// Editing the path of a shape layer in place, over the picture: the point editor the SVG editor and the font inspector use, in the
// canvas's pixels, its view the picture's. What it does is the layer's (see LayeredMode.openShape): each change is shown on the
// picture as it is made, and each edit made again as the layer's pixels. In three parts: the serialisation of what a shape layer keeps
// (its fills, stroke and vector mask), the editing of it, and the rendering of it as a picture.
import { PathEditor, ViewOptions, svgPath, simplifyPoints as simplify, fitStroke, type DragHandler, type ToolChoice, DEFAULT_OPTIONS } from './pathedit.js';
import { Pixels } from './opengl.js';
import { float2, float2x3 } from '@isopodlabs/maths/vector';
import { bezier3 } from '@isopodlabs/maths/geometry';
import { createElement, RPC } from '@isopodlabs/vscode_utils/webview/shared.js';
import { curveVertex, curveExtentQuick, ON_BEGIN, ON_CURVE, ON_END, OFF_BEZ3 } from '@isopodlabs/binary_fonts/curves';
import { type Stop, type Paint, type PaintOptions, GradientEditor } from './gradientedit.js';
import { CascadeItem, svgFace, swatchFace, valueItem, choiceItem, toggleItem, colourItems } from './cascade.js';
import { RGB, toHex, toCss, clamp01, lerp, mixColour } from './colour.js';
import { Mode } from './modes.js';
import { Input, Place } from './navigate.js';
import type { LayeredMode, Layer, LayerMask, PixelLayer, ShapeState, BlocksEdit } from './layers.js';
import type { psd } from '@isopodlabs/binary_bitmaps';
import { Access, Text, Within, PathRecord, LayerBlocks, readSpec, writeWith, put, E, Default, Long, BoolOr, Bool, Double, Lookup, List, Unit, Optional, Percent, SpecOf, Obj, Union, Post, Items, items, AccessOf } from './psdblocks.js'
import { alphaShape, Shape } from './raster.js';

//=============================================================================
//	serialisation: what a shape layer's blocks keep (fills, strokes, the vector mask), read into values and written back
//=============================================================================

/** A shape's fill or stroke paint: a solid colour or a gradient. */
export type Fill = AccessOf<typeof ShapePaint>;

// the layer style's blend modes, as the keys that layers have
export const BLEND_MODE = Default(Lookup('BlnM', {
	Nrml:				'norm',
	Dslv: 				'diss',
	Drkn:				'dark',
	Mltp:				'mul',
	CBrn:				'idiv',
	linearBurn: 		'lbrn',
	darkerColor: 		'dkCl',
	Lghn:				'lite',
	Scrn: 				'scrn',
	CDdg:				'div',
	linearDodge:		'lddg',
	lighterColor:		'lgCl',
	Ovrl:				'over',
	SftL: 				'sLit',
	HrdL:				'hLit',
	vividLight:			'vLit',
	linearLight:		'lLit',
	pinLight: 			'pLit',
	hardMix: 			'hMix',
	Dfrn:				'diff',
	Xclu: 				'smud',
	blendSubtraction:	'fsub',
	blendDivide:		'fdiv',
	H: 					'hue',
	Strt: 				'sat',
	Clr:				'colr',
	Lmns: 				'lum',
}), 'norm');

export type BLEND_MODE	= AccessOf<typeof BLEND_MODE>

export const Vec2	= (classId: string, a: Access<number>) => Obj(classId, {x: ['Hrzn', a], y: ['Vrtc', a]});

//-----------------------------------------------------------------------------
//	colour
//-----------------------------------------------------------------------------

/** A colour of the RGB model (one of another model, which the item may hold, is not read). */
export const Colour = Obj('RGBC', {
	r:	['Rd',  Double],
	g:	['Grn', Double],
	b:	['Bl',  Double],
});

export const solidFillSpec = {colour: E('Clr', Colour)};


//-----------------------------------------------------------------------------
//	gradient fills
//-----------------------------------------------------------------------------

/** A solid fill: a colour, tagged to tell it from a gradient in a `Fill`. */
export type SolidFill = SpecOf<typeof solidFillSpec> & {type: 'solid'};

export const LOCATIONS = 4096;
// a place along a gradient, 0 to 1, which the file keeps as a whole number of 4096ths
const Location		= Default(Post(Long, {from: n => n / LOCATIONS, to: (at: number) => Math.round(clamp01(at) * LOCATIONS)}), 0);

const GRADIENT_TYPE = Lookup('GrdT', {'Lnr ': 'linear', 'Rdl ': 'radial'});
const COLOUR_STOP	= Lookup('Clry', {UsrS: 'user', FrgC: 'foreground', BckC: 'background'});
const GRADIENT_FORM = Lookup('GrdF', {CstS: 'custom', ClNs: 'noise'});

const byPlace = (a: {at: number}, b: {at: number}) => a.at - b.at;

// a value along a list of places, sorted: the two either side of this place and how far between them it is (the first's before the
// first, and the last's after the last)
function along<T extends {at: number}>(list: T[], at: number): [T, T, number] {
	if (at <= list[0].at)
		return [list[0], list[0], 0];
	for (let i = 1; i < list.length; i++) {
		if (at <= list[i].at) {
			const a = list[i - 1], b = list[i];
			return [a, b, b.at === a.at ? 1 : (at - a.at) / (b.at - a.at)];
		}
	}
	return [list[list.length - 1], list[list.length - 1], 0];
}

/** The colours and the opacities, which Photoshop keeps as two lists each with its own places along the gradient, as one list of
 *  stops, at every place either of them has. A gradient with a colour that is not RGB, or with no colours, is not read. */
const stopsSpec = {
	colourList:			E('Clrs', List(Obj('Clrt', {
		colour:			E('Clr',  Colour),
		at:				E('Lctn', Location),
		type:			E('Type', Default(COLOUR_STOP, 'user')),
		midpoint:		E('Mdpn', Default(Long, 50)),
	}))),
		opacityList:	E('Trns', List(Obj('TrnS', {
		opacity:		E('Opct', Default(Percent, 1)),
		at:				E('Lctn', Location),
		midpoint:		E('Mdpn', Default(Long, 50)),
	}))),
};

const Stops = Post(Obj('Grdn', stopsSpec), {
	from: 	({colourList, opacityList}): Stop[] | undefined => {
		if (!colourList.length || colourList.some(c => !c.colour))
			return;
		colourList.sort(byPlace);
		opacityList.sort(byPlace);
		const places = [...new Set([...colourList, ...opacityList].map(s => s.at))].sort((a, b) => a - b);
		return places.map(at => {
			const [c0, c1, tc] = along(colourList, at);
			const [o0, o1, to] = opacityList.length ? along(opacityList, at) : [{opacity: 1}, {opacity: 1}, 0];
			return {
				offset: at,
				color: mixColour(c0.colour, c1.colour, tc, true),
				opacity: lerp(o0.opacity, o1.opacity, to)
			};
		});
	},
	to:		stops => {
		const sorted = [...stops].sort((a, b) => a.offset - b.offset);
		return {
			colourList:  sorted.map(s => ({colour: s.color, at: s.offset, type: 'user' as const, midpoint: 50})),
			opacityList: sorted.map(s => ({opacity: s.opacity, at: s.offset, midpoint: 50})),
		};
	},
});

const Angle		= Unit('#Ang');

// where a gradient lies; its colour and opacity stops are kept as two lists, each with its own places along the gradient
const gradientGeomSpec = {
	type:		E('Type', GRADIENT_TYPE),		// (undefined for a kind that this does not make)
	angle:		E('Angl', Default(Angle, 0)),					// degrees, anticlockwise from the direction of the x axis, for a linear gradient
	scale:		E('Scl',  Default(Percent, 1)),					// 1 is 100%
	reverse:	E('Rvrs', Bool),
	align:		E('Algn', BoolOr(true)),						// laid out on the layer's box (the path's), or on the canvas
	offset:		E('Ofst', Default(Vec2('Pnt ', Percent), float2(0, 0))),	// where the middle is, from the middle of that box, in fractions of its width and height
};
export const gradientSpec = {
	...gradientGeomSpec,
	name:		E('Grad', Optional(Within('Grdn', 'Nm', Text))),
	form:		E('Grad', Optional(Within('Grdn', 'GrdF', GRADIENT_FORM))),
	smoothness:	E('Grad', Optional(Within('Grdn', 'Intr', Double))),		// LOCATIONS is 100%
	stops:		E('Grad', Stops),
};

export type GradientFill = SpecOf<typeof gradientSpec>;

