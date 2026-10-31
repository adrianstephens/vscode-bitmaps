// import() of a DXF, and dxf_dim() / dxf_cross(): drawings made here, whose outlines are known, checked by where the
// outline is (the field is 0 on it) and by the area it encloses (the mesh of a unit-high extrusion), as OpenSCAD's
// DxfData would draw them -- each curve exact, the lines joined into paths, the paths even-odd.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate } = require('./scadhost.js');
const { FileReader } = require('../out/src/filereader.js');
const { SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { meshUniform, checkMesh } = require('./scadhost.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxf-'));
const files = new FileReader();
const run = (src) => files.with(() => evaluate(src, path.join(dir, 'main.scad'), files));

// a DXF of these entities (each [type, [code, value]...]), and blocks of them by name
function writeDxf(name, entities, blocks = {}) {
	const pairs = (list) => list.flatMap(([type, ...codes]) => [[0, type], ...codes]);
	const all = [
		[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1009'], [0, 'ENDSEC'],
		[0, 'SECTION'], [2, 'BLOCKS'],
		...Object.entries(blocks).flatMap(([n, list]) => [[0, 'BLOCK'], [8, '0'], [2, n], [70, 0], [10, 0], [20, 0], [30, 0], ...pairs(list), [0, 'ENDBLK']]),
		[0, 'ENDSEC'],
		[0, 'SECTION'], [2, 'ENTITIES'], ...pairs(entities), [0, 'ENDSEC'], [0, 'EOF'],
	];
	fs.writeFileSync(path.join(dir, name), all.map(([c, v]) => `${c}\n${v}\n`).join(''));
}
const line = (x1, y1, x2, y2, layer = '0') => ['LINE', [8, layer], [10, x1], [20, y1], [11, x2], [21, y2]];
const lwpoly = (pts, closed, layer = '0') => ['LWPOLYLINE', [8, layer], [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y]) => [[10, x], [20, y]])];

