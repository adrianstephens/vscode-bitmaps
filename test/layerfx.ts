import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import type { psd } from '@isopodlabs/binary_bitmaps';
import { solidColour, withSolidColour, layerStyle, withLayerStyle, newEffect, emptyStyle, adjustment, newAdjustment, ADJUSTMENTS, withBrightness, brightnessOf, withMonoWeight, monoWeight, type LayerStyle } from '../webview/psdblocks';

// What the layer style and adjustment menus write (layerfx.ts), through the package's PSD writer and back (npx ts-node test/layerfx.ts
// file.psd...): a style written as it was read reads the same; an edited one, and one made from nothing, read as they were written after
// a save; and a new adjustment layer of each kind, and edits to some, come back as the same adjustment.

let bad = 0;
const check = (what: string, ok: boolean, detail = '') => {
	if (!ok) {
		bad++;
		console.log('FAIL', what, detail);
	}
};
// (numbers to a few places, as percentages are kept times a hundred; and keys in order, which is not what is compared)
const text = (v: unknown) => JSON.stringify(v, (_, x) =>
	typeof x === 'number' ? Math.round(x * 1e6) / 1e6
	: x instanceof Uint8Array || x instanceof Uint8ClampedArray ? Array.from(x)
	: x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
	: x);
const same = (what: string, a: unknown, b: unknown) => check(what, text(a) === text(b), `\n  ${String(text(a)).slice(0, 600)}\n  ${String(text(b)).slice(0, 600)}`);

// a PSD saved with some of its layers' blocks replaced, and read again
async function resave(file: bitmap.PSD, blocks: Map<number, psd.LayerBlocks>) {
	const image = Object.create(file) as bitmap.PSD;
	image.getLayer = (i: number | string) => {
		const layer = file.getLayer(i);
		if (layer && typeof i === 'number' && blocks.has(i))
			layer.blocks = blocks.get(i);
		return layer;
	};
	return bitmap.PSD.load(await bitmap.PSD.save(image));
}

(async () => {
	for (const name of process.argv.slice(2)) {
		const file = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(name)));
		const short = name.split('/').pop()!;
		const edits = new Map<number, psd.LayerBlocks>(), expect = new Map<number, LayerStyle>();
		let plain = -1;

		for (let i = 0, layer; (layer = file.getLayer(i)); i++) {
			const blocks = layer.blocks ?? {};
			const style = layerStyle(blocks);
			if (!style) {
				if (plain < 0 && !blocks.vmsk && !blocks.vsms && !ADJUSTMENTS.some(k => blocks[k]))
					plain = i;
				continue;
			}
			same(`${short} ${i} ${layer.name}: written as read`, layerStyle(withLayerStyle(blocks, style)), style);

			// an edit of each effect it has, and a drop shadow if it has none
			const edited = structuredClone(style);
			if (!edited.dropShadows.length)
				edited.dropShadows.push(newEffect.dropShadow());
			for (const s of [...edited.dropShadows, ...edited.innerShadows]) {
				s.size = 17;
				s.angle = 33;
				s.globalLight = false;
				s.choke = 0.4;
				s.blend = 'scrn';
			}
			for (const g of [edited.outerGlow, edited.innerGlow])
				if (g) { g.range = 0.3; g.technique = 'precise'; g.colour = {r: 10, g: 20, b: 30}; }
			if (edited.stroke)
				edited.stroke.width = 9;
			if (edited.gradientOverlay)
				edited.gradientOverlay.stops[0].color = {r: 1, g: 2, b: 3};
			edited.enabled = !edited.enabled;
			edits.set(i, withLayerStyle(blocks, edited));
			expect.set(i, edited);
		}

		// every effect, on a layer that had no style
		if (plain >= 0) {
			const all: LayerStyle = {...emptyStyle(),
				dropShadows: [newEffect.dropShadow()], innerShadows: [newEffect.innerShadow()], outerGlow: newEffect.outerGlow(), innerGlow: newEffect.innerGlow(),
				bevel: newEffect.bevel(), colourOverlays: [newEffect.colourOverlay()], gradientOverlay: newEffect.gradientOverlay(), stroke: newEffect.stroke(),
			};
			edits.set(plain, withLayerStyle(file.getLayer(plain)!.blocks ?? {}, all));
			expect.set(plain, all);
		}

		const again = await resave(file, edits);
		for (const [i, style] of expect)
			same(`${short} ${i}: after a save`, layerStyle(again.getLayer(i)!.blocks), style);
		console.log(short, `${expect.size} styles written and read back`);
	}

	// a new adjustment layer of each kind, and some edited, on the first layer of the first file
	const name = process.argv[2];
	if (name) {
		for (const key of ADJUSTMENTS) {
			const file = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(name)));
			let blocks = newAdjustment(key);
			if (key === 'brit')
				blocks = withBrightness(blocks, 40, -20);
			if (key === 'blwh')
				blocks = withMonoWeight(blocks, 'Grn', 140);
			if (key === 'curv')
				blocks = {...blocks, curv: {...blocks.curv!, curves: [[{output: 0, input: 0}, {output: 200, input: 100}, {output: 255, input: 255}]]}};
			if (key === 'SoCo')
				blocks = withSolidColour(blocks, {r: 12, g: 200, b: 99});
			if (key === 'levl')
				blocks.levl!.records[2] = {inputFloor: 10, inputCeiling: 240, outputFloor: 5, outputCeiling: 250, gamma: 1.5};
			const back = (await resave(file, new Map([[0, blocks]]))).getLayer(0)!.blocks;
			check(`new ${key}: kept`, !!back?.[key]);
			same(`new ${key}: the same adjustment`, adjustment(back), adjustment(blocks));
			if (key === 'SoCo')
				same('solid colour fill', solidColour(back), {r: 12, g: 200, b: 99});
			if (key === 'brit')
				same('brightness', brightnessOf(back!), {brightness: 40, contrast: -20});
			if (key === 'blwh')
				same('black and white green', monoWeight(back!, 'Grn'), 140);
		}
		console.log(`${ADJUSTMENTS.length} new adjustment kinds written and read back`);
	}
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exitCode = bad ? 1 : 0;
})();
