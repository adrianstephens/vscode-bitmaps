// Layers for the bitmap editor: the stack of them, their blend modes, and how the whole-document operations (flip,
// rotate, crop) move them. The pixel work is plain, and tested outside a webview. Making the picture of them is on the GPU,
// in gpulayers.ts.

import { Pixels, Rect, flip, rotate, crop } from './edit.js';

// A layer's mask: it hides the layer where it is dark. Its pixels are one byte each, over a rectangle which need not be the
// layer's, outside which it is `defaultColor`.
export interface LayerMask {
	left:			number;
	top:			number;
	image:			Pixels;		// one byte a pixel, in `data`
	defaultColor:	number;		// 0..255
	disabled:		boolean;
	inverted:		boolean;
}

export interface Layer {
	name:		string;
	left:		number;		// where its pixels lie on the canvas; they may spill over its edges
	top:		number;
	opacity:	number;		// 0..1
	visible:	boolean;
	blend:		string;		// the file's blend mode: a key of BLEND_MODES, or any other, which is normal
	image:		Pixels;		// 8-bit rgba, not premultiplied
	mask?:		LayerMask;
	clipped?:	boolean;	// clipped to the layer below: shown only where that layer (and the others clipped to it) are, and blended with them
}

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
	pixels:		ArrayLike<number>;
	clipped?:	boolean;
	mask?:		{left: number, top: number, width: number, height: number, defaultColor: number, disabled: boolean, inverted: boolean, pixels: ArrayLike<number>};
}

export interface Snapshot {
	width:		number;
	height:		number;
	layers:		Layer[];
	current:	number;
}

export class LayerStack implements Snapshot {
	constructor(public width: number, public height: number, public layers: Layer[], public current = layers.length - 1) {}

	get layer() {
		return this.layers[this.current];
	}

	snapshot(): Snapshot {
		return {width: this.width, height: this.height, layers: this.layers.slice(), current: this.current};
	}

	restore(s: Snapshot) {
		this.width	= s.width;
		this.height	= s.height;
		this.layers	= s.layers.slice();
		this.current = s.current;
	}
}

export function fromData(data: LayerData): Layer {
	const m = data.mask;
	return {
		name: data.name, left: data.left, top: data.top, opacity: data.opacity, visible: data.visible, blend: data.blend, clipped: data.clipped,
		image: {data: new Uint8ClampedArray(data.pixels as ArrayLike<number>), width: data.width, height: data.height},
		mask: m && {
			left: m.left, top: m.top, defaultColor: m.defaultColor, disabled: m.disabled, inverted: m.inverted,
			image: {data: new Uint8ClampedArray(m.pixels as ArrayLike<number>), width: m.width, height: m.height},
		},
	};
}

export function blankLayer(width: number, height: number, name: string): Layer {
	return {name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image: {data: new Uint8ClampedArray(width * height * 4), width, height}};
}

// A layer's pixels over the whole canvas, which is what the tools draw on (anything outside the canvas is lost).
// It changes the layer itself, so that everything which holds the layer sees it.
export function expand(layer: Layer, width: number, height: number) {
	const old = layer.image;
	if (layer.left === 0 && layer.top === 0 && old.width === width && old.height === height)
		return;

	const data = new Uint8ClampedArray(width * height * 4);
	const x0 = Math.max(0, layer.left), x1 = Math.min(width, layer.left + old.width);
	const y0 = Math.max(0, layer.top), y1 = Math.min(height, layer.top + old.height);
	for (let y = y0; y < y1; y++) {
		const s = ((y - layer.top) * old.width + (x0 - layer.left)) * 4;
		if (x1 > x0)
			data.set(old.data.subarray(s, s + (x1 - x0) * 4), (y * width + x0) * 4);
	}
	layer.image	= {data, width, height};
	layer.left	= layer.top = 0;
}

