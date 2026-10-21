// The pixel and geometry work of the bitmap editor which needs no webview: rectangles of pixels, the tiles an edit keeps
// for undo, and new images made from old (flipped, turned, warped). Everything else in the editor imports this; it
// imports none of them, so it can be used before bitmap.ts has run.

import { float2, float3, float3x3 } from '@isopodlabs/maths/vector';
import type { Canvas3D, ShaderProgram, Pixels } from './opengl.js';
import type { Selection } from './bitmapSelection.js';
import { applyH } from './transformbox.js';
export type { Pixels };

export type RGBA = {r: number, g: number, b: number, a: number};
export function RGBA(r: number, g: number, b: number, a: number): RGBA { return {r, g, b, a}; }

// the size of an image (or anything with a width and a height), and the rectangle it covers from the origin
export const imageSize = (p: {width: number, height: number}) => float2(p.width, p.height);
export const imageRect = (p: {width: number, height: number}) => float2.extent.fromSize(float2(0, 0), imageSize(p));
export function unionRect(a: float2.extent | undefined, b: float2.extent | undefined) {
	return !a ? b : !b ? a : a.union(b);
}

// the pixels of a rectangle, packed
export function readRect(image: Pixels, r: float2.extent) {
	const {x, y} = r.min, {x: w, y: h} = r.extent();
	const out = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const s = ((y + j) * image.width + x) * 4;
		out.set(image.data.subarray(s, s + w * 4), j * w * 4);
	}
	return out;
}

export function writeRect(image: Pixels, r: float2.extent, src: Uint8ClampedArray) {
	const {x, y} = r.min, {x: w, y: h} = r.extent();
	for (let j = 0; j < h; j++)
		image.data.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * image.width + x) * 4);
}

export function alphaExtent(image: Pixels) {
	const {data, width, height} = image;
	const filled = (y: number) => {
		for (let x = 0; x < width; x++)
			if (data[(y * width + x) * 4 + 3])
				return true;
		return false;
	};

	// the first row with something in it, and the last (which there is, once there is a first)
	let y0 = 0;
	while (y0 < height && !filled(y0))
		++y0;
	if (y0 === height)
		return;
	let y1 = height - 1;
	while (!filled(y1))
		--y1;

	// the columns of the rows between: how far in from each side the first of them is
	let x0 = width, x1 = -1;
	for (let y = y0; y <= y1; y++) {
		let x = 0;
		while (x < x0 && !data[(y * width + x) * 4 + 3])
			++x;
		x0 = x;

		x = width - 1;
		while (x > x1 && !data[(y * width + x) * 4 + 3])
			--x;
		x1 = x;
	}
	return new float2.extent(float2(x0, y0), float2(x1 + 1, y1 + 1));
}


// The image is changed in tiles, and the first time a tile is touched its original pixels are kept. That is what undo needs,
// and it also lets a stroke be correct where it overlaps itself: every pixel is worked out from its original value and
// the greatest coverage the stroke has given it, so a translucent stroke is no darker where it crosses itself. And a preview
// (a line being dragged out) is `reset` and drawn again.
const TILE = 64;

class Tile extends float2.extent {
	before:	Uint8ClampedArray;	// the original pixels, packed
	cover:	Float32Array;		// the greatest coverage so far, per pixel
	constructor(image: Pixels, r: float2.extent) {
		super(r.min, r.max.min(float2(image.width, image.height)));
		this.before = readRect(image, r);
		const {x: w, y: h} = r.extent();
		this.cover = new Float32Array(w * h);
	 }
}

export class Tiles {
	protected tiles = new Map<number, Tile>();
	protected dirty: float2.extent | undefined;

	constructor(readonly image: Pixels) {}

	protected tile(x: number, y: number) {
		const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
		const key = ty * 65536 + tx;
		let t = this.tiles.get(key);
		if (!t) {
			t = new Tile(this.image, new float2.extent(float2(tx, ty).scale(TILE), float2(tx + 1, ty + 1).scale(TILE)));
			this.tiles.set(key, t);
		}
		return t;
	}

