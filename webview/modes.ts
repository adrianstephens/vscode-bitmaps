// What the bitmap viewer's modes share: the page's canvas and the programs it draws with, the tools, the current mode,
// and the modes the others are made from (Mode, PanMode, PictureMode)
import { Tooltip, vscode, RPC } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, rectGeometry, bitmapToImage, Pixels, RGBAPixels, RGBA, asRGBA, imageSize, imageRect, getPixel } from './opengl.js';
import { float2, float3, float2x3, float3x3, float4x4 } from '@isopodlabs/maths/vector';
import { Selection } from './bitmapSelection.js';
import { Painter, PaintHost, type ShadePreview, type CloneSource } from './paint.js';
import { Transformer, DocumentChange, TransformTarget, TransformSession } from './transform.js';
import { History, type HistoryEntry } from './history.js';
import { SheetFan } from './sheetfan.js';
import { Cascade, CascadeItem, mergeItems, valueItem, toggleItem, svgFace, icons } from './cascade.js';
import { warp, meshWarp, shade, ShadePass, drawQuad, alphaExtent, liftSelection, warpSelected } from './raster.js';
import { Warp, type Carry, carriedBounds, planar } from './transformbox.js';
import { Pan } from './pan.js';
import { NavigateHooks, Input, Place } from './navigate.js';
import type { RawImage, MessageOut, shaderType } from './bitmap.js';

export interface Dropped { name: string, pixels: ImageData }

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const canvas: HTMLCanvasElement	= $('viewport');
export const canvas3d	= new Canvas3D(canvas, {onError: message => postMessage({command: 'error', message})});
export const tooltip 	= new Tooltip();

export let programBG:		ShaderProgram;
export let programLayer:	ShaderProgram;	// what layers (and slices) are drawn with, in the fan and as one is transformed
const filterPrograms: Record<string, ShaderProgram> = {};	// the other filters' shaders, by name (see Mode.shade)
let programWarp:	ShaderProgram;	// what carries pictures onto another plane, for a transform and for the menu's thumbnails
export let programTextWarp:	ShaderProgram;	// what carries a picture by a mesh: the flat text to where its warp puts it, and a warp transform
export let blank:			WebGLTexture;	// transparent, to bind where nothing is wanted

// (made once: a program is for the page, where a mode is for one picture)
const shaders = new Map<string, Promise<ShaderProgram>>();
export function shader(type: shaderType, geometry = rectGeometry) {
	let program = shaders.get(type);
	if (!program)
		shaders.set(type, program = RPC<{vert: string, frag: string}>({command: 'getShaders', type}).then(code => canvas3d.createProgram(code, geometry)));
	return program;
}

// the programs the modes draw with, made once as the page starts
export async function loadPrograms() {
	programBG		= await shader('bg');
	programWarp		= await shader('warp');
	for (const name of ['blur', 'levels', 'convolve', 'gradient'] as const)
		filterPrograms[name] = await shader(name);
	programLayer	= await shader('layer', gridGeometry(32));
	programLayer.use({u_span: [0, 0, 1, 1]});	// (all of each layer, unless a warp says otherwise)
	programTextWarp	= await shader('textwarp');
	blank			= canvas3d.createTextureFromImage({data: new Uint8ClampedArray(4), width: 1, height: 1});
}

// a square from -1 to 1 cut into n x n, which the layer program draws (as many as there are for a warp to bend: a plane takes no more time)
function gridGeometry(n: number) {
	const data: number[] = [], at = (i: number, j: number) => [i / n * 2 - 1, j / n * 2 - 1];
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++)
			data.push(...at(i, j), ...at(i + 1, j), ...at(i, j + 1), ...at(i, j + 1), ...at(i + 1, j), ...at(i + 1, j + 1));
	return {size: 2, data: new Float32Array(data)};
}

export function postMessage(message: MessageOut) {
	vscode.postMessage(message);
}

//-----------------------------------------------------------------------------
// matrices
//-----------------------------------------------------------------------------

