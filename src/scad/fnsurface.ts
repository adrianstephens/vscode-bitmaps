// Functional surfaces: a scad function of a point, kept as a function rather than sampled into a grid. The body of
// `function(x, y) ...` is compiled once into a DAG of scalar operations, which is then written out twice -- as glsl for
// the raymarcher, and as JS for everything that has no GPU (the mesher, measuring, picking). Both come from the same
// DAG, so they differ only in the arithmetic of the machine running them.
//
// The compiler is a partial evaluator, not an interpreter: whatever it can know while compiling (constants, the scad
// variables the function closes over, vectors of any length, comprehensions over constant ranges, calls to other
// user functions) is resolved then, so the DAG that is left holds only the operations on x, y and z -- which is what
// makes it small enough to run at every raymarch step. Vectors never reach the DAG: they are arrays of scalar nodes
// while compiling, and `norm`, `dot`, `cross` and the arithmetic on them expand to scalar operations.
//
// A raymarcher needs a distance and a scalar field F gives only a value, so the DAG is also differentiated (symbolically,
// per variable) to turn F into the first-order distance estimate F / |grad F|. That is exact for a plane and close
// where the field is smooth; where it is not, a bound the user states (`slope`, `lipschitz`) replaces the estimate.
import type { Assignment, Expr, FunctionDefinition } from './parser';

// What the compiler needs of the scope a function was written in. The evaluator supplies it (a function value, its
// Closure, lives in evaluate.ts), so this file needs nothing from there at run time.
export interface Resolver {
	get(name: string): unknown;							// a variable's value
	findFunction(name: string): FunctionDefinition | Texture | undefined;	// what a call of that name means: a `function name(...) = ...`, a variable holding a function literal, or one holding a texture()
}

//-----------------------------------------------------------------------------
// images
//-----------------------------------------------------------------------------

// An image a function can look colours up in: texture("file.png") is called as img(u, v), u and v 0..1 across it, and
// gives [r, g, b, a]. Its pixels are rows of rgba from the bottom up (v = 0 is the image's last row), and it either
// repeats or holds its edges beyond 0..1. The shader's texSample (sdflib.frag) reads the same layout from the batch texture.
export class Texture {
	constructor(readonly width: number, readonly height: number, readonly rgba: Float32Array, readonly repeat: boolean) {}

	// the image at (u, v) between the pixels' centres (which = 0), or its rate of change along u (1) or v (2)
	at(u: number, v: number, which = 0): number[] {
		const w = this.width, h = this.height;
		const x = u * w - 0.5, y = v * h - 0.5, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
		const wrap = (k: number, n: number) => this.repeat ? ((k % n) + n) % n : Math.min(Math.max(k, 0), n - 1);
		const at = (di: number, dj: number) => (wrap(j + dj, h) * w + wrap(i + di, w)) * 4;
		const a = at(0, 0), b = at(1, 0), c = at(0, 1), d = at(1, 1), px = this.rgba;
		return [0, 1, 2, 3].map(k => {
			const A = px[a + k], B = px[b + k], C = px[c + k], D = px[d + k];
			return which === 0 ? (A + (B - A) * fx) * (1 - fy) + (C + (D - C) * fx) * fy
				: which === 1 ? ((B - A) * (1 - fy) + (D - C) * fy) * w
				: ((C - A) * (1 - fx) + (D - B) * fx) * h;
		});
	}
}

// Where what is written finds a texture: an index into the array a JS function is made with, or the texel of the batch
// texture the shader's copy starts at
export type TexturePlace = (t: Texture) => number;
const NO_TEXTURES: TexturePlace = () => { throw new Error('a texture with nowhere to be read from'); };

//-----------------------------------------------------------------------------
// the DAG
//-----------------------------------------------------------------------------

export class FnError extends Error {}

interface Const	{ t: 'c'; id: number; v: number }
interface Var	{ t: 'v'; id: number; name: 'x' | 'y' | 'z' | 'nx' | 'ny' | 'nz' }
interface Op	{ t: 'o'; id: number; op: string; a: Node[]; tex?: Texture; ch?: number }	// tex and ch: a lookup's image and channel (see Dag.texture)
export type Node = Const | Var | Op;

const D = Math.PI / 180;
const LN10 = Math.LN10;

interface OpDef {
	n:		number;
	f:		(...a: number[]) => number;			// the fold of constants
	js:		(a: string[]) => string;
	glsl:	(a: string[]) => string;
}

const same = (s: (a: string[]) => string): Pick<OpDef, 'js' | 'glsl'> => ({js: s, glsl: s});
const infix = (o: string) => same(a => `(${a[0]} ${o} ${a[1]})`);
const bool = (o: string, js = o) => ({js: (a: string[]) => `(${a[0]} ${js} ${a[1]} ? 1 : 0)`, glsl: (a: string[]) => `float(${a[0]} ${o} ${a[1]})`});

