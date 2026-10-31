// The bitmap editor's layers as files: that the bitmap package writes layers a PSD reader gets back (the files of a real PSD are
// tried by MY_PSDS=a.psd:b.psd). (layers.ts itself is the page's, which runs only in a page: bitmappage.js has it) Carrying layers with the canvas (flip, rotate, crop) is in bitmappage.js, and cutting a layer down to
// what is not transparent for writing is in raster.js.
const bitmap = require('@isopodlabs/binary_bitmaps');
const fs = require('fs');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const image = (w, h, rgba = [0, 0, 0, 0]) => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++)
		data.set(rgba, i * 4);
	return {data, width: w, height: h};
};
const layer = (name, left, top, w, h, rgba, extra = {}) => ({name, left, top, opacity: 1, visible: true, blend: 'norm', image: image(w, h, rgba), ...extra});
const px = (im, x, y) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));

(async () => {
	const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

	// the package saves an image's layers, and reads them back
	{
		const rgba = (w, h, pixels) => ({width: w, height: h, getPixels: async () => pixels});
		const imageOf = (w, h, pixels, layer) => Object.assign(new bitmap.LayerImage('2d', w, h, {RGBA: rgba(w, h, pixels)}), layer);
		const layers = [
			{name: 'Background', left: 0, top: 0, width: 8, height: 6, opacity: 1, visible: true, blendMode: 'norm', pixels: Uint8Array.from({length: 8 * 6 * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 7) & 255)},
			{name: 'Wide name for a layer, with a long label', left: -2, top: 3, width: 5, height: 2, opacity: 0.5, visible: false, blendMode: 'mul', pixels: Uint8Array.from({length: 5 * 2 * 4}, (_, i) => i % 4 === 3 ? (i * 5) & 255 : (i * 11) & 255)},
			{name: 'clipped', left: 0, top: 0, width: 2, height: 2, opacity: 1, visible: true, blendMode: 'norm', clipped: true, pixels: Uint8Array.from({length: 16}, (_, i) => i % 4 === 3 ? 255 : i * 5)},
			{name: 'masked', left: 1, top: 1, width: 4, height: 3, opacity: 1, visible: true, blendMode: 'norm', pixels: Uint8Array.from({length: 4 * 3 * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 13) & 255),
				mask: {left: 2, top: 0, width: 3, height: 2, default: 255, disabled: false, inverted: true, pixels: Uint8Array.from([0, 64, 128, 192, 255, 7])}},
			{name: 'empty', left: 0, top: 0, width: 0, height: 0, opacity: 1, visible: true, blendMode: 'norm', pixels: new Uint8Array(0)},
		].map(l => {
			const layer = imageOf(l.width, l.height, l.pixels, {name: l.name, left: l.left, top: l.top, opacity: l.opacity, visible: l.visible, blendMode: l.blendMode, clipped: l.clipped});
			if (l.mask) {
				const {pixels, ...mask} = l.mask;
				layer.mask = {...mask, getPixels: async () => pixels};
			}
			return layer;
		});
		const image = imageOf(8, 6, new Uint8Array(8 * 6 * 4).fill(77));
		image.getLayer = i => layers[i];

		const psd = await bitmap.PSD.load(await bitmap.PSD.save(image));
		check(psd.width === 8 && psd.height === 6 && psd.getLayer(4) && !psd.getLayer(5), 'a PSD saved from an image of five layers has five');
		let ok = true;
		for (const [i, l] of layers.entries()) {
			const b = psd.getLayer(i), want = l;
			const fine = b.name === want.name && b.left === want.left && b.top === want.top && b.width === l.width && b.height === l.height
				&& b.visible === want.visible && Math.abs(b.opacity - want.opacity) < 0.005 && b.blendMode === want.blendMode
				&& same(Array.from((await b.getPixels({plane: 'RGBA'})).pixels), Array.from((await l.getPixels({plane: 'RGBA'})).pixels));
			if (!fine) {
				ok = false;
				console.log(`     layer ${i} differs: ${b.name} @${b.left},${b.top} ${b.width}x${b.height} vs ${want.name}`);
			}
		}
		check(ok, 'with their names, places, opacity, visibility, blend modes and pixels (alpha included)');
		check(psd.getLayer(2).clipped === true && !psd.getLayer(0).clipped && !psd.getLayer(1).clipped && !psd.getLayer(3).clipped, 'a layer clipped to the one below is still, and the others are not');
		const masked = psd.getLayer(3), want = layers[3].mask;
		const {getPixels: _g, ...maskInfo} = masked.mask ?? {}, {getPixels: _w, ...wantInfo} = want;
		check(masked.mask && JSON.stringify(maskInfo) === JSON.stringify(wantInfo) && same(Array.from(await masked.mask.getPixels()), [0, 64, 128, 192, 255, 7]),
			`a mask keeps its place, default, flags and pixels (${JSON.stringify(maskInfo)})`);
		check(!psd.getLayer(0).mask && !psd.getLayer(1).mask, 'and a layer without one has none');
		check(same(Array.from((await psd.getPixels({plane: 'RGBA'})).pixels.slice(0, 8)), [77, 77, 77, 77, 77, 77, 77, 77]), 'and the merged picture');

		// without layers it is as it was: flat
		const flat = await bitmap.PSD.load(await bitmap.PSD.save(imageOf(2, 2, new Uint8Array(16).fill(5))));
		check(!flat.getLayer(0) && flat.width === 2, 'an image without layers is saved without');
	}

	// real files (read only): each, saved as it is read, has the layers it had
	for (const f of (process.env.MY_PSDS ?? '').split(':').filter(Boolean)) {
		const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(f)));
		if (!psd.getLayer(0)) {
			console.log(`   (${f}: no layers)`);
			continue;
		}
		const back = await bitmap.PSD.load(await bitmap.PSD.save(psd));
		let n = 0, fine = true;
		for (let a, b; (a = psd.getLayer(n)); n++) {
			b = back.getLayer(n);
			fine = fine && b && a.name === b.name && a.left === b.left && a.visible === b.visible && a.width === b.width
				&& same(Array.from((await a.getPixels({plane: 'RGBA'})).pixels), Array.from((await b.getPixels({plane: 'RGBA'})).pixels));
		}
		check(fine && !back.getLayer(n), `${f.split('/').pop()}: ${n} layers survive PSD.save(psd)`);
		check(same(Array.from((await psd.getPixels({plane: 'RGBA'})).pixels), Array.from((await back.getPixels({plane: 'RGBA'})).pixels)), `${f.split('/').pop()}: and the merged picture`);
		let clips = 0, clipsFine = true;
		for (let i = 0, a; (a = psd.getLayer(i)); i++) {
			clips += a.clipped ? 1 : 0;
			clipsFine = clipsFine && !!a.clipped === !!back.getLayer(i).clipped;
		}
		check(clipsFine && (clips > 0 || !/keyboard/.test(f)), `${f.split('/').pop()}: and which of its ${clips} layers are clipped`);
		let masks = 0, masksFine = true;
		for (let i = 0, a; (a = psd.getLayer(i)); i++) {
			const b = back.getLayer(i);
			if (!a.mask)
				masksFine = masksFine && !b.mask;
			else {
				masks++;
				const info = m => { const {getPixels, ...rest} = m ?? {}; return JSON.stringify(rest); };
				const same2 = info(a.mask) === info(b.mask) && same(Array.from(await a.mask.getPixels()), Array.from(await b.mask.getPixels()));
				if (!same2)
					console.log(`     layer ${i} (${a.name}): mask ${info(a.mask)} became ${info(b.mask)}`);
				masksFine = masksFine && same2;
			}
		}
		check(masksFine && (masks > 0 || !/keyboard|Diana/.test(f)), `${f.split('/').pop()}: and its ${masks} layer masks`);
	}

	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exit(bad ? 1 : 0);
})();
