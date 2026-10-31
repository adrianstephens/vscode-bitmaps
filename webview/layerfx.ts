// What a PSD layer keeps in its blocks besides its pixels: its layer style (shadows, glows, bevel, overlays, stroke), and the adjustment
// an adjustment layer makes. In three parts: the serialisation reads each from the blocks and writes it back into a copy of them; the
// editing is the menus, which are handed the blocks (BlocksEdit) to show and to record as an edit, and know nothing of undo; and the
// rendering makes the styles as pictures, on the GPU or as layers of their own for the compositor.

import { float2 } from '@isopodlabs/maths/vector';
import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { type Canvas3D, type ShaderProgram, type Offscreen, imageRect } from './opengl.js';
import { Shape, strokeAlpha } from './raster.js';
import { gradientStyle, type GradientFill } from './shapeedit.js';
import type { psd } from '@isopodlabs/binary_bitmaps';

import { CascadeItem, valueItem, toggleItem, choiceItem, colourItems, svgFace, valueFace, swatchFace, multiplicativeStep } from './cascade.js';
import { type RGB, toHex, clamp01, lerp } from './colour.js';
import { Colour, solidOf, isSolid, validGradient, gradientSpec, gradientDefaults, BLEND_MODE, LOCATIONS, shapeOf, findVectorMask, vectorMask, ownFill, Vec2 } from './shapeedit.js';
import type { Layer, LayerMask, PixelLayer, BlocksEdit } from './layers.js';
import { Value, Items, LayerBlocks, items, list, one, E, SpecOf, Specs, merge, fill, put, mergeList, Bool, BoolOr, Percent, Double, Unit, Text, Obj, Merge, List, Lookup, Union, Default, Optional, readSpec, writeSpec, Post, fromList} from './psdblocks.js';

//=============================================================================
//	serialisation: what a layer's blocks keep (styles, adjustments), read into values and written back
//=============================================================================

// what Photoshop gives a new effect
const black = {r: 0, g: 0, b: 0}, white = {r: 255, g: 255, b: 255}, glowColour = {r: 255, g: 255, b: 190};

//-----------------------------------------------------------------------------
//	strokes
//-----------------------------------------------------------------------------

// A style's stroke has its paint among its own items, which of them depending on the kind of paint it says it is (a pattern's is not made).
const PAINT_KIND = Lookup('FrFl', {SClr: 'solid', GrFl: 'gradient', Ptrn: 'pattern'});
const solidPaint = Post(Obj('', {kind: E('PntT', PAINT_KIND), colour: E('Clr', Colour)}), {
	from:	x => x.kind === 'gradient' ? undefined : solidOf(x.colour),
	to:		f => ({kind: 'solid' as const, colour: f.colour}),
});
const gradientPaint = Post(Obj('', {kind: E('PntT', PAINT_KIND), ...gradientSpec}), {
	from:	({kind, ...g}) => kind === 'gradient' ? validGradient(g) : undefined,
	to:		g => ({kind: 'gradient' as const, ...g}),
});
const StylePaint = Union(solidPaint, gradientPaint, isSolid);


//-----------------------------------------------------------------------------
//	effects: where each field of an effect is kept, and how
//-----------------------------------------------------------------------------

const TECHNIQUE		= Lookup('BETE', {SfBL: 'softer', PrBL: 'precise'});
const BEVEL_STYLE	= Lookup('BESl', {OtrB: 'outer', InrB: 'inner', Embs: 'emboss', PlEb: 'pillow', strokeEmboss: 'stroke'});
const BEVEL_TECH	= Lookup('bvlT', {SfBL: 'smooth', PrBL: 'hard', Slmt: 'soft'});
const BEVEL_DIR		= Lookup('BESs', {'In  ': 'up', 'Out ': 'down'});
const GLOW_SOURCE	= Lookup('IGSr', {SrcE: 'edge', SrcC: 'center'});
const STROKE_POS	= Lookup('FStl', {OutF: 'outside', InsF: 'inside', CtrF: 'center'});

/** A contour: the curve that shapes an effect's falloff, as points from (0,0) to (1,1). */
type Contour = float2[];

// the effects keep their curves as points from 0 to 255 in each direction
const Pixels		= Unit('#Pxl');
const Angle			= Unit('#Ang');
const Scaled255 	= Default(Post(Double, {from: n => n / 255, to: (v: number) => v * 255}), 0);
const curve			= Obj('ShpC', {name: E('Nm', Text), points: E('Crv', List(Vec2('CrPt', Scaled255)))});

// (a straight contour is written as Photoshop's linear one, which gives a new effect its contour; any other is the file's own, and is kept)
const straight = (c: {x: number, y: number}[]) => c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
const Curve = {
	from:	(v?: Value): Contour => { const p = curve.from(v)?.points; return p?.length ? p.map(({x, y}) => float2(x, y)) : [float2(0, 0), float2(1, 1)]; },
	to:		(c: Contour) => straight(c) ? curve.to({name: 'Linear', points: c.map(({x, y}) => ({x, y}))}) : undefined,
};

/** What every effect has: whether it is on, and how it is mixed with what is under it. */
const effectSpec = {
	enabled:	E('enab', Bool),
	blend:		E('Md',	  BLEND_MODE),		// a layer's blend mode key
	opacity:	E('Opct', Default(Percent, 1)),							// 0 to 1
};
type Effect = SpecOf<typeof effectSpec>;

/** Drop shadow ('DrSh') and inner shadow ('IrSh'). */
const shadowSpec = {
	...effectSpec,
	colour:		E('Clr',  Default(Colour, black)),
	globalLight: E('uglg', Bool),
	angle:		E('lagl', Default(Angle, 120)),					// degrees
	distance:	E('Dstn', Default(Pixels, 0)),
	choke:		E('Ckmt', Default(Pixels, 0)),					// spread (kept as a percentage with a pixel unit, as Photoshop keeps it)
	size:		E('blur', Default(Pixels, 0)),
	noise:		E('Nose', Default(Percent, 0)),
	antialias:	E('AntA', Bool),
	contour:	E('TrnS', Curve),
	knockout:	E('layerConceals', Optional(Bool)),				// a drop shadow only: the layer knocks the shadow out
};
type Shadow = SpecOf<typeof shadowSpec>;

/** Outer glow ('OrGl') and inner glow ('IrGl'). */
const glowSpec = {
	...effectSpec,
	colour:		E('Clr',  Default(Colour, glowColour)),
	technique:	E('GlwT', Default(TECHNIQUE, 'softer')),
	choke:		E('Ckmt', Default(Pixels, 0)),
	size:		E('blur', Default(Pixels, 0)),
	noise:		E('Nose', Default(Percent, 0)),
	jitter:		E('ShdN', Default(Percent, 0)),
	antialias:	E('AntA', Bool),
	range:		E('Inpr', Default(Percent, 0.5)),
	contour:	E('TrnS', Curve),
	source:		E('glwS', Optional(GLOW_SOURCE)),	// an inner glow only
};
type Glow = SpecOf<typeof glowSpec>;

const satinSpec = {
	...effectSpec,
	colour:		E('Clr',  Default(Colour, black)),
	angle:		E('lagl', Default(Angle, 19)),
	distance:	E('Dstn', Default(Pixels, 0)),
	size:		E('blur', Default(Pixels, 0)),
	invert:		E('Invr', Bool),
	antialias:	E('AntA', Bool),
	contour:	E('MpgS', Curve),
};
type Satin = SpecOf<typeof satinSpec>;

