// The STL export's mesher (src/scad/mesher.ts): the surface has to be closed and consistently wound, and for shapes whose
// volume is known the mesh has to enclose it. A cube is the sharp test -- dual contouring puts a vertex exactly on each
// edge and corner, so a flat-faced solid comes out with its exact volume at any resolution; a sphere converges instead.
const { evaluate } = require('../out/src/scad/evaluate.js');
const { meshUniform, meshAdaptive, checkMesh } = require('../out/src/scad/mesher.js');
const { STL } = require('@isopodlabs/binary_meshes');

const CASES = [
	// label, source, expected volume, tolerance as a fraction of it, whether every edge must be manifold
	['cube',			'cube([3, 4, 5]);',													60,						1e-6,	true],
	['two cubes',		'cube(2); translate([1, 1, 1]) cube(2);',							15,						1e-6,	true],
	['hollow box',		'difference() { cube(10); translate([1, 1, 1]) cube(8); }',			488,					1e-6,	true],
	['hex prism',		'cylinder(h = 4, r = 3, $fn = 6);',									3 * Math.sqrt(3) / 2 * 9 * 4,	1e-4,	true],
	// a smooth frustum: the general frustum-of-a-cone volume, h/3 * (pi*r1^2 + pi*r2^2 + pi*r1*r2)
	['frustum',			'cylinder(h = 10, r1 = 5, r2 = 2);',								Math.PI * 10 / 3 * (25 + 10 + 4), 3e-3, true],
	// positionally a cylinder is (h, r1, r2, center) -- r and d can only be named -- so the mast in
	// examples/Basics/hull.scad, cylinder(40, 1, 1), is 1 wide, and a lone positional radius is a taper down to the
	// default end radius of 1, not a straight cylinder (all as in OpenSCAD's primitives.cc)
	// (a 1-wide mast is only ~3 cells across at this resolution, so its volume is coarse -- what matters is radius 1 rather than 40)
	['positional mast',	'cylinder(40, 1, 1);',												Math.PI * 40,			6e-2,	true],
	['positional taper','cylinder(10, 5);',													Math.PI * 10 / 3 * (25 + 5 + 1), 3e-3, true],
	['positional taper, centred', 'cylinder(10, 5, 2, true);',								Math.PI * 10 / 3 * (25 + 10 + 4), 3e-3, true],
	// a true cone (r2 = 0), the same formula with its last two terms vanishing
	['cone',			'cylinder(h = 10, r1 = 5, r2 = 0);',								Math.PI * 25 * 10 / 3,	3e-3,	true],
	// a faceted frustum has no simpler analytic shape to fall back to at any $fn, unlike a straight faceted cylinder,
	// so this is built as a real polyhedron even well past the plain-cylinder cutoff for that -- the general frustum
	// formula again, with a regular hexagon's area in place of a circle's
	['faceted frustum', 'cylinder(h = 10, r1 = 5, r2 = 2, $fn = 6);',						Math.sqrt(3) / 2 * 10 * (25 + 10 + 4), 1e-4, true],
	['sphere',			'sphere(2);',														4 / 3 * Math.PI * 8,	3e-3,	true],
	// the ball is bigger than the cube, so it takes the corners' worth away and pokes out of each face in a cap
	['cube less ball',	'difference() { cube(6, center = true); sphere(3.5); }',			216 - (4 / 3 * Math.PI * 3.5 ** 3 - 6 * Math.PI * 0.5 ** 2 * (3 * 3.5 - 0.5) / 3), 1e-2, true],
	// a rotated solid is only nearly manifold: a few edges at its corners are shared by more than two triangles
	['rotated cube',	'rotate([20, 30, 40]) cube([3, 4, 5]);',							60,						1e-3,	false],
];

