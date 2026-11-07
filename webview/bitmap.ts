import { handleResult, sendResult, RpcMessage, createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { float2, float3, float3x3, float4, float4x4, normalise, lerp, orthonormalise, matmulExt } from '@isopodlabs/maths/vector';
import { unitQuaternion } from '@isopodlabs/maths/quaternion';
import type { psd } from '@isopodlabs/binary_bitmaps';

import { ShaderProgram, cubeGeometry, bitmapToImage, getImageData, getPixel, Pixels, imageRect } from './opengl.js';
import { asRGBA } from './colour.js';
import { Selection } from './bitmapSelection.js';
import { Transformer, type TransformSession } from './transform.js';
import { SheetFan, SheetFanHost, Placement } from './sheetfan.js';
import { CascadeItem, CascadeDrag, toggleItem, svgFace, reversed, icons as cascadeIcons } from './cascade.js';
import { liftSelection, warpSelected, crop, flip, rotate, drawQuad } from './raster.js';
import { carriedBounds, shiftCarry, planar, transformIcons } from './transformbox.js';
import { Orbit, OrbitHooks, DEFAULT_FOVY } from './orbit.js';
import { Gizmo } from './gizmo.js';
import { Input, Place } from './navigate.js';
import type { GlyphRun } from './textedit.js';
import { Dropped, AtlasMode, $, canvas3d, programBG, programLayer, loadPrograms, shader, postMessage, planeMvp, flatView, stackIcon, menuIcon, viewToggle, Mode, PanMode, PictureMode, layerChooser, mode, history } from './modes.js';
import { LayeredMode, newLayer, type PixelLayer } from './layers.js';
import { upscale, upscaleItem } from './neural.js';

//-----------------------------------------------------------------------------
// what crosses between the extension and the page
//-----------------------------------------------------------------------------

// a layer as it crosses between the extension and the page, and as the file keeps it
export interface LayerData {
	name:		string;
	left:		number;
	top:		number;
	width:		number;
	height:		number;
	opacity:	number;
	visible:	boolean;
	blend:		string;
	data:		ArrayBuffer;
	clipped?:	boolean;
	blocks?:	psd.LayerBlocks;	// the file's further information about the layer (a PSD's tagged blocks), kept for writing back
	mask?:		{left: number, top: number, width: number, height: number, default: number, disabled: boolean, inverted: boolean, density?: number, feather?: number, data: ArrayBuffer};
	vectorMaskDensity?:	number;		// the vector mask's (which is in the blocks): 0..255
	vectorMaskFeather?:	number;		// in pixels
}

// the type getTexture is given to get the pixels themselves
export interface RawImage {
	width:	number;
	height:	number;
	depth?:	number;
	data:	ArrayBuffer;	// 8 bits a channel, rgba, the first row on top, not premultiplied
	type?:	'2d' | '3d' | 'cube' | '2d-array';
	// a picture of layers has them too, bottom first, each cut down to what is not transparent; `data` is then what they make
	layers?: LayerData[];
}

export type shaderType = 'bg'|'2d'|'array2d'|'3d'|'3d2d'|'cube'|'cube2d'|'layer'|'composite'|'planes'|'warp'|'blur'|'levels'|'convolve'|'flatten'|'ink'|'effect'|'textwarp'|'gradient'|'mix';
export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders', type: shaderType, requestId: number}//result: {vert: string, frag: string}};
	| {command: 'saveSvg', text: string}	// markup to be saved as a file and opened in the SVG editor
	| {command: 'installedFonts', requestId: number}	//result: InstalledFont[] (family, style and PostScript name of each font the machine has)
	| {command: 'model', name: 'sam-encoder' | 'sam-decoder' | 'lama' | 'esrgan' | `style-${'mosaic' | 'candy' | 'rain-princess' | 'udnie' | 'pointilism'}` | 'adain-vgg' | 'adain-decoder', requestId: number}	//result: ArrayBuffer (the network's ONNX file, which the extension fetches the first time)
	| {command: 'glyphOutlines', runs: GlyphRun[], requestId: number}	//result: {curve: curveVertex[], missing: number} (the text as contours of cubics, in the runs' units)
	| {command: 'edited', label: string};	// the image has been changed, undoably

export type MessageIn =
	| {command: 'load2d', image: Pixels<4>, layers?: LayerData[]}	// layers, bottom first, over the canvas the image is the size of
	| {command: 'load2dArray', image: Pixels<4>, layers: number}
	| {command: 'loadCube', image: Pixels<4>}
	| {command: 'load3d', image: Pixels<4>, depth: number}
	| {command: 'loadTexture', data: ArrayBuffer, mimeType: string}
	| {command: 'imageOp', op: string}	// do a whole-image editing operation, or one to the layers
	| {command: 'undo'}
	| {command: 'redo'}
	| {command: 'fitToWindow'};

export type MessageRpc =
	// The image as a file of the given type, which a canvas can write (PNG, JPEG); or, for RAW_IMAGE, its raw pixels,
	// for the extension to write as whatever else it likes
	| {command: 'getTexture', type: string, result: ArrayBuffer | RawImage}
//-----------------------------------------------------------------------------
// ImageMode
//-----------------------------------------------------------------------------

// a plain image
class ImageMode extends PictureMode {
	readonly transformer: Transformer;

	constructor(image: ImageData, program2D: ShaderProgram) {
		super(image, program2D);
		this.transformer = new Transformer(this, this.canvas, $('transform-overlay'), history);
		this.setTexture(canvas3d.createTextureFromImage(image));
	}

	override menu() {
		const runItem = (id: string, icon: string, caption: string): CascadeItem => ({
			id,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => (this.run(id), true)
		});

		return [...super.menu(), ...this.transformer.menu([
			this.transformer.item('transform-image', cascadeIcons.transform, 'Free Transform (Enter applies, Esc cancels)', () => this.beginTransform()),
			runItem('flipHorizontal',		transformIcons.flipH, 'Flip Horizontal'), 				
			runItem('flipVertical',			transformIcons.flipV, 'Flip Vertical'), 					
			runItem('rotateClockwise',		transformIcons.rotateCW, 'Rotate 90° Clockwise'), 		
			runItem('rotateAnticlockwise',	transformIcons.rotateACW, 'Rotate 90° Anticlockwise'), 	
			runItem('crop',					'<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>', 'Crop to Selection'),
			upscaleItem(op => this.run(op)),
		])];
	}

	static async create(im: ImageData) {
		return new ImageMode(im, await shader('2d'));
	}

	// An undo or redo made on an earlier mode for this picture (there is one each time it is switched to) is done on the one there is
	private get live(): ImageMode {
		return mode instanceof ImageMode ? mode : this;
	}

	override picture() {
		return this.image;
	}
	override target() {
		return this.image;
	}

	override pick(x: number, y: number) {
		return asRGBA(getPixel(this.image, x, y));
	}

	override changed(changed: Pixels<4>, rect?: float2.extent) {
		if (this.texture && this.image)
			canvas3d.updateTexture(this.texture, this.image, rect);
		this.redraw();
	}
	override shownBy(image: Pixels<4>) {
		if (image === this.image && this.texture) {
			const base = canvas3d.offscreenOn(this.texture, image.width, image.height);
			return base && {
				...base,
				end: () => { base.end(); this.redraw(); },
			};
		}
	}

	beginTransform(): TransformSession | undefined {
		if (!this.image || !programLayer)
			return undefined;
		const before	= this.image, whole = imageRect(before);
		const selection	= this.selection();
		if (!selection) {
			return {
				box: whole, label: 'Transform Image', pinned: true,
				update: carry => {
					const [matrix, warp] = planar(carry);
					this.preview = () => {
						programBG.draw({u_viewport: [this.canvas.width, this.canvas.height]});
						if (this.texture)
							drawQuad(canvas3d, programLayer, this.texture, whole, {}, 1, planeMvp(this.pictureMatrix(), matrix), undefined, warp);
					};
					this.redraw();
				},
				end: carry => {
					this.preview = undefined;
					this.redraw();
					if (!carry)
						return;
					const onto = carriedBounds(carry, imageRect(before));
					const size = onto?.size();
					if (!onto || !size!.x || !size!.y)
						return undefined;
					const r = Mode.warpPixels(before, shiftCarry(carry, float2(0, 0), onto.min.neg()), float2.extent.fromSize(float2(0, 0), size!));
					const after = new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);

					const show = (im: ImageData) => () => {
						const self = this.live;
						self.image		= im;
						self.setTexture(canvas3d.createTextureFromImage(im));
						this.pan.width	= im.width;
						this.pan.height	= im.height;
						self.fit();
						self.redraw();
					};
					show(after)();
					return {undo: show(before), redo: show(after)};
				},
			};
		} else {
			// what is selected is carried, over the picture with it taken from it
			const {floating, rest} = liftSelection(before, selection);
			const own	= canvas3d.createTextureFromImage(floating);
			canvas3d.updateTexture(this.texture!, rest);

			return {
				box: selection.bounds(), label: 'Free Transform', selection,
				update: carry => {
					const [matrix, warp] = planar(carry);
					this.preview = () => {
						this.drawFlat();
						drawQuad(canvas3d, programLayer, own, whole, {}, 1, planeMvp(this.pictureMatrix(), matrix), undefined, warp);
					};
					this.redraw();
				},
				end: carry => {
					this.preview = undefined;
					canvas3d.deleteTexture(own);
					canvas3d.updateTexture(this.texture!, before);
					this.redraw();
					if (!carry)
						return;
					const r		= warpSelected(before, selection, carry, Mode.warpPixels);
					const s		= Mode.warpSelection(selection, carry, imageRect(before));
					const after = new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);

					const show = (im: ImageData, sel?: Selection) => () => {
						const self = this.live;
						self.image		= im;
						self.setSelection(sel);
						self.setTexture(canvas3d.createTextureFromImage(im));
						self.redraw();
					};
					show(after, s)();
					return {undo: show(before), redo: show(after, s)};
				},
			};
		}
	}

	private transform(op: string, apply: (m: Pixels<4>) => Pixels<4>, resizes = false) {
		const before = this.image;
		if (!before)
			return false;

		const r: Pixels<4>  = apply(before);
		const after = new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
		const sel = this.selection();

		// within the canvas, the view stays as it is
		const show = (im: ImageData) => () => {
			const self = this.live;
			self.image		= im;
			self.setTexture(canvas3d.createTextureFromImage(im));
			if (!sel || resizes) {
				this.pan.width	= im.width;
				this.pan.height	= im.height;
				self.fit();
			}
			self.redraw();
		};
		show(after)();
		history.push({undo: show(before), redo: show(after)}, op);
		return true;
	}
	

	// the faces of the picture, if it is shaped like a cubemap
	override async run(op: string) {
		const sel = this.selection();
		switch (op) {
			case 'flipHorizontal':		return this.transform(op, i => flip(i, true));
			case 'flipVertical':		return this.transform(op, i => flip(i, false));
			case 'rotateClockwise':		return this.transform(op, i => rotate(i, true));
			case 'rotateAnticlockwise':	return this.transform(op, i => rotate(i, false));
			case 'crop':				return !sel ? false : this.transform(op, i => crop(i, sel.bounds()));
			case 'upscale2':
			case 'upscale4':
			case 'upscale8': {
				const result = await upscale(this.image, Number(op.slice(7)) as 2 | 4 | 8);
				return !!result && this.transform('Upscale', () => result, true);
			}
			case 'toCubemap': {
				const faces = cubeFaces(this.image!);
				if (faces)
					await load(CubeMode.create(faces));
				else
					postMessage({command: 'error', message: 'The image is not laid out as a cubemap: it should be square, 6x1 or 1x6 faces, or a 4x3 or 3x4 cross.'});
				return true;
			}               	
			default:
				return super.run(op);
		}
	}

	// Images dropped on it make it a picture with layers
	protected override async dropped(items: Dropped[]) {
		await this.addLayers(items.map(it => newLayer(it.name, {data: it.pixels.data, width: it.pixels.width, height: it.pixels.height})), items.length > 1 ? 'Add Layers' : 'Add Layer');
	}

	// Layers put over it make it a picture with layers (it is the background): all of it one edit
	async addLayers(made: PixelLayer[], label: string) {
		const program2D = this.program2D, composite = await shader('composite'), effect = await shader('effect');
		const image		= this.image, {width, height} = image;
		const bg		= newLayer('Background', {data: new Uint8ClampedArray(image.data), width, height});
		const layers	= [bg, ...made];
		// (the same picture, seen from the same place)
		const switchTo = (next: PanMode) => {
			if (mode instanceof PanMode) {
				next.pan.scale	= mode.pan.scale;
				next.pan.offset	= mode.pan.offset;
			}
			Mode.enter(next);
			mode.redraw();
		};
		// (the picture with layers makes its picture of them in its own, and this one's is put back by undoing)
		const own		= new ImageData(new Uint8ClampedArray(image.data), width, height);
		const redo = () => switchTo(new LayeredMode(own, layers, program2D, composite, effect));
		const undo = () => switchTo(new ImageMode(image, program2D));
		redo();
		history.record(label, undo, redo);
	}
}


