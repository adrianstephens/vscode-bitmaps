// The bitmap editor's selection: a coverage mask (0..255 a pixel) inside a box of whole pixels, so a selection can have any
// perimeter -- a rectangle, an ellipse, a freehand or polygonal lasso, a closed curve (curveVertex[]), or what the magic wand
// finds -- with soft (antialiased) edges, and can be added to, taken from, intersected and inverted.
// Nothing here touches the DOM, so it can be run (and tested) outside a webview.

import { float2 } from '@isopodlabs/maths/vector';
import { curveVertex, curveFlatten, ON_BEGIN, ON_CURVE, OFF_ARC, ON_ARC } from '@isopodlabs/binary_fonts';
import { type RGBAPixels } from './opengl.ts';
import { signedDistance } from './raster.ts';
import { clamp01 } from './colour.ts';

// how a mask is blurred in place (width, height and sigma given), which the caller does (on the GPU: see Painter.maskBlur)
export type MaskBlur = (f: Float32Array, width: number, height: number, sigma: number) => void;

// how a new selection joins the one there is
export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

const SUB = 4;	// sub-scanlines a pixel row is sampled at, for antialiasing

export class Selection extends float2.extent {
	private loops?: number[][];

	// `mask` is the coverage of each pixel of the box, row by row; without one the whole box is selected
	constructor(area: float2.extent, readonly mask?: Uint8Array) {
		super(area.min, area.max);
	}

	get width()		{ return this.max.x - this.min.x; }
	get height()	{ return this.max.y - this.min.y; }

	bounds() {
		return this;
	}

	// how much of a pixel is selected, 0..255 (the pixels are those of the box without its far edges, which `contains` has)
	at(x: number, y: number) {
		if (x >= this.min.x && y >= this.min.y && x < this.max.x && y < this.max.y)
			return this.mask ? this.mask[(y - this.min.y) * this.width + (x - this.min.x)] : 255;
		return 0;
	}
	clippedAt(x: number, y: number) {
		return this.mask ? this.mask[(y - this.min.y) * this.width + (x - this.min.x)] : 255;
	}

	//-------------------------------------------------------------------------
	// making selections
	//-------------------------------------------------------------------------

	static rect(area: float2.extent) {
		return new Selection(area);
	}

	static all(size: float2) {
		return new Selection(new float2.extent(float2(0, 0), size));
	}

	// the inside of closed polygons (a pixel is inside where the winding number is not zero, so holes need the opposite
	// direction), within a width x height image; undefined if nothing is
	static fromPolygons(contours: ArrayLike<float2>[], size: float2) {
		const {x: width, y: height} = size;
		type Edge = {x0: number, y0: number, x1: number, y1: number, dir: number};
		const edges: Edge[] = [];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const c of contours) {
			for (let i = 0; i < c.length; i++) {
				const a = c[i], b = c[(i + 1) % c.length];
				minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
				minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
				if (a.y !== b.y)
					edges.push(a.y < b.y ? {x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1} : {x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1});
			}
		}
		const l = Math.max(0, Math.floor(minX)), t = Math.max(0, Math.floor(minY));
		const r = Math.min(width, Math.ceil(maxX)), b = Math.min(height, Math.ceil(maxY));
		if (!(r > l && b > t))
			return undefined;

		edges.sort((p, q) => p.y0 - q.y0);
		const w = r - l, mask = new Uint8Array(w * (b - t));
		const acc = new Float32Array(w + 2), diff = new Float32Array(w + 2);
		let next = 0, active: Edge[] = [];

