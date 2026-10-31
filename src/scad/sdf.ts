// The model as a field rather than a solid. A .scad file is a program that builds geometry, but what an SDF viewer
// needs from it is a function of a point, so evaluation produces this algebra of fields and never a mesh: the leaves
// are primitives, and the combinators are exactly the SDF operations the scad constructs mean. Each term can be
// emitted as glsl for the raymarcher, or evaluated here, which is how the model can be measured without a GPU.
import { vec, E3, float2, float3, float3x3, float3x4, safeNormalise } from '@isopodlabs/maths/vector';
import { curveDistance, bezier2Curve, parseCurve } from '@isopodlabs/binary_fonts';
import { eigenSymmetric } from '@isopodlabs/maths/linear';
import type { FieldFn, ColorFn, DisplaceFn, Texture, TexturePlace } from './fnsurface';

function normalize(v: float3) {
	return safeNormalise(v) ?? float3(0, 0, 0);
}

export type Box2		= float2.extent
export type Box3		= float3.extent
export const Box2		= float2.extent;
export const Box3		= float3.extent
export interface Hull3	{planes: {n: float3, d: number}[], faces: float3[][]}

export class SDF {
	constructor(public root: Sdf) {}
	
	bounds()	{ return bounds3(this.root); }
	eval(p: float3): number {
		return evalSdf(this.root, p);
	}
	normal(p: float3, eps: number)	{
		return surfaceNormal(this.root, p, eps);
	}
	restrict(c: float3, r: number)	{
		// a part keeps the whole model's numbering of its materials, which its own walk would not give
		const got = restrict(this.root, c, r);
		got.ids = this.ids ??= materialWalk(this.root).byMat;
		return got;
	}
	planes(p: float3, cell: float3[], eps: number) {
		return planesOf(this.root, p, cell, eps);
	}
	// which of materials() the surface at p is made of
	ids?: Map<Material, number>;
	material(p: float3): number {
		return evalMaterial(this.root, p, this.ids ??= materialWalk(this.root).byMat);
	}
	materials() {
		return materials(this.root);
	}
	// what the model is in a word, for diagnosis
	describe() {
		return describe(this.root);
	}

	walk(callback: (s: Sdf, process: (s: Sdf) => Sdf) => Sdf) {
		return walk(this.root, callback);
	}

}

function describe(s: Sdf): string {
	switch (s.k) {
		case 'union': case 'intersection': {
			const c: Record<string, number> = {};
			for (const k of s.children) {
				const d = describe(k);
				c[d] = (c[d] || 0) + 1;
			}
			return s.k.slice(0, 5) + '(' + Object.entries(c).map(([k, v]) => v > 1 ? v + 'x' + k : k).join(',') + ')';
		}
		case 'difference':	return 'diff(' + [s.base, ...s.cuts].map(describe).join(',') + ')';
		case 'domain':		return 'dom.' + describe(s.body);
		default:			return s.k;
	}
}

// What a Minkowski operand adds to the field around the shape it is summed with: the support function of the
// operand's own shape, so `dilate` never has to know what that shape was. q is A*Aᵗ of the operand's linear part
// (null when it is an unscaled ball, where the support is just r whatever the direction), and offset moves it.
export interface Support {
	r:		number;
	q:		float3x3 | null;	// null when the operand is a ball, whose support is r whatever the direction
	bound:	number;				// how far the operand can reach from the origin, for the bounding box
}

export interface TriMesh {
	k:			'trimesh';
	points:		float3[];			// the welded corners
	tris:		Uint32Array;		// three corners a triangle, in the hierarchy's leaf order
	closed:		boolean;			// every edge shared by exactly two triangles, running opposite ways in them
	min:		float3;
	max:		float3;
	// the hierarchy, two vec4s a node: (box min, left) and (box max, right), where a leaf has left = -(first + 1) and
	// right = its count of triangles, which are that run of `tris`
	nodes:		Float32Array;
	// ten vec4s a triangle: its corners a, b, c; its face normal; its edges' pseudonormals (ab, bc, ca); its corners'
	// pseudonormals (a, b, c)
	triData:	Float32Array;
}

export interface Heightmap {
	k:			'heightmap';
	cols:		number;
	rows:		number;
	heights:	Float32Array;		// row-major, row 0 at y = 0
	bottom:		number;
	top:		number;
	tile:		number;				// cells to a side of a tile
	tilesX:		number;
	tilesY:		number;
	nearTop:	Float32Array;		// per tile: the highest point in it and the tiles round it
	nearSlope:	Float32Array;		// per tile: 1 / sqrt(1 + L^2), L the steepest slope in it and the tiles round it
	wrap?:		Wrap;				// absent for OpenSCAD's own flat surface(); see Wrap
	tiled?:		Tiled;				// absent for a grid that ends; read by wrap(), which see
}

export type Sdf3 =
	| {k: 'empty'}
	| {k: 'sphere', r: number}
	| {k: 'box', size: float3, center: boolean}
	| {k: 'cylinder', r: number, h: number, center: boolean}
	| {k: 'ngonPrism', r: number, h: number, center: boolean, n: number}
	// a smooth taper (cylinder(r1, r2) with r1 != r2 and no $fn): a faceted one is built as a real polyhedron
	// instead (see evaluate.ts's 'cylinder' case), the same choice already made for a plain faceted cylinder
	| {k: 'cone', r1: number, r2: number, h: number, center: boolean}
	| {k: 'planes', planes: {n: float3, d: number}[], points: float3[], faces: float3[][]}
	| {k: 'domain', m: float3x4, scale: number, body: Sdf}		// the body is built in the frame m
	| Warp														// the body is built flat and bent into a revolution
	| {k: 'dilate', body: Sdf, support: Support}				// body grown by the operand's support function
	// hull() of exactly two same-radius spheres/circles is a capsule/stadium, not a dilated solid hull (a solid hull
	// needs 4 non-coplanar points; two spheres give only a segment) -- see hullOf() below
	| {k: 'capsule', a: float3, b: float3, r: number}
	// the exact hull of two balls of different radii (a "round cone"): a capsule generalised to r1 != r2, one
	// spherical cap at each end and a smoothly tangent conical collar between them -- degenerates to capsule at
	// r1 = r2 and to a sharp point capped by a single sphere at r1 = 0 or r2 = 0. Built for a mixed hull() (see
	// weightedHull3 below), whose edges connect points that may carry any radius, including zero for a sharp corner.
	| {k: 'roundCone', a: float3, b: float3, r1: number, r2: number}
	// surface(): a height at each point of a grid (x the column, y the row, a unit apart), over a solid down to `bottom`
	// -- built by heightmap(), which says what the tiles are for
	| Heightmap
	// surface_fn() and implicit_fn(): a scalar field kept as a function, compiled to glsl for the raymarcher and to JS
	// for the rest (see fnsurface.ts), inside the box it is asked for
	| {k: 'fnfield', fn: FieldFn, box: Box3}
	| TriMesh													// import()ed meshes and polyhedron()s that are not convex
	| Displace													// the body's surface moved along its normal by a function

export type Sdf2 =
	// 2-D shapes: fields of the plane that no z can change. They are not solids, so a union skips them for bounds
	// and anything left at the top level is reported rather than drawn as the infinite prism the field describes.
	| {k: 'circle2', r: number, n: number}						// n = 0 is a smooth circle, otherwise an n-gon
	| {k: 'square2', size: float2, center: boolean}
	| {k: 'polygon2', paths: float2[][]}						// each path a closed loop; more than one is holes/islands by even-odd fill
	// a closed path of lines and quadratic Beziers (text()'s glyph outlines, in the font's own curves rather than a
	// flattened polygon), each path its own start point and the segments that lead from it back around to it again
	| {k: 'curvepath2', paths: bezier2Curve }
	| {k: 'stadium2', a: float2, b: float2, r: number}			// hull() of two same-radius circles: 'capsule''s 2-D form
	| {k: 'offset', r: number, body: Sdf}						// offset(r): the shape grown by a disc
	| {k: 'extrude', h: number, center: boolean, body: Sdf}		// linear_extrude of a 2-D shape
	| {k: 'revolve', angle: number, body: Sdf}					// rotate_extrude of a 2-D shape, about z

export type Sdf = Sdf2 | Sdf3
	| {k: 'union', children: Sdf[]}
	| {k: 'intersection', children: Sdf[]}
	| {k: 'difference', base: Sdf, cuts: Sdf[]}
	| {k: 'material', mat: Material, body: Sdf};				// color()/$variables round the body, which they tint

export const empty: Sdf = {k: 'empty'};

// displace(): the body's surface moved out along its normal by h, a function of the point (and the normal, when it asks).
// With `base`, h is read where a point stands over the body's surface -- the point less the normal times the body's
// distance -- which is how a mesh is displaced; without it, where the point itself is, which is the same for an h that
// does not change along the normal and saves differencing the body for the normal when h does not ask for it.
// Its field is the body's distance less h, which changes by up to 1 + slope per unit, so it is divided by that to stay a
// bound; and since no h is outside lo..hi, the body's own distance less hi (or lo, inside) is a bound too, which is what
// is used away from the moved surface, where it is the longer step. See displaceDistance.
export interface Displace {
	k:		'displace';
	fn:		DisplaceFn;
	lo:		number;			// the least h can be, and the most, both found by looking and padded by the slope
	hi:		number;
	slope:	number;			// a bound on how fast h changes
	base:	boolean;		// h is read at the body's surface under the point, rather than at the point
	eps:	number;			// the step the body's normal is differenced over
	box:	Box3;
	body:	Sdf;
}

export function scaleHeightmap(map: Heightmap, zscale: number, mirrorx: boolean, mirrory: boolean) {
	const heights = Float64Array.from(map.heights, v => zscale * v);
	if (mirrorx) {
		for (let j = 0; j < map.rows; j++)
			for (let i = 0; i < map.cols >> 1; i++) {
				const k = j * map.cols + i, k2 = j * map.cols + map.cols - 1 - i;
				[heights[k], heights[k2]] = [heights[k2], heights[k]];
			}
	}
	if (mirrory) {
		for (let j = 0; j < map.rows >> 1; j++)
			for (let i = 0; i < map.cols; i++) {
				const k = j * map.cols + i, k2 = (map.rows - 1 - j) * map.cols + i;
				[heights[k], heights[k2]] = [heights[k2], heights[k]];
			}
	}
	return heights;
}

// Which of a grid's axes repeat: surface()'s `tiled`, false, true or [x, y]. A tiled grid is a tile laid over and
// over rather than a surface that ends: its columns repeat, and if asked its rows do too. It is only meaningful once
// the grid is wrapped (see Wrap); a flat surface() still lays out the one rectangle it is, because without a surface
// to tile over there is no period for the pattern to have.
export interface Tiled {
	x:		boolean;
	y:		boolean;
}

// A heightmap's grid bent into space rather than laid on the plane: the columns become a turn about z and the rows a
// height (a cylinder) or a latitude (a sphere), and r is the surface it is bent around -- the base. Both kinds are
// full turns, so the grid is periodic in its columns -- column `cols` is column 0 again and the last cell meets the
// first, which is what makes a wrap seamless. A wrapped grid is then measured from that base: heightmap() moves the
// grid's own floor onto r and its heights become thicknesses, so the solid is the shell from r out to it, a
// lithophane, and r names the base whatever the grid's z values were -- OpenSCAD's own floor, the one below the
// lowest height that surface() adds, is simply the innermost of the shell. One thing differs in the tile table a
// wrapped map carries: `nearSlope` holds the steepest slope L itself, not 1 / sqrt(1 + L^2), because that factor
// depends on the radius the point has -- see wrappedHeightmapDistance. And a sphere's first and last rows are the
// poles, one point each, so heightmap() gives each its own mean height.
//
// A tiled grid's columns -- and, if asked, its rows -- repeat rather than ending. The turn is still a whole one, but
// the grid is no longer fitted to it: one column covers `sx` of arc and one row `sy`, so scaling the grid sets the
// size of the tile and with it how many times the tile comes round, where an untiled grid's own width fills the turn
// whatever it is. On a sphere the rows still run pole to pole unless they are tiled too, since the poles are where a
// whole ring of columns meets and a row that did not land on one could not give that point a single height.
export interface Wrap {
	kind:	'cylinder' | 'sphere';
	r:		number;
	row?:	number;				// how far apart the rows are: the axis one row covers, or a scale before the wrap
	tileX?:	boolean;			// the columns repeat: sx of arc each, rather than the fitted whole turn
	tileY?:	boolean;			// the rows repeat: sy each, rather than the fitted meridian or the scaled axis
	sx?:	number;				// the arc one column covers, when tileX
	sy?:	number;				// the arc, or length up the axis, one row covers, when tileY
	part?:	boolean;			// the grid covers only the arc its own width is: the columns end rather than close
}

// A shape bent into a revolution rather than laid flat: its x becomes a turn about z, its y a height (a cylinder) or
// a latitude (a sphere), and its z a thickness standing out from the surface of radius r. This is what wrapping a
// heightmap around a sphere or a cylinder is (see Heightmap's own `wrap`, which is this specialised to a grid bent as
// one piece, and is tighter and seamless where it applies), and it takes anything: a texture, extruded text, a solid.
// r is the base -- the surface the body is wrapped around -- whatever the body's own z range is: the body's lowest
// point sits on it and its height out to its highest is how far the solid stands off. The map is not a similarity, so
// the body's distance is carried back through it and scaled by the least it stretches there -- a bound on the
// distance rather than the distance itself, like the flat heightmap's.
//
// How far round it goes is the body's own business, as it would be for any other transform: its x is an arc of r, so
// a piece twice as wide covers twice as much of the turn, and scaling it is how one asks for less than a whole one.
// A body already a circumference wide is fitted to exactly one turn rather than lapping itself, and one that covers a
// sphere's poles is fitted to them; the ends of a shorter one are real ends, the solid cut off at those two
// meridians, and a point carrying a distance that reaches past them is caught by them (see warpDistance).
//
// A cylinder's y is the axis, and an axis has no length of its own the way a turn has: it is the body's own height
// unless the bend was given one (`h`), which is the surface's second dimension as a cylinder primitive has it. A
// body given one is fitted to it -- its rows are spread over the axis rather than sizing it -- so `h` says how long
// the tube is rather than how long the body is, and the body's z still says how thick it stands off r.
interface Warp {
	k:		'warp';
	kind:	'cylinder' | 'sphere';
	r:		number;
	box:	Box3;				// the body's own bounds: the slab being bent, and what says how far round it reaches
	axis?:	number;				// a cylinder's axis, when the bend was given one: the body's y is fitted to it
	body:	Sdf;
}

// a glsl float literal, always with a decimal point so it is not read as an int
function f(x: number): string {
	if (!Number.isFinite(x))
		return x > 0 ? '1e20' : '-1e20';
	if (Number.isInteger(x) && Math.abs(x) < 1e15)
		return `${x}.0`;
	return String(x);
}

const v3 = (v: float3) => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
const v2 = (v: float2) => `vec2(${f(v.x)}, ${f(v.y)})`;

export function union(children: Sdf[]): Sdf {
	const flat = children.flatMap(c => c.k === 'union' ? c.children : [c]).filter(c => c.k !== 'empty');
	return flat.length === 0 ? empty : flat.length === 1 ? flat[0] : {k: 'union', children: flat};
}

// Whether the frame only turns and scales evenly, in which case a distance measured inside it needs nothing but
// that scale: a similarity preserves the shape of the field. A frame that stretches one axis does not, and a shape
// built in one has to be moved into its parent instead of being scaled (see place in evaluate.ts).
export function isConformal(m: vec<float3, E3>): boolean {
	const a = m.x.dot(m.x);
	const eps = 1e-9 * a;
	return Math.abs(a - m.y.dot(m.y)) <= eps
		&& Math.abs(a - m.z.dot(m.z)) <= eps
		&& Math.abs(m.x.dot(m.y)) <= eps
		&& Math.abs(m.x.dot(m.z)) <= eps
		&& Math.abs(m.y.dot(m.z)) <= eps;
}
const expand2 = (s: number) => float2(s, s);
const expand3 = (s: number) => float3(s, s, s);


export function walk(s: Sdf, callback: (s: Sdf, process: (s: Sdf) => Sdf) => Sdf): Sdf {
	const recurse = (s: Sdf): Sdf => callback(s, process);
	const process = (s: Sdf): Sdf => {
		switch (s.k) {
			case 'union':
			case 'intersection':
			{
				const children = s.children.map(recurse).filter(c => c.k !== 'empty');
				return children.length === 0 ? empty : children.length === 1 ? children[0] : {...s, children};
			}
			case 'difference': {
				const base = recurse(s.base);
				const cuts = s.cuts.map(recurse).filter(c => c.k !== 'empty');
				return base.k === 'empty' ? empty : cuts.length === 0 ? base : {...s, base, cuts};
			}
			case 'domain':
			case 'warp':
			case 'dilate':
			case 'displace':
			case 'material':
			case 'offset':
			case 'extrude':
			case 'revolve':
			{
				const body = recurse(s.body);
				return body.k === 'empty' ? empty : {...s, body};
			}
			default:
				return s;
		}
	};

	return recurse(s);
}


const LEAF = 4;
export const TRI_TEXELS = 10;


// Reorders order[lo..hi] so the element at k is the one a sort by key would put there, with nothing after it keyed
// lower and nothing before it keyed higher (Hoare's selection): the median split, without sorting either half. Mutates order.
function select(order: Uint32Array, lo: number, hi: number, k: number, key: (t: number) => number) {
	while (hi > lo) {
		const pivot = key(order[(lo + hi) >> 1]);
		let i = lo, j = hi;
		while (i <= j) {
			while (key(order[i]) < pivot)
				i++;
			while (key(order[j]) > pivot)
				j--;
			if (i <= j) {
				[order[i], order[j]] = [order[j], order[i]];
				i++;
				j--;
			}
		}
		if (k <= j)
			hi = j;
		else if (k >= i)
			lo = i;
		else
			return;
	}
}


// A face's triangles, keeping its winding: its corners flattened onto the plane of its Newell normal and ear-clipped,
// so that a concave face (the L-shaped end of an L) is covered by its own area and not its hull's.
function triangulate(loop: number[], points: float3[]): number[][] {
	if (loop.length <= 3)
		return loop.length === 3 ? [loop] : [];
	let n = float3(0, 0, 0);
	loop.forEach((i, k) => n = n.add(points[i].cross(points[loop[(k + 1) % loop.length]])));
	// the two axes the normal is least along, ordered so the face runs anticlockwise in them
	const drop = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 'x' : Math.abs(n.y) >= Math.abs(n.z) ? 'y' : 'z';
	const [u, v] = ({x: ['y', 'z'], y: ['z', 'x'], z: ['x', 'y']} as const)[drop];
	const flip = n[drop] < 0 ? -1 : 1;
	const at = (i: number) => [points[i][u], points[i][v] * flip];
	const turn = (a: number, b: number, c: number) => {
		const [ax, ay] = at(a), [bx, by] = at(b), [cx, cy] = at(c);
		return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	};
	const within = (p: number, a: number, b: number, c: number) => turn(a, b, p) > 0 && turn(b, c, p) > 0 && turn(c, a, p) > 0;

	const left = [...loop], out: number[][] = [];
	while (left.length > 3) {
		const ear = left.findIndex((b, k) => {
			const a = left[(k + left.length - 1) % left.length], c = left[(k + 1) % left.length];
			return turn(a, b, c) > 0 && !left.some(p => p !== a && p !== b && p !== c && within(p, a, b, c));
		});
		// a face with no ear folds over itself; its first corner is taken as one, as a fan would
		const k = Math.max(ear, 0);
		out.push([left[(k + left.length - 1) % left.length], left[k], left[(k + 1) % left.length]]);
		left.splice(k, 1);
	}
	out.push(left);
	return out;
}

// The nearest point of triangle abc to p, and which part of it that is: 0 the face, 1..3 the edges ab, bc, ca, and
// 4..6 the corners a, b, c (Ericson's regions, in Real-Time Collision Detection)
function nearest(px: number, py: number, pz: number, d: Float32Array, at: number): {qx: number, qy: number, qz: number, part: number} {
	const ax = d[at], ay = d[at + 1], az = d[at + 2];
	const bx = d[at + 4], by = d[at + 5], bz = d[at + 6];
	const cx = d[at + 8], cy = d[at + 9], cz = d[at + 10];
	const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
	if (d1 <= 0 && d2 <= 0)
		return {qx: ax, qy: ay, qz: az, part: 4};
	const bpx = px - bx, bpy = py - by, bpz = pz - bz;
	const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
	if (d3 >= 0 && d4 <= d3)
		return {qx: bx, qy: by, qz: bz, part: 5};
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const v = d1 / (d1 - d3);
		return {qx: ax + abx * v, qy: ay + aby * v, qz: az + abz * v, part: 1};
	}
	const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
	const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
	if (d6 >= 0 && d5 <= d6)
		return {qx: cx, qy: cy, qz: cz, part: 6};
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const w = d2 / (d2 - d6);
		return {qx: ax + acx * w, qy: ay + acy * w, qz: az + acz * w, part: 3};
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
		return {qx: bx + (cx - bx) * w, qy: by + (cy - by) * w, qz: bz + (cz - bz) * w, part: 2};
	}
	const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
	return {qx: ax + abx * v + acx * w, qy: ay + aby * v + acy * w, qz: az + abz * v + acz * w, part: 0};
}

// the field of a polyhedron, or undefined when no face of it has any area
export function trimesh(corners: float3[], faces: number[][]): TriMesh | undefined {
	// weld corners at the same place, since a triangle soup (an STL) repeats each at every triangle that uses it; the
	// hash only picks a bucket, the corners in it are compared exactly
	const buckets = new Map<number, number[]>(), points: float3[] = [], remap = new Int32Array(corners.length);
	corners.forEach((c, k) => {
		const hash = c.x * 0.7548776662 + c.y * 0.5698402910 + c.z * 0.3141592653;
		const bucket = buckets.get(hash);
		let i = bucket?.find(i => points[i].x === c.x && points[i].y === c.y && points[i].z === c.z);
		if (i === undefined) {
			i = points.length;
			points.push(c);
			if (bucket)
				bucket.push(i);
			else
				buckets.set(hash, [i]);
		}
		remap[k] = i;
	});
	const np = points.length, P = new Float64Array(np * 3);
	points.forEach((p, i) => P.set([p.x, p.y, p.z], i * 3));

	const tri: number[] = [];
	const add = (a: number, b: number, c: number) => {
		const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
		const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
		if (uy * vz - uz * vy || uz * vx - ux * vz || ux * vy - uy * vx)
			tri.push(a, b, c);
	};
	for (const face of faces) {
		const loop = face.filter(i => i >= 0 && i < corners.length).map(i => remap[i]);
		if (loop.length === 3)
			add(loop[0], loop[1], loop[2]);
		else
			for (const [a, b, c] of triangulate(loop, points))
				add(a, b, c);
	}
	const count = tri.length / 3;
	if (count === 0)
		return undefined;

	// wound so the normals face out, whichever way the source winds them (polyhedron() clockwise, STL anticlockwise)
	let volume = 0;
	for (let t = 0; t < tri.length; t += 3)
		volume += points[tri[t]].dot(points[tri[t + 1]].cross(points[tri[t + 2]]));
	if (volume < 0)
		for (let t = 0; t < tri.length; t += 3)
			[tri[t + 1], tri[t + 2]] = [tri[t + 2], tri[t + 1]];

	// the pseudonormals: a corner's is its triangles' normals weighted by the angle each makes there, an edge's the sum
	// of its two triangles' normals; each triangle keeps which three edges are its own
	const faceN = new Float64Array(count * 3), vertexN = new Float64Array(np * 3);
	const edgeOf = new Map<number, number>(), triEdge = new Int32Array(count * 3);
	const edgeN = new Float64Array(count * 9), uses = new Int32Array(count * 3), forward = new Int32Array(count * 3);
	let edges = 0;
	for (let t = 0; t < count; t++) {
		const i = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
		const e1 = [0, 1, 2].map(a => P[i[1] * 3 + a] - P[i[0] * 3 + a]), e2 = [0, 1, 2].map(a => P[i[2] * 3 + a] - P[i[0] * 3 + a]);
		const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
		const len = Math.hypot(n[0], n[1], n[2]);
		faceN.set(n.map(x => x / len), t * 3);
		for (let k = 0; k < 3; k++) {
			const a = i[k], b = i[(k + 1) % 3], c = i[(k + 2) % 3];
			const u = [0, 1, 2].map(x => P[b * 3 + x] - P[a * 3 + x]), v = [0, 1, 2].map(x => P[c * 3 + x] - P[a * 3 + x]);
			const angle = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2])))));
			for (let x = 0; x < 3; x++)
				vertexN[a * 3 + x] += faceN[t * 3 + x] * angle;
			const key = Math.min(a, b) * np + Math.max(a, b);
			let e = edgeOf.get(key);
			if (e === undefined)
				edgeOf.set(key, e = edges++);
			for (let x = 0; x < 3; x++)
				edgeN[e * 3 + x] += faceN[t * 3 + x];
			uses[e]++;
			forward[e] += a < b ? 1 : -1;
			triEdge[t * 3 + k] = e;
		}
	}
	let closed = true;
	for (let e = 0; e < edges; e++)
		closed &&= uses[e] === 2 && forward[e] === 0;

	// the hierarchy: split each run of triangles at the median of their centres along its widest axis
	const order = Uint32Array.from({length: count}, (_, t) => t);
	const lo = new Float64Array(count * 3), hi = new Float64Array(count * 3), mid = new Float64Array(count * 3);
	for (let t = 0; t < count; t++)
		for (let a = 0; a < 3; a++) {
			const x = P[tri[t * 3] * 3 + a], y = P[tri[t * 3 + 1] * 3 + a], z = P[tri[t * 3 + 2] * 3 + a];
			lo[t * 3 + a] = Math.min(x, y, z);
			hi[t * 3 + a] = Math.max(x, y, z);
			mid[t * 3 + a] = (lo[t * 3 + a] + hi[t * 3 + a]) / 2;
		}
	const nodes = new Float32Array(2 * count * 8);		// a leaf holds at least one triangle, so at most 2 count - 1 nodes
	let used = 0;
	const build = (first: number, n: number): number => {
		const at = used++;
		const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
		const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
		for (let k = first; k < first + n; k++) {
			const t = order[k];
			for (let a = 0; a < 3; a++) {
				bmin[a] = Math.min(bmin[a], lo[t * 3 + a]);
				bmax[a] = Math.max(bmax[a], hi[t * 3 + a]);
				cmin[a] = Math.min(cmin[a], mid[t * 3 + a]);
				cmax[a] = Math.max(cmax[a], mid[t * 3 + a]);
			}
		}
		// padded a hair, so that float32 rounding in the texture cannot put a triangle outside its box
		const pad = 1e-6 * Math.max(1, ...bmin.map(Math.abs), ...bmax.map(Math.abs));
		nodes.set([bmin[0] - pad, bmin[1] - pad, bmin[2] - pad], at * 8);
		nodes.set([bmax[0] + pad, bmax[1] + pad, bmax[2] + pad], at * 8 + 4);
		if (n <= LEAF) {
			nodes[at * 8 + 3] = -(first + 1);
			nodes[at * 8 + 7] = n;
			return at;
		}
		const axis = [0, 1, 2].reduce((best, a) => cmax[a] - cmin[a] > cmax[best] - cmin[best] ? a : best, 0);
		const half = n >> 1;
		select(order, first, first + n - 1, first + half, t => mid[t * 3 + axis]);
		nodes[at * 8 + 3] = build(first, half);
		nodes[at * 8 + 7] = build(first + half, n - half);
		return at;
	};
	build(0, count);

	const tris = new Uint32Array(count * 3), triData = new Float32Array(count * TRI_TEXELS * 4);
	for (let k = 0; k < count; k++) {
		const t = order[k], i = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
		tris.set(i, k * 3);
		const put = (slot: number, from: Float64Array, at: number) => triData.set(from.subarray(at * 3, at * 3 + 3), (k * TRI_TEXELS + slot) * 4);
		i.forEach((v, j) => {
			put(j, P, v);
			put(4 + j, edgeN, triEdge[t * 3 + j]);
			put(7 + j, vertexN, v);
		});
		put(3, faceN, t);
	}

	const box = [0, 1, 2].map(a => {
		let min = Infinity, max = -Infinity;
		for (let i = a; i < P.length; i += 3) {
			min = Math.min(min, P[i]);
			max = Math.max(max, P[i]);
		}
		return [min, max];
	});
	return {k: 'trimesh', points, tris, closed, min: float3(box[0][0], box[1][0], box[2][0]), max: float3(box[0][1], box[1][1], box[2][1]), nodes: nodes.slice(0, used * 8), triData};
}

