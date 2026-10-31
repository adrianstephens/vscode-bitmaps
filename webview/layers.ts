// Layers for the bitmap editor: the stack of them, their blend modes, and how the whole-document operations (flip,
// rotate, crop) move them. The pixel work is plain, and tested outside a webview. Making the picture of them is on the GPU,
// in gpulayers.ts.

import { float2, float3, float3x3, approx_equal } from '@isopodlabs/maths/vector';
import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import type { psd } from '@isopodlabs/binary_bitmaps';
import { drawQuad, maskUniforms, type QuadMask, featherReach, blurMask, liftSelection, warpSelected, alphaExtent, crop, flip, rotate, placed } from './raster.js';
import { Warp, type Carry, carryPoint, carriedBounds, shiftCarry, planar } from './transformbox.js';
import { type Adjustment, adjustmentKey, adjustmentFace, adjustmentItem, newAdjustmentItem, adjustment } from './layeradj.js';
import { blendItem, styleItem, EffectRenderer, styleLayers, effectLayers, forgetEffects, type EffectSpec, fillLayer } from './layerfx.js';
import { ShapeEditor, openShape, shapeSmall, fillSwatch, type ShapeSession, transformBlocks, isShape, hasFill, vectorMask, maskBlock, withMaskFlags, newVectorMask, openVectorMask, fillLayerItem } from './shapeedit.js';
import { isText, TextEditor, textIcon, newTextLayer, carryText } from './textedit.js';

import { Pixels, PixelStorage, asRGBA, RGBAPixels, imageRect, imageSize, getPixel, resizePixels, Canvas3D, ShaderProgram, Offscreen } from './opengl.js';
import { Selection } from './bitmapSelection.js';
import type { DocumentChange, TransformTarget, TransformSession } from './transform.js';
import { SheetFan, type SheetFanHost, type Placement } from './sheetfan.js';
import { type CascadeItem, opItem, valueItem, sliderItem, toggleItem, svgFace, swatchFace } from './cascade.js';
import { Dropped, canvas, canvas3d, programBG, programLayer, blank, shader, planeMvp, flatView, menuIcon, viewToggle, viewItem, PictureMode, layerChooser, mode, openMenu, history, warpPixels, Drag, reversed } from './modes.js';
import type { LayerData } from './bitmap.js';

// what an editor over the picture makes of a layer: its blocks, and its pixels if it makes them (a shape's or text's, not a vector mask's)
export type ShapeState = Pick<Layer, 'blocks'> & Partial<Pick<PixelLayer, 'image' | 'left' | 'top'>>;

export interface BlocksEdit {
	get():		psd.LayerBlocks | undefined;
	put(blocks: psd.LayerBlocks, final: boolean): void;
}

// pixels over a rectangle whose top left is at (left, top): 8-bit rgba, not premultiplied, for a layer; one byte for a mask
export interface PlacedPixels<N extends number = 1|4> {
	left:		number;
	top:		number;
	image:		Pixels<N>;
}
export function PlacedPixels<N extends 1 | 4>(left: number, top: number, width: number, height: number, data: PixelStorage, channels: N): PlacedPixels<N> {
	return {left, top, image: Pixels(data, width, height, channels)};
}

// A layer's mask: it hides the layer where it is dark. Its pixels are one byte each, over a rectangle which need not be the
// layer's, outside which it is `default`.
export interface LayerMask extends PlacedPixels<1> {
	default:	number;		// 0..255
	disabled:	boolean;
	inverted:	boolean;
	density?:	number;		// 0..255: how much it hides of what it hides (all of it, if not given)
	feather?:	number;		// how soft its edges are: the sigma of a gaussian, in pixels (which the compositor blurs it by, on the GPU)
}

function greyRGBA(p?: PixelStorage) { return p && {r: p[0], g: p[0], b: p[0], a: 255}; }
function placedRect(p: PlacedPixels<number>) {
	return float2.extent.fromSize(float2(p.left, p.top), imageSize(p.image));
}

// what a mask holds at a pixel of the canvas, 0..255
function storedAt(mask: LayerMask, x: number, y: number) {
	const mx = x - mask.left, my = y - mask.top, {width, height, data} = mask.image;
	return mx >= 0 && my >= 0 && mx < width && my < height ? data[my * width + mx] : mask.default;
}

// how much of the layer a mask leaves at a pixel of the canvas, 0..255: inverted if it says so, and what it hides made less by its
// density (its feather, which the GPU makes, aside)
function maskAt(mask: LayerMask, x: number, y: number) {
	const v = mask.inverted ? 255 - storedAt(mask, x, y) : storedAt(mask, x, y);
	return 255 - (255 - v) * (mask.density ?? 255) / 255;
}

// a mask, over the box of these pixels (each 0..255 as `at` gives it), which is `outside` beyond that
function makeMask(box: float2.extent, outside: number, at: (x: number, y: number) => number): LayerMask {
	const {x: left, y: top} = box.min, {x: width, y: height} = box.size(), data = new Uint8ClampedArray(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			data[y * width + x] = at(x + left, y + top);
	return {left, top, image: {data, width, height}, default: outside, disabled: false, inverted: false};
}

/** A mask that shows what is selected. */
function selectionMask(selection: Selection): LayerMask {
	return makeMask(selection, 0, (x, y) => selection.at(x, y));
}

/** A mask that shows where a layer's pixels are; and the layer's pixels with nothing transparent, as Photoshop makes them. */
function transparencyMask(layer: PixelLayer): {mask: LayerMask, image: RGBAPixels} {
	const {image} = layer, data = new Uint8ClampedArray(image.data);
	const mask = makeMask(placedRect(layer), 0, (x, y) => image.data[((y - layer.top) * image.width + x - layer.left) * 4 + 3]);
	for (let i = 3; i < data.length; i += 4)
		data[i] = 255;
	return {mask, image: RGBAPixels(data, image.width, image.height)};
}

/** What masks leave of a canvas of this size, as one mask over all of it: a mask made a selection, or a vector mask drawn into a
 *  pixel mask. Undefined if they leave nothing. */
function masksOver(masks: LayerMask[], width: number, height: number) {
	const outside = masks.reduce((v, m) => v * (m.inverted ? 255 - m.default : m.default) / 255, 255);
	return makeMask(new float2.extent(float2(0, 0), float2(width, height)), Math.round(outside), (x, y) => Math.round(masks.reduce((v, m) => v * maskAt(m, x, y) / 255, 255)));
}

/** A selection of what a mask leaves; undefined if it leaves nothing. */
function maskSelection(mask: LayerMask, width: number, height: number) {
	const {image} = masksOver([mask], width, height);
	return new Selection(new float2.extent(float2(0, 0), float2(width, height)), new Uint8Array(image.data.buffer)).trimmed();
}

// What the tools draw on while a layer's mask is painted: the mask's pixels as an opaque grey picture, kept for as long as they are
// (an undo of a stroke puts back pixels of the picture it was made on, which go back into the same mask's)
const maskPictures = new WeakMap<Pixels<1>, RGBAPixels>(), picturedMasks = new WeakMap<RGBAPixels, Pixels<1>>();

/** The picture a mask is painted on. The mask is made to cover the canvas first, as a layer's pixels are when they are drawn on:
 *  this changes the mask itself, though not what it does. */
function maskPicture(mask: LayerMask, width: number, height: number): RGBAPixels {
	if (mask.left || mask.top || mask.image.width !== width || mask.image.height !== height) {
		mask.image	= makeMask(new float2.extent(float2(0, 0), float2(width, height)), mask.default, (x, y) => storedAt(mask, x, y)).image;
		mask.left	= mask.top = 0;
	}
	let picture = maskPictures.get(mask.image);
	if (!picture) {
		const values = mask.image.data, data = new Uint8ClampedArray(values.length * 4);
		for (let i = 0; i < values.length; i++)
			data.set([values[i], values[i], values[i], 255], i * 4);
		picture = RGBAPixels(data, width, height);
		maskPictures.set(mask.image, picture);
		picturedMasks.set(picture, mask.image);
	}
	return picture;
}

/** What is painted on a mask's picture (in `rect`, or all of it) put into the mask's pixels, which are given back (undefined if it is
 *  not a mask's picture): each is the lightness painted, or less where it was erased. The picture is made the grey it now holds. */
function paintedMask(picture: RGBAPixels, rect?: float2.extent): Pixels<1> | undefined {
	const mask = picturedMasks.get(picture);
	if (!mask)
		return;
	const {width} = picture, d = picture.data;
	const x0 = rect ? Math.max(0, rect.min.x) : 0, y0 = rect ? Math.max(0, rect.min.y) : 0;
	const x1 = rect ? Math.min(width, rect.max.x) : width, y1 = rect ? Math.min(picture.height, rect.max.y) : picture.height;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const i = y * width + x, o = i * 4;
			const v = Math.round((0.3 * d[o] + 0.59 * d[o + 1] + 0.11 * d[o + 2]) * d[o + 3] / 255);
			mask.data[i] = v;
			d[o] = d[o + 1] = d[o + 2] = v;
			d[o + 3] = 255;
		}
	}
	return mask;
}

/** A layer's pixels as its mask leaves them: what it hides is made transparent. */
function appliedMask(layer: PixelLayer, mask: LayerMask): RGBAPixels {
	const {image} = layer, data = new Uint8ClampedArray(image.data);
	for (let y = 0; y < image.height; y++)
		for (let x = 0; x < image.width; x++)
			data[(y * image.width + x) * 4 + 3] = Math.round(data[(y * image.width + x) * 4 + 3] * maskAt(mask, x + layer.left, y + layer.top) / 255);
	return RGBAPixels(data, image.width, image.height);
}

function getPlacedPixel(p: PlacedPixels | undefined, x: number, y: number) {
	return p && getPixel(p.image, x - p.left, y - p.top);
}
// A layer's pixels over the whole canvas, which is what the tools draw on (anything outside the canvas is lost).
// It changes the layer itself, so that everything which holds the layer sees it.
function expand(layer: PlacedPixels, width: number, height: number) {
	layer.image	= resizePixels(layer.image, layer.left, layer.top, width, height);
	layer.left	= layer.top = 0;
}

interface LayerBase {
	name:		string;
	opacity:	number;		// 0..1
	visible:	boolean;
	blend:		BLEND_MODE;		// the file's blend mode: a key of BLEND_MODES, or any other, which is normal
	mask?:		LayerMask;
	vectorMaskDensity?:	number;		// and the vector mask's (which is in its blocks), likewise
	vectorMaskFeather?:	number;
	clipped?:	boolean;	// clipped to the layer below: shown only where that layer (and the others clipped to it) are, and blended with them
	blocks?:	psd.LayerBlocks;	// the file's further information about the layer (a PSD's tagged blocks: vector paths, fills...), carried as it was read
}

