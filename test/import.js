// import() of a mesh (STL, ASCII or binary; OFF; OBJ), and polyhedron() when it is not convex: both are drawn from their
// triangles, whose field is the real signed distance. So what is checked is the distance itself, against the nearest
// triangle found the slow way, and its sign, against which side of the surface a ray from the point says it is on --
// not against the pseudonormals the field itself uses. The shader has to agree with the mirror.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { FileReader } = require('../out/src/scad/filereader.js');
const { AMF, ThreeMF } = require('@isopodlabs/binary_meshes');
const { makeZip } = require('@isopodlabs/binary_meshes/dist/zip');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
const files = new FileReader();
const run = (src) => files.with(() => evaluate(src, path.join(dir, 'main.scad'), files));

let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// An L-shaped prism, 10 x 10 x 4 with a 6 x 6 bite out of one corner: not convex, so its hull would be wrong by
// the bite. Faces as quads and the two L-shaped ends, wound anticlockwise seen from outside.
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const points = [...L.map(([x, y]) => [x, y, 0]), ...L.map(([x, y]) => [x, y, 4])];
const n = L.length;
const faces = [
	L.map((_, i) => n - 1 - i),						// the bottom, seen from below
	L.map((_, i) => n + i),							// the top
	...L.map((_, i) => [i, (i + 1) % n, n + (i + 1) % n, n + i]),
];
const VOLUME = (100 - 36) * 4;
// its triangles for the slow references, by hand rather than by the code under test: the sides' quads halved, and each
// L-shaped end fanned from its inner corner (4, 4), which sees the whole of it
const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const end = (z, up) => [[[4, 10], [0, 10]], [[0, 10], [0, 0]], [[0, 0], [10, 0]], [[10, 0], [10, 4]]].map(([b, c]) => {
	const fan = [[4, 4, z], [...b, z], [...c, z]];
	return up ? fan : [fan[0], fan[2], fan[1]];
});
const tris = [
	...L.flatMap((_, i) => quad(points[i], points[(i + 1) % n], points[n + (i + 1) % n], points[n + i])),
	...end(0, false), ...end(4, true),
];

function triDist(p, [a, b, c]) {
	const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	const add = (u, v, s) => [u[0] + v[0] * s, u[1] + v[1] * s, u[2] + v[2] * s];
	const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
	const d1 = dot(ab, ap), d2 = dot(ac, ap);
	let q;
	if (d1 <= 0 && d2 <= 0) q = a;
	else {
		const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
		const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
		const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
		if (d3 >= 0 && d4 <= d3) q = b;
		else if (d6 >= 0 && d5 <= d6) q = c;
		else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = add(a, ab, d1 / (d1 - d3));
		else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = add(a, ac, d2 / (d2 - d6));
		else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) q = add(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
		else { const den = 1 / (va + vb + vc); q = add(add(a, ab, vb * den), ac, vc * den); }
	}
	const d = sub(p, q);
	return Math.sqrt(dot(d, d));
}

// inside by ray parity (Moller-Trumbore), along a direction no face or edge of the L lines up with
function inside(p) {
	const dir = [0.5773, 0.4071, 0.7071];
	let hits = 0;
	for (const [a, b, c] of tris) {
		const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		const h = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
		const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
		if (Math.abs(det) < 1e-12)
			continue;
		const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
		const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
		const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
		const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
		const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
		if (u >= 0 && v >= 0 && u + v <= 1 && t > 0)
			hits++;
	}
	return hits % 2 === 1;
}

