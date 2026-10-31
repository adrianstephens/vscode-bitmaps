// The clone stamp through the bitmap viewer's page, in headless Chrome (pagehost.js): Alt-click sets where it copies from, a stroke
// copies the pixels that far away exactly, aligned strokes keep the offset, and undo takes a stroke away. With layers it copies from the
// layer it was Alt-clicked on while painting on another, and with 'All layers' from what the picture shows.
// Run: npx tsc -b, then TS_NODE_TRANSPILE_ONLY=1 npx ts-node test/stamptool.ts
const {openPage, pause} = require('./pagehost');
const {menu} = require('./cascadehost');		// (for the stamp's own options, which are the tools')
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
	const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
	const where = (w: number, h: number) => { const s = Math.min(W / w, H / h, 16); return (x: number, y: number): [number, number] => [(W - w * s) / 2 + (x + 0.5) * s, (H - h * s) / 2 + (y + 0.5) * s]; };
	const stroke = async (at: (x: number, y: number) => [number, number], x0: number, y0: number, x1: number, y1: number) => {
		await page.mouse.move(...at(x0, y0));
		await page.mouse.down();
		await page.mouse.move(...at(x1, y1), {steps: 6});
		await page.mouse.up();
		await pause(200);
	};
	const setSource = async (at: (x: number, y: number) => [number, number], x: number, y: number) => {
		await page.keyboard.down('Alt');
		await page.mouse.click(...at(x, y));
		await page.keyboard.up('Alt');
		await pause(100);
	};

	// a plain picture whose every pixel is different: the copy is exact, and the next stroke keeps the offset
	{
		const w = 100, h = 80, data = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				data.set([x * 2, y * 3, 100, 255], (y * w + x) * 4);
		await send({command: 'load2d', image: {data, width: w, height: h}});
		await pause(500);
		await page.keyboard.press('s');
		const at = where(w, h);
		await stroke(at, 60, 20, 70, 20);
		check(edits.length === 0, `no source, no edit (${edits})`);

		await setSource(at, 20, 20);
		await stroke(at, 60, 20, 70, 20);
		check(edits.at(-1) === 'Clone Stamp', `it is an edit called Clone Stamp (${edits.at(-1)})`);
		let r = await raw();
		check(same(px(r, 60, 20), [40, 60, 100, 255]) && same(px(r, 65, 20), [50, 60, 100, 255]) && same(px(r, 70, 21), [60, 63, 100, 255]),
			`the stroke copies the pixels 40 to the left (${px(r, 60, 20)} ${px(r, 65, 20)} ${px(r, 70, 21)})`);
		check(same(px(r, 60, 40), [120, 120, 100, 255]), `away from the stroke the picture is as it was (${px(r, 60, 40)})`);

		await stroke(at, 60, 40, 62, 40);
		r = await raw();
		check(same(px(r, 60, 40), [40, 120, 100, 255]), `an aligned stroke keeps the offset (${px(r, 60, 40)})`);

		// not aligned: each stroke starts from the source again
		await menu(page, ...at(50, 70), ['paint', 'stamp', 'aligned']);
		await page.keyboard.press('Escape');
		await stroke(at, 60, 60, 62, 60);
		r = await raw();
		check(same(px(r, 60, 60), [40, 60, 100, 255]), `not aligned, a stroke starts from the source (${px(r, 60, 60)})`);
		await menu(page, ...at(50, 70), ['paint', 'stamp', 'aligned']);
		await page.keyboard.press('Escape');

		await send({command: 'undo'});
		await send({command: 'undo'});
		await send({command: 'undo'});
		await pause(300);
		r = await raw();
		check(same(px(r, 65, 20), [130, 60, 100, 255]), `undone (${px(r, 65, 20)})`);
	}

	// layers: a red square on the bottom one, the top one empty and half opaque. Set on the bottom one, painting on the top copies the square
	{
		const w = 100, h = 80, empty = () => new Uint8ClampedArray(w * h * 4);
		const square = empty();
		for (let y = 10; y < 30; y++)
			for (let x = 10; x < 30; x++)
				square.set([255, 0, 0, 255], (y * w + x) * 4);
		await send({command: 'load2d', image: {data: square.slice(), width: w, height: h}, layers: [
			{name: 'square', left: 0, top: 0, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: square},
			{name: 'over', left: 0, top: 0, width: w, height: h, opacity: 0.5, visible: true, blend: 'norm', data: empty()},
		]});
		await pause(800);
		await page.keyboard.press('s');
		const at = where(w, h);
		const before = edits.length;

		// on the empty top layer it copies nothing
		await setSource(at, 20, 20);
		await stroke(at, 60, 20, 64, 20);
		check(edits.length === before, `copying the empty layer onto itself changes nothing (${edits.slice(before)})`);

		await items.choose(page, ['layer', 'layer-0']);
		await setSource(at, 20, 20);
		await items.choose(page, ['layer', 'layer-1']);
		await stroke(at, 60, 20, 64, 20);
		check(edits.at(-1) === 'Clone Stamp', `copying another layer is an edit (${edits.at(-1)})`);
		let r = await raw(), p = px(r, 62, 20);
		check(p[0] > 250 && p[1] < 5 && p[3] > 120 && p[3] < 135, `the square's red, on the half-opaque top layer (${p})`);
		check(px(r, 20, 20)[3] === 255 && px(r, 62, 40)[3] === 0, `the rest as it was (${px(r, 20, 20)} ${px(r, 62, 40)})`);

		// all layers: what the picture shows (there, the top's red at half), copied onto the top, which shows it at half again
		await menu(page, ...at(50, 70), ['paint', 'stamp', 'sample', 'allLayers']);
		await page.keyboard.press('Escape');
		await setSource(at, 62, 20);
		await stroke(at, 82, 20, 84, 20);
		r = await raw(), p = px(r, 82, 20);
		check(p[0] > 250 && p[3] > 56 && p[3] < 72, `with all layers it copies what is shown (${p})`);
		await setSource(at, 20, 20);
		await stroke(at, 82, 50, 84, 50);
		r = await raw(), p = px(r, 82, 50);
		check(p[0] > 250 && p[3] > 120 && p[3] < 135, `including the bottom layer's pixels (${p})`);
	}

	console.log(bad ? `${bad} problems` : 'stamp tool ok');
	process.exit(bad ? 1 : 0);
})();
