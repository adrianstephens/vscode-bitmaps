// Editing a text layer in place, over the picture, in place of the paint tools: a text box laid over the text (which is typed into and
// changes the layer's text as it is typed), a handle to carry the text about by, and a menu of how it is set. What it does is the
// layer's (see LayeredMode.commitEdit): each change is shown on the picture as it is made, and each edit made again as the layer's pixels.

import { createElement, RPC } from '@isopodlabs/vscode_utils/webview/shared.js';
import { CascadeItem, svgFace, valueItem, choiceItem, toggleItem, colourItems, multiplicativeStep, swatchFace, opItem } from './cascade.js';
import { toHex, toCss, RGB, clamp01 } from './colour.js';
import { canvas3d, programTextWarp, postMessage } from './modes.js';
import { Input, Place } from './navigate.js';
import { meshWarp, roundOut } from './raster.js';
import { sampledExtent, Warp, carryPoint, type Carry } from './transformbox.js';
import { shapeBlocks, openShape } from './shapeedit.js';
import { float2 } from '@isopodlabs/maths/vector';
import type { psd } from '@isopodlabs/binary_bitmaps';
import { curveVertex, makeCurveVertex, ON_BEGIN, ON_CURVE, OFF_BEZ3 } from '@isopodlabs/binary_fonts/curves';
import { Descriptor, Lookup, Enum, Default, Long, Double, Text, Engine, E, SpecOf, put, readSpec, withSpec, writeField, EngineDict, EngineValue, EngineAccess, Real, Int, Flag, Reals, Str, Raw, Dict, Elems, Optional, readDict, writeDict, putDict, isDict } from './psdblocks.ts';
import type { LayeredMode, PixelLayer, ShapeState, PlacedPixels } from './layers.js';


//=============================================================================
//	serialisation
//=============================================================================

// The text of a PSD text layer, from the layer's 'TySh' block as the PSD package reads it (Layer.blocks). The block has where the text
// is (a transform), a descriptor of what it says (`Txt `), and the styled runs of it as EngineData: a PostScript-like text of
// dictionaries, arrays, numbers and UTF-16 strings. This reads that text into a tree and writes it, and makes of it the plain
// description of a text layer (TextSpec) which the editor changes and draws (see textrender.ts); what the file keeps of the text
// that the description has no place for is carried in it, and written back as it was.


const textGridding	= Lookup('textGridding',{None: 0});
const Ornt			= Lookup('Ornt',		{Hrzn: false, Vrtc: true});
const AntA			= Lookup('Annt', 		{AnCr: 0});

//-----------------------------------------------------------------------------
//	the description of a text layer
//-----------------------------------------------------------------------------

const textFields = {
	Txt:			E('Txt', 			Text),
	textGridding:	E('textGridding',	textGridding),
	Ornt:			E('Ornt',			Ornt),
	AntA:			E('AntA',			AntA),
	TextIndex:		E('TextIndex',		Long),
	EngineData:		E('EngineData',		Engine),
};
const textSpec = Descriptor('TxLr', textFields);

// the warp: the style it is of ('warpNone' for none, and any other the file has), and how much (percentages: the bend, and the distortions along each axis), across or down the text
const warpFields = {
	style:			E('warpStyle',				Default(Enum('warpStyle'), 'warpNone')),
	bend:			E('warpValue',				Default(Double, 0)),
	horizontal:		E('warpPerspective',		Default(Double, 0)),
	vertical:		E('warpPerspectiveOther',	Default(Double, 0)),
	down:			E('warpRotate',				Default(Ornt, false)),
};
const warpSpec = Descriptor('warp', warpFields);
export type TextWarp = SpecOf<typeof warpFields>;

const noWarp: TextWarp = {style: 'warpNone', bend: 0, horizontal: 0, vertical: 0, down: false};

//-----------------------------------------------------------------------------
//	a run's style: where each field is kept in the engine data, and how
//-----------------------------------------------------------------------------

const black: RGB = {r: 0, g: 0, b: 0};
const channel = (v: number) => Math.round(clamp01(v) * 255);

// A colour is alpha, red, green and blue; of the other kinds, grey is the one that could be told: the rest are black.
const FillColour: EngineAccess<RGB> = {
	from:	v => {
		const {type, values} = Dict({type: E('Type', Int), values: E('Values', Default(Reals, []))}).from(v);
		return type === 1 && values.length >= 4			? {r: channel(values[1]), g: channel(values[2]), b: channel(values[3])}
			: values.length === 2						? {r: channel(values[1]), g: channel(values[1]), b: channel(values[1])}
			: black;
	},
	to:		c => ({Type: 1, Values: Reals.to([1, c.r / 255, c.g / 255, c.b / 255])}),
};

// (sizes are in the text's own units: the transform scales them to the canvas's pixels)
const styleFields = {
	fontIndex:	E('Font',				Default(Int, 0)),				// the number of the font in the document's fonts
	size:		E('FontSize',			Default(Real, 12)),
	colour:		E('FillColor',			Default(FillColour, black)),
	bold:		E('FauxBold',			Default(Flag, false)),			// faux bold, which the font's own bold is not
	italic:		E('FauxItalic',			Default(Flag, false)),			// likewise
	tracking:	E('Tracking',			Default(Int, 0)),				// in thousandths of an em
	autoLeading: E('AutoLeading',		Default(Flag, true)),
	leading:	E('Leading',			Default(Real, 0)),
	hscale:		E('HorizontalScale',	Default(Real, 1)),
	vscale:		E('VerticalScale',		Default(Real, 1)),
	underline:	E('Underline',			Default(Flag, false)),
	strike:		E('Strikethrough',		Default(Flag, false)),
};

// the rest of what a style has, which a new one is given
const styleExtras = {
	autoKerning:		E('AutoKerning',		Flag),
	kerning:			E('Kerning',			Int),
	baselineShift:		E('BaselineShift',		Real),
	fontCaps:			E('FontCaps',			Int),
	fontBaseline:		E('FontBaseline',		Int),
	ligatures:			E('Ligatures',			Flag),
	dLigatures:			E('DLigatures',			Flag),
	baselineDirection:	E('BaselineDirection',	Int),
	tsume:				E('Tsume',				Real),
	styleRunAlignment:	E('StyleRunAlignment',	Int),
	language:			E('Language',			Int),
	noBreak:			E('NoBreak',			Flag),
	strokeColour:		E('StrokeColor',		FillColour),
	fillFlag:			E('FillFlag',			Flag),
	strokeFlag:			E('StrokeFlag',			Flag),
	fillFirst:			E('FillFirst',			Flag),
	yUnderline:			E('YUnderline',			Int),
	outlineWidth:		E('OutlineWidth',		Real),
	characterDirection:	E('CharacterDirection',	Int),
	hindiNumbers:		E('HindiNumbers',		Flag),
	kashida:			E('Kashida',			Int),
	diacriticPos:		E('DiacriticPos',		Int),
};

/** How a run of text is set. */
type TextStyle = Omit<SpecOf<typeof styleFields>, 'fontIndex' | 'autoLeading' | 'leading'> & {
	font:			string;		// the PostScript name
	leading?:		number;		// undefined for the font's own (automatic)
	extra:			EngineDict;	// all of the style the file has, which is written back with these changed
};

interface TextRun { length: number, style: TextStyle }

/** How a paragraph is set: 0 left, 1 right, 2 centred, then the justified (3 left, 4 right, 5 centre, 6 all). */
interface TextPara { length: number, justification: number, source?: EngineDict }

/** Photoshop's text warp: the style it is of, and how much (percentages: the bend, and the distortions along each axis), across or down the text. */
const WARP_STYLES = ['warpArc', 'warpArcLower', 'warpArcUpper', 'warpArch', 'warpBulge', 'warpShellLower', 'warpShellUpper', 'warpFlag', 'warpWave', 'warpFish', 'warpRise', 'warpFisheye', 'warpInflate', 'warpSqueeze', 'warpTwist'] as const;

interface TextSpec {
	text:			string;			// paragraphs end in '\r', and the text does too
	runs:			TextRun[];
	paras:			TextPara[];
	transform:		number[];		// xx, xy, yx, yy, tx, ty: text space to the canvas
	box?:			{width: number, height: number};		// text in a box is wrapped to it (in the text's units), else it is a line from its origin
	autoLeading:	number;		// the ratio of the size that automatic leading is
	warp?:			TextWarp;		// how the text is bent, if it is
}

const DEFAULT_STYLE: EngineDict = writeDict({...styleFields, ...styleExtras}, {
	fontIndex: 0, size: 12, colour: black, bold: false, italic: false, tracking: 0, autoLeading: true, leading: 0, hscale: 1, vscale: 1, underline: false, strike: false,
	autoKerning: true, kerning: 0, baselineShift: 0, fontCaps: 0, fontBaseline: 0, ligatures: true, dLigatures: false, baselineDirection: 2, tsume: 0,
	styleRunAlignment: 2, language: 0, noBreak: false, strokeColour: black, fillFlag: true, strokeFlag: false, fillFirst: true, yUnderline: 1, outlineWidth: 1,
	characterDirection: 0, hindiNumbers: false, kashida: 1, diacriticPos: 2,
});

const clone		= <T extends EngineValue>(v: T): T => Array.isArray(v) ? v.map(clone) as T : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T : v;

//-----------------------------------------------------------------------------
//	the engine data's structure: where the parts are that this reads and writes
//-----------------------------------------------------------------------------