const OPS: Record<string, OpDef> = {
	add:	{n: 2, f: (a, b) => a + b, ...infix('+')},
	sub:	{n: 2, f: (a, b) => a - b, ...infix('-')},
	mul:	{n: 2, f: (a, b) => a * b, ...infix('*')},
	div:	{n: 2, f: (a, b) => a / b, ...infix('/')},
	// scad's % keeps the sign of the dividend, as JS does; glsl's mod() does not, so it is spelt out
	mod:	{n: 2, f: (a, b) => a % b, js: a => `(${a[0]} % ${a[1]})`, glsl: a => `(${a[0]} - ${a[1]} * trunc(${a[0]} / ${a[1]}))`},
	neg:	{n: 1, f: a => -a, ...same(a => `(-${a[0]})`)},
	pow:	{n: 2, f: Math.pow, js: a => `Math.pow(${a[0]}, ${a[1]})`, glsl: a => `pow(${a[0]}, ${a[1]})`},
	// scad's trigonometry is in degrees
	sin:	{n: 1, f: a => Math.sin(a * D), js: a => `Math.sin(${a[0]} * ${D})`, glsl: a => `sin(${a[0]} * ${D})`},
	cos:	{n: 1, f: a => Math.cos(a * D), js: a => `Math.cos(${a[0]} * ${D})`, glsl: a => `cos(${a[0]} * ${D})`},
	tan:	{n: 1, f: a => Math.tan(a * D), js: a => `Math.tan(${a[0]} * ${D})`, glsl: a => `tan(${a[0]} * ${D})`},
	asin:	{n: 1, f: a => Math.asin(a) / D, js: a => `(Math.asin(${a[0]}) / ${D})`, glsl: a => `degrees(asin(${a[0]}))`},
	acos:	{n: 1, f: a => Math.acos(a) / D, js: a => `(Math.acos(${a[0]}) / ${D})`, glsl: a => `degrees(acos(${a[0]}))`},
	atan:	{n: 1, f: a => Math.atan(a) / D, js: a => `(Math.atan(${a[0]}) / ${D})`, glsl: a => `degrees(atan(${a[0]}))`},
	atan2:	{n: 2, f: (a, b) => Math.atan2(a, b) / D, js: a => `(Math.atan2(${a[0]}, ${a[1]}) / ${D})`, glsl: a => `degrees(atan(${a[0]}, ${a[1]}))`},
	sqrt:	{n: 1, f: Math.sqrt, js: a => `Math.sqrt(${a[0]})`, glsl: a => `sqrt(${a[0]})`},
	abs:	{n: 1, f: Math.abs, js: a => `Math.abs(${a[0]})`, glsl: a => `abs(${a[0]})`},
	sign:	{n: 1, f: Math.sign, js: a => `Math.sign(${a[0]})`, glsl: a => `sign(${a[0]})`},
	floor:	{n: 1, f: Math.floor, js: a => `Math.floor(${a[0]})`, glsl: a => `floor(${a[0]})`},
	ceil:	{n: 1, f: Math.ceil, js: a => `Math.ceil(${a[0]})`, glsl: a => `ceil(${a[0]})`},
	// half away from zero, as scad's round() is; glsl's own round() goes to even
	round:	{n: 1, f: a => Math.sign(a) * Math.floor(Math.abs(a) + 0.5), js: a => `(Math.sign(${a[0]}) * Math.floor(Math.abs(${a[0]}) + 0.5))`, glsl: a => `(sign(${a[0]}) * floor(abs(${a[0]}) + 0.5))`},
	exp:	{n: 1, f: Math.exp, js: a => `Math.exp(${a[0]})`, glsl: a => `exp(${a[0]})`},
	ln:		{n: 1, f: Math.log, js: a => `Math.log(${a[0]})`, glsl: a => `log(${a[0]})`},
	log:	{n: 1, f: a => Math.log(a) / LN10, js: a => `(Math.log(${a[0]}) / ${LN10})`, glsl: a => `(log(${a[0]}) / ${LN10})`},
	min:	{n: 2, f: Math.min, js: a => `Math.min(${a[0]}, ${a[1]})`, glsl: a => `min(${a[0]}, ${a[1]})`},
	max:	{n: 2, f: Math.max, js: a => `Math.max(${a[0]}, ${a[1]})`, glsl: a => `max(${a[0]}, ${a[1]})`},
	lt:		{n: 2, f: (a, b) => +(a < b),	...bool('<')},
	le:		{n: 2, f: (a, b) => +(a <= b),	...bool('<=')},
	gt:		{n: 2, f: (a, b) => +(a > b),	...bool('>')},
	ge:		{n: 2, f: (a, b) => +(a >= b),	...bool('>=')},
	eq:		{n: 2, f: (a, b) => +(a === b),	...bool('==', '===')},
	ne:		{n: 2, f: (a, b) => +(a !== b),	...bool('!=', '!==')},
	and:	{n: 2, f: (a, b) => +(a !== 0 && b !== 0), js: a => `((${a[0]} !== 0 && ${a[1]} !== 0) ? 1 : 0)`, glsl: a => `float(${a[0]} != 0.0 && ${a[1]} != 0.0)`},
	or:		{n: 2, f: (a, b) => +(a !== 0 || b !== 0), js: a => `((${a[0]} !== 0 || ${a[1]} !== 0) ? 1 : 0)`, glsl: a => `float(${a[0]} != 0.0 || ${a[1]} != 0.0)`},
	not:	{n: 1, f: a => +(a === 0), js: a => `(${a[0]} === 0 ? 1 : 0)`, glsl: a => `float(${a[0]} == 0.0)`},
	sel:	{n: 3, f: (c, a, b) => c !== 0 ? a : b, js: a => `(${a[0]} !== 0 ? ${a[1]} : ${a[2]})`, glsl: a => `(${a[0]} != 0.0 ? ${a[1]} : ${a[2]})`},
};

// Nodes are shared by structure, so a subexpression written twice is computed once, and so is the same derivative
// reached by two routes -- which is most of what keeps the differentiated DAG from blowing up.
class Dag {
	private nodes	= new Map<string, Node>();
	private count	= 0;
	readonly x		= this.make<Var>(`v:x`, id => ({t: 'v', id, name: 'x'}));
	readonly y		= this.make<Var>(`v:y`, id => ({t: 'v', id, name: 'y'}));
	readonly z		= this.make<Var>(`v:z`, id => ({t: 'v', id, name: 'z'}));
	readonly zero	= this.num(0);
	readonly one	= this.num(1);
	private memo	= new Map<string, Node>();

	private make<T extends Node>(key: string, build: (id: number) => T): T {
		let n = this.nodes.get(key) as T | undefined;
		if (!n) {
			n = build(this.count++);
			this.nodes.set(key, n);
		}
		return n;
	}

	get size() { return this.count; }

	// a channel of an image at (u, v) -- its value ('tex'), or its rate of change along u or v ('texdu', 'texdv'). Known u
	// and v are looked up now.
	texture(tex: Texture, op: 'tex' | 'texdu' | 'texdv', ch: number, u: Node, v: Node): Node {
		if (u.t === 'c' && v.t === 'c')
			return this.num(tex.at(u.v, v.v, op === 'tex' ? 0 : op === 'texdu' ? 1 : 2)[ch]);
		const key = `o:${op}:${this.textureId(tex)}:${ch}:${u.id},${v.id}`;
		return this.make<Op>(key, id => ({t: 'o', id, op, a: [u, v], tex, ch}));
	}
	private textures = new Map<Texture, number>();
	private textureId(tex: Texture) {
		let id = this.textures.get(tex);
		if (id === undefined)
			this.textures.set(tex, id = this.textures.size);
		return id;
	}

