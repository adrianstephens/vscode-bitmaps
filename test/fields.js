// The field the generated shader computes, against evalSdf() it is supposed to agree with. The shader side runs
// for real in headless Chrome (test/webgl.js) rather than through glsl.js's hand-written reimplementation of GLSL,
// so a divergence here is the generator's, not a gap in a second, independently-buggy GLSL.
const fs = require('fs');
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { float3 } = require('@isopodlabs/maths/vector');

// evalSdf/bounds3 take a float3 (@isopodlabs/maths); everything below uses [x,y,z] arrays, as the GLSL
// side and the rest of this file's own geometry do, so evalSdf is shadowed to take the same shape as everyone else
// here. Passing it an array directly reads p.x/p.y/p.z as undefined and returns NaN with no error -- silently, so
// every comparison in this file was vacuous until this wrapper was added: a NaN error is never ">" the running
// worst, so a bad case looked like agreement, and !Number.isFinite(NaN) tripped the *other* branch instantly.
const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));

const PATH = '/Volumes/DevSSD/dev/packages/rhombic_dodecahedron_system.scad';
const CASES = [
	['rotated box', 'rotate([30,0,0]) cube([1,2,3]);'],
	['rotated, scaled box', 'rotate([30,0,0]) scale([2,1,0.5]) cube([1,2,3]);'],
	['$fn prism', 'cylinder(h = 20, r = 10, center = true, $fn = 6);'],
	['tapered cylinder', 'cylinder(h = 20, r1 = 10, r2 = 3, center = true);'],
	['cone', 'cylinder(h = 20, r1 = 10, r2 = 0, center = true);'],
	['stretched prism with disc', `
module hexagonal_prism(diameter, height, radius) {
    minkowski() {
        scale([sqrt(2), 1, 1])
        cylinder(h = height, r = diameter / cos(30) / 2, center = true, $fn = 6);
        scale([1,1,0]) sphere(r = radius);
    }
}
hexagonal_prism(50.2, 20, 4);`],
	['die', fs.readFileSync(PATH, 'utf8').replace(/mode = "[a-z]+"/, 'mode = "die"')],
	['tray', fs.readFileSync(PATH, 'utf8')],
];

(async () => {
	let bad = 0;
	for (const [label, src] of CASES) {
		try {
			const { sdf } = evaluate(src, 'fields.js');
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const box = bounds3(sdf);
			const lo = [box.min.x, box.min.y, box.min.z], hi = [box.max.x, box.max.y, box.max.z];
			let seed = 1;
			const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
			const pts = Array.from({length: 3000}, () => [0, 1, 2].map(k => lo[k] + rand() * (hi[k] - lo[k])));
			const results = await shader.at(pts);

			let worst = 0, at = null;
			for (let i = 0; i < pts.length; i++) {
				const d = results[i][0];
				if (!Number.isFinite(d)) { worst = Infinity; at = pts[i]; break; }
				const err = Math.abs(d - evalSdf(sdf, pts[i]));
				if (err > worst) { worst = err; at = pts[i]; }
			}
			if (worst > 1e-4)
				++bad;
			console.log(`${label.padEnd(24)} worst |shader - mirror| = ${worst.toExponential(2)}${worst > 1e-4 ? `  at ${at.map(v => +v.toFixed(2))}` : '  (they agree)'}`);
		} catch (error) {
			++bad;
			console.log(`${label.padEnd(24)} FAILED: ${error.message}`);
		}
	}
	console.log(bad ? `\n${bad} of ${CASES.length} cases disagree` : '\nthe shader and the mirror agree everywhere');
	await close();
	process.exit(bad ? 1 : 0);
})();