	// the area changed since the last call
	take() {
		const r = this.dirty;
		this.dirty = undefined;
		return r;
	}
	// back to the original, to draw again
	reset() {
		for (const t of this.tiles.values()) {
			writeRect(this.image, t, t.before);
			t.cover.fill(0);
			this.dirty = unionRect(this.dirty, t);
		}
	}

	// what changed, to undo or redo; nothing if nothing did
	commit(): Patch | undefined {
		const tiles: PatchTile[] = [];
		for (const t of this.tiles.values()) {
			const after = readRect(this.image, t);
			if (after.some((v, i) => v !== t.before[i]))
				tiles.push(new PatchTile(t, after));
		}
		return tiles.length ? {tiles} : undefined;
	}
}

export class PatchTile extends float2.extent {
	before:	Uint8ClampedArray;	// the original pixels, packed
	constructor(tile: Tile, public after:Uint8ClampedArray) {
		super(tile.min, tile.max);
		this.before = tile.before;
	}
}
export interface Patch {
	tiles: PatchTile[];
}

export function applyPatch(image: Pixels, patch: Patch, which: 'before' | 'after') {
	let dirty: float2.extent | undefined;
	for (const t of patch.tiles) {
		writeRect(image, t, t[which]);
		dirty = unionRect(dirty, t);
	}
	return dirty;
}
export function crop(image: Pixels, r: float2.extent): Pixels {
	const {x: width, y: height} = r.extent();
	return {data: readRect(image, r), width, height};
}

//-----------------------------------------------------------------------------
// new images from old
//-----------------------------------------------------------------------------


// (`channels` is how many bytes a pixel is: 4 for the colours of a picture, 1 for a mask)
export function flip(image: Pixels, horizontal: boolean, channels = 4): Pixels {
	const {data, width, height} = image;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = ((horizontal ? y : height - 1 - y) * width + (horizontal ? width - 1 - x : x)) * channels;
			out.set(data.subarray(s, s + channels), (y * width + x) * channels);
		}
	}
	return {data: out, width, height};
}

export function rotate(image: Pixels, clockwise: boolean, channels = 4): Pixels {
	const {data, width, height} = image;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// the new image is height wide and width high
			const nx = clockwise ? height - 1 - y : y;
			const ny = clockwise ? x : width - 1 - x;
			const s = (y * width + x) * channels;
			out.set(data.subarray(s, s + channels), (ny * height + nx) * channels);
		}
	}
	return {data: out, width: height, height: width};
}

