// Evaluates the GLSL that sdf.ts generates, so the field the shader will actually compute can be compared with the
// JS mirror point by point. It is not a GLSL implementation: it covers the subset the generator emits (floats,
// vec2/vec3, mat3, the builtins it calls, blocks, if, return) with glsl's own rules for the operators, including
// mat3 built from columns.
const TYPES = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4']);

function tokenize(src) {
	const out = [];
	const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\|)|([-+*\/(){}[\];,.<>?:!=])/g;
	let m;
	while ((m = re.exec(src))) {
		if (m[1] !== undefined) out.push({k: 'num', v: parseFloat(m[1])});
		else if (m[2] !== undefined) out.push({k: 'id', v: m[2]});
		else if (m[3] !== undefined) out.push({k: 'op', v: m[3]});
		else if (m[4] !== undefined) out.push({k: 'op', v: m[4]});
	}
	return out;
}

//--- parser -------------------------------------------------------------------

function parse(src) {
	const t = tokenize(src);
	let i = 0;
	const peek = (n = 0) => t[i + n];
	const at = (v) => peek() && (peek().v === v);
	// the token position and what is around it, because "expected =, got (" on its own says nothing about which of
	// a page of glsl it happened in
	const eat = (v) => {
		if (!at(v))
			throw new Error(`expected ${v}, got ${peek() ? peek().v : 'end'} at token ${i} of ${t.length}: ` +
				t.slice(Math.max(0, i - 8), i + 4).map(x => x.v).join(' '));
		return t[i++];
	};
	const eatId = () => { if (!peek() || peek().k !== 'id') throw new Error('expected a name'); return t[i++].v; };

	function expr() { return ternary(); }
	function ternary() {
		const c = binary(0);
		return at('?') ? (eat('?'), {k: 'cond', c, a: expr(), b: (eat(':'), expr())}) : c;
	}
	const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/']];
	function binary(level) {
		if (level >= LEVELS.length)
			return unary();
		let left = binary(level + 1);
		while (peek() && peek().k === 'op' && LEVELS[level].includes(peek().v))
			left = {k: 'bin', op: t[i++].v, a: left, b: binary(level + 1)};
		return left;
	}
	function unary() {
		if (at('-') || at('!'))
			return {k: 'un', op: t[i++].v, a: unary()};
		return postfix();
	}
	function postfix() {
		let e = primary();
		for (;;) {
			if (at('.')) {
				eat('.');
				e = {k: 'swizzle', of: e, v: eatId()};
			} else
				break;
		}
		return e;
	}
	function primary() {
		if (at('(')) {
			eat('(');
			const e = expr();
			eat(')');
			return e;
		}
		if (peek() && peek().k === 'num')
			return {k: 'num', v: t[i++].v};
		if (peek() && peek().k === 'id') {
			const name = t[i++].v;
			if (at('(')) {
				eat('(');
				const args = [];
				if (!at(')'))
					do { args.push(expr()); } while (at(',') && (eat(','), true));
				eat(')');
				return {k: 'call', name, args};
			}
			return {k: 'id', name};
		}
		throw new Error(`unexpected ${peek() ? peek().v : 'end'}`);
	}

	function statement() {
		if (at('{')) {
			eat('{');
			const body = [];
			while (!at('}'))
				body.push(statement());
			eat('}');
			return {k: 'block', body};
		}
		if (at('if')) {
			eat('if');
			eat('(');
			const c = expr();
			eat(')');
			const a = statement();
			return at('else') ? (eat('else'), {k: 'if', c, a, b: statement()}) : {k: 'if', c, a};
		}
		if (at('for')) {
			eat('for');
			eat('(');
			const init = at(';') ? null : forInit();
			eat(';');
			const cond = expr();
			eat(';');
			const step = forStep();
			eat(')');
			return {k: 'for', init, cond, step, body: statement()};
		}
		if (at('break')) {
			eat('break');
			eat(';');
			return {k: 'break'};
		}
		if (at('continue')) {
			eat('continue');
			eat(';');
			return {k: 'continue'};
		}
		if (at('return')) {
			eat('return');
			const v = expr();
			eat(';');
			return {k: 'return', v};
		}
		if (peek() && peek().k === 'id' && TYPES.has(peek().v) && peek(1) && peek(1).k === 'id') {
			const type = t[i++].v;
			const decls = [];
			do {
				const name = eatId();
				decls.push({name, v: at('=') ? (eat('='), expr()) : null});
			} while (at(',') && (eat(','), true));
			eat(';');
			return {k: 'decl', type, decls};
		}
		const target = eatId();
		// a compound assignment, which the tokenizer splits into two operators
		const compound = (at('+') || at('-') || at('*') || at('/')) && peek(1) && peek(1).v === '=' ? t[i++].v : null;
		eat('=');
		const v = expr();
		eat(';');
		return compound ? {k: 'compound', name: target, op: compound, v} : {k: 'assign', name: target, v};
	}

	// a for header's initialiser, which is a declaration or an assignment
	function forInit() {
		if (peek() && peek().k === 'id' && TYPES.has(peek().v) && peek(1) && peek(1).k === 'id') {
			const type = t[i++].v;
			const decls = [];
			do {
				const name = eatId();
				decls.push({name, v: at('=') ? (eat('='), expr()) : null});
			} while (at(',') && (eat(','), true));
			return {k: 'decl', type, decls};
		}
		const name = eatId();
		eat('=');
		return {k: 'assign', name, v: expr()};
	}

	// a for header's step, which is ++i, i++ (the tokenizer splits those into two operators), or an assignment
	function forStep() {
		if ((at('+') || at('-')) && peek(1) && peek(1).v === peek().v) {
			const delta = t[i++].v === '+' ? 1 : -1;
			i++;
			return {k: 'inc', name: eatId(), delta};
		}
		const name = eatId();
		if ((at('+') || at('-')) && peek(1) && peek(1).v === peek().v) {
			const delta = t[i++].v === '+' ? 1 : -1;
			i++;
			return {k: 'inc', name, delta};
		}
		eat('=');
		return {k: 'assign', name, v: expr()};
	}

	const functions = new Map();
	while (i < t.length) {
		const type = peek() && peek().k === 'id' && TYPES.has(peek().v) ? t[i++].v : null;
		if (!type)
			throw new Error(`expected a function, got ${peek() ? peek().v : 'end'}`);
		const name = eatId();
		eat('(');
		const params = [];
		if (!at(')'))
			do {
				// an out or inout parameter, which the raymarcher's trace() writes its hit through
				const qualifier = peek() && peek().k === 'id' && (peek().v === 'out' || peek().v === 'inout') ? t[i++].v : '';
				const pt = t[i++].v;
				if (!TYPES.has(pt))
					throw new Error(`bad parameter type ${pt}`);
				params.push({type: pt, name: eatId(), out: qualifier !== ''});
			} while (at(',') && (eat(','), true));
		eat(')');
		eat('{');
		const body = [];
		while (!at('}'))
			body.push(statement());
		eat('}');
		functions.set(name, {name, params, body});
	}
	return functions;
}