function canvasMatrix(size: float2) {
	return float2x3(float2(2 / size.x, 0), float2(0, -2 / size.y), float2(-1, 1));
}

// where a picture, drawn by an affine (from its own pixels to the window's, to clip space) after the homography `matrix`, lands: as a
// 4x4 matrix of (x, y, 0, 1), with the homography's divisor in w
export function planeMvp(base: float2x3, matrix: float3x3, z = 1) {
	return float4x4.from2D(float3x3.from2D(base).matmul(matrix), z);
}

// The picture as it lies flat on the window, for the fan to open from: the 2D view's matrix, in the model's own measure (the
// picture's longest side is 1), with every sheet at no depth.
export function flatView(base: float2x3, longest: number) {
	return planeMvp(base, float3x3(float3(longest, 0, 0), float3(0, longest, 0), float3(0, 0, 1)), 0);
}

//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// the tool menu's part about what is seen, rather than what is drawn: which layer or slice, and the 3D view
export const stackIcon = '<path d="M2 5.5L8 3l6 2.5L8 8z"/><path d="M2 8.5L8 11l6-2.5"/><path d="M2 11.5L8 14l6-2.5"/>';
export const menuIcon = {
	eye:	'<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
	trash:	'<path d="M3 5h10M6 5V3h4v2M4.5 5l.5 8.5h6l.5-8.5"/>',
	plus:	'<path d="M8 3v10M3 8h10"/>',
	shape:	'<path d="M3 12C3 5 8 3 13 4C12 9 9 13 3 12z"/><rect x="2" y="11" width="2" height="2"/><rect x="12" y="3" width="2" height="2"/>',
	mask:	'<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="8" cy="8" r="2.5"/>',
	vectorMask:	'<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 10.5C5 6 11 10 11 5.5"/><rect x="4" y="9.5" width="2" height="2"/><rect x="10" y="4.5" width="2" height="2"/>',
	invert:	'<circle cx="8" cy="8" r="5"/><path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor"/>',
	select:	'<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.5"/>',
	alpha:	'<rect x="2.5" y="3.5" width="11" height="9"/><rect x="2.5" y="3.5" width="5.5" height="4.5" fill="currentColor"/><rect x="8" y="8" width="5.5" height="4.5" fill="currentColor"/>',
	apply:	'<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5.5 8l2 2 3.5-4"/>',
	pixels:	'<path d="M3 3h10v10H3zM3 6.3h10M3 9.6h10M6.3 3v10M9.6 3v10"/>',
	link:	'<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5L7.5 13a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/>',
};

// the 3D view on or off, with how far apart the layers lie (a percentage of the longest side) coming out of it
export function viewToggle(mode: Mode, fan: SheetFan): CascadeItem {
	return {
		...toggleItem('3D view', svgFace(stackIcon), () => fan.on, on => fan.show(on)),
		children: () => [valueItem({
			resolution: 0,
			label: 'gap', caption: 'Space between the layers', min: 1, max: 100, presets: [2, 4, 8, 16, 32],
			//get: () => Math.round(fan.gap * 100), set: v => { fan.gap = v / 100; mode.redraw(); },
			get: () => fan.gap * 100, set: v => { fan.gap = v / 100; mode.redraw(); },
		})],
	};
}


//-----------------------------------------------------------------------------
// modes
//-----------------------------------------------------------------------------

// What the picture is: a plain image, a picture of layers, an array of slices, a cubemap or a volume. A mode is what is done
// differently for each: how it is drawn, moved about in, edited, and kept in a file. One is made for each picture which is loaded,
// holds everything of it (its pixels, its textures, its view), and is given back (`dispose`) when another is made current (`mode`,
// by `enter`).
export abstract class Mode implements PaintHost {

// the tools and the transforms can be used, or cannot (the picture is in 3D, or there is nothing to edit)
static toolsEnabled(on: boolean) {
	painter.enabled(on);
	transformer.enabled(on);
}
// another mode is the current one
static enter(next: Mode) {
	tooltip.hide();
	mode.dispose();
	mode = next;
	painter.host = transformer.host = next;
	Mode.toolsEnabled(true);	// (and one that cannot be drawn on)
	next.activate();
}
// A new picture, in a mode made for it: what was done to the last one (and is being done) is dropped
static enterPicture(next: Mode) {
	history.clear();
	transformer.end(false);
	painter.reset();
	Mode.enter(next);
}

// the fan has come up, or gone away: the tools cannot be used in 3D, and what is drawn over the picture is not part of it
static fanOpened(open: boolean) {
	Mode.toolsEnabled(!open);
	if (open)
		tooltip.hide();
	else
		drawOverlays();
}
static fanTip(text: string | undefined, x: number, y: number) { text === undefined ? tooltip.hide() : tooltip.show(text, x + 12, y + 12); }