// The pixels of the rectangle `rect` of the plane an image is carried onto by a homography (which takes the image's
// pixel coordinates, the first pixel from 0 to 1, to the plane's). Each pixel is the image where the inverse takes it,
// bilinearly, from colours weighted by their alpha so that transparent pixels lend none of their colour; where it is
// shrunk, from several such samples a pixel. Outside the image is transparent, or for a mask (one channel) `outside`.
export function warpCPU(image: Pixels, m: float3x3, area: float2.extent, channels = 4, outside = 0): Pixels {
	const {data, width, height} = image;
	const {x: rx, y: ry} = area.min, {x: rw, y: rh} = area.extent();
	const out = new Uint8ClampedArray(rw * rh * channels);
	const inv = m.inverse();

	// how many samples a side a pixel: by how far apart its neighbours' samples are in the image, the most of that anywhere
	let spread = 1;
	for (let j = 0; j <= 4; j++) {
		const y = ry + rh * j / 4;
		for (let i = 0; i <= 4; i++) {
			const x = rx + rw * i / 4;
			const p = applyH(inv, x, y), px = applyH(inv, x + 1, y), py = applyH(inv, x, y + 1);
			if (p.z > 0)
				spread = Math.max(spread, px.sub(p).len(), py.sub(p).len());
		}
	}
	const n = Math.min(4, Math.ceil(spread - 1e-6));

	const value = new Float64Array(channels), sum = new Float64Array(channels);
	// the image at a point, premultiplied, into `value`
	const sample = (sx: number, sy: number) => {
		value.fill(0);
		const fx = sx - 0.5, fy = sy - 0.5;
		const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
		for (let k = 0; k < 4; k++) {
			const x = x0 + (k & 1), y = y0 + (k >> 1);
			const weight = (k & 1 ? tx : 1 - tx) * (k & 2 ? ty : 1 - ty);
			if (!weight)
				continue;
			if (x < 0 || y < 0 || x >= width || y >= height) {
				if (channels === 1)
					value[0] += outside * weight;
				continue;
			}
			const o = (y * width + x) * channels;
			if (channels === 4) {
				const a = data[o + 3] * weight;
				value[0] += data[o] * a;
				value[1] += data[o + 1] * a;
				value[2] += data[o + 2] * a;
				value[3] += a;
			} else {
				for (let c = 0; c < channels; c++)
					value[c] += data[o + c] * weight;
			}
		}
	};

	for (let j = 0; j < rh; j++) {
		for (let i = 0; i < rw; i++) {
			sum.fill(0);
			for (let sj = 0; sj < n; sj++) {
				for (let si = 0; si < n; si++) {
					const p = applyH(inv, rx + i + (si + 0.5) / n, ry + j + (sj + 0.5) / n);
					if (p.z <= 0) {
						if (channels === 1)
							sum[0] += outside;
						continue;
					}
					sample(p.x, p.y);
					for (let c = 0; c < channels; c++)
						sum[c] += value[c];
				}
			}
			const o = (j * rw + i) * channels, nn = n * n;
			if (channels === 4) {
				const a = sum[3];
				if (a > 0) {
					out[o]		= sum[0] / a;
					out[o + 1]	= sum[1] / a;
					out[o + 2]	= sum[2] / a;
					out[o + 3]	= a / nn;
				}
			} else {
				for (let c = 0; c < channels; c++)
					out[o + c] = sum[c] / nn;
			}
		}
	}
	return {data: out, width: rw, height: rh};
}

const MAX_TILE = 4096;

export function warp(canvas3d: Canvas3D, program: ShaderProgram, image: Pixels, m: float3x3, area: float2.extent, channels = 4, outside = 0): Pixels {
	const gl = canvas3d.gl;
	const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

	const {x: rw, y: rh} = area.extent();

	if (!program || !(image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array)
		|| (channels !== 4 && channels !== 1)
		|| !image.width || !image.height || image.width > maxSize || image.height > maxSize
		|| rw <= 0 || rh <= 0)
		return warpCPU(image, m, area, channels, outside);;

	const {x: rx, y: ry} = area.min;
	const source	= channels === 4
		? canvas3d.createTextureFromImage(image, {min: 'nearest', mag: 'nearest'})
		: canvas3d.createTexture(image.width, image.height, image.data, {format: 'r8', min: 'nearest', mag: 'nearest'});
	const tile		= Math.min(MAX_TILE, maxSize, ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
	const target	= canvas3d.createOffscreen(Math.min(rw, tile), Math.min(rh, tile));
	const inv		= m.inverse();

	const out		= new Uint8ClampedArray(rw * rh * channels);
	const read		= new Uint8ClampedArray(Math.min(rw, tile) * Math.min(rh, tile) * 4);
	const blend		= gl.isEnabled(gl.BLEND);
	gl.disable(gl.BLEND);
	target.begin();
	canvas3d.bindTexture(gl.TEXTURE_2D, source, 0);

	for (let ty = 0; ty < rh; ty += tile) {
		for (let tx = 0; tx < rw; tx += tile) {
			const tw = Math.min(tile, rw - tx), th = Math.min(tile, rh - ty);
			// from this tile's pixels to the image's: the plane's coordinates kept small, for the GPU's precision
			const t = inv.matmul(float3x3(float3(1, 0, 0), float3(0, 1, 0), float3(rx + tx, ry + ty, 1)));
			gl.viewport(0, 0, tw, th);
			program.draw({
				u_image:	0,
				u_inverse:	[t.x.x, t.x.y, t.x.z, t.y.x, t.y.y, t.y.z, t.z.x, t.z.y, t.z.z],
				u_mask:		channels === 1 ? 1 : 0,
				u_outside:	outside / 255,
			});
			const tileRead = read.subarray(0, tw * th * 4);
			gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, tileRead);
			for (let j = 0; j < th; j++) {
				const o = ((ty + j) * rw + tx) * channels;
				if (channels === 4) {
					out.set(tileRead.subarray(j * tw * 4, (j + 1) * tw * 4), o);
				} else {
					for (let i = 0; i < tw; i++)
						out[o + i] = tileRead[(j * tw + i) * 4];
				}
			}
		}
	}

	canvas3d.bindTexture(gl.TEXTURE_2D, null, 0);
	target.end();
	target.delete();
	gl.deleteTexture(source);
	if (blend)
		gl.enable(gl.BLEND);
	canvas3d.initViewport();
	return {data: out, width: rw, height: rh};
}