//-----------------------------------------------------------------------------
// ArrayMode
//-----------------------------------------------------------------------------

// an array of slices
type Slice = Pixels<4>;


const THUMB_SIZE = 26;

// A layer as it is on the picture (the rectangle `area`), small (THUMB_SIZE across at most), over a chequerboard: what tells a
// layer apart. It is shrunk by warp, which averages what a pixel covers. A layer's styles are drawn over it (`more`, each with the
// opacity it is drawn at), as they are over the layer.
export function stripThumb(image: Pixels<4>) {
	const k		= THUMB_SIZE / Math.max(image.width, image.height);
	const w		= Math.max(1, Math.round(image.width * k)), h = Math.max(1, Math.round(image.height * k));
	const canvas = createElement('canvas', {width: w, height: h});
	const ctx	= canvas.getContext('2d')!;
	const out	= ctx.createImageData(w, h);
	const small = image.width && image.height
		? Mode.warpPixels(image, float3x3(float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, 1)), new float2.extent(float2(0, 0), float2(w, h)))
		: undefined;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o		= (y * w + x) * 4;
			const check = ((x >> 2) + (y >> 2)) & 1 ? 204 : 255;
			const a		= small ? small.data[o + 3] / 255 : 0;
			for (let c = 0; c < 3; c++)
				out.data[o + c] = (small ? small.data[o + c] : 0) * a + check * (1 - a);
			out.data[o + 3] = 255;
		}
	}
	ctx.putImageData(out, 0, 0);
	return canvas;
}

function stripFaces<K>(thumb: (k: K) => HTMLCanvasElement) {
	const urls = new Map<K, string>();	// (the menu is made again each time it comes up, so these are as the pictures are then)
	return (k: K) => {
		let url = urls.get(k);
		if (url === undefined)
			urls.set(k, url = `<img class="cascade-thumb" draggable="false" src="${thumb(k).toDataURL()}">`);
		return url;
	};
}

