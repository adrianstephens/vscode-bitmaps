import { Tooltip, vscode, RPC, handleResult, sendResult, RpcMessage } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, rectGeometry, cubeGeometry, bitmapToImage, getImageData, getPixel } from './opengl.js';
import { float3, float3x3, float3x4, float4x4, normalise, lerp, orthonormalise } from '@isopodlabs/maths/vector';
import { unitQuaternion } from '@isopodlabs/maths/quaternion';
import { Painter, EditOp, DocumentChange, HistoryEntry } from './paint.js';
import { LayerStack, LayerData, Snapshot, fromData, expand, exportLayer, flipLayers, rotateLayers, cropLayers } from './layers.js';
import { LayerOps, LayerOp } from './layerops.js';
import { LayerFan } from './layerfan.js';
import { LayerCompositor } from './gpulayers.js';
import { Rect, flip, rotate, crop } from './edit.js';
export type { EditOp, LayerOp, LayerData };

interface ImageData0 {
	pixels: ArrayLike<number>;
	width: number;
	height: number;
}

// the type getTexture is given to get the pixels themselves
export const RAW_IMAGE = 'image/x-rgba';
export interface RawImage {
	width:	number;
	height:	number;
	pixels:	ArrayBuffer;	// 8 bits a channel, rgba, the first row on top, not premultiplied
	// a picture of layers has them too, bottom first, each cut down to what is not transparent; `pixels` is then what they make
	layers?: (Omit<LayerData, 'pixels' | 'mask'> & {pixels: ArrayBuffer, mask?: Omit<NonNullable<LayerData['mask']>, 'pixels'> & {pixels: ArrayBuffer}})[];
}

export type shaderType = 'bg'|'2d'|'array2d'|'3d'|'3d2d'|'cube'|'cube2d'|'layer'|'composite';
export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders', type: shaderType, requestId: number}//result: {vert: string, frag: string}};
	| {command: 'edited', label: string};	// the image has been changed, undoably

export type MessageIn =
	| {command: 'load2d', image: ImageData0, layers?: LayerData[]}	// layers, bottom first, over the canvas the image is the size of
	| {command: 'load2dArray', image: ImageData0, layers: number}
	| {command: 'loadCube', image: ImageData0}
	| {command: 'load3d', image: ImageData0, depth: number}
	| {command: 'loadTexture', data: ArrayBuffer, mimeType: string}
	| {command: 'imageOp', op: EditOp | LayerOp}	// do a whole-image editing operation, or one to the layers
	| {command: 'undo'}
	| {command: 'redo'}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'};

export type MessageRpc =
	| {command: 'getImage', result: ImageData0}
	// The image as a file of the given type, which a canvas can write (PNG, JPEG); or, for RAW_IMAGE, its raw pixels,
	// for the extension to write as whatever else it likes
	| {command: 'getTexture', type: string, result: ArrayBuffer | RawImage}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas: HTMLCanvasElement	= $('viewport');
const canvas3d	= new Canvas3D(canvas, {onError: message => postMessage({command: 'error', message})});

const layerSlider: HTMLInputElement	= $('layer-slider');
const layerLabel: HTMLSpanElement	= $('layer-label');

layerSlider.addEventListener('input', () => {
	currentLayer = Number(layerSlider.value);
	layerLabel.textContent = `${currentLayer} / ${layerSlider.max}`;
	render();
});

let texture:	WebGLTexture|null = null;
let image:		ImageData|null= null;
let atlasWidth	= 0;
let atlasHeight = 0;
let animation	= 0;

let programBG:		ShaderProgram;
let programLayer:	ShaderProgram | undefined;
let programComposite: ShaderProgram | undefined;
let program2D:		ShaderProgram;
let program2DArray:	ShaderProgram;
let programCube:	ShaderProgram;
let programCube2D:	ShaderProgram;
let program3D:		ShaderProgram;
let program3D2D:	ShaderProgram;

const tooltip = new Tooltip();

// editing, which is only possible with a plain 2D image
let stack: LayerStack | null = null;	// the layers of a picture which has them; `image` is then only its size, as the picture is on the GPU
let compositor: LayerCompositor | undefined;	// which has the layers as textures, and makes the picture of them

