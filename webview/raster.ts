// The pixel and geometry work of the bitmap editor which needs no webview: rectangles of pixels, the tiles an edit keeps
// for undo, and new images made from old (flipped, turned, warped). Everything else in the editor imports this; it
// imports none of them, so it can be used before bitmap.ts has run.

import { float2, float3, float4, float3x3, float4x4 } from '@isopodlabs/maths/vector';
import type { Canvas3D, ShaderProgram } from './opengl.js';
import type { Selection } from './bitmapSelection.js';
import { Offscreen, readRect, Pixels, getPixel, createVertexArray, resizePixels } from './opengl.ts';
import { clamp01 } from './colour.ts';
import { type Warp, type Carry, carriedBounds } from './transformbox.ts';

export const imageSize	= (p: {width: number, height: number}) => float2(p.width, p.height);
export const imageRect	= (p: {width: number, height: number}) => float2.extent.fromSize(float2(0, 0), imageSize(p));
export const unionRect	= (a: float2.extent | undefined, b: float2.extent | undefined) => !a ? b : !b ? a : a.union(b);

export const roundOut	= (a: float2.extent, e = 0) => new float2.extent(
	float2(Math.floor(a.min.x + e), Math.floor(a.min.y + e)),
	float2(Math.ceil(a.max.x - e), Math.ceil(a.max.y - e))
);

export function alphaExtent(image: Pixels<4>) {
	const {data: data, width, height} = image;
	if (!width || !height)
		return;

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


export class Shape extends float2.extent {
	constructor(area: float2.extent, readonly mask?: Uint8ClampedArray<ArrayBuffer>) {
		super(area.min, area.max);
	}
	get width()		{ return this.max.x - this.min.x; }
	get height()	{ return this.max.y - this.min.y; }

	maskImage()		{ return this.mask && Pixels(this.mask, this.width, this.height, 1); }

	// how much of a pixel is selected, 0..255 (the pixels are those of the box without its far edges, which `contains` has)
	at(x: number, y: number) {
		if (x >= this.min.x && y >= this.min.y && x < this.max.x && y < this.max.y)
			return this.mask ? this.mask[(y - this.min.y) * this.width + (x - this.min.x)] : 255;
		return 0;
	}
	offset(x: number, y: number) {
		if (x >= this.min.x && y >= this.min.y && x < this.max.x && y < this.max.y)
			return (y - this.min.y) * this.width + (x - this.min.x);
		throw new Error("bad offset");
	}
	expand(x0: number, y0: number, x1: number, y1: number) {
		const area = new float2.extent(float2(this.min.x + x0, this.min.y + y0), float2(this.max.x + x1, this.max.y + y1));
		if (!this.mask)
			return new Shape(area);
		return new Shape(area, resizePixels(this.maskImage()!, x0, y0, x1 - x0, y1 - y0).data);
	}
}

// The alpha of an image within its extent, as a shape placed at (left, top)
export function alphaShape(image: Pixels<4>, left: number, top: number): Shape | undefined {
	const ext = alphaExtent(image);
	if (!ext)
		return;

	const {x: x0, y: y0} = ext.min, {x: w, y: h} = ext.size();
	const alpha = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		let s = ((y + y0) * image.width + x0) * 4 + 3;
		for (let x = 0, d = y * w; x < w; x++, s += 4)
			alpha[d + x] = image.data[s];
	}
	return new Shape(float2.extent.fromSize(float2(left + x0, top + y0), float2(w, h)), alpha);
}

//-----------------------------------------------------------------------------
// new images from old
//-----------------------------------------------------------------------------

// the quad of the layer drawing shader (which covers 0 to 1 across and down) put where a rectangle of the picture is, at a depth, and
// seen as `mvp` has it (from the picture's pixels)
export function placed(mvp: float4x4, ext: float2.extent, depth = 0) {
	const {x: w, y: h} = ext.size();
	return mvp.matmul(float4x4(float4(w, 0, 0, 0), float4(0, h, 0, 0), float4(0, 0, 1, 0), float4(ext.min.x, ext.min.y, depth, 1)));
}

// A mask something is drawn through: the texture of its pixels (made soft already, if it is feathered), where they are on the canvas,
// what it is outside them (0..255), whether it is inverted, and how much it hides of what it hides (0..255)
export interface QuadMask {
	texture:	WebGLTexture;
	area:		float2.extent;
	outside:	number;
	inverted:	boolean;
	density:	number;
}

// the layer drawing shader's uniforms for a layer's mask ('mask') or vector mask ('vmask'), which is bound to this texture unit
export function maskUniforms(name: 'mask' | 'vmask', unit: number, mask: QuadMask | undefined) {
	const at = mask?.area.min, size = mask?.area.size();
	return {
		[`u_${name}`]:			unit,
		[`u_${name}Rect`]:		at && size ? [at.x, at.y, size.x, size.y] : [0, 0, 0, 0],
		[`u_${name}Params`]:	[(mask?.outside ?? 255) / 255, mask?.inverted ? 1 : 0, mask ? 1 : 0, (mask?.density ?? 255) / 255],
	};
}

