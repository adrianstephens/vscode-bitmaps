const {openPage, serveFile} = require('./pagehost');
import * as fs from 'fs';
import * as path from 'path';

// Object Select and Remove Object in the bitmap viewer's page, in headless Chrome on the real GPU (npx tsc -b first, then npx ts-node test/segment.ts):
// MobileSAM's networks, which the stand-in for the extension answers from binary_ml's scratch copies of them, find the disc under a click
// in a picture of a disc and a square, and the square under another; the encoder is not run again for a second click on the same picture.
// LaMa then fills a disc selected from a textured picture with what the picture there would have been.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const models = path.join(__dirname, '../../../packages/binary_ml/assistant/models');
const files: Record<string, string> = {'sam-encoder': 'mobile_sam_image_encoder.onnx', 'sam-decoder': 'sam_mask_decoder_single.onnx', 'lama': 'lama_fp32.onnx', 'esrgan': 'realesr_x4v3.onnx'};
const file = (name: string) => name.startsWith('style-') ? `${name.slice(6)}-9.onnx` : files[name];

(async () => {
	const problems: string[] = [];
	serveFile('/lama.onnx', path.join(models, files.lama));
	const view = await openPage({
		programs: true, modules: {S: 'neural.js', B: 'bitmapSelection.js', V: '@isopodlabs/maths/vector', R: 'raster.js'},
		problems: (m: string) => m.includes('willReadFrequently') || problems.push(m),
		host: (m: any, reply: (r: any) => void) => {
			if (m.command === 'model' && m.name === 'lama')
				view.page.evaluate(`fetch('/lama.onnx').then(r => r.arrayBuffer()).then(result => window.postMessage({resultId: ${m.requestId}, result}, '*'))`);
			else if (m.command === 'model')
				reply(new Uint8Array(fs.readFileSync(path.join(models, file(m.name)))));
			else if (m.command === 'error')
				problems.push(m.message);
		},
	});

	const result = await view.evaluate(async () => {
		const W = 480, H = 360, data = new Uint8ClampedArray(W * H * 4);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const inDisc = Math.hypot(x - 140, y - 180) < 80, inSquare = x > 300 && x < 420 && y > 120 && y < 240;
				data.set(inDisc ? [220, 30, 30, 255] : inSquare ? [30, 160, 40, 255] : [70, 90, 170, 255], (y * W + x) * 4);
			}
		const image = {data, width: W, height: H};
		const count = (s: any) => { let n = 0; if (s) for (const v of s.mask) n += v > 128 ? 1 : 0; return n; };
		const out: any = {};
		let t = performance.now();
		const disc = await (window as any).S.segment(image, 140, 180);
		out.first = performance.now() - t;
		t = performance.now();
		const square = await (window as any).S.segment(image, 360, 180);
		out.second = performance.now() - t;
		out.disc = {n: count(disc), min: disc && [disc.min.x, disc.min.y], max: disc && [disc.max.x, disc.max.y], centre: disc?.at(140, 180), outside: disc?.at(360, 180)};
		out.square = {n: count(square), min: square && [square.min.x, square.min.y], max: square && [square.max.x, square.max.y], centre: square?.at(360, 180), outside: square?.at(140, 180)};
		out.off = await (window as any).S.segment(image, -5, 10);
		return out;
	});
	console.log(JSON.stringify(result));

	const disc = Math.PI * 80 * 80, square = 119 * 119;
	check(Math.abs(result.disc.n - disc) < disc * 0.1, `the disc is about ${Math.round(disc)} pixels (${result.disc.n})`);
	check(result.disc.centre === 255 && result.disc.outside === 0, 'the disc holds its centre and not the square');
	check(Math.abs(result.square.n - square) < square * 0.1, `the square is about ${square} pixels (${result.square.n})`);
	check(result.square.centre === 255 && result.square.outside === 0, 'the square holds its centre and not the disc');
	check(result.off === undefined, 'a click outside the picture selects nothing');
	check(result.second < result.first / 2, `the second click is quicker than the first (${Math.round(result.second)} ms, ${Math.round(result.first)} ms)`);
	check(!problems.length, `nothing is reported${problems.length ? ': ' + problems.join('; ') : ''}`);

	const removed = await view.evaluate(async () => {
		const W = 600, H = 420, data = new Uint8ClampedArray(W * H * 4);
		const bg = (x: number, y: number) => [110 + 70 * Math.sin(x / 45), 120 + 60 * Math.cos(y / 35), 150 + 40 * Math.sin((x + y) / 60)];
		const cx = 300, cy = 210, R = 55;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				data.set(Math.hypot(x - cx, y - cy) < R ? [240, 20, 20, 255] : [...bg(x, y), 255], (y * W + x) * 4);
		const box = new Uint8Array(2 * R * 2 * R);
		for (let y = 0; y < 2 * R; y++)
			for (let x = 0; x < 2 * R; x++)
				box[y * 2 * R + x] = Math.hypot(x + 0.5 - R, y + 0.5 - R) < R ? 255 : 0;
		const {B: {Selection}, V: {float2}} = window as any;
		const selection = new Selection(new float2.extent(float2(cx - R, cy - R), float2(cx + R, cy + R)), box);
		const t = performance.now();
		const found = await (window as any).S.removeObject({data, width: W, height: H}, selection);
		if (!found)
			return undefined;
		const ms = performance.now() - t;
		let err = 0, red = 0, n = 0;
		for (let y = 0; y < 2 * R; y++)
			for (let x = 0; x < 2 * R; x++) {
				if (!box[y * 2 * R + x])
					continue;
				const o = (y * found.pixels.width + x) * 4, b = bg(cx - R + x, cy - R + y);
				for (let c = 0; c < 3; c++) {
					err += Math.abs(found.pixels.data[o + c] - b[c]);
					red += Math.abs([240, 20, 20][c] - b[c]);
				}
				n += 3;
			}
		return {ms, err: err / n, red: red / n, area: [found.area.min.x, found.area.min.y, found.area.max.x, found.area.max.y], w: found.pixels.width, h: found.pixels.height, alpha: found.pixels.data[3]};
	});
	console.log(JSON.stringify(removed), problems);
	if (!removed)
		throw new Error(problems.join('; '));
	check(removed.w === 110 && removed.h === 110 && removed.area.join() === '245,155,355,265', 'the fill covers the selection\'s bounds');
	check(removed.err < 30 && removed.err < removed.red / 3, `the fill is near what the picture was (off by ${removed.err.toFixed(1)}, where the object was off by ${removed.red.toFixed(1)})`);

	const up = await view.evaluate(async () => {
		const {S} = window as any;
		const make = (W: number, H: number, alpha = 255) => {
			const data = new Uint8ClampedArray(W * H * 4);
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++)
					data.set([128 + 100 * Math.sin(x / 23), 128 + 100 * Math.cos(y / 19), 128 + 90 * Math.sin((x + y) / 31), alpha], (y * W + x) * 4);
			return {data, width: W, height: H};
		};
		const out: any = {};
		const small = make(40, 30, 200);
		for (const f of [2, 4, 8]) {
			const r = await S.upscale(small, f);
			out['x' + f] = r && [r.width, r.height, r.data[3]];
		}
		// bigger than a tile, so that it is made in several: the seams between them must not show
		const big = await S.upscale(make(220, 170), 4);
		const W = big.width, d = big.data, jump = (x: number) => { let s = 0; for (let y = 0; y < big.height; y++) for (let c = 0; c < 3; c++) s += Math.abs(d[(y * W + x) * 4 + c] - d[(y * W + x - 1) * 4 + c]); return s / big.height; };
		const seams = [160 * 4, 160 * 4 + 1, 160 * 4 - 1].map(jump), typical = [100, 300, 500].map(jump);
		out.seam = Math.max(...seams); out.typical = Math.max(...typical); out.size = [big.width, big.height];
		return out;
	});
	console.log(JSON.stringify(up));
	check(up.x2.join() === '80,60,200' && up.x4.join() === '160,120,200' && up.x8.join() === '320,240,200', 'upscaling makes the picture 2, 4 and 8 times the size, and keeps its transparency');
	check(up.size.join() === '880,680' && up.seam < up.typical * 2 + 1, `the tiles join without a seam (a jump of ${up.seam.toFixed(2)} across it, ${up.typical.toFixed(2)} elsewhere)`);

	const art = await view.evaluate(async () => {
		const {S} = window as any;
		const W = 101, H = 77, data = new Uint8ClampedArray(W * H * 4);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				data.set([128 + 100 * Math.sin(x / 9), 128 + 100 * Math.cos(y / 7), 90 + 5 * ((x * 7 + y * 13) % 7), x < 10 ? 100 : 255], (y * W + x) * 4);
		const image = {data, width: W, height: H};
		const R0 = (window as any).R, diff = (r: any) => { let s = 0; for (let i = 0; i < W * H * 4; i++) if (i % 4 !== 3) s += Math.abs(r.data[i] - data[i]); return s / (W * H * 3); };
		const out: any = {};
		for (const style of S.styles) {
			const t = performance.now(), r = await S.stylise(image, style);
			out[style] = r && {size: [r.width, r.height], alpha: [r.data[3], r.data[(10) * 4 + 3]], diff: diff(r), ms: Math.round(performance.now() - t)};
		}
		const full = await S.stylise(image, 'candy'), none = R0.mixed(image, full, 0), half = R0.mixed(image, full, 0.5);
		out.none = diff(none); out.half = diff(half); out.full = diff(full);

		return out;
	});
	console.log(JSON.stringify(art));
	for (const style of ['mosaic', 'candy', 'rain-princess', 'udnie', 'pointilism'])
		check(art[style] && art[style].size.join() === '101,77' && art[style].alpha.join() === '100,255' && art[style].diff > 10, `${style} paints a picture of the same size, with its transparency, and changes it (by ${art[style]?.diff.toFixed(0)})`);
	check(art.none < 1 && art.half > art.none && art.half < art.full, `the strength mixes the style with the picture (${art.none.toFixed(1)}, ${art.half.toFixed(1)}, ${art.full.toFixed(1)})`);

	await view.close();
	process.exit(bad ? 1 : 0);
})();
