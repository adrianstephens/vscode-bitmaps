import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';

// the tagged blocks of a PSD's layers as the package reads them, and that a save writes the same ones back
(async () => {
	for (const file of process.argv.slice(2)) {
		const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(file)));
		const again = await bitmap.PSD.load(await bitmap.PSD.save(psd));
		const text = (b: unknown) => JSON.stringify(b, (k, v) => k === '_' ? undefined : v instanceof Uint8Array ? Array.from(v) : typeof v === 'bigint' ? Number(v) : v);
		for (let i = 0, layer; (layer = psd.getLayer(i)); i++) {
			const keys = Object.keys(layer.blocks ?? {}).filter(k => ['vmsk', 'vsms', 'SoCo', 'GdFl', 'PtFl', 'vstk', 'vscg'].includes(k));
			const same = text(layer.blocks) === text(again.getLayer(i)?.blocks);
			console.log(file.split('/').pop(), i, layer.name, keys?.join(','), same ? '' : 'CHANGED BY A SAVE');
		}
	}
})();
