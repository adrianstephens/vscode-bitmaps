// The bitmap of a glyph in an sbix font taken to the bitmap editor and back: FontDocument opens it through the embedded-image file
// system, a save in the editor (a write to that file system) is an edit of the font, undo and redo change what the editor is
// given, and a font whose bitmaps cannot be written is opened read only. The vscode API it uses is stood in for.
//   node test/fontbitmap.js [font.ttc|ttf]      (default: Apple Color Emoji)
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

class EventEmitter {
	constructor() { this.l = []; this.event = f => { this.l.push(f); return {dispose() {}}; }; }
	fire(e) { this.l.forEach(f => f(e)); }
	dispose() {}
}
const opened = [];
const errors = (name) => (uri) => Object.assign(new Error(`${name} ${uri?.path ?? uri}`), {name});
const vscode = {
	EventEmitter, Disposable: class { constructor(f) { this.dispose = f; } },
	FileType: {File: 1}, FileChangeType: {Changed: 1},
	FileSystemError: {FileNotFound: errors('FileNotFound'), NoPermissions: errors('NoPermissions'), Unavailable: errors('Unavailable')},
	Uri: {file: p => ({fsPath: p, path: p, toString: () => p}), from: ({scheme, path}) => ({scheme, path, fsPath: path, toString: () => `${scheme}:${path}`})},
	commands: {executeCommand: async (...a) => { opened.push(a); }},
	workspace: {fs: {readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d)}},
};
const origLoad = Module._load;
Module._load = function (r, ...a) {
	return r === 'vscode' ? vscode : r === '@isopodlabs/vscode_utils/webview' ? {Panel: class {}, Assets: class {}} : r === './extension' || r === './BitmapViewer' ? {} : origLoad.call(this, r, ...a);
};
const { FontDocument } = require('../out/src/FontViewer.js');
const { embedded } = require('../out/src/embedded.js');
const { loadFile, Font, TTF_OTF } = require('@isopodlabs/binary_fonts');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const same = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0;
const throws = f => { try { f(); } catch (e) { return e; } };

(async () => {
	// an sbix font as a .ttf: what a face of a collection is written as
	const source = await loadFile(process.argv[2] ?? '/System/Library/Fonts/Apple Color Emoji.ttc');
	const file = path.join(os.tmpdir(), `fontbitmap-${process.pid}.ttf`);
	fs.writeFileSync(file, TTF_OTF.write(source instanceof Font ? source : source.fonts[0]));
	try {
		const doc = new FontDocument(vscode.Uri.file(file));
		await doc.load();
		const font = doc.fonts[0], ppem = font.bitmapPpem();
		check(doc.bitmapEditable, 'an sbix font in a .ttf has bitmaps that can be edited');
		const id = font.sbix.strikes.find(s => s.ppem === ppem).glyphs.findIndex(g => g.type === 'png ' && g.data.length);
		const original = font.getGlyphImage(id, ppem).data;
		const edits = [];
		doc.edited.event(e => edits.push(e));

		await doc.openBitmap(font, id);
		const uri = opened.at(-1)[1];
		check(opened.at(-1)[0] === 'vscode.openWith' && opened.at(-1)[2] === 'bitmap.viewer' && uri.scheme === 'embedded-image' && uri.path.endsWith('.png'), `it is opened in the bitmap editor: ${JSON.stringify(opened.at(-1))}`);
		check(same(embedded.readFile(uri), original), 'which is given the glyph\'s picture');

		// the editor saves: what it wrote is the glyph's image, as one edit
		const saved = new Uint8Array([...original].reverse());
		embedded.writeFile(uri, saved);
		check(same(font.getGlyphImage(id, ppem).data, saved) && font.getGlyphImage(id, ppem).type === 'png ', 'a save in the editor is the glyph\'s bitmap');
		check(edits.length === 1 && edits[0].label === 'Edit bitmap' && doc.dirty, 'it is an edit of the document');
		const was = font.getGlyphImage(id, ppem);

		edits[0].undo();
		check(same(font.getGlyphImage(id, ppem).data, original), 'undo gives the picture back');
		check(same(embedded.readFile(uri), original), 'and the editor is given it');
		edits[0].redo();
		check(same(embedded.readFile(uri), saved), 'redo gives the editor the saved picture again');
		check(was.originOffset.x === font.getGlyphImage(id, ppem).originOffset.x, 'the picture stays where it was');

		// the font as written has the bitmap
		const bytes = doc.bytes();
		const again = (await require('@isopodlabs/binary_fonts').load(bytes));
		check(same(again.getGlyphImage(id, ppem).data, saved), 'a font written and read again has it');

		// a font whose bitmaps cannot be written is opened to look at
		doc.bitmapEditable = false;
		await doc.openBitmap(font, id);
		const ro = opened.at(-1)[1];
		const e = throws(() => embedded.writeFile(ro, saved));
		check(e?.name === 'Unavailable', `saving it is refused: ${e?.message}`);

		check(throws(() => embedded.readFile(uri))?.name === 'FileNotFound', 'opening the glyph again replaces its image');
		check(embedded.readFile(ro).length > 0, 'the read only one is there to look at');
		doc.dispose();
		check(throws(() => embedded.readFile(ro))?.name === 'FileNotFound', 'closing the document takes its images away');
	} finally {
		fs.rmSync(file, {force: true});
	}
	console.log(bad ? `${bad} FAILED` : 'font bitmaps ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