// the whole pixels a rectangle covers once it is carried by a homography; undefined if any of it goes behind the horizon
export function transformedBounds(m: float3x3, r: float2.extent): float2.extent | undefined {
	const ext	= m.transformExtent(r);
	if (!ext)
		return undefined;
	const e		= 1e-6;
	return new float2.extent(
		float2(Math.floor(ext.min.x + e), Math.floor(ext.min.y + e)),
		float2(Math.ceil(ext.max.x - e), Math.ceil(ext.max.y - e))
	);
}

// The part of a picture a selection covers, lifted out (what is partly selected partly, and the rest not at all), and the picture
// with that part taken from it
export function liftSelection(image: Pixels, s: Selection) {
	const {width, height} = image, src = image.data as Uint8ClampedArray;
	const floating: Pixels	= {data: new Uint8ClampedArray(width * height * 4), width, height};
	const rest: Pixels		= {data: src.slice(), width, height};
	const f = floating.data as Uint8ClampedArray, d = rest.data as Uint8ClampedArray;
	for (let y = Math.max(0, s.t); y < Math.min(height, s.b); y++) {
		for (let x = Math.max(0, s.l); x < Math.min(width, s.r); x++) {
			const cover = s.at(x, y);
			if (cover) {
				const o = (y * width + x) * 4;
				f.set(src.subarray(o, o + 3), o);
				f[o + 3]	= src[o + 3] * cover / 255;
				d[o + 3]	= src[o + 3] * (255 - cover) / 255;
			}
		}
	}
	return {floating, rest};
}

// A picture with what a selection covers carried by a matrix (from its pixels' coordinates): the rest of it is left as it was, but
// where the selected part was, and the carried part laid over it where that lands. `warp` carries pixels (on the GPU, if it is able).
export function warpSelected(image: Pixels, s: Selection, matrix: float3x3, warp: (image: Pixels, m: float3x3, area: float2.extent) => Pixels = warpCPU) {
	const {floating, rest} = liftSelection(image, s);
	const area = transformedBounds(matrix, s.bounds())?.intersect(imageRect(image));
	if (area && !area.empty()) {
		const warped = warp(floating, matrix, area).data as Uint8ClampedArray, w = area.size().x, d = rest.data as Uint8ClampedArray;
		for (let j = 0; j < area.size().y; j++) {
			for (let i = 0; i < w; i++) {
				const o = ((area.min.y + j) * image.width + area.min.x + i) * 4, k = (j * w + i) * 4;
				const sa = warped[k + 3] / 255, da = d[o + 3] / 255, oa = sa + da * (1 - sa);
				if (oa > 0) {
					for (let c = 0; c < 3; c++)
						d[o + c] = (warped[k + c] * sa + d[o + c] * da * (1 - sa)) / oa;
					d[o + 3] = oa * 255;
				}
			}
		}
	}
	return rest;
}