//--- values and operators ------------------------------------------------------

const v2 = (a, b) => [a, b];
const V = {
	add: (a, b) => typeof a === 'number' && typeof b === 'number' ? a + b
		: Array.isArray(a) && Array.isArray(b) ? a.map((x, i) => x + b[i])
		: Array.isArray(a) ? a.map(x => x + b) : b.map(x => x + a),
	sub: (a, b) => typeof a === 'number' && typeof b === 'number' ? a - b
		: Array.isArray(a) && Array.isArray(b) ? a.map((x, i) => x - b[i])
		: Array.isArray(a) ? a.map(x => x - b) : b.map(x => a - x),
	mul: (a, b) => {
		if (typeof a === 'number' && typeof b === 'number') return a * b;
		// mat3 * vec3, with the matrix stored as glsl builds it: nine numbers, taken as columns
		if (Array.isArray(a) && a.length === 9 && Array.isArray(b)) return [0, 1, 2].map(r => a[r] * b[0] + a[3 + r] * b[1] + a[6 + r] * b[2]);
		if (Array.isArray(b) && b.length === 9 && Array.isArray(a)) return [0, 1, 2].map(c => a[0] * b[c * 3] + a[1] * b[c * 3 + 1] + a[2] * b[c * 3 + 2]);
		// glsl multiplies two vectors componentwise, which is easy to forget when the shader is written against a
		// harness that only knew scalars and matrices
		if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((x, i) => x * b[i]);
		if (Array.isArray(a) && typeof b === 'number') return a.map(x => x * b);
		if (typeof a === 'number' && Array.isArray(b)) return b.map(x => a * x);
		throw new Error(`bad multiply: ${shape(a)} * ${shape(b)}`);
	},
	div: (a, b) => typeof a === 'number' && typeof b === 'number' ? a / b
		: Array.isArray(a) && typeof b === 'number' ? a.map(x => x / b) : a.map?.((x, i) => x / b[i]) ?? (b.map(x => a / x)),
};

