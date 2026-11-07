// Invert through the bitmap viewer's page, in headless Chrome (pagehost.js): the whole picture is inverted, and within a marquee
// that does not start at the picture's corner only the marquee is, each pixel from its own colour (not that of the pixel the same
// distance from the corner). Undo puts it back.
// Run: npx tsc -b, then TS_NODE_TRANSPILE_ONLY=1 npx ts-node test/invertpage.ts
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
	const inverse = (c: number[]) => [255 - c[0], 255 - c[1], 255 - c[2], c[3]];

	// a picture whose every pixel is different
	const w = 100, h = 80, data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			data.set([x * 2, y * 3, 100, 255], (y * w + x) * 4);
	await send({command: 'load2d', image: {data, width: w, height: h}});
	await pause(500);
	const at = where(w, h);
	const was = (x: number, y: number) => [x * 2, y * 3, 100, 255];

	// all of it
	await items.run(page, 'invert');
	await pause(300);
	let r = await raw();
	check(edits.at(-1) === 'Invert', `it is an edit called Invert (${edits.at(-1)})`);
	check(same(px(r, 0, 0), inverse(was(0, 0))) && same(px(r, 60, 30), inverse(was(60, 30))) && same(px(r, 99, 79), inverse(was(99, 79))),
		`every pixel is inverted (${px(r, 0, 0)} ${px(r, 60, 30)} ${px(r, 99, 79)})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(same(px(r, 60, 30), was(60, 30)), `undone, it is as it was (${px(r, 60, 30)})`);

	// a marquee from (20, 20) to (40, 30): inside, each pixel inverted from its own colour; outside, as it was
	await page.keyboard.press('m');
	await page.mouse.move(...at(20, 20));
	await page.mouse.down();
	await page.mouse.move(...at(40, 30), {steps: 5});
	await page.mouse.up();
	await pause(100);
	await items.run(page, 'invert');
	await pause(300);
	r = await raw();
	check(same(px(r, 30, 25), inverse(was(30, 25))) && same(px(r, 22, 21), inverse(was(22, 21))) && same(px(r, 38, 28), inverse(was(38, 28))),
		`inside the marquee each pixel is its own inverse (${px(r, 30, 25)} ${px(r, 22, 21)} ${px(r, 38, 28)})`);
	check(same(px(r, 10, 10), was(10, 10)) && same(px(r, 50, 25), was(50, 25)) && same(px(r, 30, 40), was(30, 40)),
		`outside it is as it was (${px(r, 10, 10)} ${px(r, 50, 25)} ${px(r, 30, 40)})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(same(px(r, 30, 25), was(30, 25)), `undone, it is as it was (${px(r, 30, 25)})`);

	await view.close();
	console.log(bad ? `${bad} failed` : 'all ok');
	process.exit(bad ? 1 : 0);
})();
