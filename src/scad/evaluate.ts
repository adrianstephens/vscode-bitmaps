// Evaluates a parsed .scad file into the field algebra of sdf.ts. What has to be executed is only the sequencing
// OpenSCAD's language demands -- variables, module instantiation, for/if/let/children -- because scad has no
// first-class geometry to defer. Everything a construct *means* is turned into a field as it is met, so nothing
// here builds a solid, and a Minkowski operand is understood from the expression it is written as.
import {
	parse, getLoc, IfElseModuleInstantiation,
	type SourceFile, type Location, type Assignment, type Expr, type LocalScope as Scope,
	ModuleInstantiation as Inst, type UserModule, type FunctionDefinition
} from './parser';
import type { Sdf, Support } from './sdf';
import { compileField, compileColor, compileDisplacement, FnError, Texture, type Resolver } from './fnsurface';
import type { ScadFiles } from '../filereader';
import { findFont, layoutText } from '../fonts';
import { random, colors } from '@isopodlabs/utilities';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import * as meshes from '@isopodlabs/binary_meshes';
import * as path from 'path';
import { empty,
	bounds2,	hullVertices2,	convexHull2, verticesOf2, sameRadiusCircles, is2d,
	SDF,	hullVertices3,	convexHull3, verticesOf3, polytopeOfIntersection, sameRadiusSpheres, weightedPoints3, weightedHull3,
	isConformal, projection, heightmap, type Wrap,
	sameMaterial, DEFAULT_MATERIAL, inverseOrIdentity, type Material,
	trimesh, scaleHeightmap, Box3
} from './sdf';
import { float2, float3, float4, float3x3, float3x4, float2x3, safeNormalise } from '@isopodlabs/maths/vector';
import { transformCurve, bezier2Curve, curveVertex, parseSVG, ON_BEGIN, ON_CURVE, OFF_BEZ3 } from '@isopodlabs/binary_fonts';
import * as dwg from '@isopodlabs/dwg';

const extension = (full: string) => path.extname(full).toLowerCase();

interface Warner { warn(message: string): void; }

class Ctx implements Warner {
	private seen = new Map<string, number>();

	warn(message: string) {
		this.seen.set(message, (this.seen.get(message) ?? 0) + 1);
	}

	get list(): string[] {
		return [...this.seen].map(([message, count]) => count > 1 ? `${message} (x${count})` : message);
	}

	children	= [] as { scope: Scope, env: Env }[];
	// user-defined modules currently instantiating, outermost first, for $parent_modules/parent_module() -- a
	// builtin module (translate(), difference(), ...) is not one of OpenSCAD's own either, so it is not pushed here
	moduleStack	= [] as string[];
	constructor(public files: ScadFiles, public filename: string) {}

