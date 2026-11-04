// FontModel on its own (npx tsc -b first, then npx ts-node -T test/fontmodel.ts): what the extension's FontDocument and a web page's host are
// both built on, with nothing of VS Code. A glyph is edited, undone and redone, steps of one edit are merged, and the bytes are read back.
const { FontModel, glyphDetail } = require('../out/src/fontmodel.js');
const { load } = require('@isopodlabs/binary_fonts');
import * as fs from 'fs';

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

class Model extends FontModel {
	steps: any[] = [];
	changes: any[] = [];
	protected onEdit(step: any) { this.steps.push(step); }
	protected onChange(change: any) { this.changes.push(change); }
}

(async () => {
	const file = '/System/Library/Fonts/Supplemental/Georgia.ttf';
	const model = new Model('Georgia.ttf');
	await model.open(new Uint8Array(fs.readFileSync(file)));
	check(model.editable && !model.dirty && model.fonts.length === 1, 'a TrueType font opens, editable and clean');
	check(new Model('Georgia.otf').editable === false, 'and what a name does not say is editable is not');

	const id = 36;
	const x0 = () => glyphDetail(model.fonts[0], id).points.map((p: any) => p.x);
	const original = x0();
	const moved = (dx: number) => glyphDetail(model.fonts[0], id).points.map((p: any, i: number) => i === 0 ? {...p, x: p.x + dx} : p);

	model.edit(id, moved(100), 'Move');
	check(model.dirty && model.steps.length === 1 && model.steps[0].label === 'Move', 'an edit is a step, and makes the model dirty');
	check(x0()[0] === original[0] + 100, 'the outline changed');
	check(model.changes.at(-1).kind === 'glyph' && model.changes.at(-1).own === true, 'and was reported as its own change');

	model.edit(id, moved(50), 'Move', true);
	check(model.steps.length === 1 && x0()[0] === original[0] + 150, 'a later step of it is merged, not a step of its own');

	model.steps[0].undo();
	check(x0().join() === original.join(), 'undo goes back to before the first step');
	check(model.changes.at(-1).own === undefined, 'and is not reported as the page\'s own change');
	model.edit(id, moved(10), 'Move', true);
	check(x0().join() === original.join(), 'a step continuing an edit that was undone changes nothing');
	model.steps[0].redo();
	check(x0()[0] === original[0] + 150, 'redo goes to the last step');

	const again = new Model('again.ttf');
	await again.open(model.bytes());
	check(glyphDetail(again.fonts[0], id).points[0].x === original[0] + 150, 'the bytes read back with the edit');

	const woff = await model.encode('x.woff');
	check(woff[0] === 0x77 && woff[1] === 0x4f && woff[2] === 0x46 && woff[3] === 0x46, 'a name that says WOFF is written as WOFF');
	const reread = await load(woff);
	check(!!reread, 'and that reads');

	try { model.edit(60000, [], 'x'); check(false, 'a glyph that is not there is refused'); } catch { /* refused */ }
	console.log(bad ? `${bad} failed` : 'font model ok');
	process.exit(bad ? 1 : 0);
})();
