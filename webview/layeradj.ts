// What a PSD layer keeps in its blocks besides its pixels: its layer style (shadows, glows, bevel, overlays, stroke), and the adjustment
// an adjustment layer makes. In three parts: the serialisation reads each from the blocks and writes it back into a copy of them; the
// editing is the menus, which are handed the blocks (BlocksEdit) to show and to record as an edit, and know nothing of undo; and the
// rendering makes the styles as pictures, on the GPU or as layers of their own for the compositor.

import type { psd } from '@isopodlabs/binary_bitmaps';
import { CascadeItem, valueItem, sliderItem, toggleItem, svgFace, valueFace } from './cascade.js';
import { clamp01 } from './colour.js';
import { Colour, solidFillSpec, gradientSpec, gradientDefaults } from './shapeedit.js';
import { LayerBlocks, writeWith, put, Bool, Double, Long, Default, Optional, readSpec, E } from './psdblocks.js';

//=============================================================================
//	serialisation: what a layer's blocks keep (styles, adjustments), read into values and written back
//=============================================================================

/** What an adjustment layer does to the colours below it: a table (the composite, then red, green and blue, each of 256 values),
 *  or a threshold of the luminance. */
export type Adjustment =
	| {kind: 'table', table: Uint8ClampedArray}
	| {kind: 'threshold', level: number}
	| {kind: 'balance', tones: number[][], preserve: boolean}	// colour balance: for shadows, midtones and highlights, the shift of red, green and blue, -1..1
	| {kind: 'mono', weights: number[]}	// black and white: what red, yellow, green, cyan, blue and magenta come out as, 0..1
	| {kind: 'hue', hue: number, saturation: number, lightness: number};	// hue in degrees, the others as -1..1

// four tables, the first the composite's, from one function of the value, 0..1 (which each channel has the same of unless it is given)
function tables(composite: (v: number) => number, channels: ((v: number) => number)[] = []) {
	const out = new Uint8ClampedArray(1024);
	for (let row = 0; row < 4; row++) {
		const f = row ? channels[row - 1] ?? (v => v) : composite;
		for (let i = 0; i < 256; i++)
			out[row * 256 + i] = Math.round(clamp01(f(i / 255)) * 255);
	}
	return {kind: 'table', table: out} as const;
}

// a natural cubic spline through the points of a curve, as 0..1
function spline(points: {input: number, output: number}[]): (v: number) => number {
	const p = points.map(({input, output}) => ({x: input / 255, y: output / 255})).sort((a, b) => a.x - b.x);
	const n = p.length;
	if (n < 2)
		return v => v;

	// the second derivatives, by the tridiagonal system
	const h = p.slice(1).map((q, i) => q.x - p[i].x), d2 = new Array<number>(n).fill(0), u = new Array<number>(n).fill(0);
	for (let i = 1; i < n - 1; i++) {
		const sig = h[i - 1] / (h[i - 1] + h[i]), t = sig * d2[i - 1] + 2;
		d2[i] = (sig - 1) / t;
		const slope = (p[i + 1].y - p[i].y) / h[i] - (p[i].y - p[i - 1].y) / h[i - 1];
		u[i] = (6 * slope / (h[i - 1] + h[i]) - sig * u[i - 1]) / t;
	}
	for (let i = n - 2; i >= 0; i--)
		d2[i] = d2[i] * d2[i + 1] + u[i];

	return v => {
		if (v <= p[0].x)
			return p[0].y;
		if (v >= p[n - 1].x)
			return p[n - 1].y;
		let k = 0;
		while (p[k + 1].x < v)
			k++;
		const a = (p[k + 1].x - v) / h[k], b = (v - p[k].x) / h[k];
		return a * p[k].y + b * p[k + 1].y + ((a * a * a - a) * d2[k] + (b * b * b - b) * d2[k + 1]) * h[k] * h[k] / 6;
	};
}

const brightnessSpec = {
	brightness:	E('Brgh',  Optional(Double)),
	contrast:	E('Cntr',  Optional(Double)),
	mean:		E('means', Optional(Double)),
};
// (newer files keep the settings in 'CgEd' as well as in the block of their own)
function brightnessSettings(blocks: LayerBlocks) {
	const was = readSpec(brightnessSpec, blocks.CgEd?.descriptor.items ?? {});
	return {
		brightness:	was.brightness ?? blocks.brit?.brightness ?? 0,
		contrast:	was.contrast ?? blocks.brit?.contrast ?? 0,
		mean:		was.mean ?? blocks.brit?.mean ?? 127,
	};
}