// A layer of pixels, which the tools draw on: an image, or a shape, which is a fill seen through a vector mask, or text (and has the pixels
// the file keeps of them)
export interface PixelLayer extends LayerBase, PlacedPixels<4> {
	kind:		'image' | 'shape' | 'text';
	effect?:	EffectSpec;	// a layer style made on the GPU: the layer has no pixels, only the size of them, and the compositor makes them
}

// A layer with no pixels at all: what it does to the colours below it is in its blocks (`adjust` is that made ready, which only the
// compositor's copy of it has)
interface AdjustmentLayer extends LayerBase {
	kind:		'adjustment';
	adjust?:	Adjustment;
}

export type Layer = PixelLayer | AdjustmentLayer;

// the layer if it has pixels
const pixelLayer = (layer: Layer | undefined) => layer?.kind === 'adjustment' ? undefined : layer;

/** What kind of layer a file's blocks make. */
function layerKind(blocks: psd.LayerBlocks | undefined): Layer['kind'] {
	const key = adjustmentKey(blocks);
	return key ? 'adjustment' : isText(blocks) ? 'text' : isShape(blocks) ? 'shape' : 'image';
}

interface Snapshot {
	width:		number;
	height:		number;
	layers:		Layer[];
	current:	number;
}

class LayerStack {
	constructor(public width: number, public height: number, public layers: Layer[]) {}

	index(layer?: Layer) {
		return layer ? this.layers.indexOf(layer) : -1;
	}

	// (which layer is current is the painter's; a snapshot is given the index of it, to hand back to whatever restores it)
	snapshot(current: number): Snapshot {
		return {width: this.width, height: this.height, layers: this.layers.slice(), current};
	}

	restore(s: Snapshot) {
		this.width	= s.width;
		this.height	= s.height;
		this.layers	= s.layers.slice();
	}
}



//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// PSD's blend mode keys, and the numbers composite.frag knows them by. A group's pass through, and any key not here, is normal.
export const BLEND_MODES = {
	'norm':	0,		// normal
	'diss':	1,		// dissolve
	'dark':	2,		// darken
	'mul':	3,		// multiply
	'idiv':	4,		// colour burn
	'lbrn':	5,		// linear burn
	'dkCl':	6,		// darker colour
	'lite':	7,		// lighten
	'scrn':	8,		// screen
	'div':	9,		// colour dodge
	'lddg':	10,		// linear dodge (add)
	'lgCl':	11,		// lighter colour
	'over':	12,		// overlay
	'sLit':	13,		// soft light
	'hLit':	14,		// hard light
	'vLit':	15,		// vivid light
	'lLit':	16,		// linear light
	'pLit':	17,		// pin light
	'hMix':	18,		// hard mix
	'diff':	19,		// difference
	'smud':	20,		// exclusion
	'fsub':	21,		// subtract
	'fdiv':	22,		// divide
	'hue':	23,
	'sat':	24,		// saturation
	'colr':	25,		// colour
	'lum':	26,		// luminosity
};
export type BLEND_MODE = keyof typeof BLEND_MODES;


//-----------------------------------------------------------------------------
// LayeredMode
//-----------------------------------------------------------------------------

// The editor of shape layers' paths (shapeedit.ts), which is over the picture when the current layer is one, in place of the tools:
// made when it is first wanted, for the page as the tools are
let shapeEditor: ShapeEditor | undefined;
// and of text layers' text, which is over it likewise
let textEditor: TextEditor | undefined;

// a layer of these pixels, at the top left, shown as it is
export function newLayer(name: string, image: RGBAPixels): PixelLayer {
	return {kind: 'image', name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image};
}

// a picture of layers, which is on the GPU as they are composed
export class LayeredMode extends PictureMode implements SheetFanHost {
	private static readonly FLOOR = 0.2;	// the least that shows of a layer's opacity, and of what its mask and clipping take away

	layer:			Layer | undefined;	// the current layer: the one the tools draw on
	stack:			LayerStack;
	compositor:		LayerCompositor;	// which has the layers as textures, and makes the picture of them

	// the layers as the sheets of the fan
	readonly fan = new SheetFan(this);
	readonly tip = LayeredMode.fanTip;

	opened(open: boolean) {
		LayeredMode.fanOpened(open);
		this.fanned			= open;
		this.syncShape();
	}
	get width()		{ return this.stack.width; }
	get height()	{ return this.stack.height; }
	get count()		{ return this.stack.layers.length; }
	get current()	{ return this.layer ? this.stack.layers.indexOf(this.layer) : -1; }
	flatView()		{ return flatView(this.pictureMatrix(), Math.max(this.stack.width, this.stack.height)); }
	bounds(i: number) {
		const layer = this.stack.layers[i];
		return layer.kind === 'adjustment' ? new float2.extent(float2(0, 0), float2(this.stack.width, this.stack.height)) : placedRect(layer);
	}
	sheetName(i: number)	{ return this.stack.layers[i].name; }
	choose(i: number)		{ 
		const layer = this.stack.layers[i];
		this.live.layer = layer;
		this.live.editing = undefined;
		this.live.viewMask = undefined;
		if (layer.kind !== 'adjustment')
			expand(layer, this.stack.width, this.stack.height);
		this.live.recompose();
	}
	reorderer(i: number)	{ return this.dragger(this.stack.layers[i]); }
	sheetMenu(i: number | undefined, clientX: number, clientY: number) {
		openMenu(clientX, clientY, i === undefined ? undefined : this.layerItems(this.stack.layers[i]));
	}
	// the masks a layer is drawn through on its own (as the fan and a transform draw it), their textures made now
	private masksOf(layer: Layer): {mask?: QuadMask, vmask?: QuadMask} {
		return {mask: this.compositor.maskTexture(layer), vmask: this.compositor.vectorMaskTexture(layer)};
	}

	drawSheet(i: number, at: Placement) {
		const layers = this.stack.layers, layer = layers[i];
		const rect0 = this.bounds(i);
		const rect = new float2.extent(rect0.min.scale(1 / at.longest), rect0.max.scale(1 / at.longest));

		// What of the layer the picture shows, which is drawn, but not down to nothing. A layer clipped to another has
		// that one's pixels to be clipped by (the first below it which is not clipped itself); if that one is hidden so is it.
		let base: Layer | undefined;
		if (layer.clipped) {
			for (let j = i - 1; j >= 0 && !base; j--)
				if (!layers[j].clipped)
					base = layers[j];
		}

		const shown			= layer.visible && (!base || base.visible) ? layer.opacity : 0;
		const clip			= base?.kind !== 'adjustment' && base?.image.width && base.image.height ? base : undefined;
		const flatUniforms	= {u_floor: LayeredMode.FLOOR};

		// (the textures are made before any is bound: making one binds it, on the unit which is active)
		const compositor	= this.compositor;
		const texture 		= compositor.layerTexture(layer);
		const {mask, vmask}	= this.masksOf(layer), baseTexture = clip ? compositor.layerTexture(clip) : undefined;
		if (layer.kind !== 'adjustment' && texture) {
			canvas3d.bindTexture2D(texture, 0);
			canvas3d.bindTexture2D(mask?.texture ?? compositor.dummyMask(), 1);
			canvas3d.bindTexture2D(baseTexture ?? blank, 2);
			canvas3d.bindTexture2D(vmask?.texture ?? compositor.dummyMask(), 3);
			programLayer.draw({
				...flatUniforms,
				u_mvp:			new Float32Array(placed(at.matrix, rect, at.depth).flat()),
				u_texture:		0,
				u_base:			2,
				u_origin:		[layer.left, layer.top],
				...maskUniforms('mask', 1, mask),
				...maskUniforms('vmask', 3, vmask),
				u_baseRect:		clip ? [clip.left, clip.top, clip.image.width, clip.image.height] : [0, 0, 0, 0],
				u_opacity:		shown,
				u_size:			[layer.image.width, layer.image.height],
				u_edge:			0,
				u_veil:			0,
				u_outline:		[0, 0, 0, 0],
			});
		}

		// the sheet it is on, outlined: the corners which show tell the layers apart
		canvas3d.bindTexture2D(blank, 0);
		programLayer.draw({
			...flatUniforms,
			u_mvp:			new Float32Array(placed(at.matrix, at.sheet, at.depth).flat()),
			u_texture:		0,
			u_base:			2,
			u_origin:		[0, 0],
			...maskUniforms('mask', 1, undefined),
			...maskUniforms('vmask', 3, undefined),
			u_baseRect:		[0, 0, 0, 0],
			u_opacity:		1,
			u_size:			[this.stack.width, this.stack.height],
			u_edge:			at.edge(at.current || at.hovered ? 2.5 : 1.5),
			u_veil:			0.05 * at.open,
			u_outline:		at.outline,
		})

	}

	// the layers become the picture, over a canvas the size of the image
	constructor(image: ImageData, layers: Layer[], program2D: ShaderProgram, programComposite: ShaderProgram, programEffect?: ShaderProgram, programBlur?: ShaderProgram) {
		super(image, program2D);
		this.stack		= new LayerStack(image.width, image.height, layers);
		this.layer		= layers[layers.length - 1];
		if (this.layer.kind !== 'adjustment')
			expand(this.layer, image.width, image.height);	// what the tools draw on covers the canvas
		this.compositor	= new LayerCompositor(canvas3d, programComposite, programEffect, programBlur);
		this.compositor.compose(image.width, image.height, layers);
		this.texture	= this.compositor.texture;
	}

	static async create(image: ImageData, layerdata: LayerData[]) {
		// the layers as the page has them, from a file's
		const layers = layerdata.map((data): Layer => {
			const kind = layerKind(data.blocks);
			const common = {
			name:		data.name,
			opacity:	data.opacity,
			visible:	data.visible,
			blend:		data.blend as BLEND_MODE,
			clipped:	data.clipped,
			blocks:		data.blocks,
			mask:		data.mask && {
				left: data.mask.left, top: data.mask.top, default: data.mask.default, disabled: data.mask.disabled, inverted: data.mask.inverted,
				density: data.mask.density, feather: data.mask.feather,
				image: {data: new Uint8ClampedArray(data.mask.data), width: data.mask.width, height: data.mask.height},
			},
			vectorMaskDensity:	data.vectorMaskDensity,
			vectorMaskFeather:	data.vectorMaskFeather,
			};
			return kind === 'adjustment'
				? {...common, kind}
				: {...common, kind, left: data.left, top: data.top, image: {data: new Uint8ClampedArray(data.data), width: data.width, height: data.height}};
		});
		return new LayeredMode(image, layers, await shader('2d'), await shader('composite'), await shader('effect'), await shader('blur'));
	}