// The colour of a pixel of the picture. With layers it is read from where it is made.
function pixelAt(x: number, y: number) {
	if (!image || x < 0 || y < 0 || x >= image.width || y >= image.height)
		return undefined;
	if (!stack || !compositor)
		return getPixel(image, x, y);
	const d = compositor.read({x, y, w: 1, h: 1});
	return {r: d[0], g: d[1], b: d[2], a: d[3]};
}

// The picture as pixels, all of them (with layers they are read back first)
function pictureImage() {
	if (image && stack && compositor)
		image.data.set(compositor.read({x: 0, y: 0, w: image.width, h: image.height}));
	return image;
}

const painter = new Painter({
	canvas,
	image:		() => mode !== '2d' ? null : stack ? stack.layer.image : image,
	pick:		(x, y) => mode === '2d' ? pixelAt(x, y) : undefined,
	view:	() => ({scale, offset}),
	toImage(clientX, clientY) {
		const point = canvas3d.toCanvas(clientX, clientY);
		return {x: (point.x - offset.x) / scale, y: (point.y - offset.y) / scale};
	},
	changed(changed, rect) {
		if (stack) {
			// a layer's pixels, which may lie anywhere on the canvas
			const layer = stack.layers.find(l => l.image === changed);
			if (layer)
				compositor?.upload(layer, rect);
			recompose(layer && rect ? {x: rect.x + layer.left, y: rect.y + layer.top, w: rect.w, h: rect.h} : undefined);
		} else {
			if (texture && image)
				canvas3d.updateTexture(texture, image, rect);
			render();
		}
	},
	transform: transformDocument,
	edited:	label => postMessage({command: 'edited', label}),
	panelOpened: () => tooltip.hide(),
}, $('paint-options'), $('overlay'));

const layerOps = new LayerOps({
	stack:		() => stack,
	record:		(label, undo, redo) => painter.record(label, undo, redo),
	changed:	() => recompose(),
});

// the layers, fanned out at the right edge
const fan = new LayerFan({
	canvas3d, canvas,
	stage:		$('bitmap-stage'),
	stack:		() => stack,
	view:		() => ({scale, offset}),
	programs:	() => programLayer && {background: programBG, layer: programLayer},
	layerTexture: layer => compositor?.layerTexture(layer),
	render:		() => render(),
	opened(open) {
		// what is drawn over the picture is not part of the fan
		$('overlay').style.visibility = open ? 'hidden' : '';
		if (open)
			tooltip.hide();
		else
			painter.draw();
	},
}, layerOps);

// the picture again from the layers (all of it, or a part), and what shows of it
function recompose(rect?: Rect) {
	if (!stack || !compositor)
		return;
	compositor.compose(stack.width, stack.height, stack.layers, rect);
	texture = compositor.texture ?? null;
	render();
}

// a new picture, perhaps of another size, shown from the start
function showImage(newImage: ImageData) {
	image		= newImage;
	atlasWidth	= image.width;
	atlasHeight	= image.height;
	setTexture(canvas3d.createTextureFromImage(image));
	fitView();
	render();
}

// Flip, rotate or crop all of the document. The layers go with it, each as it lies on the canvas (so a crop leaves
// a layer's pixels outside it, to come back with an undo).
function transformDocument(change: DocumentChange): HistoryEntry | undefined {
	if (stack) {
		const layers = stack;
		const before = layers.snapshot();
		const after: Snapshot = change.kind === 'flip' ? flipLayers(before, change.horizontal)
			: change.kind === 'rotate' ? rotateLayers(before, change.clockwise)
			: cropLayers(before, change.rect);
		const use = (s: Snapshot) => () => {
			layers.restore(s);
			expand(layers.layer, layers.width, layers.height);	// what the tools draw on covers the canvas
			fan.reset();
			image		= new ImageData(layers.width, layers.height);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			recompose();
			fitView();
			render();
		};
		use(after)();
		return {undo: use(before), redo: use(after)};
	}

	if (!image)
		return;
	const before = image;
	const r = change.kind === 'flip' ? flip(before, change.horizontal)
		: change.kind === 'rotate' ? rotate(before, change.clockwise)
		: crop(before, change.rect);
	const after = new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
	showImage(after);
	return {undo: () => showImage(before), redo: () => showImage(after)};
}

