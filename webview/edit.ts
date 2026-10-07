// The raster side of the bitmap editor: what a brush, a bucket or a shape does to a bitmap's pixels.
// Nothing here touches the DOM, so it can be run (and tested) outside a webview.

export type RGBA = [number, number, number, number];	// 0..255 each, not premultiplied

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

// anything with pixels: an ImageData, or a bare {data, width, height}
export interface Pixels {
	data:	Uint8ClampedArray;
	width:	number;
	height:	number;
}

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

export function unionRect(a: Rect | undefined, b: Rect | undefined) {
	if (!a)
		return b;
	if (!b)
		return a;
	const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
	return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}

// the pixels of a rectangle, packed
function readRect(image: Pixels, r: Rect) {
	const out = new Uint8ClampedArray(r.w * r.h * 4);
	for (let y = 0; y < r.h; y++) {
		const s = ((r.y + y) * image.width + r.x) * 4;
		out.set(image.data.subarray(s, s + r.w * 4), y * r.w * 4);
	}
	return out;
}

function writeRect(image: Pixels, r: Rect, src: Uint8ClampedArray) {
	for (let y = 0; y < r.h; y++)
		image.data.set(src.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * image.width + r.x) * 4);
}

//-----------------------------------------------------------------------------
// selection
//-----------------------------------------------------------------------------

export interface Selection extends Rect {
	ellipse: boolean;
}

export function inSelection(s: Selection | null, x: number, y: number) {
	if (!s)
		return true;
	if (x < s.x || y < s.y || x >= s.x + s.w || y >= s.y + s.h)
		return false;
	if (!s.ellipse)
		return true;
	const rx = s.w / 2, ry = s.h / 2;
	const dx = (x + 0.5 - s.x - rx) / rx, dy = (y + 0.5 - s.y - ry) / ry;
	return dx * dx + dy * dy <= 1;
}

//-----------------------------------------------------------------------------
// operations: one undoable change to an image
//-----------------------------------------------------------------------------

// The image is changed in tiles, and the first time a tile is touched its original pixels are kept. That is what undo needs,
// and it also lets a stroke be correct where it overlaps itself: every pixel is worked out from its original value and
// the greatest coverage the stroke has given it, so a translucent stroke is no darker where it crosses itself. And a preview
// (a line being dragged out) is `reset` and drawn again.
const TILE = 64;

interface Tile extends Rect {
	before:	Uint8ClampedArray;	// the original pixels, packed
	cover:	Float32Array;		// the greatest coverage so far, per pixel
}

export interface Patch {
	tiles: (Rect & {before: Uint8ClampedArray, after: Uint8ClampedArray})[];
}

export function applyPatch(image: Pixels, patch: Patch, which: 'before' | 'after') {
	let dirty: Rect | undefined;
	for (const t of patch.tiles) {
		writeRect(image, t, t[which]);
		dirty = unionRect(dirty, t);
	}
	return dirty;
}

// how a pixel takes its colour: composed over what was there, taking that away, or replacing it
export type Blend = 'paint' | 'erase' | 'replace';

export class Operation {
	private tiles = new Map<number, Tile>();
	private dirty: Rect | undefined;

	opacity		= 1;
	colour:		RGBA = [0, 0, 0, 255];
	blend:		Blend = 'paint';

	constructor(readonly image: Pixels, readonly selection: Selection | null = null) {}