// A texture (through its mask and vector mask, if it has them) drawn where it is on the canvas (which is `rect`) as it is carried by
// the matrix, from canvas coordinates. It is the layer's, if it is one. With a warp, the part of it in the warp's box is bent by that
// first, in the shader, and the mvp is from where the warp puts it. With `view`, what is drawn is the masks themselves: what they hide
// under a red veil ('over'), or the masks alone, in grey.
export function drawQuad(canvas3d: Canvas3D, program: ShaderProgram, texture: WebGLTexture, area: float2.extent, masks: {mask?: QuadMask, vmask?: QuadMask, view?: 'over' | 'alone'}, opacity: number, mvp: float4x4, clip?: {matrix: float3x3, size: float2}, warp?: Warp) {
	const size	= area.size();
	const at	= warp?.box.min.sub(area.min).div(size), span = warp?.box.size().div(size);

	canvas3d.bindTexture2D(texture, 0);
	if (masks.mask)
		canvas3d.bindTexture2D(masks.mask.texture, 1);
	if (masks.vmask)
		canvas3d.bindTexture2D(masks.vmask.texture, 3);
	program.draw({
		u_mvp:			new Float32Array((warp ? mvp : placed(mvp, area)).flat()),
		u_warp:			warp ? 1 : 0,
		u_span:			at && span ? [at.x, at.y, span.x, span.y] : [0, 0, 1, 1],
		u_patch:		warp ? new Float32Array(warp.patch.control.flatMap(row => row.control.flatMap(c => [c.x, c.y]))) : new Float32Array(32),
		u_floor:		0,
		u_texture:		0,
		u_base:			2,
		u_origin:		[area.min.x, area.min.y],
		...maskUniforms('mask', 1, masks.mask),
		...maskUniforms('vmask', 3, masks.vmask),
		u_view:			masks.view === 'over' ? 1 : masks.view === 'alone' ? 2 : 0,
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
	// (what else draws with the program leaves these as they were)
	if (warp)
		program.use({u_warp: 0, u_span: [0, 0, 1, 1]});
}

export function crop<P extends Pixels>(image: P, r: float2.extent): P {
	const {x: width, y: height} = r.size();
	return {...image, data: readRect(image, r), width, height};
}

// (a pixel is as many bytes as the image's channels: 4 for the colours of a picture, 1 for a mask)
export function flip<P extends Pixels>(image: P, horizontal: boolean): P {
	const {data: data, width, height} = image, channels = image.channels ?? 4;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = ((horizontal ? y : height - 1 - y) * width + (horizontal ? width - 1 - x : x)) * channels;
			out.set(data.subarray(s, s + channels), (y * width + x) * channels);
		}
	}
	return {...image, data: out};
}

export function rotate<P extends Pixels>(image: P, clockwise: boolean): P {
	const {data: data, width, height} = image, channels = image.channels ?? 4;
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
	return {...image, data: out, width: height, height: width};
}