	// (as for ImageMode: an undo or redo made on an earlier mode is done on the one there is)
	private get live(): LayeredMode {
		return mode instanceof LayeredMode ? mode : this;
	}

	// A change to a layer's blocks (its style, or the adjustment it makes), shown at once: the steps of a value being turned are one
	// edit, and one that is final (a choice) is an edit of its own
	private blocksOf(layer: Layer, caption: string): BlocksEdit {
		const get = () => layer.blocks;
		const set = (v: psd.LayerBlocks | undefined) => {
			layer.blocks = v;
			this.live.recompose();
		};
		return {
			get,
			put: (blocks, final) => {
				if (final)
					history.settle();
				history.adjust(layer, caption, get, set, blocks);
				if (final)
					history.settle();
			},
		};
	}

	private uniqueLayerName(name: string, from = 1) {
		let n = from;
		while (this.stack.layers.some(l => l.name === `${name} ${n}`))
			n++;
		return `${name} ${n}`;
	}

	private addNewLayer() {
		const {width, height} = this.stack;
		this.addLayer({kind: 'image', name: this.uniqueLayerName('Layer', this.stack.layers.length + 1),
			left: 0, top: 0, opacity: 1, visible: true, blend: 'norm',
			image: {data: new Uint8ClampedArray(width * height * 4), width, height}}
		);
	}
	private addLayer(layer: Layer) {
		const stack = this.stack;
		const was = this.live.layer!, at = stack.layers.indexOf(was) + 1;
		const redo = () => {
			stack.layers.splice(at, 0, layer);
			this.live.layer = layer;
			this.live.recompose();
		};
		redo();
		history.record('New Layer', () => {
			stack.layers.splice(at, 1);
			this.live.layer = was;
			this.live.recompose();
		}, redo);
	}
	private removeLayer(layer: Layer) {
		const stack = this.stack;
		if (stack.layers.length < 2)
			return;
		const at = stack.layers.indexOf(layer), wasCurrent = layer === this.live.layer;
		const redo = () => {
			stack.layers.splice(at, 1);
			if (wasCurrent) {
				const next = stack.layers[Math.min(at, stack.layers.length - 1)];
				this.live.layer = next;
				if (next.kind !== 'adjustment')
					expand(next, stack.width, stack.height);
			}
			this.live.recompose();
		};
		redo();
		history.record('Delete Layer', () => {
			stack.layers.splice(at, 0, layer);
			if (wasCurrent)
				this.live.layer = layer;
			this.live.recompose();
		}, redo);
	}
	// up (1) or down (-1) one place
	private moveLayer(layer: Layer, direction: 1 | -1) {
		const from = this.stack.index(layer), to = from + direction;
		if (to < 0 || to >= this.stack.layers.length)
			return;
		const swap = (a: number, b: number) => () => {
			const t = this.stack.layers[a];
			this.stack.layers[a] = this.stack.layers[b];
			this.stack.layers[b] = t;
			this.live.recompose();
		};
		swap(from, to)();
		history.record(direction > 0 ? 'Raise Layer' : 'Lower Layer', swap(to, from), swap(from, to));
	}

	private layerItems(layer: Layer) {
		// a property of the layer set as one edit, and its opacity a step at a time
		const set = <K extends 'visible' | 'blend'>(key: K, value: Layer[K], label: string) => {
			const was = layer[key];
			if (was === value)
				return;
			const put = (v: Layer[K]) => () => {
				layer[key] = v;
				this.live.recompose();
			};
			put(value)();
			history.record(label, put(was), put(value));
		};
		const setOpacity = (opacity: number) => history.adjust(layer, 'Layer Opacity', () => layer.opacity, v => {
			layer.opacity = v;
			this.live.recompose();
		}, opacity);

		// a blend mode is seen as the pointer rests on it, and is an edit when it is chosen (from the mode the layer really had,
		// which the preview puts back first)
		const previewBlend = (blend: BLEND_MODE | undefined) => {
			if (blend === undefined)
				return history.endPreview(layer);
			const was = layer.blend;
			history.preview(layer, () => {
				layer.blend = was;
				this.live.recompose();
			});
			if (layer.blend !== blend) {
				layer.blend = blend;
				this.live.recompose();
			}
		};
		const setBlend = (blend: BLEND_MODE) => {
			history.endPreview(layer);
			set('blend', blend, 'Layer Blend Mode');
		};

		const blend = blendItem(() => layer.blend, setBlend, previewBlend);

		// a layer a PSD keeps as a shape (a fill seen through a vector mask), and shown, so that what is done to it can be seen
		return [
			{...toggleItem('Visible', svgFace(menuIcon.eye), () => layer.visible, visible => set('visible', visible, visible ? 'Show Layer' : 'Hide Layer')), id: 'visible'},
			{...sliderItem({
				label: 'opacity', caption: 'Opacity', min: 0, max: 100, markers: 5,//[0, 25, 50, 75, 100],
				get: () => Math.round(layer.opacity * 100), set: v => setOpacity(v / 100),
				step: (v, steps) => v + 5 * steps,
			}), id: 'opacity'},
			blend,
			adjustmentItem(this.blocksOf(layer, 'Adjustment')) ?? fillLayerItem(this.blocksOf(layer, 'Fill')) ?? styleItem(this.blocksOf(layer, 'Layer Style')),
			...this.maskItems(layer),
			...(layer.kind === 'text' ? TextEditor.layerMenu(this, layer) : []),
			opItem(menuIcon.trash, 'Delete layer', () => this.removeLayer(layer)),
		];
	}

	// The layer's masks. Without a mask, one is added: showing all, hiding all, showing what is selected or where the layer's pixels
	// are. With one, it is turned off and on, inverted, made the selection, put into the layer's pixels, or taken away. A vector mask
	// (not a shape's outline, which is the shape's) is turned off and on, inverted, drawn into the mask, or taken away.
	private maskItems(layer: Layer): CascadeItem[] {
		const {width, height} = this.stack, pixels = pixelLayer(layer);

		// the mask, and with it perhaps the layer's pixels or blocks, changed as one edit
		type State = Pick<Layer, 'mask' | 'blocks' | 'vectorMaskDensity' | 'vectorMaskFeather'> & {image: RGBAPixels | undefined};
		const state = (): State => ({mask: layer.mask, image: pixels?.image, blocks: layer.blocks, vectorMaskDensity: layer.vectorMaskDensity, vectorMaskFeather: layer.vectorMaskFeather});
		const put = (s: State) => () => {
			layer.mask		= s.mask;
			layer.blocks	= s.blocks;
			layer.vectorMaskDensity = s.vectorMaskDensity;
			layer.vectorMaskFeather = s.vectorMaskFeather;
			if (pixels && s.image)
				pixels.image = s.image;
			this.live.recompose();
		};
		const change = (label: string, to: Partial<State>) => {
			const before = state(), after = {...before, ...to};
			put(after)();
			history.record(label, put(before), put(after));
		};

		// (read as each is chosen: a toggle leaves the menu open, and what it shows changed)
		const selection = this.selection();
		// (a mask added is what is painted, as Photoshop has it)
		const add = (id: string, face: string, caption: string, mask: () => LayerMask) => ({id, face: () => face, caption: () => caption, select: () => {
			change('Add Layer Mask', {mask: mask()});
			this.editMask(layer, 'mask');
		}});
		const all = (shown: boolean): LayerMask => ({left: 0, top: 0, image: {data: new Uint8ClampedArray(0), width: 0, height: 0}, default: shown ? 255 : 0, disabled: false, inverted: false});
		// (chosen, as a layer is, the mask is what the tools draw on)
		const maskItem: CascadeItem = {
			id:			'mask',
			face:		() => svgFace(menuIcon.mask),
			caption:	() => !layer.mask ? 'Add mask' : `Mask${layer.mask.disabled ? ': off' : ''}${this.isEdited(layer, 'mask') ? ' (being painted)' : ' (click to paint it)'}`,
			active:		() => this.isEdited(layer, 'mask'),
			...(layer.mask ? {select: () => this.editMask(layer, 'mask')} : {}),
			children:	() => !layer.mask ? [
				add('mask-reveal', swatchFace('#fff'), 'Reveal all', () => all(true)),
				add('mask-hide', swatchFace('#000'), 'Hide all', () => all(false)),
				...(selection ? [add('mask-selection', svgFace(menuIcon.select), 'From selection', () => selectionMask(selection))] : []),
				...(pixels ? [{...opItem(menuIcon.alpha, 'From transparency', () => change('Add Layer Mask', transparencyMask(pixels))), id: 'mask-alpha'}] : []),
			] : [
				{...toggleItem('Mask', svgFace(menuIcon.eye), () => !layer.mask?.disabled, on => layer.mask && change(on ? 'Enable Layer Mask' : 'Disable Layer Mask', {mask: {...layer.mask, disabled: !on}})), id: 'mask-on'},
				{...toggleItem('Inverted', svgFace(menuIcon.invert), () => !!layer.mask?.inverted, inverted => layer.mask && change('Invert Layer Mask', {mask: {...layer.mask, inverted}})), id: 'mask-invert'},
				{...opItem(menuIcon.select, 'Load as selection', () => layer.mask && this.select(maskSelection(layer.mask, width, height), 'Load Selection')), id: 'mask-select'},
				...(pixels ? [{...opItem(menuIcon.apply, 'Apply to the layer', () => {
					const m = layer.mask;
					if (m)
						change('Apply Layer Mask', {mask: undefined, image: m.disabled ? pixels.image : appliedMask(pixels, m)});
				}), id: 'mask-apply'}] : []),
				...this.maskSoftness(layer, 'mask'),
				{...opItem(menuIcon.trash, 'Delete mask', () => change('Delete Layer Mask', {mask: undefined})), id: 'mask-delete'},
			],
		};

		const flags = () => maskBlock(layer.blocks)?.flags ?? 0;
		const setFlags = (label: string, f: number | undefined) => change(label, {blocks: withMaskFlags(layer.blocks!, f)});
		// (a layer with a fill of its own is a shape when it has a vector mask, which the shape editor gives it)
		if (!maskBlock(layer.blocks)) {
			return hasFill(layer.blocks) ? [maskItem] : [maskItem, {
				id:			'vector-mask-add',
				face:		() => svgFace(menuIcon.vectorMask),
				caption:	() => 'Add vector mask: a path that shows what is inside it',
				select:		() => {
					change('Add Vector Mask', {blocks: {...layer.blocks, vmsk: newVectorMask()}});
					this.editMask(layer, 'vector');
				},
			}];
		}
		const vectorItem: CascadeItem = {
			id:			'vector-mask',
			face:		() => svgFace(menuIcon.vectorMask),
			caption:	() => `${flags() & 4 ? 'Vector mask: off' : 'Vector mask'}${this.isEdited(layer, 'vector') ? ' (being edited)' : ' (click to edit its path)'}`,
			active:		() => this.isEdited(layer, 'vector'),
			select:		() => this.editMask(layer, 'vector'),
			children:	() => [
				{...toggleItem('Vector mask', svgFace(menuIcon.eye), () => !(flags() & 4), on => setFlags(on ? 'Enable Vector Mask' : 'Disable Vector Mask', on ? flags() & ~4 : flags() | 4)), id: 'vector-mask-on'},
				{...toggleItem('Inverted', svgFace(menuIcon.invert), () => !!(flags() & 1), on => setFlags('Invert Vector Mask', on ? flags() | 1 : flags() & ~1)), id: 'vector-mask-invert'},
				// (one that is not stays where it is when the layer is moved)
				{...toggleItem('Linked to the layer', svgFace(menuIcon.link), () => !(flags() & 2), on => setFlags(on ? 'Link Vector Mask' : 'Unlink Vector Mask', on ? flags() & ~2 : flags() | 2)), id: 'vector-mask-linked'},
				...this.maskSoftness(layer, 'vector'),
				// (into the mask there is, as both hide the layer; one that is off is put in as it would be if it were on)
				{...opItem(menuIcon.pixels, 'Rasterize into the mask', () => {
					// (the densities are put in its pixels; the feather is the mask's own, or if it has none, the vector mask's)
					const m = layer.mask && !layer.mask.disabled ? layer.mask : undefined;
					const drawn = layer.blocks && vectorMask({...layer, blocks: withMaskFlags(layer.blocks, flags() & ~4)}, width, height);
					if (drawn)
						change('Rasterize Vector Mask', {blocks: withMaskFlags(layer.blocks!, undefined), vectorMaskDensity: undefined, vectorMaskFeather: undefined,
							mask: {...masksOver(m ? [m, drawn] : [drawn], width, height), feather: m ? m.feather : drawn.feather}});
				}), id: 'vector-mask-rasterize'},
				{...opItem(menuIcon.trash, 'Delete vector mask', () => change('Delete Vector Mask', {blocks: withMaskFlags(layer.blocks!, undefined), vectorMaskDensity: undefined, vectorMaskFeather: undefined})), id: 'vector-mask-delete'},
			],
		};
		return [maskItem, vectorItem];
	}

