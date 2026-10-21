// hull(): exact where an exact answer exists -- every child a shape with a known finite vertex set (built as the real
// convex hull of that point set), every child a same-radius sphere/circle (built as the hull of their centres grown
// by that radius, or as a capsule/stadium for just two), or any mix of sharp corners and spheres of any radii (each a
// weighted point; see weightedPoints3/weightedHull3: tangent faces, round-cone edges, a core) -- and an honest
// union-with-a-warning everywhere else (a curved side that is not a sphere, a cut shape among the children). See
// src/scad/sdf.ts's convexHull2/convexHull3/hullVertices2/hullVertices3/sameRadiusSpheres/sameRadiusCircles, and
// evaluate.ts's 'hull'.
const { evaluate } = require('../out/src/scad/evaluate.js');
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { makeShader, close } = require('./webgl.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

// The volume of the hull of two balls (r1 at x = 0, r2 at x = d): the two balls' outer parts either side of the
// circles where the tangent cone touches them, plus the frustum between those circles -- whose radii are r*cos(theta),
// not r, where sin(theta) = (r1 - r2) / d.
function twoBallHullVolume(r1, r2, d) {
	const sin = (r1 - r2) / d, cos = Math.sqrt(1 - sin * sin);
	const x1 = r1 * sin, x2 = d + r2 * sin, u = x2 - d;
	const outer1 = Math.PI * (r1 * r1 * x1 - x1 ** 3 / 3 + 2 * r1 ** 3 / 3);
	const outer2 = Math.PI * (2 * r2 ** 3 / 3 - r2 * r2 * u + u ** 3 / 3);
	const a = r1 * cos, b = r2 * cos;
	return outer1 + outer2 + Math.PI * (x2 - x1) / 3 * (a * a + a * b + b * b);
}

// label, source, expected volume, tolerance (fraction), whether an exact hull was expected (no fallback warning)
const CASES = [
	['two cubes (vertex)', 'hull() { cube(4); translate([10, 0, 0]) cube(4); }', 224, 1e-6, true],
	['one cube (trivial)', 'hull() { cube(4); }', 64, 1e-9, true],
	['one sphere (trivial)', 'hull() { sphere(r = 3); }', 4 / 3 * Math.PI * 27, 3e-3, true],
	// a capsule: a cylinder of the spheres' separation plus the two end caps, which together make one whole ball
	['two same-radius spheres (capsule)', 'hull() { sphere(r = 3); translate([10, 0, 0]) sphere(r = 3); }',
		Math.PI * 9 * 10 + 4 / 3 * Math.PI * 27, 3e-3, true],
	['four same-radius spheres, non-coplanar (dilate)',
		'hull() { sphere(r=2); translate([10,0,0]) sphere(r=2); translate([5,8,0]) sphere(r=2); translate([5,3,8]) sphere(r=2); }',
		null, null, true],
	// three same-radius spheres with all centres in one plane: the hull is a triangle thickened by the ball, whose
	// volume is Steiner's 2*A*r + (pi/2)*P*r^2 + (4/3)*pi*r^3 for a planar shape of area A and perimeter P
	['three coplanar same-radius spheres (a thick triangle)',
		'hull() { sphere(r=2); translate([10,0,0]) sphere(r=2); translate([5,8,0]) sphere(r=2); }',
		2 * 40 * 2 + Math.PI / 2 * (10 + 2 * Math.hypot(5, 8)) * 4 + 4 / 3 * Math.PI * 8, 3e-3, true],
	// two balls of different radii are a round cone, whose volume has a closed form
	['two different-radius spheres (round cone)', 'hull() { sphere(r = 2); translate([10, 0, 0]) sphere(r = 4); }', twoBallHullVolume(2, 4, 10), 3e-3, true],
	// a mix of sharp corners and a sphere -- the boat in examples/Basics/hull.scad is this -- and spheres of four sizes
	['a cube and a sphere (mixed)', 'hull() { cube(4); translate([10, 2, 2]) sphere(r = 1.5); }', null, null, true],
	['a sphere poking through a flat face of the boxes (the boat)', 'hull() { translate([0, 30, 2.5]) sphere(1); translate([0, 10, -1]) cube([20, 1, 8], true); translate([0, -8, -1]) cube([20, 1, 8], true); translate([0, -30, 1]) cube([16, 1, 4], true); }', null, null, true],
	['four spheres, four radii', 'hull() { sphere(r=0.5); translate([10,0,0]) sphere(r=1); translate([5,8,0]) sphere(r=2); translate([5,3,8]) sphere(r=3); }', null, null, true],
	// a cylinder is NOT a pair of balls at its end-circle centres -- its ends are flat, and balls would round them off
	// and overshoot -- so a hull of cylinders has no exact form here and must say so
	['two cylinders (flat ends, not balls)', 'hull() { cylinder(r = 3, h = 1); translate([0, 0, 10]) cylinder(r = 3, h = 1); }', null, null, false],
	['a non-uniform scale breaks same-radius detection (fallback)',
		'hull() { sphere(r=2); translate([10,0,0]) scale([1,1,2]) sphere(r=2); }', null, null, false],
	['a for loop of cylinders (vertex hull sees through the union)',
		'hull() { for (p = [[0,0],[20,0],[20,20],[0,20]]) translate(p) cylinder(r=3,h=5,$fn=8); }', null, null, true],
	// hull() of a cut shape is not a shape with known vertices or known-round leaves, so it must fall back
	['a cut shape among the children (fallback)',
		'hull() { cube(4); difference() { translate([10,0,0]) cube(4); translate([10,0,0]) cube(2); } }', null, null, false],
];

(async () => {
	for (const [label, src, volume, tolerance, exact] of CASES) {
		const { sdf, warnings } = evaluate(src, 'hull.js');
		const stats = checkMesh(await meshUniform(sdf, {cells: 96}));
		const problems = [];
		if (stats.open) problems.push(`${stats.open} open edges`);
		if (stats.nonManifold) problems.push(`${stats.nonManifold} non-manifold edges`);
		if (volume !== null && Math.abs(stats.volume - volume) / volume > tolerance)
			problems.push(`volume ${stats.volume.toFixed(3)}, wanted ${volume.toFixed(3)}`);
		const warned = warnings.some(w => /hull this viewer cannot build exactly/.test(w));
		if (exact && warned) problems.push('fell back when an exact hull should have been possible');
		if (!exact && !warned) problems.push('built something exact where a fallback was expected');
		if (problems.length) ++bad;
		console.log(`${label.padEnd(48)} vol ${stats.volume.toFixed(3)}${problems.length ? '   FAIL: ' + problems.join('; ') : '   ok'}`);
	}

	// The mixed hull against an oracle that shares no code with it: a point is inside the hull of a set of balls iff
	// u.p <= max_i(u.c_i + r_i) for every direction u, checked here over a few thousand directions. Near the surface the best
	// direction is refined by hill-climbing, and points within 0.03 of it are skipped.
	{
		const dirs = Array.from({length: 4000}, (_, i) => { const y = 1 - 2 * (i + 0.5) / 4000, r = Math.sqrt(1 - y * y), a = i * 2.399963; return [r * Math.cos(a), y, r * Math.sin(a)]; });
		const corners = (o, sx, sy, sz) => [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [[o[0] + sx * x, o[1] + sy * y, o[2] + sz * z], 0])));
		const ORACLE = [
			['two sizes', 'hull() { sphere(r=2); translate([10,0,0]) sphere(r=4); }', [[[0, 0, 0], 2], [[10, 0, 0], 4]]],
			['four sizes', 'hull() { sphere(r=0.5); translate([10,0,0]) sphere(r=1); translate([5,8,0]) sphere(r=2); translate([5,3,8]) sphere(r=3); }',
				[[[0, 0, 0], 0.5], [[10, 0, 0], 1], [[5, 8, 0], 2], [[5, 3, 8], 3]]],
			['cube and sphere', 'hull() { cube(4); translate([10,2,2]) sphere(r=1.5); }', [...corners([0, 0, 0], 4, 4, 4), [[10, 2, 2], 1.5]]],
			// the ball swallows part of the box behind it: the plain hull of the centres has the wrong faces here
			['a big sphere over two cubes', 'hull() { cube(3); translate([8,0,0]) cube(3); translate([4,6,1]) sphere(r=3); }',
				[...corners([0, 0, 0], 3, 3, 3), ...corners([8, 0, 0], 3, 3, 3), [[4, 6, 1], 3]]],
			['the boat', 'hull() { translate([0, 30, 2.5]) sphere(1); translate([0, 10, -1]) cube([20, 1, 8], true); translate([0, -8, -1]) cube([20, 1, 8], true); translate([0, -30, 1]) cube([16, 1, 4], true); }',
				[[[0, 30, 2.5], 1], ...corners([-10, 9.5, -5], 20, 1, 8), ...corners([-10, -8.5, -5], 20, 1, 8), ...corners([-8, -30.5, -1], 16, 1, 4)]],
		];
		let seed = 7;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (const [label, src, balls] of ORACLE) {
			const { sdf, warnings } = evaluate(src, 'hull.js');
			check(!warnings.some(w => /hull this viewer cannot build exactly/.test(w)), `${label}: fell back when an exact hull should have been possible`);
			let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
			for (const [c, r] of balls) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] - r - 3); hi[k] = Math.max(hi[k], c[k] + r + 3); }
			let wrong = 0, tested = 0;
			for (let i = 0; i < 4000; i++) {
				const p = lo.map((l, k) => l + rand() * (hi[k] - l));
				const gap = (u) => {
					let m = -Infinity;
					for (const [c, r] of balls) m = Math.max(m, u[0] * c[0] + u[1] * c[1] + u[2] * c[2] + r);
					return u[0] * p[0] + u[1] * p[1] + u[2] * p[2] - m;
				};
				let outside = -Infinity, best = dirs[0];
				for (const u of dirs) { const g = gap(u); if (g > outside) { outside = g; best = u; } }
				// a few thousand directions miss the exact face normal of a big flat face by enough to matter near
				// it (an error of length x angle), so near the surface the best direction is refined by hill-climbing
				if (Math.abs(outside) < 1) {
					let step = 0.05;
					for (let it = 0; it < 80; it++, step *= 0.9)
						for (let k = 0; k < 8; k++) {
							const v = best.map(x => x + (rand() - 0.5) * 2 * step), l = Math.hypot(...v), u = v.map(x => x / l), g = gap(u);
							if (g > outside) { outside = g; best = u; }
						}
				}
				const d = evalSdf(sdf, p);
				if (Math.abs(outside) < 0.03 || Math.abs(d) < 0.03)
					continue;
				tested++;
				if ((outside > 0) !== (d > 0))
					wrong++;
			}
			check(wrong === 0, `${label}: ${wrong} of ${tested} points disagree with the support-function oracle about inside/outside`);
			console.log(`oracle ${label.padEnd(28)} ${wrong} of ${tested} points disagree`);
		}
	}
	{
		// every operand's own corners must be inside (or on) the hull's field: a corner reading outside would mean
		// the hull left part of an operand out of itself
		const { sdf } = evaluate('hull() { translate([2,1,0]) cube([3,5,2]); translate([-4,2,3]) cube(2); translate([0,-3,-2]) cube(1.5); }', 'hull.js');
		const corners = [];
		for (const [c, s] of [[[2, 1, 0], [3, 5, 2]], [[-4, 2, 3], [2, 2, 2]], [[0, -3, -2], [1.5, 1.5, 1.5]]])
			for (let i = 0; i < 8; i++)
				corners.push([c[0] + (i & 1 ? s[0] : 0), c[1] + (i & 2 ? s[1] : 0), c[2] + (i & 4 ? s[2] : 0)]);
		let cworst = 0;
		for (const c of corners) cworst = Math.max(cworst, evalSdf(sdf, c));
		check(cworst < 1e-9, `a corner of an operand ended up outside its own hull by ${cworst.toExponential(3)}`);
	}

	// the shader (compiled and run for real in headless Chrome) agrees with evalSdf() for a capsule, a stadium, and
	// a dilated vertex hull -- the three constructs this feature actually adds machinery for
	{
		const GLSL = [
			['capsule', 'hull() { sphere(r=3); translate([10,4,-2]) sphere(r=3); }'],
			['stadium2', 'linear_extrude(1) hull() { circle(r=3); translate([10,4]) circle(r=3); }'],
			['dilated vertex hull', 'hull() { sphere(r=2); translate([10,0,0]) sphere(r=2); translate([5,8,0]) sphere(r=2); translate([5,3,8]) sphere(r=2); }'],
			['round cone', 'hull() { sphere(r=2); translate([10,3,-2]) sphere(r=4); }'],
			['mixed hull (slabs, round cones, core)', 'hull() { cube(4); translate([10,2,2]) sphere(r=1.5); translate([3,9,1]) sphere(r=2.5); }'],
		];
		const { emitGlsl } = require('../out/src/scad/sdf.js');
		let seed = 1;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (const [label, src] of GLSL) {
			const { sdf } = evaluate(src, 'hull.js');
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const pts = Array.from({length: 3000}, () => [(rand() - 0.5) * 40, (rand() - 0.5) * 40, (rand() - 0.5) * 40]);
			const results = await shader.at(pts);
			let worst = 0;
			for (let i = 0; i < pts.length; i++) {
				const d = results[i][0];
				if (!Number.isFinite(d)) { worst = Infinity; break; }
				worst = Math.max(worst, Math.abs(d - evalSdf(sdf, pts[i])));
			}
			check(worst < 1e-4, `${label}: shader and mirror differ by ${worst.toExponential(3)}`);
			console.log(`${label.padEnd(24)} shader vs mirror: ${worst.toExponential(3)}`);
		}
	}

	console.log(bad ? `\n${bad} FAILED` : '\nevery hull is exact where it can be, and an honest fallback everywhere else');
	await close();
	process.exit(bad ? 1 : 0);
})();