	// where anything can be drawn: the selection, inside the image
	bounds(): Rect {
		const s = this.selection;
		const x0 = Math.max(0, s ? s.x : 0), y0 = Math.max(0, s ? s.y : 0);
		const x1 = Math.min(this.image.width, s ? s.x + s.w : this.image.width);
		const y1 = Math.min(this.image.height, s ? s.y + s.h : this.image.height);
		return {x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0)};
	}

	private tile(x: number, y: number) {
		const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
		const key = ty * 65536 + tx;
		let t = this.tiles.get(key);
		if (!t) {
			const r = {x: tx * TILE, y: ty * TILE, w: Math.min(TILE, this.image.width - tx * TILE), h: Math.min(TILE, this.image.height - ty * TILE)};
			t = {...r, before: readRect(this.image, r), cover: new Float32Array(r.w * r.h)};
			this.tiles.set(key, t);
		}
		return t;
	}

	// give a pixel coverage `c` (0..1) of `colour`; a pixel only ever gains coverage until the operation is reset
	put(x: number, y: number, c: number, colour: RGBA = this.colour) {
		if (c <= 0 || x < 0 || y < 0 || x >= this.image.width || y >= this.image.height || !inSelection(this.selection, x, y))
			return;

		const t		= this.tile(x, y);
		const i		= (y - t.y) * t.w + (x - t.x);
		if (c <= t.cover[i])
			return;
		t.cover[i]	= c;

		const a		= c * this.opacity * colour[3] / 255;
		const b		= i * 4;
		const o		= (y * this.image.width + x) * 4;
		const d		= this.image.data;
		const dstA	= t.before[b + 3] / 255;

		if (this.blend === 'erase') {
			d[o + 0] = t.before[b + 0];
			d[o + 1] = t.before[b + 1];
			d[o + 2] = t.before[b + 2];
			d[o + 3] = Math.round(dstA * (1 - a) * 255);

		} else if (this.blend === 'replace') {
			for (let k = 0; k < 4; k++)
				d[o + k] = Math.round(t.before[b + k] + (colour[k] - t.before[b + k]) * c);

		} else {
			const outA = a + dstA * (1 - a);
			if (outA > 0) {
				const w = dstA * (1 - a);
				d[o + 0] = Math.round((colour[0] * a + t.before[b + 0] * w) / outA);
				d[o + 1] = Math.round((colour[1] * a + t.before[b + 1] * w) / outA);
				d[o + 2] = Math.round((colour[2] * a + t.before[b + 2] * w) / outA);
			}
			d[o + 3] = Math.round(outA * 255);
		}

		const p = this.dirty;
		if (!p)
			this.dirty = {x, y, w: 1, h: 1};
		else {
			const x1 = Math.max(p.x + p.w, x + 1), y1 = Math.max(p.y + p.h, y + 1);
			p.x = Math.min(p.x, x);
			p.y = Math.min(p.y, y);
			p.w = x1 - p.x;
			p.h = y1 - p.y;
		}
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
		const tiles: Patch['tiles'] = [];
		for (const t of this.tiles.values()) {
			const after = readRect(this.image, t);
			if (after.some((v, i) => v !== t.before[i]))
				tiles.push({x: t.x, y: t.y, w: t.w, h: t.h, before: t.before, after});
		}
		return tiles.length ? {tiles} : undefined;
	}
}

//-----------------------------------------------------------------------------
// brush and pencil
//-----------------------------------------------------------------------------

function smooth(c: number) {
	return c * c * (3 - 2 * c);
}

function segmentDistance(px: number, py: number, x0: number, y0: number, dx: number, dy: number, len2: number) {
	const t = len2 > 0 ? clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1) : 0;
	return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

// A soft round brush dragged from one point to the next: coverage depends only on the distance from the segment, so
// a stroke is even however the pointer moved. Hardness 1 is a hard edge (still antialiased); less than that fades
// from that fraction of the radius.
export function brushSegment(op: Operation, x0: number, y0: number, x1: number, y1: number, size: number, hardness: number) {
	const r		= size / 2;
	const f		= Math.max(r * (1 - hardness), 1);
	const reach	= r + 1;
	const bb	= op.bounds();
	const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;

	const xa = Math.max(bb.x, Math.floor(Math.min(x0, x1) - reach)), xb = Math.min(bb.x + bb.w, Math.ceil(Math.max(x0, x1) + reach));
	const ya = Math.max(bb.y, Math.floor(Math.min(y0, y1) - reach)), yb = Math.min(bb.y + bb.h, Math.ceil(Math.max(y0, y1) + reach));
	for (let y = ya; y < yb; y++) {
		for (let x = xa; x < xb; x++) {
			const c = clamp((r + 0.5 - segmentDistance(x + 0.5, y + 0.5, x0, y0, dx, dy, len2)) / f, 0, 1);
			op.put(x, y, f > 1 ? smooth(c) : c);
		}
	}
}