	// the density and feather of a layer's mask or vector mask, in its strip, and in the menu itself while it is what is edited
	private maskSoftness(layer: Layer, what: 'mask' | 'vector') {
		return what === 'mask'
			? this.softnessItems(layer, 'mask', 'Mask', () => layer.mask?.density, () => layer.mask?.feather, (density, feather) => {
				if (layer.mask)
					layer.mask = {...layer.mask, density, feather};
			})
			: this.softnessItems(layer, 'vector-mask', 'Vector Mask', () => layer.vectorMaskDensity, () => layer.vectorMaskFeather, (density, feather) => {
				layer.vectorMaskDensity = density;
				layer.vectorMaskFeather = feather;
			});
	}

	// A mask's density (shown as a percentage) and feather (in pixels), each turned a step at a time as one edit: what they are not
	// made is left out (255 and 0, which is how the file has them)
	private softnessItems(layer: Layer, id: string, label: string, density: () => number | undefined, feather: () => number | undefined, put: (density?: number, feather?: number) => void): CascadeItem[] {
		const set = (d?: number, f?: number) => {
			put(d === undefined || d >= 255 ? undefined : d, f === undefined || f <= 0 ? undefined : f);
			this.live.recompose();
		};
		return [
			{...valueItem({
				label: 'density', caption: `${label} density`, min: 0, max: 100, presets: [0, 25, 50, 75, 100],
				get: () => Math.round((density() ?? 255) / 2.55),
				set: v => history.adjust(layer, `${label} Density`, () => density(), d => set(d, feather()), Math.round(v * 2.55)),
				step: (v, steps) => v + 5 * steps,
			}), id: `${id}-density`},
			{...valueItem({
				label: 'feather', caption: `${label} feather (pixels)`, min: 0, max: 250, presets: [0, 1, 2, 5, 10, 25],
				get: () => feather() ?? 0,
				set: v => history.adjust(layer, `${label} Feather`, () => feather(), f => set(density(), f), v),
				step: (v, steps) => Math.max(0, v + steps),
			}), id: `${id}-feather`},
		];
	}

	// the masks that hide some of the layer, as it is now: its mask (if on) and its vector mask (drawn, if on), unfeathered
	private masksOn(layer: Layer): LayerMask[] {
		const {width, height} = this.stack, vmask = vectorMask(layer, width, height);
		return [...(layer.mask && !layer.mask.disabled ? [layer.mask] : []), ...(vmask ? [vmask] : [])];
	}