	// the surface normal's components, which only a colour or a displacement asks for, so they are made when it does
	normal(): Var[] {
		return (['nx', 'ny', 'nz'] as const).map(name => this.make<Var>(`v:${name}`, id => ({t: 'v', id, name})));
	}

	num(v: number): Node {
		// -0 and 0 are one constant; an infinity or a NaN is kept out of the shader, where it has no spelling
		if (v === 0)
			v = 0;
		return this.make<Const>(`c:${Object.is(v, NaN) ? 'nan' : v}`, id => ({t: 'c', id, v}));
	}

	op(op: string, ...a: Node[]): Node {
		const def = OPS[op];
		if (a.every(n => n.t === 'c'))
			return this.num(def.f(...a.map(n => (n as Const).v)));

		const isc = (n: Node, v: number) => n.t === 'c' && n.v === v;
		switch (op) {
			case 'add':
				if (isc(a[0], 0)) return a[1];
				if (isc(a[1], 0)) return a[0];
				break;
			case 'sub':
				if (isc(a[1], 0)) return a[0];
				if (isc(a[0], 0)) return this.op('neg', a[1]);
				break;
			case 'mul':
				if (isc(a[0], 0) || isc(a[1], 0)) return this.zero;
				if (isc(a[0], 1)) return a[1];
				if (isc(a[1], 1)) return a[0];
				if (isc(a[0], -1)) return this.op('neg', a[1]);
				if (isc(a[1], -1)) return this.op('neg', a[0]);
				break;
			case 'div':
				if (isc(a[1], 1)) return a[0];
				if (isc(a[0], 0)) return this.zero;
				break;
			case 'neg':
				if (a[0].t === 'o' && a[0].op === 'neg') return a[0].a[0];
				break;
			case 'sel':
				if (a[0].t === 'c') return a[0].v !== 0 ? a[1] : a[2];
				if (a[1] === a[2]) return a[1];
				break;
		}
		const key = `o:${op}:${a.map(n => n.id).join(',')}`;
		return this.make<Op>(key, id => ({t: 'o', id, op, a}));
	}

	// a power with an integer exponent is a product, which is exact for a negative base, and for every exponent
	// the same on the GPU and here; only a fractional one is left to pow()
	pow(a: Node, b: Node): Node {
		if (b.t === 'c' && Number.isInteger(b.v) && Math.abs(b.v) <= 32) {
			let n = Math.abs(b.v), base = a, out: Node | undefined;
			while (n > 0) {
				if (n & 1)
					out = out ? this.op('mul', out, base) : base;
				n >>= 1;
				if (n)
					base = this.op('mul', base, base);
			}
			out ??= this.one;
			return b.v < 0 ? this.op('div', this.one, out) : out;
		}
		return this.op('pow', a, b);
	}

	//-------------------------------------------------------------------------
	// symbolic differentiation with respect to one of x, y, z
	//-------------------------------------------------------------------------

	d(n: Node, v: Var): Node {
		if (n.t === 'c')
			return this.zero;
		if (n.t === 'v')
			return n === v ? this.one : this.zero;

		const key = `${n.id}/${v.id}`;
		let r = this.memo.get(key);
		if (!r) {
			r = this.deriv(n, v);
			this.memo.set(key, r);
		}
		return r;
	}

	private deriv(n: Op, v: Var): Node {
		const op = (o: string, ...a: Node[]) => this.op(o, ...a);
		const k = (c: number) => this.num(c);
		const [a, b] = n.a;
		const da = () => this.d(a, v), db = () => this.d(b, v);
		switch (n.op) {
			case 'add':		return op('add', da(), db());
			case 'sub':		return op('sub', da(), db());
			case 'neg':		return op('neg', da());
			case 'mul':		return op('add', op('mul', da(), b), op('mul', a, db()));
			case 'div':		return op('div', op('sub', op('mul', da(), b), op('mul', a, db())), op('mul', b, b));
			// the remainder moves with its dividend, and with the divisor by a whole number of steps that is the same on either side
			case 'mod':		return op('sub', da(), op('mul', db(), op('sel', op('lt', op('div', a, b), this.zero), op('ceil', op('div', a, b)), op('floor', op('div', a, b)))));
			case 'pow': {
				// the base alone varies where the exponent is a constant, the usual case; d(a^b) = a^b (b' ln a + b a' / a) otherwise
				if (b.t === 'c')
					return op('mul', op('mul', b, this.pow(a, k(b.v - 1))), da());
				return op('mul', n, op('add', op('mul', db(), op('ln', a)), op('div', op('mul', b, da()), a)));
			}
			case 'sin':		return op('mul', op('mul', op('cos', a), k(D)), da());
			case 'cos':		return op('mul', op('mul', op('sin', a), k(-D)), da());
			case 'tan': {
				const c = op('cos', a);
				return op('mul', op('div', k(D), op('mul', c, c)), da());
			}
			case 'asin':	return op('mul', op('div', k(1 / D), op('sqrt', op('sub', this.one, op('mul', a, a)))), da());
			case 'acos':	return op('mul', op('div', k(-1 / D), op('sqrt', op('sub', this.one, op('mul', a, a)))), da());
			case 'atan':	return op('mul', op('div', k(1 / D), op('add', this.one, op('mul', a, a))), da());
			// atan2(y, x): (x y' - y x') / (x^2 + y^2), in degrees
			case 'atan2':	return op('mul', op('div', op('sub', op('mul', b, da()), op('mul', a, db())), op('add', op('mul', a, a), op('mul', b, b))), k(1 / D));
			case 'sqrt':	return op('div', da(), op('mul', k(2), n));
			case 'abs':		return op('mul', op('sign', a), da());
			case 'exp':		return op('mul', n, da());
			case 'ln':		return op('div', da(), a);
			case 'log':		return op('div', da(), op('mul', a, k(LN10)));
			case 'min':		return op('sel', op('lt', a, b), da(), db());
			case 'max':		return op('sel', op('gt', a, b), da(), db());
			case 'sel':		return op('sel', a, this.d(n.a[1], v), this.d(n.a[2], v));
			// a lookup is bilinear, so its slope is the cell's; the slope's own slope is taken as none
			case 'tex':		return op('add', op('mul', this.texture(n.tex!, 'texdu', n.ch!, a, b), da()), op('mul', this.texture(n.tex!, 'texdv', n.ch!, a, b), db()));
			// stepwise, comparisons and logic: no slope
			default:		return this.zero;
		}
	}
}