export const gradientDefaults: GradientFill = {
	type:		'linear',
	angle:		90,
	scale:		1,
	reverse:	false,
	align:		true,
	offset:		{x: 0, y: 0},
	name:		'Custom',
	form:		'custom',
	smoothness:	LOCATIONS,

	stops: [{
		offset: 	0,
		color:		{r: 0, g: 0, b: 0},
		opacity:	1
	}, {
		offset:		1,
		color:		{r: 255, g: 255, b: 255},
		opacity:	1
	}],
};


export const solidOf = (colour?: RGB) => colour && {type: 'solid' as const, colour};
export const isSolid = (f: SolidFill | GradientFill): f is SolidFill => f.type === 'solid';

export const validGradient = <G extends GradientFill>(g: G) => g.type && g.stops ? g : undefined;

//-----------------------------------------------------------------------------
//	fill
//-----------------------------------------------------------------------------
function shapeBlock<K extends keyof LayerBlocks>(blocks: LayerBlocks | undefined, key: K)	{
	return blocks?.[key] || (blocks?.vscg?.kind === key ? blocks?.vscg : undefined);
}
/** Whether a shape layer has a fill that shows. A shape that has its fill turned off ('vstk', fillEnabled) shows only its stroke and its layer style. */
export function fillEnabled(blocks: LayerBlocks | undefined) {
	return !blocks?.vstk || readSpec(vstkSpec, blocks.vstk.descriptor.items).fillEnabled;
}

// The colour of a layer's solid fill ('SoCo' for a fill layer, in 'vscg' for a shape), or undefined if it has none (a gradient
// or a pattern, or a shape with only a stroke).
export function solidColour(blocks: LayerBlocks | undefined): RGB | undefined {
	return readSpec(solidFillSpec, shapeBlock(blocks, 'SoCo')?.descriptor.items ?? {}).colour;
}

/** The gradient of a layer's fill, or undefined if it has none, or it is of a kind this does not make. */
export function gradientFill(blocks: LayerBlocks | undefined): GradientFill | undefined {
	const items = shapeBlock(blocks, 'GdFl')?.descriptor.items;
	return items && validGradient(readSpec(gradientSpec, items));
}


//-----------------------------------------------------------------------------
//	stokes
//-----------------------------------------------------------------------------

// the stroke block of a shape, which it has once it has been given a stroke or has its fill turned off
const vstkSpec = {
	version:		E('strokeStyleVersion', Default(Long, 2)),
	strokeEnabled:	E('strokeEnabled', BoolOr(true)),
	fillEnabled:	E('fillEnabled', BoolOr(true)),
	scaleLock:		E('strokeStyleScaleLock', Bool),
	strokeAdjust:	E('strokeStyleStrokeAdjust', Bool),
	resolution:		E('strokeStyleResolution', Default(Double, 72)),
};

const ALIGN		= Lookup('strokeStyleLineAlignment', {strokeStyleAlignInside: 'inside', strokeStyleAlignCenter: 'center', strokeStyleAlignOutside: 'outside'});
const CAP		= Lookup('strokeStyleLineCapType', {strokeStyleButtCap: 'butt', strokeStyleRoundCap: 'round', strokeStyleSquareCap: 'square'});
const JOIN		= Lookup('strokeStyleLineJoinType', {strokeStyleMiterJoin: 'miter', strokeStyleRoundJoin: 'round', strokeStyleBevelJoin: 'bevel'});
const Dashes 	= List(Unit('#Nne'));

const solidColor	= Post(Obj('solidColorLayer', solidFillSpec),	{from: (v): SolidFill | undefined => solidOf(v.colour), to: (v: SolidFill) => v});
const gradientLayer = Post(Obj('gradientLayer', gradientSpec),		{from: (g): GradientFill | undefined => validGradient(g), to: (g: GradientFill) => g});
const ShapePaint	= Union(solidColor, gradientLayer, isSolid);

// (a width is kept in points when the file says so, and these are of the file's resolution)
const shapeStrokeSpec = (resolution: number) => {
	const pixels = Unit('#Pnt', resolution / 72);
	return {
		width:		E('strokeStyleLineWidth',		Default(pixels, 1)),
		align:		E('strokeStyleLineAlignment',	Default(ALIGN, 'center')),
		cap:		E('strokeStyleLineCapType',		Default(CAP, 'butt')),
		join:		E('strokeStyleLineJoinType',	Default(JOIN, 'miter')),
		miterLimit:	E('strokeStyleMiterLimit',		Default(Double, 10)),
		dashes:		E('strokeStyleLineDashSet',		Dashes),				// none for a solid line
		dashOffset:	E('strokeStyleLineDashOffset',	Default(pixels, 0)),
		blend:		E('strokeStyleBlendMode',		BLEND_MODE),
		opacity:	E('strokeStyleOpacity',			Default(Percent, 1)),	// 0 to 1
		paint:		E('strokeStyleContent',			Optional(ShapePaint)),	// a colour or a gradient
	};
};

type Stroke = SpecOf<ReturnType<typeof shapeStrokeSpec>>;

/** The shape's own stroke, if it is on and is a solid colour or a gradient (a pattern is not made). */
export function shapeStroke(blocks: LayerBlocks | undefined): Stroke | undefined {
	const i = blocks?.vstk?.descriptor.items;
	if (!i)
		return;
	const {strokeEnabled, resolution} = readSpec(vstkSpec, i);
	return strokeEnabled ? readSpec(shapeStrokeSpec(resolution), i) : undefined;
}

function writeShapeStroke(i: Items, s: Stroke) {
	put(i, shapeStrokeSpec(72), s);
}

/** A stroke as a shape is first given one: a black line, centred on the outline. */
const newShapeStroke = (): Stroke => ({
	width: 4, align: 'center', cap: 'butt', join: 'miter', miterLimit: 10, dashes: [], dashOffset: 0, blend: 'norm', opacity: 1,
	paint: {type: 'solid', colour: {r: 0, g: 0, b: 0}},
});

/** The blocks with the shape's stroke settings written into its descriptor, which is made if it has none, and turned on if it was off. */
function withShapeStroke(blocks: LayerBlocks, s: Stroke): LayerBlocks {
	if (blocks.vstk)
		return writeWith(blocks, blocks.vstk, i => { put(i, vstkSpec, {strokeEnabled: true}); writeShapeStroke(i, s); });
	return withNewShapeStroke(blocks, s, true, true);
}

function withNewShapeStroke(blocks: LayerBlocks, s: Stroke, strokeOn: boolean, fillOn: boolean): LayerBlocks {
	const i = put({}, vstkSpec, {version: 2, strokeEnabled: strokeOn, fillEnabled: fillOn, scaleLock: false, strokeAdjust: false, resolution: 72});
	writeShapeStroke(i, {...s, paint: s.paint ?? newShapeStroke().paint});
	return {...blocks, vstk: {key: 'vstk', version: 16, descriptor: {name: '', classId: 'null', items: i}}} as LayerBlocks;
}

/** The blocks with the shape's fill turned on or off (which a shape that has no stroke block is given one for, with its stroke off). */
function withFillEnabled(blocks: LayerBlocks, enabled: boolean): LayerBlocks {
	if (blocks.vstk)
		return writeWith(blocks, blocks.vstk, i => put(i, vstkSpec, {fillEnabled: enabled}));
	return enabled ? blocks : withNewShapeStroke(blocks, newShapeStroke(), false, false);
}

/** The blocks with this fill: written into the layer's fill if it is of the same kind (a colour or a gradient), and in place of it if not. */
function withFill(blocks: LayerBlocks, fill: Fill): LayerBlocks {
	const key = fill.type === 'solid' ? 'SoCo' : 'GdFl';
	const write = (i: Items) => fill.type === 'solid' ? put(i, solidFillSpec, {colour: fill.colour}) : put(i, gradientSpec, fill);
	const same = shapeBlock(blocks, key);
	if (same)
		return writeWith(blocks, same, write);
	const descriptor = {name: '', classId: 'null', items: write({})};
	if (blocks.vscg)
		return {...blocks, vscg: {...blocks.vscg, kind: key, descriptor}};
	const {SoCo, GdFl, ...rest} = blocks;
	return {...rest, [key]: {key, version: 16, descriptor}} as LayerBlocks;
}

/** The blocks with the shape's stroke turned off (its settings are kept, as a file keeps them). */
function withoutShapeStroke(blocks: LayerBlocks): LayerBlocks {
	return writeWith(blocks, blocks.vstk, i => put(i, vstkSpec, {strokeEnabled: false}));
}

//-----------------------------------------------------------------------------
//	vector mask
//-----------------------------------------------------------------------------

const LENGTH	= [0, 3];			// closed, open
const KNOT		= [1, 2, 4, 5];		// linked and not, closed; the same open
const isLength	= (r: PathRecord): r is PathRecord & {selector: 0|3} => LENGTH.includes(r.selector);
const isKnot	= (r: PathRecord): r is PathRecord & {selector: 1|2|4|5} => KNOT.includes(r.selector);
type Point		= {x: number, y: number};