/** The adjustment a layer is, if it is one (and one that is understood). */
export function adjustment(blocks: LayerBlocks | undefined): Adjustment | undefined {
	if (!blocks)
		return;

	if (blocks.nvrt)
		return tables(v => 1 - v);

	if (blocks.thrs)
		return {kind: 'threshold', level: blocks.thrs.level};

	if (blocks.post) {
		const n = Math.max(2, blocks.post.levels);
		return tables(v => Math.floor(v * 255.999 * n / 256) / (n - 1));
	}

	if (blocks.blnc) {
		const {cyanRed, magentaGreen, yellowBlue, preserveLuminosity} = blocks.blnc;
		return {kind: 'balance', tones: [0, 1, 2].map(t => [cyanRed[t], magentaGreen[t], yellowBlue[t]].map(v => v / 100)), preserve: preserveLuminosity};
	}

	if (blocks.blwh) {
		const i = blocks.blwh.descriptor.items;
		return {kind: 'mono', weights: MONO_KEYS.map(k => readSpec(monoSpec, i)[k] / 100)};
	}

	if (blocks.hue2 && !blocks.hue2.colorize) {
		// (the master only: what is asked of one range of colours is not done)
		const {hue, saturation, lightness} = blocks.hue2.master;
		return {kind: 'hue', hue, saturation: saturation / 100, lightness: lightness / 100};
	}

	if (blocks.brit) {
		// (an approximation: the contrast is a slope about the mean, steeper as it goes to 100; newer files keep the settings in 'CgEd')
		const {brightness, contrast, mean} = brightnessSettings(blocks);
		const slope = contrast >= 0 ? 1 / (1 - Math.min(contrast, 99) / 100) : 1 + contrast / 100;
		return tables(v => (v - mean / 255) * slope + mean / 255 + brightness / 255);
	}

	if (blocks.levl) {
		const level = ({inputFloor, inputCeiling, outputFloor, outputCeiling, gamma}: typeof blocks.levl.records[number]) => (v: number) =>
			(outputFloor + Math.pow(clamp01((v * 255 - inputFloor) / Math.max(1, inputCeiling - inputFloor)), 1 / gamma) * (outputCeiling - outputFloor)) / 255;
		const [composite, ...channels] = blocks.levl.records;
		return tables(level(composite), channels.slice(0, 3).map(level));
	}

	if (blocks.curv) {
		// (a curve for each bit of the channels, the composite's first)
		const curves = new Map<number, (v: number) => number>();
		let k = 0;
		for (let bit = 0; bit < 32; bit++) {
			if (blocks.curv.channels & (1 << bit))
				curves.set(bit, spline(blocks.curv.curves[k++]));
		}
		return tables(curves.get(0) ?? (v => v), [1, 2, 3].map(bit => curves.get(bit) ?? (v => v)));
	}
}

/** The block of a layer's that makes it an adjustment layer, if there is one, in the order `adjustment` looks for them. */
const ADJUSTMENTS = ['nvrt', 'thrs', 'post', 'blnc', 'blwh', 'hue2', 'brit', 'levl', 'curv'] as const;
type AdjustmentKey = typeof ADJUSTMENTS[number];
type AdjustmentKeyX = AdjustmentKey | 'SoCo'| 'GdFl';

export function adjustmentKey(blocks: LayerBlocks | undefined): AdjustmentKey | undefined {
	return ADJUSTMENTS.find(k => blocks?.[k]);
}

// a hue/saturation's ranges, as Photoshop has them new: reds, yellows, greens, cyans, blues and magentas, each where it starts and is
// full, and where it is full to and ends
const HUE_RANGES = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];

/** The block a new adjustment layer of this kind has, as Photoshop makes it: one that changes nothing yet (an invert apart, and a fill,
 *  which is white or black to white). */