//-----------------------------------------------------------------------------
// writing the DAG out
//-----------------------------------------------------------------------------

// every operation reachable from the root, operands before the operations that use them
function order(root: Node): Op[] {
	const seen = new Set<Node>(), out: Op[] = [];
	const stack: [Node, boolean][] = [[root, false]];
	while (stack.length) {
		const [n, done] = stack.pop()!;
		if (n.t !== 'o')
			continue;
		if (done) {
			out.push(n);
			continue;
		}
		if (seen.has(n))
			continue;
		seen.add(n);
		stack.push([n, true]);
		for (let i = n.a.length; i--;)
			stack.push([n.a[i], false]);
	}
	return out;
}

function number(v: number, glsl: boolean): string {
	if (Number.isNaN(v))
		return glsl ? '(0.0 / 0.0)' : 'NaN';
	if (!Number.isFinite(v))
		v = Math.sign(v) * 1e30;
	let s = String(v);
	if (glsl && !/[.e]/.test(s))
		s += '.0';
	return v < 0 ? `(${s})` : s;
}

function write(root: Node | Node[], glsl: boolean, place = NO_TEXTURES): string[] {
	const roots = Array.isArray(root) ? root : [root];
	const name = (n: Node): string => n.t === 'c' ? number(n.v, glsl) : n.t === 'v' ? n.name : `t${n.id}`;
	const type = glsl ? 'float ' : 'const ';
	const seen = new Set<Op>(), lines: string[] = [];
	// the channels of one lookup are one fetch of all four, written once
	const fetched = new Map<string, string>();
	for (const r of roots)
		for (const n of order(r))
			if (!seen.has(n)) {
				seen.add(n);
				if (n.tex) {
					const t = n.tex, which = n.op === 'tex' ? 0 : n.op === 'texdu' ? 1 : 2, [u, v] = n.a.map(name);
					const key = `${place(t)}:${which}:${u}:${v}`;
					let s = fetched.get(key);
					if (!s) {
						fetched.set(key, s = `s${n.id}`);
						lines.push(glsl
							? `vec4 ${s} = texSample(${place(t)}, ${t.width}, ${t.height}, ${t.repeat ? 1 : 0}, ${which}, ${u}, ${v});`
							: `const ${s} = T[${place(t)}].at(${u}, ${v}, ${which});`);
					}
					lines.push(`${type}${name(n)} = ${s}[${n.ch}];`);
					continue;
				}
				const def = OPS[n.op];
				lines.push(`${type}${name(n)} = ${(glsl ? def.glsl : def.js)(n.a.map(name))};`);
			}
	// a single root is `res`; several are r0, r1, ...
	if (!Array.isArray(root))
		return lines.concat([`${glsl ? 'float' : 'const'} res = ${name(root)};`]);
	return lines.concat(roots.map((r, i) => `${glsl ? 'float' : 'const'} r${i} = ${name(r)};`));
}

// A JS function of the point and the normal, of what `write` makes of root, ending with `ret`; the textures it reads are
// handed to it as T
function build<F>(root: Node | Node[], ret: string): F {
	const textures: Texture[] = [];
	const body = write(root, false, t => textures.includes(t) ? textures.indexOf(t) : textures.push(t) - 1);
	return new Function('T', `return function(x, y, z, nx, ny, nz) {\n${body.join('\n')}\n${ret}\n};`)(textures);
}

//-----------------------------------------------------------------------------
// the function itself
//-----------------------------------------------------------------------------

// A field F(x, y, z), solid where F < 0, and the distance estimate made from it
export class FieldFn {
	private js?:	(x: number, y: number, z: number) => number;
	private raw?:	(x: number, y: number, z: number) => number;
	private slope?:	(x: number, y: number, z: number) => number;

	constructor(private field: Node, private dist: Node, public nodes: number, private gradient?: Node) {}

	// The steepest the field gets inside a box, by looking at a lattice of n points a side: the length of its gradient,
	// which is what the field's rate of change is. A lattice can step over a narrow steep place, so the answer is only
	// a good guess, and what uses it as a bound leaves some room.
	steepest(min: [number, number, number], max: [number, number, number], n: number): number | undefined {
		if (!this.gradient)
			return undefined;
		this.slope ??= this.build(this.gradient, false);
		let worst = 0;
		const at = (i: number, k: number) => min[k] + (max[k] - min[k]) * i / n;
		// an axis the box has no extent along is looked at once
		const ni = n, nj = n, nl = max[2] > min[2] ? n : 0;
		for (let i = 0; i <= ni; i++)
			for (let j = 0; j <= nj; j++)
				for (let l = 0; l <= nl; l++) {
					const g = this.slope(at(i, 0), at(j, 1), at(l, 2));
					if (Number.isFinite(g))
						worst = Math.max(worst, g);
				}
		return worst;
	}

	// the estimated distance to the surface, which is negative inside: the field's value over its gradient's length
	distance(x: number, y: number, z: number): number {
		this.js ??= this.build(this.dist);
		return this.js(x, y, z);
	}

	// the field itself
	value(x: number, y: number, z: number): number {
		this.raw ??= this.build(this.field, false);
		return this.raw(x, y, z);
	}

	private build(root: Node, guard = true) {
		return build<(x: number, y: number, z: number) => number>(root, `return ${guard ? 'Number.isNaN(res) ? 1e20 : res' : 'res'};`);
	}

