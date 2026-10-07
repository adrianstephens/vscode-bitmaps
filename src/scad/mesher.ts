// Turns the field into triangles, for a slicer or anything else that wants a surface rather than a function.
//
// It is dual contouring: the field is sampled at the corners of cubes, and wherever it changes sign along an edge the
// surface crosses that edge. Each cube the surface passes through gets one vertex, placed where the planes through its
// edge crossings (each perpendicular to the field's gradient there) meet -- which is what keeps a sharp edge or corner
// sharp, where marching cubes would round it off -- and each crossed edge joins the vertices of the cubes around it.
//
// The cubes are the leaves of an octree, divided only where the surface is: see the section below. meshAdaptive stops
// dividing wherever a bigger cube describes the surface well enough, which is what the export uses; meshUniform divides
// every cube the surface passes through down to the finest, which is simple and predictable (the tests measure volumes
// with it). They are the one mesher, differing only in that choice.
import { float2, float3, float3x4, safeNormalise } from '@isopodlabs/maths/vector';
import { eigenSymmetric } from '@isopodlabs/maths/linear';
import { Sdf, evalSdf, bounds3, surfaceNormal, faceFrame, polygonDistance2, inverseOrIdentity, planeBrush, polyhedronOf, PlaneBrush } from './sdf';
import type { Mesh } from '@isopodlabs/binary_meshes';

//-----------------------------------------------------------------------------
// what either makes: a mesh, a vertex for a cube, and whether the result is closed
//-----------------------------------------------------------------------------

export interface MeshStats {
	triangles:		number;
	open:			number;								// edges with a triangle on one side only: holes
	nonManifold:	number;								// edges shared by more than two triangles
	inconsistent:	number;								// edges the two triangles traverse the same way: flipped faces
	volume:			number;								// signed, in the model's units cubed
}

export class Cancelled extends Error {
	constructor() { super('cancelled'); }
}

// Where the planes {n_i . x = n_i . p_i} meet, nearest the mean of the p_i when they do not meet at a point (a flat face
// is only one plane; an edge is two). The directions the planes do not pin down are dropped rather than solved, which is
// what stops a nearly-flat patch from throwing its vertex a long way off.
export function solveQef(points: float3[], normals: float3[]): float3 {
	let c = float3(0, 0, 0);
	for (const p of points)
		c = c.add(p);
	c = c.scale(1 / points.length);
	const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	const r = [0, 0, 0];
	points.forEach((p, i) => {
		const n = [normals[i].x, normals[i].y, normals[i].z];
		const b = normals[i].dot(p.sub(c));
		for (let a = 0; a < 3; a++) {
			for (let k = 0; k < 3; k++)
				m[a][k] += n[a] * n[k];
			r[a] += n[a] * b;
		}
	});
	const {values, vectors} = eigenSymmetric(m);
	const top = Math.max(...values.map(Math.abs));
	let x = [0, 0, 0];
	values.forEach((lambda, k) => {
		if (Math.abs(lambda) > 0.1 * top) {
			const along = (vectors[k][0] * r[0] + vectors[k][1] * r[1] + vectors[k][2] * r[2]) / lambda;
			for (let a = 0; a < 3; a++)
				x[a] += along * vectors[k][a];
		}
	});
	return float3(c.x + x[0], c.y + x[1], c.z + x[2]);
}

// Is it a closed surface a slicer will accept: every edge shared by exactly two faces, running opposite ways?
export function checkMesh(poly: Mesh): MeshStats {
	const {points, faces} = poly;
	const nv = points.length;
	const edges = new Map<number, number>();		// undirected edge -> +1 for each traversal low->high, and 1000 for each face
	for (const f of faces)
		f.forEach((a, e) => {
			const b = f[(e + 1) % f.length], key = Math.min(a, b) * nv + Math.max(a, b);
			edges.set(key, (edges.get(key) ?? 0) + 1000 + (a < b ? 1 : -1));
		});
	let open = 0, nonManifold = 0, inconsistent = 0;
	for (const v of edges.values()) {
		const uses = Math.round(v / 1000);
		const net = v - uses * 1000;
		if (uses === 1)
			++open;
		else if (uses > 2)
			++nonManifold;
		else if (net !== 0)
			++inconsistent;
	}
	// each face fanned from its first corner, as writeStl writes it
	let volume = 0, triangles = 0;
	for (const f of faces)
		for (let k = 1; k + 1 < f.length; k++, triangles++)
			volume += points[f[0]].dot(points[f[k]].cross(points[f[k + 1]])) / 6;
	return {triangles, open, nonManifold, inconsistent, volume};
}

// The side of the finest cube, and where the grid starts: two cubes outside the model's box and a hair off a multiple of
// the cube, since a surface exactly through grid corners puts the field at zero there, which is no side to be on.
function gridFrame(sdf: Sdf, cells: number) {
	const box = bounds3(sdf);
	if (!box)
		throw new Error('the model has no bounds to mesh');
	const extent = box.max.sub(box.min);
	const h = Math.max(extent.x, extent.y, extent.z) / cells;
	return {h, origin: box.min.sub(float3(2 * h + 0.0137 * h, 2 * h + 0.0171 * h, 2 * h + 0.0113 * h))};
}

// hand the thread back now and then, so the editor stays alive and a cancel can be seen
function pacer(cancelled?: () => boolean) {
	let last = Date.now();
	return async () => {
		if (Date.now() - last < 40)
			return;
		await new Promise(resolve => setTimeout(resolve, 0));
		last = Date.now();
		if (cancelled?.())
			throw new Cancelled();
	};
}

