// The box a free transform is dragged by, which the bitmap editor (transform.ts) and the outline editor (pathedit.ts) share:
// a rectangle taken to a quadrilateral, whose corners and edge middles are handles. Dragging one makes a new quadrilateral
// from the one the drag began with, by the mode: scale (and inside it move, outside it rotate); slide an edge along itself;
// move a corner anywhere; move a corner and its partner across the box the other way. Or it is bent by a warp (warp.ts), a grid of
// points pulled about. BoxTransform is one such transform under way, apart from what it carries and how it is drawn, which are its
// owner's.

import { float2, float3, float3x3 } from '@isopodlabs/maths/vector';
import { bezier3 } from '@isopodlabs/maths/geometry';
import { svgFace } from './cascade.js';

export type TransformMode = 'free' | 'skew' | 'distort' | 'perspective' | 'warp';

// the box's corners (top left, top right, bottom right, bottom left), the middles of its edges (the top first), inside it, or outside;
// or for a warp, one of its grid's points, or somewhere on it (across and down it)
export type QuadPart = {kind: 'corner', i: number} | {kind: 'edge', i: number} | {kind: 'inside'} | {kind: 'outside'};
export type TransformPart = QuadPart | {kind: 'grid', i: number} | {kind: 'surface', t: float2};

export const transformIcons = {
	flipH:		'<path d="M8 1.5v13" stroke-dasharray="1.5 1.5"/><path d="M6 4L2 12h4zM10 4l4 8h-4z"/>',
	flipV:		'<path d="M1.5 8h13" stroke-dasharray="1.5 1.5"/><path d="M4 6l8-4v4zM4 10l8 4v-4z"/>',
	rotateCW:	'<path d="M12.5 8.5A4.5 4.5 0 1 1 10.5 4.5"/><path d="M10 1.5l1 3-3 1"/>',
	rotateACW:	'<path d="M3.5 8.5A4.5 4.5 0 1 0 5.5 4.5"/><path d="M6 1.5l-1 3 3 1"/>',
	free:		'<rect x="4.5" y="4.5" width="7" height="7"/><path d="M2 7a6 6 0 0 1 5-5"/><path d="M5.5 1.5l1.5.5-.5 1.5"/>',
	skew:		'<path d="M5.5 3.5h9l-4 9h-9z"/>',
	distort:	'<path d="M2.5 3l11 1.5-2 9-8-2z"/>',
	perspective:'<path d="M5.5 3.5h5l3.5 9H2z"/>',
	warp:		'<path d="M2.5 4.5C5.5 2 10 6 13.5 3.5v8C10 14 5.5 10 2.5 12.5z"/><path d="M6.5 3.7v8.2M9.8 4.4v8" stroke-width="0.8"/>',
};

export const HANDLE		= 7;			// how near a handle the pointer must be (css pixels)
export const cornerUV	= [[0, 0], [1, 0], [1, 1], [0, 1]];
export const edgeUV		= [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

export const rotateCursor = (() => {
	const glyph = '<path d="M12 8a4 4 0 1 1-1.2-2.8"/><path d="M11.5 2.5v3h-3"/>';
	const style = 'fill="none" stroke-linejoin="round" stroke-linecap="round"';
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16"><g ${style} stroke="#fff" stroke-width="3">${glyph}</g><g ${style} stroke="#000" stroke-width="1.2">${glyph}</g></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, alias`;
})();



// where a point goes, and whether it goes anywhere (behind the horizon it does not)
export function applyH(m: float3x3, x: number, y: number): float3 {
	const p = m.mul(float3(x, y, 1));
	return float3(p.x / p.z, p.y / p.z, p.z);
}

// is a quadrilateral one a picture can be put on: convex, turning the same way all round, and not flat
export function convexQuad(q: float2[]) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
		const cross = b.sub(a).cross(c.sub(b));
		if (Math.abs(cross) < 1e-6 || (sign && Math.sign(cross) !== sign))
			return false;
		sign = Math.sign(cross);
	}
	return true;
}

// the homography which takes a rectangle's corners (top left, top right, bottom right, bottom left) to a quadrilateral's
export const rectToQuad = (r: float2.extent, q: float2[]) => float3x3.fromQuad(r, q);

