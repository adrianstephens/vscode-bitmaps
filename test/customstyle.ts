// A style taken from any picture (AdaIN) in the bitmap viewer's page, in headless Chrome on the real GPU (npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/customstyle.ts). The networks are the PyTorch checkpoints in binary-ml's assistant/models;
// the picture file the user would choose is made here: bold stripes of red and blue. Taken as a style it is an item of its own, which shows
// the picture in its colours while pointed at, more finely at a smaller scale, and is applied as one edit; a layer can be taken as one too.
const fs = require('fs');
const path = require('path');
const {openPage, pause, serveFile} = require('./pagehost');
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const models = path.join(__dirname, '../../../packages/binary-ml/assistant/models');
const files: Record<string, string> = {'adain-vgg': 'vgg_normalised.pth', 'adain-decoder': 'decoder.pth'};

// a 24-bit BMP of diagonal stripes, red and blue, 12 pixels wide
function stripes(w: number, h: number) {
	const row = Math.ceil(w * 3 / 4) * 4, bmp = Buffer.alloc(54 + row * h);
	bmp.write('BM', 0);
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(w, 18);
	bmp.writeInt32LE(h, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const red = Math.floor((x + y) / 12) % 2 === 0, o = 54 + y * row + x * 3;
			bmp[o] = red ? 30 : 220;		// (blue, green, red)
			bmp[o + 1] = 30;
			bmp[o + 2] = red ? 220 : 40;
		}
	return bmp;
}

