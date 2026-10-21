// text(): finds a system font by name (src/scad/fonts.ts's findFont, matching OpenSCAD/fontconfig's own family-name
// convention rather than a filename) and turns a string into one curvepath2 per glyph -- a path of lines and the
// font's own quadratic Beziers, kept as curves rather than flattened, each with its own paths for its own holes --
// unioned together, never merged into one multi-path shape (see evaluate.ts's 'text' case for why: an even-odd fill
// across unrelated glyphs would punch a hole wherever two letters happened to overlap).
//
// This also exercises the binary_fonts fixes this feature needed: a .ttc's stream was never seeked back to 0 before
// parsing (so every font inside read as zero fonts), every table read went through a ReadClass's unconditionally
// async get() even though nothing here ever awaits real I/O, the name table's string offset was resolved one
// object-chain hop short of where bin.Array's per-element read actually leaves it, and parseCurve's own handling of
// two consecutive off-curve points (TrueType's implied-on-curve-point convention) lost track of the implied point
// for whatever curve came after it, drawing a shape that skipped over it -- see the "curve accuracy" section below,
// which checks curvepath2 against a very finely flattened independent reference specifically through a glyph this
// bug affected.
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, polygonDistance2, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const bounds3 = s => new SDF(s).bounds();
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { load, parseCurve } = require('@isopodlabs/binary_fonts');
const fs = require('fs');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const FLAT = (shape) => `linear_extrude(height = 2) ${shape}`;