// the handles: the box's corners, and the middles of its edges as the transform has them
export function boxHandles(box: float2.extent, quad: float2[]) {
	const m = rectToQuad(box, quad);
	const o = box.min, size = box.size();
	const at = ([u, v]: number[]) => m.project(o.add(float2(u, v).mul(size)));
	return {corners: quad, edges: edgeUV.map(at)};
}

// what a point is on: within `radius` of a handle, or inside the box (on the same side of every edge), or outside
export function partAt(box: float2.extent, quad: float2[], p: float2, radius: number): QuadPart {
	const {corners, edges} = boxHandles(box, quad);
	const near = (h: float2|float3) => Math.hypot(h.x - p.x, h.y - p.y) <= radius;
	let i = corners.findIndex(near);
	if (i >= 0)
		return {kind: 'corner', i};
	i = edges.findIndex(near);
	if (i >= 0)
		return {kind: 'edge', i};
	const sides = quad.map((a, k) => { const b = quad[(k + 1) % 4]; return Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)); });
	return sides.every(s => s === sides[0]) ? {kind: 'inside'} : {kind: 'outside'};
}

// the cursor over a part; `inside` is for the page to say, as it may be that nothing moves
export function transformCursor(box: float2.extent, quad: float2[], part: QuadPart, mode: TransformMode, inside = 'move') {
	if (part.kind === 'inside')
		return inside;
	if (part.kind === 'outside')
		return rotateCursor;
	if (mode === 'distort' || mode === 'perspective')
		return 'crosshair';
	// a resize cursor across the handle's way out from the middle of the box
	const {corners, edges} = boxHandles(box, quad);
	const h = (part.kind === 'corner' ? corners : edges)[part.i];
	const c = corners.reduce((s, p) => s.add(p.scale(1 / 4)), float2(0, 0));
	const a = ((Math.atan2(h.y - c.y, h.x - c.x) * 180 / Math.PI) % 180 + 180) % 180;
	return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(a / 45) % 4];
}

// the mode a drag is in: Ctrl, or Command on a Mac, makes it distort for a corner and skew for an edge
export function dragMode(part: QuadPart, mode: TransformMode, e: {ctrlKey: boolean, metaKey: boolean}): TransformMode {
	const mac = navigator.platform.toLowerCase().includes('mac');
	return (mac ? e.metaKey : e.ctrlKey) && (part.kind === 'corner' || part.kind === 'edge')
		? (part.kind === 'corner' ? 'distort' : 'skew') : mode;
}

export interface BoxDrag {
	box:	float2.extent;
	q0:		float2[];		// the quadrilateral as it was when the drag began
	part:	QuadPart;
	start:	float2;			// where the pointer was then
	mode:	TransformMode;	// already through dragMode
	shift:	boolean;
	alt:	boolean;
	move?:	(d: float2) => float2;	// how a move of the whole box is made of the pointer's: rounded, say
}

