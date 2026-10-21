// The bitmap editor's selection: a coverage mask (0..255 a pixel) inside a box of whole pixels, so a selection can have any
// perimeter -- a rectangle, an ellipse, a freehand or polygonal lasso, a closed curve (curveVertex[]), or what the magic wand
// finds -- with soft (antialiased) edges, and can be added to, taken from, intersected and inverted.
// Nothing here touches the DOM, so it can be run (and tested) outside a webview.

import { float2, lerp } from '@isopodlabs/maths/vector';
import { parseCurve, bezier3Curve, curveVertex } from '@isopodlabs/binary_fonts';
import type { Pixels } from './raster.js';

// how a new selection joins the one there is
export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

const SUB = 4;	// sub-scanlines a pixel row is sampled at, for antialiasing

export class Selection {
	private loops?: number[][];

	// `mask` is the coverage of each pixel of the box, row by row; without one the whole box is selected
	constructor(readonly l: number, readonly t: number, readonly r: number, readonly b: number, readonly mask?: Uint8Array) {}

	get width()		{ return this.r - this.l; }
	get height()	{ return this.b - this.t; }
	get empty()		{ return this.r <= this.l || this.b <= this.t; }

	bounds() {
		return new float2.extent(float2(this.l, this.t), float2(this.r, this.b));
	}

	// how much of a pixel is selected, 0..255
	at(x: number, y: number) {
		if (x < this.l || y < this.t || x >= this.r || y >= this.b)
			return 0;
		return this.mask ? this.mask[(y - this.t) * this.width + (x - this.l)] : 255;
	}
	clippedAt(x: number, y: number) {
		return this.mask ? this.mask[(y - this.t) * this.width + (x - this.l)] : 255;
	}

	//-------------------------------------------------------------------------
	// making selections
	//-------------------------------------------------------------------------

	static rect(area: float2.extent) {
		return new Selection(area.min.x, area.min.y, area.max.x, area.max.y);
	}

	static all(size: float2) {
		return new Selection(0, 0, size.x, size.y);
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
		return new Selection(l, t, r, b, mask).trimmed();
	}

	static ellipse(area: float2.extent, size: float2) {
		return Selection.fromPolygons([ellipsePoints(area)], size);
	}

	// a closed curve (each contour of it), as curve vertices; arcs and beziers are flattened to within `tolerance` pixels
	static curve(curve: curveVertex[], size: float2, tolerance = 0.1) {
		return Selection.fromPolygons(flatten(curve, tolerance), size);
	}

	// the pixels within `tolerance` of the one at (sx, sy) in each channel: those connected to it, or all of them
	static wand(image: Pixels, sx: number, sy: number, tolerance: number, contiguous: boolean) {
		const {data, width, height} = image;
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
		return new Selection(l, t, r, b, mask);
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

		let l: number, t: number, r: number, b: number;
		if (mode === 'add') {
			l = Math.min(current.l, other.l); t = Math.min(current.t, other.t);
			r = Math.max(current.r, other.r); b = Math.max(current.b, other.b);
		} else if (mode === 'subtract') {
			({l, t, r, b} = current);
		} else {
			l = Math.max(current.l, other.l); t = Math.max(current.t, other.t);
			r = Math.min(current.r, other.r); b = Math.min(current.b, other.b);
		}
		if (r <= l || b <= t)
			return undefined;

		const w = r - l, mask = new Uint8Array(w * (b - t));
		for (let y = t; y < b; y++)
			for (let x = l; x < r; x++) {
				const a = current.at(x, y), c = other.at(x, y);
				mask[(y - t) * w + (x - l)] = mode === 'add' ? Math.max(a, c) : mode === 'subtract' ? Math.round(a * (255 - c) / 255) : Math.min(a, c);
			}
		return new Selection(l, t, r, b, mask).trimmed();
	}

	// everything in a width x height image that this is not
	invert(size: float2) {
		const {x: width, y: height} = size;
		const mask = new Uint8Array(width * height);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				mask[y * width + x] = 255 - this.at(x, y);
		return new Selection(0, 0, width, height, mask).trimmed();
	}

	// the same selection in the smallest box that holds it; undefined if it holds nothing
	trimmed(): Selection | undefined {
		const {mask, l, t} = this, w = this.width, h = this.height;
		if (!mask)
			return this.empty ? undefined : this;
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
		return new Selection(l + x0, t + y0, l + x1, t + y1, out);
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
			return this.loops = [[this.l, this.t, this.r, this.t, this.r, this.b, this.l, this.b]];

		const {l, t} = this, w = this.width, h = this.height, mask = this.mask;
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

export function ellipsePoints(area: float2.extent) {
	const {x: cx, y: cy} = area.centre(), {x: rx, y: ry} = area.size().scale(0.5);
	const n = Math.min(720, Math.max(24, Math.ceil(Math.PI * Math.max(rx, ry))));
	return Array.from({length: n}, (_, i) => float2(cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)));
}

// each contour of a curve as a polygon, within `tolerance` of the curve
export function flatten(curve: curveVertex[], tolerance: number) {
	const contours: float2[][] = [];
	let out: float2[] = [];
	const bez3 = (a: float2, b: float2, c: float2, d: float2) => {
		const len	= b.sub(a).len() + c.sub(b).len() + d.sub(c).len();
		const n		= Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / tolerance) / 2)));
		for (let i = 1; i <= n; i++) {
			const u		= i / n, v = 1 - u;
			const wa	= v * v * v, wb = 3 * v * v * u, wc = 3 * v * u * u, wd = u * u * u;
			out.push(float2(a.x * wa + b.x * wb + c.x * wc + d.x * wd, a.y * wa + b.y * wb + c.y * wc + d.y * wd));
		}
	};
	parseCurve(bezier3Curve(curve, tolerance)).run({
		Begin(a)			{ out = [a]; },
		Line(_a, b)			{ out.push(b); },
		Bezier2(a, b, c)	{ bez3(a, lerp(a, b, 2 / 3), lerp(c, b, 2 / 3), c); },
		Bezier3(a, b, c, d) { bez3(a, b, c, d); },
		End()				{ if (out.length > 2) contours.push(out); out = []; },
	});
	return contours;
}