// a run of styled text has a style sheet, and a run of paragraph has a paragraph sheet (kept whole, to be written back as it was)
const styleSheetSpec = {sheet: E('StyleSheet', Dict({data: E('StyleSheetData', Raw)}))};
const adjustmentsSpec = {
	axis:	E('Axis',	Reals),
	xy:		E('XY',		Reals),
};
const paraSheetSpec	= {
	sheet:			E('ParagraphSheet', Dict({defaultStyleSheet: E('DefaultStyleSheet', Int), props: E('Properties', Raw)})),
	adjustments:	E('Adjustments', Dict(adjustmentsSpec)),
};
const paraSheet		= Dict(paraSheetSpec);

// a paragraph run is kept whole as well, to be written back as it was
const ParaRun: EngineAccess<{source: EngineDict, props: EngineDict}> = {
	from:	v => ({source: Raw.from(v), props: paraSheet.from(v).sheet.props}),
	to:		run => run.source,
};

// the shapes the text is laid out in; text in a box has the box's bounds in the first shape's cookie
const transformSpec	= {
	shapeType:	E('ShapeType',		Int),
	point0:		E('TransformPoint0', Reals),
	point1:		E('TransformPoint1', Reals),
	point2:		E('TransformPoint2', Reals),
};
const shapeSpec		= {
	type:		E('ShapeType',		Default(Int, 0)),
	pointBase:	E('PointBase',		Reals),
	base:		E('Base',			Dict(transformSpec)),
	bounds:		E('BoxBounds',		Default(Reals, [])),
};
const renderedSpec	= {
	version:	E('Version',		Int),
	shapes:		E('Shapes',			Dict({
		writingDirection:	E('WritingDirection',	Int),
		children:	E('Children',	Elems(Dict({
			shapeType:	E('ShapeType',	Int),
			procession:	E('Procession',	Int),
			lines:		E('Lines',		Dict({writingDirection: E('WritingDirection', Int), children: E('Children', Elems(Raw))})),
			cookie:		E('Cookie',		Dict({photoshop: E('Photoshop', Dict(shapeSpec))})),
		}))),
	})),
};

const gridSpec		= {
	on:			E('GridIsOn',		Flag),
	show:		E('ShowGrid',		Flag),
	size:		E('GridSize',		Real),
	leading:	E('GridLeading',	Real),
	colour:		E('GridColor',		FillColour),
	fill:		E('GridLeadingFillColor', FillColour),
	alignLines:	E('AlignLineHeightToGridFlags', Flag),
};

const engineSpec	= {
	editor:		E('Editor',			Optional(Dict({text: E('Text', Default(Str, ''))}))),
	styleRun:	E('StyleRun',		Dict({
		defaults:	E('DefaultRunData',	Dict(styleSheetSpec)),
		runs:		E('RunArray',		Elems(Dict(styleSheetSpec))),
		lengths:	E('RunLengthArray',	Elems(Default(Int, 0))),
		joinable:	E('IsJoinable',		Int),
	})),
	paraRun:	E('ParagraphRun',	Dict({
		defaults:	E('DefaultRunData',	paraSheet),
		runs:		E('RunArray',		Elems(ParaRun)),
		lengths:	E('RunLengthArray',	Elems(Default(Int, 0))),
		joinable:	E('IsJoinable',		Int),
	})),
	grid:		E('GridInfo',		Dict(gridSpec)),
	antiAlias:	E('AntiAlias',		Int),
	fractionalWidths: E('UseFractionalGlyphWidths', Flag),
	rendered:	E('Rendered',		Dict(renderedSpec)),
};
const resourcesSpec	= {
	kinsoku:	E('KinsokuSet',		Elems(Raw)),
	mojiKumi:	E('MojiKumiSet',	Elems(Raw)),
	normal:		E('TheNormalStyleSheet', Default(Int, 0)),
	normalPara:	E('TheNormalParagraphSheet', Int),
	paraSheets:	E('ParagraphSheetSet', Elems(Dict({name: E('Name', Str), defaultStyleSheet: E('DefaultStyleSheet', Int), props: E('Properties', Raw)}))),
	styleSheets: E('StyleSheetSet',	Elems(Dict({name: E('Name', Str), data: E('StyleSheetData', Raw)}))),
	fonts:		E('FontSet',		Elems(Dict({name: E('Name', Default(Str, '')), script: E('Script', Int), fontType: E('FontType', Int), synthetic: E('Synthetic', Int)}))),
	superscriptSize:	E('SuperscriptSize',	Real),
	superscriptPosition: E('SuperscriptPosition', Real),
	subscriptSize:		E('SubscriptSize',		Real),
	subscriptPosition:	E('SubscriptPosition',	Real),
	smallCapSize:		E('SmallCapSize',		Real),
};
const rootSpec		= {
	engine:		E('EngineDict',			Dict(engineSpec)),
	resources:	E('ResourceDict',		Dict(resourcesSpec)),
	documents:	E('DocumentResources',	Dict(resourcesSpec)),
};

function engineOf(blocks: psd.LayerBlocks | undefined): EngineDict | undefined {
	const items = blocks?.TySh?.text.items;
	if (items) {
		const x = withSpec(textFields, items);
//		const x = readSpec(textFields, items);
		return x.EngineData;
	//return getEngine(blocks?.TySh?.text.items.EngineData);
	}
}

/** Whether the blocks are of a text layer. */
export const isText = (blocks: psd.LayerBlocks | undefined) => !!blocks?.TySh;

// the fonts the document has: where a style's number is looked up
const fontNames = (root: EngineDict) => readDict(rootSpec, root).resources.fonts.map(f => f.name);

function styleOf(root: EngineDict, data: EngineDict, base: EngineDict): TextStyle {
	const merged = {...base, ...data}, {fontIndex, autoLeading, leading, ...style} = readDict(styleFields, merged);
	return {...style, font: fontNames(root)[fontIndex] ?? 'ArialMT', leading: autoLeading ? undefined : leading, extra: merged};
}

/** The text layer a TySh block has, or undefined if it is not of text this can read. */
function readText(blocks: psd.LayerBlocks | undefined): TextSpec | undefined {
	const tysh = blocks?.TySh;
	let root: EngineDict | undefined;
	try {
		root = engineOf(blocks);
	} catch {
		return;
	}
	if (!tysh || !root)
		return;
	const {engine, resources} = readDict(rootSpec, root);
	if (!engine.editor)
		return;

	const text		= engine.editor.text;
	const normal	= resources.styleSheets[resources.normal]?.data ?? {};
	const styleBase	= {...DEFAULT_STYLE, ...normal, ...engine.styleRun.defaults.sheet.data};
	const styles	= engine.styleRun.runs.map(r => styleOf(root, r.sheet.data, styleBase));
	const lengths	= engine.styleRun.lengths.length ? engine.styleRun.lengths : [text.length];
	const runs: TextRun[] = lengths.map((length, i) => ({length, style: styles[Math.min(i, styles.length - 1)] ?? styleOf(root, {}, styleBase)}));

	const paraBase	= engine.paraRun.defaults.sheet.props;
	const sources	= engine.paraRun.runs;
	const plens		= engine.paraRun.lengths.length ? engine.paraRun.lengths : [text.length];
	const paras: TextPara[] = plens.map((length, i) => {
		const run = sources[Math.min(i, sources.length - 1)];
		return {length, justification: readDict(paraFields, {...paraBase, ...run?.props}).justification, source: run?.source};
	});

	const shape		= engine.rendered.shapes.children[0]?.cookie.photoshop, bounds = shape?.bounds ?? [];
	const box		= shape?.type === 1 && bounds.length === 4 ? {width: bounds[2] - bounds[0], height: bounds[3] - bounds[1]} : undefined;
	const leadingOf	= (props: EngineDict) => readDict({autoLeading: paraExtras.autoLeading}, props).autoLeading;
	const autoLeading = (leadingOf(paraBase) ?? 0) || (leadingOf(sources[0]?.props ?? {}) ?? 1.2);

	const warp		= warpSpec.from(tysh.warp);

	return {text, runs, paras, transform: Array.from(tysh.transform), box, autoLeading, warp: warp?.style === 'warpNone' ? undefined : warp};
}

//-----------------------------------------------------------------------------
//	writing it
//-----------------------------------------------------------------------------

// the number of a font in the document's fonts (put there if it is not), in each list of them
function fontIndex(root: EngineDict, name: string): number {
	const names = fontNames(root);
	let index = names.indexOf(name);
	if (index < 0) {
		index = names.length;
		const {resources, documents} = readDict(rootSpec, root);
		for (const [key, holder] of [['resources', resources], ['documents', documents]] as const) {
			if (holder.fonts.length === index)
				putDict(root, rootSpec, {[key]: {fonts: [...holder.fonts, {name, script: 0, fontType: 0, synthetic: 0}]}});
		}
	}
	return index;
}

function styleData(root: EngineDict, {font, leading, extra, ...style}: TextStyle): EngineDict {
	return putDict(clone(extra), styleFields, {...style, fontIndex: fontIndex(root, font), autoLeading: leading === undefined, leading: leading ?? Real.from(extra.Leading) ?? 0});
}