	// A layer's icon with what its masks leave as a small grey picture at its corner (outlined while one of them is edited), if it
	// has any
	private withMaskBadge(face: string, layer: Layer) {
		const masks = this.masksOn(layer);
		if (!masks.length && !layer.mask && !maskBlock(layer.blocks))
			return face;
		const {width, height} = this.stack, k = 12 / Math.max(width, height);
		const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
		const ctx = createElement('canvas', {width: w, height: h}).getContext('2d')!, out = ctx.createImageData(w, h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const at = float2(Math.floor((x + 0.5) / k), Math.floor((y + 0.5) / k));
				const v = masks.reduce((v, m) => v * maskAt(m, at.x, at.y) / 255, 255);
				out.data.set([v, v, v, 255], (y * w + x) * 4);
			}
		}
		ctx.putImageData(out, 0, 0);
		const edited = this.isEdited(layer, 'mask') || this.isEdited(layer, 'vector');
		return `<span style="position:relative;display:inline-block;line-height:0">${face}<img draggable="false" src="${ctx.canvas.toDataURL()}" style="position:absolute;right:-3px;bottom:-3px;width:${w}px;height:${h}px;pointer-events:none;outline:1px solid ${edited ? 'var(--vscode-focusBorder, #08f)' : 'rgba(128,128,128,0.8)'}"></span>`;
	}

	// The current layer's masks shown over the picture: as a red veil over what they hide, or alone, in grey
	private viewMask?: 'over' | 'alone';

	// the View item's: the 3D view, and the current layer's masks (if it has any) shown over the picture
	private viewItem(): CascadeItem {
		return viewItem(() => {
			const live = this.live, layer = live.layer;
			const view = (how: 'over' | 'alone', on: boolean) => {
				live.viewMask = on ? how : undefined;
				live.redraw();
			};
			return [
				viewToggle(live, live.fan),
				...(layer && (layer.mask || maskBlock(layer.blocks)) ? [
					{...toggleItem('Show the masks over the picture', svgFace(menuIcon.mask), () => live.viewMask === 'over', on => view('over', on)), id: 'mask-over'},
					{...toggleItem('Show the masks alone', svgFace(menuIcon.invert), () => live.viewMask === 'alone', on => view('alone', on)), id: 'mask-alone'},
				] : []),
			];
		});
	}

	// the masks drawn over the picture, by the layer shader, from their textures
	private drawMaskView() {
		const layer = this.viewMask && !this.fanned ? this.layer : undefined, masks = layer && this.masksOf(layer);
		if (masks && (masks.mask || masks.vmask)) {
			const {width, height} = this.stack;
			drawQuad(canvas3d, programLayer, blank, new float2.extent(float2(0, 0), float2(width, height)), {...masks, view: this.viewMask}, 1, planeMvp(this.pictureMatrix(), float3x3.identity()));
		}
	}

	// whether this layer's mask or vector mask is what is edited
	private isEdited(layer: Layer, what: 'mask' | 'vector') {
		return this.live.editing === what && this.live.layer === layer;
	}
	// the current layer's mask or vector mask edited from now on, or (with neither) its pixels, shape or text
	private edit(what: 'mask' | 'vector' | undefined) {
		this.live.editing = what;
		this.live.recompose();
	}
	// the layer's mask or vector mask made what is edited, as choosing a layer makes its pixels that (it is chosen first, if it is not)
	private editMask(layer: Layer, what: 'mask' | 'vector') {
		if (this.live.layer !== layer)
			this.choose(this.stack.index(layer));
		this.edit(what);
	}

	// The current layer's shape, when it has one the shape editor can edit: the editor is over the picture in place of the tools,
	// and what it does is the layer's (see openShape in shapeedit.ts)
	private shape?: ShapeSession;
	private text?: TextEditor;	// likewise the editor of the current layer's text, if it has some
	private focusText = false;		// the text just made is to be typed into
	private previewFrame = 0;			// the frame the session is next shown on the picture in, while it is being changed
	private fanned = false;

	// the shape editor over the picture if the current layer is a shape (and the layers are not fanned out), opened again from
	// the layer's blocks if they have been changed by something else (an undo); else the tools
	private syncShape() {
		// (while a mask is painted, the tools are over the picture whatever the layer is; while a vector mask is edited, its path is
		// the shape editor's)
		const vector = !this.fanned && this.editing === 'vector' ? this.layer : undefined;
		const layer = this.fanned || this.editing ? undefined : pixelLayer(this.layer), s = this.shape, edited = vector ?? layer;
		if (!(s && s.layer === edited && s.blocks === edited?.blocks && !!s.mask === !!vector)) {
			cancelAnimationFrame(this.previewFrame);
			this.shape = vector ? openVectorMask(vector, this.stack) : layer && openShape(layer, this.stack);
			shapeEditor ??= new ShapeEditor(canvas.parentElement!);
			shapeEditor.open(this.shape && this, this.shape);
		}
		if (!this.text?.has(layer)) {
			cancelAnimationFrame(this.previewFrame);
			textEditor ??= new TextEditor(canvas.parentElement!);
			this.text	= textEditor.open(this, layer, this.focusText);
			this.focusText = false;
		}
	}

	// a shape layer has a transform of its own (its editor's), and a text layer's cannot distort it
	transformable() {
		return this.shape ? 'none' : this.text ? 'affine' : 'any';
	}

	// the transforms a text layer has of its own (that are not the picture's)
	transformMenu() {
		return this.text?.warpItems() ?? [];
	}

	// what a layer is made, as one edit
	public replace<K extends keyof PixelLayer>(layer: PixelLayer, label: string, after: Pick<PixelLayer, K>) {
		const before = {} as Pick<PixelLayer, K>;
		for (const k in after)
			before[k] = layer[k];
		const set = (v: Pick<PixelLayer, K>) => {
			Object.assign(layer, v);
			this.live.recompose();
		};
		set(after);
		history.record(label, () => set(before), () => set(after));
	}



	// the shape (or text) as it is being changed, shown in place of the layer (which is left as it was) on the next frame
	previewEdit() {
		cancelAnimationFrame(this.previewFrame);
		this.previewFrame = requestAnimationFrame(() => {
			const s = this.shape ?? this.text;
			if (!s)
				return;
			const shown = {...s.layer, ...s.state()}, {width, height} = this.stack;
			this.compositor.compose(width, height, this.stack.layers.map(l => l === s.layer ? shown : l));
			this.texture = this.compositor.texture;
			this.redraw();
		});
	}

	// the shape (or text) as it is now made the layer's, as an edit
	commitEdit(label: string, key?: string) {
		const s = this.shape ?? this.text;
		if (!s)
			return;
		cancelAnimationFrame(this.previewFrame);
		const layer = s.layer, after = s.state();
		s.blocks = after.blocks!;		// (which the editor has: it is not opened again from them)
		const pixels = after.image && pixelLayer(layer);
		const get = (): ShapeState => pixels ? {image: pixels.image, left: pixels.left, top: pixels.top, blocks: layer.blocks} : {blocks: layer.blocks};
		const set = (v: ShapeState) => {
			Object.assign(layer, v);
			this.live.recompose();
		};
		if (key) {
			history.adjust(key, label, get, set, after);
		} else {
			const before = get();
			set(after);
			history.record(label, () => set(before), () => set(after));
		}
	}

	override activate() {
		super.activate();
		this.syncShape();
	}
	override dispose() {
		cancelAnimationFrame(this.previewFrame);
		if (this.shape || this.text) {
			this.shape = this.text = undefined;
			shapeEditor?.open();
			textEditor?.open();
		}
		this.fan.dispose();
		this.compositor.release();
		this.texture = undefined;		// (the compositor's)
		super.dispose();
	}
	override fit() {
		if (this.fan?.active)
			this.fan.navigation.fit();
		else
			this.pan.fit();
	}

	override redraw() {
		if (this.fan?.active) {
			canvas3d.initViewport();
			programBG.draw({u_viewport: [canvas.width, canvas.height]});
			this.fan.draw();
			return;
		}
		super.redraw();
		this.drawMaskView();
		if (this.shape)
			shapeEditor?.draw();
		this.text?.draw();
	}
	override tooltip(clientX: number, clientY: number): string|undefined {
		return this.fan?.active ? undefined : super.tooltip(clientX, clientY);
	}

	// with layers, the picture is read back
	override picture() {
		if (this.image && this.compositor)
			this.image.data.set(this.compositor.read(new float2.extent(float2(0, 0), float2(this.image.width, this.image.height)))!);
		return this.image;
	}

	// the tools draw on the current layer's mask, if it has one and it is to be painted, else its pixels
	private editing?: 'mask' | 'vector';	// what of the current layer is edited, if not its pixels (or its shape, or text): its mask or vector mask
	private maskPainted() {
		return this.editing === 'mask' ? this.layer?.mask : undefined;
	}
	override target() {
		const mask = this.maskPainted();
		return mask ? maskPicture(mask, this.stack.width, this.stack.height) : pixelLayer(this.layer)?.image;
	}
	// the current layer's colour (or its mask's grey, if that is painted), and off it the picture's
	override pick(x: number, y: number) {
		const mask = this.maskPainted();
		const here = mask ? greyRGBA(getPlacedPixel(mask, x, y)) : asRGBA(getPlacedPixel(pixelLayer(this.layer), x, y));
		if (here)
			return here;
		const c = this.compositor;
		const d = c && x >= 0 && y >= 0 && x < c.width && y < c.height ? c.read(new float2.extent(float2(x, y), float2(x + 1, y + 1))) : undefined;
		return d && asRGBA(d);
	}
	// the layer it was pointed at on, whichever is drawn on (nothing once it is gone), or all the picture shows as a stroke begins
	override cloneSource(at: float2, all: boolean) {
		if (all) {
			const {width, height} = this.stack, data = this.compositor.read(new float2.extent(float2(0, 0), float2(width, height)));
			return data && {from: RGBAPixels(data as Uint8ClampedArray<ArrayBuffer>, width, height), at};
		}
		const mask = this.maskPainted();
		if (mask)
			return this.live.layer?.mask === mask ? {from: maskPicture(mask, this.stack.width, this.stack.height), at} : undefined;
		const layer = pixelLayer(this.layer);
		return layer && this.live.stack.layers.includes(layer) ? {from: layer.image, at} : undefined;
	}

	override menu() {
		const stack = this.stack;
		if (!stack)
			return [];

		const add: CascadeItem = {face: () => svgFace(menuIcon.plus), caption: () => 'New layer', select: () => this.addNewLayer() };
		
		const text: CascadeItem = {face: () => svgFace(textIcon), caption: () => 'New text layer', select: () => {
			// a new text layer with its text to be typed
			const name = this.uniqueLayerName('Text');
			const {width, height} = this.stack;
			this.focusText = true;
			this.addLayer(newTextLayer(
				name,
				'Text',
				float2(Math.round(width / 10), Math.round(height / 2)),
				Math.max(8, Math.round(height / 12)),
				stack.layers.find(l => l.kind === 'text')?.blocks
			));
		} };

		const adjust = newAdjustmentItem((name, blocks) => {
			name = this.uniqueLayerName(name);
			const {width, height} = stack;
			this.addLayer(layerKind(blocks) === 'adjustment'
				? {kind: 'adjustment', name, opacity: 1, visible: true, blend: 'norm', blocks}
				: {kind: 'shape', name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', blocks, image: {data: new Uint8ClampedArray(width * height * 4), width, height}});
		});

		const urls = new Map<Layer, string>();	// (the menu is made again each time it comes up, so these are as the pictures are then)

		const layer = this.layer;
		const fx = !layer
				?	undefined
				:	adjustmentItem(this.blocksOf(layer, 'Adjustment')) ?? styleItem(this.blocksOf(layer, 'Layer Style'));

		// (while a mask is what is drawn on, or its path is edited, how dense and soft it is)
		const edited = layer && (this.editing === 'mask' && layer.mask || this.editing === 'vector' && maskBlock(layer.blocks)) ? this.editing : undefined;

		return [
			this.viewItem(),
			...(shapeEditor?.items() ?? []),
			...(this.text?.items() ?? []),
			...(fx ? [fx] : []),
			...(layer && edited ? this.maskSoftness(layer, edited) : []),
			layerChooser('Layer',
				() => stack.layers ?? [],
				() => this.layer!,
				layer => this.choose(stack.index(layer)),
				layer => layer.name,
				layer => {
					let face = urls.get(layer);
					if (face === undefined) {
						// (a fill layer with no shape is its fill all over; with one, it is the shape, which the thumbnail draws)
						const swatch = layer.kind !== 'adjustment' && fillSwatch(layer.blocks);
						face = layer.kind === 'adjustment' ? adjustmentFace(layer.blocks) ?? ''
							: swatch ? swatchFace(swatch)
							: `<img class="cascade-thumb" draggable="false" src="${layerThumbnail(stack.width, stack.height, 26, layer).toDataURL()}">`;
						urls.set(layer, face = this.withMaskBadge(face, layer));
					}
					return face;
				},
				layer => this.layerItems(layer),
				layer => this.fan.highlight(layer && stack.index(layer)),
				layer => reversed(this.dragger(layer), () => stack.layers.length),
				[add, text, adjust]
			),
		];
	}

	// a layer's pixels, which may lie anywhere on the canvas
	override changed(changed: RGBAPixels, rect?: float2.extent) {
		// (a mask's picture is over the whole canvas)
		const mask = paintedMask(changed, rect);
		if (mask) {
			for (const l of this.stack.layers)
				if (l.mask?.image === mask)
					forgetEffects(l);
			this.compositor.uploadMask(mask, rect);
			this.recompose(rect);
			return;
		}
		const layer = this.stack?.layers.find((l): l is PixelLayer => l.kind !== 'adjustment' && l.image === changed);
		if (layer)
			forgetEffects(layer);		// (a style follows what the layer shows)
		if (layer)
			this.compositor.upload(layer, rect);
		const shift = layer && float2(layer.left, layer.top);
		this.recompose(shift && rect ? new float2.extent(rect.min.add(shift), rect.max.add(shift)) : undefined);
	}
	protected override shownBy(image: RGBAPixels) {
		const layer = this.stack?.layers.find((l): l is PixelLayer => l.kind !== 'adjustment' && l.image === image);
		const texture = layer && !layer.effect ? this.compositor.layerTexture(layer) : undefined;
		return texture && {texture, drawn: () => {
			forgetEffects(layer!);
			this.recompose();
		}};
	}

	// the start of a transform: what of the canvas it is of
	override beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		if (!this.image || !programLayer)
			return undefined;
		const layer = target === 'layer' ? pixelLayer(this.layer) : undefined;
		if (!layer)
			return this.wholeSession();
		// (what the tools draw on covers the canvas, so a selection is of the canvas as well)
		if (selection && layer.left === 0 && layer.top === 0 && layer.image.width === this.image.width && layer.image.height === this.image.height)
			return this.selectedSession(layer, selection);
		const r = alphaExtent(layer.image);
		if (!r)
			return undefined;
		this.recompose(undefined, layer);	// (the layer is left out, to be drawn on its own as it is carried)
		const shift = float2(layer.left, layer.top);
		return {
			box: new float2.extent(r.min.add(shift), r.max.add(shift)), target: 'layer',
			update: carry => {
				const [matrix, warp] = planar(carry);
				this.preview = () => {
					// (the textures are got before any is bound: making one binds it)
					const texture = this.compositor.layerTexture(layer), masks = this.masksOf(layer);
					this.drawFlat();
					const mvp	= planeMvp(this.pictureMatrix(), matrix);
					if (texture)
						drawQuad(canvas3d, programLayer, texture, placedRect(layer), masks, layer.visible ? layer.opacity : 0.3, mvp, undefined, warp);
				};
				this.redraw();
			},
			end: () => {
				this.preview = undefined;
				this.recompose();
			},
		};
	}

	// a layer's selected part is carried, over the rest of it
	private selectedSession(layer: PixelLayer, selection: Selection): TransformSession {
		const {floating, rest} = liftSelection(layer.image, selection), whole = imageRect(layer.image);
		const own = canvas3d.createTextureFromImage(floating), left = canvas3d.createTextureFromImage(rest);
		this.recompose(undefined, layer);	// (the layer is left out, to be drawn on its own)
		return {
			box: selection.bounds(), target: 'layer', selection,
			update: carry => {
				const [matrix, warp] = planar(carry);
				this.preview = () => {
					// (the textures are got before any is bound: making one binds it)
					const masks = this.masksOf(layer), opacity = layer.visible ? layer.opacity : 0.3;
					this.drawFlat();
					drawQuad(canvas3d, programLayer, left, whole, masks, opacity, planeMvp(this.pictureMatrix(), float3x3.identity()));
					drawQuad(canvas3d, programLayer, own, whole, masks, opacity, planeMvp(this.pictureMatrix(), matrix), undefined, warp);
				};
				this.redraw();
			},
			end: () => {
				this.preview = undefined;
				canvas3d.deleteTexture(own);
				canvas3d.deleteTexture(left);
				this.recompose();
			},
		};
	}

	override transform(change: DocumentChange) {
		if (!this.image || !this.stack)
			return undefined;
		const layers = this.stack;
		const before = layers.snapshot(layers.index(this.layer));	// (whatever is done, the same layer is current)
		let after: Snapshot | undefined;

		// a layer's mask as the layer is moved: its rectangle goes where it is carried, its pixels turn with it
		// (`place` says where the top left of a rectangle goes)
		function moveLayer(layer: Layer, place: (area: float2.extent) => float2, apply: <P extends Pixels>(m: P) => P) {
			const m = layer.mask, maskAt = m && place(placedRect(m));
			const mask = m && maskAt && {...m, left: maskAt.x, top: maskAt.y, image: apply(m.image)};
			if (layer.kind === 'adjustment')
				return {...layer, mask};
			const at = place(placedRect(layer));
			return {...layer, left: at.x, top: at.y, image: apply(layer.image), mask};
		}

		function moveLayers(before: Snapshot, place: (area: float2.extent) => float2, apply: <P extends Pixels>(m: P) => P, layer?: Layer) {
			if (layer) {
				const moved = moveLayer(layer, place, apply);
				return moved && {...before, layers: before.layers.map((l, i) => i === before.current ? moved : l)};
			} else {
				return {...before, layers: before.layers.map(l => moveLayer(l, place, apply))};
			}
		}

		switch (change.kind) {
			case 'flip':
				after = moveLayers(before,
					area => float2(change.horizontal ? before.width - area.max.x : area.min.x, change.horizontal ? area.min.y : before.height - area.max.y),
					i => flip(i, change.horizontal)
				);
				break;

			case 'rotate':
				after = moveLayers(before,
					area => float2(change.clockwise ? before.height - area.max.y : area.min.y, change.clockwise ? area.min.x : before.width - area.max.x),
					i => rotate(i, change.clockwise)
				);
				// (the canvas is turned too)
				after = after && {...after, width: before.height, height: before.width};
				break;

			case 'crop': {
				const {x, y} = change.rect.min, {x: width, y: height} = change.rect.size();
				after = {
					width, height, current: before.current,
					layers: before.layers.map(l => {
						const mask = l.mask && {...l.mask, left: l.mask.left - x, top: l.mask.top - y};
						return l.kind === 'adjustment' ? {...l, mask} : {...l, left: l.left - x, top: l.top - y, mask};
					}),
				};
				break;
			}
			case 'warp': {
				const carry = change.carry;
				const layer = change.target === 'layer' ? before.layers[before.current] : undefined;
				if (layer && change.selection) {
					const selection = change.selection, index = before.current;
					after = {...before, layers: before.layers.map((l, k) => k === index && l.kind !== 'adjustment' ? {...l, image: warpSelected(l.image, selection, carry, warpPixels)} : l)};
					break;
				}
				// (only moved by whole pixels, the layers are not resampled)
				const n = carry instanceof Warp ? undefined : carry.scale(1 / carry.z.z);
				if (n && approx_equal(n.x, float3(1, 0, 0)) && approx_equal(n.y, float3(0, 1, 0)) && approx_equal(n.z.xy, float2(Math.round(n.z.x), Math.round(n.z.y)))) {
					const shiftx = Math.round(n.z.x), shifty = Math.round(n.z.y);
					after = moveLayers(before,
						area => area.min.add(float2(shiftx, shifty)),
						i => i,
						layer
					);
				} else {
					const clip = layer && imageRect(before);
					let local: Carry;
					let area: float2.extent | undefined;
					after = moveLayers(before,
						from => {
							const size = from.size();
							local	= shiftCarry(carry, from.min);
							area	= carriedBounds(local, float2.extent.fromSize(float2(0, 0), size));
							if (area) {
								if (clip)
									area = area.intersect(clip);
								if (!area.empty())
									return area.min;
								area = undefined;
							}
							return from.min;
						},
						i => area ? warpPixels(i, local, area) : i,
						layer
					);
				}
				break;
			}
		}

		// the vector data that layers keep (a shape's path and its gradients) goes where the picture is carried, as the pixels did
		if (after && !(change.kind === 'warp' && change.selection)) {
			const W = before.width, H = before.height;
			let map: ((x: number, y: number) => [number, number]) | undefined;
			switch (change.kind) {
				case 'flip':	map = change.horizontal ? (x, y) => [W - x, y] : (x, y) => [x, H - y]; break;
				case 'rotate':	map = change.clockwise ? (x, y) => [H - y, x] : (x, y) => [y, W - x]; break;
				case 'crop':	{ const {x: cx, y: cy} = change.rect.min; map = (x, y) => [x - cx, y - cy]; break; }
				case 'warp':	{
					const carry = change.carry;
					map = (x, y) => {
						const p = carryPoint(carry, float2(x, y));
						return [p.x, p.y];
					};
					break;
				}
			}
			const moved = after, carry = map;
			if (carry) {
				after = {...moved, layers: moved.layers.map((l, i) =>
					l.blocks && (change.kind !== 'warp' || change.target !== 'layer' || i === before.current && !((maskBlock(l.blocks)?.flags ?? 0) & 2)) ? {...l, blocks: transformBlocks(l.blocks, carry, before, moved)} : l)};
			}
		}

		// a text layer that is carried has its text carried, and set again (so it is crisp, not warped pixels)
		if (after && change.kind === 'warp' && change.target === 'layer' && !change.selection) {
			const index = before.current, l = after.layers[index], carry = change.carry, {width, height} = after;
			if (l.kind === 'text')
				after = {...after, layers: after.layers.map((k, i) => i === index ? carryText(l, carry, width, height) : k)};
		}

		if (!after)
			return undefined;

		const resized	= !(change.kind === 'warp' && change.target === 'layer');
		const use		= (s: Snapshot) => () => {
			const self = this.live, layers = self.stack;
			layers.restore(s);
			self.layer = layers.layers[s.current];
			if (self.layer.kind !== 'adjustment')
				expand(self.layer, layers.width, layers.height);	// what the tools draw on covers the canvas
			self.fan.reset();
			if (self.image.width !== layers.width || self.image.height !== layers.height)
				self.image	= new ImageData(layers.width, layers.height);
			self.pan.width	= self.image.width;
			self.pan.height	= self.image.height;
			self.recompose();
			if (resized)
				self.fit();
			self.redraw();
		};
		use(after)();
		return {undo: use(before), redo: use(after)};
	}

	// Images dropped on it become layers above the current one: all of it one edit
	protected override async dropped(items: Dropped[]) {
		const prev = this.layer;
		const made = items.map(it => newLayer(it.name, {data: it.pixels.data, width: it.pixels.width, height: it.pixels.height}));
		const last = made[made.length - 1];
		let at = 0;
		const redo = () => {
			const self = this.live, stack = self.stack;
			at = stack.layers.indexOf(self.layer!) + 1;
			stack.layers.splice(at, 0, ...made);
			self.layer = last;
			expand(last, stack.width, stack.height);	// what the tools draw on covers the canvas
			self.recompose();
		};
		const undo = () => {
			const self = this.live;
			self.stack.layers.splice(at, made.length);
			self.layer = prev;
			self.recompose();
		};
		redo();
		history.record(made.length > 1 ? 'Add Layers' : 'Add Layer', undo, redo);
	}

	// the picture again from the layers (all of it, or a part), and what shows of it
	recompose(area?: float2.extent, carried?: Layer) {
		if (this.compositor && this.stack) {
			// (the layer being transformed is drawn on its own, as it is carried)
			const layers = carried ? this.stack.layers.map(l => l === carried ? {...l, visible: false} : l) : this.stack.layers;
			this.compositor.compose(this.stack.width, this.stack.height, layers, area);
			this.texture = this.compositor.texture;
			if (this.live === this)
				this.syncShape();
			this.redraw();
		}
	}

	override run(op: string) {
		switch (op) {
			case 'newLayer':	this.addNewLayer(); return true;
			case 'deleteLayer':	return this.layer ? (this.removeLayer(this.layer), true) : false;
			case 'raiseLayer':	return this.layer ? (this.moveLayer(this.layer, 1), true) : false;
			case 'lowerLayer':	return this.layer ? (this.moveLayer(this.layer, -1), true) : false;
			default:			return super.run(op);
		}
	}

	// a layer moved to another place in the order, by index: it is one edit when it is dropped
	dragger(layer: Layer): Drag {
		let drag: {layer: Layer, order: Layer[]} | undefined;
		const stack = this.stack;
		const changed = () => this.live.recompose();

		return {
			begin() {
						drag = {layer, order: stack.layers.slice()};
			},
			to(index: number) {
				if (!drag)
					return;
				const layer = drag.layer;
				const to = Math.max(0, Math.min(stack.layers.length - 1, index));
				if (stack.layers.indexOf(layer) === to)
					return;
				stack.layers.splice(stack.layers.indexOf(layer), 1);
				stack.layers.splice(to, 0, layer);
				changed();
			},
			drop() {
				const drag2 = drag;
				drag = undefined;
				if (!drag2 || stack.layers.every((l, i) => l === drag2.order[i]))
					return;
				const after = stack.layers.slice();
				const put	= (order: Layer[]) => () => {
					stack.layers = order.slice();
					changed();
				};
				history.record('Move Layer', put(drag2.order), put(after));
			}
		};
	}

	override raw() {
		const raw = super.raw();
		if (raw && this.stack)
			raw.layers = this.stack.layers.map(layer => {
				const m		= layer.mask;
				const mask	= m && {left: m.left, top: m.top, width: m.image.width, height: m.image.height, default: m.default, disabled: m.disabled, inverted: m.inverted, density: m.density, feather: m.feather, data: m.image.data};
				const ext	= layer.kind === 'adjustment' ? undefined : alphaExtent(layer.image);
				const size	= ext?.size() ?? float2(0, 0);
				const off 	= ext && layer.kind !== 'adjustment' ? float2(layer.left, layer.top).add(ext.min) : float2(0, 0);

				return {
					name:	layer.name, opacity: layer.opacity, visible: layer.visible, blend: layer.blend, clipped: layer.clipped, blocks: layer.blocks,
					left: 	off.x, top: off.y, width: size.x, height: size.y,
					data:	ext && layer.kind !== 'adjustment' ? crop(layer.image, ext).data.slice().buffer : new Uint8ClampedArray(0).buffer,
					mask:	mask && {...mask, data: (mask.data as Uint8ClampedArray).slice().buffer},
					vectorMaskDensity: layer.vectorMaskDensity, vectorMaskFeather: layer.vectorMaskFeather,
				};
			});
		return raw;
	}
}

