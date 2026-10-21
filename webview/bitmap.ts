import { Tooltip, vscode, RPC, handleResult, sendResult, RpcMessage, createElement} from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, rectGeometry, cubeGeometry, bitmapToImage, getImageData, getPixel, Pixels } from './opengl.js';
import { float2, float3, float2x3, float3x3, float4, float4x4, normalise, lerp, orthonormalise, approx_equal, matmulExt } from '@isopodlabs/maths/vector';
import { unitQuaternion } from '@isopodlabs/maths/quaternion';
import { Selection } from './bitmapSelection.js';
import { Painter, PaintHost, EditOp, HistoryEntry, DocumentChange, TransformTarget, TransformSession } from './paint.js';
import { LayerStack, Layer, LayerMask, PlacedPixels, Snapshot, expand, LayerOps, LayerOp, LayerCompositor, BLEND_GROUPS, pixelRect } from './layers.js';
import { SheetFan, SheetFanHost, Placement } from './sheetfan.js';
import { CascadeItem, valueItem, toggleItem, svgFace, valueFace } from './cascade.js';
import { RGBA, imageSize, imageRect, liftSelection, warpSelected, transformedBounds, alphaExtent, crop, flip, rotate, warp } from './raster.js';
import { Orbit, OrbitHooks, DEFAULT_FOVY } from './orbit.js';
import { Gizmo } from './gizmo.js';
import { Pan } from './pan.js';
import { NavigateHooks } from './navigate.js';

export type { EditOp, LayerOp, Pixels };

//-----------------------------------------------------------------------------
// globals
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
	mask?:		{left: number, top: number, width: number, height: number, default: number, disabled: boolean, inverted: boolean, data: ArrayBuffer};
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

export type shaderType = 'bg'|'2d'|'array2d'|'3d'|'3d2d'|'cube'|'cube2d'|'layer'|'composite'|'planes'|'warp';
export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders', type: shaderType, requestId: number}//result: {vert: string, frag: string}};
	| {command: 'edited', label: string};	// the image has been changed, undoably

export type MessageIn =
	| {command: 'load2d', image: Pixels, layers?: LayerData[]}	// layers, bottom first, over the canvas the image is the size of
	| {command: 'load2dArray', image: Pixels, layers: number}
	| {command: 'loadCube', image: Pixels}
	| {command: 'load3d', image: Pixels, depth: number}
	| {command: 'loadTexture', data: ArrayBuffer, mimeType: string}
	| {command: 'imageOp', op: EditOp | LayerOp}	// do a whole-image editing operation, or one to the layers
	| {command: 'undo'}
	| {command: 'redo'}
	| {command: 'fitToWindow'};

export type MessageRpc =
	| {command: 'getImage', result: Pixels}
	// The image as a file of the given type, which a canvas can write (PNG, JPEG); or, for RAW_IMAGE, its raw pixels,
	// for the extension to write as whatever else it likes
	| {command: 'getTexture', type: string, result: ArrayBuffer | RawImage}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas: HTMLCanvasElement	= $('viewport');
const canvas3d	= new Canvas3D(canvas, {onError: message => postMessage({command: 'error', message})});
const tooltip 	= new Tooltip();

let programBG:		ShaderProgram;
let programLayer:	ShaderProgram;	// what layers (and slices) are drawn with, in the fan and as one is transformed
let programWarp:	ShaderProgram;	// what carries pictures onto another plane, for a transform and for the menu's thumbnails
let blank:			WebGLTexture;	// transparent, to bind where nothing is wanted

// (made once: a program is for the page, where a mode is for one picture)
const shaders = new Map<string, Promise<ShaderProgram>>();
function shader(type: shaderType, geometry = rectGeometry) {
	let program = shaders.get(type);
	if (!program)
		shaders.set(type, program = RPC<{vert: string, frag: string}>({command: 'getShaders', type}).then(code => canvas3d.createProgram(code, geometry)));
	return program;
}