export function newAdjustment(key: AdjustmentKeyX): LayerBlocks {
	const identity = {inputFloor: 0, inputCeiling: 255, outputFloor: 0, outputCeiling: 255, gamma: 1};
	// (each as the package declares it, but for what every block has)
	const blocks: {[K in AdjustmentKeyX]: Omit<NonNullable<LayerBlocks[K]>, 'signature' | 'key' | 'padding'>} = {
		SoCo:	{version: 16, descriptor: {name: '', classId: 'null', items: put({}, solidFillSpec, {colour: {r: 255, g: 255, b: 255}})}},
		GdFl:	{version: 16, descriptor: {name: '', classId: 'null', items: put({}, gradientSpec, gradientDefaults)}},
		nvrt:	{},
		thrs:	{level: 128},
		post:	{levels: 4},
		blnc:	{cyanRed: [0, 0, 0], magentaGreen: [0, 0, 0], yellowBlue: [0, 0, 0], preserveLuminosity: true},
		blwh:	{version: 16, descriptor: {name: '', classId: 'null', items: put({}, blwhSpec, {
			Rd: 40, Yllw: 60, Grn: 40, Cyn: 60, Bl: 20, Mgnt: 80, useTint: false, tint: {r: 225, g: 211, b: 179},
		})}},
		hue2:	{version: 2, colorize: false, reserved: 0, colorization: {hue: 0, saturation: 25, lightness: 0}, master: {hue: 0, saturation: 0, lightness: 0},
			ranges: HUE_RANGES.map(bounds => ({bounds, hue: 0, saturation: 0, lightness: 0}))},
		brit:	{brightness: 0, contrast: 0, mean: 127, labOnly: false},
		levl:	{version: 2, records: Array.from({length: 29}, () => ({...identity}))},
		curv:	{flags: 0, version: 1, channels: 1, curves: [[{output: 0, input: 0}, {output: 255, input: 255}]]},
	};
	return {[key]: {key, ...blocks[key]}} as LayerBlocks;
}

/** What a black and white adjustment makes of red, yellow, green, cyan, blue and magenta, as the descriptor keeps them (percentages). */
const MONO_KEYS = ['Rd', 'Yllw', 'Grn', 'Cyn', 'Bl', 'Mgnt'] as const;
function fromEntries<K extends PropertyKey, V>(entries: Iterable<readonly [K, V]>) { return Object.fromEntries(entries) as Record<K, V>; }

const monoSpec = fromEntries(MONO_KEYS.map(k => [k, E(k, Default(Long, 0))]));

const blwhSpec = {...monoSpec, useTint: E('useTint', Bool), tint: E('tintColor', Colour)};

function monoWeight(blocks: LayerBlocks, key: typeof MONO_KEYS[number]) {
	return readSpec(monoSpec, blocks.blwh?.descriptor.items ?? {})[key];
}

function withMonoWeight(blocks: LayerBlocks, key: typeof MONO_KEYS[number], value: number): LayerBlocks {
	return writeWith(blocks, blocks.blwh, i => { put(i, monoSpec, {[key]: Math.round(value)}); });
}

/** The blocks with a brightness/contrast's settings changed: in its own block, and in the descriptor newer files keep them in as well. */
function withBrightness(blocks: LayerBlocks, brightness: number, contrast: number): LayerBlocks {
	if (!blocks.brit)
		return blocks;
	const out = {...blocks, brit: {...blocks.brit, brightness, contrast}};
	return writeWith(out, out.CgEd, i => {
		for (const [key, v] of [['Brgh', brightness], ['Cntr', contrast]] as const) {
			const value = i[key];
			if (value && typeof value.value === 'number')
				value.value = v;
		}
	});
}

/** A brightness/contrast's settings, from the descriptor newer files keep them in, or else its own block. */
function brightnessOf(blocks: LayerBlocks) {
	const {brightness, contrast} = brightnessSettings(blocks);
	return {brightness, contrast};
}

//-----------------------------------------------------------------------------
// editing
//-----------------------------------------------------------------------------

