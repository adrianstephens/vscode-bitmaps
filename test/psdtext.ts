import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';
const {openPage} = require('./pagehost');

// The text layers of PSDs (npx ts-node test/psdtext.ts file.psd...): each reads, and reads back the same after withText, also with its
// text changed; runs follow edits of the text; and a new text layer reads back. The text code runs in a page (pagehost.js), as in the
// viewer. (The engine data's own round trip is the package's to test.)
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { bad++; console.log('FAIL', what); } };

(async () => {
	const view = await openPage({modules: {t: 'textedit.js?internals'}});
	for (const file of process.argv.slice(2)) {
		const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(file)));
		let n = 0;
		for (let i = 0, layer: any; (layer = psd.getLayer(i)); i++) {
			if (!layer.blocks?.TySh)
				continue;
			n++;
			const r = await view.evaluate((blocks: unknown) => {
				const t = (window as any).t, spec = t.readText(blocks);
				if (!spec)
					return null;
				const runs = (s: any) => JSON.stringify(s.runs.map((r: any) => [r.length, r.style.font, r.style.size, r.style.colour]));
				const back = t.readText(t.withText(blocks, spec));
				const text = 'Hello\rWorld\r';
				const edited = t.readText(t.withText(blocks, {...spec, text, runs: t.reflowRuns(spec.runs, spec.text, text), paras: [{...spec.paras[0], length: 6}, {...spec.paras[0], length: 6}]}));
				return {
					text: spec.text, box: spec.box ?? null,
					runs: spec.runs.map((r: any) => `${r.length}:${r.style.font}@${r.style.size} #${[r.style.colour.r, r.style.colour.g, r.style.colour.b].map((v: number) => v.toString(16).padStart(2, '0')).join('')}`).join(' '),
					paras: spec.paras.map((p: any) => `${p.length}:${p.justification}`).join(' '),
					sameRuns: runs(back) === runs(spec), sameText: back.text === spec.text,
					edited: edited.text === text && edited.runs.reduce((a: number, r: any) => a + r.length, 0) === 12,
				};
			}, layer.blocks);
			check(!!r, `${layer.name}: read`);
			if (!r)
				continue;
			console.log(file.split('/').pop(), JSON.stringify(layer.name), JSON.stringify(r.text), r.runs, r.paras, r.box ? JSON.stringify(r.box) : 'point');
			check(r.sameRuns, `${layer.name}: runs after withText`);
			check(r.sameText, `${layer.name}: text after withText`);
			check(r.edited, `${layer.name}: edited`);
		}
		console.log(file.split('/').pop(), n, 'text layers');
	}

	// the runs follow the text, and a new layer reads back
	const r = await view.evaluate(() => {
		const t = (window as any).t, runs = [{length: 5}, {length: 5}];
		const lens = (r: {length: number}[]) => r.map(x => x.length).join(',');
		const spec = t.readText(t.newTextBlocks('Hi there', {x: 10, y: 50}, t.defaultStyle('ArialMT', 40, {r: 255, g: 0, b: 0})));
		return {
			insert:		lens(t.reflowRuns(runs, 'abcdefghij', 'abcXdefghij')),
			boundary:	lens(t.reflowRuns(runs, 'abcdefghij', 'abcdeXfghij')),
			across:		lens(t.reflowRuns(runs, 'abcdefghij', 'abfghij')),
			whole:		lens(t.reflowRuns(runs, 'abcdefghij', 'abcde')),
			append:		lens(t.reflowRuns(runs, 'abcdefghij', 'abcdefghijk')),
			fresh:		!!spec && spec.text === 'Hi there\r' && spec.runs[0].style.size === 40 && spec.runs[0].style.font === 'ArialMT' && spec.runs[0].style.colour.r === 255,
		};
	});
	check(r.insert === '6,5', 'insert in the first run');
	check(r.boundary === '6,5', 'insert at the boundary goes in the run before');
	check(r.across === '2,5', 'delete across the boundary');
	check(r.whole === '5', 'delete a whole run');
	check(r.append === '5,6', 'append');
	check(r.fresh, 'new layer reads back');
	await view.close();
	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exitCode = bad ? 1 : 0;
})();
