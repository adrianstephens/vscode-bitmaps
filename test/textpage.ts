import * as fs from 'fs';
import * as path from 'path';
import * as bitmap from '@isopodlabs/binary_bitmaps';

// The text of a PSD's text layers drawn by the page (in Chrome) and compared with the pixels the file keeps of each layer: how much of
// what is drawn is where the file has it
const file = process.argv[2];
const {openPage} = require('./pagehost');

(async () => {
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(file)));
	const view = await openPage({modules: {t: 'textedit.js?internals'}, programs: true}), {page} = view;

	const W = psd.width, H = psd.height;
	for (let i = 0, layer; (layer = psd.getLayer(i)); i++) {
		const spec = await view.evaluate((blocks: unknown) => (window as any).t.readText(blocks) ?? null, layer.blocks);
		if (!spec || !layer.width)
			continue;
		const mine: number[] = await page.evaluate((spec: unknown, w: number, h: number) => {
			const t = (window as any).t, {left, top, image: img} = t.renderText(spec, t.layoutText(spec));
			const a = new Uint8Array(w * h);		// (over the canvas)
			for (let y = 0; y < img.height; y++)
				for (let x = 0; x < img.width; x++)
					if (x + left >= 0 && y + top >= 0 && x + left < w && y + top < h)
						a[(y + top) * w + x + left] = img.data[(y * img.width + x) * 4 + 3];
			return Array.from(a);
		}, spec, W, H);
		const ref = (await layer.getPixels({plane: 'RGBA'})).pixels as Uint8Array;
		let agree = 0, ours = 0, theirs = 0;
		for (let y = 0; y < H; y += 2) {
			for (let x = 0; x < W; x += 2) {
				const m = mine[y * W + x] > 128;
				const rx = x - layer.left!, ry = y - layer.top!;
				const f = rx >= 0 && ry >= 0 && rx < layer.width! && ry < layer.height! && ref[(ry * layer.width! + rx) * 4 + 3] > 128;
				if (m) ours++;
				if (f) theirs++;
				if (m && f) agree++;
			}
		}
		if (process.env.SHOT) {
			const png: string = await page.evaluate((mine: number[], ref: number[], w: number, h: number, left: number, top: number, lw: number, lh: number) => {
				const c = document.createElement('canvas'); c.width = w; c.height = h;
				const ctx = c.getContext('2d')!, img = ctx.createImageData(w, h);
				for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
					const o = (y * w + x) * 4, rx = x - left, ry = y - top;
					const f = rx >= 0 && ry >= 0 && rx < lw && ry < lh ? ref[(ry * lw + rx) * 4 + 3] : 0, m = mine[y * w + x];
					img.data[o] = m; img.data[o + 1] = f; img.data[o + 2] = 0; img.data[o + 3] = 255;
				}
				ctx.putImageData(img, 0, 0);
				return c.toDataURL('image/png');
			}, mine, Array.from(ref), W, H, layer.left!, layer.top!, layer.width!, layer.height!);
			fs.writeFileSync(process.env.SHOT.replace(/(\.png)?$/, `-${i}.png`), Buffer.from(png.split(',')[1], 'base64'));
		}
		const union = ours + theirs - agree;
		console.log(layer.name.slice(0, 24).padEnd(25), JSON.stringify(spec.text.slice(0, 20)), `drawn ${ours}, in the file ${theirs}, overlap ${union ? (agree / union * 100).toFixed(1) : 100}%`);
	}
	await view.close();
})();