// the twelve edges of a cube as its two corners (bit 0 of a corner is x, 1 is y, 2 is z) and the axis it runs along
const CUBE_EDGES: [number, number, number][] = [
	[0, 1, 0], [2, 3, 0], [4, 5, 0], [6, 7, 0],
	[0, 2, 1], [1, 3, 1], [4, 6, 1], [5, 7, 1],
	[0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2],
];
const cornerOffset = (c: number) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];

// Where the field crosses zero between a and b, whose values fa and fb have opposite signs. Regula falsi on the bracket,
// keeping the point where the field came nearest to zero: on a plane the first guess is exact, and near a smooth
// surface a few steps do. Where the field has a kink on the edge (the nearest face of a box changing over) the secant
// creeps, so every third step is a bisection, which halves the bracket whatever the field does. Within a millionth of
// the finest cube h is as near as it needs to be.
function edgeCrossing(field: (p: float3) => number, a: float3, b: float3, fa: number, fb: number, h: number): float3 {
	let ta = 0, tb = 1, t = 0, best = Infinity;
	for (let it = 0; it < 30; it++) {
		let guess = it % 3 === 2 ? (ta + tb) / 2 : ta + (tb - ta) * fa / (fa - fb);
		if (!(guess > ta && guess < tb))
			guess = (ta + tb) / 2;
		const f = field(a.add(b.sub(a).scale(guess)));
		if (Math.abs(f) < best) {
			best = Math.abs(f);
			t = guess;
		}
		if (Math.abs(f) < 1e-6 * h)
			break;
		if ((f < 0) === (fa < 0)) { ta = guess; fa = f; } else { tb = guess; fb = f; }
	}
	return a.add(b.sub(a).scale(t));
}

// the vertex of a cube at lo with this side, from the crossings on its edges, kept inside the cube: one that wandered
// out would fold the surface over its neighbour
function cubeVertex(hits: float3[], normals: float3[], lo: float3, side: number): float3 {
	const v = solveQef(hits, normals);
	return float3(Math.min(lo.x + side, Math.max(lo.x, v.x)), Math.min(lo.y + side, Math.max(lo.y, v.y)), Math.min(lo.z + side, Math.max(lo.z, v.z)));
}

// The triangles of the quad of vertices round a crossed edge, in winding order: a cube named twice in a row (a larger
// one beside smaller ones) is named once, and four are split along the better diagonal, the one `measure` finds smaller
// -- by default the shorter, which keeps the triangles from being needlessly thin.
function quadTriangles(quad: number[], points: float3[], measure = (a: float3, b: float3) => a.sub(b).len()): number[][] {
	const fan = quad.filter((x, i) => x !== quad[(i + 1) % quad.length]);
	if (fan.length < 4)
		return fan.length === 3 ? [fan] : [];
	return measure(points[fan[0]], points[fan[2]]) <= measure(points[fan[1]], points[fan[3]])
		? [[fan[0], fan[1], fan[2]], [fan[0], fan[2], fan[3]]]
		: [[fan[0], fan[1], fan[3]], [fan[1], fan[2], fan[3]]];
}

// Every corner of a cube on one side says there is nothing in it, but a wall (or a gap) thinner than the cube passes
// between the corners without touching one, which one vertex per cube cannot describe. If the surface is near enough to
// be in the cube at all, the other sign at the centre is such a wall; and so is the surface itself, found by stepping from
// the nearest corner down the gradient by its value. That is where a distance field puts the nearest surface, and a field
// that is only a bound falls short of it -- so the point counts only if the field there is near zero or has turned over.
function thinWall(fs: number[], lo: float3, side: number, field: (p: float3) => number, normal: (p: float3) => float3) {
	const near = fs.reduce((best, f, c) => Math.abs(f) < Math.abs(fs[best]) ? c : best, 0);
	if (!(Math.abs(fs[near]) < side * 0.8660254))
		return false;
	const [ci, cj, ck] = cornerOffset(near), eps = 1e-9 * side;
	if ((field(lo.add(float3(side / 2, side / 2, side / 2))) < 0) !== (fs[0] < 0))
		return true;
	const q = lo.add(float3(ci * side, cj * side, ck * side)).sub(normal(lo.add(float3(ci * side, cj * side, ck * side))).scale(fs[near]));
	// on the cube's boundary counts: stepping from a corner along one axis leaves the other two on it
	const within = [q.x - lo.x, q.y - lo.y, q.z - lo.z].every(d => d >= -eps && d <= side + eps);
	const fq = within ? field(q) : 0;
	return within && (Math.abs(fq) < 0.01 * side || (fq < 0) !== (fs[0] < 0));
}

//-----------------------------------------------------------------------------
// the mesher: an octree of cubes, small only where the surface needs them (or everywhere it is, for meshUniform)
//-----------------------------------------------------------------------------