// a bevel's highlight and its shadow each have a colour, a blend mode and an opacity, among the bevel's own items
const tone = (key: 'hgl' | 'sdw', colour: RGB) => Merge({
	colour:		E(key + 'C', Default(Colour, colour)),
	blend:		E(key + 'M', BLEND_MODE),
	opacity:	E(key + 'O', Default(Percent, 0.75)),
});
const bevelSpec = {
	enabled:	E('enab', Bool),
	style:		E('bvlS', Default(BEVEL_STYLE, 'inner')),
	technique:	E('bvlT', Default(BEVEL_TECH, 'smooth')),
	direction:	E('bvlD', Default(BEVEL_DIR, 'up')),
	depth:		E('srgR', Default(Percent, 1)),					// 1 is 100%
	size:		E('blur', Default(Pixels, 0)),
	soften:		E('Sftn', Default(Pixels, 0)),
	globalLight: E('uglg', Bool),
	angle:		E('lagl', Default(Angle, 120)),
	altitude:	E('Lald', Default(Angle, 30)),
	highlight:	tone('hgl', white),
	shadow:		tone('sdw', black),
	glossContour: E('TrnS', Curve),
	antialiasGloss: E('antialiasGloss', Bool),
	contour:	E('useShape', Bool),							// the contour sub-effect
	texture:	E('useTexture', Bool),							// the texture sub-effect
};
type BevelEmboss = SpecOf<typeof bevelSpec>;

const colourOverlaySpec = {
	...effectSpec,
	colour:		E('Clr', Default(Colour, white)),
};
type ColourOverlay = SpecOf<typeof colourOverlaySpec>;

const gradientOverlaySpec = {...effectSpec, ...gradientSpec};
type GradientOverlay = SpecOf<typeof gradientOverlaySpec>;

// (what the file keeps of a pattern is its name and uuid, in an item of its own)
const patternPart = (key: string) => ({from: (v?: Value) => String(items(v)?.[key]?.value ?? ''), to: (_: string) => undefined});
const patternSpec = {
	...effectSpec,
	name:		E('Ptrn',	patternPart('Nm')),
	id:			E('Ptrn',	patternPart('Idnt')),					// the pattern's uuid
	scale:		E('Scl',	Default(Percent, 1)),
	align:		E('Algn',	Bool),
	phase:		E('phase',	Default(Vec2('Pnt ', Double), float2(0, 0))),
};
type PatternOverlay = SpecOf<typeof patternSpec>;

const strokeSpec = {
	...effectSpec,
	align:		E('Styl', 		Default(STROKE_POS, 'outside')),
	width:		E('Sz',   		Default(Pixels, 3)),
	overprint:	E('overprint',	Bool),
	paint:		E('',			StylePaint),
};
type StrokeEffect = SpecOf<typeof strokeSpec>;

const styleSpec = {
	enabled:	E('masterFXSwitch', BoolOr(true)),
	scale:		E('Scl', Default(Percent, 1)),					// 1 is 100%
};
type LayerStyle = SpecOf<typeof styleSpec> & {
	dropShadows:	Shadow[];
	innerShadows:	Shadow[];
	outerGlow?:		Glow;
	innerGlow?:		Glow;
	bevel?:			BevelEmboss;
	satin?:			Satin;
	colourOverlays:	ColourOverlay[];
	gradientOverlay?: GradientOverlay;
	patternOverlay?: PatternOverlay;
	stroke?:		StrokeEffect;
};

function layerStyle(blocks: LayerBlocks | undefined): LayerStyle | undefined {
	const i = blocks?.lfx2?.descriptor.items;
	if (!i)
		return;

	const several	= (multi?: Value, single?: Value) => fromList(multi, single) ? list(multi) : [items(single)!];
	const gradientOf = (x: Items) => validGradient(readSpec(gradientOverlaySpec, x));
	return {
		...readSpec(styleSpec, i),
		dropShadows:	several(i.dropShadowMulti, i.DrSh).map(x => readSpec(shadowSpec, x)),
		innerShadows:	several(i.innerShadowMulti, i.IrSh).map(x => readSpec(shadowSpec, x)),
		outerGlow:		one(i.OrGl, x => readSpec(glowSpec, x)),
		innerGlow:		one(i.IrGl, x => readSpec(glowSpec, x)),
		bevel:			one(i.ebbl, x => readSpec(bevelSpec, x)),
		satin:			one(i.ChFX, x => readSpec(satinSpec, x)),
		colourOverlays:	several(i.solidFillMulti, i.SoFi).map(x => readSpec(colourOverlaySpec, x)),
		gradientOverlay: one(i.GrFl, gradientOf),
		patternOverlay:	one(i.patternFill, x => readSpec(patternSpec, x)),
		stroke:			one(i.FrFX, x => { const s = readSpec(strokeSpec, x); return s.paint ? s : undefined; }),
	};
}

function withLayerStyle(blocks: LayerBlocks, style: LayerStyle): LayerBlocks {
	const block = blocks.lfx2
		? structuredClone(blocks.lfx2)
		: {key: 'lfx2', effectsVersion: 0, version: 16, descriptor: {name: '', classId: 'null', items: {}}} as unknown as NonNullable<LayerBlocks['lfx2']>;
	const i = block.descriptor.items;
	put(i, styleSpec, style);

	// (an effect that the file did not have is shown in Photoshop's list of the effects, as it is in the menu here)
	const shown = writeSpec({present: E('present', Bool), showInDialog: E('showInDialog', Bool)}, {present: true, showInDialog: true});
	const one = <S extends Specs>(key: string, e: SpecOf<S> | undefined, spec: S) => {
		if (e) {
			merge(i, {[key]: Obj(key, spec).to(e)});
			fill(items(i[key])!, shown);
		}
	};
	// what can be had more than once goes where it was read from: the list, or the single effect; a new one is single if it is one
	const several = <S extends Specs>(multi: string, single: string, all: SpecOf<S>[], spec: S) => {
		if (!all.length)
			return;
		const toList = i[multi] || items(i[single]) ? fromList(i[multi], i[single]) : all.length > 1;
		if (toList) {
			i[multi] = mergeList(i[multi], List(Obj(single, spec)).to(all));
			list(i[multi]).forEach(d => fill(d, shown));
		} else
			one(single, all[0], spec);
	};

	several('dropShadowMulti', 'DrSh', style.dropShadows, shadowSpec);
	several('innerShadowMulti', 'IrSh', style.innerShadows, shadowSpec);
	several('solidFillMulti', 'SoFi', style.colourOverlays, colourOverlaySpec);
	one('OrGl', style.outerGlow, glowSpec);
	one('IrGl', style.innerGlow, glowSpec);
	one('ebbl', style.bevel, bevelSpec);
	one('ChFX', style.satin, satinSpec);
	one('GrFl', style.gradientOverlay, gradientOverlaySpec);
	one('patternFill', style.patternOverlay, patternSpec);
	one('FrFX', style.stroke, strokeSpec);
	return {...blocks, lfx2: block};
}

// what Photoshop gives a new effect
const shadowDefaults = (knockout?: boolean): Shadow => ({
	enabled:	true,
	blend:		'mul',
	opacity:	0.75,
	colour:		black,
	globalLight:false,
	angle:		120,
	distance:	5,
	choke:		0,
	size:		5,
	noise:		0,
	antialias:	false,
	contour:	[float2(0, 0), float2(1, 1)],
	knockout,
});
const glowDefaults = (source?: Glow['source']): Glow => ({
	enabled:	true,
	blend:		'scrn',
	opacity:	0.75,
	colour:		glowColour,
	technique:	'softer',
	choke:		0,
	size:		5,
	noise:		0,
	jitter:		0,
	antialias:	false,
	range:		0.5,
	contour:	[float2(0, 0), float2(1, 1)],
	source,
});