// which of a triangle's ten vec4s holds the pseudonormal of each part nearest() names
const PART_NORMAL = [3, 4, 5, 6, 7, 8, 9];

function trimeshDistance(s: TriMesh, p: float3): number {
	const nodes = s.nodes, data = s.triData;
	let best = Infinity, sign = 1;
	const stack: {node: number, gap: number}[] = [{node: 0, gap: 0}];
	while (stack.length) {
		const {node, gap} = stack.pop()!;
		if (gap > 0 && gap >= best)
			continue;
		const left = nodes[node * 8 + 3], right = nodes[node * 8 + 7];
		if (left < 0) {
			const first = -left - 1;
			for (let k = first; k < first + right; k++) {
				const at = k * TRI_TEXELS * 4;
				const {qx, qy, qz, part} = nearest(p.x, p.y, p.z, data, at);
				const dx = p.x - qx, dy = p.y - qy, dz = p.z - qz, d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < best) {
					best = d2;
					const n = at + PART_NORMAL[part] * 4;
					sign = dx * data[n] + dy * data[n + 1] + dz * data[n + 2] < 0 ? -1 : 1;
				}
			}
		} else {
			const gl = boxDistance2(p, nodes, left * 8), gr = boxDistance2(p, nodes, right * 8);
			// the farther child goes on first so that the nearer is taken off first
			if (gl < gr)
				stack.push({node: right, gap: gr}, {node: left, gap: gl});
			else
				stack.push({node: left, gap: gl}, {node: right, gap: gr});
		}
	}
	return sign * Math.sqrt(best);
}

//-----------------------------------------------------------------------------
// bounds
//-----------------------------------------------------------------------------

// The box the model lives in, from each primitive's own extents: conservative where a shape's exact box is awkward
// (an n-gon is taken as its circumcircle), which only makes the camera a little further back and the trace a little longer.
function bounds3(s: Sdf): Box3 | undefined {
	switch (s.k) {
		case 'empty':
			return undefined;
		case 'sphere':
			return new Box3(expand3(-s.r), expand3(s.r));
		case 'box': {
			const h = s.center ? s.size.scale(0.5) : float3(0, 0, 0);
			return new Box3(h.neg(), s.size.sub(h));
		}
		case 'cylinder':
		case 'ngonPrism': {
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
			return new Box3(float3(-s.r, -s.r, Math.min(z0, z1)), float3(s.r, s.r, Math.max(z0, z1)));
		}
		case 'cone': {
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h, r = Math.max(s.r1, s.r2);
			return new Box3(float3(-r, -r, Math.min(z0, z1)), float3(r, r, Math.max(z0, z1)));
		}
		case 'planes': {
			let min = float3(Infinity, Infinity, Infinity), max = float3(-Infinity, -Infinity, -Infinity);
			for (const p of s.points) {
				min = min.min(p);
				max = max.max(p);
			}
			return new Box3(min, max);
		}
		case 'capsule':
			return new Box3(s.a.min(s.b).sub(expand3(s.r)), s.a.max(s.b).add(expand3(s.r)));
		case 'roundCone': {
			const r = Math.max(s.r1, s.r2);
			return new Box3(s.a.min(s.b).sub(expand3(r)), s.a.max(s.b).add(expand3(r)));
		}
		case 'heightmap': {
			if (!s.wrap)
				return new Box3(float3(0, 0, s.bottom), float3(s.cols - 1, s.rows - 1, s.top));
			// a wrapped map lives on a surface of radius r: the sphere's own box, or the cylinder's, rows one apart
			const R = Math.max(s.wrap.r + Math.max(s.top, s.bottom), 0), h = (s.rows - 1) / 2 * (s.wrap.row ?? 1);
			return s.wrap.kind === 'sphere'
				? new Box3(expand3(-R), expand3(R))
				: new Box3(float3(-R, -R, -h), float3(R, R, h));
		}
		case 'fnfield':
		case 'displace':
			return s.box;
		case 'trimesh':
			return new Box3(s.min, s.max);
		case 'union': {
			let out: Box3 | undefined;
			for (const c of s.children) {
				const b = bounds3(c);
				if (!b)
					continue;
				out = out ? new Box3(out.min.min(b.min), out.max.max(b.max)) : b;
			}
			return out;
		}
		case 'intersection': {
			// the intersection of the children's own boxes, not their union: a child with no box of its own (a
			// 2-D shape, say) does not narrow it, the same as it does not widen a union's
			let out: Box3 | undefined;
			for (const c of s.children) {
				const b = bounds3(c);
				if (!b)
					continue;
				out = out ? new Box3(out.min.max(b.min), out.max.min(b.max)) : b;
			}
			// boxes that do not overlap on some axis mean the intersection itself is empty
			return out && out.min.x <= out.max.x && out.min.y <= out.max.y && out.min.z <= out.max.z ? out : undefined;
		}
		case 'difference':
			return bounds3(s.base);
		case 'domain': {
			// A shape with its own corners -- a polyhedron, an n-gon -- is bounded by those, not by the corners of its
			// axis-aligned box: a rotation carries the box's corners a long way out past the shape they contain.
			let corners = verticesOf3(s.body);
			if (!corners) {
				const b = bounds3(s.body);
				if (!b)
					return undefined;
				corners = [];
				for (let i = 0; i < 8; i++)
					corners.push(float3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
			}
			let min = float3(Infinity, Infinity, Infinity), max = float3(-Infinity, -Infinity, -Infinity);
			for (const c of corners) {
				const p = s.m.mulPos(c);
				min = min.min(p);
				max = max.max(p);
			}
			return new Box3(min, max);
		}
		case 'warp': {
			// the body's z is the radius it stands off r, and its y runs along the axis (a cylinder) or from pole to
			// pole (a sphere, which the turn's own angle then cuts a lune out of)
			const R = s.r + (s.box.max.z - s.box.min.z);	// the body's floor sits on r, its top is the thickness
			if (s.kind === 'sphere')
				return new Box3(expand3(-R), expand3(R));
			// the axis the bend was given, or the body's own height -- which is what h defaults to, the body fitted
			// to an axis of its own length being the body itself
			const h = (s.axis ?? (s.box.max.y - s.box.min.y)) / 2;
			return new Box3(float3(-R, -R, -h), float3(R, R, h));
		}
		case 'dilate': {
			const b = bounds3(s.body);
			if (!b)
				return undefined;			// A flat brush grows the body only in its own plane: a disc of radius r whose normal is dir reaches
			// r * sqrt(1 - dir_a^2) along axis a, so along the direction it is flat in the box does not grow at all.
			const brush = s.support.q ? planeBrush(s.body, s.support) : undefined;
			if (brush) {
				const r = s.support.r, d = brush.dir;
				const e = float3(r * Math.sqrt(Math.max(0, 1 - d.x * d.x)), r * Math.sqrt(Math.max(0, 1 - d.y * d.y)), r * Math.sqrt(Math.max(0, 1 - d.z * d.z)));
				return new Box3(b.min.sub(e), b.max.add(e));
			}
			return new Box3(b.min.sub(expand3(s.support.bound)), b.max.add(expand3(s.support.bound)));
		}
		case 'material':
			return bounds3(s.body);
		case 'extrude': {
			// the one place a 2-D shape becomes a solid, and so the one place with bounds
			const b = bounds2(s.body);
			if (!b)
				return undefined;
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
			return new Box3(float3(b.min.x, b.min.y, Math.min(z0, z1)), float3(b.max.x, b.max.y, Math.max(z0, z1)));
		}
		case 'revolve': {
			// the 2-D shape's x is the radius and its y becomes z, so a point at (x, y) sweeps a ring of radius x
			const b = bounds2(s.body);
			if (!b)
				return undefined;
			const r = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
			return new Box3(float3(-r, -r, b.min.y), float3(r, r, b.max.y));
		}
		case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'offset':
			return undefined;			// 2-D: no z extent at all, and no solid to put in a box
	}
}

// The plane a 2-D shape occupies. Separate from bounds() because a 2-D shape has no box of its own to give a camera,
// but an extrude needs to know where it lies.
export function bounds2(s: Sdf): Box2 | undefined {
	const union = (a: Box2 | undefined, b: Box2 | undefined) =>	!a ? b : !b ? a : new Box2(a.min.min(b.min), a.max.max(b.max));
	switch (s.k) {
		case 'material':
			return bounds2(s.body);
		case 'circle2':
			return new Box2(expand2(-s.r), expand2(s.r));
		case 'square2': {
			const h = s.center ? s.size.scale(0.5) : float2(0, 0);
			return new Box2(h.neg(), s.size.sub(h));
		}
		case 'polygon2': {
			let min = expand2(Infinity), max = expand2(-Infinity);
			let any = false;
			for (const path of s.paths)
				for (const p of path) {
					min = min.min(p);
					max = max.max(p);
					any = true;
				}
			return any ? new Box2(min, max) : undefined;
		}
		case 'curvepath2': {
			// a quadratic Bezier always lies within the hull of its own start, control and end points, so their box
			// is a safe (if occasionally slightly loose, for a curve that doesn't reach its control point's corner) bound
			const ext = float2.extent.from(s.paths.map(v => float2(v.x, v.y)));
			return ext;
		}
		case 'offset': {
			const b = bounds2(s.body);
			return b ? new Box2(b.min.sub(expand2(s.r)), b.max.add(expand2(s.r))) : undefined;
		}
		case 'stadium2':
			return new Box2(s.a.min(s.b).sub(expand2(s.r)), s.a.max(s.b).add(expand2(s.r)));
		case 'union': case 'intersection':
			return s.children.reduce((a, c) => union(a, bounds2(c)), undefined as Box2 | undefined);
		case 'difference':
			return bounds2(s.base);
		case 'domain': {
			// conservative, as bounds() is for a transform: carry the child's own corners through the frame
			const b = bounds2(s.body);
			if (!b)
				return undefined;
			let min = expand2(Infinity), max = expand2(-Infinity);
			for (let i = 0; i < 4; i++) {
				const p = s.m.mulPos(float3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, 0)).xy;
				min = min.min(p);
				max = max.max(p);
			}
			return new Box2(min, max);
		}
		default:
			return undefined;
	}
}

// Why a field has nothing to show, when it has nothing to show. The warnings are usually the diagnosis and the
// sentence without them is only the symptom: an `undef` somewhere leaves an empty field, and "no geometry reached the
// top level" says nothing about which name was undef. Returns undefined when there is something to draw.
export function emptyReason(sdf: Sdf, warnings: string[]): string | undefined {
	const why = warnings.length ? `\n\nThe evaluator also reported:\n  ${warnings.join('\n  ')}` : '';
	const box = bounds3(sdf);
	if (!box)
		return `nothing is drawn: no geometry reached the top level (check the conditions around it).${why}`;
	if (!Number.isFinite(box.min.x) || !Number.isFinite(box.min.y) || !Number.isFinite(box.min.z))
		return `the geometry has no finite extent.${why}`;
	return undefined;
}

// The corners of a shape that has a known finite set of them, so a frame around it can be taken from those, or one
// that cannot be folded into the shape's own distance formula can be rebuilt from its transformed corners instead
// (see place(), in evaluate.ts). undefined for a shape whose box is the honest answer -- a sphere, a cylinder's
// round side, anything already a combinator of several bodies rather than one with corners of its own.
export function verticesOf3(s: Sdf): float3[] | undefined {
	switch (s.k) {
		case 'material':
			return verticesOf3(s.body);
		case 'planes': case 'trimesh':
			return [...s.points];
		case 'box': {
			const lo = s.center ? s.size.scale(-0.5) : float3(0, 0, 0), hi = lo.add(s.size);
			return Array.from({length: 8}, (_, i) => float3(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z));
		}
		case 'ngonPrism': {
			// OpenSCAD generates the vertices from angle 0, so the first is on +x
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h, out: float3[] = [];
			for (let i = 0; i < s.n; i++) {
				const a = 2 * Math.PI * i / s.n;
				for (const z of [z0, z1])
					out.push(float3(s.r * Math.cos(a), s.r * Math.sin(a), z));
			}
			return out;
		}
		default:
			return undefined;
	}
}

// The 2-D form of verticesOf: a polygon, a square, or an n-gon circle's corners. A smooth circle (n = 0) has no
// finite vertex set -- there is no polygon to fall back to, only the exact formula itself.
export function verticesOf2(s: Sdf): float2[] | undefined {
	switch (s.k) {
		case 'material':
			return verticesOf2(s.body);
		case 'square2': {
			const h = s.center ? s.size.scale(0.5) : float2(0, 0);
			const lo = h.neg(), hi = s.size.sub(h);
			return [lo, float2(hi.x, lo.y), hi, float2(lo.x, hi.y)];
		}
		case 'polygon2':
			return s.paths.flat();
		case 'circle2':
			return s.n < 3 ? undefined : Array.from({length: s.n}, (_, i) => {
				const a = 2 * Math.PI * i / s.n;
				return float2(s.r * Math.cos(a), s.r * Math.sin(a));
			});
		default:
			return undefined;
	}
}

// The box a term can be culled by: a 3-D term's own bounds. A 2-D one (a glyph of a text(), or one circle of several,
// before the lot is extruded) has none, being no solid, but its field does not depend on z, so the box of its plane
// carried out to infinity in z bounds it just as well -- and gives a union of them the same culling any other union
// gets, instead of every glyph being asked at every step.
function cullBox(s: Sdf): Box3 | undefined {
	const b = bounds3(s);
	if (b || !is2d(s))
		return b;
	const b2 = bounds2(s);
	return b2 && new Box3(float3(b2.min.x, b2.min.y, -Infinity), float3(b2.max.x, b2.max.y, Infinity));
}

// the largest extent of a box that has one -- the padding is a fraction of it, and an unbounded axis must not make
// every other axis's padding unbounded too
function finiteSize(b: Box3): number {
	return Math.max(0, ...[b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].filter(Number.isFinite));
}

// A term's box is worked out once: the terms of a union are asked at every sample, and a box takes a walk of the tree.
const boxes = new WeakMap<Sdf, Box3 | null>();
function boxOf(s: Sdf): Box3 | undefined {
	let b = boxes.get(s);
	if (b === undefined) {
		b = cullBox(s) ?? null;
		boxes.set(s, b);
	}
	return b ?? undefined;
}

function boxDistance2(p: float3, n: Float32Array, at: number): number {
	const dx = Math.max(n[at] - p.x, 0, p.x - n[at + 4]);
	const dy = Math.max(n[at + 1] - p.y, 0, p.y - n[at + 5]);
	const dz = Math.max(n[at + 2] - p.z, 0, p.z - n[at + 6]);
	return dx * dx + dy * dy + dz * dz;
}


// how far p is from a box (0 inside it, and for a term with no box, which could be anywhere)
function boxDistance3(b: Box3 | undefined, p: float3): number {
	if (!b)
		return 0;
	// a hair of slack, so that rounding cannot put a point on the surface outside its own box
	const pad = 1e-9 * (1 + finiteSize(b));
	return Math.hypot(
		Math.max(b.min.x - pad - p.x, 0, p.x - b.max.x - pad),
		Math.max(b.min.y - pad - p.y, 0, p.y - b.max.y - pad),
		Math.max(b.min.z - pad - p.z, 0, p.z - b.max.z - pad));
}

//-----------------------------------------------------------------------------
// evaluating the field here, so the model can be measured without a GPU
//-----------------------------------------------------------------------------

// One face of a polyhedron, in a frame of its own: the plane it lies in, the perpendicular distance to that plane,
// and its vertices as 2-D coordinates within the face. The distance to the face as a *region* is what makes a rounded
// polyhedron round: taking the distance to the plane instead lets a face reach past its own edges.
interface Face {
	centre:	float3;
	u:		float3;
	v:		float3;
	tris:	[float2, float2, float2][];		// a fan, wound anticlockwise as seen from outside
}

// A face's frame is worked out once: it depends on nothing but the face, and the field asks for it at every sample.
const frames = new WeakMap<float3[], {n: float3, frame: Face | undefined}>();
function faceFrame(face: float3[], n: float3): Face | undefined {
	const known = frames.get(face);
	if (known && known.n.x === n.x && known.n.y === n.y && known.n.z === n.z)
		return known.frame;

	const frame = make(face, n);
	frames.set(face, {n, frame});
	return frame;


	function make(face: float3[], n: float3): Face | undefined {
		if (face.length < 3)
			return undefined;
		let centre = float3(0, 0, 0);
		for (const p of face)
			centre = centre.add(p)
		centre = centre.scale(1/ face.length);

		// u lies in the face; v = n x u, so (u, v, n) is right-handed and an anticlockwise face has positive area
		let u = float3(0, 0, 0);
		for (let i = 1; i < face.length && u.x === u.y && u.y === u.z; i++) {
			const d = face[i].sub(centre);
			const len = d.len();
			if (len > 1e-12)
				u = d.scale(1 / len);
		}
		if (u.x === u.y && u.y === u.z)
			return undefined;
		const v = n.cross(u);

		const flat = (p: float3) => float2(p.dot(u), p.dot(v));
		const flatCentre: float2 = flat(centre);
		const corners = face.map(p => flat(p).sub(flatCentre));

		let area = 0;
		for (let i = 0; i < corners.length; i++) {
			const a = corners[i], b = corners[(i + 1) % corners.length];
			area += a.x * b.y - b.x * a.y;
		}
		if (area < 0)
			corners.reverse();

		const tris: [float2, float2, float2][] = [];
		for (let i = 1; i + 1 < corners.length; i++)
			tris.push([corners[0], corners[i], corners[i + 1]]);
		return {centre, u, v, tris};
	}
}


// the signed distance in 2-D from q to the triangle, negative inside it
function tri2(q: float2, a: float2, b: float2, c: float2): number {
	const edge = (p: float2, r: float2, s: float2) => {
		const e = s.sub(p), w = r.sub(p);
		const t = Math.max(0, Math.min(1, w.dot(e) / e.dot(e) || 1));
		const dx = w.x - t * e.x, dy = w.y - t * e.y;
		return {side: e.x * w.y - e.y * w.x, d2: dx * dx + dy * dy};
	};
	const e0 = edge(a, q, b), e1 = edge(b, q, c), e2 = edge(c, q, a);
	const d = Math.sqrt(Math.min(e0.d2, e1.d2, e2.d2));
	return e0.side < 0 || e1.side < 0 || e2.side < 0 ? d : -d;
}

// Whether a union should be culled by its terms' boxes. Three or more terms always: a union asks all of them at every
// point, and the box test is cheap next to even one primitive. Two terms too when together they are heavy, which a
// recursive module makes them -- every level of a tree is the branch it draws plus one union of the two subtrees, and
// each subtree is far bigger than the box test that could rule it out. The count is worked out once per union, not
// at every sample.
const CULL_MIN	= 3, CULL_COST = 8;
const culls		= new WeakMap<Sdf[], boolean>();
function cullsUnion(children: Sdf[]): boolean {
	let c = culls.get(children);
	if (c === undefined) {
		c = children.length >= CULL_MIN || (children.length === 2 && children.reduce((n, k) => n + countPrimitives(k), 0) >= CULL_COST);
		culls.set(children, c);
	}
	return c;
}

// The nearest term of a union, and how far it is. A term can be no nearer than its box, so the one with the nearest
// box goes first and the rest are only asked while their box is nearer than the best so far -- or holds the point,
// where the field goes negative. This is what the generated glsl does, and the answer is the same as asking all of them.
function pickMin(children: Sdf[], p: float3): {child: Sdf | undefined, value: number} {
	if (!cullsUnion(children)) {
		let best = {child: undefined as Sdf | undefined, value: 1e20};
		for (const c of children) {
			const v = evalSdf(c, p);
			if (v < best.value)
				best = {child: c, value: v};
		}
		return best;
	}
	const gap = new Float64Array(children.length);
	let first = 0;
	for (let i = 0; i < children.length; i++) {
		gap[i] = boxDistance3(boxOf(children[i]), p);
		if (gap[i] < gap[first])
			first = i;
	}
	let child = children[first], value = evalSdf(child, p);
	for (let i = 0; i < children.length; i++)
		if (i !== first && (gap[i] <= 0 || gap[i] < value)) {
			const v = evalSdf(children[i], p);
			if (v < value || (v === value && i < children.indexOf(child))) {
				value = v;
				child = children[i];
			}
		}
	return {child, value};
}

// A difference is its base with each cut taken away, and a cut takes nothing away outside its box unless the point
// is deeper inside what is left than the box is far: the base goes first, and outside it no cut is asked at all.
function pickDifference(s: Sdf & {k: 'difference'}, p: float3): {value: number, cut: Sdf | undefined} {
	let value = evalSdf(s.base, p), cut: Sdf | undefined;
	for (const c of s.cuts) {
		const gap = boxDistance3(boxOf(c), p);
		if (gap <= 0 || gap < -value) {
			const v = -evalSdf(c, p);
			if (v > value) {
				value = v;
				cut = c;
			}
		}
	}
	return {value, cut};
}

// The distance in the plane to a (possibly multi-path) polygon, signed by an odd-even crossing test run across every
// path's edges with one shared parity -- the standard test, which handles a concave outline and, with more than one
// path, holes or islands (a hole's own crossings flip the parity back); it is what makes polygon() a field rather
// than a stack of half-planes. The per-edge test below is the one maths' crossesRay (and line2.crossesRay) run: it is
// written out rather than called because this is a per-edge inner loop, where the call measured ~20% slower -- and
// going through line2.closestPoint for the distance on top of that allocates, ~11x slower again.
function polygonDistance2(px: number, py: number, paths: float2[][]): number {
	let d2 = Infinity, sign = 1;
	for (const points of paths) {
		if (!points.length)
			continue;
		d2 = Math.min(d2, (px - points[0].x) ** 2 + (py - points[0].y) ** 2);
		for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
			const {x: ax, y: ay} = points[j], {x: bx, y: by} = points[i];	// v0 is the previous vertex, v1 the current one
			const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
			const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
			d2 = Math.min(d2, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
			const c0 = py >= ay, c1 = py < by, c2 = ex * wy > ey * wx;
			if (c0 === c1 && c0 === c2)
				sign = -sign;
		}
	}
	return sign * Math.sqrt(d2);
}

// A solid of revolution, from the 2-D shape the point's own half-plane sees: rotating the shape about z means the
// point (x, y, z) is the profile point (hypot(x,y), z). That is exact for a full turn, since the nearest point of the
// surface is always in the point's own half-plane. A partial turn is the same solid cut by a wedge through the axis,
// which the intersection bound max() is enough for.
function revolveDistance(s: Sdf & {k: 'revolve'}, p: float3): number {
	const radius = Math.hypot(p.x, p.y);
	const d = evalSdf(s.body, float3(radius, p.z, 0));
	if (s.angle >= 360)
		return d;
	const half = s.angle * Math.PI / 360;
	const angle = Math.atan2(p.y, p.x);
	// The wedge |angle| <= half, as the furthest of its two bounding half-planes. Both run through the axis, so the
	// distance to the one at angle h is radius*sin(angle - h): zero on the boundary, positive on the far side.
	const wedge = Math.max(radius * Math.sin(angle - half), radius * Math.sin(-half - angle));
	return Math.max(d, wedge);
}

// the 2D distance to a regular n-gon of circumradius r, shared by the evaluated field and its glsl
function ngonDistance(x: number, y: number, r: number, n: number): number {
	const an = Math.PI / n;
	const ang = Math.atan2(x, y) - (Math.PI / 2 - an);		// OpenSCAD's first vertex is on +x
	const folded = ang - 2 * an * Math.round(ang / (2 * an));
	return Math.hypot(x, y) * Math.cos(folded) - r * Math.cos(an);
}

// The exact distance to a smooth taper (cylinder(r1, r2) with r1 != r2): Inigo Quilez's capped-cone construction,
// which handles r1 or r2 being 0 (a point) as a special case of the same formula rather than needing one of its
// own. Adapted from its canonical form (the axis along y, centred on the origin) to this evaluator's z-up axis and
// z0/z1 span by recentring p.z on the cone's own mid-height and using half of z1 - z0 in place of its h. Kept in
// step by hand with sdCone in sdflib.frag, since nothing generates either from the other.
function coneDistance(s: Sdf & {k: 'cone'}, p: float3): number {
	const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
	const hy = (z1 - z0) / 2;
	const qx = Math.hypot(p.x, p.y), qy = p.z - (z0 + z1) / 2;
	const k1x = s.r2, k1y = hy;
	const k2x = s.r2 - s.r1, k2y = 2 * hy;
	const cax = qx - Math.min(qx, qy < 0 ? s.r1 : s.r2), cay = Math.abs(qy) - hy;
	const dotk2k2 = k2x * k2x + k2y * k2y;
	const t = dotk2k2 > 1e-12 ? Math.max(0, Math.min(1, ((k1x - qx) * k2x + (k1y - qy) * k2y) / dotk2k2)) : 0;
	const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
	const sign = cbx < 0 && cay < 0 ? -1 : 1;
	return sign * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}

