// Is the prism's rim sharp or rolled over?
//
// The prism is `minkowski { stretched hexagon prism; scale([1,1,0]) sphere(r) }`. The brush is flat, so it cannot
// move the caps: the result is the hexagon's cross-section swept around a disc of radius r, at the prism's own
// height -- a sharp edge where the rounded side wall meets the flat cap, not a rolled-over corner (a flat brush,
// having no extent in z, cannot round anything in z). That shape has a closed form, but the field near that sharp
// edge does not simplify to plain max(): the standard rounded-box correction (Inigo Quilez's sdBox) still applies
// to the *distance*, because a point beyond both the wall and the cap measures its distance to the rim itself --
// a real 3-D curve, not a plane -- and max() of the two half-space distances undershoots that, the same undershoot
// 'extrude' and 'dilate's own flat-brush case both had before they were fixed to include it. This file checks the
// emitted shader (compiled and run for real in headless Chrome, via test/webgl.js) and evalSdf() against:
//
//     let d2 = sd2D(cross-section) - r, dz = |z| - h/2 in
//     min(max(d2, dz), 0) + length(max(d2, 0), max(dz, 0))
//
// sd2D here is written from scratch, as the distance to a convex polygon, so it shares no code with the field under
// test; the corner correction itself was checked independently too, by densely sampling the rim curve and taking
// the true nearest distance from a point beyond it. Two earlier attempts at this measurement were blind and are
// worth not repeating:
//   * the cap height at (0, apothem - dy) reads h/2 whether the rim is rolled or not;
//   * bisecting y between two points that are both OUTSIDE finds nothing, because the solid lies between them.
// What actually discriminates is z above the cap plane: a *rolled* rim would bulge to z = r/2 above it, which is
// not what the sharp-edged closed form above says is there, and not what the field measures either.
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { float3 } = require('@isopodlabs/maths/vector');

// evalSdf takes a float3 (@isopodlabs/maths); everything else here uses [x,y,z] arrays, so it is shadowed
// to match -- see fields.js for why passing it an array unwrapped silently returns NaN instead of erroring.
const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));

const src = `
module hexagonal_prism(diameter, height, radius) {
    minkowski() {
        scale([sqrt(2), 1, 1])
        cylinder(h = height, r = diameter / cos(30) / 2, center = true, $fn = 6);
        scale([1,1,0]) sphere(r = radius);
    }
}
hexagonal_prism(50.2, 20, 4);`;
const { sdf } = evaluate(src, 'rim.js');
const g = emitGlsl(sdf);

const R = 50.2 / Math.cos(Math.PI / 6) / 2, BRUSH = 4, HALF = 10;
const poly = [];
for (let k = 0; k < 6; k++)
	poly.push([Math.SQRT2 * R * Math.cos(k * Math.PI / 3), R * Math.sin(k * Math.PI / 3)]);

// the distance to a convex polygon, written here rather than imported: the whole point is to disagree with the
// field if the field is wrong
function polygonDistance(px, py) {
	let inside = true, best = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i], b = poly[(i + 1) % poly.length];
		const ex = b[0] - a[0], ey = b[1] - a[1];
		if (ex * (py - a[1]) - ey * (px - a[0]) < 0)
			inside = false;
		const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / (ex * ex + ey * ey)));
		best = Math.min(best, Math.hypot(px - (a[0] + t * ex), py - (a[1] + t * ey)));
	}
	return inside ? -best : best;
}
// the true distance to the sharp-edged prism: the rounded-box correction (see the header comment) applied to
// the 2-D offset distance and the z-clamp, not plain max() of the two
const exact = (p) => {
	const d2 = polygonDistance(p[0], p[1]) - BRUSH, dz = Math.abs(p[2]) - HALF;
	return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
};

const apothem = R * Math.cos(Math.PI / 6);
const inside = (y, z) => evalSdf(sdf, [0, y, z]) < 0;
const span = (z) => {
	let lo = null, hi = null;
	for (let y = 20; y <= 34; y += 0.001) if (inside(y, z)) { if (lo === null) lo = y; hi = y; }
	return lo === null ? null : [lo, hi];
};
let maxZ = null;
for (let z = 9.9; z < 13; z += 0.001) if (span(z)) maxZ = z;

console.log(`cap plane z = ${HALF.toFixed(3)}, exact offset wall y = ${(apothem + BRUSH).toFixed(3)}`);
console.log(`highest z inside anywhere: ${maxZ === null ? 'none' : maxZ.toFixed(3)}   (exact: ${HALF.toFixed(3)}, rolled: ~${(HALF + BRUSH / 2).toFixed(3)})`);
for (const z of [9.9, 10.0, 10.5, 11.0, 11.5])
	console.log(`   at z = ${z.toFixed(2)}: ${(() => { const s = span(z); return s ? `inside y in [${s[0].toFixed(3)}, ${s[1].toFixed(3)}]` : 'outside everywhere'; })()}`);

(async () => {
	const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);

	// the field itself, over the rim where the two formulas differ most
	let worst = 0, worstAt = null, seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const pts = [];
	for (let y = apothem - 2; y <= apothem + 6; y += 0.05)
		for (let z = 8; z <= 12; z += 0.05)
			pts.push([0, y, z]);
	for (let i = 0; i < 20000; i++)
		pts.push([(rand() - 0.5) * 60, (rand() - 0.5) * 60, (rand() - 0.5) * 30]);

	const results = await shader.at(pts);
	for (let i = 0; i < pts.length; i++) {
		const d = results[i][0];
		if (!Number.isFinite(d)) { worst = Infinity; worstAt = pts[i]; break; }
		const err = Math.abs(d - exact(pts[i]));
		if (err > worst) { worst = err; worstAt = pts[i]; }
	}
	console.log(`shader vs the closed-form offset: worst ${worst.toExponential(3)} at [${worstAt.map(v => v.toFixed(3)).join(', ')}]`);
	let mworst = 0;
	for (const p of pts) mworst = Math.max(mworst, Math.abs(evalSdf(sdf, p) - exact(p)));
	console.log(`mirror vs the closed-form offset: worst ${mworst.toExponential(3)}`);

	let fail = 0;
	const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); fail++; } };
	check(worst < 1e-4, `the shader's rim is rolled: ${worst.toExponential(3)} from the exact offset`);
	check(mworst < 1e-9, `the mirror's rim is rolled: ${mworst.toExponential(3)}`);
	check(maxZ !== null && Math.abs(maxZ - HALF) < 0.002, `material above the cap plane: highest z ${maxZ}`);
	console.log(fail ? `${fail} FAILED` : 'ok: the rim is a sharp edge over a round vertical corner');
	await close();
	process.exit(fail ? 1 : 0);
})();