/** The effects a style can be given, as Photoshop makes them new. */
export const newEffect = {
	dropShadow:		() => shadowDefaults(true),
	innerShadow:	() => shadowDefaults(),
	outerGlow:		() => glowDefaults(),
	innerGlow:		() => glowDefaults('edge'),
	bevel:			(): BevelEmboss => ({
		enabled: true, style: 'inner', technique: 'smooth', direction: 'up', depth: 1, size: 5, soften: 0, globalLight: false, angle: 120, altitude: 30,
		highlight: {colour: white, blend: 'scrn', opacity: 0.75}, shadow: {colour: black, blend: 'mul', opacity: 0.75},
		glossContour: [float2(0, 0), float2(1, 1)], antialiasGloss: false, contour: false, texture: false,
	}),
	colourOverlay:	(): ColourOverlay => ({enabled: true, blend: 'norm', opacity: 1, colour: {r: 255, g: 0, b: 0}}),
	gradientOverlay: (): GradientOverlay => ({enabled: true, blend: 'norm', opacity: 1, ...gradientDefaults}),
	stroke:			(): StrokeEffect => ({enabled: true, blend: 'norm', opacity: 1, width: 3, align: 'outside', paint: {type: 'solid', colour: black}, overprint: false}),
};

/** A style with nothing in it, for a layer that has none. */
export function emptyStyle(): LayerStyle {
	return {enabled: true, scale: 1, dropShadows: [], innerShadows: [], colourOverlays: []};
}


//=============================================================================
//	editing: the menus that change them
//=============================================================================

/** A layer's blocks, to be read and changed: `final` is false while a value is still being turned or dragged (the page makes the changes
 *  one edit once it is left alone a moment), true when it is chosen. */

const icons = {
	fx:			'<path d="M7 3.5C5.5 3 4.5 4 4.3 5.5L3.3 13"/><path d="M2.5 7.5h4"/><path d="M8.5 7l5 6M13.5 7l-5 6"/>',
	adjust:		'<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>',
	add:		'<circle cx="8" cy="8" r="5"/><path d="M8 5.5V10.5M5.5 8H10.5"/>',
	remove:		'<rect x="3" y="3" width="10" height="10"/><path d="M5 5L11 11M11 5L5 11"/>',
	reverse:	'<path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/>',
	knockout:	'<rect x="2" y="2" width="9" height="9" fill="currentColor" fill-opacity="0.3"/><rect x="5" y="5" width="9" height="9"/>',
	preserve:	'<path d="M8 2v12"/><circle cx="8" cy="8" r="5.5"/>',
};

//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// The modes by kind, with a name and a short name for each, which is how a menu lists them
const BLEND_GROUPS: {name: string, modes: {key: BLEND_MODE, name: string, short: string}[]}[] = [
	{name: 'Normal', modes: [
		{key: 'norm', name: 'Normal', short: 'Norm'}, {key: 'diss', name: 'Dissolve', short: 'Diss'}]},
	{name: 'Darken', modes: [
		{key: 'dark', name: 'Darken', short: 'Dark'}, {key: 'mul', name: 'Multiply', short: 'Mul'}, {key: 'idiv', name: 'Colour Burn', short: 'Burn'},
		{key: 'lbrn', name: 'Linear Burn', short: 'LBrn'}, {key: 'dkCl', name: 'Darker Colour', short: 'DkCl'}]},
	{name: 'Lighten', modes: [
		{key: 'lite', name: 'Lighten', short: 'Lite'}, {key: 'scrn', name: 'Screen', short: 'Scrn'}, {key: 'div', name: 'Colour Dodge', short: 'Dodge'},
		{key: 'lddg', name: 'Linear Dodge (Add)', short: 'Add'}, {key: 'lgCl', name: 'Lighter Colour', short: 'LtCl'}]},
	{name: 'Contrast', modes: [
		{key: 'over', name: 'Overlay', short: 'Over'}, {key: 'sLit', name: 'Soft Light', short: 'Soft'}, {key: 'hLit', name: 'Hard Light', short: 'Hard'},
		{key: 'vLit', name: 'Vivid Light', short: 'Vivid'}, {key: 'lLit', name: 'Linear Light', short: 'LLit'}, {key: 'pLit', name: 'Pin Light', short: 'Pin'},
		{key: 'hMix', name: 'Hard Mix', short: 'Mix'}]},
	{name: 'Comparative', modes: [
		{key: 'diff', name: 'Difference', short: 'Diff'}, {key: 'smud', name: 'Exclusion', short: 'Excl'}, {key: 'fsub', name: 'Subtract', short: 'Sub'},
		{key: 'fdiv', name: 'Divide', short: 'Div'}]},
	{name: 'Component', modes: [
		{key: 'hue', name: 'Hue', short: 'Hue'}, {key: 'sat', name: 'Saturation', short: 'Sat'}, {key: 'colr', name: 'Colour', short: 'Col'},
		{key: 'lum', name: 'Luminosity', short: 'Lum'}]},
];

/** A blend mode chosen from the groups of them; `preview` is told of the one the pointer rests on, and of none when it leaves. */
export function blendItem(get: () => BLEND_MODE, set: (mode: BLEND_MODE) => void, preview?: (mode: BLEND_MODE | undefined) => void): CascadeItem {
	const modes = BLEND_GROUPS.flatMap(g => g.modes);
	const current = () => modes.find(m => m.key === get());
	return {
		id:			'blend',
		face:		() => valueFace('blend', current()?.short ?? 'Norm'),
		caption:	() => `Blend mode: ${current()?.name ?? 'Normal'}`,
		children:	() => BLEND_GROUPS.map(g => ({
			id:			`blend-${g.name.toLowerCase()}`,
			face:		() => valueFace('', g.name.slice(0, 4)),
			caption:	() => g.name,
			active:		() => g.modes.some(m => m.key === get()),
			children:	() => g.modes.map(m => ({
				id:			`blend-${m.key}`,
				face:		() => valueFace('', m.short),
				caption:	() => m.name,
				active:		() => get() === m.key,
				hover:		preview && ((on: boolean) => preview(on ? m.key : undefined)),
				select:		() => { set(m.key); return true; },
			})),
		})),
	};
}

//-----------------------------------------------------------------------------
// controls
//-----------------------------------------------------------------------------

// something of the settings, which a change is made to
interface Edit<T> {
	get():	T;
	set(change: (e: T) => void, final: boolean): void;
}

const step		= (by: number) => (v: number, steps: number) => v + by * steps;

function numberItem<T>(e: Edit<T>, o: {label: string, caption: string, min: number, max: number, presets?: number[], step?: (v: number, steps: number) => number, resolution?: number, format?: (v: number) => string},
	read: (x: T) => number, write: (x: T, v: number) => void): CascadeItem {
	return valueItem({...o, get: () => read(e.get()), set: v => e.set(x => write(x, v), false)});
}

function colourItem(id: string, caption: string, get: () => RGB, set: (c: RGB, final: boolean) => void): CascadeItem {
	return {
		id,
		face:		() => swatchFace(toHex(get())),
		caption:	() => `${caption} ${toHex(get())}`,
		children:	() => colourItems(id, get, set),
	};
}