// the quadrilateral for the pointer at p, if it is one the box can be: convex, and where it is not behind the horizon
export function dragQuad(drag: BoxDrag, p: float2): float2[] | undefined {
	const {box, q0, part, start, mode, shift, alt} = drag;
	const add	= (p: float2, d: float2, k = 1) => p.add(d.scale(k));
	const unit	= (a: float2, b: float2) => b.sub(a).scale(1 / (b.sub(a).len() || 1));
	let d = p.sub(start);
	let q: float2[] | undefined;

	if (part.kind === 'inside') {
		if (drag.move)
			d = drag.move(d);
		if (shift)
			d = Math.abs(d.x) > Math.abs(d.y) ? float2(d.x, 0) : float2(0, d.y);
		q = q0.map(c => c.add(d));

	} else if (part.kind === 'outside') {
		const c = q0.reduce((s, c) => s.add(c.scale(1 / 4)), float2(0, 0));
		let a = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(start.y - c.y, start.x - c.x);
		if (shift)
			a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
		const cos = Math.cos(a), sin = Math.sin(a);
		q = q0.map(k => float2(c.x + (k.x - c.x) * cos - (k.y - c.y) * sin, c.y + (k.x - c.x) * sin + (k.y - c.y) * cos));

	} else if (mode === 'free') {
		// scaled in the plane the box is in now, from the opposite side (or with Alt, the middle)
		const h0 = rectToQuad(box, q0), inv0 = h0.inverse();
		const [hu, hv] = (part.kind === 'corner' ? cornerUV : edgeUV)[part.i];
		const [au, av] = alt ? [0.5, 0.5] : [1 - hu, 1 - hv];
		const s = applyH(inv0, p.x, p.y);
		if (s.z <= 0)
			return;
		const o = box.min, size = box.size();
		const u = (s.x - o.x) / size.x, v = (s.y - o.y) / size.y;
		let su = hu === 0.5 ? 1 : (u - au) / (hu - au), sv = hv === 0.5 ? 1 : (v - av) / (hv - av);
		if (shift && part.kind === 'corner') {
			const k = Math.max(Math.abs(su), Math.abs(sv));
			su = (Math.sign(su) || 1) * k;
			sv = (Math.sign(sv) || 1) * k;
		}
		q = cornerUV.map(([cu, cv]) => applyH(h0, o.x + (au + (cu - au) * su) * size.x, o.y + (av + (cv - av) * sv) * size.y).xy);

	} else if (part.kind === 'edge') {
		const a = part.i, b = (part.i + 1) % 4;
		q = q0.map(c => c.dup());
		if (mode === 'distort') {
			q[a] = add(q0[a], d);
			q[b] = add(q0[b], d);
		} else {
			// skew, and perspective too: along the edge
			const along = unit(q0[a], q0[b]), t = d.dot(along);
			q[a] = add(q0[a], along, t);
			q[b] = add(q0[b], along, t);
		}

	} else {
		const i = part.i;
		q = q0.map(c => c.dup());
		if (mode === 'distort') {
			q[i] = add(q0[i], d);
		} else {
			// along whichever of the corner's edges the drag is more along
			const [j, along, t] = [(i + 3) % 4, (i + 1) % 4].map(j => { const u = unit(q0[j], q0[i]); return [j, u, d.dot(u)] as const; })
				.reduce((a, b) => Math.abs(b[2]) > Math.abs(a[2]) ? b : a);
			q[i] = add(q0[i], along, t);
			if (mode === 'perspective')
				q[j] = add(q0[j], along, -t);
			else
				q[(i + 2) % 4] = add(q0[(i + 2) % 4], along, -t);		// (skew: the opposite corner goes the other way, so the box stays a parallelogram, which is affine)
		}
	}

	return q.every(c => isFinite(c.x) && isFinite(c.y)) && convexQuad(q) ? q : undefined;
}

// the modes, for a menu's choice of them: only those that keep the box a parallelogram, for what must stay affine
export function modeChoices(affine = false) {
	return ([
		{value: 'free',			face: svgFace(transformIcons.free),			caption: 'Scale and rotate'},
		{value: 'skew',			face: svgFace(transformIcons.skew),			caption: 'Skew'},
		{value: 'distort',		face: svgFace(transformIcons.distort),		caption: 'Distort'},
		{value: 'perspective',	face: svgFace(transformIcons.perspective),	caption: 'Perspective'},
		{value: 'warp',			face: svgFace(transformIcons.warp),			caption: 'Warp: drag the corners, the handles beside them, or anywhere on the grid'},
	] as {value: TransformMode, face: string, caption: string}[]).slice(0, affine ? 2 : 5);
}

const parallelogram = (q: float2[]) => q[0].sub(q[1]).add(q[2]).sub(q[3]).len() < 1e-6 * (1 + q[0].len());

// A warp's handles, of its grid of 16 points (four rows of four): the corners and the points beside them, which bend its edges. The four
// in the middle are moved by dragging the grid anywhere.
const WARP_HANDLES = [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15];
const WARP_CORNERS = [0, 3, 15, 12];	// (as the box's are: top left, top right, bottom right, bottom left)
const besideCorner: Record<number, number[]> = {0: [1, 4], 3: [2, 7], 12: [8, 13], 15: [11, 14]};