(async () => {
	const edits: string[] = [], waiting = new Map<number, (r: any) => void>(), problems: string[] = [];
	let ready: () => void, picked = 0;
	const readyP = new Promise<void>(r => ready = r);
	for (const [name, file] of Object.entries(files))
		serveFile(`/${name}`, path.join(models, file));
	const view = await openPage({
		script: 'bitmap.js', width: 700, height: 500, bitmap: true, programs: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) problems.push(m); },
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
			// (too big to cross as a message: fetched by the page, and handed to it as the extension's answer)
			else if (m.command === 'model') view.page.evaluate(`fetch('/${m.name}').then(r => r.arrayBuffer()).then(result => window.postMessage({resultId: ${m.requestId}, result}, '*'))`);
			else if (m.command === 'pickImage') { picked++; const b = stripes(160, 160); reply({name: 'stripes', data: new Uint8Array(b)}); }	// (the harness carries typed arrays to the page)
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
	const waitFor = async (what: () => Promise<boolean>, tries = 300) => { for (let i = 0; i < tries && !(await what()); i++) await pause(100); };
	// the mean of each channel, and how much it changes from one pixel to the next (how fine its detail is)
	const mean = (p: Uint8ClampedArray) => [0, 1, 2].map(c => { let s = 0; for (let i = c; i < p.length; i += 4) s += p[i]; return s / (p.length / 4); });
	const detail = (p: Uint8ClampedArray, w: number) => { let s = 0, n = 0; for (let i = 4; i < p.length; i += 4) if ((i / 4) % w) { for (let c = 0; c < 3; c++) s += Math.abs(p[i + c] - p[i - 4 + c]); n++; } return s / n; };

	// a soft grey and green picture
	const w = 256, h = 192, pic = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			pic.set([90 + x * 0.3 + 20 * Math.sin(y / 15), 120 + y * 0.3, 90 + 25 * Math.cos(x / 20), 255], (y * w + x) * 4);
	await send({command: 'load2d', image: {data: pic, width: w, height: h}});
	await pause(500);
	await page.keyboard.press('Escape');
	const original = await raw();

	// taken from a file, it is an item of its own
	await items.choose(page, ['filters', 'style', 'addStyle']);
	await waitFor(async () => (await items.ids(page, ['filters', 'style'])).includes('custom:1'), 50);
	check(picked === 1 && (await items.ids(page, ['filters', 'style'])).includes('custom:1'), 'a style taken from a file is an item of the styles');
	check((await items.faces(page, ['filters', 'style'])).some(f => f.includes('<img src="data:image/png')), 'its icon is a small copy of the picture');

	// what the busy indication over the picture says, each time it changes ('on Styling 40%', 'off ...')
	const watchBusy = () => page.evaluate(`window.busySeen = []; new MutationObserver(() => {
		const b = document.getElementById('busy');
		const seen = b && (b.classList.contains('on') ? 'on ' : 'off ') + b.querySelector('.busy-label').textContent;
		if (seen && seen !== window.busySeen[window.busySeen.length - 1])
			window.busySeen.push(seen);
	}).observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true})` as any);
	const busySeen = (): Promise<string[]> => page.evaluate('window.busySeen' as any);

	// pointed at, the picture is shown in it: its colours go towards the stripes' red and blue
	await watchBusy();
	const t0 = Date.now();
	await items.hover(page, ['filters', 'style', 'custom:1'], true);
	let shown = original;
	await waitFor(async () => { shown = await raw(); return mean(shown).some((v, c) => Math.abs(v - mean(original)[c]) > 10); });
	const m0 = mean(original), m1 = mean(shown);
	console.log(`styled in ${Date.now() - t0} ms; mean colour ${m0.map(Math.round)} -> ${m1.map(Math.round)}`);
	check(m1[0] - m1[1] > m0[0] - m0[1] + 10 && m1[2] - m1[1] > m0[2] - m0[1] + 10, 'shown in the style, its colours go towards red and blue');
	check(edits.length === 0, 'shown, it is not an edit');
	await pause(200);
	const seen = await busySeen(), percents = seen.filter(t => t.startsWith('on Styling ')).map(t => parseInt(t.slice(11)));
	check(seen.includes('on Styling') && seen.at(-1)!.startsWith('off'), `while it is made, Styling is shown over the picture, and then taken away (${seen.slice(0, 3).join(', ')} ... ${seen.at(-1)})`);
	check(percents.length >= 3 && percents.every((p, i) => !i || p >= percents[i - 1]) && percents.at(-1)! >= 90, `with how far it has got, as the GPU gets on (${percents.join(' ')})`);

	// the scale: smaller is finer, larger is bolder
	await items.hover(page, ['filters', 'style', 'custom:1'], false);
	const at = async (n: number) => {
		await items.hover(page, ['filters', 'style', 'custom:1', `${n}%`], true);
		let p = original;
		await waitFor(async () => { p = await raw(); return detail(p, w) !== detail(original, w) && mean(p).some((v, c) => Math.abs(v - m0[c]) > 10); });
		await items.hover(page, ['filters', 'style', 'custom:1', `${n}%`], false);
		await pause(200);
		return p;
	};
	const fine = await at(25), bold = await at(200);
	let differ = 0;
	for (let i = 0; i < fine.length; i++)
		differ += Math.abs(fine[i] - bold[i]);
	console.log(`detail at 25%: ${detail(fine, w).toFixed(1)}, at 200%: ${detail(bold, w).toFixed(1)}, the picture's own ${detail(original, w).toFixed(1)}`);
	check(differ / fine.length > 3, `25% and 200% differ (${(differ / fine.length).toFixed(1)} levels)`);
	check(detail(fine, w) > detail(bold, w), 'the smaller scale is the finer');

	// chosen: one edit, undone in one
	await items.choose(page, ['filters', 'style', 'custom:1']);
	await waitFor(async () => edits.at(-1) === 'Style');
	check(edits.at(-1) === 'Style', `applied as an edit called Style (${edits.at(-1)})`);
	await send({command: 'undo'});
	await pause(300);
	const back = await raw();
	check(back.every((v, i) => v === original[i]), 'undone in one');

	// a layer taken as a style
	const filled = (lw: number, lh: number, f: (x: number, y: number) => number[]) => { const d = new Uint8ClampedArray(lw * lh * 4); for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) d.set(f(x, y), (y * lw + x) * 4); return d; };
	const layer = (name: string, data: Uint8ClampedArray) => ({name, left: 0, top: 0, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data});
	await send({command: 'load2d', image: {data: pic, width: w, height: h}, layers: [
		layer('dots', filled(w, h, (x, y) => (x % 16 < 6 && y % 16 < 6) ? [250, 210, 20, 255] : [20, 20, 60, 255])),
		layer('picture', pic),
	]});
	await pause(700);
	const choices = await items.ids(page, ['filters', 'style', 'styleLayer']);
	check(choices.length === 1 && choices[0] === 'styleLayer:0', `the layers other than the current one can be taken (${choices})`);
	await items.choose(page, ['filters', 'style', 'styleLayer', 'styleLayer:0']);
	check((await items.ids(page, ['filters', 'style'])).includes('custom:2'), 'taken, it is a style of its own');

	check(problems.length === 0, `nothing is reported ${problems.join('; ')}`);
	console.log(bad ? `${bad} failed` : 'all ok');
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