const opacityItem = <T extends {opacity: number}>(e: Edit<T>, caption = 'Opacity') =>
	numberItem(e, {label: 'opac', caption: `${caption} (%)`, min: 0, max: 100, presets: [0, 25, 50, 75, 100], step: step(5)}, x => Math.round(x.opacity * 100), (x, v) => { x.opacity = v / 100; });

// (a setting of an angle is the effect's own, not the document's global light)
const angleItem = <T extends {angle: number, globalLight: boolean}>(e: Edit<T>) =>
	numberItem(e, {label: 'angle', caption: 'Angle (degrees)', min: -180, max: 180, presets: [-180, -90, 0, 90, 180], step: step(5)}, x => x.angle, (x, v) => { x.angle = v; x.globalLight = false; });

const sizeItem = <T>(e: Edit<T>, caption: string, read: (x: T) => number, write: (x: T, v: number) => void, max = 250) =>
	numberItem(e, {label: caption.slice(0, 4).toLowerCase(), caption: `${caption} (pixels)`, min: 0, max, presets: [0, 5, 10, 20, 50, 100], step: multiplicativeStep()}, read, write);

const spreadItem = <T extends {choke: number}>(e: Edit<T>, caption: string) =>
	numberItem(e, {label: 'sprd', caption: `${caption} (%)`, min: 0, max: 100, presets: [0, 25, 50, 75, 100], step: step(5)}, x => Math.round(x.choke * 100), (x, v) => { x.choke = v / 100; });

function common<T extends Effect>(e: Edit<T>): CascadeItem[] {
	return [
		blendItem(() => e.get().blend, mode => e.set(x => { x.blend = mode; }, true)),
		opacityItem(e),
	];
}

const colourOf = <T extends {colour: RGB}>(id: string, e: Edit<T>, caption = 'Colour') =>
	colourItem(id, caption, () => e.get().colour, (c, final) => e.set(x => { x.colour = c; }, final));

//-----------------------------------------------------------------------------
// the effects' settings
//-----------------------------------------------------------------------------

function shadowSettings(id: string, e: Edit<Shadow>, drop: boolean): CascadeItem[] {
	return [
		colourOf(`${id}-colour`, e),
		...common(e),
		angleItem(e),
		sizeItem(e, 'Distance', x => x.distance, (x, v) => { x.distance = v; }, 1000),
		spreadItem(e, drop ? 'Spread' : 'Choke'),
		sizeItem(e, 'Size', x => x.size, (x, v) => { x.size = v; }),
		...(drop ? [toggleItem('Layer knocks out the shadow', svgFace(icons.knockout), () => e.get().knockout !== false, v => e.set(x => { x.knockout = v; }, true))] : []),
	];
}

function glowSettings(id: string, e: Edit<Glow>, inner: boolean): CascadeItem[] {
	return [
		colourOf(`${id}-colour`, e),
		...common(e),
		choiceItem('Technique', [
			{value: 'softer' as const, face: valueFace('', 'Soft'), caption: 'Softer'},
			{value: 'precise' as const, face: valueFace('', 'Prec'), caption: 'Precise'},
		], () => e.get().technique, v => e.set(x => { x.technique = v; }, true)),
		...(inner ? [choiceItem('Source', [
			{value: 'edge' as const, face: valueFace('', 'Edge'), caption: 'Edge'},
			{value: 'center' as const, face: valueFace('', 'Cntr'), caption: 'Centre'},
		], () => e.get().source ?? 'edge', v => e.set(x => { x.source = v; }, true))] : []),
		spreadItem(e, inner ? 'Choke' : 'Spread'),
		sizeItem(e, 'Size', x => x.size, (x, v) => { x.size = v; }),
		numberItem(e, {label: 'range', caption: 'Range (%)', min: 1, max: 100, presets: [1, 25, 50, 75, 100], step: step(5)}, x => Math.round(x.range * 100), (x, v) => { x.range = v / 100; }),
	];
}

function bevelSettings(id: string, e: Edit<BevelEmboss>): CascadeItem[] {
	// the highlight and the shadow: each a colour, a blend mode and an opacity
	const light = (which: 'highlight' | 'shadow', caption: string): CascadeItem => {
		const part: Edit<BevelEmboss['highlight']> = {get: () => e.get()[which], set: (change, final) => e.set(x => change(x[which]), final)};
		return {
			id:			`${id}-${which}`,
			face:		() => swatchFace(toHex(part.get().colour)),
			caption:	() => `${caption}`,
			children:	() => [
				colourItem(`${id}-${which}-colour`, 'Colour', () => part.get().colour, (c, final) => part.set(x => { x.colour = c; }, final)),
				blendItem(() => part.get().blend as BLEND_MODE, mode => part.set(x => { x.blend = mode; }, true)),
				opacityItem(part),
			],
		};
	};
	return [
		choiceItem('Style', [
			{value: 'inner' as const, face: valueFace('', 'Innr'), caption: 'Inner bevel'},
			{value: 'outer' as const, face: valueFace('', 'Outr'), caption: 'Outer bevel'},
			{value: 'emboss' as const, face: valueFace('', 'Embs'), caption: 'Emboss'},
			{value: 'pillow' as const, face: valueFace('', 'Pilw'), caption: 'Pillow emboss'},
		], () => e.get().style, v => e.set(x => { x.style = v; }, true)),
		choiceItem('Direction', [
			{value: 'up' as const, face: valueFace('', 'Up'), caption: 'Up'},
			{value: 'down' as const, face: valueFace('', 'Down'), caption: 'Down'},
		], () => e.get().direction, v => e.set(x => { x.direction = v; }, true)),
		numberItem(e, {label: 'depth', caption: 'Depth (%)', min: 1, max: 1000, presets: [1, 50, 100, 200, 500, 1000], step: multiplicativeStep()}, x => Math.round(x.depth * 100), (x, v) => { x.depth = v / 100; }),
		sizeItem(e, 'Size', x => x.size, (x, v) => { x.size = v; }),
		angleItem(e),
		numberItem(e, {label: 'alt', caption: 'Altitude (degrees)', min: 0, max: 90, presets: [0, 15, 30, 45, 60, 90], step: step(5)}, x => x.altitude, (x, v) => { x.altitude = v; x.globalLight = false; }),
		light('highlight', 'Highlight'),
		light('shadow', 'Shadow'),
	];
}

function gradientSettings(id: string, e: Edit<GradientFill>): CascadeItem[] {
	const stops = e.get().stops;
	return [
		choiceItem('Type', [
			{value: 'linear' as const, face: valueFace('', 'Lin'), caption: 'Linear'},
			{value: 'radial' as const, face: valueFace('', 'Rad'), caption: 'Radial'},
		], () => e.get().type, v => e.set(x => { x.type = v; }, true)),
		...(e.get().type === 'linear' ? [numberItem(e, {label: 'angle', caption: 'Angle (degrees)', min: -180, max: 180, presets: [-180, -90, 0, 90, 180], step: step(5)}, x => x.angle, (x, v) => { x.angle = v; })] : []),
		numberItem(e, {label: 'scale', caption: 'Scale (%)', min: 10, max: 150, presets: [10, 50, 100, 150], step: step(5)}, x => Math.round(x.scale * 100), (x, v) => { x.scale = v / 100; }),
		toggleItem('Reverse', svgFace(icons.reverse), () => e.get().reverse, v => e.set(x => { x.reverse = v; }, true)),
		// each stop: its colour, how opaque it is, and where it is along the gradient
		...stops.map((_, k): CascadeItem => {
			const stop: Edit<GradientFill['stops'][number]> = {get: () => e.get().stops[k] ?? stops[k], set: (change, final) => e.set(x => { if (x.stops[k]) change(x.stops[k]); }, final)};
			return {
				id:			`${id}-stop${k}`,
				face:		() => swatchFace(toHex(stop.get().color)),
				caption:	() => `Stop ${k + 1} at ${Math.round(stop.get().offset * 100)}%`,
				children:	() => [
					colourItem(`${id}-stop${k}-colour`, 'Colour', () => stop.get().color, (c, final) => stop.set(x => { x.color = c; }, final)),
					opacityItem(stop),
					numberItem(stop, {label: 'at', caption: 'Location (%)', min: 0, max: 100, presets: [0, 25, 50, 75, 100], step: step(1)}, x => Math.round(x.offset * 100), (x, v) => { x.offset = v / 100; }),
				],
			};
		}),
	];
}