const paraFields = {
	justification:	E('Justification',	Default(Int, 0)),
};
// (a paragraph's justification, written into its sheet)
const justifySpec	= {sheet: E('ParagraphSheet', Dict({props: E('Properties', Dict(paraFields))}))};
const paraExtras = {
	firstLineIndent:		E('FirstLineIndent',		Real),
	startIndent:			E('StartIndent',			Real),
	endIndent:				E('EndIndent',				Real),
	spaceBefore:			E('SpaceBefore',			Real),
	spaceAfter:				E('SpaceAfter',				Real),
	autoHyphenate:			E('AutoHyphenate',			Flag),
	hyphenatedWordSize:		E('HyphenatedWordSize',		Int),
	preHyphen:				E('PreHyphen',				Int),
	postHyphen:				E('PostHyphen',				Int),
	consecutiveHyphens:		E('ConsecutiveHyphens',		Int),
	zone:					E('Zone',					Real),
	wordSpacing:			E('WordSpacing',			Reals),
	letterSpacing:			E('LetterSpacing',			Reals),
	glyphSpacing:			E('GlyphSpacing',			Reals),
	autoLeading:			E('AutoLeading',			Real),
	leadingType:			E('LeadingType',			Int),
	hanging:				E('Hanging',				Flag),
	burasagari:				E('Burasagari',				Flag),
	kinsokuOrder:			E('KinsokuOrder',			Int),
	everyLineComposer:		E('EveryLineComposer',		Flag),
};

const DEFAULT_PARA_PROPERTIES = writeDict({...paraFields, ...paraExtras}, {
		justification: 0, firstLineIndent: 0, startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0,
		autoHyphenate: true, hyphenatedWordSize: 6, preHyphen: 2, postHyphen: 2, consecutiveHyphens: 8, zone: 36,
		wordSpacing: [.8, 1, 1.33], letterSpacing: [0, 0, 0], glyphSpacing: [1, 1, 1],
		autoLeading: 1.2, leadingType: 0, hanging: false, burasagari: false, kinsokuOrder: 0, everyLineComposer: false,
});
const DEFAULT_PARA: EngineDict = writeDict(paraSheetSpec, {
	sheet:			{defaultStyleSheet: 0, props: clone(DEFAULT_PARA_PROPERTIES)},
	adjustments:	{axis: [1, 0, 1], xy: [0, 0]},
});

function paraData(p: TextPara): EngineDict {
	const data = clone(p.source && isDict(p.source.ParagraphSheet) ? p.source : DEFAULT_PARA);
	return putDict(data, justifySpec, {sheet: {props: {justification: p.justification}}});
}

/** The blocks with the text layer's text, its runs and its transform as the description has them: the rest of what the file keeps is as it was. */
function withText(blocks: psd.LayerBlocks, spec: TextSpec): psd.LayerBlocks {
	const tysh = blocks.TySh;
	if (!tysh)
		return blocks;
	const root = clone(engineOf(blocks) ?? {});		// (the blocks' own is shared with the blocks the layer had, which an undo puts back)
	putDict(root, rootSpec, {engine: {
		editor:		{text: spec.text},
		styleRun:	{runs: spec.runs.map(r => ({sheet: {data: styleData(root, r.style)}})), lengths: spec.runs.map(r => r.length)},
		paraRun:	{runs: spec.paras.map(p => ({source: paraData(p), props: {}})), lengths: spec.paras.map(p => p.length)},
	}});

	const written = writeField(blocks, tysh, 'text', i => {
		put(i, textFields, {EngineData: root, Txt: spec.text.endsWith('\r') ? spec.text.slice(0, -1) : spec.text});
	});
	const warped = writeField(written, written.TySh, 'warp', i => { put(i, warpFields, spec.warp ?? noWarp); });
	return {...warped, TySh: {...warped.TySh!, transform: spec.transform.slice()}};
}

//-----------------------------------------------------------------------------
//	a new text layer
//-----------------------------------------------------------------------------

/** The style a new run of text has. */
function defaultStyle(font: string, size: number, colour: RGB): TextStyle {
	return {font, size, colour, bold: false, italic: false, tracking: 0, hscale: 1, vscale: 1, underline: false, strike: false, extra: clone(DEFAULT_STYLE)};
}

/** The blocks of a new text layer with the text at a place (its baseline's start). Another text layer's blocks, if there is one, are what it is made from, so
 * that it has the document's own settings for the parts of the engine data that the description has nothing of. */
function newTextBlocks(txt: string, at: float2, style: TextStyle, justification = 0, like?: psd.LayerBlocks): psd.LayerBlocks {
	const spec: TextSpec = {
		text:		txt.endsWith('\r') ? txt : txt + '\r',
		runs:		[{length: 0, style}],
		paras:		[{length: 0, justification}],
		transform:	[1, 0, 0, 1, at.x, at.y],
		autoLeading: 1.2,
	};
	spec.runs[0].length = spec.paras[0].length = spec.text.length;

	let base: psd.LayerBlocks['TySh'] = like?.TySh;
	if (!base || !engineOf(like)) {
		// what Photoshop gives a new document's text: the document's own resources, and an engine with no text in it yet
		const resources = () => ({
			kinsoku: [], mojiKumi: [], normal: 0, normalPara: 0,
			paraSheets:	[{name: 'Normal RGB', defaultStyleSheet: 0, props: clone(DEFAULT_PARA_PROPERTIES)}],
			styleSheets: [{name: 'Normal RGB', data: clone(DEFAULT_STYLE)}],
			fonts: [],
			superscriptSize: .583, superscriptPosition: .333, subscriptSize: .583, subscriptPosition: .333, smallCapSize: .7,
		});
		const engine = writeDict(rootSpec, {
			engine: {
				editor:		{text: ''},
				paraRun:	{defaults: {sheet: {defaultStyleSheet: 0, props: {}}, adjustments: {axis: [1, 0, 1], xy: [0, 0]}}, runs: [], lengths: [], joinable: 1},
				styleRun:	{defaults: {sheet: {data: {}}}, runs: [], lengths: [], joinable: 2},
				grid:		{on: false, show: false, size: 18, leading: 22, colour: black, fill: black, alignLines: false},
				antiAlias:	4,
				fractionalWidths: true,
				rendered:	{version: 1, shapes: {writingDirection: 0, children: [{
					shapeType: 0, procession: 0, lines: {writingDirection: 0, children: []},
					cookie: {photoshop: {type: 0, pointBase: [0, 0], base: {shapeType: 0, point0: [1, 0], point1: [0, 1], point2: [0, 0]}}},
				}]}},
			},
			resources:	resources(),
			documents:	resources(),
		});
		base = {
			key:			'TySh',
			version:		1,
			transform:		[1, 0, 0, 1, 0, 0],
			textVersion: 	50,
			textDescriptorVersion: 16,
			text: textSpec.to({
				Txt:			'',
				textGridding:	0,
				Ornt:			false,
				AntA:			0,
				TextIndex:		0,
				EngineData:		engine
			}),
			warpVersion:	1,
			warpDescriptorVersion: 16,
			warp:			warpSpec.to(noWarp),
			bounds:			[0, 0, 0, 0],
		};
	}
	return withText({TySh: base}, spec);
}

const icons = {
	text:	'<path d="M3 4V3H13V4M8 3V13M6 13H10"/>',
	left:	'<path d="M2 3H14M2 6H10M2 9H14M2 12H10"/>',
	centre:	'<path d="M2 3H14M4 6H12M2 9H14M4 12H12"/>',
	right:	'<path d="M2 3H14M6 6H14M2 9H14M6 12H14"/>',
	bold:	'<path d="M5 3H9A2.5 2.5 0 0 1 9 8H5ZM5 8H10A2.5 2.5 0 0 1 10 13H5Z"/>',
	italic:	'<path d="M7 3H12M4 13H9M10 3L6 13"/>',
};
export const textIcon = icons.text;

const warpIcons: Record<string, [string, string]> = {
	warpNone:		['None', '<path d="M2 5H14M2 11H14"/>'],
	warpArc:		['Arc', '<path d="M2 7Q8 1 14 7M2 13Q8 9 14 13"/>'],
	warpArcLower:	['Arc Lower', '<path d="M2 3H14M2 8Q8 15 14 8"/>'],
	warpArcUpper:	['Arc Upper', '<path d="M2 8Q8 1 14 8M2 13H14"/>'],
	warpArch:		['Arch', '<path d="M2 6Q8 0 14 6M2 13Q8 7 14 13"/>'],
	warpBulge:		['Bulge', '<path d="M2 5Q8 1 14 5M2 11Q8 15 14 11"/>'],
	warpShellLower:	['Shell Lower', '<path d="M5 3H11M5 3L2 9M11 3L14 9M2 9Q8 15 14 9"/>'],
	warpShellUpper:	['Shell Upper', '<path d="M2 7Q8 1 14 7M2 7L5 13M14 7L11 13M5 13H11"/>'],
	warpFlag:		['Flag', '<path d="M2 4C5 1 6 7 8 4S11 7 14 4M2 11C5 8 6 14 8 11S11 14 14 11"/>'],
	warpWave:		['Wave', '<path d="M2 5Q5 1 8 5T14 5M2 11Q5 15 8 11T14 11"/>'],
	warpFish:		['Fish', '<path d="M2 7Q8 0 14 7M2 9Q8 16 14 9"/>'],
	warpRise:		['Rise', '<path d="M2 7C7 7 9 2 14 2M2 14C7 14 9 9 14 9"/>'],
	warpFisheye:	['Fisheye', '<circle cx="8" cy="8" r="5.5"/><path d="M3 8Q8 4 13 8Q8 12 3 8"/>'],
	warpInflate:	['Inflate', '<path d="M3 4Q8 1 13 4Q15 8 13 12Q8 15 3 12Q1 8 3 4Z"/>'],
	warpSqueeze:	['Squeeze', '<path d="M3 2Q8 5 13 2Q10 8 13 14Q8 11 3 14Q6 8 3 2Z"/>'],
	warpTwist:		['Twist', '<path d="M8 8a1.5 1.5 0 1 1 1.5 1.5a3 3 0 1 1 3-3a4.5 4.5 0 1 1-4.5-4.5"/>'],
};