let mode		= '';
let currentLayer = 0;
let scale       = 1;
let offset    	= {x: 0, y: 0};
let view: float3x4 = float3x4(float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, 1), float3(0, 0, -3));
let flatten		= 0;
let sliceHeight	= 0;
const fovy0 = 1 / Math.tan(Math.PI / 6);
let fovy = fovy0;

function convertImage(image: ImageData0) {
	return new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height);
}

function postMessage(message: MessageOut) {
	vscode.postMessage(message);
}

function cubePointNormal({x, y, z} : float3) {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);

    return ax >= ay && ax >= az
        ? float3(Math.sign(x), 0, 0)
        : ay >= ax && ay >= az
		? float3(0, Math.sign(y), 0)
		: float3(0, 0, Math.sign(z));
}

function intersectRayCube(origin: float3, dir: float3) {
	const tx1 = (-1 - origin.x) / dir.x;
	const tx2 = ( 1 - origin.x) / dir.x;
	const tminx = Math.min(tx1, tx2);
	const tmaxx = Math.max(tx1, tx2);

	const ty1 = (-1 - origin.y) / dir.y;
	const ty2 = ( 1 - origin.y) / dir.y;
	const tminy = Math.min(ty1, ty2);
	const tmaxy = Math.max(ty1, ty2);

	const tz1 = (-1 - origin.z) / dir.z;
	const tz2 = ( 1 - origin.z) / dir.z;
	const tminz = Math.min(tz1, tz2);
	const tmaxz = Math.max(tz1, tz2);

	const tmin = Math.max(tminx, tminy, tminz);
	const tmax = Math.min(tmaxx, tmaxy, tmaxz);
	return tmax >= 0 && tmin <= tmax
		? float3(origin.x + dir.x * tmin, origin.y + dir.y * tmin, origin.z + dir.z * tmin)
		: undefined;
}