	// a glsl function `float name(vec3 p)`, of the distance estimate
	glsl(name: string, place: TexturePlace): string {
		const body = write(this.dist, true, place).map(l => '\t' + l);
		return `float ${name}(vec3 p) {\n\tfloat x = p.x, y = p.y, z = p.z;\n${body.join('\n')}\n\treturn isnan(res) ? 1e20 : res;\n}`;
	}
}

type CV = Node | CV[];

class Scope {
	vars = new Map<string, CV>();
	constructor(public parent?: Scope) {}
	get(name: string): CV | undefined {
		for (let s: Scope | undefined = this; s; s = s.parent)
			if (s.vars.has(name))
				return s.vars.get(name);
	}
}

const MAX_DEPTH		= 200;
const MAX_UNROLL	= 512;

class Compiler {
	dag = new Dag();
	private depth = 0;

	constructor(private resolver: Resolver) {}

	//---- values

	private fromValue(v: unknown, what: string): CV {
		if (typeof v === 'number')	return this.dag.num(v);
		if (typeof v === 'boolean')	return this.dag.num(v ? 1 : 0);
		if (Array.isArray(v))		return v.map(i => this.fromValue(i, what));
		throw new FnError(`${what} is not a number or a vector of them`);
	}

	private scalar(v: CV, what: string): Node {
		if (Array.isArray(v))
			throw new FnError(`${what} is a vector where a number is needed`);
		return v;
	}

	private constant(v: CV, what: string): number {
		const n = this.scalar(v, what);
		if (n.t !== 'c')
			throw new FnError(`${what} has to be known when the function is compiled, not depend on x, y or z`);
		return n.v;
	}

	private lift(a: CV, b: CV, f: (a: Node, b: Node) => Node, what: string): CV {
		if (Array.isArray(a) && Array.isArray(b)) {
			if (a.length !== b.length)
				throw new FnError(`'${what}' between vectors of different lengths`);
			return a.map((x, i) => this.lift(x, b[i], f, what));
		}
		if (Array.isArray(a) || Array.isArray(b))
			throw new FnError(`'${what}' between a vector and a number`);
		return f(a, b);
	}

	private map(a: CV, f: (n: Node) => Node): CV {
		return Array.isArray(a) ? a.map(x => this.map(x, f)) : f(a);
	}

	private dot(a: CV, b: CV): Node {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			throw new FnError('a dot product of things that are not vectors of the same length');
		let sum: Node = this.dag.zero;
		for (let i = 0; i < a.length; i++)
			sum = this.dag.op('add', sum, this.dag.op('mul', this.scalar(a[i], 'a component'), this.scalar(b[i], 'a component')));
		return sum;
	}

	//---- expressions

	expr(e: Expr | undefined, s: Scope): CV {
		if (e === undefined || e === null)
			throw new FnError('an expression with no value');
		if (++this.depth > MAX_DEPTH)
			throw new FnError('the function is nested too deeply (is it recursive? it cannot be)');
		try {
			return this.expr1(e, s);
		} finally {
			this.depth--;
		}
	}

	private expr1(e: Expr, s: Scope): CV {
		const dag = this.dag;
		switch (e.type) {
			case 'literal':
				if (typeof e.value === 'number' || typeof e.value === 'boolean')
					return this.fromValue(e.value, 'a literal');
				throw new FnError(`${e.value === undefined ? 'undef' : 'a string'} is not a number`);

			case 'identifier': {
				const local = s.get(e.name);
				if (local !== undefined)
					return local;
				if (e.name === 'PI')
					return dag.num(Math.PI);
				const v = this.resolver.get(e.name);
				if (v === undefined)
					throw new FnError(`'${e.name}' is not defined where the function is`);
				return this.fromValue(v, `'${e.name}'`);
			}

			case 'vector': {
				const out: CV[] = [];
				for (const x of e.value)
					this.comprehension(x, s, out);
				return out;
			}

			case 'unary': {
				const v = this.expr(e.operand, s);
				switch (e.operator) {
					case '-':	return this.map(v, n => dag.op('neg', n));
					case '+':	return v;
					case '!':	return dag.op('not', this.scalar(v, "the operand of '!'"));
				}
				throw new FnError(`the operator '${e.operator}' cannot be used in a function surface`);
			}

			case 'binary':
				return this.binary(e.operator, this.expr(e.left, s), () => this.expr(e.right, s));

			case 'conditional': {
				const c = this.scalar(this.expr(e.test, s), 'the condition');
				if (c.t === 'c')
					return this.expr(c.v !== 0 ? e.consequent : e.alternate, s);
				const a = this.expr(e.consequent, s), b = this.expr(e.alternate, s);
				return this.lift(a, b, (x, y) => dag.op('sel', c, x, y), '?:');
			}

			case 'let': {
				const inner = new Scope(s);
				this.bind(e.arguments, inner);
				return this.expr(e.expr, inner);
			}

			case 'echo': case 'assert':
				return this.expr(e.expr, s);

			case 'arraylookup': {
				const a = this.expr(e.array, s);
				const i = this.constant(this.expr(e.index, s), 'an index');
				if (!Array.isArray(a))
					throw new FnError('an index into something that is not a vector');
				const at = i < 0 ? a.length + i : i;
				if (!(at >= 0 && at < a.length))
					throw new FnError(`the index ${i} is outside a vector of ${a.length}`);
				return a[Math.floor(at)];
			}

			case 'memberlookup': {
				const a = this.expr(e.expr, s);
				const i = 'xyzw'.indexOf(e.member);
				if (!Array.isArray(a) || i < 0 || i >= a.length)
					throw new FnError(`'.${e.member}' of something that has no such component`);
				return a[i];
			}

			case 'functioncall':
				return this.call(e.name, e.arguments ?? [], s);

			case 'call':
				if (e.callee.type === 'identifier')
					return this.call(e.callee.name, e.arguments ?? [], s);
				throw new FnError('a call to something other than a named function');

			case 'funcdef':
				throw new FnError('a function value inside a function surface');
			case 'range':
				throw new FnError('a range outside a for');
			default:
				throw new FnError(`'${(e as {type: string}).type}' cannot be used in a function surface`);
		}
	}