// The text's warp, in the transform menu: the style, how much it bends, the distortions along each way, and whether it is across or down.
function warpItems(spec: TextSpec, edited: (label: string, key: string) => void): CascadeItem[] {
	const warp = (): TextWarp => spec.warp ??= {style: 'warpArc', bend: 50, horizontal: 0, vertical: 0, down: false};
	const style = () => spec.warp?.style ?? 'warpNone';
	const amount = (label: string, caption: string, key: 'bend' | 'horizontal' | 'vertical', presets: number[]) => valueItem({
		label, caption, min: -100, max: 100, presets,
		get: () => spec.warp?.[key] ?? 0, set: v => { warp()[key] = v; edited('Text Warp', `text-warp-${key}`); },
		step: (v, steps) => v + 5 * steps,
	});
	return [{
		id:			'text-warp',
		face:		() => svgFace(warpIcons[style()]?.[1] ?? warpIcons.warpArc[1]),
		caption:	() => `Warp Text: ${warpIcons[style()]?.[0] ?? style()}`,
		children:	() => [
			choiceItem({caption: 'Style', get: style, set: v => {
					if (v === 'warpNone') {
						spec.warp = undefined;
					} else {
						warp().style = v;
						if (!spec.warp!.bend && !spec.warp!.horizontal && !spec.warp!.vertical)
							spec.warp!.bend = 50;
					}
					edited('Text Warp', 'text-warp-style');
				}}, ['warpNone', ...WARP_STYLES].map(value => ({value: value as string, face: svgFace(warpIcons[value][1]), caption: warpIcons[value][0]}))),
			amount('bend', 'Bend (%)', 'bend', [-100, -50, 0, 50, 100]),
			amount('horiz', 'Horizontal distortion (%)', 'horizontal', [-50, 0, 50]),
			amount('vert', 'Vertical distortion (%)', 'vertical', [-50, 0, 50]),
			toggleItem('Down', svgFace('<path d="M8 2V14M5 11L8 14L11 11"/>'), () => !!spec.warp?.down, v => { warp().down = v; edited('Text Warp', 'text-warp-down'); }),
		],
	}];
}

// the fonts the machine has, asked of the extension (which scans them) the first time they are wanted
let fontsAsked = false;
function askFonts(then: () => void) {
	if (fontsAsked)
		return;
	fontsAsked = true;
	RPC<InstalledFont[]>({command: 'installedFonts'}).then(fonts => { setInstalledFonts(fonts); then(); }, () => {});
}

// the scale of the text's units to the canvas's pixels
const scaleOf = (spec: TextSpec) => Math.hypot(spec.transform[2], spec.transform[3]) || 1;

/** Asks for a font to be chosen from a list of families, and tells `choose` which. */
export type FontPicker = (families: string[], current: string, choose: (family: string) => void) => void;

// The menu of how the text is set. A change is to all of it (the first of its runs says what the menu shows); `edited` is told of one.
export function textItems(spec: TextSpec, edited: (label: string, key: string) => void, pick: FontPicker): CascadeItem[] {
	const first = (): TextStyle => spec.runs[0].style;
	const all = (change: (s: TextStyle) => void) => { for (const run of spec.runs) change(run.style); };

	const families = () => {
		const family = faceOf(first().font).family;
		const names = familyNames();
		return names.includes(family) ? names : [family, ...names];
	};
	const face = (family: string) => `<span class="cascade-value" style="font-family:'${family}',sans-serif;font-size:15px">Aa</span>`;
	const set = (face2: Partial<ReturnType<typeof faceOf>>) => all(s => { s.font = postscriptOf({...faceOf(s.font), ...face2}); });

	const font: CascadeItem = {
		face:		() => face(faceOf(first().font).family),
		caption:	() => `Font: ${faceOf(first().font).family} (click to choose)`,
		click:		() => {
			const family = faceOf(first().font).family, names = familyNames();
			pick(names.includes(family) ? names : [family, ...names], family, chosen => { set({family: chosen}); edited('Text Font', 'text-font'); });
			return true;
		},
	};

	const align = choiceItem({
		caption:	'Alignment',
		get:		() => spec.paras[0]?.justification % 3,
		set:		v => { for (const p of spec.paras) p.justification = v; edited('Text Alignment', 'text-align'); },
	}, [
		{value: 0, face: svgFace(icons.left), caption: 'Left'},
		{value: 2, face: svgFace(icons.centre), caption: 'Centre'},
		{value: 1, face: svgFace(icons.right), caption: 'Right'},
	]);

	return [
		font,
		valueItem({
			label: 'size', caption: 'Size (pixels)', min: 1, max: 2000, presets: [8, 12, 16, 24, 36, 48, 72, 96, 144, 200],
			get: () => first().size * scaleOf(spec), set: v => { all(s => { s.size = v / scaleOf(spec); }); edited('Text Size', 'text-size'); },
			step: multiplicativeStep(), resolution: 0.1, format: v => String(+v.toFixed(1)),
		}),
		toggleItem('Bold', svgFace(icons.bold), () => faceOf(first().font).bold, v => { set({bold: v}); edited('Text Bold', 'text-bold'); }),
		toggleItem('Italic', svgFace(icons.italic), () => faceOf(first().font).italic, v => { set({italic: v}); edited('Text Italic', 'text-italic'); }),
		{
			id:			'text-colour',
			face:		() => swatchFace(toHex(first().colour)),
			caption:	() => `Colour ${toHex(first().colour)}`,
			children:	() => colourItems('text-colour', () => first().colour, (colour, final) => { all(s => { s.colour = colour; }); edited('Text Colour', final ? 'text-colour-set' : 'text-colour'); }),
		},
		align,
		valueItem({
			label: 'track', caption: 'Tracking (thousandths of an em)', min: -200, max: 1000, presets: [-100, 0, 50, 100, 200, 500],
			get: () => first().tracking, set: v => { all(s => { s.tracking = v; }); edited('Text Tracking', 'text-tracking'); },
			step: (v, steps) => v + 10 * steps,
		}),
		valueItem({
			label: 'lead', caption: 'Line spacing (pixels)', min: 1, max: 4000, presets: [12, 24, 48, 96, 200],
			get: () => (first().leading ?? first().size * spec.autoLeading) * scaleOf(spec),
			set: v => { all(s => { s.leading = v / scaleOf(spec); }); edited('Text Leading', 'text-leading'); },
			step: multiplicativeStep(), resolution: 0.1, format: v => String(+v.toFixed(1)),
		}),
	];
}

//-----------------------------------------------------------------------------
//	changing the runs with the text
//-----------------------------------------------------------------------------

/** The runs of a text, made the runs of the text it has become: an insertion goes into the run before it, and a deletion shortens them. */
function reflowRuns<T extends {length: number}>(runs: T[], before: string, after: string): T[] {
	let p = 0;
	while (p < before.length && p < after.length && before[p] === after[p])
		p++;
	let s = 0;
	while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s])
		s++;
	const delta = after.length - before.length, tail = before.length - s;
	const move = (b: number) => b >= tail ? b + delta : b <= p ? b : p;

	const out: T[] = [];
	let at = 0, end = 0;
	for (const run of runs) {
		end += run.length;
		const to = Math.min(after.length, Math.max(at, move(end)));
		if (to > at)
			out.push({...run, length: to - at});
		at = to;
	}
	if (!out.length)
		out.push({...runs[Math.max(0, runs.length - 1)], length: after.length});
	else if (at < after.length)
		out[out.length - 1] = {...out[out.length - 1], length: out[out.length - 1].length + after.length - at};
	return out;
}

/** The paragraphs of a text: one for each that ends with a '\r', with the settings of the one the file had in that place. */
function reflowParas(paras: TextPara[], before: string, after: string): TextPara[] {
	const ends = (t: string) => { const e: number[] = []; for (let i = 0; i < t.length; i++) if (t[i] === '\r') e.push(i + 1); if (!e.length || e[e.length - 1] < t.length) e.push(t.length); return e; };
	const old = paras.length ? paras : [{length: before.length, justification: 0}];
	return ends(after).map((end, i, all) => ({...old[Math.min(i, old.length - 1)], length: end - (all[i - 1] ?? 0)}));
}

export function newTextLayer(name: string, text: string, at: float2, size: number, like?: psd.LayerBlocks): PixelLayer {
	const blocks	= newTextBlocks(text, at, defaultStyle('ArialMT', size, {r: 0, g: 0, b: 0}), 0, like);
	const spec		= readText(blocks)!;

	return {kind: 'text',
		name,
		opacity:	1,
		visible:	true,
		blend:		'norm',
		blocks,
		...renderText(spec, layoutText(spec)),
	}
}

/** A text layer's blocks with no text in them (it is the pixels it has). */
export function withoutText(blocks: psd.LayerBlocks): psd.LayerBlocks {
	const {TySh, ...rest} = blocks;
	return rest;
}

/** A text layer made into a shape: its letters' outlines (which the extension draws, as it has the fonts) are the vector mask, and the text's
 *  colour the fill; the text itself is gone. Undefined if it is not text, or its outlines could not be read. */
