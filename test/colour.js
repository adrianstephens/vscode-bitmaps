// color(): the names and hex forms OpenSCAD accepts, and which colour wins where.
//
// The material the shader reports is the second half of map()'s vec2, so it is checked here at points *on* the
// surface -- a shell where |d| is small, which is where the tracer actually stops and reads it -- against
// evalMaterial(), which is the same rule written once in the mirror. The rule itself is OpenSCAD's: the nearest
// operand decides a union, the one bounding an intersection decides that, and a cut face keeps the colour of what
// it was cut out of.
const { makeMap } = require('./glsl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, evalMaterial, materials, SDF } = require('../out/src/scad/sdf.js');
const evalSdf = (s, p) => new SDF(s).eval(p);

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function build(src) {
	const { sdf, warnings } = evaluate(src, 'colour.js');
	const g = emitGlsl(sdf);
	const map = makeMap([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'));
	return {sdf, warnings, map};
}

//--- the palette, from the names and forms ---------------------------------------------------------------
{
	const { sdf } = build(`
color("red") cube(4);
color("#0f0") translate([5,0,0]) cube(4);
color("aliceblue") translate([10,0,0]) cube(4);
color([0.1, 0.2, 0.3]) translate([15,0,0]) cube(4);
color("RED") translate([20,0,0]) cube(4);
`);
	// a palette entry is a whole material now: this file is only about the colour part of it
	const p = materials(sdf), rgb = p.map(m => m.rgb);
	console.log(`palette: ${rgb.map(c => `[${c.map(v => v.toFixed(3)).join(',')}]`).join(' ')}`);
	check(p.length === 5, `expected the default and 4 distinct colours, got ${p.length}`);
	check(rgb[1].every((v, i) => near(v, [1, 0, 0][i])), 'color("red") is not (1,0,0)');
	check(rgb[2].every((v, i) => near(v, [0, 1, 0][i])), 'color("#0f0") is not (0,1,0)');
	check(rgb[3].every((v, i) => near(v, [240 / 255, 248 / 255, 255 / 255][i])), 'color("aliceblue") is wrong');
	check(rgb[4].every((v, i) => near(v, [0.1, 0.2, 0.3][i])), 'color([0.1,0.2,0.3]) is wrong');
	check(p.length === 5, 'the same colour written twice should be one material');
}

//--- which colour wins where, shader against mirror ------------------------------------------------------
{
	// four parts, far enough apart that a material is never in two of them at once
	const { sdf, map } = build(`
color("red") cube([10, 10, 10], center = true);
color("green") translate([12, 0, 0]) sphere(r = 5);
translate([0, 20, 0]) difference() {
	color("blue") cube([10, 10, 10], center = true);
	color("yellow") sphere(r = 6);
}
translate([0, -20, 0]) intersection() {
	color("orange") sphere(r = 6);
	color("purple") cube([10, 10, 10], center = true);
}
`);
	// the css values, which are not the primaries: "green" is #008000 and "purple" #800080, while "red", "blue" and
	// "yellow" do happen to be #ff0000, #0000ff and #ffff00
	const RED = [1, 0, 0], GREEN = [0, 128 / 255, 0], BLUE = [0, 0, 1];
	const PURPLE = [128 / 255, 0, 128 / 255], ORANGE = [1, 165 / 255, 0];
	const palette = materials(sdf);
	const rgbAt = (p) => palette[evalMaterial(sdf, p)].rgb;
	const is = (p, hex) => rgbAt(p).every((v, i) => near(v, hex[i]));
	const show = (p) => `[${rgbAt(p).map(v => v.toFixed(2)).join(',')}]`;

	let worst = 0, at = null, n = 0, yellow = 0, seed = 11;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < 60000; i++) {
		const p = [(rand() - 0.5) * 24, (rand() - 0.5) * 60, (rand() - 0.5) * 24];
		if (Math.abs(evalSdf(sdf, p)) > 0.08)		// only where the tracer would stop and read a material off
			continue;
		n++;
		const got = map(p)[1], want = evalMaterial(sdf, p);
		if (!Number.isFinite(got) || got !== want)
			worst = Infinity, at = p;
		if (want === 4)
			yellow++;
	}
	console.log(`material at ${n} points on the surface: shader and mirror ${worst === 0 ? 'agree' : `DISAGREE at [${at.map(v => v.toFixed(3))}]`}`);
	check(n > 200, `too few surface points sampled (${n})`);
	check(worst === 0, 'the shader and the mirror pick different materials');

	// the specific decisions the rule is about
	check(is([0, 0, 0], RED), `inside the red cube, got ${show([0, 0, 0])} (want red)`);
	check(is([12, 0, 0], GREEN), `inside the green sphere, got ${show([12, 0, 0])} (want green)`);
	check(is([4.5, 24.5, 4.5], BLUE), `inside a corner of the difference, got ${show([4.5, 24.5, 4.5])} (want blue)`);
	// a point on the sphere's surface, inside the cube: the cut face is the blue it was cut out of
	check(is([6 / Math.sqrt(3), 20 + 6 / Math.sqrt(3), 6 / Math.sqrt(3)], BLUE),
		`on the cut face, got ${show([3.464, 23.464, 3.464])} (want the blue it was cut from, not yellow)`);
	check(yellow === 0, `a cut operand's colour was shown on ${yellow} points; it should never be`);
	// the intersection is bounded by the cube at its centre and by the sphere at its corners
	check(is([0, -20, 0], PURPLE), `at the centre of the intersection, got ${show([0, -20, 0])} (want purple, the cube)`);
	check(is([5, -15, 5], ORANGE), `at a corner of the intersection, got ${show([5, -15, 5])} (want orange, the sphere)`);
}

//--- the warnings ----------------------------------------------------------------------------------------
{
	const warn = (src) => build(src).warnings.join(' | ');
	check(/does not know: 'nosuchcolour'/.test(warn('color("nosuchcolour") cube(1);')), 'an unknown name should be reported');
	check(/xkcd/.test(warn('color("xkcd:blue") cube(1);')), 'an xkcd: name should be reported as not carried over');
	check(/outside 0\.\.1/.test(warn('color([2, 0, 0]) cube(1);')), 'an out of range component should be reported');
	// alpha is the transmission now, so it is no longer a warning: it has to reach the material instead
	check(near(materials(build('color("red", 0.5) cube(1);').sdf)[1].opacity, 0.5), 'an alpha below 1 should reach the material');
	check(warn('color("red") cube(1);') === '', 'a plain colour should not warn');
	console.log(`warnings: ${['nosuchcolour', 'xkcd:blue', '[2,0,0]', 'red at 0.5', 'red'].length} cases checked`);
}

console.log(bad ? `${bad} FAILED` : 'ok: colours parse as openscad parses them, and the nearest operand wins');
process.exit(bad ? 1 : 0);