	private bind(args: Assignment[], into: Scope) {
		for (const a of args)
			if (a.name)
				into.vars.set(a.name, this.expr(a.expr, into));
	}

	private binary(op: string, l: CV, right: () => CV): CV {
		const dag = this.dag;
		const arith = (name: string) => this.lift(l, right(), (a, b) => dag.op(name, a, b), op);
		switch (op) {
			case '+':	return arith('add');
			case '-':	return arith('sub');
			case '%':	return arith('mod');
			case '^':	return this.lift(l, right(), (a, b) => dag.pow(a, b), op);
			case '*': {
				const r = right();
				if (Array.isArray(l) && Array.isArray(r)) {
					// vector . vector is a number; matrix * vector is the vector of each row's dot with it
					if (l.length && Array.isArray(l[0]) && !Array.isArray(r[0]))
						return l.map(row => this.dot(row, r));
					return this.dot(l, r);
				}
				return Array.isArray(l) ? this.map(l, n => dag.op('mul', n, r as Node))
					: Array.isArray(r) ? this.map(r, n => dag.op('mul', l, n))
					: dag.op('mul', l, r);
			}
			case '/': {
				const r = this.scalar(right(), 'the divisor');
				return this.map(l, n => dag.op('div', n, r));
			}
			case '<': case '<=': case '>': case '>=': case '==': case '!=': {
				const name = {'<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne'}[op]!;
				return dag.op(name, this.scalar(l, `the left of '${op}'`), this.scalar(right(), `the right of '${op}'`));
			}
			case '&&': {
				const a = this.scalar(l, "the left of '&&'");
				if (a.t === 'c' && a.v === 0)
					return dag.zero;
				return dag.op('and', a, this.scalar(right(), "the right of '&&'"));
			}
			case '||': {
				const a = this.scalar(l, "the left of '||'");
				if (a.t === 'c' && a.v !== 0)
					return dag.one;
				return dag.op('or', a, this.scalar(right(), "the right of '||'"));
			}
		}
		throw new FnError(`the operator '${op}' cannot be used in a function surface`);
	}

	//---- comprehensions, unrolled: a range has to be known now

	private budget = 0;

	private comprehension(e: Expr, s: Scope, out: CV[]) {
		switch (e.type) {
			case 'lcfor': {
				const loop = (i: number, scope: Scope) => {
					if (i === e.args.length) {
						this.comprehension(e.expr, scope, out);
						return;
					}
					const a = e.args[i];
					for (const v of this.iterate(a.expr, scope)) {
						if (++this.budget > MAX_UNROLL)
							throw new FnError(`a loop that unrolls to more than ${MAX_UNROLL} steps`);
						const inner = new Scope(scope);
						inner.vars.set(a.name, v);
						loop(i + 1, inner);
					}
				};
				loop(0, s);
				return;
			}
			case 'lcif': {
				const c = this.constant(this.expr(e.cond, s), 'the condition of an if inside a vector');
				if (c !== 0)
					this.comprehension(e.ifexpr, s, out);
				else if (e.elseexpr !== undefined)
					this.comprehension(e.elseexpr, s, out);
				return;
			}
			case 'lceach': {
				const v = this.expr(e.expr, s);
				if (!Array.isArray(v))
					throw new FnError('each of something that is not a vector');
				out.push(...v);
				return;
			}
			case 'lcletp': {
				const inner = new Scope(s);
				this.bind(e.args, inner);
				this.comprehension(e.expr, inner, out);
				return;
			}
			case 'let': {
				const inner = new Scope(s);
				this.bind(e.arguments, inner);
				this.comprehension(e.expr, inner, out);
				return;
			}
			case 'lcforc':
				throw new FnError('a C-style for inside a vector');
			default:
				out.push(this.expr(e, s));
		}
	}

	private iterate(e: Expr | undefined, s: Scope): CV[] {
		if (e?.type === 'range') {
			const begin = this.constant(this.expr(e.begin, s), 'a range bound');
			const end = this.constant(this.expr(e.end, s), 'a range bound');
			const step = e.step === undefined ? 1 : this.constant(this.expr(e.step, s), 'a range step');
			const out: CV[] = [];
			if (step === 0)
				return out;
			for (let v = begin; step > 0 ? v <= end + 1e-9 : v >= end - 1e-9; v += step) {
				if (out.length > MAX_UNROLL)
					throw new FnError(`a range of more than ${MAX_UNROLL} steps`);
				out.push(this.dag.num(v));
			}
			return out;
		}
		const v = this.expr(e, s);
		if (!Array.isArray(v))
			throw new FnError('a for over something that is not a range or a vector');
		return v;
	}

	//---- calls

	private args(args: Assignment[], s: Scope): {pos: CV[], named: Map<string, CV>} {
		const pos: CV[] = [], named = new Map<string, CV>();
		for (const a of args) {
			const v = this.expr(a.expr, s);
			if (a.name)
				named.set(a.name, v);
			else
				pos.push(v);
		}
		return {pos, named};
	}