export async function textAsShape(layer: PixelLayer, stack: {width: number, height: number}) {
	const blocks = layer.blocks, spec = readText(blocks);
	if (!blocks || !spec)
		return;
	const layout = layoutText(spec);
	const {runs, colour} = glyphRuns(spec, layout.lines);
	const {curve} = await RPC<{curve: curveVertex[], missing: number}>({command: 'glyphOutlines', runs});
	if (!curve.length) {
		postMessage({command: 'error', message: 'The outlines of this text could not be read from its fonts.'});
		return;
	}
	const made = {...layer, kind: 'shape' as const, blocks: shapeBlocks(blocks, textCurve(spec, layout.area, curve), colour ?? {r: 0, g: 0, b: 0}, stack.width, stack.height)};
	const shape = openShape(made, stack);
	return shape && {kind: 'shape' as const, ...shape.state() as Required<ShapeState>};	// (a shape's session makes its pixels)
}

/** A text layer carried as the picture is (by the transform tool): its text is carried, and set again, so it is crisp, not warped pixels. A transform
 *  with perspective is more than the text's own is, but its warp's two distortions go as far as a free distort does: for what they do not, and for a
 *  warp, as in Photoshop the text is made into pixels, the warped ones (which the layer has been given). The layer as it is if it is not text. */
export function carryText(layer: PixelLayer, carry: Carry, width: number, height: number): PixelLayer {
	const spec = layer.kind === 'text' ? readText(layer.blocks) : undefined;
	if (!spec || !layer.blocks)
		return layer;

	const layout	= layoutText(spec);

	const m = carry instanceof Warp ? undefined : carry.scale(1 / carry.z.z);
	const affine = !!m && !(Math.abs(m.x.z) > 1e-9 || Math.abs(m.y.z) > 1e-9);
	if (affine) {
		const [a, b, c, d, e, f] = spec.transform;
		spec.transform = [a * m.x.x + b * m.y.x, a * m.x.y + b * m.y.y, c * m.x.x + d * m.y.x, c * m.x.y + d * m.y.y, e * m.x.x + f * m.y.x + m.z.x, e * m.x.y + f * m.y.y + m.z.y];
	} else if (!(m && distortText(spec, layout.area, p => carryPoint(carry, p)))) {
		return {...layer, kind: 'image', blocks: withoutText(layer.blocks)};
	}
	return {...layer, ...renderText(spec, layout), blocks: withText(layer.blocks, spec)};
}

// The editor of the current layer's text, over the picture in place of the tools while it has some (`open`).
export class TextEditor {
	private picture?:	LayeredMode;
	// while it has text to edit: the text's layer, the blocks it was read from (or that an edit last made), and the text as it is being changed,
	// which is ahead of the layer's until an edit makes it the layer's
	layer!:				PixelLayer;
	blocks!:			psd.LayerBlocks;
	private spec?:		TextSpec;
	private readonly host:	HTMLElement;
	private readonly frame:	HTMLElement;
	private readonly input:	HTMLTextAreaElement;
	private readonly handle: HTMLElement;
	private hidden		= false;		// something over it has the picture (a transform): it is out of the way
	private off?:		() => void;		// it has the picture while it has text: how it gives it back

	constructor(private canvas: HTMLCanvasElement) {
		const parent = canvas.parentElement!;
		this.host	= createElement('div', {className: 'textedit-host', style: {position: 'absolute', inset: '0', display: 'none', pointerEvents: 'none', overflow: 'hidden'}});
		this.frame	= createElement('div', {className: 'textedit-frame', style: {position: 'absolute', outline: '1px dashed rgba(128,128,128,0.9)', pointerEvents: 'none'}});
		this.input	= createElement('textarea', {
			className:	'textedit-input',
			spellcheck:	false,
			style: {
				position: 'absolute', inset: '0', margin: '0', padding: '0', border: '0', background: 'transparent', color: 'transparent', caretColor: '#888',
				resize: 'none', overflow: 'hidden', whiteSpace: 'pre', outline: 'none', pointerEvents: 'auto', boxSizing: 'border-box',
			},
		}) as HTMLTextAreaElement;
		this.handle	= createElement('div', {className: 'textedit-handle', title: 'Move the text', style: {
			position: 'absolute', width: '10px', height: '10px', left: '-12px', top: '-12px', background: 'rgba(128,128,128,0.9)', cursor: 'move', pointerEvents: 'auto',
		}});
		this.frame.append(this.input, this.handle);
		this.host.append(this.frame);
		parent.append(this.host);

		this.input.addEventListener('input', () => this.typed());
		this.input.addEventListener('keydown', e => {
			e.stopPropagation();		// (the keys are the text's)
			if (e.key === 'Escape')
				this.input.blur();
		});
		this.handle.addEventListener('pointerdown', e => this.carry(e));
	}

	static layerMenu(picture: LayeredMode, layer: PixelLayer): CascadeItem[] {
		return [
			opItem('<path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"/>', 'Rasterize text: make it pixels, which can no longer be edited as text', () => {
				if (layer.blocks)
					picture.replace(layer, 'Rasterize Text', {kind: 'image', blocks: withoutText(layer.blocks)});
			}),
			opItem('<path d="M2.5 13.5L8 2.5l5.5 11M4.5 9.5h7"/>', 'Convert text to shape: make its letters a vector shape, which can no longer be edited as text', () => {
				const blocks = layer.blocks;
				textAsShape(layer, picture.stack).then(after => {
					if (after && layer.blocks === blocks && picture.stack.layers.includes(layer))		// (not if it was changed while the fonts were being read)
						picture.replace(layer, 'Convert Text to Shape', after);
				});
			})
		];
	}