// A hard, unantialiased square-ish dot of `size` pixels at every pixel the line from one point to the next passes through
export function pencilSegment(op: Operation, x0: number, y0: number, x1: number, y1: number, size: number) {
	const r		= size / 2;
	const odd	= Math.round(size) % 2 === 1;
	// the dot's centre is a pixel's centre for an odd size, a pixel corner for an even one
	const dot = (cx: number, cy: number) => {
		for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
			for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
				if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 1e-6)
					op.put(x, y, 1);
	};

	// Bresenham over the pixels
	let ix = Math.floor(x0), iy = Math.floor(y0);
	const ex = Math.floor(x1), ey = Math.floor(y1);
	const dx = Math.abs(ex - ix), dy = -Math.abs(ey - iy);
	const sx = ix < ex ? 1 : -1, sy = iy < ey ? 1 : -1;
	let err = dx + dy;
	for (;;) {
		dot(odd ? ix + 0.5 : ix + 1, odd ? iy + 0.5 : iy + 1);
		if (ix === ex && iy === ey)
			break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			ix += sx;
		}
		if (e2 <= dx) {
			err += dx;
			iy += sy;
		}
	}
}

//-----------------------------------------------------------------------------
// shapes
//-----------------------------------------------------------------------------

export type ShapeKind = 'line' | 'rect' | 'ellipse';
export type ShapeFill = 'stroke' | 'fill' | 'both';

// how much of the pixel starting at p lies in [a, b)
const overlap = (p: number, a: number, b: number) => clamp(Math.min(p + 1, b) - Math.max(p, a), 0, 1);

// coverage of the pixel at (px, py) by an ellipse, from an approximation to the distance to its edge
function ellipseCover(px: number, py: number, cx: number, cy: number, rx: number, ry: number) {
	if (rx <= 0 || ry <= 0)
		return 0;
	const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
	const k0 = Math.hypot(dx / rx, dy / ry);
	const k1 = Math.hypot(dx / (rx * rx), dy / (ry * ry));
	return clamp(0.5 - (k1 === 0 ? -Math.min(rx, ry) : k0 * (k0 - 1) / k1), 0, 1);
}

// A shape dragged out from one corner to the other (a line goes between the two points, with `width`).
// The outline is `width` wide inside the shape. `fill` and `stroke` are the colours to use, or null for none.
export function drawShape(op: Operation, kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, width: number, fill: RGBA | null, stroke: RGBA | null) {
	if (kind === 'line') {
		op.colour = stroke ?? fill ?? op.colour;
		brushSegment(op, x0, y0, x1, y1, width, 1);
		return;
	}

	// whole pixels, taking in the one under each end
	const l = Math.floor(Math.min(x0, x1)), t = Math.floor(Math.min(y0, y1));
	const r = Math.floor(Math.max(x0, x1)) + 1, b = Math.floor(Math.max(y0, y1)) + 1;
	const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
	const w = stroke ? Math.max(1, width) : 0;

	const bb = op.bounds();
	for (let y = Math.max(bb.y, t - 1); y < Math.min(bb.y + bb.h, b + 1); y++) {
		for (let x = Math.max(bb.x, l - 1); x < Math.min(bb.x + bb.w, r + 1); x++) {
			let outer: number, inner = 0;
			if (kind === 'rect') {
				outer = overlap(x, l, r) * overlap(y, t, b);
				if (w)
					inner = r - l > 2 * w && b - t > 2 * w ? overlap(x, l + w, r - w) * overlap(y, t + w, b - w) : 0;
			} else {
				outer = ellipseCover(x, y, cx, cy, rx, ry);
				if (w)
					inner = ellipseCover(x, y, cx, cy, rx - w, ry - w);
			}

			const fa = fill ? outer * fill[3] / 255 : 0;
			const sa = stroke ? clamp(outer - inner, 0, 1) * stroke[3] / 255 : 0;
			const a = sa + fa * (1 - sa);
			if (a <= 0)
				continue;
			const f = fill ?? stroke!, s = stroke ?? fill!;
			const k = fa * (1 - sa);
			op.put(x, y, 1, [
				(s[0] * sa + f[0] * k) / a,
				(s[1] * sa + f[1] * k) / a,
				(s[2] * sa + f[2] * k) / a,
				a * 255,
			]);
		}
	}
}