// What a transform carries something by: a homography (a free transform, skew, distort or perspective), or a warp, where a box is
// bent by a bicubic patch. Only geometry: the pixels are carried by raster.ts, on the GPU.

// A box bent by a patch: the point of the box at (u, v) across and down it goes where the patch has it. The patch's rows run down
// the box (v) and each row across it (u), so it is evaluated at v first
export class Warp {
	constructor(readonly box: float2.extent, readonly patch: bezier3<bezier3<float2>>) {}

	// the patch that leaves a box as it is, carried by a homography (exactly, if that is affine)
	static grid(box: float2.extent, m = float3x3.identity()) {
		const size	= box.size();
		return Array.from({length: 16}, (_, k) => m.project(box.min.add(float2((k & 3) / 3, (k >> 2) / 3).mul(size))).xy);
	}
	// the patch that leaves a box as it is, carried by a homography (exactly, if that is affine)
	static load(box: float2.extent, p: float2[]) {
		return new Warp(box, loadPatch(p));
	}

	// where a point of the box is across and down it, and back
	param(p: float2) {
		return p.sub(this.box.min).div(this.box.size());
	}
	point(t: float2) {
		return this.box.min.add(t.mul(this.box.size()));
	}

	// where a point of the box goes
	at(p: float2) {
		const t = this.param(p);
		return this.patch.evaluate(t.y).evaluate(t.x);
	}

	// The same warp of what is `before` away from where the box is, which goes `after` further: p goes to at(p + before) + after
	shifted(before: float2, after = float2(0, 0)) {
		return new Warp(this.box.translate(before.neg()), this.patch.map(row => row.map(c => c.add(after))));
	}

	// Where across and down the patch a point it carries comes from (the nearest of a grid of its points, then Newton's method), if
	// it is on it
	find(p: float2): float2 | undefined {
		const patch = this.patch, N = 16;
		let t = float2(0.5, 0.5), best = Infinity;
		for (let j = 0; j <= N; j++) {
			for (let i = 0; i <= N; i++) {
				const d = patch.evaluate(j / N).evaluate(i / N).sub(p).lensq();
				if (d < best) {
					best = d;
					t = float2(i / N, j / N);
				}
			}
		}
		for (let n = 0; n < 16; n++) {
			const r = patch.evaluate(t.y).evaluate(t.x).sub(p), a = patch.evaluate(t.y).tangent(t.x), b = patch.tangent(t.y).evaluate(t.x), det = a.x * b.y - a.y * b.x;
			if (r.lensq() < 1e-12 || !det)
				break;
			t = t.sub(float2(r.x * b.y - r.y * b.x, a.x * r.y - a.y * r.x).scale(1 / det));
		}
		const e = 1e-6;
		return t.x >= -e && t.y >= -e && t.x <= 1 + e && t.y <= 1 + e && patch.evaluate(t.y).evaluate(t.x).sub(p).len() < 1e-3 * (1 + p.len()) ? t : undefined;
	}

	// what it carries part of the box to: the extent of the bent part (from a grid of its points), if it has any of the box
	bounds(r = this.box) {
		const part = r.intersect(this.box);
		return part.min.x < part.max.x && part.min.y < part.max.y ? sampledExtent(part, p => this.at(p)) : undefined;
	}
}