const SWIZZLE = {x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3};
// what an operand is, for the errors that say what could not be combined
const shape = (v) => Array.isArray(v) ? `vec${v.length}` : v === undefined ? 'undefined' : typeof v;

const BUILTIN = {
	// min/max take (vec, vec) or (vec, scalar), the scalar broadcasting -- getting this wrong made every term of
	// the form max(vec2, float) come out NaN, which reads as a broken generator rather than a broken harness
	min: (...a) => Array.isArray(a[0]) ? a[0].map((x, i) => Math.min(x, Array.isArray(a[1]) ? a[1][i] : a[1])) : Math.min(...a),
	max: (...a) => Array.isArray(a[0]) ? a[0].map((x, i) => Math.max(x, Array.isArray(a[1]) ? a[1][i] : a[1])) : Math.max(...a),
	abs: (a) => Array.isArray(a) ? a.map(Math.abs) : Math.abs(a),
	sqrt: (a) => Array.isArray(a) ? a.map(Math.sqrt) : Math.sqrt(Math.max(a, 0)),
	floor: (a) => Array.isArray(a) ? a.map(Math.floor) : Math.floor(a),
	cos: (a) => Array.isArray(a) ? a.map(Math.cos) : Math.cos(a),
	sin: (a) => Array.isArray(a) ? a.map(Math.sin) : Math.sin(a),
	atan: (a, b) => b === undefined ? Math.atan(a) : Math.atan2(a, b),
	dot: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
	length: (a) => Math.hypot(...a),
	distance: (a, b) => Math.hypot(...a.map((x, i) => x - b[i])),
	// the comparisons glsl writes as vectors of bools, which a constructor converts to 0s and 1s
	equal: (a, b) => Array.isArray(a) ? a.map((x, i) => x === b[i]) : a === b,
	notEqual: (a, b) => Array.isArray(a) ? a.map((x, i) => x !== b[i]) : a !== b,
	all: (a) => Array.isArray(a) ? a.every(Boolean) : !!a,
	any: (a) => Array.isArray(a) ? a.some(Boolean) : !!a,
	normalize: (a) => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); },
	radians: (a) => a * Math.PI / 180,
	degrees: (a) => a * 180 / Math.PI,
	reflect: (I, N) => V.sub(I, V.mul(N, 2 * V.dot(N, I))),
	// glsl's refract: zero when the angle is past the critical one, which is how total internal reflection is written
	refract: (I, N, eta) => {
		const d = V.dot(N, I), k = 1 - eta * eta * (1 - d * d);
		return k < 0 ? [0, 0, 0] : V.sub(V.mul(I, eta), V.mul(N, eta * d + Math.sqrt(k)));
	},
	cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
	clamp: (x, lo, hi) => Array.isArray(x) ? x.map((v, i) => Math.min(Math.max(v, lo[i] ?? lo), hi[i] ?? hi)) : Math.min(Math.max(x, lo), hi),
	mix: (a, b, t) => Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t,
	pow: (a, b) => Array.isArray(a) ? a.map((v, i) => Math.pow(v, b[i] ?? b)) : Math.pow(a, b),
	exp: (a) => Array.isArray(a) ? a.map(Math.exp) : Math.exp(a),
	log: (a) => Array.isArray(a) ? a.map(Math.log) : Math.log(a),
	mod: (a, b) => Array.isArray(a) ? a.map((x, i) => x - b * Math.floor(x / b)) : a - b * Math.floor(a / b),
	step: (a, b) => Array.isArray(b) ? b.map(x => x < a ? 0 : 1) : (b < a ? 0 : 1),
	smoothstep: (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); },
	// glsl's fract and sign take a vector as readily as a scalar, and this harness has been caught out by that
	// before: a componentwise builtin that is not componentwise turns into NaN, which reads as a broken shader
	fract: (a) => Array.isArray(a) ? a.map(x => x - Math.floor(x)) : a - Math.floor(a),
	sign: (a) => Array.isArray(a) ? a.map(Math.sign) : Math.sign(a),
	// the two the template provides, written here as the template writes them
	sdNgon: (p, r, n) => {
		const sector = 3.14159265358979 / n;
		const angle = Math.atan2(p[0], p[1]) - (1.5707963267948966 - sector);
		const fold = angle - 2 * sector * Math.floor(angle / (2 * sector) + 0.5);
		return Math.hypot(...p) * Math.cos(fold) - r * Math.cos(sector);
	},
	sdTri2: (q, a, b, c) => {
		const e0 = V.sub(b, a), e1 = V.sub(c, b), e2 = V.sub(a, c);
		const w0 = V.sub(q, a), w1 = V.sub(q, b), w2 = V.sub(q, c);
		const s0 = e0[0] * w0[1] - e0[1] * w0[0], s1 = e1[0] * w1[1] - e1[1] * w1[0], s2 = e2[0] * w2[1] - e2[1] * w2[0];
		const t = (w, e) => Math.min(1, Math.max(0, (w[0] * e[0] + w[1] * e[1]) / (e[0] * e[0] + e[1] * e[1] || 1)));
		const d0 = V.sub(w0, V.mul(e0, t(w0, e0))), d1 = V.sub(w1, V.mul(e1, t(w1, e1))), d2 = V.sub(w2, V.mul(e2, t(w2, e2)));
		const d = Math.sqrt(Math.min(V.dot(d0, d0), V.dot(d1, d1), V.dot(d2, d2)));
		return (s0 < 0 || s1 < 0 || s2 < 0) ? d : -d;
	},
};
V.dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
BUILTIN.normalize = (a) => { const l = Math.hypot(...a) || 1e-20; return a.map(x => x / l); };
const equal = (a, b) => Array.isArray(a) ? a.map((x, i) => x === b[i]) : a === b;