function strokeSettings(id: string, e: Edit<StrokeEffect>): CascadeItem[] {
	const paint = e.get().paint;
	return [
		...(paint.type === 'solid' ? [colourItem(`${id}-colour`, 'Colour', () => { const p = e.get().paint; return p.type === 'solid' ? p.colour : {r: 0, g: 0, b: 0}; },
			(c, final) => e.set(x => { if (x.paint.type === 'solid') x.paint.colour = c; }, final))] : []),
		...common(e),
		sizeItem(e, 'Size', x => x.width, (x, v) => { x.width = Math.max(1, v); }),
		choiceItem('Position', [
			{value: 'outside' as const, face: valueFace('', 'Out'), caption: 'Outside'},
			{value: 'inside' as const, face: valueFace('', 'In'), caption: 'Inside'},
			{value: 'center' as const, face: valueFace('', 'Cntr'), caption: 'Centre'},
		], () => e.get().align, v => e.set(x => { x.align = v; }, true)),
	];
}

//-----------------------------------------------------------------------------
// the layer style
//-----------------------------------------------------------------------------

/** The layer's style: the whole of it turned on or off, and each effect, which a click turns on or off (and gives the layer, if it has
 *  none of it), with its settings coming out of it. Satin and pattern overlays are not drawn here, but one that a file has can be turned off. */
export function styleItem(edit: BlocksEdit): CascadeItem {
	const style = () => layerStyle(edit.get()) ?? emptyStyle();
	// (a change that leaves the style as it was is not an edit)
	const write = (change: (s: LayerStyle) => void, final: boolean) => {
		const s = style(), was = JSON.stringify(s);
		change(s);
		if (JSON.stringify(s) !== was)
			edit.put(withLayerStyle(edit.get() ?? {}, s), final);
	};
	const shown = () => {
		const s = style();
		return s.enabled && [...s.dropShadows, ...s.innerShadows, ...s.colourOverlays, s.outerGlow, s.innerGlow, s.bevel, s.gradientOverlay, s.stroke].some(e => e?.enabled);
	};

	// one effect: `find` is where a style has it, `make` gives a style a new one
	const effect = <T extends {enabled: boolean}>(id: string, name: string, short: string, find: (s: LayerStyle) => T | undefined, make: (s: LayerStyle) => T,
		settings: (id: string, e: Edit<T>) => CascadeItem[], note = ''): CascadeItem => {
		const e: Edit<T> = {
			get: () => find(style()) ?? make(emptyStyle()),		// (the settings of one that has gone, as by an undo, are a new one's)
			set: (change, final) => write(s => change(find(s) ?? make(s)), final),
		};
		const has = () => find(style());
		return {
			id,
			face:		() => valueFace('', short),
			caption:	() => `${name}${note}: ${!has() ? 'none (click to add)' : has()!.enabled ? 'on' : 'off'}`,
			active:		() => !!has()?.enabled,
			select:		() => { write(s => { const x = find(s); if (x) x.enabled = !x.enabled; else make(s); }, true); return true; },
			children:	() => has()?.enabled ? settings(id, e) : [],		// (one that is off has no settings to show)
		};
	};
	// one an effect can be had more than once, as many as there are (and one, to add, if there are none)
	const several = <T extends {enabled: boolean}>(id: string, name: string, short: string, all: (s: LayerStyle) => T[], made: () => T,
		settings: (id: string, e: Edit<T>) => CascadeItem[]) => {
		const n = Math.max(1, all(style()).length);
		return Array.from({length: n}, (_, k) => effect(`${id}${k || ''}`, n > 1 ? `${name} ${k + 1}` : name, short, s => all(s)[k], s => all(s)[k] = made(), settings));
	};

	return {
		id:			'fx',
		face:		() => svgFace(icons.fx),
		caption:	() => `Layer style: ${style().enabled ? 'on' : 'off'} (click to switch all effects ${style().enabled ? 'off' : 'on'})`,
		active:		shown,
		select:		() => { write(s => { s.enabled = !s.enabled; }, true); return true; },
		children:	() => {
			const s = style();
			return [
				...several('fx-drop', 'Drop shadow', 'Drop', s => s.dropShadows, newEffect.dropShadow, (id, e) => shadowSettings(id, e, true)),
				...several('fx-inner-shadow', 'Inner shadow', 'InSh', s => s.innerShadows, newEffect.innerShadow, (id, e) => shadowSettings(id, e, false)),
				effect('fx-outer-glow', 'Outer glow', 'OGlo', s => s.outerGlow, s => s.outerGlow = newEffect.outerGlow(), (id, e) => glowSettings(id, e, false)),
				effect('fx-inner-glow', 'Inner glow', 'IGlo', s => s.innerGlow, s => s.innerGlow = newEffect.innerGlow(), (id, e) => glowSettings(id, e, true)),
				effect('fx-bevel', 'Bevel & emboss', 'Bevl', s => s.bevel, s => s.bevel = newEffect.bevel(), bevelSettings),
				...several('fx-colour', 'Colour overlay', 'Colr', s => s.colourOverlays, newEffect.colourOverlay, (id, e) => [colourOf(`${id}-colour`, e), ...common(e)]),
				effect('fx-gradient', 'Gradient overlay', 'Grad', s => s.gradientOverlay, s => s.gradientOverlay = newEffect.gradientOverlay(), (id, e) => [...common(e), ...gradientSettings(id, e)]),
				effect('fx-stroke', 'Stroke', 'Strk', s => s.stroke, s => s.stroke = newEffect.stroke(), strokeSettings),
				...(s.satin ? [effect('fx-satin', 'Satin', 'Satn', s => s.satin, s => s.satin!, (_, e) => common(e), ' (not drawn here)')] : []),
				...(s.patternOverlay ? [effect('fx-pattern', 'Pattern overlay', 'Ptrn', s => s.patternOverlay, s => s.patternOverlay!, (_, e) => common(e), ' (not drawn here)')] : []),
			];
		},
	};
}

//=============================================================================
//	rendering: styles as pictures, on the GPU and as layers for the compositor
//=============================================================================

// A layer style's shadows, glows and overlays, made on the GPU (effect.frag): each is the shape of the layer (its alpha) shifted, spread,
// blurred, shaped by a contour and painted in a colour, over the part of the canvas it reaches. A wide one is made at a lower resolution,
// the blur being smooth, so what it costs does not grow with its size.

