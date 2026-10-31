import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const Module = require('module');

// FontDocument's steps (a nudge held down, sent by the page as edits that continue the one before): over a copy of a font, with the
// parts of the vscode API it uses stood in for. Steps in a row are one edit, which undoes to before the first and redoes to the last;
// a step that arrives after an undo is dropped (the page has been shown the glyph again); and one after an edit made elsewhere (a
// glyph's bitmap) is an edit of its own. (npx tsc -b first, then: TS_NODE_TRANSPILE_ONLY=1 node -r <packages>/node_modules/ts-node/register test/fonthistory.ts)

class EventEmitter<T> {
	private listeners: ((e: T) => void)[] = [];
	event = (f: (e: T) => void) => { this.listeners.push(f); return {dispose() {}}; };
	fire(e: T) { this.listeners.forEach(f => f(e)); }
	dispose() {}
}
const vscode = {EventEmitter, workspace: {fs: {readFile: async (u: {fsPath: string}) => new Uint8Array(fs.readFileSync(u.fsPath))}}, Uri: {file: (p: string) => ({fsPath: p, toString: () => p})}};
const origLoad = Module._load;
Module._load = function (r: string, ...a: unknown[]) {
	return r === 'vscode' ? vscode : r === '@isopodlabs/vscode_utils/webview' ? {Panel: class {}, Assets: class {}} : r === './extension' || r === './BitmapViewer' ? {} : origLoad.call(this, r, ...a);
};
const { FontDocument } = require('../out/src/FontViewer.js');

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const file = path.join(os.tmpdir(), `fonthistory-${process.pid}.ttf`);
	fs.copyFileSync('/System/Library/Fonts/Supplemental/Georgia.ttf', file);
	const doc = new FontDocument(vscode.Uri.file(file));
	await doc.load();
	const events: {label: string, undo(): void, redo(): void}[] = [];
	doc.edited.event((e: any) => events.push(e));

	const font = doc.fonts[0], id = font.getGlyphMapping()['E'.codePointAt(0)!];
	// the outline as the page has it (y down), with its second point moved right by dx
	const x0 = font.getGlyph(id).curve[1].x;
	const page = (dx: number) => font.getGlyph(id).curve.map((v: any, i: number) => ({x: v.x + (i === 1 ? dx : 0), y: -v.y, flags: v.flags}));
	const at = () => font.getGlyph(id).curve[1].x - x0;

	// three nudges of one unit, the last two continuing the first
	doc.edit(id, page(1), 'Move point');
	doc.edit(id, page(1), 'Move point', true);
	doc.edit(id, page(1), 'Move point', true);
	check(events.length === 1 && at() === 3, `three nudges are one edit, and the point is moved by all of them (${events.length} edits, moved ${at()})`);
	events[0].undo();
	check(at() === 0, `undone, it is where it was before the first (${at()})`);
	events[0].redo();
	check(at() === 3, `redone, where it was after the last (${at()})`);

	// after an undo, a step on its way is dropped
	events[0].undo();
	doc.edit(id, page(1), 'Move point', true);
	check(events.length === 1 && at() === 0, `a step after an undo is dropped (${events.length} edits, moved ${at()})`);

	// another nudge is another edit; a step after a glyph's bitmap was changed elsewhere is an edit of its own
	doc.edit(id, page(1), 'Move point');
	check(events.length === 2 && at() === 1, `a new nudge is a new edit (${events.length} edits)`);
	(doc as any).latest = undefined;		// (as an edit of a bitmap, from the bitmap editor, leaves it)
	doc.edit(id, page(1), 'Move point', true);
	check(events.length === 3 && at() === 2, `a step after an edit made elsewhere is kept as an edit (${events.length} edits, moved ${at()})`);

	// steps of the outline do not continue an edit of the glyph's SVG drawing, or of another glyph
	const other = font.getGlyphMapping()['F'.codePointAt(0)!];
	const before = events.length;
	doc.edit(other, font.getGlyph(other).curve.map((v: any) => ({x: v.x, y: -v.y, flags: v.flags})), 'Move point', true);
	check(events.length === before + 1, 'a step of another glyph is an edit of its own');

	fs.unlinkSync(file);
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exitCode = bad ? 1 : 0;
})();