	// What `reader` makes of the file a call names, found as OpenSCAD finds it (beside the file the call is written in,
	// then the library path); undefined, reported, when it cannot be. The result is shared by every call and every
	// evaluation that names the file under `key`, so the reader is to make only what the bytes say (see FileReader),
	// and a format it does not read is for it to throw on.
	openFile<T>(module: string, written: string, from: string, key: string, reader: (bytes: Uint8Array)=>T | Promise<T>): T | undefined {
		const full = this.files ? this.files.resolve(written, path.dirname(from)) : written;
		if (!full) {
			this.warn(`${module}(): '${written}' was not found`);
			return undefined;
		}
		try {
			return this.files.read(full, key, reader);
		} catch (error: any) {
			this.warn(`${module}(): '${written}' could not be read (${error?.message ?? String(error)})`);
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
// a function literal is the one value that is not data: it can only be called, or compiled by surface_fn()/implicit_fn()
export type Value = number | string | boolean | undefined | Value[] | Closure;


// a function value: `function(x, y) ...`, with what it closes over, or a texture() to be looked up as img(u, v)
export interface Closure {
	closure:	true;
	definition:	FunctionDefinition;
	resolver:	Resolver;
	call:	(env: Env, args: Assignment[]) => Value;
	texture?:	Texture;
}

const isClosure = (v: Value | FunctionDefinition): v is Closure => typeof v === 'object' && v !== null && (v as Closure).closure === true;
const isList	= (v: Value): v is Value[] => Array.isArray(v);

function truthy(v: Value): boolean {
	switch (typeof v) {
		case 'undefined':	return false;
		case 'boolean':		return v;
		case 'number':		return v !== 0;
		case 'string':		return v.length > 0;
		default:			return isClosure(v) || v.length > 0;
	}
}

function num(v: Value, warn?: Warner, what?: string): number | undefined {
	switch (typeof v) {
		case 'number':		return v;
		case 'boolean':		return v ? 1 : 0;
		case 'undefined':	break;
		default:			if (warn) warn.warn(`${what} is not a number`);
	}
	return undefined;
}

function maybe<T>(convert: (v: Value, warn: Warner, what?: string)=> T | undefined) {
	return (v: Value, warn: Warner, what?: string) => v === undefined ? undefined : convert(v, warn, what);
}

function str(v: Value, warn: Warner, what?: string): string{
	if (typeof v === 'string')
		return v;
	if (warn)
		warn.warn(`${what} is not a string`);
	return '';
}

// a point of the plane: polygon() takes [x, y], and ignores any third component
function vec2(v: Value, warn: Warner, what?: string): float2 | undefined {
	if (!isList(v))
		return undefined;
	const x = num(v[0], warn, 'a 2d point');
	const y = num(v[1], warn, 'a 2d point');
	if (x !== undefined && y !== undefined)
		return float2(x, y);
	if (warn)
		warn.warn(`${what} is not a 2-vector`);
	return undefined;
}

function vec3(v: Value, warn?: Warner, what?: string): float3 | undefined {
	if (typeof v === 'number')
		return float3(v, v, v);
	if (isList(v)) {
		const n = v.map(x => num(x, warn, what));
		if (n.length >= 3 && n.every(x => x !== undefined))
			return float3(n[0]!, n[1]!, n[2]!);
		if (n.length === 2 && n.every(x => x !== undefined))
			return float3(n[0]!, n[1]!, 0);
	}
	if (warn)
		warn.warn(`${what} is not a 3-vector`);
	return undefined;
}

function show(v: Value): string {
	switch (typeof v) {
		case 'undefined':	return 'undef';
		case 'string':		return JSON.stringify(v);
		case 'number':		return String(v);
		case 'boolean': 	return v ? 'true' : 'false';
		default:			return isClosure(v) ? 'function' : `[${v.map(show).join(', ')}]`;
	}
}

//-----------------------------------------------------------------------------
// arguments
//-----------------------------------------------------------------------------

// the positional arguments of an instantiation, in order
const positional	= (args: Assignment[]) => args.filter(a => !a.name);
const named			= (args: Assignment[], name: string) => args.find(a => a.name === name);

const argGetter = (inst: Inst, env: Env, ctx: Ctx) => {
	const args	= inst.args ?? [];
	const p		= positional(args);
	const eva	= (e: Expr|undefined) => env.evalExpr(e, ctx);
	const get	= (name: string, index = -1) => {
		const byName = named(args, name);
		return byName ? eva(byName.expr) : index >= 0 && index < p.length ? eva(p[index].expr) : undefined;
	};

	return {
		positional: p,
		scope:		inst.scope,
		env,
		ctx,
		raw:		args,
		eval:		eva,
		filename:	() => getLoc(args[0]?.expr)?.filename ?? ctx.filename,
		warn:		(w: string) => ctx.warn(w),
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
			return byName ? eva(byName.expr) : env.get(name, ctx);
		},
		child:			(frame: Frame) => evalScope(new Env(env), inst.scope, frame, ctx),
		children:		(frame: Frame) => inst.scope.moduleInstantiations.map(i => instantiate(new Env(env), i, frame, ctx)),
		transformed:	(frame: Frame, m: float3x4, scale: number) => evalScope(new Env(env), inst.scope, {m: frame.m.mulAffine(m), scale: frame.scale * scale}, ctx),

		arity:			(name: string, count: number) => {
			const extra = positional.length - count;
			if (extra > 0)
				ctx.warn(`${name}() takes ${count} argument${count === 1 ? '' : 's'}, so ${extra} of them ${extra === 1 ? 'is' : 'are'} ignored`);
		}

	}
}
type argGetter = ReturnType<typeof argGetter>;

// let()'s bindings are sequential (let* in Scheme terms, not the order-independent style a module/file scope's
// variables use): each one sees every binding before it in the same let(), so it evaluates each expression in
// `target` itself -- which accumulates them one at a time -- rather than in the outer `env` a plain module-call
// argument list would use, where the arguments cannot see each other at all.
function bindArguments(args: Assignment[], target: Env, ctx: Ctx) {
	for (const a of args)
		if (a.name)
			target.values.set(a.name, target.evalExpr(a.expr, ctx));
}


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

function getColor(c: Value, alpha: number | undefined, warn: Warner) {
	let rgba: [number, number, number, number] | undefined;
	if (c === undefined) {
		warn.warn('a color() with no colour, so it tints nothing');
		
	} else if (typeof c === 'string') {
		rgba = colors.lookupColor(c);
		if (!rgba) {
			warn.warn(c.toLowerCase().startsWith('xkcd:')
				? 'an xkcd: colour name, which this viewer does not carry over'
				: `a colour name or hex value it does not know: '${c}'`);
		}
	} else if (isList(c)) {
		rgba = [1, 1, 1, 1];
		for (let i = 0; i < Math.min(4, c.length); i++)
			rgba[i] = num(c[i], warn, 'a component of a color()') ?? 0;
		if (rgba.some(v => v < 0 || v > 1))
			warn.warn('a color() component outside 0..1');
	} else {
		warn.warn('a color() whose colour is neither a name nor a vector');
	}

	if (rgba && alpha !== undefined) {
		if (alpha < 0 || alpha > 1)
			warn.warn('a color() alpha outside 0..1');
		rgba[3] = alpha;
	}
	return rgba;
}

//-----------------------------------------------------------------------------
// 
//-----------------------------------------------------------------------------


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
	if (body.k === 'trimesh' && Math.abs(m.det()) >= 1e-12) {
		const mirrors = m.det() < 0;
		const faces: number[][] = [];
		for (let t = 0; t < body.tris.length; t += 3)
			faces.push(mirrors ? [body.tris[t], body.tris[t + 2], body.tris[t + 1]] : [body.tris[t], body.tris[t + 1], body.tris[t + 2]]);
		return trimesh(body.points.map(p => m.mulPos(p)), faces) ?? empty;
	}
	

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
function forEachIteration(args: argGetter, leaf: (inner: Env) => void) {
	let count = 0, truncated = false;
	const recurse = (i: number, inner: Env) => {
		if (count >= 10000) {
			truncated = true;
		} else if (i >= args.raw.length) {
			count++;
			leaf(inner);
		} else {
			const loop	= args.raw[i];
			const range	= inner.evalExpr(loop.expr, args.ctx);
			for (const value of isList(range) ? range : [range]) {
				const next = new Env(inner);
				next.values.set(loop.name || 'i', value);
				recurse(i + 1, next);
				if (truncated)
					return;
			}
		}
	};
	if (args.raw.length > 0)
		recurse(0, args.env);
	if (truncated)
		args.warn('a for loop with more than 10000 iterations, which is cut short');
}

//-----------------------------------------------------------------------------
// polyhedra
//-----------------------------------------------------------------------------

// import()'s mesh formats, by extension as OpenSCAD decides; AMF and 3MF may be zipped, which only reads asynchronously,
// so these are read as files are loaded (see FileReader)
const MESH_READERS: Record<string, (bytes: Uint8Array) => meshes.Model|Promise<meshes.Model>> = {
	'.stl': meshes.STL.read,
	'.off': meshes.OFF.read,
	'.dxf': meshes.DXF.read,
	'.amf': meshes.AMF.read,
	'.3mf': meshes.ThreeMF.read,
	'.obj': meshes.OBJ.read,
};

function vectorOfPoints(v: Value, warn: Warner): float3[] | undefined {
	if (!isList(v))
		return undefined;
	const out: float3[] = [];
	for (const p of v) {
		const point = vec3(p, warn, 'a polyhedron point');
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
		// the whole polygon: its region is where the face is the nearest thing, so a corner left out is a bite taken out of it
		loops.push(face.map(i => points[i]).filter(Boolean));
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

function solidOf(points: float3[], faces: number[][], warn: Warner): Sdf {
	const shape = faces.length <= PLANES_MAX ? facePlanes(points, faces) : undefined;
	if (shape?.convex)
		return {k: 'planes', planes: shape.planes, points, faces: shape.faces};
	const solid = trimesh(points, faces);
	if (solid && !solid.closed)
		warn.warn('a mesh that is not closed (an edge not shared by exactly two faces, or faces wound differently), so which side of it is inside is a guess near its gaps');
	return solid ?? empty;
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
	const values = argGetter(inst, env, ctx);

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

function numerical(args: argGetter, fn: (...a: number[]) => number, what: string) {
	const numbers = args.raw.map(a => num(args.eval(a.expr), args, what));
	if (numbers.some(n => n === undefined))
		return undefined;
	return fn(...(numbers as number[]));
}

// rands() with no seed goes on from wherever the last call left the generator, as OpenSCAD's one shared engine does;
// with a seed it starts again from that seed, so a seeded call always gives the same numbers
let sharedRng: random.MT19937 | undefined;

const builtin_functions: Record<string, (args: argGetter) => Value> = {
	// texture("file.png", repeat = true): an image as a function of (u, v), each 0..1 across it with v up the image, that
	// gives [r, g, b, a] there between the pixels' centres -- beyond 0..1 the image repeats, or holds its edges. It is called
	// as any function value is, and inside a colour, surface or displace() function the shader reads the image itself.
	texture: (args) => {
		const written = args.get('file', 0);
		if (typeof written !== 'string') {
			args.warn('texture() without a file name');
			return undefined;
		}
		const textures = args.ctx.openFile('texture', written, args.filename(), 'texture', async bytes => {
			let format: {load(a: Uint8Array): bitmap.Image | Promise<bitmap.Image>} | undefined;
			switch (extension(written)) {
				case '.png':	format = bitmap.PNG; break;
				case '.jpg':
				case '.jpeg':	format = bitmap.JPEG; break;
				case '.bmp':	format = bitmap.BMP; break;
				default:		throw new Error('not an image texture() reads (png, jpeg or bmp)');
			}
			const {width, height, pixels} = await (await format.load(bytes)).getPixels({plane: 'RGBA', array: Float32Array});
			// rows from the bottom up, so v runs up the image as y does up a surface()
			const rgba = new Float32Array(width * height * 4), row = width * 4;
			for (let j = 0; j < height; j++)
				rgba.set((pixels as Float32Array).subarray((height - 1 - j) * row, (height - j) * row), j * row);
			return {repeat: new Texture(width, height, rgba, true), clamp: new Texture(width, height, rgba, false)};
		});
		if (!textures)
			return undefined;
		const tex = (args.bool('repeat') ?? true) ? textures.repeat : textures.clamp;
		const ident = (name: string): Expr => ({type: 'identifier', name} as Expr);
		return {
			closure:	true,
			texture:	tex,
			// what it is as a function, for the compiler: function(u, v) texture(u, v), that name meaning this image
			definition:	{parameters: [{name: 'u'}, {name: 'v'}], expr: {type: 'call', callee: ident('texture'), arguments: [{name: '', expr: ident('u')}, {name: '', expr: ident('v')}]} as Expr},
			resolver:	{get: () => undefined, findFunction: name => name === 'texture' ? tex : undefined},
			call: (env, call) => {
				const pos = positional(call).map(a => env.evalExpr(a.expr, args.ctx));
				const uv = pos.length === 1 && isList(pos[0]) ? pos[0] : pos;
				const u = num(uv[0], args.ctx, 'the u of a texture'), v = num(uv[1], args.ctx, 'the v of a texture');
				return u === undefined || v === undefined ? undefined : tex.at(u, v);
			},
		};
	},
	rands:		(args) => {
		const a = args.raw.map(x => args.eval(x.expr));
		if (a.length < 3 || a.length > 4 || a.some(v => typeof v !== 'number')) {
			args.warn('rands() takes (min, max, count) or (min, max, count, seed), all numbers');
			return undefined;
		}
		let [min, max] = a as number[];
		const huge = Number.MAX_VALUE / 2;
		if (!Number.isFinite(min)) { args.warn('rands() range min cannot be infinite'); min = -huge; }
		if (!Number.isFinite(max)) { args.warn('rands() range max cannot be infinite'); max = huge; }
		if (max < min)
			[min, max] = [max, min];
		const wanted = Math.abs(a[2] as number);
		if (!Number.isFinite(wanted)) {
			args.warn('rands() cannot create an infinite number of results');
			return [];
		}
		const count = Math.min(Math.floor(wanted), 10_000_000);
		if (a.length === 4)
			sharedRng = new random.MT19937(random.seedOf(a[3] as number));
		sharedRng ??= new random.MT19937((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
		const rng = sharedRng;
		return Array.from({length: count}, () => min >= max ? min : rng.uniform(min, max));
	},
	len:		(args) => {
		const v = args.eval(args.raw[0].expr);
		return isList(v) ? v.length : num(v, args, 'len');
	},
	concat:		(args) => {
		const out: Value[] = [];
		for (const a of args.raw) {
			const v = args.eval(a.expr);
			if (isList(v))
				out.push(...v);
			else if (v !== undefined)
				out.push(v);
		}
		return out;
	},
	// a string is used as it is; anything else (a number, a vector, which quotes the strings inside it) is shown as echo shows it
	str:		(args) => args.raw.map(a => { const v = args.eval(a.expr); return typeof v === 'string' ? v : show(v); }).join(''),
	norm:	(args) => {
		const v = vec3(args.eval(args.raw[0]?.expr), args, 'norm()');
		return v ? v.len() : undefined;
	},
	dot:		(args) => {
		const a = vec3(args.eval(args.raw[0]?.expr), args, 'dot()');
		const b = vec3(args.eval(args.raw[1]?.expr), args, 'dot()');
		return a && b ? a.dot(b) : undefined;
	},
	dxf_dim:	(args) => dxfDim(args),
	dxf_cross:	(args) => dxfCross(args),
	cross:		(args) => {
		const x = args.eval(args.raw[0]?.expr), y = args.eval(args.raw[1]?.expr);
		// two 2-D vectors give their cross product's z alone, a number, as OpenSCAD's own cross() does -- the
		// signed area the shoelace formula sums
		if (isList(x) && isList(y) && x.length === 2 && y.length === 2) {
			const [ax, ay, bx, by] = [x[0], x[1], y[0], y[1]].map(v => num(v, args, 'cross'));
			return ax === undefined || ay === undefined || bx === undefined || by === undefined ? undefined : ax * by - ay * bx;
		}
		const a = vec3(x, args, 'cross');
		const b = vec3(y, args, 'cross');
		if (!a || !b)
			return undefined;
		const c = a.cross(b);
		return [c.x, c.y, c.z];
	},
	is_undef:	(args) => args.eval(args.raw[0]?.expr) === undefined,
	is_num:		(args) => typeof args.eval(args.raw[0]?.expr) === 'number',
	is_bool:	(args) => typeof args.eval(args.raw[0]?.expr) === 'boolean',
	is_string:	(args) => typeof args.eval(args.raw[0]?.expr) === 'string',
	is_list:	(args) => isList(args.eval(args.raw[0]?.expr)),

	sqrt:		(args) => numerical(args, Math.sqrt, 'sqrt'),
	abs:		(args) => numerical(args, Math.abs, 'abs'),
	sign:		(args) => numerical(args, Math.sign, 'sign'),
	floor:		(args) => numerical(args, Math.floor, 'floor'),
	ceil:		(args) => numerical(args, Math.ceil, 'ceil'),
	// halves round away from zero, as C's round() (and so OpenSCAD's) does, where Math.round takes -2.5 to -2
	round:		(args) => numerical(args, a => Math.sign(a) * Math.round(Math.abs(a)), 'round'),
	exp:		(args) => numerical(args, Math.exp, 'exp'),
	ln:			(args) => numerical(args, Math.log, 'log'),
	log:		(args) => numerical(args, Math.log, 'log'),
	// OpenSCAD's trig functions are all in degrees: the three forward ones take degrees in, the four inverse ones
	// give degrees out -- Math's are all radians, so the conversion belongs here at the boundary, not left to
	// whichever caller remembers it.
	sin:		(args) => numerical(args, a => Math.sin(rad(a)), 'sin'),
	cos:		(args) => numerical(args, a => Math.cos(rad(a)), 'cos'),
	tan:		(args) => numerical(args, a => Math.tan(rad(a)), 'tan'),
	asin:		(args) => numerical(args, a => deg(Math.asin(a)), 'asin'),
	acos:		(args) => numerical(args, a => deg(Math.acos(a)), 'acos'),
	atan:		(args) => numerical(args, a => deg(Math.atan(a)), 'atan'),
	atan2:		(args) => numerical(args, (y, x) => deg(Math.atan2(y, x)), 'atan2'),
	pow:		(args) => numerical(args, Math.pow, 'pow'),
	min:		(args) => numerical(args, Math.min, 'min'),
	max:		(args) => numerical(args, Math.max, 'max'),

	// parent_module(0) is the immediate caller, so it sits one below the top of the stack -- the top is this call
	// itself, pushed by instantiate() before the body (and so this function call) runs. Indexing past either end
	// of the stack is a plain out-of-range array read, which JS already gives back as undefined.
	parent_module: (args) => {
		const n = num(args.eval(args.raw[0]?.expr), args, 'parent_module()');
		return n === undefined ? undefined : args.ctx.moduleStack[args.ctx.moduleStack.length - 2 - Math.floor(n)];
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


function eq(l: Value, r: Value): boolean {
	if (isList(l) && isList(r))
		return l.length === r.length && l.every((v, i) => eq(v, r[i]));
	return l === r;
}

function le(l: Value, r: Value, warn: Warner): boolean|undefined {
	const a = num(l, warn, `the left of ''`), b = num(r, warn, `the right of ''`);
	return a === undefined || b === undefined ? undefined : a <= b;
}

function binary(op: string, l: Value, r: Value, warn: Warner): Value {
	switch (op) {
		case '==':	return eq(l, r);
		case '!=':	return !eq(l, r);
		case '<':	return !le(r, l, warn);
		case '>':	return !le(l, r, warn);
		case '<=':	return le(l, r, warn);
		case '>=':	return le(r, l, warn);
		// + and - between vectors are componentwise, not concat() -- OpenSCAD has no vector meaning for `+` beyond
		// that. Recursing per component, rather than requiring the elements be numbers, is what makes this the same
		// operation for a matrix (a vector of vectors) with no separate case.
		case '+': case '-': {
			if (isList(l) || isList(r)) {
				if (!isList(l) || !isList(r) || l.length !== r.length) {
					warn.warn(`'${op}' between mismatched vectors`);
					return undefined;
				}
				return l.map((lv, i) => binary(op, lv, r[i], warn));
			}
			break;
		}
		case '*': {
			if (isList(l) && isList(r)) {
				// A "matrix" here is a list of equal-length rows; a plain vector stands in for a single row on the left or a single
				// column on the right, which is what turns OpenSCAD's four shapes of `*` -- vector.vector, matrix*vector,
				// vector*matrix, matrix*matrix -- into one rule: rows of the left against columns of the right. Which sides were
				// plain vectors decides how much of the result to unwrap afterwards: both collapses to a scalar (a dot product),
				// either one collapses that side's dimension of the result down to a flat vector, and neither leaves a matrix.
				const row = (v: Value, what: string): number[] | undefined => {
					if (!isList(v) || v.some(isList)) {
						warn.warn(`'*': ${what} is not a row of numbers`);
						return undefined;
					}
					const out = v.map(x => num(x, warn, "an element of '*'"));
					return out.some(x => x === undefined) ? undefined : out as number[];
				};
				const asRows = (v: Value[], isMatrix: boolean, side: string): number[][] | undefined => {
					const rows = isMatrix ? v.map((x, i) => row(x, `row ${i} of the ${side} of '*'`)) : [row(v, `the ${side} of '*'`)];
					if (rows.some(a => !a))
						return undefined;
					if (!rows.every(a => a!.length === rows[0]!.length)) {
						warn.warn(`'*' with a matrix on the ${side} whose rows are not all the same length`);
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
					warn.warn("'*' between a matrix/vector and one of the wrong size");
					return undefined;
				}
				const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
				const out = lRows.map(lr => cols.map(c => dot(lr, c)));

				if (!lIsMatrix && !rIsMatrix) return out[0][0];	// vector . vector: a scalar
				if (!lIsMatrix) return out[0];						// vector * matrix: one row
				if (!rIsMatrix) return out.map(orow => orow[0]);	// matrix * vector: one column, flattened
				return out;											// matrix * matrix
			}
			// a number times a vector (either side) scales it componentwise; two lists is linear-algebra `*` -- a dot
			// product, a matrix against a vector, or two matrices -- so `*` is the one operator whose vector form is
			// not just "do it componentwise"
			if (isList(l) || isList(r)) {
				const vec		= isList(l) ? l : r as Value[];
				const scalar	= num(isList(l) ? r : l, warn, "the scalar side of '*'");
				return scalar === undefined ? undefined : vec.map(v => binary('*', v, scalar, warn));
			}
			break;
		}
		// a vector divides only by a number, componentwise; a number divided by a vector is not defined
		case '/': {
			if (isList(l)) {
				const scalar = num(r, warn, "the right of '/'");
				return scalar === undefined ? undefined : l.map(v => binary('/', v, scalar, warn));
			}
			if (isList(r)) {
				warn.warn("a number divided by a vector");
				return undefined;
			}
			break;
		}
	}
	const a = num(l, warn, `the left of '${op}'`), b = num(r, warn, `the right of '${op}'`);
	if (a === undefined || b === undefined)
		return undefined;

	switch (op) {
		case '+': return a + b;
		case '-': return a - b;
		case '*': return a * b;
		case '/': return a / b;
		case '%': return a % b;
		case '^': return Math.pow(a, b);
		case '&': return a & b;
		case '|': return a | b;
		case '<<': return a << b;
		case '>>': return a >> b;
		default:
			warn.warn(`the operator '${op}'`);
			return undefined;
	}
}
// Whether a polygon's own vertex order traces a convex, simply-wound boundary -- every turn the same way, not just
// "these points happen to be in convex position" (a hull would tell you that, but not whether the given order
// traces it without folding back on itself). Undefined for fewer than three vertices or a degenerate polygon.
function polygonConvexity(points: float2[]): {ccw: boolean} | undefined {
	const n = points.length;
	if (n < 3)
		return undefined;
	let sign = 0;
	for (let i = 0; i < n; i++) {
		const a = points[(i + n - 1) % n], b = points[i], c = points[(i + 1) % n];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (Math.abs(cross) < 1e-12)
			continue;			// a straight (180 degree) vertex -- doesn't break convexity either way
		const s = Math.sign(cross);
		if (sign === 0)
			sign = s;
		else if (s !== sign)
			return undefined;	// a turn the other way: concave, or the order doesn't trace a simple boundary
	}
	return sign ? {ccw: sign > 0} : undefined;
}
// Whether every edge of a mitred result still points the same way as the edge it came from -- the check the caller
// runs to catch a delta that shrinks a convex polygon past itself. A shrink that far can still (by coincidence, for
// a symmetric shape) come back round to a result that is itself convex and correctly wound, so re-checking
// polygonConvexity on the output is not enough on its own; an edge that has reversed, gone to zero length, or
// swung round more than a right angle from where it started is what actually says the mitre construction broke.
function offsetPreservesEdges(points: float2[], mitred: float2[]): boolean {
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const orig = points[(i + 1) % n].sub(points[i]);
		const moved = mitred[(i + 1) % n].sub(mitred[i]);
		if (orig.dot(moved) <= 0)
			return false;
	}
	return true;
}

// The exact mitred offset of a convex polygon by delta (outward for delta > 0): each edge's own offset line moves
// out along its normal by delta, and each new vertex is where its two adjacent edges' offset lines meet -- the
// textbook construction, valid here because a convex polygon's edges can never fold back on each other as they
// move, PROVIDED delta does not shrink an edge past where it would disappear; undefined when two adjacent edges are
// parallel (a redundant straight vertex, so no single mitre point exists). A delta so negative the polygon
// collapses past itself is instead caught by the caller with offsetPreservesEdges on the result.
function mitredOffset2(points: float2[], delta: number, ccw: boolean): float2[] | undefined {
	const n = points.length;
	const side = ccw ? 1 : -1;
	const outward = (a: float2, b: float2): float2 | undefined => {
		const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
		return len > 1e-12 ? float2(side * dy / len, -side * dx / len) : undefined;
	};
	const out: float2[] = [];
	for (let i = 0; i < n; i++) {
		const prev = points[(i + n - 1) % n], cur = points[i], next = points[(i + 1) % n];
		const n0 = outward(prev, cur), n1 = outward(cur, next);
		if (!n0 || !n1)
			return undefined;
		const c0 = n0.x * prev.x + n0.y * prev.y + delta;
		const c1 = n1.x * cur.x + n1.y * cur.y + delta;
		const det = n0.x * n1.y - n0.y * n1.x;
		if (Math.abs(det) < 1e-9)
			return undefined;	// the two edges are parallel (a straight vertex) -- no single mitre point
		out.push(float2((c0 * n1.y - c1 * n0.y) / det, (n0.x * c1 - n1.x * c0) / det));
	}
	return out;
}

const builtin_modules: Record<string, (args: argGetter, frame: Frame) => Sdf> = {
	color: (args, frame) => {
		const children = args.children(frame);
		const body = children.length === 0 ? empty : children.length === 1 ? children[0] : {k: 'union' as const, children};

		if (args.positional.length > 2)
			args.warn('a color() with more than two positional arguments: the material properties are named');

		// alpha is the second argument, not the first: color([r,g,b,a]) passes its alpha inside `c`, and reading
		// index 0 here would take the colour vector itself for the alpha and warn about it
		const written = args.get('c', 0);
		let colorFn: Material['colorFn'];
		if (isClosure(written)) {
			// a colour that is a function of the point, in the frame this color() is written in: its inverse takes a point of
			// the model to one of that frame (its columns are x, y, z and w, so a row of the map takes one component of each),
			// and the frame's own transpose takes a normal there
			try {
				const inv = inverseOrIdentity(frame.m), m = frame.m, xyz = ['x', 'y', 'z'] as const;
				colorFn = compileColor(written.definition, written.resolver, xyz.map(k => [inv.x[k], inv.y[k], inv.z[k], inv.w[k]]), xyz.map(k => [m[k].x, m[k].y, m[k].z]));
			} catch (e) {
				if (!(e instanceof FnError))
					throw e;
				args.warn(`color(): ${e.message}`);
				return body;
			}
		}
		const rgba = colorFn ? [0.62, 0.66, 0.72, args.num('alpha', 1) ?? 1] : getColor(written, args.num('alpha', 1), args);
		if (!rgba)
			return body;

		const ambient	= ambientMaterial(args.env, args.ctx);

		// an explicit argument wins over the `$` variable, which is what setting one for a scope and another for one object means
		const property = (name: string) => args.num(name) ?? args.num(`$${name}`) ?? (ambient as any)[name === 'refractive_index' ? 'ior' : name];
		const mat = {
			...ambient,
			rgb:		float3(rgba[0], rgba[1], rgba[2]),
			opacity:	rgba[3],
			specular:	property('specular'),
			roughness:	property('roughness'),
			ior:		args.num('ior') ?? args.num('$ior') ?? args.num('refractive_index') ?? args.num('$refractive_index') ?? ambient.ior,
			metallic:	property('metallic'),
			colorFn,
		};

		// a color() that changes nothing is not a node: the common case stays exactly as it was
		return !sameMaterial(mat, ambient) ? {k: 'material', mat, body} : body;
	},

	circle: (args, frame) => {
		const d		= args.num('d', 2);
		const r		= d !== undefined ? d / 2 : args.num('r', 0) ?? 1;
		const fn	= num(args.special('$fn'), args, '$fn') ?? 0;
		return place(frame, {k: 'circle2', r, n: fn >= 3 ? Math.max(3, Math.round(fn)) : 0});
	},

	square: (args, frame) => {
		const v = args.get('size', 0);
		let size: float2;
		if (typeof v === 'number')
			size = float2(v, v);
		else if (isList(v) && v.length >= 2)
			size = float2(num(v[0], args, "square()'s x") ?? 0, num(v[1], args, "square()'s y") ?? 0);
		else if (isList(v) && v.length === 1) {
			args.warn('a square() with one size, taken as a square of it');
			size = float2(num(v[0], args, "square()'s size") ?? 0, num(v[0], args, "square()'s size") ?? 0);
		} else {
			args.warn('a square() whose size is neither a number nor a vector, so 1 x 1 is used');
			size = float2(1, 1);
		}
		return place(frame, {k: 'square2', size, center: args.bool('center', 1) ?? false});
	},

	polygon: (args, frame) => {
		// points= is the shared vertex pool; paths= is a list of loops of indices into it (a hole is just
		// another loop -- the even-odd fill in polygonDistance2 is what makes it read as a hole rather than
		// an extra island). Omitting paths= means one loop, the points in the order given.
		const points: float2[] = [];
		const v = args.get('points', 0);
		if (isList(v))
			for (const p of v) {
				const q = vec2(p, args);
				if (!q)
					break;
				points.push(q);
			}
		if (points.length < 3) {
			args.warn('a polygon() with fewer than three readable points, so nothing is drawn');
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
					const i = num(idx, args, "polygon()'s path index");
					if (i === undefined || i < 0 || i >= points.length)
						continue;
					loop.push(points[Math.round(i)]);
				}
				if (loop.length >= 3)
					paths.push(loop);
			}
			if (paths.length === 0) {
				args.warn('a polygon() whose paths described no usable loop, so nothing is drawn');
				return empty;
			}
		} else {
			paths = [points];
		}
		return place(frame, {k: 'polygon2', paths});
	},

	text: (args, frame) => {
		const textArg = args.get('text', 0);
		if (typeof textArg !== 'string') {
			if (textArg !== undefined)
				args.warn('a text() whose text is not a string, so nothing is drawn');
			return empty;
		}
		const spec	= args.str('font', 2);
		const m		= /^(.*?):style=(.*)$/i.exec(spec);
		const {family, style} = m ? {family: m[1].trim(), style: m[2].trim()} : {family: spec.trim()};
		const font	= findFont(family, style, args.ctx.files, m => args.warn(m));

		if (font) {
			const size		= args.num('size', 1) ?? 10;
			const halign	= args.enum('halign', 3, ['left', 'center']);
			const valign	= args.enum('valign', 4, ['baseline', 'top', 'center', 'bottom']);
			const spacing	= args.num('spacing', 5) ?? 1;

			if (args.get('direction', 6) !== undefined || args.get('language', 7) !== undefined || args.get('script', 8) !== undefined)
				args.warn("a text() with direction=/language=/script=, which this viewer does not use -- left to right, in the font's own default script");

			const glyphs	= layoutText({font, text: textArg, size, halign, valign, spacing}, args.ctx.files, m => args.warn(m));
			if (glyphs.length === 0)
				return empty;

			const children: Sdf[] = glyphs.map(curve => ({k: 'curvepath2', paths: curve}));
			return place(frame, children.length === 1 ? children[0] : {k: 'union', children});
		}
		return empty;
	},

	offset: (args, frame) => {
		// offset(r) grows the shape by that radius with round joins, which is exactly its distance minus r.
		// offset(delta) mitres the corners instead: exact when the body is one simple convex polygon (a
		// square, a $fn-sided circle, or a convex polygon()), by moving each edge's own line out by delta
		// and meeting adjacent edges at their new intersection -- everything else (concave, multiple paths,
		// a union, a smooth circle) still draws the round approximation, honestly reported.
		// r is the first positional argument *or* the named 'r'; delta is named only, since OpenSCAD parses the
		// signature as offset(r) with delta as a separate name
		const r		= args.num('r');		// (undefined if it is not given: delta is used then, and neither is 0)
		const delta = args.num('delta');
		if (r !== undefined && delta !== undefined)
			args.warn('an offset() given both r and delta, which OpenSCAD resolves to r');
		// children are placed in the *local* frame: `frame` is applied once, below, to the offset node as a
		// whole. Placing them in `frame` here too would double-apply it -- e.g. a translate() above an
		// offset() would move the result twice.
		const children = args.children(identityFrame);
		const body = children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
		if (!is2d(body))
			args.warn('an offset() of something that is not 2-D, which OpenSCAD rejects');
		if (r === undefined && delta !== undefined) {
			const verts = body.k === 'square2' || body.k === 'circle2' || (body.k === 'polygon2' && body.paths.length === 1)
				? verticesOf2(body) : undefined;
			const convexity = verts && polygonConvexity(verts);
			const mitred	= convexity && verts && mitredOffset2(verts, delta, convexity.ccw);
			if (mitred && offsetPreservesEdges(verts!, mitred))
				return place(frame, {k: 'polygon2', paths: [mitred]});
			args.warn('an offset(delta), whose mitred corners are drawn round here -- exact mitring only works for a single convex outline (a square, a $fn-sided circle, or a convex polygon())');
		}
		return place(frame, {k: 'offset', r: r ?? delta ?? 0, body});
	},

	linear_extrude: (args, frame) => {
		const height = args.num('height', 0) ?? 100;
		const center = args.bool('center', 1) ?? false;
		for (const name of ['twist', 'scale', 'slices'])
			if (args.get(name))
				args.warn(`a linear_extrude ${name}, which this viewer does not vary along its height`);

		// children are placed in the *local* frame, as offset()'s are (see the comment there): `frame` is
		// applied once, below, to the extruded solid as a whole.
		const children	= args.children(identityFrame);
		const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
		if (!is2d(body) && body.k !== 'empty')
			args.warn('a linear_extrude of something that is not a 2-D shape (circle, square or polygon)');
		return place(frame, {k: 'extrude', h: height, center, body});
	},

	projection: (args, frame) => {
		// the solid's shadow on the xy plane, or with cut = true its slice there -- worked out once as 2-D
		// shapes (see projection() in sdf.ts); children are placed in the local frame, as offset()'s are
		const cut		= args.bool('cut', 0) ?? false;
		const children	= args.children(identityFrame);
		const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
		if (is2d(body))
			args.warn('a projection() of a 2-D shape, which OpenSCAD ignores');
		const {sdf, traced} = projection(body, cut);
		if (traced !== undefined)
			args.warn(`a projection() whose outline is not known exactly (a cut, an intersection, a minkowski, a rotate_extrude or a mesh), so it is traced to about ${Number(traced.toPrecision(2))} units`);
		return place(frame, sdf);
	},

	rotate_extrude: (args, frame) => {
		// the 2-D shape is the profile: its x is the radius and its y becomes the axis, so this is exact for a
		// full turn and a wedge cut for a partial one
		const angle		= args.num('angle', 0) ?? 360;
		// children are placed in the *local* frame, as offset()'s are (see the comment there).
		const children	= args.children(identityFrame);
		const body		= children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
		if (!is2d(body))
			args.warn('a rotate_extrude of something that is not a 2-D shape (circle, square or polygon)');
		return place(frame, {k: 'revolve', angle, body});
	},

	group: (args, frame) => args.child(frame),
	union: (args, frame) => args.child(frame),

	difference: (args, frame) => {
		const children = args.children(frame);
		return children.length === 0 ? empty
			: children.length === 1 ? children[0]
			: {k: 'difference', base: children[0], cuts: children.slice(1)};
	},

	intersection: (args, frame) => {
		return combineIntersection(args.children(frame));
	},

	// the one place a `for`'s iterations are not unioned first: real OpenSCAD gives it its own node type
	// (an AbstractIntersectionNode, not for's usual GroupNode -- see childrenOf's own comment) precisely so
	// each iteration becomes its own operand here, the way it reads like it should but plain `for` never does
	intersection_for: (args, frame) => {
		const children: Sdf[] = [];
		forEachIteration(args, inner => children.push(...evalScopeList(inner, args.scope, frame, args.ctx)));
		return combineIntersection(children);
	},

	minkowski: (args, frame) => {
		// Minkowski sum is commutative and associative, so which operand is "the shape" and which are
		// "what it is grown by" is not fixed by write order: every operand is checked the same way (still
		// structurally, via supportOf/supportsOf/circleSupportsOfSdf -- see supportOf's own comment for
		// why nothing is built to find this out), and exactly one not resolving to a sphere/circle is
		// what makes the body, in whatever position it is written, not just the first. Zero or
		// two-or-more such operands falls back to anchoring on the first, as this always has.
		const insts = args.scope.moduleInstantiations;
		if (insts.length === 0)
			return empty;
		// insts[0], built once, real frame and all: whichever operand turns out to be the body is always
		// built this same way, in one step (never identityFrame then place() on top), because a rotated
		// flat-brush operand's dilate needs findPlaneBrush to recognise the body's faces to the epsilon it
		// checks them to (see below), and composing a transform in two baked steps instead of one, while
		// mathematically the same field, is not bit-for-bit the same floating point, which is enough to
		// miss that epsilon. Reused directly as the body when it needs no other frame than this one.
		const probe = instantiate(new Env(args.env), insts[0], frame, args.ctx);

		if (is2d(probe)) {
			// A 2-D Minkowski sum's useful case is a sum with circles, which is exactly offset(r) -- what
			// OpenSCAD's own 2-D minkowski of a circle is too. Every operand is built again here, with no
			// frame of its own (identityFrame): that is what circleSupportsOfSdf's own `own` parameter
			// reads back off the resulting domain nodes, and place(frame, ...) on it is exactly what a
			// real-frame build would have been -- offset() has no equivalent of findPlaneBrush's precision
			// sensitivity, so building insts[0] a second time this way, only when it is not the body, costs
			// nothing but a little work.
			const built			= insts.map(i => instantiate(new Env(args.env), i, identityFrame, args.ctx));
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
					args.warn(is2d(built[i])
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
			const resolved		= insts.map(i => supportsOf(i, args.env, frame, args.ctx));
			const unresolved	= resolved.map((r, i) => r ? -1 : i).filter(i => i >= 0);
			const bodyIndex		= unresolved.length === 1 ? unresolved[0] : 0;
			const body			= bodyIndex === 0 ? probe : instantiate(new Env(args.env), insts[bodyIndex], frame, args.ctx);

			// `base` starts as "no growth operand seen yet", not a zero support, so that a single non-round
			// operand (the flat-brush pattern above, most often) keeps its q exactly: addSupport() is only
			// ever asked to combine two *actual* supports, and only then is dropping q to a warning rather
			// than an error, since the Minkowski sum of two differently-shaped non-ball operands is not
			// itself a single ball or ellipsoid in general.
			let base: (Support & {shift: float3}) | undefined;
			const branches: (Support & {shift: float3})[][] = [];
			const addSupport = (a: Support & {shift: float3}, b: Support & {shift: float3}): Support & {shift: float3} => {
				if (a.q || b.q)
					args.warn('a minkowski sum of several operands where one is not a ball (a non-uniformly-scaled sphere), which this viewer sums by radius only, dropping the direction it is not round in');
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
					const built = i === 0 ? probe : instantiate(new Env(args.env), insts[i], frame, args.ctx);
					args.warn(is2d(built)
						? 'a minkowski operand that is a 2-D shape, which is not a solid to grow by'
						: 'a minkowski operand that is not a sphere, so it is grown by its bounding sphere');
					const box = new SDF(built).bounds();
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
	},

	hull: (args, frame) => {
		// Two routes to an exact hull, tried in order: every child a shape with a known finite vertex set (a
		// polygon, a box, an n-gon circle/prism, a polyhedron -- built as the real hull of that point set), or
		// every child a same-radius sphere/circle (whose hull is exactly the hull of their centres grown by that
		// radius, since a same-radius ball is "medial" along a convex hull's whole surface -- the existing
		// dilate()/offset() this viewer already renders exactly, plus a capsule/stadium for just two centres,
		// which is too few points to bound a solid the vertex hull's algorithm could work with). Anything else --
		// different radii, a curved side that is not a sphere, a cut shape among the children -- falls back to
		// drawing the union, as this always has.
		const body = args.child(frame);

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
			args.warn('a 2-D hull this viewer cannot build exactly -- circles of different sizes, or a cut shape among its children -- drawn as a union of its children');
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
			args.warn('a hull this viewer cannot build exactly -- a curved side other than a sphere, a cut shape, or a sphere large enough to change which points are on the hull -- drawn as a union of its children');
			return body;
		}
	},

	render:	(args, frame) => args.child(frame),

	children: (args, frame) => {
		const outer = args.ctx.children.at(-1);
		if (!outer) {
			args.warn('children() outside a module call');
			return empty;
		}
		if (args.positional.length === 0)
			return evalScope(new Env(outer.env), outer.scope, frame, args.ctx);
		const index		= args.num('index', 0) ?? 0;
		const chosen	= outer.scope.moduleInstantiations[index];
		return chosen ? instantiate(new Env(outer.env), chosen, frame, args.ctx) : empty;
	},

	for: (args, frame) => {
		const out: Sdf[] = [];
		forEachIteration(args, inner => out.push(evalScope(inner, args.scope, frame, args.ctx)));
		return out.length === 0 ? empty : out.length === 1 ? out[0] : {k: 'union', children: out};
	},

	let: (args, frame) => {
		const inner = new Env(args.env);
		for (const a of args.raw)
			if (a.name)
				inner.values.set(a.name, args.env.evalExpr(a.expr, args.ctx));
		return evalScope(inner, args.scope, frame, args.ctx);
	},

	echo: (args, frame) => {
		console.log('ECHO:', args.positional.map(a => show(args.eval(a.expr))).join(' '));
		return args.child(frame);
	},
	assert: (args, frame) => {
		console.log('ASSERT:', args.positional.map(a => show(args.eval(a.expr))).join(' '));
		return args.child(frame);
	},


	translate: (args, frame) => {
		args.arity('translate', 1);
		return args.transformed(frame, float3.translate(args.vec3('v', 0) ?? float3(0, 0, 0)), 1);
	},

	rotate: (args, frame) => {
		const first = args.get('a', 0);
		if (typeof first === 'number' || typeof first === 'string') {
			const axis = args.vec3('v', 1) ?? float3(0, 0, 1);
			return args.transformed(frame, rotationAxis(num(first, args, 'rotate()') ?? 0, axis), 1);
		}
		return args.transformed(frame, rotation(vec3(first, args, 'rotate()') ?? float3(0, 0, 0)), 1);
	},

	scale: (args, frame) => {
		args.arity('scale', 1);
		const v = args.vec3('v', 0) ?? float3(1, 1, 1);
		// A zero factor does not make a thinner solid, it makes a flat one, and a field cannot describe that:
		// there is no distance from a point to a plane of zero thickness. As a Minkowski operand it means
		// something else entirely -- an offset in the other axes, which is how a shape is rounded in one plane
		// only -- and that path reads the operand itself, so it is unaffected by this.

		const minScaleFactor = (v: float3) => Math.min(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));

		if (minScaleFactor(v) === 0 || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
			args.warn('scale() with a zero factor, which flattens the shape: the viewer draws it only as a minkowski operand');
			return empty;
		}
		return args.transformed(frame, scaling(v), minScaleFactor(v));
	},

	mirror: (args, frame) => {
		args.arity('mirror', 1);
		return args.transformed(frame, mirroring(args.vec3('v', 0) ?? float3(1, 0, 0)), 1);
	},

	multmatrix: (args, frame) => {
		const rows = args.get('m', 0);
		if (!isList(rows)) {
			args.warn('multmatrix with something other than a matrix');
			return args.child(frame);
		}
		const at = (r: number, c: number) => (rows as any[])?.[r]?.[c] ?? (r === c ? 1 : 0);
		// OpenSCAD's transforms are affine: the fourth row is ignored
		return args.transformed(frame, float3x4(
			float3(at(0, 0), at(1, 0), at(2, 0)),
			float3(at(0, 1), at(1, 1), at(2, 1)),
			float3(at(0, 2), at(1, 2), at(2, 2)),
			float3(at(0, 3), at(1, 3), at(2, 3)),
		), 1);
	},

	cube: (args, frame) => {
		const size = args.vec3('size', 0) ?? float3(1, 1, 1);
		return place(frame, {k: 'box', size, center: args.bool('center', 1) ?? false});
	},

	sphere: (args, frame) => {
		const d = num(args.get('d', 2), args, 'sphere()');
		const r = d !== undefined ? d / 2 : args.num('r', 0) ?? 1;
		return place(frame, {k: 'sphere', r});
	},

	cylinder: (args, frame) => {
		// The argument rules are OpenSCAD's own (primitives.cc): positionally it is (h, r1, r2, center), and r, d, d1
		// and d2 can only be named. A diameter beats the radius of the same name, r / d set both ends, and r1 / r2
		// (or d1 / d2) then override one end each -- so cylinder(40, 1, 1) is a 1-radius mast, and cylinder(10, 5)
		// is a taper from 5 down to the default 1, not a straight cylinder.
		const h			= args.num('h', 0) ?? 1;
		const center	= args.bool('center', 3) ?? false;
		const radius	= (dName: string, rName: string, position: number): number | undefined => {
			const d = num(args.get(dName), args, `cylinder()'s ${dName}`);
			if (d !== undefined)
				return d / 2;
			return num(position >= 0 ? args.get(rName, position) : args.get(rName), args, `cylinder()'s ${rName}`);
		};
		const r = radius('d', 'r', -1), r1 = radius('d1', 'r1', 1), r2 = radius('d2', 'r2', 2);
		if (r !== undefined && (r1 !== undefined || r2 !== undefined))
			args.warn('a cylinder() given both r or d and r1/r2 or d1/d2, which OpenSCAD calls ambiguous (r1/r2 win for their own end)');

		const baseR1	= r1 ?? r ?? 1, baseR2 = r2 ?? r ?? 1;
		const tapered	= Math.abs(baseR1 - baseR2) > 1e-9;
		const straight	= (baseR1 + baseR2) / 2;		// only used by the untapered paths below

		const fn		= num(args.special('$fn'), args, '$fn') ?? 0;
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
	},

	polyhedron: (args, frame) => {
		const points	= vectorOfPoints(args.get('points', 0), args);
		const faces		= vectorOfFaces(args.get('faces', 1));
		if (!points || !faces) {
			args.warn('polyhedron without readable points and faces');
			return empty;
		}
		return place(frame, solidOf(points, faces, args));
	},

	import: (args, frame) => {
		const written	= args.get('file', 0) ?? args.get('filename');
		if (typeof written !== 'string') {
			args.warn('import() without a file name');
			return empty;
		}

		const center	= args.bool('center') ?? false;
		const scale		= num(args.get('scale', 4), args, "import()'s scale") ?? 1;
		const from		= args.filename();

		// a drawing is 2-D: its entities on one layer (or all), joined into outlines and filled even-odd, as
		// OpenSCAD's own dxf import does
		if (extension(written) === '.dxf') {
			const dxf = args.ctx.openFile('import', written, from, 'dxf', bytes => meshes.DXF.read(bytes).extras.document as dwg.DXF);
			if (!dxf)
				return empty;

			const layer			= args.get('layer', 1) ?? args.get('layername');
			const origin		= args.vec2('origin') ?? float2(0, 0);

			// the origin comes off before the scale is applied
			const top			= float2x3(float2(scale, 0), float2(0, scale), origin.scale(-scale));
			const pieces:		Curve[] = [];
			for (const e of dxf.entities.filter(e => layer === undefined || (e instanceof dwg.Entity && e.layer === layer)))
				dxfRender(dxf, e, pieces, top, m => args.warn(m));

			// an open path is closed by the fill, and a lone line encloses nothing
			const joined = joinCurves(pieces).flatMap(p => p.curve.length >= 3 ? p.curve : []);
			return joined.length ? place(frame, curvePath(joined, center)) : empty;
		}

		// a drawing in SVG is 2-D too: OpenSCAD's own import takes its y upward, from the page's lower left,
		// and its pixels at `dpi` (96 unless told) to millimetres
		if (extension(written) === '.svg') {
			const svg = args.ctx.openFile('import', written, from, 'svg', bytes => parseSVG(new TextDecoder('utf-8').decode(bytes)));
			if (!svg)
				return empty;
			for (const w of svg.warnings)
				args.warn(`import(): an SVG with ${w}`);

			const id		= args.get('id');
			const layer		= args.get('layer', 1) ?? args.get('layername');
			const dpi		= num(args.get('dpi'), args, "import()'s dpi") ?? 96;
			const shapes	= svg.shapes.filter(sh => (id === undefined || sh.ids.includes(String(id))) && (layer === undefined || sh.layer === layer));

			// user units to millimetres: the size the document gives itself, over its view box, or else pixels
			const unit = (text: string | undefined) => {
				const m = /^\s*[-+]?[\d.]+(?:[eE][-+]?\d+)?\s*([a-z%]*)/.exec(text ?? '');
				const perUnit: Record<string, number> = {'': 25.4 / dpi, px: 25.4 / dpi, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6};
				return m && m[1] in perUnit ? perUnit[m[1]] : undefined;
			};
			const size	= (text: string | undefined) => text === undefined ? undefined : Number(/[-+]?[\d.]+(?:[eE][-+]?\d+)?/.exec(text)?.[0]);
			const vb	= svg.viewBox;
			const w		= size(svg.width), h = size(svg.height);
			const sx	= vb && w && unit(svg.width) !== undefined && !/%/.test(svg.width!) ? w * unit(svg.width)! / vb.width : 25.4 / dpi;
			const sy	= vb && h && unit(svg.height) !== undefined && !/%/.test(svg.height!) ? h * unit(svg.height)! / vb.height : 25.4 / dpi;
			const all	= shapes.flatMap(sh => sh.curve);
			const top	= vb ? vb.y + vb.height : h ?? all.reduce((m, v) => Math.max(m, v.y), 0);
			const left	= vb ? vb.x : 0;
			const curves = shapes.map(sh => sh.curve.map(v => curveVertex((v.x - left) * sx * scale, (top - v.y) * sy * scale, v.flags)));
			return curves.length ? place(frame, curvePath(curves.flat(), center)) : empty;
		}

		const result	= args.ctx.openFile('import', written, from, 'import', async bytes => {
			const read = MESH_READERS[extension(written)];
			if (!read)
				throw new Error('not a format import() reads');
			return {model: await read(bytes), solid: undefined as Sdf | undefined};
		});
		if (result) {
			if (!result.solid) {
				const {points, faces} = meshes.flatten(result.model);
				result.solid = solidOf(points, faces, args);
			}

			if (center || scale !== 1) {
				const mesh 		= meshes.flatten(result.model);
				const mid		= mesh.points.reduce((a, p) => a.min(p)).add(mesh.points.reduce((a, p) => a.max(p))).scale(0.5);
				const frame2	= {m: frame.m.mulAffine(float3.translate(mid.neg())), scale: frame.scale * scale };
				return place(frame2, result.solid)
			}

			return place(frame, result.solid);
		}
		return empty;
	},

	// surface_fn(function(x, y) <height>, x = [x0, x1], y = [y0, y1], bottom, zmax, slope): the surface z = f(x, y)
	// over that rectangle, solid down to `bottom`, kept as a function rather than sampled. The one thing it has to
	// find out is how high the surface gets, for the box the raymarcher starts from -- by looking, so `zmax` says
	// so where a narrow peak is missed. `slope` is a bound on the gradient, replacing the one worked out from f.
	surface_fn: (args, frame) => {
		const f = args.get('f', 0);
		if (!isClosure(f)) {
			args.warn('surface_fn() needs a function: surface_fn(function(x, y) ..., x = [x0, x1], y = [y0, y1])');
			return empty;
		}
		const xr = args.vec2('x') ?? float2(-10, 10), yr = args.vec2('y') ?? float2(-10, 10);
		const slope = args.num('slope');
		try {
			let fn = compileField(f.definition, f.resolver, {kind: 'height', bound: slope});
			// as for implicit_fn(): the slope here is no bound on the slope nearby, so use the steepest in the rectangle
			if (slope === undefined) {
				const steepest = fn.steepest([xr.x, yr.x, 0], [xr.y, yr.y, 0], 96);
				if (steepest !== undefined && steepest > 1)
					fn = compileField(f.definition, f.resolver, {kind: 'height', bound: Math.sqrt(steepest * steepest - 1) * 1.25, size: Math.max(xr.y - xr.x, yr.y - yr.x) / 2});
			}

			// the heights over a lattice, which is where the surface can be found without being drawn
			const N = 48;
			let lo = Infinity, hi = -Infinity, steepest = 0, previous: number[] = [];
			for (let j = 0; j <= N; j++) {
				const row: number[] = [];
				for (let i = 0; i <= N; i++) {
					const h = -fn.value(xr.x + (xr.y - xr.x) * i / N, yr.x + (yr.y - yr.x) * j / N, 0);
					row.push(h);
					if (Number.isFinite(h)) {
						lo = Math.min(lo, h);
						hi = Math.max(hi, h);
						for (const q of [row[i - 1], previous[i]])
							if (q !== undefined && Number.isFinite(q))
								steepest = Math.max(steepest, Math.abs(h - q));
					}
				}
				previous = row;
			}
			if (!Number.isFinite(lo)) {
				args.warn('surface_fn(): the function is not a number anywhere in the rectangle');
				return empty;
			}
			// what the lattice can have stepped over: a rise as steep as the steepest step it saw, half a cell on
			const bottom = args.num('bottom') ?? lo - 1;
			const top = args.num('zmax') ?? hi + Math.max((hi - lo) * 0.05, steepest * 0.5, 1e-3);
			return place(frame, {k: 'fnfield', fn, box: new Box3(float3(xr.x, yr.x, Math.min(bottom, top)), float3(xr.y, yr.y, top))});
		} catch (e) {
			if (!(e instanceof FnError))
				throw e;
			args.warn(`surface_fn(): ${e.message}`);
			return empty;
		}
	},

	// implicit_fn(function(x, y, z) <field>, x = [..], y = [..], z = [..], lipschitz): the solid where the field is
	// negative, inside that box: a gyroid is `sin(x)*cos(y) + sin(y)*cos(z) + sin(z)*cos(x)`. `lipschitz` bounds how
	// fast the field changes, replacing the estimate from its gradient where that is not safe to step by.
	implicit_fn: (args, frame) => {
		const f = args.get('f', 0);
		if (!isClosure(f)) {
			args.warn('implicit_fn() needs a function: implicit_fn(function(x, y, z) ..., x = [x0, x1], y = [y0, y1], z = [z0, z1])');
			return empty;
		}
		const xr = args.vec2('x') ?? float2(-10, 10), yr = args.vec2('y') ?? float2(-10, 10), zr = args.vec2('z') ?? float2(-10, 10);
		try {
			let lipschitz = args.num('lipschitz');
			let fn = compileField(f.definition, f.resolver, {kind: 'implicit', bound: lipschitz});
			// The gradient at the point is no bound on how fast the field changes nearby: where it dies away (a saddle
			// of a gyroid, with the field not yet zero) the step it gives is far too long, and the ray goes through the
			// surface. The steepest it gets in the box, with room for what the lattice missed, is a step that is safe.
			if (lipschitz === undefined) {
				const steepest = fn.steepest([xr.x, yr.x, zr.x], [xr.y, yr.y, zr.y], 24);
				if (steepest !== undefined && steepest > 0)
					fn = compileField(f.definition, f.resolver, {kind: 'implicit', bound: steepest * 1.25, size: Math.max(xr.y - xr.x, yr.y - yr.x, zr.y - zr.x) / 2});
			}
			return place(frame, {k: 'fnfield', fn, box: new Box3(float3(xr.x, yr.x, zr.x), float3(xr.y, yr.y, zr.y))});
		} catch (e) {
			if (!(e instanceof FnError))
				throw e;
			args.warn(`implicit_fn(): ${e.message}`);
			return empty;
		}
	},

	surface: (args, frame) => {
		const written	= args.get('file', 0);
		if (typeof written !== 'string') {
			args.warn("surface() without a file name");
			return empty;
		}
		const grid = args.ctx.openFile('surface', written, args.filename(), 'surface', async bytes => {
			let format: {load(a: Uint8Array): bitmap.Image | Promise<bitmap.Image>} | undefined;
			switch (extension(written)) {
				case '.png':	format = bitmap.PNG; break;
				case '.jpg':
				case '.jpeg':	format = bitmap.JPEG; break;
				case '.bmp':	format = bitmap.BMP; break;
			}
			if (format) {
				const {width, height, pixels} = await (await format.load(bytes)).getPixels({plane: 'Y', array: Float32Array, luma: 'rec709'});
				return {image: true, cols: width, rows: height, values: pixels.map(i => i * 100)};
			}

			const rows: number[][] = [];
			for (const raw of new TextDecoder().decode(bytes).split(/\r?\n/)) {
				const line = raw.trim();
				if (!line || line.startsWith('#'))
					continue;
				rows.push(line.split(/[ \t]+/).map(token => {
					const v = Number(token);
					if (!Number.isFinite(v))
						throw new Error(`a value that is not a number: '${token}'`);
					return v;
				}));
			}
			const cols		= rows.reduce((n, r) => Math.max(n, r.length), 0);
			const values	= new Float64Array(cols * rows.length);
			rows.forEach((r, j) => r.forEach((v, i) => values[j * cols + i] = v));
			return {image: false, cols, rows: rows.length, values};
		});


		if (grid) {
			const invert	= args.bool('invert') ?? false;

			const v = args.get('tiled');
			const t = isList(v)
				? {x: truthy(v[0]), y: v.length > 1 ? truthy(v[1]) : false}
				: {x: truthy(v), y: truthy(v)};
			const tiled = t.x || t.y ? t : undefined;

			const {image, cols, rows, values} = grid;
			const heights	= new Float64Array(cols * rows);
			let lowest		= image ? Infinity : 1;
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < cols; x++) {
					// an image is a height of 0 to 100 by brightness, its top row furthest along y
					const z = invert ? -values[y * cols + x] : values[y * cols + x];
					heights[(image ? rows - 1 - y : y) * cols + x] = z;
					lowest = Math.min(lowest, z);
				}
			}

			if (cols >= 2 && rows >= 2) {
				const map = heightmap(cols, rows, heights, lowest - 1, undefined, tiled);
				// OpenSCAD's centre is the flat grid's own middle, in x and y only
				return place(args.bool('center', 1) ? {m: frame.m.mulAffine(float3.translate(float3(-(map.cols - 1) / 2, -(map.rows - 1) / 2, 0))), scale: frame.scale} : frame, map);
			}
			
			args.warn(`surface(): '${written}' has fewer than two rows or columns, so there is no surface`);
		}

		return empty;
	},

	resize: (args, frame) => {
		args.warn('resize, which is drawn at its own size');
		return args.child(frame);
	},

	// displace(function(x, y, z) h), or function(x, y, z, nx, ny, nz) h to be given the surface's unit normal too: what is
	// inside it with its surface moved out along its normal by h, or in where h is negative, x, y, z and the normal being in
	// the frame displace() is written in. It is how a height map goes on any shape: h looks the point up in a texture() by
	// whatever projection suits the shape. h is read at the point of the body's surface that is moved, as a mesh's
	// displacement is; `base = false` reads it where the moved point is instead, which is the same for a projection that
	// does not change along the normal (atan2(y, x) and z on a cylinder, say) and cheaper. Being a field rather than a
	// mesh, a deep displacement cannot fold through itself; it fills in, and where a displaced face meets one that is not,
	// in a corner, it is cut off half way between them -- displace only what is to move, and union the rest outside.
	// `slope` bounds how fast h changes, replacing the steepest found by looking.
	displace: (args, frame) => {
		const f = args.get('f', 0);
		const children = args.children(identityFrame);
		const body = children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
		if (!isClosure(f)) {
			args.warn('displace() needs a function: displace(function(x, y, z) ...)');
			return place(frame, body);
		}
		const sdf = new SDF(body), box = sdf.bounds();
		if (!box || is2d(body)) {
			args.warn(is2d(body) ? 'displace(): a 2-D shape, which has no surface to move' : 'displace() of nothing');
			return empty;
		}
		try {
			const fn = compileDisplacement(f.definition, f.resolver);
			const base = args.bool('base') ?? true;
			// What h is and how steep it gets where the surface is: on a lattice, at the points within reach of the body's
			// surface -- first the body's own, then again as far out as h was found to move it. Between lattice points h can
			// be at most the slope times half a step further out.
			const size = box.size(), N = 32, eps = Math.max(size.x, size.y, size.z) * 1e-4;
			let lo = 0, hi = 0, steepest = 0, step = 0;
			for (let pass = 0; pass < 2; pass++) {
				const grow = Math.max(-lo, hi) * 1.1, min = box.min.sub(float3(grow, grow, grow)), span = box.size().add(float3(2 * grow, 2 * grow, 2 * grow));
				step = span.len() / N;
				for (let i = 0; i <= N; i++)
					for (let j = 0; j <= N; j++)
						for (let k = 0; k <= N; k++) {
							const p = float3(min.x + span.x * i / N, min.y + span.y * j / N, min.z + span.z * k / N);
							const d = sdf.eval(p);
							if (Math.abs(d) > step + grow)
								continue;
							const n = fn.normal || base ? sdf.normal(p, eps) : float3(0, 0, 0);
							const q = base ? p.sub(n.scale(d)) : p;
							const h = fn.value(q.x, q.y, q.z, n.x, n.y, n.z), g = fn.slope(q.x, q.y, q.z, n.x, n.y, n.z);
							if (Number.isFinite(h)) {
								lo = Math.min(lo, h);
								hi = Math.max(hi, h);
							}
							if (Number.isFinite(g))
								steepest = Math.max(steepest, g);
						}
			}
			const slope = args.num('slope') ?? steepest * 1.25;
			lo -= slope * step / 2;
			hi += slope * step / 2;
			const out = Math.max(hi, 0);
			return place(frame, {k: 'displace', fn, lo, hi, slope, base, eps, body,
				box: new Box3(box.min.sub(float3(out, out, out)), box.max.add(float3(out, out, out)))});
		} catch (e) {
			if (!(e instanceof FnError))
				throw e;
			args.warn(`displace(): ${e.message}`);
			return place(frame, body);
		}
	},

	// wrap("cylinder"/"sphere", r = <radius>) bends what is inside it into a revolution about z: its x
	// becomes an arc of r, its y a height up the axis or a latitude, and its z a thickness standing out
	// from the surface of radius r. A cylinder can be given the length of its axis too (h) -- r and h being
	// the surface's two dimensions, as a cylinder primitive has them -- and then the body's own height is
	// fitted to it rather than being it. Being a wrapper is the point: a transform *inside* it is applied to
	// the flat shape before the bend, so `wrap("sphere", r = 50) scale([1, 1, 0.1]) surface("map.png")`
	// thins the relief and leaves the sphere alone, where a scale outside it would flatten the sphere.
	wrap: (args, frame) => {
		const how	= args.str('kind', 0);
		const r		= args.num('r') ?? (args.num('d') ?? 0) / 2;
		const h		= args.num('h');
		if (how !== 'cylinder' && how !== 'sphere')
			args.warn(`wrap(): "${how}", which is neither "cylinder" nor "sphere"`);
		else if (!(r > 0))
			args.warn(`wrap(): "${how}" needs a positive r or d`);
		// a sphere's meridian is a half turn of r whatever its grid, so it has no second dimension to give
		else if (h !== undefined && how === 'sphere')
			args.warn(`wrap(): h, which is the length of a cylinder's axis; a sphere's meridian is pi * r`);
		else if (h !== undefined && !(h > 0))
			args.warn('wrap(): h, which should be a positive length');
		else {
			// children are placed in the *local* frame, as offset()'s and rotate_extrude()'s are: `frame` is
			// applied once, below, to the whole bend. Placing them in `frame` here too would not merely move
			// the result twice -- a bent body's z *is* the radius it stands off r, so the frame's own
			// translate would be folded into that radius, and a translate above the wrap would resize it.
			const children = args.children(identityFrame);
			let body = children.length === 1 ? children[0] : children.length === 0 ? empty : {k: 'union' as const, children};
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

			// (what the general bend takes is the body with all that is done to it: below, `body` is what is under its scales)
			const whole = body;
			let scale = float3(1, 1, 1), turned = false;
			while (body.k === 'material' || body.k === 'domain') {
				if (body.k === 'domain') {
					const m = body.m;
					// a turned grid is not the grid it is, which only the general bend can take
					if (Math.hypot(m.x.y, m.x.z, m.y.x, m.y.z, m.z.x, m.z.y) > 1e-12) {
						turned = true;
						break;
					}
					scale = float3(scale.x * m.x.x, scale.y * m.y.y, scale.z * m.z.z);
				}
				body = body.body;
			}

			if (!turned && body.k === 'heightmap' && !body.wrap) {
				const tiled = body.tiled;
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

				const full_horz = (body.cols - 1) * Math.abs(scale.x) >= 2 * Math.PI * r;
				const full_vert = how === 'cylinder' || (body.rows - 1) * Math.abs(scale.y) >= Math.PI * r;

				const part = !tiled
					&& Math.abs(scale.x) > 0 && Math.abs(scale.x - 1) >= 1e-9
					&& !full_horz
					&& full_vert;

				// The other side of the same case: a scaled grid at least a circumference wide is fitted to the
				// whole turn rather than ending at a meridian, so it is a whole surface again and the scale stops
				// saying how much of it is covered -- exactly as an untiled grid with no scale at all is. The
				// general bend fits it too, but it can only carry the scale of the thinnest of the three axes
				// (see place), so a relief a hundredth as thick as the grid is wide is shaded flat; the fused map
				// is where the columns are a whole turn over cols and the scale is carried exactly.
				const fitted = !tiled && !part
					&& Math.abs(scale.x - 1) >= 1e-9
					&& full_horz
					&& full_vert;

				if (tiled || part || fitted || (Math.abs(scale.x - 1) < 1e-9 && (how === 'cylinder' || Math.abs(scale.y - 1) < 1e-9))) {
					const H		= body.rows - 1;
					const axis	= h ?? H * Math.abs(scale.y);
					const wrap: Wrap = {
						kind:	how,
						r,
						row:	how === 'cylinder' ? axis / Math.max(H, 1) : 1,
						part,
						sx:		Math.abs(scale.x),
						sy:		Math.abs(scale.y),
						tileX:	tiled?.x,
						tileY:	tiled?.y
					};
					const heights = scaleHeightmap(body, scale.z, (!!tiled?.x || part || fitted) && scale.x < 0, how === 'cylinder' && scale.y < 0);
					return place(frame, heightmap(body.cols, body.rows, heights, scale.z * body.bottom, wrap));
				}
			}
			const box = new SDF(whole).bounds();
			if (box)
				return place(frame, {k: 'warp', kind: how, r, box, body: whole, axis: how === 'cylinder' ? h : undefined});

			args.warn(is2d(whole) ? 'wrap(): a 2-D shape, which wants an extrude before it can be bent' : 'wrap() of nothing');
		}
		return empty;
	}

};


//-----------------------------------------------------------------------------
// Env
// A module body's variables, and the modules and functions visible in it. Definitions are hoisted: a module can
// call one defined later in the same scope, as OpenSCAD allows.
//-----------------------------------------------------------------------------


class Env {
	values		= new Map<string, Value>();
	// A scope's own assignments, registered up front by evalScope() but not yet evaluated: OpenSCAD's variables are
	// not sequentially scoped the way a JS block's are, so a module instantiation earlier in the same scope than a
	// variable's assignment still sees its value, and two assignments to the same name in one scope resolve to
	// whichever is textually last, regardless of where any use of the name appears. Resolving lazily on first use
	// (via get()/has(), memoized into `values`) is what gives both of those without evaluating a scope's assignments
	// in some order other than the one that would come from just asking for each name as it's needed.
	pending		= new Map<string, Expr | undefined>();
	modules		= new Map<string, UserModule>();
	functions	= new Map<string, NonNullable<ReturnType<Scope['functions']['get']>>>();

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
			// `pending` (a scope's own assignment) is checked before `values` (what the frame started with) because
			// a module body's assignment may share a name with one of the call's parameters and must win: MCAD's
			// gears, for one, write `clearance = (clearance != undef ? clearance : 0.25 * circular_pitch / pi)`, and
			// that right-hand side has to see the parameter while the assignment replaces it for every later use.
			// OpenSCAD does the same thing by construction -- UserModuleContext applies the arguments first, then
			// ScopeContext::init() runs the body's assignments over them. resolvePending removes the pending entry
			// before evaluating it, so the right-hand side still sees `values`.
			if (e.pending.has(name))
				return e.resolvePending(name, ctx);
			if (e.values.has(name))
				return e.values.get(name);
		}
		return undefined;
	}
	getT<T>(name: string, ctx: Ctx, convert: (v: Value, warn: Warner, what: string) => T | undefined) {
		return convert(this.get(name, ctx), ctx, name);
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
	// What a call by name means, as OpenSCAD's lookup_function finds it: the nearest scope that has one, and within a
	// scope a `function name(...)` before a variable of that name holding a function literal. A variable that holds
	// anything else is not callable and the search goes on outward.
	findCallable(name: string, ctx: Ctx): FunctionDefinition | Closure | undefined {
		for (let e: Env | undefined = this; e; e = e.parent) {
			const f = e.functions.get(name);
			if (f)
				return f;
			if (e.values.has(name) || e.pending.has(name)) {
				const v = e.get(name, ctx);
				if (isClosure(v))
					return v;
			}
		}
	}

	evalExpr(expr: Expr | undefined, ctx: Ctx): Value {
		if (expr === undefined || expr === null)
			return undefined;

		switch (expr.type) {
			case 'literal':
				return expr.value;// as Value;

			case 'identifier': {
				const name = expr.name;
				if (!this.has(name) && !name.startsWith('$'))
					ctx.warn(`'${name}' is used before it is assigned`);
				return this.get(name, ctx);
			}

			case 'vector': {
				const out: Value[] = [];
				for (const x of expr.value)
					pushComprehension(x, this, ctx, out);
				return out;
			}

			case 'funcdef':
				return {closure: true, 
					definition:	expr,
					resolver: {
						get: (name: string) => this.get(name, ctx),
						findFunction: (name: string) => {
							const f = this.findCallable(name, ctx);
							return f && isClosure(f) ? f.texture ?? f.definition : f;
						}
					},
					call: (env: Env, args: Assignment[]): Value => {
						const call = new Env(this);
						let pi = 0;
						const pos = positional(args);
						for (const p of expr.parameters) {
							const named = args.find(a => a.name === p.name);
							call.values.set(p.name, named ? env.evalExpr(named.expr, ctx)
								: pi < pos.length ? env.evalExpr(pos[pi++].expr, ctx)
								: p.expr ? call.evalExpr(p.expr, ctx) : undefined);
						}
						return call.evalExpr(expr.expr, ctx);
					}
				};

			case 'range': {
				const begin = num(this.evalExpr(expr.begin, ctx), ctx, 'a range bound') ?? 0;
				const end	= num(this.evalExpr(expr.end, ctx), ctx, 'a range bound') ?? 0;
				const step	= expr.step === undefined ? 1 : num(this.evalExpr(expr.step, ctx), ctx, 'a range step') ?? 1;
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
				const v = this.evalExpr(expr.operand, ctx);
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
				const left = this.evalExpr(expr.left, ctx);
				if (expr.operator === '&&')
					return truthy(left) && truthy(this.evalExpr(expr.right, ctx));
				if (expr.operator === '||')
					return truthy(left) || truthy(this.evalExpr(expr.right, ctx));
				return binary(expr.operator, left, this.evalExpr(expr.right, ctx), ctx);
			}

			case 'conditional':
				return truthy(this.evalExpr(expr.test, ctx)) ? this.evalExpr(expr.consequent, ctx) : this.evalExpr(expr.alternate, ctx);

			case 'let': {
				const inner = new Env(this);
				bindArguments(expr.arguments, inner, ctx);
				return inner.evalExpr(expr.expr, ctx);
			}

			case 'echo': case 'assert': {
				const values = (expr.arguments ?? []).map(x => this.evalExpr(x.expr, ctx));
				if (expr.type === 'echo')
					console.log('ECHO:', values.map(show).join(' '));
				return expr.expr === undefined ? undefined : this.evalExpr(expr.expr, ctx);
			}

			case 'arraylookup': {
				const array = this.evalExpr(expr.array, ctx), index = this.evalExpr(expr.index, ctx);
				if (!isList(array))
					return undefined;
				const i = num(index, ctx, 'an index');
				return i === undefined ? undefined : array[i < 0 ? array.length + i : i];
			}

			case 'call': {
				const name = expr.callee.type === 'identifier' ? expr.callee.name : undefined;
				if (name !== undefined)
					return this.callFunction(name, expr.arguments ?? [], ctx);
				const callee = this.evalExpr(expr.callee, ctx);
				if (isClosure(callee))
					return callee.call(this, expr.arguments ?? []);
				ctx.warn('a call to something other than a named function');
				return undefined;
			}

			case 'functioncall':
				return this.callFunction(expr.name, expr.arguments ?? [], ctx);

			case 'memberlookup':
				ctx.warn('a member lookup');
				return undefined;

			default:
				ctx.warn(`'${(expr as {type: string}).type}' is not evaluated`);
				return undefined;
		}
	}
/*
	private callClosure(c: Closure, args: Assignment[], ctx: Ctx): Value {
		const call = new Env(c.env as Env);
		let pi = 0;
		const pos = positional(args);
		for (const p of c.parameters) {
			const named = args.find(a => a.name === p.name);
			call.values.set(p.name, named ? this.evalExpr(named.expr, ctx)
				: pi < pos.length ? this.evalExpr(pos[pi++].expr, ctx)
				: p.expr ? call.evalExpr(p.expr, ctx) : undefined);
		}
		return call.evalExpr(c.expr, ctx);
	}
*/
	private callFunction(name: string, args: Assignment[], ctx: Ctx): Value {
		const found = this.findCallable(name, ctx);
		if (found && isClosure(found))
			return found.call(this, args);
		const user = found;
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
		const builtin = builtin_functions[name];
		if (builtin)
			return builtin(argGetter({args} as Inst, this, ctx));
		ctx.warn(`the function '${name}'`);
		return undefined;
	}

	// A scope's modules and functions, and its assignments (registered lazily), made visible; returns its module
	// instantiations in the order written.
	//
	// OpenSCAD evaluates a scope's assignments before any of its instantiations (ScopeContext::init), so a variable is
	// its last assignment in the scope wherever it is read from, and a $variable is no exception: `$fn = 3; sphere();
	// $fn = 64; sphere();` makes both spheres smooth. Resolving each name lazily on first use (Env.get/resolvePending)
	// gives that, and lets one assignment read another written below it. The parser has already merged two
	// assignments to a name into one, so there is nothing here to order.
	declare(scope: Scope): Inst[] {
		for (const [name, mod] of scope.modules)
			this.modules.set(name, mod);
		for (const [name, fn] of scope.functions)
			this.functions.set(name, fn);
		for (const a of scope.assignments)
			this.pending.set(a.name, a.expr);
		return scope.moduleInstantiations;
	}
}

// evalScope's own statement list, before it is combined into the one shape a scope normally means. Split out
// so a for loop or an if/else can hand its statements up to whatever contains *them* as separate siblings
// (see instantiateList) instead of pre-combining into a union no matter what that container is -- the same
// list this union-wraps when a scope is asked for as one shape on its own.
function evalScopeList(env: Env, scope: Scope, frame: Frame, ctx: Ctx): Sdf[] {
	const out: Sdf[] = [];
	for (const inst of env.declare(scope)) {
		// A scope that sets no `$` variable that colours adds no node at all. Each piece a for/if statement splices in
		// gets the same wrap, since they all see the same ambient material.
		const mat = ambientMaterial(env, ctx);

		// what this one statement amounts to -- almost always one shape, but a for loop's iterations or an
		// if/else's taken branch are splices of several, so they are collected here and appended below
		const pieces: Sdf[] = [];
		if (inst instanceof IfElseModuleInstantiation) {
			const taken = truthy(env.evalExpr(inst.expr, ctx)) ? inst.scope : inst.else_scope;
			if (taken)
				pieces.push(...evalScopeList(new Env(env), taken, frame, ctx));
		} else if (inst.modname === 'for') {
			const innerscope = inst.scope;
			forEachIteration(argGetter(inst, env, ctx), inner => pieces.push(...evalScopeList(inner, innerscope, frame, ctx)));
		} else {
			pieces.push(instantiate(env, inst, frame, ctx));
		}

		for (const body of pieces)
			out.push(body.k === 'material' || sameMaterial(mat, DEFAULT_MATERIAL) ? body : {k: 'material' as const, mat, body});
	}
	return out;
}

function evalScope(env: Env, scope: Scope, frame: Frame, ctx: Ctx): Sdf {
	const out = evalScopeList(env, scope, frame, ctx);
	return out.length === 0 ? empty : out.length === 1 ? out[0] : {k: 'union', children: out};
}


function instantiate(env: Env, inst: Inst, frame: Frame, ctx: Ctx): Sdf {
	// if / else: only the branch taken is built, so a dead branch cannot fail on what it mentions
	if (inst instanceof IfElseModuleInstantiation) {
		const taken = truthy(env.evalExpr(inst.expr, ctx)) ? inst.scope : inst.else_scope;
		return taken ? evalScope(new Env(env), taken, frame, ctx) : empty;
	}

	const name	= inst.modname ?? '';
	const scope	= inst.scope;
	const args	= argGetter(inst, env, ctx);

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
		ctx.children.push({scope, env: env});
		ctx.moduleStack.push(name);
		const body = evalScope(call, user.body, frame, ctx);
		ctx.moduleStack.pop();
		ctx.children.pop();
		return body;
	}

	const builtin = builtin_modules[name];
	if (builtin)
		return builtin(args, frame);

	ctx.warn(`the module '${name}', which is not drawn`);
	return empty;
}

//-----------------------------------------------------------------------------
// curves
//-----------------------------------------------------------------------------
// A run of curve vertices from a begin to an end, as the curve format has them (see curveVertex): the first vertex
// begins it, the last is on the curve, and between are lines' on-curve points and cubics' two off-curve points.
type Curve = curveVertex[];

// Contours as a flat shape, kept as curves as a font's glyphs are -- a circle or an arc is exact up to a tolerance, not
// segments. `curves` are cubics and lines (see Curve); the fill is even-odd, so an outline inside another is a hole.
function curvePath(curves: Curve, center: boolean): Sdf {
	const box	= float2.extent.from(curves.map(v => float2(v.x, v.y)));
	let curve	= bezier2Curve(curves, 1e-4 * Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 1e-3));
	if (center) {
		const mid = box.centre();
		curve = curve.map(v => curveVertex(v.x - mid.x, v.y - mid.y, v.flags));
	}
	return {k: 'curvepath2', paths: curve};
}

// Curves joined at their ends into outlines, as DxfData joins them: ends are snapped to a grid (to an occupied
// neighbouring cell if there is one, which is how nearly-meeting ends meet), open paths are walked from their loose
// ends first, and whatever is left forms closed loops. A closed loop does not repeat its first point, as the format
// closes a contour itself.
function joinCurves(curves: Curve[], GRID = 0.0009765625): {curve: Curve, closed: boolean}[] {
	const cells = new Map<string, number[]>();
	const snap	= (p: {x: number, y: number}) => {
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

	const lines = curves.filter(c => c.length >= 2).map((curve, i) => {
		const ends = [snap(curve[0]), snap(curve[curve.length - 1])];
		for (const e of ends)
			cells.set(e.key, [...cells.get(e.key) ?? [], i]);
		return {curve, ends};
	});

	const done = new Array<boolean>(lines.length).fill(false);
	// the curve of `line`, from its end `from`, with both its ends where they snapped to
	const oriented = (line: number, from: number) => {
		const {curve, ends} = lines[line];
		const out = curve.slice();
		if (from !== 0)
			out.reverse();
		out[0]				= curveVertex(ends[from].at.x, ends[from].at.y, ON_BEGIN);
		out[out.length - 1] = curveVertex(ends[1 - from].at.x, ends[1 - from].at.y, ON_CURVE);
		return out;
	};
	const walk = (line: number, from: number, closed: boolean) => {
		const out = oriented(line, from);
		for (let l: number | undefined = line, f = from; ; ) {
			const end: {key: string, at: float2} = lines[l].ends[1 - f];
			done[l] = true;
			const next: number | undefined = cells.get(end.key)!.find(k => !done[k]);
			if (next === undefined)
				break;
			f = lines[next].ends[0].key === end.key ? 0 : 1;
			out.push(...oriented(next, f).slice(1));
			l = next;
		}
		if (closed)
			out.pop();
		return {curve: out, closed};
	};

	const paths: {curve: Curve, closed: boolean}[] = [];
	// an open path starts at an end no other line shares, and which is not its own other end
	for (let again = true; again; ) {
		again = false;
		for (let i = 0; i < lines.length && !again; i++)
			for (let j = 0; j < 2 && !done[i] && !again; j++)
				if (lines[i].ends[0].key !== lines[i].ends[1].key && cells.get(lines[i].ends[j].key)!.every(k => k === i || done[k])) {
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
	return args.ctx.openFile(module, written, args.filename(), 'dxf', bytes => {
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

// What a drawing's entity amounts to as curves, each point carried through `mat` (the placement of the entity's own
// space in the result's, so a block's entities compose the INSERT's into it). An arc or an ellipse is cubic pieces of
// at most an eighth of a turn -- exact to a millionth of its size, and exact under any `mat`, a shear or an unequal
// scale included. An entity OpenSCAD cannot draw is reported through `warn`, when there is one.
function dxfRender(doc: dwg.DXF, e: dwg.Obj, curves: Curve[], mat: float2x3, warn?: (message: string) => void, depth = 0) {
	const to2	= (p: {x: number, y: number}) => mat.mulPos(float2(p.x, p.y));
	const vert	= (p: float2, flags: number) => curveVertex(p.x, p.y, flags);

	// the ellipse centre + major cos(t) + minor sin(t), from t = from over `sweep` radians
	const ellipse = (centre: float2, major: float2, minor: float2, from: number, sweep: number) => {
		const at	= (t: number) => centre.add(major.scale(Math.cos(t))).add(minor.scale(Math.sin(t)));
		const slope	= (t: number) => minor.scale(Math.cos(t)).sub(major.scale(Math.sin(t)));
		const n		= Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 4) - 1e-9));
		const step	= sweep / n, k = 4 / 3 * Math.tan(step / 4);
		const curve: Curve = [vert(mat.mulPos(at(from)), ON_BEGIN)];
		for (let i = 0; i < n; i++) {
			const t0 = from + step * i, t1 = t0 + step;
			curve.push(
				vert(mat.mulPos(at(t0).add(slope(t0).scale(k))), OFF_BEZ3),
				vert(mat.mulPos(at(t1).sub(slope(t1).scale(k))), OFF_BEZ3),
				vert(mat.mulPos(at(t1)), ON_CURVE),
			);
		}
		curves.push(curve);
	};

	if (e instanceof dwg.DRW_LINE) {
		curves.push([vert(to2(e.point1), ON_BEGIN), vert(to2(e.point2), ON_CURVE)]);

	} else if (e instanceof dwg.DRW_LWPOLYLINE) {
		const verts = e.vertlist.map(to2);
		if (e.closed && verts.length > 1)
			verts.push(verts[0]);
		curves.push(verts.map((p, i) => vert(p, i ? ON_CURVE : ON_BEGIN)));

	} else if (e instanceof dwg.DRW_ARC) {
		let end = e.angle1;
		while (e.angle0 > end)
			end += 2 * Math.PI;
		const r = e.radius;
		ellipse(float2(e.centre.x, e.centre.y), float2(r, 0), float2(0, r), e.angle0, end - e.angle0);

	} else if (e instanceof dwg.DRW_CIRCLE) {
		const r = e.radius;
		ellipse(float2(e.centre.x, e.centre.y), float2(r, 0), float2(0, r), 0, 2 * Math.PI);

	} else if (e instanceof dwg.DRW_ELLIPSE) {
		let end = e.angle1;
		while (e.angle0 > end)
			end += 2 * Math.PI;
		// point2 is the major axis from the centre, and ratio the minor's share of it
		const major = float2(e.point2.x, e.point2.y);
		ellipse(float2(e.point1.x, e.point1.y), major, float2(-major.y, major.x).scale(e.ratio), e.angle0, end - e.angle0);

	} else if (e instanceof dwg.DRW_INSERT) {
		const block = doc.blocks.get(e.block_name ?? '');
		// a block drawn inside itself would never end; OpenSCAD cannot see one, as it reads blocks in file order
		if (!block || depth > 32)
			return;

		const a		= e.angle, s = e.scale;
		const inner = mat.mulAffine(float2x3(
			float2(Math.cos(a) * s.x, Math.sin(a) * s.x),
			float2(-Math.sin(a) * s.y, Math.cos(a) * s.y),
			float2(e.base_point.x, e.base_point.y)
		));
		for (const b of block.entities)
			dxfRender(doc, b, curves, inner, warn, depth + 1);

	} else if (warn && !/^DRW_(DIM|TEXT|MTEXT|POINT)/.test(e.constructor.name)) {
		warn(`import(): a ${e.constructor.name.replace(/^DRW_/, '')} in the drawing, which is not drawn`);
	}
}

// dxf_cross(): where the first two single lines of the layer cross
function dxfCross(args: argGetter): Value {
	const doc	= loadDXF('dxf_cross', args);
	if (!doc)
		return undefined;

	const pieces: Curve[] = [];

	const origin	= args.vec2('origin') ?? float2(0, 0);
	const scale		= args.num('scale') ?? 1;
	const top		= float2x3(float2(scale, 0), float2(0, scale), origin.scale(-scale));
	const layer		= args.str('layer');

	for (const e of doc.entities.filter(e => !layer || (e instanceof dwg.Entity && e.layer === layer)))
		dxfRender(doc, e, pieces, top);

	// the lines that stand alone
	const [a, b]	= joinCurves(pieces).filter(p => !p.closed && p.curve.length === 2).map(p => p.curve.map(v => float2(v.x, v.y)));
	const dem		= b && (b[1].y - b[0].y) * (a[1].x - a[0].x) - (b[1].x - b[0].x) * (a[1].y - a[0].y);
	if (!dem) {
		args.warn('dxf_cross(): no two lines that cross');
		return undefined;
	}
	const ua = ((b[1].x - b[0].x) * (a[0].y - b[0].y) - (b[1].y - b[0].y) * (a[0].x - b[0].x)) / dem;
	return [a[0].x + ua * (a[1].x - a[0].x), a[0].y + ua * (a[1].y - a[0].y)];
}

//-----------------------------------------------------------------------------
// entry
//-----------------------------------------------------------------------------

export interface Evaluated {
	sdf:		Sdf;
	warnings:	string[];
	camera: {vpt?: [number, number, number], vpr?: [number, number, number], vpd?: number, vpf?: number};
}

// `use <file>` makes a library's modules and functions available without drawing its geometry or importing its
// variables, unlike `include <file>` -- which the parser already splices in as if typed in place, so it needs no
// handling here. `file.usedlibs` holds each used path already resolved against the file that named it (or, if it
// could not be found, the path as written, which `files.read` below then fails on and this reports as a warning).
// A library's own `use`s are loaded too, each path read at most once; a name already bound -- by this file, or by
// a library asked for earlier -- is left alone, so the first (most local) definition wins.
function loadUsedLibraries(file: {path: string, usedlibs: string[]}, files: ScadFiles | undefined, env: Env, ctx: Ctx, seen: Set<string>) {
	if (!files)
		return;
	for (const path of file.usedlibs) {
		if (seen.has(path))
			continue;
		seen.add(path);
		let text: string;
		try {
			text = files.read(path, 'text', bytes => new TextDecoder('utf-8').decode(bytes)) ?? '';
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
function rootDefaults(values: Record<string, Value>): Env {
	const defaults = new Env();
	defaults.values = new Map(Object.entries({
		'PI':		Math.PI,
		'$fn':		0,
		'$fa': 		12,
		'$fs': 		2,
		'$t': 		0,
		...values,
		//'$vpt': 	[0, 0, 0],
		//'$vpr': 	[55, 0, 25],
		//'$vpd': 	140,
		//'$vpf': 	22.5,
	}));
	return defaults;
}

// `preview` is false only for a final export (see exportStl()): OpenSCAD's own $preview, which a file may use to
// skip a preview-only simplification, since here that step -- unlike a re-evaluation on a moved camera -- is one
// this viewer already always pays for.
export function evaluate(file: SourceFile, filename: string, files: ScadFiles, values: Record<string, Value>) {
	const env		= new Env(rootDefaults(values));
	const ctx		= new Ctx(files, filename);
	loadUsedLibraries(file, files, env, ctx, new Set([filename]));

	const sdf		= new SDF(evalScope(env, file.scope, identityFrame, ctx));
	let box		= sdf.bounds();
	if (!box && values.$entry) {
		const inst = new Inst(values.$entry as string);
		sdf.root = instantiate(env, inst, identityFrame, ctx,)
		box		= sdf.bounds();
	}

	const size		= box ? box.size().len() : 0;
	const center	= box ? box.centre() : float3(0, 0, 0);
	const vpf		= env.getT('$vpf', ctx, num) ?? 22.5;

	const camera = {
		vpt: env.getT('$vpt', ctx, maybe(vec3)) ?? center,
		vpr: env.getT('$vpr', ctx, maybe(vec3)) ?? float3(0, 0, 0),
		vpd: env.getT('$vpd', ctx, num) ?? size / Math.sin(rad(vpf)) * 1.1,
		vpf,
	};
	return {sdf, box, warnings: ctx.list, camera};
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
	surface_fn:			['f', 'x', 'y', 'bottom', 'zmax', 'slope'],
	implicit_fn:		['f', 'x', 'y', 'z', 'lipschitz'],
	displace:			['f', 'base', 'slope'],
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
const CSG_LEAVES = new Set(['cube', 'sphere', 'cylinder', 'circle', 'square', 'polygon', 'polyhedron', 'text', 'import', 'surface', 'surface_fn', 'implicit_fn']);

function csgNumber(n: number) {
	return Number.isNaN(n) ? 'nan' : !Number.isFinite(n) ? (n < 0 ? '-inf' : 'inf') : String(parseFloat(n.toPrecision(12)));
}

function csgValue(v: Value): string {
	return typeof v === 'number'	? csgNumber(v)
		: typeof v === 'string'		? JSON.stringify(v)
		: typeof v === 'boolean'	? String(v)
		: isList(v)					? '[' + v.map(csgValue).join(', ') + ']'
		: isClosure(v)				? 'function'
		: 'undef';
}

function csgScope(scope: Scope, env: Env, ctx: Ctx, out: string[], depth: number) {
	for (const inst of env.declare(scope))
		csgInstance(inst, env, ctx, out, depth);
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
	const args		= argGetter(inst, env, ctx);

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
			block('group()', d => forEachIteration(args, it => csgScope(scope, it, ctx, out, d)));
			return;

		case 'intersection_for':
			block('intersection()', d => forEachIteration(args, it => block('group()', d2 => csgScope(scope, it, ctx, out, d2))));
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
export function evaluateCsg(code: string, filename: string, files: ScadFiles) {
	const file	= parse(code, filename, files);
	const env	= new Env(rootDefaults({$preview: false}));
	const ctx	= new Ctx(files, filename);
	loadUsedLibraries(file, files, env, ctx, new Set([filename]));
	const out: string[] = [];
	csgScope(file.scope, env, ctx, out, 0);
	return {csg: out.join('\n') + '\n', warnings: ctx.list};
}