// the layer cropped to the pixels that are not transparent, for writing: whole canvas-sized layers are mostly empty
export function exportLayer(layer: Layer): LayerData {
	const {data, width, height} = layer.image;
	let x0 = width, y0 = height, x1 = -1, y1 = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3]) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				y1 = y;
			}
		}
	}
	const m = layer.mask;
	const base = {
		name: layer.name, opacity: layer.opacity, visible: layer.visible, blend: layer.blend, clipped: layer.clipped,
		mask: m && {left: m.left, top: m.top, width: m.image.width, height: m.image.height, defaultColor: m.defaultColor, disabled: m.disabled, inverted: m.inverted, pixels: m.image.data},
	};
	if (x1 < 0)
		return {...base, left: 0, top: 0, width: 0, height: 0, pixels: new Uint8Array(0)};

	const r = {x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1};
	return {...base, left: layer.left + r.x, top: layer.top + r.y, width: r.w, height: r.h, pixels: crop(layer.image, r).data};
}

//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// PSD's blend mode keys, and the numbers composite.frag knows them by. A group's pass through, and any key not here, is
// normal.
export const BLEND_MODES: Record<string, number> = {
	'norm': 0,		// normal
	'diss': 1,		// dissolve
	'dark': 2,		// darken
	'mul ': 3,		// multiply
	'idiv': 4,		// colour burn
	'lbrn': 5,		// linear burn
	'dkCl': 6,		// darker colour
	'lite': 7,		// lighten
	'scrn': 8,		// screen
	'div ': 9,		// colour dodge
	'lddg': 10,		// linear dodge (add)
	'lgCl': 11,		// lighter colour
	'over': 12,		// overlay
	'sLit': 13,		// soft light
	'hLit': 14,		// hard light
	'vLit': 15,		// vivid light
	'lLit': 16,		// linear light
	'pLit': 17,		// pin light
	'hMix': 18,		// hard mix
	'diff': 19,		// difference
	'smud': 20,		// exclusion
	'fsub': 21,		// subtract
	'fdiv': 22,		// divide
	'hue ': 23,
	'sat ': 24,		// saturation
	'colr': 25,		// colour
	'lum ': 26,		// luminosity
};

export function blendModeNumber(key: string) {
	return BLEND_MODES[key] ?? 0;
}

//-----------------------------------------------------------------------------
// whole-document operations: new layers from old, with the canvas they sit on
//-----------------------------------------------------------------------------

// a layer's mask as the layer is moved: its rectangle goes where it is carried, its pixels turn with it
function moveMask(mask: LayerMask | undefined, image: (m: Pixels) => Pixels, place: (left: number, top: number, width: number, height: number) => {left: number, top: number}) {
	if (!mask)
		return undefined;
	const moved = image(mask.image);
	return {...mask, ...place(mask.left, mask.top, mask.image.width, mask.image.height), image: moved};
}

export function flipLayers(s: Snapshot, horizontal: boolean): Snapshot {
	const place = (left: number, top: number, width: number, height: number) => ({
		left:	horizontal ? s.width - (left + width) : left,
		top:	horizontal ? top : s.height - (top + height),
	});
	return {...s, layers: s.layers.map(l => ({
		...l,
		image:	flip(l.image, horizontal),
		...place(l.left, l.top, l.image.width, l.image.height),
		mask:	moveMask(l.mask, m => flip(m, horizontal, 1), place),
	}))};
}

export function rotateLayers(s: Snapshot, clockwise: boolean): Snapshot {
	const place = (left: number, top: number, width: number, height: number) => ({
		left:	clockwise ? s.height - (top + height) : top,
		top:	clockwise ? left : s.width - (left + width),
	});
	return {
		width: s.height, height: s.width, current: s.current,
		layers: s.layers.map(l => ({
			...l,
			image:	rotate(l.image, clockwise),
			...place(l.left, l.top, l.image.width, l.image.height),
			mask:	moveMask(l.mask, m => rotate(m, clockwise, 1), place),
		})),
	};
}

// the canvas is cut down to the rectangle; what a layer has outside it stays with the layer
export function cropLayers(s: Snapshot, r: Rect): Snapshot {
	return {
		width: r.w, height: r.h, current: s.current,
		layers: s.layers.map(l => ({
			...l,
			left: l.left - r.x, top: l.top - r.y,
			mask: l.mask && {...l.mask, left: l.mask.left - r.x, top: l.mask.top - r.y},
		})),
	};
}
