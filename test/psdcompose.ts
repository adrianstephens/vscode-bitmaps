import * as fs from 'fs';
import * as path from 'path';
import * as bitmap from '@isopodlabs/binary_bitmaps';

// A PSD's layers composed by the page's own compositor (headless Chrome), and compared with the composite the file keeps:
// npx ts-node test/psdcompose.ts file.psd [x0 y0 x1 y1]. It prints the mean and the largest difference over the picture (or the rectangle),
// and the mean over an 8 by 8 grid, so a layer that is wrong shows up as where in the picture it is. Environment: SCALE=n takes every nth
// pixel of a big picture (the colour work is the same at each), UPTO=n or ONLY=i,j the layers to use, LINE=y,x0,x1,step a row to print,
// DUMP=path the two pictures as raw rgba.
const ROOT = path.join(__dirname, '..');
const {openPage} = require('./pagehost');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => k === '_' ? undefined : x instanceof Uint8Array ? Array.from(x) : typeof x === 'bigint' ? Number(x) : x));
const b64 = (a: ArrayLike<number> & {buffer: ArrayBufferLike, byteOffset: number, byteLength: number}) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

const K = Number(process.env.SCALE ?? 1);	// a big picture is taken every K pixels (the colour work is the same at each)
const decimate = (px: ArrayLike<number> & {length: number}, w: number, h: number, channels: number) => {
	if (K === 1) return {data: px as Uint8Array, width: w, height: h};
	const nw = Math.ceil(w / K), nh = Math.ceil(h / K), out = new Uint8Array(nw * nh * channels);
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
		const {name, left, top, opacity, visible, blendMode, clipped, blocks} = layer;
		const px = layer.width && layer.height ? decimate((await layer.getPixels({plane: 'RGBA'})).pixels, layer.width, layer.height, 4) : {data: new Uint8Array(0), width: 0, height: 0};
		const mask = layer.mask && layer.mask.width && layer.mask.height ? decimate(await layer.mask.getPixels(), layer.mask.width, layer.mask.height, 1) : undefined;
		layers.push({
			name, left: Math.round(left / K), top: Math.round(top / K), opacity, visible, blend: blendMode, clipped, blocks: plain(blocks), width: px.width, height: px.height, data: b64(px.data),
			mask: layer.mask && {...layer.mask, left: Math.round(layer.mask.left / K), top: Math.round(layer.mask.top / K), width: mask?.width ?? 0, height: mask?.height ?? 0, data: b64(mask?.data ?? new Uint8Array(0))},
		});
	}

	const view = await openPage({modules: {gl: 'opengl.js', layers: 'layers.js', fx: 'layerfx.js', V: '@isopodlabs/maths/vector'}}), {page} = view;
	await page.evaluate(() => { const c = document.createElement('canvas'); c.id = 'c'; c.width = c.height = 64; document.body.appendChild(c); });

	const asset = (n: string) => fs.readFileSync(path.join(ROOT, 'assets', n), 'utf8');
	const result: string = await page.evaluate((layers: any[], W: number, H: number, codes: any, env: any) => {
		const g = globalThis as any; Object.assign(g, env);
		const bytes = (s: string) => Uint8ClampedArray.from(atob(s), c => c.charCodeAt(0));
		const c3 = new g.gl.Canvas3D(g.document.getElementById('c'), {depth: false});
		const comp = new g.layers.LayerCompositor(c3, c3.createProgram(codes.composite, g.gl.rectGeometry), c3.createProgram(codes.effect, g.gl.rectGeometry));
		const list = layers.map((l: any) => ({
			...l, image: {data: bytes(l.data), width: l.width, height: l.height},
			mask: l.mask && {...l.mask, image: {data: bytes(l.mask.data), width: l.mask.width, height: l.mask.height}},
		}));
		let shown = list;		// (the compositor makes the styles, and what fill layers show)
		if (g.SKIP) shown = shown.filter((l: any) => !l.name.includes(g.SKIP));
		if (g.BLEND) shown.forEach((l: any) => { if (l.name === 'Color Fill 1') l.blend = g.BLEND; });
		if (g.globalThis?.DEBUG ?? true) console.log('layers: ' + shown.map((l: any) => `${l.name}[${l.blend}${l.effect ? ',fx' : ''}${l.adjust ? ',adj' : ''}${l.mask ? ',mask' : ''} ${l.visible ? 'v' : 'h'} ${l.opacity}]`).join(' | '));
		comp.compose(W, H, shown);
		const out = comp.read(new g.V.float2.extent(g.V.float2(0, 0), g.V.float2(W, H)));
		let s = '';
		for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
		return btoa(s);
	}, layers, W, H, {composite: {vert: asset('bitmap.vert'), frag: asset('composite.frag')}, effect: {vert: asset('bitmap.vert'), frag: asset('effect.frag')}}, {SKIP: process.env.SKIP, BLEND: process.env.BLEND});

	const ours = Buffer.from(result, 'base64');
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
	console.log(`${path.basename(process.argv[2])} ${W}x${H}: mean difference ${(sum / Math.max(1, n)).toFixed(2)}, largest ${worst}, over ${n} pixels`);
	console.log(cell.map((row, j) => row.map((v, i) => (v / Math.max(1, cellN[j][i])).toFixed(1).padStart(5)).join(' ')).join('\n'));
	if (process.env.LINE) {
		const [y, xa, xb, step] = process.env.LINE.split(',').map(Number);
		for (let x = xa; x <= xb; x += step) { const o = (y * W + x) * 4; console.log(`  x=${x} ours ${[...ours.subarray(o, o + 3)]} file ${[...composite.subarray(o, o + 3)]}`); }
	}
	for (const [x, y] of [[480, 640], [300, 300], [700, 900], [480, 200], [100, 100]]) {
		const o = (y * W + x) * 4;
		console.log(`  (${x},${y}) ours ${[...ours.subarray(o, o + 4)]}  file ${[...composite.subarray(o, o + 4)]}`);
	}
	await view.close();
})();