	private call(name: string, args: Assignment[], s: Scope): CV {
		const dag = this.dag;

		// a function of the file's shadows a builtin of the same name, as it does in scad
		const target = this.resolver.findFunction(name);
		if (target instanceof Texture) {
			// img(u, v) or img([u, v]): the four channels there
			const {pos} = this.args(args, s);
			const uv = pos.length === 1 && Array.isArray(pos[0]) ? pos[0] : pos;
			if (uv.length < 2)
				throw new FnError(`${name}() is a texture, which is looked up at (u, v)`);
			const u = this.scalar(uv[0], `the u of ${name}()`), v = this.scalar(uv[1], `the v of ${name}()`);
			return [0, 1, 2, 3].map(ch => this.dag.texture(target, 'tex', ch, u, v));
		}
		if (target) {
			const {pos, named} = this.args(args, s);
			const inner = new Scope();
			let pi = 0;
			for (const p of target.parameters)
				inner.vars.set(p.name, named.get(p.name) ?? (pi < pos.length ? pos[pi++] : p.expr ? this.expr(p.expr, inner) : undefined) as CV);
			for (const [k, v] of [...inner.vars])
				if (v === undefined)
					inner.vars.delete(k);
			return this.expr(target.expr, inner);
		}

		const {pos} = this.args(args, s);
		const num = (i: number) => this.scalar(pos[i] ?? (() => { throw new FnError(`${name}() is missing an argument`); })(), `an argument of ${name}()`);
		const one = (op: string) => dag.op(op, num(0));

		switch (name) {
			case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
			case 'sqrt': case 'abs': case 'sign': case 'floor': case 'ceil': case 'round': case 'exp': case 'ln': case 'log':
				return one(name);
			case 'atan2':	return dag.op('atan2', num(0), num(1));
			case 'pow':		return dag.pow(num(0), num(1));
			case 'min': case 'max': {
				const all = pos.length === 1 && Array.isArray(pos[0]) ? pos[0] : pos;
				if (!all.length)
					throw new FnError(`${name}() of nothing`);
				return all.map(v => this.scalar(v, `an argument of ${name}()`)).reduce((a, b) => dag.op(name, a, b));
			}
			case 'norm': {
				const v = pos[0];
				if (!Array.isArray(v))
					throw new FnError('norm() of something that is not a vector');
				return dag.op('sqrt', this.dot(v, v));
			}
			case 'dot':		return this.dot(pos[0], pos[1]);
			case 'cross': {
				const a = pos[0], b = pos[1];
				if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 2 || a.length > 3)
					throw new FnError('cross() of things that are not 2- or 3-vectors of the same length');
				const m = (i: number, j: number) => dag.op('mul', this.scalar(a[i], 'a component'), this.scalar(b[j], 'a component'));
				const sub = (p: Node, q: Node) => dag.op('sub', p, q);
				return a.length === 2 ? sub(m(0, 1), m(1, 0)) : [sub(m(1, 2), m(2, 1)), sub(m(2, 0), m(0, 2)), sub(m(0, 1), m(1, 0))];
			}
			case 'len':
				if (Array.isArray(pos[0]))
					return dag.num(pos[0].length);
				throw new FnError('len() of something that is not a vector');
			case 'sum': {
				const v = pos[0];
				if (!Array.isArray(v))
					throw new FnError('sum() of something that is not a vector');
				return v.map(i => this.scalar(i, 'a component')).reduce((a, b) => dag.op('add', a, b), dag.zero);
			}
		}
		throw new FnError(`the function '${name}' cannot be used in a function surface`);
	}

	//---- entry

	bindParameters(parameters:	Assignment[], count: number, vars: Node[] = [this.dag.x, this.dag.y, this.dag.z]): Scope {
		const s = new Scope();
		if (parameters.length < count)
			throw new FnError(`the function takes ${parameters.length} parameter${parameters.length === 1 ? '' : 's'}, and needs ${count}`);
		parameters.slice(0, count).forEach((p, i) => s.vars.set(p.name, vars[i]));
		return s;
	}
}

export interface FieldOptions {
	kind:		'height' | 'implicit';
	// a bound the field is trusted to obey instead of the gradient's estimate: the height field's steepest slope,
	// or the implicit field's greatest rate of change
	bound?:		number;
	// how big the shape is (half its largest side). With a bound, this says how close to the surface the field is
	// the gradient's own estimate rather than the bound's: see compileField.
	size?:		number;
}

// How cautious the estimate is: a first-order distance is exact only to first order, and a raymarcher that steps all
// of it can pass through a thin or sharply curved part of the surface
const SAFETY = 0.7;
// the smallest gradient an implicit field's estimate will divide by, so a flat spot is not an infinite step
const FLAT = 1e-2;
// Within NEAR of the shape's size of the surface the field is its gradient's estimate, and beyond FAR of it the
// bound's, with a blend between. A bound that is safe far away is too short close to the surface -- it can be a
// fraction of the true distance -- and the marcher's offsets off a surface (a hair outside it to start the next ray)
// assume the field there is about the distance: with a short one a ray leaving the surface hits it again at once,
// from the wrong side, and is shaded black. The gradient is accurate that close; it is only far away it can overshoot.
const NEAR = 0.01, FAR = 0.05;
// how much of the gradient's estimate is believed close to the surface
const NEAR_SAFETY = 0.85;

// A height field `z = f(x, y)` has the field F = z - f; an implicit surface has F = f(x, y, z) itself. Both are solid
// where F < 0, and F / |grad F| is the distance estimate (which for a height field is (z - f) / sqrt(1 + |grad f|^2)).
export function compileField(definition: FunctionDefinition, resolver: Resolver, options: FieldOptions): FieldFn {
	const c = new Compiler(resolver);
	const dag = c.dag;
	const height = options.kind === 'height';
	const result = c.expr(definition.expr, c.bindParameters(definition.parameters, height ? 2 : 3));
	if (Array.isArray(result))
		throw new FnError('the function gives a vector where a number is needed');
	if (result.t === 'c' && !Number.isFinite(result.v))
		throw new FnError('the function is not a number');

	const field = height ? dag.op('sub', dag.z, result) : result;
	let scale: Node, gradient: Node | undefined;
	const gradientLength = () => {
		const g = [dag.x, dag.y, dag.z].map(v => dag.d(field, v as Var));
		return dag.op('sqrt', g.reduce((s, n) => dag.op('add', s, dag.op('mul', n, n)), dag.zero));
	};
	if (options.bound === undefined) {
		const len = gradient = gradientLength();
		scale = dag.op('mul', dag.op('max', len, dag.num(height ? 1 : FLAT)), dag.num(1 / SAFETY));
	} else {
		const far = dag.num(height ? Math.sqrt(1 + options.bound * options.bound) : options.bound);
		if (options.size === undefined)
			scale = far;
		else {
			// the gradient's estimate near the surface, no less than a quarter of the bound's so a flat spot cannot give a
			// long step, blended into the bound's by how far (by the bound's own measure) the surface is
			const near = dag.op('max', dag.op('div', gradientLength(), dag.num(NEAR_SAFETY)), dag.op('mul', far, dag.num(0.25)));
			const away = dag.op('div', dag.op('abs', field), far);
			const w = dag.op('min', dag.op('max', dag.op('div', dag.op('sub', away, dag.num(NEAR * options.size)), dag.num((FAR - NEAR) * options.size)), dag.zero), dag.one);
			scale = dag.op('add', near, dag.op('mul', dag.op('sub', far, near), w));
		}
	}
	return new FieldFn(field, dag.op('div', field, scale), dag.size, gradient);
}

