// minkowski(): commutative and associative, so which operand is "the shape" and which are "what it is grown by" is
// not fixed by write order (any one operand not resolving to a sphere/circle becomes the body, wherever it is
// written -- see supportOf/supportsOf/circleSupportsOfSdf and the 'minkowski' case in evaluate.ts), and Minkowski
// distributes over union: a union()/for loop of spheres as one operand grows the body separately by each and unions
// the results, rather than summing their radii the way separate sibling operands (genuinely different terms of the
// same sum) do.
const { evaluate } = require('../out/src/scad/evaluate.js');
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { makeShader, close } = require('./webgl.js');
const { float3 } = require('@isopodlabs/maths/vector');
const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const volumeOf = async (src) => {
	const { sdf, warnings } = await evaluate(src, 'minkowski.js');
	const stats = checkMesh(await meshUniform(sdf, {cells: 90}));
	return {vol: stats.volume, open: stats.open, nonManifold: stats.nonManifold, warnings};
};

(async () => {
	// commutativity: write order must not change the result, in 3-D or 2-D
	{
		const a = await volumeOf('minkowski() { sphere(r=1); cube(4); }');
		const b = await volumeOf('minkowski() { cube(4); sphere(r=1); }');
		check(a.warnings.length === 0 && b.warnings.length === 0, `sphere-first/cube-first warned: ${JSON.stringify(a.warnings)} / ${JSON.stringify(b.warnings)}`);
		check(Math.abs(a.vol - b.vol) < 1e-6, `sphere-first (${a.vol}) should equal cube-first (${b.vol})`);
		console.log(`3-D commutativity: sphere-first ${a.vol.toFixed(3)}, cube-first ${b.vol.toFixed(3)}`);
	}
	{
		const a = await volumeOf('linear_extrude(1) minkowski() { circle(r=1); square(4); }');
		const b = await volumeOf('linear_extrude(1) minkowski() { square(4); circle(r=1); }');
		check(a.warnings.length === 0 && b.warnings.length === 0, `circle-first/square-first warned: ${JSON.stringify(a.warnings)} / ${JSON.stringify(b.warnings)}`);
		check(Math.abs(a.vol - b.vol) < 1e-6, `circle-first (${a.vol}) should equal square-first (${b.vol})`);
		console.log(`2-D commutativity: circle-first ${a.vol.toFixed(3)}, square-first ${b.vol.toFixed(3)}`);
	}

	// distributivity: a for loop and an explicit union() of the same spheres must agree with each other, and must
	// differ from treating them as separate sibling operands (which sums the radii into one growth, not two)
	{
		const forLoop = await volumeOf('minkowski() { cube(2); for (p=[[0,0,0],[10,0,0]]) translate(p) sphere(r=1); }');
		const union = await volumeOf('minkowski() { cube(2); union() { sphere(r=1); translate([10,0,0]) sphere(r=1); } }');
		const siblings = await volumeOf('minkowski() { cube(2); translate([5,0,0]) sphere(r=1); translate([0,5,0]) sphere(r=1); }');
		check(forLoop.warnings.length === 0 && union.warnings.length === 0, `distributing warned: ${JSON.stringify(forLoop.warnings)} / ${JSON.stringify(union.warnings)}`);
		check(Math.abs(forLoop.vol - union.vol) < 1e-6, `a for loop (${forLoop.vol}) should equal an explicit union() of the same spheres (${union.vol})`);
		check(Math.abs(forLoop.vol - siblings.vol) > 1, `distributing over a union should not give the same volume as summing separate sibling operands (both ${forLoop.vol.toFixed(3)})`);
		console.log(`distribute (for) ${forLoop.vol.toFixed(3)}, distribute (union) ${union.vol.toFixed(3)}, sum (siblings) ${siblings.vol.toFixed(3)}`);
	}
	{
		const forLoop = await volumeOf('linear_extrude(1) minkowski() { square(4); for (p=[[0,0],[10,0]]) translate(p) circle(r=1); }');
		check(forLoop.warnings.length === 0, `2-D distributing warned: ${JSON.stringify(forLoop.warnings)}`);
		console.log(`2-D distribute (for): ${forLoop.vol.toFixed(3)}`);
	}

	// the flat-brush pattern (scale([1,1,0]) X): only ever valid as a minkowski operand -- a plain instantiate()
	// of it is empty -- so recognising it has to stay structural (the AST, not a built-then-inspected Sdf), the
	// same as it always was; this is the regression risk of ever reading operands off built geometry instead.
	{
		const flat = await volumeOf('minkowski() { cube([10, 6, 4]); scale([1, 1, 0]) sphere(2); }');
		check(flat.warnings.length === 0, `flat brush warned: ${JSON.stringify(flat.warnings)}`);
		const expect = (60 + 64 + Math.PI * 4) * 4;
		check(Math.abs(flat.vol - expect) / expect < 1e-3, `flat brush volume ${flat.vol}, wanted ${expect}`);
		console.log(`flat brush: ${flat.vol.toFixed(3)}, wanted ${expect.toFixed(3)}`);

		// and under an *additional* enclosing rotation, on a body ($fn <= 16, so an exact polyhedron) that keeps
		// findPlaneBrush's fast path -- composing the transform in two baked steps instead of one (rather than
		// building the body in a single instantiate() call) is exact in principle but not bit-for-bit the same
		// floating point, which is precisely what findPlaneBrush's face-recognition epsilon is sensitive to; a
		// plain (unfaceted) box under a rotation stays a `domain`-wrapped box rather than a baked polyhedron even
		// in the unmodified original, so it was never on the fast path either way and is not a fair comparison
		const rotated = await volumeOf(`rotate([20, 30, 40]) minkowski() {
			scale([sqrt(2), 1, 1]) cylinder(h = 8, r = 20 / cos(30) / 2, center = true, $fn = 6);
			scale([1, 1, 0]) sphere(2);
		}`);
		check(rotated.warnings.length === 0, `rotated flat brush warned: ${JSON.stringify(rotated.warnings)}`);
		check(rotated.open === 0 && rotated.nonManifold < 20, `rotated flat brush mesh has ${rotated.open} open edges -- the fast planeBrush path was not taken`);
		console.log(`rotated flat brush (hexagon body): ${rotated.vol.toFixed(3)}, open edges ${rotated.open}`);
	}

	// a bounding-sphere fallback is still honest when nothing resolves at all
	{
		const { warnings } = await evaluate('minkowski() { cube(4); cylinder(r=2, h=3); }', 'minkowski.js');
		check(warnings.some(w => /not a sphere/.test(w)), 'a non-sphere growth operand should still warn and approximate');
	}

	// the shader (compiled and run for real in headless Chrome) agrees with evalSdf() for the two genuinely new
	// constructs this feature emits -- a union of dilates and a union of offsets, from distributing over a union
	// growth operand -- plus the commutative (sphere-first) case
	{
		const GLSL = [
			['distributed union of spheres', 'minkowski() { cube(2); union() { sphere(r=1); translate([10,0,0]) sphere(r=1.5); } }'],
			['2-D distributed union of circles', 'linear_extrude(1) minkowski() { square(4); for (p=[[0,0],[10,0]]) translate(p) circle(r=1); }'],
			['sphere-first commutativity', 'minkowski() { sphere(r=1); cube(4); }'],
		];
		let seed = 1;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (const [label, src] of GLSL) {
			const { sdf } = evaluate(src, 'minkowski.js');
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const pts = Array.from({length: 3000}, () => [(rand() - 0.5) * 20, (rand() - 0.5) * 20, (rand() - 0.5) * 20]);
			const results = await shader.at(pts);
			let worst = 0;
			for (let i = 0; i < pts.length; i++) {
				const d = results[i][0];
				if (!Number.isFinite(d)) { worst = Infinity; break; }
				worst = Math.max(worst, Math.abs(d - evalSdf(sdf, pts[i])));
			}
			check(worst < 1e-4, `${label}: shader and mirror differ by ${worst.toExponential(3)}`);
			console.log(`${label.padEnd(32)} shader vs mirror: ${worst.toExponential(3)}`);
		}
	}

	console.log(bad ? `\n${bad} FAILED` : '\nminkowski is commutative, distributes over union, and still finds the flat-brush pattern structurally');
	await close();
	process.exit(bad ? 1 : 0);
})();