//-----------------------------------------------------------------------------
// GPU
//-----------------------------------------------------------------------------

function layerThumbnail(width: number, height: number, size: number, layer: PixelLayer) {
	const {left, top}		= layer;
	const k		= size / Math.max(width, height);
	const w		= Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
	const canvas = createElement('canvas', {width: w, height: h});
	const ctx	= canvas.getContext('2d')!;
	const out	= ctx.createImageData(w, h);
	const small = shapeSmall(layer, width, height, w, h) ?? (layer.image.width && layer.image.height
		? warpPixels(layer.image, float3x3(float3(w / width, 0, 0), float3(0, h / height, 0), float3(left * w / width, top * h / height, 1)), new float2.extent(float2(0, 0), float2(w, h)))
		: undefined);
	const over = effectLayers(layer, width, height).map(e => ({
		alpha:	layer.opacity ? Math.min(1, e.opacity / layer.opacity) : 1,
		pixels:	e.image.width && e.image.height
			? warpPixels(e.image, float3x3(float3(w / width, 0, 0), float3(0, h / height, 0), float3(e.left * w / width, e.top * h / height, 1)), new float2.extent(float2(0, 0), float2(w, h)))
			: undefined,
	}));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o		= (y * w + x) * 4;
			const check = ((x >> 2) + (y >> 2)) & 1 ? 204 : 255;
			const a		= small ? small.data[o + 3] / 255 : 0;
			for (let c = 0; c < 3; c++)
				out.data[o + c] = (small ? small.data[o + c] : 0) * a + check * (1 - a);
			for (const m of over) {
				const b = m.pixels ? m.pixels.data[o + 3] / 255 * m.alpha : 0;
				for (let c = 0; c < 3; c++)
					out.data[o + c] = (m.pixels ? m.pixels.data[o + c] : 0) * b + out.data[o + c] * (1 - b);
			}
			out.data[o + 3] = 255;
		}
	}
	ctx.putImageData(out, 0, 0);
	return canvas;
};

