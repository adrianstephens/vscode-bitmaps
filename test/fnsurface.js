// surface_fn() and implicit_fn(): a function kept as a function. What is checked: the compiler (scalar arithmetic,
// degrees, vectors, comprehensions, closures, user functions, errors), the distance estimate (right sign, the surface
// where the function says, never overshooting the true distance by more than the safety margin), the symbolic
// gradient against finite differences, the mesher on one, and the real shader against the JS mirror point by point.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('./scadhost.js');
const { FileReader } = require('../out/src/filereader.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { compileField } = require('../out/src/scad/fnsurface.js');
const { meshUniform, checkMesh } = require('./scadhost.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnsurface-'));
const files = new FileReader();
const run = async (src) => {
	const r = await files.with(() => evaluate(src, path.join(dir, 'main.scad'), files));
	r.warnings = r.warnings.filter(w => !w.startsWith('$vp'));
	return r;
};
let seed = 5;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const shaderOf = async (sdf) => {
	const g = emitGlsl(sdf);
	return makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
};

(async () => {
	//--- a height field: the surface where f says, the sign either side, degrees ----------------------------
	{
		const r = await run('surface_fn(function(x, y) 2 + 3*sin(x*30)*cos(y*30), x=[0,12], y=[0,12], bottom=-3);');
		check(r.warnings.length === 0, `warnings: ${r.warnings}`);
		const sdf = r.sdf;
		check(sdf.k === 'fnfield', `kind ${sdf.k}`);
		const h = (x, y) => 2 + 3 * Math.sin(x * Math.PI / 6) * Math.cos(y * Math.PI / 6);
		let worst = 0, wrongSign = 0;
		for (let i = 0; i < 300; i++) {
			const x = 0.5 + rand() * 11, y = 0.5 + rand() * 11, hh = h(x, y);
			worst = Math.max(worst, Math.abs(evalSdf(sdf, [x, y, hh])));
			if (evalSdf(sdf, [x, y, hh - 0.5]) >= 0 || evalSdf(sdf, [x, y, hh + 0.5]) <= 0) wrongSign++;
		}
		check(worst < 1e-9, `the surface is ${worst} off where f says`);
		check(wrongSign === 0, `${wrongSign} points on the wrong side`);
		const b = bounds3(sdf);
		check(b.min.z === -3 && b.max.z >= 5 - 1e-6, `bounds3 ${b.min.z}..${b.max.z}`);
		console.log('height field: surface and sign right');
	}

	//--- conservative: the estimate against the true distance to a sampled surface -----------------------
	{
		const sdf = (await run('surface_fn(function(x, y) 2*sin(x*40)+ y*0.3, x=[0,10], y=[0,10], bottom=-10);')).sdf;
		const h = (x, y) => 2 * Math.sin(x * 40 * Math.PI / 180) + y * 0.3;
		const pts = [];
		for (let i = 0; i <= 400; i++) for (let j = 0; j <= 400; j++) pts.push([i / 40, j / 40, h(i / 40, j / 40)]);
		let over = 0, worst = 0;
		for (let k = 0; k < 200; k++) {
			const p = [1 + rand() * 8, 1 + rand() * 8, h(5, 5) + (rand() - 0.5) * 8];
			let d = Infinity;
			for (const q of pts) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
			const e = Math.abs(evalSdf(sdf, p));
			if (p[2] < h(p[0], p[1]) && e > d + 0.2) over++;		// sampled spacing is 0.025
			if (p[2] > h(p[0], p[1]) && e > d * 1.05 + 0.05) over++;
			worst = Math.max(worst, e / d);
		}
		check(over === 0, `${over} points where the estimate is further than the surface`);
		console.log(`estimate never overshoots (worst ratio ${worst.toFixed(2)})`);
	}

	//--- a user bound replaces the gradient --------------------------------------------------------------
	{
		const sdf = (await run('surface_fn(function(x, y) 0, x=[-5,5], y=[-5,5], slope=1, bottom=-5, zmax=10);')).sdf;
		near(evalSdf(sdf, [0, 0, 2]), 2 / Math.SQRT2, 1e-9, 'slope = 1 divides by sqrt 2');
	}

	//--- an implicit surface: a sphere, then a gyroid, with the gradient against differences -------------
	{
		const sdf = (await run('implicit_fn(function(x, y, z) x*x + y*y + z*z - 25, x=[-6,6], y=[-6,6], z=[-6,6]);')).sdf;
		// a bound, not the distance: never further than the true distance, and not uselessly short either
		for (const p of [[3, 4, 1], [0, 0, 0], [5.5, 0, 0], [0, 4, 4], [0, 0, 5.8]]) {
			const want = Math.hypot(...p) - 5, got = evalSdf(sdf, p);
			check(Math.sign(got) === Math.sign(want) && Math.abs(got) <= Math.abs(want) + 1e-9 && Math.abs(got) > Math.abs(want) / 30, `sphere at ${p}: ${got} for ${want}`);
		}
		near(evalSdf(sdf, [5, 0, 0]), 0, 1e-9, 'sphere surface');
		check(evalSdf(sdf, [0, 0, 0]) < 0 && evalSdf(sdf, [5.5, 0, 0]) > 0, 'sphere sign');

		// the symbolic gradient against finite differences, through every operation that has a derivative: the
		// field over the estimate is |grad F| / 0.7, whatever the function is
		const body = require('../out/src/scad/parser.js').parse('r = (sin(x*20)*cos(y*20) + sin(y*20)*cos(z*20) + sin(z*20)*cos(x*20))^2 + atan2(y, x+3)/50 + sqrt(x*x+2) + abs(z-1) + min(x, y) + (x > y ? x*y : y/3) + 2^x + tan(z*5) + asin(x/9) + acos(y/9) + atan(z) + exp(y/9) + ln(x*x+1) + log(z*z+1) + (x % 2.5);').scope.assignments[0].expr;
		const resolver = {get: () => undefined, findFunction: () => undefined};
		const fn = compileField({parameters: [{name: 'x'}, {name: 'y'}, {name: 'z'}], expr: body}, resolver, {kind: 'implicit'});
		let worst = 0;
		const off = [];
		for (let i = 0; i < 60; i++) {
			const p = [rand() * 6 - 3, rand() * 6 - 3, rand() * 6 - 3], h = 1e-5;
			const g = [0, 1, 2].map(k => {
				const a = [...p], b = [...p]; a[k] -= h; b[k] += h;
				return (fn.value(...b) - fn.value(...a)) / (2 * h);
			});
			const want = Math.max(Math.hypot(...g), 1e-2) / 0.7, got = fn.value(...p) / fn.distance(...p);
			if (Number.isFinite(want)) {
				const e = Math.abs(got - want) / want;
				if (e > 1e-4) off.push(e);
				else worst = Math.max(worst, e);
			}
		}
		// the odd point across a floor, a kink or a % wrap has no derivative to compare: a few of those are allowed
		check(off.length <= 3, `${off.length} of 60 points where the symbolic gradient differs from finite differences (${off.slice(0, 4)})`);
		console.log(`gradient: symbolic agrees with differences (${off.length} kinks of 60)`);
		console.log('implicit: sphere right');
	}

	//--- the language: vectors, let, comprehensions, closures, user functions, captured variables ----------
	{
		const cases = [
			['function(x, y) let(p = [x, y]) norm(p) * 0.5', (x, y) => Math.hypot(x, y) * 0.5],
			['function(x, y) [x, y, 2] * [1, 2, 3]', (x, y) => x + 2 * y + 6],
			['function(x, y) sum([for (i = [1:4]) sin(x * i * 20) / i])', (x, y) => [1, 2, 3, 4].reduce((s, i) => s + Math.sin(x * i * 20 * Math.PI / 180) / i, 0)],
			['function(x, y) k * (x % 3) + base(x) + PI', (x, y) => 2 * (x % 3) + (x + 1) + Math.PI],
			['function(x, y) cross([x, y, 1], [0, 1, 2])[0]', (x, y) => y * 2 - 1],
			['function(x, y) x > 1 && y < 2 ? 1 : round(x) + floor(y) + ceil(x) + sign(y)', (x, y) => x > 1 && y < 2 ? 1 : Math.sign(x) * Math.floor(Math.abs(x) + .5) + Math.floor(y) + Math.ceil(x) + Math.sign(y)],
			['function(x, y, z) x*x - y', (x, y) => x * x - y],
			['function(x, y) pow(x, 3) + x ^ 0.5 + log(x + 5) + ln(y + 5) + exp(y / 5)', (x, y) => x ** 3 + (x >= 0 ? x ** 0.5 : NaN) + Math.log10(x + 5) + Math.log(y + 5) + Math.exp(y / 5)],
		];
		for (const [fexpr, want] of cases) {
			const r = await run(`k = 2; function base(a) = a + 1; f = function(x, y) x*x - y; implicit_fn(${fexpr.replace('function(x, y)', 'function(x, y, z)')}, x=[-1,1], y=[-1,1], z=[-1,1]);`);
			check(r.warnings.length === 0, `${fexpr}: ${r.warnings}`);
			const sdf = r.sdf;
			if (sdf.k !== 'fnfield') { check(false, `${fexpr}: not a field (${sdf.k})`); continue; }
			let worst = 0;
			for (let i = 0; i < 40; i++) {
				const x = rand() * 4 - 2 + 0.1, y = rand() * 4 - 2 + 0.1, z = 0;
				const v = sdf.fn.value(x, y, z), w = want(x, y);
				if (Number.isNaN(w)) continue;
				worst = Math.max(worst, Math.abs(v - w) / (1 + Math.abs(w)));
			}
			check(worst < 1e-9, `${fexpr} is off by ${worst}`);
		}
		console.log('language: vectors, let, comprehensions, user functions, closures');
	}

	//--- a function held in a variable can be called from inside a function surface, as a named one can
	{
		const r = await run('sq = function(a) a*a; k = 2; add = function(a, b = k) a + b; implicit_fn(function(x, y, z) sq(x) + sq(y) + sq(z) + add(z) - 27, x=[-6,6], y=[-6,6], z=[-6,6]);');
		check(r.warnings.length === 0, `${r.warnings}`);
		const fn = r.sdf.fn;
		check(r.sdf.k === 'fnfield', `kind ${r.sdf.k}`);
		if (fn) near(fn.value(1, 2, 3), 1 + 4 + 9 + 5 - 27, 1e-9, 'a call to a function literal held in a variable');
	}

	//--- color(function(x, y, z) [r, g, b]): a colour that is a function of the point, in the frame color() is written in
	{
		const r = await run('translate([10, 0, 0]) rotate([0, 0, 90]) color(function(x, y, z) [x / 10, y / 10 + 0.5, 0.25 + 0.5 * sin(z * 30)]) cube(5);');
		check(r.warnings.length === 0, `${r.warnings}`);
		const palette = [], seenFn = [];
		(function w(s) { if (s.k === 'material' && s.mat.colorFn) seenFn.push(s.mat.colorFn); for (const c of s.children ?? []) w(c); if (s.body) w(s.body); })(r.sdf);
		check(seenFn.length === 1, `one colour function in the field, got ${seenFn.length}`);
		const fn = seenFn[0];
		// the model's point (12, 3, 2) is, in the frame the color() is written in (rotated a quarter turn, then moved),
		// (3, -2, 2)
		const got = fn.at(12, 3, 2), want = [3 / 10, -2 / 10 + 0.5, 0.25 + 0.5 * Math.sin(60 * Math.PI / 180)];
		check(got.every((v, i) => Math.abs(v - want[i]) < 1e-9), `colour at (12, 3, 2): ${got} for ${want}`);
		// the shader's, at points of the model
		const g = emitGlsl(r.sdf);
		const code = ['vec3 g_hit;', 'vec3 g_normal;', ...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}',
			'vec2 probe(vec3 p) { g_hit = p; vec3 c = matColor(1.0); return vec2(c.x + 4.0 * c.y, c.z); }'].join('\n');
		const shader = await makeShader(code, 'probe', g.data);
		const pts = Array.from({length: 200}, () => [rand() * 14 + 4, rand() * 8 - 4, rand() * 8 - 2]);
		const out = await shader.at(pts);
		let worst = 0;
		pts.forEach((p, i) => { const c = fn.at(...p); worst = Math.max(worst, Math.abs(out[i][0] - (c[0] + 4 * c[1])), Math.abs(out[i][1] - c[2])); });
		check(worst < 1e-4, `the shader's colour and the mirror's differ by ${worst}`);
		console.log(`colour function: follows its frame, shader agrees to ${worst.toExponential(1)}`);
		// with the normal too: a normal of the model is carried into the color()'s frame (turned, and under a scale that is not
		// the same every way, by the frame's transpose and made unit again), and the shader agrees given the same one
		const normalFn = async src => {
			const r = await run(src), fns = [];
			check(r.warnings.length === 0, `${r.warnings}`);
			(function w(s) { if (s.k === 'material' && s.mat.colorFn) fns.push(s.mat.colorFn); for (const c of s.children ?? []) w(c); if (s.body) w(s.body); })(r.sdf);
			return {sdf: r.sdf, fn: fns[0]};
		};
		const unit = ns => ns.map(v => (v * 0.5 + 0.5));
		{
			const {sdf, fn} = await normalFn('translate([10, 0, 0]) rotate([0, 0, 90]) color(function(x, y, z, nx, ny, nz) [nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5]) cube(5);');
			const got = fn.at(12, 3, 2, 1, 0, 0), want = unit([0, -1, 0]);
			check(got.every((v, i) => Math.abs(v - want[i]) < 1e-9), `turned normal: ${got} for ${want}`);
			const g = emitGlsl(sdf);
			const code = ['vec3 g_hit;', 'vec3 g_normal;', ...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}',
				'vec2 probe(vec3 p) { g_hit = p; g_normal = normalize(p - vec3(10.0, 0.0, 0.0)); vec3 c = matColor(1.0); return vec2(c.x + 4.0 * c.y, c.z); }'].join('\n');
			const shader = await makeShader(code, 'probe', g.data);
			const pts = Array.from({length: 200}, () => [rand() * 14 + 4, rand() * 8 - 4, rand() * 8 - 2]);
			const out = await shader.at(pts);
			let worst = 0;
			pts.forEach((p, i) => {
				const d = [p[0] - 10, p[1], p[2]], l = Math.hypot(...d), c = fn.at(...p, ...d.map(v => v / l));
				worst = Math.max(worst, Math.abs(out[i][0] - (c[0] + 4 * c[1])), Math.abs(out[i][1] - c[2]));
			});
			check(worst < 1e-4, `the shader's colour from the normal and the mirror's differ by ${worst}`);
			console.log(`colour function of the normal: turns with its frame, shader agrees to ${worst.toExponential(1)}`);
		}
		{
			const {fn} = await normalFn('scale([2, 1, 1]) color(function(x, y, z, nx, ny, nz) [nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5]) sphere(1);');
			const got = fn.at(Math.SQRT2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0), want = unit([2 / Math.sqrt(5), 1 / Math.sqrt(5), 0]);
			check(got.every((v, i) => Math.abs(v - want[i]) < 1e-9), `scaled normal: ${got} for ${want}`);
			// fewer parameters than six take only what they name
			const {fn: fn4} = await normalFn('color(function(x, y, z, nx) [nx, 0, 0]) cube(1);');
			check(Math.abs(fn4.at(0, 0, 0, 0.25, 0, 0)[0] - 0.25) < 1e-9, 'four parameters: x, y, z and nx');
		}
		for (const [src, what] of [['color(function(x, y, z) x) cube(1);', 'a number'], ['color(function(x, y, z) [x, y]) cube(1);', 'two components'], ['color(function(x, y, z) [q, 0, 0]) cube(1);', 'an unbound name']]) {
			const e = await run(src);
			check(e.warnings.length > 0, `${what} should be reported`);
		}
	}

	//--- what cannot be compiled is reported, not drawn ---------------------------------------------------------
	for (const [src, what] of [
		['surface_fn(function(x, y) [x, y], x=[0,1], y=[0,1]);', 'a vector'],
		['surface_fn(function(x, y) nosuch(x), x=[0,1], y=[0,1]);', 'unknown function'],
		['surface_fn(function(x, y) q, x=[0,1], y=[0,1]);', 'unbound name'],
		['surface_fn(function(x, y) "s", x=[0,1], y=[0,1]);', 'a string'],
		['surface_fn(function(x, y) sum([for (i=[0:x]) i]), x=[0,1], y=[0,1]);', 'a range depending on x'],
		['surface_fn(function(x) x, x=[0,1], y=[0,1]);', 'too few parameters'],
		['surface_fn(3);', 'not a function'],
	]) {
		const r = await run(src);
		check(r.warnings.length > 0 && bounds3(r.sdf) === undefined, `${what}: ${JSON.stringify(r.warnings)}`);
	}
	console.log('errors are reported');

	//--- it composes: transforms, csg, a function stored and called ---------------------------------------------
	{
		const r = await run('g = function(x, y) 0.1*(x*x+y*y); translate([100,0,0]) difference() { surface_fn(g, x=[-5,5], y=[-5,5], bottom=-2); cylinder(r=1, h=100, center=true); }');
		check(r.warnings.length === 0, `${r.warnings}`);
		const b = bounds3(r.sdf);
		check(Math.abs(b.min.x - 95) < 1e-9, `translated to ${b.min.x}`);
		check(evalSdf(r.sdf, [100, 0, 0]) > 0, 'the hole is empty');
		check(evalSdf(r.sdf, [103, 0, 0]) < 0, 'the rest is solid');
		const k = (await run('scale([2,1,1]) implicit_fn(function(x,y,z) x*x+y*y+z*z-4, x=[-3,3], y=[-3,3], z=[-3,3]);')).sdf;
		check(evalSdf(k, [3.9, 0, 0]) < 0 && evalSdf(k, [4.1, 0, 0]) > 0, 'scaled');
		console.log('composes with transforms and csg');
	}

	//--- the mesher draws it -------------------------------------------------------------------------------------
	{
		const sdf = (await run('implicit_fn(function(x, y, z) x*x + y*y + z*z - 16, x=[-5,5], y=[-5,5], z=[-5,5]);')).sdf;
		const stats = checkMesh(await meshUniform(sdf, {cells: 64}));
		near(stats.volume, 4 / 3 * Math.PI * 64, 4 / 3 * Math.PI * 64 * 0.03, 'the mesh volume of a sphere of radius 4');
		check(stats.open === 0 && stats.nonManifold === 0 && stats.inconsistent === 0, 'the mesh is closed: ' + JSON.stringify(stats));
		console.log(`mesh: volume ${stats.volume.toFixed(1)}`);
	}

	//--- a ray marched with the field's own steps finds the surface a fine march finds: the gradient dies away at a saddle
	//    of a gyroid with the field not yet zero, and a step by the local gradient there goes straight through a sheet
	for (const [name, src] of [
		['gyroid', 'implicit_fn(function(x, y, z) sin(x*40)*cos(y*40) + sin(y*40)*cos(z*40) + sin(z*40)*cos(x*40) - 0.2, x=[-12,12], y=[-12,12], z=[-12,12]);'],
		['rough height field', 'surface_fn(function(x, y) 4*sin(x*20)*cos(y*20) + 3*sin(x*90)*sin(y*90), x=[-15,15], y=[-15,15], bottom=-8);'],
	]) {
		const sdf = (await run(src)).sdf, d = (p) => evalSdf(sdf, p);
		let wrong = 0;
		const N = 300;
		for (let k = 0; k < N; k++) {
			const o = [-30 + rand() * 60, -30 + rand() * 60, 30], tg = [rand() * 20 - 10, rand() * 20 - 10, rand() * 20 - 10];
			let rd = tg.map((v, i) => v - o[i]); const l = Math.hypot(...rd); rd = rd.map(v => v / l);
			const at = (t) => o.map((v, i) => v + rd[i] * t);
			let ref = -1; for (let t = 0; t < 120; t += 0.02) if (d(at(t)) < 0) { ref = t; break; }
			let hit = -1, t = 0; for (let i = 0; i < 4000 && t < 120; i++) { const v = d(at(t)); if (v < 0.004) { hit = t; break; } t += v * 0.9; }
			if ((ref < 0) !== (hit < 0) || (ref >= 0 && Math.abs(ref - hit) > 0.5)) wrong++;
		}
		check(wrong <= N * 0.025, `${name}: ${wrong} of ${N} rays go through or stop short of the surface`);
		console.log(`${name}: ${wrong} of ${N} marched rays disagree with a fine march`);
	}

	//--- a ray that has just left the surface does not hit it again. The marcher starts such a ray a couple of eps off
	//    the surface (eps being 2e-4 of the model's half size) and calls it a hit if the field there is under eps: a
	//    bound that is a fraction of the true distance near the surface makes that a hit from the wrong side, which is
	//    shaded black -- the zebra stripes in a transparent gyroid
	for (const [name, src, scale] of [
		['gyroid', 'implicit_fn(function(x, y, z) sin(x*40)*cos(y*40) + sin(y*40)*cos(z*40) + sin(z*40)*cos(x*40) - 0.2, x=[-12,12], y=[-12,12], z=[-12,12]);', 12],
		['height field', 'surface_fn(function(x, y) 4*sin(x*20)*cos(y*20) + 3*sin(x*90)*sin(y*90), x=[-15,15], y=[-15,15], bottom=-8);', 15],
	]) {
		const sdf = (await run(src)).sdf, d = (p) => evalSdf(sdf, p), eps = scale * 2e-4;
		let hit = 0, n = 0;
		for (let k = 0; k < 400; k++) {
			const o = [rand() * 16 - 8, rand() * 16 - 8, rand() * 6 - 3], a = rand() * 6.283, b = rand() * 3 - 1.5;
			const dir = [Math.cos(a), Math.sin(a), b]; const l = Math.hypot(...dir); dir.forEach((_, i) => dir[i] /= l);
			if (d(o) > 0) continue;
			let lo = 0, hi = 30;
			for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (d(o.map((v, j) => v + dir[j] * m)) < 0 ? lo = m : hi = m); }
			const p = o.map((v, j) => v + dir[j] * lo);
			if (d(p.map((v, j) => v + dir[j] * 0.5)) < 0 && lo > 29) continue;
			const g = [0, 1, 2].map(i => { const q = [...p], r = [...p]; q[i] -= 1e-4; r[i] += 1e-4; return d(r) - d(q); });
			const gl = Math.hypot(...g);
			if (!(gl > 0)) continue;
			// along the field's own outward normal, as the shader steps off the surface
			const out = p.map((v, i) => v + g[i] / gl * eps * 2);
			n++;
			if (d(out) < eps) hit++;
		}
		check(n > 50 && hit === 0, `${name}: ${hit} of ${n} points two eps off the surface are under the hit threshold`);
		console.log(`${name}: ${n} points just off the surface all clear the hit threshold`);
	}

	//--- the shader and the mirror agree --------------------------------------------------------------------------
	for (const [name, src] of [
		['height field', 'surface_fn(function(x, y) 2 + 3*sin(x*30)*cos(y*30) + (x > 6 ? 1 : 0) + atan2(y, x+1)/30 + sqrt(x*y+1) + (x % 3)/5 + abs(y-6)/4 + round(x/4), x=[0,12], y=[0,12], bottom=-3);'],
		['gyroid', 'implicit_fn(function(x, y, z) sin(x*40)*cos(y*40) + sin(y*40)*cos(z*40) + sin(z*40)*cos(x*40) - 0.3 + 0.01*pow(x, 3) + min(x, z)*0.01, x=[-10,10], y=[-10,10], z=[-10,10]);'],
		['bounded', 'translate([5,0,0]) rotate([0,0,30]) implicit_fn(function(x, y, z) x*x + y*y - z*z - 4, x=[-10,10], y=[-10,10], z=[-6,6], lipschitz=20);'],
	]) {
		const sdf = (await run(src)).sdf;
		const shader = await shaderOf(sdf);
		const b = bounds3(sdf);
		const pts = Array.from({length: 600}, () => [b.min.x - 2 + rand() * (b.max.x - b.min.x + 4), b.min.y - 2 + rand() * (b.max.y - b.min.y + 4), b.min.z - 2 + rand() * (b.max.z - b.min.z + 4)]);
		const got = await shader.at(pts);
		let worst = 0;
		pts.forEach((p, i) => {
			const w = evalSdf(sdf, p);
			// float32 against float64 in the arithmetic of the field, which is relative
			worst = Math.max(worst, Math.abs(got[i][0] - w) / (1 + Math.abs(w)));
		});
		check(worst < 2e-3, `${name}: the shader and the mirror differ by ${worst}`);
		console.log(`${name}: shader agrees to ${worst.toExponential(1)}`);
	}

	await close();
	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exit(bad ? 1 : 0);
})();