	/** The families to choose a font from, as a list over the picture with a box to narrow it by name; each is drawn in its own font. */
	pick: FontPicker = (families, current, choose) => {
		this.closePicker?.();
		const panel		= createElement('div', {className: 'textedit-picker', style: {
			position: 'absolute', left: '64px', top: '40px', width: '260px', maxHeight: '60%', display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
			background: 'var(--vscode-editorWidget-background, #252526)', color: 'var(--vscode-editorWidget-foreground, #ccc)',
			border: '1px solid var(--vscode-editorWidget-border, #454545)', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', zIndex: '10',
		}});
		const filter	= createElement('input', {type: 'text', placeholder: 'Find a font', spellcheck: false, style: {margin: '6px', padding: '3px 6px', font: 'inherit'}}) as HTMLInputElement;
		const list		= createElement('div', {style: {overflowY: 'auto', flex: '1'}});
		panel.append(filter, list);
		this.host.append(panel);

		let shown: string[] = [], at = 0;
		const rows: HTMLElement[] = [];
		const mark = () => {
			rows.forEach((r, i) => { r.style.background = i === at ? 'var(--vscode-list-activeSelectionBackground, #094771)' : ''; });
			rows[at]?.scrollIntoView({block: 'nearest'});
		};
		const fill = () => {
			const words = filter.value.toLowerCase().split(/\s+/).filter(w => w);
			shown = families.filter(f => words.every(w => f.toLowerCase().includes(w)));
			at = Math.max(0, shown.indexOf(current));
			list.replaceChildren();
			rows.length = 0;
			for (const family of shown) {
				const row = createElement('div', {textContent: family, title: family, style: {padding: '3px 10px', cursor: 'pointer', fontSize: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: `"${family}", sans-serif`}});
				row.addEventListener('pointerdown', e => { e.preventDefault(); pickFamily(family); });
				rows.push(row);
				list.append(row);
			}
			mark();
		};
		const close = () => {
			document.removeEventListener('pointerdown', outside, true);
			panel.remove();
			this.closePicker = undefined;
		};
		const pickFamily = (family: string) => { close(); choose(family); this.draw(); };
		const outside = (e: PointerEvent) => { if (!panel.contains(e.target as Node)) close(); };
		this.closePicker = close;
		document.addEventListener('pointerdown', outside, true);

		filter.addEventListener('input', fill);
		filter.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Escape')			close();
			else if (e.key === 'Enter')		{ if (shown[at]) pickFamily(shown[at]); }
			else if (e.key === 'ArrowDown')	{ at = Math.min(shown.length - 1, at + 1); mark(); }
			else if (e.key === 'ArrowUp')	{ at = Math.max(0, at - 1); mark(); }
			else return;
			e.preventDefault();
		});
		fill();
		filter.focus();
	};
	private closePicker?: () => void;

	// The editor has the picture while it has text, over the tools (which are put away), and is put out of the way while something over it
	// (a transform) has it. (Its box and handle take their own pointer and keys.)
	private hold(on: boolean) {
		if (on && !this.off) {
			this.off = Input.on(this.canvas).add({holds: true, covered: by => {
				this.hidden = by !== undefined;
				this.host.style.display = this.hidden ? 'none' : '';
				if (this.hidden)
					this.closePicker?.();
			}}, Place.editor);
		} else if (!on && this.off) {
			this.off();
			this.off	= undefined;
			this.hidden	= false;
		}
	}

	/** The text of a layer to edit over the picture: what it says and how it is set, and where it is. Each edit writes the settings in the layer's
	 *  text block and makes the text again as its pixels. With no layer, or one that is not text (or text this cannot read), the editor goes.
	 *  This, if it has text to edit. */
	open(picture?: LayeredMode, layer?: PixelLayer, focus = false) {
		const blocks = picture && layer?.kind === 'text' ? layer.blocks : undefined;
		this.spec		= readText(blocks);
		this.picture	= this.spec && picture;
		this.closePicker?.();
		this.hold(!!this.spec);
		this.host.style.display = this.spec && !this.hidden ? '' : 'none';
		if (!this.spec || !layer || !blocks)
			return undefined;
		this.layer	= layer;
		this.blocks	= blocks;
		askFonts(() => this.draw());
		this.input.value = this.spec.text.replace(/\r$/, '').replace(/[\r\u0003]/g, '\n');
		this.draw();
		if (focus) {
			this.input.focus();
			this.input.select();
		}
		return this;
	}

	/** Whether this has the layer's text as the layer has it now (if not, as after an undo, it is to be opened again). */
	has(layer?: PixelLayer) {
		return !!this.spec && this.layer === layer && this.blocks === layer.blocks;
	}

	/** The text as it is being changed, made as the layer's pixels and blocks. */
	state(): ShapeState {
		const spec = this.spec!;
		return {...renderText(spec, layoutText(spec)), blocks: withText(this.layer.blocks!, spec)};
	}

	// an edit from a menu is the layer's at once
	private edited = (label: string, key: string) => {
		this.picture?.commitEdit(label, key);
		this.draw();
	};

	/** The menu of how the text is set, and the text's warp, which is in the transform menu. */
	items() {
		return this.spec ? textItems(this.spec, this.edited, this.pick) : [];
	}
	warpItems() {
		return this.spec ? warpItems(this.spec, this.edited) : [];
	}

	// what is in the box is the layer's text
	private typed() {
		const spec = this.spec;
		if (!spec)
			return;
		const after = this.input.value.replace(/\n/g, '\r') + '\r';
		spec.runs	= reflowRuns(spec.runs, spec.text, after);
		spec.paras	= reflowParas(spec.paras, spec.text, after);
		spec.text	= after;
		this.picture?.commitEdit('Edit Text', 'text');
		this.draw();
	}

	// the text carried about by its handle
	private carry(e: PointerEvent) {
		const spec = this.spec, picture = this.picture;
		if (!spec || !picture || e.button !== 0)
			return;
		e.preventDefault();
		e.stopPropagation();
		const k = this.canvas.getBoundingClientRect().width / this.canvas.width, scale = picture.pan.scale * k;
		const from = {x: e.clientX, y: e.clientY, tx: spec.transform[4], ty: spec.transform[5]};
		this.handle.setPointerCapture(e.pointerId);
		const move = (m: PointerEvent) => {
			spec.transform[4] = from.tx + (m.clientX - from.x) / scale;
			spec.transform[5] = from.ty + (m.clientY - from.y) / scale;
			picture.commitEdit('Move Text', 'text-move');
			this.draw();
		};
		const end = () => {
			this.handle.removeEventListener('pointermove', move);
			this.handle.removeEventListener('pointerup', end);
			this.handle.removeEventListener('pointercancel', end);
		};
		this.handle.addEventListener('pointermove', move);
		this.handle.addEventListener('pointerup', end);
		this.handle.addEventListener('pointercancel', end);
	}

	// the box over the text, as the picture is seen
	draw() {
		const spec = this.spec, picture = this.picture;
		if (!spec || !picture)
			return;
		// (the canvas's pixels are in the window's: client = pixel * s + t)
		const pan = picture.pan, r = this.host.getBoundingClientRect(), c = this.canvas.getBoundingClientRect(), k = c.width / this.canvas.width;
		const s = pan.scale * k, tx = c.left + pan.offset.x * k - r.left, ty = c.top + pan.offset.y * k - r.top;

		const layout = layoutText(spec), box = textBox(spec, layout.area);
		const style = spec.runs[0].style, size = style.size * scaleOf(spec) * s;
		const pad = 4;
		const width = Math.max(box.max.x - box.min.x, style.size * scaleOf(spec)) * s + pad * 2, height = Math.max(box.max.y - box.min.y, style.size * scaleOf(spec)) * s + pad * 2;
		const f = this.frame.style;
		f.left		= `${box.min.x * s + tx - pad}px`;
		f.top		= `${box.min.y * s + ty - pad}px`;
		f.width		= `${width}px`;
		f.height	= `${height}px`;

		const i = this.input.style;
		i.font			= cssFont(style, scaleOf(spec) * s);
		i.padding		= `${pad}px`;
		i.lineHeight	= `${(style.leading ?? style.size * spec.autoLeading) * style.vscale * scaleOf(spec) * s}px`;
		i.textAlign		= ['left', 'right', 'center'][(spec.paras[0]?.justification ?? 0) % 3];
		i.letterSpacing	= `${style.tracking / 1000 * size}px`;
	}
}

//=============================================================================
//	rendering
//=============================================================================

// A text layer's text drawn as pixels (a canvas's own text, so with the fonts the page has), from the description psdtext.ts makes of the
// layer: broken into lines (at the paragraphs' ends, and at the box's edge for text in one), set by the paragraphs' alignment, and drawn
// in the layer's transform. The file's own picture of it was made by Photoshop's, which this only comes near.

//-----------------------------------------------------------------------------
//	fonts
//-----------------------------------------------------------------------------

// The fonts the machine has, from the extension (which scans them): a PSD names a font by its PostScript name, which only these say
// for certain. Until they are known (or if they cannot be), a name is taken apart by the way fonts are usually named.
export interface InstalledFont { family: string, style: string, postscript: string }
let installed: InstalledFont[] = [];
const slanted = (style: string) => /italic|oblique/i.test(style), weighty = (style: string) => /bold|black|heavy/i.test(style) && !/semi|demi/i.test(style);

export function setInstalledFonts(fonts: InstalledFont[]) { installed = fonts; }

/** The families there are to choose from. */
export const familyNames = () => [...new Set(installed.map(f => f.family))].sort((a, b) => a.localeCompare(b));

export interface FontFace { family: string, bold: boolean, italic: boolean }

