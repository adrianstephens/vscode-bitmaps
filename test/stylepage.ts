// Styles, Flatten in the bitmap viewer's page, in headless Chrome on the real GPU (npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/stylepage.ts): each is shown while pointed at, at the strength the settings have, taken
// away when the pointer leaves, and applied (as one edit, undone in one) by choosing it. A style is made by the network once, and
// other strengths are only mixed.
const fs = require('fs');
const path = require('path');
const {openPage, pause} = require('./pagehost');
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const models = path.join(__dirname, '../../../packages/binary_ml/assistant/models');
const W = 700, H = 500;

(async () => {
	const edits: string[] = [], waiting = new Map<number, (r: any) => void>(), problems: string[] = [];
	let ready: () => void, runs = 0;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) problems.push(m); },
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
			else if (m.command === 'model') { runs++; reply(new Uint8Array(fs.readFileSync(path.join(models, `${m.name.slice(6)}-9.onnx`)))); }
			else if (m.command === 'error') problems.push(m.message);
		},
	});
	await readyP;
	const {page, send} = view;
	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return new Uint8ClampedArray((await got).data);
	};
	const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]); return s / (a.length / 4 * 3); };

	const w = 96, h = 64, pic = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			pic.set([128 + 100 * Math.sin(x / 9), 128 + 100 * Math.cos(y / 7), 90 + 5 * ((x * 7 + y * 13) % 7), 255], (y * w + x) * 4);
	await send({command: 'load2d', image: {data: pic, width: w, height: h}});
	await pause(500);
	await page.keyboard.press('Escape');
	const original = await raw();
	const waitFor = async (what: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await what()); i++) await pause(100); };

	// a style shown while pointed at, and gone when the pointer is
	await items.hover(page, ['filters', 'style', 'style:candy'], true);
	await waitFor(async () => diff(await raw(), original) > 5);
	const full = await raw();
	check(diff(full, original) > 20, `a style is shown while it is pointed at (${diff(full, original).toFixed(1)} from the picture)`);
	check(edits.length === 0, 'and is no edit');
	const fetched = runs;

	// at half strength: mixed from what the network made, not made again
	await items.turn(page, ['filters', 'style', 'style:candy'], -10);
	await pause(300);
	const half = await raw();
	check(diff(half, original) > 2 && diff(half, original) < diff(full, original) - 5, `a lower strength is nearer the picture (${diff(half, original).toFixed(1)}, against ${diff(full, original).toFixed(1)})`);
	check(runs === fetched, 'and the network is not fetched or run again for it');

	await items.hover(page, ['filters', 'style', 'style:candy'], false);
	await pause(300);
	check(diff(await raw(), original) === 0, 'the picture is as it was once the pointer leaves');

	// chosen: one edit, which one undo takes back
	await items.choose(page, ['filters', 'style', 'style:candy']);
	await waitFor(async () => edits.at(-1) === 'Style');
	const applied = await raw();
	check(edits.at(-1) === 'Style' && diff(applied, original) > 2 && diff(applied, original) < diff(full, original) - 5, `chosen it is an edit called Style, at the strength set (${diff(applied, original).toFixed(1)})`);
	await send({command: 'undo'});
	await pause(300);
	check(diff(await raw(), original) === 0, 'undone in one');

	// chosen with the pointer going from the item at once (as it does when the menu closes), before the network has made anything: still applied
	const before = edits.length;
	await items.hover(page, ['filters', 'style', 'style:udnie'], true);
	await items.choose(page, ['filters', 'style', 'style:udnie']);
	await items.hover(page, ['filters', 'style', 'style:udnie'], false);
	await waitFor(async () => edits.length > before);
	check(edits.length === before + 1 && edits.at(-1) === 'Style' && diff(await raw(), original) > 5, 'a style chosen as the pointer leaves is still applied, once');
	await pause(1500);
	check(edits.length === before + 1, 'and nothing else is made after it');
	await send({command: 'undo'});
	await pause(300);
	check(diff(await raw(), original) === 0, 'undone in one');

	// Flatten shown at the colours of the item pointed at, and applied
	const colours = (d: Uint8ClampedArray) => new Set(Array.from({length: d.length / 4}, (_, i) => d[i * 4] << 16 | d[i * 4 + 1] << 8 | d[i * 4 + 2])).size;
	await items.hover(page, ['filters', 'flatten'], true);
	await waitFor(async () => colours(await raw()) < 100);
	const flat = await raw();
	check(colours(flat) <= 8 && colours(flat) >= 3, `Flatten is shown while pointed at, in ${colours(flat)} colours`);
	check(diff(flat, original) < 60 && diff(flat, original) > 0, `and is still the picture (${diff(flat, original).toFixed(1)} from it)`);
	await items.hover(page, ['filters', 'flatten'], false);
	await pause(300);
	check(diff(await raw(), original) === 0, 'and taken away');
	await items.choose(page, ['filters', 'flatten']);
	await waitFor(async () => edits.at(-1) === 'Flatten');
	check(edits.at(-1) === 'Flatten' && colours(await raw()) <= 8, 'chosen it is an edit called Flatten');
	await send({command: 'undo'});
	await pause(300);

	// gradient regions: a noisy ramp with a hard-edged square on it comes back as the clean ramp and the square, a plane each
	const gw = 120, gh = 90, clean = new Uint8ClampedArray(gw * gh * 4), noisy = new Uint8ClampedArray(gw * gh * 4);
	let seed = 7;
	const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
	for (let y = 0; y < gh; y++)
		for (let x = 0; x < gw; x++) {
			const inSquare = x >= 50 && x < 90 && y >= 30 && y < 70, c = inSquare ? [30, 40, 200 - y] : [40 + x, 120 + y / 2, 90];
			clean.set([...c, 255], (y * gw + x) * 4);
			noisy.set([...c.map(v => v + rand() * 12), 255], (y * gw + x) * 4);
		}
	await send({command: 'load2d', image: {data: noisy, width: gw, height: gh}});
	await pause(500);
	await page.keyboard.press('Escape');
	const was = edits.length;
	await items.choose(page, ['filters', 'gradients']);
	await waitFor(async () => edits.length > was);
	const graded = await raw();
	check(edits.at(-1) === 'Gradients', `gradient regions is an edit called Gradients (${edits.at(-1)})`);
	check(diff(graded, clean) < 3 && diff(noisy as any, clean) > 2.5, `the noise is gone and the ramp stays (off the clean picture by ${diff(graded, clean).toFixed(2)}, from ${diff(noisy, clean).toFixed(2)})`);
	const at = (x: number, y: number) => Array.from(graded.subarray((y * gw + x) * 4, (y * gw + x) * 4 + 3));
	check(Math.abs(at(52, 50)[2] - 150) < 8 && Math.abs(at(48, 50)[2] - 90) < 8 && Math.abs(at(88, 50)[2] - 150) < 8 && Math.abs(at(92, 50)[2] - 90) < 8, `the square's edges are where they were (${at(48, 50)[2]}, ${at(52, 50)[2]}, ${at(88, 50)[2]}, ${at(92, 50)[2]} in blue)`);
	await send({command: 'undo'});
	await pause(300);

	// ink lines: a thin dark line and the edge of a dark block are drawn, a soft ramp and a flat white are not, and the transparency stays
	const iw = 120, ih = 60, art = new Uint8ClampedArray(iw * ih * 4);
	for (let y = 0; y < ih; y++)
		for (let x = 0; x < iw; x++) {
			const v = x >= 20 && x < 22 ? 40 : x >= 70 ? 60 + (x - 70) * 3 : x >= 40 && x < 55 && y > 30 ? 30 : 235;
			art.set([v, v, v, x >= 100 ? 120 : 255], (y * iw + x) * 4);
		}
	await send({command: 'load2d', image: {data: art, width: iw, height: ih}});
	await pause(500);
	await page.keyboard.press('Escape');
	const seen = edits.length;
	await items.choose(page, ['filters', 'ink']);
	await waitFor(async () => edits.length > seen);
	const inked = await raw(), grey = (x: number, y: number) => inked[(y * iw + x) * 4];
	check(edits.at(-1) === 'Ink', `ink is an edit called Ink (${edits.at(-1)})`);
	check(grey(20, 10) < 120 && grey(21, 10) < 120 && grey(5, 10) > 245 && grey(30, 10) > 245, `a thin dark line is inked, the white round it is not (${grey(20, 10)}, ${grey(21, 10)}, ${grey(5, 10)})`);
	check(grey(48, 45) > 245 && Math.min(grey(39, 45), grey(40, 45), grey(41, 45)) < 150 && grey(85, 10) > 245, `the edge of a dark block is inked and its inside is not, and nor is a soft ramp (${grey(48, 45)}, ${grey(40, 45)}, ${grey(85, 10)})`);
	check(inked[(10 * iw + 110) * 4 + 3] === 120 && inked[(10 * iw + 10) * 4 + 3] === 255, 'and the transparency is the picture\'s own');
	await send({command: 'undo'});
	await pause(300);

	console.log(problems);
	check(!problems.length, 'nothing is reported');
	await view.close();
	process.exit(bad ? 1 : 0);
})();
