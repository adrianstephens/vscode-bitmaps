// Evaluates a parsed .scad file into the field algebra of sdf.ts. What has to be executed is only the sequencing
// OpenSCAD's language demands -- variables, module instantiation, for/if/let/children -- because scad has no
// first-class geometry to defer. Everything a construct *means* is turned into a field as it is met, so nothing
// here builds a solid, and a Minkowski operand is understood from the expression it is written as.
import {
	parse, getLoc, IfElseModuleInstantiation,
	type FileAccess, type Location, type Assignment, type Expr, type LocalScope as Scope,
	type ModuleInstantiation as Inst, type UserModule,
} from './parser';
import type { Sdf, Support } from './sdf';
import { lookupColor, parseHexColor } from './colors';
import { findFont, layoutText } from './fonts';
import { MT19937, seedOf } from './random';
import { trimesh, mapTrimesh } from './meshfield';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import * as meshes from '@isopodlabs/binary_meshes';
import * as path from 'path';
import { empty,
	bounds2,	hullVertices2,	convexHull2, verticesOf2, polygonConvexity, sameRadiusCircles, mitredOffset2, offsetPreservesEdges, is2d, strip2d, flat2d,
	bounds3,	hullVertices3,	convexHull3, verticesOf3, polytopeOfIntersection, sameRadiusSpheres, weightedPoints3, weightedHull3,
	isConformal, projection, heightmap, type Tiled, type Wrap, type Warp, type Heightmap,
	sameMaterial, DEFAULT_MATERIAL, type Material,
} from './sdf';
import { float2, float3, float4, float3x3, float3x4, float2x3, safeNormalise } from '@isopodlabs/maths/vector';
import { transformCurve } from '@isopodlabs/binary_fonts';
import * as dwg from '@isopodlabs/dwg';

const extension = (full: string) => path.extname(full).toLowerCase();

export type ScadFiles = FileAccess & { readBinary<T>(full: string, reader: (bytes: Uint8Array) => T | Promise<T>): T; };

// What a module instantiation's children see when it calls children()
interface ChildScope { scope: Scope, env: Env }

class Ctx {
	private seen = new Map<string, number>();

	warn(message: string) {
		this.seen.set(message, (this.seen.get(message) ?? 0) + 1);
	}

	get list(): string[] {
		return [...this.seen].map(([message, count]) => count > 1 ? `${message} (x${count})` : message);
	}

	children	= [] as ChildScope[];
	used		= new Set<string>;	// the cache's entries this evaluation asked for, which are all it keeps
	// user-defined modules currently instantiating, outermost first, for $parent_modules/parent_module() -- a
	// builtin module (translate(), difference(), ...) is not one of OpenSCAD's own either, so it is not pushed here
	moduleStack	= [] as string[];
	constructor(public files: ScadFiles, public filename: string) {}

	openFile<T>(module: string, written: string, from: string, reader: (bytes: Uint8Array)=>T | Promise<T>): T | undefined {
		const full = this.files ? this.files.resolve(written, path.dirname(from)) : written;
		if (!full) {
			this.warn(`${module}(): '${written}' was not found`);
			return undefined;
		}
		try {
			this.used.add(full);
			return this.files.readBinary(full, reader);
		} catch {
			this.warn(`${module}(): '${written}' could not be read`);
			return undefined;
		}
	}

}
// A frame the geometry is built in: the transform from the current space to the model's, and the factor a
// distance measured inside it has to be multiplied by to stay a lower bound outside.
interface Frame { m: float3x4, scale: number }

const identityFrame: Frame = {m: float3x4.identity(), scale: 1};

const normalize	= (v: float3) => safeNormalise(v) ?? float3(0, 0, 0);
const linear 	= (m: float3x4) => float3x3(m.x, m.y, m.z);
const rad		= (deg: number) => deg * Math.PI / 180;
const deg		= (rad: number) => rad * 180 / Math.PI;
const affine	= (m: float3x3) => float3x4(m.x, m.y, m.z, float3(0, 0, 0));
const scaling	= (v: float3) => affine(float3.scale(v));
const atan2Degrees = (y: number, x: number) => deg(Math.atan2(y, x));

// OpenSCAD's rotate([x, y, z]) turns about x first, then y, then z
function rotation({x, y, z}: float3) {
	return affine(float3.rotateZ(rad(z)).matmul(float3.rotateY(rad(y))).matmul(float3.rotateX(rad(x))));
}
// rotate(a, v): a degrees about the axis v
function rotationAxis(angle: number, axis: float3) {
	return affine(float3.rotate(normalize(axis), rad(angle)));
}

// mirror across the plane through the origin with normal v
function mirroring(v: float3) {
	return affine(float3.mirror(normalize(v)));
}

interface Discretizer { fn: number, fa: number, fs: number }

// how many segments a circle of radius r takes over `angle` degrees (CurveDiscretizer::getCircularSegmentCount), or
// undefined for a radius too small to have any
function segmentCount(d: Discretizer, r: number, angle = 360): number | undefined {
	if (!(r >= 0.00000095367431640625) || !Number.isFinite(angle))
		return undefined;
	const full = d.fn > 0 ? Math.ceil(Math.max(d.fn, 3)) : Math.ceil(Math.max(Math.min(360 / d.fa, r * 2 * Math.PI / d.fs), 5));
	return Math.max(1, Math.ceil(full * Math.abs(angle) / 360));
}

//-----------------------------------------------------------------------------
// values
//-----------------------------------------------------------------------------

// What a scad expression evaluates to: a number, a string, a boolean, undef, or a (possibly nested) vector.
export type Value = number | string | boolean | undefined | Value[];

const isList = (v: Value): v is Value[] => Array.isArray(v);

function truthy(v: Value): boolean {
	if (v === undefined)
		return false;
	if (typeof v === 'boolean')
		return v;
	if (typeof v === 'number')
		return v !== 0;
	if (typeof v === 'string')
		return v.length > 0;
	return v.length > 0;
}

function num(v: Value, ctx: Ctx, what: string): number | undefined {
	if (typeof v === 'number')
		return v;
	if (typeof v === 'boolean')
		return v ? 1 : 0;
	if (v === undefined)
		return undefined;
	ctx.warn(`${what} is not a number`);
	return undefined;
}


// a point of the plane: polygon() takes [x, y], and ignores any third component
function vec2(v: Value, ctx: Ctx): float2 | undefined {
	if (!isList(v))
		return undefined;
	const x = num(v[0], ctx, 'a polygon point'), y = num(v[1], ctx, 'a polygon point');
	return x === undefined || y === undefined ? undefined : float2(x, y);
}

function vec3(v: Value, ctx: Ctx, what: string): float3 | undefined {
	if (typeof v === 'number')
		return float3(v, v, v);
	if (isList(v)) {
		const n = v.map(x => num(x, ctx, what));
		if (n.length >= 3 && n.every(x => x !== undefined))
			return float3(n[0]!, n[1]!, n[2]!);
		if (n.length === 2 && n.every(x => x !== undefined))
			return float3(n[0]!, n[1]!, 0);
	}
	ctx.warn(`${what} is not a 3-vector`);
	return undefined;
}