(async () => {
	let bad = 0;
	for (const [label, source, volume, tolerance, manifold] of CASES) {
		const { sdf } = evaluate(source, 'mesh.js', {});
		const mesh = await meshUniform(sdf, { cells: 64 });
		const stats = checkMesh(mesh);
		const off = Math.abs(stats.volume - volume) / volume;
		const problems = [];
		if (stats.open)						problems.push(`${stats.open} open edges`);
		if (stats.inconsistent)				problems.push(`${stats.inconsistent} flipped edges`);
		if (manifold && stats.nonManifold)	problems.push(`${stats.nonManifold} non-manifold edges`);
		if (off > tolerance)				problems.push(`volume ${stats.volume.toFixed(3)}, wanted ${volume.toFixed(3)}`);
		// the file itself: the size the format demands, and the count in its header
		const bytes = STL.save(mesh);
		if (bytes.length !== 84 + 50 * stats.triangles || new DataView(bytes.buffer).getUint32(80, true) !== stats.triangles)
			problems.push('the STL is the wrong size');
		// and it reads back as the same triangles, enclosing the same volume (to float32)
		const back = STL.load(bytes);
		if (back.faces.length !== stats.triangles || Math.abs(checkMesh(back).volume - stats.volume) > 1e-5 * Math.max(1, volume))
			problems.push(`the STL does not read back: ${back.faces.length} triangles, volume ${checkMesh(back).volume}`);
		if (problems.length)
			++bad;
		console.log(`${label.padEnd(16)} ${String(stats.triangles).padStart(6)} triangles, volume ${stats.volume.toFixed(3)}${problems.length ? '   FAILED: ' + problems.join('; ') : '   ok'}`);
	}

	// A wall or gap thinner than the finest cell passes between its corners. The uniform mesher leaves it out and says so; the
	// adaptive one finds it from the model (two separate flat sheets in a cell) and draws it either way. A 0.05 slot through a
	// 6 cube, at 48 cells (0.125 each): where the grid's corners straddle it they do not see it, and where one falls in it
	// the slot is drawn (216 less its 1.8) and there is nothing to report. The adaptive mesher's slot is a little shallow
	// where the walls meet the faces of the cube (3 planes in a cell), but it is there.
	const slot = (x) => evaluate(`difference() { cube(6, center = true); translate([${x}, 0, 0]) cube([0.05, 10, 10], center = true); }`, 'mesher.js', {}).sdf;
	for (const [label, sdf, uniformSees, adaptiveSees] of [['centred slot', slot(0), true, true], ['shifted slot', slot(0.03), false, true]]) {
		const u = await meshUniform(sdf, { cells: 48 }), a = await meshAdaptive(sdf, { cells: 48, tolerance: 0.02 });
		for (const [name, m, sees] of [['uniform', u, uniformSees], ['adaptive', a, adaptiveSees]]) {
			const volume = checkMesh(m).volume, ok = sees ? Math.abs(volume - 214.2) < (m === a ? 0.6 : 0.2) && m.thin === 0 : Math.abs(volume - 216) < 1e-6 && m.thin > 0;
			if (!ok)
				++bad;
			console.log(`${(label + ', ' + name).padEnd(24)} volume ${volume.toFixed(2)}, ${m.thin} thin cells${ok ? '   ok' : `   FAILED: the slot should be ${sees ? 'drawn, with nothing thin' : 'reported thin'}`}`);
		}
	}
	for (const src of ['cube([3, 4, 5]);', 'sphere(3);', 'minkowski() { cube([4, 3, 2]); sphere(0.5); }', 'rotate([20, 30, 40]) cylinder(h = 6, r1 = 3, r2 = 1);']) {
		const sdf = evaluate(src, 'mesher.js', {}).sdf;
		const thin = [(await meshUniform(sdf, { cells: 48 })).thin, (await meshAdaptive(sdf, { cells: 48, tolerance: 0.02 })).thin];
		if (thin.some(t => t !== 0)) {
			++bad;
			console.log(`${src}   FAILED: ${thin} thin cells where no wall is thin`);
		}
	}
	console.log(bad ? `\n${bad} of ${CASES.length} cases failed` : '\nevery mesh is closed, wound outwards, and encloses what it should; thin walls are reported, and only they');
	process.exit(bad ? 1 : 0);
})();
