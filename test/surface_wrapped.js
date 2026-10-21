// wrap(kind, r = ...): surface()'s grid -- or anything else -- bent around a surface of revolution instead of laid on
// the plane: r is the surface it is wrapped *around*, the body's own floor lands on it and its heights are the
// thickness standing off it, so the solid is a shell from r out to them (see wrappedHeightmapDistance in sdf.ts).
// How far round it goes is the body's own size: a flat grid is a whole surface (its columns are a ring) and anything
// else covers the arc its width is. This is an extension of
// our own -- OpenSCAD's surface() is flat only, and wrapping one round a sphere is what its issue #815 has wanted
// since 2014 (with #994, wrapping one round a cylinder, closed as a duplicate of it).
//
// It is only possible at all because a model here is a field rather than a mesh: there are no faces to subdivide and
// stitch back together, only a query point to carry into the grid's own coordinates. What is checked is what a bound
// owes -- the right sign everywhere, the surface exactly where the heights and their four triangles say, never
// further than the real distance to that surface -- and, with it, the seam closing without a crack, the poles taking
// one height each, the mesh enclosing the volume the surface does, and the shader agreeing with the mirror.
//
// The surface itself is the grid interpolated in the map's own coordinates and then bent, so a cell is not flat in
// space the way OpenSCAD's is on the plane; the triangles the tests measure against are a fine division of it, which
// is within a hair of the curve (see DIVISIONS).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { FileReader } = require('../out/src/scad/filereader.js');
const { emitGlsl, heightmap, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

let seed = 17;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const COLS = 30, ROWS = 22, R = 50, BOTTOM = -1, H = (ROWS - 1) / 2;	// a wrapped grid's base is r itself: its floor moves to r
const DIVISIONS = 4;		// how finely a cell is divided to measure against: the curve is then within 0.01 of it
const SLACK = 0.02;			// ... so a bound is allowed to be that much beyond the triangles and still be honest

// Where a grid point stands: column i at longitude 2 pi i / cols, row j at latitude pi (rows - 1 - j) / (rows - 1) on
// a sphere -- the first row is the south pole and the last the north, as the wrap maps them -- or at height
// j - (rows - 1) / 2 on a cylinder, at radius r + that height.
function gridPoint(wrap, r, cols, rows, i, j, h) {
	const ph = 2 * Math.PI * i / cols, rad = r + h[j * cols + i];
	if (wrap === 'sphere') {
		const th = Math.PI * (rows - 1 - j) / (rows - 1);
		return [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)];
	}
	return [rad * Math.cos(ph), rad * Math.sin(ph), j - (rows - 1) / 2];
}

// The height the grid interpolates at a continuous column (periodic) and row: the four triangles of the cell, meeting
// at its centre at the mean of the corners -- the rule the field itself uses, written out again here so the surface
// it bounds3 can be built without asking it.
function chartHeight(cols, rows, h, u, v) {
	const cy = Math.min(Math.max(v, 0), rows - 1), cj = Math.min(Math.floor(cy), rows - 2), dv = cy - cj - 0.5;
	const cx = u - Math.floor(u / cols) * cols, ci = Math.floor(cx), du = cx - ci - 0.5;
	const i1 = ci + 1 < cols ? ci + 1 : 0;
	const k = cj * cols + ci, k1 = cj * cols + i1, k2 = k + cols, k3 = k1 + cols;
	const v1 = h[k], v2 = h[k1], v3 = h[k2], v4 = h[k3], m = (v1 + v2 + v3 + v4) / 4;
	if (dv <= -Math.abs(du))
		return m + (v2 - v1) * du + 2 * (m - (v1 + v2) / 2) * dv;
	if (dv >= Math.abs(du))
		return m + (v4 - v3) * du + 2 * ((v3 + v4) / 2 - m) * dv;
	if (du < 0)
		return m + (v3 - v1) * dv + 2 * (m - (v1 + v3) / 2) * du;
	return m + (v4 - v2) * dv + 2 * ((v2 + v4) / 2 - m) * du;
}

// where a member of the grid's own coordinates stands in space
function chartPoint(wrap, r, cols, rows, h, u, v) {
	const ph = 2 * Math.PI * u / cols, rad = r + chartHeight(cols, rows, h, u, v);
	if (wrap === 'sphere') {
		const th = Math.PI * (rows - 1 - v) / (rows - 1);
		return [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)];
	}
	return [rad * Math.cos(ph), rad * Math.sin(ph), v - (rows - 1) / 2];
}

// The surface, divided finely: each cell into DIVISIONS by DIVISIONS, and a cylinder's two open ends closed with the
// flat annuli between the tube and the base cylinder (the solid's own end faces).
function chartSurface(wrap, r, cols, rows, h, withEnds) {
	const tris = [];
	for (let j = 1; j < rows; j++)
		for (let i = 0; i < cols; i++)
			for (let a = 0; a < DIVISIONS; a++)
				for (let b = 0; b < DIVISIONS; b++) {
					const u0 = i + a / DIVISIONS, u1 = i + (a + 1) / DIVISIONS, v0 = j - 1 + b / DIVISIONS, v1 = j - 1 + (b + 1) / DIVISIONS;
					const p00 = chartPoint(wrap, r, cols, rows, h, u0, v0), p10 = chartPoint(wrap, r, cols, rows, h, u1, v0);
					const p11 = chartPoint(wrap, r, cols, rows, h, u1, v1), p01 = chartPoint(wrap, r, cols, rows, h, u0, v1);
					tris.push([p00, p10, p11], [p00, p11, p01]);
				}
	if (wrap === 'cylinder' && withEnds)
		// the flat ends of the solid the tube bounds3, fanned from the axis -- so that with the tube the whole outer
		// solid is closed and the divergence theorem gives its volume, from which the base cylinder's is taken
		for (const [j, z] of [[0, -H], [rows - 1, H]])
			for (let i = 0; i < cols; i++)
				for (let a = 0; a < DIVISIONS; a++) {
					const u0 = i + a / DIVISIONS, u1 = i + (a + 1) / DIVISIONS;
					const o0 = chartPoint(wrap, r, cols, rows, h, u0, j), o1 = chartPoint(wrap, r, cols, rows, h, u1, j);
					// wound so that the end points away from the solid: up at one end, down at the other
					if (z > 0) tris.push([[0, 0, z], o0, o1]);
					else tris.push([[0, 0, z], o1, o0]);
				}
	return tris;
}

// where the surface stands in a point's own direction: the map's height there, as a radius
function surfaceRadius(wrap, r, cols, rows, h, p) {
	const ph = Math.atan2(p[1], p[0]);
	const u = (ph < 0 ? ph + 2 * Math.PI : ph) / (2 * Math.PI) * cols;
	const v = wrap === 'sphere'
		? Math.acos(Math.max(-1, Math.min(1, -p[2] / Math.max(Math.hypot(p[0], p[1], p[2]), 1e-12)))) / Math.PI * (rows - 1)
		: p[2] + (rows - 1) / 2;
	return r + chartHeight(cols, rows, h, u, v);
}

// the distance from p to a triangle (Ericson's closest point)
function triDist(p, [a, b, c]) {
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
		else { const den = 1 / (va + vb + vc); q = den && isFinite(den) ? add(add(a, ab, vb * den), ac, vc * den) : a; }
	}
	const d = sub(p, q), out = Math.sqrt(dot(d, d));
	return isFinite(out) ? out : Infinity;
}

// A point near the surface: a direction, how far along it the surface stands, and a little off it either way. The
// sphere's direction is a whole 3-D one, the cylinder's a bearing with a height inside its own rows.
function nearSurface(wrap, r, cols, rows, h, spread) {
	const phi = rand() * 2 * Math.PI;
	const z = wrap === 'sphere' ? rand() * 2 - 1 : (rand() * 2 - 1) * (H - 1.5);
	const u = phi / (2 * Math.PI) * cols;
	const v = wrap === 'sphere' ? Math.acos(-z) / Math.PI * (rows - 1) : z + (rows - 1) / 2;
	const sigma = r + chartHeight(cols, rows, h, u, v) * (1 + spread * (rand() - 0.5));
	if (wrap === 'sphere') {
		const th = Math.acos(-z);
		return [sigma * Math.sin(th) * Math.cos(phi), sigma * Math.sin(th) * Math.sin(phi), sigma * -z];
	}
	return [sigma * Math.cos(phi), sigma * Math.sin(phi), z];
}