// the vector mask of a layer: 'vmsk', or 'vsms' as newer files have it
export function findVectorMask(blocks: LayerBlocks | undefined): PathRecord[]|undefined {
	return blocks?.vmsk?.paths ?? blocks?.vsms?.paths;
}

// whether the layer has a fill of its own (a colour, gradient or pattern), whose outline its vector mask is, if it has one
export const hasFill = (blocks: LayerBlocks | undefined) => !!(blocks?.SoCo || blocks?.GdFl || blocks?.PtFl || blocks?.vscg);

/** Whether a layer's blocks make it a shape: a fill seen through a vector mask (any other layer's vector mask only hides some of it). */
export function isShape(blocks: LayerBlocks | undefined) {
	return hasFill(blocks) && !!findVectorMask(blocks);
}

/** The block of a layer's vector mask when it is one that hides some of the layer (not a shape's outline), whether it is on or not. */
export function maskBlock(blocks: LayerBlocks | undefined) {
	const block = blocks?.vmsk ?? blocks?.vsms;
	return block?.paths && !hasFill(blocks) ? block : undefined;
}

/** The blocks with the vector mask's flags (1 inverted, 2 not linked, 4 off) changed, or with no vector mask. */
export function withMaskFlags(blocks: LayerBlocks, flags: number | undefined): LayerBlocks {
	const {vmsk, vsms, ...rest} = blocks;
	if (flags === undefined)
		return rest;
	return vmsk ? {...blocks, vmsk: {...vmsk, flags}} : vsms ? {...blocks, vsms: {...vsms, flags}} : blocks;
}

// The subpaths as curves in canvas pixels. A closed one comes back to its first anchor, which ends it; an open one ends with ON_END.
export function pathsToCurve(paths: PathRecord[], width: number, height: number): curveVertex[] {
	const out: curveVertex[] = [];
	const pt = (p: Point, flags: number) => curveVertex(p.x * width, p.y * height, flags);
	for (let i = 0; i < paths.length; i++) {
		const head = paths[i];
		if (!isLength(head))
			continue;
		const closed	= head.selector === 0;
		const knots		= paths.slice(i + 1, i + 1 + head.count).filter(isKnot);
		if (!knots.length)
			continue;
		out.push(pt(knots[0].anchor, ON_BEGIN));
		const segments = closed ? knots.length : knots.length - 1;
		for (let k = 0; k < segments; k++) {
			const a = knots[k], b = knots[(k + 1) % knots.length];
			out.push(pt(a.after, OFF_BEZ3), pt(b.before, OFF_BEZ3));
			// (the segment that closes a contour ends at its begin, which a contour does not repeat: the point is moved with it)
			if (!(closed && k === segments - 1))
				out.push(pt(b.anchor, k === segments - 1 ? ON_END : ON_CURVE));
		}
		if (!closed && knots.length === 1)
			out[out.length - 1].flags = ON_END;
	}
	return out;
}

// And back: each contour's on-curve points become knots, a line segment having its controls at the anchors. What the file
// keeps of a subpath besides its knots (how it combines with the others), and the records which are not paths (the fill rule,
// the clipboard), are taken from `previous`.
export function curveToPaths(curve: curveVertex[], width: number, height: number, previous: PathRecord[] = []): PathRecord[] {
	const heads		= previous.filter(isLength);
	const first		= previous.findIndex(isLength);
	const last		= previous.reduce((n, r, i) => isKnot(r) || isLength(r) ? i : n, -1);
	const out: PathRecord[] = previous.slice(0, Math.max(first, 0)).filter(r => !isKnot(r) && !isLength(r));
	const frac		= (v: Point) => ({y: v.y / height, x: v.x / width});
	const knotsWas	= previous.filter(isKnot);

	let n = 0, m = 0;
	for (let i = 0; i < curve.length;) {
		let e = i + 1;
		while (e < curve.length && curve[e].flags !== ON_BEGIN)
			e++;
		const pts	= curve.slice(i, e);
		const open	= pts[pts.length - 1].flags === ON_END;
		let anchors = pts.map((p, k) => ({k, p})).filter(({p}) => p.flags === ON_BEGIN || p.flags === ON_CURVE || p.flags === ON_END);
		// a closed contour which comes back to its start does not need that anchor twice
		if (!open && anchors.length > 1 && anchors[0].p.x === anchors[anchors.length - 1].p.x && anchors[0].p.y === anchors[anchors.length - 1].p.y)
			anchors = anchors.slice(0, -1);

		const knots = anchors.map(({p}) => ({before: frac(p), anchor: frac(p), after: frac(p)}));
		for (let k = 0; k < anchors.length && !(open && k === anchors.length - 1); k++) {
			const controls = pts.slice(anchors[k].k + 1, k + 1 < anchors.length ? anchors[k + 1].k : pts.length).filter(p => p.flags === OFF_BEZ3);
			if (controls.length === 2) {
				knots[k].after							= frac(controls[0]);
				knots[(k + 1) % knots.length].before	= frac(controls[1]);
			}
		}

		const was = (heads[n++] ?? heads[heads.length - 1]);
		out.push({selector: open ? 3 : 0, count: knots.length, operation: was?.operation ?? 1, shape: was?.shape ?? 0, reserved: was?.reserved ?? new Uint8Array(18)} as PathRecord);
		// (whether a knot's controls move together is not in the curve: a knot that was there keeps what it had)
		for (const k of knots)
			out.push({selector: (open ? 4 : 1) + (knotsWas[m++]?.selector === 2 || knotsWas[m - 1]?.selector === 5 ? 1 : 0), ...k} as PathRecord);
		i = e;
	}
	return out.concat(previous.slice(last + 1).filter(r => !isKnot(r) && !isLength(r)));
}

// the records a vector mask starts with, as Photoshop keeps them: how paths combine, and that nothing is filled outside them
const maskPreamble = (all = false) => [
	{selector: 6, reserved: new Uint8Array(24)},
	{selector: 8, initialFill: all ? 1 : 0, reserved: new Uint8Array(22)},
] as psd.PathRecord[];

/** The vector mask a layer is given that hides none of it: no paths, over what starts as all of the layer. */
export function newVectorMask(): NonNullable<LayerBlocks['vmsk']> {
	return {key: 'vmsk', version: 3, flags: 0, paths: maskPreamble(true)} as NonNullable<LayerBlocks['vmsk']>;
}

// the records with what is filled before any path is (all, or nothing) as given
function withInitialFill(paths: PathRecord[], all: boolean): PathRecord[] {
	const initial = {selector: 8, initialFill: all ? 1 : 0, reserved: new Uint8Array(22)} as PathRecord;
	return paths.some(r => r.selector === 8)
		? paths.map(r => r.selector === 8 ? {...r, initialFill: all ? 1 : 0} as PathRecord : r)
		: [initial, ...paths];
}

/** The blocks of a shape layer that is a layer's other blocks with this outline (in canvas pixels) filled with a colour: the vector mask is
 *  made, and a solid fill; what the layer had of a fill or a mask of its own is replaced. */
export function shapeBlocks(blocks: LayerBlocks | undefined, curve: curveVertex[], colour: RGB, width: number, height: number): LayerBlocks {
	const {vmsk, vsms, SoCo, GdFl, vscg, ...rest} = blocks ?? {};
	return {
		...rest,
		SoCo: {key: 'SoCo', version: 16, descriptor: {name: '', classId: 'null', items: put({}, solidFillSpec, {colour})}},
		vmsk: {key: 'vmsk', version: 3, flags: 0, paths: [...maskPreamble(), ...curveToPaths(curve, width, height)]},
	} as LayerBlocks;
}

/** A paint for a new shape layer: a colour, or a linear gradient through its stops (evenly spaced) from one point to another, in canvas pixels */
export type NewPaint = RGB | {from: {x: number, y: number}, to: {x: number, y: number}, stops: RGB[]};

/** A new shape layer of this outline (in canvas pixels) with a fill, or a stroke (round at its ends and joins), or both. A gradient is laid out
 *  on the outline's box as a file keeps it. The layer's pixels are only of the box it paints. */