/** The family and slant a PostScript name is for. */
export function faceOf(postscript: string): FontFace {
	const known = installed.find(f => f.postscript === postscript);
	if (known)
		return {family: known.family, bold: weighty(known.style), italic: slanted(known.style)};
	const [name, style = ''] = postscript.split('-');
	const family = name.replace(/(PS)?MT$/, '').replace(/PS$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
	return {family, bold: weighty(style), italic: slanted(style)};
}

/** The PostScript name of a family in a weight and slant: the installed font that is it, or the name such a font would have. */
export function postscriptOf({family, bold, italic}: FontFace): string {
	const styles = installed.filter(f => f.family === family);
	const exact = styles.find(f => weighty(f.style) === bold && slanted(f.style) === italic && !/semi|demi|light|thin|medium|condensed|narrow/i.test(f.style));
	if (exact)
		return exact.postscript;
	const name = family.replace(/\s+/g, '');
	return bold || italic ? `${name}-${bold ? 'Bold' : ''}${italic ? 'Italic' : ''}` : name;
}

/** The CSS font for a style (its size in the text's units: `scale` is the pixels of one). */
export function cssFont(style: TextStyle, scale = 1) {
	const face = faceOf(style.font);
	const bold = face.bold || style.bold, italic = face.italic || style.italic;
	const weight = style.bold || /bold|black|heavy/i.test(style.font.split('-')[1] ?? '') && !/semi|demi/i.test(style.font) ? (/black|heavy/i.test(style.font) ? 900 : 700)
		: /semibold|demi/i.test(style.font) ? 600 : /light/i.test(style.font) ? 300 : face.bold || bold ? 700 : 400;
	return `${italic ? 'italic ' : ''}${weight} ${style.size * scale}px "${face.family}", sans-serif`;
}

//-----------------------------------------------------------------------------
//	layout
//-----------------------------------------------------------------------------

interface Piece { text: string, style: TextStyle, width: number }
interface Line {
	pieces:		Piece[];
	width:		number;
	baseline:	number;		// below the text's origin (for a line of text in a box, which is the box's top, the first line's is its ascent)
	left:		number;		// where the line starts across, from the alignment
}
interface Layout {
	lines:		Line[];
	area:		float2.extent;		// the extent of the text, in its own units
}

let measurer: CanvasRenderingContext2D | undefined;
const measuring = () => measurer ??= createElement('canvas').getContext('2d')!;

function setFont(ctx: CanvasRenderingContext2D, style: TextStyle) {
	ctx.font = cssFont(style);
	ctx.letterSpacing = `${style.tracking / 1000 * style.size}px`;
}

const widthOf = (ctx: CanvasRenderingContext2D, text: string, style: TextStyle) => {
	setFont(ctx, style);
	return ctx.measureText(text).width * style.hscale;
};

/** The text broken into lines and put in place, in the text's own units. */
function layoutText(spec: TextSpec): Layout {
	const ctx = measuring();

	// what style is at a place in the text
	const styleAt = (at: number) => {
		let end = 0;
		for (const run of spec.runs) {
			end += run.length;
			if (at < end)
				return run.style;
		}
		return spec.runs[spec.runs.length - 1].style;
	};
	const justificationAt = (at: number) => {
		let end = 0;
		for (const para of spec.paras) {
			end += para.length;
			if (at < end)
				return para.justification;
		}
		return spec.paras[spec.paras.length - 1]?.justification ?? 0;
	};
	const leadingOf = (style: TextStyle) => (style.leading ?? style.size * spec.autoLeading) * style.vscale;

	const lines: Line[] = [];
	const boxWidth = spec.box?.width;
	let y = 0, first = true;

	let start = 0;
	for (const paragraph of spec.text.split(/(?<=[\r\n\u0003])/)) {
		const body = paragraph.replace(/[\r\n\u0003]$/, '');

		// the words, each of pieces which are a run's part of it
		const words: Piece[][] = [];
		for (let i = 0; i < body.length;) {
			let j = i;
			while (j < body.length && body[j] !== ' ')
				j++;
			while (j < body.length && body[j] === ' ')
				j++;
			const pieces: Piece[] = [];
			for (let k = i; k < j;) {
				const style = styleAt(start + k);
				let m = k + 1;
				while (m < j && styleAt(start + m) === style)
					m++;
				const text = body.slice(k, m);
				pieces.push({text, style, width: widthOf(ctx, text, style)});
				k = m;
			}
			words.push(pieces);
			i = j;
		}

		const justification = justificationAt(start) % 3 === 1 ? 1 : justificationAt(start) % 3 === 2 ? 2 : 0;	// (justified text is set as its last line is: by its side)
		const rows: Piece[][] = [[]];
		let rowWidth = 0;
		for (const word of words) {
			const full = word.reduce((a, p) => a + p.width, 0);
			const last = word[word.length - 1];
			const trimmed = full - (last.width - widthOf(ctx, last.text.trimEnd(), last.style));
			if (boxWidth !== undefined && rows[rows.length - 1].length && rowWidth + trimmed > boxWidth) {
				rows.push([]);
				rowWidth = 0;
			}
			rows[rows.length - 1].push(...word);
			rowWidth += full;
		}

		for (const pieces of rows) {
			const style = pieces[0]?.style ?? styleAt(start);
			const leading = Math.max(leadingOf(style), ...pieces.map(p => leadingOf(p.style)));
			const width = pieces.reduce((a, p) => a + p.width, 0) - (pieces.length ? pieces[pieces.length - 1].width - widthOf(ctx, pieces[pieces.length - 1].text.trimEnd(), pieces[pieces.length - 1].style) : 0);
			if (first) {
				// (a line of text set from a point has its baseline there; one in a box hangs from the top of it)
				setFont(ctx, style);
				y = boxWidth !== undefined ? (ctx.measureText('M').fontBoundingBoxAscent ?? style.size * 0.8) * style.vscale : 0;
				first = false;
			} else {
				y += leading;
			}
			const room = boxWidth ?? 0;
			const left = justification === 0 ? 0 : boxWidth !== undefined ? (justification === 1 ? room - width : (room - width) / 2) : (justification === 1 ? -width : -width / 2);
			lines.push({pieces, width, baseline: y, left});
		}
		start += paragraph.length;
	}

	let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
	for (const line of lines) {
		left	= Math.min(left, line.left);
		right	= Math.max(right, line.left + line.width);
		const size = Math.max(0, ...line.pieces.map(p => p.style.size * p.style.vscale));
		top		= Math.min(top, line.baseline - size * 0.9);
		bottom	= Math.max(bottom, line.baseline + size * 0.25);
	}
	if (spec.box) {
		left = 0; right = spec.box.width; top = 0; bottom = Math.max(bottom, spec.box.height);
	} else if (!lines.length || !isFinite(left)) {
		left = right = top = bottom = 0;
	}
	return {lines, area: new float2.extent(float2(left, top), float2(right, bottom))};
}

//-----------------------------------------------------------------------------
//	warping
//-----------------------------------------------------------------------------

// the text's warp, if it has one that does anything
function textWarp(spec: TextSpec) {
	return spec.warp && spec.warp.style !== 'warpNone' ? spec.warp : undefined;
}

/** What carries a point of the text (in its units) when it is warped over `area`, its extent. Each style's curve is of `p` across and down the
 *  extent, -1 to 1 from its centre, and makes a place from the centre in the text's units (`half` the extent's size). (Each style is a plain curve
 *  of the Photoshop's of that name, which this only comes near.) */
function warpFunction(warp: TextWarp, area: float2.extent): (p: float2) => float2 {
	// (text set down the page is warped across the page, as it were set the other way and turned)
	const mid	= area.centre(), size = area.size().scale(0.5), half = warp.down ? size.yx : size;
	const b		= warp.bend / 100;
	const hv2	= float2(warp.vertical / 200, warp.horizontal / 200);	// (x is scaled by the vertical distortion across y, y by the horizontal across x)

	const finish = (p: float2, P: float2): float2 => {
		return P.sub(P.mul(p.yx).mul(hv2))
	}
	let curve = (p: float2) => finish(p, p.mul(half));
	switch (warp.style) {
		case 'warpArc':			// on an arc, each side a line out from its centre
			if (Math.abs(b) > 1e-4) {
				const sweep = Math.abs(b) * Math.PI / 2, sign = Math.sign(b), radius = half.x / sweep;
				curve = p => {
					const r = radius - sign * p.y * half.y, angle = p.x * sweep;
					return finish(p, float2(r * Math.sin(angle), -sign * (r * Math.cos(angle) - radius)));
				};
			}
			break;
		case 'warpArch':		// the arc's curve, all of it carried up or down together
			curve = p => finish(p, float2(p.x, p.y - b * (1 - p.x * p.x)).mul(half));
			break;
		case 'warpArcUpper':	// the top bent, the bottom as it was
			curve = p => finish(p, float2(p.x, p.y - b * (1 - p.x * p.x) * (1 - p.y)).mul(half));
			break;
		case 'warpArcLower':	// the bottom bent, the top as it was
			curve = p => finish(p, float2(p.x, p.y + b * (1 - p.x * p.x) * (1 + p.y)).mul(half));
			break;
		case 'warpBulge':		// the middle swelled
			curve = p => finish(p, float2(p.x, p.y * (1 + b * (1 - p.x * p.x))).mul(half));
			break;
		case 'warpFlag':		// a wave along it
			curve = p => finish(p, float2(p.x, p.y + b * Math.sin(Math.PI * p.x)).mul(half));
			break;
		case 'warpWave':		// the wave made by one edge moving more than the other
			curve = p => finish(p, float2(p.x, p.y + b * Math.sin(Math.PI * p.x) * -p.y).mul(half));
			break;
		case 'warpShellLower':	// the bottom bent and spread, the top drawn in: a shell's fan
			curve = p => finish(p, float2(p.x * (1 - b * (1 - p.y) / 4), p.y + b * (1 - p.x * p.x) * (1 + p.y)).mul(half));
			break;
		case 'warpShellUpper':	// the same, upside down
			curve = p => finish(p, float2(p.x * (1 - b * (1 + p.y) / 4), p.y - b * (1 - p.x * p.x) * (1 - p.y)).mul(half));
			break;
		case 'warpFish':		// swelled in the middle and narrowed to the ends
			curve = p => finish(p, float2(p.x, p.y * (1 + b * (1 - 2 * p.x * p.x))).mul(half));
			break;
		case 'warpRise':		// carried up (or down) from one end to the other, level at each end
			curve = p => finish(p, float2(p.x, p.y - b * Math.sin(Math.PI * p.x / 2)).mul(half));
			break;
		case 'warpFisheye':		// the middle made bigger, as much each way, the corners where they were (by how far from the middle, in the text's units)
			curve = p => {
				const q = p.mul(half);
				return finish(p, q.scale(1 + b * Math.max(0, 1 - q.lensq() / half.lensq())));
			};
			break;
		case 'warpInflate':		// puffed out each way, the middles of the sides most
			curve = p => finish(p, float2(p.x * (1 + b / 2 * (1 - p.y * p.y)), p.y * (1 + b * (1 - p.x * p.x))).mul(half));
			break;
		case 'warpSqueeze':		// pinched in at the middles of the sides and stretched up and down to make up for it
			curve = p => finish(p, float2(p.x * (1 - b / 2 * (1 - p.y * p.y)), p.y * (1 + b / 2 * (1 - p.x * p.x))).mul(half));
			break;
		case 'warpTwist':		// turned about the middle, most at the middle and not at all at the corners (by how far from the middle, in the text's
								// units, so it turns rather than shears, and the ends of a long line turn little)
			curve = p => {
				const q = p.mul(half), angle = b * Math.PI / 2 * Math.max(0, 1 - q.lensq() / half.lensq()), c = Math.cos(angle), s = Math.sin(angle);
				return finish(p, float2(q.x * c - q.y * s, q.x * s + q.y * c));
			};
			break;
	}
	return warp.down
		? p => curve(p.sub(mid).div(size).yx).yx.add(mid)
		: p => curve(p.sub(mid).div(size)).add(mid);
}

// what carries a point of the text (in its units) to the canvas: the warp, if it has one (over its extent), then the transform
function textMap(spec: TextSpec, area: float2.extent): (p: float2) => float2 {
	const [a, b, c, d, e, f] = spec.transform;
	const transform	= (p: float2) => float2(a * p.x + c * p.y + e, b * p.x + d * p.y + f);
	const warp		= textWarp(spec);
	if (!warp)
		return transform;
	const w = warpFunction(warp, area);
	return p => transform(w(p));
}

/** Text carried by a map of the canvas that is not affine (a free distort): the transform and the warp's two distortions are found that put the
 *  corners of the text's extent where the map puts them, and the text between them is carried as a bilinear map does. Photoshop's text warp has
 *  no more than that, so it is as far as the text can stay text. False, with the text as it was, if that is not enough: a warp that bends it, or
 *  corners that would be turned past what a distortion of 100% is. */
function distortText(spec: TextSpec, area: float2.extent, map: (x: float2) => float2): boolean {
	const warp = textWarp(spec);
	if (area.empty() || warp && Math.abs(warp.bend) > 1e-6)
		return false;
	
	const c		= area.centre(), h = area.size().scale(0.5);

	const carry = textMap(spec, area);
	const at	= (x: number, y: number) => map(carry(float2(x * h.x + c.x, y * h.y + c.y)));

	const [pp, pm, mp, mm] = [at(1, 1), at(1, -1), at(-1, 1), at(-1, -1)];
	
	// (Q(x, y) = O + x X1 + y X2 + x y D over the extent, from -1 to 1 each way)
	const O		= pp.add(pm).add(mp).add(mm).scale(0.25);
	const X1	= pp.add(pm).sub(mp).sub(mm).scale(0.25);
	const X2	= pp.sub(pm).add(mp).sub(mm).scale(0.25);
	const D		= pp.sub(pm).sub(mp).add(mm).scale(0.25);

	// D = -(v X1 + h X2) / 2, where v and h are the warp's distortions as fractions
	const det	= X1.cross(X2);
	if (!isFinite(det) || Math.abs(det) < 1e-9 * (X1.len() * X2.len() || 1))
		return false;

	const R		= D.scale(-2);
	const v		= R.cross(X2) / det;
	const hz	= X1.cross(R) / det;
	if (Math.abs(v) > 1 || Math.abs(hz) > 1)
		return false;

	const A			= [X1.x / h.x, X1.y / h.x, X2.x / h.y, X2.y / h.y];
	spec.transform	= [A[0], A[1], A[2], A[3], O.x - A[0] * c.x - A[2] * c.y, O.y - A[1] * c.x - A[3] * c.y];
	spec.warp		= Math.abs(v) < 1e-9 && Math.abs(hz) < 1e-9 ? undefined : {style: warp?.style ?? 'warpArc', bend: 0, horizontal: hz * 100, vertical: v * 100, down: false};
	return true;
}

//-----------------------------------------------------------------------------
//	drawing
//-----------------------------------------------------------------------------

// the lines of a layout drawn at the origin, in the units of whatever transform the context has
function drawLines(ctx: CanvasRenderingContext2D, lines: Line[]) {
	for (const line of lines) {
		let x = line.left;
		for (const piece of line.pieces) {
			const style = piece.style;
			setFont(ctx, style);
			ctx.fillStyle = toCss(style.colour);
			ctx.save();
			ctx.translate(x, line.baseline);
			ctx.scale(style.hscale, style.vscale);
			ctx.fillText(piece.text, 0, 0);
			const plain = piece.text.trimEnd(), w = ctx.measureText(plain).width;
			if (style.underline)
				ctx.fillRect(0, style.size * 0.1, w, Math.max(1, style.size * 0.05));
			if (style.strike)
				ctx.fillRect(0, -style.size * 0.3, w, Math.max(1, style.size * 0.05));
			ctx.restore();
			x += piece.width;
		}
	}
}

/** The text as pixels, over the whole pixels of the canvas that it covers (textBox: the layout's area is in the text's own units). */
function renderText(spec: TextSpec, layout: Layout): PlacedPixels<4> {
	const area		= layout.area, box = roundOut(textBox(spec, area));
	const {x: left, y: top}		= box.min;
	const {x: width, y: height} = box.size();
	const [a, b, c, d, e, f]	= spec.transform;

	if (!textWarp(spec)) {
		const ctx = createElement('canvas', {width, height}).getContext('2d', {willReadFrequently: true})!;
		ctx.setTransform(a, b, c, d, e - left, f - top);
		drawLines(ctx, layout.lines);
		return {left, top, image: ctx.getImageData(0, 0, width, height)};
	}

	// the text drawn flat (finely enough for where it goes), then carried to where the warp puts it
	const {x: w, y: h} = area.size();
	const res		= Math.min(Math.max(1, Math.sqrt(Math.abs(a * d - b * c))), 2048 / Math.max(w, h));
	const texture	= createElement('canvas', {width: Math.max(1, Math.ceil(w * res)), height: Math.max(1, Math.ceil(h * res))});
	const tctx		= texture.getContext('2d', {willReadFrequently: true})!;
	tctx.setTransform(res, 0, 0, res, -area.min.x * res, -area.min.y * res);
	drawLines(tctx, layout.lines);

	const map		= textMap(spec, area), flat = tctx.getImageData(0, 0, texture.width, texture.height), at = float2(left, top);
	const warped	= meshWarp(canvas3d, programTextWarp, flat, new float2.extent(float2(0, 0), float2(texture.width, texture.height)),
		p => map(p.scale(1 / res).add(area.min)).sub(at),
		new float2.extent(float2(0, 0), float2(width, height))
	);
	return {left, top, image: warped};
}

/** Where the text is on the canvas, as a rectangle: the layout's extent (warped, if it is) put through the transform. */
function textBox(spec: TextSpec, area: float2.extent) {//layout = layoutText(spec)) {
	// (a warp bends the sides; without one, the corners are enough)
	const map = textMap(spec, area), [across, down] = textWarp(spec) ? [64, 24] : [1, 1];
	return sampledExtent(area, map, across, down);
}


//-----------------------------------------------------------------------------
//	outlines
//-----------------------------------------------------------------------------

/** The characters of a text layer as the page set them, run by run, for the extension to draw the outlines of: the fonts are there. */
export interface GlyphRun {
	font:	string;		// the PostScript name
	family:	string;
	bold:	boolean;
	italic:	boolean;
	size:	number;
	hscale:	number;
	vscale:	number;
	x:		number;		// the run's start, and its baseline, in the text's units
	y:		number;
	chars:	{ch: string, x: number}[];	// each from the run's start, with the kerning and tracking the text was set with
}

/** The runs there are in a laid-out text, and the colour of the first of them. */
function glyphRuns(spec: TextSpec, lines: Line[]) {
	const ctx = measuring(), runs: GlyphRun[] = [];
	let colour: RGB | undefined;
	for (const line of lines) {
		let x = line.left;
		for (const piece of line.pieces) {
			const style = piece.style, face = faceOf(style.font);
			setFont(ctx, style);
			colour ??= style.colour;
			const chars: GlyphRun['chars'] = [];
			let i = 0;
			for (const ch of piece.text) {
				chars.push({ch, x: ctx.measureText(piece.text.slice(0, i)).width * style.hscale});
				i += ch.length;
			}
			runs.push({font: style.font, family: face.family, bold: face.bold || style.bold, italic: face.italic || style.italic, size: style.size, hscale: style.hscale, vscale: style.vscale, x, y: line.baseline, chars});
			x += piece.width;
		}
	}
	return {runs, colour};
}

/** Contours of cubics (in the text's units) carried to the canvas: through the warp, if there is one, and the transform. A warp bends what is
 *  between a segment's ends, so each is cut into pieces first. Contours come back closed, ending where they began. */
function textCurve(spec: TextSpec, area: float2.extent, curve: curveVertex[]): curveVertex[] {
	const map = textMap(spec, area), parts = textWarp(spec) ? 8 : 1;
	const out: curveVertex[] = [];
	for (let i = 0; i < curve.length;) {
		let end = i + 1;
		while (end < curve.length && curve[end].flags !== ON_BEGIN)
			end++;
		const pts = curve.slice(i, end);
		i = end;
		const first = pts[0];
		const put = (p: {x: number, y: number}, flags: number) => out.push(makeCurveVertex(map(float2(p.x, p.y)), flags));
		put(first, ON_BEGIN);
		let from = first;
		for (let k = 1; k < pts.length;) {
			const cubic = pts[k].flags === OFF_BEZ3 && pts[k + 1]?.flags === OFF_BEZ3 && pts[k + 2];
			const to = cubic ? pts[k + 2] : pts[k], p1 = cubic ? pts[k] : from, p2 = cubic ? pts[k + 1] : to;
			k += cubic ? 3 : 1;
			if (parts === 1 && !cubic) {
				put(to, ON_CURVE);		// (a line is its ends)
			} else {
				// the segment cut in parts, each a cubic of the same curve
				const at = (t: number) => {
					const u = 1 - t, m = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
					return {x: m[0] * from.x + m[1] * p1.x + m[2] * p2.x + m[3] * to.x, y: m[0] * from.y + m[1] * p1.y + m[2] * p2.y + m[3] * to.y};
				};
				const slope = (t: number) => {
					const u = 1 - t;
					return {x: 3 * (u * u * (p1.x - from.x) + 2 * u * t * (p2.x - p1.x) + t * t * (to.x - p2.x)), y: 3 * (u * u * (p1.y - from.y) + 2 * u * t * (p2.y - p1.y) + t * t * (to.y - p2.y))};
				};
				for (let j = 0; j < parts; j++) {
					const t0 = j / parts, t1 = (j + 1) / parts, s0 = slope(t0), s1 = slope(t1), p0 = at(t0), q = at(t1), dt = (t1 - t0) / 3;
					put({x: p0.x + s0.x * dt, y: p0.y + s0.y * dt}, OFF_BEZ3);
					put({x: q.x - s1.x * dt, y: q.y - s1.y * dt}, OFF_BEZ3);
					put(j === parts - 1 ? to : q, ON_CURVE);
				}
			}
			from = to;
		}
		// (it comes back to where it began, which ends it: a contour that is closed does not end in ON_END)
		if (from.x !== first.x || from.y !== first.y)
			put(first, ON_CURVE);
	}
	return out;
}