		for (let y = t; y < b; y++) {
			acc.fill(0);
			diff.fill(0);
			let any = false;
			for (let s = 0; s < SUB; s++) {
				const sy = y + (s + 0.5) / SUB;
				while (next < edges.length && edges[next].y0 <= sy)
					active.push(edges[next++]);
				active = active.filter(e => e.y1 > sy);

				const xs = active.map(e => ({x: e.x0 + (sy - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0), dir: e.dir})).sort((p, q) => p.x - q.x);
				let winding = 0;
				for (let i = 0; i < xs.length - 1; i++) {
					winding += xs[i].dir;
					if (!winding)
						continue;
					// the span from xs[i] to xs[i + 1], clipped to the box: partial pixels at the ends, whole ones between
					const xa = Math.max(l, xs[i].x) - l, xb = Math.min(r, xs[i + 1].x) - l;
					if (xb <= xa)
						continue;
					any = true;
					const ia = Math.floor(xa), ib = Math.floor(xb);
					if (ia === ib) {
						acc[ia] += xb - xa;
					} else {
						acc[ia] += ia + 1 - xa;
						acc[ib] += xb - ib;
						diff[ia + 1]++;
						diff[ib]--;
					}
				}
			}
			if (!any)
				continue;
			let run = 0;
			const row = (y - t) * w;
			for (let x = 0; x < w; x++) {
				run += diff[x];
				mask[row + x] = Math.min(255, Math.round((acc[x] + run) * 255 / SUB));
			}
		}
		return new Selection(new float2.extent(float2(l, t), float2(r, b)), mask).trimmed();
	}

	static ellipse(area: float2.extent, size: float2) {
		return Selection.fromPolygons([ellipsePoints(area)], size);
	}

	// a closed curve (each contour of it), as curve vertices; arcs and beziers are flattened to within `tolerance` pixels
	static curve(curve: curveVertex[], size: float2, tolerance = 0.1) {
		return Selection.fromPolygons(curveFlatten(curve, tolerance), size);
	}

	// the pixels within `tolerance` of the one at (sx, sy) in each channel: those connected to it, or all of them
	static wand(image: RGBAPixels, sx: number, sy: number, tolerance: number, contiguous: boolean) {
		const {data: data, width, height} = image;
		if (sx < 0 || sy < 0 || sx >= width || sy >= height)
			return undefined;

		const s = (sy * width + sx) * 4;
		const tr = data[s], tg = data[s + 1], tb = data[s + 2], ta = data[s + 3];
		const matches = (i: number) => {
			const o = i * 4;
			if (data[o + 3] === 0 && ta === 0)
				return true;
			return Math.abs(data[o] - tr) <= tolerance && Math.abs(data[o + 1] - tg) <= tolerance
				&& Math.abs(data[o + 2] - tb) <= tolerance && Math.abs(data[o + 3] - ta) <= tolerance;
		};

		const found = new Uint8Array(width * height);
		let l = width, t = height, r = 0, b = 0;
		const take = (x0: number, x1: number, y: number) => {	// x0..x1 inclusive
			found.fill(255, y * width + x0, y * width + x1 + 1);
			l = Math.min(l, x0); r = Math.max(r, x1 + 1); t = Math.min(t, y); b = Math.max(b, y + 1);
		};

		if (!contiguous) {
			for (let y = 0; y < height; y++)
				for (let x = 0; x < width; x++)
					if (matches(y * width + x))
						take(x, x, y);
		} else {
			const stack = [sx, sy];
			while (stack.length) {
				const y = stack.pop()!, x = stack.pop()!;
				if (found[y * width + x] || !matches(y * width + x))
					continue;
				let x0 = x, x1 = x;
				while (x0 > 0 && !found[y * width + x0 - 1] && matches(y * width + x0 - 1))
					x0--;
				while (x1 < width - 1 && !found[y * width + x1 + 1] && matches(y * width + x1 + 1))
					x1++;
				take(x0, x1, y);
				for (const ny of [y - 1, y + 1]) {
					if (ny < 0 || ny >= height)
						continue;
					let inRun = false;
					for (let nx = x0; nx <= x1; nx++) {
						const ok = !found[ny * width + nx] && matches(ny * width + nx);
						if (ok && !inRun)
							stack.push(nx, ny);
						inRun = ok;
					}
				}
			}
		}
		if (r <= l)
			return undefined;
		const w = r - l, mask = new Uint8Array(w * (b - t));
		for (let y = t; y < b; y++)
			mask.set(found.subarray(y * width + l, y * width + r), (y - t) * w);
		return new Selection(new float2.extent(float2(l, t), float2(r, b)), mask);
	}

	//-------------------------------------------------------------------------
	// changing them
	//-------------------------------------------------------------------------

	// this joined with `other` as `mode` says; undefined if nothing is left selected
	static combine(current: Selection | undefined, other: Selection | undefined, mode: SelectMode) {
		if (mode === 'replace' || !current)
			return mode === 'subtract' || mode === 'intersect' ? undefined : other;
		if (!other)
			return mode === 'intersect' ? undefined : current;

		let ext	= mode === 'add' ? current.union(other) : mode === 'intersect' ? current.intersect(other) : current;
		if (ext.empty())
			return undefined;

		const {x: w, y: h} = ext.size();
		const mask = new Uint8Array(w * h);
		for (let y = 0; y < h; y++) {
			const y1 = y + ext.min.y;
			for (let x = 0; x < w; x++) {
				const x1 = x + ext.min.x;
				const a = current.at(x1, y1), c = other.at(x1, y1);
				mask[y * w + x] = mode === 'add' ? Math.max(a, c) : mode === 'subtract' ? Math.round(a * (255 - c) / 255) : Math.min(a, c);
			}
		}
		return new Selection(ext, mask).trimmed();
	}

	// everything in a width x height image that this is not
	invert(size: float2) {
		const {x: width, y: height} = size;
		const mask = new Uint8Array(width * height);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				mask[y * width + x] = 255 - this.at(x, y);
		return new Selection(new float2.extent(float2(0, 0), float2(width, height)), mask).trimmed();
	}

	// The selection with its edge moved out by `r` pixels (in by -r), the new edge antialiased; the image's own edges do not
	// pull a selection in. r is in pixels, of the box's image `size`.
	growClamp(r: number, size: float2) {
		return this.reshape(r, size, (s, r) => clamp01(r - s + 0.5));
	}

	// a band `width` pixels wide centred on the edge
	border(width: number, size: float2) {
		return this.reshape(Math.ceil(width / 2), size, (s) => clamp01(width / 2 - Math.abs(s) + 0.5));
	}

	// the edge blurred over about `r` pixels either side of it
	feather(r: number, size: float2, blur: MaskBlur) {
		if (r <= 0)
			return this;
		const sigma = r / 2, pad = Math.ceil(r * 1.5) + 1;
		const box = this.padded(pad, size);
		const {w, h} = box, f = new Float32Array(w * h);
		for (let i = 0; i < f.length; i++)
			f[i] = box.mask[i];
		blur(f, w, h, sigma);
		return box.make(f, v => v);
	}

	// rough edges rounded off: the selection blurred over `r` pixels, then cut back to a clean edge
	smooth(r: number, size: float2, blur: MaskBlur) {
		if (r <= 0)
			return this;
		const pad = Math.ceil(r * 2) + 1;
		const box = this.padded(pad, size);
		const {w, h} = box, f = new Float32Array(w * h);
		for (let i = 0; i < f.length; i++)
			f[i] = box.mask[i];
		blur(f, w, h, r / 2);
		return box.make(f, v => clamp01((v - 127.5) / 255 * 4 + 0.5) * 255);
	}

	// this in a box `pad` pixels bigger each way (within the image), as a full mask
	private padded(pad: number, size: float2) {
		const l = Math.max(0, this.min.x - pad), t = Math.max(0, this.min.y - pad);
		const r = Math.min(size.x, this.max.x + pad), b = Math.min(size.y, this.max.y + pad);
		const w = r - l, h = b - t, mask = new Uint8Array(w * h);
		for (let y = t; y < b; y++)
			for (let x = l; x < r; x++)
				mask[(y - t) * w + (x - l)] = this.at(x, y);
		return {l, t, w, h, mask, make: (f: Float32Array, fn: (v: number) => number) => {
			const out = new Uint8Array(w * h);
			for (let i = 0; i < out.length; i++)
				out[i] = Math.round(Math.min(255, Math.max(0, fn(f[i]))));
			return new Selection(new float2.extent(float2(l, t), float2(r, b)), out).trimmed();
		}};
	}

	// the coverage of each pixel as `cover` makes it from the signed distance of its centre from the edge (negative inside)
	private reshape(r: number, size: float2, cover: (signed: number, r: number) => number) {
		const reach = Math.ceil(Math.abs(r)) + 2;
		const box = this.padded(reach, size);
		const {w, h, mask} = box;
		const signed = signedDistance(i => mask[i] >= 128, w, h), out = new Float32Array(w * h);
		for (let i = 0; i < out.length; i++)
			out[i] = cover(signed[i], r) * 255;
		return box.make(out, v => v);
	}

	// the same selection in the smallest box that holds it; undefined if it holds nothing
	trimmed(): Selection | undefined {
		const mask = this.mask;
		if (!mask)
			return this.empty() ? undefined : this;
		const w = this.width, h = this.height;
		let x0 = w, y0 = h, x1 = 0, y1 = 0;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				if (mask[y * w + x]) {
					x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
					y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
				}
		if (x1 <= x0)
			return undefined;
		if (x0 === 0 && y0 === 0 && x1 === w && y1 === h)
			return this;
		const nw = x1 - x0, out = new Uint8Array(nw * (y1 - y0));
		for (let y = y0; y < y1; y++)
			out.set(mask.subarray(y * w + x0, y * w + x1), (y - y0) * nw);
		return new Selection(new float2.extent(this.min.add(float2(x0, y0)), this.min.add(float2(x1, y1))), out);
	}

	// A selection that is a whole box (no pixel of it partly selected)
	get isRect() {
		return !this.mask || this.mask.every(v => v === 255);
	}

	// The edge between what is more than half selected and what is not, as closed loops of pixel corners: [x0, y0, x1, y1, ...]
	outline() {
		if (this.loops)
			return this.loops;
		if (!this.mask)
			return this.loops = [[this.min.x, this.min.y, this.max.x, this.min.y, this.max.x, this.max.y, this.min.x, this.max.y]];

		const {x: l, y: t} = this.min, w = this.width, h = this.height, mask = this.mask;
		const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= 128;
		const stride = w + 1;
		// edges run clockwise (on screen) around inside pixels: right = 1, down = 2, left = 4, up = 8, from each corner
		const out = new Map<number, number>();
		const add = (x: number, y: number, dir: number) => out.set(y * stride + x, (out.get(y * stride + x) ?? 0) | dir);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				if (!inside(x, y))
					continue;
				if (!inside(x, y - 1)) add(x, y, 1);
				if (!inside(x + 1, y)) add(x + 1, y, 2);
				if (!inside(x, y + 1)) add(x + 1, y + 1, 4);
				if (!inside(x - 1, y)) add(x, y + 1, 8);
			}

		const dx = [0, 1, 0, -1, 0], dy = [0, 0, 1, 0, -1];
		const loops: number[][] = [];
		for (const [key] of out) {
			while (out.get(key)) {
				const loop: number[] = [];
				let x = key % stride, y = Math.floor(key / stride), last = 0;
				for (;;) {
					const dirs = out.get(y * stride + x) ?? 0;
					if (!dirs)
						break;
					// keep going the way we were if we can (so crossings of diagonal pixels do not tangle), else the first way out
					const pick = last && (dirs & last) ? last : dirs & -dirs;
					out.set(y * stride + x, dirs & ~pick);
					if (pick !== last)
						loop.push(l + x, t + y);
					last = pick;
					const d = 1 + Math.log2(pick);
					x += dx[d]; y += dy[d];
				}
				if (loop.length)
					loops.push(loop);
			}
		}
		return this.loops = loops;
	}
}