export function newShapeLayer(name: string, curve: curveVertex[], stack: {width: number, height: number}, fill?: NewPaint, stroke?: {width: number, paint: NewPaint}): PixelLayer {
	const {width, height} = stack;
	let blocks = shapeBlocks(undefined, curve, {r: 0, g: 0, b: 0}, width, height);
	const points = pathsToCurve(findVectorMask(blocks)!, width, height), box = curveBox(points, stack);
	const paint = (p: NewPaint): Fill => 'stops' in p
		? {...gradientDefaults, stops: p.stops.map((color, i) => ({offset: i / Math.max(1, p.stops.length - 1), color, opacity: 1})),
			...gradientFromHandles(gradientDefaults, [float2(p.from.x, p.from.y), float2(p.to.x, p.to.y)], box)}
		: {type: 'solid', colour: p};

	const f = fill && paint(fill);
	const s = stroke && {...newShapeStroke(), width: stroke.width, cap: 'round', join: 'round', paint: paint(stroke.paint)} as Stroke;
	if (f)
		blocks = withFill(blocks, f);
	if (s)
		blocks = f ? withShapeStroke(blocks, s) : withNewShapeStroke(blocks, s, true, false);

	// its pixels: what it paints, over as much of the canvas as that reaches
	const pad	= s ? Math.ceil(strokeReach(s)) : 1;
	const left	= Math.min(width - 1, Math.max(0, Math.floor(box.min.x) - pad)), top = Math.min(height - 1, Math.max(0, Math.floor(box.min.y) - pad));
	const w		= Math.max(1, Math.min(width, Math.ceil(box.max.x) + pad) - left), h = Math.max(1, Math.min(height, Math.ceil(box.max.y) + pad) - top);
	const ctx	= createElement('canvas', {width: w, height: h}).getContext('2d', {willReadFrequently: true})!;
	ctx.translate(-left, -top);
	paintShape(ctx, points, f, s, stack);
	return {kind: 'shape', name, left, top, opacity: 1, visible: true, blend: 'norm', blocks, image: {data: ctx.getImageData(0, 0, w, h).data, width: w, height: h}};
}

/** The fill a layer's blocks have of their own (a colour or a gradient), if any. */
export function ownFill(blocks: LayerBlocks | undefined): Fill | undefined {
	const colour = solidColour(blocks);
	return colour ? {type: 'solid', colour} : gradientFill(blocks);
}

//=============================================================================
//	editing: the shape editor, and opening a layer to edit
//=============================================================================

// what is edited, which the editor changes in place (and what the layers make of it is in LayeredMode)
export interface ShapeSession {
	layer: Layer;
	mask?:		boolean;	// the path is the layer's vector mask, not a shape's: it has no fill or stroke
	blocks: psd.LayerBlocks;
	state(): ShapeState;
	width:		number;
	height:		number;
	points:		curveVertex[];
	fill?:		Fill;		// what the Fill icon edits, if there is something to
	spare?:		Fill;		// the fill the shape has but is not showing, which is put back if it is given a fill again
	stroke?:	Stroke;		// the shape's own stroke, if it has one
}

/** The handles of a gradient on the box it is laid out on: the start and end of a linear one, or the centre, a place a radius away
 *  and the focus (the centre) of a radial one. */
function gradientHandles(g: GradientFill, box: float2.extent): float2[] {
	const geo = gradientGeometry(g, box);
	return geo.type === 'radial'
		? [geo.c, geo.c.add(float2(geo.r, 0)), geo.c]
		: [geo.p1, geo.p2];
}

/** The angle, scale and offset a gradient has when its handles lie where `p` says, on the box it is laid out on. */
function gradientFromHandles(g: GradientFill, p: float2[], box: float2.extent) {
	const size		= box.size(), d = p[1].sub(p[0]), radial = g.type === 'radial';
	const angle		= !radial && (d.x || d.y) ? Math.atan2(-d.y, d.x) * 180 / Math.PI : g.angle;
	// what a scale of 1 spans, and what the handles do (a radial gradient's second handle is a radius away, a linear one's a whole length)
	const reach		= radial ? size.len() : size.dot(d.abs()) / d.len();
	const span		= radial ? 2 * d.len() : d.len();
	const middle	= radial ? p[0] : p[0].add(p[1]).scale(0.5);
	return {
		angle,
		scale:		span && reach ? Math.max(0.01, span / reach) : g.scale,
		offset:		size.x && size.y ? middle.sub(box.centre()).div(size) : g.offset,
	};
}
const icons = {
	add:		'<circle cx="8" cy="8" r="5"/><path d="M8 5.5V10.5M5.5 8H10.5"/>',
	addFill:	'<rect x="3" y="3" width="10" height="10" fill="currentColor" fill-opacity="0.3" stroke-dasharray="2 2"/><path d="M8 5.5V10.5M5.5 8H10.5"/>',
	addStroke:	'<rect x="3" y="3" width="10" height="10" stroke-dasharray="2 2"/><path d="M8 5.5V10.5M5.5 8H10.5"/>',
	remove:		'<rect x="3" y="3" width="10" height="10"/><path d="M5 5L11 11M11 5L5 11"/>',
	reverse:	'<path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/>',
	linear:		'<defs><linearGradient id="shape-icon-lin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity="0.1"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><rect x="2" y="2" width="12" height="12" fill="url(#shape-icon-lin)"/>',
	radial:		'<defs><radialGradient id="shape-icon-rad" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0.1"/></radialGradient></defs><rect x="2" y="2" width="12" height="12" fill="url(#shape-icon-rad)"/>',
};

function curveBox(curve: curveVertex[], canvas: {width: number, height: number}) {
	return curve.length ? curveExtentQuick(curve) : float2.extent.fromSize(float2(0, 0), float2(canvas.width, canvas.height));
}

// The gradient of the fill, edited on the drawing (see gradientmode.ts): its handles are in the canvas's pixels, laid out on the box
// the gradient is aligned to (the path's, or the canvas), so they follow from the gradient's angle, scale and offset and give them
// back. A linear gradient's middle is the middle of its axis, and a radial one's its centre.
class ShapeGradient extends GradientEditor {
	protected override readonly spreads = false;

	constructor(private readonly session: ShapeSession, readonly g: GradientFill, redraw: () => void, private readonly edited: () => void) {
		super('fill', 
			gradientHandles(g, gradientBox(g, curveBox(session.points, session), session)),
			float2x3.identity(), redraw
		);
	}

	refresh() {
		this.points.splice(0, this.points.length,
			...gradientHandles(this.g, gradientBox(this.g, curveBox(this.session.points, this.session), this.session))
		);
	}

	options(): PaintOptions {
		const g = this.g;
		return {
			label:	'Fill',
			modes:	['linear', 'radial'],
			get:	(): Paint => ({type: g.type, stops: gradientStops(g).map(s => ({...s})), spread: 'pad'}),
			set:	paint => {
				if ('stops' in paint) {
					g.stops = gradientStops({...g, stops: paint.stops.map(s => ({...s}))});		// (as they are kept: a reversed gradient has them the other way about)
					this.edited();
				}
			},
		};
	}

	// the gradient's angle, scale and offset from the handles
	private apply() {
		Object.assign(this.g, gradientFromHandles(this.g, this.points, gradientBox(this.g, curveBox(this.session.points, this.session), this.session)));
	}

	updateContent() {
		this.apply();
	}

	commit() {
		this.apply();
		this.refresh();
		this.edited();
	}
}

const removeItem = (id: string, caption: string, remove: () => void): CascadeItem => ({id: `${id}-remove`, face: () => svgFace(icons.remove), caption: () => caption, select: () => { remove(); }});

const strokeIcon = (colour: string) => `<rect x="3" y="3" width="10" height="10" fill="none" stroke="${colour}" stroke-width="3"/>`;

