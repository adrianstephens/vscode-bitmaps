// The adaptive mesher (src/scad/adaptive.ts): the same closed, outward-wound surface the uniform one makes, from fewer
// triangles, and with a cost that follows how curved the model is rather than how fine the finest cells are.
//
// The volumes are the check on the geometry: a cube, a box with a cavity and a prism come out exact because dual
// contouring puts a vertex on every edge and corner, and the rounded solids -- a polyhedron grown by a ball or by a flat
// disc, which the mesher takes apart into planes, cylinders and balls -- are compared with their volumes worked out by
// hand. What is being tested besides is the lowering itself: if a piece were missing or misplaced the volume would say.
const { evaluate } = require('../out/src/scad/evaluate.js');
const { checkMesh, meshAdaptive } = require('../out/src/scad/mesher.js');
const { SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();

const PI = Math.PI;
const hex = 'module hp(d, h, r) { minkowski() { scale([sqrt(2), 1, 1]) cylinder(h = h, r = d / cos(30) / 2, center = true, $fn = 6); scale([1, 1, 0]) sphere(r = r); } } ';
// a cube 10 grown by a ball of 2: the cube, six slabs, twelve quarter-cylinders and eight eighths of a ball
const ROUNDED_CUBE = 1000 + 6 * 100 * 2 + 12 * PI * 4 / 4 * 10 + 4 / 3 * PI * 8;

const CASES = [
	// label, source, expected volume, tolerance (a fraction), how many non-manifold edges to allow (a fraction of edges)
	['cube',				'cube([3, 4, 5]);',													60,						1e-5,	0],
	['two cubes',			'cube(2); translate([1, 1, 1]) cube(2);',							15,						1e-5,	0],
	['hollow box',			'difference() { cube(10); translate([1, 1, 1]) cube(8); }',			488,					1e-5,	0],
	['hex prism',			'cylinder(h = 4, r = 3, $fn = 6);',									3 * Math.sqrt(3) / 2 * 9 * 4,	1e-4,	0],
	['sphere',				'sphere(2);',														4 / 3 * PI * 8,			1e-3,	0],
	['rounded cube',		'minkowski() { cube(10); sphere(2); }',								ROUNDED_CUBE,			1e-3,	0],
	['rounded, centred',	'minkowski() { cube(10, center = true); sphere(2); }',				ROUNDED_CUBE,			1e-3,	0],
	['rounded, turned',		'rotate([20, 30, 40]) minkowski() { cube(10); sphere(2); }',		ROUNDED_CUBE,			1e-3,	0],
	// a flat brush leaves the height alone and grows the outline: (60 + 64 + pi 4) * 4
	['flat disc on a cube',	'minkowski() { cube([10, 6, 4]); scale([1, 1, 0]) sphere(2); }',	(60 + 64 + PI * 4) * 4,	1e-3,	0],
	// the same solid turned: the brush's flat direction is then no coordinate axis
	['stretched, turned',	hex + 'rotate([20, 30, 40]) hp(20, 8, 2);',						5368.6,					1e-3,	0.01],
	['turned cube',			'rotate([20, 30, 40]) cube([3, 4, 5]);',							60,						1e-3,	0.01],
];

(async () => {
	let bad = 0;
	for (const [label, source, volume, tolerance, nonManifold] of CASES) {
		const { sdf } = evaluate(source, 'adaptive.js', {});
		const box = bounds3(sdf);
		const longest = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
		const mesh = await meshAdaptive(sdf, { cells: 512, tolerance: longest * 3e-4 });
		const stats = checkMesh(mesh);
		const off = Math.abs(stats.volume - volume) / volume;
		const problems = [];
		if (stats.open)							problems.push(`${stats.open} open edges`);
		if (stats.inconsistent)					problems.push(`${stats.inconsistent} flipped edges`);
		if (stats.nonManifold > nonManifold * stats.triangles * 1.5)
												problems.push(`${stats.nonManifold} non-manifold edges`);
		if (off > tolerance)					problems.push(`volume ${stats.volume.toFixed(3)}, wanted ${volume.toFixed(3)}`);
		if (problems.length)
			++bad;
		console.log(`${label.padEnd(22)} ${String(stats.triangles).padStart(7)} triangles, volume ${stats.volume.toFixed(3)}${problems.length ? '   FAILED: ' + problems.join('; ') : '   ok'}`);
	}

	// What makes it adaptive: a curved surface costs what its curvature asks for and no more, however small the finest
	// cells are allowed to be. A uniform mesh would grow with the square of the resolution, 256 times over this range; this
	// grows by the few cells along the tangent joins, well under twice.
	const { sdf } = evaluate('minkowski() { cube(10); sphere(2); }', 'adaptive.js', {});
	const counts = [];
	for (const cells of [256, 1024, 4096])
		counts.push(checkMesh(await meshAdaptive(sdf, { cells, tolerance: 0.005 })).triangles);
	const steady = counts[2] < counts[0] * 2;
	if (!steady)
		++bad;
	console.log(`\ntriangles of a rounded cube at 256, 1024 and 4096 finest cells: ${counts.join(', ')}${steady ? '   ok' : '   FAILED: it grows with the resolution'}`);

	console.log(bad ? `\n${bad} checks failed` : '\nevery mesh is closed, encloses what it should, and costs by its curvature');
	process.exit(bad ? 1 : 0);
})();
