// Big unions are not unrolled into the shader: their leaves go into a texture as a bounding-volume hierarchy, and one
// small loop (sdBatch) walks it. That is what lets a 2047-leaf tree compile in a fraction of a second and draw in a
// few milliseconds, where the unrolled code took fourteen seconds to compile and a third of a second per frame. Two
// things are checked: the shader's field agrees with the JS mirror wherever a ray can meet the surface, for every
// kind of leaf the batch can hold, with the leftovers that cannot be batched drawn beside them; and the tree the
// examples use stays inside a cost budget.
//
// "Wherever a ray can meet the surface" is a band around it, not everywhere: far from a union the field is only a
// lower bound, and the shader and the mirror cull differently there and return different (both valid) bounds3.
const { evaluate } = require('./scadhost.js');
const { emitGlsl, countPrimitives, union, SDF } = require('../out/src/scad/sdf.js');
const evalSdf = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { makeShader, close } = require('./webgl.js');
const { render, close: closeRender } = require('./render.js');
const { float2, float3 } = require('@isopodlabs/maths/vector');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

// The outline of a glyph, worked out here rather than read from a font so that the test needs none installed: Helvetica
// Bold's O, in 1/1000 em, an outline and its counter, all quadratic. A text is a union of these, one to a character.
const P = (x, y) => float2(x / 25, y / 25);
const quad = (cx, cy, bx, by) => ({t: 'quad', c: P(cx, cy), b: P(bx, by)});
const LETTER_O = [
	{start: P(395, -20), segs: [quad(240, -20, 159, 64), quad(49, 167, 49, 361), quad(49, 559, 159, 658), quad(240, 742, 395, 742), quad(549, 742, 630, 658), quad(739, 559, 739, 361), quad(739, 167, 630, 64), quad(549, -20, 395, -20)]},
	{start: P(537, 173), segs: [quad(589, 239, 589, 361), quad(589, 482, 536, 548), quad(484, 614, 395, 614), quad(305, 614, 252, 548), quad(199, 482, 199, 361), quad(199, 239, 252, 173), quad(305, 107, 395, 107), quad(484, 107, 537, 173)]},
];
// (as a font's curve, which a curvepath2 holds: each contour's start, then each quadratic segment's control point and end)
const { curveVertex, ON_BEGIN, ON_CURVE, OFF_BEZ2 } = require('@isopodlabs/binary_fonts');
const shifted = (paths, dx, dy) => paths.flatMap(p => [
	curveVertex(p.start.x + dx, p.start.y + dy, ON_BEGIN),
	...p.segs.flatMap(s => [curveVertex(s.c.x + dx, s.c.y + dy, OFF_BEZ2), curveVertex(s.b.x + dx, s.b.y + dy, ON_CURVE)]),
]);
const glyphs = (n) => ({k: 'extrude', h: 2, center: false, body: union(Array.from({length: n}, (_, i) => ({k: 'curvepath2', paths: shifted(LETTER_O, i * 32, (i % 3) * 5)})))});

const BAND = 3;
const ROW = 'for (i = [0:19]) translate([i * 5, 0, 0])';
const CASES = {
	'spheres': `${ROW} sphere(2);`,
	'boxes': `${ROW} cube([3, 2, 4]);`,
	'centred boxes': `${ROW} cube([3, 2, 4], center = true);`,
	'cylinders': `${ROW} cylinder(h = 5, r = 1.5);`,
	'centred cylinders': `${ROW} cylinder(h = 5, r = 1.5, center = true);`,
	'boxes rotated about z': `${ROW} rotate([0, 0, i * 17]) cube([3, 2, 4]);`,
	'boxes rotated about all three': `${ROW} rotate([i * 13, i * 7, i * 29]) cube([3, 2, 4]);`,
	'cylinders rotated about all three': `${ROW} rotate([i * 13, i * 7, i * 29]) cylinder(h = 5, r = 2);`,
	'scaled spheres': `${ROW} scale([1 + i % 3, 1, 1]) sphere(2);`,
	'squares': 'linear_extrude(2) for (i = [0:19]) translate([i * 5, 0]) rotate(i * 11) square([3, 2]);',
	'polygons with holes': 'linear_extrude(2) for (i = [0:19]) translate([i * 12, 0]) rotate(i * 9) polygon(points = [[0,0],[10,0],[10,10],[0,10],[3,3],[7,3],[7,7],[3,7]], paths = [[0,1,2,3],[4,5,6,7]]);',
	'circles': 'linear_extrude(2) for (i = [0:19]) translate([i * 5, 0]) circle(2);',
	'coloured spheres': `for (i = [0:19]) color(i % 2 ? "red" : "green") translate([i * 5, 0, 0]) sphere(2);`,
	// a text: few leaves, but each with dozens of segments, which unrolled are most of a shader
	'three glyphs': () => glyphs(3),
	'forty glyphs': () => glyphs(40),
	// leaves the batch cannot hold sit in the same union as ones it can
	'batchable and not': `union() { ${ROW} sphere(2); hull() { sphere(3); translate([40, 5, 0]) cube(2); } translate([20, -9, 0]) rotate_extrude() translate([3, 0]) circle(1); }`,
};