class ArrayMode extends AtlasMode implements SheetFanHost {
	// the slices as the sheets of the fan
	readonly fan = new SheetFan(this);
	readonly tip = Mode.fanTip;
	opened(open: boolean) {
		Mode.fanOpened(open);
	}
	get width()		{ return this.image!.width; }
	get height()	{ return this.sliceHeight; }
	get current()	{ return this.currentSlice(); }
	flatView()		{ return flatView(this.pictureMatrix(), Math.max(this.image!.width, this.sliceHeight)); }
	bounds(i: number)		{ return undefined; }
	sheetName(i: number)	{ return `Slice ${i}`; }
	reorderer(i: number)	{ return this.dragger(this.layers[i]); }
	sheetMenu(i: number | undefined, clientX: number, clientY: number) {
		Mode.openMenu(clientX, clientY, i === undefined ? undefined : this.sliceItems(this.layers[i]));
	}
	// a slice of the array texture: the sheet itself, with its outline
	drawSheet(i: number, at: Placement) {
		const {x: u, y: v} = at.sheet.size();
		// (the planes' own quad is centred on the origin, y up)
		const centred = at.matrix.matmul(float4x4(float4(1, 0, 0, 0), float4(0, 1, 0, 0), float4(0, 0, 1, 0), float4(u / 2, v / 2, 0, 1)));
		canvas3d.bindTexture2DArray(this.texture ?? null, 0);
		this.programPlanes.draw({
			u_texture:	0,
			u_mvp:		new Float32Array(centred.flat()),
			u_half:		[u / 2, -v / 2],
			u_z:		at.depth,
			u_size:		[this.image!.width, this.sliceHeight, this.count],
			u_layer:	i,
			u_opacity:	1,
			u_edge:		at.edge(at.current || at.hovered ? 2.5 : 1.5),
			u_outline:	at.outline,
		});
	}


	// which slice is the current one
	currentSlice() {
		return this.layer ? this.layers.indexOf(this.layer) : 0;
	}
	choose(slice: number) {
		this.layer = this.layers[slice];
		this.redraw();
	}

	// what can be done to a slice
	sliceItems(layer: Slice): CascadeItem[] {
		return [
			{face: () => svgFace(menuIcon.trash), caption: () => 'Delete slice', select: () => { this.deleteSlice(layer); }},
		];
	}
	override dispose() {
		this.fan.dispose();
		super.dispose();
	}
	override fit() {
		if (this.fan?.active)
			this.fan.navigation.fit();
		else
			this.pan.fit();
	}

	setSlices(order: Slice[]) {
		const was = this.layers, at = this.layer ? Math.max(0, was.indexOf(this.layer)) : 0;
		this.layers = order.slice();
		if (order.length === was.length) {
			this.layers.forEach((layer, i) => {
				if (layer !== was[i] && this.texture)
					canvas3d.updateTextureLayer(this.texture, i, layer as ImageData);
			});
		} else if (this.image) {
			const size = this.image.width * this.sliceHeight * 4, data = new Uint8ClampedArray(size * order.length);
			order.forEach((layer, i) => data.set(layer.data, i * size));
			this.image = new ImageData(data, this.image.width, this.sliceHeight * order.length);
			this.setTexture(canvas3d.createTexture(this.image.width, this.sliceHeight, this.image.data, {depth: order.length}));
		}
		if (!this.layer || !order.includes(this.layer))
			this.layer = order[Math.min(at, order.length - 1)];
		this.redraw();
	}

	deleteSlice(layer: Slice) {
		if (this.layers.length < 2)
			return;
		const before = this.layers.slice(), after = before.filter(l => l !== layer);
		this.setSlices(after);
		history.record('Delete Slice', () => this.setSlices(before), () => this.setSlices(after));
	}

	// a slice moved to another place in the order, by index: it is one edit when it is dropped
	dragger(layer: Slice): CascadeDrag {
		let before: Slice[];
		return {
			begin:	() => { before = this.layers.slice(); },
			to:		(i: number) => {
				const order = this.layers.filter(l => l !== layer);
				order.splice(i, 0, layer);
				this.setSlices(order);
			},
			drop:	() => {
				const after = this.layers.slice();
				if (after.some((l, i) => l !== before[i]))
					history.record('Move Slice', () => this.setSlices(before), () => this.setSlices(after));
			},
		};
	}

	constructor(atlas: ImageData, count: number, private program2DArray: ShaderProgram, private programPlanes: ShaderProgram) {
		super(atlas, count, pixels => new ImageData(pixels.data.slice(), pixels.width, pixels.height));
		this.pan.width	= atlas.width;
		this.pan.height	= this.sliceHeight;
		this.setTexture(canvas3d.createTexture(atlas.width, this.sliceHeight, atlas.data, {depth: count}));
	}
	static async create(atlas: ImageData, count: number) {
		return new ArrayMode(atlas, count, await shader('array2d'), await shader('planes'));
	}
	protected override uploadSlice(i: number, image: Pixels<4>) {
		canvas3d.updateTextureLayer(this.texture!, i, image);
	}
	// (a slice is seen in the 2D view, by itself)
	protected override carriedMvp(i: number, matrix: float3x3) {
		return planeMvp(this.pictureMatrix(), matrix);
	}