// The menu of a shape's stroke: its colour, width, which side of the path it lies on, the ends and corners of its lines and whether
// they are dashed. `edited` is told of a change.
function strokeItems(id: string, stroke: Stroke, edited: () => void, paint: CascadeItem, remove: () => void): CascadeItem {
	const choice = <K extends keyof Stroke>(caption: string, key: K, values: {value: Stroke[K], icon: string, caption: string}[]) =>
		choiceItem({caption, get: () => stroke[key], set: v => { stroke[key] = v; edited(); }}, values.map(v => ({value: v.value, face: svgFace(v.icon), caption: v.caption})));
	const dashed = (dashes: number[]) => stroke.dashes && dashes.length === stroke.dashes?.length && dashes.every((d, i) => d === stroke.dashes![i]);
	return {
		id,
		face:		() => svgFace(strokeIcon(stroke.paint?.type === 'solid' ? toHex(stroke.paint.colour) : 'currentColor')),
		caption:	() => `Stroke: ${stroke.paint?.type === 'solid' ? toHex(stroke.paint.colour) : stroke.paint?.type + ' gradient'}, ${+stroke.width.toFixed(2)} px, ${stroke.align}`,
		children:	() => [
			paint,
			removeItem(id, 'Remove the stroke', remove),
			valueItem({
				label: 'width', caption: 'Width (pixels)', min: 0.25, max: 500, get: () => stroke.width, set: v => { stroke.width = v; edited(); },
				step: (v, steps) => Math.round(v * 1.2 ** steps * 100) / 100, presets: [1, 5, 10, 25, 50, 100], resolution: 0.01,
				format: v => String(+v.toFixed(2)),
			}),
			valueItem({
				label: 'opac', caption: 'Opacity (%)', min: 0, max: 100, presets: [0, 25, 50, 75, 100],
				get: () => stroke.opacity * 100, set: v => { stroke.opacity = v / 100; edited(); },
			}),
			choice('Position', 'align', [
				{value: 'inside', icon: '<rect x="2" y="2" width="12" height="12"/><rect x="2" y="2" width="12" height="12" stroke-width="4" opacity="0.4"/>', caption: 'Inside'},
				{value: 'center', icon: '<rect x="4" y="4" width="8" height="8"/><rect x="4" y="4" width="8" height="8" stroke-width="3" opacity="0.4"/>', caption: 'Centre'},
				{value: 'outside', icon: '<rect x="5" y="5" width="6" height="6"/><rect x="5" y="5" width="6" height="6" stroke-width="4" opacity="0.4"/>', caption: 'Outside'},
			]),
			choice('Ends', 'cap', [
				{value: 'butt', icon: '<path d="M3 8H11" stroke-width="4"/>', caption: 'Flat'},
				{value: 'round', icon: '<path d="M4 8H10" stroke-width="4" stroke-linecap="round"/>', caption: 'Round'},
				{value: 'square', icon: '<path d="M4 8H10" stroke-width="4" stroke-linecap="square"/>', caption: 'Square'},
			]),
			choice('Corners', 'join', [
				{value: 'miter', icon: '<path d="M3 13V3H13" stroke-width="3" stroke-linejoin="miter"/>', caption: 'Mitred'},
				{value: 'round', icon: '<path d="M3 13V3H13" stroke-width="3" stroke-linejoin="round"/>', caption: 'Round'},
				{value: 'bevel', icon: '<path d="M3 13V3H13" stroke-width="3" stroke-linejoin="bevel"/>', caption: 'Bevelled'},
			]),
			choiceItem({
				caption:	'Dashes',
				get:		() => dashed([]) ? 'solid' : dashed([4, 2]) ? 'dashed' : dashed([1, 1]) ? 'dotted' : 'dashed',
				set:		v => { stroke.dashes = v === 'solid' ? [] : v === 'dashed' ? [4, 2] : [1, 1]; stroke.cap = v === 'dotted' ? 'round' : stroke.cap; edited(); },
			}, [
				{value: 'solid', face: svgFace('<path d="M2 8H14" stroke-width="2"/>'), caption: 'Solid'},
				{value: 'dashed', face: svgFace('<path d="M2 8H5M7 8H10M12 8H14" stroke-width="2"/>'), caption: 'Dashed'},
				{value: 'dotted', face: svgFace('<path d="M2 8H3M5 8H6M8 8H9M11 8H12" stroke-width="2"/>'), caption: 'Dotted'},
			]),
		],
	};
}

// What something is painted with: a colour, which has its red, green and blue, or a gradient, which can be changed in kind (linear
// or radial), angle and scale. `paint` is changed in place, and `edited` told of each change. Where the gradient can have its stops and
// ends dragged on the drawing (in the shape editor), `onDrawing` turns that on and off (a click on the icon).
// A colour does not become a gradient or the other way about.
export function paintItem(id: string, label: string, paint: Fill, edited: () => void, remove?: () => void, onDrawing?: {active: () => boolean, toggle: () => void}): CascadeItem {
	if (paint.type === 'solid') {
		return {
			id,
			face:		() => swatchFace(toHex(paint.colour)),
			caption:	() => `${label} ${toHex(paint.colour)}`,
			children:	() => [
				...colourItems(id, () => paint.colour, colour => { paint.colour = colour; edited(); }, () => true, []),
				...(remove ? [removeItem(id, 'Remove the fill', remove)] : []),
			],
		};
	}
	const g = paint;
	return {
		id,
		face:		() => svgFace(g.type === 'radial' ? icons.radial : icons.linear),
		caption:	() => `${label}: ${g.type} gradient${onDrawing ? ' (click to edit it on the drawing)' : ''}`,
		...(onDrawing && {
			active:	onDrawing.active,
			click:	() => { onDrawing.toggle(); return true; },
		}),
		children:	() => [
			choiceItem({caption: 'Type', get: () => g.type, set: v => { g.type = v; edited(); }}, [
				{value: 'linear' as const, face: svgFace(icons.linear), caption: 'Linear'},
				{value: 'radial' as const, face: svgFace(icons.radial), caption: 'Radial'},
			]),
			...(g.type === 'linear' ? [valueItem({
				label: 'angle', caption: 'Angle (degrees)', min: -180, max: 180, presets: [-180, -90, 0, 90, 180],
				get: () => g.angle, set: v => { g.angle = v; edited(); }, step: (v, steps) => v + 5 * steps,
			})] : []),
			valueItem({
				label: 'scale', caption: 'Scale (%)', min: 10, max: 150, presets: [10, 50, 100, 150],
				get: () => g.scale * 100, set: v => { g.scale = v / 100; edited(); }, step: (v, steps) => v + 5 * steps,
			}),
			toggleItem('Reverse', svgFace(icons.reverse), () => g.reverse, v => { g.reverse = v; edited(); }),
			...(remove ? [removeItem(id, 'Remove the fill', remove)] : []),
		],
	};
}

/** The fill of a fill layer that fills all (one with no shape), to be changed from the layers' menu; undefined if it is not one.
 *  (A shape's fill is the shape editor's, as is dragging a gradient on the drawing.) */
export function fillLayerItem(edit: BlocksEdit): CascadeItem | undefined {
	const blocks = edit.get();
	const fill = blocks && !blocks.vscg && !findVectorMask(blocks) ? ownFill(blocks) : undefined;
	return fill && paintItem('fill', 'Fill', fill, () => edit.put(withFill(edit.get() ?? {}, fill), false));
}

// The editor of the current layer's shape, over the picture in place of the tools while it has one (`open`).
export class ShapeEditor extends PathEditor {
	protected override cubic = true;		// (a shape's path is of cubic segments, which is all that a file's can be)
	private picture?:		LayeredMode;
	private session?:		ShapeSession;
	private gradientMode?:	ShapeGradient;		// when the gradient is what is being edited, in place of the path's points
	private shown			= '';				// the session as it was last shown, to tell a change from a redraw
	private hidden			= false;			// something over it has the picture (a transform): it is out of the way
	private off?:			() => void;			// it has the picture while it has a session: how it gives it back
	private readonly statusText = createElement('div', {style: {position: 'absolute', left: '8px', bottom: '6px', opacity: '0.7', pointerEvents: 'none', fontSize: '11px'}});

	constructor(private canvas: HTMLCanvasElement) {
		const parent = canvas.parentElement!;
		const host = createElement('div', {className: 'pathedit-host', style: {position: 'absolute', inset: '0', display: 'none'}});
		parent.append(host);
		super(host, new ViewOptions(DEFAULT_OPTIONS), false);
		host.append(this.statusText);
		// (its drawing is part of the picture: the pointer there is in the picture's stack, as is the editor while it is open)
		Input.on(canvas).include(this.svg);
	}

	// The editor in the picture's stack, over the tools, while it has a session; the keys it does not use are the page's. It is put out of
	// the way while something over it (a transform) has the picture.
	private hold(on: boolean) {
		if (on && !this.off) {
			this.off = Input.on(this.canvas).add({
				...this.input,
				holds:		true,
				key:		e => !e.metaKey && !e.ctrlKey && (this.key(e) || (e.key === 'Escape' && this.leaveGradient())),
				covered:	by => {
					this.hidden = by !== undefined;
					this.host.style.display = this.hidden ? 'none' : '';
					this.draw();
				},
			}, Place.editor);
		} else if (!on && this.off) {
			this.off();
			this.off	= undefined;
			this.hidden	= false;
		}
	}

	/** A shape to edit over the picture, or none: the editor goes. Opened again on the same picture (after an undo) it keeps its tool. */
	open(picture?: LayeredMode, session?: ShapeSession) {
		this.picture		= picture;
		this.session		= picture && session;
		this.gradientMode	= undefined;
		this.reset();
		this.hold(!!this.session);
		this.host.style.display = this.session && !this.hidden ? '' : 'none';
		if (!this.session)
			this.cascade.close();
		this.shown = this.signature();
		this.draw();
	}

	private signature() {
		const s = this.session;
		return s ? svgPath(s.points) + JSON.stringify([s.fill, s.stroke]) : '';
	}