// A colour that is a function of the point: function(x, y, z) [r, g, b], in the frame the color() was written in, or
// function(x, y, z, nx, ny, nz) to have the surface's unit normal there too, in that frame as well. `local` carries a
// point of the model's own frame into that one -- three rows of an affine map, each [a, b, c, d] for a x + b y + c z + d
// -- and `normal` (three rows [a, b, c]) a normal, so a colour written on a shape that is moved, turned or scaled moves with it.
export class ColorFn {
	private js?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number[];
	constructor(private roots: Node[]) {}

	// the colour at a point of the model's frame, where the surface's normal is n, each component clamped to 0..1
	at(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0): [number, number, number] {
		this.js ??= build(this.roots, `return [${this.roots.map((_, i) => `r${i}`).join(', ')}];`);
		const c = this.js!(x, y, z, nx, ny, nz);
		return [0, 1, 2].map(i => Math.min(Math.max(Number.isNaN(c[i]) ? 0 : c[i], 0), 1)) as [number, number, number];
	}

	// `vec3 name(vec3 p, vec3 n)`, p and the unit normal n in the model's frame
	glsl(name: string, place: TexturePlace): string {
		const body = write(this.roots, true, place).map(l => '\t' + l);
		const c = this.roots.map((_, i) => `r${i}`);
		return `vec3 ${name}(vec3 p, vec3 n) {\n\tfloat x = p.x, y = p.y, z = p.z, nx = n.x, ny = n.y, nz = n.z;\n${body.join('\n')}\n\treturn clamp(vec3(${c.join(', ')}), 0.0, 1.0);\n}`;
	}
}

export function compileColor(definition: FunctionDefinition, resolver: Resolver, local: number[][], normal: number[][]): ColorFn {
	const c = new Compiler(resolver);
	const dag = c.dag;
	const sum = (terms: Node[]) => terms.reduce((s, n) => dag.op('add', s, n), dag.zero);
	const point = local.map(([a, b, cc, d]) => sum([dag.op('mul', dag.num(a), dag.x), dag.op('mul', dag.num(b), dag.y), dag.op('mul', dag.num(cc), dag.z), dag.num(d)]));
	const count = Math.min(Math.max(definition.parameters.length, 3), 6);
	let vars = point;
	if (count > 3) {
		const n = dag.normal();
		const turned = normal.map(row => sum(row.map((k, i) => dag.op('mul', dag.num(k), n[i]))));
		// a turn, or a turn and the same scale every way, keeps the normal's length to a constant; anything else is
		// measured where it is
		const len2 = normal.map(r => r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
		const dot = (i: number, j: number) => normal[i][0] * normal[j][0] + normal[i][1] * normal[j][1] + normal[i][2] * normal[j][2];
		const rigid = Math.abs(len2[1] - len2[0]) < 1e-9 * len2[0] && Math.abs(len2[2] - len2[0]) < 1e-9 * len2[0]
			&& [dot(0, 1), dot(0, 2), dot(1, 2)].every(d => Math.abs(d) < 1e-9 * len2[0]);
		const len = rigid ? dag.num(Math.sqrt(len2[0])) : dag.op('sqrt', sum(turned.map(t => dag.op('mul', t, t))));
		vars = [...point, ...turned.map(t => dag.op('div', t, len))];
	}
	const result = c.expr(definition.expr, c.bindParameters(definition.parameters, count, vars));
	if (!Array.isArray(result) || result.length < 3 || result.slice(0, 3).some(n => Array.isArray(n)))
		throw new FnError('a colour function gives [r, g, b], three numbers');
	return new ColorFn(result.slice(0, 3) as Node[]);
}

// displace()'s function: function(x, y, z) h, or function(x, y, z, nx, ny, nz) h to have the body's unit normal there
// too -- how far the surface moves out along its normal (in, where h is negative), in the frame displace() is written in.
// The slope of h is what bounds the step a raymarcher can take over the moved surface; it is the slope with the point
// alone, the normal held still, so it says nothing of how fast a normal-dependent h changes round an edge.
export class DisplaceFn {
	private js?:	(x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
	private grad?:	(x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
	constructor(private h: Node, private gradient: Node, readonly normal: boolean) {}

	value(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0): number {
		this.js ??= build(this.h, 'return res;');
		return this.js!(x, y, z, nx, ny, nz);
	}

	// the length of h's gradient
	slope(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0): number {
		this.grad ??= build(this.gradient, 'return res;');
		return this.grad!(x, y, z, nx, ny, nz);
	}

	// `float name(vec3 p, vec3 n)`
	glsl(name: string, place: TexturePlace): string {
		const body = write(this.h, true, place).map(l => '\t' + l);
		return `float ${name}(vec3 p, vec3 n) {\n\tfloat x = p.x, y = p.y, z = p.z, nx = n.x, ny = n.y, nz = n.z;\n${body.join('\n')}\n\treturn isnan(res) ? 0.0 : res;\n}`;
	}
}

export function compileDisplacement(definition: FunctionDefinition, resolver: Resolver): DisplaceFn {
	const c = new Compiler(resolver);
	const dag = c.dag;
	const count = Math.min(Math.max(definition.parameters.length, 3), 6);
	const h = c.expr(definition.expr, c.bindParameters(definition.parameters, count, [dag.x, dag.y, dag.z, ...count > 3 ? dag.normal() : []]));
	if (Array.isArray(h))
		throw new FnError('a displacement gives a number, how far the surface moves');
	const g = [dag.x, dag.y, dag.z].map(v => dag.d(h, v as Var));
	return new DisplaceFn(h, dag.op('sqrt', g.reduce((s, n) => dag.op('add', s, dag.op('mul', n, n)), dag.zero)), count > 3);
}