/** A bevel's highlight or shadow: the shape blurred is the height of a surface, lit from an angle */
interface BevelSpec {
	depth:		number;				// the height the edge rises, in pixels
	altitude:	number;				// degrees
	angle:		number;				// degrees
	direction:	1 | -1;				// up, down
	highlight:	boolean;			// the highlight, and not the shadow
	mask:		'all' | 'inside' | 'outside' | 'both';	// emboss, inner bevel, outer bevel, pillow emboss
}

export interface EffectSpec {
	kind:		'shadow' | 'glow' | 'fill' | 'bevel';
	bevel?:		BevelSpec;
	inside:		boolean;			// cast from outside the shape into it (an inner shadow or glow), and not out from it
	shape:		Shape;
	colour:		RGB;
	dx:			number;				// where it falls, in canvas pixels
	dy:			number;
	size:		number;				// the blur, of which the spread is solid
	spread:		number;				// pixels
	contour?:	{x: number, y: number}[];	// points from (0, 0) to (1, 1)
	range?:		number;				// a soft glow: the value which counts as full
	precise?:	boolean;			// a glow which falls off by distance, and not by blur
	knockout?:	boolean;			// the shape hides it where it is over it (a drop shadow)
	centre?:	boolean;			// an inner glow from the middle, and not the edge
}

// a bevel's edge is the blurred shape, and it is as high as this many sizes, for a depth of 100%
const BEVEL_HEIGHT = 1.1;

// the room round the shape that what is cast from it needs
const padOf = (s: EffectSpec) => s.kind === 'fill' ? 0 : Math.ceil(Math.hypot(s.dx, s.dy) + s.size * 1.5 + s.spread + 2);

// the pixels of the canvas a style covers: the shape's rectangle, with room round it for what falls outside (which is kept to the canvas)
function effectRegion(s: EffectSpec, width: number, height: number): float2.extent | undefined {
	if (s.inside || s.kind === 'fill')
		return !s.shape.empty() ? s.shape : undefined;
	const pad = padOf(s);
	const padded = s.shape.grow(float2(pad, pad)).intersect(new float2.extent(float2(0, 0), float2(width, height)));
	return !padded.empty() ? padded : undefined;
}

// a contour's curve as a table of 256 values
function contourTable(points: {x: number, y: number}[]) {
	const table = new Uint8ClampedArray(256);
	for (let i = 0, k = 0; i < 256; i++) {
		const x = i / 255;
		while (k < points.length - 2 && points[k + 1].x < x)
			k++;
		const p = points[k], q = points[k + 1], span = q.x - p.x;
		table[i] = Math.round(255 * clamp01(span > 0 ? lerp(p.y, q.y, clamp01((x - p.x) / span)) : q.y));
	}
	return table;
}

const isLinear = (c?: {x: number, y: number}[]) => !c || c.length < 2 || straight(c);

export class EffectRenderer {
	constructor(private canvas3d: Canvas3D, private program: ShaderProgram) {}

	/** The style as a texture (rgba, not premultiplied) over its region, which the caller deletes; nothing if it cannot be made. */
	render(spec: EffectSpec, canvasWidth: number, canvasHeight: number): WebGLTexture | undefined {
		const {canvas3d, program} = this, gl = canvas3d.gl;
		const region = effectRegion(spec, canvasWidth, canvasHeight);
		const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 8192);
		if (!region || Math.max(region.size().x, region.size().y) > limit)
			return;

		const shape = spec.shape, pad = padOf(spec);
		const hasWork = spec.kind !== 'fill' && (spec.precise ? spec.size >= 1 : true);
		// A wide blur is made smaller: no more than a few pixels across at the working size. What the spread takes of the size is solid;
		// the rest is blurred, over about five sigmas (that is how Photoshop's shadows and glows fall off).
		const bevel = spec.kind === 'bevel';
		const sigma = bevel ? spec.size / 2.5 : 0.4 * Math.max(0, spec.size - spec.spread);
		let k = 1;
		while (sigma / k > 6 && k < 16)
			k *= 2;
		const {x: shapeW, y: shapeH} = shape.size(), {x: left, y: top} = shape.min, {x: regionW, y: regionH} = region.size(), {x: regionX, y: regionY} = region.min;
		const workOrigin = [left - pad, top - pad];
		const ww = Math.ceil((shapeW + pad * 2) / k), wh = Math.ceil((shapeH + pad * 2) / k);
		if (hasWork && Math.max(ww, wh) > limit)
			return;

		const float = !!gl.getExtension('EXT_color_buffer_float');
		const textures: WebGLTexture[] = [], targets: Offscreen[] = [];
		const blend = gl.isEnabled(gl.BLEND);
		let result: Offscreen | undefined;
		try {
			gl.disable(gl.BLEND);
			const flat = !shape.mask;
			const shapeTexture = flat
				? canvas3d.createTexture(1, 1, new Uint8ClampedArray([255]), {format: 'r8', min: 'nearest', mag: 'nearest'})
				: canvas3d.createTexture(shapeW, shapeH, shape.mask as Uint8ClampedArray<ArrayBuffer>, {format: 'r8', min: 'nearest', mag: 'nearest'});
			textures.push(shapeTexture);
			const contour = isLinear(spec.contour) ? undefined : canvas3d.createTexture(256, 1, contourTable(spec.contour!) as Uint8ClampedArray<ArrayBuffer>, {format: 'r8', min: 'linear', mag: 'linear'});
			if (contour)
				textures.push(contour);

			const pass = (target: Offscreen, width: number, height: number, source: WebGLTexture | undefined, uniforms: Record<string, any>) => {
				target.begin();
				gl.viewport(0, 0, width, height);
				canvas3d.bindTexture2D(source ?? shapeTexture, 0);
				canvas3d.bindTexture2D(contour ?? shapeTexture, 1);
				canvas3d.bindTexture2D(shapeTexture, 2);
				program.draw({u_src: 0, u_contour: 1, u_shape: 2, u_shapeOrigin: [left, top], u_shapeSize: [shapeW, shapeH], u_flatShape: flat ? 1 : 0, u_workOrigin: workOrigin, u_k: k, ...uniforms});
				target.end();
			};

			// the working image: the shape (or what is outside it) shifted, spread and blurred
			let work: WebGLTexture | undefined, steps = 0;
			if (hasWork) {
				const format = float ? 'rgba16f' : 'rgba8';
				let from = canvas3d.createOffscreen(ww, wh, format), to = canvas3d.createOffscreen(ww, wh, format);
				targets.push(from, to);
				pass(from, ww, wh, undefined, {u_op: 0, u_offset: [Math.round(spec.dx), Math.round(spec.dy)], u_invert: spec.inside && spec.kind !== 'bevel' ? 1 : 0});
				const next = (uniforms: Record<string, any>) => {
					pass(to, ww, wh, from.texture, uniforms);
					[from, to] = [to, from];
				};
				if (spec.precise) {
					steps = Math.max(1, Math.ceil(spec.size / k));
					for (let i = 0; i < steps; i++)
						next({u_op: 3, u_square: i % 2 === 0 ? 1 : 0});
				} else {
					const spread = spec.spread / k;
					if (spread >= 0.5) {
						// a square and a diamond (along the diagonals) together make something near a circle
						const a = Math.round(spread / (1 + Math.SQRT2)), d = Math.round((spread - a) / 2);
						for (const [step, radius] of [[[1, 0], a], [[0, 1], a], [[1, 1], d], [[1, -1], d]] as [number[], number][])
							if (radius > 0)
								next({u_op: 1, u_step: step, u_radius: radius});
					}
					if (sigma / k > 0.3) {
						// (a bevel's is a raised cosine as wide as the bevel)
						const s = sigma / k, radius = bevel ? Math.max(1, Math.round(spec.size / k)) : Math.max(1, Math.ceil(s * 3));
						next({u_op: 2, u_step: [1, 0], u_radius: radius, u_sigma: s, u_hann: bevel ? 1 : 0});
						next({u_op: 2, u_step: [0, 1], u_radius: radius, u_sigma: s, u_hann: bevel ? 1 : 0});
					}
				}
				work = from.texture;
			}

			result = canvas3d.createOffscreen(regionW, regionH, 'rgba8');
			pass(result, regionW, regionH, work, {
				u_op:			4,
				u_mode:			spec.kind === 'bevel' ? 2 : hasWork ? 0 : 1,
				u_outOrigin:	[regionX, regionY],
				u_colour:		[spec.colour.r / 255, spec.colour.g / 255, spec.colour.b / 255],
				u_precise:		spec.precise ? 1 : 0,
				u_steps:		steps,
				u_spread:		spec.spread / k,
				u_range:		spec.range ?? 0,
				u_centre:		spec.centre ? 1 : 0,
				u_inside:		spec.inside ? 1 : 0,
				u_knockout:		spec.knockout ? 1 : 0,
				u_hasContour:	contour ? 1 : 0,
				...(spec.bevel && {
					u_depth:		spec.bevel.depth,
					u_altitude:		spec.bevel.altitude * Math.PI / 180,
					u_azimuth:		spec.bevel.angle * Math.PI / 180,
					u_direction:	spec.bevel.direction,
					u_highlight:	spec.bevel.highlight ? 1 : 0,
					u_bevelMask:	{all: 0, inside: 1, outside: 2, both: 3}[spec.bevel.mask],
				}),
			});
			const texture = result.texture;
			result.delete(true);
			result = undefined;
			return texture;
		} catch {
			return undefined;
		} finally {
			result?.delete();
			for (const unit of [2, 1, 0])
				canvas3d.bindTexture2D(null, unit);
			for (const t of targets)
				t.delete();
			for (const t of textures)
				canvas3d.deleteTexture(t);
			if (blend)
				gl.enable(gl.BLEND);
			canvas3d.initViewport();
		}
	}
}

