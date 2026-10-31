// import() of an SVG: drawings made here, whose outlines are known, checked by where the outline is (the field is 0 on
// it) and by the area it encloses (the mesh of a unit-high extrusion). OpenSCAD's own import takes y upward from the
// page's lower left and a pixel as 25.4 / dpi millimetres; curves stay curves.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-'));
const files = new FileReader();
const run = (src) => files.with(() => evaluate(src, path.join(dir, 'main.scad'), files));
const write = (name, body, attrs = 'viewBox="0 0 100 100" width="100mm" height="100mm"') =>
	fs.writeFileSync(path.join(dir, name), `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);

async function area(src) {
	const { sdf, warnings } = await run(`linear_extrude(1) ${src}`);
	return { area: sdf.k === 'empty' ? 0 : checkMesh(await meshUniform(sdf, { cells: 96 })).volume, sdf, warnings };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
// curves are within 1e-4 of the drawing's size of exact
const on = (sdf, x, y) => Math.abs(evalSdf(sdf, [x, y, 0.5])) < 5e-3;

(async () => {

//--- a rect: y is up from the page's lower left, in millimetres -----------------------------------------------------
{
	write('rect.svg', '<rect x="10" y="20" width="30" height="40"/>');
	const { area: a, sdf, warnings } = await area('import("rect.svg");');
	check(warnings.length === 0, `a rect should import without complaint: ${warnings}`);
	check(near(a, 1200, 1e-3), `a 30 by 40 rect should enclose 1200, not ${a.toFixed(3)}`);
	// the page is 100 high, so the rect spans y 40..80 once flipped
	check(on(sdf, 10, 60) && on(sdf, 40, 60) && on(sdf, 25, 40) && on(sdf, 25, 80), 'the rect should span x 10..40 and y 40..80');
	console.log(`rect: area ${a.toFixed(3)}`);
}

//--- pixels at dpi; a view box scaled to a size ---------------------------------------------------------------------
{
	write('px.svg', '<rect width="96" height="48"/>', 'width="96" height="48"');
	const { sdf } = await area('import("px.svg");');
	check(on(sdf, 25.4, 0) && on(sdf, 25.4, 12.7), 'at 96 dpi a 96 px rect is 25.4 mm wide');
	const { sdf: dpi } = await area('import("px.svg", dpi = 25.4);');
	check(on(dpi, 96, 0) && on(dpi, 96, 48), 'at 25.4 dpi a pixel is a millimetre');
	write('scaled.svg', '<rect width="50" height="50"/>', 'viewBox="0 0 100 100" width="2in" height="2in"');
	const { sdf: inches } = await area('import("scaled.svg");');
	check(on(inches, 25.4, 25.4) && on(inches, 25.4, 50.8), 'a 100 unit view box 2 in wide scales a unit to 0.508 mm: the rect is 25.4 mm');
	console.log('units: dpi and view box checked');
}

//--- curves stay curves: a circle, an ellipse, rounded corners, an arc path -------------------------------------------
{
	write('circle.svg', '<circle cx="50" cy="50" r="20"/><ellipse cx="50" cy="50" rx="10" ry="5" fill="none"/>');
	const { area: a, warnings } = await area('import("circle.svg");');
	check(near(a, Math.PI * 400, 1e-3), `a circle of 20 should enclose ${(Math.PI * 400).toFixed(3)} whatever $fn says, not ${a.toFixed(3)}`);
	check(warnings.some(w => w.includes('no fill')), `a shape with no fill should be reported: ${warnings}`);
	write('round.svg', '<rect width="40" height="20" rx="5" ry="5"/>');
	const { area: r } = await area('import("round.svg");');
	check(near(r, 800 - (4 - Math.PI) * 25, 1e-3), `a 40 by 20 rect with corners of 5 should enclose ${(800 - (4 - Math.PI) * 25).toFixed(3)}, not ${r.toFixed(3)}`);
	write('arc.svg', '<path d="M30 50 A20 20 0 0 1 70 50 Z"/>');
	const { area: h, sdf } = await area('import("arc.svg");');
	check(near(h, Math.PI * 200, 1e-3), `a half disc of 20 should enclose ${(Math.PI * 200).toFixed(3)}, not ${h.toFixed(3)}`);
	check(on(sdf, 50, 70), 'the arc should reach its top, 20 above its chord (y is up)');
	console.log(`circle ${a.toFixed(3)}; rounded rect ${r.toFixed(3)}; arc half disc ${h.toFixed(3)}`);
}

//--- transforms, groups, use ---------------------------------------------------------------------------------------
{
	write('group.svg', '<g transform="translate(10 0) scale(2 1)"><circle cx="10" cy="50" r="5"/></g>');
	const { area: a, sdf } = await area('import("group.svg");');
	check(near(a, Math.PI * 5 * 10, 2e-3), `a circle of 5 scaled 2 by 1 is an ellipse of 10 by 5, enclosing ${(Math.PI * 50).toFixed(3)}, not ${a.toFixed(3)}`);
	check(on(sdf, 40, 50) && on(sdf, 30, 55), 'the ellipse should centre at 30, 50 and reach 10 across and 5 up');
	write('use.svg', '<defs><rect id="r" width="10" height="10"/></defs><use xlink:href="#r" x="20" y="30"/>', 'viewBox="0 0 100 100" width="100mm" height="100mm" xmlns:xlink="http://www.w3.org/1999/xlink"');
	const { sdf: used } = await area('import("use.svg");');
	check(on(used, 20, 60) && on(used, 30, 60), 'a use should draw its target, moved by x and y');
	console.log(`transforms: ellipse ${a.toFixed(3)}; use checked`);
}

//--- a hole, ids and layers, center -------------------------------------------------------------------------------
{
	write('hole.svg', '<path d="M0 0H40V40H0Z M10 10H30V30H10Z"/>');
	const { area: a } = await area('import("hole.svg");');
	check(near(a, 1200, 1e-3), `a 40 square with a 20 hole should enclose 1200, not ${a.toFixed(3)}`);
	write('ids.svg', '<g id="a"><rect width="10" height="10"/></g><g id="b" inkscape:label="top" inkscape:groupmode="layer" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><rect x="50" y="50" width="20" height="20"/></g>');
	const { area: ia } = await area('import("ids.svg", id = "a");');
	check(near(ia, 100, 1e-3), `id = "a" should draw only the 10 square, not ${ia.toFixed(3)}`);
	const { area: la } = await area('import("ids.svg", layer = "top");');
	check(near(la, 400, 1e-3), `layer = "top" should draw only the 20 square, not ${la.toFixed(3)}`);
	const { sdf: centred } = await area('import("ids.svg", id = "b", center = true);');
	check(on(centred, -10, 0) && on(centred, 10, 0), 'center = true should put the middle of its box at the origin');
	console.log('hole, id, layer and center checked');
}

//--- what is not drawn is reported -------------------------------------------------------------------------------
{
	write('text.svg', '<text x="0" y="10">hi</text><rect width="5" height="5"/>');
	const { warnings } = await area('import("text.svg");');
	check(warnings.some(w => w.includes('text')), `text should be reported, not drawn: ${warnings}`);
	console.log('text reported');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'ok: SVG shapes come out as OpenSCAD draws them, their curves exact');
process.exit(bad ? 1 : 0);

})();
