// Is a rotated box placed the way OpenSCAD places it?
//
// The cube's rotation is the one place where a transposed matrix or a flipped sign hides: the shader and the mirror
// share the transform code, so their agreeing proves nothing. This compares both against an OBB distance built here
// from scratch:
//   * the rotation matrix is copied verbatim out of OpenSCAD (src/core/TransformNode.cc, builtin_rotate), so the
//     direction of a rotation is settled by the reference implementation rather than by my memory of it;
//   * the cube's corners are rotated by it explicitly, and the distance is then measured to the six *face
//     rectangles* of that rotated box in world space -- a different route to the box's transform, not a re-use.
// The shader is compiled and run for real in headless Chrome (test/webgl.js), not through a hand-written
// reimplementation of GLSL.
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { float3 } = require('@isopodlabs/maths/vector');

// evalSdf takes a float3 (@isopodlabs/maths); everything else here uses [x,y,z] arrays, so it is shadowed
// to match -- see fields.js for why passing it an array unwrapped silently returns NaN instead of erroring.
const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));

// verbatim from openscad's builtin_rotate: M << cy*cz, cz*sx*sy - cx*sz, cx*cz*sy + sx*sz, ...
function scadRotation([x, y, z]) {
	const [sx, cx] = [Math.sin(x * Math.PI / 180), Math.cos(x * Math.PI / 180)];
	const [sy, cy] = [Math.sin(y * Math.PI / 180), Math.cos(y * Math.PI / 180)];
	const [sz, cz] = [Math.sin(z * Math.PI / 180), Math.cos(z * Math.PI / 180)];
	return [
		cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
		cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
		-sy, cy * sx, cx * cy,
	];
}
const apply = (m, p) => [0, 1, 2].map(i => m[3 * i] * p[0] + m[3 * i + 1] * p[1] + m[3 * i + 2] * p[2]);

// the exact distance to a convex box given by its six face rectangles in world space: the nearest point of the
// surface lies in one of the face regions, so the distance is their minimum, signed by an inside test
function boxDistance(faces, p) {
	let inside = true, best = Infinity;
	for (const {base, u, v, n, hu, hv} of faces) {
		const w = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
		if (w[0] * n[0] + w[1] * n[1] + w[2] * n[2] > 0)
			inside = false;
		// the closest point of the rectangle: clamp the in-plane coordinates, then keep the perpendicular part
		const du = Math.max(-hu, Math.min(hu, w[0] * u[0] + w[1] * u[1] + w[2] * u[2]));
		const dv = Math.max(-hv, Math.min(hv, w[0] * v[0] + w[1] * v[1] + w[2] * v[2]));
		const c = [base[0] + du * u[0] + dv * v[0] - p[0], base[1] + du * u[1] + dv * v[1] - p[1], base[2] + du * u[2] + dv * v[2] - p[2]];
		best = Math.min(best, Math.hypot(c[0], c[1], c[2]));
	}
	return inside ? -best : best;
}

const CASES = [
	['rotate([30,0,0]) cube([1,2,3]);', [30, 0, 0], [[0, 1], [0, 2], [0, 3]]],
	['rotate([0,90,0]) cube([1,2,3]);', [0, 90, 0], [[0, 1], [0, 2], [0, 3]]],
	['rotate([0,0,90]) cube([1,2,3]);', [0, 0, 90], [[0, 1], [0, 2], [0, 3]]],
	['rotate([20,-35,10]) cube([2,3,4], center = true);', [20, -35, 10], [[-1, 1], [-1.5, 1.5], [-2, 2]]],
];

(async () => {
	let bad = 0;
	for (const [src, angles, extents] of CASES) {
		const { sdf } = evaluate(src, 'rotate.js');
		const g = emitGlsl(sdf);
		const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
		const m = scadRotation(angles);
		// the eight rotated corners, and from them the six faces
		const corners = [];
		for (let i = 0; i < 8; i++)
			corners.push(apply(m, [extents[0][i & 1], extents[1][(i >> 1) & 1], extents[2][(i >> 2) & 1]]));
		const centre = apply(m, extents.map(e => (e[0] + e[1]) / 2));
		const axis = [0, 1, 2].map(i => apply(m, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]));
		const half = extents.map(e => (e[1] - e[0]) / 2);
		const faces = [];
		for (let i = 0; i < 3; i++) {
			const u = axis[(i + 1) % 3], v = axis[(i + 2) % 3];
			for (const s of [1, -1]) {
				const n = axis[i].map(c => c * s);
				const base = centre.map((c, k) => c + n[k] * half[i]);
				faces.push({base, u, v, n, hu: half[(i + 1) % 3], hv: half[(i + 2) % 3]});
			}
		}
		const exact = (p) => boxDistance(faces, p);

		let worst = 0, at = null, seed = 3;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (let i = 0; i < 20000; i++) {
			const p = [0, 1, 2].map(k => (rand() - 0.5) * 12);
			const err = Math.abs(evalSdf(sdf, p) - exact(p));
			if (err > worst) { worst = err; at = p; }
		}
		// the shader's own points, batched through headless Chrome in one draw rather than one round trip each
		const spts = Array.from({length: 5000}, () => [0, 1, 2].map(k => (rand() - 0.5) * 12));
		const sresults = await shader.at(spts);
		let sworst = 0;
		for (let i = 0; i < spts.length; i++) {
			const d = sresults[i][0];
			if (!Number.isFinite(d)) { sworst = Infinity; break; }
			sworst = Math.max(sworst, Math.abs(d - exact(spts[i])));
		}
		// and every rotated corner must be exactly on the surface, whichever way the rotation went
		let cworst = 0;
		for (const c of corners) cworst = Math.max(cworst, Math.abs(evalSdf(sdf, c)));
		const ok = worst < 1e-9 && cworst < 1e-9 && sworst < 1e-4;
		if (!ok) bad++;
		console.log(`${src.padEnd(45)} mirror ${worst.toExponential(2)}  shader ${sworst.toExponential(2)}  corners ${cworst.toExponential(2)}  ${ok ? 'ok' : `FAIL${at ? ` at [${at.map(v => v.toFixed(3))}]` : ''}`}`);
	}
	await close();
	process.exit(bad ? 1 : 0);
})();
