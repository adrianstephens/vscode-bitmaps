// FontDocument, the editor's model: edit, undo, redo, save, revert and backup, over a copy of a font, with the parts of
// the vscode API it uses stood in for.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const fire = [];
class EventEmitter {
	constructor() { this.l = []; this.event = f => { this.l.push(f); return {dispose() {}}; }; }
	fire(e) { this.l.forEach(f => f(e)); }
	dispose() {}
}
const vscode = {EventEmitter, workspace: {fs: {
	readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)),
	writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d),
}}, Uri: {file: p => ({fsPath: p, toString: () => p})}};
const origLoad = Module._load;
Module._load = function (r, ...a) {
	return r === 'vscode' ? vscode : r === '@isopodlabs/vscode_utils/webview' ? {Panel: class {}, Assets: class {}} : r === './extension' || r === './BitmapViewer' ? {} : origLoad.call(this, r, ...a);
};
const { FontDocument, glyphDetail } = require('../out/src/FontViewer.js');
const { ON_CURVE } = require('@isopodlabs/binary_fonts');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

(async () => {
	const file = path.join(os.tmpdir(), `fontdoc-${process.pid}.ttf`);
	fs.copyFileSync('/System/Library/Fonts/Supplemental/Georgia.ttf', file);
	const doc = new FontDocument(vscode.Uri.file(file));
	await doc.load();
	check(doc.editable, 'a TTF is editable');
	const events = [], changes = [];
	doc.edited.event(e => events.push(e));
	doc.onDidChange(c => changes.push(c));

	const font = doc.fonts[0], id = font.getGlyphMapping()['E'.codePointAt(0)];
	// (the points as the page has them: y down)
	const original = font.getGlyph(id).curve.map(v => ({x: v.x, y: -v.y, flags: v.flags}));
	const moved = original.map(v => ({...v}));
	moved[1].x += 50;
	doc.edit(id, moved, 'Move point');
	check(events.length === 1 && events[0].label === 'Move point', 'edit fired an edit event');
	check(font.getGlyph(id).curve[1].x === original[1].x + 50, 'the font has the edit');

	events[0].undo();
	check(font.getGlyph(id).curve[1].x === original[1].x, 'undo restored the point');
	check(changes.at(-1).kind === 'glyph' && changes.at(-1).id === id, 'undo told the views');
	events[0].redo();
	check(font.getGlyph(id).curve[1].x === original[1].x + 50, 'redo redid it');

	await doc.write(vscode.Uri.file(file));
	check(fs.readFileSync(file).length > 0, 'saved');
	await doc.reloadIfChanged();
	check(!changes.some(c => c.kind === 'reload'), 'its own save is not reloaded');

	const again = new FontDocument(vscode.Uri.file(file));
	await again.load();
	check(again.fonts[0].getGlyph(id).curve[1].x === original[1].x + 50, 'the saved file has the edit');

	// undo all the way restores the exact bytes, hinting included
	events[0].undo();
	const fresh = new FontDocument(vscode.Uri.file('/System/Library/Fonts/Supplemental/Georgia.ttf'));
	await fresh.load();
	check(Buffer.compare(Buffer.from(font.glyphdata[id]), Buffer.from(fresh.fonts[0].glyphdata[id])) === 0, 'undo restored the original glyph bytes');

	let threw = false;
	try { doc.edit(id, [{x: 1, y: 2, flags: ON_CURVE}], 'bad'); } catch { threw = true; }
	check(threw, 'a glyph that does not begin with a begin point is refused');

	const ttc = new FontDocument(vscode.Uri.file('/System/Library/Fonts/Helvetica.ttc'));
	await ttc.load();
	check(!ttc.editable, 'a collection is not editable');

	// a composite is decomposed by writing its outline, as the page's Decompose does
	const comp = font.getGlyphMapping()['\u00e9'.codePointAt(0)];
	const detail = glyphDetail(font, comp);
	check(detail.components.length >= 2 && detail.points.length > 30, `é is a composite of ${detail.components}`);
	events.length = 0;
	doc.edit(comp, detail.points, 'Decompose glyph');
	check(glyphDetail(font, comp).components.length === 0 && glyphDetail(font, comp).points.length === detail.points.length, 'decomposed: simple, same number of points');
	// the components were put where they belong: what they make fills the box the composite says it has
	const xs = detail.points.map(p => p.x), ys = detail.points.map(p => -p.y);
	const stored = font.getGlyph(comp);
	check(Math.min(...xs) === stored.min.x && Math.max(...xs) === stored.max.x && Math.min(...ys) === stored.min.y && Math.max(...ys) === stored.max.y, `the composite's components are where its box says (${Math.min(...xs)}..${Math.max(...xs)}, ${Math.min(...ys)}..${Math.max(...ys)})`);
	events[0].undo();
	check(glyphDetail(font, comp).components.length >= 2, 'undo brought the composite back');

	// CFF fonts are converted, which undo and redo swap in and out
	const otf = new FontDocument(vscode.Uri.file('/Users/adrianstephens/Library/Fonts/HouseOfTheDragonColor-rge8L.otf'));
	await otf.load();
	check(!otf.editable && otf.convertible, 'a CFF font is convertible, not editable');
	const oe = [];
	otf.edited.event(e => oe.push(e));
	await otf.convert();
	check(otf.editable && !otf.convertible && !!otf.fonts[0].glyphdata, 'converted');
	oe[0].undo();
	check(!otf.editable && otf.convertible && !otf.fonts[0].glyphdata, 'undo gave the CFF font back');
	oe[0].redo();
	check(otf.editable && !!otf.fonts[0].glyphdata, 'redo converted again');

	// edits are not read over by a change of the file on disk, until they are saved
	check(doc.dirty, 'an edited document is dirty');
	const sizeNow = fs.statSync(file).size;
	fs.writeFileSync(file, fs.readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf'));
	changes.length = 0;
	await doc.reloadIfChanged();
	check(!changes.some(c => c.kind === 'reload') && doc.fonts[0] === font, 'a change on disk did not replace the edits');
	await doc.write(vscode.Uri.file(file));
	check(!doc.dirty, 'saving clears it');
	fs.writeFileSync(file, fs.readFileSync('/System/Library/Fonts/Supplemental/Georgia.ttf'));
	await doc.reloadIfChanged();
	check(changes.some(c => c.kind === 'reload'), 'a clean document does follow the file');
	const restored = new FontDocument(vscode.Uri.file(file));
	await restored.load(doc.bytes());
	check(restored.dirty && restored.editable, 'a document restored from a backup is dirty, and editable');

	// saved as WOFF, and opened (and edited) as that
	const woffFile = file.replace(/\.ttf$/, '.woff');
	await doc.write(vscode.Uri.file(woffFile));
	check(fs.readFileSync(woffFile).subarray(0, 4).toString() === 'wOFF', 'a .woff name is written as WOFF');
	const w = new FontDocument(vscode.Uri.file(woffFile));
	await w.load();
	check(w.editable && w.fonts[0].getGlyph(id).curve.length === font.getGlyph(id).curve.length, 'the WOFF opens, editable, with the same glyph');
	w.edit(id, glyphDetail(w.fonts[0], id).points, 'noop');
	await w.write(vscode.Uri.file(woffFile));
	check(fs.readFileSync(woffFile).subarray(0, 4).toString() === 'wOFF', 'and is saved as WOFF again');
	fs.unlinkSync(woffFile);
	const woff2File = file.replace(/\.ttf$/, '.woff2');
	await doc.write(vscode.Uri.file(woff2File));
	check(fs.readFileSync(woff2File).subarray(0, 4).toString() === 'wOF2', 'a .woff2 name is written as WOFF2');
	const w2 = new FontDocument(vscode.Uri.file(woff2File));
	await w2.load();
	check(w2.editable && w2.fonts[0].getGlyph(id)?.curve?.length > 0, 'a WOFF2 opens editable, with its glyphs');
	w2.edit(id, glyphDetail(w2.fonts[0], id).points, 'noop');
	await w2.write(vscode.Uri.file(woff2File));
	check(fs.readFileSync(woff2File).subarray(0, 4).toString() === 'wOF2', 'and is saved as WOFF2 again');
	fs.unlinkSync(woff2File);

	await doc.revert();
	check(changes.at(-1).kind === 'reload', 'revert reloads');
	fs.unlinkSync(file);
	console.log(bad ? `${bad} failed` : 'font document ok');
	process.exit(bad ? 1 : 0);
})();