// The pixels of the rectangle `rect` of the plane an image is carried onto by a homography (which takes the image's
// pixel coordinates, the first pixel from 0 to 1, to the plane's). Each pixel is the image where the inverse takes it,
// bilinearly, from colours weighted by their alpha so that transparent pixels lend none of their colour; where it is
// shrunk, from several such samples a pixel. Outside the image is transparent, or for a mask (one channel) `outside`.
export function warpCPU<P extends Pixels>(image: P, m: float3x3, area: float2.extent, outside = 0): P {
	const {data: data, width, height} = image, channels = image.channels ?? 4;
	const {x: rx, y: ry} = area.min, {x: rw, y: rh} = area.size();
	const out = newData(data, rw * rh * channels);
	const inv = m.inverse();

	// how many samples a side a pixel: by how far apart its neighbours' samples are in the image, the most of that anywhere
	let spread = 1;
	for (let j = 0; j <= 4; j++) {
		const y = ry + rh * j / 4;
		for (let i = 0; i <= 4; i++) {
			const x = rx + rw * i / 4;
			const p = inv.project(float2(x, y));
			if (p) {
				const px = inv.project(float2(x + 1, y)), py = inv.project(float2(x, y + 1));
				if (px && py)
					spread = Math.max(spread, px.sub(p).len(), py.sub(p).len());
			}
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
					const p = inv.project(float2(rx + i + (si + 0.5) / n, ry + j + (sj + 0.5) / n));
					if (p) {
						sample(p.x, p.y);
						for (let c = 0; c < channels; c++)
							sum[c] += value[c];
					} else {
						if (channels === 1)
							sum[0] += outside;
					}
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
	return {...image, data: out, width: rw, height: rh};
}

const MAX_TILE = 4096;

// a new array for pixels of the same kind as these (bytes, or floats)
const newData = (like: Pixels['data'], n: number) => (like instanceof Float32Array ? new Float32Array(n) : new Uint8ClampedArray(n)) as Pixels['data'];

export function warp<P extends Pixels>(canvas3d: Canvas3D, program: ShaderProgram, image: P, m: float3x3, area: float2.extent, outside = 0): P {
	const {width, height, data} = image;
	const channels = image.channels ?? 4;
	const {x: rw, y: rh} = area.size();
	const floats = data instanceof Float32Array;
	const out = newData(data, rw * rh * channels);

	const w = m.z.z;
	if (w && Math.abs(m.x.z) === 0 && Math.abs(m.y.z) === 0) {
		const xx = m.x.x / w, xy = m.x.y / w, yx = m.y.x / w, yy = m.y.y / w, tx = m.z.x / w, ty = m.z.y / w;
		const unit = (v: number) => v === -1 || v === 1;
		// (a flip or quarter turn by whole pixels, which is a copy: each output axis from one input axis, so that centres land on centres)
		const exact = ([xx, yy].every(unit) && !xy && !yx) || ([xy, yx].every(unit) && !xx && !yy);
		if (exact && Number.isInteger(tx) && Number.isInteger(ty)) {
			if (xx === 1 && yy === 1 && !tx && !ty && width === rw && height === rh && !area.min.x && !area.min.y)
				return image;

			// Each pixel lands where its centre does: along an axis it moves by v + t, or by -v - 1 + t where that is reversed (v the pixel's
			// column or row), and the area's own corner is taken off. Of each output axis one input axis is the source: along that the
			// output steps by 1 or -1 a pixel, and along the other it holds still.
			const to_ = (v: number, sign: number) => sign > 0 ? v : -v - 1;
			const words = channels === 4 && !floats && data.byteOffset % 4 === 0;
			const from = words ? new Uint32Array(data.buffer, data.byteOffset, width * height) : undefined, wout = words ? new Uint32Array(out.buffer, out.byteOffset, rw * rh) : undefined;
			const stepX = xx || 0, stepY = xy || 0;		// (the output's column and row, a pixel to the right)
			for (let y = 0; y < height; y++) {
				const startX = (xx ? to_(0, xx) : to_(y, yx)) + tx - area.min.x, startY = (xy ? to_(0, xy) : to_(y, yy)) + ty - area.min.y;
				if (xx === 1) {
					// the row stays a row, in the same direction: copied whole, as much of it as the area holds
					if (startY < 0 || startY >= rh)
						continue;
					const x0 = Math.max(0, -startX), x1 = Math.min(width, rw - startX);
					if (x1 > x0)
						out.set(data.subarray((y * width + x0) * channels, (y * width + x1) * channels), (startY * rw + startX + x0) * channels);
					continue;
				}
				for (let x = 0; x < width; x++) {
					const dx = startX + stepX * x, dy = startY + stepY * x;
					if (dx < 0 || dy < 0 || dx >= rw || dy >= rh)
						continue;	// (beyond the area)
					if (from && wout) {
						wout[dy * rw + dx] = from[y * width + x];
					} else {
						const o = (dy * rw + dx) * channels, i = (y * width + x) * channels;
						for (let c = 0; c < channels; c++)
							out[o + c] = data[i + c];
					}
				}
			}

			return {...image, data: out, width: rw, height: rh};
		}

	}
	const gl = canvas3d.gl;
	const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;


	// (floats are kept as floats all the way, which needs a target they can be drawn into)
	if (!program || !(data instanceof Uint8ClampedArray || data instanceof Uint8Array || floats && gl.getExtension('EXT_color_buffer_float'))
		|| (channels !== 4 && channels !== 1)
		|| !width || !height || width > maxSize || height > maxSize
		|| rw <= 0 || rh <= 0)
		return warpCPU(image, m, area, outside);

	const {x: rx, y: ry} = area.min;
	const source	= channels === 4
		? canvas3d.createTextureFromImage(image, {format: floats ? 'rgba32f' : 'rgba8', min: 'nearest', mag: 'nearest'})
		: canvas3d.createTexture(width, height, data, {format: floats ? 'r32f' : 'r8', min: 'nearest', mag: 'nearest'});
	const tile		= Math.min(MAX_TILE, maxSize, ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
	const target	= canvas3d.createOffscreen(Math.min(rw, tile), Math.min(rh, tile), floats ? 'rgba32f' : 'rgba8');
	const inv		= m.inverse();

	const read		= newData(data, Math.min(rw, tile) * Math.min(rh, tile) * 4) as Uint8ClampedArray<ArrayBuffer>;	// (or floats: the one array is read into as either)
	const blend		= gl.isEnabled(gl.BLEND);
	gl.disable(gl.BLEND);
	target.begin();
	canvas3d.bindTexture2D(source, 0);

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
				u_outside:	floats ? outside : outside / 255,
			});
			const tileRead = read.subarray(0, tw * th * 4);
			gl.readPixels(0, 0, tw, th, gl.RGBA, floats ? gl.FLOAT : gl.UNSIGNED_BYTE, tileRead as Uint8ClampedArray);
			for (let j = 0; j < th; j++) {
				const o = ((ty + j) * rw + tx) * channels;
				if (channels === 4) {
					(out as Uint8ClampedArray).set(tileRead.subarray(j * tw * 4, (j + 1) * tw * 4), o);
				} else {
					for (let i = 0; i < tw; i++)
						out[o + i] = tileRead[(j * tw + i) * 4];
				}
			}
		}
	}

	canvas3d.bindTexture2D(null, 0);
	target.end();
	target.delete();
	canvas3d.deleteTexture(source);
	if (blend)
		gl.enable(gl.BLEND);
	canvas3d.initViewport();
	return {...image, data: out, width: rw, height: rh};
}