// the volume a closed triangle list encloses, from the divergence theorem
function enclosedVolume(tris) {
	let v = 0;
	for (const [a, b, c] of tris)
		v += dot(a, cross(b, c));
	return v / 6;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-'));
const files = new FileReader();
// a source naming a .dat in `dir`, evaluated with nothing loaded first: a .dat is its own text, so it needs no more
const run = (code) => files.with(() => evaluate(code, path.join(dir, 'main.scad'), files));

(async () => {

// a ridge, a cliff and noise: enough that tiles differ and that the seam is not accidentally smooth
const source = Array.from({length: ROWS}, (_, j) => Array.from({length: COLS}, (_, i) =>
	2 + Math.sin(i / 3) * 1.5 + (i > 18 ? 3 : 0) + (j > 14 ? 2 : 0) + rand() * 0.6));
const flat = Float64Array.from(source.flat());

// The shader is the renderer, so the mirror and it have to agree; the harness that compiles it needs a headless
// Chrome, and where that cannot start there is nothing to compare against, which is said rather than failed.
let shaderReady = true;
try {
	const probe = await makeShader('vec2 map(vec3 p) { return vec2(length(p) - 1.0, 0.0); }', 'map');
	await probe.one([0, 0, 0]);
} catch (error) {
	shaderReady = false;
	console.log(`   note: the GLSL harness is unavailable, so the shader checks are skipped (${error.message.split('\n')[0]})`);
}

//--- a sphere and a cylinder: the surface exactly where the heights say, and the bound honest about the rest -------
for (const wrap of ['sphere', 'cylinder']) {
	const sdf = heightmap(COLS, ROWS, flat, BOTTOM, {kind: wrap, r: R});
	check(!!sdf && sdf.wrap.kind === wrap, `${wrap}: should build a wrapped heightmap`);
	const h = sdf.heights;

	// the base is r itself, and the grid is measured from there: the field is zero on the surface (r + the height)
	// and positive just inside the base
	check(Math.abs(evalSdf(sdf, [R - 0.05, 0, 0])) > 0.02, `${wrap}: nothing should be inside the base at r = ${R}`);
	// on every grid point the field is zero
	let worstOn = 0;
	for (let j = 0; j < ROWS; j++)
		for (let i = 0; i < COLS; i++)
			worstOn = Math.max(worstOn, Math.abs(evalSdf(sdf, gridPoint(wrap, R, COLS, ROWS, i, j, h))));
	check(worstOn < 1e-4, `${wrap}: the surface should pass through every grid point, off by ${worstOn}`);

	// against the surface's own triangles: the sign right, and never further than the real distance. A cell whose
	// corners meet -- the ones round a sphere's poles -- has no area and no distance of its own, so it is left out.
	const area = (t) => Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2;
	const tris = chartSurface(wrap, R, COLS, ROWS, h, false).filter(t => area(t) > 1e-9);
	let over = 0, wrongSign = 0, ratio = 0, n = 0, insideCount = 0;
	for (let k = 0; k < 300; k++) {
		const p = nearSurface(wrap, R, COLS, ROWS, h, 0.35);
		// the radius that matters is the one the map's own rows are at: the distance from the axis on a cylinder,
		// and from the centre on a sphere
		const rad = wrap === 'sphere' ? Math.hypot(p[0], p[1], p[2]) : Math.hypot(p[0], p[1]);
		const inside = rad > R && rad < surfaceRadius(wrap, R, COLS, ROWS, h, p);
		const field = evalSdf(sdf, p);
		const real = Math.min(Math.abs(rad - R), tris.reduce((m, t) => Math.min(m, triDist(p, t)), Infinity));
		insideCount += inside ? 1 : 0;
		if (Math.abs(field) > real + SLACK)
			over = Math.max(over, Math.abs(field) - real);
		if ((field < 0) !== inside && real > 1e-6)
			wrongSign++;
		if (field > 0) { ratio += field / Math.max(real, 1e-9); n++; }
	}
	check(over === 0, `${wrap}: the field should never be further than the real distance, but was by ${over}`);
	check(wrongSign === 0, `${wrap}: ${wrongSign} of 300 points on the wrong side`);
	check(insideCount > 50, `${wrap}: only ${insideCount} of the sampled points were inside, too few to test the sign`);
	check(n > 20 && ratio / n > 0.2, `${wrap}: the bound is only ${(100 * ratio / n).toFixed(0)}% of the real distance outside, too loose to be a bound at all`);

	// the seam: the last column meets the first, so the height either side of it is one value, and a point standing
	// on the surface there is on the surface
	const seamA = chartHeight(COLS, ROWS, h, -1e-6, (ROWS - 1) / 2), seamB = chartHeight(COLS, ROWS, h, 1e-6, (ROWS - 1) / 2);
	check(Math.abs(seamA - seamB) < 1e-3, `${wrap}: the grid should not jump across the seam, but moved ${Math.abs(seamA - seamB)}`);
	const onSeam = (delta) => {
		const u = delta < 0 ? COLS + delta : delta, ph = 2 * Math.PI * u / COLS;
		const rad = R + chartHeight(COLS, ROWS, h, u, (ROWS - 1) / 2);
		return wrap === 'sphere' ? [rad * Math.cos(ph), rad * Math.sin(ph), 0] : [rad * Math.cos(ph), rad * Math.sin(ph), 0];
	};
	check(Math.max(Math.abs(evalSdf(sdf, onSeam(-1e-6))), Math.abs(evalSdf(sdf, onSeam(1e-6)))) < 1e-3, `${wrap}: a point on the surface at the seam should be on it`);

	// the volume: the surface's own, by the divergence theorem, against the mesh's
	const closed = chartSurface(wrap, R, COLS, ROWS, h, true);
	const shellVolume = Math.abs(enclosedVolume(closed)) - (wrap === 'sphere' ? 4 / 3 * Math.PI * R ** 3 : Math.PI * R ** 2 * (ROWS - 1));
	const stats = checkMesh(await meshUniform(sdf, { cells: 110 }));
	check(Math.abs(stats.volume - shellVolume) / shellVolume < 1e-2, `${wrap}: the mesh should enclose ${shellVolume.toFixed(1)}, not ${stats.volume.toFixed(1)}`);

	// the shader agrees with the mirror
	let worstShader = 0;
	if (shaderReady) {
		const g = emitGlsl(sdf);
		const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
		const pts = Array.from({length: 250}, () => nearSurface(wrap, R, COLS, ROWS, h, 0.2));
		const results = await shader.at(pts);
		worstShader = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
		check(worstShader < 1e-3, `${wrap}: the shader and the mirror differ by ${worstShader}`);
	}
	console.log(`${wrap}: on the surface to ${worstOn.toExponential(1)}; ${insideCount} of 300 samples inside; outside, the bound is ${(100 * ratio / n).toFixed(0)}% of the real distance on average; the mesh encloses ${stats.volume.toFixed(1)} against ${shellVolume.toFixed(1)}${shaderReady ? `; the shader agrees to ${worstShader.toExponential(1)}` : ''}`);
}

//--- a sphere's poles are one point each, so each takes its own mean height ---------------------------------------
{
	const raised = Float64Array.from(flat);
	for (let i = 0; i < COLS; i++)
		raised[i] += 5;
	const sdf = heightmap(COLS, ROWS, raised, BOTTOM, {kind: 'sphere', r: R});
	// the grid is measured from the base, so the file's floor is taken off every height before anything else
	const lift = Math.min(BOTTOM, Math.min(...Array.from(raised)));
	const mean = Array.from({length: COLS}, (_, i) => raised[i] - lift).reduce((a, b) => a + b, 0) / COLS;
	check(Math.abs(sdf.heights[0] - mean) < 1e-6, `the south pole should take its row's mean, not ${sdf.heights[0]}`);
	check(Math.abs(sdf.heights[COLS * (ROWS - 1)] - sdf.heights[COLS * (ROWS - 1) + 7]) < 1e-9, 'the north pole row should be one height');
	check(Math.abs(evalSdf(sdf, [0, 0, -(R + sdf.heights[0])])) < 1e-4, 'the field should be zero on the axis at the south pole');
	check(Math.abs(evalSdf(sdf, [0, 0, R + sdf.heights[COLS * (ROWS - 1)]])) < 1e-4, 'the field should be zero on the axis at the north pole');
	// a cylinder keeps its rows exactly as they were, bar that same measuring from the base: no pole to fold
	const cyl = heightmap(COLS, ROWS, flat, BOTTOM, {kind: 'cylinder', r: R});
	check(Math.abs(cyl.heights[0] - (flat[0] - lift)) < 1e-6, 'a cylinder should not touch its first row');
}

//--- a sphere's equator: the field there must still know which side of the surface it is on ------------------------
// A colatitude's ring has radius r sin(theta), so it is widest at the equator. The field bounds3 the far side of a
// tile's neighbourhood by how far a longitude step goes, and reading the axis component (cos) instead of the ring's
// own share (sin) closed that to nothing there: every point inside the shell read as the surface, a whole disc of it,
// whatever the grid and whether or not it was tiled. The pole is the other end of the same factor -- the columns
// crowd, so the tangential bound closes to nothing, and there it is the gap the point is over that floors the edge.
{
	const sdf = heightmap(COLS, ROWS, flat, BOTTOM, {kind: 'sphere', r: R});
	const h = sdf.heights, v = (ROWS - 1) / 2;		// the equator, mid-cell, so the height is the chart's own
	let wrong = 0, least = Infinity, n = 0;
	for (let k = 0; k < 600; k++) {
		const ph = rand() * 2 * Math.PI, u = ph / (2 * Math.PI) * COLS;
		const hh = chartHeight(COLS, ROWS, h, u, v);
		if (hh < 1)				// a shell too thin to have an inside to stand in
			continue;
		const inside = evalSdf(sdf, [(R + hh / 2) * Math.cos(ph), (R + hh / 2) * Math.sin(ph), 0]);
		const outside = evalSdf(sdf, [(R + hh + 1) * Math.cos(ph), (R + hh + 1) * Math.sin(ph), 0]);
		if (!(inside < 0) || !(outside > 0))
			wrong++;
		least = Math.min(least, -inside, outside);
		n++;
	}
	check(n > 100, `only ${n} equator points were thick enough to have an inside`);
	check(wrong === 0, `${wrong} of ${n} equator points read on the wrong side of the surface, or exactly on it`);
	// the axis at a pole: the same clamp must not read a rod of surface through the solid there either. The grid's
	// first row is the south pole and its last the north, so both ends are checked.
	const south = h[0], north = h[COLS * (ROWS - 1)];
	check(evalSdf(sdf, [0, 0, -(R + south / 2)]) < 0 && evalSdf(sdf, [0, 0, -(R + south + 1)]) > 0,
		'a point either side of the south pole should read the side it is on');
	check(evalSdf(sdf, [0, 0, R + north / 2]) < 0 && evalSdf(sdf, [0, 0, R + north + 1]) > 0,
		'a point either side of the north pole should read the side it is on');
	console.log(`equator: ${n} points either side of the surface, at least ${least.toFixed(3)} from it; both poles read either side too`);
}

//--- wrap() of a grid read from a file, and what it says when it cannot -------------------------------------------
{
	// a .dat is the file's own text, so a plain evaluate() reads it with nothing loaded first
	const W = 16, I = 12;
	const value = (x, y) => (x * 7919 + y * 104729) % 97;
	const text = Array.from({length: I}, (_, y) => Array.from({length: W}, (_, x) => value(x, y)).join(' ')).join('\n') + '\n';
	fs.writeFileSync(path.join(dir, 'map.dat'), text);
	const { sdf, warnings } = await run('wrap("sphere", r = 60) surface("map.dat");');
	check(warnings.length === 0, `a wrapped grid should draw without complaint: ${warnings}`);
	check(sdf.k === 'heightmap' && sdf.wrap && sdf.wrap.kind === 'sphere' && sdf.wrap.r === 60, 'wrap = "sphere" and r = 60 should reach the term');
	const h = sdf.heights;
	// the first line of a .dat is its first row, the two rows that land on the poles are each their own mean, and --
	// because the grid is now measured from the base at r -- the file's own floor (one below its lowest, which is
	// what surface() adds) counts for nothing: every height is that much higher
	const lift = 1 - Math.min(...Array.from({length: I * W}, (_, k) => value(k % W, (k / W) | 0)));
	let off = 0;
	for (let j = 1; j < I - 1; j++)
		for (let x = 0; x < W; x++)
			off = Math.max(off, Math.abs(h[j * W + x] - (value(x, j) + lift)));
	for (const j of [0, I - 1]) {
		const mean = Array.from({length: W}, (_, x) => value(x, j)).reduce((a, b) => a + b, 0) / W;
		for (let x = 0; x < W; x++)
			off = Math.max(off, Math.abs(h[j * W + x] - (mean + lift)));
	}
	check(off < 1e-3, `the wrapped grid should stand at the file's heights, off by ${off}`);
	let on = 0;
	for (let j = 0; j < I; j++)
		for (let i = 0; i < W; i++)
			on = Math.max(on, Math.abs(evalSdf(sdf, gridPoint('sphere', 60, W, I, i, j, h))));
	check(on < 1e-3, `the wrapped grid's surface should pass through its heights, off by ${on}`);

	// it is an extension, so what it says when it cannot is worth having too
	check((await run('wrap("sphere") surface("map.dat");')).warnings.some(w => w.includes('positive r')), 'a wrap with no radius should be reported');
	check((await run('wrap("torus", r = 5) surface("map.dat");')).warnings.some(w => w.includes('neither')), 'a wrap that is neither should be reported');
	check((await run('wrap("cylinder", d = 120) surface("map.dat");')).sdf.wrap.r === 60, 'd should be taken as a diameter');
	// and with no wrap at all, none of this reaches the term: the flat surface() is untouched
	const plain = await run('surface("map.dat");');
	check(!plain.sdf.wrap && plain.sdf.cols === W && plain.sdf.rows === I && Math.abs(plain.sdf.heights[0] - value(0, 0)) < 1e-9, 'surface() on its own should still be the flat grid, exactly as OpenSCAD draws it');
	console.log(`surface(): the wrapped grid stands at its heights to ${off.toExponential(1)}`);
}

//--- wrap(): the bend as an operator, so a transform inside it is applied to the flat field first ----------------
{
	// the map as it comes in, and the same map bent with its depth scaled by a tenth: the two must be one field, with
	// the second's heights a tenth of the first's -- which is the whole reason for bending after the fact
	fs.writeFileSync(path.join(dir, 'bend.dat'), fs.readFileSync(path.join(__dirname, '..', 'wrapped_heightmap.dat')));
	const flat = (await run('surface("bend.dat");')).sdf;
	const { sdf, warnings } = await run('wrap("sphere", r = 24) scale([1, 1, 0.1]) surface("bend.dat");');
	check(warnings.length === 0 && sdf.k === 'heightmap' && sdf.wrap.r === 24, `a whole turn of a flat field should bend as the grid it is: ${warnings}`);
	const want = heightmap(flat.cols, flat.rows, Float64Array.from(flat.heights, v => 0.1 * v), 0.1 * flat.bottom, {kind: 'sphere', r: 24});
	let off = 0;
	for (let k = 0; k < 2000; k++) {
		const p = [rand() * 80 - 40, rand() * 80 - 40, rand() * 80 - 40];
		off = Math.max(off, Math.abs(evalSdf(sdf, p) - evalSdf(want, p)));
	}
	check(off === 0, `folding a scale into a bent field should be that very field, but differed by ${off}`);

	let zero = 0;
	for (let j = 0; j < 61; j++)
		for (let i = 0; i < 120; i++) {
			const ph = 2 * Math.PI * i / 120, th = Math.PI * (60 - j) / 60, rad = 24 + sdf.heights[j * 120 + i];
			zero = Math.max(zero, Math.abs(evalSdf(sdf, [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)])));
		}
	check(zero < 1e-3, `the scaled relief should still stand on its own surface, off by ${zero}`);

	// the sphere itself is untouched: a tenth of the relief on the same radius, not a flattened sphere
	const box = bounds3(sdf);
	check(Math.abs(box.max.z - (24 + 0.1 * (flat.top - flat.bottom))) < 1e-4 && Math.abs(box.max.x - box.max.z) < 1e-4,
		`a tenth of the relief should leave a sphere of radius 24, not ${box.max.x} by ${box.max.z}`);
	// which is the other way round from the argument form, where the scale is outside the bend and squashes it
	const argBox = bounds3((await run('scale([1, 1, 0.1]) wrap("sphere", r = 24) surface("bend.dat");')).sdf);
	check(Math.abs(argBox.max.z - 0.1 * (24 + flat.top - flat.bottom)) < 1e-3 && Math.abs(argBox.max.x - (24 + flat.top - flat.bottom)) < 1e-3,
		`a scale outside the wrap squashes the whole sphere, which is why a transform inside it is what thins the relief: ${argBox.max.x} by ${argBox.max.z}`);
	console.log(`wrap(): a tenth of the relief on the same sphere, on its surface to ${zero.toExponential(1)}`);
}

//--- a body that is not a height field: the bend is the general one ---------------------------------------------
{
	// the square is 40 wide, so at r = 20 it covers two radians: the solid is {20 <= rho <= 22, |z| <= half,
	// 0 <= phi <= 2}, and the field must never be further than its distance nor on the wrong side. `h` names the axis
	// the square's own 10 of height is fitted to -- the surface's second dimension -- so the same body is the same
	// shape over a longer tube, which is what the second spelling checks.
	const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
	const phi = (p) => { const a = Math.atan2(p[1], p[0]); return a < 0 ? a + 2 * Math.PI : a; };
	const exact = (p, half) => {
		// {20 <= rho <= 22, |z| <= half, 0 <= phi <= 2}: outside it the nearest point is the clamped one -- the
		// clamped longitude, then rho*cos of the difference clamped to the shell, then the clamped z -- and inside it
		// the nearest face is the nearest of the four walls and the two cut meridians
		const rad = Math.hypot(p[0], p[1]), a = phi(p), inside = rad > 20 && rad < 22 && Math.abs(p[2]) < half && a < 2;
		if (inside)
			return -Math.min(rad - 20, 22 - rad, half - Math.abs(p[2]), rad * Math.sin(a), rad * Math.sin(2 - a));
		const ac = clamp(a, 0, 2), dphi = a - ac;
		const rc = clamp(rad * Math.cos(dphi), 20, 22), zc = clamp(p[2], -half, half);
		return Math.sqrt(Math.max(0, rad * rad + rc * rc - 2 * rad * rc * Math.cos(dphi) + (p[2] - zc) * (p[2] - zc)));
	};
	for (const [spelled, half, axis] of [['', 5, undefined], [', h = 40', 20, 40]]) {
		const { sdf, warnings } = await run(`wrap("cylinder", r = 20${spelled}) linear_extrude(2) square([40, 10]);`);
		check(warnings.length === 0 && sdf.k === 'warp', `a square bent round a cylinder should be a warp of it: ${warnings}`);
		check(sdf.axis === axis, `the bend's axis should be ${axis}, not ${sdf.axis}`);
		let over = 0, wrongSign = 0, ratio = 0, n = 0;
		for (let k = 0; k < 2000; k++) {
			const p = [rand() * 60 - 10, rand() * 60 - 30, rand() * 3 * half - 1.5 * half];
			const rad = Math.hypot(p[0], p[1]), field = evalSdf(sdf, p), real = exact(p, half);
			const inside = rad > 20 && rad < 22 && Math.abs(p[2]) < half && phi(p) < 2;
			if (Math.abs(field) > Math.abs(real) + 1e-4) over = Math.max(over, Math.abs(field) - Math.abs(real));
			if (Math.abs(field) > 1e-6 && (field < 0) !== inside) wrongSign++;
			if (field > 0) { ratio += field / Math.max(real, 1e-9); n++; }
		}
		check(over === 0, `a bent body's field should never be further than the real distance, but was by ${over}`);
		check(wrongSign === 0, `${wrongSign} of 2000 points on the wrong side of the bent body`);
		check(ratio / n > 0.2, `the bound is only ${(100 * ratio / n).toFixed(0)}% of the real distance, too loose to be one`);
		// The cut faces are only where the wall is: a point on one of their planes, well off the wall, is a distance
		// away and not a sheet of surface -- reading the plane alone, as if the face ran out to infinity, laid one
		// across it. An axis end is the same: the square's own height ends where h says it does.
		check(evalSdf(sdf, [25, 0, 50]) > 1, `a point on a cut meridian away from the wall read ${evalSdf(sdf, [25, 0, 50])}, not a distance`);
		check(evalSdf(sdf, [0, 21, half - 0.1]) < 0 && evalSdf(sdf, [0, 21, half + 0.1]) > 0,
			`the axis should end at ${half}: ${evalSdf(sdf, [0, 21, half - 0.1])} inside, ${evalSdf(sdf, [0, 21, half + 0.1])} past it`);

		let worstShader = 0;
		if (shaderReady) {
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const pts = Array.from({length: 200}, () => [rand() * 60 - 10, rand() * 60 - 30, rand() * 3 * half - 1.5 * half]);
			const results = await shader.at(pts);
			worstShader = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
			check(worstShader < 1e-3, `the bent body's shader and mirror differ by ${worstShader}`);
		}
		console.log(`wrap(): a 40-wide square bent two radians round a cylinder${spelled ? `, its 10 of height fitted to ${2 * half}` : ''}; ${wrongSign} wrong side, outside the bound is ${(100 * ratio / n).toFixed(0)}% of the real distance${shaderReady ? `; the shader agrees to ${worstShader.toExponential(1)}` : ''}`);
	}
}

//--- tiled: the grid is a tile whose size the scale sets, so the scale chooses how many come round ---------------
// A tiled grid's columns repeat: the turn is still a whole one, but one column is `sx` of arc rather than the fitted
// 2 pi r / cols, so the tile is the grid's own width and what the scale sets is how many times it comes round. It
// stays on the fused path whatever the scale, which is the point -- the general bend cannot fit a piece and keep a
// sphere's poles sane (see the pole test below). Only x is tiled here, so the rows still reach pole to pole.
{
	const P = 30, Q = 22, TR = 40, TH = (Q - 1) / 2;
	// a grid periodic in its columns, so a tile boundary is the ring closing rather than a jump
	const wave = Array.from({length: Q}, (_, j) => Array.from({length: P}, (_, i) => 2 + Math.cos(2 * Math.PI * i / P) + 0.5 * Math.sin(Math.PI * j / (Q - 1))));
	fs.writeFileSync(path.join(dir, 'wave.dat'), wave.map(r => r.join(' ')).join('\n') + '\n');

	// where a tiled grid's own (u, v) stands: u * sx / r of longitude, the fitted latitude or axis row
	const tiledPoint = (kind, h, u, v, sx, turn = 0) => {
		const ph = u * sx / TR + turn * 2 * Math.PI, rad = TR + chartHeight(P, Q, h, u, v);
		if (kind === 'sphere') {
			const th = Math.PI * (Q - 1 - v) / (Q - 1);
			return [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)];
		}
		return [rad * Math.cos(ph), rad * Math.sin(ph), v - TH];
	};

	for (const kind of ['cylinder', 'sphere']) {
		for (const count of [1, 2, 3, 3.5]) {
			// a tile is P * sx of arc and the turn is 2 pi r, so this scale puts `count` of them round
			const sx = 2 * Math.PI * TR / (P * count);
			const { sdf, warnings } = await run(`wrap("${kind}", r = ${TR}) scale([${sx}, 1, 1]) surface("wave.dat", tiled = [true, false]);`);
			check(warnings.length === 0 && sdf.k === 'heightmap' && sdf.wrap.tileX === true && Math.abs(sdf.wrap.sx - sx) < 1e-12,
				`${kind}: a tiled grid should stay the fused wrapped map, not ${sdf.k}: ${warnings}`);
			const h = sdf.heights;
			// the whole turn is covered: every longitude stands on the surface at the height its column gives
			let onTurn = 0;
			for (let k = 0; k < 360; k++) {
				const ph = 2 * Math.PI * k / 360, rad = TR + chartHeight(P, Q, h, ph * TR / sx, TH);
				onTurn = Math.max(onTurn, Math.abs(evalSdf(sdf, [rad * Math.cos(ph), rad * Math.sin(ph), 0])));
			}
			check(onTurn < 1e-3, `${kind} x${count}: the tiled surface should cover every longitude, off by ${onTurn}`);
			// the tile count: the surface's height round the turn repeats once per tile, so it has `count` peaks --
			// a fractional count showing the whole number of them and part of another
			const radius = (k) => TR + chartHeight(P, Q, h, 2 * Math.PI * k / 720 * TR / sx, TH);
			let peaks = 0;
			for (let k = 0; k < 720; k++)
				if (radius(k) > radius(k - 1) && radius(k) >= radius(k + 1))
					peaks++;
			check(Number.isInteger(count) ? peaks === count : Math.abs(peaks - count) < 1,
				`${kind}: a scale that fits ${count} tiles should show about ${count} round the turn, not ${peaks}`);
			// the seam: the tile boundary is the ring closing, so a point standing on the surface just either side of
			// it is on it, and -- a whole number of tiles fitting -- the height there is one value, the grid being
			// periodic in its columns. A fractional count leaves the grid's own seam elsewhere: the solid still
			// closes, but the picture does not join, which is the grid's business rather than a crack in the field.
			const seam = (delta) => TR + chartHeight(P, Q, h, (delta < 0 ? 2 * Math.PI + delta : delta) * TR / sx, TH);
			const onSeam = (delta) => {
				const ph = delta < 0 ? 2 * Math.PI + delta : delta, rad = seam(delta);
				return [rad * Math.cos(ph), rad * Math.sin(ph), 0];
			};
			check(Math.max(Math.abs(evalSdf(sdf, onSeam(-1e-6))), Math.abs(evalSdf(sdf, onSeam(1e-6)))) < 1e-3,
				`${kind} x${count}: a point on the surface at the seam should be on it`);
			if (Number.isInteger(count))
				check(Math.abs(seam(-1e-6) - seam(1e-6)) < 1e-3, `${kind} x${count}: the periodic grid should not jump across the seam`);
			console.log(`${kind} tiled x${count}: ${peaks} tile${peaks === 1 ? '' : 's'} round the turn, on the surface across it to ${onTurn.toExponential(1)}`);
		}
	}

	// against the tiled surface's own triangles: the sign right and never further than the real distance, as the
	// untiled tests do, with a tile either side of the seam so a point near it is measured against the right one
	const tiledTris = (kind, h, sx) => {
		const tris = [];
		for (let c = -1; c <= 1; c++)
			for (let j = 1; j < Q; j++)
				for (let i = 0; i < P; i++)
					for (let a = 0; a < DIVISIONS; a++)
						for (let b = 0; b < DIVISIONS; b++) {
							const u0 = i + a / DIVISIONS, u1 = i + (a + 1) / DIVISIONS, v0 = j - 1 + b / DIVISIONS, v1 = j - 1 + (b + 1) / DIVISIONS;
							const p00 = tiledPoint(kind, h, u0, v0, sx, c), p10 = tiledPoint(kind, h, u1, v0, sx, c);
							const p11 = tiledPoint(kind, h, u1, v1, sx, c), p01 = tiledPoint(kind, h, u0, v1, sx, c);
							tris.push([p00, p10, p11], [p00, p11, p01]);
						}
		return tris;
	};
	const area = (t) => Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2;
	const tiledNear = (kind, h, sx, spread) => {
		const u = rand() * P, v = rand() * (Q - 1), s = 1 + spread * (rand() - 0.5);
		const ph = u * sx / TR, th = kind === 'sphere' ? Math.PI * (Q - 1 - v) / (Q - 1) : 0;
		const sigma = (TR + chartHeight(P, Q, h, u, v)) * s;
		return kind === 'sphere'
			? [sigma * Math.sin(th) * Math.cos(ph), sigma * Math.sin(th) * Math.sin(ph), sigma * Math.cos(th)]
			: [sigma * Math.cos(ph), sigma * Math.sin(ph), v - TH];
	};
	for (const kind of ['cylinder', 'sphere']) {
		const sx = 2 * Math.PI * TR / (P * 2);
		const { sdf } = await run(`wrap("${kind}", r = ${TR}) scale([${sx}, 1, 1]) surface("wave.dat", tiled = [true, false]);`);
		const h = sdf.heights;
		const tris = tiledTris(kind, h, sx).filter(t => area(t) > 1e-9);
		let over = 0, wrongSign = 0, ratio = 0, n = 0, insideCount = 0;
		for (let k = 0; k < 300; k++) {
			const p = tiledNear(kind, h, sx, 0.35);
			const rad = kind === 'sphere' ? Math.hypot(p[0], p[1], p[2]) : Math.hypot(p[0], p[1]);
			const ph = Math.atan2(p[1], p[0]), u = (ph < 0 ? ph + 2 * Math.PI : ph) * TR / sx;
			const v = kind === 'sphere'
				? Math.acos(Math.max(-1, Math.min(1, -p[2] / Math.max(rad, 1e-12)))) / Math.PI * (Q - 1)
				: p[2] + TH;
			const inside = rad > TR && rad < TR + chartHeight(P, Q, h, u, v);
			const field = evalSdf(sdf, p);
			const real = Math.min(Math.abs(rad - TR), tris.reduce((m, t) => Math.min(m, triDist(p, t)), Infinity));
			insideCount += inside ? 1 : 0;
			if (Math.abs(field) > real + SLACK) over = Math.max(over, Math.abs(field) - real);
			if ((field < 0) !== inside && real > 1e-6) wrongSign++;
			if (field > 0) { ratio += field / Math.max(real, 1e-9); n++; }
		}
		check(over === 0, `tiled ${kind}: the field should never be further than the real distance, but was by ${over}`);
		check(wrongSign === 0, `tiled ${kind}: ${wrongSign} of 300 points on the wrong side`);
		check(insideCount > 40, `tiled ${kind}: only ${insideCount} of the samples were inside, too few to test the sign`);
		// the shader is the renderer, so the mirror and it have to agree for a tiled map too
		let worstShader = 0;
		if (shaderReady) {
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const pts = Array.from({length: 250}, () => tiledNear(kind, h, sx, 0.2));
			const results = await shader.at(pts);
			worstShader = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
			check(worstShader < 1e-3, `tiled ${kind}: the shader and the mirror differ by ${worstShader}`);
		}
		console.log(`tiled ${kind}: ${insideCount} of 300 inside; outside, the bound is ${(100 * ratio / n).toFixed(0)}% of the real distance on average${shaderReady ? `; the shader agrees to ${worstShader.toExponential(1)}` : ''}`);
	}

	// A negative scale is a mirror, and the fused mapping has no sign in it -- a signed arc would read the grid
	// backwards -- so the grid itself is turned round and the arc taken as a size. The field is then the same as one
	// built from the mirrored grid. On a sphere a mirrored y is nothing at all: the meridian puts row 0 on the north
	// pole either way, so the same rows lie on the same latitudes; a cylinder's axis has no such anchor, so its rows
	// are reversed when the scale is.
	{
		const sx = 2 * Math.PI * TR / (P * 2);
		const file = (await run('surface("wave.dat");')).sdf;
		const flip = (x, y) => {
			const a = Float64Array.from(file.heights);
			for (let j = 0; j < file.rows; j++)
				for (let i = 0; x && i < file.cols >> 1; i++) {
					const k = j * file.cols + i, k2 = j * file.cols + file.cols - 1 - i;
					[a[k], a[k2]] = [a[k2], a[k]];
				}
			for (let j = 0; y && j < file.rows >> 1; j++)
				for (let i = 0; i < file.cols; i++) {
					const k = j * file.cols + i, k2 = (file.rows - 1 - j) * file.cols + i;
					[a[k], a[k2]] = [a[k2], a[k]];
				}
			return a;
		};
		const difference = (a, b) => {
			let off = 0;
			for (let k = 0; k < 2000; k++) {
				const p = [rand() * 90 - 45, rand() * 90 - 45, rand() * 90 - 45];
				off = Math.max(off, Math.abs(evalSdf(a, p) - evalSdf(b, p)));
			}
			return off;
		};
		// a mirrored x stays on the fused path and is the map of the mirrored grid
		const mirrored = await run(`wrap("sphere", r = ${TR}) scale([${-sx}, 1, 1]) surface("wave.dat", tiled = [true, false]);`);
		check(mirrored.warnings.length === 0 && mirrored.sdf.k === 'heightmap' && mirrored.sdf.wrap.tileX === true && mirrored.sdf.wrap.sx > 0,
			`a mirrored tiled scale should stay on the fused path and take the arc as a size, not ${mirrored.sdf.k}: ${mirrored.warnings}`);
		const offX = difference(mirrored.sdf, heightmap(file.cols, file.rows, flip(true, false), file.bottom, {kind: 'sphere', r: TR, tileX: true, sx}));
		check(offX < 1e-9, `a mirrored tiled x should be the grid mirrored, but differed by ${offX}`);
		// a mirrored y on a sphere is the same field, since the meridian fixes row 0 on the north pole
		const sy = Math.PI * TR / ((Q - 1) * 2);
		const pos = (await run(`wrap("sphere", r = ${TR}) scale([1, ${sy}, 1]) surface("wave.dat", tiled = true);`)).sdf;
		const neg = (await run(`wrap("sphere", r = ${TR}) scale([1, ${-sy}, 1]) surface("wave.dat", tiled = true);`)).sdf;
		const offY = difference(pos, neg);
		check(offY < 1e-9, `a mirrored y on a sphere should be the same field, but differed by ${offY}`);
		// a mirrored y on a cylinder reverses the rows, as its axis has no pole to anchor them. Its axis is the grid's
		// own scaled height either way, which is what row records -- the mirrored y is a size, so the axis is too.
		const cyl = await run(`wrap("cylinder", r = ${TR}) scale([1, -0.5, 1]) surface("wave.dat", tiled = [false, true]);`);
		const offCyl = difference(cyl.sdf, heightmap(file.cols, file.rows, flip(false, true), file.bottom, {kind: 'cylinder', r: TR, row: 0.5, tileY: true, sy: 0.5}));
		check(offCyl < 1e-9, `a mirrored tiled cylinder should reverse its rows, but differed by ${offCyl}`);
		console.log(`tiled mirrors: x read backwards to ${offX.toExponential(1)}; sphere y a no-op to ${offY.toExponential(1)}; cylinder y reversed to ${offCyl.toExponential(1)}`);
	}

	// A scale so small or large that the tile comes round thousands of times, or fails to come round once, is still
	// the fused map: the arc is the scale itself and the sampling is modulo the period, so nothing overflows, aliases
	// or falls off a path the scale alone would have sent to the general bend.
	for (const [axis, s] of [['sx', 1e-6], ['sx', 1e6], ['sy', 1e-6], ['sy', 1e6]]) {
		const { sdf, warnings } = await run(`wrap("sphere", r = ${TR}) scale(${axis === 'sx' ? `[${s}, 1, 1]` : `[1, ${s}, 1]`}) surface("wave.dat", tiled = true);`);
		check(warnings.length === 0 && sdf.k === 'heightmap' && !!sdf.wrap.tileX && !!sdf.wrap.tileY,
			`an extreme ${axis} scale should stay on the fused path, not ${sdf.k}: ${warnings}`);
		const box = bounds3(sdf);
		check(Math.abs(box.max.x - box.max.z) < 1e-6 && Math.abs(box.max.x - box.min.x - 2 * box.max.x) < 1e-9,
			`an extreme ${axis} scale should still be the sphere, not ${box.max.x} by ${box.max.z}`);
		let bad = 0;
		for (let k = 0; k < 200; k++) {
			const p = [rand() * 90 - 45, rand() * 90 - 45, rand() * 90 - 45];
			bad += Number.isFinite(evalSdf(sdf, p)) ? 0 : 1;
		}
		check(bad === 0, `an extreme ${axis} scale read ${bad} non-finite distances`);
	}
	console.log('tiled extremes: a tile thousands of times round, and one larger than the sphere, both stay the fused map');
}

//--- tiled y: the rows repeat along the axis, and over a sphere's meridian they fold at a pole -------------------
{
	const P = 24, Q = 9, TR = 20, H = Q - 1;
	const rows = Array.from({length: Q}, (_, j) => Array.from({length: P}, (_, i) => 1 + Math.cos(2 * Math.PI * i / P) + 0.1 * j));
	fs.writeFileSync(path.join(dir, 'rows.dat'), rows.map(r => r.join(' ')).join('\n') + '\n');
	// A cylinder's y is its axis, and an axis has no length of its own the way a turn does: without an `h` it is the
	// grid's own scaled height, so a tiled cylinder is exactly one tile long whatever its scale, and the rows repeat
	// only when `h` names a longer axis. That is the difference from a sphere, whose meridian is a half turn of r and
	// always there for the surplus rows to fold over.
	for (const sy of [1, 0.5, 0.25]) {
		const { sdf, warnings } = await run(`wrap("cylinder", r = ${TR}) scale([1, ${sy}, 1]) surface("rows.dat", tiled = [false, true]);`);
		check(warnings.length === 0 && sdf.k === 'heightmap' && sdf.wrap.tileY === true && Math.abs(sdf.wrap.row - sy) < 1e-12 && Math.abs(sdf.wrap.sy - sy) < 1e-12,
			`a tiled cylinder with no h should take the grid's own height as its axis, not ${sdf.k}: ${warnings}`);
		const h = sdf.heights;
		let off = 0;
		for (let k = 0; k < 200; k++) {
			const z = (-H / 2 + H * k / 200) * sy, ph = rand() * 2 * Math.PI;
			const u = ph / (2 * Math.PI) * P, v = ((z / sy + H / 2) % H + H) % H;
			const rad = TR + chartHeight(P, Q, h, u, v);
			off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.cos(ph), rad * Math.sin(ph), z])));
		}
		check(off < 1e-3, `a tiled cylinder's rows should stand on the surface at the tile's own size, off by ${off}`);
		check(Math.abs(bounds3(sdf).max.z - H * sy / 2) < 1e-9, `a tiled cylinder with no h should be the grid's own height ${H * sy}, not ${2 * bounds3(sdf).max.z}`);
		console.log(`cylinder tiled y at sy ${sy} with no h: one tile over an axis of ${H * sy}`);
	}
	// with h the axis is that length, and the tile comes round again over it: the rows are still sy of axis each, so
	// what h buys is a longer tube rather than a stretched one, and its ends are real caps that cut the tile wherever
	// the axis stops. A half tile past the end of one is the case where the cap lands mid-tile.
	for (const [sy, tiles] of [[1, 3], [0.5, 2.5], [0.25, 2]]) {
		const len = H * sy * tiles;
		const { sdf, warnings } = await run(`wrap("cylinder", r = ${TR}, h = ${len}) scale([1, ${sy}, 1]) surface("rows.dat", tiled = [false, true]);`);
		check(warnings.length === 0 && sdf.k === 'heightmap' && Math.abs(sdf.wrap.row - len / H) < 1e-12,
			`a tiled cylinder's h should be its axis, not ${sdf.k}: ${warnings}`);
		check(Math.abs(bounds3(sdf).max.z - len / 2) < 1e-9, `an axis of ${len} should be ${len / 2} either way, not ${bounds3(sdf).max.z}`);
		const h = sdf.heights;
		let off = 0;
		for (let k = 0; k < 300; k++) {
			const z = -len / 2 + len * k / 300, ph = rand() * 2 * Math.PI;
			const u = ph / (2 * Math.PI) * P, v = (((z + len / 2) / sy) % H + H) % H;
			const rad = TR + chartHeight(P, Q, h, u, v);
			off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.cos(ph), rad * Math.sin(ph), z])));
		}
		check(off < 1e-3, `a tiled cylinder's rows should repeat over an axis of ${len}, off by ${off}`);
		// a whole tile up the axis is the same field, which is what repeating means, and the tile starts at the end of
		// the axis rather than half a picture in: the bottom of the tube stands at the grid's first row, so an axis a
		// whole number of tiles long begins and ends on a tile boundary. Reading the row from the axis's middle
		// instead -- as the untiled grid's own height does, where the two agree -- would stand this end on the middle
		// row, which is the difference the first row's own height tells.
		const tile = H * sy, z0 = -len / 2 + tile / 2, at = (z) => evalSdf(sdf, [TR + 1, 0, z]);
		check(Math.abs(at(z0) - at(z0 + tile)) < 1e-9, `a tile of ${tile} up the axis should repeat the field, not differ by ${Math.abs(at(z0) - at(z0 + tile))}`);
		const first = TR + chartHeight(P, Q, h, 0, 0.01 / sy);
		check(Math.abs(evalSdf(sdf, [first, 0, -len / 2 + 0.01])) < 1e-3,
			`the axis should start at the grid's first rows: its surface read ${evalSdf(sdf, [first, 0, -len / 2 + 0.01])}`);
		// and each end is a cap: the shell's inside just short of it, nothing at all past it
		check(evalSdf(sdf, [TR + 1, 0, len / 2 - 0.01]) < 0 && evalSdf(sdf, [TR + 1, 0, len / 2 + 0.01]) > 0,
			`an axis should end where h says: ${evalSdf(sdf, [TR + 1, 0, len / 2 - 0.01])} inside, ${evalSdf(sdf, [TR + 1, 0, len / 2 + 0.01])} past it`);
		// the shader is the renderer, so the repeated rows have to be the same there
		if (shaderReady) {
			const g = emitGlsl(sdf);
			const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
			const pts = Array.from({length: 200}, () => [rand() * 60 - 30, rand() * 60 - 30, rand() * 2 * len - len]);
			const results = await shader.at(pts);
			const worst = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
			check(worst < 1e-3, `a tiled cylinder's shader and mirror differ by ${worst}`);
		}
		console.log(`cylinder tiled y at sy ${sy}: ${tiles} tiles over an axis of ${len}, capped either end`);
	}
	// untiled, h is the axis too: the rows are fitted to it, as a sphere's are fitted to its meridian, so a scale in
	// y sizes nothing here and the grid fills whatever tube h names
	for (const [sy, len] of [[1, 30], [0.5, 30], [2, 12]]) {
		const { sdf, warnings } = await run(`wrap("cylinder", r = ${TR}, h = ${len}) scale([1, ${sy}, 1]) surface("rows.dat");`);
		check(warnings.length === 0 && sdf.k === 'heightmap' && Math.abs(sdf.wrap.row - len / H) < 1e-12,
			`an untiled cylinder's h should be its axis whatever its y scale, not ${sdf.k}: ${warnings}`);
		check(Math.abs(bounds3(sdf).max.z - len / 2) < 1e-9, `an axis of ${len} should be ${len / 2} either way, not ${bounds3(sdf).max.z}`);
		const h = sdf.heights;
		let off = 0;
		for (let k = 0; k < 300; k++) {
			const z = -len / 2 + len * k / 300, ph = rand() * 2 * Math.PI;
			const u = ph / (2 * Math.PI) * P, v = z / (len / H) + H / 2;
			const rad = TR + chartHeight(P, Q, h, u, v);
			off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.cos(ph), rad * Math.sin(ph), z])));
		}
		check(off < 1e-3, `an untiled cylinder's rows should be spread over an axis of ${len}, off by ${off}`);
		console.log(`cylinder untiled with h at sy ${sy}: the rows fitted to an axis of ${len}`);
	}
	// it is the surface's second dimension, so a sphere -- whose meridian is pi * r -- has none to give, and a length
	// that is not one is not an axis
	check((await run('wrap("sphere", r = 20, h = 30) surface("rows.dat");')).warnings.some(w => w.includes("cylinder's axis")),
		'h on a sphere should be reported');
	check((await run('wrap("cylinder", r = 20, h = -5) surface("rows.dat");')).warnings.some(w => w.includes('positive length')),
		'a wrap whose h is not a positive length should be reported');
	// a sphere: past a pole the row folds and the longitude turns with it, as it does going over a globe's pole. A
	// whole number of tiles over the meridian makes each fold land on a pole, which is the case worth checking, and
	// two tiles round makes that half-turn of longitude a whole tile rather than half of one -- the case where taking
	// it for half the columns would be wrong. A fractional count is the other spelling: the fold lands off a pole,
	// where the two sides meet at a crease rather than smoothly, but the surface is still the grid's own and the
	// solid still closes.
	const SP = 24, SQ = 9, SR = 10, SH = SQ - 1;
	const sph = Array.from({length: SQ}, (_, j) => Array.from({length: SP}, (_, i) => 1 + Math.cos(2 * Math.PI * i / SP) + 0.1 * j));
	fs.writeFileSync(path.join(dir, 'sph.dat'), sph.map(r => r.join(' ')).join('\n') + '\n');
	for (const xcount of [1, 2]) {
		const sx = 2 * Math.PI * SR / (SP * xcount), shift = Math.PI * SR / sx;
		for (const ycount of [1, 2, 1.5]) {
			const sy = Math.PI * SR / (SH * ycount);
			const { sdf } = await run(`wrap("sphere", r = ${SR}) scale([${sx}, ${sy}, 1]) surface("sph.dat", tiled = true);`);
			const h = sdf.heights;
			let off = 0, folds = 0;
			for (let k = 1; k < 400; k++) {
				const th = Math.PI * k / 400, ph = rand() * 2 * Math.PI;
				const raw = SR * (Math.PI - th) / sy, q = Math.floor(raw / SH), v = q % 2 ? SH - (raw - q * SH) : raw - q * SH;
				const u = ph * SR / sx + (q % 2 ? shift : 0);
				const rad = SR + chartHeight(SP, SQ, h, u, v);
				off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)])));
				folds = Math.max(folds, q);
			}
			check(off < 1e-3, `a tiled sphere's rows should fold at a pole, off by ${off}`);
			check(folds >= ycount - 1, `a meridian of ${ycount} tiles should fold ${ycount - 1} times, not ${folds}`);
			console.log(`sphere tiled ${xcount} x ${ycount} tiles: ${folds} folds, on the surface to ${off.toExponential(1)}`);
		}
	}
}

