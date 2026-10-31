import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';
const show = (v: any, d = 0): string => {
	const pad = '  '.repeat(d);
	if (Array.isArray(v)) return '[\n' + v.map(x => pad + '  ' + show(x, d + 1)).join('\n') + '\n' + pad + ']';
	if (v && typeof v === 'object') {
		if ('items' in v && 'classId' in v) return `Objc ${v.classId} {\n` + v.items.map((i: any) => `${pad}  ${i.key}: ${show(i.value, d + 1)}`).join('\n') + `\n${pad}}`;
		if ('type' in v && 'value' in v && !(v.value instanceof Uint8Array)) return `${v.type}${v.unit ? ' ' + v.unit : ''} ${typeof v.value === 'object' ? show(v.value, d) : JSON.stringify(v.value)}${v.typeId ? ' (' + v.typeId + ')' : ''}`;
		return JSON.stringify(v, (k, x) => k === '_' ? undefined : x);
	}
	return String(v);
};
(async () => {
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync('/private/tmp/claude-501/-Volumes-DevSSD-dev-vscode-extensions-bitmaps/29f2f51c-cd0b-42ed-bb3d-434c32880c04/scratchpad/gradshape.copy.psd')));
	console.log(psd.width, 'x', psd.height);
	for (let i = 0, l; (l = psd.getLayer(i)); i++) {
		console.log('LAYER', i, JSON.stringify(l.name), 'rect', l.left, l.top, l.width, l.height, l.blocks?.map(b => b.key).join(','));
		for (const b of l.blocks ?? []) {
			if (b.key === 'vstk') console.log(show((b as any).descriptor, 1).split('\n').filter((x: string) => /strokeEnabled|fillEnabled|LineWidth|Align|DashSet|#Nne|Content|classId|Type|Rd  |Grn |Bl  |Lctn|Angl|Scl |Algn|Rvrs|Ofst|Hrzn|Vrtc|Opacity|BlendMode/.test(x)).join('\n'));
			if (b.key === 'lfx2') {
				const d = (b as any).descriptor;
				console.log('  lfx2 keys:', d.items.map((x: any) => x.key + (x.value.value?.items ? '{enab=' + x.value.value.items.find((y: any) => y.key === 'enab')?.value.value + '}' : x.value.type === 'VlLs' ? `[${x.value.value.length}${x.value.value.map((e: any) => e.value.items?.find((y: any) => y.key === 'enab')?.value.value).join('')}]` : '')).join(' '));
				const fr = d.items.find((x: any) => x.key === 'FrFX');
				if (fr) console.log(show(fr.value, 2).split('\n').filter((x: string) => !/Rd  |Grn |Bl  |Mdpn|Lctn|Opct: UntF #Prc 100\b/.test(x)).join('\n'));
			}
		}
	}
})();