	// the view is the picture's, and a change to the session is shown on it
	override draw() {
		if (this.picture && this.session) {
			// (the canvas's pixels are in the window's: client = pixel * s + t)
			const pan = this.picture.pan, r = this.svg.getBoundingClientRect(), c = this.canvas.getBoundingClientRect(), k = c.width / this.canvas.width;
			this.view = {s: pan.scale * k, t: float2(c.left + pan.offset.x * k - r.left, c.top + pan.offset.y * k - r.top)};
			this.gradientMode?.updateContent();		// (the gradient from its handles, as they are dragged)
			const now = this.signature();
			if (now !== this.shown) {
				this.shown = now;
				this.picture.previewEdit();
			}
		}
		super.draw();
	}
	protected override moveView(by: float2) {
		this.picture?.pan.moveBy(by.scale(this.canvas.width / this.canvas.getBoundingClientRect().width));
		this.picture?.redraw();
	}
	override zoom(factor: number, c = float2(this.host.clientWidth / 2, this.host.clientHeight / 2)) {
		const r = this.svg.getBoundingClientRect();
		this.picture?.pan.zoomAbout(c.x + r.left, c.y + r.top, factor);
		this.picture?.redraw();
	}
	override fit() { this.picture?.fit(); this.picture?.redraw(); }

	// something about the fill or a stroke was changed: a step of an edit of them
	private edited() {
		this.gradientMode?.refresh();
		this.shown = this.signature();
		this.picture?.commitEdit('Shape Paint', 'paint');
		this.draw();
	}

	/** The gradient edited on the drawing, in place of the path's points. */
	enterGradient(g: GradientFill) {
		this.gradientMode = new ShapeGradient(this.session!, g, () => this.draw(), () => this.edited());
		this.reset();
		this.draw();
	}

	/** Back to the path's points; false if the gradient was not what was being edited. */
	leaveGradient() {
		if (!this.gradientMode)
			return false;
		this.gradientMode = undefined;
		this.reset();
		this.draw();
		return true;
	}

	// the fill: a colour, or a gradient, which can be changed in kind (linear or radial) and in its stops, but a solid fill
	// does not become a gradient or the other way about
	protected pageItems(): CascadeItem[] {
		const items: CascadeItem[] = [], session = this.session;
		if (!session || session.mask)
			return items;
		if (session.fill)
			items.push(this.paintOf('fill', 'Fill', session.fill, () => this.setFill()));
		else
			items.push({id: 'fill-add', face: () => svgFace(icons.addFill), caption: () => 'Add a fill', select: () => { this.setFill(session.spare ?? {type: 'solid', colour: {r: 0, g: 0, b: 0}}); }});
		const stroke = session.stroke;
		if (stroke && stroke.paint) {
			items.push(strokeItems('stroke', stroke, () => this.edited(), this.paintOf('stroke-paint', 'Colour', stroke.paint), () => this.setStroke()));
		} else if (!stroke) {
			items.push({id: 'stroke-add', face: () => svgFace(icons.addStroke), caption: () => 'Add a stroke', select: () => { this.setStroke(newShapeStroke()); }});
		}
		return items;
	}

	// the shape given a fill, or its fill taken away: an edit of its own
	private setFill(fill?: Fill) {
		if (!this.session)
			return;
		this.leaveGradient();
		this.session.fill = fill;
		this.shown = this.signature();
		this.picture?.commitEdit(fill ? 'Add Fill' : 'Remove Fill');
		this.draw();
	}

	// the shape given a stroke, or its stroke taken away: an edit of its own
	private setStroke(stroke?: Stroke) {
		if (!this.session)
			return;
		this.session.stroke = stroke;
		this.gradientMode?.refresh();
		this.shown = this.signature();
		this.picture?.commitEdit(stroke ? 'Add Stroke' : 'Remove Stroke');
		this.draw();
	}
	// the menu is the page's, with the editor's items among it; but for the gradient's, which is the whole menu
	protected override showMenu(x: number, y: number) {
		if (this.only())
			super.showMenu(x, y);
		else
			Mode.openMenu(x, y);
	}

	// what the shape is painted with, as paintItem has it, with a gradient's stops and ends dragged on the drawing (a click on its icon,
	// or Escape to leave it)
	private paintOf(id: string, label: string, paint: Fill, remove?: () => void): CascadeItem {
		return paintItem(id, label, paint, () => this.edited(), remove, paint.type === 'solid' ? undefined : {
			active:	() => this.gradientMode?.g === paint,
			toggle:	() => { this.gradientMode?.g === paint ? this.leaveGradient() : this.enterGradient(paint); },
		});
	}

	points()				{ return this.gradientMode ? undefined : this.session?.points; }
	canEdit()				{ return !!this.session && !this.gradientMode; }
	protected structural()	{ return !this.gradientMode; }
	active()				{ return !!this.session && !this.hidden; }
	status(text: string)	{ this.statusText.textContent = text; }
	commit(label: string, key?: string) {
		if (this.gradientMode) {
			this.gradientMode.commit();
		} else {
			this.shown = this.signature();
			this.picture?.commitEdit(label, key);
			this.draw();
		}
	}
	describe()				{ return this.gradientMode ? this.gradientMode.describe() : `${this.session?.points.filter(p => p.flags === 0).length ?? 0} subpaths · ${this.session?.points.length ?? 0} points`; }
	bounds()				{ return new float2.extent(float2(0, 0), float2(this.session?.width ?? 1, this.session?.height ?? 1)); }
	protected defaultSize()	{ return Math.max(this.session?.width ?? 0, this.session?.height ?? 0) / 4; }

	protected override simplifyPoints(points: curveVertex[], tol: number) { return simplify(points, tol, true); }

	// A stroke drawn freehand (the pen: a press anywhere starts one, unless Shift is held, which moves the view), as an open contour that
	// follows it to within two pixels
	private stroke?: float2[];
	protected override extraTools(): ToolChoice[] {
		return [{value: 'freehand', face: svgFace('<path d="M2 13C4 4 7 4 8 8S12 12 14 3"/>'), caption: 'Freehand (Shift moves the view)'}];
	}
	private async drawStroke(world: float2[]) {
		const session = this.session;
		if (!session || world.length < 2)
			return;
		const points = await fitStroke(world.flatMap(p => [p.x, p.y]), 2 / this.view.s);
		if (points.length > 1 && this.session === session) {
			session.points.push(...points);
			this.commit('Draw path');
		}
	}
	protected capture(e: PointerEvent, at: float2): DragHandler | undefined {
		if (this.gradientMode)
			return this.gradientMode.capture(this, at);
		if (this.tool !== 'freehand' || !this.canDraw() || e.shiftKey)
			return;
		const w = this.toWorld(at), mine: float2[] = this.stroke = [w];
		return {
			raw:	true,
			move:	d => { mine.push(w.add(d)); },
			end:	moved => {
				this.stroke = undefined;
				this.draw();
				if (moved)
					void this.drawStroke(mine);
			},
		};
	}
	protected menuOnly(here: float2) { return this.gradientMode?.menu(this, here); }
	protected overlay() {
		if (this.stroke?.length)
			return `<path class="insp-draw" d="M${this.stroke.map(w => { const p = this.worldToScreen(w); return `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`; }).join('L')}" fill="none"/>`;
		return this.gradientMode?.overlay(this) ?? '';
	}
}

/** A layer's vector data carried with the picture: `map` takes a place on the old canvas to the new. The path goes where it is
 *  carried, and the gradients (a fill's and an overlay's), which are laid out on the path's box, are made to lie where they were
 *  carried to. The pixels are the transform's own. */
export function transformBlocks(blocks: LayerBlocks, map: (x: number, y: number) => [number, number], from: {width: number, height: number}, to: {width: number, height: number}): LayerBlocks {
	const mask = findVectorMask(blocks);
	if (!mask)
		return blocks;
	const oldBox	= curveExtentQuick(pathsToCurve(mask, from.width, from.height));
	const carry		= (p: {x: number, y: number}) => {
		const [x, y] = map(p.x * from.width, p.y * from.height);
		return {y: y / to.height, x: x / to.width};
	};
	const paths		= mask.map(r => 'anchor' in r ? {...r, before: carry(r.before), anchor: carry(r.anchor), after: carry(r.after)} : r) as PathRecord[];
	const newBox	= curveExtentQuick(pathsToCurve(paths, to.width, to.height));

	const place = (d: Items) => {
		const spec = {...gradientSpec}; delete (spec as any).stops;
		const g = readSpec(spec, d);
		if (g) {
			const moved = gradientHandles(g, gradientBox(g, oldBox, from)).map(h => float2(...map(h.x, h.y)));
			put(d, spec, {...g, ...gradientFromHandles(g, moved, gradientBox(g, newBox, to))});
		}
	};

	const gdfl = structuredClone(shapeBlock(blocks, 'GdFl'));
	if (gdfl)
		place(gdfl.descriptor.items);
	const lfx2 = structuredClone(blocks.lfx2);
	if (lfx2) {
		const d		= items(lfx2.descriptor.items.GrFl);
		if (d)
			place(d);
	}
	const key = blocks?.vmsk?.paths ? 'vmsk' : 'vsms';

	return {...blocks, [gdfl?.key??'GdFl']: gdfl, lfx2, [key]: {...blocks[key], paths}};
}