function postMessage(message: MessageOut) {
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
function planeMvp(base: float2x3, matrix: float3x3, z = 1) {
	return float4x4.from2D(float3x3.from2D(base).matmul(matrix), z);
}

// The picture as it lies flat on the window, for the fan to open from: the 2D view's matrix, in the model's own measure (the
// picture's longest side is 1), with every sheet at no depth.
function flatView(base: float2x3, longest: number) {
	return planeMvp(base, float3x3(float3(longest, 0, 0), float3(0, longest, 0), float3(0, 0, 1)), 0);
}

// A texture (with a mask, if it has one) drawn where it is on the canvas (which is `rect`) as it is carried by the matrix,
// from canvas coordinates. It is the layer's, if it is one.
function drawQuad(texture: WebGLTexture | undefined, maskTexture: WebGLTexture | undefined, area: float2.extent, mask: LayerMask | undefined, opacity: number, mvp: float4x4, clip?: {matrix: float3x3, size: float2}) {
	if (!texture || !programLayer)
		return;

	const gl	= canvas3d.gl;
	const size	= area.extent();

	canvas3d.bindTexture(gl.TEXTURE_2D, texture, 0);
	canvas3d.bindTexture(gl.TEXTURE_2D, maskTexture ?? blank, 1);
	canvas3d.bindTexture(gl.TEXTURE_2D, blank, 2);
	programLayer.draw({
		u_mvp:			new Float32Array(placed(mvp, area).flat()),
		u_floor:		0,
		u_texture:		0,
		u_mask:			1,
		u_base:			2,
		u_origin:		[area.min.x, area.min.y],
		u_maskRect:		mask ? [mask.left, mask.top, mask.image.width, mask.image.height] : [0, 0, 0, 0],
		u_maskParams:	[(mask?.default ?? 255) / 255, mask?.inverted ? 1 : 0, mask ? 1 : 0],
		u_baseRect:		[0, 0, 0, 0],
		u_opacity:		opacity,
		u_size:			[size.x, size.y],
		u_edge:			0,
		u_veil:			0,
		u_outline:		[0, 0, 0, 0],
		// what lands outside `size`, once `matrix` has carried it, is not drawn
		u_clip:			clip ? new Float32Array(clip.matrix.matmul(float3x3(float3(size.x, 0, 0), float3(0, size.y, 0), float3(area.min.x, area.min.y, 1))).flat()) : new Float32Array(float3x3.identity().flat()),
		u_clipSize:		clip ? [clip.size.x, clip.size.y] : [0, 0],
	});
}

//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// the tool menu's part about what is seen, rather than what is drawn: which layer or slice, and the 3D view
const stackIcon = '<path d="M2 5.5L8 3l6 2.5L8 8z"/><path d="M2 8.5L8 11l6-2.5"/><path d="M2 11.5L8 14l6-2.5"/>';
const menuIcon = {
	eye:	'<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
	trash:	'<path d="M3 5h10M6 5V3h4v2M4.5 5l.5 8.5h6l.5-8.5"/>',
	plus:	'<path d="M8 3v10M3 8h10"/>',
};
const THUMB_SIZE = 26;

// A layer as it is on the picture (the rectangle `area`), small (THUMB_SIZE across at most), over a chequerboard: what tells a
// layer apart. It is shrunk by warp, which averages what a pixel covers.
function stripThumb({image, left, top}: PlacedPixels, area: float2.extent) {
	const {x: width, y: height} = area.extent();
	const k		= THUMB_SIZE / Math.max(width, height);
	const w		= Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
	const canvas = createElement('canvas', {width: w, height: h});
	const ctx	= canvas.getContext('2d')!;
	const out	= ctx.createImageData(w, h);
	const small = image.width && image.height
		? warpPixels(image, float3x3(float3(w / width, 0, 0), float3(0, h / height, 0), float3(left * w / width, top * h / height, 1)), new float2.extent(float2(0, 0), float2(w, h)))
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

// A layer or slice is chosen from a strip of them all as thumbnails (the top first), each coming out with more to be done
// to it, and a layer dragged to another place in the strip is moved there; or by the wheel on the icon, which shows the
// one chosen
function chooser<K>(caption: string,
	keys:		()					=> K[],
	current:	()					=> K,
	set:		(k: K)				=> void,
	name:		(k: K)				=> string,
	thumb:		(k: K)				=> HTMLCanvasElement,
	more:		(k: K)				=> CascadeItem[] | undefined,
	highlight:	(k: K | undefined)	=> void,
	drag?:		(k: K)				=> CascadeItem['drag'],
	extra:		CascadeItem[] = [],
	topFirst = true
): CascadeItem {
	const urls = new Map<K, string>();	// (the menu is made again each time it comes up, so these are as the pictures are then)
	const face = (k: K) => {
		let url = urls.get(k);
		if (url === undefined)
			urls.set(k, url = `<img class="cascade-thumb" draggable="false" src="${thumb(k).toDataURL()}">`);
		return url;
	};
	return {
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

// the 3D view on or off, with how far apart the layers lie (a percentage of the longest side) coming out of it
function viewToggle(mode: Mode, fan: SheetFan): CascadeItem {
	return {
		...toggleItem('3D view', svgFace(stackIcon), () => fan.on, on => fan.show(on)),
		children: () => [valueItem({
			label: 'gap', caption: 'Space between the layers', min: 1, max: 100, presets: [2, 4, 8, 16, 32],
			get: () => Math.round(fan.gap * 100), set: v => { fan.gap = v / 100; mode.redraw(); },
		})],
	};
}

// what can be done to a layer
function layerItems(layerOps: LayerOps, layer: Layer): CascadeItem[] {
	const op = (icon: string, caption: string, run: () => void): CascadeItem => ({
		face:		() => svgFace(icon),
		caption:	() => caption,
		select:		() => { run(); },
	});
	const modes = BLEND_GROUPS.flatMap(g => g.modes);
	const blend: CascadeItem = {
		face:		() => valueFace('blend', modes.find(m => m.key === layer.blend)?.short ?? 'Norm'),
		caption:	() => `Blend mode: ${modes.find(m => m.key === layer.blend)?.name ?? 'Normal'}`,
		children:	() => BLEND_GROUPS.map(g => ({
			face:		() => valueFace('', g.name.slice(0, 4)),
			caption:	() => g.name,
			active:		() => g.modes.some(m => m.key === layer.blend),
			children:	() => g.modes.map(m => ({
				face:		() => valueFace('', m.short),
				caption:	() => m.name,
				active:		() => layer.blend === m.key,
				select:		() => { layerOps.setBlend(layer, m.key); return true; },
			})),
		})),
	};
	return [
		toggleItem('Visible', svgFace(menuIcon.eye), () => layer.visible, v => layerOps.setVisible(layer, v)),
		valueItem({
			label: 'opacity', caption: 'Opacity', min: 0, max: 100, presets: [0, 25, 50, 75, 100],
			get: () => Math.round(layer.opacity * 100), set: v => layerOps.setOpacity(layer, v / 100),
			step: (v, steps) => v + 5 * steps,
		}),
		blend,
		op(menuIcon.trash, 'Delete layer', () => layerOps.remove(layer)),
	];
}


//-----------------------------------------------------------------------------
// dropped images
//-----------------------------------------------------------------------------

interface Dropped { name: string, pixels: ImageData }

// images dropped on a picture with layers become layers above the current one; on a plain image, they make it one with
// layers (it is the background); on an array they are added to it as slices; on a cube, the first is a face. All of it one edit.
const dropTarget = $('bitmap-stage');
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
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

type Drag = NonNullable<CascadeItem['drag']>;

// a way of moving a layer as the menu's strip has it, which lists the last first
function reversed(r: Drag, count: () => number): Drag {
	return {begin: r.begin, to: (place: number) => r.to(count() - 1 - place), drop: r.drop};
}

//-----------------------------------------------------------------------------
// modes
//-----------------------------------------------------------------------------

// What the picture is: a plain image, a picture of layers, an array of slices, a cubemap or a volume. A mode is what is done
// differently for each: how it is drawn, moved about in, edited, and kept in a file. One is made for each picture which is loaded,
// holds everything of it (its pixels, its textures, its view), and is given back (`dispose`) when another is made current (`mode`,
// by `enter`).
abstract class Mode implements PaintHost {
	readonly canvas = canvas;
	readonly canvas3d = canvas3d;

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

	abstract picture(): ImageData | undefined;
	abstract target(): Pixels | undefined;
	abstract toImage(clientX: number, clientY: number): float2;
	abstract toScreen(p: float2): float2;
	abstract pixelSize(): number;
	abstract redraw(): void;
	abstract fit(): void;

	edited(label: string) {				// an undoable change has been made
		postMessage({command: 'edited', label});
	}

	tooltip(clientX: number, clientY: number): string | undefined {
		return undefined;
	}
	panelOpened() {							// the tool menu has come up over the picture
		tooltip.hide();
	}
	// A press which a tool takes (it is not for the view). Control-click, a right click on a Mac, brings up the menu, and is not for
	// the view either.
	pointerDown(event: PointerEvent): boolean {
		return painter.pointerDown(event) || (event.button === 0 && event.ctrlKey && navigator.platform.toLowerCase().includes('mac'));
	}

	resized() {}						// the window has changed size

	// editing
	
	pick(x: number, y: number): RGBA | undefined {	// the colour seen at a pixel of the picture
		return undefined;
	}
	menu(): CascadeItem[] {			// more for the tool menu
		return [];
	}
	changed(changed: Pixels, rect?: float2.extent) {	// pixels of an image have changed
		this.redraw();
	}
	beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		return undefined;
	}
	transform(change: DocumentChange): HistoryEntry | undefined {
		return undefined;
	}
	// Files dropped on it: the images among them are for it to do with as it will
	async drop(files: File[], clientX: number, clientY: number) {
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
			await this.dropped(items, clientX, clientY);
	}
	protected async dropped(items: Dropped[], clientX: number, clientY: number) {}

	// An operation from the title menu: whether this mode does it (some do not mean anything to some modes)
	run(op: EditOp | LayerOp): boolean | Promise<boolean> {
		return painter.run(op);
	}

	// the picture as pixels, and as the file keeps it, with what is more than pixels
	raw(): RawImage | undefined {
		const image = this.picture();
		return image && {width: image.width, height: image.height, data: image.data.slice().buffer};
	}
}

class EmptyMode extends Mode {
	fit() {}
	toImage(clientX: number, clientY: number) {
		return float2(0, 0);
	}
	toScreen(p: float2) {
		return p;
	}
	pixelSize() {
		return 1;
	}
	override target() {
		return undefined;
	}
	override picture() {
		return undefined;
	}
	redraw() {}
}
/*
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

//-----------------------------------------------------------------------------
// PanMode
// base of AtlasMode,PictureMode
//-----------------------------------------------------------------------------

// A picture seen in a 2D view: zoomed and dragged about
abstract class PanMode extends Mode implements NavigateHooks {
	// the 2D view of the picture (for a cube, of its unfolded layout)
	readonly pan: Pan = new Pan(canvas, this);

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
		this.pan.dispose();
		super.dispose();
	}
}

//-----------------------------------------------------------------------------
// AtlasMode
//-----------------------------------------------------------------------------

// the colour of a pixel of a layer, if it is on the layer
function layerPixel(layer: Layer | undefined, x: number, y: number) {
	if (layer && x >= layer.left && y >= layer.top && x < layer.left + layer.image.width && y < layer.top + layer.image.height)
		return getPixel(layer.image, x - layer.left, y - layer.top);
}

// an image of slices, one above another: the faces of a cube, the slices of an array or a volume
abstract class AtlasMode extends PanMode {
	layer:		Layer | undefined;		// the current slice (or face): the one the tools draw on

	count:		number;
	sliceHeight:	number;
	// the rectangle of one slice
	get sliceRect() {
		return float2.extent.fromSize(float2(0, 0), float2(this.image.width, this.sliceHeight));
	}
	// The slices as layers of their own, which the painter chooses between as it does a picture's layers, in their order in
	// the atlas. Each has pixels of its own (copied from the atlas, which is not kept up to date by that, for an array; shared
	// with it for a cube), as an undo step knows the image it was made on, and a slice moved takes them with it.
	layers:		Layer[] = [];

	// The slices become layers, if they are named: each with pixels of the atlas, shared with it or copied
	constructor(public image: ImageData, count: number, layers?: {name: (i: number) => string, share: boolean}) {
		super();
		this.count		= count;
		this.sliceHeight = image.height / count;
		if (layers) {
			const height = this.sliceHeight, size = image.width * height * 4;
			this.layers = Array.from({length: count}, (_, i): Layer => ({
				name: layers.name(i), left: 0, top: 0, opacity: 1, visible: true, blend: 'norm',
				image: new ImageData(layers.share ? image.data.subarray(i * size, (i + 1) * size) : image.data.slice(i * size, (i + 1) * size), image.width, height),
			}));
			this.layer = this.layers[0];
		}
	}

	override picture() {
		return this.image;
	}
	override target() {
		return this.layer?.image;
	}
	override pick(x: number, y: number) {
		return layerPixel(this.layer, x, y);
	}

	// the slice (or face) `i` has these pixels on the GPU
	protected uploadSlice(i: number, image: Pixels): void {
		throw new Error('there are no slices to put pixels in');
	}
	// where the pixels of slice `i`, carried by this matrix (from its own coordinates), land in clip space
	protected carriedMvp(i: number, matrix: float3x3): float4x4 {
		throw new Error('there are no slices to carry');
	}
	// what is drawn over the picture while a slice is transformed: the slice, carried
	protected carried: (() => void) | undefined;

	// A slice is carried by drawing it over the picture, which has its place left empty while it is
	override beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		const layer	= target === 'layer' ? this.layer : undefined;
		const box	= layer && (selection ? selection.bounds() : alphaExtent(layer.image));
		if (!layer || !box)
			return undefined;
		const i		= this.layers.indexOf(layer);
		// (what is carried is all of the slice, or what is selected of it, and its place is left with the rest)
		const lifted = selection && liftSelection(layer.image, selection);
		const own	= canvas3d.createTextureFromImage(lifted ? lifted.floating : layer.image);
		this.uploadSlice(i, lifted ? lifted.rest : new ImageData(layer.image.width, layer.image.height));
		return {
			box, layer, selection,
			update: matrix => {
				this.carried = () => {
					const gl = canvas3d.gl, depth = gl.isEnabled(gl.DEPTH_TEST);
					gl.disable(gl.DEPTH_TEST);
					drawQuad(own, undefined, imageRect(layer.image), undefined, 1, this.carriedMvp(i, matrix), {matrix, size: imageSize(layer.image)});
					if (depth)
						gl.enable(gl.DEPTH_TEST);
				};
				this.redraw();
			},
			end: () => {
				this.carried = undefined;
				canvas3d.deleteTexture(own);
				this.uploadSlice(i, layer.image);
				this.redraw();
			},
		};
	}

	override transform(change: DocumentChange) {
		return change.kind === 'warp' ? this.warpSlice(change.matrix, change.layer, change.selection) : undefined;
	}

	// A slice (or face) carried by a matrix (its own pixels, in its own coordinates): what is carried off the slice is lost, and what is
	// left is transparent. One edit.
	warpSlice(matrix: float3x3, layer?: Layer, selection?: Selection): HistoryEntry | undefined {
		const slice = layer ? this.layers.indexOf(layer) : -1;
		if (!layer || slice < 0 || !this.texture)
			return undefined;
		const {width} = layer.image, whole = imageRect(layer.image);
		const before = (layer.image.data as Uint8ClampedArray).slice();
		let after: Uint8ClampedArray;
		if (selection) {
			// (the rest of the slice is as it was)
			after = warpSelected(layer.image, selection, matrix, warpPixels).data as Uint8ClampedArray;
		} else {
			const area = transformedBounds(matrix, whole)?.intersect(whole);
			if (!area || area.empty())
				return undefined;
			const warped = warpPixels(layer.image, matrix, area);
			after = new Uint8ClampedArray(before.length);
			const {x: w, y: h} = area.extent();
			for (let j = 0; j < h; j++)
				after.set((warped.data as Uint8ClampedArray).subarray(j * w * 4, (j + 1) * w * 4), ((area.min.y + j) * width + area.min.x) * 4);
		}
		const set = (data: Uint8ClampedArray) => () => {
			(layer.image.data as Uint8ClampedArray).set(data);
			this.uploadSlice(slice, layer.image);
			this.redraw();
		};
		set(after)();
		return {undo: set(before), redo: set(after)};
	}

}

// the quad of the layer drawing shader (which covers 0 to 1 across and down) put where a rectangle of the picture is, at a depth, and
// seen as `mvp` has it (from the picture's pixels)
function placed(mvp: float4x4, ext: float2.extent, depth = 0) {
	const {x: w, y: h} = ext.extent();
	return mvp.matmul(float4x4(float4(w, 0, 0, 0), float4(0, h, 0, 0), float4(0, 0, 1, 0), float4(ext.min.x, ext.min.y, depth, 1)));
}

//-----------------------------------------------------------------------------
// PictureMode
//-----------------------------------------------------------------------------

// a 2D picture, in the 2D view
abstract class PictureMode extends PanMode {

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
			box,
			update: matrix => {
				this.preview = () => {
					programBG.draw({u_viewport: [canvas.width, canvas.height]});
					drawQuad(this.texture, undefined, box, undefined, 1, planeMvp(this.pictureMatrix(), matrix));
				};
				this.redraw();
			},
			end: () => {
				this.preview = undefined;
				this.redraw();
			},
		};
	}

	// the colour at a pixel of the picture
	protected abstract colourAt(x: number, y: number): {r: number, g: number, b: number, a: number} | undefined;

	protected drawFlat() {
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_2D, this.texture ?? null);
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
		painter.draw();
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image)
			return undefined;
		const point = canvas3d.toCanvas(clientX, clientY);
		const x = Math.floor((point.x - this.pan.offset.x) / this.pan.scale);
		const y = Math.floor((point.y - this.pan.offset.y) / this.pan.scale);
		const colour = this.colourAt(x, y);
		return colour && `Pixel ${x}, ${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}
}

//-----------------------------------------------------------------------------
// ImageMode
//-----------------------------------------------------------------------------

// a plain image
class ImageMode extends PictureMode {

	constructor(image: ImageData, program2D: ShaderProgram) {
		super(image, program2D);
		this.setTexture(canvas3d.createTextureFromImage(image));
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

	protected colourAt(x: number, y: number) {
		return getPixel(this.image!, x, y);
	}

	override changed(changed: Pixels, rect?: float2.extent) {
		if (this.texture && this.image)
			canvas3d.updateTexture(this.texture, this.image, rect);
		this.redraw();
	}

	// the start of a transform: the whole canvas
	override beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		if (!this.image || !programLayer)
			return undefined;
		if (!selection)
			return this.wholeSession();
		// what is selected is carried, over the picture with it taken from it
		const image = this.image, whole = imageRect(image), {floating, rest} = liftSelection(image, selection);
		const own = canvas3d.createTextureFromImage(floating);
		canvas3d.updateTexture(this.texture!, rest);
		return {
			box: selection.bounds(), selection,
			update: matrix => {
				this.preview = () => {
					this.drawFlat();
					drawQuad(own, undefined, whole, undefined, 1, planeMvp(this.pictureMatrix(), matrix));
				};
				this.redraw();
			},
			end: () => {
				this.preview = undefined;
				canvas3d.deleteTexture(own);
				canvas3d.updateTexture(this.texture!, image);
				this.redraw();
			},
		};
	}

	override transform(change: DocumentChange) {
		if (!this.image)
			return undefined;
		const before = this.image;
		let r: Pixels;
		switch (change.kind) {
			case 'flip':	r = flip(before, change.horizontal); break;
			case 'rotate':	r = rotate(before, change.clockwise); break;
			case 'crop':	r = crop(before, change.rect); break;
			case 'warp': {
				if (change.selection) {
					r = warpSelected(before, change.selection, change.matrix, warpPixels);
					break;
				}
				// the picture within its canvas, or onto a canvas which fits it
				const onto = change.layer ? imageRect(before) : transformedBounds(change.matrix, imageRect(before));
				const size = onto?.extent();
				if (!onto || !size!.x || !size!.y)
					return undefined;
				r = warpPixels(before, float3x3.translate(onto.min.neg()).matmul(change.matrix), float2.extent.fromSize(float2(0, 0), size!));
				break;
			}
		}
		const after = new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
		// within the canvas, the view stays as it is
		const show = (im: ImageData) => () => {
			const self = this.live;
			self.image		= im;
			self.setTexture(canvas3d.createTextureFromImage(im));
			if (change.kind !== 'warp' || !(change.layer || change.selection)) {
				this.pan.width	= im.width;
				this.pan.height	= im.height;
				self.fit();
			}
			self.redraw();
		};
		show(after)();
		return {undo: show(before), redo: show(after)};
	}

	// the faces of the picture, if it is shaped like a cubemap
	override async run(op: EditOp | LayerOp) {
		if (op !== 'toCubemap')
			return super.run(op);
		const faces = cubeFaces(this.image!);
		if (faces)
			await load(CubeMode.create(faces));
		else
			postMessage({command: 'error', message: 'The image is not laid out as a cubemap: it should be square, 6x1 or 1x6 faces, or a 4x3 or 3x4 cross.'});
		return true;
	}

	// Images dropped on it make it a picture with layers (it is the background): all of it one edit
	protected override async dropped(items: Dropped[]) {
		const program2D = this.program2D, composite = await shader('composite');
		const image		= this.image, {width, height} = image;
		const bg		= newLayer('Background', {data: new Uint8ClampedArray(image.data), width, height});
		const made		= items.map(it => newLayer(it.name, {data: it.pixels.data, width: it.pixels.width, height: it.pixels.height}));
		const layers	= [bg, ...made];
		// (the same picture, seen from the same place)
		const switchTo = (next: PanMode) => {
			if (mode instanceof PanMode) {
				next.pan.scale	= mode.pan.scale;
				next.pan.offset	= mode.pan.offset;
			}
			enter(next);
			mode.redraw();
		};
		const redo = () => switchTo(new LayeredMode(image, layers, program2D, composite));
		const undo = () => switchTo(new ImageMode(image, program2D));
		redo();
		painter.record(made.length > 1 ? 'Add Layers' : 'Add Layer', undo, redo);
	}
}

//-----------------------------------------------------------------------------
// LayeredMode
//-----------------------------------------------------------------------------

// a picture of layers, which is on the GPU as they are composed
class LayeredMode extends PictureMode implements SheetFanHost {

	readonly ops = new LayerOps({
		stack:		() => this.live.stack,
		layer:		() => this.live.layer,
		select:		layer => { this.live.layer = layer; },
		record:		(label, undo, redo) => painter.record(label, undo, redo),
		changed:	() => this.live.recompose(),
	});
	private static readonly FLOOR = 0.2;	// the least that shows of a layer's opacity, and of what its mask and clipping take away

	// the layers as the sheets of the fan
	readonly fan = new SheetFan(this);
	readonly tip = fanTip;
	opened(open: boolean) {
		fanOpened(open);
		this.pan.enabled = !open;	// (the 2D view is not in use while the layers are)
	}
	get width()		{ return this.stack.width; }
	get height()	{ return this.stack.height; }
	get count()		{ return this.stack.layers.length; }
	get current()	{ return this.layer ? this.stack.layers.indexOf(this.layer) : -1; }
	flatView()		{ return flatView(this.pictureMatrix(), Math.max(this.stack.width, this.stack.height)); }
	bounds(i: number) {
		const layer = this.stack.layers[i];
		return pixelRect(layer);
	}
	sheetName(i: number)	{ return this.stack.layers[i].name; }
	choose(i: number)		{ this.ops.choose(i); }
	reorderer(i: number)	{ return this.dragger(this.stack.layers[i]); }
	sheetMenu(i: number | undefined, clientX: number, clientY: number) {
		painter.openMenu(clientX, clientY, i === undefined ? undefined : layerItems(this.ops, this.stack.layers[i]));
	}
	drawSheet(i: number, at: Placement) {

		const layers = this.stack.layers, layer = layers[i], gl = canvas3d.gl;
		const rect0 = pixelRect(layer);// / at.longest;
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
		const mask			= layer.mask && !layer.mask.disabled && layer.mask.image.width && layer.mask.image.height ? layer.mask : undefined;
		const clip			= base && base.image.width && base.image.height ? base : undefined;
		const flatUniforms	= {u_floor: LayeredMode.FLOOR};

		// (the textures are made before any is bound: making one binds it, on the unit which is active)
		const compositor	= this.compositor;
		const texture 		= compositor.layerTexture(layer);
		const maskTexture	= compositor.maskTexture(layer) ?? compositor.dummyMask(), baseTexture = clip ? compositor.layerTexture(clip) : undefined;
		if (texture && maskTexture) {
			canvas3d.bindTexture(gl.TEXTURE_2D, texture, 0);
			canvas3d.bindTexture(gl.TEXTURE_2D, maskTexture, 1);
			canvas3d.bindTexture(gl.TEXTURE_2D, baseTexture ?? blank, 2);
			programLayer.draw({
				...flatUniforms,
				u_mvp:			new Float32Array(placed(at.matrix, rect, at.depth).flat()),
				u_texture:		0,
				u_mask:			1,
				u_base:			2,
				u_origin:		[layer.left, layer.top],
				u_maskRect:		mask ? [mask.left, mask.top, mask.image.width, mask.image.height] : [0, 0, 0, 0],
				u_maskParams:	[(mask?.default ?? 255) / 255, mask?.inverted ? 1 : 0, mask ? 1 : 0],
				u_baseRect:		clip ? [clip.left, clip.top, clip.image.width, clip.image.height] : [0, 0, 0, 0],
				u_opacity:		shown,
				u_size:			[layer.image.width, layer.image.height],
				u_edge:			0,
				u_veil:			0,
				u_outline:		[0, 0, 0, 0],
			});
		}

		// the sheet it is on, outlined: the corners which show tell the layers apart
		canvas3d.bindTexture(gl.TEXTURE_2D, blank, 0);
		programLayer.draw({
			...flatUniforms,
			u_mvp:			new Float32Array(placed(at.matrix, at.sheet, at.depth).flat()),
			u_texture:		0,
			u_mask:			1,
			u_base:			2,
			u_origin:		[0, 0],
			u_maskRect:		[0, 0, 0, 0],
			u_maskParams:	[0, 0, 0],
			u_baseRect:		[0, 0, 0, 0],
			u_opacity:		1,
			u_size:			[this.stack.width, this.stack.height],
			u_edge:			at.edge(at.current || at.hovered ? 2.5 : 1.5),
			u_veil:			0.05 * at.open,
			u_outline:		at.outline,
		})

	}

	layer:			Layer | undefined;	// the current layer: the one the tools draw on
	stack:			LayerStack;
	compositor:		LayerCompositor;	// which has the layers as textures, and makes the picture of them

	// the layers become the picture, over a canvas the size of the image
	constructor(image: ImageData, layers: Layer[], program2D: ShaderProgram, programComposite: ShaderProgram) {
		super(image, program2D);
		this.stack		= new LayerStack(image.width, image.height, layers);
		this.layer		= layers[layers.length - 1];
		expand(this.layer, image.width, image.height);	// what the tools draw on covers the canvas
		this.compositor	= new LayerCompositor(canvas3d, programComposite);
		this.compositor.compose(image.width, image.height, layers);
		this.texture	= this.compositor.texture;
	}
	static async create(image: ImageData, layers: Layer[]) {
		return new LayeredMode(image, layers, await shader('2d'), await shader('composite'));
	}

	// (as for ImageMode: an undo or redo made on an earlier mode is done on the one there is)
	private get live(): LayeredMode {
		return mode instanceof LayeredMode ? mode : this;
	}

	override dispose() {
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

	protected colourAt(x: number, y: number) {
		const c = this.compositor;
		const d = c && x >= 0 && y >= 0 && x < c.width && y < c.height ? c.read(new float2.extent(float2(x, y), float2(x + 1, y + 1))) : undefined;
		return d && {r: d[0], g: d[1], b: d[2], a: d[3]};
	}
	override target() {
		return this.layer?.image;
	}
	override pick(x: number, y: number) {
		return layerPixel(this.layer, x, y) ?? this.colourAt(x, y);
	}

	override menu() {
		const stack = this.stack;
		if (!stack)
			return [];
		const layers = stack.layers, area = imageRect(stack);
		const add: CascadeItem = {face: () => svgFace(menuIcon.plus), caption: () => 'New layer', select: () => { this.ops.run('newLayer'); }};
		return [
			chooser('Layer',
				() => this.stack?.layers ?? [],
				() => this.layer!,
				layer => { this.ops.choose(layers.indexOf(layer)); painter.draw(); },
				layer => layer.name,
				layer => stripThumb(layer, area),
				layer => layerItems(this.ops, layer), layer => this.fan.highlight(layer && layers.indexOf(layer)),
				layer => reversed(this.dragger(layer), () => layers.length),
				[add]
			),
			viewToggle(this, this.fan),
		];
	}

	// a layer's pixels, which may lie anywhere on the canvas
	override changed(changed: Pixels, rect?: float2.extent) {
		const layer = this.stack?.layers.find(l => l.image === changed);
		if (layer)
			this.compositor.upload(layer, rect);
		const shift = layer && float2(layer.left, layer.top);
		this.recompose(shift && rect ? new float2.extent(rect.min.add(shift), rect.max.add(shift)) : undefined);
	}

	// the start of a transform: what of the canvas it is of
	override beginTransform(target: TransformTarget, selection?: Selection): TransformSession | undefined {
		if (!this.image || !programLayer)
			return undefined;
		const layer = target === 'layer' ? this.layer : undefined;
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
			box: new float2.extent(r.min.add(shift), r.max.add(shift)), layer,
			update: matrix => {
				this.preview = () => {
					// (the textures are got before any is bound: making one binds it)
					const texture = this.compositor.layerTexture(layer), maskTexture = this.compositor.maskTexture(layer);
					this.drawFlat();
					const mask	= layer.mask && !layer.mask.disabled && layer.mask.image.width && layer.mask.image.height ? layer.mask : undefined;
					const mvp	= planeMvp(this.pictureMatrix(), matrix);
					drawQuad(texture, maskTexture, pixelRect(layer), mask, layer.visible ? layer.opacity : 0.3, mvp);
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
	private selectedSession(layer: Layer, selection: Selection): TransformSession {
		const {floating, rest} = liftSelection(layer.image, selection), whole = imageRect(layer.image);
		const own = canvas3d.createTextureFromImage(floating), left = canvas3d.createTextureFromImage(rest);
		this.recompose(undefined, layer);	// (the layer is left out, to be drawn on its own)
		return {
			box: selection.bounds(), layer, selection,
			update: matrix => {
				this.preview = () => {
					// (the textures are got before any is bound: making one binds it)
					const mask = layer.mask && !layer.mask.disabled && layer.mask.image.width && layer.mask.image.height ? layer.mask : undefined;
					const maskTexture = this.compositor.maskTexture(layer), opacity = layer.visible ? layer.opacity : 0.3;
					this.drawFlat();
					drawQuad(left, maskTexture, whole, mask, opacity, planeMvp(this.pictureMatrix(), float3x3.identity()));
					drawQuad(own, maskTexture, whole, mask, opacity, planeMvp(this.pictureMatrix(), matrix));
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
		function moveLayer(layer: Layer, place: (area: float2.extent) => float2, apply: (m: Pixels, c: number) => Pixels) {
			const m = layer.mask, at = place(pixelRect(layer)), maskAt = m && place(pixelRect(m));
			return {
				...layer,
				left:	at.x, top: at.y,
				image:	apply(layer.image, 4),
				mask:	m && maskAt && {...m, left: maskAt.x, top: maskAt.y, image: apply(m.image, 1)}
			};
		}

		function moveLayers(before: Snapshot, place: (area: float2.extent) => float2, apply: (m: Pixels, c: number) => Pixels, layer?: Layer) {
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
					(i, c) => flip(i, change.horizontal, c)
				);
				break;

			case 'rotate':
				after = moveLayers(before,
					area => float2(change.clockwise ? before.height - area.max.y : area.min.y, change.clockwise ? area.min.x : before.width - area.max.x),
					(i, c) => rotate(i, change.clockwise, c)
				);
				// (the canvas is turned too)
				after = after && {...after, width: before.height, height: before.width};
				break;

			case 'crop': {
				const {x, y} = change.rect.min, {x: width, y: height} = change.rect.extent();
				after = {
					width, height, current: before.current,
					layers: before.layers.map(l => ({
						...l,
						left: l.left - x, top: l.top - y,
						mask: l.mask && {...l.mask, left: l.mask.left - x, top: l.mask.top - y},
					})),
				};
				break;
			}
			case 'warp': {
				if (change.layer && change.selection) {
					const selection = change.selection, index = before.current;
					after = {...before, layers: before.layers.map((l, k) => k === index ? {...l, image: warpSelected(l.image, selection, change.matrix, warpPixels)} : l)};
					break;
				}
				const n = change.matrix.scale(1 / change.matrix.z.z);
				if (approx_equal(n.x, float3(1, 0, 0)) && approx_equal(n.y, float3(0, 1, 0)) && approx_equal(n.z.xy, float2(Math.round(n.z.x), Math.round(n.z.y)))) {
					const shiftx = Math.round(n.z.x), shifty = Math.round(n.z.y);
					after = moveLayers(before,
						area => area.min.add(float2(shiftx, shifty)),
						(i: Pixels, c: number) => i,
						change.layer
					);
				} else {
					const clip = change.layer && imageRect(before);
					let local: float3x3;
					let area: float2.extent | undefined;
					after = moveLayers(before,
						from => {
							const size = from.extent();
							local	= change.matrix.matmul(float3x3.translate(from.min));
							area	= transformedBounds(local, float2.extent.fromSize(float2(0, 0), size));
							if (area) {
								if (clip)
									area = area.intersect(clip);
								if (!area.empty())
									return area.min;
								area = undefined;
							}
							return from.min;
						},
						(i: Pixels, c: number) => area ? warpPixels(i, local, area, c) : i,
						change.layer
					);
				}
				break;
			}
		}

		if (!after)
			return undefined;

		const resized	= !(change.kind === 'warp' && change.layer);
		const use		= (s: Snapshot) => () => {
			const self = this.live, layers = self.stack;
			layers.restore(s);
			self.layer = layers.layers[s.current];
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
			painter.draw();
		};
		const undo = () => {
			const self = this.live;
			self.stack.layers.splice(at, made.length);
			self.layer = prev;
			self.recompose();
			painter.draw();
		};
		redo();
		painter.record(made.length > 1 ? 'Add Layers' : 'Add Layer', undo, redo);
	}

	// the picture again from the layers (all of it, or a part), and what shows of it
	recompose(area?: float2.extent, carried?: Layer) {
		if (this.compositor && this.stack) {
			// (the layer being transformed is drawn on its own, as it is carried)
			const layers = carried ? this.stack.layers.map(l => l === carried ? {...l, visible: false} : l) : this.stack.layers;
			this.compositor.compose(this.stack.width, this.stack.height, layers, area);
			this.texture = this.compositor.texture;
			this.redraw();
		}
	}

	override run(op: EditOp | LayerOp) {
		return this.ops.run(op) || super.run(op);
	}

	// a layer moved to another place in the order, by index: it is one edit when it is dropped
	dragger(layer: Layer): Drag {
		return {begin: () => this.ops.beginDrag(layer), to: (i: number) => this.ops.dragTo(i), drop: () => this.ops.endDrag()};
	}

	override raw() {
		const raw = super.raw();
		if (raw && this.stack)
			raw.layers = this.stack.layers.map(layer => {
				const m		= layer.mask;
				const mask	= m && {left: m.left, top: m.top, width: m.image.width, height: m.image.height, default: m.default, disabled: m.disabled, inverted: m.inverted, data: m.image.data};
				const ext	= alphaExtent(layer.image);
				const size	= ext?.extent() ?? float2(0, 0);
				const off 	= ext ? float2(layer.left, layer.top).add(ext.min) : float2(0, 0);

				return {
					name:	layer.name, opacity: layer.opacity, visible: layer.visible, blend: layer.blend, clipped: layer.clipped,
					left: 	off.x, top: off.y, width: size.x, height: size.y,
					data:	ext ? crop(layer.image, ext).data.slice().buffer : new Uint8ClampedArray(0).buffer,
					mask:	mask && {...mask, data: (mask.data as Uint8ClampedArray).slice().buffer},
				};
			});
		return raw;
	}
}

//-----------------------------------------------------------------------------
// ArrayMode
//-----------------------------------------------------------------------------

// an array of slices
class ArrayMode extends AtlasMode implements SheetFanHost {

	// the slices as the sheets of the fan
	readonly fan = new SheetFan(this);
	readonly tip = fanTip;
	opened(open: boolean) {
		fanOpened(open);
		this.pan.enabled = !open;	// (the 2D view is not in use while the layers are)
	}
	get width()		{ return this.image!.width; }
	get height()	{ return this.sliceHeight; }
	get current()	{ return this.currentSlice(); }
	flatView()		{ return flatView(this.pictureMatrix(), Math.max(this.image!.width, this.sliceHeight)); }
	bounds(i: number)		{ return undefined; }
	sheetName(i: number)	{ return `Slice ${i}`; }
	reorderer(i: number)	{ return this.dragger(this.layers[i]); }
	sheetMenu(i: number | undefined, clientX: number, clientY: number) {
		painter.openMenu(clientX, clientY, i === undefined ? undefined : this.sliceItems(this.layers[i]));
	}
	// a slice of the array texture: the sheet itself, with its outline
	drawSheet(i: number, at: Placement) {
		const {x: u, y: v} = at.sheet.extent();
		// (the planes' own quad is centred on the origin, y up)
		const centred = at.matrix.matmul(float4x4(float4(1, 0, 0, 0), float4(0, 1, 0, 0), float4(0, 0, 1, 0), float4(u / 2, v / 2, 0, 1)));
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_2D_ARRAY, this.texture ?? null, 0);
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
		painter.draw();
		this.redraw();
	}

	// what can be done to a slice
	sliceItems(layer: Layer): CascadeItem[] {
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

	setSlices(order: Layer[]) {
		const was = this.layers, at = this.layer ? Math.max(0, was.indexOf(this.layer)) : 0;
		this.layers = order.slice();
		if (order.length === was.length) {
			this.layers.forEach((layer, i) => {
				if (layer !== was[i] && this.texture)
					canvas3d.updateTextureLayer(this.texture, i, layer.image as ImageData);
			});
		} else if (this.image) {
			const size = this.image.width * this.sliceHeight * 4, data = new Uint8ClampedArray(size * order.length);
			order.forEach((layer, i) => data.set(layer.image.data, i * size));
			this.image = new ImageData(data, this.image.width, this.sliceHeight * order.length);
			this.setTexture(canvas3d.create2DArrayTexture(this.image, order.length));
		}
		if (!this.layer || !order.includes(this.layer))
			this.layer = order[Math.min(at, order.length - 1)];
		painter.draw();
		this.redraw();
	}

	deleteSlice(layer: Layer) {
		if (this.layers.length < 2)
			return;
		const before = this.layers.slice(), after = before.filter(l => l !== layer);
		this.setSlices(after);
		painter.record('Delete Slice', () => this.setSlices(before), () => this.setSlices(after));
	}

	addSlices(items: Dropped[]) {
		const width = this.image!.width;
		const made = items.map((it): Layer => {
			const data = new Uint8ClampedArray(width * this.sliceHeight * 4);
			const w = Math.min(width, it.pixels.width), h = Math.min(this.sliceHeight, it.pixels.height);
			for (let y = 0; y < h; y++)
				data.set(it.pixels.data.subarray(y * it.pixels.width * 4, (y * it.pixels.width + w) * 4), y * width * 4);
			return {name: it.name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image: new ImageData(data, width, this.sliceHeight)};
		});
		const before = this.layers.slice(), after = [...before, ...made], last = made[made.length - 1];
		const redo = () => {
			this.setSlices(after);
			this.layer = last;
			painter.draw();
			this.redraw();
		};
		redo();
		painter.record('Add Slice', () => this.setSlices(before), redo);
	}

	// a slice moved to another place in the order, by index: it is one edit when it is dropped
	dragger(layer: Layer): Drag {
		let before: Layer[];
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
					painter.record('Move Slice', () => this.setSlices(before), () => this.setSlices(after));
			},
		};
	}

	constructor(atlas: ImageData, count: number, private program2DArray: ShaderProgram, private programPlanes: ShaderProgram) {
		super(atlas, count, {name: i => `Slice ${i}`, share: false});
		this.pan.width	= atlas.width;
		this.pan.height	= this.sliceHeight;
		this.setTexture(canvas3d.create2DArrayTexture(atlas, count));
	}
	static async create(atlas: ImageData, count: number) {
		return new ArrayMode(atlas, count, await shader('array2d'), await shader('planes'));
	}
	protected override uploadSlice(i: number, image: Pixels) {
		canvas3d.updateTextureLayer(this.texture!, i, image);
	}
	// (a slice is seen in the 2D view, by itself)
	protected override carriedMvp(i: number, matrix: float3x3) {
		return planeMvp(this.pictureMatrix(), matrix);
	}

	override redraw() {
		canvas3d.initViewport();
		if (this.fan?.active) {
			programBG.draw({u_viewport: [canvas.width, canvas.height]});
			this.fan.draw();
			return;
		}

		canvas3d.bindTexture(canvas3d.gl.TEXTURE_2D_ARRAY, this.texture ?? null);
		this.program2DArray.draw({
			u_texture:	0,
			u_size:		[this.image!.width, this.sliceHeight, this.sliceHeight],
			u_viewport:	[canvas.width, canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
			u_layer:	this.currentSlice(),
		});
		this.carried?.();
		painter.draw();
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image || this.fan?.active)
			return undefined;
		// the slice being shown
		const point = canvas3d.toCanvas(clientX, clientY);
		const x = Math.floor((point.x - this.pan.offset.x) / this.pan.scale), y = Math.floor((point.y - this.pan.offset.y) / this.pan.scale);
		if (x < 0 || y < 0 || x >= this.image.width || y >= this.sliceHeight)
			return undefined;
		const slice = this.currentSlice(), colour = getPixel(this.layers[slice].image, x, y);
		return colour && `Pixel ${x},${y},${slice} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		if (!this.image)
			return [];
		const area = this.sliceRect;
		return [
			chooser('Slice',
				() => this.layers,
				() => this.layer!,
				layer => this.choose(this.layers.indexOf(layer)), layer => `Slice ${this.layers.indexOf(layer)}`,
				layer => stripThumb(layer, area),
				layer => this.sliceItems(layer),
				layer => this.fan.highlight(layer && this.layers.indexOf(layer)),
				layer => reversed(this.dragger(layer), () => this.layers.length)
			),
			viewToggle(this, this.fan),
		];
	}

	// a slice's pixels, which are part of the atlas as well as of the array texture
	override changed(changed: Pixels, rect?: float2.extent) {
		const i = this.layers.findIndex(l => l.image === changed);
		if (this.texture && i >= 0)
			canvas3d.updateTextureLayer(this.texture, i, changed as ImageData, rect);
		this.redraw();
	}

	// (the whole picture is not turned, flipped or cropped: only a slice)
	override run(op: EditOp | LayerOp) {
		return !['flip', 'rotate', 'crop'].some(k => op.startsWith(k)) && super.run(op);
	}

	protected override async dropped(items: Dropped[]) {
		this.addSlices(items);
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
	flatten			= 0;						// 0 the cube, 1 unfolded flat; between as it goes
	flattenTarget	= 0;
	protected orbit:	CubeOrbit;
	private gizmo:		Gizmo;
	protected animation	= 0;					// the animation frame of the cube turning, or unfolding
	protected id		= 0;					// (an unfolding is superseded by a later one)

	constructor(image: ImageData, count: number, layers?: {name: (i: number) => string, share: boolean}) {
		super(image, count, layers);
		this.orbit = new CubeOrbit(canvas, {
			anchor:		(x, y) => this.rayHit(x, y) ?? this.orbit.along(x, y, float3(0, 0, 0), 2),
			size:		() => 2,
			redraw: 	() => this.redraw(),
			dragStart:	() => this.stop(),
			contextMenu: (x, y) => painter.openMenu(x, y),
			pointerDown: e => this.pointerDown(e),
			active:		() => this.turnable,
			home:		() => this.home(),
		}, (x, y) => this.rayHit(x, y));
		this.gizmo = new Gizmo(canvas, this.orbit.gizmoHooks());
		// the browser's context menu comes with the press or the release of the right button, whether it is a click or a
		// drag: while the cube is turned by the camera it is not to reach the tools, which the camera's hook brings up for a real click
		canvas.parentElement!.addEventListener('contextmenu', e => {
			if (this.orbit.live) {
				e.preventDefault();
				e.stopPropagation();
			}
		}, {capture: true, signal: this.orbit.signal});
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
		this.orbit.dispose();
		super.dispose();
	}

	// the faces can be drawn on in 3D and unfolded, but not while on the way between
	protected updatePainting() {
		painter.enabled(this.paintable && this.flatten === this.flattenTarget);
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
		const f = canvas.height / 2 * this.orbit.fovy;

		const depth			= 2 * f / (width * scale);
		const pixelDeltaX	= offset.x + centre.x * scale - canvas.width / 2;
		const pixelDeltaY	= canvas.height / 2 - (offset.y + centre.y * scale);

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
		return toggleItem('3D view', svgFace(stackIcon), () => this.flattenTarget === 0, on => {
			if (!on)
				this.pan.reset();	// as a 2D picture at its full size
			this.unfold(!on);
		});
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
			programBG.draw({u_viewport: [canvas.width, canvas.height]});
			gl.clearColor(0.06, 0.06, 0.06, 1);
			gl.clear(gl.DEPTH_BUFFER_BIT);
			this.drawSolid(matmulExt(o.projection(float3(0, 0, 0), canvas.width / canvas.height), o.toview()).flat());
		}
		this.carried?.();
		painter.draw();
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
		super(faces, 6, {name: i => CubeMode.faceNames[i], share: true});
		this.pan.width	= faces.width * 4;		// (the unfolded layout, four faces across and three down)
		this.pan.height	= faces.width * 3;
		this.orbit.environment = true;
		this.setTexture(canvas3d.createCubeTextureFromImage(faces));
	}
	static async create(faces: ImageData) {
		return new CubeMode(faces, await shader('cube', cubeGeometry), await shader('cube2d'));
	}
	protected override uploadSlice(i: number, image: Pixels) {
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
		const o = this.orbit, m = matmulExt(o.projection(float3(0, 0, 0), canvas.width / canvas.height), o.toview());
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
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_CUBE_MAP, this.texture ?? null);
		this.programCube2D.draw({
			u_texture:	0,
			u_size:		this.image!.width,
			u_viewport:	[canvas.width, canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
		});
	}
	protected drawSolid(mvp: number[]) {
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_CUBE_MAP, this.texture ?? null);
		this.programCube.draw({
			u_texture: 	0,
			u_size:    	this.image!.width,
			u_mvp:		mvp,
			u_flatten: 	this.flatten,
		});
	}

	// another face is the one chosen
	private faceChosen(face: number) {
		this.layer = this.layers[face];
		painter.draw();
	}

	// the cube turned (by the shortest way) until a face looks at the camera
	turnToFace(face: number) {
		this.face = face;
		this.faceChosen(face);
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
			this.faceChosen(face);
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
		const o = this.orbit, m = matmulExt(o.projection(float3(0, 0, 0), canvas.width / canvas.height), o.toview());
		const mvp = float4x4(m.x, m.y, m.z, m.w);
		const q = CubeMode.facePoint(this.face, p.x / this.image.width, p.y / this.image.width);
		const clip = mvp.mul(float4(q.x, q.y, q.z, 1));
		return float2((clip.x / clip.w + 1) / 2 * canvas.width, (1 - clip.y / clip.w) / 2 * canvas.height);
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
	// other turns the cube.
	override pointerDown(event: PointerEvent) {
		this.selectAt(event.clientX, event.clientY);
		// (a transform's handles can be off the face, which is where they are taken hold of)
		return (this.flatten === 1 || painter.transforming || this.faceAt(event.clientX, event.clientY) === this.face) && super.pointerDown(event);
	}

	override tooltip(clientX: number, clientY: number) {
		if (!this.image || this.flatten !== 0)
			return undefined;
		const point = this.rayHit(clientX, clientY);
		if (!point)
			return undefined;
		const uv = cubeDirectionToFaceUV(point);
		const x = clampDimension(uv.u, this.image.width), y = clampDimension(uv.v, this.image.width);
		const colour = getPixel(this.image, x, y + uv.face * this.image.width);
		return colour && `Cube ${CubeMode.faceNames[uv.face]} ${x},${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		if (!this.image)
			return [];
		const area = this.sliceRect;
		return [
			chooser('Face',
				() => [0, 1, 2, 3, 4, 5],
				() => this.face,
				face => this.turnToFace(face),
				i => `Face ${CubeMode.faceNames[i]}`,
				i => stripThumb(this.layers[i], area), () => undefined, () => {}, undefined, [], false
			),
			this.foldToggle()
		];
	}


	// a face's pixels, which are part of the atlas as well as of the cube texture
	override changed(changed: Pixels, rect?: float2.extent) {
		const i = this.layers.findIndex(l => l.image === changed);
		if (this.texture && i >= 0)
			canvas3d.updateCubeFace(this.texture, i, changed, rect);
		this.redraw();
	}


	// An image dropped on the cube: it is the face it was dropped on, or the one chosen if it was not dropped on one (or
	// the cube is unfolded)
	protected override async dropped(items: Dropped[], clientX: number, clientY: number) {
		const hit = this.flatten === 0 ? this.rayHit(clientX, clientY) : undefined;
		this.replaceFace(hit ? cubeDirectionToFaceUV(hit).face : this.face, items[0].pixels);
	}

	// a face made from a picture (stretched to fit it), as one edit
	private replaceFace(face: number, picture: ImageData) {
		if (!this.image)
			return;
		const atlas = this.image, width = atlas.width, size = width * width * 4;
		const from = createElement('canvas', {width: picture.width, height: picture.height});
		from.getContext('2d')!.putImageData(picture, 0, 0);
		const ctx = createElement('canvas', {width, height: width}).getContext('2d')!;
		ctx.drawImage(from, 0, 0, width, width);
		const after = ctx.getImageData(0, 0, width, width).data;
		const before = atlas.data.slice(face * size, (face + 1) * size);
		const set = (data: Uint8ClampedArray) => () => {
			atlas.data.set(data, face * size);
			this.setTexture(canvas3d.createCubeTextureFromImage(atlas));
			this.redraw();
		};
		set(after)();
		this.face = face;
		this.faceChosen(face);
		painter.record(`Set Face ${CubeMode.faceNames[face]}`, set(before), set(after));
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
		this.setTexture(canvas3d.create3DTextureFromImage(volume, depth));
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
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_3D, this.texture ?? null);
		this.program3D2D.draw({
			u_texture:	0,
			u_size:		[this.image!.width, this.sliceHeight, this.count],
			u_viewport:	[canvas.width, canvas.height],
			u_scale:	this.pan.scale,
			u_offset:	[this.pan.offset.x, this.pan.offset.y],
		});
	}
	protected drawSolid(mvp: number[]) {
		const o = this.orbit;
		canvas3d.bindTexture(canvas3d.gl.TEXTURE_3D, this.texture ?? null);
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
		const colour = getPixel(this.image, x, y + z * this.sliceHeight);
		return colour && `Pixel ${x},${y},${z} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`;
	}

	override menu() {
		return [this.foldToggle()];
	}
}

//-----------------------------------------------------------------------------
// 
//-----------------------------------------------------------------------------

const emptyMode		= new EmptyMode;
let mode: Mode		= emptyMode;

function newLayer(name: string, image: Pixels): Layer {
	return {name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image};
}

// the tools, which work on whichever mode is current
const painter: Painter = new Painter(emptyMode, $('overlay'));

// another mode is the current one
function enter(next: Mode) {
	tooltip.hide();
	mode.dispose();
	mode = next;
	painter.host = next;
	painter.enabled(true);	// (and one that cannot be drawn on)
	next.activate();
}

// A new picture, in a mode made for it, replaces the one there is (and what was done to that: it is not undone)
async function load(made: Promise<Mode>) {
	const next = await made;
	painter.reset();
	enter(next);
	next.fit();
	next.redraw();
}

// the layers as the page has them, from a file's
function layersOfData(layers: LayerData[]): Layer[] {
	return layers.map(data => ({
		name: data.name, left: data.left, top: data.top, opacity: data.opacity, visible: data.visible, blend: data.blend, clipped: data.clipped,
		image: {data: new Uint8ClampedArray(data.data), width: data.width, height: data.height},
		mask: data.mask && {
			left: data.mask.left, top: data.mask.top, default: data.mask.default, disabled: data.mask.disabled, inverted: data.mask.inverted,
			image: {data: new Uint8ClampedArray(data.mask.data), width: data.mask.width, height: data.mask.height},
		},
	}));
}

// the fan has come up, or gone away: the tools cannot be used in 3D, and what is drawn over the picture is not part of it
function fanOpened(open: boolean) {
	painter.enabled(!open);
	if (open)
		tooltip.hide();
	else
		painter.draw();
}
const fanTip = (text: string | undefined, x: number, y: number) => text === undefined ? tooltip.hide() : tooltip.show(text, x + 12, y + 12);

//-----------------------------------------------------------------------------
// transforming
//-----------------------------------------------------------------------------

// warp, on the GPU unless it cannot take the image
const warpPixels = (image: Pixels, m: float3x3, area: float2.extent, channels = 4, outside = 0) =>
	warp(canvas3d, programWarp, image, m, area, channels, outside);

//-----------------------------------------------------------------------------
//
//-----------------------------------------------------------------------------

canvas.addEventListener('wheel', event => event.preventDefault(), {passive: false});

function convertImage(image: Pixels) {
	return new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height);
}

//-----------------------------------------------------------------------------
// tooltip
//-----------------------------------------------------------------------------

canvas.addEventListener('pointermove', event => {
	const text = mode.tooltip(event.clientX, event.clientY);
	if (text) {
		tooltip.show(text, event.clientX + 12, event.clientY + 12);
		return;
	}
	tooltip.hide();
});

canvas.addEventListener('pointerleave', () => {
	tooltip.hide();
});

//-----------------------------------------------------------------------------
// interaction
//-----------------------------------------------------------------------------

function resizeCanvas() {
	canvas3d.resize();
	painter.resize();

	mode.resized();
}

// the canvas changes size with the window, and with the tool bars of the editor coming and going or wrapping
new ResizeObserver(() => {
	resizeCanvas();
	mode.redraw();
}).observe(canvas);

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
				await load(LayeredMode.create(convertImage(message.image), layersOfData(message.layers)));
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
			painter.undo();
			break;

		case 'redo':
			painter.redo();
			break;

		case 'fitToWindow':
			mode.fit();
			mode.redraw();
			break;

		//RPC cases
		case 'getImage': {
			const image = mode.picture();
			if (image)
				sendResult(message.requestId, { pixels: image.data, width: image.width, height: image.height });
			else
				sendResult(message.requestId);
			break;
		}

		case 'getTexture': {
			const image = mode.picture();
			if (image) {
				if (message.type === 'image/x-rgba') {
					sendResult(message.requestId, mode.raw());
					break;

				} else {
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
	}

});

(async () => {
	programBG		= await shader('bg');
	programWarp		= await shader('warp');
	programLayer	= await shader('layer');
	blank			= canvas3d.createTextureFromImage({data: new Uint8ClampedArray(4), width: 1, height: 1});
	resizeCanvas();
	postMessage({command: 'ready'});
})();