//--- a scaled grid's pole: tiled keeps the fused path, so the cap reads the distance it is ------------------------
{
	const P = 200, Q = 201, PR = 24;
	// big enough that, scaled by 0.4, the grid still reaches a sphere of r = 24 pole to pole: the untiled general
	// bend is then the case whose stretch has to reach a pole, where the longitude direction closes up
	const big = Array.from({length: Q}, (_, j) => Array.from({length: P}, (_, i) => 4 + 3 * Math.cos(2 * Math.PI * i / P) * Math.sin(Math.PI * j / (Q - 1))));
	fs.writeFileSync(path.join(dir, 'pole.dat'), big.map(r => r.map(v => v.toFixed(4)).join(' ')).join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'wrapped.dat'), fs.readFileSync(path.join(__dirname, '..', 'wrapped_heightmap.dat')));
	// the field in a three degree cap about the axis at a radius well off the surface: on the surface it would be ~0
	const cap = (sdf, rad) => {
		let worst = Infinity;
		for (let k = 0; k < 800; k++) {
			const th = rand() * 3 * Math.PI / 180, ph = rand() * 2 * Math.PI;
			const p = [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)];
			worst = Math.min(worst, Math.abs(evalSdf(sdf, p)));
		}
		return worst;
	};
	// the reference: the example's own .dat, fused on a sphere as it always was
	const ref = (await run(`wrap("sphere", r = ${PR}) surface("wrapped.dat");`)).sdf;
	// A scaled grid with no tiling is a *piece* of a surface -- its columns end where the grid does -- so it is bent
	// on the fused path too, as a partial map, which carries the scale exactly. That is what the general bend could
	// not do: a non-uniform scale is folded into its distance by the smallest axis alone, and giving each axis its
	// own scale back along the way the body is nearest was not a lower bound (the stretch falls along that way).
	const untiled = (await run(`wrap("sphere", r = ${PR}) scale([0.4, 0.4, 0.01]) surface("pole.dat");`)).sdf;
	check(untiled.k === 'heightmap' && untiled.wrap.part === true, `a scaled grid with no tiling should be a partial fused map, not ${untiled.k}`);
	const poleSdf = (await run(`wrap("sphere", r = ${PR}) scale([0.4, 0.4, 0.01]) surface("pole.dat", tiled = [true, false]);`)).sdf;
	const poleMean = poleSdf.heights[(poleSdf.rows - 1) * poleSdf.cols];		// the +z pole now takes the grid's last row
	const want = (rad) => rad - PR - poleMean;
	for (const rad of [30, 34, 40]) {
		const got = Math.abs(evalSdf(untiled, [0, 0, rad]));
		check(Math.abs(got - want(rad)) < 0.5, `the untiled piece at the pole should read ${want(rad)}, not ${got}`);
	}
	// the shader is the renderer, so the piece has to be the same there
	let untiledShader = 0;
	if (shaderReady) {
		const g = emitGlsl(untiled);
		const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
		const pts = Array.from({length: 200}, () => [rand() * 90 - 45, rand() * 90 - 45, rand() * 90 - 45]);
		const results = await shader.at(pts);
		untiledShader = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(untiled, p))), 0);
		check(untiledShader < 1e-3, `the untiled piece's shader and mirror differ by ${untiledShader}`);
	}
	// A piece wider than a half turn used to read the far half of the start plane as a face -- a wedge up to a half
	// one is convex and its nearer plane bounds3 it, but a wider one is the complement of the small empty turn, so it
	// is the farther plane that does. Reading the nearer laid a sheet of surface down the middle of the piece at
	// phi = 180 degrees, where it must be solid.
	check(evalSdf(untiled, [-(PR + 0.03), 0, 0]) < -1e-3,
		`a piece wider than a half turn should be solid across its middle, not surface (${evalSdf(untiled, [-(PR + 0.03), 0, 0])})`);
	for (const spelling of ['[true, false]', 'true']) {
		const { sdf, warnings } = await run(`wrap("sphere", r = ${PR}) scale([0.4, 0.4, 0.01]) surface("pole.dat", tiled = ${spelling});`);
		check(warnings.length === 0 && sdf.k === 'heightmap', `tiled = ${spelling} should keep the fused path, not ${sdf.k}: ${warnings}`);
		// the surface in the cap stands at r + the pole's own mean height, so the field reads the radius less that
		for (const rad of [30, 34, 40]) {
			const got = cap(sdf, rad);
			check(got > 1, `tiled = ${spelling}: the pole should read as the distance it is at ${rad}, not as the surface (${got})`);
			check(Math.abs(got - want(rad)) < 0.5, `tiled = ${spelling}: the cap at ${rad} reads ${got}, not the ${want(rad)} the fused map gives`);
		}
		console.log(`pole: untiled reads ${Math.abs(evalSdf(untiled, [0, 0, 34])).toFixed(3)} on the axis against ${want(34).toFixed(3)}${shaderReady ? ` (shader ${untiledShader.toExponential(1)})` : ''}; tiled = ${spelling} reads ${cap(sdf, 34).toFixed(3)} against ${want(34).toFixed(3)}; the fused reference .dat reads ${cap(ref, 34).toFixed(3)}`);
	}
}

