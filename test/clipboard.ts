// The clipboard in the bitmap viewer's page, in headless Chrome (pagehost.js): cutting a marquee selection clears it and puts it on the
// clipboard (a PNG); pasting it back makes a layer with it where it was (the picture as it was before), and one undo takes the paste away; a
// picture from elsewhere is pasted in the middle; a paste into a field is the field's; and a picture on the clipboard can be taken as a style.
// The copy, cut and paste events are dispatched as VS Code's Cmd/Ctrl C, X and V make them.
// Run: npx tsc -b, then npx ts-node -T test/clipboard.ts
const {openPage, pause} = require('./pagehost');
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 500;

(async () => {
	const edits: string[] = [];
	let ready: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const waiting = new Map<number, (r: any) => void>();
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail') && !m.includes('GPU stall')) { console.log('   page:', m); bad++; } },
		host: (m: any) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
		},
	});
	await readyP;
	const {page, send, browser} = view;
	await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
	await page.bringToFront();

	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const px = (r: any, x: number, y: number) => Array.from(new Uint8ClampedArray(r.data).subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
	const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
	const where = (w: number, h: number) => { const s = Math.min(W / w, H / h, 16); return (x: number, y: number): [number, number] => [(W - w * s) / 2 + (x + 0.5) * s, (H - h * s) / 2 + (y + 0.5) * s]; };

	// the events, as VS Code makes them: a paste carries what the clipboard has (read by the page), or a picture made for it
	const event = (type: 'copy' | 'cut') => page.evaluate(`document.dispatchEvent(new ClipboardEvent('${type}', {bubbles: true, cancelable: true}))`);
	const pasteClipboard = () => page.evaluate(`(async () => {
		const dt = new DataTransfer();
		let from = 'nothing';
		try {
			for (const item of await navigator.clipboard.read()) {
				const type = item.types.find(t => t.startsWith('image/'));
				if (type) {
					dt.items.add(new File([await item.getType(type)], 'image.png', {type}));
					from = 'the clipboard';
				}
			}
		} catch (e) {
			from = 'nothing (' + e.message + ')';
		}
		document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
		return from;
	})()`);
	const pasteRed = (w: number, h: number, target = 'document') => page.evaluate(`(async () => {
		const c = new OffscreenCanvas(${w}, ${h}), g = c.getContext('2d');
		g.fillStyle = '#ff0000';
		g.fillRect(0, 0, ${w}, ${h});
		const dt = new DataTransfer();
		dt.items.add(new File([await c.convertToBlob({type: 'image/png'})], 'red.png', {type: 'image/png'}));
		const e = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
		${target}.dispatchEvent(e);
		return e.defaultPrevented;
	})()`);

	// a picture whose every pixel is different
	const w = 100, h = 80, data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			data.set([x * 2, y * 3, 100, 255], (y * w + x) * 4);
	await send({command: 'load2d', image: {data, width: w, height: h}});
	await pause(500);
	const at = where(w, h);

	// a marquee from (20, 20) to (40, 30), cut
	await page.keyboard.press('m');
	await page.mouse.move(...at(20, 20));
	await page.mouse.down();
	await page.mouse.move(...at(40, 30), {steps: 5});
	await page.mouse.up();
	await pause(100);
	await event('cut');
	await pause(300);
	let r = await raw();
	check(edits.at(-1) === 'Cut', `a cut is an edit called Cut (${edits.at(-1)})`);
	check(px(r, 30, 25)[3] === 0 && same(px(r, 50, 25), [100, 75, 100, 255]) && same(px(r, 30, 40), [60, 120, 100, 255]),
		`what was selected is cleared and the rest is as it was (${px(r, 30, 25)} ${px(r, 50, 25)} ${px(r, 30, 40)})`);

	// pasted back: a layer, where it was
	const from = await pasteClipboard();
	console.log(`     (pasted from ${from})`);
	await pause(800);
	r = await raw();
	check(edits.at(-1) === 'Paste', `a paste is an edit called Paste (${edits.at(-1)})`);
	check(same(px(r, 30, 25), [60, 75, 100, 255]) && same(px(r, 22, 21), [44, 63, 100, 255]) && same(px(r, 50, 25), [100, 75, 100, 255]),
		`pasted back where it was, the picture is as it was before the cut (${px(r, 30, 25)} ${px(r, 22, 21)} ${px(r, 50, 25)})`);
	const layers = await items.ids(page, ['layer']);
	check(layers.filter(id => /^layer-\d+$/.test(id)).length === 2, `it is a layer over the picture, which is the background now (${layers})`);

	await send({command: 'undo'});
	await pause(500);
	r = await raw();
	check(px(r, 30, 25)[3] === 0, `the paste undone, the cut is there again (${px(r, 30, 25)})`);

	// a picture from elsewhere: in the middle
	await pasteRed(10, 10);
	await pause(800);
	r = await raw();
	check(edits.at(-1) === 'Paste' && same(px(r, 49, 39), [255, 0, 0, 255]) && same(px(r, 45, 35), [255, 0, 0, 255]) && same(px(r, 44, 39), [88, 117, 100, 255]),
		`a picture copied elsewhere is pasted in the middle (${px(r, 45, 35)} ${px(r, 49, 39)} ${px(r, 44, 39)})`);

	// a paste into a field is the field's
	const before = edits.length;
	const taken = await pasteRed(4, 4, `(() => { const i = document.createElement('input'); document.body.append(i); return i; })()`);
	await pause(500);
	check(!taken && edits.length === before, `a paste into a field is the field's (${edits.slice(before)})`);

	// copy (nothing changes), then the clipboard's picture taken as a style
	await items.run(page, 'selectAll');
	await pause(100);
	const selected = edits.length;
	await event('copy');
	await pause(300);
	check(edits.length === selected, `a copy is not an edit (${edits.slice(selected)})`);
	const styles = await items.ids(page, ['filters', 'style']);
	await items.choose(page, ['filters', 'style', 'addStyle']);
	await pause(500);
	const after = await items.ids(page, ['filters', 'style']);
	check(!styles.includes('custom:0') && after.includes('custom:0'), `the clipboard's picture is a style (${after.filter(id => id.startsWith('custom'))})`);

	await view.close();
	console.log(bad ? `${bad} failed` : 'all ok');
	process.exit(bad ? 1 : 0);
})();