(async () => {

// fonts.ts scans the system's font directories once, asynchronously, the same as a real extension host does before
// its first render (see ScadViewer.tsx's own await of this) -- every text() below depends on it having finished.
await require('../out/src/scad/fonts.js').buildIndex();

//--- a plain string draws clean, closed, manifold geometry --------------------------------------------------
{
	const { sdf, warnings } = evaluate(FLAT('text("Hi", size = 10, font = "Helvetica");'), 'text.js');
	check(warnings.length === 0, `a plain text() warned: ${JSON.stringify(warnings)}`);
	const stats = checkMesh(await meshUniform(sdf, {cells: 96}));
	check(stats.open === 0 && stats.nonManifold === 0, `text() mesh has ${stats.open} open and ${stats.nonManifold} non-manifold edges`);
	check(stats.volume > 0, 'text() should draw something');
	console.log(`plain text: volume ${stats.volume.toFixed(3)}, open ${stats.open}, non-manifold ${stats.nonManifold}`);
}

//--- a letter with a counter (a hole) really has one: even-odd across that glyph's own two paths -------------
{
	const { sdf, warnings } = evaluate(FLAT('text("O", size = 20, font = "Helvetica", halign = "center", valign = "center");'), 'text.js');
	check(warnings.length === 0, `text("O") warned: ${JSON.stringify(warnings)}`);
	check(evalSdf(sdf, [0, 0, 1]) > 0, 'the centre of an "O" should be outside it -- in the hole');
	check(evalSdf(sdf, [5.5, 0, 1]) < 0, 'a point in the stroke of an "O" should be inside it');
	console.log(`"O" hole: centre ${evalSdf(sdf, [0, 0, 1]).toFixed(3)}, stroke ${evalSdf(sdf, [5.5, 0, 1]).toFixed(3)}`);
}

//--- halign/valign move the whole string relative to its own origin, not just clip it -------------------------
{
	const left = bounds3(evaluate(FLAT('text("A", size = 10);'), 'text.js').sdf);
	const centred = bounds3(evaluate(FLAT('text("A", size = 10, halign = "center", valign = "center");'), 'text.js').sdf);
	check(left.min.x > -1e-6, `left-aligned text should start at x = 0, starts at ${left.min.x}`);
	check(centred.min.x < -1e-6 && centred.max.x > 1e-6, 'centre-aligned text should straddle x = 0');
	check(centred.min.y < -1e-6 && centred.max.y > 1e-6, 'centre-aligned text should straddle y = 0');
	console.log(`halign/valign: left [${left.min.x.toFixed(2)}, ${left.max.x.toFixed(2)}], centred [${centred.min.x.toFixed(2)}, ${centred.max.x.toFixed(2)}]`);
}

//--- spacing widens the whole string, not just the last character's advance -----------------------------------
{
	const normal = bounds3(evaluate(FLAT('text("mmmm", size = 10);'), 'text.js').sdf);
	const wide = bounds3(evaluate(FLAT('text("mmmm", size = 10, spacing = 2);'), 'text.js').sdf);
	check(wide.max.x > normal.max.x * 1.5, `spacing = 2 should roughly double the width (${normal.max.x.toFixed(2)} -> ${wide.max.x.toFixed(2)})`);
	console.log(`spacing: normal width ${normal.max.x.toFixed(2)}, spacing = 2 width ${wide.max.x.toFixed(2)}`);
}

//--- an unknown font name falls back to a real one, and says so ------------------------------------------------
{
	const { warnings } = evaluate(FLAT('text("x", font = "Definitely Not A Real Font Name");'), 'text.js');
	check(warnings.some(w => /font .* not found/.test(w)), `an unknown font should warn, got ${JSON.stringify(warnings)}`);
	console.log(`unknown font: ${warnings.join(' | ')}`);
}

//--- empty text and an unreadable text= argument both draw nothing, not an error --------------------------------
{
	const { sdf: sdfEmpty } = evaluate(FLAT('text("");'), 'text.js');
	check(bounds3(sdfEmpty) === undefined, 'an empty string should draw nothing');
	const { sdf: sdfUndef, warnings } = evaluate(FLAT('text(dir_nothing);'), 'text.js');
	check(bounds3(sdfUndef) === undefined, 'a text() with an unreadable text= should draw nothing');
	check(warnings.some(w => /dir_nothing/.test(w)), `it should name the undef, got ${JSON.stringify(warnings)}`);
}

//--- curve accuracy: curvepath2's exact Bezier distance against a very finely flattened independent reference ----
{
	// built straight from binary_fonts, not through fonts.ts, so this is a check against an independent source: a
	// polygon2 (the already-trusted straight-edge field) flattened at 300 segments per curve, which is close enough
	// to the true curve that any difference above float noise means curvepath2's own math -- or the font curve data
	// parseCurve handed it -- is wrong, not a flattening artefact
	const font = load(fs.readFileSync('/System/Library/Fonts/Helvetica.ttc')).fonts[0];
	const upm = font.head.units_per_em;
	const scale = 30 / upm;
	const gid = font.getGlyphMapping()['@'.codePointAt(0)];		// a glyph with runs of consecutive off-curve points
	const glyph = font.getGlyph(gid);
	const refPaths = [];
	let cur = [];
	const flatQuad = (a, b, c, n) => { for (let i = 1; i <= n; i++) { const t = i / n, mt = 1 - t; cur.push({x: mt * mt * a.x + 2 * mt * t * b.x + t * t * c.x, y: mt * mt * a.y + 2 * mt * t * b.y + t * t * c.y}); }; };
	parseCurve(glyph.curve).run({
		Begin(a) { cur = [a]; }, End() { refPaths.push(cur); }, Line(_a, b) { cur.push(b); },
		Bezier2(a, b, c) { flatQuad(a, b, c, 300); }, Bezier3() {}, Arc() {}, Arc3() {},
	});
	const advance = font.hmtx.metrics[Math.min(gid, font.hmtx.metrics.length - 1)].advance;
	const offsetX = -advance / 2, offsetY = -(font.hhea.ascent + font.hhea.descent) / 2;
	const scaled = refPaths.map(p => p.map(pt => ({x: (pt.x + offsetX) * scale, y: (pt.y + offsetY) * scale})));

	// a tall centred extrusion, so that at z = 0 the slab term is far below and the shape's own field is what is
	// measured everywhere in the 40x40 sample area -- FLAT()'s height = 2 would let the slab clamp answers deep
	// inside a stroke, which a random-point sweep (unlike the boundary-only checks elsewhere in this file) reaches
	const { sdf } = evaluate('linear_extrude(height = 200, center = true) text("@", size = 30, font = "Helvetica", halign = "center", valign = "center");', 'text.js');
	let seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	let worst = 0, at = null;
	for (let i = 0; i < 20000; i++) {
		const px = (rand() - 0.5) * 40, py = (rand() - 0.5) * 40;
		const diff = Math.abs(polygonDistance2(px, py, scaled) - evalSdf(sdf, [px, py, 0]));
		if (diff > worst) { worst = diff; at = [px, py]; }
	}
	check(worst < 1e-3, `curvepath2's "@" differs from a finely flattened reference by ${worst.toExponential(3)} at [${at}]`);
	console.log(`curve accuracy ("@" vs 300-segment reference): worst ${worst.toExponential(3)}`);
}

//--- the shader (compiled and run for real in headless Chrome) agrees with evalSdf() for a union of glyph
//    curvepath2s, the one construct this feature actually adds to what twod.js already covers --------------------
{
	const { sdf } = evaluate(FLAT('text("Bo8@", size = 12, font = "Helvetica");'), 'text.js');
	const g = emitGlsl(sdf);
	const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
	let seed = 3;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const pts = Array.from({length: 4000}, () => [(rand() - 0.5) * 40, (rand() - 0.5) * 30, (rand() - 0.5) * 4]);
	const results = await shader.at(pts);
	let worst = 0;
	for (let i = 0; i < pts.length; i++) {
		const d = results[i][0];
		if (!Number.isFinite(d)) { worst = Infinity; break; }
		worst = Math.max(worst, Math.abs(d - evalSdf(sdf, pts[i])));
	}
	check(worst < 1e-4, `text() shader and mirror differ by ${worst.toExponential(3)}`);
	console.log(`shader vs mirror: ${worst.toExponential(3)}`);
}

//--- every face, not just the one the rest of this file draws with --------------------------------------------
// A TrueType contour may start on a control point (a round glyph's often does), and the outline must then be
// rotated to start on a point that is on the curve. binary_fonts once failed to rotate it, and promoted the control
// point to a start instead, which turns the curve beside it into a straight chord: the notch cut out of a letter O
// in the Regular face of Helvetica while the Bold face, whose contours happen to start on the curve, was fine. The
// round letters of any face have no straight side at all, so a straight segment in one is that bug. Faces and
// families are tried in whatever this machine has.
{
	// findFont() is fonts.ts's own business (layoutText is the public surface that reaches it), so whether a face
	// is actually installed -- rather than substituted for another -- is read off layoutText's own warn callback
	const { layoutText } = require('../out/src/scad/fonts.js');
	const families = ['Helvetica', 'Arial', 'Times New Roman', 'Times', 'Georgia', 'Verdana', 'Courier New', 'DejaVu Sans', 'Liberation Sans', 'Menlo'];
	let faces = 0;
	for (const family of families) for (const style of ['', ':style=Bold', ':style=Italic']) {
		const spec = family + style;
		let warned = false;
		const contours0 = layoutText({text: 'O', size: 1000, font: spec, halign: 'left', valign: 'baseline', spacing: 1, fn: 16}, () => { warned = true; })[0] ?? [];
		if (warned)		// not installed: findFont substituted another, which some other spec in this list covers
			continue;
		faces++;
		for (const [ch, contours] of [['O', contours0], ['o', layoutText({text: 'o', size: 1000, font: spec, halign: 'left', valign: 'baseline', spacing: 1, fn: 16}, () => {})[0] ?? []]]) {
			const lines = contours.flatMap(c => c.segs.filter(seg => seg.t === 'line'));
			check(contours.length === 2, `${spec}: '${ch}' should be an outline and its counter, it has ${contours.length} contours`);
			check(lines.length === 0, `${spec}: '${ch}' has ${lines.length} straight segments, where a round letter has none`);
		}
	}
	console.log(`round letters: ${faces} installed faces checked for straight sides`);
	check(faces > 0, 'no face to check the round letters of (is any of the usual fonts installed?)');
}

//--- str() builds the font name -----------------------------------------------------------------------------
// str() once quoted its string arguments as echo does, so str("Helvetica", ":style=Bold") named a font that has
// quote marks in it and the wrong face was drawn, silently, with only a "font not found" warning to show for it.
{
	const built = evaluate('linear_extrude(height = 1) text("Ag", size = 20, font = str("Helvetica", ":style=Bold"));', 'str.scad');
	const literal = evaluate('linear_extrude(height = 1) text("Ag", size = 20, font = "Helvetica:style=Bold");', 'str.scad');
	check(JSON.stringify(built.sdf) === JSON.stringify(literal.sdf), 'a font built with str() should draw the same glyphs as the same name written out');
	check(built.warnings.join() === literal.warnings.join(), `str() should not change what is warned about (${built.warnings} against ${literal.warnings})`);
	console.log('str(): a font name built from strings selects the same face as the literal');
}

console.log(bad ? `\n${bad} FAILED` : '\ntext() finds a system font by name, and draws holes, alignment and spacing correctly');
await close();
process.exit(bad ? 1 : 0);

})();
