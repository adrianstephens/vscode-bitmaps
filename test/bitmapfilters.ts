// The sharpen and levels filters through the bitmap viewer's page for real, in headless Chrome (pagehost.js): a soft edge sharpened from
// the menu, and undone; levels set from the strip under its icon, shown while pointed at, applied, and undone; and the GPU's sharpen
// against the plain sums on noise.
const fs = require('fs');
const path = require('path');
const {openPage, pause} = require('./pagehost');
import * as reference from './reference';
const {menu, strips} = require('./cascadehost');		// (for the levels' strip itself)
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const W = 700, H = 500;

(async () => {
	const edits: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) { console.log('   page:', m); bad++; } },
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
		},
	});
	await readyP;
	const {page, send, shot} = view;
	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const px = (r: any, x: number, y: number) => Array.from(new Uint8ClampedArray(r.data).subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
	const where = (w: number, h: number) => { const s = Math.min(W / w, H / h, 16); return (x: number, y: number): [number, number] => [(W - w * s) / 2 + x * s, (H - h * s) / 2 + y * s]; };
	const drag = async (a: [number, number], b: [number, number], steps = 6) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, {steps}); await page.mouse.up(); await pause(150); };
	const edge = (w: number, h: number) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4); return d; };

	// a soft edge, a ramp across the middle of the picture
	const ramp = new Uint8ClampedArray(100 * 80 * 4);
	for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
		const v = x < 45 ? 80 : x >= 55 ? 180 : 80 + (x - 45) * 10;
		ramp.set([v, v, v, 255], (y * 100 + x) * 4);
	}
	await send({command: 'load2d', image: {data: ramp, width: 100, height: 80}});
	await pause(500);
	let r = await raw();
	const before = px(r, 44, 40)[0], after = px(r, 55, 40)[0];

	await items.run(page, 'sharpen');
	await pause(500);
	check(edits.at(-1) === 'Sharpen', `sharpen is an edit called Sharpen (${edits.at(-1)})`);
	r = await raw();
	check(px(r, 5, 40)[0] === 80 && px(r, 95, 40)[0] === 180, 'flat areas are as they were');
	check(px(r, 44, 40)[0] < before && px(r, 55, 40)[0] > after, `the ramp's ends overshoot (${before} -> ${px(r, 44, 40)[0]}, ${after} -> ${px(r, 55, 40)[0]})`);
	check(px(r, 44, 40)[3] === 255, 'alpha is kept');
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(px(r, 44, 40)[0] === before, 'undone');

	// levels: the white point brought down with the wheel over its icon in the strip under Levels, applied by clicking Levels
	const grey = new Uint8ClampedArray(100 * 80 * 4);
	for (let i = 0; i < grey.length; i += 4) grey.set([100, 100, 100, 255], i);
	await send({command: 'load2d', image: {data: grey, width: 100, height: 80}});
	await pause(500);
	await page.keyboard.press('Escape');
	await pause(200);
	const out = await strips(page, 350, 250, ['filters', 'levels']);
	check(out.at(-1)?.length === 4, `levels has black, gamma, white and reset (${out.at(-1)})`);
	// (the levels' strip by its place: a slider pointed at brings out a strip of its own after it)
	const levelsStrip = out.length - 1;
	// (moved on to where it is now until it is the one open, as the icons grow about the pointer)
	for (let tries = 0; tries < 4; tries++) {
		const white = await page.$$eval('.cascade:not(.hidden) .cascade-strip.shown', (ss: Element[], i: number) => { const b = ss[i].children[2]; const r = b.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, open: b.classList.contains('open')}; }, levelsStrip);
		if (white.open)
			break;
		await page.mouse.move(white.x, white.y);
		await pause(250);
	}
	for (let i = 0; i < 4; i++) { await page.mouse.wheel({deltaY: 100}); await pause(100); }
	const lev = await page.$$eval('.cascade:not(.hidden) .cascade-strip.shown', (ss: Element[], i: number) => ss[i].children[2].textContent, levelsStrip);
	check(lev !== '255', `the white point moved (${lev})`);
	// (the GPU draws it over the picture, whose pixels are as they were until it is made an edit)
	r = await raw();
	check(px(r, 50, 40)[0] === 100, `the pixels are as they were while it is pointed at (${px(r, 50, 40)[0]})`);
	const seen = (await shot()).at(Math.round((W - 100 * 7) / 2 + 50 * 7 + 3), Math.round((H - 80 * 7) / 2 + 40 * 7 + 3));
	check(seen[0] > 100, `it is shown while pointed at (${seen})`);
	const lv = await page.$eval('.cascade:not(.hidden) .cascade-strip.shown [data-id="levels"]', (e: Element) => { const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; });
	await page.mouse.click(lv.x, lv.y);
	await pause(500);
	check(edits.at(-1) === 'Levels', `levels is an edit called Levels (${edits.at(-1)})`);
	r = await raw();
	check(px(r, 50, 40)[0] > 100 && px(r, 50, 40)[3] === 255, `it brightened the grey (${px(r, 50, 40)})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(px(r, 50, 40)[0] === 100, 'undone');

	// the GPU's against the plain sums (test/reference.ts), on noise
	await page.keyboard.press('Escape');
	await pause(200);
	const w = 90, h = 70, noise = new Uint8ClampedArray(w * h * 4);
	let seed = 7;
	for (let i = 0; i < noise.length; i++) noise[i] = i % 4 === 3 ? 255 : ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
	await send({command: 'load2d', image: {data: noise, width: w, height: h}});
	await pause(500);
	await items.run(page, 'sharpen');
	await pause(500);
	r = await raw();
	// (the plain sums, test/reference.ts, with the viewer's kernels)
	const kernels: Record<string, reference.Kernel> = await page.evaluate(async () => {
		const R = await import('/out/webview/raster.js' as string);
		return {boxBlur: R.boxKernel(3), emboss: R.embossKernel, edges: R.edgeKernel};
	});
	const cpu = async (filter: string) => {
		const image = {data: noise, width: w, height: h};
		return Array.from(filter === 'sharpen' ? reference.unsharp(image, reference.blurPixels(image, 2), 1) : reference.convolve(image, kernels[filter]));
	};
	const want = await cpu('sharpen');
	let worst = 0;
	for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(want[i] - new Uint8ClampedArray(r.data)[i]));
	check(worst <= 3, `the GPU sharpen matches the plain sum (largest difference ${worst})`);
	await send({command: 'undo'});
	await pause(300);

	// the convolutions, the GPU's against the plain sums (test/reference.ts), on the noise
	await page.keyboard.press('Escape');
	await pause(200);
	for (const id of ['boxBlur', 'emboss', 'edges']) {
		await send({command: 'load2d', image: {data: noise, width: w, height: h}});
		await pause(500);
		await items.run(page, id);
		await pause(500);
		r = await raw();
		const expect = await cpu(id);
		let off = 0;
		for (let i = 0; i < expect.length; i++) off = Math.max(off, Math.abs(expect[i] - new Uint8ClampedArray(r.data)[i]));
		check(off <= 2, `the GPU ${id} matches the plain sum (largest difference ${off})`);
		await send({command: 'undo'});
		await pause(300);
		await page.keyboard.press('Escape');
		await pause(200);
	}

	console.log(bad ? `${bad} problems` : 'sharpen and levels ok');
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
