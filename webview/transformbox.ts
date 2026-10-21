// The box a free transform is dragged by, which the bitmap editor (paint.ts) and the outline editor (pathedit.ts) share:
// a rectangle taken to a quadrilateral, whose corners and edge middles are handles. Dragging one makes a new quadrilateral
// from the one the drag began with, by the mode: scale (and inside it move, outside it rotate); slide an edge along itself;
// move a corner anywhere; move a corner and its partner across the box the other way.

import { float2, float3, float3x3 } from '@isopodlabs/maths/vector';

export type TransformMode = 'free' | 'skew' | 'distort' | 'perspective';

// the box's corners (top left, top right, bottom right, bottom left), the middles of its edges (the top first), inside it, or outside
export type TransformPart = {kind: 'corner', i: number} | {kind: 'edge', i: number} | {kind: 'inside'} | {kind: 'outside'};

export const transformIcons = {
	flipH:		'<path d="M8 1.5v13" stroke-dasharray="1.5 1.5"/><path d="M6 4L2 12h4zM10 4l4 8h-4z"/>',
	flipV:		'<path d="M1.5 8h13" stroke-dasharray="1.5 1.5"/><path d="M4 6l8-4v4zM4 10l8 4v-4z"/>',
	rotateCW:	'<path d="M12.5 8.5A4.5 4.5 0 1 1 10.5 4.5"/><path d="M10 1.5l1 3-3 1"/>',
	rotateACW:	'<path d="M3.5 8.5A4.5 4.5 0 1 0 5.5 4.5"/><path d="M6 1.5l-1 3 3 1"/>',
	free:		'<rect x="4.5" y="4.5" width="7" height="7"/><path d="M2 7a6 6 0 0 1 5-5"/><path d="M5.5 1.5l1.5.5-.5 1.5"/>',
	skew:		'<path d="M5.5 3.5h9l-4 9h-9z"/>',
	distort:	'<path d="M2.5 3l11 1.5-2 9-8-2z"/>',
	perspective:'<path d="M5.5 3.5h5l3.5 9H2z"/>',
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


export const rectCorners = (r: float2.extent): float2[] => r.corners();

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
	const o = box.min, size = box.extent();
	const at = ([u, v]: number[]) => applyH(m, o.x + u * size.x, o.y + v * size.y);
	return {corners: quad, edges: edgeUV.map(at)};
}

// what a point is on: within `radius` of a handle, or inside the box (on the same side of every edge), or outside
export function partAt(box: float2.extent, quad: float2[], p: float2, radius: number): TransformPart {
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
export function transformCursor(box: float2.extent, quad: float2[], part: TransformPart, mode: TransformMode, inside = 'move') {
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
export function dragMode(part: TransformPart, mode: TransformMode, e: {ctrlKey: boolean, metaKey: boolean}): TransformMode {
	const mac = navigator.platform.toLowerCase().includes('mac');
	return (mac ? e.metaKey : e.ctrlKey) && (part.kind === 'corner' || part.kind === 'edge')
		? (part.kind === 'corner' ? 'distort' : 'skew') : mode;
}

export interface BoxDrag {
	box:	float2.extent;
	q0:		float2[];		// the quadrilateral as it was when the drag began
	part:	TransformPart;
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
		const o = box.min, size = box.extent();
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
		}
	}

	return q.every(c => isFinite(c.x) && isFinite(c.y)) && convexQuad(q) ? q : undefined;
}