	readonly canvas = canvas;
	readonly canvas3d = canvas3d;
	shade(program: string, image: Pixels, area: float2.extent, passes: ShadePass[] | Record<string, any>, reach = 0) { return shade(canvas3d, filterPrograms[program], image, area, passes, reach); }

	// An image shown as a filter's shader draws it from its pixels, by drawing into the texture it is shown from (which its own pixels
	// are put back into at the end)
	previewShade(image: RGBAPixels, program: string, extra: Pixels[] = []): ShadePreview | undefined {
		const shown = this.shownBy(image), shader = filterPrograms[program];
		const target = shown && shader && canvas3d.offscreenOn(shown.texture, image.width, image.height, shown.layer);
		if (!target)
			return undefined;
		const textures = [image, ...extra].map(p => canvas3d.createTextureFromImage(p, {format: p.channels === 1 ? 'r8' : 'rgba8', min: 'nearest', mag: 'nearest'}));
		return {
			show: uniforms => {
				const gl = canvas3d.gl, blend = gl.isEnabled(gl.BLEND);
				gl.disable(gl.BLEND);
				target.begin();
				textures.forEach((t, i) => canvas3d.bindTexture2D(t, i));
				shader.draw({u_image: 0, ...uniforms});
				textures.forEach((_, i) => canvas3d.bindTexture2D(null, i));
				target.end();
				if (blend)
					gl.enable(gl.BLEND);
				canvas3d.initViewport();
				shown.drawn();
			},
			end: () => {
				target.delete(true);
				for (const t of textures)
					canvas3d.deleteTexture(t);
				this.changed(image);
			},
		};
	}
	// the texture an image is shown from (rgba8, the image's size, or a layer of an array of them), and what is to be done once it is drawn into
	protected shownBy(image: RGBAPixels): {texture: WebGLTexture, layer?: number, drawn(): void} | undefined {
		return undefined;
	}

	texture:	WebGLTexture | undefined;

	// the texture it draws from, which another replaces when the pixels change size or count
	protected setTexture(texture: WebGLTexture) {
		if (this.texture)
			canvas3d.deleteTexture(this.texture);
		this.texture = texture;
	}

	// it is the current mode: the page is made to suit it
	activate() {}

	// it is done with: it gives back what it made
	dispose() {
		if (this.texture)
			canvas3d.deleteTexture(this.texture);
		this.texture = undefined;
	}

	abstract picture():		ImageData | undefined;

	//Paint Host
	abstract pick(x: number, y: number): RGBA | undefined;
	abstract target():		RGBAPixels | undefined;
	abstract toImage(x: number, y: number): float2;
	abstract toScreen(p: float2): float2;
	abstract pixelSize():	number;
	abstract redraw():		void;

	//Transform Host
	selection()						{ return painter.selection; }
	setSelection(sel: Selection)	{ painter.selection = sel; }
	select(sel: Selection | undefined, label: string) { painter.select(sel, label); }	// as an edit, which can be undone

	abstract fit():			void;

	tooltip(clientX: number, clientY: number): string | undefined {
		return undefined;
	}
	panelOpened() {						// the tool menu has come up over the picture
		tooltip.hide();
	}

	resized() {}						// the window has changed size

	// editing
	