// The exact distance to the hull of two balls of different radii, a.k.a. a "round cone": Inigo Quilez's construction,
// unlike coneDistance's (a flat-capped frustum) this has a spherical cap at each end and is exactly what a mixed
// hull() (see weightedHull3 below) needs along an edge between two points of any radii, including zero. Degenerates
// to the plain capsule formula at r1 = r2, and is guarded separately for two more degenerate inputs neither capsule
// nor a plain cone need worry about: coincident centres (whichever radius is bigger is the whole answer), and a
// radius difference bigger than the distance between the centres (the smaller ball is entirely in the bigger one's
// shadow along the axis, so again the bigger ball alone is the answer). Kept in step by hand with sdRoundCone in
// sdflib.frag, since nothing generates either from the other.
function roundConeDistance(p: float3, a: float3, b: float3, r1: number, r2: number): number {
	const ba = b.sub(a);
	const l2 = ba.dot(ba);
	if (l2 < 1e-18)
		return p.sub(a).len() - Math.max(r1, r2);
	const rr = r1 - r2;
	const a2 = l2 - rr * rr;
	if (a2 <= 0)
		return r1 >= r2 ? p.sub(a).len() - r1 : p.sub(b).len() - r2;
	const il2 = 1 / l2;
	const pa = p.sub(a);
	const y = pa.dot(ba);
	const z = y - l2;
	const w = pa.scale(l2).sub(ba.scale(y));
	const x2 = w.dot(w);
	const y2 = y * y * l2;
	const z2 = z * z * l2;
	const k = Math.sign(rr) * rr * rr * x2;
	if (Math.sign(z) * a2 * z2 > k)
		return Math.sqrt(x2 + z2) * il2 - r2;
	if (Math.sign(y) * a2 * y2 < k)
		return Math.sqrt(x2 + y2) * il2 - r1;
	return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function evalSdf(s: Sdf, p: float3): number {
	switch (s.k) {
		case 'empty':
			return 1e20;
		case 'sphere':
			return p.len() - s.r;
		case 'box': {
			// the box spans [h, h+size] with h = center ? -size/2 : 0, so its *centre* is 0 when centered and
			// size/2 otherwise -- not the other way round, which is a displacement of size/2 in every axis
			const c = s.center ? expand3(0) : s.size.scale(0.5);
			const q = float3(Math.abs(p.x - c.x) - s.size.x / 2, Math.abs(p.y - c.y) - s.size.y / 2, Math.abs(p.z - c.z) - s.size.z / 2);
			const outside = float3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0)).len();
			return outside + Math.min(Math.max(q.x, q.y, q.z), 0);
		}
		case 'cylinder':
		case 'ngonPrism': {
			const z = s.center ? Math.abs(p.z) - s.h / 2 : Math.max(-p.z, p.z - s.h);
			const r = s.k === 'cylinder' ? Math.hypot(p.x, p.y) - s.r : ngonDistance(p.x, p.y, s.r, s.n);
			return Math.max(r, z);
		}
		case 'cone':
			return coneDistance(s, p);
		case 'planes': {
			const plane = s.planes.reduce((best, pl) => Math.max(best, pl.n.x * p.x + pl.n.y * p.y + pl.n.z * p.z - pl.d), -1e20);
			let best = Infinity;
			for (let i = 0; i < s.planes.length; i++) {
				const pl = s.planes[i];
				const perp = pl.n.x * p.x + pl.n.y * p.y + pl.n.z * p.z - pl.d;
				const a = Math.abs(perp);
				if (a >= best || !s.faces[i])
					continue;
				const frame = faceFrame(s.faces[i], pl.n);
				if (!frame)
					continue;
				const d = p.sub(frame.centre);
				const q = float2(d.dot(frame.u), d.dot(frame.v));
				let inside = Infinity;
				for (const t of frame.tris)
					inside = Math.min(inside, tri2(q, t[0], t[1], t[2]));
				const region = Math.max(inside, 0);
				best = Math.min(best, Math.hypot(perp, region));
			}
			return plane > 0 ? best : -best;
		}
		case 'union':
			return pickMin(s.children, p).value;
		case 'intersection':
			return s.children.reduce((best, c) => Math.max(best, evalSdf(c, p)), -1e20);
		case 'difference':
			return pickDifference(s, p).value;
		case 'domain': {
			const inv = inverseOrIdentity(s.m);
			const q = inv.mulPos(p)
			return evalSdf(s.body, q) * s.scale;
		}
		case 'warp':
			return warpDistance(s, p);
		case 'material':
			return evalSdf(s.body, p);
		case 'circle2':
			return s.n ? ngonDistance(p.x, p.y, s.r, s.n) : Math.hypot(p.x, p.y) - s.r;
		case 'square2': {
			const h: float2 = s.center ? float2(s.size.x / 2, s.size.y / 2) : float2(0, 0);
			const c: float2 = float2(s.size.x / 2 - h.x, s.size.y / 2 - h.y);
			const q: float2 = float2(Math.abs(p.x - c.x) - s.size.x / 2, Math.abs(p.y - c.y) - s.size.y / 2);
			return Math.hypot(Math.max(q.x, 0), Math.max(q.y, 0)) + Math.min(Math.max(q.x, q.y), 0);
		}
		case 'polygon2':
			return polygonDistance2(p.x, p.y, s.paths);
		case 'curvepath2':
			return curveDistance(p.xy, s.paths);
		case 'offset':
			return evalSdf(s.body, p) - s.r;
		case 'extrude': {
			// max(d2, dz) alone is only the true distance next to a face (where at most one of the two is outside);
			// past a corner -- outside the 2-D shape's own edge *and* past the cap -- the nearest point is the edge
			// itself, and the exact distance to it needs the usual rounded-box correction (Inigo Quilez's sdBox):
			// the "how deep inside" part stays max(d2, dz), and the "how far outside" part becomes their hypotenuse
			// rather than the larger of the two. Without this, minkowski()/offset() of an extrusion undershoots
			// near every corner, and (since it stays negative for too long) looks flat far past where it should
			// have started rounding off.
			const d2 = evalSdf(s.body, p);
			const dz = s.center ? Math.abs(p.z) - s.h / 2 : Math.max(-p.z, p.z - s.h);
			return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
		}
		case 'revolve':
			return revolveDistance(s, p);
		case 'dilate': {
			const brush = planeBrush(s.body, s.support);
			if (brush) {
				// the same rounded-box correction as 'extrude' (see its own comment): past a corner of the slab --
				// outside the cross-section's own grown edge *and* past the cap -- plain max() undershoots
				const along = p.dot(brush.dir);
				const flat = p.sub(brush.dir.scale(along - brush.mid));
				const d2 = evalSdf(brush.sides, flat) - s.support.r;
				const dz = Math.abs(along - brush.mid) - brush.half;
				return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
			}
			const d = evalSdf(s.body, p);
			if (!s.support.q)
				return d - s.support.r;
			const e = 1e-4 * Math.max(1, Math.abs(d));
			const dx = float3(e, 0, 0);
			const dy = float3(0, e, 0);
			const dz = float3(0, 0, e);
			const gx = evalSdf(s.body, p.add(dx)) - evalSdf(s.body, p.sub(dx));
			const gy = evalSdf(s.body, p.add(dy)) - evalSdf(s.body, p.sub(dy));
			const gz = evalSdf(s.body, p.add(dz)) - evalSdf(s.body, p.sub(dz));
			const g = float3(gx, gy, gz);
			const gl = g.len() || 1;
			const n = g.scale(1 / gl);
			return d - supportDistance(s.support, n);
		}
		case 'capsule': {
			const pa = p.sub(s.a), ba = s.b.sub(s.a);
			const h = Math.max(0, Math.min(1, pa.dot(ba) / (ba.dot(ba) || 1)));
			return pa.sub(ba.scale(h)).len() - s.r;
		}
		case 'roundCone':
			return roundConeDistance(p, s.a, s.b, s.r1, s.r2);
		case 'heightmap':
			return heightmapDistance(s, p);
		case 'fnfield': {
			// the box it stands in, and the field's own estimate inside it: both are bounds, so the larger is one too
			const c = s.box.centre(), h = s.box.size().scale(0.5);
			const qx = Math.abs(p.x - c.x) - h.x, qy = Math.abs(p.y - c.y) - h.y, qz = Math.abs(p.z - c.z) - h.z;
			const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
			return Math.max(box, s.fn.distance(p.x, p.y, p.z));
		}
		case 'trimesh':
			return trimeshDistance(s, p);
		case 'displace':
			return displaceDistance(s, p);
		case 'stadium2': {
			const pa = float2(p.x, p.y).sub(s.a), ba = s.b.sub(s.a);
			const h = Math.max(0, Math.min(1, pa.dot(ba) / (ba.dot(ba) || 1)));
			return Math.hypot(pa.x - ba.x * h, pa.y - ba.y * h) - s.r;
		}
	}
}

// How far from a displaced surface, as the shader's 'displace' term has it: the larger of the body's distance less hi and
// the field over 1 + slope (the smaller of it and the body's distance less lo, inside). The second can only be the larger
// within (hi - lo) / slope of the shell h can reach, so beyond that the first is taken without asking h -- exactly where
// the two agree, which keeps the estimate continuous.
const displaceReach = (s: Displace) => s.slope > 0 ? (s.hi - s.lo) / s.slope : 1e30;

function displaceDistance(s: Displace, p: float3): number {
	const d = evalSdf(s.body, p), reach = displaceReach(s);
	if (d - s.hi > reach)
		return d - s.hi;
	if (d - s.lo < -reach)
		return d - s.lo;
	const n = s.fn.normal || s.base ? numericNormal(s.body, p, s.eps) : float3(0, 0, 0);
	const q = s.base ? p.sub(n.scale(d)) : p;
	const h = s.fn.value(q.x, q.y, q.z, n.x, n.y, n.z);
	const f = (d - (Number.isNaN(h) ? 0 : h)) / (1 + s.slope);
	return f >= 0 ? Math.max(f, d - s.hi) : Math.min(f, d - s.lo);
}

// The outward normal of the surface at a point that is on it (or so near it that nothing else is): the direction the
// field increases. Most of a model's surface is a plane, a sphere, a cylinder or a box side, whose normal is known
// exactly, so it is taken from whichever primitive decides the field there, through the combinators and transforms.
// What has no formula here -- a Minkowski sum, an offset, a 2-D shape -- is differenced, but only that term rather than
// the whole model. Six evaluations of the whole tree was what this replaces.
function surfaceNormal(s: Sdf, p: float3, eps: number): float3 {
	const n = analyticNormal(s, p, eps);
	const l = n ? n.len() : 0;
	return n && l > 1e-9 ? n.scale(1 / l) : numericNormal(s, p, eps);
}

function numericNormal(s: Sdf, p: float3, eps: number): float3 {
	const g = float3(
		evalSdf(s, float3(p.x + eps, p.y, p.z)) - evalSdf(s, float3(p.x - eps, p.y, p.z)),
		evalSdf(s, float3(p.x, p.y + eps, p.z)) - evalSdf(s, float3(p.x, p.y - eps, p.z)),
		evalSdf(s, float3(p.x, p.y, p.z + eps)) - evalSdf(s, float3(p.x, p.y, p.z - eps)));
	return normalize(g);
}

// the gradient of one term, unnormalised, or undefined where there is no formula for it
function analyticNormal(s: Sdf, p: float3, eps: number): float3 | undefined {
	switch (s.k) {
		case 'sphere':
			return p;
		case 'box': {
			const c = s.center ? expand3(0) : s.size.scale(0.5);
			const d = p.sub(c);
			const q = [Math.abs(d.x) - s.size.x / 2, Math.abs(d.y) - s.size.y / 2, Math.abs(d.z) - s.size.z / 2];
			const sign = [d.x < 0 ? -1 : 1, d.y < 0 ? -1 : 1, d.z < 0 ? -1 : 1];
			if (q[0] > 0 || q[1] > 0 || q[2] > 0)
				return float3(sign[0] * Math.max(q[0], 0), sign[1] * Math.max(q[1], 0), sign[2] * Math.max(q[2], 0));
			const axis = q[0] >= q[1] && q[0] >= q[2] ? 0 : q[1] >= q[2] ? 1 : 2;
			return float3(axis === 0 ? sign[0] : 0, axis === 1 ? sign[1] : 0, axis === 2 ? sign[2] : 0);
		}
		case 'cylinder':
		case 'ngonPrism': {
			const zTerm = s.center ? Math.abs(p.z) - s.h / 2 : Math.max(-p.z, p.z - s.h);
			const rTerm = s.k === 'cylinder' ? Math.hypot(p.x, p.y) - s.r : ngonDistance(p.x, p.y, s.r, s.n);
			if (rTerm >= zTerm) {
				if (s.k === 'cylinder')
					return float3(p.x, p.y, 0);
				// the nearest side of the polygon: the field there is the distance to the line through it, whose normal
				// is the direction of the point rotated by how far it is from that side's own
				const an = Math.PI / s.n;
				const ang = Math.atan2(p.x, p.y) - (Math.PI / 2 - an);
				const folded = ang - 2 * an * Math.round(ang / (2 * an));
				const side = Math.atan2(p.y, p.x) + folded;
				return float3(Math.cos(side), Math.sin(side), 0);
			}
			return float3(0, 0, s.center ? (p.z < 0 ? -1 : 1) : (-p.z > p.z - s.h ? -1 : 1));
		}
		case 'planes': {
			// on the surface a point is on one face's polygon, and the field there is that face's own plane distance
			let best = Infinity, face = -1;
			for (let i = 0; i < s.planes.length; i++) {
				const pl = s.planes[i];
				const perp = pl.n.x * p.x + pl.n.y * p.y + pl.n.z * p.z - pl.d;
				if (Math.abs(perp) >= best)
					continue;
				const frame = s.faces[i] ? faceFrame(s.faces[i], pl.n) : undefined;
				let region = 0;
				if (frame) {
					const d = p.sub(frame.centre);
					const q = float2(d.dot(frame.u), d.dot(frame.v));
					let inside = Infinity;
					for (const t of frame.tris)
						inside = Math.min(inside, tri2(q, t[0], t[1], t[2]));
					region = Math.max(inside, 0);
				}
				const h = Math.hypot(perp, region);
				if (h < best) {
					best = h;
					face = i;
				}
			}
			return face < 0 ? undefined : s.planes[face].n;
		}
		case 'union': {
			const {child} = pickMin(s.children, p);
			return child && surfaceNormal(child, p, eps);
		}
		case 'intersection': {
			let best = -1e20, child: Sdf | undefined;
			for (const c of s.children) {
				const v = evalSdf(c, p);
				if (v > best) {
					best = v;
					child = c;
				}
			}
			return child && surfaceNormal(child, p, eps);
		}
		case 'difference': {
			const {cut} = pickDifference(s, p);
			return cut ? surfaceNormal(cut, p, eps).scale(-1) : surfaceNormal(s.base, p, eps);
		}
		case 'domain': {
			// the field is the body's at the point carried into the body's frame, so its gradient is the body's
			// carried back by the transpose of that map
			const inv = inverseOrIdentity(s.m);
			const nb = surfaceNormal(s.body, inv.mulPos(p), eps);
			return float3(inv.x.dot(nb), inv.y.dot(nb), inv.z.dot(nb));
		}
		case 'material':
			return surfaceNormal(s.body, p, eps);
		case 'offset':
			return surfaceNormal(s.body, p, eps);
		case 'extrude': {
			const zTerm = s.center ? Math.abs(p.z) - s.h / 2 : Math.max(-p.z, p.z - s.h);
			if (evalSdf(s.body, p) >= zTerm)
				return surfaceNormal(s.body, p, eps);
			return float3(0, 0, s.center ? (p.z < 0 ? -1 : 1) : (-p.z > p.z - s.h ? -1 : 1));
		}
		case 'capsule': {
			// the same clamped point as evalSdf: the gradient of a distance to a point is the direction to it
			const pa = p.sub(s.a), ba = s.b.sub(s.a);
			const h = Math.max(0, Math.min(1, pa.dot(ba) / (ba.dot(ba) || 1)));
			return pa.sub(ba.scale(h));
		}
		default:
			return undefined;
	}
}

//-----------------------------------------------------------------------------
// asking the field about a region, for the mesher
//-----------------------------------------------------------------------------
// A mesher samples the field in cells, and wants to know of each cell which parts of the model can matter in it, and
// whether the surface there is a plane it can describe with one vertex. Both are answers only the model can give, so they
// are asked of it, with `restrict` and `surfaceFrame`. Both rest on the field being a
// bound on distance, so that over a ball of radius r it changes by at most r.

// how far a field can change over a distance: 1 for a distance, more for the one kind that is only a bound on it, a
// Minkowski sum with a brush that is not a ball (measured with the brush's support along the body's normal, which changes
// abruptly where that normal does)
const reachOf = (s: Sdf) => s.k === 'dilate' && s.support.q ? 3 : 1;

// how far a transform can stretch a vector: the largest singular value of its linear part
const stretches = new WeakMap<float3x4, number>();
function stretchOf(inv: float3x4): number {
	let k = stretches.get(inv);
	if (k === undefined) {
		const c = [inv.x, inv.y, inv.z];
		const g = c.map(a => c.map(b => a.dot(b)));
		stretches.set(inv, k = Math.sqrt(Math.max(...eigenSymmetric(g).values)));
	}
	return k;
}

// two unit vectors square to d and to each other
function perpendicular(d: float3): [float3, float3] {
	const a = normalize(Math.abs(d.x) < 0.6 ? d.cross(float3(1, 0, 0)) : d.cross(float3(0, 1, 0)));
	return [a, d.cross(a)];
}

// the exact pieces of a convex polyhedron grown by a ball, as terms of the field like any other: a slab over each
// face (its polygon carried a radius out along the normal, and a radius in, where every point is still within r of the
// face and so inside the sum -- the inner half is there so that its far plane lies deep in the body rather than touching the
// body's own face), a cylinder along each edge, a ball at each vertex
function slabOver(n: float3, d: number, r: number, frame: Face, poly: float2[]): Sdf {
	const centre = frame.centre.add(n.scale(d - n.dot(frame.centre)));
	return {k: 'domain', m: float3x4(frame.u, frame.v, n, centre), scale: 1,
		body: {k: 'extrude', h: 2 * r, center: true, body: {k: 'polygon2', paths: [poly]}}};
}

function cylinderAlong(mid: float3, dir: float3, half: number, r: number): Sdf {
	const [a, b] = perpendicular(dir);
	return {k: 'domain', m: float3x4(a, b, dir, mid), scale: 1, body: {k: 'cylinder', r, h: 2 * half, center: true}};
}

// the points between two planes square to dir, as far out sideways as anything the mesher will ask about
const BAND_WIDTH = 1e9;
function bandAbout(dir: float3, mid: number, half: number): Sdf {
	const [a, b] = perpendicular(dir);
	return {k: 'domain', m: float3x4(a, b, dir, dir.scale(mid)), scale: 1, body: {k: 'box', size: float3(BAND_WIDTH, BAND_WIDTH, 2 * half), center: true}};
}