//--- a scaled grid on a cylinder: a piece of the surface too, bent as the grid it is --------------------------------
// The same case a scaled sphere is bent as the grid it is for, and now the same answer. A piece of a cylinder is the
// columns (cols - 1) * sx of arc, ending at a meridian apiece, with the rows spread over the axis -- the grid's own
// height, or h. The general bend takes that same shape, but folds a non-uniform scale into its distance by the
// smallest axis alone (see place), so a relief a hundredth as thick as the grid is wide comes out with a gradient a
// few tenths of the distance's: the surface is still where it should be, but it is shaded as the near-flat sheet
// that gradient describes, which is what a bent photograph looked like. Here the piece's field rises by one.
{
	const TR = 24, sx = 0.1, sy = 0.1;
	fs.writeFileSync(path.join(dir, 'bend.dat'), fs.readFileSync(path.join(__dirname, '..', 'wrapped_heightmap.dat')));
	const scale = `scale([${sx}, ${sy}, 0.01])`;
	const { sdf, warnings } = await run(`wrap("cylinder", r = ${TR}) ${scale} surface("bend.dat");`);
	check(warnings.length === 0 && sdf.k === 'heightmap' && sdf.wrap.part === true && Math.abs(sdf.wrap.sx - sx) < 1e-12 && Math.abs(sdf.wrap.row - sy) < 1e-12,
		`a scaled grid with no tiling should be a piece of the cylinder, bent as the grid it is, not ${sdf.k}: ${warnings}`);
	const cols = sdf.cols, rows = sdf.rows, h = sdf.heights, H2 = (rows - 1) / 2;
	// one column is sx of arc from phi = 0 and one row sy up the axis, so the grid's own samples stand there
	const spot = (i, j) => { const ph = i * sx / TR, rad = TR + h[j * cols + i]; return [rad * Math.cos(ph), rad * Math.sin(ph), (j - H2) * sy]; };
	let on = 0;
	for (let j = 0; j < rows; j += 5)
		for (let i = 0; i < cols; i += 7)
			on = Math.max(on, Math.abs(evalSdf(sdf, spot(i, j))));
	check(on < 1e-3, `a piece's own columns and rows should stand on its surface, off by ${on}`);
	// its ends are real faces, the last column's meridian among them, and past it is a distance away
	const last = (cols - 1) * sx / TR, mid = h[(rows >> 1) * cols + (cols >> 1)];
	const at = (ph) => [(TR + mid) * Math.cos(ph), (TR + mid) * Math.sin(ph), 0];
	check(evalSdf(sdf, at(-0.05)) > 0.5 && evalSdf(sdf, at(last + 0.05)) > 0.5,
		`past either end of a piece should be outside it: ${evalSdf(sdf, at(-0.05))} and ${evalSdf(sdf, at(last + 0.05))}`);
	// The gradient is the surface's normal, so it is the number the shading of the relief is made of. The same grid
	// off the fused path -- a rotation far too slight to be seen keeps it off, which is how the two are held side by
	// side here -- reads a few tenths of a distance where this one reads its whole one.
	const general = await run(`wrap("cylinder", r = ${TR}) rotate([0, 0, 1e-6]) ${scale} surface("bend.dat");`);
	check(general.sdf.k === 'warp', `the same grid off the fused path should be the general bend, not ${general.sdf.k}`);
	const slope = (s) => {
		const g = [];
		for (let j = 0; j < rows; j += 5)
			for (let i = 0; i < cols; i += 7) {
				const p = spot(i, j), e = 1e-3, d = evalSdf(s, p);
				g.push(Math.hypot(
					(evalSdf(s, [p[0] + e, p[1], p[2]]) - d) / e,
					(evalSdf(s, [p[0], p[1] + e, p[2]]) - d) / e,
					(evalSdf(s, [p[0], p[1], p[2] + e]) - d) / e));
			}
		return g.sort((a, b) => a - b)[Math.floor(g.length / 10)];
	};
	const steep = slope(sdf), shallow = slope(general.sdf);
	check(steep > 0.7, `a piece's field should rise by one to its surface, but reads ${steep.toFixed(3)} at its tenth percentile`);
	check(shallow < 0.5 && steep > 2 * shallow, `the general bend of the same grid should be the flat one, but reads ${shallow.toFixed(3)} against ${steep.toFixed(3)}`);
	// a mirrored x is the grid turned round within the same arc, as it is for a sphere's piece
	const flipped = Float64Array.from(h);
	for (let j = 0; j < rows; j++)
		for (let i = 0; i < cols >> 1; i++) {
			const k = j * cols + i, k2 = j * cols + cols - 1 - i;
			[flipped[k], flipped[k2]] = [flipped[k2], flipped[k]];
		}
	const mirror = await run(`wrap("cylinder", r = ${TR}) scale([${-sx}, ${sy}, 0.01]) surface("bend.dat");`);
	const want = heightmap(cols, rows, flipped, sdf.bottom, {kind: 'cylinder', r: TR, row: sy, part: true, sx});
	let offMirror = 0;
	for (let k = 0; k < 2000; k++) {
		const p = [rand() * 80 - 40, rand() * 80 - 40, rand() * 80 - 40];
		offMirror = Math.max(offMirror, Math.abs(evalSdf(mirror.sdf, p) - evalSdf(want, p)));
	}
	check(offMirror < 1e-9, `a mirrored piece of a cylinder should be the grid mirrored, but differed by ${offMirror}`);
	// the shader is the renderer, so the piece and its cut faces have to be the same there
	let pieceShader = 0;
	if (shaderReady) {
		const g = emitGlsl(sdf);
		const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
		const pts = Array.from({length: 200}, () => [rand() * 80 - 40, rand() * 80 - 40, rand() * 60 - 30]);
		const results = await shader.at(pts);
		pieceShader = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
		check(pieceShader < 1e-3, `a cylinder piece's shader and mirror differ by ${pieceShader}`);
	}
	console.log(`cylinder piece: on its own surface to ${on.toExponential(1)}, mirrored to ${offMirror.toExponential(1)}; the field rises by ${steep.toFixed(3)} against ${shallow.toFixed(3)} for the general bend of the same grid${shaderReady ? `; the shader agrees to ${pieceShader.toExponential(1)}` : ''}`);
}