// Edit the path of a shape layer, and its own fill (a colour or a gradient) and stroke; what its layer style adds (an overlay, a
// stroke) is edited from the style's menu. An edit replaces the file's vector mask with the path and writes the settings, the rest
// of what the file keeps of the layer left as it was, and makes the fill and stroke again as the layer's pixels. Undefined if it is
// not a shape, or one that cannot be edited here: a stroke that is not a solid colour (which is not made, so editing the path would
// lose it), or a fill that is not a colour or a linear or radial gradient.
export function openShape(layer: PixelLayer, stack: {width: number, height: number}): ShapeSession | undefined {
	const blocks = layer.blocks, mask = findVectorMask(blocks);
	// (a fill layer with no shape is its fill over the whole canvas, which is a shape that has not been made smaller; any other
	// layer's vector mask is not a shape's)
	if (!blocks || !hasFill(blocks))
		return;
	const stroke = shapeStroke(blocks);
	if (stroke && !stroke.paint)
		return;

	// the fill the layer's pixels are made of, if it shows
	const shows		= fillEnabled(blocks);
	const colour	= solidColour(blocks), gradient = gradientFill(blocks);
	const own: Fill | undefined = colour ? {type: 'solid', colour} : gradient;
	if (shows && !own)
		return;

	const {width, height} = stack;
	const session = {width, height, fill: shows ? own : undefined, spare: own, stroke, points: mask ? pathsToCurve(mask, width, height) : []};

	// the layer as the session has it
	const state = (): ShapeState => {
		const edited	= session.points;
		const fill		= session.fill;

		let written = blocks;
		if (fill)
			written = withFill(written, fill);
		if (fill && !shows)
			written = withFillEnabled(written, true);		// (a fill that had been turned off is put back)
		else if (!fill && shows)
			written = withFillEnabled(written, false);
		// (a shape with no contours is not a shape: its layer's fill fills all, which a fill layer has no vector mask for)
		if (!edited.length) {
			const {vmsk, vsms, ...rest} = written;
			written = rest;
		} else if (written.vmsk) {
			written = {...written, vmsk: {...written.vmsk, paths: curveToPaths(edited, width, height, mask), key: 'vmsk'}};
		} else if (written.vsms) {
			written = {...written, vsms: {...written.vsms, paths: curveToPaths(edited, width, height, mask), key: 'vsms'}};
		} else {		// (a fill layer is given a shape when it is first drawn)
			written = {...written, vmsk: {key: 'vmsk', version: 3, flags: 0, paths: [...maskPreamble(), ...curveToPaths(edited, width, height)]}};
		}
		if (session.stroke)
			written = withShapeStroke(written, session.stroke);
		else if (stroke)
			written = withoutShapeStroke(written);		// (it was taken away)

		// the layer's own pixels are the fill that shows and the shape's own stroke, if it has one
		if (!fill && !session.stroke)
			return {image: layer.image, left: layer.left, top: layer.top, blocks: written};
		const context = createElement('canvas', {width, height}).getContext('2d')!;
		paintShape(context, edited, fill, session.stroke, stack);
		const raster = context.getImageData(0, 0, width, height);
		return {image: {data: raster.data, width, height}, left: 0, top: 0, blocks: written};
	};
	return Object.assign(session, {layer, blocks, state});
}

// Edit the path of a layer's vector mask (one that is not a shape's outline). An edit replaces the paths of the mask, what the file
// keeps besides them left as it was. A mask with no contours shows all of the layer, and given its first it shows what is inside it.
// Undefined if the layer has no such mask.
export function openVectorMask(layer: Layer, stack: {width: number, height: number}): ShapeSession | undefined {
	const blocks = layer.blocks, block = maskBlock(blocks);
	if (!blocks || !block)
		return;
	const {width, height} = stack, points = pathsToCurve(block.paths, width, height), had = points.length > 0;
	const all = block.paths.some(r => r.selector === 8 && r.initialFill);
	const session = {width, height, points, mask: true};
	const state = (): ShapeState => {
		const edited = session.points;
		const paths = withInitialFill(curveToPaths(edited, width, height, block.paths), edited.length ? had && all : true);
		return {blocks: blocks.vmsk ? {...blocks, vmsk: {...blocks.vmsk, paths, key: 'vmsk'}} : {...blocks, vsms: {...blocks.vsms!, paths, key: 'vsms'}}};
	};
	return Object.assign(session, {layer, blocks, state});
}

//=============================================================================
//	rendering: fills, strokes and shapes as pictures
//=============================================================================

function gradientBox(g: Fill, path: float2.extent, canvas: {width: number, height: number}) {
	return g.type !== 'solid' && g.align ? path : float2.extent.fromSize(float2(0, 0), float2(canvas.width, canvas.height));
}
/** The stops as they lie along the gradient, which a reversed one has the other way about. */
function gradientStops(g: GradientFill): Stop[] {
	const stops = [...g.stops].sort((a, b) => a.offset - b.offset);
	return g.reverse ? stops.map(s => ({...s, offset: 1 - s.offset})).reverse() : stops;
}

function gradientGeometry(g: GradientFill, box: float2.extent) {
	const size = box.size(), c = box.centre().add(float2(g.offset.x, g.offset.y).mul(size));
	if (g.type === 'radial')
		return {type: 'radial' as const, c, r: Math.max(0.001, g.scale * size.len() / 2)};
	const d		= float2.cossin(g.angle * Math.PI / -180);
	const half	= Math.max(0.001, g.scale * size.dot(d.abs()) / 2);
	return {type: 'linear' as const, p1: c.sub(d.scale(half)), p2: c.add(d.scale(half))};
}

/** How far a stroke may reach beyond the path it follows. */
function strokeReach(s: Stroke) {
	if (s.align === 'inside')
		return 0;
	const corners = s.join === 'miter' ? Math.min(s.miterLimit ?? 0, 4) : 1;
	return (s.align === 'outside' ? s.width : s.width / 2) * corners + 2;
}


/** The length of a path's first contour (as the cubic segments of pathsToCurve make it). */
function pathLength(points: curveVertex[]) {
	let length = 0, at = points[0];
	for (let i = 1; i + 2 < points.length && points[i].flags === OFF_BEZ3; i += 3) {
		const b = new bezier3(float2(at.x, at.y), float2(points[i].x, points[i].y), float2(points[i + 1].x, points[i + 1].y), float2(points[i + 2].x, points[i + 2].y));
		length += b.lengthTo(1);
		at = points[i + 2];
		if (at.flags !== ON_CURVE)
			break;
	}
	return length;
}

/** The stroke drawn along `path` (nonzero) onto a canvas, in its colour or gradient (laid out on the path's `box`, or the canvas) and with its dashes. */
export function strokePath(ctx: CanvasRenderingContext2D, path: Path2D, s: Stroke, box: float2.extent, canvas: {width: number, height: number}, length?: number) {
	ctx.save();
	ctx.strokeStyle		= s.paint ? gradientStyle(ctx, s.paint, box, canvas) : '';
	ctx.lineCap			= s.cap ?? 'butt';
	ctx.lineJoin		= s.join ?? 'bevel';
	ctx.miterLimit		= Math.max(1, s.miterLimit ?? 0);
	ctx.lineDashOffset	= s?.dashOffset ?? 0;
	if (s.align === 'center') {
		ctx.lineWidth = s.width;
		ctx.setLineDash(s.dashes?.length ? s.dashes.map(d => d * s.width) : []);
	} else {
		// only the half of a line twice as wide that lies to one side of the path: inside it, or everywhere but
		const keep = new Path2D();
		if (s.align === 'outside')
			keep.rect(-1e6, -1e6, 2e6, 2e6);
		keep.addPath(path);
		ctx.clip(keep, s.align === 'outside' ? 'evenodd' : 'nonzero');
		ctx.lineWidth = s.width * 2;
		// Photoshop lays the dashes along the line it strokes (the middle of what is drawn), which for a stroke on one side of a closed
		// path is the path moved by half the width, shorter or longer by a half turn of a circle of that radius; here they lie along the path
		const along = !length ? 1 : length / Math.max(1, length + (s.align === 'outside' ? 1 : -1) * Math.PI * s.width);
		ctx.setLineDash(s.dashes?.length ? s.dashes.map(d => d * s.width * along) : []);
	}
	ctx.stroke(path);
	ctx.restore();
}

