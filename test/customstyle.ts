// A style taken from any picture (AdaIN) in the bitmap viewer's page, in headless Chrome on the real GPU (npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/customstyle.ts). The networks are the PyTorch checkpoints in binary_ml's assistant/models;
// the picture the user would copy is put on the clipboard here: bold stripes of red and blue. Taken as a style it is an item of its own, which
// shows the picture in its colours while pointed at, more finely at a smaller scale, and is applied as one edit; a layer copied can be taken
// as one too.
const path = require('path');
const {openPage, pause, serveFile} = require('./pagehost');
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const models = path.join(__dirname, '../../../packages/binary_ml/assistant/models');
const files: Record<string, string> = {'adain-vgg': 'vgg_normalised.pth', 'adain-decoder': 'decoder.pth'};

(async () => {
	const edits: string[] = [], waiting = new Map<number, (r: any) => void>(), problems: string[] = [];
	let ready: () => void;
	const readyP = new Promise<void>(r => ready = r);
	for (const [name, file] of Object.entries(files))
		serveFile(`/${name}`, path.join(models, file));
	const view = await openPage({
		script: 'bitmap.js', width: 700, height: 500, bitmap: true, programs: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) problems.push(m); },
		host: (m: any) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
			// (too big to cross as a message: fetched by the page, and handed to it as the extension's answer)
			else if (m.command === 'model') view.page.evaluate(`fetch('/${m.name}').then(r => r.arrayBuffer()).then(result => window.postMessage({resultId: ${m.requestId}, result}, '*'))`);
			else if (m.command === 'error') problems.push(m.message);
		},
	});
	await readyP;
	const {page, send, browser, shot} = view;
	await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
	await page.bringToFront();
	// the custom styles' items, and the one taken last
	const customs = async () => (await items.ids(page, ['filters', 'style'])).filter(id => id.startsWith('custom:'));
	const taken = async () => {
		const before = await customs();
		await items.choose(page, ['filters', 'style', 'addStyle']);
		await waitFor(async () => (await customs()).length > before.length, 50);
		return (await customs()).find(id => !before.includes(id));
	};
	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return new Uint8ClampedArray((await got).data);
	};
	// the picture as it is shown (a preview is drawn over it by the GPU, and its pixels are as they were until it is made an edit)
	const shownPixels = async (w: number, h: number) => {
		const s = await shot(), k = Math.min(700 / w, 500 / h, 16), out = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				out.set(s.at(Math.round((700 - w * k) / 2 + (x + 0.5) * k), Math.round((500 - h * k) / 2 + (y + 0.5) * k)), (y * w + x) * 4);
		return out;
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
	const original = await shownPixels(w, h);
	check((await raw()).every((v, i) => v === pic[i]), 'the picture is as it was loaded');

	// diagonal stripes, red and blue, 12 pixels wide, copied elsewhere
	await page.evaluate(`(async () => {
		const c = new OffscreenCanvas(160, 160), g = c.getContext('2d');
		for (let y = 0; y < 160; y++)
			for (let x = 0; x < 160; x++) {
				g.fillStyle = Math.floor((x + y) / 12) % 2 === 0 ? 'rgb(220,30,30)' : 'rgb(40,30,220)';
				g.fillRect(x, y, 1, 1);
			}
		await navigator.clipboard.write([new ClipboardItem({'image/png': await c.convertToBlob({type: 'image/png'})})]);
	})()` as any);

	// taken from the clipboard, it is an item of its own
	const id = await taken();
	check(!!id, `a style taken from the clipboard is an item of the styles (${id})`);
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
	await items.hover(page, ['filters', 'style', id!], true);
	let shown = original;
	await waitFor(async () => { shown = await shownPixels(w, h); return mean(shown).some((v, c) => Math.abs(v - mean(original)[c]) > 10); });
	const m0 = mean(original), m1 = mean(shown);
	console.log(`styled in ${Date.now() - t0} ms; mean colour ${m0.map(Math.round)} -> ${m1.map(Math.round)}`);
	check(m1[0] - m1[1] > m0[0] - m0[1] + 10 && m1[2] - m1[1] > m0[2] - m0[1] + 10, 'shown in the style, its colours go towards red and blue');
	check(edits.length === 0, 'shown, it is not an edit');
	await pause(200);
	const seen = await busySeen(), percents = seen.filter(t => t.startsWith('on Styling ')).map(t => parseInt(t.slice(11)));
	check(seen.includes('on Styling') && seen.at(-1)!.startsWith('off'), `while it is made, Styling is shown over the picture, and then taken away (${seen.slice(0, 3).join(', ')} ... ${seen.at(-1)})`);
	check(percents.length >= 3 && percents.every((p, i) => !i || p >= percents[i - 1]) && percents.at(-1)! >= 90, `with how far it has got, as the GPU gets on (${percents.join(' ')})`);

	// the scale: smaller is finer, larger is bolder
	await items.hover(page, ['filters', 'style', id!], false);
	const at = async (n: number) => {
		await items.hover(page, ['filters', 'style', id!, `${n}%`], true);
		let p = original;
		await waitFor(async () => { p = await shownPixels(w, h); return detail(p, w) !== detail(original, w) && mean(p).some((v, c) => Math.abs(v - m0[c]) > 10); });
		await items.hover(page, ['filters', 'style', id!, `${n}%`], false);
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
	await items.choose(page, ['filters', 'style', id!]);
	await waitFor(async () => edits.at(-1) === 'Style');
	check(edits.at(-1) === 'Style', `applied as an edit called Style (${edits.at(-1)})`);
	await send({command: 'undo'});
	await pause(300);
	const back = await raw();
	check(back.every((v, i) => v === pic[i]), 'undone in one');

	// a layer copied (all of it, without a selection) and taken as a style
	const filled = (lw: number, lh: number, f: (x: number, y: number) => number[]) => { const d = new Uint8ClampedArray(lw * lh * 4); for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) d.set(f(x, y), (y * lw + x) * 4); return d; };
	const layer = (name: string, data: Uint8ClampedArray) => ({name, left: 0, top: 0, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data});
	await send({command: 'load2d', image: {data: pic, width: w, height: h}, layers: [
		layer('dots', filled(w, h, (x, y) => (x % 16 < 6 && y % 16 < 6) ? [250, 210, 20, 255] : [20, 20, 60, 255])),
		layer('picture', pic),
	]});
	await pause(700);
	await items.choose(page, ['layer', 'layer-0']);
	await page.evaluate(`document.dispatchEvent(new ClipboardEvent('copy', {bubbles: true, cancelable: true}))` as any);
	await pause(300);
	const second = await taken();
	check(!!second && second !== id, `taken, it is a style of its own (${second})`);

	check(problems.length === 0, `nothing is reported ${problems.join('; ')}`);
	console.log(bad ? `${bad} failed` : 'all ok');
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
