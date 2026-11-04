const {openPage, pause} = require('./pagehost');
import * as fs from 'fs';
import * as path from 'path';
import * as items from './menuitems';

// Upscale in the bitmap viewer's page of layers, in headless Chrome on the real GPU (npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/upscalepage.ts): the stand-in for the extension answers the request for the network
// from binary_ml's scratch copy of it. Upscaling makes the canvas and every layer (and a layer's mask, and where each is) the size asked
// for as one edit, which is undone and redone.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const model = path.join(__dirname, '../../../packages/binary-ml/assistant/models/realesr_x4v3.onnx');

(async () => {
	const problems: string[] = [], edits: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready!: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: 700, height: 700, bitmap: true,
		problems: (m: string) => m.includes('HALF_FLOAT') || m.includes('willReadFrequently') || problems.push(m),
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m)
				waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready')
				ready();
			else if (m.command === 'edited')
				edits.push(m.label);
			else if (m.command === 'model')
				reply(new Uint8Array(fs.readFileSync(model)));
			else if (m.command === 'error')
				problems.push(m.message);
		},
	});
	await readyP;
	const {send, page} = view;

	let rid = 100;
	const raw = async (): Promise<any> => {
		const id = ++rid;
		const got = new Promise(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const filled = (w: number, h: number, c: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(c, i * 4); return d; };
	const lay = (name: string, left: number, top: number, w: number, h: number, c: number[], more = {}) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, c), ...more});

	// white, under a red square from (30, 25) to (70, 55), which a mask shows the left half of
	const mask = {left: 30, top: 25, width: 20, height: 30, default: 0, disabled: false, inverted: false, data: new Uint8ClampedArray(20 * 30).fill(255)};
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [lay('back', 0, 0, 100, 80, [255, 255, 255, 255]), lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {mask})]});
	await pause(700);
	let r = await raw();
	check(r.width === 100 && r.height === 80, `the picture is 100 x 80 (${r.width} x ${r.height})`);

	edits.length = 0;
	const t = Date.now();
	await items.run(page, 'upscale2');
	await pause(300);
	r = await raw();
	console.log(`   (${Date.now() - t} ms)`);
	const sq = r.layers?.[1];
	check(r.width === 200 && r.height === 160, `the canvas is 200 x 160 (${r.width} x ${r.height})`);
	// (its edge is soft, which takes a pixel more each side)
	const near = (v: number, want: number) => Math.abs(v - want) <= 2;
	check(sq && near(sq.left, 60) && near(sq.top, 50) && near(sq.width, 80) && near(sq.height, 60), `the square is where it was and twice the size (${sq && [sq.left, sq.top, sq.width, sq.height]})`);
	check(sq?.mask && sq.mask.left === 60 && sq.mask.top === 50 && sq.mask.width === 40 && sq.mask.height === 60, `so is its mask (${sq?.mask && [sq.mask.left, sq.mask.top, sq.mask.width, sq.mask.height]})`);
	const px = (x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)).join();
	check(px(80, 80) === '255,0,0' && px(120, 80) === '255,255,255' && px(10, 10) === '255,255,255', `the picture shows the same (${px(80, 80)}, ${px(120, 80)}, ${px(10, 10)})`);
	check(edits[edits.length - 1] === 'Upscale', `it is one edit (${edits.join(', ')})`);

	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(r.width === 100 && r.height === 80 && r.layers?.[1]?.width === 40, `undone, it is 100 x 80 again (${r.width} x ${r.height})`);
	await send({command: 'redo'});
	await pause(300);
	r = await raw();
	check(r.width === 200 && near(r.layers?.[1]?.width, 80), `redone, it is 200 x 160 (${r.width} x ${r.height})`);

	//-------------------------------------------------------------------------
	// flips, turns and a crop: the same carry, and exact (no pixel is blurred or changed)
	//-------------------------------------------------------------------------

	// white, under a red square from (30, 25) with a blue pixel at its top left corner
	const mark = filled(40, 30, [255, 0, 0, 255]);
	mark.set([0, 0, 255, 255], 0);
	const marked = {name: 'square', left: 30, top: 25, width: 40, height: 30, opacity: 1, visible: true, blend: 'norm', data: mark};
	const load = async () => {
		await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [lay('back', 0, 0, 100, 80, [255, 255, 255, 255]), marked]});
		await pause(500);
		r = await raw();
	};
	const colours = () => {
		const seen = new Map<string, number>();
		for (let i = 0; i < r.width * r.height; i++)
			seen.set(Array.from(r.data.subarray(i * 4, i * 4 + 3)).join(), (seen.get(Array.from(r.data.subarray(i * 4, i * 4 + 3)).join()) ?? 0) + 1);
		return seen;
	};
	const exact = () => [...colours().keys()].every(k => ['255,255,255', '255,0,0', '0,0,255'].includes(k)) && colours().get('255,0,0') === 1199 && colours().get('0,0,255') === 1;

	await load();
	await items.run(page, 'flipHorizontal'); await pause(300); r = await raw();
	check(r.width === 100 && r.height === 80 && px(69, 25) === '0,0,255' && exact(), `flipped across, the marker is at (69, 25) and no colour is blurred (${px(69, 25)})`);
	await send({command: 'undo'}); await pause(300); r = await raw();
	check(px(30, 25) === '0,0,255', `undone, the marker is back (${px(30, 25)})`);

	await load();
	await items.run(page, 'flipVertical'); await pause(300); r = await raw();
	check(px(30, 54) === '0,0,255' && exact(), `flipped down, the marker is at (30, 54) (${px(30, 54)})`);

	await load();
	await items.run(page, 'rotateClockwise'); await pause(300); r = await raw();
	check(r.width === 80 && r.height === 100 && px(54, 30) === '0,0,255' && exact(), `turned clockwise, the canvas is 80 x 100 and the marker is at (54, 30) (${r.width} x ${r.height}, ${px(54, 30)})`);
	await send({command: 'undo'}); await pause(300); r = await raw();
	check(r.width === 100 && r.height === 80 && px(30, 25) === '0,0,255', `undone, it is 100 x 80 again (${r.width} x ${r.height})`);

	await load();
	await items.run(page, 'rotateAnticlockwise'); await pause(300); r = await raw();
	check(r.width === 80 && r.height === 100 && px(25, 69) === '0,0,255' && exact(), `turned anticlockwise, the marker is at (25, 69) (${px(25, 69)})`);

	await load();
	await page.evaluate(`(async () => {
		const {mode} = await import('/out/webview/modes.js'), {Selection} = await import('/out/webview/bitmapSelection.js'), {float2} = await import('@isopodlabs/maths/vector');
		mode.select(new Selection(new float2.extent(float2(20, 15), float2(60, 45))), 'Select');
	})()`);
	await items.run(page, 'crop'); await pause(300); r = await raw();
	check(r.width === 40 && r.height === 30 && px(10, 10) === '0,0,255' && px(0, 0) === '255,255,255', `cropped to (20, 15)-(60, 45), the canvas is 40 x 30 and the marker is at (10, 10) (${r.width} x ${r.height}, ${px(10, 10)})`);

	check(!problems.length, `nothing is reported${problems.length ? ': ' + problems.join('; ') : ''}`);
	await view.close();
	process.exit(bad ? 1 : 0);
})();