	override redraw() {
		canvas3d.initViewport();
		if (this.fan?.active) {
			programBG.draw({u_viewport: [this.canvas.width, this.canvas.height]});
			this.fan.draw();
			return;
		}

		canvas3d.bindTexture2DArray(this.texture ?? null);
		this.program2DArray.draw({
			u_texture:	0,
			u_size:		[this.image!.width, this.sliceHeight, this.sliceHeight],
			u_viewport:	[this.canvas.width, this.canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
			u_layer:	this.currentSlice(),
		});
		super.redraw();
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image || this.fan?.active)
			return undefined;
		// the slice being shown
		const {x, y} = this.pan.toImage(clientX, clientY);
//		const point = canvas3d.toCanvas(clientX, clientY);
//		const x = Math.floor((point.x - this.pan.offset.x) / this.pan.scale), y = Math.floor((point.y - this.pan.offset.y) / this.pan.scale);
		if (x < 0 || y < 0 || x >= this.image.width || y >= this.sliceHeight)
			return undefined;
		const slice = this.currentSlice(), colour = this.pick(x, y);
		return colour && `Pixel ${x},${y},${slice} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		if (!this.image)
			return [];
		return [
			...super.menu(),
			Mode.viewItem(() => [viewToggle(this, this.fan)]),
			layerChooser('Slice',
				() => this.layers,
				() => this.layer!,
				layer => this.choose(this.layers.indexOf(layer)), layer => `Slice ${this.layers.indexOf(layer)}`,
				stripFaces(layer => stripThumb(layer)),
				layer => this.sliceItems(layer),
				layer => this.fan.highlight(layer && this.layers.indexOf(layer)),
				layer => reversed(this.dragger(layer), () => this.layers.length)
			),
		];
	}

	// a slice's pixels, which are part of the atlas as well as of the array texture
	override changed(changed: Pixels<4>, rect?: float2.extent) {
		const i = this.layers.findIndex(l => l === changed);
		if (this.texture && i >= 0)
			canvas3d.updateTextureLayer(this.texture, i, changed, rect);
		this.redraw();
	}
	override shownBy(image: Pixels<4>) {
		const i = this.layers.findIndex(l => l === image);
		if (this.texture && i >= 0) {
			const base = canvas3d.offscreenOn(this.texture, image.width, image.height, i);
			return base && {...base,
				end: () => { base.end(); this.redraw(); }
			};
		}
	}

	// (the whole picture is not turned, flipped or cropped: only a slice)
	override run(op: string) {
		return !['flip', 'rotate', 'crop'].some(k => op.startsWith(k)) && super.run(op);
	}

	protected override async dropped(items: Dropped[]) {
		const width = this.image!.width;
		const made = items.map((it): Slice => {
			const data = new Uint8ClampedArray(width * this.sliceHeight * 4);
			const w = Math.min(width, it.pixels.width), h = Math.min(this.sliceHeight, it.pixels.height);
			for (let y = 0; y < h; y++)
				data.set(it.pixels.data.subarray(y * it.pixels.width * 4, (y * it.pixels.width + w) * 4), y * width * 4);
			return new ImageData(data, width, this.sliceHeight);
		});
		const before = this.layers.slice(), after = [...before, ...made], last = made[made.length - 1];
		const redo = () => {
			this.setSlices(after);
			this.layer = last;
			this.redraw();
		};
		redo();
		history.record('Add Slice', () => this.setSlices(before), redo);
	}

	override raw() {
		const raw = super.raw();
		if (raw) {
			raw.type	= '2d-array';
			raw.depth	= this.image!.height / this.sliceHeight;
		}
		return raw;
	}
}

//-----------------------------------------------------------------------------
// CubeOrbit
//-----------------------------------------------------------------------------

const HOME_DISTANCE		= 3;		// how far the camera starts from the middle
const ENTER_DISTANCE	= 1.5;		// how near a cube lets the camera come before the wheel zooms the lens instead, and then goes inside
const MAX_DISTANCE		= 40;
const MAX_ZOOM			= 50;		// the most the lens zooms in (of its start)
const TURN_MS			= 350;
const FOLD_MS			= 300;

export function intersectRayCube(origin: float3, dir: float3) {
	const t1 = float3((-1 - origin.x) / dir.x, (-1 - origin.y) / dir.y, (-1 - origin.z) / dir.z);
	const t2 = float3(( 1 - origin.x) / dir.x, ( 1 - origin.y) / dir.y, ( 1 - origin.z) / dir.z);
	const tmin = Math.max(Math.min(t1.x, t2.x), Math.min(t1.y, t2.y), Math.min(t1.z, t2.z));
	const tmax = Math.min(Math.max(t1.x, t2.x), Math.max(t1.y, t2.y), Math.max(t1.z, t2.z));
	if (tmax < 0 || tmin > tmax)
		return undefined;
	const t = tmin < 0 ? tmax : tmin;	// (from inside, the wall it looks at)
	return float3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
}

export function cubeDirectionToFaceUV({x, y, z}: float3) {
	const ax = Math.abs(x);
	const ay = Math.abs(y);
	const az = Math.abs(z);
	return ax >= ay && ax >= az ? (x > 0
		? {face: 0, u: (-z / ax + 1) * 0.5, v: (-y / ax + 1) * 0.5}
		: {face: 1, u: ( z / ax + 1) * 0.5, v: (-y / ax + 1) * 0.5}
	) : (ay >= ax && ay >= az) ? (y > 0
		? {face: 2, u: (x / ay + 1) * 0.5, v: ( z / ay + 1) * 0.5}
		: {face: 3, u: (x / ay + 1) * 0.5, v: (-z / ay + 1) * 0.5}
	): z > 0
		? {face: 4, u: ( x / az + 1) * 0.5, v: (-y / az + 1) * 0.5}
		: {face: 5, u: (-x / az + 1) * 0.5, v: (-y / az + 1) * 0.5};
}

export function clampDimension(x: number, size: number) {
	return Math.min(size - 1, Math.max(0, Math.floor(x * size)));
}

// The camera of a cubemap, which is seen from outside, and from inside as an environment: it stays about the middle (so
// it does not pan), and a drag takes hold of the point of the cube under the cursor and turns the cube to keep it
// there. The wheel brings the camera in, and when it is near the cube zooms the lens and then goes inside; out again
// it does the same the other way. A volume is not so, and is moved as an Orbit is.
export class CubeOrbit extends Orbit {
	environment = false;

	constructor(canvas: HTMLCanvasElement, hooks: OrbitHooks, private surface: (clientX: number, clientY: number) => float3 | undefined) {
		super(canvas, hooks);
	}

	// how far the camera is from the middle, along its back axis (0: inside)
	get distance() {
		return this.eye.dot(this.basis.z);
	}
	// the camera at that distance, looking at the middle
	put(distance: number) {
		this.eye = this.basis.z.scale(distance);
	}

	protected override grab(anchor: float3, event: PointerEvent) {
		if (!this.environment)
			return super.grab(anchor, event);
		const point = this.surface(event.clientX, event.clientY);
		let last = {x: event.clientX, y: event.clientY};
		return (e: PointerEvent) => {
			const distance = this.distance, rotation = this.basis.transpose();
			let turn: float3x3 | undefined;
			if (point) {
				// The cube is turned about its middle until the point is under the cursor: where the cursor's ray meets the
				// sphere the point turns on (the near side from outside, the far from inside), or the nearest it comes to it
				const middle = rotation.mul(this.eye.neg()), from = rotation.mul(point), radius = from.len();
				const ray = normalise(this.ray(e.clientX, e.clientY));
				const along = ray.dot(middle), disc = along * along - (middle.dot(middle) - radius * radius);
				let to: float3;
				if (disc >= 0)
					to = ray.scale(middle.len() < radius ? along + Math.sqrt(disc) : along - Math.sqrt(disc)).sub(middle);
				else
					to = normalise(ray.scale(Math.max(0, along)).sub(middle)).scale(radius);
				// from outside, only a face which looks at the camera is taken hold of
				const faces = distance < 1e-6 || ray.dot(rotation.mul(CubeMode.faceNormals[cubeDirectionToFaceUV(point).face])) < 0;
				const d = Math.max(-1, Math.min(1, from.dot(to) / (radius * to.len())));
				const axis = from.cross(to);	// (a right handed turn about it takes the one to the other)
				if (faces && axis.len() > 1e-9 && d < 1 - 1e-12)
					turn = float3.rotate(normalise(axis), Math.acos(d));
			} else {
				// about the screen's up axis, then its right axis
				turn = float3.rotateX((e.clientY - last.y) * 0.01).matmul(float3.rotateY((e.clientX - last.x) * 0.01)) as float3x3;
			}
			if (turn) {
				this.basis = (turn.matmul(rotation) as float3x3).transpose();
				orthonormalise(this.basis);
				this.put(distance);
			}
			last = {x: e.clientX, y: e.clientY};
			this.hooks.redraw();
		};
	}

	protected override zoom(anchor: float3, factor: number, event: WheelEvent) {
		if (!this.environment)
			return super.zoom(anchor, factor, event);
		let distance = this.distance / factor;
		if (distance < ENTER_DISTANCE) {
			// near, the lens zooms (and the camera goes inside); out again, the other way
			this.fovy = Math.min(DEFAULT_FOVY * MAX_ZOOM, this.fovy * factor);
			if (factor < 1 && this.fovy < DEFAULT_FOVY) {
				this.fovy = DEFAULT_FOVY;
				distance = ENTER_DISTANCE;
			} else {
				distance = 0;
			}
		}
		this.put(Math.min(MAX_DISTANCE, distance));
	}

	override gizmoHooks() {
		const hooks = super.gizmoHooks();
		return {
			...hooks,
			// (turned about the middle)
			setRotation: (rotation: float3x3) => {
				if (!this.environment)
					return hooks.setRotation(rotation);
				const distance = this.distance;
				this.basis = rotation.transpose();
				this.put(distance);
				this.hooks.redraw();
			},
		};
	}

}

//-----------------------------------------------------------------------------
// CubeViewMode
//-----------------------------------------------------------------------------

// where each face is in the unfolded layout, in faces across and down (cube2d.frag)
export const UNFOLDED = [{x: 2, y: 1}, {x: 0, y: 1}, {x: 1, y: 0}, {x: 1, y: 2}, {x: 1, y: 1}, {x: 3, y: 1}];

// A cubemap, or a volume, in 3D: a cube of -1 to 1 which the camera (an Orbit, orbit.ts) goes about, and which can be unfolded
// flat into the layout the 2D view shows (the shaders do the unfolding, by u_flatten; this moves the camera as it goes so that
// the unfolded layout lands exactly where the 2D view draws it). A cubemap's faces, or a volume's slices, are one above
// another in the image, in the order +X -X +Y -Y +Z -Z for the cube.
abstract class CubeViewMode extends AtlasMode {
	flatten				= 0;					// 0 the cube, 1 unfolded flat; between as it goes
	flattenTarget		= 0;
	protected orbit:	CubeOrbit;
	private gizmo:		Gizmo;
	protected unlisten:	(() => void)[];				// (what it has put in the pointer's stack is taken out of it)
	protected animation	= 0;					// the animation frame of the cube turning, or unfolding
	protected id		= 0;					// (an unfolding is superseded by a later one)

	constructor(image: ImageData, count: number, makeSlice?: (pixels: ImageData) => Slice) {
		super(image, count, makeSlice);
		this.orbit = new CubeOrbit(this.canvas, {
			anchor:		(x, y)	=> this.rayHit(x, y) ?? this.orbit.along(x, y, float3(0, 0, 0), 2),
			size:		()		=> 2,
			redraw: 	()		=> this.redraw(),
			dragStart:	()		=> this.stop(),
			contextMenu:(x, y)	=> Mode.openMenu(x, y),
			active:		()		=> this.turnable,
			home:		()		=> this.home(),
		}, (x, y) => this.rayHit(x, y));
		this.gizmo = new Gizmo(this.canvas, this.orbit.gizmoHooks());
		this.unlisten = [Input.on(this.canvas).add(this.orbit, Place.view)];
	}

	// the camera is the pointer's, as the cube is in 3D and not on its way anywhere
	get turnable(): boolean {
		return mode === this && this.flatten === 0 && this.flattenTarget === 0;
	}

	// a new cube or volume of this many faces or slices, seen from the start
	protected reset() {
		this.stop();
		//this.count = slices;
		this.flatten = this.flattenTarget = 0;
		this.updatePainting();
		this.home();
	}

	override dispose() {
		this.stop();
		this.gizmo.dispose();
		this.unlisten.forEach(f => f());
		super.dispose();
	}

	// the faces can be drawn on in 3D and unfolded, but not while on the way between
	protected updatePainting() {
		Mode.toolsEnabled(this.paintable && this.flatten === this.flattenTarget);
		this.pan.enabled = this.flatten === 1 && this.flattenTarget === 1;	// (the 2D view is for the unfolded cube)
	}
	protected get paintable() {
		return false;
	}

	// Orientation (of the view, as a matrix) in which the unfolded layout is seen face on, matching the 2D view
	protected abstract homeRotation(): float3x3;
	// where the camera is, unfolded
	protected abstract unfoldedPosition(): float3;
	protected abstract drawFlat(): void;
	protected abstract drawSolid(mvp: number[]): void;

	override fit() {
		if (this.turnable)
			this.orbit.fit();
		else
			this.pan.fit();
	}

	protected stop() {
		cancelAnimationFrame(this.animation);
		this.id++;
	}

	home() {
		this.orbit.fovy = DEFAULT_FOVY;
		this.setView(this.homeRotation(), float3(0, 0, -HOME_DISTANCE));
		this.redraw();
	}

	// the camera from the view's rotation, and where the origin is in it
	protected setView(rotation: float3x3, w: float3) {
		this.orbit.basis	= rotation.transpose();
		this.orbit.eye		= this.orbit.basis.mul(w).neg();
	}

	// where the camera's ray through a point of the window meets the cube
	protected rayHit(clientX: number, clientY: number) {
		const o = this.orbit;
		return intersectRayCube(o.eye, o.basis.mul(o.ray(clientX, clientY)));
	}

	// Where the camera is (as the view's translation) with the home rotation, for the unfolded layout to land exactly where
	// the 2D view draws it, at its scale and offset. The layout is the plane z=planeZ, 2 world units across `width` atlas
	// texels, with atlas point `centre` on the axis.
	protected flatPosition(centre: {x: number, y: number}, width: number, planeZ: number) {
		const {scale, offset} = this.pan;
		const f = this.canvas.height / 2 * this.orbit.fovy;

		const depth			= 2 * f / (width * scale);
		const pixelDeltaX	= offset.x + centre.x * scale - this.canvas.width / 2;
		const pixelDeltaY	= this.canvas.height / 2 - (offset.y + centre.y * scale);

		return float3(pixelDeltaX * depth / f, pixelDeltaY * depth / f, -depth - this.homeRotation().z.z * planeZ);
	}

	// unfolded flat to be seen as a 2D picture (or folded back into the cube, from where it is now)
	unfold(on: boolean) {
		if (!this.image)
			return;
		if (on) {
			this.animateFlatten(1, this.unfoldedPosition());
			this.updatePainting();
		} else {
			// back to 3D: start from the 2D view as it is now
			if (this.flatten === 1)
				this.setView(this.homeRotation(), this.unfoldedPosition());
			this.animateFlatten(0, float3(0, 0, -HOME_DISTANCE));
		}
		this.updatePainting();
	}

	// a cubemap or volume in 3D, or unfolded flat to be seen as a 2D picture
	foldToggle(): CascadeItem {
		return {...toggleItem('3D view', svgFace(stackIcon), () => this.flattenTarget === 0, on => {
			if (!on)
				this.pan.reset();	// as a 2D picture at its full size
			this.unfold(!on);
		}), id: 'fold'};
	}

	private animateFlatten(target: number, cameraTarget: float3) {
		this.stop();
		this.flattenTarget = target;
		const id		= this.id;
		const flatten0	= this.flatten;
		const o			= this.orbit;
		const start		= unitQuaternion.from3x3(o.basis.transpose());
		const end		= unitQuaternion.from3x3(this.homeRotation());
		const w0		= o.toview().w;
		const startTime	= performance.now();

		const step = (now: number) => {
			if (id !== this.id)
				return;	// superseded
			const t		= Math.min(1, (now - startTime) / FOLD_MS);
			const s		= t * t * (3 - 2 * t);
			this.flatten = t === 1 ? target : flatten0 + (target - flatten0) * s;
			this.setView(unitQuaternion.slerp(start, end, s).to3x3(), lerp(w0, cameraTarget, s));
			this.redraw();
			if (t < 1)
				this.animation = requestAnimationFrame(step);
			else
				this.updatePainting();
		};
		this.animation = requestAnimationFrame(step);
	}

	override redraw() {
		canvas3d.initViewport();
		// (the gizmo is for the cube in 3D, not unfolded)
		this.gizmo.show(this.flatten !== 1);
		if (this.flatten === 1) {
			this.drawFlat();
		} else {
			const gl = canvas3d.gl, o = this.orbit;
			programBG.draw({u_viewport: [this.canvas.width, this.canvas.height]});
			//gl.clearColor(0.06, 0.06, 0.06, 1);
			canvas3d.clear();
			this.drawSolid(matmulExt(o.projection(float3(0, 0, 0), this.canvas.width / this.canvas.height), o.toview()).flat());
		}
		super.redraw();
	}
}

//-----------------------------------------------------------------------------
// CubeMode
//-----------------------------------------------------------------------------

// an image as a cubemap: its faces one above another, in the order +X -X +Y -Y +Z -Z
class CubeMode extends CubeViewMode {
	static faceNames	= ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
	static faceNormals	= [float3(1, 0, 0), float3(-1, 0, 0), float3(0, 1, 0), float3(0, -1, 0), float3(0, 0, 1), float3(0, 0, -1)];


	// a point of a face, from where it is on the face (0 to 1 across, and down, as its pixels are)
	static facePoint(face: number, u: number, v: number) {
		switch (face) {
			case 0:		return float3(1, 1 - 2 * v, 1 - 2 * u);
			case 1:		return float3(-1, 1 - 2 * v, 2 * u - 1);
			case 2:		return float3(2 * u - 1, 1, 2 * v - 1);
			case 3:		return float3(2 * u - 1, -1, 1 - 2 * v);
			case 4:		return float3(2 * u - 1, 1 - 2 * v, 1);
			default:	return float3(1 - 2 * u, 1 - 2 * v, -1);
		}
	}

	// and back: where a point of the plane of a face is on the face (it may be off it)
	static faceUV(face: number, {x, y, z}: float3) {
		switch (face) {
			case 0:		return float2((1 - z) / 2, (1 - y) / 2);
			case 1:		return float2((z + 1) / 2, (1 - y) / 2);
			case 2:		return float2((x + 1) / 2, (z + 1) / 2);
			case 3:		return float2((x + 1) / 2, (1 - z) / 2);
			case 4:		return float2((x + 1) / 2, (1 - y) / 2);
			default:	return float2((1 - x) / 2, (1 - y) / 2);
		}
	}

	face			= 0;						// the face chosen, which the cube is turned to
	private lastUV	= float2(0, 0);

	// (the faces are in the atlas, `image`, so that what is drawn on one is in it too, and is what is saved)
	constructor(faces: ImageData, private programCube: ShaderProgram, private programCube2D: ShaderProgram) {
		super(faces, 6, image => image);
		this.unlisten.push(Input.on(this.canvas).add({press: e => this.press(e)}, Place.tools));
		this.pan.width	= faces.width * 4;		// (the unfolded layout, four faces across and three down)
		this.pan.height	= faces.width * 3;
		this.orbit.environment = true;
		this.setTexture(canvas3d.createTexture(faces.width, faces.width, faces.data, {type: 'cube'}));
	}
	static async create(faces: ImageData) {
		return new CubeMode(faces, await shader('cube', cubeGeometry), await shader('cube2d'));
	}
	protected override uploadSlice(i: number, image: Pixels<4>) {
		canvas3d.updateCubeFace(this.texture!, i, image);
	}
	// A face is carried where it is: on its plane in 3D, or in its place in the unfolded layout
	protected override carriedMvp(i: number, matrix: float3x3) {
		const size = this.image.width;
		if (this.flatten === 1) {
			const cell = UNFOLDED[i];
			return planeMvp(this.pictureMatrix(), float3x3.translate(float2(cell.x, cell.y).scale(size)).matmul(matrix));
		}
		// (face pixels to the cube, as the faces' points go: affine, so that the homography's divisor carries through)
		const o = this.orbit, m = matmulExt(o.projection(float3(0, 0, 0), this.canvas.width / this.canvas.height), o.toview());
		const p0 = CubeMode.facePoint(i, 0, 0), pu = CubeMode.facePoint(i, 1, 0).sub(p0).scale(1 / size), pv = CubeMode.facePoint(i, 0, 1).sub(p0).scale(1 / size);
		const onFace = float4x4(float4(pu.x, pu.y, pu.z, 0), float4(pv.x, pv.y, pv.z, 0), float4(0, 0, 0, 0), float4(p0.x, p0.y, p0.z, 1));
		const carried = float4x4(
			float4(matrix.x.x, matrix.x.y, 0, matrix.x.z),
			float4(matrix.y.x, matrix.y.y, 0, matrix.y.z),
			float4(0, 0, 1, 0),
			float4(matrix.z.x, matrix.z.y, 0, matrix.z.z)
		);
		return float4x4(m.x, m.y, m.z, m.w).matmul(onFace).matmul(carried) as float4x4;
	}

	override activate() {
		this.reset();
	}

	protected override get paintable() {
		return true;
	}
	protected homeRotation() {
		return float3x3.identity();		// (the cube unfolds around its +Z face)
	}
	protected unfoldedPosition() {
		return this.flatPosition({x: this.image!.width * 1.5, y: this.image!.width * 1.5}, this.image!.width, 1);
	}

	protected drawFlat() {
		canvas3d.bindTextureCube(this.texture ?? null);
		this.programCube2D.draw({
			u_texture:	0,
			u_size:		this.image!.width,
			u_viewport:	[this.canvas.width, this.canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
		});
	}
	protected drawSolid(mvp: number[]) {
		canvas3d.bindTextureCube(this.texture ?? null);
		this.programCube.draw({
			u_texture: 	0,
			u_size:    	this.image!.width,
			u_mvp:		mvp,
			u_flatten: 	this.flatten,
		});
	}

	// the cube turned (by the shortest way) until a face looks at the camera
	turnToFace(face: number) {
		this.face = face;
		this.setSlice(this.layers[face]);
		if (this.flatten !== 0 || this.flattenTarget !== 0)
			return;		// unfolded, the faces are all in view
		this.stop();
		// the camera's back axis is to be the face's normal, to look at it from outside; or against it, from inside
		const o = this.orbit, from = o.basis.z, to = o.distance < ENTER_DISTANCE / 2 ? CubeMode.faceNormals[face].neg() : CubeMode.faceNormals[face];
		const angle = Math.acos(Math.max(-1, Math.min(1, from.dot(to))));
		if (angle < 1e-4)
			return;
		let axis = from.cross(to);
		axis = axis.len() < 1e-6
			? (Math.abs(from.y) < 0.9 ? float3(0, 1, 0) : float3(1, 0, 0))	// facing away: any axis will do
			: normalise(axis);
		const start = performance.now();
		let done = 0;
		const id = this.id;
		const ease = (p: number) => p * p * (3 - 2 * p);
		const step = (time: number) => {
			if (id !== this.id)
				return;
			const p = Math.min(1, (time - start) / TURN_MS), at = ease(p);
			const r = float3.rotate(axis, angle * (at - done));
			done = at;
			o.basis = r.matmul(o.basis);
			o.eye = r.mul(o.eye);
			this.redraw();
			if (p < 1)
				this.animation = requestAnimationFrame(step);
		};
		this.animation = requestAnimationFrame(step);
	}

	// the chosen face to be the one pressed on, when unfolded (in 3D it is the face drawn on, and the others turn the cube)
	selectAt(clientX: number, clientY: number) {
		if (this.flatten !== 1)
			return;
		if (!this.image)
			return;
		const p = this.pan.toImage(clientX, clientY);
		const width = this.image.width, face = UNFOLDED.findIndex(c => Math.floor(p.x / width) === c.x && Math.floor(p.y / width) === c.y);
		if (face >= 0 && face !== this.face) {
			this.face = face;
			this.setSlice(this.layers[face]);
		}
	}

	// the chosen face as it is in the unfolded layout, which is the 2D view of all of them
	private flatToImage(clientX: number, clientY: number) {
		const p = this.pan.toImage(clientX, clientY), w = this.image?.width ?? 0, cell = UNFOLDED[this.face];
		return float2(p.x - cell.x * w, p.y - cell.y * w);
	}
	private flatToScreen(p: float2) {
		const w = this.image?.width ?? 0, cell = UNFOLDED[this.face];
		return this.pan.toScreen(float2(p.x + cell.x * w, p.y + cell.y * w));
	}

	// the face under the pointer, if any
	faceAt(clientX: number, clientY: number) {
		const point = this.flatten === 0 ? this.rayHit(clientX, clientY) : undefined;
		return point && cubeDirectionToFaceUV(point).face;
	}

	// A point of the plane of face `from` (in its pixels, and it may be off the face) as it is seen from the middle of the cube on
	// the plane of face `to`, and how much longer a length there is on it; nothing if the point is not in front of that face
	private onFace(from: number, p: float2, to: number) {
		const w = this.image.width, q = CubeMode.facePoint(from, p.x / w, p.y / w), d = q.dot(CubeMode.faceNormals[to]);
		if (d < 1e-3)
			return undefined;
		const uv = CubeMode.faceUV(to, q.scale(1 / d));
		return {p: float2(uv.x * w, uv.y * w), scale: 1 / d};
	}

	// A stroke goes on to the face the pointer has come to, which is the one chosen then (`last` is where the stroke was, on the old one)
	crossTo(clientX: number, clientY: number, last: float2) {
		if (!this.image)
			return undefined;
		let to: number | undefined;
		if (this.flatten === 1) {
			const p = this.pan.toImage(clientX, clientY), w = this.image.width;
			to = UNFOLDED.findIndex(c => Math.floor(p.x / w) === c.x && Math.floor(p.y / w) === c.y);
		} else
			to = this.faceAt(clientX, clientY);
		if (to === undefined || to < 0 || to === this.face)
			return undefined;
		const carried = this.onFace(this.face, last, to);
		this.face = to;
		this.setSlice(this.layers[to]);
		return carried?.p ?? this.toImage(clientX, clientY);
	}

	// What a stroke on the chosen face does on the others: its brush goes past an edge, where it is on the face beyond
	adjoining(p: float2, q: float2, size: number) {
		const w = this.image.width, spill: {image: Pixels<4>, p: float2, q: float2, size: number}[] = [];
		for (let to = 0; to < 6; ++to) {
			if (to === this.face)
				continue;
			const a = this.onFace(this.face, p, to), b = this.onFace(this.face, q, to);
			if (!a || !b)
				continue;
			const s = size * Math.max(a.scale, b.scale), reach = s / 2 + 1;
			if (Math.max(a.p.x, b.p.x) < -reach || Math.min(a.p.x, b.p.x) > w + reach || Math.max(a.p.y, b.p.y) < -reach || Math.min(a.p.y, b.p.y) > w + reach)
				continue;
			spill.push({image: this.layers[to], p: a.p, q: b.p, size: s});
		}
		return spill;
	}

	// The chosen face as an image, for the tools: where the pointer is on its plane, which goes on past its edges, and where
	// a point of it falls on the window
	private faceToImage(clientX: number, clientY: number) {
		if (!this.image)
			return this.lastUV;
		const o = this.orbit, d = o.basis.mul(o.ray(clientX, clientY)), normal = CubeMode.faceNormals[this.face];
		const axis = normal.x ? 'x' : normal.y ? 'y' : 'z';
		const t = (normal[axis] - o.eye[axis]) / d[axis];
		if (!Number.isFinite(t) || t <= 0)
			return this.lastUV;		// the plane is behind or edge on: where it was
		const uv = CubeMode.faceUV(this.face, o.eye.add(d.scale(t)));
		return this.lastUV = float2(uv.x * this.image.width, uv.y * this.image.width);
	}
	private faceToScreen(p: float2) {
		if (!this.image)
			return float2(0, 0);
		const o = this.orbit, m = matmulExt(o.projection(float3(0, 0, 0), this.canvas.width / this.canvas.height), o.toview());
		const mvp = float4x4(m.x, m.y, m.z, m.w);
		const q = CubeMode.facePoint(this.face, p.x / this.image.width, p.y / this.image.width);
		const clip = mvp.mul(float4(q.x, q.y, q.z, 1));
		return float2((clip.x / clip.w + 1) / 2 * this.canvas.width, (1 - clip.y / clip.w) / 2 * this.canvas.height);
	}
	private facePixelSize() {
		if (!this.image)
			return 1;
		const c = this.image.width / 2, a = this.faceToScreen(float2(c, c)), b = this.faceToScreen(float2(c + 1, c));
		return 1 / Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y));
	}

	// how the tools see the cube: the chosen face, turned in 3D or unfolded flat; the 2D view when it is on its way between
	override toImage(clientX: number, clientY: number) {
		return this.flatten === 1 ? this.flatToImage(clientX, clientY) : this.turnable ? this.faceToImage(clientX, clientY) : super.toImage(clientX, clientY);
	}
	override toScreen(p: float2) {
		return this.flatten === 1 ? this.flatToScreen(p) : this.turnable ? this.faceToScreen(p) : super.toScreen(p);
	}
	override pixelSize() {
		return this.flatten === 1 || !this.turnable ? super.pixelSize() : this.facePixelSize();
	}

	// Unfolded, the face pressed on is the one chosen, and it is drawn on. In 3D the chosen face is the one drawn on; a press on any
	// other is the view's, and turns the cube. (A transform is over this, as its handles can be off the face.)
	private press(event: PointerEvent) {
		this.selectAt(event.clientX, event.clientY);
		return this.flatten === 1 || this.faceAt(event.clientX, event.clientY) === this.face ? undefined : Input.on(this.canvas).press(event, Place.view);
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image || this.flatten !== 0)
			return undefined;
		const point = this.rayHit(clientX, clientY);
		if (!point)
			return undefined;
		const uv = cubeDirectionToFaceUV(point);
		const x = clampDimension(uv.u, this.image.width), y = clampDimension(uv.v, this.image.width);
		const colour = asRGBA(getPixel(this.image, x, y + uv.face * this.image.width));
		return colour && `Cube ${CubeMode.faceNames[uv.face]} ${x},${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		if (!this.image)
			return [];
		return [
			...super.menu(),
			layerChooser('Face',
				() => [0, 1, 2, 3, 4, 5],
				() => this.face,
				face => this.turnToFace(face),
				i => `Face ${CubeMode.faceNames[i]}`,
				stripFaces(i => stripThumb(this.layers[i])),
				() => undefined,
				() => {},
				undefined,
				[],
				false
			),
			this.foldToggle()
		];
	}

	// a face's pixels, which are part of the atlas as well as of the cube texture
	override changed(changed: Pixels<4>, rect?: float2.extent) {
		const i = this.layers.findIndex(l => l === changed);
		if (this.texture && i >= 0)
			canvas3d.updateCubeFace(this.texture, i, changed, rect);
		this.redraw();
	}


	// An image dropped on the cube: it is the face it was dropped on, or the one chosen if it was not dropped on one (or the cube is unfolded)
	protected override async dropped(items: Dropped[], clientX: number, clientY: number) {
		if (!this.image)
			return;

		const hit		= this.flatten === 0 ? this.rayHit(clientX, clientY) : undefined;
		const face		= hit ? cubeDirectionToFaceUV(hit).face : this.face;
		const picture	= items[0].pixels;
		const atlas		= this.image, width = atlas.width, size = width * width * 4;
		const from		= createElement('canvas', {width: picture.width, height: picture.height});
		from.getContext('2d')!.putImageData(picture, 0, 0);
		const ctx		= createElement('canvas', {width, height: width}).getContext('2d')!;
		ctx.drawImage(from, 0, 0, width, width);
		const after		= ctx.getImageData(0, 0, width, width).data;
		const before	= atlas.data.slice(face * size, (face + 1) * size);

		const set	= (data: Uint8ClampedArray) => () => {
			atlas.data.set(data, face * size);
			this.setTexture(canvas3d.createTexture(width, width, atlas.data, {type: 'cube'}));
			this.redraw();
		};
		set(after)();
		this.face = face;
		this.setSlice(this.layers[face]);
		history.record(`Set Face ${CubeMode.faceNames[face]}`, set(before), set(after));
	}

	override raw() {
		const raw = super.raw();
		if (raw)
			raw.type	= 'cube';
		return raw;
	}
}

//-----------------------------------------------------------------------------
// Volume Mode
//-----------------------------------------------------------------------------

// a volume, which can be looked at but not drawn on
class VolumeMode extends CubeViewMode {