	menu(): CascadeItem[] {				// more for the tool menu (a View item among them has its strip joined to the page's)
		return [];
	}
	cloneSource(at: float2, all: boolean): CloneSource | undefined {	// what the clone stamp copies from: what the tools draw on, as it is then
		return {
			from:	this.target(),
			at
		};
	}
	changed(changed: RGBAPixels, rect?: float2.extent) {	// pixels of an image have changed
		this.redraw();
	}
	beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		return undefined;
	}
	transform(change: DocumentChange): HistoryEntry | undefined {
		return undefined;
	}
	carryPixels<P extends Pixels>(image: P, carry: Carry, area: float2.extent): P {
		return warpPixels(image, carry, area);
	}
	// Files dropped on it: the images among them are for it to do with as it will
	async drop(files: File[], x: number, y: number) {
		const items: Dropped[] = [];
		for (const file of files) {
			if (!file.type.startsWith('image/'))
				continue;
			try {
				items.push({name: file.name.replace(/\.[^.]*$/, ''), pixels: bitmapToImage(await createImageBitmap(file))});
			} catch {
				// not an image the browser can read
			}
		}
		if (items.length)
			await this.dropped(items, x, y);
	}
	protected async dropped(items: Dropped[], x: number, y: number) {}

	// An operation from the title menu: whether this mode does it (some do not mean anything to some modes)
	run(op: string): boolean | Promise<boolean> {
		return transformer.run(op) || painter.run(op);
	}

	// the picture as pixels, and as the file keeps it, with what is more than pixels
	raw(): RawImage | undefined {
		const image = this.picture();
		return image && {width: image.width, height: image.height, data: image.data.slice().buffer};
	}
}

/*	HIERARCHY
	Mode
		EmptyMode
		PanMode
			AtlasMode
				ArrayMode
				CubeViewMode
					CubeMode
					VolumeMode
			PictureMode
				ImageMode
				LayeredMode
*/

class EmptyMode extends Mode {
	fit() {}
	toImage(x: number, y: number)	{ return float2(0, 0); }
	toScreen(p: float2)				{ return p; }
	pixelSize()						{ return 1; }
	target()						{ return undefined; }
	picture()						{ return undefined; }
	pick(x: number, y: number)		{ return undefined; }
	redraw() {}
}

//-----------------------------------------------------------------------------
// PanMode
// base of AtlasMode,PictureMode
//-----------------------------------------------------------------------------

// A picture seen in a 2D view: zoomed and dragged about
export abstract class PanMode extends Mode implements NavigateHooks {
	// the 2D view of the picture (for a cube, of its unfolded layout)
	readonly pan: Pan = new Pan(canvas, this);
	private unpan = Input.on(canvas).add(this.pan, Place.view);

	// the picture's own pixels to clip space, as the 2D view has them
	protected pictureMatrix() {
		return canvasMatrix(imageSize(canvas)).mulAffine(this.pan.matrix());
	}

	override fit() {
		this.pan.fit();
	}
	override resized() {
		this.pan.clamp();
	}
	override toImage(clientX: number, clientY: number) {
		return this.pan.toImage(clientX, clientY);
	}
	override toScreen(p: float2) {
		return this.pan.toScreen(p);
	}
	override pixelSize() {
		return this.pan.pixelSize();
	}
	override dispose() {
		this.unpan();
		super.dispose();
	}
}

//-----------------------------------------------------------------------------
// PictureMode
//-----------------------------------------------------------------------------

// a 2D picture, in the 2D view
export abstract class PictureMode extends PanMode {

	constructor(public image: ImageData, protected program2D: ShaderProgram) {
		super();
		this.pan.width	= image.width;
		this.pan.height	= image.height;
	}

	// how the picture is drawn while something of it is transformed (in place of drawing it as it is), if it is
	protected preview: (() => void) | undefined;

	// the whole picture is to be transformed: carried over the background
	protected wholeSession(): TransformSession {
		const box = new float2.extent(float2(0, 0), float2(this.image.width, this.image.height));
		return {
			box, target: 'image',
			update: carry => {
				const [matrix, warp] = planar(carry);
				this.preview = () => {
					programBG.draw({u_viewport: [canvas.width, canvas.height]});
					if (this.texture)
						drawQuad(canvas3d, programLayer, this.texture, box, {}, 1, planeMvp(this.pictureMatrix(), matrix), undefined, warp);
				};
				this.redraw();
			},
			end: () => {
				this.preview = undefined;
				this.redraw();
			},
		};
	}