const loadPatch = (p: float2[]) => new bezier3(
	new bezier3(p[0], p[1], p[2], p[3]),
	new bezier3(p[4], p[5], p[6], p[7]),
	new bezier3(p[8], p[9], p[10], p[11]),
	new bezier3(p[12], p[13], p[14], p[15])
);
const bernstein3 = (t: number) =>
	[(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];


export type Carry = float3x3 | Warp;

// where a point goes
export function carryPoint(c: Carry, p: float2): float2 {
	return c instanceof Warp ? c.at(p) : c.project(p).xy;
}

// the same carry of what is `before` away, which goes `after` further: p goes to carry(p + before) + after
export function shiftCarry(c: Carry, before: float2, after = float2(0, 0)): Carry {
	return c instanceof Warp ? c.shifted(before, after) : float3x3.translate(after).matmul(c).matmul(float3x3.translate(before));
}

// the whole pixels a rectangle is carried over, if it is carried anywhere (not behind the horizon)
export function carriedBounds(c: Carry, r: float2.extent): float2.extent | undefined {
	const ext	= c instanceof Warp ? c.bounds(r) : c.transformExtent(r);
	if (!ext)
		return undefined;
	const e		= 1e-6;
	return new float2.extent(
		float2(Math.floor(ext.min.x + e), Math.floor(ext.min.y + e)),
		float2(Math.ceil(ext.max.x - e), Math.ceil(ext.max.y - e))
	);
}

// where a map takes a rectangle, as near as the extent of where it takes a grid of points over it (`across` by `down` cells) comes
export function sampledExtent(r: float2.extent, at: (p: float2) => float2, across = 32, down = across) {
	const out = new float2.extent, size = r.size();
	for (let j = 0; j <= down; j++)
		for (let i = 0; i <= across; i++)
			out.add(at(r.min.add(float2(i / across, j / down).mul(size))));
	return out;
}

// the homography, and the warp done before it (if there is one): what a shader carries a plane by
export function planar(c: Carry): [float3x3, Warp | undefined] {
	return c instanceof Warp ? [float3x3.identity(), c] : [c, undefined];
}

// A free transform under way: a box (in whatever space its owner works in) taken to a quadrilateral, or bent by a warp. One that is to stay
// affine cannot be distorted or warped (by its mode, or by Ctrl/Command on a corner): its quadrilateral is always a parallelogram.
export class BoxTransform {
	quad:	float2[];
	grid:	float2[] | undefined;		// the warp's control points, while it is a warp
	private current: TransformMode = 'free';
	private bent	= false;			// the warp has been dragged: it is more than the quadrilateral

	constructor(readonly box: float2.extent, mode: TransformMode = 'free', readonly affine = false) {
		this.quad = box.corners();
		this.setMode(mode);
	}

	get mode() {
		return this.current;
	}

	// Change the mode, which keeps what it has been made so far; false if it cannot be changed in place, as a warp that has been bent is
	// more than a quadrilateral: the owner is to apply it, and begin another
	setMode(mode: TransformMode) {
		if (this.affine && mode !== 'skew')
			mode = 'free';
		if (mode === 'warp') {
			this.grid ??= Warp.grid(this.box, this.matrix);
		} else if (this.grid) {
			if (this.bent)
				return false;
			this.grid = undefined;
		}
		this.current = mode;
		return true;
	}

	// what takes the box to the quadrilateral
	get matrix() {
		return float3x3.fromQuad(this.box, this.quad);
	}

	private get warp() {
		return Warp.load(this.box, this.grid!);
	}

	// what it carries the box by
	get carry(): Carry {
		return this.grid ? this.warp : this.matrix;
	}

	// where the box's corners have gone (top left, top right, bottom right, bottom left)
	get corners() {
		return this.grid ? WARP_CORNERS.map(k => this.grid![k]) : this.quad;
	}

	// whether it is anywhere but where it began
	get moved() {
		const same = (a: float2[], b: float2[]) => a.every((p, i) => Math.abs(p.x - b[i].x) <= 1e-9 && Math.abs(p.y - b[i].y) <= 1e-9);
		return this.grid ? !same(this.grid, Warp.grid(this.box)) : !same(this.quad, this.box.corners());
	}

	// what a point is on, within `radius` of a handle
	part(p: float2, radius: number): TransformPart {
		if (!this.grid)
			return partAt(this.box, this.quad, p, radius);
		const i = WARP_HANDLES.find(k => this.grid![k].sub(p).len() <= radius);
		if (i !== undefined)
			return {kind: 'grid', i};
		const t = this.warp.find(p);
		return t ? {kind: 'surface', t} : {kind: 'outside'};
	}

	// the cursor over a part (`inside` is the owner's to say, as it may be that nothing moves)
	cursor(part: TransformPart, inside = 'move') {
		return part.kind === 'grid' ? 'crosshair'
			: part.kind === 'surface' ? 'move'
			: this.grid ? 'default'
			: transformCursor(this.box, this.quad, part as QuadPart, this.mode, inside);
	}

	// A drag begun at `start` on a part: for each place the pointer comes to after, with the keys held then, the quadrilateral (or the
	// warp's grid) is made anew from the one the drag began with; whether it changed (a quadrilateral the box cannot be leaves it as it
	// was). `move` is how a move of the whole box is made of the pointer's: rounded, say.
	drag(part: TransformPart, start: float2, move?: (d: float2) => float2): (p: float2, e: {shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean}) => boolean {
		if (this.grid) {
			const g0 = this.grid.map(p => p.dup());
			//const patch = loadPatch(g0);

			// a handle (and a corner, the two beside it, so its edges' bends go with it), or the surface: the least change to the points but
			// the corners (which stay where they are) that takes the point of it under the pointer with the pointer
			let weight: (k: number) => number;
			if (part.kind === 'grid') {
				const moved = [part.i, ...besideCorner[part.i] ?? []];
				weight = k => moved.includes(k) ? 1 : 0;
			} else if (part.kind === 'surface') {
				const bu = bernstein3(part.t.x), bv = bernstein3(part.t.y);
				const w = (k: number) => WARP_CORNERS.includes(k) ? 0 : bu[k & 3] * bv[k >> 2];
				const sum = g0.reduce((s, _, k) => s + w(k) ** 2, 0);
				weight = k => w(k) / sum;
			} else {
				return () => false;
			}
			return p => {
				const d = p.sub(start);
				this.grid = g0.map((c, k) => c.add(d.scale(weight(k))));
				this.bent = true;
				return true;
			};
		}
		const q0 = this.quad.map(p => p.dup());
		return (p, e) => {
			const q = dragQuad({box: this.box, q0, part: part as QuadPart, start, mode: dragMode(part as QuadPart, this.mode, e), shift: e.shiftKey, alt: e.altKey, move}, p);
			if (!q || (this.affine && !parallelogram(q)))
				return false;
			this.quad = q;
			return true;
		};
	}

	// What is drawn of it: its edge (a closed outline), lines through it in thirds (and for a warp, from its corners to the handles beside
	// them), and its handles (the corners, then the middles of its edges; or the warp's)
	outline(): {edge: float2[], lines: [float2, float2][], handles: float2[]} {
		const grid = this.grid;
		if (grid) {
			const patch		= loadPatch(grid), N = 24;
			const curve		= (f: (s: number) => float2) => Array.from({length: N + 1}, (_, i) => f(i / N));
			const segments	= (pts: float2[]) => pts.slice(1).map((p, i) => [pts[i], p] as [float2, float2]);
			const v0 = patch.evaluate(0), v1 = patch.evaluate(1);
			const u0 = patch.map(c => c.c0), u1 = patch.map(c => c.c3);
			return {
				edge:		[
					...curve(s => v0.evaluate(s)), ...curve(s => u1.evaluate(s)).slice(1),
					...curve(s => v1.evaluate(s)).slice(1), ...curve(s => u0.evaluate(1 - s)).slice(1, -1),
				],
				lines:		[
					...[1 / 3, 2 / 3].flatMap(t => [...segments(curve(s => patch.evaluate(s).evaluate(t))), ...segments(curve(s => patch.evaluate(t).evaluate(s)))]),
					...Object.entries(besideCorner).flatMap(([c, beside]) => beside.map(k => [grid[+c], grid[k]] as [float2, float2])),
				],
				handles:	WARP_HANDLES.map(k => grid[k]),
			};
		}
		const m = this.matrix, o = this.box.min, size = this.box.size();
		const at = (u: number, v: number) => m.project(o.add(float2(u, v).mul(size))).xy;
		const {corners, edges} = boxHandles(this.box, this.quad);
		return {
			edge:		corners,
			lines:		[1 / 3, 2 / 3].flatMap(t => [[at(t, 0), at(t, 1)], [at(0, t), at(1, t)]] as [float2, float2][]),
			handles:	[...corners, ...edges.map(e => e.xy)],
		};
	}
}