//--- evaluation ----------------------------------------------------------------

// A chain of scopes, as glsl has: a declaration is local to the block it is in, but an assignment writes whichever
// enclosing block declared the name. Copying a scope instead loses every `best = min(best, ...)` inside an if-block.
class Scope {
	constructor(parent) { this.parent = parent; this.vars = new Map(); }
	native(name, value) { this.vars.set(name, value); return this; }
	declare(name, value) { this.vars.set(name, value); }
	has(name) { return this.vars.has(name) || !!(this.parent && this.parent.has(name)); }
	get(name) {
		if (this.vars.has(name))
			return this.vars.get(name);
		if (this.parent)
			return this.parent.get(name);
		throw new Error(`no variable ${name}`);
	}
	set(name, value) {
		if (this.vars.has(name))
			this.vars.set(name, value);
		else if (this.parent)
			this.parent.set(name, value);
		else
			throw new Error(`no variable ${name}`);
	}
}

// entry names the function to call: usually the generated map(), but a test that wants to run something in the
// template around it -- the glass path, say -- needs a probe of its own while trace() still calls map() for the scene
function makeMap(code, entry = 'map', extra = {}) {
	const functions = parse(code);
	const globals = new Scope(undefined);
	const call = (name, args, callerScope, argNodes) => {
		if (TYPES.has(name)) {
			// A single scalar broadcasts (vec3(0.0) is (0,0,0)) and matN of one scalar is the diagonal; a single
			// vector converts, padded with zero as glsl pads. Anything else has to be n scalars, or n/row vectors for
			// a matN. glsl has no vec2(vec2, float), and quietly accepting one here hid a term that would not have
			// compiled in a real shader -- the one kind of error this harness exists to find.
			const n = {float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, mat2: 4, mat3: 9, mat4: 16}[name];
			if (n === 1)
				return args[0];
			if (args.length === 1 && typeof args[0] === 'number')
				return name.startsWith('mat')
					? Array.from({length: n}, (_, k) => k % (Math.sqrt(n) + 1) === 0 ? args[0] : 0)
					: Array.from({length: n}, () => args[0]);
			if (args.length === 1 && Array.isArray(args[0]))
				// vec3(bvec3): glsl converts each component, and a bool is 1 or 0
				return Array.from({length: n}, (_, k) => {
					const v = args[0][k] ?? 0;
					return typeof v === 'boolean' ? (v ? 1 : 0) : v;
				});
			const rows = name.startsWith('mat') ? (n === 4 ? 2 : 3) : 0;
			if (args.length === n && args.every(a => typeof a === 'number'))
				return args.slice();
			if (rows && args.length === rows && args.every(a => Array.isArray(a)))
				return args.flat();
			throw new Error(`${name}(${args.map(a => Array.isArray(a) ? `vec${a.length}` : typeof a).join(', ')}) is not a valid glsl constructor call`);
		}
		const builtin = Object.prototype.hasOwnProperty.call(extra, name) ? extra[name] : BUILTIN[name];
		if (builtin)
			return builtin(...args);
		const fn = functions.get(name);
		if (!fn)
			throw new Error(`no function ${name}`);
		const scope = new Scope(globals);			// glsl has no closures over a caller's locals
		const writeback = [];
		fn.params.forEach((p, i) => {
			if (!p.out) {
				scope.declare(p.name, args[i]);
				return;
			}
			// an out parameter is a reference, so the caller has to have named a variable: a literal has nowhere to
			// be written back to
			const node = argNodes && argNodes[i];
			if (!node || node.k !== 'id')
				throw new Error(`${name}: out parameter '${p.name}' needs a plain variable at the call`);
			scope.declare(p.name, 0);
			writeback.push([node.name, p.name]);
		});
		const result = run(fn.body, scope);
		for (const [target, param] of writeback)
			callerScope.set(target, scope.get(param));
		// a return is wrapped so that a break can be told from it; only the wrapper is unwrapped here
		return result && result.__signal === 'return' ? result.v : undefined;
	};
	const evalExpr = (e, scope) => {
		switch (e.k) {
			case 'num': return e.v;
			case 'id': return e.name === 'true' ? true : e.name === 'false' ? false : scope.get(e.name);
			case 'call': return call(e.name, e.args.map(a => evalExpr(a, scope)), scope, e.args);
			case 'swizzle': {
				const of = evalExpr(e.of, scope);
				const idx = [...e.v].map(c => SWIZZLE[c]);
				const out = idx.map(k => of[k]);
				return out.length === 1 ? out[0] : out;
			}
			case 'un': {
				const a = evalExpr(e.a, scope);
				return e.op === '-' ? (Array.isArray(a) ? a.map(x => -x) : -a) : !a;
			}
			case 'bin': {
				const a = evalExpr(e.a, scope), b = evalExpr(e.b, scope);
				switch (e.op) {
					case '+': return V.add(a, b);
					case '-': return V.sub(a, b);
					case '*': return V.mul(a, b);
					case '/': return V.div(a, b);
					case '<': return a < b; case '>': return a > b;
					case '<=': return a <= b; case '>=': return a >= b;
					case '==': return equal(a, b); case '!=': return !equal(a, b);
					case '&&': return a && b; case '||': return a || b;
				}
				throw new Error(`bad operator ${e.op}`);
			}
			case 'cond': return evalExpr(e.c, scope) ? evalExpr(e.a, scope) : evalExpr(e.b, scope);
		}
		throw new Error(`bad expression ${e.k}`);
	};
	// A return, a break and a continue all have to travel out through whatever blocks and ifs they sit in, and they
	// cannot be told apart from a value, so each is wrapped: a run() result is either undefined, a value, or one of
	// these.
	const signal = (k, v) => ({__signal: k, v});
	const STEP_LIMIT = 20000;			// a loop that never ends should fail the test, not hang it

	const run = (stmts, scope) => {
		for (const s of stmts) {
			switch (s.k) {
				case 'block': { const r = run(s.body, new Scope(scope)); if (r !== undefined) return r; break; }
				case 'decl': for (const d of s.decls) scope.declare(d.name, d.v ? evalExpr(d.v, scope) : 0); break;
				case 'assign': scope.set(s.name, evalExpr(s.v, scope)); break;
				case 'inc': scope.set(s.name, scope.get(s.name) + s.delta); break;
				case 'compound': scope.set(s.name, V[{'+': 'add', '-': 'sub', '*': 'mul', '/': 'div'}[s.op]](scope.get(s.name), evalExpr(s.v, scope))); break;
				case 'if': { const r = evalExpr(s.c, scope) ? run([s.a], new Scope(scope)) : (s.b ? run([s.b], new Scope(scope)) : undefined); if (r !== undefined) return r; break; }
				case 'return': return signal('return', evalExpr(s.v, scope));
				case 'break': return signal('break');
				case 'continue': return signal('continue');
				case 'for': {
					const loop = new Scope(scope);
					if (s.init)
						run([s.init], loop);
					for (let n = 0; n < STEP_LIMIT; n++) {
						if (!evalExpr(s.cond, loop))
							break;
						const r = run([s.body], new Scope(loop));
						if (r && r.__signal === 'break')
							break;
						if (r !== undefined && r.__signal !== 'continue')
							return r;
						run([s.step], loop);
					}
					break;
				}
			}
		}
		return undefined;
	};
	return (p) => call(entry, [p]);
}