/** The kinds of adjustment layer there are, by the block that makes one, as a menu names them (and a new layer is named). */
const ADJUSTMENT_NAMES: Record<AdjustmentKeyX, {name: string, short: string, icon: string}> = {
	SoCo:	{name: 'Solid Colour',			short: 'SoCo',	icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor"/>'},
	GdFl:	{name: 'Gradient',				short: 'Grad',	icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 3v10" opacity="0.25" stroke-width="2.4"/><path d="M8 3v10" opacity="0.55" stroke-width="2.4"/><path d="M11 3v10" opacity="0.9" stroke-width="2.4"/>'},
	brit:	{name: 'Brightness/Contrast',	short: 'Brit',	icon: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/><path d="M8 5a3 3 0 0 1 0 6z" fill="currentColor"/>'},
	levl:	{name: 'Levels',				short: 'Lvls',	icon: '<path d="M2 13.5h12M3.5 13V9M6 13V5M8.5 13V7M11 13V10"/>'},
	curv:	{name: 'Curves',				short: 'Crvs',	icon: '<rect x="2" y="2" width="12" height="12"/><path d="M2 14C6 14 6 9 8 8S10 2 14 2"/>'},
	hue2:	{name: 'Hue/Saturation',		short: 'Hue',	icon: '<circle cx="8" cy="8" r="5.5" stroke-width="3" stroke-dasharray="5.8 5.8 5.8 5.8 5.8 5.8" opacity="0.35"/><circle cx="8" cy="8" r="2"/>'},
	blnc:	{name: 'Colour Balance',		short: 'Bal',	icon: '<circle cx="6" cy="6" r="3.3"/><circle cx="10" cy="6" r="3.3"/><circle cx="8" cy="10" r="3.3"/>'},
	blwh:	{name: 'Black & White',			short: 'B&W',	icon: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M8 2.5h5.5v11H8z" fill="currentColor"/>'},
	nvrt:	{name: 'Invert',				short: 'Inv',	icon: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 2.5L13.5 13.5H2.5z" fill="currentColor"/>'},
	post:	{name: 'Posterize',				short: 'Post',	icon: '<path d="M2 13.5v-3h3v-3h3v-3h3v-3h3v12z" fill="currentColor" fill-opacity="0.35"/><path d="M2 13.5v-3h3v-3h3v-3h3v-3h3"/>'},
	thrs:	{name: 'Threshold',				short: 'Thr',	icon: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 13.5V8H8V2.5h5.5v11z" fill="currentColor"/>'},
};

interface BlocksEdit {
	get():		psd.LayerBlocks | undefined;
	put(blocks: psd.LayerBlocks, final: boolean): void;
}

const icons = {
	add:		'<circle cx="8" cy="8" r="5"/><path d="M8 5.5V10.5M5.5 8H10.5"/>',
	remove:		'<rect x="3" y="3" width="10" height="10"/><path d="M5 5L11 11M11 5L5 11"/>',
	preserve:	'<path d="M8 2v12"/><circle cx="8" cy="8" r="5.5"/>',
	adjust:		'<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>',
};

/** The icon of an adjustment layer of this kind. */
export function adjustmentFace(blocks: LayerBlocks | undefined) {
	const key = adjustmentKey(blocks);
	return key && svgFace(ADJUSTMENT_NAMES[key].icon);
}

/** A new adjustment layer, of any kind: `add` is given its name and its blocks. */
export function newAdjustmentItem(add: (name: string, blocks: psd.LayerBlocks) => void): CascadeItem {
	return {
		id:			'new-adjustment',
		face:		() => svgFace(icons.adjust),
		caption:	() => 'New adjustment layer',
		children:	() => Object.entries(ADJUSTMENT_NAMES).map(([key, {name, short, icon}]) => ({
			id:			`new-${key}`,
			face:		() => svgFace(icon),
			caption:	() => name,
			select:		() => { add(name, newAdjustment(key as AdjustmentKeyX)); },
		})),
	};
}

const CHANNELS = ['RGB', 'Red', 'Green', 'Blue'];

/** The settings of the adjustment a layer makes, if it is an adjustment layer (and one that has settings: an invert has none). */
export function adjustmentItem(edit: BlocksEdit): CascadeItem | undefined {
	const key = adjustmentKey(edit.get());
	if (!key || key === 'nvrt')
		return;

	const blocks = () => edit.get() ?? {};
	// a block of the blocks, changed (a copy of it, and of the blocks)
	const block = <K extends AdjustmentKey>(k: K) => blocks()[k]!;
	const put = <K extends AdjustmentKey>(k: K, change: (b: NonNullable<psd.LayerBlocks[K]>) => void, final: boolean) => {
		const copy = structuredClone(block(k)), was = JSON.stringify(copy);
		change(copy);
		if (JSON.stringify(copy) !== was)
			edit.put({...blocks(), [k]: copy}, final);
	};

	const step	= (by: number) => (v: number, steps: number) => v + by * steps;
	const value	= (label: string, caption: string, min: number, max: number, markers: number|number[], get: () => number, set: (v: number) => void, by = 1): CascadeItem =>
		({...sliderItem({label, caption, min, max, markers, get, set, step: step(by)}), id: `${key}-${label.replace(/\W/g, '')}`});
	// a group of settings, as an icon they come out of
	const group = (id: string, short: string, caption: string, children: () => CascadeItem[]): CascadeItem =>
		({id, face: () => valueFace('', short), caption: () => caption, children});

	const settings = (): CascadeItem[] => {
		switch (key) {
			default: return [];
			case 'thrs':
				return [value('level', 'Threshold level', 1, 255, 5, () => block('thrs').level, v => put('thrs', b => { b.level = v; }, false))];

			case 'post':
				return [value('levels', 'Levels', 2, 255, [2, 4, 8, 16, 32], () => block('post').levels, v => put('post', b => { b.levels = v; }, false))];

			case 'brit': {
				const now = () => brightnessOf(blocks());
				return [
					value('brit', 'Brightness', -150, 150, 5, () => now().brightness, v => edit.put(withBrightness(blocks(), v, now().contrast), false), 5),
					value('cntr', 'Contrast', -50, 100, 4, () => now().contrast, v => edit.put(withBrightness(blocks(), now().brightness, v), false), 5),
				];
			}

			case 'hue2':
				return [
					value('hue', 'Hue (degrees)', -180, 180, 5, () => block('hue2').master.hue, v => put('hue2', b => { b.master.hue = v; }, false), 5),
					value('sat', 'Saturation', -100, 100, 5, () => block('hue2').master.saturation, v => put('hue2', b => { b.master.saturation = v; }, false), 5),
					value('light', 'Lightness', -100, 100, 5, () => block('hue2').master.lightness, v => put('hue2', b => { b.master.lightness = v; }, false), 5),
				];

			case 'blnc': {
				const axes = [['cyanRed', 'Cyan - Red', 'C/R'], ['magentaGreen', 'Magenta - Green', 'M/G'], ['yellowBlue', 'Yellow - Blue', 'Y/B']] as const;
				return [
					...['Shadows', 'Midtones', 'Highlights'].map((tone, t) => group(`balance-${t}`, tone.slice(0, 4), tone, () => axes.map(([axis, caption, label]) =>
						value(label, caption, -100, 100, 5, () => block('blnc')[axis][t], v => put('blnc', b => { b[axis][t] = v; }, false), 5)))),
					toggleItem('Preserve luminosity', svgFace(icons.preserve), () => block('blnc').preserveLuminosity, v => put('blnc', b => { b.preserveLuminosity = v; }, true)),
				];
			}

			case 'blwh':
				return MONO_KEYS.map((k, i) => value(['R', 'Y', 'G', 'C', 'B', 'M'][i], `${['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'][i]} (%)`, -200, 300, [-200, -100, 0, 100, 200, 300],
					() => monoWeight(blocks(), k), v => edit.put(withMonoWeight(blocks(), k, v), false), 5));

			case 'levl':
				return CHANNELS.map((channel, c) => {
					const record = () => block('levl').records[c];
					const set = (change: (r: psd.LevelsRecord) => void) => put('levl', b => change(b.records[c]), false);
					return group(`levels-${c}`, channel.slice(0, 3), `${channel} levels`, () => [
						value('in lo', 'Input black', 0, 253, [0, 64, 128, 192, 253], () => record().inputFloor, v => set(r => { r.inputFloor = Math.min(v, r.inputCeiling - 2); }), 2),
						valueItem({
							label: 'gamma', caption: 'Gamma', min: 0.1, max: 9.99, presets: [0.25, 0.5, 1, 2, 4], resolution: 0.01, format: v => v.toFixed(2),
							get: () => record().gamma, set: v => set(r => { r.gamma = Math.round(v * 100) / 100; }),
							step: (v, steps) => Math.round(v * 1.05 ** steps * 100) / 100,
						}),
						value('in hi', 'Input white', 2, 255, [2, 64, 128, 192, 255], () => record().inputCeiling, v => set(r => { r.inputCeiling = Math.max(v, r.inputFloor + 2); }), 2),
						value('out lo', 'Output black', 0, 255, 5, () => record().outputFloor, v => set(r => { r.outputFloor = v; }), 2),
						value('out hi', 'Output white', 0, 255, 5, () => record().outputCeiling, v => set(r => { r.outputCeiling = v; }), 2),
					]);
				});

			case 'curv':
				return CHANNELS.map((channel, c) => group(`curve-${c}`, channel.slice(0, 3), `${channel} curve`, () => curveItems(c)));
		}
	};

	// A channel's curve: its points (each with where it is in and out, and taken away, if there are more than two), and a point to add
	// in the widest gap. A channel the layer has no curve for has a straight one, until it is changed. (the copy of the curves a file
	// keeps after them, in its newer form, would no longer be the same: it is left out, and the curves are read as they are)
	const curveOf = (c: number) => {
		const b = block('curv'), at = bitsBelow(b.channels, c);
		return b.channels & (1 << c) ? b.curves[at] : [{output: 0, input: 0}, {output: 255, input: 255}];
	};
	const putCurve = (c: number, change: (points: {output: number, input: number}[]) => void, final: boolean) => put('curv', b => {
		if (!(b.channels & (1 << c))) {
			b.curves.splice(bitsBelow(b.channels, c), 0, [{output: 0, input: 0}, {output: 255, input: 255}]);
			b.channels |= 1 << c;
		}
		const points = b.curves[bitsBelow(b.channels, c)];
		change(points);
		points.sort((p, q) => p.input - q.input);
		b.padding = undefined;
	}, final);

	const curveItems = (c: number): CascadeItem[] => [
		...curveOf(c).map((_, k): CascadeItem => {
			const point = () => curveOf(c)[k] ?? {input: 0, output: 0};
			// (a point stays between the ones either side of it)
			const between = (points: {input: number}[], v: number) => Math.max(k ? points[k - 1].input + 1 : 0, Math.min(k < points.length - 1 ? points[k + 1].input - 1 : 255, v));
			return {
				id:			`curve-${c}-${k}`,
				face:		() => valueFace(String(point().input), String(point().output)),
				caption:	() => `Point: in ${point().input}, out ${point().output}`,
				children:	() => [
					value('in', 'Input', 0, 255, 5, () => point().input, v => putCurve(c, p => { if (p[k]) p[k].input = between(p, v); }, false), 2),
					value('out', 'Output', 0, 255, 5, () => point().output, v => putCurve(c, p => { if (p[k]) p[k].output = v; }, false), 2),
					...(curveOf(c).length > 2 ? [{id: `curve-${c}-${k}-remove`, face: () => svgFace(icons.remove), caption: () => 'Remove the point', select: () => { putCurve(c, p => { p.splice(k, 1); }, true); }}] : []),
				],
			};
		}),
		{
			id:			`curve-${c}-add`,
			face:		() => svgFace(icons.add),
			caption:	() => 'Add a point',
			select:		() => {
				putCurve(c, p => {
					let gap = 0;
					for (let i = 1; i < p.length; i++)
						if (p[i].input - p[i - 1].input > p[gap + 1].input - p[gap].input)
							gap = i - 1;
					const a = p[gap], b = p[gap + 1];
					if (b.input - a.input >= 2)
						p.push({input: Math.round((a.input + b.input) / 2), output: Math.round((a.output + b.output) / 2)});
				}, true);
				return true;
			},
		},
	];

	return {
		id:			'adjustment',
		face:		() => valueFace('adj', ADJUSTMENT_NAMES[key].short),
		caption:	() => `Adjustment: ${ADJUSTMENT_NAMES[key].name}`,
		children:	settings,
	};
}

// how many of the bits below this one are set: where a channel's curve is among those there are
const bitsBelow = (bits: number, bit: number) => (bits & ((1 << bit) - 1)).toString(2).replace(/0/g, '').length;