// Part of an image carried onto an area by `at` (from the image's pixels to the area's), on the GPU (`program` is textwarp's): a mesh
// over the part (a cell for every few pixels, with a transparent pixel round it so that its edges are filtered as the rest is), each
// vertex where `at` puts it, and the image its texture, premultiplied and with mipmaps, so that what is shrunk is filtered down. A mask
// (one channel) is carried the same, with `outside` where nothing lands. A warp, or a text's warp style.
export function meshWarp<P extends Pixels>(canvas3d: Canvas3D, program: ShaderProgram, image: P, part: float2.extent, at: (p: float2) => float2, area: float2.extent, outside = 0): P {
	const gl = canvas3d.gl, channels = image.channels ?? 4;
	const {x: rw, y: rh} = area.size();
	const out = new Uint8ClampedArray(rw * rh * channels).fill(channels === 1 ? outside : 0);
	const box = roundOut(part).intersect(imageRect(image));
	if (box.empty() || rw <= 0 || rh <= 0)
		return {...image, data: out, width: rw, height: rh};

	// the part of the image in the box, and a pixel round it: transparent, or for a mask `outside`
	const pad		= box.grow(float2(1, 1)), {x: pw, y: ph} = pad.size(), src = image.data;
	const texels	= new Uint8Array(pw * ph * channels).fill(channels === 1 ? outside : 0);
	for (let y = box.min.y; y < box.max.y; y++) {
		for (let x = box.min.x; x < box.max.x; x++) {
			const o = (y * image.width + x) * channels, t = ((y - pad.min.y) * pw + x - pad.min.x) * channels;
			if (channels === 1) {
				texels[t] = src[o];
			} else {
				const a = src[o + 3];
				texels[t] = src[o] * a / 255; texels[t + 1] = src[o + 1] * a / 255; texels[t + 2] = src[o + 2] * a / 255; texels[t + 3] = a;
			}
		}
	}
	const texture = canvas3d.createTexture(pw, ph, texels, {format: channels === 1 ? 'r8' : 'rgba8', min: 'linear', mag: 'linear'});
	canvas3d.bindTexture2D(texture, 0);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

	// the mesh: where each vertex lands on the area, and where it is in the texture
	const across = Math.min(256, Math.max(4, Math.ceil(pw / 8))), down = Math.min(256, Math.max(4, Math.ceil(ph / 8)));
	const landed: float2[] = [];
	for (let j = 0; j <= down; j++)
		for (let i = 0; i <= across; i++)
			landed.push(at(pad.min.add(float2(i / across * pw, j / down * ph))).sub(area.min));

	const cells = (f: (i: number, j: number) => number[]) => {
		const data: number[] = [];
		for (let j = 0; j < down; j++)
			for (let i = 0; i < across; i++)
				data.push(...f(i, j), ...f(i + 1, j), ...f(i, j + 1), ...f(i + 1, j), ...f(i + 1, j + 1), ...f(i, j + 1));
		return new Float32Array(data);
	};
	const uv = cells((i, j) => [i / across, j / down]);

	const maxSize	= gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
	const tile		= Math.min(MAX_TILE, maxSize, ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
	const target	= canvas3d.createOffscreen(Math.min(rw, tile), Math.min(rh, tile));
	const read		= new Uint8ClampedArray(Math.min(rw, tile) * Math.min(rh, tile) * 4);
	const blend		= gl.isEnabled(gl.BLEND);

	gl.disable(gl.BLEND);
	target.begin();
	for (let ty = 0; ty < rh; ty += tile) {
		for (let tx = 0; tx < rw; tx += tile) {
			const tw		= Math.min(tile, rw - tx), th = Math.min(tile, rh - ty);
			// (in this tile's clip space, the first row first, as what is read back has it)
			const position	= cells((i, j) => { const p = landed[j * (across + 1) + i]; return [(p.x - tx) / tw * 2 - 1, (p.y - ty) / th * 2 - 1]; });
			const vao		= createVertexArray(gl, program.program, {a_position: {size: 2, data: position}, a_uv: {size: 2, data: uv}});
			gl.viewport(0, 0, tw, th);
			gl.clearColor(channels === 1 ? outside / 255 : 0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			canvas3d.bindTexture2D(texture, 0);
			program.use({u_text: 0});
			gl.bindVertexArray(vao);
			gl.drawArrays(gl.TRIANGLES, 0, position.length / 2);
			gl.bindVertexArray(null);
			gl.deleteVertexArray(vao);
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
	canvas3d.bindTexture2D(null, 0);
	target.end();
	target.delete();
	canvas3d.deleteTexture(texture);
	if (blend)
		gl.enable(gl.BLEND);
	canvas3d.initViewport();
	return {...image, data: out, width: rw, height: rh};
}

// The part of a picture a selection covers, lifted out (what is partly selected partly, and the rest not at all), and the picture
// with that part taken from it
export function liftSelection(image: Pixels<4>, s: Selection) {
	const {width, height, data: src} = image;
	const floating	= Pixels<4>(new Uint8ClampedArray(width * height * 4), width, height);
	const rest		= Pixels<4>(src.slice(), width, height);
	const f = floating.data as Uint8ClampedArray, d = rest.data as Uint8ClampedArray;
	for (let y = Math.max(0, s.min.y); y < Math.min(height, s.max.y); y++) {
		for (let x = Math.max(0, s.min.x); x < Math.min(width, s.max.x); x++) {
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

// A picture with what a selection covers carried (from its pixels' coordinates): the rest of it is left as it was, but where the
// selected part was, and the carried part laid over it where that lands. `warp` carries pixels (on the GPU, if it is able).
export function warpSelected(image: Pixels<4>, s: Selection, carry: Carry, warp: (image: Pixels<4>, c: Carry, area: float2.extent) => Pixels<4>) {
	const {floating, rest} = liftSelection(image, s);
	const area = carriedBounds(carry, s.bounds())?.intersect(imageRect(image));
	if (area && !area.empty()) {
		const warped = warp(floating, carry, area).data as Uint8ClampedArray, w = area.size().x, d = rest.data as Uint8ClampedArray;
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

//-----------------------------------------------------------------------------
// distance from an edge: for the soft edges of a selection that is grown or shrunk, and the strokes of a layer style
//-----------------------------------------------------------------------------

const INF = 1e20;

// The squared distance to the nearest of the `on` places along one line (Felzenszwalb and Huttenlocher's parabolas)
function line(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
	let k = 0;
	v[0] = 0;
	z[0] = -INF;
	z[1] = INF;
	for (let q = 1; q < n; q++) {
		let s: number;
		while (true) {
			const p = v[k];
			s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
			if (s > z[k] || k === 0)
				break;
			k--;
		}
		if (s <= z[k]) {
			v[k] = q;
			z[k] = -INF;
			z[k + 1] = INF;
		} else {
			k++;
			v[k] = q;
			z[k] = s;
			z[k + 1] = INF;
		}
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1] < q)
			k++;
		d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
	}
}

/** For each place, its distance in pixels to the nearest place where `on` is set (0 where it is itself). */
export function distanceTo(on: (i: number) => boolean, width: number, height: number): Float32Array {
	const out = new Float32Array(width * height);
	for (let i = 0; i < out.length; i++)
		out[i] = on(i) ? 0 : INF;
	const n = Math.max(width, height);
	const f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++)
			f[y] = out[y * width + x];
		line(f, height, d, v, z);
		for (let y = 0; y < height; y++)
			out[y * width + x] = d[y];
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++)
			f[x] = out[y * width + x];
		line(f, width, d, v, z);
		for (let x = 0; x < width; x++)
			out[y * width + x] = Math.sqrt(d[x]);
	}
	return out;
}

/** For each place, how far its middle is from the edge of the shape that `inside` picks out: positive outside it, negative inside it,
 *  the edge being half a pixel from the middle of the places next to it. With `sides` only one side is worked out, and the places on
 *  the other are given an infinite distance (further from the edge than anything). */
export function signedDistance(inside: (i: number) => boolean, width: number, height: number, sides: 'both' | 'inside' | 'outside' = 'both'): Float32Array {
	const toInside	= sides === 'inside' ? undefined : distanceTo(inside, width, height);			// (the places outside look for the inside)
	const toOutside	= sides === 'outside' ? undefined : distanceTo(i => !inside(i), width, height);
	const out = new Float32Array(width * height);
	for (let i = 0; i < out.length; i++)
		out[i] = inside(i) ? (toOutside ? -(toOutside[i] - 0.5) : -Infinity) : (toInside ? toInside[i] - 0.5 : Infinity);
	return out;
}

/** The alpha of a stroke of `size` pixels along the edge of the shape that `alpha` (width by height, a pixel being in it from 128)
 *  gives: outside it, inside it, or half on each side. Its edges are softened over a pixel. */
export function strokeAlpha(alpha: ArrayLike<number>, width: number, height: number, size: number, align: 'inside' | 'center' | 'outside'): Uint8ClampedArray {
	const signed = signedDistance(i => alpha[i] >= 128, width, height, align === 'center' ? 'both' : align);
	const reach = align === 'center' ? size / 2 : size;
	const out = new Uint8ClampedArray(width * height);
	for (let i = 0; i < out.length; i++)
		out[i] = clamp01(reach - Math.abs(signed[i]) + 0.5) * 255;
	return out;
}

//-----------------------------------------------------------------------------
// blur
//-----------------------------------------------------------------------------

// what blur.frag takes for a gaussian of this sigma, either way: its reach (three sigmas), the sum of its weights, and what lies
// beyond the edges (`edge`: nothing, or the edge's own; with `fill`, that value, for a mask that is something beyond its pixels)
function blurUniforms(sigma: number, edge: 'zero' | 'clamp', plain: boolean, fill = 0) {
	const rad = Math.max(1, Math.ceil(sigma * 3));
	let norm = 0;
	for (let i = -rad; i <= rad; i++)
		norm += Math.exp(-i * i / (2 * sigma * sigma));
	return {u_radius: rad, u_sigma: sigma, u_norm: norm, u_zero: edge === 'zero' ? 1 : 0, u_plain: plain ? 1 : 0, u_fill: [fill, fill, fill, fill]};
}

/** The passes of blur.frag for a gaussian of this sigma (and with a `sharpen` amount, the unsharp mask of that radius): the first along
 *  the rows into a float target and the second down the columns (which goes on to the unsharp mask of the image if sharpening); and how
 *  far they look around a pixel. Colours are weighted by their alpha; `plain` is for a one-channel image (a mask), blurred value by value. */
export function blurPasses(plain: boolean, sigma: number, edge: 'zero' | 'clamp' = 'clamp', sharpen = 0) {
	const common = blurUniforms(sigma, edge, plain), rad = common.u_radius;
	const passes: ShadePass[] = [
		{uniforms: {...common, u_step: [1, 0], u_first: 1, u_amount: 0}, grow: [0, rad], float: true},
		{uniforms: {...common, u_step: [0, 1], u_first: 0, u_amount: sharpen}},
	];
	return {passes, reach: rad};
}

/** The pixels of `area` of an image blurred (see blurPasses), on the GPU */
export function blur(canvas3d: Canvas3D, program: ShaderProgram, image: Pixels, area: float2.extent, sigma: number, edge: 'zero' | 'clamp' = 'clamp', sharpen = 0): Pixels | undefined {
	const {passes, reach} = blurPasses(image.channels === 1, sigma, edge, sharpen);
	return shade(canvas3d, program, image, area, passes, reach);
}

/** How far a mask's feather reaches beyond its pixels: the blurred mask covers a rectangle this much bigger each way. */
export function featherReach(mask: {feather?: number, image: {width: number, height: number}}) {
	return mask.feather && mask.feather > 0 && mask.image.width && mask.image.height ? Math.max(1, Math.ceil(mask.feather * 3)) : 0;
}

/** A mask's pixels (a texture `width` by `height`, its values in the red) blurred on the GPU by a gaussian of this sigma, what lies beyond
 *  them taken to be `outside` (0..1): drawn into a target as much bigger each way as featherReach says, whose red is the blurred mask,
 *  which the caller deletes. Undefined where it cannot be made. */
export function blurMask(canvas3d: Canvas3D, program: ShaderProgram, source: WebGLTexture, width: number, height: number, sigma: number, outside: number): Offscreen | undefined {
	const gl = canvas3d.gl, common = blurUniforms(sigma, 'zero', true, outside), rad = Math.max(1, Math.ceil(sigma * 3));
	const w = width + rad * 2, h = height + rad * 2, limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
	if (Math.max(w, h) > limit)
		return undefined;
	const blend = gl.isEnabled(gl.BLEND), targets: Offscreen[] = [];
	// (each pass draws all of the bigger rectangle, the first from the mask's own (0, 0) less the reach)
	const pass = (read: WebGLTexture, origin: [number, number], step: [number, number], format: 'rgba16f' | 'rgba8') => {
		const target = canvas3d.createOffscreen(w, h, format);
		targets.push(target);
		target.begin();
		gl.viewport(0, 0, w, h);
		canvas3d.bindTexture2D(read, 0);
		program.draw({...common, u_image: 0, u_original: 0, u_origin: origin, u_originalAt: [0, 0], u_step: step, u_first: 1, u_amount: 0});
		target.end();
		return target;
	};
	try {
		gl.disable(gl.BLEND);
		const rows = pass(source, [-rad, -rad], [1, 0], gl.getExtension('EXT_color_buffer_float') ? 'rgba16f' : 'rgba8');
		const out = pass(rows.texture, [0, 0], [0, 1], 'rgba8');
		targets.pop();
		return out;
	} catch {
		return undefined;
	} finally {
		for (const t of targets)
			t.delete();
		program.use({u_fill: [0, 0, 0, 0]});		// (what else blurs with the program takes nothing beyond the edge)
		canvas3d.bindTexture2D(null, 0);
		if (blend)
			gl.enable(gl.BLEND);
		canvas3d.initViewport();
	}
}

//-----------------------------------------------------------------------------
// sharpen and levels
//-----------------------------------------------------------------------------

export interface Levels {
	black:	number;		// the input which becomes black: 0..254
	white:	number;		// the input which becomes white: 1..255
	gamma:	number;		// above 1 lightens the middle, below darkens it
}

/** The uniforms which levels.frag takes for these levels */
export const levelsUniforms = (l: Levels) => ({u_black: l.black / 255, u_white: l.white / 255, u_gamma: l.gamma});

//-----------------------------------------------------------------------------
// convolution
//-----------------------------------------------------------------------------

export interface Kernel {
	size:		number;			// odd, up to 7
	weights:	number[];		// size by size, a row at a time
	bias?:		number;			// 0..1, added to the result of a kernel that is not smoothing
	grey?:		boolean;		// from the luminance, to grey
	smooth?:	boolean;		// a smoothing kernel, whose weights add to 1: it takes the alpha into account
}

/** A square of equal weights, a box blur */
export const boxKernel = (size: number): Kernel => ({size, weights: new Array(size * size).fill(1 / (size * size)), smooth: true});

/** Relief, as if lit from the top left, on grey */
export const embossKernel: Kernel = {size: 3, weights: [-2, -1, 0, -1, 0, 1, 0, 1, 2], bias: 0.5, grey: true};

/** The edges, bright on black */
export const edgeKernel: Kernel = {size: 3, weights: [-1, -1, -1, -1, 8, -1, -1, -1, -1], grey: true};

/** The uniforms which convolve.frag takes for this kernel */
export function kernelUniforms(kernel: Kernel) {
	const weights = new Float32Array(49);
	weights.set(kernel.weights);
	return {u_size: kernel.size, u_kernel: weights, u_bias: kernel.bias ?? 0, u_grey: kernel.grey ? 1 : 0, u_smooth: kernel.smooth ? 1 : 0};
}

/** One draw of a filter's fragment shader. A pass reads what the one before drew (the first, the image), and `u_origin` is where its own
 *  (0, 0) is in that; the image itself is always `u_original`, with `u_originalAt` the place in it of the pass's first pixel. */
export interface ShadePass {
	uniforms:	Record<string, any>;
	grow?:		[number, number];	// it draws this many pixels more than the area all round (as many as the image has), for a later pass to look at
	float?:		boolean;			// into a float target, to keep more than a byte a channel (bytes where there is no such thing); (always, for an image of floats)
}

/** Where the last of a filter's passes is drawn: `rect` (of the image), into the target that `open` gives, and what `read` makes of it
 *  once drawn (before the target ends). `uniforms` are the last pass's alone (what the earlier ones' do not need). A target which is not
 *  `owned` is the caller's to delete. */
export interface ShadeSink<T> {
	rect:		float2.extent;
	open(format: 'rgba8' | 'rgba16f' | 'rgba32f'): Offscreen;	// (the target the pass would be drawn into otherwise)
	read(width: number, height: number): T;
	owned?:		boolean;
	uniforms?:	Record<string, any>;
}

/** The passes of a filter's fragment shader run against the texture of an image (`whole` its rect), the earlier ones over `area` and
 *  what they grow by, the last into the sink. Units: 0 is what the pass reads, 1 the image itself (`u_original`), and `extra`'s from 2.
 *  Nothing where it cannot be done. */
export function drawPasses<T>(canvas3d: Canvas3D, program: ShaderProgram, source: WebGLTexture, whole: float2.extent, area: float2.extent, passes: ShadePass[], floats: boolean,
		sink: ShadeSink<T>, extra: WebGLTexture[] = []): T | undefined {
	const gl = canvas3d.gl;
	// (a pass that wants a float target has bytes where there are none: less exact, but done)
	const halfFloat = !!gl.getExtension('EXT_color_buffer_float');
	const targets: Offscreen[] = [];
	const blend = gl.isEnabled(gl.BLEND);
	try {
		gl.disable(gl.BLEND);
		let read = source, readAt = float2(0, 0);
		canvas3d.bindTexture2D(source, 1);
		extra.forEach((t, i) => canvas3d.bindTexture2D(t, i + 2));
		for (const [i, pass] of passes.entries()) {
			const last	= i === passes.length - 1;
			const [gx, gy] = pass.grow ?? [0, 0];
			const draws	= last ? sink.rect : new float2.extent(area.min.sub(float2(gx, gy)), area.max.add(float2(gx, gy))).intersect(whole);
			const {x: w, y: h} = draws.size();
			const format = floats ? 'rgba32f' : pass.float && halfFloat ? 'rgba16f' : 'rgba8';
			const target = last ? sink.open(format) : canvas3d.createOffscreen(w, h, format);
			if (!last || sink.owned)
				targets.push(target);
			target.begin();
			gl.viewport(0, 0, w, h);
			canvas3d.bindTexture2D(read, 0);
			program.draw({u_image: 0, u_original: 1, u_origin: [draws.min.x - readAt.x, draws.min.y - readAt.y], u_originalAt: [draws.min.x, draws.min.y], u_bounded: 0, ...pass.uniforms, ...(last ? sink.uniforms : undefined)});
			if (last) {
				const out = sink.read(w, h);
				target.end();
				return out;
			}
			target.end();
			read = target.texture;
			readAt = draws.min;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		extra.forEach((_, i) => canvas3d.bindTexture2D(null, i + 2));
		canvas3d.bindTexture2D(null, 1);
		canvas3d.bindTexture2D(null, 0);
		for (const t of targets)
			t.delete();
		if (blend)
			gl.enable(gl.BLEND);
		canvas3d.initViewport();
	}
}

/** An area of an image run through a filter's fragment shader, as passes (the last drawing the area itself), in one go: nothing where it
 *  cannot be. An image of floats is kept in floats all the way, and comes back so. An image of one channel (a mask) is sampled as its red,
 *  and a shader writes its result to the red. */
function shadeOnce(canvas3d: Canvas3D, program: ShaderProgram, image: Pixels, area: float2.extent, passes: ShadePass[]): Pixels | undefined {
	const gl = canvas3d.gl, {x: aw, y: ah} = area.size();
	const floats = image.data instanceof Float32Array, channels = image.channels ?? 4;
	if (!program || !(floats || image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array) || !image.width || !image.height
		|| Math.max(image.width, image.height) > gpuLimit(canvas3d) || aw <= 0 || ah <= 0
		|| floats && !gl.getExtension('EXT_color_buffer_float'))
		return undefined;
	let source: WebGLTexture | undefined;
	try {
		source = canvas3d.createTextureFromImage(image, {min: 'nearest', mag: 'nearest', format: floats ? (channels === 1 ? 'r32f' : 'rgba32f') : (channels === 1 ? 'r8' : 'rgba8')});
		return drawPasses<Pixels>(canvas3d, program, source, imageRect(image), area, passes, floats, {
			rect:	area,
			owned:	true,
			open:	format => canvas3d.createOffscreen(aw, ah, format),
			read:	(w, h) => {
				// (always read as rgba, which is what a target can be read as; a single channel is the red)
				let data: Pixels<4>['data'];
				if (floats) {
					data = new Float32Array(w * h * 4);
					gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data);
				} else {
					data = new Uint8ClampedArray(w * h * 4);
					gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
				}
				if (channels === 1) {
					const red = floats ? new Float32Array(w * h) : new Uint8ClampedArray(w * h);
					for (let i = 0; i < red.length; i++)
						red[i] = data[i * 4];
					data = red;
				}
				return {data, width: w, height: h, channels: image.channels};
			},
		});
	} catch {
		return undefined;
	} finally {
		if (source)
			canvas3d.deleteTexture(source);
	}
}

/** shadeOnce in pieces where the image is too big to do at once, for a shader that looks `reach` pixels around each one. Nothing where
 *  there is no GPU to do it (the caller has the CPU's way). A single pass can be given as just its uniforms. */
export function shade(canvas3d: Canvas3D, program: ShaderProgram, image: Pixels, area: float2.extent, passes: ShadePass[] | Record<string, any>, reach = 0): Pixels | undefined {
	const list = Array.isArray(passes) ? passes : [{uniforms: passes}];
	return tiled(image, area, reach, gpuLimit(canvas3d), (img, a) => shadeOnce(canvas3d, program, img, a, list));
}

//-----------------------------------------------------------------------------
// pieces
//-----------------------------------------------------------------------------

/** The biggest piece of an image to give the GPU at once: what it can take, and no more than will not strain its memory */
const MAX_PIECE = 4096;
export const gpuLimit = (canvas3d: Canvas3D) => Math.min(MAX_PIECE, textureLimit(canvas3d));
/** The biggest image the GPU can hold as one texture and draw into whole */
export const textureLimit = (canvas3d: Canvas3D) => {
	const gl = canvas3d.gl;
	return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
};

/** A filter of an area of an image, which `run` does for an image and area of at most `limit` pixels either way, done in pieces
 *  where they are bigger. A filter that looks `reach` pixels around each one is given each piece with that much around it (as much as
 *  the image has), so that the pieces join up as the whole would. Nothing if it cannot (`run` gives nothing for a piece, or the
 *  reach leaves no room). */
export function tiled(image: Pixels, area: float2.extent, reach: number, limit: number, run: (image: Pixels, area: float2.extent) => Pixels | undefined): Pixels | undefined {
	const {x: aw, y: ah} = area.size();
	if (aw <= 0 || ah <= 0 || !(image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array || image.data instanceof Float32Array))
		return undefined;
	if (image.width <= limit && image.height <= limit)
		return run(image, area);

	const step = limit - 2 * reach;
	if (step < 64)
		return undefined;
	const ch = image.channels ?? 4, whole = imageRect(image), Make = image.data instanceof Float32Array ? Float32Array : Uint8ClampedArray, out = new Make(aw * ah * ch);
	for (let ty = area.min.y; ty < area.max.y; ty += step) {
		for (let tx = area.min.x; tx < area.max.x; tx += step) {
			const tile	= new float2.extent(float2(tx, ty), float2(Math.min(tx + step, area.max.x), Math.min(ty + step, area.max.y)));
			const from	= new float2.extent(tile.min.sub(float2(reach, reach)), tile.max.add(float2(reach, reach))).intersect(whole);
			const {x: sw, y: sh} = from.size(), {x: tw, y: th} = tile.size();

			// the piece's pixels, copied out row by row
			const piece = new Make(sw * sh * ch);
			for (let y = 0; y < sh; y++) {
				const o = ((y + from.min.y) * image.width + from.min.x) * ch;
				piece.set((image.data as Uint8ClampedArray).subarray(o, o + sw * ch), y * sw * ch);
			}
			const got = run({data: piece, width: sw, height: sh, channels: image.channels}, new float2.extent(tile.min.sub(from.min), tile.max.sub(from.min)));
			if (!got)
				return undefined;
			for (let y = 0; y < th; y++)
				out.set((got.data as Uint8ClampedArray).subarray(y * tw * ch, (y + 1) * tw * ch), ((y + tile.min.y - area.min.y) * aw + tile.min.x - area.min.x) * ch);
		}
	}
	return {data: out, width: aw, height: ah, channels: image.channels};
}