// the L in each format
fs.writeFileSync(path.join(dir, 'l.off'), `OFF\n# an L\n${points.length} ${faces.length} 0\n${points.map(p => p.join(' ')).join('\n')}\n${faces.map(f => `${f.length} ${f.join(' ')}`).join('\n')}\n`);
fs.writeFileSync(path.join(dir, 'l.obj'), `# an L\n${points.map(p => `v ${p.join(' ')}`).join('\n')}\nvn 0 0 1\n${faces.map(f => `f ${f.map(i => `${i + 1}//1`).join(' ')}`).join('\n')}\n`);
fs.writeFileSync(path.join(dir, 'l-ascii.stl'), `solid l\n${tris.map(t => `facet normal 0 0 0\n outer loop\n${t.map(v => `  vertex ${v.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid l\n`);
{
	const b = Buffer.alloc(84 + 50 * tris.length);
	b.write('solid -- a binary STL may begin like an ASCII one', 0, 'latin1');
	b.writeUInt32LE(tris.length, 80);
	tris.forEach((t, i) => t.flat().forEach((v, k) => b.writeFloatLE(v, 84 + 50 * i + 12 + 4 * k)));
	fs.writeFileSync(path.join(dir, 'l-binary.stl'), b);
}

(async () => {

// AMF and 3MF, which may be zipped, and so are loaded between evaluations
{
	const mesh = {points: points.map(([x, y, z]) => float3(x, y, z)), faces};
	fs.writeFileSync(path.join(dir, 'l.amf'), AMF.save(mesh));
	fs.writeFileSync(path.join(dir, 'l-zipped.amf'), await makeZip({'l.amf': AMF.save(mesh)}));
	fs.writeFileSync(path.join(dir, 'l.3mf'), await ThreeMF.save(mesh));
	fs.writeFileSync(path.join(dir, 'broken.3mf'), 'not a zip');
	const broken = await run('import("broken.3mf");');
	check(broken.sdf.k === 'empty' && broken.warnings.some(w => w.includes('could not be read')), `a broken 3MF should be reported: ${broken.warnings}`);
}

//--- each format: the distance, its sign, the volume -------------------------------------------------------
const samples = Array.from({length: 600}, () => [rand() * 16 - 3, rand() * 16 - 3, rand() * 10 - 3]);
for (const file of ['l.off', 'l.obj', 'l-ascii.stl', 'l-binary.stl', 'l.amf', 'l-zipped.amf', 'l.3mf']) {
	const { sdf, warnings } = await run(`import("${file}");`);
	check(warnings.length === 0, `${file} should import without complaint: ${warnings}`);
	check(sdf.k === 'trimesh' && sdf.closed, `${file} should be a closed mesh, not ${sdf.k}`);
	let worst = 0, wrong = 0;
	for (const p of samples) {
		const d = evalSdf(sdf, p), real = tris.reduce((m, t) => Math.min(m, triDist(p, t)), Infinity);
		worst = Math.max(worst, Math.abs(Math.abs(d) - real));
		if (real > 1e-9 && (d < 0) !== inside(p))
			wrong++;
	}
	check(worst < 1e-9, `${file}: the distance should be the nearest triangle's, off by ${worst}`);
	check(wrong === 0, `${file}: ${wrong} of ${samples.length} points on the wrong side`);
	const stats = checkMesh(await meshUniform(sdf, { cells: 64 }));
	check(Math.abs(stats.volume - VOLUME) / VOLUME < 1e-3, `${file}: the volume should be ${VOLUME}, not ${stats.volume.toFixed(2)}`);
	console.log(`${file}: distance exact to ${worst.toExponential(1)}, ${samples.filter(inside).length} samples inside, volume ${stats.volume.toFixed(2)}`);
}

//--- polyhedron(): the same L, wound as OpenSCAD's faces are (clockwise from outside), is no longer its hull -------
{
	const src = `polyhedron(points = ${JSON.stringify(points)}, faces = ${JSON.stringify(faces.map(f => [...f].reverse()))});`;
	const { sdf, warnings } = await run(src);
	check(sdf.k === 'trimesh' && warnings.length === 0, `a concave polyhedron should be a mesh without complaint: ${sdf.k} ${warnings}`);
	check(evalSdf(sdf, [7, 7, 2]) > 2.9, 'the bite out of the L should be outside it, 3 from its walls');
	check(Math.abs(evalSdf(sdf, [2, 2, 2]) + 2) < 1e-9, 'a point 2 in from the L\'s walls should be at -2');
	// a convex one is still exact half-spaces
	const cube = await run('polyhedron([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]], [[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]);');
	check(cube.sdf.k === 'planes', `a convex polyhedron should stay half-spaces, not ${cube.sdf.k}`);
	console.log('polyhedron: a concave one is its triangles, a convex one its planes');
}

//--- center, and a stretch, which the mesh follows by moving its corners --------------------------------------
{
	const { sdf: centred } = await run('import("l.off", center = true);');
	check(Math.abs(evalSdf(centred, [-5 + 2, -5 + 2, 0]) + 2) < 1e-9, 'center = true should put the middle of the box at the origin');
	const { sdf: stretched } = await run('scale([2, 1, 1]) import("l.off");');
	check(stretched.k === 'trimesh', `a stretched mesh should still be a mesh, not ${stretched.k}`);
	check(Math.abs(evalSdf(stretched, [19, 2, 2]) + 1) < 1e-9, 'stretched to 20 wide, a point 1 in from the end should be at -1');
	const { sdf: mirrored } = await run('mirror([1, 0, 0]) import("l.off");');
	check(Math.abs(evalSdf(mirrored, [-2, 2, 2]) + 2) < 1e-9, 'a mirrored mesh should still have its inside inside');
	console.log('center, stretch, mirror: checked');
}

//--- the shader agrees with the mirror -------------------------------------------------------------------
{
	const { sdf } = await run('translate([1, 2, 3]) rotate([10, 20, 30]) import("l-binary.stl");');
	const g = emitGlsl(sdf);
	const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
	const pts = Array.from({length: 500}, () => [rand() * 20 - 5, rand() * 20 - 5, rand() * 16 - 5]);
	const results = await shader.at(pts);
	const worst = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
	check(worst < 1e-4, `the shader and the mirror differ by ${worst}`);
	console.log(`shader agrees to ${worst.toExponential(1)}`);
}

//--- real files: OpenSCAD's own example, and a big one ---------------------------------------------------
for (const file of ['/Volumes/DevSSD/dev/github/openscad/examples/Basics/projection.stl', '/Volumes/DevSSD/dev/packages/rhombic_boggle.stl']) {
	if (!fs.existsSync(file))
		continue;
	const t0 = Date.now();
	const { sdf, warnings } = await run(`import("${file}");`);
	const built = Date.now() - t0;
	check(sdf.k === 'trimesh', `${path.basename(file)} should be a mesh, not ${sdf.k}: ${warnings}`);
	// the volume the triangles enclose, against the mesh the field meshes to
	let volume = 0;
	for (let t = 0; t < sdf.tris.length; t += 3) {
		const [a, b, c] = [0, 1, 2].map(k => sdf.points[sdf.tris[t + k]]);
		volume += a.dot(b.cross(c)) / 6;
	}
	const t1 = Date.now();
	const stats = checkMesh(await meshUniform(sdf, { cells: 96 }));
	check(Math.abs(stats.volume - volume) / volume < 2e-2, `${path.basename(file)}: the mesh should enclose ${volume.toFixed(0)}, not ${stats.volume.toFixed(0)}`);
	console.log(`${path.basename(file)}: ${sdf.tris.length / 3} triangles, ${sdf.closed ? 'closed' : 'NOT closed'}, built in ${built} ms, meshed in ${Date.now() - t1} ms; volume ${stats.volume.toFixed(0)} against ${volume.toFixed(0)}${warnings.length ? '; ' + warnings : ''}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'ok: imported meshes and concave polyhedra measure their real signed distance, in the shader too');
await close();
process.exit(bad ? 1 : 0);

})();