// the area a 2-D import encloses: the volume of it extruded 1 high
async function area(src) {
	const { sdf, warnings } = await run(`linear_extrude(1) ${src}`);
	return { area: sdf.k === 'empty' ? 0 : checkMesh(await meshUniform(sdf, { cells: 96 })).volume, sdf, warnings };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

(async () => {

//--- lines and a closed LWPOLYLINE; a square hole in a square by the even-odd rule --------------------------------
{
	writeDxf('square.dxf', [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0), lwpoly([[3, 3], [7, 3], [7, 7], [3, 7]], true)]);
	const { area: a, sdf, warnings } = await area('import("square.dxf");');
	check(warnings.length === 0, `a square with a hole should import without complaint: ${warnings}`);
	check(near(a, 84, 1e-3), `a 10 square with a 4 square hole should enclose 84, not ${a.toFixed(3)}`);
	check(Math.abs(evalSdf(sdf, [10, 5, 0.5])) < 1e-9 && Math.abs(evalSdf(sdf, [7, 5, 0.5])) < 1e-9, 'the outline and the hole should be where the lines are');
	console.log(`square with a hole: area ${a.toFixed(3)}`);
}

//--- a circle and an arc closed by a line stay curves: $fn, $fa and $fs do not facet them ------------------------
{
	writeDxf('circle.dxf', [['CIRCLE', [8, '0'], [10, 0], [20, 0], [40, 5]]]);
	const { area: a } = await area('import("circle.dxf", $fn = 12);');
	check(near(a, Math.PI * 25, 1e-3), `a circle of 5 should enclose ${(Math.PI * 25).toFixed(3)} whatever $fn says, not ${a.toFixed(3)}`);
	// a half disc: an ARC from 0 to 180 degrees, closed by its diameter
	writeDxf('half.dxf', [['ARC', [8, '0'], [10, 0], [20, 0], [40, 5], [50, 0], [51, 180]], line(-5, 0, 5, 0)]);
	const { area: h, sdf: half } = await area('import("half.dxf");');
	check(near(h, Math.PI * 25 / 2, 1e-3), `a half disc of 5 should enclose ${(Math.PI * 25 / 2).toFixed(3)}, not ${h.toFixed(3)}`);
	check(Math.abs(evalSdf(half, [3, 4, 0.5])) < 1e-3, 'the arc should pass through (3, 4), on the circle of 5');
	// an ellipse, and a circle in a block scaled unequally, which is an ellipse too
	writeDxf('ellipse.dxf', [['ELLIPSE', [8, '0'], [10, 0], [20, 0], [11, 6], [21, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]]]);
	const { area: e } = await area('import("ellipse.dxf");');
	check(near(e, Math.PI * 6 * 3, 1e-3), `an ellipse of 6 by 3 should enclose ${(Math.PI * 18).toFixed(3)}, not ${e.toFixed(3)}`);
	writeDxf('squashed.dxf', [['INSERT', [8, '0'], [2, 'disc'], [10, 0], [20, 0], [41, 4], [42, 1]]], {disc: [['CIRCLE', [8, '0'], [10, 0], [20, 0], [40, 2]]]});
	const { area: q } = await area('import("squashed.dxf");');
	check(near(q, Math.PI * 8 * 2, 1e-3), `a circle of 2 scaled 4 by 1 should enclose ${(Math.PI * 16).toFixed(3)}, not ${q.toFixed(3)}`);
	console.log(`circle ${a.toFixed(3)}; half disc ${h.toFixed(3)}; ellipse ${e.toFixed(3)}; squashed circle ${q.toFixed(3)}`);
}

//--- an INSERT, turned and scaled; a layer; origin, scale and center ---------------------------------------------
{
	writeDxf('insert.dxf', [
		['INSERT', [8, 'parts'], [2, 'unit'], [10, 20], [20, 0], [41, 2], [42, 3], [50, 90]],
		lwpoly([[0, 0], [1, 0], [1, 1], [0, 1]], true, 'other'),
	], {unit: [lwpoly([[0, 0], [1, 0], [1, 1], [0, 1]], true)]});
	// the unit square, 2 by 3, turned a quarter: x from 20 - 3 to 20, y from 0 to 2
	const { area: a, sdf } = await area('import("insert.dxf", layer = "parts");');
	check(near(a, 6, 1e-3), `the inserted square scaled 2 by 3 should enclose 6, not ${a.toFixed(3)}`);
	check(Math.abs(evalSdf(sdf, [17, 1, 0.5])) < 1e-9 && Math.abs(evalSdf(sdf, [18.5, 2, 0.5])) < 1e-9, 'turned a quarter about its insertion point, it should span x 17..20 and y 0..2');
	const { area: other } = await area('import("insert.dxf", layer = "other");');
	check(near(other, 1, 1e-3), `the other layer is the unit square alone, not ${other.toFixed(3)}`);
	const { sdf: moved } = await run('linear_extrude(1) import("insert.dxf", layer = "other", origin = [1, 1], scale = 10);');
	check(Math.abs(evalSdf(moved, [-10, -5, 0.5])) < 1e-9 && Math.abs(evalSdf(moved, [0, -5, 0.5])) < 1e-9, 'origin comes off before scale: the unit square becomes -10..0');
	const { sdf: centred } = await run('linear_extrude(1) import("insert.dxf", layer = "parts", center = true);');
	check(Math.abs(evalSdf(centred, [-1.5, 0, 0.5])) < 1e-9 && Math.abs(evalSdf(centred, [0, 1, 0.5])) < 1e-9, 'center = true should put the middle of its box at the origin');
	console.log(`insert: area ${a.toFixed(3)}; layers, origin, scale and center checked`);
}

//--- an open path is closed; what OpenSCAD does not draw is reported ----------------------------------------------
{
	writeDxf('open.dxf', [lwpoly([[0, 0], [4, 0], [4, 3]], false), ['SPLINE', [8, '0'], [70, 8], [71, 3], [72, 0], [73, 0]]]);
	const { area: a, warnings } = await area('import("open.dxf");');
	check(near(a, 6, 1e-3), `an open path is closed, so the triangle encloses 6, not ${a.toFixed(3)}`);
	check(warnings.some(w => w.includes('SPLINE')), `a SPLINE should be reported, not drawn: ${warnings}`);
	console.log('open path closed; SPLINE reported');
}

//--- dxf_dim() and dxf_cross() ---------------------------------------------------------------------------------
{
	writeDxf('dims.dxf', [
		// a rotated (type 0) dimension measured along 30 degrees between (0, 0) and (10, 0), and an aligned one
		['DIMENSION', [8, '0'], [1, 'along'], [70, 0], [10, 0], [20, 0], [13, 0], [23, 0], [14, 10], [24, 0], [50, 30]],
		['DIMENSION', [8, '0'], [1, 'aligned'], [70, 1], [10, 0], [20, 0], [13, 0], [23, 0], [14, 3], [24, 4]],
		['DIMENSION', [8, '0'], [1, 'radius'], [70, 4], [10, 1], [20, 1], [15, 4], [25, 5]],
		line(0, 0, 10, 10, 'cross'), line(0, 10, 10, 0, 'cross'),
	]);
	const got = [];
	const { warnings } = await run('x = [dxf_dim(file = "dims.dxf", name = "along"), dxf_dim(file = "dims.dxf", name = "aligned"), dxf_dim(file = "dims.dxf", name = "radius"), dxf_cross(file = "dims.dxf", layer = "cross")];');
	const log = console.log;
	console.log = (...a) => got.push(a.join(' '));
	await run('echo(dxf_dim(file = "dims.dxf", name = "along"), dxf_dim(file = "dims.dxf", name = "aligned"), dxf_dim(file = "dims.dxf", name = "radius"), dxf_cross(file = "dims.dxf", layer = "cross"));');
	console.log = log;
	const [along, aligned, radius, cross] = got.at(-1).replace('ECHO: ', '').match(/\[[^\]]*\]|[^,\s]+/g);
	check(near(Number(along), 10 * Math.cos(Math.PI / 6), 1e-9), `the rotated dimension should be 10 cos 30, not ${along}`);
	check(Number(aligned) === 5, `the aligned dimension should be 5, not ${aligned}`);
	check(Number(radius) === 5, `the radius dimension should be 5, not ${radius}`);
	check(cross === '[5, 5]', `the lines should cross at [5, 5], not ${cross}`);
	check(warnings.length === 0, `the dimensions should read without complaint: ${warnings}`);
	console.log(`dxf_dim: ${along} ${aligned} ${radius}; dxf_cross: ${cross}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'ok: DXF outlines, blocks, layers and dimensions come out as OpenSCAD draws them');
process.exit(bad ? 1 : 0);

})();