module.exports = {makeMap};

// Running it as a script checks one thing: that it can read its own generator's output.
if (require.main === module) {
	const { evaluate } = require('../out/src/scad/evaluate.js');
	const { emitGlsl } = require('../out/src/scad/sdf.js');
	const { sdf } = evaluate('rotate([30,0,0]) cube([1,2,3]);', 'glsl.js');
	const g = emitGlsl(sdf);
	const map = makeMap([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'));
	const m = (p) => map(p);
	console.log(`evaluator self-test: map(0,0,0) = (${m([0, 0, 0]).map(v => v.toFixed(4))}), map(5,5,5) = (${m([5, 5, 5]).map(v => v.toFixed(4))})`);

	// the harness's own glsl semantics, checked against glsl's rules rather than against the generator: anything it
	// gets wrong here is a generator bug it would otherwise report, or a wrong answer it would call agreement
	const probe = makeMap([
		'vec2 opUnion(vec2 a, vec2 b) { return a.x <= b.x ? a : b; }',
		'vec2 opIntersect(vec2 a, vec2 b) { return a.x >= b.x ? a : b; }',
		'vec2 opSubtract(vec2 a, vec2 b) { return -b.x > a.x ? vec2(-b.x, a.y) : a; }',
		'vec2 map(vec3 p) {',
		'\tvec2 a = vec2(1.0, 7.0), b = vec2(3.0, 2.0);',
		'\tvec2 lo = min(a, b), hi = max(a, 1.5), pick = opUnion(a, b), cut = opSubtract(a, b);',
		'\treturn vec2(lo.x * 100.0 + lo.y * 10.0 + hi.x + hi.y + pick.y + cut.y, dot(a, b));',
		'}'].join('\n'));
	const got = probe([0, 0, 0])[0];
	// a=(1,7) b=(3,2): lo=(1,2), hi=max(a,1.5)=(1.5,7), pick=opUnion=(1,7), cut=opSubtract=(1,7) -- the base's
	// material 7 on the cut, not b's 2
	const want = 100 * 1 + 10 * 2 + 1.5 + 7 + 7 + 7;
	if (Math.abs(got - want) > 1e-9)
		throw new Error(`harness self-test: expected ${want}, got ${got}`);
	console.log(`harness self-test: vec broadcast and the combinators agree with glsl (${got})`);
}