//-----------------------------------------------------------------------------
// shapes
//-----------------------------------------------------------------------------
/*
export function ellipsePoints(area: float2.extent) {
	const {x: cx, y: cy} = area.centre(), {x: rx, y: ry} = area.size().scale(0.5);
	const n = Math.min(720, Math.max(24, Math.ceil(Math.PI * Math.max(rx, ry))));
	return Array.from({length: n}, (_, i) => float2(cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)));
}
*/

export function ellipsePoints(area: float2.extent) {
	const c = area.centre(), ry = area.max.y - c.y, x0 = area.min.x, x1 = area.max.x;

	const ellipse: curveVertex[] = [
		curveVertex(x0, c.y, ON_BEGIN),
		curveVertex(x0, c.y - ry * 2, OFF_ARC),   // on the tangent line at the start, 2*ry away
		curveVertex(x1, c.y - ry * 2, OFF_ARC),   // on the tangent line at the end,area.max.y away
		curveVertex(x1, c.y, ON_CURVE),
		curveVertex(x1, c.y + ry * 2, OFF_ARC),
		curveVertex(x0, c.y + ry * 2, OFF_ARC),
	];
	return curveFlatten(ellipse, 0.1)[0];
}

//-----------------------------------------------------------------------------
// image processing for the modifiers
//-----------------------------------------------------------------------------