//--- a scaled grid a circumference wide or more: fitted to the whole turn, on the fused path too --------------------
// The other side of the piece above: a grid whose own width is a circumference or more is fitted to the whole turn
// rather than ending at a meridian, so its scale stops saying how much of the surface is covered, exactly as an
// untiled grid with no scale at all. The general bend fits it too, but carries only the thinnest axis's scale (see
// place) -- which is what shaded the example's own untiled photo flat once the picture on this machine was wide
// enough to be fitted, its z scale being a hundredth of its x. The fused map has the columns a whole turn over cols
// and the rows the fitted meridian or the scaled axis, so the surface stands at r plus the grid's own heights.
{
	const P = 60, Q = 40, TR = 10, SW = 2, SH = 1.5;
	const wide = Array.from({length: Q}, (_, j) => Array.from({length: P}, (_, i) => (3 + 2 * Math.cos(2 * Math.PI * i / P) + 0.05 * j).toFixed(3)));
	fs.writeFileSync(path.join(dir, 'wide.dat'), wide.map(r => r.join(' ')).join('\n') + '\n');
	for (const [kind, scale, rows] of [['sphere', `[${SW}, ${SH}, 0.5]`, 'the fitted meridian'], ['cylinder', `[${SW}, 1, 0.5]`, 'the scaled axis']]) {
		const { sdf, warnings } = await run(`wrap("${kind}", r = ${TR}) scale(${scale}) surface("wide.dat");`);
		check(warnings.length === 0 && sdf.k === 'heightmap' && !sdf.wrap.part && !sdf.wrap.tileX,
			`a grid a circumference wide or more should be fitted to the whole turn on the fused path, not ${sdf.k}: ${warnings}`);
		const h = sdf.heights;
		let off = 0;
		for (let k = 0; k < 200; k++) {
			const i = rand() * P, j = rand() * (Q - 1), ph = 2 * Math.PI * i / P, rad = TR + chartHeight(P, Q, h, i, j);
			if (kind === 'sphere') {
				const th = Math.PI * (Q - 1 - j) / (Q - 1);
				off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.sin(th) * Math.cos(ph), rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th)])));
			} else
				off = Math.max(off, Math.abs(evalSdf(sdf, [rad * Math.cos(ph), rad * Math.sin(ph), j - (Q - 1) / 2])));
		}
		check(off < 1e-3, `a fitted grid's surface should stand at its own heights, off by ${off}`);
		console.log(`wide grid on a ${kind}: columns a whole turn over ${P}, rows ${rows}, on its surface to ${off.toExponential(1)}`);
	}
}