const fanOf = (frame: Face) => [frame.tris[0][0], frame.tris[0][1], ...frame.tris.map(t => t[2])];
const pointKey = (p: float3) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`;

// A prism grown by a disc lying square to its axis: the prism's cross-section grown by the disc, kept between the caps,
// which do not move. The grown cross-section is the cross-section, a slab over each side, and a cylinder along the axis
// at each corner, and the caps are a band -- so what the field measures as one distance is made of terms that are each
// a plane, a cylinder or nothing at all.
function decomposeBrush(b: PlaneBrush, r: number): Sdf | undefined {
	const sides = b.sides;
	if (sides.k !== 'planes' || sides.faces.some(f => !f || f.length < 3))
		return undefined;
	const along		= (p: float3) => p.dot(b.dir);
	const withAxis	= (p: float3, value: number) => p.sub(b.dir.scale(along(p) - value));

	const tall = b.half + 2 * r + 1;			// far enough along the axis that only the caps end them
	const kids: Sdf[] = [sides];
	const corners = new Map<string, float3>();
	for (let i = 0; i < sides.faces.length; i++) {
		const pl = sides.planes[i];
		// the side carried past the caps, so that it is the band that ends it
		const face = sides.faces[i].map(p => withAxis(p, along(p) >= b.mid ? b.mid + tall : b.mid - tall));
		const frame = faceFrame(face, pl.n);
		if (!frame)
			return undefined;
		kids.push(slabOver(pl.n, pl.d, r, frame, fanOf(frame)));
		for (const p of sides.faces[i]) {
			const at = withAxis(p, b.mid);
			corners.set(pointKey(at), at);
		}
	}
	for (const c of corners.values())
		kids.push(cylinderAlong(c, b.dir, tall, r));
	return {k: 'intersection', children: [bandAbout(b.dir, b.mid, b.half), {k: 'union', children: kids}]};
}

// A flat brush is the one Minkowski sum whose pieces are worth having as terms of their own: a window onto the field of
// just the slab or cylinder that matters in a cell is far cheaper than the whole sum, which measures the entire
// cross-section at every sample. Found once per sum.
const brushPieces = new WeakMap<Sdf, Sdf | null>();
function brushPiecesOf(s: Sdf & {k: 'dilate'}): Sdf | undefined {
	let pieces = brushPieces.get(s);
	if (pieces === undefined) {
		const brush = s.support.q ? planeBrush(s.body, s.support) : undefined;
		pieces = brush && decomposeBrush(brush, s.support.r) || null;
		brushPieces.set(s, pieces);
	}
	return pieces ?? undefined;
}

// The field restricted to the ball (c, r): a model with whatever cannot decide the surface inside the ball taken out
// of it, so that it is cheaper to ask and has less to be confused by. A part of a union that is above another's highest
// value cannot be the smallest anywhere in the ball (the same for the other combinators), and a part that is positive
// throughout cannot be zero anywhere in it, however it compares with the others. What is left is the handful of parts
// that could shape the surface there; a combination left with one part is that part.
export class Restricted extends SDF {
	constructor(root: Sdf, public lo = 0, public hi = Infinity) {
		super(root);
	}
}

function restrict(s: Sdf, c: float3, r: number): Restricted {
	const slack = 1e-9 * (1 + r);
	switch (s.k) {
		case 'union': {
			const got = s.children.map(k => restrict(k, c, r));
			let minHi = Infinity;
			for (const g of got)
				minHi = Math.min(minHi, g.hi);
			let keep = got.filter(g => g.lo <= minHi + slack && g.lo <= 0);
			if (!keep.length)
				keep = got.filter(g => g.lo <= minHi + slack);
			const lo = Math.min(...keep.map(g => g.lo));
			if (keep.length === 1)
				return new Restricted(keep[0].root, lo, minHi);
			return new Restricted(keep.length === got.length && keep.every((g, i) => g.root === s.children[i]) ? s : {k: 'union', children: keep.map(g => g.root)}, lo, minHi);
		}
		case 'intersection': {
			const got = s.children.map(k => restrict(k, c, r));
			let maxLo = -Infinity;
			for (const g of got)
				maxLo = Math.max(maxLo, g.lo);
			// and the other way about: a part that is negative throughout cannot be the largest where the largest is zero
			let keep = got.filter(g => g.hi >= maxLo - slack && g.hi >= 0);
			if (!keep.length)
				keep = got.filter(g => g.hi >= maxLo - slack);
			const hi = Math.max(...keep.map(g => g.hi));
			if (keep.length === 1)
				return new Restricted(keep[0].root, maxLo, hi);
			return new Restricted(keep.length === got.length && keep.every((g, i) => g.root === s.children[i]) ? s : {k: 'intersection', children: keep.map(g => g.root)}, maxLo, hi);
		}
		case 'difference': {
			// the largest of the base and the cuts' negations, so a cut is a part with its bounds turned over. The base stays,
			// since there is no field to leave if it were the part that went
			const base = restrict(s.base, c, r);
			const cuts = s.cuts.map(k => restrict(k, c, r));
			let maxLo = base.lo;
			for (const g of cuts)
				maxLo = Math.max(maxLo, -g.hi);
			const keep = cuts.filter(g => -g.lo >= maxLo - slack && -g.lo >= 0);
			const hi = Math.max(base.hi, ...keep.map(g => -g.lo));
			if (!keep.length)
				return new Restricted(base.root, maxLo, hi);
			const same = base.root === s.base && keep.length === cuts.length && keep.every((g, i) => g.root === s.cuts[i]);
			return new Restricted(same ? s : {k: 'difference', base: base.root, cuts: keep.map(g => g.root)}, maxLo, hi);
		}
		case 'domain': {
			// the ball, carried into the body's frame, sits inside a ball stretched by at most the transform's stretch
			const inv = inverseOrIdentity(s.m);
			const inner = restrict(s.body, inv.mulPos(c), r * stretchOf(inv));
			return new Restricted(inner.root === s.body ? s : {...s, body: inner.root}, inner.lo * s.scale, inner.hi * s.scale);
		}
		case 'material': {
			// kept round what is left of its body, so what the cell is made of can still be asked
			const inner = restrict(s.body, c, r);
			return new Restricted(inner.root === s.body ? s : {...s, body: inner.root}, inner.lo, inner.hi);
		}
		case 'dilate': {
			const pieces = brushPiecesOf(s);
			if (pieces)
				return restrict(pieces, c, r);
		}
		// falls through: a sum that is not taken apart is one term
		default: {
			const v = evalSdf(s, c), reach = reachOf(s) * r;
			return new Restricted(s, v - reach, v + reach);
		}
	}
}

export interface Plane {
	n:	float3;		// a unit normal; the plane is the points x with n.x = d
	d:	number;
}

// whether a solid is a convex polyhedron under transforms, so that a ball's growth of it leaves each face a plane
function convexPolyhedral(s: Sdf): boolean {
	return s.k === 'box' || s.k === 'planes' || ((s.k === 'domain' || s.k === 'material') && convexPolyhedral(s.body));
}

// the two caps of a prism of height h along z, as the plane fields of each (positive outside)
const capFields = (z: number, h: number, center: boolean): [number, number] =>
	center ? [-z - h / 2, z - h / 2] : [-z, z - h];

// how far a plane's field changes across the cell: the cell is the parallelepiped of the point plus or minus each of three
// vectors, a cube for the mesher and, carried into a transformed body's frame, the shape that cube becomes. A plane whose
// field at the point is less than minus this is behind the whole cell.
const spread = (n: float3, cell: float3[]) => cell.reduce((w, g) => w + Math.abs(n.dot(g)), 0);

// the farthest the cell reaches from its point, in all three directions or (for a field of the plane) in the plane
function circumradius(cell: float3[], planar = false): number {
	let best = 0;
	for (let m = 0; m < 4; m++) {					// the other four corners are the same distances
		let x = 0, y = 0, z = 0;
		for (let k = 0; k < 3; k++) {
			const sign = k === 0 ? 1 : (m >> (k - 1)) & 1 ? -1 : 1;
			x += sign * cell[k].x;
			y += sign * cell[k].y;
			z += sign * cell[k].z;
		}
		best = Math.max(best, planar ? Math.hypot(x, y) : Math.hypot(x, y, z));
	}
	return best;
}

// +1 if the polygon is one convex loop wound anticlockwise, -1 if clockwise, 0 if it is anything else
const convexity = new WeakMap<float2[][], number>();
function convexSense(s: Sdf & {k: 'polygon2'}): number {
	let sense = convexity.get(s.paths);
	if (sense === undefined) {
		sense = 0;
		if (s.paths.length === 1 && s.paths[0].length >= 3) {
			const pts = s.paths[0];
			let pos = 0, neg = 0, area = 0;
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
				const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
				if (turn > 1e-12) ++pos;
				else if (turn < -1e-12) ++neg;
				area += a.x * b.y - b.x * a.y;
			}
			if (!(pos && neg) && area !== 0)
				sense = area > 0 ? 1 : -1;
		}
		convexity.set(s.paths, sense);
	}
	return sense;
}

// A polygon's outline is a straight line where the nearest part of it is the inside of one edge: there its field is the
// signed distance to that edge's line, linear, and so is any offset of it. The edge holds the whole cell if the cell stays
// over the edge and every other edge stays farther than it is by the width of the cell.
function polygonPlane(s: Sdf & {k: 'polygon2'}, p: float3, cell: float3[]): Plane | undefined {
	let best = Infinity, second = Infinity, a = float2(0, 0), b = a;
	for (const path of s.paths)
		for (let i = 0; i < path.length; i++) {
			const u = path[i], v = path[(i + 1) % path.length];
			const e = v.sub(u), len2 = e.dot(e);
			const w = float2(p.x - u.x, p.y - u.y);
			const t = len2 > 0 ? Math.max(0, Math.min(1, w.dot(e) / len2)) : 0;
			const d = Math.hypot(w.x - e.x * t, w.y - e.y * t);
			if (d < best) {
				second = best;
				best = d;
				a = u;
				b = v;
			} else if (d < second)
				second = d;
		}
	const e = b.sub(a), len = e.len();
	if (!(len > 1e-12))
		return undefined;
	const dir = e.scale(1 / len), along = float2(p.x - a.x, p.y - a.y).dot(dir);
	const width = spread(float3(dir.x, dir.y, 0), cell);
	if (!(along >= width && len - along >= width))
		return undefined;
	// Outside a convex polygon, over an edge, the nearest part of the outline is that edge wherever the point is on the
	// outer side of its line, however near the next edge is by comparison. Elsewhere another edge must stay farther.
	const sense = convexSense(s);
	const out = sense ? float3(dir.y * sense, -dir.x * sense, 0) : undefined;
	if (!(out && out.x * (p.x - a.x) + out.y * (p.y - a.y) >= spread(out, cell)) && !(second - best >= 2 * circumradius(cell, true)))
		return undefined;
	// the outward side is the one on which the field grows
	const side = float3(dir.y, -dir.x, 0), step = 1e-4 * len;
	const sign = polygonDistance2(p.x + side.x * step, p.y + side.y * step, s.paths) >= polygonDistance2(p.x - side.x * step, p.y - side.y * step, s.paths) ? 1 : -1;
	const n = side.scale(sign);
	return {n, d: n.x * a.x + n.y * a.y};
}

// a square as the polygon it is, once
const outlines = new WeakMap<Sdf, Sdf & {k: 'polygon2'}>();
function squareOutline(s: Sdf & {k: 'square2'}): Sdf & {k: 'polygon2'} {
	let o = outlines.get(s);
	if (!o) {
		const x0 = s.center ? -s.size.x / 2 : 0, y0 = s.center ? -s.size.y / 2 : 0;
		outlines.set(s, o = {k: 'polygon2', paths: [[float2(x0, y0), float2(x0 + s.size.x, y0), float2(x0 + s.size.x, y0 + s.size.y), float2(x0, y0 + s.size.y)]]});
	}
	return o;
}

// A plane of a body in the frame inv takes the body into, as a plane of the frame outside it
function planeOutOf(inv: float3x4, pl: Plane): Plane {
	const m = float3(inv.x.dot(pl.n), inv.y.dot(pl.n), inv.z.dot(pl.n)), len = m.len();
	return {n: m.scale(1 / len), d: (pl.d - pl.n.dot(inv.w)) / len};
}

// The planes that the surface in a cell is made of, if it is made of nothing else: wherever the surface is in the cell it
// is in one of these, and the model is, within the cell, some combination of their half-spaces. Whatever cannot reach the
// cell is left out: the rest of a union are above zero over a cell whose circumradius is no more than their values, the
// rest of an intersection below, a face of a box or a prism is behind the cell by the extent of the cell along its normal.
// Undefined where it is not certain, which is a curve, a part the model has no formula for, or too many to count.
function planesOf(s: Sdf, p: float3, cell: float3[], eps: number): Plane[] | undefined {
	switch (s.k) {
		case 'union': case 'intersection': case 'difference': {
			// the largest of the parts, or the smallest, as an intersection or a union; a cut is the negation of the part it is
			const parts = s.k === 'difference' ? [s.base, ...s.cuts] : s.children;
			const sign = (i: number) => s.k === 'union' || (s.k === 'difference' && i) ? 1 : -1;
			const R = circumradius(cell);
			const out: Plane[] = [];
			for (let i = 0; i < parts.length; i++) {
				// above zero throughout the cell, for a union (a cut is out of the way the same, a part of an intersection
				// or the base the other)
				if (sign(i) * evalSdf(parts[i], p) >= R * reachOf(parts[i]))
					continue;
				const got = planesOf(parts[i], p, cell, eps);
				if (!got)
					return undefined;
				out.push(...got);
			}
			return out;
		}
		case 'domain': {
			const inv = inverseOrIdentity(s.m);
			const got = planesOf(s.body, inv.mulPos(p), cell.map(g => inv.mulDir(g)), eps);
			return got && got.map(pl => planeOutOf(inv, pl));
		}
		case 'material':
			return planesOf(s.body, p, cell, eps);
		case 'box': {
			const c = s.center ? float3(0, 0, 0) : s.size.scale(0.5);
			const at = [c.x, c.y, c.z], h = [s.size.x / 2, s.size.y / 2, s.size.z / 2], q = [p.x, p.y, p.z];
			const out: Plane[] = [];
			for (let i = 0; i < 6; i++) {
				const a = i >> 1, up = (i & 1) === 1;
				const n = float3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).scale(up ? 1 : -1);
				const d = up ? at[a] + h[a] : -(at[a] - h[a]);
				// behind the cell by its extent along the normal, or a face the surface can be on
				if (n.dot(p) - d > -spread(n, cell))
					out.push({n, d});
			}
			return out;
		}
		case 'planes': {
			const out: Plane[] = [];
			for (const pl of s.planes)
				if (pl.n.dot(p) - pl.d > -spread(pl.n, cell))
					out.push(pl);
			return out;
		}
		case 'polygon2': {
			// a convex polygon is the intersection of its edges' half-planes, as a 'planes' body is of its faces': every
			// edge the cell is not wholly behind, corners and all
			const sense = convexSense(s);
			if (sense) {
				const out: Plane[] = [], pts = s.paths[0];
				for (let i = 0; i < pts.length; i++) {
					const a = pts[i], b = pts[(i + 1) % pts.length], e = b.sub(a), len = e.len();
					if (!(len > 1e-12))
						continue;
					const n = float3(e.y * sense / len, -e.x * sense / len, 0), d = n.x * a.x + n.y * a.y;
					if (n.dot(p) - d > -spread(n, cell))
						out.push({n, d});
				}
				return out;
			}
			const pl = polygonPlane(s, p, cell);
			return pl && [pl];
		}
		case 'square2':
			return planesOf(squareOutline(s), p, cell, eps);
		case 'offset': {
			// a level of a field that is linear in the cell is the plane shifted by the level
			if (s.body.k !== 'polygon2' && s.body.k !== 'square2' && s.body.k !== 'offset')
				return undefined;
			const got = planesOf(s.body, p, cell, eps);
			return got && got.length === 1 ? [{n: got[0].n, d: got[0].d + s.r}] : undefined;
		}
		case 'cylinder': case 'ngonPrism': case 'extrude': {
			const [bottom, top] = capFields(p.z, s.h, s.center);
			const high = spread(float3(0, 0, 1), cell);
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
			const out: Plane[] = [];
			if (bottom > -high)
				out.push({n: float3(0, 0, -1), d: -z0});
			if (top > -high)
				out.push({n: float3(0, 0, 1), d: z1});
			// the side is nothing to the cell if it is behind it, and a plane only for an extrusion of a straight edge
			const side = s.k === 'cylinder' ? Math.hypot(p.x, p.y) - s.r : s.k === 'ngonPrism' ? ngonDistance(p.x, p.y, s.r, s.n) : evalSdf(s.body, p);
			if (side > -circumradius(cell, true)) {
				if (s.k !== 'extrude')
					return undefined;
				const got = planesOf(s.body, p, cell, eps);
				if (!got)
					return undefined;
				out.push(...got);
			}
			return out;
		}
		case 'dilate': {
			// growing a corner rounds it: only a single face stays a plane, shifted out by the growth
			if (!s.support.q) {
				if (!convexPolyhedral(s.body))
					return undefined;
				const got = planesOf(s.body, p, cell, eps);
				return got && (got.length === 0 ? got : got.length === 1 ? [{n: got[0].n, d: got[0].d + s.support.r}] : undefined);
			}
			const brush = planeBrush(s.body, s.support);
			if (!brush)
				return undefined;
			// the field is that of 'extrude' with the cross-section grown: its sides are the cross-section's faces moved out,
			// and its caps, which do not move, are behind the cell as far as the grown cross-section is
			const a = p.dot(brush.dir) - brush.mid, on = p.sub(brush.dir.scale(a));
			const high = spread(brush.dir, cell);
			const out: Plane[] = [];
			if (a - brush.half > -high)
				out.push({n: brush.dir, d: brush.mid + brush.half});
			if (-a - brush.half > -high)
				out.push({n: brush.dir.scale(-1), d: -(brush.mid - brush.half)});
			if (evalSdf(brush.sides, on) - s.support.r > -circumradius(cell)) {
				const wall = planesOf(brush.sides, on, cell, eps);
				if (!wall || wall.length > 1)
					return undefined;
				for (const pl of wall)
					out.push({n: pl.n, d: pl.d + s.support.r});
			}
			return out;
		}
		default:
			return undefined;
	}
}

// The faces of a body that is a convex polyhedron, as the planes and polygons the `planes` primitive carries: a box, a
// prism on a regular n-gon, or a polyhedron itself. Anything with a curved side is not one.
function polyhedronOf(body: Sdf): Hull3| undefined {
	switch (body.k) {
		case 'planes':
			return body.faces.length && body.faces.length === body.planes.length && body.faces.every(f => f && f.length >= 3)
				? {planes: body.planes, faces: body.faces} : undefined;
		case 'box': {
			const lo = body.center ? float3(-body.size.x / 2, -body.size.y / 2, -body.size.z / 2) : float3(0, 0, 0);
			const hi = float3(lo.x + body.size.x, lo.y + body.size.y, lo.z + body.size.z);
			const planes: {n: float3, d: number}[] = [], faces: float3[][] = [];
			for (let a = 0; a < 3; a++)
				for (const side of [0, 1]) {
					const n = float3(a === 0 ? 2 * side - 1 : 0, a === 1 ? 2 * side - 1 : 0, a === 2 ? 2 * side - 1 : 0);
					const at = side ? hi : lo;
					const u = (a + 1) % 3, v = (a + 2) % 3;
					const coord = (p: float3, i: number) => i === 0 ? p.x : i === 1 ? p.y : p.z;
					const corner = (cu: number, cv: number) => {
						const c = [0, 0, 0];
						c[a] = coord(at, a);
						c[u] = coord(cu ? hi : lo, u);
						c[v] = coord(cv ? hi : lo, v);
						return float3(c[0], c[1], c[2]);
					};
					planes.push({n, d: n.dot(at)});
					faces.push([corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]);
				}
			return {planes, faces};
		}
		case 'ngonPrism': {
			const z0 = body.center ? -body.h / 2 : 0, z1 = body.center ? body.h / 2 : body.h, n = body.n;
			const ring = (z: number) => Array.from({length: n}, (_, k) => float3(body.r * Math.cos(2 * Math.PI * k / n), body.r * Math.sin(2 * Math.PI * k / n), z));
			const bottom = ring(z0), top = ring(z1);
			const planes = [{n: float3(0, 0, -1), d: -z0}, {n: float3(0, 0, 1), d: z1}];
			const faces = [bottom, top];
			for (let k = 0; k < n; k++) {
				const mid = Math.PI * (2 * k + 1) / n;
				const nn = float3(Math.cos(mid), Math.sin(mid), 0);
				planes.push({n: nn, d: body.r * Math.cos(Math.PI / n)});
				faces.push([bottom[k], bottom[(k + 1) % n], top[(k + 1) % n], top[k]]);
			}
			return {planes, faces};
		}
		default:
			return undefined;
	}
}

//-----------------------------------------------------------------------------
// hull()
//-----------------------------------------------------------------------------

// The 2-D convex hull of a point set, counter-clockwise, or undefined if the points do not span an area (fewer than
// three left after dedupe, or all collinear). The standard monotone chain (Andrew's) construction.
export function convexHull2(points: float2[]): float2[] | undefined {
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const uniq: float2[] = [];
	for (const p of sorted)
		if (!uniq.length || Math.hypot(p.x - uniq[uniq.length - 1].x, p.y - uniq[uniq.length - 1].y) > 1e-9)
			uniq.push(p);
	if (uniq.length < 3)
		return undefined;
	const cross = (o: float2, a: float2, b: float2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const chain = (seq: float2[]) => {
		const h: float2[] = [];
		for (const p of seq) {
			while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 1e-9)
				h.pop();
			h.push(p);
		}
		h.pop();
		return h;
	};
	const hull = chain(uniq).concat(chain([...uniq].reverse()));
	return hull.length >= 3 ? hull : undefined;
}

// The 3-D convex hull of a point set, as the planes and polygons the `planes` primitive carries (every face a
// triangle -- adjacent coplanar faces are not merged, which costs a few extra terms in the field but nothing in
// correctness), or undefined if the points are coincident, collinear or coplanar. The standard incremental
// construction: seed a tetrahedron from four non-degenerate points, then for each remaining point, remove the faces
// it can see and re-roof the hole with new faces to that point, walking outward from the horizon between the visible
// and hidden faces.

// The half-space constraints (n.x <= d) an intersection amounts to, if it is nothing but boxes under nothing but
// domain transforms and colour -- the way a convex polyhedron is often built by hand (a dodecahedron as six tilted
// slabs, say). undefined means some child is not one of those, so the caller keeps the ordinary CSG node.
function halfSpacesOf(s: Sdf): {n: float3, d: number}[] | undefined {
	switch (s.k) {
		// already exactly a set of half-spaces -- its own faces are, by construction, no more and no less than
		// their intersection (see polytopeOfIntersection below), so an intersection nested inside another one (a
		// fixed face alongside an intersection_for() of the rest, say) still ends up as a single exact polyhedron
		case 'planes':
			return s.planes;
		case 'box': {
			const b = bounds3(s)!;
			return [
				{n: float3(1, 0, 0), d: b.max.x}, {n: float3(-1, 0, 0), d: -b.min.x},
				{n: float3(0, 1, 0), d: b.max.y}, {n: float3(0, -1, 0), d: -b.min.y},
				{n: float3(0, 0, 1), d: b.max.z}, {n: float3(0, 0, -1), d: -b.min.z},
			];
		}
		case 'material':
			return halfSpacesOf(s.body);
		case 'intersection': {
			const out: {n: float3, d: number}[] = [];
			for (const c of s.children) {
				const v = halfSpacesOf(c);
				if (!v)
					return undefined;
				out.push(...v);
			}
			return out;
		}
		case 'domain': {
			const local = halfSpacesOf(s.body);
			if (!local)
				return undefined;
			// the same plane-into-frame move place() does for a 'planes' body (see its own comment): a local
			// plane {n.q = d} becomes {p : (L^-t n).p = d + (L^-t n).t}, divided through so it is a distance again
			const l = float3x3(s.m.x, s.m.y, s.m.z);
			if (Math.abs(l.det()) < 1e-12)
				return undefined;
			const inv = l.inverse().transpose();
			const world: {n: float3, d: number}[] = [];
			for (const pl of local) {
				const w = inv.mul(pl.n);
				const len = w.len();
				if (len < 1e-12)
					return undefined;
				world.push({n: w.scale(1 / len), d: (pl.d + w.dot(s.m.w)) / len});
			}
			return world;
		}
		default:
			return undefined;
	}
}

// Three planes meet at one point (Cramer's rule on n0.x = d0 etc, by the scalar triple product), unless their
// normals are coplanar, which a polyhedron's own three mutually adjacent faces never are.
function threePlanes(a: {n: float3, d: number}, b: {n: float3, d: number}, c: {n: float3, d: number}, eps: number): float3 | undefined {
	const det = a.n.dot(b.n.cross(c.n));
	if (Math.abs(det) < eps)
		return undefined;
	return b.n.cross(c.n).scale(a.d).add(c.n.cross(a.n).scale(b.d)).add(a.n.cross(b.n).scale(c.d)).scale(1 / det);
}

// Caps the O(n^3) vertex search below -- cheap even here (n^3 checks against n planes each is still well under a
// second at this size), so generous rather than tight. A hand-built polyhedron rarely needs more than a few dozen
// half-spaces on its own, but intersection_for() can hand this an *intermediate* shape with many more: five tilted,
// still-oversized slabs with no sixth to cap them yet have real vertices out along their own far, otherwise-inert
// sides, which only disappear once that sixth slab (or whatever else is in the same intersection()) joins them.
const POLYTOPE_MAX_PLANES = 160;

// The convex polyhedron an intersection() of half-spaces describes, as an explicit 'planes' body -- the same shape
// convexHull3(points) would give a hull() of its vertices, and for the same reason: a body that knows its own faces
// measures its true distance everywhere, not just near a face's own normal, which is what a plain intersection's
// max() of its children only does (each child's box-distance is exact close to its own face, but past an edge it
// overstates the distance to the polyhedron, the corner's true nearest point). That difference does not show on the
// unwrapped shape's own surface -- max() is a lower bound wherever it is not exact, but zero exactly where the
// surface actually is -- but it means a minkowski() sum with a sphere, which offsets an exact field by its radius,
// pushes each face out without rounding the edges and corners between them. Undefined if the intersection is not
// built only from boxes (see halfSpacesOf), or if the half-spaces it does have do not bound a solid.
export function polytopeOfIntersection(children: Sdf[]): Sdf | undefined {
	const planes: {n: float3, d: number}[] = [];
	for (const c of children) {
		const v = halfSpacesOf(c);
		if (!v)
			return undefined;
		planes.push(...v);
	}
	if (planes.length < 4 || planes.length > POLYTOPE_MAX_PLANES)
		return undefined;

	// a vertex of the polytope is where three of its planes meet and every other plane still holds there -- the
	// standard route from a half-space description to a point set, handed to convexHull3 exactly as hull() of an
	// explicit vertex set is
	const scale = Math.max(1, ...planes.map(pl => Math.abs(pl.d)));
	const eps = 1e-9 * scale;
	const points: float3[] = [];
	for (let i = 0; i < planes.length; i++)
		for (let j = i + 1; j < planes.length; j++)
			for (let k = j + 1; k < planes.length; k++) {
				const x = threePlanes(planes[i], planes[j], planes[k], 1e-9);
				if (x && planes.every(pl => pl.n.dot(x) <= pl.d + eps))
					points.push(x);
			}

	const hull = convexHull3(points);
	// only the planes convexHull3 actually kept as a face survive: one collected from a box's far, uninvolved side
	// (nothing this polytope ever reaches) is redundant and does not appear as one of its faces
	return hull && {k: 'planes', planes: hull.planes, points: [...new Set(hull.faces.flat())], faces: hull.faces};
}

export function convexHull3(points: float3[]): Hull3 | undefined {
	const pts: float3[] = [];
	for (const p of points)
		if (!pts.some(q => p.sub(q).len() < 1e-9))
			pts.push(p);
	if (pts.length < 4)
		return undefined;

	let scale = 0;
	for (const p of pts)
		scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
	const eps = 1e-9 * Math.max(1, scale);

	// four points that do not all lie on one plane, to seed a tetrahedron
	let i0 = 0, i1 = -1, i2 = -1, i3 = -1;
	for (let i = 1; i < pts.length; i++)
		if (pts[i].sub(pts[i0]).len() > eps) { i1 = i; break; }
	if (i1 < 0)
		return undefined;						// every point coincides
	const dir = pts[i1].sub(pts[i0]);
	for (let i = 0; i < pts.length; i++) {
		if (i === i0 || i === i1)
			continue;
		if (dir.cross(pts[i].sub(pts[i0])).len() > eps) { i2 = i; break; }
	}
	if (i2 < 0)
		return undefined;						// every point is collinear
	const seedNormal = pts[i1].sub(pts[i0]).cross(pts[i2].sub(pts[i0]));
	for (let i = 0; i < pts.length; i++) {
		if (i === i0 || i === i1 || i === i2)
			continue;
		if (Math.abs(seedNormal.dot(pts[i].sub(pts[i0]))) > eps) { i3 = i; break; }
	}
	if (i3 < 0)
		return undefined;						// every point is coplanar

	let faces: {a: number, b: number, c: number}[] = [];
	const centroid = pts[i0].add(pts[i1]).add(pts[i2].add(pts[i3])).scale(0.25);
	const orient = (a: number, b: number, c: number) => {
		const n = pts[b].sub(pts[a]).cross(pts[c].sub(pts[a]));
		return n.dot(centroid.sub(pts[a])) > 0 ? {a, b: c, c: b} : {a, b, c};
	};
	faces.push(orient(i0, i1, i2), orient(i0, i1, i3), orient(i0, i2, i3), orient(i1, i2, i3));

	const used = new Set([i0, i1, i2, i3]);
	const faceNormal = (f: {a: number, b: number, c: number}) => pts[f.b].sub(pts[f.a]).cross(pts[f.c].sub(pts[f.a]));

	for (let idx = 0; idx < pts.length; idx++) {
		if (used.has(idx))
			continue;
		const p = pts[idx];
		const visible = faces.map(f => faceNormal(f).dot(p.sub(pts[f.a])) > eps);
		if (!visible.some(v => v))
			continue;							// inside the hull built so far

		// the horizon: each edge of a visible face whose reverse is not also a visible face's edge
		const key = (a: number, b: number) => a + '_' + b;
		const visibleEdges = new Set<string>();
		for (let fi = 0; fi < faces.length; fi++) {
			if (!visible[fi])
				continue;
			const f = faces[fi];
			for (const [a, b] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]])
				visibleEdges.add(key(a, b));
		}
		const horizon: [number, number][] = [];
		for (let fi = 0; fi < faces.length; fi++) {
			if (!visible[fi])
				continue;
			const f = faces[fi];
			for (const [a, b] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]])
				if (!visibleEdges.has(key(b, a)))
					horizon.push([a, b]);
		}

		faces = faces.filter((_, fi) => !visible[fi]);
		for (const [a, b] of horizon)
			faces.push({a, b, c: idx});
		used.add(idx);
	}

	const planes = faces.map(f => {
		const n = normalize(faceNormal(f));
		return {n, d: n.dot(pts[f.a])};
	});
	const outFaces = faces.map(f => [pts[f.a], pts[f.b], pts[f.c]]);
	return {planes, faces: outFaces};
}

// The world-space point set of an already-placed body that has a known finite one: recurses through union() (a
// `for` loop desugars to one) and domain (an operand's own transform, which the algorithm above needs applied
// before it can treat the points as one set), unlike verticesOf() above, which only reads a body already in its
// final frame. undefined the moment anything without a finite vertex set -- a sphere, a cylinder's round side, an
// offset, a cut -- is met, since hull() then has to fall back to drawing a union.
export function hullVertices3(s: Sdf): float3[] | undefined {
	switch (s.k) {
		case 'material':
			return hullVertices3(s.body);
		case 'union': {
			const out: float3[] = [];
			for (const c of s.children) {
				const v = hullVertices3(c);
				if (!v)
					return undefined;
				out.push(...v);
			}
			return out;
		}
		case 'domain': {
			const local = hullVertices3(s.body);
			return local?.map(p => s.m.mulPos(p));
		}
		default:
			return verticesOf3(s);
	}
}

// A generator hull() can reduce to a location and the radius of the ball centred there: a sharp vertex is r = 0 and
// a sphere is its own centre and radius. A cylinder is deliberately not one of these: its ends are flat discs, and a
// ball at each end centre would round them off and overshoot the true hull. Anything with a curved side that isn't a
// sphere -- a cylinder, an offset, a cut -- has no such reduction, so hull() then has to fall back to a union.
export interface WeightedPoint { p: float3, r: number }

export function weightedPoints3(s: Sdf): WeightedPoint[] | undefined {
	switch (s.k) {
		case 'material':
			return weightedPoints3(s.body);
		case 'union': {
			const out: WeightedPoint[] = [];
			for (const c of s.children) {
				const v = weightedPoints3(c);
				if (!v)
					return undefined;
				out.push(...v);
			}
			return out;
		}
		case 'domain': {
			const inner = weightedPoints3(s.body);
			if (!inner)
				return undefined;
			// a radius only scales correctly under a conformal map (a non-uniform scale turns a sphere into an
			// ellipsoid, which no weighted point describes); a sharp vertex (r = 0) has no radius to distort, so a
			// body made only of those tolerates any transform place() left as a domain wrap
			if (inner.some(w => w.r !== 0)
				&& !isConformal(s.m))
				return undefined;
			return inner.map(({p, r}) => ({p: s.m.mulPos(p), r: r * s.scale}));
		}
		case 'sphere':
			return [{p: float3(0, 0, 0), r: s.r}];
		default: {
			const verts = verticesOf3(s);
			return verts?.map(p => ({p, r: 0}));
		}
	}
}

// The two planes tangent to the balls at three points, one either side of the triangle they make: unit normal n with
// n.p_i + r_i = d for all three. With every radius equal this is the triangle's plane pushed out by r either way (and
// with r = 0 the plain plane); with unequal radii it is tilted towards the smaller balls. Split n into its part in
// the triangle's own plane, which the two edge equations fix, plus t along its normal, which the unit length fixes.
// Empty when the points are collinear, or the radii differ by more than the triangle is wide (no tangent plane).
function tangentPlanes(pts: float3[], radii: number[]): {n: float3, d: number, points: float3[]}[] {
	const e1 = pts[1].sub(pts[0]), e2 = pts[2].sub(pts[0]);
	const c1 = radii[0] - radii[1], c2 = radii[0] - radii[2];
	const g11 = e1.dot(e1), g12 = e1.dot(e2), g22 = e2.dot(e2);
	const det = g11 * g22 - g12 * g12;
	if (det < 1e-12 * g11 * g22)
		return [];
	const a = (c1 * g22 - c2 * g12) / det, b = (c2 * g11 - c1 * g12) / det;
	const par = e1.scale(a).add(e2.scale(b));
	const t2 = 1 - par.dot(par);
	if (t2 < 0)
		return [];
	const fn = normalize(e1.cross(e2)), t = Math.sqrt(t2);
	return (t < 1e-12 ? [1] : [1, -1]).map(sign => {
		const n = par.add(fn.scale(sign * t));
		return {n, d: n.dot(pts[0]) + radii[0], points: pts.map((p, i) => p.add(n.scale(radii[i])))};
	});
}

// hull() of a mix of round and sharp things. The hull of balls is bounded by planes tangent to three of them with
// every other ball on or inside, and by round collars along the edges between neighbouring balls -- so those faces
// are found directly, by trying every triple with at least one ball in it (a triple of sharp points is a plain face
// of the hull of the centres, which the core below already has). The ordinary hull of the centres can not be trusted
// to say which points are neighbours: a ball reaching past a flat face of it -- the bow of a boat, poking above the
// deck line of the boxes behind it -- replaces that face with a ramp the unweighted hull knows nothing about.
// Every piece is convex and inside the true hull on its own, which is what lets a union of them be exact: the core
// (the hull of the centres), for each face the slab between its centre triangle and its tangent triangle, and for
// each edge a round cone (a plain capsule where the two ends match), whose end caps are the vertex spheres too. The
// tangent planes are deliberately never combined into one polyhedron: a `planes` node takes its sign from the
// intersection of its half-spaces, which has sharp spikes past every rounded vertex.
// With every radius 0 this is the plain vertex hull and with every radius equal it is what a Minkowski sum with a
// ball draws, but heavier than either, which is why hull() only reaches it after they have failed. Gives up
// (undefined) beyond a size where trying every triple stops being cheap.
export function weightedHull3(input: WeightedPoint[]): Sdf | undefined {
	// two points at one place are one ball: the bigger radius
	const points: WeightedPoint[] = [];
	for (const w of input) {
		const same = points.find(q => q.p.sub(w.p).len() < 1e-9);
		if (!same)
			points.push(w);
		else if (w.r > same.r)
			same.r = w.r;
	}
	if (points.length === 2) {
		const [A, B] = points;
		return Math.abs(A.r - B.r) < 1e-9 * Math.max(1, A.r, B.r)
			? {k: 'capsule', a: A.p, b: B.p, r: A.r}
			: {k: 'roundCone', a: A.p, b: B.p, r1: A.r, r2: B.r};
	}
	if (points.length < 3 || points.length > 64)
		return undefined;

	const children: Sdf[] = [];
	const core = convexHull3(points.map(w => w.p));
	if (core)
		children.push({k: 'planes', planes: core.planes, points: [...new Set(core.faces.flat())], faces: core.faces});

	const edges = new Set<string>();
	let faces = 0;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			for (let k = j + 1; k < points.length; k++) {
				const tri = [points[i], points[j], points[k]];
				if (tri.every(w => w.r === 0))
					continue;
				for (const t of tangentPlanes(tri.map(w => w.p), tri.map(w => w.r))) {
					const scale = Math.max(1, Math.abs(t.d));
					if (points.some(w => t.n.dot(w.p) + w.r > t.d + 1e-7 * scale))
						continue;
					const slab = convexHull3([...tri.map(w => w.p), ...t.points]);
					if (!slab)
						continue;
					children.push({k: 'planes', planes: slab.planes, points: [...new Set(slab.faces.flat())], faces: slab.faces});
					faces++;
					for (const [x, y] of [[i, j], [j, k], [i, k]])
						edges.add(`${x}_${y}`);
				}
			}
		}
	}
	if (faces === 0)
		return undefined;
	for (const key of edges) {
		const [x, y] = key.split('_').map(Number), A = points[x], B = points[y];
		if (A.r === 0 && B.r === 0)
			continue;		// a plain edge between two sharp corners: the faces either side meet exactly there
		children.push(Math.abs(A.r - B.r) < 1e-9 * Math.max(1, A.r, B.r)
			? {k: 'capsule', a: A.p, b: B.p, r: A.r}
			: {k: 'roundCone', a: A.p, b: B.p, r1: A.r, r2: B.r});
	}
	return children.length === 1 ? children[0] : {k: 'union', children};
}

// The 2-D form of hullVertices3: a polygon, a square, or an n-gon circle's vertices, again recursing through
// union() and domain(). A smooth circle (n = 0) has no finite vertex set -- it is handled by sameRadiusCircles()
// below instead, or falls through to the union fallback.
export function hullVertices2(s: Sdf): float2[] | undefined {
	switch (s.k) {
		case 'material':
			return hullVertices2(s.body);
		case 'union': {
			const out: float2[] = [];
			for (const c of s.children) {
				const v = hullVertices2(c);
				if (!v)
					return undefined;
				out.push(...v);
			}
			return out;
		}
		case 'domain': {
			const local = hullVertices2(s.body);
			return local?.map(p => { const q = s.m.mulPos(float3(p.x, p.y, 0)); return float2(q.x, q.y); });
		}
		default:
			return verticesOf2(s);
	}
}

// Whether every leaf of an already-placed body is a sphere, and every one is the same radius: hull() of such spheres
// is exactly the hull of their centres grown by that radius (a same-radius ball is "medial" everywhere along a
// convex hull's surface, which is what a Minkowski sum with a ball already means), so it reuses the existing
// `dilate` this viewer already renders exactly rather than needing a rounded-cone primitive for every radius pair.
// A domain wrapping a sphere is trusted only when it is conformal: a non-uniform scale turns a sphere into an
// ellipsoid, which is a different shape a domain node cannot be mistaken for one of these two.
function sphereList(s: Sdf, out: {centre: float3, r: number}[]): boolean {
	switch (s.k) {
		case 'material':
			return sphereList(s.body, out);
		case 'union':
			return s.children.every(c => sphereList(c, out));
		case 'sphere':
			out.push({centre: float3(0, 0, 0), r: s.r});
			return true;
		case 'domain': {
			if (!isConformal(s.m))
				return false;
			const inner: {centre: float3, r: number}[] = [];
			if (!sphereList(s.body, inner))
				return false;
			for (const {centre, r} of inner)
				out.push({centre: s.m.mulPos(centre), r: r * s.scale});
			return true;
		}
		default:
			return false;
	}
}
export function sameRadiusSpheres(body: Sdf): {centres: float3[], r: number} | undefined {
	const found: {centre: float3, r: number}[] = [];
	if (!sphereList(body, found) || found.length === 0)
		return undefined;
	const r = found[0].r;
	if (found.some(f => Math.abs(f.r - r) > 1e-9 * Math.max(1, Math.abs(r))))
		return undefined;
	return {centres: found.map(f => f.centre), r};
}

// The 2-D form of sameRadiusSpheres: every leaf a smooth circle, all the same radius.
function circleList(s: Sdf, out: {centre: float2, r: number}[]): boolean {
	switch (s.k) {
		case 'material':
			return circleList(s.body, out);
		case 'union':
			return s.children.every(c => circleList(c, out));
		case 'circle2':
			if (s.n >= 3)
				return false;					// an n-gon circle has finite vertices already -- hullVertices2 handles it
			out.push({centre: float2(0, 0), r: s.r});
			return true;
		case 'domain': {
			if (!isConformal(s.m))
				return false;
			const inner: {centre: float2, r: number}[] = [];
			if (!circleList(s.body, inner))
				return false;
			for (const {centre, r} of inner) {
				const p = s.m.mulPos(float3(centre.x, centre.y, 0));
				out.push({centre: float2(p.x, p.y), r: r * s.scale});
			}
			return true;
		}
		default:
			return false;
	}
}
export function sameRadiusCircles(body: Sdf): {centres: float2[], r: number} | undefined {
	const found: {centre: float2, r: number}[] = [];
	if (!circleList(body, found) || found.length === 0)
		return undefined;
	const r = found[0].r;
	if (found.some(f => Math.abs(f.r - r) > 1e-9 * Math.max(1, Math.abs(r))))
		return undefined;
	return {centres: found.map(f => f.centre), r};
}

// A Minkowski operand whose linear part is flat in one direction is a brush with no thickness along it -- in the
// file that prompted this, `scale([1,1,0]) sphere(r)`: a disc of radius r lying in xy. Summing a *prism* with such
// a brush cannot move its caps, because every copy of the prism in the sum is the same height, so the result is the
// prism's cross-section swept around a disc with the prism's own cap heights. That gives the exact field
//
//     max( sd2D(cross-section) - r , |z - mid| - half )
//
// since offsetting a convex shape by a ball is exactly its distance field minus the radius. The cross-section is
// the same polyhedron with the caps dropped, measured on the mid-plane, so the existing exact polyhedron distance
// does the work and the corners of the cross-section come out as real arcs.
//
// The obvious formula, `d - r*|grad(d).xy|`, cannot be right here: across the rim the gradient swings from the cap
// normal to the wall normal, so the offset subtracted falls from r to nothing and the rim is rolled over by r/2.
interface PlaneBrush {
	dir: float3;			// the direction (a unit vector) the brush has no thickness along, and the body's axis
	mid: number;			// the caps, which do not move, as positions along dir
	half: number;
	sides: Sdf;				// the body without its caps: an unbounded prism with the cross-section of the body
}

// found once per operand: the field asks at every sample, and a box has to be turned into its faces to be asked
const brushes = new WeakMap<Sdf, {support: Support, brush: PlaneBrush | undefined}>();
function planeBrush(original: Sdf, support: Support): PlaneBrush | undefined {
	const known = brushes.get(original);
	if (known && known.support === support)
		return known.brush;
	const brush = findPlaneBrush(original, support);
	brushes.set(original, {support, brush});
	return brush;
}

function findPlaneBrush(original: Sdf, support: Support): PlaneBrush | undefined {
	const q = support.q;
	if (!q)
		return undefined;
	// a box or a prism on a regular polygon is a polyhedron like any other, and a flat brush on one is the same case
	let body = original;
	if (original.k === 'box' || original.k === 'ngonPrism') {
		const poly = polyhedronOf(original);
		if (!poly)
			return undefined;
		body = {k: 'planes', planes: poly.planes, points: [], faces: poly.faces};
	}
	if (body.k !== 'planes')
		return undefined;
	// The flat direction: q is A*Aᵗ, so the direction the operand has no extent along is the eigenvector of its one zero
	// eigenvalue -- a coordinate axis in the file's own frame, and any direction once a rotation has been carried in.
	const {values, vectors} = eigenSymmetric([[q.x.x, q.y.x, q.z.x], [q.x.y, q.y.y, q.z.y], [q.x.z, q.y.z, q.z.z]]);
	const top = Math.max(...values.map(Math.abs));
	if (top < 1e-12)
		return undefined;
	const flat = values.map((v, i) => Math.abs(v) < 1e-9 * top ? i : -1).filter(i => i >= 0);
	if (flat.length !== 1)
		return undefined;			// flat in none or in two directions: not the disc this handles
	const dir = normalize(float3(vectors[flat[0]][0], vectors[flat[0]][1], vectors[flat[0]][2]));
	// and the body must be a prism along it: caps square to that direction, every other face parallel to it
	let hi = -Infinity, lo = Infinity, caps = 0;
	const sides: Sdf = {k: 'planes', planes: [], points: body.points, faces: []};
	for (let i = 0; i < body.planes.length; i++) {
		const pl = body.planes[i];
		const along = pl.n.dot(dir);
		if (Math.abs(along) > 1e-9) {
			// a cap, and square to the direction, or the cross-section would vary with height and this decomposition fails
			if (Math.abs(Math.abs(along) - 1) > 1e-9)
				return undefined;
			const at = along > 0 ? pl.d : -pl.d;		// the plane is dot(p, n) <= d
			hi = Math.max(hi, at);
			lo = Math.min(lo, at);
			caps++;
		} else {
			sides.planes.push(pl);
			sides.faces.push(body.faces[i]);
		}
	}
	if (caps !== 2 || hi <= lo || sides.planes.length < 3)		// 3 sides at least, or the cross-section is unbounded
		return undefined;
	return {dir, mid: (hi + lo) / 2, half: (hi - lo) / 2, sides};
}

export function supportDistance(s: Support, n: float3): number {
	if (!s.q)
		return s.r;
	const qn = s.q.mul(n);
	return s.r * Math.sqrt(Math.max(0, n.dot(qn)));
}

// a transform's inverse is worked out once: the field asks for it at every sample, and the emitter for each term
const inverses = new WeakMap<float3x4, float3x4>();
export function inverseOrIdentity(m: float3x4): float3x4 {
	let inv = inverses.get(m);
	if (!inv) {
		inv = computeInverse(m);
		inverses.set(m, inv);
	}
	return inv;
}

function computeInverse(m: float3x4): float3x4 {
	return Math.abs(m.det()) < 1e-12
		? float3x4(float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, 1), m.w.neg())
		: m.inverse();
}

// Whether a term is a shape of the plane rather than a solid. A transform of one is still flat, and so is a
// combination of them; anything else, including the extrudes, is a solid.
export function is2d(s: Sdf): boolean {
	switch (s.k) {
		case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2':
			return true;
		case 'offset': case 'domain': case 'material':
			return is2d(s.body);
		case 'union': case 'intersection':
			return s.children.some(is2d);
		case 'difference':
			return is2d(s.base);
		default:
			return false;
	}
}

//-----------------------------------------------------------------------------
// surface(): a heightmap
//-----------------------------------------------------------------------------

const HEIGHTMAP_TILE = 8;

// heights[row * cols + col], row 0 at y = 0; undefined for a grid with no cells (fewer than two rows or columns).
// `wrap` bends the grid round z: the columns become a turn and the rows a height or a latitude, so the grid gains a
// cell (the last column meets the first again) and each cell's slope -- which is what makes the field safe -- is
// measured per unit of arc on the surface it lies on rather than per unit of grid. A wrapped grid is then measured
// from the surface it is bent around: its own floor is moved to r and its heights become thicknesses, so r names the
// base radius whatever heights (or transforms) the grid came with -- and OpenSCAD's own floor, the one below the
// lowest height that surface() adds, is simply the innermost shell there.
// `tiled` says which of the grid's axes repeat once it is wrapped, and is carried for wrap() to read: it is the flat
// grid's own property, since it is the grid -- not the bend -- that is a tile (see Tiled).
export function heightmap(cols: number, rows: number, heights: ArrayLike<number>, bottom: number, wrap?: Wrap, tiled?: Tiled): Heightmap {
	const h = Float32Array.from(heights);
	if (wrap) {
		let floor = Math.min(bottom, h[0]);
		for (let i = 1; i < h.length; i++)
			floor = Math.min(floor, h[i]);
		if (floor !== 0) {
			for (let i = 0; i < h.length; i++)
				h[i] -= floor;
			bottom = 0;
		}
	}
	if (wrap?.kind === 'sphere') {
		// The first and last rows stand on the poles, where a whole ring of columns is one point: each takes its own
		// mean, so that point has one radius. Without it the field would jump across the axis -- the surface would be
		// at a different height depending on which way round one came at the pole -- and no slope could bound it.
		for (const j of [0, rows - 1]) {
			let sum = 0;
			for (let i = 0; i < cols; i++)
				sum += h[j * cols + i];
			h.fill(sum / cols, j * cols, (j + 1) * cols);
		}
	}
	const tile = HEIGHTMAP_TILE;
	// a flat grid has one cell fewer than its columns; a wrapped one has a cell per column, the last closing the ring
	// -- unless it is only a piece of a surface, where the columns end again and there is no cell to close it
	const full = wrap && !wrap.part;
	const cellsX = full ? cols : cols - 1;
	const tilesX = Math.max(1, Math.ceil(cellsX / tile)), tilesY = Math.max(1, Math.ceil((rows - 1) / tile));
	const steps = wrap && wrapSteps(wrap, cols, rows);
	const ownTop = new Float64Array(tilesX * tilesY).fill(-Infinity), ownSlope = new Float64Array(tilesX * tilesY);
	let top = -Infinity;
	for (let j = 0; j < rows - 1; j++) {
		const sx = steps ? steps.x(j) : 1, sy = steps ? steps.y : 1;
		for (let i = 0; i < cellsX; i++) {
			const i1 = full ? (i + 1) % cols : i + 1;
			const k = j * cols + i, k1 = j * cols + i1, k2 = (j + 1) * cols + i, k3 = (j + 1) * cols + i1;
			const v1 = h[k], v2 = h[k1], v3 = h[k2], v4 = h[k3], m = (v1 + v2 + v3 + v4) / 4;
			// each triangle's gradient: along its outer edge, and from that edge's midpoint to the centre, the
			// across-edge part per column step and the along-edge part per row step
			const slope = Math.max(
				Math.hypot((v2 - v1) / sx, 2 * (m - (v1 + v2) / 2) / sy),
				Math.hypot((v4 - v3) / sx, 2 * ((v3 + v4) / 2 - m) / sy),
				Math.hypot(2 * (m - (v1 + v3) / 2) / sx, (v3 - v1) / sy),
				Math.hypot(2 * ((v2 + v4) / 2 - m) / sx, (v4 - v2) / sy));
			const t = Math.floor(j / tile) * tilesX + Math.floor(i / tile);
			ownTop[t] = Math.max(ownTop[t], v1, v2, v3, v4);
			ownSlope[t] = Math.max(ownSlope[t], slope);
			top = Math.max(top, v1, v2, v3, v4);
		}
	}
	const nearTop = new Float32Array(tilesX * tilesY), nearSlope = new Float32Array(tilesX * tilesY);
	for (let ty = 0; ty < tilesY; ty++) {
		for (let tx = 0; tx < tilesX; tx++) {
			let t = -Infinity, l = 0;
			for (let y = Math.max(ty - 1, 0); y <= Math.min(ty + 1, tilesY - 1); y++)
				for (let dx = -1; dx <= 1; dx++) {
					// a wrapped map has no edge in its columns: the tiles round one continue round the ring
					const x = full ? ((tx + dx) % tilesX + tilesX) % tilesX : tx + dx;
					if (x < 0 || x >= tilesX)
						continue;
					t = Math.max(t, ownTop[y * tilesX + x]);
					l = Math.max(l, ownSlope[y * tilesX + x]);
				}
			// rounded outward in float32, so the bound stays a bound once it is in the texture
			nearTop[ty * tilesX + tx] = t + 1e-5 * Math.max(1, Math.abs(t));
			nearSlope[ty * tilesX + tx] = wrap ? l : 1 / Math.sqrt(1 + l * l) * (1 - 1e-6);
		}
	}
	return {k: 'heightmap', cols, rows, heights: h, bottom: Math.min(bottom, top), top, tile, tilesX, tilesY, nearTop, nearSlope, wrap, tiled};
}

// The arc one step of a wrapped grid covers: one column, and one row. On a cylinder both are the same everywhere; on a
// sphere a column step is r sin(theta) d(phi), which closes to nothing at the poles, where a whole ring of columns
// crowds into a point. That is the steepest a cell's own triangles can be, so a cell takes the smallest its span
// reaches, floored at half a row for the two cells that meet the poles themselves.
//
// A tiled grid is measured by its own scale instead: a column is sx of arc and a row sy, so the same grid is a
// smaller tile and the pattern comes round more often. On a sphere a row's own latitude is where the fold puts it --
// v past the end of the grid comes back down the other side -- so the column step's sin(theta) reads the folded row.
function wrapSteps(wrap: Wrap, cols: number, rows: number) {
	const H = rows - 1;
	if (wrap.kind === 'cylinder')
		return {x: (_j: number) => wrap.tileX || wrap.part ? wrap.sx ?? 1 : wrap.r * 2 * Math.PI / cols, y: wrap.tileY ? wrap.sy ?? 1 : wrap.row ?? 1};
	// one row's angle: the fitted meridian unless the rows repeat, in which case the grid's own row is the arc
	const dTheta = wrap.tileY ? (wrap.sy ?? 1) / wrap.r : Math.PI / H;
	const half = Math.sin(Math.min(dTheta, Math.PI) / 2);
	const dPhi = wrap.tileX || wrap.part ? (wrap.sx ?? 1) / wrap.r : 2 * Math.PI / cols;
	// the row the fold leaves in place j: the triangle wave of period 2H takes a row past a pole back down again
	const at = (j: number) => {
		if (!wrap.tileY)
			return j;
		const q = Math.floor(j / H);
		return q % 2 ? H - (j - q * H) : j - q * H;
	};
	return {
		x: (j: number) => wrap.r * Math.max(Math.min(Math.sin(at(j) * dTheta), Math.sin(at(j + 1) * dTheta)), half) * dPhi,
		y: wrap.tileY ? wrap.sy ?? 1 : wrap.r * dTheta,
	};
}

// A wrapped map's height at a continuous column (periodic: column `cols` is column 0 again) and row, by the same four
// triangles as heightAt, which share the cell's centre -- the grid has no edge across, so the cell index wraps rather
// than clamping.
function heightAtWrap(s: Heightmap, cu: number, cv: number): number {
	const cy = Math.min(Math.max(cv, 0), s.rows - 1);
	const cj = Math.min(Math.floor(cy), s.rows - 2);
	const dv = cy - cj - 0.5;
	const cx = cu - Math.floor(cu / s.cols) * s.cols;
	const ci = Math.floor(cx);
	const du = cx - ci - 0.5;
	const i1 = ci + 1 < s.cols ? ci + 1 : 0;
	const h = s.heights, k = cj * s.cols + ci, k1 = cj * s.cols + i1, k2 = k + s.cols, k3 = k1 + s.cols;
	const v1 = h[k], v2 = h[k1], v3 = h[k2], v4 = h[k3];
	const m = (v1 + v2 + v3 + v4) / 4;
	if (dv <= -Math.abs(du))
		return m + (v2 - v1) * du + 2 * (m - (v1 + v2) / 2) * dv;
	if (dv >= Math.abs(du))
		return m + (v4 - v3) * du + 2 * ((v3 + v4) / 2 - m) * dv;
	if (du < 0)
		return m + (v3 - v1) * dv + 2 * (m - (v1 + v3) / 2) * du;
	return m + (v4 - v2) * dv + 2 * ((v2 + v4) / 2 - m) * du;
}

// Each cell of the grid is OpenSCAD's four triangles, meeting at the cell's centre at the mean of its corners, and the
// solid stands on the floor at `bottom`. The exact distance to thousands of triangles is not something to work out at
// every step of a raymarch, so the field is a bound instead: the solid's box, and above or below the surface the
// height gap divided by sqrt(1 + L^2), L the steepest slope -- no point can be nearer than that, since to reach the
// surface it must close the gap by moving either up or across, and across gains at most L per unit. One slope for the
// whole map would make a single cliff (a photograph's edge in a lithophane) slow the march everywhere, so the map is
// cut into tiles and each tile knows the steepest slope and the highest point of itself and its neighbours: a point
// is at least as far as the edge of its tile's neighbourhood from anything outside it, so only the neighbourhood's
// slope bounds the gap, and far above it the neighbourhood's highest point does better still.

// The surface's height at (x, y), clamped into the grid, and the four triangles' corners each cell is made of --
// shared with sdHeightmap in sdflib.frag, which must agree with it.
function heightAt(s: Heightmap, x: number, y: number): number {
	const cx = Math.min(Math.max(x, 0), s.cols - 1), cy = Math.min(Math.max(y, 0), s.rows - 1);
	const ci = Math.min(Math.floor(cx), s.cols - 2), cj = Math.min(Math.floor(cy), s.rows - 2);
	const du = cx - ci - 0.5, dv = cy - cj - 0.5;
	const h = s.heights, k = cj * s.cols + ci;
	const v1 = h[k], v2 = h[k + 1], v3 = h[k + s.cols], v4 = h[k + s.cols + 1];
	const m = (v1 + v2 + v3 + v4) / 4;
	if (dv <= -Math.abs(du))
		return m + (v2 - v1) * du + 2 * (m - (v1 + v2) / 2) * dv;
	if (dv >= Math.abs(du))
		return m + (v4 - v3) * du + 2 * ((v3 + v4) / 2 - m) * dv;
	if (du < 0)
		return m + (v3 - v1) * dv + 2 * (m - (v1 + v3) / 2) * du;
	return m + (v4 - v2) * dv + 2 * ((v2 + v4) / 2 - m) * du;
}

// The height grid's field: OpenSCAD's flat map, or that grid bent round an axis.
function heightmapDistance(s: Heightmap, p: float3): number {
	return s.wrap ? wrappedHeightmapDistance(s, s.wrap, p) : flatHeightmapDistance(s, p);
}

function flatHeightmapDistance(s: Heightmap, p: float3): number {
	const W = s.cols - 1, H = s.rows - 1;
	// the box it stands in
	const qx = Math.abs(p.x - W / 2) - W / 2, qy = Math.abs(p.y - H / 2) - H / 2, qz = Math.abs(p.z - (s.bottom + s.top) / 2) - (s.top - s.bottom) / 2;
	const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
	// the tile the point is over (the nearest, beyond the edge), and how far it is from anything outside that tile's
	// neighbourhood -- no distance at all on a side where the grid ends, since nothing is beyond it there
	const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
	const tx = Math.min(Math.floor(Math.min(Math.floor(cx), s.cols - 2) / s.tile), s.tilesX - 1);
	const ty = Math.min(Math.floor(Math.min(Math.floor(cy), s.rows - 2) / s.tile), s.tilesY - 1);
	let edge = Infinity;
	if (tx - 1 > 0)				edge = Math.min(edge, p.x - (tx - 1) * s.tile);
	if (tx + 1 < s.tilesX - 1)	edge = Math.min(edge, (tx + 2) * s.tile - p.x);
	if (ty - 1 > 0)				edge = Math.min(edge, p.y - (ty - 1) * s.tile);
	if (ty + 1 < s.tilesY - 1)	edge = Math.min(edge, (ty + 2) * s.tile - p.y);
	const t = ty * s.tilesX + tx;
	const gap = p.z - heightAt(s, p.x, p.y);
	const terrain = gap > 0
		? Math.min(Math.max(gap * s.nearSlope[t], p.z - s.nearTop[t]), edge)
		: -Math.min(-gap * s.nearSlope[t], edge);
	return Math.max(box, terrain);
}

// Where a longitude stands on an arc [a, b] of the circle, as the angle the arc's own turn measures it in: the
// longitude itself while it is on the arc, and the nearer end of it otherwise -- the short way round, so a body
// reaching past +-pi is asked about the end in front of the point rather than the one behind it. The value is always
// within [a, b], which is what lets the caller scale it back into the body's own x.
function arcPoint(phi: number, a: number, b: number): number {
	const rel = ((phi - a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
	return rel <= b - a ? a + rel : (2 * Math.PI - rel < rel - (b - a) ? a : b);
}

// The cut where a turn falls short of a whole one, shared by the general bend and a partial wrapped map: the ends of
// the turn are real faces, at the meridians the map's own ends stand on. The solid is the body *and* the wedge those
// two meridians bound, so the field is the body's own distance and the wedge's, the less confident of the two --
// their max. The wedge's own is the distance to the nearer of its two faces, negative inside it, since a point has to
// be that far in from the boundary before it can call itself solid. Outside the wedge the body's own distance is what
// has to stand, for a face is a face only where the body is: the wedge's own term there is a plain distance to the
// nearer of the two boundary rays. Reading the *plane's* distance instead -- as if a face ran on past the end of the
// body -- left the field exactly nought all along the empty half-plane, a sheet of surface that reached to the end of
// the world and lay across the axis, where every longitude meets every other and the two planes cross. Past the
// wedge's own turn the two crossings mean the farther plane's distance is not a lower bound at all, which is why the
// nearer ray's is what the term is.
//
// A turn *wider* than a half one is instead the complement of the small empty one: the union of the two half-spaces
// rather than their intersection, whose distance is the lesser of the two terms'. That plane is a face only on its
// own half, so reading the nearer one there called the start plane's far half a face and laid a sheet of surface down
// the middle of a piece wider than half a turn (a piece's arc is cols-1 columns, which for the example's photo is
// 185 degrees).
function meridianCut(p: float3, a: number, b: number, d: number): number {
	const w = b - a;
	const c1 = -p.x * Math.sin(a) + p.y * Math.cos(a);
	const c2 = p.x * Math.sin(b) - p.y * Math.cos(b);
	if (w > Math.PI)
		return Math.max(d, -Math.max(c1, c2));
	// the angle from the point's longitude to each of the wedge's boundary rays, the short way round, and the nearer
	const rel = ((Math.atan2(p.y, p.x) - a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
	const toA = Math.min(rel, 2 * Math.PI - rel);
	const toB = Math.min(Math.abs(w - rel), 2 * Math.PI - Math.abs(w - rel));
	// a ray is bounded at the axis, so an angle past a quarter turn is the distance to the axis itself, which is what
	// floors the edge at rad rather than letting the sine of a widening angle turn back down
	const edge = Math.hypot(p.x, p.y) * Math.sin(Math.min(toA, toB, Math.PI / 2));
	return rel > w ? Math.max(d, edge) : Math.max(d, -edge);
}

// A wrapped map's field, on the same principle as the flat one -- the same tiles, the same gap over the same four
// triangles -- but reached through the grid's own coordinates: a point is carried to the column and row it stands
// over, and what it is above is the base surface of radius r displaced by that height, so the gap is radial.
//
// Two things need care. The slope a lateral step climbs is per unit of arc, and at radius `rad` a step of one covers
// only `rad / r` of the arc a step on the surface does: the steepest slope of the tile is scaled by r / rad, which is
// why a wrapped map's `nearSlope` is the slope itself and this is where it becomes a safety factor. And the flat
// map's box, which is also what keeps the bound honest where the slope is not, does not apply: here it is the ball the
// whole map stands in (and, for a cylinder, the slab its rows span), plus the base surface at `bottom`, which is a
// sphere or cylinder and so exact -- that last one is what bounds the field near the axis, where a sphere's grid
// pinches to a point and its slope means nothing at all.
//
// A tiled map's column is `sx` of arc rather than the fitted turn over cols, and its row `sy` rather than the fitted
// meridian over H, so the grid is a tile whose size the scale sets; the sampling is modulo the period either way, so
// the ring closes without a crack whatever the tile count comes to. On a sphere a row past a pole folds: v comes back
// down the other side and the longitude turns with it, as it does going over a globe's pole, so the far side reads
// the mirrored row through the shifted columns. That fold is smooth only where it lands on a pole -- the two sides
// meet at the pole row's own mean height, but their slopes differ -- which is the price of tiling a sphere's rows.
function wrappedHeightmapDistance(s: Heightmap, wrap: Wrap, p: float3): number {
	const H = s.rows - 1;
	const sphere = wrap.kind === 'sphere';
	// the radius the map's surface is at, which is length(p) on a sphere and the distance from the axis on a cylinder
	const rad = sphere ? Math.hypot(p.x, p.y, p.z) : Math.hypot(p.x, p.y);
	const rr = Math.max(rad, 1e-9);
	// the colatitude from the *south* pole, so the grid's first row lands there: a picture then stands the way up it
	// does on the plane, and as its rows do up a cylinder's axis, rather than upside down on a globe
	const theta = sphere ? Math.acos(Math.max(-1, Math.min(1, -p.z / rr))) : 0;
	const phi = Math.atan2(p.y, p.x);
	const posPhi = phi < 0 ? phi + 2 * Math.PI : phi;
	// The column the point stands over: the grid's own arc when the columns repeat or the grid is only a piece of a
	// surface, the fitted whole turn otherwise.
	let u = wrap.tileX || wrap.part ? posPhi * wrap.r / (wrap.sx ?? 1) : posPhi / (2 * Math.PI) * s.cols;
	// The row, and the arc or axis one row covers: the grid's own when the rows repeat, the fitted meridian on a
	// sphere, the scaled axis on a cylinder. A tiled row past a pole folds back down with the longitude turned.
	const rowArc = wrap.tileY ? wrap.sy ?? 1 : (sphere ? wrap.r * Math.PI / H : wrap.row ?? 1);
	let v = sphere ? theta / Math.PI * H : p.z / (wrap.row ?? 1) + H / 2;
	if (wrap.tileY) {
		if (sphere) {
			const raw = wrap.r * theta / (wrap.sy ?? 1);
			const q = Math.floor(raw / H);
			v = q % 2 ? H - (raw - q * H) : raw - q * H;
			// the longitude turns by half a turn, which is half the columns only when the tile is the whole turn
			u += q % 2 ? (wrap.tileX ? Math.PI * wrap.r / (wrap.sx ?? 1) : s.cols / 2) : 0;
		} else {
			// The tile starts where the axis does, as a tiled sphere's first row starts at a pole, so an axis a whole
			// number of tiles long ends on a tile boundary too. Half the axis is H * row / 2 of the grid's own
			// units -- which is the H / 2 rows of shift an untiled grid's own height has always asked for.
			v = (p.z + H * (wrap.row ?? 1) / 2) / (wrap.sy ?? 1);
			v -= Math.floor(v / H) * H;
		}
	}
	// a piece of a surface has real ends in its columns, so the grid clamps there instead of closing onto itself
	const sigma = wrap.r + (wrap.part ? heightAt(s, u, v) : heightAtWrap(s, u, v));
	const gap = rad - sigma;

	// the tile the point is over -- its column wrapped, since the ring has no end -- and how far the point is from
	// anything outside that tile's neighbourhood
	const cv = Math.min(Math.max(v, 0), H);
	const cj = Math.min(Math.floor(cv), s.rows - 2);
	const cx = wrap.part ? Math.min(Math.max(u, 0), s.cols - 1) : u - Math.floor(u / s.cols) * s.cols;
	const ci = Math.min(Math.floor(cx), s.cols - 1);
	const tx = Math.min(Math.floor(ci / s.tile), s.tilesX - 1), ty = Math.min(Math.floor(cj / s.tile), s.tilesY - 1);
	const t = ty * s.tilesX + tx;
	// The edge: two points whose directions differ by an angle d, at radii within the map's own reach, are at least
	// 2 sqrt(rad * least) sin(d / 2) apart, so the angle to the far side of the neighbourhood is a distance. On a
	// sphere that angle is at least the latitude difference, or -- where the neighbourhood does not reach round the
	// ring -- the distance to the meridian that bounds it; a cylinder's rows are a plain height, so their separation
	// is a distance itself.
	const least = Math.max(wrap.r + Math.min(s.bottom, s.top, 0), 0);
	const chord = 2 * Math.sqrt(Math.max(rad * least, 0));
	let edge = Infinity;
	if (sphere) {
		const arc = (rows: number) => chord * Math.sin(rows * rowArc / (2 * wrap.r));
		if (ty - 1 >= 1)			edge = Math.min(edge, arc(cv - (ty - 1) * s.tile));
		if (ty + 1 <= s.tilesY - 2)	edge = Math.min(edge, arc((ty + 2) * s.tile - cv));
	} else {
		if (ty - 1 >= 1)			edge = Math.min(edge, (cv - (ty - 1) * s.tile) * rowArc);
		if (ty + 1 <= s.tilesY - 2)	edge = Math.min(edge, ((ty + 2) * s.tile - cv) * rowArc);
	}
	if (3 * s.tile < s.cols) {
		const local = ci - tx * s.tile;
		const dphi = Math.min(s.tile + local, 2 * s.tile - local) * (wrap.tileX || wrap.part ? (wrap.sx ?? 1) / wrap.r : 2 * Math.PI / s.cols);
		// a colatitude theta stands on a ring of radius rad sin(theta), so a longitude step is only that fraction of
		// an angle on the sphere -- and closes to nothing at a pole, where the whole turn of columns crowds into the
		// one point the pole row gives a single height. The gap the point is over floors it there: the neighbourhood
		// already bounds the field by its own surface, so the column edge must not claim to end nearer than that
		// (reading cos here instead of sin made every point on the equator, where the ring is widest, read as surface)
		const d = sphere ? Math.asin(Math.min(1, Math.sin(theta) * Math.sin(dphi))) : dphi;
		edge = Math.min(edge, Math.max(chord * Math.sin(d / 2), Math.abs(gap)));
	}

	const l = s.nearSlope[t] * wrap.r / rr;
	const terrain = gap > 0
		? Math.min(Math.max(gap / Math.sqrt(1 + l * l), rad - (wrap.r + s.nearTop[t])), edge)
		: -Math.min(-gap / Math.sqrt(1 + l * l), edge);
	const rMax = wrap.r + Math.max(s.top, s.bottom);
	let d = Math.max(rad - rMax, wrap.r + s.bottom - rad, terrain);
	// a piece of a surface is cut off at the two meridians its ends stand on, exactly as the general bend is
	// A piece's width is the flat grid's own -- one column fewer than the ring's cols, since its columns end rather
	// than closing (see heightmap), so (cols - 1) * sx of arc. That is the arc the general bend gave the same grid too.
	if (wrap.part)
		d = meridianCut(p, 0, (s.cols - 1) * (wrap.sx ?? 1) / wrap.r, d);
	// a cylinder ends where its rows do: the axis they are laid on is `h` when the bend was given one, and the grid's
	// own scaled height otherwise, one row of it per row (see the wrap case in evaluate.ts, which sets `row`)
	return sphere ? d : Math.max(d, Math.abs(p.z) - H / 2 * (wrap.row ?? 1));
}

//-----------------------------------------------------------------------------
// wrap(): a shape bent into a revolution
//-----------------------------------------------------------------------------

// The flat point a wrapped body is asked about: the turn (and the latitude, or the height up the axis) the query
// point stands over, and how far past r it is for the body's own z. Its x is the arc its own width is -- a grid's
// units are arbitrary, so a wrap fits it, and one a circumference round or more is fitted to the whole turn instead
// -- while its y is a length on a cylinder (centred on the axis, which is the body's own height unless the bend was
// given one, `h`) and the whole pole-to-pole latitude on a sphere, and its z is a length everywhere.
function warpPoint(s: Warp, p: float3): float3 {
	const sphere = s.kind === 'sphere';
	const rad = sphere ? Math.hypot(p.x, p.y, p.z) : Math.hypot(p.x, p.y);
	const rr = Math.max(rad, 1e-9);
	const phi = Math.atan2(p.y, p.x);
	const ex = s.box.max.x - s.box.min.x, ey = s.box.max.y - s.box.min.y;
	const ym = (s.box.min.y + s.box.max.y) / 2;
	// Its own width is the arc it covers, measured from the body's own first column: a longitude is only defined to a
	// whole turn, so reading `phi` itself asked a body whose arc straddles +-pi about the wrong end of itself, and one
	// a circumference round or more is fitted to the whole turn instead. Past the ends of a shorter body the *nearest*
	// end is what a point is asked about -- the short way round, not the side of the axis its longitude is written on
	// -- which is what keeps the body's own distance a distance from the body's end faces rather than from across the
	// axis: reading the far side there made that distance as much as three times the real one, and the cut that leans
	// on it (see meridianCut) laid a sheet of surface down the empty half-plane.
	const x = ex >= 2 * Math.PI * s.r
		? s.box.min.x + (phi < 0 ? phi + 2 * Math.PI : phi) / (2 * Math.PI) * ex
		: arcPoint(phi, s.box.min.x / s.r, s.box.max.x / s.r) * s.r;
	// a cylinder's axis: the body's own y unless the bend was given a length, which its rows are spread over
	const axis = s.axis ?? 0;
	let y = axis > 0 ? ym + p.z * (ey / axis) : ym + p.z;
	if (sphere) {
		// a sphere's are an arc from its equator, and one that reaches the poles is fitted to them
		// measured from the south pole, as in wrappedHeightmapDistance, so the two paths run the rows the same way
		const theta = Math.acos(Math.max(-1, Math.min(1, -p.z / rr)));
		y = ey >= Math.PI * s.r ? s.box.min.y + theta / Math.PI * ey : ym + (theta - Math.PI / 2) * s.r;
	}
	return float3(x, y, s.box.min.z + rad - s.r);
}

// The least the map stretches a step of the body's own space by, along the way the body is actually nearest: a step
// of one in its z is one in space, one in its x the arc a column covers there, on a sphere one in its y the arc a row
// covers, and along a cylinder's axis the length the body's rows were fitted to (h, or its own height). The way to
// the body is its own field's gradient -- for a height field that is the surface's normal, so a step to it climbs by
// one, where the arc a crowded pole leaves would read zero -- and the stretch is measured along it, never more than
// one so a map that stretches a step cannot inflate a distance measured in its own space. Reading the least over
// every direction instead left the field leaning on nothing at a pole, which is the fan a bent grid showed there.
//
// A body under a non-uniform scale carries a distance folded by the *smallest* axis alone (see place), so this bound
// under-reports whatever nearest surface lies along a wider one -- a relief's every cliff, by the ratio of the scales.
// Giving each axis its own scale back along the way the body is nearest was tried and is not sound: |J * u| is the
// stretch at the point, and it falls along the way to the surface, so the field read up to five times the distance it
// was meant to bound and the marcher overshot every cliff. A height grid gets its scale exactly on the fused path
// instead, where the columns and rows carry their own arc; this one stays the honest bound for everything else.
function warpStretch(s: Warp, p: float3, q: float3, d0: number, g: float3): number {
	const sphere = s.kind === 'sphere';
	const rad = sphere ? Math.hypot(p.x, p.y, p.z) : Math.hypot(p.x, p.y);
	const sin = sphere ? Math.sqrt(Math.max(0, 1 - Math.min(1, (p.z / Math.max(rad, 1e-9)) ** 2))) : 1;
	const ex = s.box.max.x - s.box.min.x, ey = s.box.max.y - s.box.min.y;
	// capped at one, so a map that stretches a step never inflates a distance measured in its own space
	const x = Math.min(1, ex >= 2 * Math.PI * s.r ? 2 * Math.PI * rad * sin / ex : rad * sin / s.r);
	// a cylinder's axis is a plain length, so a step of one up it is one in space -- unless the body was fitted to
	// an axis of its own length (h), where a step of one is axis / ey of space, and the field tightens by that
	const axis = s.axis ?? 0;
	const y = Math.min(1, sphere
		? (ey >= Math.PI * s.r ? Math.PI * rad / ey : 1)
		: (axis > 0 ? axis / ey : 1));
	// The way to the body is its own field's gradient: for a height field that is the surface's normal, so the
	// nearest surface lies the way it points. The box is not used for it: at a cliff the nearest surface is the
	// cliff face, which the way to the box can miss entirely, and the correction below then inflates the field past
	// the distance it is meant to bound -- a dark edge wherever the relief is steep. Only a gradient too flat to
	// read falls back to the box.
	const gl = Math.hypot(g.x, g.y, g.z);
	let u: float3;
	if (gl > 1e-12) {
		// outside, the field falls toward the body; inside, it is the rise to it that points the way
		u = g.scale((d0 < 0 ? 1 : -1) / gl);
	} else {
		const c = q.min(s.box.max).max(s.box.min);
		const off = q.sub(c);
		const ol = Math.hypot(off.x, off.y, off.z);
		if (ol < 1e-9)
			return Math.min(x, y);
		u = off.scale(-1 / ol);
	}
	return Math.min(1, Math.hypot(x * u.x, y * u.y, u.z));
}

function warpDistance(s: Warp, p: float3): number {
	const q = warpPoint(s, p), d0 = evalSdf(s.body, q);
	// the body's own gradient, a step each way in its own space, to say which way the nearest surface lies
	const e = Math.max(1e-3, Math.abs(d0) * 1e-2);
	const g = float3(
		evalSdf(s.body, q.add(float3(e, 0, 0))) - d0,
		evalSdf(s.body, q.add(float3(0, e, 0))) - d0,
		evalSdf(s.body, q.add(float3(0, 0, e))) - d0);
	const d = d0 * warpStretch(s, p, q, d0, g);
	const ex = s.box.max.x - s.box.min.x;
	if (ex >= 2 * Math.PI * s.r)
		return d;								// all the way round: there are no ends to cut it off at
	// A turn short of a whole one is cut off by the two meridians its ends stand on, and those faces are part of the
	// solid: the field is the body's own distance and the wedge's, whichever is the less confident claim, which is
	// their max. A face is only part of the solid where the body is, so away from it the body's distance has to
	// stand: letting the meridian plane cap it to nothing there -- as if the plane were a face out to infinity --
	// laid a sheet of surface right across the empty half-plane, which is the fan a bent grid showed at the axis.
	return meridianCut(p, s.box.min.x / s.r, s.box.max.x / s.r, d);
}

//-----------------------------------------------------------------------------
// projection(): a solid's shadow on the xy plane, or its slice there
//-----------------------------------------------------------------------------

// The shadow is not a field this algebra can hold as a term: its distance at (x, y) is the least of the solid's own
// distance over every z (outside the solid that is exact, since the nearest point of the shadow is the shadow of the
// nearest point), and finding that least is a search along z whose cost grows with the solid's height over the
// precision wanted -- per sample, which the raymarcher cannot afford. So the projection is worked out here, once, as
// ordinary 2-D shapes: exactly, where the solid is made of parts whose shadows are known (a union is the union of
// its shadows, an extrusion along z is its own outline, a convex solid is the hull of its projected points), and
// traced as a polygon from that search on a grid for what is left -- a cut, an intersection, a Minkowski sum.

// the shadow of a convex solid is the convex hull of the shadows of points that span it: a polyhedron's corners, or
// enough points round a curved solid's rims that the hull inscribed in them is within a hair of the curve
const RIM_POINTS = 96;

function rim(r: number, z: number, n = RIM_POINTS): float3[] {
	return r <= 0 ? [float3(0, 0, z)] : Array.from({length: n}, (_, i) => {
		const a = 2 * Math.PI * i / n;
		return float3(r * Math.cos(a), r * Math.sin(a), z);
	});
}

function convexPoints(s: Sdf): float3[] | undefined {
	switch (s.k) {
		case 'box': case 'planes': case 'ngonPrism':
			return verticesOf3(s);
		case 'cylinder': case 'cone': {
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
			return s.k === 'cylinder' ? [...rim(s.r, z0), ...rim(s.r, z1)] : [...rim(s.r1, z0), ...rim(s.r2, z1)];
		}
		case 'sphere': {
			// an ellipsoid's shadow: latitude rings, each inscribed, so the hull is too
			const out: float3[] = [];
			for (let i = 0; i <= RIM_POINTS / 4; i++) {
				const a = Math.PI * (i / (RIM_POINTS / 4) - 0.5);
				out.push(...rim(s.r * Math.cos(a), s.r * Math.sin(a)));
			}
			return out;
		}
		case 'capsule': case 'roundCone': {
			// a ball at each end, so the points of a sphere's shadow at each
			const r1 = s.k === 'capsule' ? s.r : s.r1, r2 = s.k === 'capsule' ? s.r : s.r2;
			const ball = (c: float3, r: number) => (convexPoints({k: 'sphere', r}) ?? []).map(p => p.add(c));
			return [...ball(s.a, r1), ...ball(s.b, r2)];
		}
		default:
			return undefined;
	}
}

// m's xy plane stays horizontal and its z axis stays vertical: an extrusion along z under it still has its outline
// for a shadow, and a sphere or an upright round solid a circle
function keepsVertical(m: float3x4): boolean {
	const e = 1e-9 * Math.max(m.x.len(), m.y.len(), m.z.len());
	return Math.abs(m.x.z) <= e && Math.abs(m.y.z) <= e && Math.abs(m.z.x) <= e && Math.abs(m.z.y) <= e;
}

// a 2-D shape drawn in the frame m's xy part: the same domain place() would put round it, when that is only a turn and
// an even scale (anything else stretches a circle, which no 2-D term here can be)
function in2d(m: float3x4, body: Sdf): Sdf | undefined {
	const scale = Math.hypot(m.x.x, m.x.y);
	const flat = float3x4(float3(m.x.x, m.x.y, 0), float3(m.y.x, m.y.y, 0), float3(0, 0, scale), float3(m.w.x, m.w.y, 0));
	if (!isConformal(flat))
		return undefined;
	return flat.eq(float3x4.identity()) ? body : {k: 'domain', m: flat, scale, body};
}

// The shadow (or with `cut`, the slice at z = 0) of s under the frame m, when it is known exactly, or undefined.
function projectExact(s: Sdf, m: float3x4, cut: boolean): Sdf | undefined {
	switch (s.k) {
		case 'empty':
			return empty;
		case 'material': {
			const body = projectExact(s.body, m, cut);
			return body && (body.k === 'empty' ? empty : {k: 'material', mat: s.mat, body});
		}
		case 'union': {
			const children: Sdf[] = [];
			for (const c of s.children) {
				const p = projectExact(c, m, cut);
				if (!p)
					return undefined;
				children.push(p);
			}
			return union(children);
		}
		case 'domain':
			return projectExact(s.body, m.mulAffine(s.m), cut);
		case 'extrude': {
			if (!keepsVertical(m) || s.h <= 0)
				return undefined;
			if (cut) {
				// the slice at z = 0 is the outline where the extrusion spans that height, and nothing where it does not
				const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
				const a = m.z.z * z0 + m.w.z, b = m.z.z * z1 + m.w.z;
				if (Math.min(a, b) > 0 || Math.max(a, b) < 0)
					return empty;
			}
			return in2d(m, s.body);
		}
	}
	if (cut)
		return undefined;
	// a round solid whose shadow is a circle round its projected centre: a sphere under any turn and even scale, an
	// upright cylinder or cone (whose axis, through its own origin, then projects to a point)
	if (isConformal(m) && (s.k === 'sphere' || (keepsVertical(m) && (s.k === 'cylinder' || s.k === 'cone')))) {
		const r = s.k === 'cone' ? Math.max(s.r1, s.r2) : s.r, c = m.w;
		const circle: Sdf = {k: 'circle2', r: r * m.x.len(), n: 0};
		return c.x === 0 && c.y === 0 ? circle : {k: 'domain', m: float3.translate(float3(c.x, c.y, 0)), scale: 1, body: circle};
	}
	// two equal balls' shadow is a stadium
	if (s.k === 'capsule' && isConformal(m)) {
		const a = m.mulPos(s.a), b = m.mulPos(s.b), scale = m.x.len();
		return {k: 'stadium2', a: float2(a.x, a.y), b: float2(b.x, b.y), r: s.r * scale};
	}
	const points = convexPoints(s);
	const hull = points && convexHull2(points.map(p => { const q = m.mulPos(p); return float2(q.x, q.y); }));
	return hull ? {k: 'polygon2', paths: [hull]} : points ? empty : undefined;
}

// The least of the field along z at (x, y), over the z the solid spans. The field changes by no more than the distance
// moved, so after a sample of v, with m the least so far, nothing in the next v - m + t can be below m - t: the search
// steps that far, and ends knowing the least lies between the lowest such bound and the lowest sample. Far from the
// outline only the sign matters, so t grows with the distance there; near it, t = tol.
function shadowDistance(s: Sdf, x: number, y: number, z0: number, z1: number, tol: number): number {
	let least = Infinity, bound = Infinity;
	for (let z = z0; ; ) {
		const v = evalSdf(s, float3(x, y, z));
		least = Math.min(least, v);
		if (z >= z1)
			return (Math.min(bound, least) + least) / 2;
		const t = Math.max(tol, 0.25 * Math.abs(least));
		bound = Math.min(bound, least - t);
		z = Math.min(z1, z + v - least + t);
	}
}

// The outline of {f < 0} over the box, by marching squares on a grid of cells of side h, joined into closed loops
// (for polygon2's even-odd fill), and each thinned to within a quarter cell of itself.
function traceOutline(f: (x: number, y: number) => number, box: Box2, h: number): float2[][] {
	const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / h)), ny = Math.max(1, Math.ceil((box.max.y - box.min.y) / h));
	const x0 = box.min.x, y0 = box.min.y;
	const v = new Float64Array((nx + 1) * (ny + 1));
	for (let j = 0; j <= ny; j++)
		for (let i = 0; i <= nx; i++)
			v[j * (nx + 1) + i] = f(x0 + i * h, y0 + j * h);
	const at = (i: number, j: number) => v[j * (nx + 1) + i];

	// an edge's crossing, keyed by the edge so the two cells either side of it meet at the same point
	const points = new Map<number, float2>();
	const crossing = (i: number, j: number, horizontal: boolean): number => {
		const key = 2 * (j * (nx + 1) + i) + (horizontal ? 0 : 1);
		if (!points.has(key)) {
			const a = at(i, j), b = horizontal ? at(i + 1, j) : at(i, j + 1);
			const t = a === b ? 0.5 : Math.min(1, Math.max(0, a / (a - b)));
			points.set(key, horizontal ? float2(x0 + (i + t) * h, y0 + j * h) : float2(x0 + i * h, y0 + (j + t) * h));
		}
		return key;
	};

	// each segment runs with the inside on its left, so every crossing starts exactly one and ends exactly one
	const next = new Map<number, number>();
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			const bottom = () => crossing(i, j, true), top = () => crossing(i, j + 1, true);
			const left = () => crossing(i, j, false), right = () => crossing(i + 1, j, false);
			const inside = [at(i, j) < 0, at(i + 1, j) < 0, at(i + 1, j + 1) < 0, at(i, j + 1) < 0];	// counter-clockwise from bottom left
			const code = (inside[0] ? 1 : 0) | (inside[1] ? 2 : 0) | (inside[2] ? 4 : 0) | (inside[3] ? 8 : 0);
			const seg = (a: number, b: number) => next.set(a, b);
			switch (code) {
				case 1:  seg(left(), bottom()); break;
				case 2:  seg(bottom(), right()); break;
				case 3:  seg(left(), right()); break;
				case 4:  seg(right(), top()); break;
				case 6:  seg(bottom(), top()); break;
				case 7:  seg(left(), top()); break;
				case 8:  seg(top(), left()); break;
				case 9:  seg(top(), bottom()); break;
				case 11: seg(top(), right()); break;
				case 12: seg(right(), left()); break;
				case 13: seg(right(), bottom()); break;
				case 14: seg(bottom(), left()); break;
				case 5: case 10: {
					// a saddle: the centre decides whether the two inside corners are joined across it
					const joined = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 < 0;
					if (code === 5) {
						if (joined) { seg(left(), top()); seg(right(), bottom()); }
						else		{ seg(left(), bottom()); seg(right(), top()); }
					} else {
						if (joined) { seg(bottom(), left()); seg(top(), right()); }
						else		{ seg(bottom(), right()); seg(top(), left()); }
					}
					break;
				}
			}
		}
	}

	const loops: float2[][] = [];
	for (const start of next.keys()) {
		if (!next.has(start))
			continue;
		const loop: float2[] = [];
		for (let k: number | undefined = start; k !== undefined && next.has(k); ) {
			loop.push(points.get(k)!);
			const n: number = next.get(k)!;
			next.delete(k);
			k = n;
		}
		const thin = simplifyLoop(loop, h / 4);
		if (thin.length >= 3)
			loops.push(thin);
	}
	return loops;
}

// Douglas-Peucker on a closed loop: split at the point furthest from the first, then thin each half as a polyline
function simplifyLoop(loop: float2[], tol: number): float2[] {
	if (loop.length < 4)
		return loop;
	let far = 0, best = -1;
	loop.forEach((p, i) => { const d = Math.hypot(p.x - loop[0].x, p.y - loop[0].y); if (d > best) { best = d; far = i; } });
	const thin = (pts: float2[]): float2[] => {
		const a = pts[0], b = pts[pts.length - 1];
		const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
		let worst = -1, at = 0;
		for (let i = 1; i < pts.length - 1; i++) {
			const d = len > 0
				? Math.abs(ex * (pts[i].y - a.y) - ey * (pts[i].x - a.x)) / len
				: Math.hypot(pts[i].x - a.x, pts[i].y - a.y);
			if (d > worst) { worst = d; at = i; }
		}
		if (worst <= tol)
			return [a];
		return [...thin(pts.slice(0, at + 1)), ...thin(pts.slice(at))];
	};
	return [...thin(loop.slice(0, far + 1)), ...thin([...loop.slice(far), loop[0]])];
}

// How finely a traced projection is drawn: cells across its larger side.
const TRACE_CELLS = 200;

// projection(): the shadow of a solid on the xy plane, or with `cut` the slice through it there, as 2-D shapes --
// `traced` is the cell size when some of it had to be traced rather than known exactly (see above).
export function projection(body: Sdf, cut: boolean): {sdf: Sdf, traced?: number} {
	let traced: number | undefined;
	const walk = (s: Sdf): Sdf => {
		if (s.k === 'union')
			return union(s.children.map(walk));
		if (s.k === 'material') {
			const b = walk(s.body);
			return b.k === 'empty' ? empty : {k: 'material', mat: s.mat, body: b};
		}
		const exact = projectExact(s, float3x4.identity(), cut);
		if (exact)
			return exact;
		const b = bounds3(s);
		if (!b || (cut && (b.min.z > 0 || b.max.z < 0)))
			return empty;
		const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
		if (!(size > 0) || !Number.isFinite(size))
			return empty;
		const h = size / TRACE_CELLS;
		traced = Math.max(traced ?? 0, h);
		const pad = float2(h, h);
		const box = new Box2(float2(b.min.x, b.min.y).sub(pad), float2(b.max.x, b.max.y).add(pad));
		const f = cut
			? (x: number, y: number) => evalSdf(s, float3(x, y, 0))
			: (x: number, y: number) => shadowDistance(s, x, y, b.min.z, b.max.z, h / 4);
		const paths = traceOutline(f, box, h);
		return paths.length ? {k: 'polygon2', paths} : empty;
	};
	return {sdf: walk(body), traced};
}

//-----------------------------------------------------------------------------
// the material of a surface, at a point or in the shader
//-----------------------------------------------------------------------------

// What a surface is made of. rgb and opacity come from color(); everything else from `$` variables, which OpenSCAD
// ignores, so a file that sets them is still a valid scad file and simply renders without the effect there.
export interface Material {
	rgb:		float3;
	opacity:	number;		// color()'s alpha: how much light it does not let through
	specular:	number;		// how strong the highlight is; where it falls is the Fresnel term's business
	roughness:	number;		// how wide the highlight and the reflection are
	ior:		number;		// the refractive index: 1 is air, which bends nothing
	metallic:	number;		// 1 puts the colour in the reflection and lets nothing through
	colorFn?:	ColorFn;	// a colour that is a function of the point, in place of rgb (which is then only what is shown where a pixel has no point to ask)
}

// The viewer's own material: what geometry no color() and no `$` variable mentions is drawn in. The index of
// refraction defaults to that of a plastic rather than to 1, because it does two jobs: it bends light through a
// transparent material, and it says how much light a dielectric reflects head-on (about 4% at 1.5). An opaque
// surface never transmits whatever its index -- that is color()'s alpha -- so this only ever means "an ordinary
// glossy plastic", and $ior = 1 is how a surface with no reflection at all is asked for.
export const DEFAULT_MATERIAL: Material = {
	rgb: float3(0.62, 0.66, 0.72), opacity: 1, specular: 0.25, roughness: 0.4, ior: 1.5, metallic: 0,
};

// Two materials draw the same, whether they are the same object or not.
export function sameMaterial(a: Material, b: Material): boolean {
	return Math.abs(a.rgb.x - b.rgb.x) < 1e-9 && Math.abs(a.rgb.y - b.rgb.y) < 1e-9 && Math.abs(a.rgb.z - b.rgb.z) < 1e-9 &&
		Math.abs(a.opacity - b.opacity) < 1e-9 && Math.abs(a.specular - b.specular) < 1e-9 &&
		Math.abs(a.roughness - b.roughness) < 1e-9 && Math.abs(a.ior - b.ior) < 1e-9 &&
		Math.abs(a.metallic - b.metallic) < 1e-9 && a.colorFn === b.colorFn;
}

// Every material in the field with the default at index 0, in the order they are met. Both the emitter and the mirror
// read the indices off this one walk, so the material the shader reports and the one measured here cannot drift.
// byMat is the same numbering by the material itself, which survives restrict() making new nodes round it.
function materialWalk(root: Sdf): {ids: Map<Sdf, number>, byMat: Map<Material, number>, palette: Material[]} {
	const ids = new Map<Sdf, number>(), byMat = new Map<Material, number>(), palette: Material[] = [DEFAULT_MATERIAL];
	walk(root, (s, process) => {
		if (s.k=== 'material') {
			// the same material written twice is one entry, so the palette stays as short as it can be
			let i = palette.findIndex(m => sameMaterial(m, s.mat));
			if (i < 0) {
				palette.push(s.mat);
				i = palette.length - 1;
			}
			ids.set(s, i);
			byMat.set(s.mat, i);
		}
		return process(s);
	});
	return {ids, byMat, palette};
}

export function materials(root: Sdf) {
	return materialWalk(root).palette;
}

// The material shown at a point, by the rule the shader uses: the nearest operand wins a union, the operand bounding
// an intersection does, and cut faces keep the material of what they were cut out of, which is what OpenSCAD shows.
export function evalMaterial(root: Sdf, p: float3, ids = materialWalk(root).byMat): number {
	const walk = (s: Sdf, p: float3, mat: number): number => {
		switch (s.k) {
			case 'material':
				return walk(s.body, p, ids.get(s.mat) ?? mat);
			case 'union': {
				let best = 1e20, id = mat;
				for (const c of s.children) {
					const d = evalSdf(c, p);
					if (d < best) {
						best = d;
						id = walk(c, p, mat);
					}
				}
				return id;
			}
			case 'intersection': {
				let best = -1e20, id = mat;
				for (const c of s.children) {
					const d = evalSdf(c, p);
					if (d > best) {
						best = d;
						id = walk(c, p, mat);
					}
				}
				return id;
			}
			case 'difference':
				// only the base chooses: the faces a cut exposes are the base's own material
				return walk(s.base, p, mat);
			case 'domain':
				// the body's parts are compared where the point is in the body's frame
				return walk(s.body, inverseOrIdentity(s.m).mulPos(p), mat);
			case 'revolve':
				return walk(s.body, float3(Math.hypot(p.x, p.y), p.z, 0), mat);
			case 'offset': case 'extrude': case 'displace':
				return walk(s.body, p, mat);
			default:
				return mat;			// a dilate is measured through a helper that carries no colour
		}
	};
	return walk(root, p, 0);
}

//-----------------------------------------------------------------------------
// emit as glsl
//-----------------------------------------------------------------------------

// The distance from `p` to the box `c` lives in, as glsl, or undefined when it has none (it reaches to infinity). The box
// is padded a hair so that rounding in the glsl cannot make a point on the surface look outside it.
function boxDistOf(c: Sdf, p: string): string | undefined {
	const b = cullBox(c);
	if (!b)
		return undefined;
	const pad = Math.max(1e-6, 1e-4 * finiteSize(b));
	return `boxDist(${p}, ${v3(b.min.sub(expand3(pad)))}, ${v3(b.max.add(expand3(pad)))})`;
}


//-----------------------------------------------------------------------------
// a big union of simple shapes, as data
//-----------------------------------------------------------------------------

// A union of hundreds of like shapes -- the boxes of a for loop, the branches of a recursive module -- cannot be
// emitted as code: the shader grows with every leaf (a 2000-leaf tree was 26,000 lines and took 14 seconds to
// compile, and culling it by boxes as a union of 3 or more is made 1.8 MB and minutes), long before culling could save
// the marcher anything. So it is emitted as data instead: each leaf's transform, parameters, material and box go in a
// texture, with a bounding-volume hierarchy over the boxes, and one small function in sdflib.frag (sdBatch) walks the
// hierarchy nearest box first, skipping whatever cannot beat the best found. The shader no longer grows with the
// number of leaves, and a step costs about log N rather than N.
//
// Texels are RGBA32F. A node is two: (box min, left) and (box max, right), where left is a node index, or for a leaf
// -(leaf index + 1). A leaf is five: three rows of the map into its own space (q = M p + t, distances then scaled), then
// (scale, kind, material, param 0) and (param 1, param 2, param 3, order).
// Enough leaves, or enough segments among fewer: a text of a dozen glyphs is a union of a dozen leaves, and a hundred
// unrolled segments each.
const BATCH_MIN = 16, BATCH_MAX = 65536, BATCH_SEGMENTS = 48;
const BATCH_KINDS = {sphere: 0, box: 1, cylinder: 2, square2: 3, circle2: 4, path2: 5};

interface BatchLeaf {
	kind:		number;
	params:		number[];		// four
	segs?:		number[];		// a path's segments, eight floats each: (start, end) and (control, kind), see batchPath in sdflib.frag
	m:			float3x4;		// the map from the union's space into the shape's own
	scale:		number;
	material:	number;
	box:		Box3;
	order:		number;
	term?:		Sdf;			// the shape itself, which the grid is built by measuring
}

const IDENTITY_MAP = float3x4.identity();

// a after b: apply b's map first, then a's
function composeMaps(a: float3x4, b: float3x4): float3x4 {
	return a.mulAffine(b);
}

// The leaf a term amounts to, if it is a simple shape under nothing but transforms and colours -- the wrappers place()
// and color() put round a shape -- or undefined. `mat` is the material in force outside it, which a color() replaces.
function batchLeaf(term: Sdf, mat: number, ids: Map<Sdf, number>): Omit<BatchLeaf, 'box' | 'order'> | undefined {
	let s = term, m = IDENTITY_MAP, scale = 1;
	for (;;) {
		if (s.k === 'material') {
			mat = ids.get(s) ?? mat;
			s = s.body;
		} else if (s.k === 'domain') {
			m = composeMaps(inverseOrIdentity(s.m), m);		// outer first: the point meets the outer frame before the inner
			scale *= s.scale;
			s = s.body;
		} else {
			break;
		}
	}
	const leaf = (kind: number, ...params: number[]) => ({kind, params: [params[0] ?? 0, params[1] ?? 0, params[2] ?? 0, params[3] ?? 0], m, scale, material: mat});
	switch (s.k) {
		case 'sphere':		return leaf(BATCH_KINDS.sphere, s.r);
		case 'box':			return leaf(BATCH_KINDS.box, s.size.x, s.size.y, s.size.z, s.center ? 1 : 0);
		case 'cylinder':	return leaf(BATCH_KINDS.cylinder, s.r, s.h, s.center ? 1 : 0);
		case 'square2':		return leaf(BATCH_KINDS.square2, s.size.x, s.size.y, s.center ? 1 : 0);
		case 'circle2':		return s.n === 0 ? leaf(BATCH_KINDS.circle2, s.r) : undefined;
		case 'curvepath2': {
			const segs: number[] = [];
			parseCurve(s.paths).run({
				Line(a: float2, b: float2)					{ segs.push(a.x, a.y, b.x, b.y, 0, 0, 0, 0); },
				Bezier2(a: float2, c: float2, b: float2)	{ segs.push(a.x, a.y, b.x, b.y, c.x, c.y, 1, 0); }
			});
			return segs.length ? {...leaf(BATCH_KINDS.path2), segs} : undefined;
		}
		case 'polygon2': {
			// each edge, the last back to the first, as a straight segment of a path
			const segs: number[] = [];
			for (const path of s.paths)
				path.forEach((a, i) => {
					const b = path[(i + 1) % path.length];
					segs.push(a.x, a.y, b.x, b.y, 0, 0, 0, 0);
				});
			return segs.length ? {...leaf(BATCH_KINDS.path2), segs} : undefined;
		}
		default:			return undefined;
	}
}

// the terms of a union with any nested unions opened out, in the order they were written
function flattenUnion(children: Sdf[], out: Sdf[] = []): Sdf[] {
	for (const c of children) {
		if (c.k === 'union')
			flattenUnion(c.children, out);
		else if (c.k !== 'empty')
			out.push(c);
	}
	return out;
}

// A hierarchy over the leaves' boxes, by splitting at the median of the longest axis of their centres -- an axis a
// 2-D shape has no extent along (its box runs to infinity in z) is never the one split on. Node 0 is the root.
interface BatchNode { lo: float3, hi: float3, left: number, right: number }
function buildHierarchy(leaves: BatchLeaf[]): BatchNode[] {
	const nodes: BatchNode[] = [];
	const clamp = (v: number) => Math.max(-1e20, Math.min(1e20, v));
	const centre = (l: BatchLeaf, axis: 'x' | 'y' | 'z') => (l.box.min[axis] + l.box.max[axis]) / 2;
	const build = (items: number[]): number => {
		const at = nodes.length;
		nodes.push(undefined as unknown as BatchNode);
		let lo = float3(Infinity, Infinity, Infinity), hi = float3(-Infinity, -Infinity, -Infinity);
		for (const i of items) {
			lo = lo.min(leaves[i].box.min);
			hi = hi.max(leaves[i].box.max);
		}
		if (items.length === 1) {
			nodes[at] = {lo, hi, left: -(items[0] + 1), right: 0};
			return at;
		}
		let axis: 'x' | 'y' | 'z' = 'x', spread = -1;
		for (const a of ['x', 'y', 'z'] as const) {
			const cs = items.map(i => centre(leaves[i], a)).filter(Number.isFinite);
			const extent = cs.length ? Math.max(...cs) - Math.min(...cs) : -1;
			if (extent > spread) { spread = extent; axis = a; }
		}
		const sorted = [...items].sort((a, b) => (centre(leaves[a], axis) || 0) - (centre(leaves[b], axis) || 0) || a - b);
		const half = sorted.length >> 1;
		const left = build(sorted.slice(0, half)), right = build(sorted.slice(half));
		nodes[at] = {lo, hi, left, right};
		return at;
	};
	build(leaves.map((_, i) => i));
	for (const n of nodes) {
		n.lo = float3(clamp(n.lo.x), clamp(n.lo.y), clamp(n.lo.z));
		n.hi = float3(clamp(n.hi.x), clamp(n.hi.y), clamp(n.hi.z));
	}
	return nodes;
}

// Appends a batch to the texture data and returns the call that asks for it. The boxes are padded a hair, for the
// reason boxDistOf's are.
function emitBatch(e: Emit, leaves: BatchLeaf[], p: string): string {
	const nodes = buildHierarchy(leaves);
	const nodeBase = e.data.length / 4, leafBase = nodeBase + nodes.length * 2;
	for (const n of nodes) {
		const pad = Math.max(1e-6, 1e-4 * Math.max(0, ...[n.hi.x - n.lo.x, n.hi.y - n.lo.y, n.hi.z - n.lo.z].filter(d => d < 1e19)));
		const grow = (v: number, d: number) => Math.abs(v) >= 1e19 ? v : v + d;
		e.data.push(grow(n.lo.x, -pad), grow(n.lo.y, -pad), grow(n.lo.z, -pad), n.left, grow(n.hi.x, pad), grow(n.hi.y, pad), grow(n.hi.z, pad), n.right);
	}
	// a path's segments follow the leaves, and its leaf says where they start and how many there are
	let segAt = leafBase + leaves.length * 5;
	const segStart = leaves.map(l => {
		const at = segAt;
		segAt += (l.segs?.length ?? 0) / 4;
		return at;
	});
	leaves.forEach((l, i) => {
		const {x, y, z, w} = l.m;
		const params = l.segs ? [segStart[i], l.segs.length / 8, 0, 0] : l.params;
		e.data.push(
			x.x, y.x, z.x, w.x,
			x.y, y.y, z.y, w.y,
			x.z, y.z, z.z, w.z,
			l.scale, l.kind, l.material, params[0],
			params[1], params[2], params[3], l.order);
	});
	for (const l of leaves)
		if (l.segs)
			e.data.push(...l.segs);
	const grid = emitGrid(e, leaves);
	return grid < 0 ? `sdBatch(${p}, ${nodeBase}, ${leafBase})` : `sdBatchGrid(${p}, ${nodeBase}, ${leafBase}, ${grid})`;
}

// A grid over the plane for a union of 2-D shapes, which the hierarchy cannot serve well when the shapes are long and
// thin and lie across one another: their boxes all overlap, so no box can be skipped, and every step measures nearly
// every shape. Each cell of the grid lists the shapes that could be the nearest to some point in it. A shape's
// distance over a cell is within (its distance at the centre) +- (the cell's radius x how fast the distance can change),
// so a shape is dropped from a cell when even its lowest possible distance is above the lowest highest-possible
// distance of any shape. What is left still holds the minimum exactly, and the shader measures only those.
// Laid out after the segments: two header texels, (x0, y0, 1/cell width, 1/cell height) and (nx, ny, first cell, 0);
// a texel for each cell, (first list texel, count); where the list would be too long the count is -2 and the texel is
// the first of a finer grid of 8 x 8 cells over that cell's rectangle (to as many levels as it takes, to three), or -1
// where even that was too crowded and the hierarchy answers; then the lists and the finer grids, a list's shape
// indices four to a texel. Returns the header's texel, or -1 if there is no grid.
const GRID_MIN_LEAVES = 8, GRID_MAX_LIST = 24, GRID_MAX_CELLS = 16384, GRID_WORK = 600000, GRID_SUB = 8, GRID_DEPTH = 3;
function emitGrid(e: Emit, leaves: BatchLeaf[]): number {
	if (leaves.length < GRID_MIN_LEAVES)
		return -1;
	const finite = (v: number) => Math.abs(v) < 1e19;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const lip: number[] = [];
	for (const l of leaves) {
		// only shapes of the plane that depend on the plane alone, and sit somewhere
		if (!l.term || l.kind < BATCH_KINDS.square2 || l.m.z.x !== 0 || l.m.z.y !== 0
			|| !finite(l.box.min.x) || !finite(l.box.max.x) || !finite(l.box.min.y) || !finite(l.box.max.y))
			return -1;
		x0 = Math.min(x0, l.box.min.x); x1 = Math.max(x1, l.box.max.x);
		y0 = Math.min(y0, l.box.min.y); y1 = Math.max(y1, l.box.max.y);
		// the largest factor the plane part of the map can stretch by, times the distance scale
		const a = l.m.x.x, b = l.m.y.x, c = l.m.x.y, d = l.m.y.y;
		const t = a * a + b * b + c * c + d * d, det = a * d - b * c;
		lip.push(l.scale * Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2));
	}
	const w = x1 - x0, h = y1 - y0;
	if (!(w > 0 && h > 0))
		return -1;
	const cells = Math.min(GRID_MAX_CELLS, Math.floor(GRID_WORK / leaves.length));
	const size = Math.sqrt(w * h / cells);
	const nx = Math.max(1, Math.ceil(w / size)), ny = Math.max(1, Math.ceil(h / size));
	const cw = w / nx, ch = h / ny, radius = Math.hypot(cw, ch) / 2;

	// what a rectangle of the grid holds: a list of shapes, or if the list is long a finer grid over it, or at last
	// nothing (the hierarchy answers there)
	type Cell = {list: number[]} | {sub: Cell[]} | undefined;
	const build = (cx: number, cy: number, cw: number, ch: number, among: number[], depth: number): Cell => {
		const p = float3(cx + cw / 2, cy + ch / 2, 0), r = Math.hypot(cw, ch) / 2;
		const d = among.map(k => evalSdf(leaves[k].term!, p));
		let top = Infinity;
		d.forEach((v, i) => top = Math.min(top, v + lip[among[i]] * r));
		const slack = 1e-6 * (Math.abs(top) + 1);
		const list = among.filter((k, i) => d[i] - lip[k] * r <= top + slack);
		if (list.length <= GRID_MAX_LIST)
			return {list};
		if (depth >= GRID_DEPTH)
			return undefined;
		const sub: Cell[] = [];
		for (let j = 0; j < GRID_SUB; j++)
			for (let i = 0; i < GRID_SUB; i++)
				sub.push(build(cx + i * cw / GRID_SUB, cy + j * ch / GRID_SUB, cw / GRID_SUB, ch / GRID_SUB, list, depth + 1));
		return {sub};
	};
	const all = leaves.map((_, k) => k);
	const top: Cell[] = [];
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++)
			top.push(build(x0 + i * cw, y0 + j * ch, cw, ch, all, 1));

	const base = e.data.length / 4, cellBase = base + 2, extraBase = cellBase + nx * ny;
	const extra: number[] = [];
	// writes a cell's texel, with whatever it points at after the ones so far
	const place = (c: Cell): [number, number] => {
		if (!c)
			return [0, -1];
		if ('list' in c) {
			const at = extraBase + extra.length / 4;
			for (let k = 0; k < c.list.length; k += 4)
				extra.push(c.list[k], c.list[k + 1] ?? 0, c.list[k + 2] ?? 0, c.list[k + 3] ?? 0);
			return [at, c.list.length];
		}
		const at = extraBase + extra.length / 4, first = extra.length;
		extra.push(...new Array(c.sub.length * 4).fill(0));
		c.sub.forEach((child, k) => {
			const [x, y] = place(child);
			extra[first + 4 * k] = x;
			extra[first + 4 * k + 1] = y;
		});
		return [at, -2];
	};
	e.data.push(x0, y0, 1 / cw, 1 / ch, nx, ny, cellBase, 0);
	for (const c of top)
		e.data.push(...place(c), 0, 0);
	for (const v of extra)		// (one at a time: there may be more than a call can take)
		e.data.push(v);
	return base;
}

interface Emit {
	helpers: string[];		// the functions the map body calls
	body: string[];			// the body of map(), without the return
	n: number;				// names helpers apart
	ids: Map<Sdf, number>;	// each color() and the material index it emits
	data: number[];			// floats for the batch texture (see batchUnion), four to a texel
	textures: Map<Texture, number>;	// the texel each texture() a function reads starts at
}

// Where a texture's pixels are in the batch texture, put there the first time a function reads it
function texturePlace(e: Emit): TexturePlace {
	return t => {
		let at = e.textures.get(t);
		if (at === undefined) {
			e.textures.set(t, at = e.data.length / 4);
			for (const x of t.rgba)
				e.data.push(x);
		}
		return at;
	};
}

// The combinators carry the material of the operand that decided the result, so map() can return both at once. They
// keep the earlier operand on a tie, which is the rule evalMaterial() uses here.
const OP_HELPERS = `// each term is (distance, material), so the colour survives the combinators
vec2 opUnion(vec2 a, vec2 b) { return a.x <= b.x ? a : b; }
vec2 opIntersect(vec2 a, vec2 b) { return a.x >= b.x ? a : b; }
vec2 opSubtract(vec2 a, vec2 b) { return -b.x > a.x ? vec2(-b.x, a.y) : a; }
// how far p is from a box: what a term can be no closer than, which lets a union skip the terms that cannot matter
float boxDist(vec3 p, vec3 lo, vec3 hi) { return length(max(max(lo - p, p - hi), vec3(0.0))); }`;

// The palette the material indices select from, one function per property so the shader carries its own materials
// with no uniform. Each is an if-chain rather than an array because the test harness reads these functions too, and a
// chain is a smaller thing for it to have to understand.
function materialFunction(palette: Material[], place: TexturePlace): string {
	const lines = ['// the material palette: index 0 is the viewer\'s own, then each one the model set, in the order met'];
	const accessor = (name: string, type: string, of: (m: Material) => string) => {
		lines.push(`${type} ${name}(float m) {`);
		for (let i = 0; i < palette.length - 1; i++)
			lines.push(`\tif (m < ${f(i + 0.5)}) return ${of(palette[i])};`);
		lines.push(`\treturn ${of(palette[palette.length - 1])};`);
		lines.push('}');
	};
	// a colour that is a function of the point asks for it at g_hit, the point being shaded, where the surface's normal is
	// g_normal (both set by the shader before it shades), each carried into the frame the function was written in
	const fns = new Map<Material, string>();
	palette.forEach((m, i) => {
		if (m.colorFn) {
			const name = `matFn${i}`;
			fns.set(m, name);
			lines.push(m.colorFn.glsl(name, place));
		}
	});
	accessor('matColor', 'vec3', m => fns.has(m) ? `${fns.get(m)}(g_hit, g_normal)` : v3(m.rgb));
	accessor('matOpacity', 'float', m => f(m.opacity));
	accessor('matSpec', 'float', m => f(m.specular));
	accessor('matRough', 'float', m => f(m.roughness));
	accessor('matIor', 'float', m => f(m.ior));
	accessor('matMetal', 'float', m => f(m.metallic));
	return lines.join('\n');
}

// The distance to `s` at `p`, as statements writing the variable `v`. A nested term gets its own variable so the
// combinators read as the operations they are, and a transformed term gets its own point for the frame it is built in.
function emit(e: Emit, out: string[], v: string, s: Sdf, p: string, indent: string, mat: number) {
	const line = (text: string) => out.push(indent + text);
	switch (s.k) {
		case 'empty':
			line(`vec2 ${v} = vec2(1e20, ${f(mat)});`);
			return;
		case 'sphere':
			line(`vec2 ${v} = vec2(length(${p}) - ${f(s.r)}, ${f(mat)});`);
			return;
		case 'box': {
			const h = s.size.scale(0.5);
			const c = s.center ? float3(0, 0, 0) : h;
			line(`vec3 ${v}_q = abs(${p} - ${v3(c)}) - ${v3(h)};`);
			line(`vec2 ${v} = vec2(length(max(${v}_q, vec3(0.0))) + min(max(${v}_q.x, max(${v}_q.y, ${v}_q.z)), 0.0), ${f(mat)});`);
			return;
		}
		case 'cylinder':
			line(`vec2 ${v} = vec2(max(length(${p}.xy) - ${f(s.r)}, ${s.center ? `abs(${p}.z) - ${f(s.h / 2)}` : `max(-${p}.z, ${p}.z - ${f(s.h)})`}), ${f(mat)});`);
			return;
		case 'ngonPrism':
			line(`vec2 ${v} = vec2(max(sdNgon(${p}.xy, ${f(s.r)}, ${f(s.n)}), ${s.center ? `abs(${p}.z) - ${f(s.h / 2)}` : `max(-${p}.z, ${p}.z - ${f(s.h)})`}), ${f(mat)});`);
			return;
		case 'cone': {
			const z0 = s.center ? -s.h / 2 : 0, z1 = s.center ? s.h / 2 : s.h;
			line(`vec2 ${v} = vec2(sdCone(${p}, ${f(z0)}, ${f(z1)}, ${f(s.r1)}, ${f(s.r2)}), ${f(mat)});`);
			return;
		}
		case 'planes': {
			// A convex polyhedron is the intersection of its face planes, and their furthest is a bound on the
			// distance -- but only the distance to a *region* of a face is the real thing, and the difference is
			// exactly the rounding: a plane bound lets a face reach out past its own edges, so a polyhedron grown
			// by a ball would come out sharp-edged and too big. Each face is measured to its own polygon instead,
			// skipped as soon as its plane is further away than the best found (nothing beyond it can be nearer).
			const name = `sdPoly${e.n++}`;
			const lines = [`float ${name}(vec3 p) {`, `\tfloat plane = -1e20, best = 1e20;`];
			for (let i = 0; i < s.planes.length; i++) {
				const pl = s.planes[i];
				const frame = s.faces[i] ? faceFrame(s.faces[i], pl.n) : undefined;
				lines.push(`\t{`);
				lines.push(`\t\tfloat perp = dot(p, ${v3(pl.n)}) - ${f(pl.d)};`);
				lines.push(`\t\tplane = max(plane, perp);`);
				lines.push(`\t\tfloat a = abs(perp);`);
				lines.push(`\t\tif (a < best) {`);
				if (frame) {
					lines.push(`\t\t\tvec3 r = p - ${v3(frame.centre)};`);
					lines.push(`\t\t\tvec2 q = vec2(dot(r, ${v3(frame.u)}), dot(r, ${v3(frame.v)}));`);
					lines.push(`\t\t\tfloat within = 1e20;`);
					for (const t of frame.tris)
						lines.push(`\t\t\twithin = min(within, sdTri2(q, ${v2(t[0])}, ${v2(t[1])}, ${v2(t[2])}));`);
					lines.push(`\t\t\tfloat region = max(within, 0.0);`);
					lines.push(`\t\t\tbest = min(best, sqrt(perp * perp + region * region));`);
				} else {
					lines.push(`\t\t\tbest = min(best, a);`);
				}
				lines.push(`\t\t}`);
				lines.push(`\t}`);
			}
			lines.push(`\treturn plane > 0.0 ? best : -best;`);
			lines.push(`}`);
			e.helpers.push(lines.join('\n'));
			line(`vec2 ${v} = vec2(${name}(${p}), ${f(mat)});`);
			return;
		}
		case 'union': {
			line(`vec2 ${v} = vec2(1e20, ${f(mat)});`);
			let kids: Sdf[] = s.children.filter(c => c.k !== 'empty');
			// Simple shapes in bulk go out as data (see above), with the other terms left to the code paths below.
			const flat = flattenUnion(s.children);
			if (flat.length >= 2) {
				const found: {term: Sdf, leaf: Omit<BatchLeaf, 'box' | 'order'>, box: Box3}[] = [];
				let segments = 0;
				for (const term of flat) {
					const leaf = batchLeaf(term, mat, e.ids), box = leaf && cullBox(term);
					if (leaf && box) {
						found.push({term, leaf, box});
						segments += (leaf.segs?.length ?? 0) / 8;
					}
				}
				if ((found.length >= BATCH_MIN || (found.length >= 2 && segments >= BATCH_SEGMENTS)) && found.length <= BATCH_MAX) {
					const taken = new Set(found.map(f => f.term));
					line(`${v} = ${emitBatch(e, found.map((f, order) => ({...f.leaf, box: f.box, order, term: f.term})), p)};`);
					kids = flat.filter(t => !taken.has(t));
				}
			}
			// Enough terms, each costly, and a union asks all of them at every point. But a term can be no closer than
			// its box, so the ones whose box is further than the best found cannot decide the result and need not be
			// asked. Which is best is not known until it is found, so the term with the nearest box goes first and the
			// rest are tested against it. Each term becomes a function so it can be called from either place.
			if (kids.length >= CULL_MIN) {
				const fns = kids.map(c => {
					const name = `sdTerm${e.n++}`;
					const inner: string[] = [];
					emit(e, inner, 'd', c, 'p', '\t', mat);
					e.helpers.push(`vec2 ${name}(vec3 p) {\n${inner.join('\n')}\n\treturn d;\n}`);
					return {name, box: boxDistOf(c, p) ?? '0.0'};
				});
				fns.forEach((k, i) => line(`float ${v}_b${i} = ${k.box};`));
				line(`float ${v}_bm = ${fns.map((_, i) => `${v}_b${i}`).reduce((a, b) => `min(${a}, ${b})`)};`);
				// the earlier term wins a tie, as opUnion does, so the order the terms are asked in must not change the material
				line(`float ${v}_w = 1e9;`);
				const ask = (i: number, name: string) => {
					line(`\t{`);
					line(`\t\tvec2 c = ${name}(${p});`);
					line(`\t\tif (c.x < ${v}.x || (c.x == ${v}.x && ${i}.0 < ${v}_w)) {`);
					line(`\t\t\t${v} = c;`);
					line(`\t\t\t${v}_w = ${i}.0;`);
					line(`\t\t}`);
					line(`\t}`);
				};
				fns.forEach((k, i) => {
					line(`if (${v}_b${i} == ${v}_bm)`);
					ask(i, k.name);
				});
				// a box that holds the point is always asked: inside a term the field goes negative, and inside a union
				// it is the deepest that counts
				fns.forEach((k, i) => {
					line(`if (${v}_b${i} != ${v}_bm && (${v}_b${i} <= 0.0 || ${v}_b${i} < ${v}.x))`);
					ask(i, k.name);
				});
				return;
			}
			for (const c of kids) {
				line(`{`);
				emit(e, out, `${v}_c`, c, p, indent + '\t', mat);
				line(`\t${v} = opUnion(${v}, ${v}_c);`);
				line(`}`);
			}
			return;
		}
		case 'intersection':
			line(`vec2 ${v} = vec2(-1e20, ${f(mat)});`);
			for (const c of s.children) {
				if (c.k === 'empty')
					continue;
				line(`{`);
				emit(e, out, `${v}_c`, c, p, indent + '\t', mat);
				line(`\t${v} = opIntersect(${v}, ${v}_c);`);
				line(`}`);
			}
			return;
		case 'difference':
			emit(e, out, v, s.base, p, indent, mat);
			s.cuts.forEach((c, i) => {
				if (c.k === 'empty')
					return;
				// A cut takes something away only where the point is inside it or close to it. It cannot be nearer than
				// its box, so while that is further than the point is inside what is left -- which is always so outside
				// it, the base being asked first -- the cut cannot change the result and is not asked. A box that holds
				// the point is always asked.
				const box = boxDistOf(c, p);
				if (box) {
					line(`float ${v}_b${i} = ${box};`);
					line(`if (${v}_b${i} <= 0.0 || ${v}_b${i} < -${v}.x) {`);
				} else {
					line(`{`);
				}
				emit(e, out, `${v}_c`, c, p, indent + '\t', mat);
				line(`\t${v} = opSubtract(${v}, ${v}_c);`);
				line(`}`);
			});
			return;
		case 'domain': {
			const inv = inverseOrIdentity(s.m);
			// glsl builds a mat3 out of its columns, which is how inv is stored
			const columns = [
				f(inv.x.x), f(inv.x.y), f(inv.x.z),
				f(inv.y.x), f(inv.y.y), f(inv.y.z),
				f(inv.z.x), f(inv.z.y), f(inv.z.z),
			];
			line(`vec3 ${v}_p = mat3(${columns.join(', ')}) * ${p} + ${v3(inv.w)};`);
			emit(e, out, `${v}_b`, s.body, `${v}_p`, indent, mat);
			line(`vec2 ${v} = vec2(${v}_b.x * ${f(s.scale)}, ${v}_b.y);`);		// only the distance scales
			return;
		}
		case 'warp': {
			// the body is emitted at the flat point the query point stands over, and its distance scaled by the least
			// the map stretches there (see warpPoint, warpStretch and warpCut in sdflib.frag, which must agree). The
			// way to the body is its own field's gradient, so the body is asked a step each way in its own space too.
			// The axis a cylinder's rows are fitted to is passed after r, and is nothing at all when there is none.
			const args = `${v3(s.box.min)}, ${v3(s.box.max)}, ${f(s.r)}, ${s.kind === 'sphere' ? 1 : 0}`;
			const fitted = `${args}, ${f(s.axis ?? 0)}`;
			line(`vec3 ${v}_q = warpPoint(${p}, ${fitted});`);
			emit(e, out, `${v}_b`, s.body, `${v}_q`, indent, mat);
			line(`float ${v}_e = max(1e-3, abs(${v}_b.x) * 1e-2);`);
			line(`vec3 ${v}_qx = ${v}_q + vec3(${v}_e, 0.0, 0.0);`);
			line(`vec3 ${v}_qy = ${v}_q + vec3(0.0, ${v}_e, 0.0);`);
			line(`vec3 ${v}_qz = ${v}_q + vec3(0.0, 0.0, ${v}_e);`);
			emit(e, out, `${v}_gx`, s.body, `${v}_qx`, indent, mat);
			emit(e, out, `${v}_gy`, s.body, `${v}_qy`, indent, mat);
			emit(e, out, `${v}_gz`, s.body, `${v}_qz`, indent, mat);
			line(`vec3 ${v}_g = vec3(${v}_gx.x - ${v}_b.x, ${v}_gy.x - ${v}_b.x, ${v}_gz.x - ${v}_b.x);`);
			line(`vec2 ${v} = vec2(warpCut(${p}, ${args}, ${v}_b.x * warpStretch(${p}, ${v}_q, ${v}_b.x, ${v}_g, ${fitted})), ${v}_b.y);`);
			return;
		}
		case 'material':
			emit(e, out, v, s.body, p, indent, e.ids.get(s) ?? mat);
			return;
		case 'circle2':
			line(s.n
				? `vec2 ${v} = vec2(sdNgon(${p}.xy, ${f(s.r)}, ${f(s.n)}), ${f(mat)});`
				: `vec2 ${v} = vec2(length(${p}.xy) - ${f(s.r)}, ${f(mat)});`);
			return;
		case 'square2': {
			const h = s.size.scale(0.5);
			const c = s.center ? float2(0, 0) : h;
			line(`vec2 ${v}_q = abs(${p}.xy - ${v2(c)}) - ${v2(h)};`);
			line(`vec2 ${v} = vec2(length(max(${v}_q, vec2(0.0))) + min(max(${v}_q.x, ${v}_q.y), 0.0), ${f(mat)});`);
			return;
		}
		case 'polygon2': {
			// The distance to the outline, signed by an odd-even crossing count run across every path's edges with one
			// shared parity (more than one path is holes/islands), unrolled one block per edge. The crossings are
			// counted with arithmetic rather than a bvec3/all(), so the field stays inside the glsl the test harness
			// (test/webgl.js) can evaluate.
			const name = `sdShape${e.n++}`;
			const lines = [`float ${name}(vec2 p) {`];
			const first = s.paths.find(pts => pts.length)?.[0] ?? float2(0, 0);
			lines.push(`\tvec2 v0 = ${v2(first)};`);
			lines.push(`\tfloat d = dot(p - v0, p - v0), s = 1.0;`);
			for (const pts of s.paths) {
				for (let i = 0; i < pts.length; i++)
					lines.push(`\ts *= sdLine2(p, d, ${v2(pts[(i + pts.length - 1) % pts.length])}, ${v2(pts[i])});`);
			}
			lines.push(`\treturn s * sqrt(d);`);
			lines.push(`}`);
			e.helpers.push(lines.join('\n'));
			line(`vec2 ${v} = vec2(${name}(${p}.xy), ${f(mat)});`);
			return;
		}
		case 'curvepath2': {
			// The same unrolled-one-block-per-segment shape as polygon2, generalised to a mix of lines and quadratic
			// Beziers -- a curve calls the shared sdBezier2/bezierCrossing2 in sdflib.frag rather than inlining
			// Cardano's method per segment, which is what keeps a glyph's helper function small no matter how many
			// curves it has.
			const name = `sdShape${e.n++}`;
			const lines = [`float ${name}(vec2 p) {`];
			const firstStart = float2(s.paths[0].x, s.paths[0].y);
			lines.push(`\tvec2 v0 = ${v2(firstStart)};`);
			lines.push(`\tfloat d = dot(p - v0, p - v0), s = 1.0;`);
			parseCurve(s.paths).run({
				Line(a: float2, b: float2)					{ lines.push(`\ts *= sdLine2(p, d, ${v2(a)}, ${v2(b)});`); },
				Bezier2(a: float2, c: float2, b: float2)	{ lines.push(`\ts *= sdBezier2(p, d, ${v2(a)}, ${v2(c)}, ${v2(b)});`); }
			});
			lines.push(`\treturn s * sqrt(d);`);
			lines.push(`}`);
			e.helpers.push(lines.join('\n'));
			line(`vec2 ${v} = vec2(${name}(${p}.xy), ${f(mat)});`);
			return;
		}
		case 'offset':
			emit(e, out, `${v}_b`, s.body, p, indent, mat);
			line(`vec2 ${v} = vec2(${v}_b.x - ${f(s.r)}, ${v}_b.y);`);
			return;
		case 'extrude':
			// the same rounded-box correction as evalSdf's own 'extrude' case (see its comment): plain max() of
			// the 2-D distance and the z-clamp undershoots past a corner, which only shows up once something
			// (minkowski(), offset()) reads the field away from the surface itself
			emit(e, out, `${v}_b`, s.body, p, indent, mat);
			line(`float ${v}_z = ${s.center ? `abs(${p}.z) - ${f(s.h / 2)}` : `max(-${p}.z, ${p}.z - ${f(s.h)})`};`);
			line(`vec2 ${v} = vec2(min(max(${v}_b.x, ${v}_z), 0.0) + length(max(vec2(${v}_b.x, ${v}_z), 0.0)), ${v}_b.y);`);
			return;
		case 'revolve': {
			// the point's own half-plane, seen as a profile: radius across, z up
			line(`vec3 ${v}_p = vec3(length(${p}.xy), ${p}.z, 0.0);`);
			emit(e, out, `${v}_b`, s.body, `${v}_p`, indent, mat);
			if (s.angle >= 360) {
				line(`vec2 ${v} = ${v}_b;`);
			} else {
				const half = s.angle * Math.PI / 360;
				line(`float ${v}_a = atan(${p}.y, ${p}.x);`);
				line(`float ${v}_w = max(length(${p}.xy) * sin(${v}_a - ${f(half)}), length(${p}.xy) * sin(${-half} - ${v}_a));`);
				line(`vec2 ${v} = vec2(max(${v}_b.x, ${v}_w), ${f(mat)});`);
			}
			return;
		}
		case 'dilate': {
			// a flat brush on a prism cannot move the caps, so it is the cross-section's offset within a slab:
			// measuring the sides on the mid-plane gives the exact 2-D distance the brush then subtracts
			const brush = planeBrush(s.body, s.support);
			if (brush) {
				// the point with the brush's flat axis pinned to the mid-plane. Built as a constructor rather than a
				// swizzle assignment so the field stays inside the glsl the test harness (test/glsl.js) can evaluate.
				const dir = v3(brush.dir);
				line(`vec3 ${v}_q = ${p} - ${dir} * (dot(${p}, ${dir}) - ${f(brush.mid)});`);
				emit(e, out, `${v}_c`, brush.sides, `${v}_q`, indent, mat);
				// the same rounded-box correction as 'extrude' (see its own comment)
				line(`float ${v}_d2 = ${v}_c.x - ${f(s.support.r)};`);
				line(`float ${v}_dz = abs(dot(${p}, ${dir}) - ${f(brush.mid)}) - ${f(brush.half)};`);
				line(`vec2 ${v} = vec2(min(max(${v}_d2, ${v}_dz), 0.0) + length(max(vec2(${v}_d2, ${v}_dz), 0.0)), ${f(mat)});`);
				return;
			}
			// otherwise the support function needs the field's gradient, so the body becomes a function it can sample
			const name = `sdBody${e.n++}`;
			const inner: string[] = [];
			// sampled as a plain distance: a color() inside a minkowski operand tints nothing, because an operand is
			// never seen -- only the body it grows is
			emit(e, inner, 'd', s.body, 'p', '', 0);
			e.helpers.push(`float ${name}(vec3 p) {\n${inner.map(l => '\t' + l).join('\n')}\n\treturn d.x;\n}`);
			line(`float ${v}_d = ${name}(${p});`);
			if (!s.support.q) {
				line(`vec2 ${v} = vec2(${v}_d - ${f(s.support.r)}, ${f(mat)});`);
			} else {
				line(`vec3 ${v}_e = vec3(${f(1e-3)}, 0.0, 0.0);`);
				line(`vec3 ${v}_g = normalize(vec3(` +
					`${name}(${p} + ${v}_e.xyy) - ${name}(${p} - ${v}_e.xyy), ` +
					`${name}(${p} + ${v}_e.yxy) - ${name}(${p} - ${v}_e.yxy), ` +
					`${name}(${p} + ${v}_e.yyx) - ${name}(${p} - ${v}_e.yyx)) + vec3(1e-20));`);
				const q = Array.from(new Float32Array(s.support.q.flat()), f).join(', ');
				line(`float ${v}_s = ${f(s.support.r)} * sqrt(max(0.0, dot(${v}_g, mat3(${q}) * ${v}_g)));`);
				line(`vec2 ${v} = vec2(${v}_d - ${v}_s, ${f(mat)});`);
			}
			return;
		}
		case 'capsule':
			line(`vec3 ${v}_pa = ${p} - ${v3(s.a)}, ${v}_ba = ${v3(s.b.sub(s.a))};`);
			line(`float ${v}_h = clamp(dot(${v}_pa, ${v}_ba) / dot(${v}_ba, ${v}_ba), 0.0, 1.0);`);
			line(`vec2 ${v} = vec2(length(${v}_pa - ${v}_ba * ${v}_h) - ${f(s.r)}, ${f(mat)});`);
			return;
		case 'roundCone':
			line(`vec2 ${v} = vec2(sdRoundCone(${p}, ${v3(s.a)}, ${v3(s.b)}, ${f(s.r1)}, ${f(s.r2)}), ${f(mat)});`);
			return;
		case 'heightmap': {
			// the heights and the tiles go in the batch texture, four floats to a texel (see sdHeightmap and
			// sdWrappedHeightmap in sdflib.frag)
			const pack = (values: ArrayLike<number>) => {
				const at = e.data.length / 4;
				for (let i = 0; i < values.length; i++)
					e.data.push(values[i]);
				while (e.data.length % 4)
					e.data.push(0);
				return at;
			};
			const heights = pack(s.heights);
			const tiles = pack(Array.from({length: s.nearTop.length * 2}, (_, i) => i & 1 ? s.nearSlope[i >> 1] : s.nearTop[i >> 1]));
			const common = `${heights}, ${tiles}, ${s.cols}, ${s.rows}, ${s.tile}, ${s.tilesX}, ${s.tilesY}, ${f(s.bottom)}, ${f(s.top)}`;
			// a wrapped map also says how its rows are spaced and whether either axis repeats (see sdWrappedHeightmap)
			line(s.wrap
				? `vec2 ${v} = vec2(sdWrappedHeightmap(${p}, ${common}, ${f(s.wrap.r)}, ${s.wrap.kind === 'sphere' ? 1 : 0}, ` +
					`${f(s.wrap.row ?? 1)}, ${s.wrap.tileX ? 1 : 0}, ${s.wrap.tileY ? 1 : 0}, ${f(s.wrap.sx ?? 1)}, ${f(s.wrap.sy ?? 1)}, ${s.wrap.part ? 1 : 0}), ${f(mat)});`
				: `vec2 ${v} = vec2(sdHeightmap(${p}, ${common}), ${f(mat)});`);
			return;
		}
		case 'fnfield': {
			const name = `fn${e.n++}`, c = s.box.centre(), h = s.box.size().scale(0.5);
			e.helpers.push(s.fn.glsl(name, texturePlace(e)));
			line(`vec3 ${v}_q = abs(${p} - ${v3(c)}) - ${v3(h)};`);
			line(`vec2 ${v} = vec2(max(length(max(${v}_q, vec3(0.0))) + min(max(${v}_q.x, max(${v}_q.y, ${v}_q.z)), 0.0), ${name}(${p})), ${f(mat)});`);
			return;
		}
		case 'displace': {
			// the body is a function of its own, asked once at the point and, for a normal, a step each way; its material
			// is the term's. Away from the moved surface h is not asked at all (see displaceDistance, which this mirrors).
			const body = `sdBody${e.n++}`, h = `disp${e.n++}`;
			const inner: string[] = [];
			emit(e, inner, 'd', s.body, 'p', '', mat);
			e.helpers.push(`vec2 ${body}(vec3 p) {\n${inner.map(l => '\t' + l).join('\n')}\n\treturn d;\n}`);
			e.helpers.push(s.fn.glsl(h, texturePlace(e)));
			const reach = f(displaceReach(s)), hi = f(s.hi), lo = f(s.lo);
			line(`vec2 ${v}_b = ${body}(${p});`);
			line(`float ${v}_d = ${v}_b.x - ${hi};`);
			line(`if (${v}_b.x - ${lo} < -${reach})`);
			line(`\t${v}_d = ${v}_b.x - ${lo};`);
			line(`else if (${v}_d <= ${reach}) {`);
			if (s.fn.normal || s.base) {
				line(`\tvec3 ${v}_e = vec3(${f(s.eps)}, 0.0, 0.0);`);
				line(`\tvec3 ${v}_n = normalize(vec3(` +
					`${body}(${p} + ${v}_e.xyy).x - ${body}(${p} - ${v}_e.xyy).x, ` +
					`${body}(${p} + ${v}_e.yxy).x - ${body}(${p} - ${v}_e.yxy).x, ` +
					`${body}(${p} + ${v}_e.yyx).x - ${body}(${p} - ${v}_e.yyx).x) + vec3(1e-20));`);
			}
			const at = s.base ? `${p} - ${v}_n * ${v}_b.x` : p;
			line(`\tfloat ${v}_f = (${v}_b.x - ${h}(${at}, ${s.fn.normal || s.base ? `${v}_n` : 'vec3(0.0)'})) * ${f(1 / (1 + s.slope))};`);
			line(`\t${v}_d = ${v}_f >= 0.0 ? max(${v}_f, ${v}_b.x - ${hi}) : min(${v}_f, ${v}_b.x - ${lo});`);
			line('}');
			line(`vec2 ${v} = vec2(${v}_d, ${v}_b.y);`);
			return;
		}
		case 'trimesh': {
			// the hierarchy and the triangles go in the batch texture as they are laid out (see sdMesh in sdflib.frag)
			const append = (values: Float32Array) => {
				const at = e.data.length / 4;
				for (const x of values)
					e.data.push(x);
				return at;
			};
			const nodes = append(s.nodes), tris = append(s.triData);
			line(`vec2 ${v} = vec2(sdMesh(${p}, ${nodes}, ${tris}), ${f(mat)});`);
			return;
		}
		case 'stadium2':
			line(`vec2 ${v}_pa = ${p}.xy - ${v2(s.a)}, ${v}_ba = ${v2(s.b.sub(s.a))};`);
			line(`float ${v}_h = clamp(dot(${v}_pa, ${v}_ba) / dot(${v}_ba, ${v}_ba), 0.0, 1.0);`);
			line(`vec2 ${v} = vec2(length(${v}_pa - ${v}_ba * ${v}_h) - ${f(s.r)}, ${f(mat)});`);
			return;
	}
}

// the generated map() body and the functions it calls, to be spliced into the raymarcher
export function emitGlsl(root: Sdf): {helpers: string[], body: string[], data: Float32Array} {
	const {ids, palette} = materialWalk(root);
	const e: Emit = {helpers: [OP_HELPERS], body: [], n: 0, ids, data: [], textures: new Map()};
	e.helpers.push(materialFunction(palette, texturePlace(e)));
	emit(e, e.body, 'd', root, 'p', '\t', 0);
	return {helpers: e.helpers, body: e.body, data: new Float32Array(e.data)};
}

// How many primitives the field is built from, which is what the raymarcher evaluates at each step: worth saying,
// because the generated shader's cost is proportional to it.
export function countPrimitives(s: Sdf): number {
	switch (s.k) {
		case 'empty': return 0;
		case 'sphere': case 'box': case 'cylinder': case 'ngonPrism': case 'cone': case 'planes': case 'capsule': case 'roundCone': case 'heightmap': case 'fnfield': case 'trimesh': return 1;
		case 'union': case 'intersection': return s.children.reduce((n, c) => n + countPrimitives(c), 0);
		case 'difference': return countPrimitives(s.base) + s.cuts.reduce((n, c) => n + countPrimitives(c), 0);
		case 'domain': case 'warp': case 'dilate': case 'displace': case 'material': case 'offset': case 'extrude': case 'revolve':
			return countPrimitives(s.body);
		case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2': return 1;
	}
}
