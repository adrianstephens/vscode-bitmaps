import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';

// The adjustment layers a PSD has, as the package reads them (npx ts-node test/psdadjust.ts file.psd): each layer with one of the keys
// below, and what its block holds.
const keys = ['nvrt', 'thrs', 'post', 'brit', 'levl', 'curv', 'hue2', 'blwh', 'blnc', 'vibA', 'expA', 'mixr', 'selc', 'phfl', 'grdm'];

(async () => {
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(process.argv[2])));
	for (let i = 0, l: any; (l = psd.getLayer(i)); i++) {
		for (const k of keys) {
			const b = l.blocks?.[k];
			if (b)
				console.log(i, JSON.stringify(l.name), k, JSON.stringify(b, (n, v) => n === 'padding' || n === 'data' ? `${(v as any)?.length ?? 0} bytes` : v instanceof Uint8Array ? `${v.length} bytes` : v).slice(0, 700));
		}
	}
})();