//-----------------------------------------------------------------------------
// A PSD layer's styles as layers of their own, for the compositor to blend: a gradient overlay is the gradient seen over what the
// layer shows, and a stroke is a band along the edge of that, each in its own blend mode and opacity, on top of the layer. They are
// made from the layer's blocks (Layer.blocks) and kept with the layer, so that the same ones are handed to the compositor (which has a
// texture for each) until those, or the layer's pixels, change (forgetEffects). Shadows, glows and colour overlays are made too, beneath or over the layer, on the GPU; satin, bevels and pattern overlays are not shown.
//
// What the layer shows is its pixels' alpha, except for a shape: that is the shape's own fill and stroke, and if it has neither,
// its path, which is what Photoshop applies a style to.
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// shadows, glows and colour overlays are made by the compositor, on the GPU (gpueffects.ts): what the layers here carry is the style's
// settings (Layer.effect) and the rectangle of the canvas it covers, not pixels.
//-----------------------------------------------------------------------------

// a shadow's shift: the light is at `angle` degrees, so the shadow falls the other way
const shift = (s: Shadow) => ({dx: -Math.cos(s.angle * Math.PI / 180) * s.distance, dy: Math.sin(s.angle * Math.PI / 180) * s.distance});

/** One of a layer's styles as a layer for the compositor. */
interface StyleLayer {
	layer:		PixelLayer;
	name:		string;
	blend:		BLEND_MODE;
	opacity:	number;
	below:		boolean;	// beneath the layer, not over it
}

const made = new WeakMap<Layer, {blocks: unknown, image: unknown, mask: unknown, size: string, parts: StyleLayer[]}>();

/** The layer's styles are to be made again (its pixels were changed). */
export function forgetEffects(layer: Layer) {
	made.delete(layer);
}

export function styleLayers(layer: PixelLayer, width: number, height: number, below: boolean): StyleLayer[] {
	const size = `${width}x${height}`;
	let entry = made.get(layer);
	if (!entry || entry.blocks !== layer.blocks || entry.image !== layer.image || entry.mask !== layer.mask || entry.size !== size) {
		entry = {
			blocks: layer.blocks,
			image:	layer.image,
			mask:	layer.mask,
			size,
			parts:	buildStyles(layer, width, height)
		};
		made.set(layer, entry);
	}

	// (what can change without the layer's blocks or pixels doing so)
	return entry.parts.filter(p => p.below === below).map(p => {
		const effect	= p.layer;
		effect.name		= `${layer.name} (${p.name})`;
		effect.visible	= layer.visible;
		effect.opacity	= layer.opacity * p.opacity;
		effect.blend	= p.blend;
		effect.clipped	= layer.clipped;
		return p;
	});
}

/** A layer's styles as layers made of pixels (the gradient overlay and the stroke), the ones the compositor is given after it. The rest
 *  (shadows, glows and colour overlays) are made on the GPU, and are in withEffects only. */
export function effectLayers(layer: PixelLayer, width: number, height: number): PixelLayer[] {
	return styleLayers(layer, width, height, false).map(p => p.layer).filter(l => !l.effect);
}

// a layer whose pixels the compositor makes from the effect when it first wants them
function effectLayer(spec: EffectSpec, width: number, height: number): PixelLayer | undefined {
	const region = effectRegion(spec, width, height);
	return region && {kind: 'image', name: '', left: region.min.x, top: region.min.y, opacity: 1, visible: true, blend: 'norm', image: {data: new Uint8ClampedArray(0), width: region.max.x - region.min.x, height: region.max.y - region.min.y}, effect: spec};
}

// What the layer's masks leave of the shape the styles follow: Photoshop puts them on the layer as it shows, its masks applied, and
// does not cut them off with the masks.
function maskedShape(layer: PixelLayer, shape: Shape, width: number, height: number): Shape | undefined {
	const kept = layer.mask && !layer.mask.disabled ? keptBy(shape, layer.mask) : shape;
	const vmask = vectorMask(layer, width, height);
	return kept && vmask ? keptBy(kept, vmask) : kept;
}

// what a mask leaves of a shape: inverted if it says so, and what it hides made less by its density (its feather aside, which is the
// compositor's)
function keptBy(shape: Shape, mask: LayerMask): Shape | undefined {
	const dense = (v: number) => 255 - (255 - v) * (mask.density ?? 255) / 255;

	// (outside the mask's rectangle it is its default: what is left is within the rectangle if that is nothing)
	const {left, top, image: {width: mw, height: mh, data: data}} = mask, outside = dense(mask.inverted ? 255 - mask.default : mask.default);
	const {x: sx, y: sy} = shape.min, {x: sw, y: sh} = shape.size();
	const x0 = outside ? sx : Math.max(sx, left), y0 = outside ? sy : Math.max(sy, top);
	const x1 = outside ? sx + sw : Math.min(sx + sw, left + mw), y1 = outside ? sy + sh : Math.min(sy + sh, top + mh);
	if (x1 <= x0 || y1 <= y0)
		return;

	const width = x1 - x0, height = y1 - y0, alpha = new Uint8ClampedArray(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const mx = x + x0 - left, my = y + y0 - top, inside = mx >= 0 && my >= 0 && mx < mw && my < mh;
			const m = inside ? dense(mask.inverted ? 255 - data[my * mw + mx] : data[my * mw + mx]) : outside;
			alpha[y * width + x] = shape.mask![(y + y0 - sy) * sw + x + x0 - sx] * m / 255;
		}
	}
	return new Shape(float2.extent.fromSize(float2(x0, y0), float2(width, height)), alpha);
}