(async () => {
	let seed = 5;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (const [label, src] of Object.entries(CASES)) {
		const {sdf} = typeof src === 'function' ? {sdf: src()} : evaluate(src, 'batch.scad');
		const g = emitGlsl(sdf);
		const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
		// points through the whole of the model's box and a little beyond, wherever that is
		const box = bounds3(sdf), pad = BAND;
		const points = Array.from({length: 3000}, () => [
			box.min.x - pad + rand() * (box.max.x - box.min.x + 2 * pad), box.min.y - pad + rand() * (box.max.y - box.min.y + 2 * pad), box.min.z - pad + rand() * (box.max.z - box.min.z + 2 * pad)]);
		const got = await shader.at(points);
		let worst = 0, compared = 0, inside = 0;
		points.forEach((p, i) => {
			const want = evalSdf(sdf, float3(p[0], p[1], p[2]));
			if (want > BAND)
				return;
			compared++;
			if (want < 0) inside++;
			worst = Math.max(worst, Math.abs(got[i][0] - want));
		});
		console.log(`${label.padEnd(34)} ${g.data.length ? 'batched' : 'unrolled'}  ${compared} points, ${inside} inside, worst ${worst.toExponential(1)}`);
		check(g.data.length > 0, `${label}: expected the union to be batched`);
		check(compared > 100 && inside > 10, `${label}: too few points near the surface to mean anything (${compared}, ${inside})`);
		check(worst < 1e-3, `${label}: the shader disagrees with the mirror by ${worst}`);
	}
	await close();

	// the shape that motivated it (examples/Advanced/module_recursion.scad): a binary tree of 2047 extruded pieces
	const tree = `
		module branch(depth, length) {
			translate([0, length / 2]) square([length / 12, length], center = true);
			if (depth > 0)
				translate([0, length]) {
					rotate(25 + depth * 3) branch(depth - 1, length * 0.8);
					rotate(-30 - depth * 2) branch(depth - 1, length * 0.75);
				}
		}
		linear_extrude(1) branch(10, 40);`;
	{
		const {sdf} = evaluate(tree, 'tree.scad');
		const g = emitGlsl(sdf);
		const r = await render(sdf);
		console.log(`tree of ${countPrimitives(sdf)} leaves: ${g.helpers.length} helpers, ${g.body.length} lines; ${r.error ? 'did not compile' : `${r.compileMs.toFixed(0)} ms to compile and draw, ${r.frameMs.toFixed(1)} ms a frame`}`);
		check(countPrimitives(sdf) > 2000, 'the tree should have thousands of leaves');
		check(!r.error, `the tree did not compile: ${r.error}`);
		check(g.helpers.length < 10 && g.body.length < 20, 'the tree was unrolled into the shader');
		check(r.compileMs < 4000, `the tree took ${r.compileMs} ms to compile`);
		check(r.frameMs < 150, `the tree took ${r.frameMs} ms a frame`);
	}
	// the shape of logo_and_text.scad: several lines of text, each its own extrusion of one glyph per character. Kept
	// as unrolled code that was 87 functions and 225 KB, ten seconds to compile and a third of a second a frame.
	{
		const line = (n, y) => ({k: 'extrude', h: 1, center: false, body: union(Array.from({length: n}, (_, i) => ({k: 'curvepath2', paths: shifted(LETTER_O, i * 30, y)})))});
		const sdf = union([line(4, 0), line(4, 40), line(14, 80), line(18, 120)]);
		const g = emitGlsl(sdf);
		const r = await render(sdf);
		console.log(`four lines of text (${4 + 4 + 14 + 18} glyphs): ${g.helpers.length} helpers; ${r.error ? 'did not compile' : `${r.compileMs.toFixed(0)} ms to compile and draw, ${r.frameMs.toFixed(1)} ms a frame`}`);
		check(!r.error, `the text did not compile: ${r.error}`);
		check(g.helpers.length < 20, `the glyphs were unrolled into the shader (${g.helpers.length} helpers)`);
		check(r.compileMs < 4000 && r.frameMs < 100, `the text cost ${r.compileMs} ms to compile and ${r.frameMs} ms a frame`);
	}
	await closeRender();
	console.log(bad ? `${bad} FAILED` : 'ok: big unions are batched, agree with the mirror, and stay cheap');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.log('ERR', String(e.stack ?? e.message).slice(0, 800)); process.exit(1); });
