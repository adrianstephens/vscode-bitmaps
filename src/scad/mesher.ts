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
import { float3, safeNormalise } from '@isopodlabs/maths/vector';
import { eigenSymmetric } from '@isopodlabs/maths/linear';
import { Sdf, SDF, Plane } from './sdf';
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

export interface UniformOptions {
	cells:			number;								// cubes along the longest side of the model
	progress?:		(message: string) => void;
	cancelled?:		() => boolean;
	thin?:			boolean;							// look for walls thinner than a cube (default: yes)
}

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

// cubes as large as the surface allows, down to the finest
export function meshAdaptive(sdf: Sdf | SDF, options: AdaptiveOptions): Promise<AdaptiveMesh> {
	return contour(sdf, options, true);
}

// every cube the surface passes through the finest size
export function meshUniform(sdf: Sdf | SDF, options: UniformOptions): Promise<AdaptiveMesh> {
	return contour(sdf, {...options, tolerance: 0}, false);
}

export class Cancelled extends Error {
	constructor() { super('cancelled'); }
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

function normalize(v: float3) {
	return safeNormalise(v) ?? float3(0, 0, 0);
}


// Where the planes {n_i . x = n_i . p_i} meet, nearest the mean of the p_i when they do not meet at a point (a flat face
// is only one plane; an edge is two). The directions the planes do not pin down are dropped rather than solved, which is
// what stops a nearly-flat patch from throwing its vertex a long way off.
function solveQef(points: float3[], normals: float3[]): float3 {
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
	const nv	= points.length;
	const edges = new Map<number, number>();		// undirected edge -> +1 for each traversal low->high, and 1000 for each face
	for (const f of faces)
		f.forEach((a, e) => {
			const b = f[(e + 1) % f.length], key = Math.min(a, b) * nv + Math.max(a, b);
			edges.set(key, (edges.get(key) ?? 0) + 1000 + (a < b ? 1 : -1));
		});
	let open = 0, nonManifold = 0, inconsistent = 0;
	for (const v of edges.values()) {
		const uses	= Math.round(v / 1000);
		const net	= v - uses * 1000;
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
function gridFrame(sdf: SDF, cells: number) {
	const box = sdf.bounds();
	if (!box)
		throw new Error('the model has no bounds to mesh');
	const extent	= box.max.sub(box.min);
	const h			= Math.max(extent.x, extent.y, extent.z) / cells;
	return {h, origin: box.min.sub(float3(2 * h + 0.0137 * h, 2 * h + 0.0171 * h, 2 * h + 0.0113 * h))};
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
	return float3(
		Math.min(lo.x + side, Math.max(lo.x, v.x)),
		Math.min(lo.y + side, Math.max(lo.y, v.y)),
		Math.min(lo.z + side, Math.max(lo.z, v.z))
	);
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
	const within	= [q.x - lo.x, q.y - lo.y, q.z - lo.z].every(d => d >= -eps && d <= side + eps);
	const fq		= within ? field(q) : 0;
	return within && (Math.abs(fq) < 0.01 * side || (fq < 0) !== (fs[0] < 0));
}

//-----------------------------------------------------------------------------
// the mesher: an octree of cubes, small only where the surface needs them (or everywhere it is, for meshUniform)
//-----------------------------------------------------------------------------

// An adaptive mesher: fine cells only where the surface needs them, decided from what the model is made of rather than
// from how it happens to sample.
//
// A grid of cubes all the finest size pays for that resolution everywhere, flat faces included. This works down an
// octree, and at each cell asks the model two things (see sdf.ts): `restrict`, which parts of it can reach the cell at
// all, and `planes`, what the surface in the cell is made of. Every part's field is a lower bound on
// the distance to its surface, so over a cell of circumradius r it lies within f(centre) +/- r, and a part whose lowest
// value is above another's highest cannot be the minimum of a union anywhere in the cell (the same for the other
// combinators). What survives is the handful of parts that could shape the surface there. A cell may then stop being
// divided if either
//
//   * the model says the surface in it is one plane, or two that meet in a line through it (a crease), or
//   * the dual-contouring vertex for the cell is within the tolerance of every plane through the surface crossings on its
//     edges, and of the surface itself (the usual test for a smooth part, where the error is what refining would reduce).
//
// A junction of three or more is divided to the finest size, which costs in proportion to its length rather than to an area.
// The mesh is then made from the leaves by dual contouring on the octree (Ju et al.), which joins cells of different
// sizes without cracks.
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
	sheets?:	{plane: Plane, vertex: number}[];	// a wall: a vertex for each of two separate sheets, `vertex` being the first
	constructor(public x: number, public y: number, public z: number, public size: number, public term: SDF | undefined) {}
}

// two planes are the same plane, whichever way round they are given
const samePlane = (a: Plane, b: Plane, tol: number) => {
	const along = a.n.dot(b.n);
	return Math.abs(Math.abs(along) - 1) < 1e-9 && Math.abs(a.d - Math.sign(along) * b.d) < tol;
};

// whether the line where two planes meet passes through the cell, which is the point plus or minus each of three vectors
function meetInCell(a: Plane, b: Plane, p: float3, cell: float3[]): boolean {
	const dir = a.n.cross(b.n), len2 = dir.dot(dir);
	if (len2 < 1e-18)
		return false;
	const x0 = b.n.cross(dir).scale(a.d / len2).add(dir.cross(a.n).scale(b.d / len2));
	// the line in the cell's own coordinates, where the cell is [-1, 1] on each axis
	const [g0, g1, g2] = cell;
	const c0 = g1.cross(g2), c1 = g2.cross(g0), c2 = g0.cross(g1), det = g0.dot(c0);
	if (!(Math.abs(det) > 1e-30))
		return false;
	const w = x0.sub(p);
	const start = [w.dot(c0) / det, w.dot(c1) / det, w.dot(c2) / det];
	const rate = [dir.dot(c0) / det, dir.dot(c1) / det, dir.dot(c2) / det];
	let lo = -Infinity, hi = Infinity;
	for (let i = 0; i < 3; i++) {
		if (Math.abs(rate[i]) < 1e-12 * Math.sqrt(len2)) {
			if (Math.abs(start[i]) > 1 + 1e-9)
				return false;
			continue;
		}
		const t0 = (-1 - start[i]) / rate[i], t1 = (1 - start[i]) / rate[i];
		lo = Math.max(lo, Math.min(t0, t1));
		hi = Math.min(hi, Math.max(t0, t1));
	}
	return lo <= hi + 1e-9;
}

// What the surface in a cell is made of, if it is at most two planes: one (flat), or two. Two that meet in a line through
// the cell (a crease) make a connected surface, and the vertex where the planes meet is where a mesh of it must have a
// vertex. Two that do not are two separate sheets, a wall or a wedge, which one vertex cannot describe but one vertex each
// can. The cell is the point plus or minus each of three vectors.
function surfaceFacets(s: SDF, p: float3, cell: float3[], eps: number): {planes: Plane[], joined: boolean} | undefined {
	const got = s.planes(p, cell, eps);
	if (!got)
		return undefined;
	const planes: Plane[] = [];
	for (const pl of got) {
		if (!planes.some(q => samePlane(q, pl, 1e-9 * (1 + Math.abs(pl.d)))))
			planes.push(pl);
		if (planes.length > 2)
			return undefined;
	}
	return {planes, joined: planes.length < 2 || meetInCell(planes[0], planes[1], p, cell)};
}

// Where the segment from a to b passes through each of the planes, and the field's value just before it: a crossing of
// a plane is only a crossing of the surface if the field changes sign across it, which the field at the middle of each
// stretch between crossings says. That is how a wall too thin for the ends of the segment to see is found.
interface Crossing { plane: number; at: float3; before: number }
function edgeSheets(field: (p: float3) => number, a: float3, b: float3, planes: Plane[]): Crossing[] {
	const u = b.sub(a), len = u.len();
	const hits: {t: number, plane: number}[] = [];
	planes.forEach((pl, plane) => {
		const rate = pl.n.dot(u);
		if (Math.abs(rate) < 1e-12 * len)
			return;
		const t = (pl.d - pl.n.dot(a)) / rate;
		if (t > 1e-9 && t < 1 - 1e-9)
			hits.push({t, plane});
	});
	if (!hits.length)
		return [];
	hits.sort((x, y) => x.t - y.t);
	const ts = [0, ...hits.map(h => h.t), 1];
	const values = ts.slice(0, -1).map((t0, k) => field(a.add(u.scale((t0 + ts[k + 1]) / 2))));
	const out: Crossing[] = [];
	hits.forEach((h, k) => {
		if ((values[k] < 0) !== (values[k + 1] < 0))
			out.push({plane: h.plane, at: a.add(u.scale(h.t)), before: values[k]});
	});
	return out;
}

// a child's index is one bit per axis, the bit for axis a at position a: so it is built by shifting
const c3 = (a1: number, b1: number, a2: number, b2: number, a3: number, b3: number) => (b1 << a1) | (b2 << a2) | (b3 << a3);

// the four cells round an edge along axis e, in the order that runs anticlockwise seen from +e: the (p, q) quadrants
// of the cell relative to the edge, p and q being the axes after e
const RING: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

// the mesher, which with `adaptive` false never stops dividing a cube with surface in it above the finest size
async function contour(model: Sdf | SDF, options: AdaptiveOptions, adaptive: boolean): Promise<AdaptiveMesh> {
	const sdf = model instanceof SDF ? model : new SDF(model);
	const {h: hf, origin} = gridFrame(sdf, options.cells);
	const N		= 2 ** Math.ceil(Math.log2(options.cells + 4));
	const pos	= (i: number, j: number, k: number) => float3(origin.x + i * hf, origin.y + j * hf, origin.z + k * hf);
	const tol	= options.tolerance;
	const eps	= 0.02 * hf;
	const breathe = pacer(options.cancelled);

	const M = N + 1;
	const cache = new Map<number, number>();
	const cornerValue = (t: SDF, i: number, j: number, k: number) => {
		const key = i + M * (j + M * k);
		let f = cache.get(key);
		if (f === undefined) {
			f = t.eval(pos(i, j, k));
			cache.set(key, f);
		}
		return f;
	};
	const known = (i: number, j: number, k: number) => cache.get(i + M * (j + M * k));

	const crossings = new Map<number, {p: float3, n: float3}>();
	const crossing = (t: SDF, i: number, j: number, k: number, axis: number, s: number, level: number, fa: number, fb: number) => {
		const key = ((i + M * (j + M * k)) * 3 + axis) * 16 + level;
		let x = crossings.get(key);
		if (!x) {
			const [di, dj, dk] = cornerOffset(1 << axis);
			const p = edgeCrossing(q => t.eval(q), pos(i, j, k), pos(i + di * s, j + dj * s, k + dk * s), fa, fb, hf);
			crossings.set(key, x = {p, n: t.normal(p, eps)});
		}
		return x;
	};
	// Would one vertex describe this cell as its children would? Where the corners of an edge, or of a face, are all on one
	// side, the middle must be too: if it is not, the surface passes through between the samples the cell was judged
	// from -- the tip of a corner, a ridge that grazes a face -- and no vertex placed from the crossings on its edges can
	// know of it.
	const consistent = (t: SDF, node: Node, fs: number[]) => {
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
	const planar = (t: SDF, node: Node, v: float3, normals: float3[]) => {
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

	// The sheets of a cell that holds two planes' worth of surface: where each plane crosses the cell's edges (and the field
	// changes sign there), and a point of the cell on the plane, at the middle of those crossings. Undefined unless both
	// are really there.
	const sheetsOf = (t: SDF, node: Node, planes: Plane[]) => {
		const s = node.size, mean = planes.map(() => ({sum: float3(0, 0, 0), count: 0}));
		for (const [a, b] of CUBE_EDGES)
			for (const c of edgeSheets(q => t.eval(q), pos(node.x + (a & 1) * s, node.y + ((a >> 1) & 1) * s, node.z + ((a >> 2) & 1) * s), pos(node.x + (b & 1) * s, node.y + ((b >> 1) & 1) * s, node.z + ((b >> 2) & 1) * s), planes)) {
				mean[c.plane].sum = mean[c.plane].sum.add(c.at);
				++mean[c.plane].count;
			}
		return mean.every(m => m.count) ? planes.map((plane, i) => ({plane, at: mean[i].sum.scale(1 / mean[i].count)})) : undefined;
	};

	const vertices: float3[] = [];
	const whole = sdf;
	const root = new Node(0, 0, 0, N, whole);
	const stack: Node[] = [root];
	const leaves: Node[] = [];
	let finest = 0, visited = 0, thin = 0;
	options.progress?.('refining');
	while (stack.length) {
		const node = stack.pop()!;
		const s = node.size;
		const centre = pos(node.x + s / 2, node.y + s / 2, node.z + s / 2);
		const half = s * hf / 2;
		const pr = node.term!.restrict(centre, s * hf * 0.8660254 + 2 * eps);
		node.term = pr;
		if (pr.lo > 0 || pr.hi < 0) {
			node.empty = true;
			node.term = undefined;
			leaves.push(node);
			continue;
		}
		const term = pr;
		const fs: number[] = [];
		let inside = 0;
		for (let c = 0; c < 8; c++) {
			const f = cornerValue(term, node.x + (c & 1) * s, node.y + ((c >> 1) & 1) * s, node.z + ((c >> 2) & 1) * s);
			fs.push(f);
			if (f < 0)
				inside |= 1 << c;
		}
		// The model says what the surface in the cell is made of (see surfaceFacets)
		const found = adaptive ? surfaceFacets(term, centre, [float3(half, 0, 0), float3(0, half, 0), float3(0, 0, half)], eps) : undefined;
		// Two sheets that do not meet in the cell, a wall or a slot thinner than the cell, or thinner than the finest cell
		// and so invisible to the corners: each is flat, and has a vertex of its own, wherever the corners lie
		if (found?.planes.length === 2 && !found.joined && Math.abs(found.planes[0].n.dot(found.planes[1].n)) > 1 - 1e-9) {
			const sheets = sheetsOf(term, node, found.planes);
			if (sheets) {
				node.sheets = sheets.map(sh => ({plane: sh.plane, vertex: vertices.push(sh.at) - 1}));
				node.vertex = node.sheets[0].vertex;
				node.why = 'wall';
				node.term = undefined;
				leaves.push(node);
				if (s === 1)
					++finest;
				continue;
			}
		}
		let accept = false;
		if (inside === 0 || inside === 255) {
			// nothing crosses an edge: the bounds could not rule surface out, but at the finest size there is none to draw,
			// unless a wall too thin for the corners to see goes through it
			if (s === 1) {
				if (options.thin !== false && thinWall(fs, pos(node.x, node.y, node.z), hf, p => term.eval(p), p => term.normal(p, eps)))
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
				// One plane is something a vertex from the crossings gets exactly, and so is two that meet in a line through the
				// cell, if the field on the lattice does not contradict it (a ridge between the samples, which no vertex from
				// the edges can know of)
				if (found?.planes.length === 1) {
					accept = true;
					node.why = 'flat';
				} else if (found?.planes.length === 2 && found.joined && Math.abs(term.eval(v)) <= tol && consistent(term, node, fs)) {
					accept = true;
					node.why = 'crease';
				} else {
					// Otherwise it is judged from the field: one vertex within the tolerance of every plane through the
					// crossings and of the surface, with the field on the whole lattice that of a plane, and no surface in
					// between the samples. A tangent join of two smooth terms passes; a crease or a corner does not.
					let err = 0;
					points.forEach((p, i) => err = Math.max(err, Math.abs(normals[i].dot(v.sub(p)))));
					accept = err <= tol && Math.abs(term.eval(v)) <= tol && consistent(term, node, fs) && planar(term, node, v, normals);
					node.why = 'qef';
				}
			}
			if (accept) {
				if ((options as any).debug)
					node.desc = term.describe();
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
	// A ring with a wall in it: the crossings of the edge come from the planes of the walls rather than from the corners,
	// and each makes a quad of the vertices on its sheet, a cell with one vertex giving that
	const wallQuads = (ring: Node[], a: float3, b: float3) => {
		const planes: Plane[] = [];
		for (const n of ring)
			for (const sh of n.sheets ?? [])
				if (!planes.some(q => samePlane(q, sh.plane, 1e-6 * hf)))
					planes.push(sh.plane);
		for (const c of edgeSheets(q => whole.eval(q), a, b, planes)) {
			let v = ring.map(n => n.sheets ? (n.sheets.find(sh => samePlane(sh.plane, planes[c.plane], 1e-6 * hf))?.vertex ?? -1) : n.vertex);
			if (v.some(x => x < 0)) {
				++missing;
				continue;
			}
			if (!(c.before < 0))
				v = v.reverse();
			faces.push(...quadTriangles(v, vertices, ring.some(n => n.size !== ring[0].size) ? (p, q) => Math.abs(whole.eval(p.add(q).scale(0.5))) : undefined));
		}
	};
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
		if (ring.some(n => n.sheets)) {
			wallQuads(ring, pos(ax, ay, az), pos(bx, by, bz));
			return;
		}
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
		faces.push(...quadTriangles(v, vertices, ring.some(n => n.size !== ring[0].size) ? (a, b) => Math.abs(whole.eval(a.add(b).scale(0.5))) : undefined));
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
