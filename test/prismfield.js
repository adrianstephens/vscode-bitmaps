// A faceted cylinder (cylinder with $fn) is a convex polyhedron, drawn from its faces. Each face is measured to its
// own polygon, so the polygon has to be the whole face: facePlanes once kept only a face's first three corners, which
// took a bite out of every quad side and every cap of more than three sides, and a point near the missing corner was
// measured to the wrong place -- the field came out further than the real distance, and lit wrongly in the viewer. What
// is checked is that the field is never further than the true distance to the prism, and has the right sign.
const { evaluate } = require('./scadhost.js');
const { FileReader } = require('../out/src/filereader.js');
const { SDF } = require('../out/src/scad/sdf.js');
const evalSdf = (s, p) => new SDF(s).eval(p);
const { float3 } = require('@isopodlabs/maths/vector');

const files = new FileReader();
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// exact signed distance to a regular n-gon prism, the first corner on +x as OpenSCAD lays it out
function reference(n, r, h) {
	const V = Array.from({length: n}, (_, i) => [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)]);
	const poly = (x, y) => {
		let d2 = Infinity, inside = true;
		for (let i = 0; i < n; i++) {
			const a = V[i], b = V[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1];
			const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey)));
			d2 = Math.min(d2, (x - a[0] - ex * t) ** 2 + (y - a[1] - ey * t) ** 2);
			if (ex * (y - a[1]) - ey * (x - a[0]) < 0) inside = false;
		}
		return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
	};
	return (x, y, z) => { const a = poly(x, y), b = Math.max(-z, z - h); return Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0); };
}

(async () => {
	for (const n of [3, 4, 5, 6, 8, 12]) {
		const r = await files.with(() => evaluate(`cylinder(r=5, h=2, $fn=${n});`, '/tmp/prismfield.scad', files));
		let sdf = r.sdf;
		while (sdf.body) sdf = sdf.body;
		check(sdf.k === 'planes', `$fn=${n} should be a polyhedron, got ${sdf.k}`);
		if (sdf.k === 'planes') {
			const corners = sdf.faces.map(f => f.length).sort((a, b) => a - b);
			const want = n === 4 ? [4, 4, 4, 4, 4, 4] : [4, ...Array(n - 1).fill(4), n, n].sort((x, y) => x - y);
			check(corners.length === want.length && corners.every((c, i) => c === want[i]), `$fn=${n}: faces should be two caps of ${n} and ${n} quads, got ${corners}`);
		}
		const exact = reference(n, 5, 2);
		let over = 0, wrong = 0, worst = 0;
		for (let i = 0; i < 4000; i++) {
			const p = [rnd() * 14 - 7, rnd() * 14 - 7, rnd() * 6 - 2];
			const e = exact(...p), g = evalSdf(r.sdf, float3(...p));
			if (Math.sign(e) !== Math.sign(g)) wrong++;
			if (g > e + 1e-9) { over++; worst = Math.max(worst, g - e); }
		}
		check(wrong === 0 && over === 0, `$fn=${n}: ${wrong} wrong signs, ${over} of 4000 points where the field is further than the true distance (by up to ${worst.toFixed(3)})`);
	}
	console.log(bad ? `${bad} FAILED` : 'faceted cylinders: every face is whole, the field is never further than the prism');
	process.exit(bad ? 1 : 0);
})();