function show(v: Value): string {
	if (v === undefined)
		return 'undef';
	if (isList(v))
		return `[${v.map(show).join(', ')}]`;
	return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

//-----------------------------------------------------------------------------
// statements
//-----------------------------------------------------------------------------

const at = (node: unknown) => {
	const loc = getLoc(node) as Location | undefined;
	return loc ? loc.line * 100000 + loc.col : 0;
};

interface Statement { at: number, name?: string, expr?: Expr, inst?: Inst }

// OpenSCAD runs a scope's statements in the order they are written, and the parser keeps assignments and
// instantiations apart, so they are put back in order by where they were written.
function statements(scope: Scope): Statement[] {
	const out: Statement[] = [];
	for (const a of scope.assignments)
		out.push({at: at(a.expr) || at(a), name: a.name, expr: a.expr});
	for (const i of scope.moduleInstantiations)
		out.push({at: at(i), inst: i});
	return out.sort((x, y) => x.at - y.at);
}

// A primitive is placed where its frame puts it: the transform from the space it is written in to the model's,
// and the factor that keeps its distance a lower bound once the transform has stretched it. This is the only
// place a transform reaches a leaf, so every construct that changes the frame ends up in the field.
function place(frame: Frame, body: Sdf): Sdf {
	const m = frame.m;
	if (m.eq(float3x4.identity()))
		return body;

	// A frame that only turns and scales evenly carries distances through unchanged apart from its scale, so the
	// shape can stay where it is written. One that stretches an axis does not: scaling the shape's distance by its
	// smallest factor is a bound, not the distance, and a Minkowski operand reads that distance's *gradient* to aim
	// its support function -- so a hexagon under scale(sqrt(2),1,1) rounds in the wrong direction. A polyhedron can
	// simply be moved into the parent frame instead, where it measures its own distance properly.
	if (isConformal(m))
		return {k: 'domain', m, scale: frame.scale, body};

	// Move a polyhedron's faces into the frame: a plane {n.q = d} becomes {p : (L^-t n).p = d + (L^-t n).t}, divided
	// through by |L^-t n| so it is a distance again, and the face polygons move as points. Cheaper than rebuilding
	// through convexHull3 below, and it keeps the face structure as given (a box's 6 quads stay 6 quads rather than
	// a fresh triangulation), so a body already in this form takes this path first.
	if (body.k === 'planes' && Math.abs(m.det()) >= 1e-12) {
		const inv = linear(m).inverse().transpose();

		// w = L^-t n, which is the columns of L^-1 against n (inv here is already transposed)
		const planes = body.planes.map(pl => {
			const w = inv.mul(pl.n);
			const scale = w.len();
			if (scale < 1e-12)
				return pl;
			return {n: w.scale(1 / scale), d: (pl.d + w.dot(m.w)) / scale};
		});
		return {
			k: 'planes',
			planes,
			points:	body.points.map(p => m.mulPos(p)),
			faces:	body.faces.map(face => face.map(p => m.mulPos(p))),
		};
	}

	// A mesh moves its corners too, wound the other way if the frame turns it inside out; it is no hull of them.
	if (body.k === 'trimesh' && Math.abs(m.det()) >= 1e-12)
		return mapTrimesh(body, p => m.mulPos(p), m.det() < 0) ?? empty;

	// Any other body with a known finite vertex set -- a box, an n-gon prism -- is always convex, so the transform
	// of its hull is the hull of its transformed corners: it has no face structure of its own to move, so this
	// rebuilds one through convexHull3 instead. A singular or otherwise degenerate transform (an axis flattened to
	// nothing) falls through to the domain wrap below, the same as a 'planes' body that det3x3 rejected above.
	if (body.k !== 'planes') {
		const corners = verticesOf3(body);
		if (corners) {
			const hull = convexHull3(corners.map(p => m.mulPos(p)));
			if (hull)
				return {k: 'planes', planes: hull.planes, points: [...new Set(hull.faces.flat())], faces: hull.faces};
		}
	}

	// The 2-D form: a shape of the plane moves as its vertices, not as a scaled distance, or an offset() of a
	// stretched hexagon would be wrong by several millimetres. Only a transform that keeps the plane mapping to
	// itself qualifies -- no z in the x/y columns, no x/y in the z column; one that turns the shape out of the
	// plane has no 2-D vertices left to move.
	if (Math.hypot(m.x.z, m.y.z, m.z.x, m.z.y) <= 1e-12) {
		const trans	= float2x3(m.x.xy, m.y.xy, m.w.xy);
		const move	= (p: float2) => trans.mulPos(p);
		// polygon2 moves path by path -- verticesOf2 flattens every path into one point set for hull purposes, which
		// would fuse a hole's loop into the outline's, so a polygon2 body is moved directly instead of through it.
		if (body.k === 'polygon2')
			return {k: 'polygon2', paths: body.paths.map(path => path.map(move))};
		// a curvepath2 moves its control points along with its corners -- a Bezier curve under an affine map is
		// exactly the Bezier curve of the transformed control points, so this is exact, not an approximation
		if (body.k === 'curvepath2')
			return {k: 'curvepath2', paths: transformCurve(body.paths, trans)};
		const pts = verticesOf2(body);
		if (pts)
			return {k: 'polygon2', paths: [pts.map(move)]};
	}
	return {k: 'domain', m: frame.m, scale: frame.scale, body};	// a sphere or a smooth circle under a stretch is an ellipse/ellipsoid, which no polygon or polyhedron describes
}

// the positional arguments of an instantiation, in order
const positional = (args: Assignment[]) => args.filter(a => !a.name);

// OpenSCAD binds positional arguments to a module's parameters in order and ignores whatever is left over, so
// `scale(sqrt(2), 1, 1)` is scale(sqrt(2)), not a per-axis scale: Parameters::parse takes one parameter, "v", and a
// single number there means a uniform scale. Saying so is the point -- this is invisible in the geometry otherwise.
function arity(name: string, values: argGetter, count: number) {
	const extra = values.positional.length - count;
	if (extra > 0)
		values.warn(`${name}() takes ${count} argument${count === 1 ? '' : 's'}, so ${extra} of them ${extra === 1 ? 'is' : 'are'} ignored`);
}
const named = (args: Assignment[], name: string) => args.find(a => a.name === name);

const argGetter = (args: Assignment[], env: Env, ctx: Ctx) => {
	const p = positional(args);
	const get = (name: string, index = -1) => {
		const byName = named(args, name);
		if (byName)
			return env.evalExpr(byName.expr, ctx);
		return index >= 0 && index < p.length ? env.evalExpr(p[index].expr, ctx) : undefined;
	};
	return {
		positional: p,
		env,
		ctx,
		filename:	() => getLoc(args[0]?.expr)?.filename ?? ctx.filename,
		warn:	(w: string) => ctx.warn(w),
		get,
		num: (name: string, index = -1) => {
			const v = get(name, index);
			return v === undefined ? undefined : num(v, ctx, `the '${name}' argument`);
		},
		vec3: (name: string, index = -1) => {
			const v = get(name, index);
			return v === undefined ? undefined : vec3(v, ctx, `the '${name}' argument`);
		},
		vec2: (name: string, index = -1) => {
			return vec2(get(name, index), ctx);
		},
		bool: (name: string, index = -1) => {
			const v = get(name, index);
			return v === undefined ? undefined : truthy(v);
		},
		str: (name: string, index = -1) => {
			const v = get(name, index);
			return typeof v === 'string' ? v : '';
		},
		enum: <T extends string>(name: string, index: number, values: T[]): T => {
			const v = get(name, index);
			if (v === undefined)
				return values[0];
			if (values.every(i => i !== v)) {
				ctx.warn(`unrecognised ${name} (${JSON.stringify(v)}), using "${values[0]}"`);
				return values[0];
			}
			return v as T;
		},
		special: (name: string) => {
			const byName = named(args, name);
			return byName ? env.evalExpr(byName.expr, ctx) : env.get(name, ctx);
		},
		checkNum: (v: Value, what: string) => num(v, ctx, what),

	}
}
type argGetter = ReturnType<typeof argGetter>;

// The material in force here, from `$` variables. OpenSCAD ignores them, and this viewer reads them exactly the way
// it reads $fn -- including their dynamic scope, so a module can set one and everything it instantiates sees it. That
// is what keeps a file that uses them a valid scad file, which a material() module of our own would not be.
function ambientMaterial(env: Env, ctx: Ctx): Material {
	const number = (name: string) => num(env.get(name, ctx), ctx, name);
	return {
		...DEFAULT_MATERIAL,
		specular:	number('$specular') 	?? DEFAULT_MATERIAL.specular,
		roughness:	number('$roughness') 	?? DEFAULT_MATERIAL.roughness,
		ior:		number('$ior') 			?? number('$refractive_index') 	?? DEFAULT_MATERIAL.ior,
		metallic:	number('$metallic') 	?? DEFAULT_MATERIAL.metallic,
	};
}

// The material a color() describes. The colour and its alpha are positional, as OpenSCAD takes them; the rest are
// named, and both `ior = 1.5` and `$ior = 1.5` are read. That is deliberate: OpenSCAD warns about the first -- an
// unexpected parameter for color() -- and says nothing at all about the second, because it skips `$` names, and it
// ignores both. So a file that sets a material here renders in OpenSCAD as its plain colour, which is the most a
// file can degrade while still being a valid scad file. A material() module of our own would not: OpenSCAD drops the
// whole instantiation, geometry included, on an unknown module name.
function materialOf(values: argGetter): Material | undefined {
	if (values.positional.length > 2)
		values.warn('a color() with more than two positional arguments: the material properties are named');
	const colour	= colourOf(values);
	const ambient	= ambientMaterial(values.env, values.ctx);
	if (!colour)
		return undefined;
	// an explicit argument wins over the `$` variable, which is what setting one for a scope and another for one
	// object means
	const property = (name: string) =>
		values.num(name) ?? values.num(`$${name}`) ?? (ambient as any)[name === 'refractive_index' ? 'ior' : name];
	return {
		...ambient,
		rgb:		colour.xyz,
		opacity:	colour.w,
		specular:	property('specular'),
		roughness:	property('roughness'),
		ior:		values.num('ior') ?? values.num('$ior') ?? values.num('refractive_index') ?? values.num('$refractive_index') ?? ambient.ior,
		metallic:	property('metallic'),
	};
}

// color(c[, alpha]): c is a name, a "#hex" value, or [r, g, b(, a)]. OpenSCAD's own rules apply -- components
// missing from the vector are 1, out-of-range ones are used but warned about, and alpha overrides a fourth
// component. A colour it cannot read tints nothing rather than guessing.
function colourOf(values: argGetter): float4 | undefined {
	const c = values.get('c', 0);
	if (c === undefined) {
		values.warn('a color() with no colour, so it tints nothing');
		return undefined;
	}
	let rgba: [number, number, number, number] | undefined;
	if (typeof c === 'string') {
		rgba = lookupColor(c) ?? parseHexColor(c);
		if (!rgba)
			values.warn(c.toLowerCase().startsWith('xkcd:')
				? 'an xkcd: colour name, which this viewer does not carry over'
				: `a colour name or hex value it does not know: '${c}'`);
	} else if (isList(c)) {
		rgba = [1, 1, 1, 1];
		for (let i = 0; i < Math.min(4, c.length); i++)
			rgba[i] = values.checkNum(c[i], 'a component of a color()') ?? 0;
		if (rgba.some(v => v < 0 || v > 1))
			values.warn('a color() component outside 0..1');
	} else {
		values.warn('a color() whose colour is neither a name nor a vector');
	}
	if (!rgba)
		return undefined;
	const alpha = values.num('alpha', 1);
	if (alpha !== undefined)
		rgba[3] = alpha;
	if (rgba[3] < 0 || rgba[3] > 1)
		values.warn('a color() alpha outside 0..1');
	return float4(rgba[0], rgba[1], rgba[2], rgba[3]);
}

// let()'s bindings are sequential (let* in Scheme terms, not the order-independent style a module/file scope's
// variables use): each one sees every binding before it in the same let(), so it evaluates each expression in
// `target` itself -- which accumulates them one at a time -- rather than in the outer `env` a plain module-call
// argument list would use, where the arguments cannot see each other at all.
function bindArguments(args: Assignment[], target: Env, ctx: Ctx) {
	for (const a of args)
		if (a.name)
			target.values.set(a.name, target.evalExpr(a.expr, ctx));
}

// the geometry a module instantiation's children describe. A `for` or `if`/`else` among them is one operand here,
// not several: real OpenSCAD's own `for` wraps every iteration in a group that gets unioned before it is handed to
// whatever contains it (control.cc's builtin_for -> a GroupNode; CSGTreeEvaluator's generic node visitor unions a
// node's children before adding the result to its own parent), by design, not as a gap -- `intersection() { a; for
// (...) b; }` really does mean a ∩ (the union of every b), and the dedicated intersection_for() exists precisely
// because plain `for` does not do the per-iteration intersection that reads like it should.
function childrenOf(scope: Scope, env: Env, frame: Frame, ctx: Ctx): Sdf[] {
	return scope.moduleInstantiations.map(i => new Env(env).instantiate(i, frame, ctx));
}

// intersection() and intersection_for() differ only in how their children are gathered (see childrenOf and
// intersection_for's own case), not in what is done with them once gathered.
function combineIntersection(children: Sdf[]): Sdf {
	if (children.length <= 1)
		return children.length === 0 ? empty : children[0];
	// A convex polyhedron built by hand as the intersection of half-spaces (rotated boxes, most often) is turned
	// into an explicit polyhedron here: see polytopeOfIntersection's own comment for why that is what lets
	// minkowski() round it correctly, rather than just pushing its faces outward. Anything else about the
	// intersection -- what encloses it, whether it is cut afterwards -- is unaffected.
	return polytopeOfIntersection(children) ?? {k: 'intersection', children};
}

// Walks a for's nested ranges (`for (i = a, j = b)` nests as `for (i = a) for (j = b)`, so a later range may read
// an earlier loop variable, and the whole nest shares one iteration cap rather than each level getting its own),
// calling leaf(innerEnv) once fully bound for each iteration. Shared by instantiate()'s 'for' case, which combines
// what leaf builds into one shape, and instantiateList's, which does not.
function forEachIteration(args: Assignment[], env: Env, ctx: Ctx, leaf: (inner: Env) => void) {
	let count = 0, truncated = false;
	const recurse = (i: number, inner: Env) => {
		if (count >= 10000) {
			truncated = true;
		} else if (i >= args.length) {
			count++;
			leaf(inner);
		} else {
			const loop	= args[i];
			const range	= inner.evalExpr(loop.expr, ctx);
			for (const value of isList(range) ? range : [range]) {
				const next = new Env(inner);
				next.values.set(loop.name || 'i', value);
				recurse(i + 1, next);
				if (truncated)
					return;
			}
		}
	};
	if (args.length > 0)
		recurse(0, env);
	if (truncated)
		ctx.warn('a for loop with more than 10000 iterations, which is cut short');
}

//-----------------------------------------------------------------------------
// polyhedra
//-----------------------------------------------------------------------------

function vectorOfPoints(v: Value, ctx: Ctx): float3[] | undefined {
	if (!isList(v))
		return undefined;
	const out: float3[] = [];
	for (const p of v) {
		const point = vec3(p, ctx, 'a polyhedron point');
		if (!point)
			return undefined;
		out.push(point);
	}
	return out;
}

function vectorOfFaces(v: Value): number[][] | undefined {
	if (!isList(v))
		return undefined;
	const out: number[][] = [];
	for (const face of v) {
		if (!isList(face))
			return undefined;
		out.push(face.map(x => (typeof x === 'number' ? Math.round(x) : NaN)));
	}
	return out;
}

// A polyhedron's faces as half-spaces, whose furthest is the polyhedron itself only when it is convex -- which this
// says, so that one that is not can be drawn from its triangles instead (see solidOf).
function facePlanes(points: float3[], faces: number[][]): {planes: {n: float3, d: number}[], faces: float3[][], convex: boolean} | undefined {
	if (points.length < 4 || faces.length < 4)
		return undefined;

	const centre = points.reduce((a, b) => a.add(b), float3(0, 0, 0)).scale(1 / points.length);

	const planes: {n: float3, d: number}[] = [], loops: float3[][] = [];
	for (const face of faces) {
		const [i0, i1, i2] = face;
		const p0 = points[i0], p1 = points[i1], p2 = points[i2];
		if (!p0 || !p1 || !p2)
			continue;
		let n = p1.sub(p0).cross(p2.sub(p0));
		if (n.len() < 1e-12)
			continue;
		n = normalize(n);
		let d = n.dot(p0);
		if (n.dot(centre) > d) {
			n = n.neg();
			d = -d;
		}
		planes.push({n, d});
		loops.push([p0, p1, p2]);
	}
	if (planes.length === 0)
		return undefined;

	let size = 0;
	for (const p of points)
		size = Math.max(size, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
	const eps = size * 1e-6;
	return {planes, faces: loops, convex: points.every(p => planes.every(pl => pl.n.dot(p) - pl.d <= eps))};
}

// A solid given by its corners and faces (a polyhedron(), an import()ed mesh): its half-spaces when it is convex and has
// few enough faces to unroll in the shader (testing that is corners times faces), and its triangles otherwise.
const PLANES_MAX = 256;

function solidOf(points: float3[], faces: number[][], ctx: Ctx): Sdf {
	const shape = faces.length <= PLANES_MAX ? facePlanes(points, faces) : undefined;
	if (shape?.convex)
		return {k: 'planes', planes: shape.planes, points, faces: shape.faces};
	return warnOpen(trimesh(points, faces) ?? empty, ctx);
}

function warnOpen(solid: Sdf, ctx: Ctx) {
	if (solid.k === 'trimesh' && !solid.closed)
		ctx.warn('a mesh that is not closed (an edge not shared by exactly two faces, or faces wound differently), so which side of it is inside is a guess near its gaps');
	return solid;
}

//-----------------------------------------------------------------------------
// a Minkowski operand, from the expression it is written as
//-----------------------------------------------------------------------------
// Maximum singular value (largest scale) of a 3x3 matrix
export function maxSingularValue(m: float3x3): number {
	const mT = m.transpose();
	let v = float3(1, 1, 1);
	for (let i = 0; i < 12; i++) {
		const w = m.mul(mT.mul(v)), len = w.len() || 1;
		v = w.scale(1 / len);
	}
	const wv = m.mul(mT.mul(v));
	return Math.sqrt(Math.max(0, v.dot(wv)));
}

// The support function of the operand, which is what growing by it means. A sphere under translate/rotate/scale
// reaches r*|A n| + t.n, where A is its linear part, so the operand is read structurally: nothing is built and
// then inspected to find out what shape it was -- which matters for more than efficiency, since a zero-scale
// flat brush (scale([1,1,0]) sphere(r), the "flat disc on a cube" pattern below) is only ever valid *as* a
// minkowski operand: built as an ordinary shape it is empty (see 'scale' above), so reading it off a built Sdf
// instead of the AST would lose it. undefined when the operand is not a sphere.
function supportOf(inst: Inst, env: Env, frame: Frame, ctx: Ctx, depth = 0, own: float3x4 = float3x4.identity()): (Support & {shift: float3}) | undefined {
	if (depth > 16)
		return undefined;

	const name	= inst.modname ?? '';
	const scope	= inst.scope;
	const only	= () => scope.moduleInstantiations[0];
	const values = argGetter(inst.args ?? [], env, ctx);

	switch (name) {
		case 'translate': {
			const v = values.vec3('v', 0);
			return v ? supportOf(only(), env, frame, ctx, depth + 1, own.mulAffine(float3.translate(v))) : undefined;
		}
		case 'rotate': {
			const first = values.get('a', 0);
			const m = typeof first === 'number'
				? rotationAxis(num(first, ctx, 'rotate()') ?? 0, values.vec3('v', 1) ?? float3(0, 0, 1))
				: rotation(vec3(first, ctx, 'rotate()') ?? float3(0, 0, 0));
			return supportOf(only(), env, frame, ctx, depth + 1, own.mulAffine(m));
		}
		case 'scale': {
			const v = values.vec3('v', 0) ?? float3(1, 1, 1);
			return supportOf(only(), env, frame, ctx, depth + 1, own.mulAffine(scaling(v)));
		}
		case 'sphere': {
			const d = values.num('d', 2);
			const r = d !== undefined ? d / 2 : values.num('r', 0) ?? 1;
			// the operand's own transform is what it is displaced and stretched by; the frame it happens to sit in
			// is not part of its support, or the shape it is summed with would be moved by it a second time
			const world = linear(frame.m.mulAffine(own));
			const q		= world.matmul(world.transpose());
			// The operand's own displacement, in the directions of the frame but without the frame's own origin:
			// the body it is summed with was placed by the same frame, so only what the operand moved by itself
			// separates them. This is what the body is shifted by; the support itself stays centred.
			const shift = frame.m.mulDir(own.w);
			const round = isConformal(world);		// A*Aᵗ is a multiple of the identity exactly when A only turns and scales evenly

			// a round operand is a ball whatever the direction, so its scale goes into the radius; otherwise q carries it
			return {
				r: round ? r * world.x.len() : r,
				q: round ? null : q,
				shift,
				bound: r * maxSingularValue(world) + shift.len(),
			};
		}
	}
	return undefined;
}

// The plural form: also sees through a union() or a for loop of spheres (Minkowski distributes over union,
// body ⊕ (S1 ∪ S2) = (body⊕S1) ∪ (body⊕S2), so every term is returned separately rather than combined into one
// support the way sibling minkowski operands -- separate terms of the *same* sum -- are; see the 'minkowski'
// case). Still structural, like supportOf, and for the same reason: a for loop's own body is only ever entered
// with the real per-iteration env, never built as a shape to inspect afterwards.
function supportsOf(inst: Inst, env: Env, frame: Frame, ctx: Ctx): (Support & {shift: float3})[] | undefined {
	const name = inst.modname ?? '';
	if (name === 'union' || name === 'group') {
		const out: (Support & {shift: float3})[] = [];
		for (const child of inst.scope.moduleInstantiations) {
			const v = supportsOf(child, env, frame, ctx);
			if (!v)
				return undefined;
			out.push(...v);
		}
		return out;
	}
	if (name === 'for') {
		const args = inst.args ?? [];
		if (args.length === 0)
			return [];
		const out: (Support & {shift: float3})[] = [];
		let ok = true;
		const recurse = (i: number, inner: Env) => {
			if (!ok)
				return;
			if (i >= args.length) {
				for (const child of inst.scope.moduleInstantiations) {
					const v = supportsOf(child, inner, frame, ctx);
					if (!v) { ok = false; return; }
					out.push(...v);
				}
				return;
			}
			const loop = args[i];
			const range = inner.evalExpr(loop.expr, ctx);
			for (const value of isList(range) ? range : [range]) {
				const next = new Env(inner);
				if (loop.name)
					next.values.set(loop.name, value);
				recurse(i + 1, next);
				if (!ok)
					return;
			}
		};
		recurse(0, env);
		return ok ? out : undefined;
	}
	const s = supportOf(inst, env, frame, ctx);
	return s ? [s] : undefined;
}

// The 2-D form of supportsOfSdf: a smooth circle, possibly transformed or unioned the same way. offset()'s field
// has no direction-dependent term the way dilate's q does -- there is no anisotropic offset -- so a circle stood
// on its side by a transform that is not a 2-D-plane-preserving similarity (an ellipse, not a circle any more) is
// correctly not one, and comes back undefined.
function circleSupportsOfSdf(s: Sdf, frame: Frame, own: float3x4 = float3x4.identity()): {r: number, shift: float2}[] | undefined {
	switch (s.k) {
		case 'material':
			return circleSupportsOfSdf(s.body, frame, own);
		case 'union': {
			const out: {r: number, shift: float2}[] = [];
			for (const c of s.children) {
				const v = circleSupportsOfSdf(c, frame, own);
				if (!v)
					return undefined;
				out.push(...v);
			}
			return out;
		}
		case 'domain':
			return circleSupportsOfSdf(s.body, frame, own.mulAffine(s.m));
		case 'circle2': {
			if (s.n)
				return undefined;			// an n-gon is not a disk: it has no single radius to grow by
			const world = frame.m.mulAffine(own);
			// only a similarity of the xy plane keeps a circle a circle: no z mixed into x/y or x/y into z, and an
			// even scale, exactly the conditions place() itself uses to keep a 2-D shape's own vertices exact
			if (Math.hypot(world.x.z, world.y.z, world.z.x, world.z.y) > 1e-9 || !isConformal(world))
				return undefined;
			const shiftW = frame.m.mulDir(own.w);
			return [{r: s.r * world.x.len(), shift: float2(shiftW.x, shiftW.y)}];
		}
		default:
			return undefined;
	}
}

//-----------------------------------------------------------------------------
// expressions
//-----------------------------------------------------------------------------

function numerical(args: Assignment[], env: Env, ctx: Ctx, fn: (...a: number[]) => number, what: string) {
	const numbers = args.map(a => num(env.evalExpr(a.expr, ctx), ctx, what));
	if (numbers.some(n => n === undefined))
		return undefined;
	return fn(...(numbers as number[]));
}

// rands() with no seed goes on from wherever the last call left the generator, as OpenSCAD's one shared engine does;
// with a seed it starts again from that seed, so a seeded call always gives the same numbers
let sharedRng: MT19937 | undefined;

const builtins: Record<string, (args: Assignment[], env: Env, ctx: Ctx) => Value> = {
	rands:		(args, env, ctx) => {
		const a = args.map(x => env.evalExpr(x.expr, ctx));
		if (a.length < 3 || a.length > 4 || a.some(v => typeof v !== 'number')) {
			ctx.warn('rands() takes (min, max, count) or (min, max, count, seed), all numbers');
			return undefined;
		}
		let [min, max] = a as number[];
		const huge = Number.MAX_VALUE / 2;
		if (!Number.isFinite(min)) { ctx.warn('rands() range min cannot be infinite'); min = -huge; }
		if (!Number.isFinite(max)) { ctx.warn('rands() range max cannot be infinite'); max = huge; }
		if (max < min)
			[min, max] = [max, min];
		const wanted = Math.abs(a[2] as number);
		if (!Number.isFinite(wanted)) {
			ctx.warn('rands() cannot create an infinite number of results');
			return [];
		}
		const count = Math.min(Math.floor(wanted), 10_000_000);
		if (a.length === 4)
			sharedRng = new MT19937(seedOf(a[3] as number));
		sharedRng ??= new MT19937((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
		const rng = sharedRng;
		return Array.from({length: count}, () => min >= max ? min : rng.uniform(min, max));
	},
	len:		(args, env, ctx) => {
		const v = env.evalExpr(args[0].expr, ctx);
		return isList(v) ? v.length : num(v, ctx, 'len');
	},
	concat:		(args, env, ctx) => {
		const out: Value[] = [];
		for (const a of args) {
			const v = env.evalExpr(a.expr, ctx);
			if (isList(v))
				out.push(...v);
			else if (v !== undefined)
				out.push(v);
		}
		return out;
	},
	// a string is used as it is; anything else (a number, a vector, which quotes the strings inside it) is shown as echo shows it
	str:		(args, env, ctx) => args.map(a => { const v = env.evalExpr(a.expr, ctx); return typeof v === 'string' ? v : show(v); }).join(''),
	norm:	(args, env, ctx) => {
		const v = vec3(env.evalExpr(args[0]?.expr, ctx), ctx, 'norm()');
		return v ? v.len() : undefined;
	},
	dot:		(args, env, ctx) => {
		const a = vec3(env.evalExpr(args[0]?.expr, ctx), ctx, 'dot()');
		const b = vec3(env.evalExpr(args[1]?.expr, ctx), ctx, 'dot()');
		return a && b ? a.dot(b) : undefined;
	},
	dxf_dim:	(args, env, ctx) => dxfDim(argGetter(args, env, ctx)),
	dxf_cross:	(args, env, ctx) => dxfCross(argGetter(args, env, ctx)),
	cross:		(args, env, ctx) => {
		const x = env.evalExpr(args[0]?.expr, ctx), y = env.evalExpr(args[1]?.expr, ctx);
		// two 2-D vectors give their cross product's z alone, a number, as OpenSCAD's own cross() does -- the
		// signed area the shoelace formula sums
		if (isList(x) && isList(y) && x.length === 2 && y.length === 2) {
			const [ax, ay, bx, by] = [x[0], x[1], y[0], y[1]].map(v => num(v, ctx, 'cross'));
			return ax === undefined || ay === undefined || bx === undefined || by === undefined ? undefined : ax * by - ay * bx;
		}
		const a = vec3(x, ctx, 'cross');
		const b = vec3(y, ctx, 'cross');
		if (!a || !b)
			return undefined;
		const c = a.cross(b);
		return [c.x, c.y, c.z];
	},
	is_undef:	(args, env, ctx) => env.evalExpr(args[0]?.expr, ctx) === undefined,
	is_num:		(args, env, ctx) => typeof env.evalExpr(args[0]?.expr, ctx) === 'number',
	is_bool:	(args, env, ctx) => typeof env.evalExpr(args[0]?.expr, ctx) === 'boolean',
	is_string:	(args, env, ctx) => typeof env.evalExpr(args[0]?.expr, ctx) === 'string',
	is_list:	(args, env, ctx) => isList(env.evalExpr(args[0]?.expr, ctx)),

	sqrt:		(args, env, ctx) => numerical(args, env, ctx, Math.sqrt, 'sqrt'),
	abs:		(args, env, ctx) => numerical(args, env, ctx, Math.abs, 'abs'),
	sign:		(args, env, ctx) => numerical(args, env, ctx, Math.sign, 'sign'),
	floor:		(args, env, ctx) => numerical(args, env, ctx, Math.floor, 'floor'),
	ceil:		(args, env, ctx) => numerical(args, env, ctx, Math.ceil, 'ceil'),
	// halves round away from zero, as C's round() (and so OpenSCAD's) does, where Math.round takes -2.5 to -2
	round:		(args, env, ctx) => numerical(args, env, ctx, a => Math.sign(a) * Math.round(Math.abs(a)), 'round'),
	exp:		(args, env, ctx) => numerical(args, env, ctx, Math.exp, 'exp'),
	ln:			(args, env, ctx) => numerical(args, env, ctx, Math.log, 'log'),
	log:		(args, env, ctx) => numerical(args, env, ctx, Math.log, 'log'),
	// OpenSCAD's trig functions are all in degrees: the three forward ones take degrees in, the four inverse ones
	// give degrees out -- Math's are all radians, so the conversion belongs here at the boundary, not left to
	// whichever caller remembers it.
	sin:		(args, env, ctx) => numerical(args, env, ctx, a => Math.sin(rad(a)), 'sin'),
	cos:		(args, env, ctx) => numerical(args, env, ctx, a => Math.cos(rad(a)), 'cos'),
	tan:		(args, env, ctx) => numerical(args, env, ctx, a => Math.tan(rad(a)), 'tan'),
	asin:		(args, env, ctx) => numerical(args, env, ctx, a => deg(Math.asin(a)), 'asin'),
	acos:		(args, env, ctx) => numerical(args, env, ctx, a => deg(Math.acos(a)), 'acos'),
	atan:		(args, env, ctx) => numerical(args, env, ctx, a => deg(Math.atan(a)), 'atan'),
	atan2:		(args, env, ctx) => numerical(args, env, ctx, (y, x) => deg(Math.atan2(y, x)), 'atan2'),
	pow:		(args, env, ctx) => numerical(args, env, ctx, Math.pow, 'pow'),
	min:		(args, env, ctx) => numerical(args, env, ctx, Math.min, 'min'),
	max:		(args, env, ctx) => numerical(args, env, ctx, Math.max, 'max'),

	// parent_module(0) is the immediate caller, so it sits one below the top of the stack -- the top is this call
	// itself, pushed by instantiate() before the body (and so this function call) runs. Indexing past either end
	// of the stack is a plain out-of-range array read, which JS already gives back as undefined.
	parent_module: (args, env, ctx) => {
		const n = num(env.evalExpr(args[0]?.expr, ctx), ctx, 'parent_module()');
		return n === undefined ? undefined : ctx.moduleStack[ctx.moduleStack.length - 2 - Math.floor(n)];
	},
};

// A vector literal's items are not all plain expressions: `for`, `if` and `each` inside `[...]` each contribute zero
// or more values instead of exactly one, and OpenSCAD lets them sit alongside ordinary items (`[1, for (i=...) i, 2]`
// is one vector, not three). This pushes whatever `expr` contributes onto `out`, recursing for the constructs that
// nest -- a `for` inside a `for`, an `if` inside a `for`'s body -- and falling back to a single evalExpr() for
// anything else, which is what an ordinary item is.
function pushComprehension(expr: Expr, env: Env, ctx: Ctx, out: Value[]): void {
	const LIMIT = 100000;
	switch (expr.type) {
		case 'lcfor': {
			// multiple ranges nest, exactly as the module-instantiation `for` statement's do (see case 'for' below):
			// `for (i = a, j = b)` is `for (i = a) for (j = b)`, and a later range may read an earlier variable
			const recurse = (i: number, inner: Env) => {
				if (out.length >= LIMIT)
					return;
				if (i >= expr.args.length) {
					pushComprehension(expr.expr, inner, ctx, out);
					return;
				}
				const loop = expr.args[i];
				const range = inner.evalExpr(loop.expr, ctx);
				for (const value of isList(range) ? range : [range]) {
					if (out.length >= LIMIT)
						return;
					const next = new Env(inner);
					if (loop.name)
						next.values.set(loop.name, value);
					recurse(i + 1, next);
				}
			};
			recurse(0, env);
			return;
		}
		case 'lcforc': {
			// the C-style form: init once, then test/body/step -- the loop variables are mutated in place (the step
			// reads the value the body saw), not rebound each turn, which is what lets `i = i + 1` mean what it says
			const inner = new Env(env);
			for (const a of expr.args)
				if (a.name)
					inner.values.set(a.name, inner.evalExpr(a.expr, ctx));
			let n = 0;
			while (truthy(inner.evalExpr(expr.cond, ctx)) && n++ < LIMIT && out.length < LIMIT) {
				pushComprehension(expr.expr, inner, ctx, out);
				for (const a of expr.incrargs)
					if (a.name)
						inner.values.set(a.name, inner.evalExpr(a.expr, ctx));
			}
			return;
		}
		case 'lcif':
			if (truthy(env.evalExpr(expr.cond, ctx)))
				pushComprehension(expr.ifexpr, env, ctx, out);
			else if (expr.elseexpr !== undefined)
				pushComprehension(expr.elseexpr, env, ctx, out);
			return;
		case 'lceach': {
			// `each` splices a list in rather than nesting it one level deeper; a non-list value is just added, as
			// OpenSCAD's own `each` does for one that turns out not to be a list
			const v = env.evalExpr(expr.expr, ctx);
			if (isList(v))
				out.push(...v);
			else if (v !== undefined)
				out.push(v);
			return;
		}
		case 'lcletp': {
			const inner = new Env(env);
			for (const a of expr.args)
				if (a.name)
					inner.values.set(a.name, env.evalExpr(a.expr, ctx));
			pushComprehension(expr.expr, inner, ctx, out);
			return;
		}
		case 'let': {
			// the parser gives a comprehension's own `let` (`[let (n = 3) for (i = [0:n]) i]`, or one between a `for`
			// and its `if`) as the ordinary let expression, so its body may be a for/if/each that has to be expanded
			// here rather than handed to evalExpr() -- bound sequentially, as the expression form is
			const inner = new Env(env);
			bindArguments(expr.arguments, inner, ctx);
			pushComprehension(expr.expr, inner, ctx, out);
			return;
		}
		default:
			out.push(env.evalExpr(expr, ctx));
	}
}

function binary(op: string, l: Value, r: Value, ctx: Ctx): Value {
	switch (op) {
		case '==': return eq(l, r);
		case '!=': return !eq(l, r);
		case '<': case '>': case '<=': case '>=': {
			const a = num(l, ctx, `the left of '${op}'`), b = num(r, ctx, `the right of '${op}'`);
			if (a === undefined || b === undefined)
				return undefined;
			return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
		}
		// + and - between vectors are componentwise, not concat() -- OpenSCAD has no vector meaning for `+` beyond
		// that. Recursing per component, rather than requiring the elements be numbers, is what makes this the same
		// operation for a matrix (a vector of vectors) with no separate case.
		case '+': case '-': {
			if (isList(l) || isList(r)) {
				if (!isList(l) || !isList(r) || l.length !== r.length) {
					ctx.warn(`'${op}' between mismatched vectors`);
					return undefined;
				}
				return l.map((lv, i) => binary(op, lv, r[i], ctx));
			}
			const a = num(l, ctx, `the left of '${op}'`), b = num(r, ctx, `the right of '${op}'`);
			return a === undefined || b === undefined ? undefined : op === '+' ? a + b : a - b;
		}
		// a number times a vector (either side) scales it componentwise; two lists is linear-algebra `*` -- a dot
		// product, a matrix against a vector, or two matrices -- so `*` is the one operator whose vector form is
		// not just "do it componentwise"
		case '*': {
			if (isList(l) && isList(r))
				return matMul(l, r, ctx);
			if (isList(l) || isList(r)) {
				const vec = (isList(l) ? l : r) as Value[];
				const scalar = num(isList(l) ? r : l, ctx, "the scalar side of '*'");
				return scalar === undefined ? undefined : vec.map(v => binary('*', v, scalar, ctx));
			}
			break;
		}
		// a vector divides only by a number, componentwise; a number divided by a vector is not defined
		case '/': {
			if (isList(l)) {
				const scalar = num(r, ctx, "the right of '/'");
				return scalar === undefined ? undefined : l.map(v => binary('/', v, scalar, ctx));
			}
			if (isList(r)) {
				ctx.warn("a number divided by a vector");
				return undefined;
			}
			break;
		}
	}
	const a = num(l, ctx, `the left of '${op}'`), b = num(r, ctx, `the right of '${op}'`);
	if (a === undefined || b === undefined)
		return undefined;
	switch (op) {
		case '*': return a * b;
		case '/': return a / b;
		case '%': return a % b;
		case '^': return Math.pow(a, b);
		case '&': return a & b;
		case '|': return a | b;
		case '<<': return a << b;
		case '>>': return a >> b;
		default:
			ctx.warn(`the operator '${op}'`);
			return undefined;
	}
}

// A "matrix" here is a list of equal-length rows; a plain vector stands in for a single row on the left or a single
// column on the right, which is what turns OpenSCAD's four shapes of `*` -- vector.vector, matrix*vector,
// vector*matrix, matrix*matrix -- into one rule: rows of the left against columns of the right. Which sides were
// plain vectors decides how much of the result to unwrap afterwards: both collapses to a scalar (a dot product),
// either one collapses that side's dimension of the result down to a flat vector, and neither leaves a matrix.
function matMul(l: Value[], r: Value[], ctx: Ctx): Value {
	const row = (v: Value, what: string): number[] | undefined => {
		if (!isList(v) || v.some(isList)) {
			ctx.warn(`'*': ${what} is not a row of numbers`);
			return undefined;
		}
		const out = v.map(x => num(x, ctx, "an element of '*'"));
		return out.some(x => x === undefined) ? undefined : out as number[];
	};
	const asRows = (v: Value[], isMatrix: boolean, side: string): number[][] | undefined => {
		const rows = isMatrix ? v.map((x, i) => row(x, `row ${i} of the ${side} of '*'`)) : [row(v, `the ${side} of '*'`)];
		if (rows.some(a => !a))
			return undefined;
		if (!rows.every(a => a!.length === rows[0]!.length)) {
			ctx.warn(`'*' with a matrix on the ${side} whose rows are not all the same length`);
			return undefined;
		}
		return rows as number[][];
	};

	const lIsMatrix = l.some(isList), rIsMatrix = r.some(isList);
	const lRows = asRows(l, lIsMatrix, 'left');
	const rRows = asRows(r, rIsMatrix, 'right');
	if (!lRows || !rRows)
		return undefined;

	// r's columns: its rows transposed if it is a matrix, or its one row read as the one column if it is a vector
	const cols: number[][] = rIsMatrix
		? Array.from({length: rRows[0].length}, (_, j) => rRows.map(rr => rr[j]))
		: [rRows[0]];

	if (lRows[0].length !== cols[0].length) {
		ctx.warn("'*' between a matrix/vector and one of the wrong size");
		return undefined;
	}
	const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
	const out = lRows.map(lr => cols.map(c => dot(lr, c)));

	if (!lIsMatrix && !rIsMatrix) return out[0][0];	// vector . vector: a scalar
	if (!lIsMatrix) return out[0];						// vector * matrix: one row
	if (!rIsMatrix) return out.map(orow => orow[0]);	// matrix * vector: one column, flattened
	return out;											// matrix * matrix
}

function eq(l: Value, r: Value): boolean {
	if (isList(l) && isList(r))
		return l.length === r.length && l.every((v, i) => eq(v, r[i]));
	return l === r;
}

//-----------------------------------------------------------------------------
// Env
// A module body's variables, and the modules and functions visible in it. Definitions are hoisted: a module can
// call one defined later in the same scope, as OpenSCAD allows.
//-----------------------------------------------------------------------------

class Env {
	values = new Map<string, Value>();
	// A scope's own assignments, registered up front by evalScope() but not yet evaluated: OpenSCAD's variables are
	// not sequentially scoped the way a JS block's are, so a module instantiation earlier in the same scope than a
	// variable's assignment still sees its value, and two assignments to the same name in one scope resolve to
	// whichever is textually last, regardless of where any use of the name appears. Resolving lazily on first use
	// (via get()/has(), memoized into `values`) is what gives both of those without evaluating a scope's assignments
	// in some order other than the one that would come from just asking for each name as it's needed.
	pending = new Map<string, Expr | undefined>();
	modules = new Map<string, UserModule>();
	functions = new Map<string, NonNullable<ReturnType<Scope['functions']['get']>>>();

	constructor(public parent?: Env) {}

	// Deleting from `pending` before evaluating (rather than after) is what keeps a self-referential assignment
	// (x = x + 1, or two names that refer to each other) from recursing forever: the inner lookup no longer finds
	// the name pending -- it isn't resolved yet either -- so it falls out as an honest "used before it is assigned"
	// rather than a stack overflow, the same outcome a genuinely-absent name gets.
	private resolvePending(name: string, ctx: Ctx): Value {
		const expr = this.pending.get(name);
		this.pending.delete(name);
		const value = this.evalExpr(expr, ctx);
		this.values.set(name, value);
		return value;
	}
	get(name: string, ctx: Ctx): Value {
		for (let e: Env | undefined = this; e; e = e.parent) {
			if (e.values.has(name))
				return e.values.get(name);
			if (e.pending.has(name))
				return e.resolvePending(name, ctx);
		}
		return undefined;
	}
	has(name: string): boolean {
		for (let e: Env | undefined = this; e; e = e.parent)
			if (e.values.has(name) || e.pending.has(name))
				return true;
		return false;
	}
	findModule(name: string): UserModule | undefined {
		for (let e: Env | undefined = this; e; e = e.parent) {
			const m = e.modules.get(name);
			if (m)
				return m;
		}
	}
	findFunction(name: string) {
		for (let e: Env | undefined = this; e; e = e.parent) {
			const f = e.functions.get(name);
			if (f)
				return f;
		}
	}

	// The four that recurse through a scope as it is entered -- an expression, a function call, a block of
	// statements, a module instantiation -- are methods rather than free functions taking `env` as their first
	// argument, because `env` is the one thing among their parameters that is genuinely new at nearly every
	// recursive step (a child scope, a call's own parameters, a for loop's variable), so `newEnv.evalXxx(...)` says
	// "evaluate this in a new/different scope" more directly than `evalXxx(x, newEnv, ctx)` did. `ctx` (ambient,
	// never varies across a whole evaluate() call) and the helpers whose real subject is something else -- an
	// argument list, an SDF shape -- stay free functions, taking `env` as an ordinary parameter as before.
	evalExpr(expr: Expr | undefined, ctx: Ctx): Value {
		const env = this;
		if (expr === undefined || expr === null)
			return undefined;
		switch (expr.type) {
			case 'literal':
				return expr.value;// as Value;

			case 'identifier': {
				const name = expr.name;
				if (!env.has(name) && !name.startsWith('$'))
					ctx.warn(`'${name}' is used before it is assigned`);
				return env.get(name, ctx);
			}

			case 'vector': {
				const out: Value[] = [];
				for (const x of expr.value)
					pushComprehension(x, env, ctx, out);
				return out;
			}

			case 'range': {
				const begin = num(env.evalExpr(expr.begin, ctx), ctx, 'a range bound') ?? 0;
				const end	= num(env.evalExpr(expr.end, ctx), ctx, 'a range bound') ?? 0;
				const step	= expr.step === undefined ? 1 : num(env.evalExpr(expr.step, ctx), ctx, 'a range step') ?? 1;
				const out: Value[] = [];
				if (step === 0)
					return out;
				for (let v = begin; step > 0 ? v <= end + 1e-9 : v >= end - 1e-9; v += step) {
					if (out.length > 100000)
						break;
					out.push(v);
				}
				return out;
			}

			case 'unary': {
				const v = env.evalExpr(expr.operand, ctx);
				if (expr.operator === '!')
					return !truthy(v);
				// a vector negates componentwise, recursing so a matrix does too
				if (isList(v) && expr.operator !== '~')
					return expr.operator === '-' ? binary('*', v, -1, ctx) : v;
				const n = num(v, ctx, `the operand of '${expr.operator}'`);
				if (n === undefined)
					return undefined;
				return expr.operator === '-' ? -n : expr.operator === '+' ? n : ~n;
			}

			case 'binary': {
				const left = env.evalExpr(expr.left, ctx);
				if (expr.operator === '&&')
					return truthy(left) && truthy(env.evalExpr(expr.right, ctx));
				if (expr.operator === '||')
					return truthy(left) || truthy(env.evalExpr(expr.right, ctx));
				return binary(expr.operator, left, env.evalExpr(expr.right, ctx), ctx);
			}

			case 'conditional':
				return truthy(env.evalExpr(expr.test, ctx)) ? env.evalExpr(expr.consequent, ctx) : env.evalExpr(expr.alternate, ctx);

			case 'let': {
				const inner = new Env(env);
				bindArguments(expr.arguments, inner, ctx);
				return inner.evalExpr(expr.expr, ctx);
			}

			case 'echo': case 'assert': {
				const values = (expr.arguments ?? []).map(x => env.evalExpr(x.expr, ctx));
				if (expr.type === 'echo')
					console.log('ECHO:', values.map(show).join(' '));
				return expr.expr === undefined ? undefined : env.evalExpr(expr.expr, ctx);
			}

			case 'arraylookup': {
				const array = env.evalExpr(expr.array, ctx), index = env.evalExpr(expr.index, ctx);
				if (!isList(array))
					return undefined;
				const i = num(index, ctx, 'an index');
				return i === undefined ? undefined : array[i < 0 ? array.length + i : i];
			}

			case 'call': {
				const name = expr.callee.type === 'identifier' ? expr.callee.name : undefined;
				if (name !== undefined)
					return env.callFunction(name, expr.arguments ?? [], ctx);
				ctx.warn('a call to something other than a named function');
				return undefined;
			}

			case 'functioncall':
				return env.callFunction(expr.name, expr.arguments ?? [], ctx);

			case 'memberlookup':
				ctx.warn('a member lookup');
				return undefined;

			default:
				ctx.warn(`'${(expr as {type: string}).type}' is not evaluated`);
				return undefined;
		}
	}

	callFunction(name: string, args: Assignment[], ctx: Ctx): Value {
		const user = this.findFunction(name);
		if (user) {
			const call = new Env(this);
			let pi = 0;
			const pos = positional(args);
			for (const p of user.parameters) {
				const named = args.find(a => a.name === p.name);
				call.values.set(p.name, named ? this.evalExpr(named.expr, ctx)
					: pi < pos.length ? this.evalExpr(pos[pi++].expr, ctx)
					: p.expr ? call.evalExpr(p.expr, ctx) : undefined);
			}
			return call.evalExpr(user.expr, ctx);
		}
		const builtin = builtins[name];
		if (builtin)
			return builtin(args, this, ctx);
		ctx.warn(`the function '${name}'`);
		return undefined;
	}

	evalScope(scope: Scope, frame: Frame, ctx: Ctx): Sdf {
		const out = this.evalScopeList(scope, frame, ctx);
		return out.length === 0 ? empty : out.length === 1 ? out[0] : {k: 'union', children: out};
	}

	// A scope's modules and functions, and its ordinary assignments (registered lazily), made visible; returns its
	// statements in the order written.
	declare(scope: Scope): Statement[] {
		const env = this;
		for (const [name, mod] of scope.modules)
			env.modules.set(name, mod);
		for (const [name, fn] of scope.functions)
			env.functions.set(name, fn);

		const stmts = statements(scope);
		// An ordinary variable resolves to its last assignment in the scope regardless of where a use appears
		// relative to it -- OpenSCAD's variables are not sequentially scoped the way a JS block's are -- so every
		// non-$ name is registered here and evaluated lazily on first use (Env.get/resolvePending), letting a module
		// instantiation earlier in the scope than the assignment it reads still see it, and two assignments to the
		// same name resolve to whichever is textually last. $-prefixed variables are the one exception: OpenSCAD
		// gives them genuinely sequential effect (a $fn assigned partway through a module body changes what the
		// geometry after it sees, not the geometry before), so those are still set inline, in file order, below.
		for (const s of stmts)
			if (!s.inst && !s.name!.startsWith('$'))
				env.pending.set(s.name!, s.expr);
		return stmts;
	}

	// evalScope's own statement list, before it is combined into the one shape a scope normally means. Split out
	// so a for loop or an if/else can hand its statements up to whatever contains *them* as separate siblings
	// (see instantiateList) instead of pre-combining into a union no matter what that container is -- the same
	// list this union-wraps when a scope is asked for as one shape on its own.
	evalScopeList(scope: Scope, frame: Frame, ctx: Ctx): Sdf[] {
		const env = this;
		const stmts = env.declare(scope);

		const out: Sdf[] = [];
		for (const s of stmts) {
			if (!s.inst) {
				if (s.name!.startsWith('$'))
					env.values.set(s.name!, env.evalExpr(s.expr, ctx));
				continue;
			}
			// `$` variables are read after the statement, so an assignment above it is in force and one below it is
			// not: how OpenSCAD sequences a module body. A scope that sets none adds no node at all. Each piece a
			// for/if statement splices in gets the same wrap, since they all see the same ambient material.
			const mat = ambientMaterial(env, ctx);
			for (const body of env.instantiateList(s.inst, frame, ctx))
				out.push(body.k === 'material' || sameMaterial(mat, DEFAULT_MATERIAL) ? body : {k: 'material' as const, mat, body});
		}
		return out;
	}

	// The shapes one instantiation amounts to -- almost always one, from instantiate() itself, but a for loop's
	// iterations or an if/else's taken branch are not a shape of their own: each is a splice of whatever it
	// contains into the scope around it, the same as if it had been written out by hand there (see intersection()'s
	// own case for why this matters: `intersection() { a; for (...) b; }` must intersect with each iteration of b
	// in turn, not with one union of all of them, which is what instantiate() alone would build). An explicit
	// union()/group() is not this: it is deliberately one combined operand, so it is left to the ordinary path.
	instantiateList(inst: Inst, frame: Frame, ctx: Ctx): Sdf[] {
		const env = this;
		if (inst instanceof IfElseModuleInstantiation) {
			const taken = truthy(env.evalExpr(inst.expr, ctx)) ? inst.scope : inst.else_scope;
			return taken ? new Env(env).evalScopeList(taken, frame, ctx) : [];
		}
		if (inst.modname === 'for') {
			const out: Sdf[] = [];
			forEachIteration(inst.args ?? [], env, ctx, inner => out.push(...inner.evalScopeList(inst.scope, frame, ctx)));
			return out;
		}
		return [env.instantiate(inst, frame, ctx)];
	}

	instantiate(inst: Inst, frame: Frame, ctx: Ctx): Sdf {
		const env = this;
		// if / else: only the branch taken is built, so a dead branch cannot fail on what it mentions
		if (inst instanceof IfElseModuleInstantiation) {
			const taken = truthy(env.evalExpr(inst.expr, ctx)) ? inst.scope : inst.else_scope;
			return taken ? new Env(env).evalScope(taken, frame, ctx) : empty;
		}

		const name	= inst.modname ?? '';
		const scope	= inst.scope;
		const args	= argGetter(inst.args ?? [], env, ctx);

		// a module the file defines itself
		const user = env.findModule(name);
		if (user) {
			const call	= new Env(env);
			const p		= args.positional;
			let pi = 0;
			for (const param of user.parameters)
				call.values.set(param.name, args.get(param.name) ?? (pi < p.length ? env.evalExpr(p[pi++].expr, ctx) : param.expr ? call.evalExpr(param.expr, ctx) : undefined));

			// $children is the count children() sees for *this* call -- set directly on the call's own env, the
			// same as a parameter, so it is visible throughout the body without going through the identifier lookup
			// that would otherwise treat a name starting with $ as silently optional and never assigned
			call.values.set('$children', scope.moduleInstantiations.length);
			// $parent_modules is how many of these are already open above this one; parent_module() reads the
			// stack itself, so it is pushed only once the count for *this* call has been taken
			call.values.set('$parent_modules', ctx.moduleStack.length);
			ctx.children.push({scope, env});
			ctx.moduleStack.push(name);
			const body = call.evalScope(user.body, frame, ctx);
			ctx.moduleStack.pop();
			ctx.children.pop();
			return body;
		}

		const child = () => new Env(env).evalScope(scope, frame, ctx);
		const transformed = (m: float3x4, scale: number) => new Env(env).evalScope(scope, {m: frame.m.mulAffine(m), scale: frame.scale * scale}, ctx);

		switch (name) {
			case 'color': {
				const children = childrenOf(scope, env, frame, ctx);
				const body = children.length === 0 ? empty : children.length === 1 ? children[0] : {k: 'union' as const, children};
				const mat = materialOf(args);
				// a color() that changes nothing is not a node: the common case stays exactly as it was
				return mat && !sameMaterial(mat, ambientMaterial(env, ctx)) ? {k: 'material' as const, mat, body} : body;
			}

			case 'circle': {
				const d		= args.num('d', 2);
				const r		= d !== undefined ? d / 2 : args.num('r', 0) ?? 1;
				const fn	= num(args.special('$fn'), ctx, '$fn') ?? 0;
				return place(frame, {k: 'circle2', r, n: fn >= 3 ? Math.max(3, Math.round(fn)) : 0});
			}

			case 'square': {
				const v = args.get('size', 0);
				let size: float2;
				if (typeof v === 'number')
					size = float2(v, v);
				else if (isList(v) && v.length >= 2)
					size = float2(num(v[0], ctx, "square()'s x") ?? 0, num(v[1], ctx, "square()'s y") ?? 0);
				else if (isList(v) && v.length === 1) {
					ctx.warn('a square() with one size, taken as a square of it');
					size = float2(num(v[0], ctx, "square()'s size") ?? 0, num(v[0], ctx, "square()'s size") ?? 0);
				} else {
					ctx.warn('a square() whose size is neither a number nor a vector, so 1 x 1 is used');
					size = float2(1, 1);
				}
				return place(frame, {k: 'square2', size, center: args.bool('center', 1) ?? false});
			}

			case 'polygon': {
				// points= is the shared vertex pool; paths= is a list of loops of indices into it (a hole is just
				// another loop -- the even-odd fill in polygonDistance2 is what makes it read as a hole rather than
				// an extra island). Omitting paths= means one loop, the points in the order given.
				const points: float2[] = [];
				const v = args.get('points', 0);
				if (isList(v))
					for (const p of v) {
						const q = vec2(p, ctx);
						if (!q)
							break;
						points.push(q);
					}
				if (points.length < 3) {
					ctx.warn('a polygon() with fewer than three readable points, so nothing is drawn');
					return empty;
				}
				const pathsArg = args.get('paths', 1);
				let paths: float2[][];
				if (isList(pathsArg) && pathsArg.length > 0) {
					paths = [];
					for (const path of pathsArg) {
						if (!isList(path))
							continue;
						const loop: float2[] = [];
						for (const idx of path) {
							const i = num(idx, ctx, "polygon()'s path index");
							if (i === undefined || i < 0 || i >= points.length)
								continue;
							loop.push(points[Math.round(i)]);
						}
						if (loop.length >= 3)
							paths.push(loop);
					}
					if (paths.length === 0) {
						ctx.warn('a polygon() whose paths described no usable loop, so nothing is drawn');
						return empty;
					}
				} else {
					paths = [points];
				}
				return place(frame, {k: 'polygon2', paths});
			}

			case 'text': {
				const textArg = args.get('text', 0);
				if (typeof textArg !== 'string') {
					if (textArg !== undefined)
						ctx.warn('a text() whose text is not a string, so nothing is drawn');
					return empty;
				}
				const spec	= args.str('font', 2);
				const m		= /^(.*?):style=(.*)$/i.exec(spec);
				const {family, style} = m ? {family: m[1].trim(), style: m[2].trim()} : {family: spec.trim()};
				const font	= findFont(family, style, ctx.files, m => ctx.warn(m));

				if (font) {
					const size		= args.num('size', 1) ?? 10;
					const halign	= args.enum('halign', 3, ['left', 'center']);
					const valign	= args.enum('valign', 4, ['baseline', 'top', 'center', 'bottom']);
					const spacing	= args.num('spacing', 5) ?? 1;

					if (args.get('direction', 6) !== undefined || args.get('language', 7) !== undefined || args.get('script', 8) !== undefined)
						ctx.warn("a text() with direction=/language=/script=, which this viewer does not use -- left to right, in the font's own default script");

					const glyphs	= layoutText({font, text: textArg, size, halign, valign, spacing}, ctx.files, m => ctx.warn(m));
					if (glyphs.length === 0)
						return empty;

					const children: Sdf[] = glyphs.map(curve => ({k: 'curvepath2', paths: curve}));
					return place(frame, children.length === 1 ? children[0] : {k: 'union', children});
				}
				return empty;
			}

			case 'offset': {
				// offset(r) grows the shape by that radius with round joins, which is exactly its distance minus r.
				// offset(delta) mitres the corners instead: exact when the body is one simple convex polygon (a
				// square, a $fn-sided circle, or a convex polygon()), by moving each edge's own line out by delta
				// and meeting adjacent edges at their new intersection -- everything else (concave, multiple paths,
				// a union, a smooth circle) still draws the round approximation, honestly reported.
				// r is the first positional argument *or* the named 'r'; delta is named only, since OpenSCAD parses the
				// signature as offset(r) with delta as a separate name
				const r		= args.num('r') ?? 0;
				const delta = args.num('delta');
				if (r !== undefined && delta !== undefined)
					ctx.warn('an offset() given both r and delta, which OpenSCAD resolves to r');
				// children are placed in the *local* frame: `frame` is applied once, below, to the offset node as a
				// whole. Placing them in `frame` here too would double-apply it -- e.g. a translate() above an
				// offset() would move the result twice.
				const children = childrenOf(scope, env, identityFrame, ctx);
				const body = children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
				if (!is2d(body))
					ctx.warn('an offset() of something that is not 2-D, which OpenSCAD rejects');
				if (r === undefined && delta !== undefined) {
					const verts = body.k === 'square2' || body.k === 'circle2' || (body.k === 'polygon2' && body.paths.length === 1)
						? verticesOf2(body) : undefined;
					const convexity = verts && polygonConvexity(verts);
					const mitred	= convexity && verts && mitredOffset2(verts, delta, convexity.ccw);
					if (mitred && offsetPreservesEdges(verts!, mitred))
						return place(frame, {k: 'polygon2', paths: [mitred]});
					ctx.warn('an offset(delta), whose mitred corners are drawn round here -- exact mitring only works for a single convex outline (a square, a $fn-sided circle, or a convex polygon())');
				}
				return place(frame, {k: 'offset', r: r ?? delta ?? 1, body});
			}

			case 'linear_extrude': {
				const height = args.num('height', 0) ?? 100;
				const center = args.bool('center', 1) ?? false;
				for (const name of ['twist', 'scale', 'slices'])
					if (args.get(name))
						ctx.warn(`a linear_extrude ${name}, which this viewer does not vary along its height`);

				// children are placed in the *local* frame, as offset()'s are (see the comment there): `frame` is
				// applied once, below, to the extruded solid as a whole.
				const children	= childrenOf(scope, env, identityFrame, ctx);
				const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
				if (!is2d(body) && body.k !== 'empty')
					ctx.warn('a linear_extrude of something that is not a 2-D shape (circle, square or polygon)');
				return place(frame, {k: 'extrude', h: height, center, body});
			}

			case 'projection': {
				// the solid's shadow on the xy plane, or with cut = true its slice there -- worked out once as 2-D
				// shapes (see projection() in sdf.ts); children are placed in the local frame, as offset()'s are
				const cut		= args.bool('cut', 0) ?? false;
				const children	= childrenOf(scope, env, identityFrame, ctx);
				const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
				if (is2d(body))
					ctx.warn('a projection() of a 2-D shape, which OpenSCAD ignores');
				const {sdf, traced} = projection(body, cut);
				if (traced !== undefined)
					ctx.warn(`a projection() whose outline is not known exactly (a cut, an intersection, a minkowski, a rotate_extrude or a mesh), so it is traced to about ${Number(traced.toPrecision(2))} units`);
				return place(frame, sdf);
			}

			case 'rotate_extrude': {
				// the 2-D shape is the profile: its x is the radius and its y becomes the axis, so this is exact for a
				// full turn and a wedge cut for a partial one
				const angle		= args.num('angle', 0) ?? 360;
				// children are placed in the *local* frame, as offset()'s are (see the comment there).
				const children	= childrenOf(scope, env, identityFrame, ctx);
				const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
				if (!is2d(body))
					ctx.warn('a rotate_extrude of something that is not a 2-D shape (circle, square or polygon)');
				return place(frame, {k: 'revolve', angle, body});
			}

			case 'group': case 'union':
				return child();

			case 'difference': {
				const children = childrenOf(scope, env, frame, ctx);
				return children.length === 0 ? empty
					: children.length === 1 ? children[0]
					: {k: 'difference', base: children[0], cuts: children.slice(1)};
			}

			case 'intersection':
				return combineIntersection(childrenOf(scope, env, frame, ctx));

			// the one place a `for`'s iterations are not unioned first: real OpenSCAD gives it its own node type
			// (an AbstractIntersectionNode, not for's usual GroupNode -- see childrenOf's own comment) precisely so
			// each iteration becomes its own operand here, the way it reads like it should but plain `for` never does
			case 'intersection_for': {
				const children: Sdf[] = [];
				forEachIteration(inst.args ?? [], env, ctx, inner => children.push(...inner.evalScopeList(scope, frame, ctx)));
				return combineIntersection(children);
			}

			case 'minkowski': {
				// Minkowski sum is commutative and associative, so which operand is "the shape" and which are
				// "what it is grown by" is not fixed by write order: every operand is checked the same way (still
				// structurally, via supportOf/supportsOf/circleSupportsOfSdf -- see supportOf's own comment for
				// why nothing is built to find this out), and exactly one not resolving to a sphere/circle is
				// what makes the body, in whatever position it is written, not just the first. Zero or
				// two-or-more such operands falls back to anchoring on the first, as this always has.
				const insts = scope.moduleInstantiations;
				if (insts.length === 0)
					return empty;
				// insts[0], built once, real frame and all: whichever operand turns out to be the body is always
				// built this same way, in one step (never identityFrame then place() on top), because a rotated
				// flat-brush operand's dilate needs findPlaneBrush to recognise the body's faces to the epsilon it
				// checks them to (see below), and composing a transform in two baked steps instead of one, while
				// mathematically the same field, is not bit-for-bit the same floating point, which is enough to
				// miss that epsilon. Reused directly as the body when it needs no other frame than this one.
				const probe = new Env(env).instantiate(insts[0], frame, ctx);

				if (is2d(probe)) {
					// A 2-D Minkowski sum's useful case is a sum with circles, which is exactly offset(r) -- what
					// OpenSCAD's own 2-D minkowski of a circle is too. Every operand is built again here, with no
					// frame of its own (identityFrame): that is what circleSupportsOfSdf's own `own` parameter
					// reads back off the resulting domain nodes, and place(frame, ...) on it is exactly what a
					// real-frame build would have been -- offset() has no equivalent of findPlaneBrush's precision
					// sensitivity, so building insts[0] a second time this way, only when it is not the body, costs
					// nothing but a little work.
					const built			= insts.map(i => new Env(env).instantiate(i, identityFrame, ctx));
					const resolved		= built.map(b => circleSupportsOfSdf(b, frame));
					const unresolved	= resolved.map((r, i) => r ? -1 : i).filter(i => i >= 0);
					const bodyIndex		= unresolved.length === 1 ? unresolved[0] : 0;
					const body			= bodyIndex === 0 ? probe : place(frame, built[bodyIndex]);

					let base = {r: 0, shift: float2(0, 0)};
					const branches: {r: number, shift: float2}[][] = [];
					for (let i = 0; i < insts.length; i++) {
						if (i === bodyIndex)
							continue;
						const terms = resolved[i];
						if (terms && terms.length > 1) {
							branches.push(terms);				// a union/for of circles: distribute, not sum
							continue;
						}
						let term = terms?.[0];
						if (!term) {
							ctx.warn(is2d(built[i])
								? 'a 2-D minkowski operand that is not a circle, which this viewer cannot sum'
								: 'a 2-D minkowski operand that is a 3-D shape, which this viewer cannot sum');
							const box = bounds2(place(frame, built[i]));
							const radius = box ? Math.max(Math.abs(box.min.x), Math.abs(box.min.y), Math.abs(box.max.x), Math.abs(box.max.y)) : 0;
							term = {r: radius, shift: float2(0, 0)};
						}
						base = {r: base.r + term.r, shift: base.shift.add(term.shift)};
					}
					// at most the first union/for operand distributes exactly; a second one (rare) is folded into
					// one term by summing its own branches first, the same approximation multiple non-circle
					// operands already made
					for (const extra of branches.slice(1)) {
						const summed = extra.reduce((a, b) => ({r: a.r + b.r, shift: a.shift.add(b.shift)}));
						base = {r: base.r + summed.r, shift: base.shift.add(summed.shift)};
					}
					const offsetAt = (term: {r: number, shift: float2}) => {
						const combined = {r: base.r + term.r, shift: base.shift.add(term.shift)};
						const shifted = combined.shift.x || combined.shift.y
							? place({m: float3.translate(float3(combined.shift.x, combined.shift.y, 0)), scale: 1}, body)
							: body;
						return {k: 'offset' as const, r: combined.r, body: shifted};
					};
					if (branches.length === 0)
						return offsetAt({r: 0, shift: float2(0, 0)});
					const children = branches[0].map(offsetAt);
					return children.length === 1 ? children[0] : {k: 'union', children};
				} else {
					//3D
					const resolved		= insts.map(i => supportsOf(i, env, frame, ctx));
					const unresolved	= resolved.map((r, i) => r ? -1 : i).filter(i => i >= 0);
					const bodyIndex		= unresolved.length === 1 ? unresolved[0] : 0;
					const body			= bodyIndex === 0 ? probe : new Env(env).instantiate(insts[bodyIndex], frame, ctx);

					// `base` starts as "no growth operand seen yet", not a zero support, so that a single non-round
					// operand (the flat-brush pattern above, most often) keeps its q exactly: addSupport() is only
					// ever asked to combine two *actual* supports, and only then is dropping q to a warning rather
					// than an error, since the Minkowski sum of two differently-shaped non-ball operands is not
					// itself a single ball or ellipsoid in general.
					let base: (Support & {shift: float3}) | undefined;
					const branches: (Support & {shift: float3})[][] = [];
					const addSupport = (a: Support & {shift: float3}, b: Support & {shift: float3}): Support & {shift: float3} => {
						if (a.q || b.q)
							ctx.warn('a minkowski sum of several operands where one is not a ball (a non-uniformly-scaled sphere), which this viewer sums by radius only, dropping the direction it is not round in');
						return {r: a.r + b.r, q: null, shift: a.shift.add(b.shift), bound: a.bound + b.bound};
					};
					for (let i = 0; i < insts.length; i++) {
						if (i === bodyIndex)
							continue;
						const terms = resolved[i];
						if (terms && terms.length > 1) {
							branches.push(terms);					// a union/for of spheres: distribute, not sum
							continue;
						}
						let term = terms?.[0];
						if (!term) {
							// not a sphere: grow by the bounding sphere of what it is, and say so. A 2-D operand is not
							// a solid at all, and growing a solid by its flat bounding sphere is not what the file meant.
							const built = i === 0 ? probe : new Env(env).instantiate(insts[i], frame, ctx);
							ctx.warn(is2d(built)
								? 'a minkowski operand that is a 2-D shape, which is not a solid to grow by'
								: 'a minkowski operand that is not a sphere, so it is grown by its bounding sphere');
							const box = bounds3(built);
							const radius = box ? Math.max(Math.abs(box.min.x), Math.abs(box.min.y), Math.abs(box.min.z), Math.abs(box.max.x), Math.abs(box.max.y), Math.abs(box.max.z)) : 0;
							term = {r: radius, q: null, shift: float3(0, 0, 0), bound: radius};
						}
						base = base ? addSupport(base, term) : term;
					}
					for (const extra of branches.slice(1)) {
						const summed = extra.reduce((a, b) => addSupport(a, b));
						base = base ? addSupport(base, summed) : summed;
					}

					const dilateAt = (term: Support & {shift: float3}) => {
						const combined = base ? addSupport(base, term) : term;
						const shifted = combined.shift.x || combined.shift.y || combined.shift.z
							? place({m: float3.translate(combined.shift), scale: 1}, body)
							: body;
						return {k: 'dilate' as const, body: shifted, support: {r: combined.r, q: combined.q, bound: combined.bound}};
					};
					if (branches.length === 0) {
						if (!base)
							return body;
						const shifted = base.shift.x || base.shift.y || base.shift.z
							? place({m: float3.translate(base.shift), scale: 1}, body)
							: body;
						return {k: 'dilate', body: shifted, support: {r: base.r, q: base.q, bound: base.bound}};
					}
					const children = branches[0].map(dilateAt);
					return children.length === 1 ? children[0] : {k: 'union', children};
				}
			}

			case 'hull': {
				// Two routes to an exact hull, tried in order: every child a shape with a known finite vertex set (a
				// polygon, a box, an n-gon circle/prism, a polyhedron -- built as the real hull of that point set), or
				// every child a same-radius sphere/circle (whose hull is exactly the hull of their centres grown by that
				// radius, since a same-radius ball is "medial" along a convex hull's whole surface -- the existing
				// dilate()/offset() this viewer already renders exactly, plus a capsule/stadium for just two centres,
				// which is too few points to bound a solid the vertex hull's algorithm could work with). Anything else --
				// different radii, a curved side that is not a sphere, a cut shape among the children -- falls back to
				// drawing the union, as this always has.
				const body = child();

				if (is2d(body)) {
					const verts	= hullVertices2(body);
					const hull	= verts && convexHull2(verts);
					if (hull)
						return {k: 'polygon2', paths: [hull]};

					const round = sameRadiusCircles(body);
					if (round) {
						if (round.centres.length === 1)
							return body;					// hull of one circle is that circle, already
						if (round.centres.length === 2)
							return {k: 'stadium2', a: round.centres[0], b: round.centres[1], r: round.r};
						const hull = convexHull2(round.centres);
						if (hull)
							return {k: 'offset', r: round.r, body: {k: 'polygon2', paths: [hull]}};
					}
					ctx.warn('a 2-D hull this viewer cannot build exactly -- circles of different sizes, or a cut shape among its children -- drawn as a union of its children');
					return body;

				} else {
					//3D
					const verts	= hullVertices3(body);
					const hull	= verts && convexHull3(verts);
					if (hull)
						return {k: 'planes', planes: hull.planes, points: [...new Set(hull.faces.flat())], faces: hull.faces};
					const round = sameRadiusSpheres(body);
					if (round) {
						if (round.centres.length === 1)
							return body;						// hull of one sphere is that sphere, already
						if (round.centres.length === 2)
							return {k: 'capsule', a: round.centres[0], b: round.centres[1], r: round.r};
						const hull = convexHull3(round.centres);
						if (hull)
							return {k: 'dilate', body: {k: 'planes', planes: hull.planes, points: [...new Set(hull.faces.flat())], faces: hull.faces}, support: {r: round.r, q: null, bound: round.r}};
					}
					// A mix of sharp corners and spheres of any and varying radii -- a sailboat hull of boxes
					// and a bow sphere is exactly this -- reduces to a list of weighted points (a sharp corner is r = 0)
					// and builds an exact hull from them: offset faces, capsules/round cones along the edges, tried only
					// after the two faster exact cases above, which it would otherwise needlessly outdo in cost.
					const weighted	= weightedPoints3(body);
					const mixedHull	= weighted && weightedHull3(weighted);
					if (mixedHull)
						return mixedHull;
					ctx.warn('a hull this viewer cannot build exactly -- a curved side other than a sphere, a cut shape, or a sphere large enough to change which points are on the hull -- drawn as a union of its children');
					return body;
				}
			}

			case 'color':
				return child();

			case 'render':
				return child();

			case 'children': {
				const outer = ctx.children.at(-1);
				if (!outer) {
					ctx.warn('children() outside a module call');
					return empty;
				}
				if (args.positional.length === 0)
					return new Env(outer.env).evalScope(outer.scope, frame, ctx);
				const index		= args.num('index', 0) ?? 0;
				const chosen	= outer.scope.moduleInstantiations[index];
				return chosen ? new Env(outer.env).instantiate(chosen, frame, ctx) : empty;
			}

			case 'for': {
				const out: Sdf[] = [];
				forEachIteration(inst.args ?? [], env, ctx, inner => out.push(inner.evalScope(scope, frame, ctx)));
				return out.length === 0 ? empty : out.length === 1 ? out[0] : {k: 'union', children: out};
			}

			case 'let': {
				const inner = new Env(env);
				for (const a of inst.args ?? [])
					if (a.name)
						inner.values.set(a.name, env.evalExpr(a.expr, ctx));
				return inner.evalScope(scope, frame, ctx);
			}

			case 'echo': case 'assert':
				console.log(name.toUpperCase() + ':', args.positional.map(a => show(env.evalExpr(a.expr, ctx))).join(' '));
				return child();

			case 'translate':
				arity('translate', args, 1);
				return transformed(float3.translate(args.vec3('v', 0) ?? float3(0, 0, 0)), 1);

			case 'rotate': {
				const first = args.get('a', 0);
				if (typeof first === 'number' || typeof first === 'string') {
					const axis = args.vec3('v', 1) ?? float3(0, 0, 1);
					return transformed(rotationAxis(num(first, ctx, 'rotate()') ?? 0, axis), 1);
				}
				return transformed(rotation(vec3(first, ctx, 'rotate()') ?? float3(0, 0, 0)), 1);
			}

			case 'scale': {
				arity('scale', args, 1);
				const v = args.vec3('v', 0) ?? float3(1, 1, 1);
				// A zero factor does not make a thinner solid, it makes a flat one, and a field cannot describe that:
				// there is no distance from a point to a plane of zero thickness. As a Minkowski operand it means
				// something else entirely -- an offset in the other axes, which is how a shape is rounded in one plane
				// only -- and that path reads the operand itself, so it is unaffected by this.

				const minScaleFactor = (v: float3) => Math.min(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));

				if (minScaleFactor(v) === 0 || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
					ctx.warn('scale() with a zero factor, which flattens the shape: the viewer draws it only as a minkowski operand');
					return empty;
				}
				return transformed(scaling(v), minScaleFactor(v));
			}

			case 'mirror':
				arity('mirror', args, 1);
				return transformed(mirroring(args.vec3('v', 0) ?? float3(1, 0, 0)), 1);

			case 'multmatrix': {
				const rows = args.get('m', 0);
				if (!isList(rows)) {
					ctx.warn('multmatrix with something other than a matrix');
					return child();
				}
				const at = (r: number, c: number) => (rows as any[])?.[r]?.[c] ?? (r === c ? 1 : 0);
				// OpenSCAD's transforms are affine: the fourth row is ignored
				return transformed(float3x4(
					float3(at(0, 0), at(1, 0), at(2, 0)),
					float3(at(0, 1), at(1, 1), at(2, 1)),
					float3(at(0, 2), at(1, 2), at(2, 2)),
					float3(at(0, 3), at(1, 3), at(2, 3)),
				), 1);
			}

			case 'cube': {
				const size = args.vec3('size', 0) ?? float3(1, 1, 1);
				return place(frame, {k: 'box', size, center: args.bool('center', 1) ?? false});
			}

			case 'sphere': {
				const d = num(args.get('d', 2), ctx, 'sphere()');
				const r = d !== undefined ? d / 2 : args.num('r', 0) ?? 1;
				return place(frame, {k: 'sphere', r});
			}

			case 'cylinder': {
				// The argument rules are OpenSCAD's own (primitives.cc): positionally it is (h, r1, r2, center), and r, d, d1
				// and d2 can only be named. A diameter beats the radius of the same name, r / d set both ends, and r1 / r2
				// (or d1 / d2) then override one end each -- so cylinder(40, 1, 1) is a 1-radius mast, and cylinder(10, 5)
				// is a taper from 5 down to the default 1, not a straight cylinder.
				const h			= args.num('h', 0) ?? 1;
				const center	= args.bool('center', 3) ?? false;
				const radius	= (dName: string, rName: string, position: number): number | undefined => {
					const d = num(args.get(dName), ctx, `cylinder()'s ${dName}`);
					if (d !== undefined)
						return d / 2;
					return num(position >= 0 ? args.get(rName, position) : args.get(rName), ctx, `cylinder()'s ${rName}`);
				};
				const r = radius('d', 'r', -1), r1 = radius('d1', 'r1', 1), r2 = radius('d2', 'r2', 2);
				if (r !== undefined && (r1 !== undefined || r2 !== undefined))
					ctx.warn('a cylinder() given both r or d and r1/r2 or d1/d2, which OpenSCAD calls ambiguous (r1/r2 win for their own end)');

				const baseR1	= r1 ?? r ?? 1, baseR2 = r2 ?? r ?? 1;
				const tapered	= Math.abs(baseR1 - baseR2) > 1e-9;
				const straight	= (baseR1 + baseR2) / 2;		// only used by the untapered paths below

				const fn		= num(args.special('$fn'), ctx, '$fn') ?? 0;
				const sides		= fn >= 3 ? Math.max(3, Math.round(fn)) : 0;
				// A cylinder with $fn is not a round shape approximated: it is that polyhedron, so it is built as one.
				// That keeps its own distance exact at its vertical edges (which a set of face planes only bounds), and
				// lets a frame that stretches an axis move it rather than scale it. A high $fn is left as the analytic
				// shape, where the difference is a fraction of a percent and the polyhedron would be far more work --
				// except when tapered, where there is no analytic frustum formula for an arbitrary side count to fall
				// back to, so a faceted taper is always built as the exact polyhedron it is, however many sides it has.
				if (sides && (sides <= 16 || tapered)) {
					const z0 = center ? -h / 2 : 0, z1 = center ? h / 2 : h, points: float3[] = [];
					for (let i = 0; i < sides; i++) {
						const a = 2 * Math.PI * i / sides;			// OpenSCAD's generate_circle starts at angle 0
						points.push(float3(baseR1 * Math.cos(a), baseR1 * Math.sin(a), z0), float3(baseR2 * Math.cos(a), baseR2 * Math.sin(a), z1));
					}
					const prism = [
						Array.from({length: sides}, (_, i) => 2 * i),
						Array.from({length: sides}, (_, i) => 2 * i + 1),
						...Array.from({length: sides}, (_, i) => [2 * i, 2 * ((i + 1) % sides), 2 * ((i + 1) % sides) + 1, 2 * i + 1]),
					];
					const shape = facePlanes(points, prism);
					if (shape)
						return place(frame, {k: 'planes', planes: shape.planes, points, faces: shape.faces});
				}
				return tapered
					? place(frame, {k: 'cone', r1: baseR1, r2: baseR2, h, center})
					: place(frame, sides ? {k: 'ngonPrism', r: straight, h, center, n: sides} : {k: 'cylinder', r: straight, h, center});
			}

			case 'polyhedron': {
				const points	= vectorOfPoints(args.get('points', 0), ctx);
				const faces		= vectorOfFaces(args.get('faces', 1));
				if (!points || !faces) {
					ctx.warn('polyhedron without readable points and faces');
					return empty;
				}
				return place(frame, solidOf(points, faces, ctx));
			}

			case 'import': {
				const written	= args.get('file', 0) ?? args.get('filename');
				if (typeof written !== 'string') {
					ctx.warn('import() without a file name');
					return empty;
				}

				const from		= getLoc(inst)?.filename ?? ctx.filename;
				const result	= ctx.openFile('import', written, from, async bytes => {
					const ext = extension(written);
					if (MESH_READERS[ext]) {
						const model = await MESH_READERS[ext](bytes);
						const {points, faces} = meshes.flatten(model);
						return {model, solid: solidOf(points, faces, ctx)}
					}
				});
				if (result) {
					const center	= args.bool('center') ?? false;
					const layer		= args.get('layer', 1) ?? args.get('layername');
					const scale		= num(args.get('scale', 4), ctx, "import()'s scale") ?? 1;

					// $fn, $fa and $fs, with OpenSCAD's defaults and floors, for what a file's curves are broken into
					const value			= (name: string, fallback: number) => num(args.special(name) ?? fallback, ctx, name) ?? fallback;
					const discretizer	= {fn: Math.max(value('$fn', 0), 0), fa: Math.max(value('$fa', 12), 0.01), fs: Math.max(value('$fs', 2), 0.01)};

					if (center || scale !== 1) {
						const mesh 		= meshes.flatten(result.model!);
						const mid		= mesh.points.reduce((a, p) => a.min(p)).add(mesh.points.reduce((a, p) => a.max(p))).scale(0.5);
						const frame2	= {m: frame.m.mulAffine(float3.translate(mid.neg())), scale: frame.scale * scale };
						return place(frame2, result.solid)
					}

					return place(frame, result.solid);
				}
				return empty;
			}

			case 'surface': {
				const written	= args.get('file', 0);
				const center	= args.bool('center', 1) ?? false;
				const invert	= args.bool('invert') ?? false;
				const tiled		= tiledOf(args.get('tiled'));
				if (typeof written !== 'string') {
					ctx.warn("surface() without a file name");
					return empty;
				}
				// surface() is OpenSCAD's own, flat only -- bending the grid is wrap()'s job, which is what lets a
				// transform written inside the wrap() be applied to the grid before the bend (see that case).
				const map = readSurface(written, invert, tiled, getLoc(inst)?.filename ?? ctx.filename, ctx);
				if (!map)
					return empty;
				// OpenSCAD's centre is the flat grid's own middle, in x and y only
				return place(center ? {m: frame.m.mulAffine(float3.translate(float3(-(map.cols - 1) / 2, -(map.rows - 1) / 2, 0))), scale: frame.scale} : frame, map);
			}

			case 'resize':
				ctx.warn('resize, which is drawn at its own size');
				return child();

			// wrap("cylinder"/"sphere", r = <radius>) bends what is inside it into a revolution about z: its x
			// becomes an arc of r, its y a height up the axis or a latitude, and its z a thickness standing out
			// from the surface of radius r. A cylinder can be given the length of its axis too (h) -- r and h being
			// the surface's two dimensions, as a cylinder primitive has them -- and then the body's own height is
			// fitted to it rather than being it. Being a wrapper is the point: a transform *inside* it is applied to
			// the flat shape before the bend, so `wrap("sphere", r = 50) scale([1, 1, 0.1]) surface("map.png")`
			// thins the relief and leaves the sphere alone, where a scale outside it would flatten the sphere.
			case 'wrap': {
				const how	= args.str('kind', 0);
				const r		= args.num('r') ?? (args.num('d') ?? 0) / 2;
				const h		= args.num('h');
				if (how !== 'cylinder' && how !== 'sphere')
					ctx.warn(`wrap(): "${how}", which is neither "cylinder" nor "sphere"`);
				else if (!(r > 0))
					ctx.warn(`wrap(): "${how}" needs a positive r or d`);
				// a sphere's meridian is a half turn of r whatever its grid, so it has no second dimension to give
				else if (h !== undefined && how === 'sphere')
					ctx.warn(`wrap(): h, which is the length of a cylinder's axis; a sphere's meridian is pi * r`);
				else if (h !== undefined && !(h > 0))
					ctx.warn('wrap(): h, which should be a positive length');
				else {
					// children are placed in the *local* frame, as offset()'s and rotate_extrude()'s are: `frame` is
					// applied once, below, to the whole bend. Placing them in `frame` here too would not merely move
					// the result twice -- a bent body's z *is* the radius it stands off r, so the frame's own
					// translate would be folded into that radius, and a translate above the wrap would resize it.
					const children = childrenOf(scope, env, identityFrame, ctx);
					const body = children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
					// A flat height field is a whole surface already -- its columns are a ring and its rows reach the
					// poles -- so it is bent as the grid it is: fitted to the turn, seamless, and tighter than the
					// general bend. Scaled across, though -- x anywhere, or y too on a sphere -- it is a piece of a
					// surface rather than the whole of one, and the general bend takes it, its own width being the
					// arc it covers. A scale in z is only how thick the shell stands off r, and one along a
					// cylinder's y only how much of its axis the rows cover: neither makes it a piece. That axis is
					// what h names instead, when the bend was given one -- the length the rows are then fitted to, or
					// repeat over, rather than the length the grid's own scale asks for.
					//
					// A tiled grid is the exception, and the reason for tiling: there the scale sets the size of the
					// tile, not how much of the surface is covered, so the fused path still applies and the mapping
					// is the grid's own arc (see wrappedHeightmapDistance). That is also what keeps a scaled sphere
					// sane at its poles, where the general bend's stretch falls to nothing.
					const placed = placedBody(body);
					const map = placed?.body.k === 'heightmap' && !placed.body.wrap ? placed.body : undefined;
					const tiled = map?.tiled;
					// A scaled grid that is not tiled is a piece of the surface its own width asks for: its columns
					// end where the grid does, of the arc (cols - 1) * sx, and a meridian through each end is a face
					// of the solid. It is bent on the fused path, which carries that scale exactly. The general bend
					// cannot: it folds a non-uniform scale into its distance by the smallest axis alone (see place),
					// so a relief a hundredth as thick as the grid is wide comes out with a gradient a hundredth of
					// the distance's -- the surface still where it should be, but shaded as the flat sheet that
					// gradient describes. That is what a scaled sphere's poles and its every cliff suffered too.
					//
					// A sphere's rows are fitted to the whole meridian by that map, so a piece of one has to be a grid
					// tall enough to span pole to pole; a cylinder's rows are a length up the axis, which the grid's
					// own height or h gives, so its piece needs nothing but its width.
					const part = !!(map && placed && !tiled
						&& Math.abs(placed.scale.x) > 0
						&& Math.abs(placed.scale.x - 1) >= 1e-9
						&& (map.cols - 1) * Math.abs(placed.scale.x) < 2 * Math.PI * r
						&& (how === 'cylinder' || (map.rows - 1) * Math.abs(placed.scale.y) >= Math.PI * r));
					// The other side of the same case: a scaled grid at least a circumference wide is fitted to the
					// whole turn rather than ending at a meridian, so it is a whole surface again and the scale stops
					// saying how much of it is covered -- exactly as an untiled grid with no scale at all is. The
					// general bend fits it too, but it can only carry the scale of the thinnest of the three axes
					// (see place), so a relief a hundredth as thick as the grid is wide is shaded flat; the fused map
					// is where the columns are a whole turn over cols and the scale is carried exactly.
					const fitted = !!(map && placed && !tiled && !part
						&& Math.abs(placed.scale.x - 1) >= 1e-9
						&& (map.cols - 1) * Math.abs(placed.scale.x) >= 2 * Math.PI * r
						&& (how === 'cylinder' || (map.rows - 1) * Math.abs(placed.scale.y) >= Math.PI * r));
					const fused = map && placed && (!!tiled || part || fitted
						|| (Math.abs(placed.scale.x - 1) < 1e-9 && (how === 'cylinder' || Math.abs(placed.scale.y - 1) < 1e-9)));
					if (fused && map && placed) {
						const heights = Float64Array.from(map.heights, v => placed.scale.z * v);
						// A negative scale is a mirror, and the fused mapping has no room for one -- a signed arc
						// would send the columns or the rows round the wrong way -- so a mirrored axis is turned
						// round in the grid itself instead and the arc taken as a size. On a sphere the rows' mirror
						// is nothing at all: the fitted or tiled meridian puts row 0 on the north pole either way, so
						// the same rows lie on the same latitudes. A cylinder's axis is a plain length with no such
						// anchor, so its rows are reversed when the scale is.
						const mirror = (x: boolean, y: boolean) => {
							for (let j = 0; j < map.rows; j++)
								for (let i = 0; x && i < map.cols >> 1; i++) {
									const k = j * map.cols + i, k2 = j * map.cols + map.cols - 1 - i;
									[heights[k], heights[k2]] = [heights[k2], heights[k]];
								}
							for (let j = 0; y && j < map.rows >> 1; j++)
								for (let i = 0; i < map.cols; i++) {
									const k = j * map.cols + i, k2 = (map.rows - 1 - j) * map.cols + i;
									[heights[k], heights[k2]] = [heights[k2], heights[k]];
								}
						};
						const wrap: Wrap = {kind: how, r, row: 1};
						if (tiled) {
							// a tiled grid's scale sets the size of its tile rather than how much of the surface it
							// covers, so the columns repeat round the whole turn and the rows up the axis
							if (tiled.x) { wrap.tileX = true; wrap.sx = Math.abs(placed.scale.x); }
							if (tiled.y) { wrap.tileY = true; wrap.sy = Math.abs(placed.scale.y); }
						} else if (part) {
							// one column is sx of arc and the columns end there: the grid covers that much of the turn
							wrap.part = true;
							wrap.sx = Math.abs(placed.scale.x);
						}
						// A cylinder's axis: h when it was given, else the grid's own scaled height, which is the
						// length a scale in y asks for and what h then names instead. One row covers one row of it,
						// so `row` is that length divided by the grid's rows: the rows are spread over the axis when
						// it is not their own height, and a tiled grid's tile repeats over however long it is.
						if (how === 'cylinder') {
							const H = map.rows - 1;
							const axis = h ?? H * Math.abs(placed.scale.y);
							wrap.row = H > 0 ? axis / H : axis;
						}
						mirror((!!tiled?.x || part || fitted) && placed.scale.x < 0, how === 'cylinder' && placed.scale.y < 0);
						const folded = heightmap(map.cols, map.rows, heights,
							placed.scale.z * map.bottom, wrap);
						return folded ? place(frame, folded) : empty;
					}
					const box = bounds3(body);
					if (!box)
						ctx.warn(is2d(body)
							? 'wrap(): a 2-D shape, which wants an extrude before it can be bent'
							: 'wrap() of nothing');
					else
						// the axis h names is fitted to here too, so a body that is not a grid covers the tube rather
						// than being it; undefined is the body's own height, which is what the map already is
						return place(frame, {k: 'warp', kind: how, r, box, body, axis: how === 'cylinder' ? h : undefined});
				}
				return empty;
			}

			default:
				ctx.warn(`the module '${name}', which is not drawn`);
				return empty;
		}
	}
}

// The body a wrap() is handed under nothing but per-axis scales and translates, with the scales composed into the
// one they amount to -- undefined for anything else, a turn or a shear being beyond what the wrap can read its own
// terms off. A whole turn can fold those scales in exactly and keep a height field's own tile table: a shrink in z
// is a thinner relief whatever radius it is bent onto -- the whole reason to bend a field after the fact rather than
// to have made the map and the bend one thing -- and on a cylinder a scale in y is how much of the axis the rows
// cover. A scale in x is nothing either way, since the columns fill the turn whatever their own width -- unless the
// grid is tiled, where x and y are the arc each cell covers and so the size of the tile (see the wrap case above). A
// translate is nothing on any axis: the wrap fits the body to the surface it bends it around, a translate being no
// part of a shape.
function placedBody(body: Sdf): {body: Sdf, scale: float3} | undefined {
	let s = body, scale = float3(1, 1, 1);
	for (;;) {
		if (s.k === 'material') {
			s = s.body;
			continue;
		}
		if (s.k !== 'domain')
			break;
		const m = s.m;
		if (Math.hypot(m.x.y, m.x.z, m.y.x, m.y.z, m.z.x, m.z.y) > 1e-12)
			return undefined;
		scale = float3(scale.x * m.x.x, scale.y * m.y.y, scale.z * m.z.z);
		s = s.body;
	}
	return {body: s, scale};
}

//-----------------------------------------------------------------------------
// surface()
//-----------------------------------------------------------------------------

// The heightmap a surface() file describes, read as OpenSCAD's SurfaceNode.cc reads it. A PNG is a height of 0 to
// 100 by brightness (0 to -100 inverted), its top row furthest along y. Anything else is a .dat: a row of numbers
// per line, the first line at y = 0, blank lines and lines starting with # skipped, and a short row padded with
// zeros. The solid goes down to one below the lowest height -- for a .dat, to no higher than -1, as OpenSCAD's has
// always done.
// A file a call names, found as OpenSCAD finds it (beside the file the call is written in, then the library path) and
// read as bytes where the files allow, or as text; undefined, reported, when it cannot be.

function readSurface(written: string, invert: boolean, tiled: Tiled | undefined, from: string, ctx: Ctx) {
	const value = ctx.openFile('surface', written, from, async bytes => {
		let format: {load(a: Uint8Array): bitmap.Image | Promise<bitmap.Image>} | undefined;
		switch (extension(written)) {
			case '.png':	format = bitmap.PNG; break;
			case '.jpg':	format = bitmap.JPEG; break;
			case '.jpeg':	format = bitmap.JPEG; break;
			case '.bmp':	format = bitmap.BMP; break;
		}
		let width: number, height: number;
		let heights: Float64Array;
		if (format) {
			const image = await (await format.load(bytes)).getPixels({plane: 'Y', array: Float32Array, luma: 'rec709'});
			width = image.width;
			height =image.height;
			heights = new Float64Array(image.pixels);
		} else {
			const text = new TextDecoder().decode(bytes);
			const rows: number[][] = [];
			for (const raw of text.split(/\r?\n/)) {
				const line = raw.trim();
				if (!line || line.startsWith('#'))
					continue;
				const row: number[] = [];
				for (const token of line.split(/[ \t]+/)) {
					const v = Number(token);
					if (!Number.isFinite(v)) {
						ctx.warn(`surface(): '${written}' has a value that is not a number: '${token}'`);
						return undefined;
					}
					row.push(v);
				}
				rows.push(row);
			}
			width	= rows.reduce((n, r) => Math.max(n, r.length), 0);
			height	= rows.length;
			heights	= new Float64Array(width * height);
			rows.forEach((r, j) => r.forEach((v, i) => heights[j * width + i] = v));
		}
		let lowest = Infinity;
		heights.forEach(v => lowest = Math.min(lowest, v));
		return checkedHeightmap(width, height, heights, lowest - 1, tiled, written, ctx);

	});
	return value;
}

// import()'s mesh formats, by extension as OpenSCAD decides; AMF and 3MF may be zipped, which only reads asynchronously,
// so those are loaded between evaluations (see evaluateWithImages)
const MESH_READERS: Record<string, (bytes: Uint8Array) => meshes.Model|Promise<meshes.Model>> = {
	'.stl': meshes.STL.read,
	'.off': meshes.OFF.read,
	'.dxf': meshes.DXF.read,
	'.amf': meshes.AMF.read,
	'.3mf': meshes.ThreeMF.read,
	'.obj': meshes.OBJ.read,
};


// Segments joined at their ends into paths, as DxfData joins them: ends are snapped to a grid (to an occupied
// neighbouring cell if there is one, which is how nearly-meeting ends meet), open paths are walked from their loose
// ends first, and whatever is left forms closed loops.
function joinPaths(segments: [float2, float2][], GRID = 0.0009765625): {points: float2[], closed: boolean}[] {
	const cells = new Map<string, number[]>();
	const snap = (p: float2) => {
		let ix = Math.round(p.x / GRID), iy = Math.round(p.y / GRID);
		if (!cells.has(`${ix},${iy}`)) {
			let best = 10;
			for (let jx = ix - 1; jx <= ix + 1; jx++)
				for (let jy = iy - 1; jy <= iy + 1; jy++)
					if (cells.has(`${jx},${jy}`) && Math.abs(ix - jx) + Math.abs(iy - jy) < best) {
						best = Math.abs(ix - jx) + Math.abs(iy - jy);
						[ix, iy] = [jx, jy];
					}
		}
		return {key: `${ix},${iy}`, at: float2(ix * GRID, iy * GRID)};
	};

	const lines = segments.map(([a, b], i) => {
		const ends = [snap(a), snap(b)];
		for (const e of ends)
			cells.set(e.key, [...cells.get(e.key) ?? [], i]);
		return ends;
	});

	const done = new Array<boolean>(lines.length).fill(false);
	const walk = (line: number, from: number, closed: boolean) => {
		const points = [lines[line][from].at];
		for (let l: number | undefined = line, f = from; l !== undefined; ) {
			const end: {key: string, at: float2} = lines[l][1 - f];
			points.push(end.at);
			done[l] = true;
			const next: number | undefined = cells.get(end.key)!.find(k => !done[k]);
			f = next === undefined ? 0 : lines[next][0].key === end.key ? 0 : 1;
			l = next;
		}
		// a closed path ends where it began, which the polygon does not repeat
		return {points: closed ? points.slice(0, -1) : points, closed};
	};

	const paths: {points: float2[], closed: boolean}[] = [];
	// an open path starts at an end no other line shares
	for (let again = true; again; ) {
		again = false;
		for (let i = 0; i < lines.length && !again; i++)
			for (let j = 0; j < 2 && !done[i] && !again; j++)
				if (cells.get(lines[i][j].key)!.every(k => k === i || done[k])) {
					paths.push(walk(i, j, false));
					again = true;
				}
	}

	lines.forEach((_, i) => {
		if (!done[i])
			paths.push(walk(i, 0, true));
	});
	return paths;
}

function loadDXF(module: string, args: argGetter) {
	const written = args.str('file');
	if (typeof written !== 'string') {
		args.warn(`${module}() without a file name`);
		return undefined;
	}
	return args.ctx.openFile(module, written, args.filename(), bytes => {
		const model = meshes.DXF.read(bytes);
		return model.extras.document as dwg.DXF;
	});
}

// dxf_dim(): the measurement of the DIMENSION of that name (the first, without one), worked out from its points as
// OpenSCAD's dxfdim.cc does
function dxfDim(args: argGetter): Value {
	const doc	= loadDXF('dxf_dim', args);
	if (!doc)
		return undefined;

	const name	= args.str('name');
	const layer = args.str('layer');

	const dim = doc.entities.filter(e => e instanceof dwg.Dimension).find(e => (!layer || e.layer === layer) && (!name || name === (e.user_text ?? '')));
	if (!dim) {
		args.warn(`dxf_dim(): no dimension '${name}'`);
		return undefined;
	}

	const origin	= args.vec2('origin') ?? float2(0, 0);
	const scale		= args.num('scale') ?? 1;
	const at		= (p?: dwg.Vec2) => p ? float2((p.x - origin.x) * scale, (p.y - origin.y) * scale) : float2(0, 0);

	const lines		= dim instanceof dwg.DRW_DIMENSION_LINEAR || dim instanceof dwg.DRW_DIMENSION_ALIGNED || dim instanceof dwg.DRW_DIMENSION_ORDINATE;
	const angular	= dim instanceof dwg.DRW_DIMENSION_ANG_LN2 || dim instanceof dwg.DRW_DIMENSION_ANG_PT3;
	const defpoint	= at(lines || angular || dim instanceof dwg.DRW_DIMENSION_RADIUS || dim instanceof dwg.DRW_DIMENSION_DIAMETER ? dim.defpoint : undefined);
	const def1		= at(lines || angular ? dim.def1 : undefined);
	const def2		= at(lines || angular ? dim.def2 : undefined);
	const centre	= at(angular ? dim.centrePoint : dim instanceof dwg.DRW_DIMENSION_RADIUS || dim instanceof dwg.DRW_DIMENSION_DIAMETER ? dim.circlePoint : undefined);
	const angle		= deg(dim instanceof dwg.DRW_DIMENSION_LINEAR ? dim.angle : 0);

	const dx = def2.x - def1.x, dy = def2.y - def1.y;
	switch (dim.tflags & 7) {
		case 0:	return Math.abs(dx * Math.cos(angle * Math.PI / 180) + dy * Math.sin(angle * Math.PI / 180));
		case 1:	return Math.hypot(dx, dy);
		// as dxfdim.cc has it, x before y
		case 2:	return Math.abs(atan2Degrees(defpoint.x - centre.x, defpoint.y - centre.y) - atan2Degrees(dx, dy));
		case 3: case 4:	return Math.hypot(centre.x - defpoint.x, centre.y - defpoint.y);
		case 6:	return dim.tflags & 64 ? def1.x : def1.y;
	}
	args.warn(`dxf_dim(): dimension '${name}' is of a type OpenSCAD does not measure`);
	return undefined;
}

// dxf_cross(): where the first two single lines of the layer cross
function dxfCross(args: argGetter): Value {
	const doc	= loadDXF('dxf_cross', args);
	if (!doc)
		return undefined;

	const discretizer =	{fn: 36, fa: 0, fs: 0};
	const segments: [float2, float2][] = [];

	// the plane a drawing's points are placed in: a map, and how much it scales a length
	interface Place { at: (p: dwg.Vec3) => float2, k: number }

	const arc = (place: Place, c: dwg.Vec3, r: number, from: number, sweep: number, n: number) => {
		for (let i = 0; i < n; i++) {
			const a1 = (from + sweep * i / n) * Math.PI / 180, a2 = (from + sweep * (i + 1) / n) * Math.PI / 180;
			segments.push([place.at({x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1), z: 0}), place.at({x: c.x + r * Math.cos(a2), y: c.y + r * Math.sin(a2), z: 0})]);
		}
	};

	const draw = (e: dwg.Obj, place: Place, depth: number) => {
		if (e instanceof dwg.DRW_LINE) {
			segments.push([place.at(e.point1), place.at(e.point2)]);
		} else if (e instanceof dwg.DRW_LWPOLYLINE) {
			const v = e.vertlist.map(p => place.at({x: p.x, y: p.y, z: 0}));
			v.slice(1).forEach((p, i) => segments.push([v[i], p]));
			if (e.closed && v.length > 1)
				segments.push([v[v.length - 1], v[0]]);
		} else if (e instanceof dwg.DRW_ARC) {
			let end = e.angle1 * 180 / Math.PI;
			const start = e.angle0 * 180 / Math.PI;
			while (start > end)
				end += 360;
			arc(place, e.centre, e.radius, start, end - start, segmentCount(discretizer, e.radius * place.k, end - start) ?? 1);
		} else if (e instanceof dwg.DRW_CIRCLE) {
			arc(place, e.centre, e.radius, 0, 360, segmentCount(discretizer, e.radius * place.k) ?? 3);
		} else if (e instanceof dwg.DRW_ELLIPSE) {
			let end = e.angle1;
			while (e.angle0 > end)
				end += 2 * Math.PI;
			const major	= Math.hypot(e.point2.x, e.point2.y), rot = Math.atan2(e.point2.y, e.point2.x), sweep = end - e.angle0;
			const n		= segmentCount(discretizer, major * place.k, sweep * 180 / Math.PI) ?? 1;
			const at	= (i: number) => {
				const a = e.angle0 + sweep * i / n, x = Math.cos(a) * major, y = Math.sin(a) * major * e.ratio;
				return place.at({x: e.point1.x + Math.cos(rot) * x - Math.sin(rot) * y, y: e.point1.y + Math.sin(rot) * x + Math.cos(rot) * y, z: 0});
			};
			for (let i = 0; i < n; i++)
				segments.push([at(i), at(i + 1)]);
		} else if (e instanceof dwg.DRW_INSERT) {
			const block = doc.blocks.get(e.block_name ?? '');
			// a block drawn inside itself would never end; OpenSCAD cannot see one, as it reads blocks in file order
			if (!block || depth > 32)
				return;
			const a		= e.angle, s = e.scale, ins = e.base_point;
			const inner: Place = {
				at: p => place.at({x: ins.x + Math.cos(a) * p.x * s.x - Math.sin(a) * p.y * s.y, y: ins.y + Math.sin(a) * p.x * s.x + Math.cos(a) * p.y * s.y, z: 0}),
				k: place.k * Math.max(Math.abs(s.x), Math.abs(s.y)),
			};
			for (const b of block.entities)
				draw(b, inner, depth + 1);
		}
	};

	const origin	= args.vec2('origin') ?? float2(0, 0);
	const scale		= args.num('scale') ?? 1;
	const top: Place = {at: p => float2((p.x - origin.x) * scale, (p.y - origin.y) * scale), k: scale};
	const layer		= args.str('layer');

	for (const e of doc.entities.filter(e => !layer || (e instanceof dwg.Entity && e.layer === layer)))
		draw(e, top, 0);

	const paths		= joinPaths(segments);
	const [a, b]	= paths.filter(p => !p.closed && p.points.length === 2).map(p => p.points);
	const dem		= b && (b[1].y - b[0].y) * (a[1].x - a[0].x) - (b[1].x - b[0].x) * (a[1].y - a[0].y);
	if (!dem) {
		args.warn('dxf_cross(): no two lines that cross');
		return undefined;
	}
	const ua = ((b[1].x - b[0].x) * (a[0].y - b[0].y) - (b[1].y - b[0].y) * (a[0].x - b[0].x)) / dem;
	return [a[0].x + ua * (a[1].x - a[0].x), a[0].y + ua * (a[1].y - a[0].y)];
}

// surface()'s `tiled`: false (the default), true for both axes, or [x, y] -- a one-element list tiling x alone, since
// that is the axis a wrapped surface most often wants repeated. Undefined when neither axis repeats, so that a plain
// surface() carries no tiled property at all and wrap() reads it as the untiled grid it is. `tiled` is the grid's own
// property, read when a wrap() bends it (see Tiled and Wrap in sdf.ts).
function tiledOf(v: Value): Tiled | undefined {
	const t = isList(v)
		? {x: truthy(v[0]), y: v.length > 1 ? truthy(v[1]) : false}
		: {x: truthy(v), y: truthy(v)};
	return t.x || t.y ? t : undefined;
}

function checkedHeightmap(cols: number, rows: number, heights: Float64Array, bottom: number, tiled: Tiled | undefined, written: string, ctx: Ctx) {
	const map = heightmap(cols, rows, heights, bottom, undefined, tiled);
	if (!map)
		ctx.warn(`surface(): '${written}' has fewer than two rows or columns, so there is no surface`);
	return map;
}

//-----------------------------------------------------------------------------
// entry
//-----------------------------------------------------------------------------

export interface Evaluated {
	sdf: Sdf;
	flat?: (thickness: number) => Sdf;		// the 2-D shapes left outside any extrude, as sheets that tall (see flat2d); the viewer's to draw, not an export's
	warnings: string[];
	// $vpt/$vpr/$vpd/$vpf, but only a field the file itself assigned at its own top level -- the one scope OpenSCAD
	// honours these in -- so the viewer can take them as the file's own preferred view without a default value
	// (there whether the file mentions them or not) looking exactly as deliberate as one it actually wrote.
	camera: {vpt?: [number, number, number], vpr?: [number, number, number], vpd?: number, vpf?: number};
}

const vecOf = (v: Value): [number, number, number] | undefined => isList(v) && v.length >= 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number' ? [v[0], v[1], v[2]] : undefined;
const numOf = (v: Value): number | undefined => typeof v === 'number' ? v : undefined;

// `use <file>` makes a library's modules and functions available without drawing its geometry or importing its
// variables, unlike `include <file>` -- which the parser already splices in as if typed in place, so it needs no
// handling here. `file.usedlibs` holds each used path already resolved against the file that named it (or, if it
// could not be found, the path as written, which `files.read` below then fails on and this reports as a warning).
// A library's own `use`s are loaded too, each path read at most once; a name already bound -- by this file, or by
// a library asked for earlier -- is left alone, so the first (most local) definition wins.
function loadUsedLibraries(file: {path: string, usedlibs: string[]}, files: FileAccess | undefined, env: Env, ctx: Ctx, seen: Set<string>) {
	if (!files)
		return;
	for (const path of file.usedlibs) {
		if (seen.has(path))
			continue;
		seen.add(path);
		let text: string;
		try {
			text = files.read(path);
		} catch {
			ctx.warn(`a use<>d library that could not be read: ${path}`);
			continue;
		}
		const lib = parse(text, path, files);
		loadUsedLibraries(lib, files, env, ctx, seen);
		for (const [name, mod] of lib.scope.modules)
			if (!env.modules.has(name))
				env.modules.set(name, mod);
		for (const [name, fn] of lib.scope.functions)
			if (!env.functions.has(name))
				env.functions.set(name, fn);
	}
}

// The defaults OpenSCAD itself starts these at, kept on a synthetic parent of the real root env: a nested read
// that never finds its own assignment falls through to these exactly as it would any other outer scope's, while
// `env`'s own `values` (checked directly, not through this parent) stays clean for topLevel() to test.
function rootDefaults(preview: boolean): Env {
	const defaults = new Env();
	defaults.values.set('$t', 0);
	defaults.values.set('$preview', preview);
	defaults.values.set('$vpt', [0, 0, 0]);
	defaults.values.set('$vpr', [55, 0, 25]);
	defaults.values.set('$vpd', 140);
	defaults.values.set('$vpf', 22.5);
	return defaults;
}

// `preview` is false only for a final export (see exportStl()): OpenSCAD's own $preview, which a file may use to
// skip a preview-only simplification, since here that step -- unlike a re-evaluation on a moved camera -- is one
// this viewer already always pays for.
export function evaluate(code: string, filename: string, files: ScadFiles, preview = true) {
	const file	= parse(code, filename, files);
	const env	= new Env(rootDefaults(preview));
	const ctx	= new Ctx(files, filename);
	loadUsedLibraries(file, files, env, ctx, new Set([filename]));

	const raw = env.evalScope(file.scope, identityFrame, ctx);
	const {sdf, stripped} = strip2d(raw);
	if (stripped)
		ctx.warn('a 2-D shape (circle, square or polygon) outside linear_extrude/rotate_extrude, which the viewer draws as a flat sheet and an export leaves out');
/*
	for (const key of cache.keys())
		if (!ctx.used.has(key))
			cache.delete(key);
*/
	// Whether `name` was assigned by a statement in the file's own top-level scope -- not just readable there, which
	// env.has() would also say yes to for one of the defaults seeded below on `defaults`, but actually written into
	// `env`'s own `values` by evalScope() itself (see its handling of a $-prefixed assignment).
	function topLevel<T>(name: string, convert: (v: Value) => T | undefined): T | undefined {
		return env.values.has(name) ? convert(env.get(name, ctx)) : undefined;
	}

	const camera = {
		vpt: topLevel('$vpt', vecOf),
		vpr: topLevel('$vpr', vecOf),
		vpd: topLevel('$vpd', numOf),
		vpf: topLevel('$vpf', numOf),
	};
	return {sdf, flat: stripped ? (thickness: number) => flat2d(raw, thickness) : undefined, warnings: ctx.list, camera};
}

//-----------------------------------------------------------------------------
// CSG export: the evaluated tree as text, in the form of OpenSCAD's own .csg -- modules expanded, for loops unrolled,
// if/else resolved and every argument a value, with each built-in's arguments named
//-----------------------------------------------------------------------------

// the parameters of each built-in that takes them, in positional order; a primitive with defaults or aliases (cube,
// sphere, cylinder, circle, square) is written out by csgInstance itself
const CSG_PARAMS: Record<string, string[]> = {
	polygon:			['points', 'paths', 'convexity'],
	polyhedron:			['points', 'faces', 'convexity'],
	translate:			['v'],
	rotate:				['a', 'v'],
	scale:				['v'],
	mirror:				['v'],
	multmatrix:			['m'],
	resize:				['newsize', 'auto', 'convexity'],
	color:				['c', 'alpha'],
	offset:				['r', 'delta', 'chamfer'],
	linear_extrude:		['height', 'center', 'convexity', 'twist', 'slices', 'scale'],
	rotate_extrude:		['angle', 'convexity'],
	projection:			['cut'],
	import:				['file', 'layer', 'convexity'],
	surface:			['file', 'center', 'invert', 'convexity'],
	text:				['text', 'size', 'font', 'halign', 'valign', 'spacing', 'direction', 'language', 'script'],
	wrap:				['kind', 'r', 'd', 'h'],
	minkowski:			['convexity'],
	render:				['convexity'],
	hull:				[],
	union:				[],
	difference:			[],
	intersection:		[],
	group:				[],
};
// the ones that read $fn/$fa/$fs, which OpenSCAD writes out with their values
const CSG_FRAGMENTS = new Set(['sphere', 'cylinder', 'circle', 'rotate_extrude', 'offset', 'text']);
// the ones that stand alone, with no children to put braces round
const CSG_LEAVES = new Set(['cube', 'sphere', 'cylinder', 'circle', 'square', 'polygon', 'polyhedron', 'text', 'import', 'surface']);

function csgNumber(n: number) {
	return Number.isNaN(n) ? 'nan' : !Number.isFinite(n) ? (n < 0 ? '-inf' : 'inf') : String(parseFloat(n.toPrecision(12)));
}

function csgValue(v: Value): string {
	return typeof v === 'number'	? csgNumber(v)
		: typeof v === 'string'		? JSON.stringify(v)
		: typeof v === 'boolean'	? String(v)
		: isList(v)					? '[' + v.map(csgValue).join(', ') + ']'
		: 'undef';
}

function csgScope(scope: Scope, env: Env, ctx: Ctx, out: string[], depth: number) {
	for (const s of env.declare(scope)) {
		if (s.inst)
			csgInstance(s.inst, env, ctx, out, depth);
		else if (s.name!.startsWith('$'))
			env.values.set(s.name!, env.evalExpr(s.expr, ctx));
	}
}

function csgInstance(inst: Inst, env: Env, ctx: Ctx, out: string[], depth: number) {
	const pad		= '\t'.repeat(depth);
	const block		= (head: string, body: (depth: number) => void) => {
		out.push(`${pad}${head} {`);
		body(depth + 1);
		out.push(`${pad}}`);
	};
	const inner		= (scope: Scope, e: Env, d: number) => csgScope(scope, new Env(e), ctx, out, d);

	if (inst instanceof IfElseModuleInstantiation) {
		const taken = truthy(env.evalExpr(inst.expr, ctx)) ? inst.scope : inst.else_scope;
		if (taken)
			csgScope(taken, new Env(env), ctx, out, depth);
		return;
	}

	const name		= inst.modname ?? '';
	const scope		= inst.scope;
	const rawargs	= inst.args ?? [];
	const args		= argGetter(rawargs, env, ctx);

	// a module the file defines itself: a group of what its body builds
	const user = env.findModule(name);
	if (user) {
		const call	= new Env(env);
		const p		= args.positional;
		let pi = 0;
		for (const param of user.parameters)
			call.values.set(param.name, args.get(param.name) ?? (pi < p.length ? env.evalExpr(p[pi++].expr, ctx) : param.expr ? call.evalExpr(param.expr, ctx) : undefined));
		call.values.set('$children', scope.moduleInstantiations.length);
		call.values.set('$parent_modules', ctx.moduleStack.length);
		ctx.children.push({scope, env});
		ctx.moduleStack.push(name);
		block('group()', d => csgScope(user.body, call, ctx, out, d));
		ctx.moduleStack.pop();
		ctx.children.pop();
		return;
	}

	switch (name) {
		case 'for':
			block('group()', d => forEachIteration(rawargs, env, ctx, it => csgScope(scope, it, ctx, out, d)));
			return;

		case 'intersection_for':
			block('intersection()', d => forEachIteration(rawargs, env, ctx, it => block('group()', d2 => csgScope(scope, it, ctx, out, d2))));
			return;

		case 'let': {
			const e = new Env(env);
			for (const a of rawargs)
				if (a.name)
					e.values.set(a.name, env.evalExpr(a.expr, ctx));
			csgScope(scope, e, ctx, out, depth);
			return;
		}

		case 'children': {
			const outer = ctx.children.at(-1);
			if (!outer) {
				ctx.warn('children() outside a module call');
				return;
			}
			// the children were written where the module was called, so their own children() belong to that call's
			ctx.children.pop();
			if (args.positional.length === 0 && !named(rawargs, 'index'))
				csgScope(outer.scope, new Env(outer.env), ctx, out, depth);
			else {
				const chosen = outer.scope.moduleInstantiations[args.num('index', 0) ?? 0];
				if (chosen)
					csgInstance(chosen, new Env(outer.env), ctx, out, depth);
			}
			ctx.children.push(outer);
			return;
		}

		case 'echo': case 'assert':
			console.log(name.toUpperCase() + ':', args.positional.map(a => env.evalExpr(a.expr, ctx)).map(show).join(' '));
			inner(scope, env, depth);
			return;
	}

	const given: [string, string][] = [];
	const fragments = () => {
		if (CSG_FRAGMENTS.has(name))
			for (const [f, d] of [['$fn', 0], ['$fa', 12], ['$fs', 2]] as const)
				given.push([f, csgValue(args.special(f) ?? d)]);
	};

	switch (name) {
		case 'cube': {
			const size = args.get('size', 0);
			given.push(['size', csgValue(typeof size === 'number' ? [size, size, size] : size ?? [1, 1, 1])], ['center', csgValue(args.bool('center', 1) ?? false)]);
			break;
		}
		case 'square': {
			const size = args.get('size', 0);
			given.push(['size', csgValue(typeof size === 'number' ? [size, size] : size ?? [1, 1])], ['center', csgValue(args.bool('center', 1) ?? false)]);
			break;
		}
		case 'sphere': case 'circle': {
			fragments();
			const d = args.num('d', 2);
			given.push(['r', csgValue(d !== undefined ? d / 2 : args.num('r', 0) ?? 1)]);
			break;
		}
		case 'cylinder': {
			fragments();
			// primitives.cc's rules: d beats r, r/d set both ends, and r1/r2 (d1/d2) then override one end each
			const r		= args.num('d') !== undefined ? args.num('d')! / 2 : args.num('r');
			const r1	= args.num('d1') !== undefined ? args.num('d1')! / 2 : args.num('r1', 1) ?? r ?? 1;
			const r2	= args.num('d2') !== undefined ? args.num('d2')! / 2 : args.num('r2', 2) ?? r ?? 1;
			given.push(['h', csgValue(args.num('h', 0) ?? 1)], ['r1', csgValue(r1)], ['r2', csgValue(r2)], ['center', csgValue(args.bool('center', 3) ?? false)]);
			break;
		}
		default: {
			const known = CSG_PARAMS[name];
			if (!known) {
				ctx.warn(`${name}(): not a module this export knows, so it and its children are left out`);
				return;
			}
			fragments();
			const params = [...known];
			for (const a of rawargs)
				if (a.name && !a.name.startsWith('$') && !params.includes(a.name))
					params.push(a.name);
			params.forEach((p, i) => {
				const v = args.get(p, i);
				if (v !== undefined)
					given.push([p, csgValue(v)]);
			});
			// positional arguments past the parameters are ignored by OpenSCAD too
		}
	}
	given.sort(([a], [b]) => +!a.startsWith('$') - +!b.startsWith('$'));

	const mark = inst.tag_root ? '!' : inst.tag_highlight ? '#' : inst.tag_background ? '%' : '';
	const head = `${mark}${name}(${given.map(([k, v]) => `${k} = ${v}`).join(', ')})`;
	if (CSG_LEAVES.has(name))
		out.push(`${pad}${head};`);
	else
		block(head, d => inner(scope, env, d));
}

// The tree evaluate() would build, as .csg text: OpenSCAD's own export of the same file.
export function evaluateCsg(code: string, filename: string, files: ScadFiles, preview = false) {
	const file	= parse(code, filename, files);
	const env	= new Env(rootDefaults(preview));
	const ctx	= new Ctx(files, filename);
	loadUsedLibraries(file, files, env, ctx, new Set([filename]));
	const out: string[] = [];
	csgScope(file.scope, env, ctx, out, 0);
	return {csg: out.join('\n') + '\n', warnings: ctx.list};
}