//--- the example that ships with it: the same grid flat, round a cylinder and round a sphere ----------------------
{
	const file = path.join(__dirname, '..', 'wrapped_heightmap.scad');
	const repo = new FileReader();
	const { sdf, warnings } = await repo.with(() => evaluate(fs.readFileSync(file, 'utf8'), file, repo));
	// the example also wraps a picture of the author's own, whatever it is called, so a machine without it draws the
	// rest and says so
	const missedFile = /\.(png|jpg|jpeg|gif|bmp)|wrap\(\) of nothing/;
	const missed = warnings.filter(w => !missedFile.test(w));
	check(missed.length === 0, `wrapped_heightmap.scad should draw without complaint: ${missed}`);
	const kinds = [], parts = [];
	(function walk(s) {
		if (!s)
			return;
		if (s.k === 'heightmap') {
			kinds.push(s.wrap ? s.wrap.kind : 'flat');
			if (s.wrap && s.wrap.part)
				parts.push(s.wrap.kind);
		}
		for (const c of s.children ?? [])
			walk(c);
		for (const c of s.cuts ?? [])
			walk(c);
		walk(s.body);
		walk(s.base);
	})(sdf);
	check(kinds.includes('flat') && kinds.includes('cylinder') && kinds.filter(k => k === 'sphere').length >= 2,
		`the example should be the grid flat, round a cylinder and round spheres, not ${kinds}`);
	// The example's own objects are the author's to rearrange -- and which of them are pieces depends on the photo
	// that happens to be on the machine -- so what is checked is that any piece it draws is a fused map of a sphere
	// or a cylinder rather than the general bend, which would carry the thinnest axis's scale and shade it flat (see
	// the piece tests above). A machine without the picture draws none, which the warnings above already tolerate.
	const missedPhoto = warnings.some(w => missedFile.test(w));
	check(missedPhoto || parts.every(k => k === 'sphere' || k === 'cylinder'),
		`a piece the example draws should be a fused map of a sphere or a cylinder, not ${parts}`);
	console.log(`example: wrapped_heightmap.scad draws ${kinds.join(', ')}${missedPhoto ? ' (picture absent)' : ` and ${parts.length} partial map (${parts.join(', ')})`}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'ok: surface() wraps a heightmap onto a cylinder or a sphere, bounds3 its distance honestly, and closes its seam');
await close().catch(() => {});	// the harness may never have got a page to close
process.exit(bad ? 1 : 0);

})();