// An adaptive mesher: fine cells only where the surface needs them, decided from what the model is made of rather than
// from how it happens to sample.
//
// A grid of cubes all the finest size pays for that resolution everywhere, flat faces included. This works down an
// octree, and at each cell asks which of the model's terms can reach it at all. Every term's field is a lower bound on
// the distance to its surface, so over a cell of circumradius r it lies within f(centre) +/- r, and a term whose lowest
// value is above another's highest cannot be the minimum of a union anywhere in the cell (the same for the other
// combinators). What survives is the handful of terms that could shape the surface there. A cell may then stop being
// divided if a *single* term remains and either
//
//   * it is provably one plane -- a certificate from the term itself, in the way a box's side or an offset face is --
//     or
//   * the dual-contouring vertex for the cell is within the tolerance of every plane through the surface crossings on its
//     edges, and of the surface itself (the usual test for a smooth term, where the error is what refining would reduce).
//
// Anything with two or more terms in play is a crease or a junction and is divided to the finest size, which costs in
// proportion to its length rather than to an area. The mesh is then made from the leaves by dual contouring on the
// octree (Ju et al.), which joins cells of different sizes without cracks.
//
// A Minkowski sum of a convex polyhedron and a ball is the one place this needs help from the source: as a single field
// its flat offset faces and its rounded rims cannot be told apart from outside. It is exactly the union of the body,
// a slab over each face, a cylinder along each edge and a ball at each vertex, so it is lowered into those, and the
// flat part of a slab is then a term of its own.

export interface AdaptiveOptions {
	cells:			number;								// the finest cubes along the longest side of the model
	tolerance:		number;								// how far the surface may be from the mesh where cubes are not divided further
	progress?:		(message: string) => void;
	cancelled?:		() => boolean;
	thin?:			boolean;							// look for walls thinner than the finest cube (default: yes)
}

export interface AdaptiveMesh extends Mesh {
	cell:			number;								// the side of a cube
	thin:			number;								// cubes holding a wall or gap thinner than they are, which the mesh has missed
	leaves:			number;								// cubes the mesh was made from
	finest:			number;								// how many of them are as small as they get
}

function normalize(v: float3) {
	return safeNormalise(v) ?? float3(0, 0, 0);
}

//-----------------------------------------------------------------------------
// the terms a cell is asked about
//-----------------------------------------------------------------------------

type Term =
	| {t: 'leaf', sdf: Sdf}									// anything the field already knows how to evaluate
	| {t: 'slab', n: float3, d: number, r: number, centre: float3, u: float3, v: float3, poly: float2[]}
	| {t: 'cyl', mid: float3, dir: float3, half: number, r: number}
	| {t: 'ball', c: float3, r: number}
	| {t: 'band', dir: float3, mid: number, half: number}
	| {t: 'union', kids: Term[]}
	| {t: 'inter', kids: Term[]}
	| {t: 'neg', body: Term}									// the negated field: a cut, seen from the difference it is taken from
	| {t: 'domain', inv: float3x4, scale: number, sigma: number, body: Term};

// how far a transform can stretch a vector: the largest singular value of its linear part
function stretch(m: float3x4): number {
	const c = [m.x, m.y, m.z];
	const g = c.map(a => c.map(b => a.dot(b)));
	return Math.sqrt(Math.max(...eigenSymmetric(g).values));
}

const leaf = (sdf: Sdf): Term => ({t: 'leaf', sdf});

// The exact pieces of a convex polyhedron grown by a ball: the body, a slab over each face (its polygon carried a radius
// out along the normal, and a radius in, where every point is still within r of the face and so inside the sum -- the
// inner half is there so that its far plane lies deep in the body rather than touching the body's own face), a cylinder
// along each edge, a ball at each vertex. Any point within r of the body is
// within r of its boundary if it is outside, and the boundary is the faces, so the union of the faces' neighbourhoods
// with the body is the whole sum.
function lowerDilate(s: Sdf & {k: 'dilate'}): Term | undefined {
	if (!s.support.q)
		return lowerGrown(s.body, s.support.r);
	const brush = planeBrush(s.body, s.support);
	return brush && lowerBrush(brush, s.support.r);
}

// A prism grown by a disc lying square to its axis: the prism's cross-section grown by the disc, kept between the caps,
// which do not move. The grown cross-section is the cross-section, a slab over each side, and a cylinder along the axis
// at each corner, and the caps are a band -- so what the field measures as one distance is made of terms that are each
// a plane, a cylinder or nothing at all.
function lowerBrush(b: PlaneBrush, r: number): Term | undefined {
	const sides = b.sides;
	if (sides.k !== 'planes' || sides.faces.some(f => !f || f.length < 3))
		return undefined;
	const along = (p: float3) => p.dot(b.dir);
	const withAxis = (p: float3, value: number) => p.sub(b.dir.scale(along(p) - value));
	const tall = b.half + 2 * r + 1;			// far enough along the axis that only the caps end them
	const kids: Term[] = [leaf(sides)];
	const corners = new Map<string, float3>();
	for (let i = 0; i < sides.faces.length; i++) {
		const pl = sides.planes[i];
		// the side carried past the caps, so that it is the band that ends it
		const face = sides.faces[i].map(p => withAxis(p, along(p) >= b.mid ? b.mid + tall : b.mid - tall));
		const frame = faceFrame(face, pl.n);
		if (!frame)
			return undefined;
		const poly = [frame.tris[0][0], frame.tris[0][1], ...frame.tris.map(t => t[2])];
		kids.push({t: 'slab', n: pl.n, d: pl.d, r, centre: frame.centre, u: frame.u, v: frame.v, poly});
		for (const p of sides.faces[i]) {
			const at = withAxis(p, b.mid);
			corners.set(`${Math.round(at.x * 1e6)},${Math.round(at.y * 1e6)},${Math.round(at.z * 1e6)}`, at);
		}
	}
	for (const c of corners.values())
		kids.push({t: 'cyl', mid: c, dir: b.dir, half: tall, r});
	return {t: 'inter', kids: [{t: 'band', dir: b.dir, mid: b.mid, half: b.half}, {t: 'union', kids}]};
}