	constructor(volume: ImageData, depth: number, private program3D: ShaderProgram, private program3D2D: ShaderProgram) {
		super(volume, depth);
		this.pan.width	= volume.width;
		this.pan.height	= volume.height;
		this.setTexture(canvas3d.createTexture(volume.width, volume.height / depth, volume.data, {type: 'volume', depth}));
	}
	static async create(volume: ImageData, depth: number) {
		return new VolumeMode(volume, depth, await shader('3d', cubeGeometry), await shader('3d2d'));
	}
	override activate() {
		this.reset();
	}

	// A volume unfolds with slice 0 at the top and image rows running down the screen, so it faces the camera with a half
	// turn about x (slice 0 in front, image upright)
	protected homeRotation() {
		return float3x3(float3(1, 0, 0), float3(0, -1, 0), float3(0, 0, -1));
	}
	protected unfoldedPosition() {
		return this.flatPosition({x: this.image!.width / 2, y: this.image!.height / 2}, this.image!.width, 0);
	}

	protected drawFlat() {
		canvas3d.bindTexture3D(this.texture ?? null);
		this.program3D2D.draw({
			u_texture:	0,
			u_size:		[this.image!.width, this.sliceHeight, this.count],
			u_viewport:	[this.canvas.width, this.canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
		});
	}
	protected drawSolid(mvp: number[]) {
		const o = this.orbit;
		canvas3d.bindTexture3D(this.texture ?? null);
		this.program3D.draw({
			u_texture: 	0,
			u_mvp:		mvp,
			u_origin:	o.eye._values,
			u_opacity:	1.0,
			u_size:    	this.image!.width,
			u_light:	o.basis.z._values, // direction towards the light: a headlight, from the camera
			u_flatten: 	this.flatten,
		});
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image || this.flatten !== 0)
			return undefined;
		const point = this.rayHit(clientX, clientY);
		if (!point)
			return undefined;
		const x = clampDimension(point.x, this.image.width);
		const y = clampDimension(point.y, this.sliceHeight);
		const z = clampDimension(point.z, this.count);
		const colour = asRGBA(getPixel(this.image, x, y + z * this.sliceHeight));
		return colour && `Pixel ${x},${y},${z} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		return [
			...super.menu(),
			this.foldToggle()
		];
	}
}

//-----------------------------------------------------------------------------
// dropped images
//-----------------------------------------------------------------------------

// images dropped on a picture with layers become layers above the current one;
// on a plain image, they make it one with layers (it is the background);
// on an array they are added to it as slices; on a cube, the first is a face. All of it one edit.
const dropTarget	= $('bitmap-stage');
const hasFiles		= (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
dropTarget.addEventListener('dragover', e => {
	if (hasFiles(e)) {
		e.preventDefault();
		dropTarget.classList.add('dropping');
	}
});
dropTarget.addEventListener('dragleave', e => {
	if (e.target === dropTarget)
		dropTarget.classList.remove('dropping');
});
dropTarget.addEventListener('drop', e => {
	dropTarget.classList.remove('dropping');
	if (hasFiles(e)) {
		e.preventDefault();
		mode.drop(Array.from(e.dataTransfer!.files), e.clientX, e.clientY);
	}
});

//-----------------------------------------------------------------------------
// laying out a picture as a cubemap
//-----------------------------------------------------------------------------

// Where each face is in an image laid out in one of the usual ways, as cells of a grid (and whether the face is turned
// half way round there), by the shape of the image: one picture to be on every face when it is about square; six faces in a
// row or in a column; a cross, four faces across and three down or three across and four down
function cubeLayout(width: number, height: number) {
	const ratio = width / height;
	type Cell = [col: number, row: number, turned?: boolean];
	const grid = (cols: number, rows: number, cells: Cell[]) => ({cols, rows, cells});
	if (ratio > 0.8 && ratio < 1.25)
		return grid(1, 1, [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
	if (ratio > 5 && ratio < 7)
		return grid(6, 1, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
	if (ratio > 1 / 7 && ratio < 1 / 5)
		return grid(1, 6, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]);
	if (ratio >= 1.25 && ratio < 1.5)
		return grid(4, 3, [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [3, 1]]);
	if (ratio > 0.6 && ratio <= 0.8)
		return grid(3, 4, [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [1, 3, true]]);
	return undefined;
}

// the faces of the picture, one above another; undefined if it is not shaped like a cubemap
export function cubeFaces(picture: ImageData): ImageData | undefined {
	const layout = cubeLayout(picture.width, picture.height);
	if (!layout)
		return undefined;
	const cw = Math.floor(picture.width / layout.cols), ch = Math.floor(picture.height / layout.rows);
	const size = Math.min(cw, ch);
	if (size < 1)
		return undefined;
	
	const from	= createElement('canvas', {width: picture.width, height: picture.height});
	from.getContext('2d')!.putImageData(picture, 0, 0);

	const ctx	= createElement('canvas', { width: size, height: size * 6}).getContext('2d')!;
	layout.cells.forEach(([col, row, turned], face) => {
		ctx.save();
		ctx.translate(size / 2, face * size + size / 2);
		if (turned)
			ctx.rotate(Math.PI);
		ctx.drawImage(from, col * cw, row * ch, cw, ch, -size / 2, -size / 2, size, size);
		ctx.restore();
	});
	return ctx.getImageData(0, 0, size, size * 6);
}

//-----------------------------------------------------------------------------
// messages
//-----------------------------------------------------------------------------
function convertImage(image: Pixels<4>) {
	return new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height);
}

// A new picture, in a mode made for it, replaces the one there is (and what was done to that: it is not undone)
async function load(made: Promise<Mode>) {
	const next = await made;
	Mode.enterPicture(next);
	next.fit();
	next.redraw();
}

window.addEventListener('message', async event => {
	if (handleResult(event.data))
		return;

	const message = event.data as MessageIn | RpcMessage<MessageRpc>;

	switch (message.command) {
		case 'loadTexture': {
			const bitmap = await createImageBitmap(new Blob([message.data], {type: message.mimeType}));
			await load(ImageMode.create(bitmapToImage(bitmap)));
			break;
		}
		case 'load2d':
			if (message.layers?.length)
				await load(LayeredMode.create(convertImage(message.image), message.layers));
			else
				await load(ImageMode.create(convertImage(message.image)));
			break;

		case 'load2dArray':
			await load(ArrayMode.create(convertImage(message.image), message.layers));
			break;

		case 'loadCube':
			await load(CubeMode.create(convertImage(message.image)));
			break;

		case 'load3d':
			await load(VolumeMode.create(convertImage(message.image), message.depth));
			break;

		case 'imageOp':
			if (!await mode.run(message.op))
				postMessage({command: 'error', message: 'That is not available here.'});
			break;

		case 'undo':
			history.undo();
			break;

		case 'redo':
			history.redo();
			break;

		case 'fitToWindow':
			mode.fit();
			mode.redraw();
			break;

		//RPC cases

		case 'getTexture':
			if (message.type === 'image/x-rgba') {
				sendResult(message.requestId, mode.raw());
				break;
				
			} else {
				const image = mode.picture();
				if (image) {
					getImageData(image, message.type)?.then(async blob => {
						if (blob)
							sendResult(message.requestId, await blob.arrayBuffer());
						else
							sendResult(message.requestId);
					});
					break;
				}
			}
			sendResult(message.requestId);
			break;
	}

});

(async () => {
	await loadPrograms();
	//resizeCanvas();
	postMessage({command: 'ready'});
})();
