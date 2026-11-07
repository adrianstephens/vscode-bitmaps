// A filter of one pass (emboss, levels...) shown by the GPU while it is pointed at, through the bitmap viewer's page in headless Chrome
// (pagehost.js): the pixels stay as they were while it is shown, it is taken away by moving off, and once made an edit the pixels are
// what was shown. Within a selection, only the selection is shown filtered.
// Run: npx tsc -b, then TS_NODE_TRANSPILE_ONLY=1 npx ts-node test/shadepreview.ts
const {openPage, pause} = require('./pagehost');
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
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail') && !m.includes('GPU stall')) { console.log('   page:', m); bad++; } },
		host: (m: any) => {
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
	const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
	const w = 90, h = 70, s = Math.min(W / w, H / h, 16);
	const at = (x: number, y: number): [number, number] => [Math.round((W - w * s) / 2 + (x + 0.5) * s), Math.round((H - h * s) / 2 + (y + 0.5) * s)];
	const noise = new Uint8ClampedArray(w * h * 4);
	let seed = 7;
	for (let i = 0; i < noise.length; i++) noise[i] = i % 4 === 3 ? 255 : ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
	const spots: [number, number][] = [[10, 10], [30, 20], [60, 30], [75, 55], [20, 60]];
	const load = async () => { await send({command: 'load2d', image: {data: noise, width: w, height: h}}); await pause(500); };
	const far = (a: number[], b: number[]) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));

	// shown while pointed at, the pixels as they were, taken away by moving off
	await load();
	const plain = await shot();
	await items.hover(page, ['filters', 'emboss'], true);
	await pause(200); await frames();
	const shown = await shot();
	check(spots.some(p => far(shown.at(...at(...p)), plain.at(...at(...p))) > 20), 'the emboss is shown while pointed at');
	let r = await raw();
	check(spots.every(p => far(px(r, ...p), px({data: noise, width: w}, ...p)) === 0), 'the pixels are as they were while it is shown');
	await items.hover(page, ['filters', 'emboss'], false);
	await pause(200); await frames();
	const gone = await shot();
	check(spots.every(p => far(gone.at(...at(...p)), plain.at(...at(...p))) <= 2), 'and it is taken away on moving off');

	// made an edit: the pixels are what was shown
	await items.hover(page, ['filters', 'emboss'], true);
	await pause(200); await frames();
	const again = await shot();
	await items.run(page, 'emboss');
	await pause(400);
	check(edits.at(-1) === 'Emboss', `it is an edit called Emboss (${edits.at(-1)})`);
	r = await raw();
	check(spots.every(p => far(px(r, ...p), again.at(...at(...p))) <= 3), `the pixels are what was shown (${spots.map(p => far(px(r, ...p), again.at(...at(...p))))})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(spots.every(p => far(px(r, ...p), px({data: noise, width: w}, ...p)) === 0), 'undone');

	// in a selection, only it is shown filtered
	await page.keyboard.press('Escape');
	await load();
	await page.keyboard.press('m');
	await page.keyboard.press('m');
	await page.keyboard.press('m');
	await page.mouse.move(...at(0, 0));
	await page.mouse.down();
	await page.mouse.move(...at(44, 69), {steps: 6});
	await page.mouse.up();
	await pause(200);
	await items.hover(page, ['filters', 'edges'], true);
	await pause(200); await frames();
	const part = await shot();
	check(far(part.at(...at(70, 30)), plain.at(...at(70, 30))) <= 2 && far(part.at(...at(60, 60)), plain.at(...at(60, 60))) <= 2, 'outside the selection is as it was');
	check([[10, 10], [30, 20], [20, 60]].some(p => far(part.at(...at(...p)), plain.at(...at(...p))) > 20), 'inside it is filtered');
	await items.run(page, 'edges');
	await pause(400);
	r = await raw();
	check(far(px(r, 70, 30), px({data: noise, width: w}, 70, 30)) === 0 && far(px(r, 60, 60), px({data: noise, width: w}, 60, 60)) === 0, 'and so are the pixels');
	check([[10, 10], [30, 20], [20, 60]].every(p => far(px(r, ...p), part.at(...at(...p))) <= 3), 'inside, as it was shown');

	// the filters of more than one pass (blur, sharpen) are shown the same way, and made what was shown
	for (const [id, label] of [['blur', 'Blur'], ['sharpen', 'Sharpen'], ['boxBlur', 'Box Blur']]) {
		await page.keyboard.press('Escape');
		await load();
		await items.hover(page, ['filters', id], true);
		await pause(200); await frames();
		const sh = await shot();
		check(spots.some(p => far(sh.at(...at(...p)), plain.at(...at(...p))) > 10), `${id} is shown while pointed at`);
		r = await raw();
		check(spots.every(p => far(px(r, ...p), px({data: noise, width: w}, ...p)) === 0), `${id}: the pixels are as they were while it is shown`);
		await items.run(page, id);
		await pause(400);
		r = await raw();
		check(spots.every(p => far(px(r, ...p), sh.at(...at(...p))) <= 3), `${id}: the pixels are what was shown (${spots.map(p => far(px(r, ...p), sh.at(...at(...p))))})`);
	}

	// a blur in a selection: outside it is as it was, and the edge of the selection does not bleed
	await page.keyboard.press('Escape');
	await load();
	await page.keyboard.press('m');
	await page.mouse.move(...at(0, 0));
	await page.mouse.down();
	await page.mouse.move(...at(44, 69), {steps: 6});
	await page.mouse.up();
	await pause(200);
	await items.hover(page, ['filters', 'blur'], true);
	await pause(200); await frames();
	const blurred = await shot();
	check(far(blurred.at(...at(70, 30)), plain.at(...at(70, 30))) <= 2 && far(blurred.at(...at(46, 10)), plain.at(...at(46, 10))) <= 2, 'a blur: outside the selection is as it was');
	check([[10, 10], [30, 20], [20, 60]].some(p => far(blurred.at(...at(...p)), plain.at(...at(...p))) > 10), 'a blur: inside it is blurred');
	await items.run(page, 'blur');
	await pause(400);
	r = await raw();
	check([[10, 10], [30, 20], [20, 60]].every(p => far(px(r, ...p), blurred.at(...at(...p))) <= 3), 'a blur: inside, as it was shown');

	// an effect (its result arriving when it does) is mixed with the picture by the GPU: shown with the pixels as they were, and made what
	// was shown; within a selection, only it
	const blocks = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const v = ((x * 7 + y * 13) % 200) + 20;
		blocks.set([v, 255 - v, (x * 3) & 255, 255], (y * w + x) * 4);
	}
	for (const selecting of [false, true]) {
		const tag = selecting ? 'an effect in a selection' : 'an effect';
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data: blocks, width: w, height: h}});
		await pause(500);
		const before = await shot();
		if (selecting) {
			await page.keyboard.press('m');
			await page.mouse.move(...at(0, 0));
			await page.mouse.down();
			await page.mouse.move(...at(44, 69), {steps: 6});
			await page.mouse.up();
			await pause(200);
		}
		await items.hover(page, ['filters', 'flatten'], true);
		await pause(1500); await frames();
		const fx = await shot();
		check(spots.some(p => far(fx.at(...at(...p)), before.at(...at(...p))) > 10), `${tag} is shown while pointed at`);
		r = await raw();
		check(spots.every(p => far(px(r, ...p), px({data: blocks, width: w}, ...p)) === 0), `${tag}: the pixels are as they were while it is shown`);
		if (selecting)
			check(far(fx.at(...at(70, 30)), before.at(...at(70, 30))) <= 2, `${tag}: outside the selection is as it was`);
		await items.run(page, 'flatten');
		await pause(1500);
		r = await raw();
		check(spots.every(p => far(px(r, ...p), fx.at(...at(...p))) <= 3), `${tag}: the pixels are what was shown (${spots.map(p => far(px(r, ...p), fx.at(...at(...p))))})`);
	}

	console.log(bad ? `${bad} problems` : 'shade preview ok');
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