function cubeDirectionToFaceUV({x, y, z}: float3) {
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

function render() {
	if (!texture || !image)
		return;

	canvas3d.initViewport();
	const gl = canvas3d.gl;

	switch (mode) {
		case '2d':
			if (fan.active) {
				fan.draw();
				break;
			}
			if (program2D) {
				canvas3d.bindTexture(gl.TEXTURE_2D, texture);
				program2D.draw({
					u_texture: 	0,
					u_size:    	[image.width, image.height],
					u_viewport:	[canvas.width, canvas.height],
					u_scale:   	scale,
					u_offset:  	[offset.x, offset.y],
				});
			}
			painter.draw();
			break;

		case '2d-array':
			if (program2DArray) {
				canvas3d.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
				program2DArray.draw({
					u_texture:	0,
					u_size:		[image.width, sliceHeight, sliceHeight],
					u_viewport:	[canvas.width, canvas.height],
					u_scale:	scale,
					u_offset:	[offset.x, offset.y],
					u_layer:	currentLayer,
				});
			}
			break;

		case 'cube': {
			if (flatten === 1) {
				canvas3d.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
				programCube2D.draw({
					u_texture:  0,
					u_size:     image.width,
					u_viewport: [canvas.width, canvas.height],
					u_scale:    scale,
					u_offset:   [offset.x, offset.y],
				});
				return;
			}

			programBG.draw({u_viewport: [canvas.width, canvas.height]});

			gl.clearColor(0.06, 0.06, 0.06, 1);
			gl.clear(gl.DEPTH_BUFFER_BIT);

			const projection	= float4x4.perspective(fovy, canvas.width / canvas.height, 0.1, 100.0);
			const mvp			= projection.matmul(view.to4x4()).flat();
			canvas3d.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
			programCube.draw({
				u_texture: 	0,
				u_size:    	image.width,
				u_mvp:		mvp,
				u_flatten: 	flatten,
			});
			break;
		}
		case '3d': {
			if (flatten === 1) {
				canvas3d.bindTexture(gl.TEXTURE_3D, texture);
				program3D2D.draw({
					u_texture: 	0,
					u_size:    	[image.width, sliceHeight, image.height / sliceHeight],
					u_viewport: [canvas.width, canvas.height],
					u_scale:   	scale,
					u_offset:  	[offset.x, offset.y],
				});
				return;
			}

			programBG.draw({u_viewport: [canvas.width, canvas.height]});

			gl.clearColor(0.06, 0.06, 0.06, 1);
			gl.clear(gl.DEPTH_BUFFER_BIT);

			const projection	= float4x4.perspective(fovy, canvas.width / canvas.height, 0.1, 100.0);
			const iview			= view.inverse();
			const mvp			= projection.matmul(view.to4x4()).flat();

			canvas3d.bindTexture(gl.TEXTURE_3D, texture);
			program3D.draw({
				u_texture: 	0,
				u_mvp:		mvp,
				u_origin:	iview.w._values,
				u_opacity:	1.0,
				u_size:    	image.width,
				u_light:	iview.z._values, // direction towards the light: a headlight, from the camera
				u_flatten: 	flatten,
			});
			break;
		}
	}
}

// Orientation in which the unfolded layout is seen face on, matching the 2D view.
// A volume unfolds with slice 0 at the top and image rows running down the screen, so it faces the camera
// with a half turn about x (slice 0 in front, image upright); the cube unfolds around its +Z face.
function homeRotation() {
	return mode === '3d'
		? float3x3(float3(1, 0, 0), float3(0, -1, 0), float3(0, 0, -1))
		: float3x3.identity();
}

function fitView() {
	if ((mode === 'cube' || mode === '3d') && flatten === 0) {
		const home = homeRotation();
		view = float3x4(home.x, home.y, home.z, float3(0, 0, -3));
	} else if (image) {
		scale	= Math.min(16, Math.min(canvas.width / atlasWidth, canvas.height / atlasHeight));
		offset	= {x: (canvas.width - atlasWidth * scale) / 2, y: (canvas.height - atlasHeight * scale) / 2};
	}
}

function pointerToCube(clientX: number, clientY: number, fovy: number) {
	const dir = canvas3d.rayDirection(clientX, clientY, fovy);
	const inv = view.inverse();
	return intersectRayCube(inv.w, inv.mulDir(dir));
}

//-----------------------------------------------------------------------------
// tooltip
//-----------------------------------------------------------------------------

function clampDimension(x: number, size: number) {
	return Math.min(size - 1, Math.max(0, Math.floor(x * size)));
}

const cubeFaceNames = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

canvas.addEventListener('pointermove', event => {
	if (image) switch (mode) {
		case '2d': {
			const point = canvas3d.toCanvas(event.clientX, event.clientY);
			const x = Math.floor((point.x - offset.x) / scale);
			const y = Math.floor((point.y - offset.y) / scale);
			const colour = pixelAt(x, y);
			if (colour) {
				tooltip.show(`Pixel ${x}, ${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
				return;
			}
			break;
		}
		case 'cube': {
			const point = pointerToCube(event.clientX, event.clientY, fovy);
			if (point) {
				const faceUv = cubeDirectionToFaceUV(point);
				const x = clampDimension(faceUv.u, image.width);
				const y = clampDimension(faceUv.v, sliceHeight);
				const colour = getPixel(image, x, y + faceUv.face * sliceHeight);
				if (colour) {
					tooltip.show(`Cube ${cubeFaceNames[faceUv.face]} ${x},${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
					return;
				}
			}
			break;
		}
		case '3d': {
			const point = pointerToCube(event.clientX, event.clientY, fovy);
			if (point) {
				const x = clampDimension(point.x, image.width);
				const y = clampDimension(point.y, sliceHeight);
				const z = clampDimension(point.z, image.height / sliceHeight);
				const colour = getPixel(image, x, y + z * sliceHeight);
				if (colour) {
					tooltip.show(`Pixel ${x},${y},${z} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
					return;
				}
			}
			break;
		}
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

	scale	= clampScale(scale);
	offset	= clampOffset(offset.x, offset.y);
}

// the canvas changes size with the window, and with the tool bars of the editor coming and going or wrapping
new ResizeObserver(() => {
	resizeCanvas();
	render();
}).observe(canvas);

function clampScale(scale: number) {
	const minScale = Math.min(canvas.width / atlasWidth, canvas.height / atlasHeight);
	return Math.min(256, Math.max(minScale, scale));
}

// 1:1, centred - but never below the minimum (fit to window) that zooming allows, or the first wheel tick would jump
function resetScale() {
	scale	= clampScale(1);
	offset	= {x: (canvas.width - atlasWidth * scale) / 2, y: (canvas.height - atlasHeight * scale) / 2};
}

function clampOffset(x: number, y: number) {
	if (!image)
		return {x, y};
	const imageWidthPx	= atlasWidth * scale;
	const imageHeightPx = atlasHeight * scale;
	const minX = Math.min(0, canvas.width - imageWidthPx);
	const maxX = Math.max(0, canvas.width - imageWidthPx);
	const minY = Math.min(0, canvas.height - imageHeightPx);
	const maxY = Math.max(0, canvas.height - imageHeightPx);
	return {
		x: Math.min(maxX, Math.max(minX, x)),
		y: Math.min(maxY, Math.max(minY, y))
	};
}

canvas.addEventListener('pointerdown', event => {
	if (mode === '2d') {
		if (fan.pointerDown(event) || painter.pointerDown(event))
			return;
		// a right click (or control-click) opens the context menu, which takes the button's release with it: a drag begun
		// here would never end
		if (event.button === 2 || (event.button === 0 && event.ctrlKey && navigator.platform.toLowerCase().includes('mac')))
			return;
	}
	canvas.setPointerCapture(event.pointerId);
	let onMove: (event: PointerEvent) => void;

	if (flatten === 0 && (mode === 'cube' || mode === '3d')) {
		let prevX = event.clientX;
		let prevY = event.clientY;

		let point = view.w.z < -2 ? pointerToCube(event.clientX, event.clientY, fovy) : undefined;

		onMove = (event: PointerEvent) => {
			if (point) {
				const targetDir = canvas3d.rayDirection(event.clientX, event.clientY, fovy);
				const currentDir = normalise(view.mulPos(point));

				const d = currentDir.dot(targetDir);
				if (Math.abs(d - 1) < 1e-6)
					return; // already aligned

				if (targetDir.dot(view.mulDir(cubePointNormal(point))) < 0) {
					let axis = targetDir.cross(currentDir);
					if (axis.len() < 1e-6) {
						// 180° case: choose any orthogonal axis
						axis = Math.hypot(currentDir.z, currentDir.y) < 1e-6
							? float3(-currentDir.z, 0, currentDir.x)
							: float3(0, currentDir.z, -currentDir.y);
					}

					const r = float3.rotate(normalise(axis), Math.acos(d));
					view.x = r.mul(view.x);
					view.y = r.mul(view.y);
				}

			} else {
				const dx = (event.clientX - prevX) * 0.01;
				const dy = (event.clientY - prevY) * 0.01;

				// about the screen's up axis, then its right axis
				const r = float3.rotateX(dy).matmul(float3.rotateY(dx));
				view.x = r.mul(view.x);
				view.y = r.mul(view.y);
			}

			orthonormalise(view);
			render();
			prevX = event.clientX;
			prevY = event.clientY;
		};

	} else if (flatten === 1 || mode === '2d') {
		const startPoint = canvas3d.toCanvas(event.clientX, event.clientY);
		const startOffset = offset;

		onMove = (event: PointerEvent) => {
			const current = canvas3d.toCanvas(event.clientX, event.clientY);
			offset = clampOffset(startOffset.x + (current.x - startPoint.x), startOffset.y + (current.y - startPoint.y));
			render();
		};
	} else {
		return; // no interaction while transitioning
	}

	const onUp = () => {
		canvas.removeEventListener('pointermove', onMove);
		canvas.removeEventListener('pointerup', onUp);
		canvas.removeEventListener('pointercancel', onUp);
		canvas.removeEventListener('lostpointercapture', onUp);
	};

	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
	canvas.addEventListener('lostpointercapture', onUp);
});

canvas.addEventListener('wheel', event => {
	event.preventDefault();
	const delta = 1.01 ** -event.deltaY;// < 0 ? 1.15 : 0.87;

	if ((mode === 'cube' || mode === '3d') && flatten === 0) {
		//view.w.z = Math.max(-10, Math.min(-1.5, view.w.z / delta));
		view.w.z = view.w.z / delta;
		if (mode === 'cube' && view.w.z > -1.5) {
			fovy *= delta;
			if (delta > 1)
				view.w.z = 0;
			else if (fovy < fovy0)
				view.w.z = -1.5;
		}

	} else {
		const centre = canvas3d.toCanvas(event.clientX, event.clientY);
		const scale0 = scale;
		scale	= clampScale(scale * delta);
		offset	= clampOffset(centre.x - (centre.x - offset.x) / scale0 * scale, centre.y - (centre.y - offset.y) / scale0 * scale);
	}

	render();
});



async function init2d() {
	if (!program2D) {
		const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '2d'});
		program2D = canvas3d.createProgram(shaders, rectGeometry);
	}
}

function setTexture(newTexture: WebGLTexture) {
	if (texture)
		canvas3d.deleteTexture(texture);
	texture = newTexture;
}

//-----------------------------------------------------------------------------
// folding
//-----------------------------------------------------------------------------

// Camera position (with the home rotation) at which the unfolded layout lands exactly where the 2D view draws it
// (at the current scale and offset), so the switch between them is seamless.
// The unfolded layout is the plane z=planeZ, 2 world units across `width` atlas texels, with atlas point `centre` on the axis
function flatPosition(fovy: number, centre: {x: number, y: number}, width: number, planeZ: number) {
	const f = canvas.height / 2 * fovy;

	const widthPx		= width * scale;
	const depth			= 2 * f / widthPx;
	const pixelDeltaX	= offset.x + centre.x * scale - canvas.width / 2;
	const pixelDeltaY	= canvas.height / 2 - (offset.y + centre.y * scale);

	return float3(pixelDeltaX * depth / f, pixelDeltaY * depth / f, -depth - homeRotation().z.z * planeZ);
}

function unfoldedPosition() {
	return mode === '3d'
		? flatPosition(fovy, {x: atlasWidth / 2, y: atlasHeight / 2}, image!.width, 0)
		: flatPosition(fovy, {x: image!.width * 1.5, y: image!.width * 1.5}, image!.width, 1);
}


// Animate between the 3D view (target 0) and the unfolded 2D layout (target 1).
// The unfolding itself is done by the shaders (u_flatten); this moves the camera so the layout ends up matching the 2D view.
function animateFlatten(target: number, cameraTarget: float3) {
	const id		= ++animation;
	const flatten0	= flatten;
	const start		= unitQuaternion.from3x3(float3x3(view.x, view.y, view.z));
	const end		= unitQuaternion.from3x3(homeRotation());
	const w0		= view.w;
	const startTime	= performance.now();

	function step(now: number) {
		if (id !== animation)
			return;	// superseded

		const t		= Math.min(1, (now - startTime) / 300);
		const s		= t * t * (3 - 2 * t);
		flatten		= t === 1 ? target : flatten0 + (target - flatten0) * s;

		const basis	= unitQuaternion.slerp(start, end, s).to3x3();
		view.x		= basis.x;
		view.y		= basis.y;
		view.z		= basis.z;
		view.w		= lerp(w0, cameraTarget, s);
		render();
		if (t < 1)
			requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}

//-----------------------------------------------------------------------------
// messages
//-----------------------------------------------------------------------------

window.addEventListener('message', async event => {
	if (handleResult(event.data))
		return;

	const message = event.data as MessageIn | RpcMessage<MessageRpc>;
	if (message.command.startsWith('load')) {
		tooltip.hide();
		stack = null;
		fan.reset();
		compositor?.release();
		compositor = undefined;
		texture = null;
	}

	switch (message.command) {
		case 'loadTexture': {
			await init2d();
			const bitmap = await createImageBitmap(new Blob([message.data], {type: message.mimeType}));
			image	= bitmapToImage(bitmap);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			setTexture(canvas3d.createTextureFromImage(image));
			mode	= '2d';
			painter.reset();
			painter.enabled(true);
			fitView();
			render();
			break;
		}
		case 'load2d':
			await init2d();
			image	= convertImage(message.image);
			if (message.layers?.length) {
				stack = new LayerStack(image.width, image.height, message.layers.map(fromData));
				expand(stack.layer, stack.width, stack.height);
				programLayer		??= canvas3d.createProgram(await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'layer'}), rectGeometry);
				programComposite	??= canvas3d.createProgram(await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'composite'}), rectGeometry);
				compositor = new LayerCompositor(canvas3d, programComposite);
				compositor.compose(stack.width, stack.height, stack.layers);
				texture = compositor.texture ?? null;
			}
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			if (!stack)
				setTexture(canvas3d.createTextureFromImage(image));
			mode	= '2d';
			$('layer-control').classList.add('hidden');
			painter.reset();
			painter.enabled(true);
			fitView();
			render();
			break;

		case 'load2dArray': {
			if (!program2DArray) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'array2d'});
				program2DArray = canvas3d.createProgram(shaders, rectGeometry);
			}
			image		= convertImage(message.image);
			sliceHeight	= image.height / message.layers;
			atlasWidth	= image.width;
			atlasHeight	= sliceHeight;
			setTexture(canvas3d.create2DArrayTexture(image, message.layers));
			mode		= '2d-array';
			painter.enabled(false);
			currentLayer = 0;
			layerSlider.max = String(message.layers - 1);
			layerSlider.value = '0';
			layerLabel.textContent = `0 / ${message.layers - 1}`;
			$('layer-control').classList.remove('hidden');
			fitView();
			render();
			break;
		}

		case 'loadCube':
			if (!programCube) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'cube'});
				programCube = canvas3d.createProgram(shaders, cubeGeometry);
				const shaders2d = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'cube2d'});
				programCube2D = canvas3d.createProgram(shaders2d, rectGeometry);
			}
			image		= convertImage(message.image);
			atlasWidth	= image.width * 4;
			atlasHeight	= image.height / 6 * 3;
			sliceHeight	= image.height / 6;
			setTexture(canvas3d.createCubeTextureFromImage(image));
			mode	= 'cube';
			painter.enabled(false);
			fitView();
			render();
			break;

		case 'load3d':
			if (!program3D) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '3d'});
				program3D = canvas3d.createProgram(shaders, cubeGeometry);
				const shaders2d = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '3d2d'});
				program3D2D = canvas3d.createProgram(shaders2d, rectGeometry);
			}
			image		= convertImage(message.image);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			sliceHeight	= image.height / message.depth;
			setTexture(canvas3d.create3DTextureFromImage(image, message.depth));
			mode	= '3d';
			painter.enabled(false);
			fitView();
			render();
			break;

		case 'imageOp':
			if (message.op === 'newLayer' || message.op === 'deleteLayer' || message.op === 'raiseLayer' || message.op === 'lowerLayer')
				layerOps.run(message.op);
			else
				painter.run(message.op);
			break;

		case 'undo':
			painter.undo();
			break;

		case 'redo':
			painter.redo();
			break;

		case 'fitToWindow':
			fitView();
			render();
			break;

		case 'resetZoom':
			if (mode === 'cube' || mode === '3d') {
				if (flatten > 0) {
					// back to 3D: start from the 2D view as it is now
					if (flatten === 1)
						view.w = unfoldedPosition();
					animateFlatten(0, float3(0, 0, -3));

				} else {
					resetScale();
					animateFlatten(1, unfoldedPosition());
				}

			} else {
				resetScale();
				render();
			}
			break;

		//RPC cases
		case 'getImage':
			if (pictureImage())
				sendResult(message.requestId, { pixels: image!.data, width: image!.width, height: image!.height });
			else
				sendResult(message.requestId);
			break;

		case 'getTexture':
			if (pictureImage() && message.type === RAW_IMAGE) {
				const raw: RawImage = {width: image!.width, height: image!.height, pixels: image!.data.slice().buffer};
				if (stack) {
					raw.layers = stack.layers.map(layer => {
						const {pixels, mask, ...data} = exportLayer(layer);
						return {
							...data,
							pixels:	(pixels as Uint8ClampedArray).slice().buffer,
							mask:	mask && {...mask, pixels: (mask.pixels as Uint8ClampedArray).slice().buffer},
						};
					});
				}
				sendResult(message.requestId, raw);
			} else if (image) {
				getImageData(pictureImage()!, message.type)?.then(async blob => {
					if (blob)
						sendResult(message.requestId, await blob.arrayBuffer());
					else
						sendResult(message.requestId);
				});
			} else {
				sendResult(message.requestId);
			}
			break;
	}

});

RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'bg'}).then(shaders => {
	programBG = canvas3d.createProgram(shaders, rectGeometry);

	resizeCanvas();

	postMessage({command: 'ready'});
});