// A picture's layers on the GPU: each layer is a texture of its own, and the picture is made from them by drawing them
// one over another, each with its blend mode, in float buffers. Only what has changed is made again: a stroke on a layer
// is a rectangle of its texture and of the picture; showing, hiding, reordering and opacity are only the drawing.

const fills = new WeakMap<Layer, {blocks: unknown, size: string, layer: Layer | undefined}>();

function makeFill(layer: Layer, width: number, height: number): Layer | undefined {
	const adjust = adjustment(layer.blocks);
	if (adjust)
		return {kind: 'adjustment', name: '', opacity: 1, visible: true, blend: 'norm', adjust, blocks: layer.blocks};	// (its blocks for its vector mask)
	return layer.kind === 'adjustment' ? undefined : fillLayer(layer, width, height);
}

// the layer as the compositor is to have it: what a fill layer shows, with the layer's own mode and the like, or the layer itself
function shown(layer: Layer, width: number, height: number): Layer {
	const size = `${width}x${height}`;
	let entry = fills.get(layer);
	if (!entry || entry.blocks !== layer.blocks || entry.size !== size) {
		entry = {blocks: layer.blocks, size, layer: makeFill(layer, width, height)};
		fills.set(layer, entry);
	}
	const fill = entry.layer;
	if (!fill)
		return layer;

	fill.name		= layer.name;
	fill.visible	= layer.visible;
	fill.opacity	= layer.opacity;
	fill.blend		= layer.blend;
	fill.mask		= layer.mask;
	fill.vectorMaskDensity	= layer.vectorMaskDensity;
	fill.vectorMaskFeather	= layer.vectorMaskFeather;
	fill.clipped	= layer.clipped;
	return fill;
}

// a mask's pixels as a texture, and (if it is feathered) them blurred, which are as much bigger each way as the blur reaches
type MaskEntry = {texture: WebGLTexture, image: unknown, feather: number | undefined, outside: number, soft?: Offscreen};

// a texture the compositor made, and what it made of it
const dropTexture = (canvas3d: Canvas3D, entry: {texture: WebGLTexture, soft?: Offscreen}) => {
	canvas3d.deleteTexture(entry.texture);
	entry.soft?.delete();
};

class LayerCompositor {
	private textures = new Map<Layer, {texture: WebGLTexture, image: unknown}>();
	private masks = new Map<Layer, MaskEntry>();
	private vectorMasks = new Map<Layer, MaskEntry>();	// their vector masks, as they are drawn
	private luts = new Map<Layer, {texture: WebGLTexture, table: unknown}>();	// the tables of the adjustment layers
	private noMask: WebGLTexture | undefined;		// for a layer which has none, as something has to be bound
	private result: Offscreen | undefined;			// the picture
	private scratch: Offscreen[] = [];				// what is drawn into on the way to it
	private groups: Offscreen[] = [];				// and where a layer with layers clipped to it is made first, which is only if there are some
	private float: boolean;
	width = 0;
	height = 0;

	private effects: EffectRenderer | undefined;	// which makes the layers that are styles (Layer.effect)

	constructor(private canvas3d: Canvas3D, private program: ShaderProgram, programEffect?: ShaderProgram, private programBlur?: ShaderProgram) {
		this.effects = programEffect && new EffectRenderer(canvas3d, programEffect);
		// half floats keep the picture exact however many layers are drawn over each other; bytes are the way out when
		// they can't be drawn into
		this.float = !!canvas3d.gl.getExtension('EXT_color_buffer_float');
	}

	// the picture, which changes when the size does; undefined before it is first made
	get texture() {
		return this.result?.texture;
	}

	//-------------------------------------------------------------------------
	// the layers' textures
	//-------------------------------------------------------------------------

	// a layer's texture, made now if it has not been (or the layer's pixels are another image's, as when it is expanded)
	layerTexture(layer: Layer) {
		if (layer.kind === 'adjustment')
			return this.dummyMask();
		const entry = this.textures.get(layer);
		if (entry && entry.image === layer.image)
			return entry.texture;
		if (entry)
			this.canvas3d.deleteTexture(entry.texture);
		if (!layer.image.width || !layer.image.height) {
			this.textures.delete(layer);
			return undefined;
		}
		const texture = layer.effect ? this.effects?.render(layer.effect, this.width, this.height) : this.canvas3d.createTextureFromImage(layer.image);
		if (!texture) {
			this.textures.delete(layer);
			return undefined;
		}
		this.textures.set(layer, {texture, image: layer.image});
		return texture;
	}

	/** A layer's mask as it is drawn through, its texture made now (one with no pixels is what it is outside them everywhere, and is
	 *  drawn through a texture of nothing); undefined if it has none, or it is off. */
	maskTexture(layer: Layer) {
		const mask = layer.mask;
		return mask && !mask.disabled ? this.maskOf(this.masks, layer, mask) : undefined;
	}

	// and its vector mask, as it is drawn on a canvas of the compositor's size
	vectorMaskTexture(layer: Layer) {
		const mask = vectorMask(layer, this.width, this.height);
		return mask && this.maskOf(this.vectorMasks, layer, mask);
	}

	// A mask's texture, made again if its pixels (or how they are blurred) have changed: a feathered one is blurred on the GPU, into a
	// rectangle as much bigger as the blur reaches. Inverting it and its density are the shaders'.
	private maskOf(masks: Map<Layer, MaskEntry>, layer: Layer, mask: LayerMask): QuadMask {
		const {width, height} = mask.image, feather = featherReach(mask) ? mask.feather : undefined;
		let entry = masks.get(layer);
		if (!(entry && entry.image === mask.image && entry.feather === feather && entry.outside === mask.default)) {
			if (entry)
				dropTexture(this.canvas3d, entry);
			masks.delete(layer);
			entry = undefined;
			if (width && height) {
				const texture = this.canvas3d.createTexture(width, height, mask.image.data, {format: 'r8', min: 'nearest', mag: 'nearest'});
				entry = {texture, image: mask.image, feather, outside: mask.default};
				this.soften(entry, width, height);
				masks.set(layer, entry);
			}
		}
		const reach = entry?.soft ? featherReach(mask) : 0;
		return {
			texture:	entry ? entry.soft?.texture ?? entry.texture : this.dummyMask(),
			area:		float2.extent.fromSize(float2(mask.left - reach, mask.top - reach), float2(width + reach * 2, height + reach * 2)),
			outside:	mask.default,
			inverted:	mask.inverted,
			density:	mask.density ?? 255,
		};
	}

	// a feathered mask's pixels blurred (again), from its texture; left sharp where the GPU cannot blur them
	private soften(entry: MaskEntry, width: number, height: number) {
		entry.soft?.delete();
		entry.soft = entry.feather && this.programBlur ? blurMask(this.canvas3d, this.programBlur, entry.texture, width, height, entry.feather, entry.outside / 255) : undefined;
	}

	// an adjustment layer's tables as a texture, made now if it has not been
	lutTexture(layer: Layer) {
		const adjust = layer.kind === 'adjustment' ? layer.adjust : undefined;
		if (adjust?.kind !== 'table')
			return undefined;
		const entry = this.luts.get(layer);
		if (entry && entry.table === adjust.table)
			return entry.texture;
		if (entry)
			this.canvas3d.deleteTexture(entry.texture);
		const texture = this.canvas3d.createTexture(256, 4, adjust.table as Uint8ClampedArray<ArrayBuffer>, {format: 'r8', min: 'nearest', mag: 'nearest'});
		this.luts.set(layer, {texture, table: adjust.table});
		return texture;
	}

	// something to bind where a layer has no mask
	dummyMask() {
		return this.noMask ??= this.canvas3d.createTexture(1, 1, new Uint8ClampedArray(1), {format: 'r8', min: 'nearest', mag: 'nearest'});
	}

