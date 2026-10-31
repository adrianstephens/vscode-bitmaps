import * as fs from 'fs';
import * as path from 'path';
import * as bitmap from '@isopodlabs/binary_bitmaps';


// The layer styles of gradshape.psd's top layer (a gradient overlay and a stroke, on a shape that has only a stroke of its own), made in
// Chrome and put over the layer's own pixels, and compared with the picture the file keeps of all the layers.
const file = process.argv[2];
const ROOT = path.join(__dirname, '..');
const {openPage} = require('./pagehost');

const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => k === '_' ? undefined : x instanceof Uint8Array ? Array.from(x) : typeof x === 'bigint' ? Number(x) : x));


(async () => {
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(file)));
	const view = await openPage({modules: {fx: 'layerfx.js'}}), {page} = view;
	await page.evaluate(() => { const c = document.createElement('canvas'); c.id = 'c'; c.width = c.height = 64; document.body.appendChild(c); });

	const W = psd.width, H = psd.height;
	const composite = (await psd.getPixels({plane: 'RGBA'})).pixels as Uint8Array;
	const index = Number(process.argv[3] ?? 3);
	const layer = psd.getLayer(index)!;
	const raster = (await layer.getPixels({plane: 'RGBA'})).pixels as Uint8Array;
	const timing: number[] = await page.evaluate((blocks: unknown, w: number, h: number) => {
		const fx = (window as any).fx, out: number[] = [];
		const layer = {name: 'x', left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image: {data: new Uint8ClampedArray(0), width: 0, height: 0}, blocks};
		for (let k = 0; k < 3; k++) { fx.forgetEffects(layer); const t = performance.now(); fx.effectLayers(layer, w, h); out.push(Math.round(performance.now() - t)); }
		const t = performance.now(); fx.effectLayers(layer, w, h); out.push(Math.round(performance.now() - t));
		return out;
	}, plain(layer.blocks), W, H);
	console.log('   building the effects: ' + timing.slice(0, 3).join(', ') + ' ms each time; cached: ' + timing[3] + ' ms');
	const effects: {name: string, blend: string, opacity: number, left: number, top: number, width: number, height: number, data: number[]}[] = await page.evaluate((blocks: unknown, w: number, h: number) => {
		const fx = (window as any).fx;
		const layer = {name: 'x', left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image: {data: new Uint8ClampedArray(0), width: 0, height: 0}, blocks};
		return fx.effectLayers(layer, w, h).map((e: any) => ({name: e.name, blend: e.blend, opacity: e.opacity, left: e.left, top: e.top, width: e.image.width, height: e.image.height, data: Array.from(e.image.data)}));
	}, plain(layer.blocks), W, H);

	// the layer's pixels, then each style over them (Normal blend only)
	const out = new Float32Array(W * H * 4);
	const over = (src: ArrayLike<number>, left: number, top: number, w: number, h: number, opacity: number) => {
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const X = x + left, Y = y + top;
			if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
			const s = (y * w + x) * 4, d = (Y * W + X) * 4, a = src[s + 3] / 255 * opacity, da = out[d + 3] / 255;
			const oa = a + da * (1 - a);
			if (!oa) continue;
			for (let c = 0; c < 3; c++) out[d + c] = (src[s + c] * a + out[d + c] * da * (1 - a)) / oa;
			out[d + 3] = oa * 255;
		}
	};
	over(raster, layer.left!, layer.top!, layer.width!, layer.height!, 1);
	for (const e of effects) { console.log(' ', e.name, e.blend, 'opacity', e.opacity, `${e.width}x${e.height} at ${e.left},${e.top}`); over(e.data, e.left, e.top, e.width, e.height, e.opacity); }

	// where this has something, the picture of the file has the same colour
	let agree = 0, total = 0, shown = 0;
	const xmax = Number(process.argv[4] ?? W);		// (another layer may be above this one, further along)
	for (let y = 0; y < H; y += 3) for (let x = 0; x < xmax; x += 3) {
		const o = (y * W + x) * 4;
		if (out[o + 3] < 250) continue;
		total++;
		if (Math.max(Math.abs(out[o] - composite[o]), Math.abs(out[o + 1] - composite[o + 1]), Math.abs(out[o + 2] - composite[o + 2])) < 40) agree++;
	}
	const ok = total > 0 && agree / total > 0.9;
	console.log(layer.name, `${agree} of ${total} opaque places have the colour the file's picture has (${(100 * agree / Math.max(1, total)).toFixed(1)}%)`, ok ? 'ok' : 'FAILED');
	await view.close();
	if (!ok) process.exitCode = 1;
})();