// `body` grown by a ball of radius r, if it is a convex polyhedron under transforms that keep a ball a ball. A rotation
// or an even scale does: growing the transformed body by r is the transformed body grown by r in its own units.
function lowerGrown(body: Sdf, r: number): Term | undefined {
	if (body.k === 'material')
		return lowerGrown(body.body, r);
	if (body.k === 'domain') {
		const inv = inverseOrIdentity(body.m);
		const c = [inv.x, inv.y, inv.z];
		const g = c.map(a => c.map(b => a.dot(b)));
		const values = eigenSymmetric(g).values;
		const hi = Math.sqrt(Math.max(...values)), lo = Math.sqrt(Math.max(0, Math.min(...values)));
		if (hi - lo > 1e-9 * hi)
			return undefined;
		const inner = lowerGrown(body.body, r * hi);
		return inner && {t: 'domain', inv, scale: body.scale, sigma: hi, body: inner};
	}
	const shape = polyhedronOf(body);
	if (!shape)
		return undefined;
	const kids: Term[] = [leaf(body)];
	const key = (p: float3) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`;
	const edges = new Map<string, [float3, float3]>(), verts = new Map<string, float3>();
	for (let i = 0; i < shape.faces.length; i++) {
		const face = shape.faces[i], pl = shape.planes[i];
		const frame = faceFrame(face, pl.n);
		if (!frame)
			return undefined;
		// the polygon in the face's own coordinates, from the fan of triangles it was cut into
		const poly = [frame.tris[0][0], frame.tris[0][1], ...frame.tris.map(t => t[2])];
		kids.push({t: 'slab', n: pl.n, d: pl.d, r, centre: frame.centre, u: frame.u, v: frame.v, poly});
		for (let j = 0; j < face.length; j++) {
			const a = face[j], b = face[(j + 1) % face.length];
			const ka = key(a), kb = key(b);
			edges.set(ka < kb ? ka + '|' + kb : kb + '|' + ka, [a, b]);
			verts.set(ka, a);
		}
	}
	for (const [a, b] of edges.values()) {
		const d = b.sub(a), len = d.len();
		if (len > 1e-12)
			kids.push({t: 'cyl', mid: a.add(b).scale(0.5), dir: d.scale(1 / len), half: len / 2, r});
	}
	for (const c of verts.values())
		kids.push({t: 'ball', c, r});
	return {t: 'union', kids};
}

function lower(s: Sdf): Term {
	switch (s.k) {
		case 'union': case 'intersection': {
			const kids = s.children.filter(c => c.k !== 'empty').map(lower);
			return kids.length === 1 ? kids[0] : {t: s.k === 'union' ? 'union' : 'inter', kids};
		}
		case 'difference': {
			// the base with each cut taken away is the largest of the base and the cuts' negations
			const cuts = s.cuts.filter(c => c.k !== 'empty').map(c => ({t: 'neg', body: lower(c)} as Term));
			return cuts.length ? {t: 'inter', kids: [lower(s.base), ...cuts]} : lower(s.base);
		}
		case 'domain': {
			const inv = inverseOrIdentity(s.m);
			return {t: 'domain', inv, scale: s.scale, sigma: stretch(inv), body: lower(s.body)};
		}
		case 'material':
			return lower(s.body);
		case 'dilate':
			return lowerDilate(s) ?? leaf(s);
		default:
			return leaf(s);
	}
}

function evalT(t: Term, p: float3): number {
	switch (t.t) {
		case 'leaf':
			return evalSdf(t.sdf, p);
		case 'slab': {
			const perp = t.n.dot(p) - t.d;
			const w = p.sub(t.centre);
			const inside = polygonDistance2(w.dot(t.u), w.dot(t.v), [t.poly]);
			return Math.max(Math.abs(perp) - t.r, inside);
		}
		case 'cyl': {
			const w = p.sub(t.mid);
			const ax = w.dot(t.dir);
			return Math.max(Math.abs(ax) - t.half, w.sub(t.dir.scale(ax)).len() - t.r);
		}
		case 'ball':
			return p.sub(t.c).len() - t.r;
		case 'band':
			return Math.abs(p.dot(t.dir) - t.mid) - t.half;
		case 'union': {
			let best = 1e20;
			for (const k of t.kids)
				best = Math.min(best, evalT(k, p));
			return best;
		}
		case 'inter': {
			let best = -1e20;
			for (const k of t.kids)
				best = Math.max(best, evalT(k, p));
			return best;
		}
		case 'neg':
			return -evalT(t.body, p);
		case 'domain':
			return evalT(t.body, t.inv.mulPos(p)) * t.scale;
	}
}

function numericNormal(t: Term, p: float3, eps: number): float3 {
	return normalize(float3(
		evalT(t, float3(p.x + eps, p.y, p.z)) - evalT(t, float3(p.x - eps, p.y, p.z)),
		evalT(t, float3(p.x, p.y + eps, p.z)) - evalT(t, float3(p.x, p.y - eps, p.z)),
		evalT(t, float3(p.x, p.y, p.z + eps)) - evalT(t, float3(p.x, p.y, p.z - eps))));
}

// the outward normal at a point on the surface, from whichever term decides the field there
function normalT(t: Term, p: float3, eps: number): float3 {
	switch (t.t) {
		case 'leaf':
			return surfaceNormal(t.sdf, p, eps);
		case 'slab': {
			const perp = t.n.dot(p) - t.d;
			const w = p.sub(t.centre);
			const inside = polygonDistance2(w.dot(t.u), w.dot(t.v), [t.poly]);
			if (Math.abs(perp) - t.r >= inside)
				return perp < 0 ? t.n.scale(-1) : t.n;
			return numericNormal(t, p, eps);
		}
		case 'cyl': {
			const w = p.sub(t.mid);
			const ax = w.dot(t.dir);
			const radial = w.sub(t.dir.scale(ax));
			if (radial.len() - t.r >= Math.abs(ax) - t.half && radial.len() > 1e-12)
				return normalize(radial);
			return ax < 0 ? t.dir.scale(-1) : t.dir;
		}
		case 'ball':
			return normalize(p.sub(t.c));
		case 'band': {
			return p.dot(t.dir) - t.mid < 0 ? t.dir.scale(-1) : t.dir;
		}
		case 'union': case 'inter': {
			let best = t.t === 'union' ? Infinity : -Infinity, child = t.kids[0];
			for (const k of t.kids) {
				const v = evalT(k, p);
				if (t.t === 'union' ? v < best : v > best) {
					best = v;
					child = k;
				}
			}
			return normalT(child, p, eps);
		}
		case 'neg':
			return normalT(t.body, p, eps).scale(-1);
		case 'domain': {
			const nb = normalT(t.body, t.inv.mulPos(p), eps);
			return normalize(float3(t.inv.x.dot(nb), t.inv.y.dot(nb), t.inv.z.dot(nb)));
		}
	}
}

//-----------------------------------------------------------------------------
// which terms can matter in a cell
//-----------------------------------------------------------------------------

interface Pruned { t: Term, lo: number, hi: number }

// The term as it is inside the ball (c, r), with the bounds its field keeps there. A term the field cannot make the
// deciding one anywhere in the ball is dropped, and a combinator left with one term is that term.
function prune(t: Term, c: float3, r: number): Pruned {
	switch (t.t) {
		case 'union': {
			const got = t.kids.map(k => prune(k, c, r));
			let minHi = Infinity;
			for (const g of got)
				minHi = Math.min(minHi, g.hi);
			const slack = 1e-9 * (1 + r);
			// A term that is positive throughout the ball cannot be zero anywhere in it, so it has no part in the surface
			// however it compares with the others: the union has the same sign, and the same zero set, without it.
			let keep = got.filter(g => g.lo <= minHi + slack && g.lo <= 0);
			if (!keep.length)
				keep = got.filter(g => g.lo <= minHi + slack);
			const lo = Math.min(...keep.map(g => g.lo));
			if (keep.length === 1)
				return {t: keep[0].t, lo, hi: minHi};
			return {t: keep.length === t.kids.length && keep.every((g, i) => g.t === t.kids[i]) ? t : {t: 'union', kids: keep.map(g => g.t)}, lo, hi: minHi};
		}
		case 'inter': {
			const got = t.kids.map(k => prune(k, c, r));
			let maxLo = -Infinity;
			for (const g of got)
				maxLo = Math.max(maxLo, g.lo);
			const slack = 1e-9 * (1 + r);
			// and the other way about: a term that is negative throughout cannot be the largest where the largest is zero
			let keep = got.filter(g => g.hi >= maxLo - slack && g.hi >= 0);
			if (!keep.length)
				keep = got.filter(g => g.hi >= maxLo - slack);
			const hi = Math.max(...keep.map(g => g.hi));
			if (keep.length === 1)
				return {t: keep[0].t, lo: maxLo, hi};
			return {t: keep.length === t.kids.length && keep.every((g, i) => g.t === t.kids[i]) ? t : {t: 'inter', kids: keep.map(g => g.t)}, lo: maxLo, hi};
		}
		case 'neg': {
			const inner = prune(t.body, c, r);
			return {t: inner.t === t.body ? t : {t: 'neg', body: inner.t}, lo: -inner.hi, hi: -inner.lo};
		}
		case 'domain': {
			// the ball, carried into the body's frame, sits inside a ball stretched by at most sigma
			const inner = prune(t.body, t.inv.mulPos(c), r * t.sigma);
			return {t: inner.t === t.body ? t : {...t, body: inner.t}, lo: inner.lo * t.scale, hi: inner.hi * t.scale};
		}
		default: {
			const v = evalT(t, c);
			// The bounds rest on the field changing no faster than the distance moved. A Minkowski sum with a brush that is
			// not a ball is measured with the brush's support along the body's normal, which changes abruptly where that
			// normal does, so for one of those (which is not lowered into terms that are exact) they are widened.
			const reach = t.t === 'leaf' && t.sdf.k === 'dilate' && t.sdf.support.q ? 3 * r : r;
			return {t, lo: v - reach, hi: v + reach};
		}
	}
}

function describe(t: Term): string {
	switch (t.t) {
		case 'union': case 'inter': {
			const c: Record<string, number> = {};
			for (const k of t.kids) {
				const d = describe(k);
				c[d] = (c[d] || 0) + 1;
			}
			return t.t + '(' + Object.entries(c).map(([k, v]) => v > 1 ? v + 'x' + k : k).join(',') + ')';
		}
		case 'neg': return '-' + describe(t.body);
		case 'domain': return 'dom.' + describe(t.body);
		case 'leaf': return t.sdf.k;
		default: return t.t;
	}
}

// a term that is one primitive rather than a combination of several
function single(t: Term): boolean {
	switch (t.t) {
		case 'union': case 'inter': return false;
		case 'domain': case 'neg': return single(t.body);
		default: return true;
	}
}

// Is the surface of this term inside the eight corners (in the term's own frame) provably a single plane? The tests are
// on convex functions of the point, so they are settled by the corners.
function flat(t: Term, corners: float3[]): boolean {
	switch (t.t) {
		case 'neg':
			return flat(t.body, corners);
		case 'domain':
			return flat(t.body, corners.map(c => t.inv.mulPos(c)));
		case 'leaf': {
			const s = t.sdf;
			if (s.k !== 'box')
				return false;
			const c = s.center ? [0, 0, 0] : [s.size.x / 2, s.size.y / 2, s.size.z / 2];
			const h = [s.size.x / 2, s.size.y / 2, s.size.z / 2];
			const at = (p: float3, a: number) => (a === 0 ? p.x : a === 1 ? p.y : p.z) - c[a];
			// one side of the box, with the point inside the other two extents throughout
			for (let a = 0; a < 3; a++) {
				const b = (a + 1) % 3, d = (a + 2) % 3;
				const sides = corners.map(p => Math.sign(at(p, a)));
				if (!sides.every(x => x === sides[0] && x !== 0))
					continue;
				if (corners.every(p => Math.abs(at(p, b)) < h[b] && Math.abs(at(p, d)) < h[d]))
					return true;
			}
			return false;
		}
		case 'band': {
			// the cell on one side of the middle: only the cap on that side can be in it
			const at = (p: float3) => p.dot(t.dir) - t.mid;
			const side = Math.sign(at(corners[0]));
			return side !== 0 && corners.every(p => Math.sign(at(p)) === side);
		}
		case 'slab': {
			// every corner strictly inside the polygon's prism, and only the top plane through the cell
			let lo = Infinity, hi = -Infinity;
			for (const p of corners) {
				const w = p.sub(t.centre);
				if (polygonDistance2(w.dot(t.u), w.dot(t.v), [t.poly]) > -1e-9)
					return false;
				const perp = t.n.dot(p) - t.d;
				lo = Math.min(lo, perp);
				hi = Math.max(hi, perp);
			}
			// the plane a distance r out; the one at the face itself only touches zero, inside the body, and never crosses it
			return lo <= t.r && t.r <= hi;
		}
		default:
			return false;
	}
}

//-----------------------------------------------------------------------------
// the octree
//-----------------------------------------------------------------------------

class Node {
	children:	Node[] | null = null;
	vertex		= -1;					// the mesh vertex of a leaf that holds surface
	why			= '';					// what let it stop dividing (for diagnosis)
	desc		= '';					// the terms that were in play (for diagnosis)
	empty		= false;				// a leaf with no surface in it
	live		= false;				// some leaf at or below it holds surface: nothing is joined through a node that does not
	constructor(public x: number, public y: number, public z: number, public size: number, public term: Term | undefined) {}
}

// a child's index is one bit per axis, the bit for axis a at position a: so it is built by shifting
const c3 = (a1: number, b1: number, a2: number, b2: number, a3: number, b3: number) => (b1 << a1) | (b2 << a2) | (b3 << a3);

// the four cells round an edge along axis e, in the order that runs anticlockwise seen from +e: the (p, q) quadrants
// of the cell relative to the edge, p and q being the axes after e
const RING: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

export interface UniformOptions {
	cells:			number;								// cubes along the longest side of the model
	progress?:		(message: string) => void;
	cancelled?:		() => boolean;
	thin?:			boolean;							// look for walls thinner than a cube (default: yes)
}

// cubes as large as the surface allows, down to the finest
export function meshAdaptive(sdf: Sdf, options: AdaptiveOptions): Promise<AdaptiveMesh> {
	return contour(sdf, options, true);
}

// every cube the surface passes through the finest size
export function meshUniform(sdf: Sdf, options: UniformOptions): Promise<AdaptiveMesh> {
	return contour(sdf, {...options, tolerance: 0}, false);
}

// the mesher, which with `adaptive` false never stops dividing a cube with surface in it above the finest size
async function contour(sdf: Sdf, options: AdaptiveOptions, adaptive: boolean): Promise<AdaptiveMesh> {
	const {h: hf, origin} = gridFrame(sdf, options.cells);
	const N = 2 ** Math.ceil(Math.log2(options.cells + 4));
	const pos = (i: number, j: number, k: number) => float3(origin.x + i * hf, origin.y + j * hf, origin.z + k * hf);
	const tol = options.tolerance;
	const eps = 0.02 * hf;
	const breathe = pacer(options.cancelled);

	const M = N + 1;
	const cache = new Map<number, number>();
	const cornerValue = (t: Term, i: number, j: number, k: number) => {
		const key = i + M * (j + M * k);
		let f = cache.get(key);
		if (f === undefined) {
			f = evalT(t, pos(i, j, k));
			cache.set(key, f);
		}
		return f;
	};
	const known = (i: number, j: number, k: number) => cache.get(i + M * (j + M * k));

	const crossings = new Map<number, {p: float3, n: float3}>();
	const crossing = (t: Term, i: number, j: number, k: number, axis: number, s: number, level: number, fa: number, fb: number) => {
		const key = ((i + M * (j + M * k)) * 3 + axis) * 16 + level;
		let x = crossings.get(key);
		if (!x) {
			const [di, dj, dk] = cornerOffset(1 << axis);
			const p = edgeCrossing(q => evalT(t, q), pos(i, j, k), pos(i + di * s, j + dj * s, k + dk * s), fa, fb, hf);
			crossings.set(key, x = {p, n: normalT(t, p, eps)});
		}
		return x;
	};
	// Would one vertex describe this cell as its children would? Where the corners of an edge, or of a face, are all on one
	// side, the middle must be too: if it is not, the surface passes through between the samples the cell was judged
	// from -- the tip of a corner, a ridge that grazes a face -- and no vertex placed from the crossings on its edges can
	// know of it.
	const consistent = (t: Term, node: Node, fs: number[]) => {
		const s = node.size, h = s / 2;
		const at = (a: number, b: number, c: number) => cornerValue(t, node.x + a * h, node.y + b * h, node.z + c * h) < 0;
		for (const [a, b] of CUBE_EDGES) {
			const ia = (fs[a] < 0), ib = (fs[b] < 0);
			if (ia === ib) {
				const mid = at((a & 1) + (b & 1), ((a >> 1) & 1) + ((b >> 1) & 1), ((a >> 2) & 1) + ((b >> 2) & 1));
				if (mid !== ia)
					return false;
			}
		}
		for (let axis = 0; axis < 3; axis++)
			for (let side = 0; side < 2; side++) {
				const cs = [0, 1, 2, 3, 4, 5, 6, 7].filter(c => ((c >> axis) & 1) === side);
				const first = fs[cs[0]] < 0;
				if (cs.every(c => (fs[c] < 0) === first)) {
					const centre = [1, 1, 1];
					centre[axis] = side * 2;
					if (at(centre[0], centre[1], centre[2]) !== first)
						return false;
				}
			}
		return true;
	};

	// Is the field, throughout the cell, that of a single plane through the vertex? The 27 lattice points (corners, edge
	// midpoints, face centres, centre) are the children's corners, so their values are needed anyway if the cell is
	// divided. A crease, a corner, a cell with several faces in it: none of them is a plane, and the difference shows
	// at the points the crossings on the edges never touched. A gently curved patch differs by about its chord error.
	const planar = (t: Term, node: Node, v: float3, normals: float3[]) => {
		let n = float3(0, 0, 0);
		for (const x of normals)
			n = n.add(x);
		if (n.len() < 1e-12)
			return false;
		n = normalize(n);
		const h = node.size / 2, limit = 2 * tol + 1e-9 * hf;
		for (let c = 0; c < 27; c++) {
			const a = c % 3, b = Math.floor(c / 3) % 3, d = Math.floor(c / 9);
			const f = cornerValue(t, node.x + a * h, node.y + b * h, node.z + d * h);
			if (Math.abs(f - n.dot(pos(node.x + a * h, node.y + b * h, node.z + d * h).sub(v))) > limit)
				return false;
		}
		return true;
	};

	const vertices: float3[] = [];
	const whole = lower(sdf);
	const root = new Node(0, 0, 0, N, whole);
	const stack: Node[] = [root];
	const leaves: Node[] = [];
	let finest = 0, visited = 0, thin = 0;
	options.progress?.('refining');
	while (stack.length) {
		const node = stack.pop()!;
		const s = node.size;
		const centre = pos(node.x + s / 2, node.y + s / 2, node.z + s / 2);
		const pr = prune(node.term!, centre, s * hf * 0.8660254 + 2 * eps);
		node.term = pr.t;
		if (pr.lo > 0 || pr.hi < 0) {
			node.empty = true;
			node.term = undefined;
			leaves.push(node);
			continue;
		}
		const term = pr.t;
		const fs: number[] = [];
		let inside = 0;
		for (let c = 0; c < 8; c++) {
			const f = cornerValue(term, node.x + (c & 1) * s, node.y + ((c >> 1) & 1) * s, node.z + ((c >> 2) & 1) * s);
			fs.push(f);
			if (f < 0)
				inside |= 1 << c;
		}
		let accept = false;
		if (inside === 0 || inside === 255) {
			// nothing crosses an edge: the bounds could not rule surface out, but at the finest size there is none to draw,
			// unless a wall too thin for the corners to see goes through it
			if (s === 1) {
				if (options.thin !== false && thinWall(fs, pos(node.x, node.y, node.z), hf, p => evalT(term, p), p => normalT(term, p, eps)))
					++thin;
				node.empty = true;
				node.term = undefined;
				leaves.push(node);
				continue;
			}
		} else {
			const points: float3[] = [], normals: float3[] = [];
			const level = Math.log2(s);
			for (const [a, b, axis] of CUBE_EDGES) {
				if ((fs[a] < 0) !== (fs[b] < 0)) {
					const x = crossing(term, node.x + (a & 1) * s, node.y + ((a >> 1) & 1) * s, node.z + ((a >> 2) & 1) * s, axis, s, level, fs[a], fs[b]);
					points.push(x.p);
					normals.push(x.n);
				}
			}
			const v = cubeVertex(points, normals, pos(node.x, node.y, node.z), s * hf);
			if (s === 1) {
				accept = true;
				node.why = 'finest';
			} else if (!adaptive) {
				accept = false;
			} else {
				const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(c => pos(node.x + (c & 1) * s, node.y + ((c >> 1) & 1) * s, node.z + ((c >> 2) & 1) * s));
				if (single(term) && flat(term, corners)) {
					accept = true;
					node.why = 'flat';
				} else {
					// Otherwise it is judged from the field: one vertex within the tolerance of every plane through the
					// crossings and of the surface, with the field on the whole lattice that of a plane, and no surface in
					// between the samples. A tangent join of two smooth terms passes; a crease or a corner does not.
					let err = 0;
					points.forEach((p, i) => err = Math.max(err, Math.abs(normals[i].dot(v.sub(p)))));
					accept = err <= tol && Math.abs(evalT(term, v)) <= tol && consistent(term, node, fs) && planar(term, node, v, normals);
					node.why = 'qef';
				}
			}
			if (accept) {
				if ((options as any).debug)
					node.desc = describe(term);
				node.vertex = vertices.length;
				vertices.push(v);
				node.term = undefined;
				leaves.push(node);
				if (s === 1)
					++finest;
				continue;
			}
		}
		// divide, handing each child the term as this cell left it
		const h = s / 2;
		node.children = [];
		for (let c = 0; c < 8; c++)
			node.children.push(new Node(node.x + (c & 1) * h, node.y + ((c >> 1) & 1) * h, node.z + ((c >> 2) & 1) * h, h, term));
		node.term = undefined;
		for (const child of node.children)
			stack.push(child);
		if ((++visited & 255) === 0)
			await breathe();
	}

	// the four cells round each minimal edge make a quad
	options.progress?.('joining faces');
	const faces: number[][] = [];
	let missing = 0;
	const makeQuad = (ring: Node[], e: number) => {
		let k0 = 0;
		for (let k = 1; k < 4; k++)
			if (ring[k].size < ring[k0].size)
				k0 = k;
		const S = ring[k0];
		if (S.empty)
			return;
		const p = (e + 1) % 3, q = (e + 2) % 3;
		const corner = (be: number) => {
			const bits = [0, 0, 0];
			bits[e] = be;
			bits[p] = 1 - RING[k0][0];
			bits[q] = 1 - RING[k0][1];
			return [S.x + bits[0] * S.size, S.y + bits[1] * S.size, S.z + bits[2] * S.size];
		};
		const [ax, ay, az] = corner(0), [bx, by, bz] = corner(1);
		const fa = known(ax, ay, az), fb = known(bx, by, bz);
		if (fa === undefined || fb === undefined || (fa < 0) === (fb < 0))
			return;
		let v = ring.map(n => n.vertex);
		if (v.some(x => x < 0)) {
			++missing;
			return;
		}
		if (!(fa < 0))
			v = v.reverse();
		// Among cells of one size the shorter diagonal is as good as any, but a quad that joins cells of different sizes
		// is not flat, and the wrong diagonal cuts straight across a ridge: the right one has its midpoint nearer the surface.
		faces.push(...quadTriangles(v, vertices, ring.some(n => n.size !== ring[0].size) ? (a, b) => Math.abs(evalT(whole, a.add(b).scale(0.5))) : undefined));
	};

	const edgeProc = (ring: Node[], e: number) => {
		for (let k = 0; k < 4; k++)
			if (!ring[k].live)
				return;
		if (!ring[0].children && !ring[1].children && !ring[2].children && !ring[3].children) {
			makeQuad(ring, e);
			return;
		}
		const p = (e + 1) % 3, q = (e + 2) % 3;
		for (let h = 0; h < 2; h++) {
			const next: Node[] = [];
			for (let k = 0; k < 4; k++) {
				const n = ring[k];
				next.push(n.children ? n.children[c3(e, h, p, 1 - RING[k][0], q, 1 - RING[k][1])] : n);
			}
			edgeProc(next, e);
		}
	};
	const faceProc = (n0: Node, n1: Node, d: number) => {
		if ((!n0.children && !n1.children) || !n0.live || !n1.live)
			return;
		const u = (d + 1) % 3, v = (d + 2) % 3;
		// the children of n0 that touch the face are those with bit d set, of n1 those with it clear; a leaf stands for them all
		const a = (cu: number, cv: number) => n0.children ? n0.children[c3(d, 1, u, cu, v, cv)] : n0;
		const b = (cu: number, cv: number) => n1.children ? n1.children[c3(d, 0, u, cu, v, cv)] : n1;
		for (let cu = 0; cu < 2; cu++)
			for (let cv = 0; cv < 2; cv++)
				faceProc(a(cu, cv), b(cu, cv), d);
		// the lines across the face, along u and along v, each in two halves
		for (let h = 0; h < 2; h++) {
			edgeProc([a(h, 0), a(h, 1), b(h, 1), b(h, 0)], u);
			edgeProc([a(0, h), b(0, h), b(1, h), a(1, h)], v);
		}
	};
	const cellProc = (n: Node) => {
		if (!n.children || !n.live)
			return;
		for (const c of n.children)
			cellProc(c);
		for (let d = 0; d < 3; d++) {
			const u = (d + 1) % 3, v = (d + 2) % 3;
			for (let cu = 0; cu < 2; cu++)
				for (let cv = 0; cv < 2; cv++)
					faceProc(n.children[c3(d, 0, u, cu, v, cv)], n.children[c3(d, 1, u, cu, v, cv)], d);
		}
		for (let e = 0; e < 3; e++) {
			const p = (e + 1) % 3, q = (e + 2) % 3;
			for (let h = 0; h < 2; h++)
				edgeProc([RING[0], RING[1], RING[2], RING[3]].map(([qp, qq]) => n.children![c3(e, h, p, qp, q, qq)]), e);
		}
	};
	// which nodes have any surface below them, so that the traversal need not visit those that do not
	const mark = (n: Node): boolean => {
		if (!n.children)
			return n.live = n.vertex >= 0;
		let any = false;
		for (const c of n.children)
			any = mark(c) || any;
		return n.live = any;
	};
	mark(root);
	cellProc(root);
	if (missing)
		options.progress?.(`${missing} faces could not be joined`);
	const result: AdaptiveMesh & {debug?: any} = {points: vertices, faces, cell: hf, thin, leaves: leaves.length, finest};
	if ((options as any).debug)
		result.debug = {leaves: leaves.filter(n => n.vertex >= 0).map(n => ({x: n.x, y: n.y, z: n.z, size: n.size, vertex: n.vertex, why: n.why, desc: n.desc})), origin, hf};
	return result;
}