// something painted (a colour, or a gradient laid out on the shape's box) over a rectangle of the canvas, kept to where `alpha` is
function painted(left: number, top: number, width: number, height: number, alpha: ArrayLike<number>, paint: (ctx: CanvasRenderingContext2D) => void): PixelLayer {
	const ctx = createElement('canvas', {width, height}).getContext('2d', {willReadFrequently: true})!;
	ctx.save();
	ctx.translate(-left, -top);
	paint(ctx);
	ctx.restore();
	const keep = ctx.getImageData(0, 0, width, height);
	for (let i = 0; i < alpha.length; i++)
		keep.data[i * 4 + 3] = Math.round(keep.data[i * 4 + 3] * alpha[i] / 255);
	return {kind: 'image', name: '', left, top, opacity: 1, visible: true, blend: 'norm', image: {data: keep.data, width, height}};
}


function buildStyles(layer: PixelLayer, width: number, height: number): StyleLayer[] {
	const style = layerStyle(layer.blocks);
	if (!style || !style.enabled)
		return [];

	const overlays	= style.colourOverlays.filter(o => o.enabled);
	const overlay	= style.gradientOverlay?.enabled ? style.gradientOverlay : undefined;
	const stroke	= style.stroke?.enabled ? style.stroke : undefined;
	const drops		= style.dropShadows.filter(s => s.enabled);
	const inners	= style.innerShadows.filter(s => s.enabled);
	const outer		= style.outerGlow?.enabled ? style.outerGlow : undefined;
	const inner		= style.innerGlow?.enabled ? style.innerGlow : undefined;
	const bevel		= style.bevel?.enabled && style.bevel.style !== 'stroke' ? style.bevel : undefined;
	if (!(overlays.length || overlay || stroke || drops.length || inners.length || outer || inner || bevel))
		return [];

	const unmasked	= shapeOf(layer, width, height);
	const shape		= unmasked && maskedShape(layer, unmasked, width, height);
	if (!shape)
		return [];

	const out: StyleLayer[] = [];
	const add		= (image: PixelLayer | undefined, name: string, e: {blend: BLEND_MODE, opacity: number}, below = false) => image && out.push({layer: image, name, blend: e.blend, opacity: e.opacity, below});
	const shadow	= (s: Shadow, inside: boolean) => effectLayer({
		kind: 'shadow', inside, shape, colour: s.colour, ...shift(s), size: s.size, spread: s.size * Math.min(1, s.choke), contour: s.contour, knockout: !inside && s.knockout !== false,
	}, width, height);
	const glow		= (g: Glow, inside: boolean) => effectLayer({
		kind: 'glow', inside, shape, colour: g.colour, dx: 0, dy: 0, size: g.size, spread: g.size * Math.min(1, g.choke), contour: g.contour,
		precise: g.technique === 'precise', range: g.technique === 'softer' ? g.range : undefined, centre: inside && g.source === 'center',
	}, width, height);

	// beneath the layer, the first of the shadows being the topmost
	for (const s of drops.slice().reverse())
		add(shadow(s, false), 'drop shadow', s, true);

	if (outer)
		add(glow(outer, false), 'outer glow', outer, true);

	// over it, from the colour overlays at the bottom up to the stroke
	for (const o of overlays)
		add(effectLayer({kind: 'fill', inside: true, shape, colour: o.colour, dx: 0, dy: 0, size: 0, spread: 0}, width, height), 'colour overlay', o);

	if (overlay) {
		const g = overlay;
		const {x: left, y: top} = shape.min, {x: w, y: h} = shape.size();
		add(painted(left, top, w, h, shape.mask!, ctx => {
			ctx.fillStyle = gradientStyle(ctx, g, shape, {width, height});
			ctx.fillRect(left, top, w, h);
		}), 'gradient overlay', g);
	}

	if (inner)
		add(glow(inner, true), 'inner glow', inner);

	for (const s of inners.slice().reverse())
		add(shadow(s, true), 'inner shadow', s);

	if (bevel) {
		const mask = {inner: 'inside', outer: 'outside', emboss: 'all', pillow: 'both', stroke: 'all'}[bevel.style] as 'inside' | 'outside' | 'all' | 'both';
		for (const [highlight, light, name] of [[false, bevel.shadow, 'bevel shadow'], [true, bevel.highlight, 'bevel highlight']] as const) {
			add(effectLayer({
				kind: 'bevel', inside: mask === 'inside', shape, colour: light.colour, dx: 0, dy: 0, size: bevel.size, spread: 0,
				bevel: {depth: bevel.depth * BEVEL_HEIGHT * bevel.size, altitude: bevel.altitude, angle: bevel.angle, direction: bevel.direction === 'down' ? -1 : 1, highlight, mask},
			}, width, height), name, {blend: light.blend as BLEND_MODE, opacity: light.opacity});
		}
	}

	if (stroke) {
		// room for the band outside the shape's rectangle
		const pad	= stroke.align === 'inside' ? 0 : Math.ceil(stroke.width) + 2;
		const {x: sx, y: sy} = shape.min, {x: sw, y: sh} = shape.size();
		const left	= Math.max(0, sx - pad), top = Math.max(0, sy - pad);
		const w		= Math.min(width, sx + sw + pad) - left, h = Math.min(height, sy + sh + pad) - top;
		const alpha = new Uint8ClampedArray(w * h);

		for (let y = 0; y < sh; y++)
			alpha.set(shape.mask!.subarray(y * sw, (y + 1) * sw), (y + sy - top) * w + sx - left);

		const band = strokeAlpha(alpha, w, h, stroke.width, stroke.align);
		add(painted(left, top, w, h, band, ctx => {
			ctx.fillStyle = gradientStyle(ctx, stroke.paint, shape, {width, height});
			ctx.fillRect(left, top, w, h);
		}), 'stroke', stroke);
	}
	return out;
}

/** What a fill layer shows, as a layer of pixels for the compositor: its colour or gradient, all over the canvas or through its shape.
 *  Undefined if it is not a fill layer (a shape layer has its fill in 'vscg', and is its pixels). */
export function fillLayer(layer: PixelLayer, width: number, height: number): PixelLayer | undefined {
	const blocks = layer.blocks;
	if (!blocks || blocks.vscg || !(blocks.SoCo || blocks.GdFl))
		return;

	const shape	= findVectorMask(blocks) ? shapeOf(layer, width, height) : new Shape(imageRect({width, height}));
	if (!shape)
		return;

	const fill = ownFill(blocks), colour = fill?.type === 'solid' ? fill.colour : undefined, gradient = fill?.type === 'solid' ? undefined : fill;
	if (colour)
		return effectLayer({kind: 'fill', inside: true, shape, colour, dx: 0, dy: 0, size: 0, spread: 0}, width, height);
	if (gradient) {
		const {x: left, y: top} = shape.min, {x: w, y: h} = shape.size();
		const alpha = shape.mask ?? new Uint8ClampedArray(w * h).fill(255);
		return painted(left, top, w, h, alpha, ctx => {
			ctx.fillStyle = gradientStyle(ctx, gradient, shape, {width, height});
			ctx.fillRect(left, top, w, h);
		});
	}
}
