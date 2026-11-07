import * as fs from 'fs';
import * as path from 'path';
import * as bitmap from '@isopodlabs/binary_bitmaps';

// A PSD's layers loaded into the bitmap viewer's page (headless Chrome) as the extension sends them, and the picture it composes compared
// with the composite the file keeps: npx tsc -b, then npx ts-node test/psdcompose.ts file.psd [x0 y0 x1 y1]. It prints the mean and the
// largest difference over the picture (or the rectangle), and the mean over an 8 by 8 grid, so a layer that is wrong shows up as where in
// the picture it is. Environment: SCALE=n takes every nth pixel of a big picture (the colour work is the same at each), UPTO=n or ONLY=i,j
// the records to send (a group is its end, its layers and itself), SKIP=text leaves out layers whose names have it, BLEND=key gives
// 'Color Fill 1' that mode, LINE=y,x0,x1,step a row to print, DUMP=path the two pictures as raw rgba, MAX=n fails if the mean is more.
const {openPage, pause} = require('./pagehost');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => k === '_' ? undefined : x instanceof Uint8Array ? Array.from(x) : typeof x === 'bigint' ? Number(x) : x));

const K = Number(process.env.SCALE ?? 1);	// a big picture is taken every K pixels (the colour work is the same at each)
const decimate = (px: ArrayLike<number> & {length: number}, w: number, h: number, channels: number) => {
	if (K === 1) return {data: Uint8ClampedArray.from(px), width: w, height: h};
	const nw = Math.ceil(w / K), nh = Math.ceil(h / K), out = new Uint8ClampedArray(nw * nh * channels);
	for (let y = 0; y < nh; y++)
		for (let x = 0; x < nw; x++)
			for (let c = 0; c < channels; c++)
				out[(y * nw + x) * channels + c] = px[(y * K * w + x * K) * channels + c];
	return {data: out, width: nw, height: nh};
};

(async () => {
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(process.argv[2])));
	const full = {W: psd.width, H: psd.height};
	const ref = decimate((await psd.getPixels({plane: 'RGBA'})).pixels as Uint8Array, full.W, full.H, 4);
	const W = ref.width, H = ref.height, composite = ref.data;

	const layers: any[] = [];
	for (let i = 0, layer: any; (layer = psd.getLayer(i)) && i <= Number(process.env.UPTO ?? 1e9); i++) {
		if (process.env.ONLY && !process.env.ONLY.split(',').map(Number).includes(i)) continue;
		if (process.env.SKIP && layer.name.includes(process.env.SKIP)) continue;
		const {name, left, top, opacity, visible, blendMode, clipped, blocks} = layer;
		const px = layer.width && layer.height ? decimate((await layer.getPixels({plane: 'RGBA'})).pixels, layer.width, layer.height, 4) : {data: new Uint8ClampedArray(0), width: 0, height: 0};
		const mask = layer.mask && layer.mask.width && layer.mask.height ? decimate(await layer.mask.getPixels(), layer.mask.width, layer.mask.height, 1) : undefined;
		layers.push({
			name, left: Math.round(left / K), top: Math.round(top / K), opacity, visible, clipped, blocks: plain(blocks), width: px.width, height: px.height, data: px.data,
			blend: process.env.BLEND && name === 'Color Fill 1' ? process.env.BLEND : blendMode,
			mask: layer.mask && {...layer.mask, getPixels: undefined, left: Math.round(layer.mask.left / K), top: Math.round(layer.mask.top / K), width: mask?.width ?? 0, height: mask?.height ?? 0, data: mask?.data ?? new Uint8ClampedArray(0)},
			vectorMaskDensity: layer.vectorMaskDensity, vectorMaskFeather: layer.vectorMaskFeather,
		});
	}
	console.log('layers: ' + layers.map(l => `${l.name}[${l.blend}${l.blocks?.lsct ? `,section ${l.blocks.lsct.type}${l.blocks.lsct.blend ? ' ' + l.blocks.lsct.blend.key : ''}` : ''}${l.mask ? ',mask' : ''} ${l.visible ? 'v' : 'h'} ${l.opacity.toFixed(2)}]`).join(' | '));

	const problems: string[] = [];
	let ready!: () => void, got!: (r: any) => void;
	const readyP = new Promise<void>(r => ready = r), result = new Promise<any>(r => got = r);
	const view = await openPage({
		script: 'bitmap.js', width: 400, height: 300, bitmap: true,
		problems: (m: string) => m.includes('HALF_FLOAT') || m.includes('willReadFrequently') || problems.push(m),
		host: (m: any) => m.command === 'ready' ? ready() : 'resultId' in m && m.resultId === 1 ? got(m.result) : undefined,
	});
	await readyP;
	await view.send({command: 'load2d', image: {data: new Uint8ClampedArray(W * H * 4), width: W, height: H}, layers});
	await pause(1500);
	await view.send({command: 'getTexture', type: 'image/x-rgba', requestId: 1});
	const ours: Uint8Array | undefined = (await result)?.data;
	if (!ours)
		throw new Error(`the page gave no picture: ${problems.join('; ')}`);

	const [x0, y0, x1, y1] = process.argv.length > 6 ? process.argv.slice(3, 7).map(Number) : [0, 0, W, H];
	let sum = 0, worst = 0, n = 0;
	const GRID = 8, cell: number[][] = Array.from({length: GRID}, () => new Array(GRID).fill(0)), cellN: number[][] = Array.from({length: GRID}, () => new Array(GRID).fill(0));
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const o = (y * W + x) * 4;
			// (the file's composite is over nothing, as is the page's: only where it is opaque)
			if (composite[o + 3] < 255) continue;
			const d = Math.max(Math.abs(ours[o] - composite[o]), Math.abs(ours[o + 1] - composite[o + 1]), Math.abs(ours[o + 2] - composite[o + 2]));
			sum += d; n++; worst = Math.max(worst, d);
			const gy = Math.min(GRID - 1, Math.floor((y - y0) / (y1 - y0) * GRID)), gx = Math.min(GRID - 1, Math.floor((x - x0) / (x1 - x0) * GRID));
			cell[gy][gx] += d; cellN[gy][gx]++;
		}
	}
	if (process.env.DUMP) { fs.writeFileSync(process.env.DUMP + '.ours', ours); fs.writeFileSync(process.env.DUMP + '.file', composite); }
	const mean = sum / Math.max(1, n);
	console.log(`${path.basename(process.argv[2])} ${W}x${H}: mean difference ${mean.toFixed(2)}, largest ${worst}, over ${n} pixels`);
	console.log(cell.map((row, j) => row.map((v, i) => (v / Math.max(1, cellN[j][i])).toFixed(1).padStart(5)).join(' ')).join('\n'));
	if (process.env.LINE) {
		const [y, xa, xb, step] = process.env.LINE.split(',').map(Number);
		for (let x = xa; x <= xb; x += step) { const o = (y * W + x) * 4; console.log(`  x=${x} ours ${[...ours.subarray(o, o + 3)]} file ${[...composite.subarray(o, o + 3)]}`); }
	}
	if (problems.length)
		console.log(`page problems: ${problems.join('; ')}`);
	await view.close();
	process.exit(problems.length || (process.env.MAX && mean > Number(process.env.MAX)) ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