	// some of a mask's pixels have changed (all of them, without a rect), whichever layers have it (a fill's has its layer's)
	uploadMask(image: Pixels<1>, rect?: float2.extent) {
		for (const entry of this.masks.values()) {
			if (entry.image === image) {
				this.canvas3d.updateTexture(entry.texture, Pixels(image.data, image.width, image.height, 1), rect);
				if (entry.feather)
					this.soften(entry, image.width, image.height);
			}
		}
	}

	// some of a layer's pixels have changed (all of them, without a rect)
	upload(layer: PixelLayer, rect?: float2.extent) {
		const entry = this.textures.get(layer);
		if (entry && entry.image === layer.image)
			this.canvas3d.updateTexture(entry.texture, layer.image, rect);
		// else there is no texture yet, or it is of other pixels: it is made, from these, when it is next wanted
	}

	//-------------------------------------------------------------------------
	// composing
	//-------------------------------------------------------------------------

	private target(width: number, height: number) {
		const canvas3d = this.canvas3d;
		try {
			return canvas3d.createOffscreen(width, height, this.float ? 'rgba16f' : 'rgba8');
		} catch (error) {
			if (!this.float)
				throw error;
			this.float = false;
			return canvas3d.createOffscreen(width, height, 'rgba8');
		}
	}

	private deleteTargets() {
		this.result?.delete();
		for (const s of [...this.scratch, ...this.groups])
			s.delete();
		this.result = undefined;
		this.scratch = [];
		this.groups = [];
	}

	// The layers, bottom first, composed into the picture: all of it, or the part inside rect
	compose(width: number, height: number, layers: Layer[], rect?: float2.extent) {
		const {canvas3d} = this;

		/** The layers with each one's styles after it (and a fill layer as what it shows), as the compositor takes them. */
		layers = layers.flatMap(layer => layer.kind === 'adjustment' ? [shown(layer, width, height)] : [
			...styleLayers(layer, width, height, true).map(p => p.layer),
			shown(layer, width, height),
			...styleLayers(layer, width, height, false).map(p => p.layer),
		]);

		// textures for the layers there are, and none for those there are not
		const live = new Set(layers);
		for (const textures of [this.textures, this.masks, this.vectorMasks, this.luts]) {
			for (const [layer, entry] of textures) {
				if (!live.has(layer)) {
					dropTexture(canvas3d, entry);
					textures.delete(layer);
				}
			}
		}
		this.dummyMask();

		if (!this.result || this.width !== width || this.height !== height) {
			this.deleteTargets();
			this.width = width;
			this.height = height;
			this.result = this.target(width, height);
			this.scratch = [this.target(width, height), this.target(width, height)];
			rect = undefined;
		}

		const x0 = Math.max(0, rect ? rect.min.x : 0), y0 = Math.max(0, rect ? rect.min.y : 0);
		const x1 = Math.min(width, rect ? rect.max.x : width), y1 = Math.min(height, rect ? rect.max.y : height);
		if (x1 <= x0 || y1 <= y0)
			return;

		// What is to be drawn, bottom first: each layer, with the layers clipped to it (the ones directly above it which say they
		// are), which are drawn onto it first, as a group. Only layers which are shown and reach the part to be made are.
		// (a style is made when it is first looked for: before anything is drawn, which making it would disturb)
		const reaches = (l: Layer) => l.visible && l.opacity > 0 && (l.kind === 'adjustment'
			|| l.image.width > 0 && l.image.height > 0 && l.left < x1 && l.top < y1 && l.left + l.image.width > x0 && l.top + l.image.height > y0
			&& (!l.effect || !!this.layerTexture(l)));
		const items: {base: Layer, clipped: Layer[]}[] = [];
		const groups: {base: Layer, clipped: Layer[]}[] = [];
		for (const layer of layers) {
			if (layer.clipped && groups.length)
				groups[groups.length - 1].clipped.push(layer);
			else
				groups.push({base: layer, clipped: []});
		}
		for (const group of groups)
			if (reaches(group.base))
				items.push({base: group.base, clipped: group.clipped.filter(reaches)});

		// Their textures, and the buffers a group needs, first: making either binds it, to whichever texture unit is active,
		// which would be the one of a texture bound to be drawn from
		// (a feathered mask is blurred as its texture is made, which draws into targets of its own)
		const textures = new Map<Layer, {texture: WebGLTexture, mask: QuadMask | undefined, vmask: QuadMask | undefined, lut: WebGLTexture | undefined}>();
		for (const item of items) {
			for (const layer of [item.base, ...item.clipped])
				textures.set(layer, {texture: this.layerTexture(layer)!, mask: this.maskTexture(layer), vmask: this.vectorMaskTexture(layer), lut: this.lutTexture(layer)});
		}
		if (items.some(item => item.clipped.length) && !this.groups.length)
			this.groups = [this.target(width, height), this.target(width, height)];

		const gl	= canvas3d.gl
		const blend = gl.isEnabled(gl.BLEND);
		gl.disable(gl.BLEND);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(x0, y0, x1 - x0, y1 - y0);
		canvas3d.clearColour(0, 0, 0, 0);

		const clear = (target: Offscreen) => {
			target.begin();
			canvas3d.clear(true, false);
		};

		// a layer, or what a group has made, over what has been made so far
		const draw = (from: Offscreen, to: Offscreen, layer: Layer, mode: BLEND_MODE, opacity: number, clip: boolean, own?: WebGLTexture) => {
			const t = textures.get(layer);
			const mask		= own ? undefined : t!.mask, vmask = own ? undefined : t!.vmask;
			const whole		= own || layer.kind === 'adjustment';		// (an adjustment is of the whole canvas)
			const adjust	= !own && layer.kind === 'adjustment' ? layer.adjust : undefined;
			to.begin();
			canvas3d.bindTexture2D(from.texture, 0);
			canvas3d.bindTexture2D(own ?? t!.texture, 1);
			canvas3d.bindTexture2D(mask?.texture ?? this.noMask!, 2);
			canvas3d.bindTexture2D(!own && t!.lut ? t!.lut : this.noMask!, 3);
			canvas3d.bindTexture2D(vmask?.texture ?? this.noMask!, 4);
			this.program.draw({
				u_backdrop:	0,
				u_layer:	1,
				u_origin:	whole ? [0, 0] : [layer.left, layer.top],
				u_size:		whole ? [width, height] : [layer.image.width, layer.image.height],
				u_opacity:	opacity,
				u_mode:		BLEND_MODES[mode] ?? 0,
				u_clip:		clip ? 1 : 0,
				u_adjust:	!adjust ? 0 : adjust.kind === 'table' ? 1 : adjust.kind === 'threshold' ? 2 : adjust.kind === 'hue' ? 3 : adjust.kind === 'mono' ? 4 : 5,
				u_lut:		3,
				u_level:	adjust?.kind === 'threshold' ? adjust.level : 0,
				u_bal0:		adjust?.kind === 'balance' ? adjust.tones[0] : [0, 0, 0],
				u_bal1:		adjust?.kind === 'balance' ? adjust.tones[1] : [0, 0, 0],
				u_bal2:		adjust?.kind === 'balance' ? adjust.tones[2] : [0, 0, 0],
				u_preserve:	adjust?.kind === 'balance' && adjust.preserve ? 1 : 0,
				u_bw0:		adjust?.kind === 'mono' ? adjust.weights.slice(0, 3) : [0, 0, 0],
				u_bw1:		adjust?.kind === 'mono' ? adjust.weights.slice(3, 6) : [0, 0, 0],
				u_hsl:		adjust?.kind === 'hue' ? [adjust.hue, adjust.saturation, adjust.lightness] : [0, 0, 0],
				u_mask:			2,
				u_hasMask:		mask ? 1 : 0,
				u_maskOrigin:	[mask?.area.min.x ?? 0, mask?.area.min.y ?? 0],
				u_maskSize:		[mask?.area.size().x ?? 0, mask?.area.size().y ?? 0],
				u_maskDefault:	(mask?.outside ?? 255) / 255,
				u_maskInvert:	mask?.inverted ? 1 : 0,
				u_maskDensity:	(mask?.density ?? 255) / 255,
				u_vmask:		4,
				u_hasVmask:		vmask ? 1 : 0,
				u_vmaskOrigin:	[vmask?.area.min.x ?? 0, vmask?.area.min.y ?? 0],
				u_vmaskSize:	[vmask?.area.size().x ?? 0, vmask?.area.size().y ?? 0],
				u_vmaskDefault:	(vmask?.outside ?? 255) / 255,
				u_vmaskInvert:	vmask?.inverted ? 1 : 0,
				u_vmaskDensity:	(vmask?.density ?? 255) / 255,
			});
		};

		if (!items.length) {
			clear(this.result);
		} else {
			// each is drawn over what has been made so far, which goes from one scratch buffer to the other, and the last
			// goes into the picture
			let from = this.scratch[0];
			clear(from);
			items.forEach(({base, clipped}, i) => {
				const to = i === items.length - 1 ? this.result! : from === this.scratch[0] ? this.scratch[1] : this.scratch[0];
				if (!clipped.length) {
					draw(from, to, base, base.blend, base.opacity, false);
				} else {
					// The group is made on its own: the layer as it is (its mask applied, whatever its mode and opacity,
					// which are for the group), and each layer clipped to it over that. Its alpha is the layer's, which
					// is what they are clipped to. Then the group goes over what is below, with the layer's mode and opacity.
					const [a, b] = this.groups;
					clear(a);
					draw(a, b, base, 'norm', 1, false);
					let made = b, other = a;
					for (const layer of clipped) {
						draw(made, other, layer, layer.blend, layer.opacity, true);
						[made, other] = [other, made];
					}
					draw(from, to, base, base.blend, base.opacity, false, made.texture);
				}
				from = to;
			});
			for (const unit of [4, 3, 2, 1, 0])
				canvas3d.bindTexture2D(null, unit);
		}

		gl.disable(gl.SCISSOR_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		if (blend)
			gl.enable(gl.BLEND);
	}

	// The pixels of the picture inside the rectangle, as 8-bit rgba (not premultiplied), the first row on top
	read(rect: float2.extent): PixelStorage | undefined {
		if (!this.result)
			return;

		const out = this.result?.readPixels(rect);
		if (!this.float)
			return out;

		const out2 = new Uint8ClampedArray(out.length);
		for (let i = 0; i < out.length; i++)
			out2[i] = Math.round(out[i] * 255);
		return out2;
	}

	release() {
		for (const textures of [this.textures, this.masks, this.vectorMasks, this.luts]) {
			for (const entry of textures.values())
				dropTexture(this.canvas3d, entry);
			textures.clear();
		}
		if (this.noMask)
			this.canvas3d.deleteTexture(this.noMask);
		this.noMask = undefined;
		this.deleteTargets();
		this.width = this.height = 0;
	}
}