// The shape the styles follow: a vector shape's own, drawn in opaque black, or the alpha of any other layer's pixels
export function vectorMaskShape(blocks: LayerBlocks | undefined, width:number, height: number) {
	const mask = isShape(blocks) ? findVectorMask(blocks) : undefined;
	if (mask) {
		const points	= pathsToCurve(mask, width, height), box = curveExtentQuick(points);
		const own		= shapeStroke(blocks);
		const pad		= own ? Math.ceil(strokeReach(own)) : 0;
		const left		= Math.max(0, Math.floor(box.min.x) - pad), top = Math.max(0, Math.floor(box.min.y) - pad);
		const w			= Math.min(width, Math.ceil(box.max.x) + pad) - left, h = Math.min(height, Math.ceil(box.max.y) + pad) - top;
		if (w <= 0 || h <= 0)
			return;

		const canvasOf = (width: number, height: number) => createElement('canvas', {width, height});
		
		const ctx	= canvasOf(w, h).getContext('2d', {willReadFrequently: true})!;
		const path	= new Path2D(svgPath(points));

		ctx.translate(-left, -top);
		ctx.fillStyle = '#000';
		if (fillEnabled(blocks) || !own)
			ctx.fill(path, 'nonzero');
		if (own)
			strokePath(ctx, path, {...own, opacity: 1, paint: {type: 'solid', colour: {r: 0, g: 0, b: 0}}}, box, {width, height}, undefined);

		return alphaShape(ctx.getImageData(0, 0, w, h), left, top);
	}
}

// how a subpath of a vector mask goes with what the ones before it have made: exclude, combine, subtract, intersect
const MASK_OPERATION: GlobalCompositeOperation[] = ['xor', 'source-over', 'destination-out', 'destination-in'];
const vectorMasks = new WeakMap<LayerBlocks, {size: string, mask: LayerMask | undefined}>();

/** A layer's vector mask as it hides the layer, drawn into one byte a pixel over the box of its paths, outside which it is what it
 *  starts as (all or nothing), with the density and feather the layer gives it (which the shaders apply). Undefined if it has none or it is turned
 *  off, or the layer is a shape, whose fill is made only inside the path. Subpaths of one shape are filled together, and each shape
 *  is put with those before it as it says. */
export function vectorMask(layer: Pick<Layer, 'blocks' | 'vectorMaskDensity' | 'vectorMaskFeather'>, width: number, height: number): LayerMask | undefined {
	const blocks = layer.blocks, block = maskBlock(blocks);
	if (!blocks || !block || block.flags & 4)
		return;
	const size = `${width}x${height}`;
	let entry = vectorMasks.get(blocks);
	if (!entry || entry.size !== size) {
		entry = {size, mask: drawVectorMask(block.paths, width, height, !!(block.flags & 1))};
		vectorMasks.set(blocks, entry);
	}
	return entry.mask && {...entry.mask, density: layer.vectorMaskDensity, feather: layer.vectorMaskFeather};
}

function drawVectorMask(paths: PathRecord[], width: number, height: number, inverted: boolean): LayerMask {
	const all = paths.some(r => r.selector === 8 && r.initialFill);

	// the subpaths, a shape at a time (a shape's are those one after another with the same number)
	const shapes: {operation: number, records: PathRecord[]}[] = [];
	paths.forEach((r, i) => {
		if (isLength(r)) {
			const records = paths.slice(i, i + 1 + r.count);
			const last = shapes[shapes.length - 1], prev = paths.slice(0, i).reverse().find(isLength);
			if (last && prev && prev.shape === r.shape)
				last.records.push(...records);
			else
				shapes.push({operation: r.operation, records});
		}
	});
	const curves = shapes.map(s => ({operation: s.operation, curve: pathsToCurve(s.records, width, height)})).filter(s => s.curve.length);

	// (at least a pixel, which with what is outside it is all there is of a mask with no paths)
	const box	= curves.reduce((box, s) => box.union(curveExtentQuick(s.curve)), new float2.extent());
	const left	= curves.length ? Math.min(width - 1, Math.max(0, Math.floor(box.min.x))) : 0, top = curves.length ? Math.min(height - 1, Math.max(0, Math.floor(box.min.y))) : 0;
	const w		= curves.length ? Math.max(1, Math.min(width, Math.ceil(box.max.x)) - left) : 1, h = curves.length ? Math.max(1, Math.min(height, Math.ceil(box.max.y)) - top) : 1;

	const ctx = createElement('canvas', {width: w, height: h}).getContext('2d', {willReadFrequently: true})!;
	ctx.fillStyle = '#fff';
	if (all)
		ctx.fillRect(0, 0, w, h);
	ctx.translate(-left, -top);
	for (const {operation, curve} of curves) {
		ctx.globalCompositeOperation = MASK_OPERATION[operation] ?? 'source-over';
		ctx.fill(new Path2D(svgPath(curve)), 'nonzero');
	}
	const rgba = ctx.getImageData(0, 0, w, h).data, data = new Uint8ClampedArray(w * h);
	for (let i = 0; i < data.length; i++)
		data[i] = rgba[i * 4 + 3];
	return {left, top, image: Pixels(data, w, h, 1), default: all ? 255 : 0, inverted, disabled: false};
}

// a shape's fill and stroke painted as they are in its pixels, over a canvas of this size
function paintShape(ctx: CanvasRenderingContext2D, curve: curveVertex[], fill: Fill | undefined, stroke: Stroke | undefined, size: {width: number, height: number}) {
	// (a shape with no contours fills all)
	const path = new Path2D(curve.length ? svgPath(curve) : `M0,0H${size.width}V${size.height}H0Z`), box = curveBox(curve, size);
	if (fill) {
		ctx.fillStyle = gradientStyle(ctx, fill, box, size);
		ctx.fill(path, 'nonzero');
	}
	if (stroke) {
		ctx.globalAlpha = stroke.opacity;
		strokePath(ctx, path, stroke, box, size, pathLength(curve));
	}
}

// A shape layer's picture for a thumbnail: what its blocks paint (its own pixels may be a placeholder, or not show its stroke)
export function shapeSmall(layer: PixelLayer, width: number, height: number, w: number, h: number): ImageData | undefined {
	const blocks = layer.blocks, mask = findVectorMask(blocks);
	if (layer.kind !== 'shape' || !blocks || !mask)
		return;
	const fill = fillEnabled(blocks) ? ownFill(blocks) : undefined;
	const stroke = shapeStroke(blocks);
	if (!fill && !stroke)
		return;
	const context = createElement('canvas', {width: w, height: h}).getContext('2d', {willReadFrequently: true})!;
	context.scale(w / width, h / height);
	paintShape(context, pathsToCurve(mask, width, height), fill, stroke?.paint ? stroke : undefined, {width, height});
	return context.getImageData(0, 0, w, h);
}

/** The CSS background a swatch shows for a fill layer that fills all (one with no shape): its colour or gradient, if it has one. */
export function fillSwatch(blocks: LayerBlocks | undefined): string | undefined {
	if (!findVectorMask(blocks)) {
		const fill = ownFill(blocks);
		if (fill)
			return fill.type === 'solid' ? toHex(fill.colour) : `linear-gradient(90deg,${gradientStops(fill).map(s => `${toCss(s.color, s.opacity)} ${s.offset * 100}%`).join(',')})`;
	}
}

/** A fill style for a canvas, painting this shape's box (else the whole canvas, for a gradient not aligned to its layer) with the fill. */
export function gradientStyle(ctx: CanvasRenderingContext2D, g: Fill, shape: float2.extent, canvas: {width: number, height: number}) {
	const box = gradientBox(g, shape, canvas);
	if (g.type === 'solid')
		return `rgb(${g.colour.r} ${g.colour.g} ${g.colour.b})`;
	const geo = gradientGeometry(g, box);
	const style = geo.type === 'radial' ? ctx.createRadialGradient(geo.c.x, geo.c.y, 0, geo.c.x, geo.c.y, geo.r) : ctx.createLinearGradient(geo.p1.x, geo.p1.y, geo.p2.x, geo.p2.y);
	for (const s of gradientStops(g))
		style.addColorStop(clamp01(s.offset), toCss(s.color, s.opacity));
	return style;

}

// The shape the styles follow: a vector shape's own, drawn in opaque black, or the alpha of any other layer's pixels
export function shapeOf(layer: PixelLayer, width: number, height: number): Shape | undefined {
	return vectorMaskShape(layer.blocks, width, height) ?? alphaShape(layer.image, layer.left, layer.top);
}