// a linear gradient from one colour at the first point to another at the second, over everything the operation may draw on
export function drawGradient(op: Operation, x0: number, y0: number, x1: number, y1: number, c0: RGBA, c1: RGBA) {
	const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
	if (len2 === 0)
		return;
	const bb = op.bounds();
	for (let y = bb.y; y < bb.y + bb.h; y++) {
		for (let x = bb.x; x < bb.x + bb.w; x++) {
			const t = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2, 0, 1);
			op.put(x, y, 1, [
				c0[0] + (c1[0] - c0[0]) * t,
				c0[1] + (c1[1] - c0[1]) * t,
				c0[2] + (c1[2] - c0[2]) * t,
				c0[3] + (c1[3] - c0[3]) * t,
			]);
		}
	}
}

//-----------------------------------------------------------------------------
// bucket
//-----------------------------------------------------------------------------

// Paint every pixel that is within `tolerance` of the one at (sx, sy): those connected to it (not crossing the selection's
// edge), or all of them
export function floodFill(op: Operation, sx: number, sy: number, tolerance: number, contiguous: boolean) {
	const {data, width, height} = op.image;
	if (sx < 0 || sy < 0 || sx >= width || sy >= height)
		return;

	const s = (sy * width + sx) * 4;
	const target = [data[s], data[s + 1], data[s + 2], data[s + 3]];
	const visited = new Uint8Array(width * height);

	const matches = (x: number, y: number) => {
		const i = y * width + x;
		if (visited[i] || !inSelection(op.selection, x, y))
			return false;
		const o = i * 4;
		if (data[o + 3] === 0 && target[3] === 0)
			return true;
		return Math.abs(data[o] - target[0]) <= tolerance
			&& Math.abs(data[o + 1] - target[1]) <= tolerance
			&& Math.abs(data[o + 2] - target[2]) <= tolerance
			&& Math.abs(data[o + 3] - target[3]) <= tolerance;
	};

	if (!contiguous) {
		const matched: number[] = [];
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				if (matches(x, y))
					matched.push(x, y);
		for (let i = 0; i < matched.length; i += 2)
			op.put(matched[i], matched[i + 1], 1);
		return;
	}

	const stack = [sx, sy];
	while (stack.length) {
		const y = stack.pop()!, x = stack.pop()!;
		if (!matches(x, y))
			continue;

		let x1 = x;
		while (x1 > 0 && matches(x1 - 1, y))
			x1--;

		let up = false, down = false;
		for (let xi = x1; xi < width && matches(xi, y); xi++) {
			visited[y * width + xi] = 1;
			op.put(xi, y, 1);

			if (y > 0) {
				const m = matches(xi, y - 1);
				if (m && !up)
					stack.push(xi, y - 1);
				up = m;
			}
			if (y < height - 1) {
				const m = matches(xi, y + 1);
				if (m && !down)
					stack.push(xi, y + 1);
				down = m;
			}
		}
	}
}

//-----------------------------------------------------------------------------
// whole-area operations
//-----------------------------------------------------------------------------

// the colour of the operation, everywhere it may draw
export function fillArea(op: Operation) {
	const bb = op.bounds();
	for (let y = bb.y; y < bb.y + bb.h; y++)
		for (let x = bb.x; x < bb.x + bb.w; x++)
			op.put(x, y, 1);
}

export function invertArea(op: Operation) {
	const {data, width} = op.image;
	const bb = op.bounds();
	op.blend = 'replace';
	for (let y = bb.y; y < bb.y + bb.h; y++) {
		for (let x = bb.x; x < bb.x + bb.w; x++) {
			const o = (y * width + x) * 4;
			op.put(x, y, 1, [255 - data[o], 255 - data[o + 1], 255 - data[o + 2], data[o + 3]]);
		}
	}
}

//-----------------------------------------------------------------------------
// new images from old
//-----------------------------------------------------------------------------

export function crop(image: Pixels, r: Rect): Pixels {
	return {data: readRect(image, r), width: r.w, height: r.h};
}

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
