// The blur filter through the bitmap viewer's page for real, in headless Chrome (pagehost.js): a picture with a hard edge, blurred
// whole from the menu; blurred within a selection (what is outside it is left alone, and so is the selection's edge); and undone.
const fs = require('fs');
const path = require('path');
const {openPage, pause} = require('./pagehost');
import * as reference from './reference';
const {menu} = require('./cascadehost');		// (for choosing a tool)
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
	const {page, send} = view;
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

	// a whole picture: red on the left, blue on the right
	await send({command: 'load2d', image: {data: edge(100, 80), width: 100, height: 80}});
	await pause(500);
	let r = await raw();
	check(px(r, 49, 40).join() === '255,0,0,255' && px(r, 50, 40).join() === '0,0,255,255', 'the edge is hard to begin with');

	await items.run(page, 'blur');
	await pause(400);
	check(edits.at(-1) === 'Blur', `it is an edit called Blur (${edits.at(-1)})`);
	r = await raw();
	const near = px(r, 49, 40), far = px(r, 5, 40), farRight = px(r, 95, 40);
	check(near[0] > 100 && near[0] < 200 && near[2] > 50, `the edge is soft: ${near}`);
	check(far.join() === '255,0,0,255' && farRight.join() === '0,0,255,255', `far from the edge is as it was: ${far} ${farRight}`);
	check(px(r, 0, 0)[3] === 255, 'the picture stays opaque at its own edge');

	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(px(r, 49, 40).join() === '255,0,0,255', 'undone, the edge is hard again');

	// within a selection: the edge outside it is not blurred
	const at = where(100, 80);
	await page.keyboard.press('Escape');		// (an operation leaves the menu out, to be done again)
	await menu(page, 350, 250, ['select', 'marquee']);
	await drag(at(10, 10), at(90, 40));
	await items.run(page, 'blur');
	await pause(400);
	r = await raw();
	check(px(r, 49, 25)[0] > 100 && px(r, 49, 25)[0] < 200, `inside the selection the edge is soft: ${px(r, 49, 25)}`);
	check(px(r, 49, 60).join() === '255,0,0,255' && px(r, 50, 60).join() === '0,0,255,255', `below it the edge is still hard: ${px(r, 49, 60)} ${px(r, 50, 60)}`);

	// the GPU's blur against the plain sum, on noise, whole and within a selection (what the selection covers is blurred the same)
	{
		const w = 90, h = 70, data = new Uint8ClampedArray(w * h * 4);
		let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		for (let i = 0; i < w * h; i++) data.set([rnd() * 255, rnd() * 255, rnd() * 255, 90 + rnd() * 165], i * 4);
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data, width: w, height: h}});
		await pause(500);
		await items.run(page, 'blur');
		await pause(500);
		const got = await raw();
		// (the plain sum, test/reference.ts)
		const want = reference.blurPixels({data, width: w, height: h}, 4);
		const g = new Uint8ClampedArray(got.data);
		let worst = 0, sum = 0;
		for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - want[i]); worst = Math.max(worst, d); sum += d; }
		console.log(`   GPU against the plain sum on noise: largest difference ${worst}, mean ${(sum / g.length).toFixed(3)}`);
		check(worst <= 3, `the GPU blur matches the plain sum (largest difference ${worst})`);
	}

	// a feathered selection, whose blur the GPU does too: what is cleared within it has the coverage the feather gives with the plain sum for its blur
	{
		const w = 100, h = 80, data = new Uint8ClampedArray(w * h * 4).fill(255);
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data, width: w, height: h}});
		await pause(500);
		const at2 = where(w, h);
		await menu(page, 350, 250, ['select', 'marquee']);
		await drag(at2(20, 10), at2(60, 50));
		await items.run(page, 'featherSelection');
		await pause(300);
		await page.keyboard.press('Delete');
		await pause(400);
		const got = await raw();
		let l = w, t = h, r2 = 0, b = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (got.data[(y * w + x) * 4 + 3] === 0) { l = Math.min(l, x); r2 = Math.max(r2, x + 1); t = Math.min(t, y); b = Math.max(b, y + 1); }
		// (the feather made in the page with the plain sum for its blur: its coverage of every pixel)
		const cover: number[] = await page.evaluate(async (w: number, h: number, gaussian: string) => {
			const {float2} = await import('@isopodlabs/maths/vector' as string), {Selection} = await import('/out/webview/bitmapSelection.js' as string);
			const sel = Selection.rect(new float2.extent(float2(20, 10), float2(60, 50))).feather(8, float2(w, h), new Function(`return ${gaussian}`)());
			return Array.from({length: w * h}, (_, i) => sel.at(i % w, Math.floor(i / w)));
		}, w, h, reference.gaussian.toString());
		const at = (x: number, y: number) => cover[y * w + x];
		console.log('   gpu row:', Array.from({length: 24}, (_, i) => 255 - new Uint8ClampedArray(got.data)[(30 * w + 8 + i) * 4 + 3]).join(' '), '\n   sum row:', Array.from({length: 24}, (_, i) => at(8 + i, 30)).join(' '));
		let worst = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) worst = Math.max(worst, Math.abs((255 - new Uint8ClampedArray(got.data)[(y * w + x) * 4 + 3]) - at(x, y)));
		console.log(`   feathered selection, GPU against the plain sum: largest difference in coverage ${worst} (cleared pixels span ${l},${t}-${r2},${b})`);
		check(worst <= 4, `the feather's blur matches the plain sum (largest difference ${worst})`);
	}

	// and the GPU does it fast: a big picture at a big radius
	{
		const w = 2400, h = 3000, data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 256;
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data, width: w, height: h}});
		await pause(1500);
		const t = Date.now();
		await items.run(page, 'blur');
		const r2 = await raw();
		const ms = Date.now() - t;
		console.log(`   2400x3000 blurred at radius 4, and read back: ${ms} ms`);
		const u0 = Date.now();
		await send({command: 'undo'});
		await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
		await page.evaluate(() => { const c = document.getElementById('viewport') as HTMLCanvasElement; const gl = c.getContext('webgl2'); gl?.finish(); });
		console.log(`   undo of that blur: ${Date.now() - u0} ms`);
		check(r2.width === w && ms < 4000, `a big picture is blurred quickly (${ms} ms)`);
	}

		// undo in a picture of big layers: after a flip, and after blurring a layer
	{
		const w = 1200, h = 1500;
		const lay = (name: string, c: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(c, i * 4); return {name, left: 0, top: 0, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: d}; };
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h}, layers: [lay('a', [0, 0, 255, 255]), lay('b', [255, 0, 0, 255]), lay('c', [0, 255, 0, 255])]});
		await pause(3000);
		const timed = async (what: string, run: () => Promise<void>) => {
			const t0 = Date.now();
			await run();
			await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
			await page.evaluate(() => { (document.getElementById('viewport') as HTMLCanvasElement).getContext('webgl2')?.finish(); });
			console.log(`   ${what}: ${Date.now() - t0} ms`);
		};
		await timed('save-style read of the layers (getTexture)', async () => { await raw(); });
		await timed('flip', () => send({command: 'imageOp', op: 'flipHorizontal'}));
		await timed('undo the flip', () => send({command: 'undo'}));
		await timed('blur a layer', async () => { await items.run(page, 'blur'); });
		await timed('undo the blur', () => send({command: 'undo'}));
	}

	console.log(bad ? `${bad} problems` : 'blur filter ok');
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