	protected drawFlat() {
		canvas3d.bindTexture2D(this.texture ?? null);
		this.program2D.draw({
			u_texture: 	0,
			u_size:    	[this.image!.width, this.image!.height],
			u_viewport:	[canvas.width, canvas.height],
			u_scale:   	this.pan.scale,
			u_offset:  	[this.pan.offset.x, this.pan.offset.y],
		});
	}

	override redraw() {
		canvas3d.initViewport();
		if (this.preview)
			this.preview();
		else
			this.drawFlat();
		drawOverlays();
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image)
			return undefined;
		const point = canvas3d.toCanvas(clientX, clientY);
		const x = Math.floor((point.x - this.pan.offset.x) / this.pan.scale);
		const y = Math.floor((point.y - this.pan.offset.y) / this.pan.scale);
		const colour = this.pick(x, y);
		return colour && `Pixel ${x}, ${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}
}


//-----------------------------------------------------------------------------
// AtlasMode
//-----------------------------------------------------------------------------

type Slice = RGBAPixels;

// an image of slices, one above another: the faces of a cube, the slices of an array or a volume
export abstract class AtlasMode extends PanMode {
	layer:			Slice | undefined;		// the current slice (or face): the one the tools draw on
	count:			number;
	sliceHeight:	number;
	layers:		Slice[] = [];
	
	// the rectangle of one slice
	get sliceRect() {
		return float2.extent.fromSize(float2(0, 0), float2(this.image.width, this.sliceHeight));
	}
	constructor(public image: ImageData, count: number, makeSlice?: (pixels: ImageData) => Slice) {
		super();
		this.count		= count;
		this.sliceHeight = image.height / count;
		const height = this.sliceHeight, size = image.width * height * 4;
		if (makeSlice) {
			this.layers = Array.from({length: count}, (_, i) => makeSlice(new ImageData(image.data.subarray(i * size, (i + 1) * size), image.width, height)));
			this.layer = this.layers[0];
		}
	}

	setSlice(slice: Slice) {
		this.layer = slice;
		drawOverlays();
	}

	override picture() {
		return this.image;
	}
	override target() {
		return this.layer;
	}
	override pick(x: number, y: number) {
		return this.layer ? asRGBA(getPixel(this.layer, x, y)) : undefined;
	}
	// the slice it was pointed at on, whichever is drawn on
	override cloneSource(at: float2, all: boolean) {
		const i = this.layer ? this.layers.indexOf(this.layer) : -1;
		return i < 0 ? undefined : {
			from: this.layers[i],
			at
		};
	}

	// the slice (or face) `i` has these pixels on the GPU
	protected uploadSlice(i: number, image: RGBAPixels): void {
		throw new Error('there are no slices to put pixels in');
	}
	// where the pixels of slice `i`, carried by this matrix (from its own coordinates), land in clip space (for a warp, the matrix is
	// the identity: the shader bends the slice first)
	protected carriedMvp(i: number, matrix: float3x3): float4x4 {
		throw new Error('there are no slices to carry');
	}
	// what is drawn over the picture while a slice is transformed: the slice, carried
	protected carried: (() => void) | undefined;

	override redraw() {
		this.carried?.();
		drawOverlays();
	}
	// A slice is carried by drawing it over the picture, which has its place left empty while it is
	override beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		const layer	= target === 'layer' ? this.layer : undefined;
		const box	= layer && (selection ? selection.bounds() : alphaExtent(layer));
		if (!layer || !box)
			return undefined;
		const i		= this.layers.indexOf(layer);
		// (what is carried is all of the slice, or what is selected of it, and its place is left with the rest)
		const lifted = selection && liftSelection(layer, selection);
		const own	= canvas3d.createTextureFromImage(lifted ? lifted.floating : layer);
		this.uploadSlice(i, lifted ? lifted.rest : new ImageData(layer.width, layer.height));
		return {
			box, target: 'layer', selection,
			update: carry => {
				const [matrix, warp] = planar(carry);
				this.carried = () => {
					const gl = canvas3d.gl, depth = gl.isEnabled(gl.DEPTH_TEST);
					gl.disable(gl.DEPTH_TEST);
					drawQuad(canvas3d, programLayer, own, imageRect(layer), {}, 1, this.carriedMvp(i, matrix), {matrix, size: imageSize(layer)}, warp);
					if (depth)
						gl.enable(gl.DEPTH_TEST);
				};
				this.redraw();
			},
			end: () => {
				this.carried = undefined;
				canvas3d.deleteTexture(own);
				this.uploadSlice(i, layer);
				this.redraw();
			},
		};
	}

	override transform(change: DocumentChange) {
		return change.kind === 'warp' ? this.warpSlice(change.carry, change.target === 'layer' ? this.layer : undefined, change.selection) : undefined;
	}

	// A slice (or face) carried (its own pixels, in its own coordinates): what is carried off the slice is lost, and what is left is
	// transparent. One edit.
	warpSlice(carry: Carry, layer?: Slice, selection?: Selection): HistoryEntry | undefined {
		const slice = layer ? this.layers.indexOf(layer) : -1;
		if (!layer || slice < 0 || !this.texture)
			return undefined;
		const {width} = layer, whole = imageRect(layer);
		const before = (layer.data as Uint8ClampedArray).slice();
		let after: Uint8ClampedArray;
		if (selection) {
			// (the rest of the slice is as it was)
			after = warpSelected(layer, selection, carry, warpPixels).data as Uint8ClampedArray;
		} else {
			const area = carriedBounds(carry, whole)?.intersect(whole);
			if (!area || area.empty())
				return undefined;
			const warped = warpPixels(layer, carry, area);
			after = new Uint8ClampedArray(before.length);
			const {x: w, y: h} = area.size();
			for (let j = 0; j < h; j++)
				after.set((warped.data as Uint8ClampedArray).subarray(j * w * 4, (j + 1) * w * 4), ((area.min.y + j) * width + area.min.x) * 4);
		}
		const set = (data: Uint8ClampedArray) => () => {
			(layer.data as Uint8ClampedArray).set(data);
			this.uploadSlice(slice, layer);
			this.redraw();
		};
		set(after)();
		return {undo: set(before), redo: set(after)};
	}

}

//-----------------------------------------------------------------------------
// the layer strip
//-----------------------------------------------------------------------------

// A layer or slice is chosen from a strip of them all as thumbnails (the top first), each coming out with more to be done
// to it, and a layer dragged to another place in the strip is moved there; or by the wheel on the icon, which shows the
// one chosen
export function layerChooser<K>(caption: string,
	keys:		()					=> K[],
	current:	()					=> K,
	set:		(k: K)				=> void,
	name:		(k: K)				=> string,
	face:		(k: K)				=> string,
	more:		(k: K)				=> CascadeItem[] | undefined,
	highlight:	(k: K | undefined)	=> void,
	drag?:		(k: K)				=> CascadeItem['drag'],
	extra:		CascadeItem[] = [],
	topFirst = true
): CascadeItem {
	const id = caption.toLowerCase();
	return {
		id,
		face:		() => face(current()),
		caption:	() => `${caption}: ${name(current())} (scroll)`,
		wheel:		steps => {
			const all = keys(), was = all.indexOf(current()), delta = Math.round(steps);
			const now = Math.min(all.length - 1, Math.max(0, was + delta));
			if (now !== was)
				set(all[now]);
			return now === was + delta ? delta : steps;
		},
		children:	() => [
			...(topFirst ? keys().slice().reverse() : keys()).map(k => {
				const children = more(k);
				return {
					id:			`${id}-${keys().indexOf(k)}`,		// (by its place, the bottom one 0)
					face:		() => face(k),
					caption:	() => name(k),
					active:		() => current() === k,
					select:		() => { set(k); },
					children:	children && (() => children),
					drag:		drag?.(k),
					hover:		(on: boolean) => highlight(on ? k : undefined),
				};
			}),
			...extra,
		],
	};
}

//-----------------------------------------------------------------------------
// the current mode
//-----------------------------------------------------------------------------

const emptyMode		= new EmptyMode;
export let mode: Mode		= emptyMode;

// what has been done to the picture, for undo: the edits are told to the extension, which keeps them for VS Code, and sends undo and redo back
export const history = new History(label => postMessage({command: 'edited', label}));

// the menu the right button brings up: the tools, the transforms, and what the current mode adds
const menuItems = () => mergeItems([...painter.menuItems(), ...transformer.menuItems(), ...mode.menu(), ...viewMenu()]);

// the View item, last, with the grid; the mode's (a 3D view, a layer's masks) and an editor's are joined to it
// a View item: what is shown over the picture; all the View items of the menu are one (see mergeItems)
export const viewItem = (children: () => CascadeItem[]): CascadeItem => ({id: 'view', face: () => svgFace(icons.view), caption: () => 'View', children});
const viewMenu = (): CascadeItem[] => [viewItem(() => [{...toggleItem('Grid', svgFace(icons.grid), () => painter.grid, v => { painter.grid = v; painter.draw(); }), id: 'grid'}])];
const menu = new Cascade(canvas.parentElement!, menuItems);

// the tools and the transforms, which work on whichever mode is current
const painter: Painter = new Painter(emptyMode, $('overlay'), history, menu);
const transformer: Transformer = new Transformer(emptyMode, $('transform-overlay'), history);

// the menu, brought up at a point of the window (with other items than its own, for something there)
export function openMenu(x: number, y: number, items?: CascadeItem[]) {
	mode.panelOpened();
	painter.menuOpened(x, y);
	menu.open(x, y, items);
}
// Under everything else over the picture: the menu, for a right click nothing takes itself (as a 3D view turning does); and Space, which
// while it is held gives the pointer to the view, over the tools and anything else
const input = Input.on(canvas);
let panning: (() => void) | undefined;
const letGo = () => {
	panning?.();
	panning = undefined;
};
input.add({
	menu: e => {
		const items = menuItems();
		if (items.length)
			openMenu(e.clientX, e.clientY, items);
		return true;
	},
	key: e => {
		if (e.key !== ' ' || e.metaKey || e.ctrlKey)
			return false;
		panning ??= input.add({
			press:	e => input.press(e, Place.view),
			hover:	() => 'grab',
			key:	e => e.key === ' ',			// (the key repeating)
			keyUp:	e => e.key === ' ' && (letGo(), true),
		}, Place.panning);
		return true;
	},
}, Place.page);
window.addEventListener('blur', letGo);

// what is over the picture (the tools' selection, brush and grid, and a transform's box), drawn again as the view has it now
function drawOverlays() {
	painter.draw();
	transformer.draw();
}
// the canvas has changed size, and what is drawn over it with it
// the canvas changes size with the window, and with the tool bars of the editor coming and going or wrapping
new ResizeObserver(() => {
	canvas3d.resize();
	painter.resize();
	transformer.resize();
	mode.resized();
	mode.redraw();
}).observe(canvas);

//-----------------------------------------------------------------------------
// transforming
//-----------------------------------------------------------------------------

// pixels carried onto an area, on the GPU (a homography's unless it cannot take the image)
export const warpPixels = <P extends Pixels>(image: P, carry: Carry, area: float2.extent, outside = 0) =>
	carry instanceof Warp ? meshWarp(canvas3d, programTextWarp, image, carry.box, p => carry.at(p), area, outside) : warp(canvas3d, programWarp, image, carry, area, outside);

export type Drag = NonNullable<CascadeItem['drag']>;

// a way of moving a layer as the menu's strip has it, which lists the last first
export function reversed(r: Drag, count: () => number): Drag {
	return {begin: r.begin, to: (place: number) => r.to(count() - 1 - place), drop: r.drop};
}
