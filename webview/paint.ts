// The bitmap editor's tools, with their options for the menu the right button brings up (cascade.ts), and the selection.
// The pixels themselves are changed by the Operations here; this turns pointer and key events into those changes.
// Transforms are not tools (transform.ts): the tools give way to one while it is under way.

import { float2 } from '@isopodlabs/maths/vector';
import { CurveFlag, curveFlatten, curveVertex } from '@isopodlabs/binary_fonts/curves';
import { createElement, RPC } from '@isopodlabs/vscode_utils/webview/shared.js';
import * as xml from '@isopodlabs/xml';

import { Mode, postMessage, working, filterPrograms, CoordinateInterface } from './modes.js';
import { RGBA, asRGBA, loadRGBA, fromHex, toHex, clamp01, toFloat, saveRGBA } from './colour.js';
import { Canvas3D, Pixels, imageSize, imageRect, unionRect, getPixel, Offscreen, readRect, writeRect, bitmapToImage, PixelStorage } from './opengl.js';
import { Shape, blurPasses, drawPasses, textureLimit, ShadePass, crop, levelsUniforms, Kernel, kernelUniforms, Levels, boxKernel, embossKernel, edgeKernel, roundOut } from './raster.js';
import { flattenWith, gradientsWith, traceWith, inkWith, mixed, type Traced, type TracedFill } from './vectorise.js';
import { Selection } from './bitmapSelection.js';
import { segment, removeObject, stylise, styleFrom, styles, type Style } from './neural.js';
import { History, type HistoryEntry } from './history.js';
import { Input, Place, typing, type Drag } from './navigate.js';
import type { PixelLayer } from './layers.js';
import { newShapeLayer, type NewPaint } from './shapeedit.js';
import { gridSpacing, fitRuns, svgPath } from './pathedit.js';
import { Cascade, CascadeItem,
	svgFace, swatchFace, valueFace, imgFace,
	valueItem, ValueOptions, valueItemPersist,
	sliderItem, sliderItemPersist,
	choiceItemPersist,
	toggleItemPersist,
	multiplicativeStep, colourItems,
} from './cascade.js';

type FilterKind		= 'blur' | 'sharpen' | 'levels' | 'boxBlur' | 'emboss' | 'edges';
type FilterUsing	= {blurRadius?: number, sharpenRadius?: number, boxSize?: number};
type Tool			= 'hand' | 'marquee' | 'ellipse-marquee' | 'lasso' | 'polygon-lasso' | 'wand' | 'segment' | 'brush' | 'pencil' | 'eraser' | 'stamp' | 'bucket' | 'gradient' | 'eyedropper' | 'line' | 'rect' | 'ellipse';
type SelectMode		= 'replace' | 'add' | 'subtract' | 'intersect';

class Region extends Shape {
	id: string;
	constructor(public image: Pixels<4>, sel?: Selection) {
		const ext = sel ? sel : imageRect(image);
		super(ext, sel?.mask);
		this.id = `${ext.min.x},${ext.min.y},${ext.max.x},${ext.max.y}`;
	}
};


// where the clone stamp copies from: pixels, and the point Alt-clicked as it is on them (a stroke copies the pixel as far from that point
// as it is from where the stroke began)
export interface CloneSource {
	from:		Pixels<4>;
	at:			float2;
	offset?:	float2;		// once a stroke has begun, how far the source is from where it paints (on the source's pixels)
}

// what the editor needs of the viewer it is part of
export interface PaintHost extends CoordinateInterface {
	canvas:			HTMLCanvasElement;
	canvas3d:		Canvas3D;
	target():									Pixels<4> | undefined;	// what the tools draw on: the current layer's pixels (which cover the canvas), or the picture if there is none
	pick(x: number, y: number):					RGBA | undefined;	// the colour seen at a pixel of the picture (of the current layer, if it is on it)
	changed(image: Pixels<4>, rect?: float2.extent): void;				// pixels of an image (all of them, without a rect) have changed
	redraw():									void;
	cloneSource?(at: float2, all: boolean):		CloneSource | undefined;	// what the clone stamp copies from, chosen now (what the tools draw on, or all the picture shows) and read as each stroke begins
	// for a picture of surfaces that join (the faces of a cube), where a stroke goes on from one to the next
	crossTo?(x: number, y: number, last: float2): float2 | undefined;	// the pointer is over another surface, which is the target now: where `last` is on it
	adjoining?(p: float2, q: float2, size: number): {image: Pixels<4>, p: float2, q: float2, size: number}[];	// a stroke from p to q on the target, as it falls on the other surfaces it reaches
	shownBy(image: Pixels<4>): Offscreen | undefined;
	addLayers?(layers: PixelLayer[], label: string): void | Promise<void>;
}

// A program of Mode.shade as the vectorising functions take their shader: what they are given runs its passes on an image
const shadeWith = (program: string) => (image: Pixels<4>, passes: ShadePass[], reach: number) => Mode.shade(program, image, imageRect(image), passes, reach) as Pixels<4> | undefined;

// what a tool shows of its change while it is dragged, where working out the pixels each time would be too slow
export interface ShadePreview {
	readonly image:	Pixels<4>;		// what it shows
	readonly program: string;		// the shader it shows it with
	show(passes: ShadePass[] | Record<string, any>, other?: Pixels<4>): void;	// the image as the shader draws it with these (a single pass can be given as just its uniforms), and another image for it to draw from (u_other)
	end(): void;											// the image's own pixels shown again
}

interface Filter {program: string, passes: ShadePass[] | Record<string, any>, reach: number}


// An image shown as a filter's shader draws it from its pixels (the same passes Mode.shade runs, the last into the texture it is shown
// from instead of back to the CPU), limited to what the operation's selection lets through. The image's pixels are put back into the
// texture at the end. Nothing where the host has no single texture to draw into (or the image is more than the GPU can hold as one).
function previewShade(host: PaintHost, op: Operation, program: string): ShadePreview | undefined {
	const canvas3d = host.canvas3d, image = op.image;
	const shader = filterPrograms[program];
	const target = shader && Math.max(image.width, image.height) <= textureLimit(canvas3d) && host.shownBy(image);
	if (!target)
		return undefined;
	const sel = op.selection, m = sel?.mask, box = sel ?? imageRect(image), whole = imageRect(image);
	const options = {min: 'nearest', mag: 'nearest'} as const;
	const source = canvas3d.createTextureFromImage(image, {format: 'rgba8', ...options});
	// (the selection's coverage, a texel of it where there is none; and the other images shown from, which are kept while they are asked for)
	const mask = canvas3d.createTextureFromImage(m ? Pixels(new Uint8ClampedArray(m.buffer as ArrayBuffer, m.byteOffset, m.length), sel.width, sel.height, 1) : Pixels(new Uint8ClampedArray([255]), 1, 1, 1), {format: 'r8', ...options});
	const others = new Map<Pixels<4>, WebGLTexture>();
	const limit = {u_selection: 2, u_bounded: 1, u_selected: [box.min.x, box.min.y, box.max.x - box.min.x, box.max.y - box.min.y], u_masked: m ? 1 : 0};
	const area = op.bounds();
	return {
		image, program,
		show: (passes, other) => {
			let texture = other && others.get(other);
			if (other && !texture)
				others.set(other, texture = canvas3d.createTextureFromImage(other, {format: 'rgba8', ...options}));
			drawPasses(canvas3d, shader, source, whole, area, Array.isArray(passes) ? passes : [{uniforms: passes}], false, {
				rect:		whole,
				open:		() => target,
				read:		() => undefined,
				uniforms:	limit,
			}, texture ? [mask, texture] : [mask]);
		},
		end: () => {
			target.delete(true);
			canvas3d.deleteTexture(source);
			canvas3d.deleteTexture(mask);
			for (const t of others.values())
				canvas3d.deleteTexture(t);
			host.changed(image);
		},
	};
}

interface ToolInfo {
	icon:		string;		// SVG path data
	label:		string;		// its name, which is also what an edit made with it is called
	hint?:		string;		// more for the menu's caption: how to use it
	hotspot?:	[number, number];
	key:		string;		// the menu's caption adds it to the label
}
const CURSOR_SIZE = 24;

const toolInfo: Record<Tool, ToolInfo> = {
	hand:				{
		icon:		'<path d="M8 1.5v13M1.5 8h13M8 1.5L6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
		label:		'Hand',
		hint:		'hold Space to use it while another tool is chosen',
		key:		'h',//	'hand'],
	},
	marquee:			{
		icon:		'<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.5"/>',
		label:		'Rectangular Marquee',
		key:		'm',//	'marquee', 'ellipse-marquee'],
	},
	'ellipse-marquee': {
		icon:		'<ellipse cx="8" cy="8" rx="5.5" ry="4.5" stroke-dasharray="2 1.5"/>',
		label:		'Elliptical Marquee',
		key:		'm',//	'marquee', 'ellipse-marquee'],
	},
	lasso:				{
		icon:		'<path d="M4 6.5C4 3.5 11 3 12.5 6S9 11 6.5 10.5 5 13.5 3.5 13.5" stroke-dasharray="2 1.5"/>',
		label:		'Lasso',
		key:		'l',
	},
	'polygon-lasso':	{
		icon:		'<path d="M2.5 11.5l2-7 5 2 3-3.5 1 8z" stroke-dasharray="2 1.5"/>',
		label:		'Polygonal Lasso',
		hint:		'click the corners, click the first to close, Backspace takes one back',
		key:		'l',
	},
	wand:				{
		icon:		'<path d="M2.5 13.5l7-7"/><path d="M11 1.5v3M9.5 3h3M13.5 7v2M12.5 8h2M6 2.5v2M5 3.5h2"/>',
		label:		'Magic Wand',
		key:		'w',
	},
	segment:			{
		icon:		'<path d="M3 3h3M10 3h3M3 13h3M10 13h3M3 3v3M13 3v3M3 10v3M13 10v3"/><path d="M6.5 7.5l3 1-1 1.5 1.5 2.5" stroke-linejoin="round"/>',
		label:		'Object Select',
		hint:		'click an object to select it (the first use fetches a neural network, and takes a moment)',
		key:		'w',
	},
	brush:			{
		icon:		'<path d="M13.5 2.5l-6 6"/><path d="M7.5 8.5c-2 0-3 1-3 3 0 1-1 2-2 2.5 3 .5 6-.5 6-3.5z" fill="currentColor"/>',
		label:		'Brush',
		hotspot:	[3, 21],//'brush':
		key:		'b',//	'brush'],
	},
	pencil:			{
		icon:		'<path d="M11 2.5l2.5 2.5-7.5 7.5-3.5 1 1-3.5z"/><path d="M9.5 4l2.5 2.5"/>',
		hotspot:	[3, 21],//'pencil':
		key:		'n',//	'pencil'],
		label:		'Pencil',
	},
	eraser:			{
		icon:		'<path d="M9.5 2.5l4 4-6 6h-3l-2-2z"/><path d="M5 7l4 4M7.5 13.5h6.5"/>',
		hotspot:	[5, 19],//'eraser':
		key:		'e',//	'eraser'],
		label:		'Eraser',
	},
	stamp:			{
		icon:		'<path d="M6.5 2.5h3v4l1 2h3v3h-11v-3h3l1-2z"/><path d="M3 13.5h10"/>',
		key:		's',
		label:		'Clone Stamp',
		hint:		'Alt-click where to copy from (on any layer), then paint',
	},
	bucket:			{
		icon:		'<path d="M3 8l5-5 5 5-4.5 4.5a1.5 1.5 0 0 1-2 0z"/><path d="M13.5 10.5c0 1-1 1.5-1 2.2a1 1 0 0 0 2 0c0-.7-1-1.2-1-2.2z" fill="currentColor"/>',
		hotspot:	[12, 19],//'bucket':
		key:		'g',//	'bucket', 'gradient'],
		label:		'Paint Bucket',
	},
	gradient:			{
		icon:		'<defs><linearGradient id="g"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="2.5" y="2.5" width="11" height="11" fill="url(#g)"/>',
		key:		'g',//	'bucket', 'gradient'],
		label:		'Gradient',
	},
	eyedropper:		{
		icon:		'<path d="M13 3a1.5 1.5 0 0 0-2.1 0L9 4.9 7.9 3.8 7 4.7l.9.9-5 5v2.9h2.9l5-5 .9.9.9-.9-1.1-1.1L13 5.1A1.5 1.5 0 0 0 13 3z"/>',
		label:		'Eyedropper',
		hotspot:	[3, 21],//'eyedropper':
		key:		'i',//	'eyedropper'],
	},
	line:				{
		icon:		'<path d="M2.5 13.5l11-11"/>',
		key:		'u',//	'line', 'rect', 'ellipse'],
		label:		'Line',
	},
	rect:				{
		icon:		'<rect x="2.5" y="3.5" width="11" height="9"/>',
		key:		'u',//	'line', 'rect', 'ellipse'],
		label:		'Rectangle',
	},
	ellipse:			{
		icon:		'<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>',
		key:		'u',//	'line', 'rect', 'ellipse'],
		label:		'Ellipse',
	},
};

// the tools that share a place in the menu, which shows the one last used
const toolGroups: Tool[][] = [
	['marquee', 'ellipse-marquee', 'lasso', 'polygon-lasso', 'wand', 'segment'],
	['brush', 'pencil', 'eraser', 'stamp'],
	['bucket', 'gradient'],
	['line', 'rect', 'ellipse'],
];

// icons of things in the menu that are not tools
const menuIcons = {
	selectAll:	'<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M5.5 8l2 2 3-4"/>',
	deselect:	'<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
	growSelection:	'<rect x="5.5" y="5.5" width="5" height="5"/><rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="2 1.5"/>',
	shrinkSelection: '<rect x="1.5" y="1.5" width="13" height="13"/><rect x="5.5" y="5.5" width="5" height="5" stroke-dasharray="2 1.5"/>',
	borderSelection: '<rect x="2.5" y="2.5" width="11" height="11"/><rect x="5.5" y="5.5" width="5" height="5"/>',
	smoothSelection: '<path d="M2.5 11c3 0 2-6 5.500-6s2.500 6 5.500 6" stroke-dasharray="2 1.5"/>',
	featherSelection: '<rect x="4.5" y="4.5" width="7" height="7" stroke-dasharray="1 1.5"/><rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="1 3" opacity=".6"/>',
	invertSelection: '<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M2.5 2.5h11v11z" fill="currentColor"/>',
	selectNew:	'<rect x="3.5" y="3.5" width="9" height="9"/>',
	selectAdd:	'<rect x="2.5" y="2.5" width="7" height="7"/><rect x="6.5" y="6.5" width="7" height="7"/>',
	selectSub:	'<path d="M2.5 2.5h7v4h4v7h-7v-4h-4z"/>',
	selectInt:	'<rect x="2.5" y="2.5" width="7" height="7"/><rect x="6.5" y="6.5" width="7" height="7"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/>',
	blur:		'<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4" stroke-dasharray="1 1.5"/><circle cx="8" cy="8" r="6" stroke-dasharray="0.5 2"/>',
	sharpen:	'<path d="M8 2.5l5.5 10h-11z"/><path d="M8 6.5l2.5 4.5h-5z" fill="currentColor"/>',
	levels:		'<path d="M2.5 13.5h11M4.5 13.5v-4M7 13.5v-9M9.5 13.5v-6M12 13.5v-3"/>',
	filters:	'<path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z"/>',
	boxBlur:	'<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11"/>',
	emboss:		'<path d="M3 13l4-9 6 9z"/><path d="M7 4l-4 9" stroke-width="2.4"/>',
	edges:		'<path d="M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5z" stroke-dasharray="2 1.2"/>',
	style:		'<path d="M3 13c0-3 2-3 2-5s-1-3 1-5c2 2 5 0 7 2-1 3-3 2-3 5-2 3-5 4-7 3z"/><circle cx="6" cy="7" r="0.8"/><circle cx="10" cy="9" r="0.8"/>',
	ink:		'<path d="M2.5 13.5c2-6 4-9 6-9s2 4 5 4M5 13.5c1.5-3 3-5 4.5-5" stroke-width="1.8"/>',
	gradients:	'<path d="M2.5 2.5h11v11h-11z" fill="currentColor" fill-opacity="0.2"/><path d="M2.5 11l11-6M2.5 13.5l11-6"/>',
	trace:		'<path d="M2.5 13.5C4 6 7 3 13.5 2.5"/><circle cx="2.5" cy="13.5" r="1.2"/><circle cx="13.5" cy="2.5" r="1.2"/><circle cx="7" cy="5.2" r="1.2"/>',
	traceLayers: '<path d="M2 10.5l6 3 6-3M2 7.5l6 3 6-3-6-3z"/><path d="M5 6.5c1-2 3-3 6-2.5" stroke-width="1.4"/>',
	styleAdd:	'<path d="M3 13c0-3 2-3 2-5s-1-3 1-5c2 2 5 0 7 2"/><path d="M11 9.5v5M8.5 12h5"/>',
	copy:		'<rect x="2.5" y="2.5" width="8" height="8" rx="1"/><rect x="5.5" y="5.5" width="8" height="8" rx="1"/>',
	cut:		'<circle cx="4.5" cy="12" r="2"/><circle cx="11.5" cy="12" r="2"/><path d="M5.8 10.5L11 2.5M10.2 10.5L5 2.5"/>',
	paste:		'<rect x="3.5" y="3" width="9" height="11" rx="1"/><path d="M6 3V2h4v1"/><path d="M6 7.5h4M6 10h4"/>',
	flatten:	'<path d="M2.5 13.5v-4h4v4zM6.5 9.5v-4h4v4zM10.5 5.5v-4h3v4z"/>',
	removeObject: '<circle cx="8" cy="8" r="4.5" stroke-dasharray="2 1.5"/><path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6"/>',
	reset:		'<path d="M3.5 8a4.5 4.5 0 1 0 1.5-3.4M3 2.5v3h3"/>',
	swap:		'<path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/>',
	picker:		'<path d="M10.5 2.5l3 3-7 7H3.5v-3z"/><path d="M9 4l3 3"/>',
	contiguous:	'<path d="M2.5 8h3l2-3 2 6 2-3h2"/>',
	filled:		'<rect x="2.5" y="3.5" width="11" height="9" fill="currentColor"/>',
	outline:	'<rect x="2.5" y="3.5" width="11" height="9"/>',
	both:		'<rect x="2.5" y="3.5" width="11" height="9" fill="currentColor" fill-opacity="0.4" stroke-width="2"/>',
	aligned:	'<path d="M2.5 5.5h4M2.5 10.5h4M9.5 5.5h4M9.5 10.5h4"/><path d="M6.5 8h3M8.5 7l1 1-1 1"/>',
	oneLayer:	'<rect x="2.5" y="5.5" width="11" height="5"/>',
	allLayers:	'<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke-width="2"/>',
};

const menuLabels = {
	growSelection:		'Grow Selection',
	shrinkSelection:	'Shrink Selection',
	borderSelection:	'Border Selection',
	smoothSelection:	'Smooth Selection',
	featherSelection:	'Feather Selection',
};
type Modifier = keyof typeof menuLabels;

const crosshair		= '<path d="M8 1.5v4.5M8 10v4.5M1.5 8h4.5M10 8h4.5"/>';

function cursorFor(tool: Tool) {
	if (tool === 'hand')
		return 'grab';
	const info	= toolInfo[tool];
	const hot	= info.hotspot;
	const glyph = hot ? info.icon : crosshair;
	const style = 'fill="none" stroke-linejoin="round" stroke-linecap="round"';
	// the glyph twice, thick and light then thin and dark; filled parts of the icon keep their fill
	const svg	= `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="0 0 16 16">`
		+ `<g ${style} stroke="#fff" stroke-width="3.2" color="#fff">${glyph}</g>`
		+ `<g ${style} stroke="#000" stroke-width="1.2" color="#000">${glyph}</g></svg>`;
	const [x, y] = hot ?? [CURSOR_SIZE / 2, CURSOR_SIZE / 2];
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
}

// A tracing as the text of an SVG the size of the picture: its shapes, each painted to its edge (a thin line of the same paint closing the
// seams where the antialiasing of neighbours meet), under its ink lines
function tracedSvg({width, height, shapes, strokes}: Traced) {
	const round = (n: number) => Math.round(n * 10) / 10;
	const d = (curve: curveVertex[]) => svgPath(curve.map(v => curveVertex(round(v.x), round(v.y), v.flags)));
	const defs = new xml.Element('defs'), svg = new xml.Element('svg', {xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}`}, [defs]);
	shapes.forEach(({curve, fill}, i) => {
		let paint: string;
		if ('stops' in fill) {
			defs.add(new xml.Element('linearGradient', {id: `g${i}`, gradientUnits: 'userSpaceOnUse', x1: round(fill.from.x), y1: round(fill.from.y), x2: round(fill.to.x), y2: round(fill.to.y)},
				fill.stops.map((c, j) => new xml.Element('stop', {offset: j, 'stop-color': toHex(c)}))));
			paint = `url(#g${i})`;
		} else {
			paint = toHex(fill);
		}
		svg.add(new xml.Element('path', {d: d(curve), fill: paint, stroke: paint, 'stroke-width': 0.8, 'stroke-linejoin': 'round', 'fill-rule': 'evenodd'}));
	});
	if (!defs.children.length)
		svg.remove(defs);
	if (strokes.length)
		svg.add(new xml.Element('g', {fill: 'none', stroke: '#000', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'},
			strokes.map(({curve, width}) => new xml.Element('path', {d: d(curve), 'stroke-width': width}))));
	return svg.toString() + '\n';
}

interface CustomStyle {name: string, image: Pixels<4>, face: string, scale: number};

// whether a picture back from the clipboard is one copied here: the same, but for the colour a PNG loses where a pixel is nearly transparent
function samePicture(kept: Pixels<4>, back: ImageData) {
	if (kept.width !== back.width || kept.height !== back.height)
		return false;
	const a = kept.data, b = back.data;
	for (let i = 0; i < a.length; i += 4) {
		const alpha = a[i + 3];
		if (Math.abs(alpha - b[i + 3]) > 1)
			return false;
		const slack = alpha ? Math.ceil(255 / alpha) + 1 : 255;
		if (Math.abs(a[i] - b[i]) > slack || Math.abs(a[i + 1] - b[i + 1]) > slack || Math.abs(a[i + 2] - b[i + 2]) > slack)
			return false;
	}
	return true;
}


	// a mask (one value a pixel, 0..255, zero beyond its edges) blurred in place, on the GPU, as bytes (which a selection's coverage
	// is, and which can be drawn into where floats cannot); left as it is where there is no GPU
function maskBlur(f: Float32Array, width: number, height: number, sigma: number) {
	const image = Pixels(Uint8ClampedArray.from(f), width, height, 1), {passes, reach} = blurPasses(true, sigma, 'zero');
	const blurred = Mode.shade('blur', image, imageRect(image), passes, reach);
	if (blurred)
		f.set(blurred.data);
}

async function readClipboard(): Promise<{file?: Blob, kept: boolean}> {
	try {
		for (const item of await navigator.clipboard.read()) {
			const type = item.types.find(t => t.startsWith('image/'));
			if (type)
				return {file: await item.getType(type), kept: false};
		}
		return {kept: false};
	} catch {
		return {kept: true};
	}
}

function kernelUniformsReach(kernel: Kernel) {
	return {passes: kernelUniforms(kernel), reach: kernel.size >> 1};
}

const objectMap = <const K extends string, V, const T>(o: Record<K, V>, fn: (k: K, v: V) => T) => Object.entries(o).map(([k, v]) => fn(k as K, v as V));

export class Painter {
	private tool:		Tool	= 'hand';
	private fg			= RGBA(0, 0, 0, 255);
	private bg			= RGBA(255, 255, 255, 255);

	// the tools' settings, each the menu item that sets it, which holds it (state.value)
	private size = valueItemPersist({
		label: 'size', caption: 'Size', min: 1, max: 200, value: 10,
		set: () => this.draw(),
		step: multiplicativeStep(), presets: [1, 2, 5, 10, 20, 50, 100, 200],
	});
	private hardness = sliderItemPersist({
		label: 'hard', caption: 'Hardness', min: 0, max: 100, value: 80,
		step: (v, steps) => v + 5 * steps, markers: [0, 25, 50, 75, 100],
	});
	private opacity = sliderItemPersist({
		label: 'opacity', caption: 'Opacity', min: 1, max: 100, value: 100,
		step: (v, steps) => v + 5 * steps, markers: [10, 25, 50, 75, 100],
	});
	private tolerance = valueItemPersist({
		label: 'tol', caption: 'Tolerance', min: 0, max: 255, value: 32,
		step: (v, steps) => v + 4 * steps, presets: [0, 8, 16, 32, 64, 128],
	});

	private contiguous = toggleItemPersist('Contiguous', svgFace(menuIcons.contiguous), true);

	private shapeFill = choiceItemPersist({caption: 'Shape'}, [
		{value: 'fill' as const,	face: svgFace(menuIcons.filled),	caption: 'Filled'},
		{value: 'stroke' as const,	face: svgFace(menuIcons.outline),	caption: 'Outline'},
		{value: 'both' as const,	face: svgFace(menuIcons.both),		caption: 'Filled and outlined'},
	]);

	private selectMode = choiceItemPersist({caption: 'Selection'}, [
		{value: 'replace' as const,		face: svgFace(menuIcons.selectNew),	caption: 'New selection'},
		{value: 'add' as const,			face: svgFace(menuIcons.selectAdd),	caption: 'Add to selection (Shift)'},
		{value: 'subtract' as const,	face: svgFace(menuIcons.selectSub),	caption: 'Subtract from selection (Alt)'},
		{value: 'intersect' as const,	face: svgFace(menuIcons.selectInt),	caption: 'Intersect with selection (Shift+Alt)'},
	]);


	// how far each of the selection's modifiers goes, in pixels: changed, what it would do is shown
	private modifyBy = Object.fromEntries(objectMap({growSelection: 4, shrinkSelection: 4, borderSelection: 4, smoothSelection: 4, featherSelection: 8} as Record<Modifier, number>,
		(name, value) => [name, valueItemPersist({
			main: {
				id:			name,
				face:		() => svgFace(menuIcons[name]),
				caption:	() => `${menuLabels[name]} by ${this.modifyBy[name].state.value} px (scroll or drag to change)`,
				select:		() => { this.previewModifier(undefined); return this.run(name); },
			},
			label: 'px', caption: `${menuLabels[name]} by`, min: 1, max: 200, value,
			preview: v => this.previewModifier(v === undefined ? undefined : name, v),
			step: multiplicativeStep(), presets: [1, 2, 4, 8, 16, 32, 64, 128],
		})])) as Record<Modifier, ReturnType<typeof valueItemPersist>>;
	// how much darker, in levels, than what is round it a pixel must be to be inked
	private inkContrast = valueItemPersist({
		main: {
			id:			'ink',
			face:		() => svgFace(menuIcons.ink),
			caption:	() => `Ink lines where pixels are ${this.inkContrast.state.value} levels darker than round them (scroll or drag to change; lower finds more lines)`,
			select:		() => this.run('ink'),
		},
		children:	n => ({
			caption:	() => `Ink lines at ${n} levels`,
		}),
		label: 'ink', caption: 'Ink lines: how much darker than its surroundings a pixel must be', min: 2, max: 60, value: 10,
		preview: v => v === undefined ? this.endEffect() : this.previewEffect(`ink:${v}`, crop => inkWith(shadeWith('ink'), crop, v)),
		step: multiplicativeStep(), presets: [4, 8, 12, 20, 32],
	});
	// how far, in levels, the colours of a gradient region may stray from its gradient
	private gradientTolerance = valueItemPersist({
		main: {
			id:			'gradients',
			face:		() => svgFace(menuIcons.gradients),
			caption:	() => `Gradients: smooth regions each with a linear gradient, within ${this.gradientTolerance.state.value} levels (scroll or drag to change)`,
			select:		() => this.run('gradients'),
		},
		children:	n => ({
			caption:	() => `Gradient regions within ${n} levels`,
		}),
		label: 'tol', caption: 'Gradient regions: how far colours may stray from a gradient', min: 2, max: 60, value: 12,
		preview: v => v === undefined ? this.endEffect() : this.previewEffect(`gradients:${v}`, crop => this.gradients(crop, v)),
		step: multiplicativeStep(), presets: [4, 8, 12, 20, 32],
	});
	private traceKind = choiceItemPersist({
		caption: 'Trace to SVG',
	}, [
		{value: 'shapes' as const,	face: svgFace(menuIcons.gradients),	caption: `Shapes with linear gradients, within ${this.gradientTolerance.state.value} levels`},
		{value: 'lines' as const,	face: svgFace(menuIcons.ink),		caption: `Ink lines as strokes, at ${this.inkContrast.state.value} levels`},
		{value: 'both' as const,	face: svgFace(menuIcons.trace),		caption: 'Shapes with ink lines over them'},
	]);

	private styleChoice: Style = 'mosaic';	// the style the strength is shown on
	// styles taken from pictures (a file, or a layer): each with how big its marks are, as a percentage of the picture's size that the style
	// picture is taken at
	private customStyles: CustomStyle[] = [];
	// what was copied last, as it was, and where it was on the picture; whether the clipboard was given it too
	private clip:		{pixels: Pixels<4>, left: number, top: number, shared: boolean} | undefined;
	
	private effects:	{image: Pixels<4>, region: string, crop: Pixels<4>, made: Map<string, Promise<Pixels<4> | undefined>>} | undefined;	// what neural and slow filters made of the region they were last shown on, to show at other strengths (being made, as well as made, so that none is made twice)
	private effectToken = 0;		// which showing of one is the latest asked for
	private applying = 0;			// the effects being made to apply (a preview is not shown meanwhile, and the pointer going from the item does not stop them)
	// the colours Flatten leaves
	private flatColours = valueItemPersist({
		main: {
			id:			'flatten',
			face:		() => svgFace(menuIcons.flatten),
			caption:	() => `Flatten to ${this.flatColours.state.value} colours, which makes simple vector shapes (scroll or drag to change)`,
			select:		() => this.run('flatten'),
		},
		children:	n => ({
			caption:	() => `Flatten to ${n} colours`,
		}),
		label: 'colours', caption: 'Colours to flatten to', min: 2, max: 64, value: 8,
		preview: v => v === undefined ? this.endEffect() : this.previewEffect(`flatten:${v}`, crop => working('Flattening', () => flattenWith(shadeWith('flatten'), crop, v))),
		step: multiplicativeStep(), presets: [3, 4, 6, 8, 12, 16, 24],
	});
	// the gaussian blur of the filter, in pixels
	private blurRadius = valueItemPersist({
		main: {
			id:			'blur',
			face:		() => svgFace(menuIcons.blur),
			caption:	() => `Gaussian blur of ${this.blurRadius.state.value} px (scroll or drag to change)`,
			select:		() => this.run('blur'),
		},
		label: 'px', caption: 'Blur radius', min: 1, max: 100, value: 4,
		preview: v => v === undefined ? this.previewFilter(undefined) : this.previewFilter({program: 'blur', ...blurPasses(false, v, 'clamp', 0)}),
		step: multiplicativeStep(), presets: [1, 2, 4, 8, 16, 32, 64],
	});
	private sharpenRadius = valueItemPersist({
		main: {
			id:			'sharpen',
			face:		() => svgFace(menuIcons.sharpen),
			caption:	() => `Sharpen with a radius of ${this.sharpenRadius.state.value} px (scroll or drag to change)`,
			select:		() => this.run('sharpen'),
		},
		label: 'px', caption: 'Sharpen radius', min: 1, max: 100, value: 2,
		preview: v => v === undefined ? this.previewFilter(undefined) : this.previewFilter({program: 'blur', ...blurPasses(false, v, 'clamp', 1)}),
		step: multiplicativeStep(), presets: [1, 2, 4, 8, 16, 32, 64],
	});
	// the box blur filter's side, in pixels
	private boxSize = valueItemPersist({
		main: {
			id:			'boxBlur',
			face:		() => svgFace(menuIcons.boxBlur),
			caption:	() => `Box blur ${this.boxSize.state.value} px wide (scroll or drag to change)`,
			select:		() => this.run('boxBlur'),
		},
		label: 'box', caption: 'Box blur size', min: 3, max: 7, value: 3,
		preview: v => v === undefined ? this.previewFilter(undefined) : this.previewFilter({program: 'convolve', ...kernelUniformsReach(boxKernel(v))}),
		step: (v, n) => Math.min(7, Math.max(3, v + 2 * Math.sign(n))), presets: [3, 5, 7], resolution: 2,
	});
	// the blur the sharpen filter's unsharp mask is taken against, in pixels
	private levels:	Levels = {black: 0, white: 255, gamma: 1};	// the levels filter's settings

	// the clone stamp keeps its offset from one stroke to the next (or starts each from its source)
	private aligned = {...toggleItemPersist('Aligned', svgFace(menuIcons.aligned), true, () => {
		if (this.stamp)
			this.stamp.offset = undefined;
		this.draw();
	}), id: 'aligned'};
	// what the clone stamp copies: the layer it was pointed at on, or all the picture shows
	private sample = {...choiceItemPersist({caption: 'Sample'}, [
		{value: 'oneLayer' as const,	face: svgFace(menuIcons.oneLayer),	caption: 'The layer Alt-clicked on'},
		{value: 'allLayers' as const,	face: svgFace(menuIcons.allLayers),	caption: 'All layers'},
	]), id: 'sample'};
	// where the clone stamp copies from, and the point Alt-clicked on the picture (where its cross is drawn)
	private stamp:		(CloneSource & {shown: float2}) | undefined;

	private selected:	Selection | undefined;


	private previewFrame: 		number | undefined;		// the frame at which a filter's preview is to be shown
	private previewGPU:			ShadePreview | undefined;	// a filter being shown by the GPU
	private previewOp:			OperationReplace | undefined;			// the filter being previewed, which is not yet an edit
	private previewSelection:	Selection | undefined;			// what the selection would become under the modifier the pointer is on

	private draft:		float2[] | undefined;			// the outline of a selection being drawn, in image coordinates
	private corners:	{points: float2[], selMode: SelectMode} | undefined;	// a polygonal lasso under way
	private pointer:	float2 | undefined;			// where the pointer is over the picture, while it is the tools'

	private active		= false;
	grid				= false;		// whether the pixel grid is shown over the picture, which it is under a shape layer's editor as well
	private suspended	= false;		// another editor has the picture (a shape layer's, which edits its path), or the 3D view does
	private aside		= false;		// a transform has the pointer
	private readonly stack: Input;

	private ctx:		CanvasRenderingContext2D;
	private lastOfGroup	= new Map<Tool[], Tool>();
	private colourInput	= createElement('input');	// the system's colour picker, for the colour being chosen
	private picking:	'fg' | 'bg' = 'fg';

	// (the menu is the page's: these are some of what is in it)
	constructor(public host: PaintHost, private overlay: HTMLCanvasElement, private readonly history: History, private readonly menu: Cascade) {
		this.ctx = overlay.getContext('2d')!;
		const stage = overlay.parentElement!;

		// out of sight, but where the menu is, which is where the picker comes up
		this.colourInput.type = 'color';
		Object.assign(this.colourInput.style, {position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none'});
		this.colourInput.addEventListener('input', () => {
			this.setColour(this.picking, {...fromHex(this.colourInput.value), a: 255});
			this.menu.refresh();
		});
		stage.append(this.colourInput);

		// (the pointer is theirs while nothing over them shows a cursor of its own: Space, a transform's box)
		this.stack = Input.on(host.canvas);
		this.stack.add({
			press:		e => this.press(e),
			hover:		e => this.hover(e),
			leave:		() => {
				this.pointer = undefined;
				this.draw();
			},
			key:		e => this.keyDown(e),
			covered:	by => this.covered(by),
		}, Place.tools);

		// the clipboard: Cmd/Ctrl C, X and V, which come as the document's copy, cut and paste (VS Code gives a webview them so), unless
		// they are a field's
		const clipboard = (e: ClipboardEvent, act: () => boolean) => {
			if (!typing(e.target) && this.active && !this.suspended && !this.aside && act()) {
				e.preventDefault();
				e.stopPropagation();	// (the web page's own paste opens a file)
			}
		};
		document.addEventListener('copy',	e => clipboard(e, () => this.copy()));
		document.addEventListener('cut',	e => clipboard(e, () => this.cut()));
		document.addEventListener('paste',	e => clipboard(e, () => {
			if (!this.host.addLayers || !this.host.target())
				return false;
			this.paste(Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/')));
			return true;
		}));

		this.setTool('hand');
	}

	//-------------------------------------------------------------------------
	// the clipboard
	//-------------------------------------------------------------------------

	// What is selected of what the tools draw on (all of it, without a selection), cut to the selection's box, and where that is
	private selectedPixels() {
		const image = this.host.target(), s = this.selection;
		if (!image || !(image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array))
			return undefined;
		const box = s ? s.bounds().intersect(imageRect(image)) : imageRect(image);
		if (box.empty())
			return undefined;
		const data = readRect(image, box), {x: left, y: top} = box.min, {x: w, y: h} = box.size();
		if (s) {
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++)
					data[(y * w + x) * 4 + 3] = Math.round(data[(y * w + x) * 4 + 3] * s.at(left + x, top + y) / 255);
		}
		return {pixels: Pixels<4>(data, w, h), left, top};
	}

	// The selected pixels to the clipboard, as a PNG; and kept here as they are (a PNG through the clipboard loses a little of the colour of
	// pixels that are nearly transparent) with where they were. Whether there was anything to copy.
	private copy() {
		const selected = this.selectedPixels();
		if (!selected)
			return false;
		const clip = {...selected, shared: true as boolean};
		this.clip = clip;
		const {data, width, height} = selected.pixels;
		const canvas = new OffscreenCanvas(width, height);
		canvas.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
		const write = navigator.clipboard?.write([new ClipboardItem({'image/png': canvas.convertToBlob({type: 'image/png'})})]);
		if (write)
			write.catch(() => clip.shared = false);
		else
			clip.shared = false;
		return true;
	}

	private cut() {
		if (!this.copy())
			return false;
		this.clearSelection('Cut');
		return true;
	}

	// What a paste gives: a picture from the clipboard, where it was if it is what was copied here, otherwise in the middle of a picture this
	// size. Without a picture from the clipboard, what was copied here if the clipboard could not be given it (or `kept`, as when the
	// clipboard cannot be read).
	private async pasted(file: Blob | undefined, kept: boolean, size: {width: number, height: number}) {
		const clip = this.clip;
		if (!file)
			return clip && (!clip.shared || kept) ? clip : undefined;
		let pixels: ImageData;
		try {
			pixels = bitmapToImage(await createImageBitmap(file));
		} catch {
			return undefined;		// (not a picture the browser reads)
		}
		return clip && samePicture(clip.pixels, pixels) ? clip
			: {pixels: Pixels<4>(pixels.data, pixels.width, pixels.height), left: Math.round((size.width - pixels.width) / 2), top: Math.round((size.height - pixels.height) / 2)};
	}

	// the picture on the clipboard as a new layer
	private async paste(file: Blob | undefined, kept = false) {
		const image = this.host.target();
		const p = image && this.host.addLayers && await this.pasted(file, kept, image);
		if (p)
			await this.host.addLayers!([{kind: 'image', name: 'Pasted', left: p.left, top: p.top, opacity: 1, visible: true, blend: 'norm', image: Pixels<4>(new Uint8ClampedArray(p.pixels.data), p.pixels.width, p.pixels.height)}], 'Paste');
	}

	//-------------------------------------------------------------------------
	// state
	//-------------------------------------------------------------------------

	// whether there is anything to edit: the tools come up only then
	enabled(on: boolean) {
		this.active = on;
		this.overlay.classList.toggle('hidden', !on);
		if (!on)
			this.menu.close();
		this.updateCursor();
	}

	// the pointer over the picture: where the brush is drawn, and the tool's cursor
	private hover(e: PointerEvent) {
		if (!this.active)
			return undefined;
		this.pointer = this.host.toImage(e.clientX, e.clientY);
		this.draw();
		return this.suspended || this.aside ? undefined : cursorFor(this.tool);
	}

	// Something over the tools has the picture for now (or has given it back). A transform: the tools take no presses and no keys, and what
	// they draw over the picture is put away but the grid. Another editor (a shape layer's), or the 3D view: the tools are put away and take
	// no keys, and none of their operations are done.
	private covered(by: number | undefined) {
		const aside = by === Place.transform, suspended = by !== undefined && !aside;
		if (aside !== this.aside) {
			this.aside		= aside;
			this.corners	= undefined;
		}
		if (suspended !== this.suspended) {
			this.suspended = suspended;
			if (suspended)
				this.menu.close();
			this.menu.refresh();
		}
		this.draw();
	}

	// what is selected, which a transform carries
	get selection() {
		return this.selected;
	}
	set selection(s: Selection | undefined) {
		this.selected = s;
		this.draw();
	}

	// a new image: nothing selected
	reset() {
		this.selected	= undefined;
		this.draft		= this.corners = undefined;
		this.stamp		= undefined;
	}

	resize() {
		this.overlay.width	= this.host.canvas.width;
		this.overlay.height	= this.host.canvas.height;
	}

	setTool(tool: Tool) {
		this.tool		= tool;
		this.corners	= undefined;
		const group		= toolGroups.find(g => g.includes(tool));
		if (group)
			this.lastOfGroup.set(group, tool);
		this.updateCursor();
		this.draw();
		this.menu.refresh();
	}

	//-------------------------------------------------------------------------
	// the menu
	//-------------------------------------------------------------------------

	// the tools, for the menu (none while they are put away)
	menuItems(): CascadeItem[] {
		if (!this.active || this.suspended || this.aside)
			return [];
		// levels: the black point, white point and gamma, each shown on the picture while it is pointed at, and the icon applies them
		const levelValue = (label: string, caption: string, min: number, max: number, get: () => number, set: (v: number) => void, o: Partial<ValueOptions> = {}) =>
			sliderItem({label, caption, min, max, markers: 5, get, set, preview: v => this.previewFilter({program: 'levels', passes: levelsUniforms(this.levels), reach: 0}), ...o});
		const levelsItem: CascadeItem = {
			id:			'levels',
			face:		() => svgFace(menuIcons.levels),
			caption:	() => `Levels ${this.levels.black}, ${this.levels.gamma.toFixed(2)}, ${this.levels.white}: click to apply`,
			select:		() => { this.previewFilter(); return this.run('levels'); },
			children:	() => [
				levelValue('black', 'Black point', 0, 254, () => this.levels.black, v => this.levels.black = Math.min(v, this.levels.white - 1)),
				levelValue('γ', 'Gamma', 0.1, 9.99, () => this.levels.gamma, v => this.levels.gamma = v,
					{step: (v, n) => Math.round(Math.max(0.1, v * 1.05 ** n) * 100) / 100, resolution: 0, format: v => v.toFixed(2)}),
				levelValue('white', 'White point', 1, 255, () => this.levels.white, v => this.levels.white = Math.max(v, this.levels.black + 1)),
				{face: () => svgFace(menuIcons.reset), caption: () => 'Reset levels', select: () => { this.levels = {black: 0, white: 255, gamma: 1}; return true; }},
			],
		};
		// the convolution filters (box blur, by the side of the box, is this.boxSize), emboss and edge detect, which take nothing
		const convolution = (kind: 'emboss' | 'edges', icon: string, caption: string): CascadeItem => ({
			id:			kind,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => this.run(kind),
			hover:		on => this.previewFilter(on ? {program: 'convolve', ...kernelUniformsReach(kind === 'edges' ? edgeKernel : embossKernel)} : undefined),
		});
		// styles: a painting's manner given to the picture by a neural network, as much as the strength says; and Flatten, which reduces it to a
		// few flat colours so that it makes simple vector shapes

		const scalePresets = [25, 50, 100, 200];
		const showCustom = (c: CustomStyle, id: string, scale = c.scale) => this.previewEffect(`${id}:${scale}`, crop => styleFrom(crop, c.image, scale / 100));
		let strength = 100;
		const styleItem: CascadeItem = {
			id:			'style',
			face:		() => svgFace(menuIcons.style),
			caption:	() => `Style: ${this.styleChoice} (click to apply; the first use fetches a neural network, and takes a moment)`,
			select:		() => this.run(`style:${this.styleChoice}`),
			// each style is its own strength control: scrolled over or dragged along its presets it takes the strength, clicked it applies
			children:	() => objectMap(styles, (name, label): CascadeItem => sliderItem({
				main: {
					id:			`style:${name}`,
					face:		() => imgFace(`assets/${name}.png`),
					select:		() => { this.styleChoice = name; return this.run(`style:${name}`); },
				},
				label: name, caption: `${name} strength`, min: 0, max: 100,
				get:	() => strength, set: v => { strength = v; },
				preview: v => {
					if (v === undefined) {
						this.endEffect();
					} else {
						this.styleChoice = name; 
						this.previewEffect(`style:${name}`, crop => stylise(crop, name), strength / 100);
					}
				},
				step: (v, n) => Math.min(100, Math.max(0, v + 5 * n)), markers: 5,
			})).concat(
				// the styles taken from pictures, each of which the wheel makes finer or bolder, and then where more can come from
				this.customStyles.map((c, index): CascadeItem => {
					const id = `custom:${index}`;
					return valueItem({
						main: {
							id,
							face:		() => c.face,
							caption:	() => `${c.name}: a style from that picture, its marks as big as they are at ${c.scale}% of this one's size (scroll or drag for finer or bolder, click to apply)`,
							select:		() => this.run(id),
						},
						children:	(n) => ({
							id:			`${n}%`,
							face:		() => valueFace('', `${n}%`),
							caption:	() => `${c.name} with its marks as big as at ${n}% (${n < 100 ? 'finer' : n > 100 ? 'bolder' : 'as it is'})`,
						}),
						label:	'%',
						caption: `${c.name}: its marks as big as at`,
						min:	10, max: 400,
						get:	() => c.scale, set: v => { c.scale = v; },
						preview: v => v === undefined ? this.endEffect() : showCustom(c, id, v),
						step:	multiplicativeStep(), presets: scalePresets,
					});
				}),
				{
					id:			'addStyle',
					face:		() => svgFace(menuIcons.styleAdd),
					caption:	() => 'Custom style: take a style from the picture on the clipboard (copy a layer, or a picture opened here, to put it there; the first use fetches a neural network, and takes a moment)',
					select:		() => this.run('addStyle'),
				},
			),
		};
		
		// tracing, to a file or to layers, as one of its kinds, which is kept for the next
		const traceItem = (id: string, icon: string, label: string, where: string): CascadeItem => ({
			...this.traceKind,
			id,
			face:		() => svgFace(icon),
			//caption:	() => `${label}: the picture (or selection) as ${traceKinds.find(k => k.value === this.traceKind)!.caption.toLowerCase()}, ${where}`,
			select:		() => this.run(id)
		});
		// all the filters, under one icon
		const filters: CascadeItem = {
			id:			'filters',
			face:		() => svgFace(menuIcons.filters),
			caption:	() => 'Filters',
			children:	() => [
				// blur and sharpen: clicked they apply, scrolled over (or dragged along their presets) they take the radius, a preset chosen
				// applies at it, and what each would do is shown while it is pointed at
				this.blurRadius,
				this.sharpenRadius,
				levelsItem,
				this.boxSize,
				convolution('emboss', menuIcons.emboss, 'Emboss'),
				convolution('edges', menuIcons.edges, 'Detect edges'),
				styleItem,
				this.flatColours,
				this.gradientTolerance,
				this.inkContrast,
				traceItem('traceSvg', menuIcons.trace, 'Trace to SVG', 'saved as an SVG file'),
				traceItem('traceLayers', menuIcons.traceLayers, 'Trace to layers', 'as shape layers above it'),
				{
					id:			'removeObject',
					face:		() => svgFace(menuIcons.removeObject),
					caption:	() => 'Remove Object: fills the selection from what is round it (the first use fetches a neural network, and takes a moment)',
					select:		() => this.run('removeObject'),
				},
			],
		};
		const {tolerance, size, hardness, opacity, contiguous, selectMode, shapeFill} = this;
		const options: Partial<Record<Tool, CascadeItem[]>> = {
			marquee:			[selectMode],
			'ellipse-marquee':	[selectMode],
			lasso:				[selectMode],
			'polygon-lasso':	[selectMode],
			wand:				[tolerance, contiguous, selectMode],
			segment:			[selectMode],
			brush:				[size, hardness, opacity],
			pencil:				[size, opacity],
			eraser:				[size, hardness, opacity],
			stamp:				[size, hardness, opacity, this.aligned, this.sample],
			bucket:				[tolerance, contiguous, opacity],
			gradient:			[opacity],
			line:				[size, opacity],
			rect:				[shapeFill, size, opacity],
			ellipse:			[shapeFill, size, opacity],
		};
		const tool = (t: Tool): CascadeItem => {
			const info = toolInfo[t];
			return {
				id:			t,
				face:		() => svgFace(info.icon),
				caption:	() => info.label + (info.key ? ` (${info.key.toUpperCase()})` : '') + (info.hint ? `: ${info.hint}` : ''),
				active:		() => this.tool === t,
				select:		() => this.setTool(t),
				children:	options[t] && (() => options[t]!),
			};
		};
		// a place for a group of tools, showing the one last used; a click takes that one
		const group = (tools: Tool[], caption: string, extra: CascadeItem[] = []): CascadeItem => {
			const shown = () => this.lastOfGroup.get(tools) ?? tools[0];
			return {
				id:			caption.toLowerCase(),
				face:		() => svgFace(toolInfo[shown()].icon),
				caption:	() => caption,
				active:		() => tools.includes(this.tool),
				select:		() => this.setTool(shown()),
				children:	() => [...tools.map(tool), ...extra],
			};
		};
		const op = (o: string, icon: string, caption: string): CascadeItem => ({
			id:			o,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => this.run(o),
		});
		const colour = (which: 'fg' | 'bg', caption: string): CascadeItem => ({
			id:			which,
			face:		() => swatchFace(toHex(this[which])),
			caption:	() => `${caption} ${toHex(this[which])}`,
			children:	() => [
				...colourItems(which, () => this[which], c => this.setColour(which, {...c, a: 255}), () => true, []),
				{
					face:		() => svgFace(menuIcons.picker),
					caption:	() => 'Choose with the system colour picker',
					select:		() => {
						this.picking = which;
						this.colourInput.value = toHex(this[which]);
						this.colourInput.showPicker?.() ?? this.colourInput.click();
						return true;
					},
				},
			],
		});

		const [select, paint, fill, shapes] = toolGroups;
		return [
			tool('hand'),
			group(select, 'Select', [
				op('selectAll', menuIcons.selectAll, 'Select All (⌘A)'),
				op('deselect', menuIcons.deselect, 'Deselect (⌘D)'),
				op('invertSelection', menuIcons.invertSelection, 'Invert Selection (⇧⌘I)'),
				op('copy', menuIcons.copy, 'Copy (⌘C): what is selected (or all the layer), to the clipboard'),
				op('cut', menuIcons.cut, 'Cut (⌘X): what is selected (or all the layer), to the clipboard, and cleared'),
				...this.host.addLayers ? [op('paste', menuIcons.paste, 'Paste (⌘V): the picture on the clipboard as a new layer')] : [],

				// a selection modifier: clicked it applies, and scrolled over (or dragged along its presets) it changes by how much
				...Object.values(this.modifyBy),
			]),
			group(paint, 'Paint'),
			group(fill, 'Fill'),
			group(shapes, 'Shapes'),
			filters,
			tool('eyedropper'),
			{
				id:			'colours',
				face:		() => swatchFace(toHex(this.fg), toHex(this.bg)),
				caption:	() => 'Colours',
				children:	() => [
					colour('fg', 'Foreground'),
					colour('bg', 'Background'),
					{face: () => svgFace(menuIcons.swap), caption: () => 'Swap colours (X)', select: () => { this.swapColours(); return true; }},
					{face: () => swatchFace('#000', '#fff'), caption: () => 'Black and white (D)', select: () => { this.defaultColours(); return true; }},
				],
			},
		];
	}

	private updateCursor() {
		this.stack.refresh();
	}

	// one of the whole-image operations (whether it is one of the tools': the others are not done)
	run(op: string): boolean {
		const image = this.host.target(), selection = this.selection;
		if (!this.active || !image || this.suspended || this.aside)
			return false;

		switch (op) {
			case 'fill':				return this.fillSelection(this.fg, 'Fill'), true;
			case 'clear':				return this.clearSelection(), true;
			case 'invert': {
				const op = new OperationComputed(image, selection, (x, y) => {
					const col = loadRGBA(image.data, (y * image.width + x) * 4);
					return RGBA(255 - col.r, 255 - col.g, 255 - col.b, col.a);
				});
				op.fill();
				this.flush(op);
				this.commit(op, 'Invert');
				return true;
			}


			case 'blur':				this.filter('Blur', {program: 'blur', ...blurPasses(false, this.blurRadius.state.value, 'clamp', 0)}); return true;
			case 'sharpen':				this.filter('Sharpen', {program: 'blur', ...blurPasses(false, this.sharpenRadius.state.value, 'clamp', 1)}); return true;
			case 'levels':				this.filter('Levels', {program: 'levels', passes: levelsUniforms(this.levels), reach: 0}); return true;
			case 'boxBlur':				this.filter('Box Blur', {program: 'convolve', ...kernelUniformsReach(boxKernel(this.boxSize.state.value))}); return true;
			case 'emboss':				this.filter('Emboss', {program: 'convolve', ...kernelUniformsReach(embossKernel)});	return true;
			case 'edges':				this.filter('Detect Edges', {program: 'convolve', ...kernelUniformsReach(edgeKernel)});	return true;

			case 'addStyle':	// the picture on the clipboard taken as a style
				readClipboard().then(async ({file, kept}) => {
					const p = await this.pasted(file, kept, image);
					if (p)
						this.addStyle('Clipboard', Pixels<4>(new Uint8ClampedArray(p.pixels.data), p.pixels.width, p.pixels.height));
					else
						postMessage({command: 'error', message: 'There is no picture on the clipboard to take a style from.'});
				});
				return true;
	
			case 'removeObject':	// fill the selection with what the picture round it suggests (by a neural network, so after a moment)
				if (selection) {
					removeObject(image, selection).then(found => {
						if (!found)
							return;
						const op = new OperationReplace(image, selection, found.pixels);
						op.fill(found.area);
						this.flush(op);
						this.commit(op, 'Remove Object');
					});
				}
				return true;
	
			case 'copy':				return this.copy();
			case 'cut':					return this.cut();
			case 'paste':				return readClipboard().then(({file, kept}) => this.paste(file, kept)), true;
			case 'traceSvg':			return this.traceSvg(), true;
			case 'traceLayers':			return this.traceLayers(), true;
			
			case 'selectAll':			return this.select(Selection.all(imageSize(image)), 'Select All'), true;
			case 'deselect':			return this.select(undefined, 'Deselect'), true;
			case 'invertSelection':		return this.select(selection ? selection.invert(imageSize(image)) : Selection.all(imageSize(image)), 'Invert Selection'), true;
			case 'growSelection':
			case 'shrinkSelection':
			case 'borderSelection':
			case 'smoothSelection':
			case 'featherSelection':	return !!selection && (this.select(this.modified(op, this.modifyBy[op].state.value), op.replace('Selection', ' Selection').replace(/^./, c => c.toUpperCase())), true);

			case 'flatten':				return this.applyEffect('Flatten', `flatten:${this.flatColours.get()}`, crop => working('Flattening', () => flattenWith(shadeWith('flatten'), crop, this.flatColours.get()))), true;
			case 'gradients':			return this.applyEffect('Gradients', `gradients:${this.gradientTolerance.state.value}`, crop => this.gradients(crop, this.gradientTolerance.state.value)), true;
			case 'ink':					return this.applyEffect('Ink', `ink:${this.inkContrast.state.value}`, crop => inkWith(shadeWith('ink'), crop, this.inkContrast.state.value)), true;

			default:
				if (op.startsWith('custom:')) {
					const c = this.customStyles[Number(op.slice(7))];//.find(c => `custom:${c.id}` === op);
					return !!c && (this.applyEffect('Style', `${op}:${c.scale}`, crop => styleFrom(crop, c.image, c.scale / 100)), true);
				}
				if (op.startsWith('style:')) {
					const style = op.slice(6) as Style;
					return this.applyEffect('Style', `style:${style}`, crop => stylise(crop, style), 1), true;
				}
				return false;
		}
	}

	// the selection as a modifier, of so many pixels, would leave it
	private modified(op: Modifier, n: number) {
		const sel = this.selection!, size = imageSize(this.host.target()!);
		switch (op) {
			case 'growSelection':	return sel.growClamp(n, size);
			case 'shrinkSelection':	return sel.growClamp(-n, size);
			case 'borderSelection':	return sel.border(n, size);
			case 'smoothSelection':	return sel.smooth(n, size, maskBlur);
			default:				return sel.feather(n, size, maskBlur);
		}
	}

	// show what a modifier would do, with the amount it has (or one that is being considered); nothing stops it
	private previewModifier(op: Modifier | undefined, amount?: number) {
		this.previewSelection = op && this.active && this.selection && this.host.target() ? this.modified(op, amount ?? this.modifyBy[op].state.value) : undefined;
		this.draw();
	}

	// the selection becomes this, which is an undoable edit (as in Photoshop) unless nothing changes
	select(s: Selection | undefined, label = 'Select') {
		const before = this.selection;
		this.draft = this.corners = this.previewSelection = undefined;
		if (s === before) {
			this.draw();
			return;
		}
		const set = (v: Selection | undefined) => () => {
			this.selected = v;
			this.draft = this.corners = this.previewSelection = undefined;
			this.draw();
		};
		set(s)();
		this.push({undo: set(before), redo: set(s)}, label);
	}

	// The selection a new shape makes, joined to the one there is as the modifier keys (or else the menu) say.
	// The shape is a selection already, or undefined for nothing: a click that selects nothing deselects.
	private join(shape: Selection | undefined, mode: SelectMode) {
		this.select(Selection.combine(this.selection, shape, mode));
	}

	// Select the inside of a closed curve (curveVertex[] as binary_fonts has them), however it is bent
	//selectCurve(curve: Parameters<typeof Selection.curve>[0], mode: SelectMode = 'replace') {
	//	const image = this.host.target();
	//	if (image)
	//		this.join(Selection.curve(curve, imageSize(image)), mode);
	//}

	private swapColours() {
		[this.fg, this.bg] = [this.bg, this.fg];
		this.menu.refresh();
	}

	private defaultColours() {
		this.fg = RGBA(0, 0, 0, 255);
		this.bg = RGBA(255, 255, 255, 255);
		this.menu.refresh();
	}

	private setColour(which: 'fg' | 'bg', colour: RGBA) {
		this[which] = colour;
		this.menu.refresh();
	}

	private push(entry: HistoryEntry, label: string) {
		this.history.push(entry, label);
	}

	// finish operations (of one edit, which may reach more than one image): if they changed anything, that is an edit.
	// A patch is of the image it was made on, which may not be the one being drawn on when it is undone
	private commitAll(ops: Iterable<Operation>, label: string) {
		const made: {image: Pixels<4>, patch: Patch<PixelStorage>}[] = [];
		for (const op of ops) {
			const patch = op.commit();
			if (patch)
				made.push({image: op.image, patch});
		}
		const apply = (which: 'before' | 'after') => () => {
			for (const {image, patch} of made)
				this.host.changed(image, applyPatch(image, patch, which));
		};
		if (made.length)
			this.push({undo: apply('before'), redo: apply('after')}, label);
	}

	private commit(op: Operation, label: string) {
		const patch = op.commit();
		if (patch) {
			this.push({
				undo: () => this.host.changed(op.image, applyPatch(op.image, patch, 'before')),
				redo: () => this.host.changed(op.image, applyPatch(op.image, patch, 'after'))
			}, label);
		}
	}

	private flush(op: Operation) {
		const r = op.take();
		if (r)
			this.host.changed(op.image, r);
	}

	//-------------------------------------------------------------------------
	// whole-image and selection operations
	//-------------------------------------------------------------------------

	private fillSelection(colour: RGBA, label: string) {
		const image = this.host.target();
		if (image) {
			const op		= new OperationPaint(image, this.selection, colour, this.opacity.get() / 100);
			op.fill();
			this.flush(op);
			this.commit(op, label);
		}
	}

	private clearSelection(label = 'Clear') {
		const image = this.host.target();
		if (image) {
			const op	= new OperationErase(image, this.selection);
			op.fill();
			this.flush(op);
			this.commit(op, label);
		}
	}

	// The part of the picture an effect (a style, Flatten) is for: the selection's bounds, or the layer
	private region(): Region | undefined {
		const image = this.host.target();
		if (!image)
			return;
		return new Region(image, this.selection);
	}

	// what an effect makes of the region at full strength, kept (while the same region is being looked at) for the other strengths
	private async effectOf(r: Region, key: string, make: (crop: Pixels<4>) => Pixels<4> | undefined | Promise<Pixels<4> | undefined>) {
		let fx = this.effects;
		if (fx?.image !== r.image || fx.region !== r.id)
			this.effects = fx = {image: r.image, region: r.id, made: new Map(), crop: crop(r.image, r)};
		let made = fx.made.get(key);
		if (!made) {
			const mine = fx;
			fx.made.set(key, made = Promise.resolve(make(fx.crop)).then(full => {
				if (!full)
					mine.made.delete(key);	// (so that it is tried again)
				return full;
			}));
		}
		const full = await made;
		return full && {crop: fx.crop, full};
	}

	// the effect shown on the picture at this strength, by the GPU where it can, which mixes its result with the picture as it is
	// dragged (so showing another or ending it takes it away, as it does a filter's)
	private showEffect(r: Region, made: {crop: Pixels<4>, full: Pixels<4>}, strength: number) {
		if (!this.showOnGPU(() => new OperationReplace(r.image, r), 'mix', {u_other: 3, u_otherAt: [r.min.x, r.min.y], u_strength: strength}, made.full))
			this.effectOperation(r, made, strength);
	}

	// the effect as an unmade edit, with its pixels in the picture (the filter previews' own, as when the GPU cannot show it)
	private effectOperation(r: Region, made: {crop: Pixels<4>, full: Pixels<4>}, strength: number) {
		this.endPreviewGPU();
		const op = this.previewOp;
		if (op) {
			op.reset();
			this.flush(op);
		}
		const next = op ?? new OperationReplace(r.image, r);
		next.from = made.full;
		next.strength = strength;
		next.fill(r);
		this.flush(next);
		this.previewOp = next;
		return next;
	}

	private previewEffect(key: string, make: (crop: Pixels<4>) => Pixels<4> | undefined | Promise<Pixels<4> | undefined>, strength = 1) {
		const token = ++this.effectToken, r = this.region();
		if (!r)
			return;
		this.effectOf(r, key, make).then(made => {
			if (made && !this.applying && token === this.effectToken && this.host.target() === r.image)
				this.showEffect(r, made, strength);
		});
	}

	// the preview taken away (what is asked for after it, in the same moment, is shown in its place)
	private endEffect() {
		++this.effectToken;
		this.showFilter();
	}

	// the effect made an edit of the picture, which is the preview if there is one
	private applyEffect(label: string, key: string, make: (crop: Pixels<4>) => Pixels<4> | undefined | Promise<Pixels<4> | undefined>, strength = 1) {
		const r = this.region();
		if (!r)
			return;
		++this.effectToken;		// (a preview on its way is no longer wanted)
		this.applying++;
		this.effectOf(r, key, make).then(made => {
			// (not if the picture has been changed meanwhile)
			if (!made || this.host.target() !== r.image)
				return;
			this.endPreviewGPU();
			const op = this.effectOperation(r, made, strength);
			this.previewOp = undefined;
			this.effects = undefined;
			this.commit(op, label);
		}).finally(() => this.applying--);
	}

	// the selection, or the whole layer, filtered: the selection's soft edge is how much of the filter a pixel takes
	private filter(label: string, filter: Filter) {
		if (this.previewFrame !== undefined) {
			cancelAnimationFrame(this.previewFrame);
			this.previewFrame = undefined;
		}
		this.endPreviewGPU();		// (the edit is made from the picture's pixels, as the preview left them)
		if (this.previewOp) {
			// as it was previewed, at the settings it was left with
			this.showFilter(filter);
			const op = this.previewOp;
			this.previewOp = undefined;
			this.commit(op, label);
			return;
		}
		const image = this.host.target();
		const op = image && this.filterOperation(new OperationReplace(image, this.selection), filter);
		if (op)
			this.commit(op, label);
	}

	// the picture (or the selection's bounds) traced as gradient regions and ink lines (as traceKind has it), in its pixels
	private async traced(r: Region) {
		const part = crop(r.image, r);
		const kind = this.traceKind.get();
		return working('Tracing', progress => traceWith(part, (runs, closed) => fitRuns(runs, closed, 0.75),
			kind !== 'lines' ? {run: shadeWith('flatten'), tolerance: this.gradientTolerance.state.value} : undefined,
			kind !== 'shapes' ? {run: shadeWith('ink'), contrast: this.inkContrast.state.value} : undefined,
			progress
		));
	}

	// a picture taken as a style, its icon a small copy of it
	private addStyle(name: string, image: Pixels<4>) {
		const scale = 40 / Math.max(image.width, image.height);
		const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
		const full = createElement('canvas', {width: image.width, height: image.height}), small = createElement('canvas', {width: w, height: h});
		full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data as Uint8ClampedArray), image.width, image.height), 0, 0);
		small.getContext('2d')!.drawImage(full, 0, 0, w, h);
		const face = `<img src="${small.toDataURL()}" style="width:100%;height:100%;object-fit:cover;border-radius:2px">`;
		this.customStyles.push({name, image, face, scale: 100});
	}

	// the tracing as an SVG, which the extension opens
	private async traceSvg() {
		const r = this.region(), traced = r && await this.traced(r);
		if (traced)
			postMessage({command: 'saveSvg', text: tracedSvg(traced)});
	}

	// the tracing as shape layers above what it was made from: one for each region (with a thin line of its own paint, which closes the seams
	// where the antialiasing of neighbours meet), and one of the ink lines of each width over them
	private async traceLayers() {
		const host = this.host, r = this.region();
		const traced = r && host.addLayers && await this.traced(r);
		if (!r || !traced)
			return;
		const stack = {width: r.image.width, height: r.image.height};
		const at = (p: {x: number, y: number}) => ({x: p.x + r.min.x, y: p.y + r.min.y});
		const moved = (curve: curveVertex[]) => curve.map(v => curveVertex(v.x + r.min.x, v.y + r.min.y, v.flags));
		const paint = (f: TracedFill): NewPaint => 'stops' in f ? {from: at(f.from), to: at(f.to), stops: f.stops} : f;

		const layers = await working('Making layers', async progress => {
			const made: PixelLayer[] = [];
			for (const [i, s] of traced.shapes.entries()) {
				made.push(newShapeLayer(`Shape ${i + 1}`, moved(s.curve), stack, paint(s.fill), {width: 0.8, paint: paint(s.fill)}));
				if (i % 50 === 49)
					await progress(i / traced.shapes.length);
			}
			const widths = new Map<number, curveVertex[]>();
			for (const s of traced.strokes) {
				const curve = widths.get(s.width) ?? [];
				curve.push(...moved(s.curve));
				widths.set(s.width, curve);
			}
			for (const [width, curve] of [...widths].sort((a, b) => a[0] - b[0]))
				made.push(newShapeLayer(`Ink ${width}px`, curve, stack, undefined, {width, paint: {r: 0, g: 0, b: 0}}));
			return made;
		});
		if (layers.length)
			await host.addLayers!(layers, 'Trace to Layers');
	}

	// a picture reduced to smooth regions with a linear gradient each, the GPU smoothing it first (nothing where there is none)
	private gradients(image: Pixels<4>, tolerance: number) {
		return working('Finding gradients', () => gradientsWith(shadeWith('flatten'), image, tolerance));
	}

	// the operation which has filtered the selection (or layer), if there was anything to filter
	private filterOperation(op: OperationReplace, filter: Filter) {
		const image = op.image;
		const area = op.bounds();
		if (area.empty())
			return;
		const {program, passes, reach} = filter;
		const result = Mode.shade(program, image, area, passes, reach) as Pixels<4> | undefined;	// (a picture's pixels in, so a picture's out)
		if (!result)
			return;		// (no GPU to do it)
		op.from = result;
		op.fill(area);
		this.flush(op);
		return op;
	}

	// Show the filter on the picture without making an edit, or (without one) take it away. A filter of a big picture takes a while,
	// so the showing waits for the next frame, and what is asked for in the meantime (the wheel turning, a value dragged) is
	// only shown as it stands then.
	private previewFilter(filter?: Filter) {
		if (this.previewFrame !== undefined) {
			cancelAnimationFrame(this.previewFrame);
			this.previewFrame = undefined;
		}
		if (!filter || !this.host.target()) {
			this.showFilter();
		} else {
			this.previewFrame = requestAnimationFrame(() => {
				this.previewFrame = undefined;
				this.showFilter(filter);
			});
		}
	}

	// the GPU's showing of a filter taken away, the picture's own pixels shown again
	private endPreviewGPU() {
		this.previewGPU?.end();
		this.previewGPU = undefined;
	}

	// A filter or effect shown by the GPU (and so not as an operation's pixels): in the preview kept while it is of the same image and
	// shader, one made if there is none. False where it cannot be (the caller then has an operation show it).
	private showOnGPU(operation: () => Operation, program: string, passes: ShadePass[] | Record<string, any>, other?: Pixels<4>) {
		const image = this.host.target();
		if (this.previewGPU && (this.previewGPU.image !== image || this.previewGPU.program !== program))
			this.endPreviewGPU();
		if (this.previewOp) {
			this.previewOp.reset();
			this.flush(this.previewOp);
			this.previewOp = undefined;
		}
		if (!this.previewGPU) {
			const op = operation();
			this.previewGPU = op.bounds().empty() ? undefined : previewShade(this.host, op, program);
		}
		this.previewGPU?.show(passes, other);
		return !!this.previewGPU;
	}

	// the preview as it is asked for, at once
	private showFilter(filter?: Filter) {
		const image = this.host.target();
		if (!image)
			return;
		// (the GPU shows the filter as it draws the picture, with nothing worked out until it is made an edit)
		if (filter && this.showOnGPU(() => new OperationReplace(image, this.selection), filter.program, filter.passes))
			return;
		if (!filter)
			this.endPreviewGPU();
		const op = this.previewOp;
		if (op) {
			op.reset();
			this.flush(op);
		}
		this.previewOp = filter ? this.filterOperation(op ?? new OperationReplace(image, this.selection), filter) : undefined;
	}

	//-------------------------------------------------------------------------
	// pointer
	//-------------------------------------------------------------------------

	// the menu has come up at a point of the window, which is where the system's colour picker is to come up
	menuOpened(x: number, y: number) {
		this.effects = undefined;	// (the picture may have been changed since the effects were made)
		const r = this.overlay.parentElement!.getBoundingClientRect();
		this.colourInput.style.left = `${x - r.left}px`;
		this.colourInput.style.top	= `${y - r.top}px`;
	}

	// Begin a tool's drag; undefined if the pointer is not for it (the viewer then pans)
	private press(event: PointerEvent): Drag | true | undefined {
		const image = this.host.target();
		if (!this.active || this.suspended || this.aside || !image || event.button !== 0 || this.tool === 'hand')
			return;

		const start	= this.host.toImage(event.clientX, event.clientY);

		const ends = (start: float2, end: float2, line: boolean, shift: boolean, alt: boolean): [float2, float2] => {
			const d = end.sub(start);
			if (shift) {
				if (line) {
					// to the nearest multiple of 45 degrees
					const a = Math.round(d.atan2() / (Math.PI / 4)) * Math.PI / 4;
					end = start.add(float2.cossin(a).scale(d.len()));
				} else {
					const t = Math.max(Math.abs(d.x), Math.abs(d.y));
					end = start.add(float2(d.x < 0 ? -t : t, d.y < 0 ? -t : t));
				}
			}
			if (alt)
				start = start.scale(2).sub(end);
			return [start, end];
		};
		// (every point the pointer passed through, not just where it is when the frame is drawn)
		let drag: Drag | true = true;
		const track = (move: (e: PointerEvent, p: float2) => void, up: (e: PointerEvent) => void) => {
			drag = {coalesced: true, move: e => move(e, this.pointer = this.host.toImage(e.clientX, e.clientY)), end: up};
		};
		const selMode	= event.shiftKey && event.altKey ? 'intersect' : event.shiftKey ? 'add' : event.altKey ? 'subtract' : this.selectMode.get();
		const opacity	= this.opacity.state.value / 100;

		switch (this.tool) {
			case 'brush':
			case 'pencil':
			case 'eraser': {
				// (a stroke may go on to other surfaces of the picture, each with an operation of its own: the selection is of the first)
				const ops	= new Map<Pixels<4>, Operation>();
				const opNew: (image: Pixels<4>, selection?: Shape)=>Operation = this.tool === 'eraser'
					? (image, shape) => new OperationErase(image, shape, opacity)
					: (image, shape) => new OperationPaint(image, shape, this.fg, opacity)
				const opOn	= (on: Pixels<4>) => {
					let o = ops.get(on);
					if (!o)
						ops.set(on, o = opNew(on, on === image ? this.selection : undefined));
					return o;
				};
				let op		= opOn(image);
				let last	= start;
				const segment = (o: Operation, a: float2, b: float2, size: number) => {
					if (this.tool === 'pencil')
						pencilSegment(o, a, b, size);
					else
						brushSegment(o, a, b, size, this.hardness.state.value / 100);
				};
				const stroke = (to: float2) => {
					segment(op, last, to, this.size.state.value);
					for (const s of this.host.adjoining?.(last, to, this.size.state.value) ?? [])
						segment(opOn(s.image), s.p, s.q, s.size);
					last = to;
					for (const o of ops.values())
						this.flush(o);
				};
				stroke(start);
				track((c, p) => {
					const carried = this.host.crossTo?.(c.clientX, c.clientY, last);
					if (carried) {
						last = carried;
						op = opOn(this.host.target()!);
						p = this.host.toImage(c.clientX, c.clientY);
					}
					stroke(p);
				}, () => this.commitAll(ops.values(), toolInfo[this.tool].label!));
				break;
			}

			case 'stamp': {
				if (event.altKey) {
					// where it copies from: this point, of the layer (or all the picture) seen now
					const source = this.host.cloneSource?.(start, this.sample.state.value === 'allLayers');
					this.stamp = source && {...source, shown: start};
					this.draw();
					break;
				}
				const stamp = this.stamp;
				let from = stamp?.from;
				if (!stamp || !from)
					break;
				// (a copy of what is drawn on, so a stroke copies what was there before it and not itself)
				if (from === image)
					from = Pixels(image.data.slice(), image.width, image.height);

				// by whole pixels, so what is copied is not resampled
				const	offset	= stamp.offset ??= float2(Math.round(stamp.at.x - start.x), Math.round(stamp.at.y - start.y));
				const	op 		= new OperationComputed(image, this.selection, (x: number, y: number) => asRGBA(getPixel(from, x + offset.x, y + offset.y)));
				let		last	= start;
				const stroke = (to: float2) => {
					brushSegment(op, last, to, this.size.state.value, this.hardness.state.value / 100);
					last = to;
					this.flush(op);
				};
				stroke(start);
				track((_, p) => stroke(p), () => {
					if (!this.aligned.state.value)
						stamp.offset = undefined;
					this.commit(op, toolInfo.stamp.label);
					this.draw();
				});
				break;
			}

			case 'line': {
				let end		= start;
				let shift	= false, alt = false, frame: number | undefined;
				const op	= new OperationPaint(image, this.selection, this.fg, opacity);

				// (once a frame, however many moves there were)
				const render = () => {
					frame = undefined;
					const [p0, p1] = ends(start, end, true, shift, alt);
					op.reset();
					brushSegment(op, p0, p1, this.size.get(), 1);
					this.flush(op);
				};
				track((e, p) => {
					end		= p;
					shift	= e.shiftKey;
					alt		= e.altKey;
					frame ??= requestAnimationFrame(render);
				}, () => {
					if (frame !== undefined)
						cancelAnimationFrame(frame);
					render();
					this.commit(op, toolInfo['line'].label);
				});
				break;
				
			}
			case 'rect':
			case 'ellipse': {
				const tool		= this.tool;
				const cover		= tool === 'rect' ? rectCover : ellipseCover;
				const shapeFill = this.shapeFill.get();
				const fill		= shapeFill === 'stroke' ? null : shapeFill === 'fill' ? this.fg : this.bg;
				const stroke	= shapeFill === 'fill' ? null : this.fg
				const w			= stroke ? Math.max(1, this.size.get()) : 0;

				let cx: number, cy: number, rx: number, ry: number;

				const op	= new OperationComputed(image, this.selection, (x, y) => {
					const outer = cover(x, y, cx, cy, rx, ry);
					const inner = w ? cover(x, y, cx, cy, rx - w, ry - w) : 0;
					const fa	= fill		? outer * fill.a / 255 : 0;
					const sa	= stroke	? clamp01(outer - inner) * stroke.a / 255 : 0;
					const a = sa + fa * (1 - sa);
					if (a > 0) {
						const f = fill ?? stroke!, s = stroke ?? fill!;
						const k = fa * (1 - sa);
						return RGBA(
							(s.r * sa + f.r * k) / a,
							(s.g * sa + f.g * k) / a,
							(s.b * sa + f.b * k) / a,
							a * 255,
						);
					}

				}, opacity);

				let end	= start, shift = false, alt = false, frame: number | undefined;

				// (once a frame, however many moves there were)
				const render = () => {
					frame = undefined;
					op.reset();
					const [p0, p1]	= ends(start, end, false, shift, alt);
					const area		= roundOut(new float2.extent(p0.min(p1), p0.max(p1)));

					({x: cx, y: cy} = area.centre());
					({x: rx, y: ry} = area.size().scale(0.5));

					const bb = op.bounds().intersect(area);
					for (let y = bb.min.y; y < bb.max.y; y++) {
						for (let x = bb.min.x; x < bb.max.x; x++)
							op.put(x, y, 1);
					}
					this.flush(op);
				};
				track((e, p) => {
					end		= p;
					shift	= e.shiftKey;
					alt		= e.altKey;
					frame ??= requestAnimationFrame(render);
				}, () => {
					if (frame !== undefined)
						cancelAnimationFrame(frame);
					render();
					this.commit(op, toolInfo[tool].label!);
				});
				break;
			}
			case 'gradient': {
				// (a gradient covers all it can, so the GPU shows it as it is dragged, and its pixels are worked out once, when it is let go)
				const	c0 = this.fg, c1 = this.bg;
				let		x0: number, y0: number, dx: number, dy: number, len2: number;
				const op	= new OperationComputed(image, this.selection, (x, y) => {
					const t = clamp01(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2);
					return RGBA(
						c0.r + (c1.r - c0.r) * t,
						c0.g + (c1.g - c0.g) * t,
						c0.b + (c1.b - c0.b) * t,
						c0.a + (c1.a - c0.a) * t,
					);
				}, opacity);

				const	preview	= previewShade(this.host, op, 'gradient');
				let		end		= start, shift = false, alt = false, frame: number | undefined;

				// (once a frame, however many moves there were)
				const render = () => {
					frame = undefined;
					const [p0, p1] = ends(start, end, true, shift, alt), d = p1.sub(p0);
					preview!.show({
						u_line:		[p0.x, p0.y, d.x, d.y], u_from: toFloat(c0), u_to: toFloat(c1),
						u_opacity:	this.opacity.get() / 100
					});
				};
				track((e, p) => {
					end		= p;
					shift	= e.shiftKey;
					alt		= e.altKey;
					frame ??= requestAnimationFrame(render);
				}, () => {
					if (frame !== undefined)
						cancelAnimationFrame(frame);

					const [p0, p1] = ends(start, end, true, shift, alt);
					const d = p1.sub(p0);
					len2 = d.lensq();
					if (len2 === 0)
						return;
					({x: x0, y: y0} = p0), {x: dx, y: dy} = d;
					op.fill();
					op.take();			// (all the image is shown again as it ends)
					preview!.end();
					this.commit(op, toolInfo['gradient'].label!);
				});
				break;
			}

			case 'bucket': {
				const op	= new OperationPaint(image, this.selection, this.fg, opacity);
				floodFill(op, Math.floor(start.x), Math.floor(start.y), this.tolerance.state.value, this.contiguous.state.value);
				this.flush(op);
				this.commit(op, 'Paint Bucket');
				break;
			}

			case 'eyedropper': {
				// the colour the tooltip shows: the current layer's, where the pointer is on it
				const sample = (e: PointerEvent, p: {x: number, y: number}) => {
					const c = this.host.pick(Math.floor(p.x), Math.floor(p.y));
					if (c)
						this.setColour(e.altKey ? 'bg' : 'fg', c);
				};
				sample(event, start);
				track(sample, () => {});
				break;
			}

			case 'marquee':
			case 'ellipse-marquee': {
				const round = this.tool === 'ellipse-marquee';
				// a modifier held when the drag began chose the mode; it constrains or centres only once let go and pressed again
				let shiftFree = !event.shiftKey, altFree = !event.altKey;
				let box: float2.extent | undefined;
				track((e, p) => {
					shiftFree	||= !e.shiftKey;
					altFree		||= !e.altKey;
					let x = p.x, y = p.y, x0 = start.x, y0 = start.y;
					if (e.shiftKey && shiftFree) {
						const d = Math.max(Math.abs(x - x0), Math.abs(y - y0));
						x = x0 + Math.sign(x - x0 || 1) * d;
						y = y0 + Math.sign(y - y0 || 1) * d;
					}
					if (e.altKey && altFree) {
						x0 = 2 * start.x - x;
						y0 = 2 * start.y - y;
					}
					const l = Math.max(0, Math.round(Math.min(x0, x))), t = Math.max(0, Math.round(Math.min(y0, y)));
					const r = Math.min(image.width, Math.round(Math.max(x0, x))), b = Math.min(image.height, Math.round(Math.max(y0, y)));
					box = r > l && b > t ? new float2.extent(float2(l, t), float2(r, b)) : undefined;
					this.draft = !box ? undefined
						: round ? ellipsePoints(box)
						: box.corners();
					this.draw();
				}, () => {
					this.draft = undefined;
					if (box)
						this.join(round ? Selection.fromPolygons([ellipsePoints(box)], imageSize(image)) : Selection.rect(box), selMode);
					else if (selMode === 'replace')
						this.select(undefined);	// a click on its own deselects
					else
						this.draw();
				});
				break;
			}

			case 'lasso': {
				const points	= [start];
				const pixel		= this.host.pixelSize();
				this.draft		= points;
				track((_, p) => {
					const last = points[points.length - 1];
					if (p.sub(last).len() >= 2 * pixel)
						points.push(p);
					this.draw();
				}, () => {
					this.draft = undefined;
					if (points.length >= 3)
						this.join(Selection.fromPolygons([points], imageSize(image)), selMode);
					else if (selMode === 'replace')
						this.select(undefined);
					else
						this.draw();
				});
				break;
			}

			case 'polygon-lasso':
				if (!this.corners) {
					this.corners = {points: [start], selMode};
				} else {
					const pts	= this.corners.points, pixel = this.host.pixelSize();
					const near	= (q: float2) => q.sub(start).len() < 6 * pixel;
					if (near(pts[pts.length - 1]) || (pts.length >= 3 && near(pts[0])))
						this.finishCorners();
					else
						pts.push(start);
				}
				this.draw();
				break;

			case 'wand':
				this.join(Selection.wand(image, Math.floor(start.x), Math.floor(start.y), this.tolerance.state.value, this.contiguous.state.value), selMode);
				break;

			case 'segment':
				segment(image, Math.floor(start.x), Math.floor(start.y)).then(found => {
					if (found)
						this.join(found, selMode);
				});
				break;
		}
		return drag;
	}

	// close the polygonal lasso and select what it encloses
	private finishCorners() {
		const image = this.host.target(), c = this.corners;
		this.corners = undefined;
		if (!c || !image)
			return;
		if (c.points.length >= 3)
			this.join(Selection.fromPolygons([c.points], imageSize(image)), c.selMode);
		else if (c.selMode === 'replace')
			this.select(undefined);
		else
			this.draw();
	}

	//-------------------------------------------------------------------------
	// keys
	//-------------------------------------------------------------------------

	// a key: whether the tools take it
	private keyDown(e: KeyboardEvent): boolean {
		// (a transform has the keys it wants)
		if (!this.active || this.suspended || this.aside)
			return false;

		const image = this.host.target();
		const mod = e.metaKey || e.ctrlKey;
		const key = e.key.toLowerCase();

		if (mod) {
			if (key === 'a' && image)
				this.run('selectAll');
			else if (key === 'i' && e.shiftKey)
				this.run('invertSelection');
			else if (key === 'd')
				this.run('deselect');
			else if (e.key === 'Backspace')
				this.fillSelection(this.bg, 'Fill');
			else
				return false;
			return true;
		}

		// (with a polygonal lasso under way, any other key goes on to do what it does)
		if (this.corners && ['Enter', 'Escape', 'Backspace', 'Delete'].includes(e.key)) {
			if (e.key === 'Enter') {
				this.finishCorners();
			} else if (e.key === 'Escape') {
				this.corners = undefined;
				this.draw();
			} else {
				this.corners.points.pop();
				if (!this.corners.points.length)
					this.corners = undefined;
				this.draw();
			}
			return true;
		}

		if (e.key === 'Escape') {
			// (an open menu takes the key itself)
			this.select(undefined);

		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			if (e.altKey)
				this.fillSelection(this.fg, 'Fill');
			else
				this.clearSelection();

		} else if (key === 'x') {
			this.swapColours();

		} else if (key === 'd') {
			this.defaultColours();

		} else if (e.key === '[' || e.key === ']') {
			this.size.state.value = Math.max(1, Math.min(200, Math.round(this.size.state.value * (e.key === ']' ? 1.2 : 1 / 1.2) + (e.key === ']' ? 1 : -1))));
			this.draw();
			this.menu.refresh();

		} else {
			const group = e.altKey ? [] : Object.entries(toolInfo).filter(([t, info]) => info.key === e.key).map(([t, info]) => t as Tool);
			if (!group.length)
				return false;
			const i = group.indexOf(this.tool);
			this.setTool(group[(i + 1) % group.length]);
		}
		return true;
	}

	//-------------------------------------------------------------------------
	// overlay: the selection and the brush
	//-------------------------------------------------------------------------

	// a grid of round numbers of the image's pixels, as fine as keeps its lines apart on the screen (but not finer than a pixel), over the
	// image (or the part of the canvas it is seen in); its major lines numbered on white strips against the image's top and left edges,
	// kept on the screen when an edge is off it
	private drawGrid(screen: (p: float2) => float2, pixelRatio: number) {
		const ctx = this.ctx, o = screen(float2(0, 0)), k = screen(float2(1, 1)).x - o.x;
		if (!(k > 0))
			return;
		const target = this.host.target(), size = target ? imageSize(target) : undefined;
		const W = this.overlay.width, H = this.overlay.height;
		const x0 = Math.max(0, -o.x / k), x1 = Math.min(size?.x ?? Infinity, (W - o.x) / k);
		const y0 = Math.max(0, -o.y / k), y1 = Math.min(size?.y ?? Infinity, (H - o.y) / k);
		const {step, every} = gridSpacing(k / pixelRatio, 12, 1);
		const sx = (v: number) => Math.round(o.x + v * k) + 0.5, sy = (v: number) => Math.round(o.y + v * k) + 0.5;
		const xs: number[] = [], ys: number[] = [];
		for (let i = Math.ceil(x0 / step); i <= Math.floor(x1 / step); i++)
			xs.push(i);
		for (let i = Math.ceil(y0 / step); i <= Math.floor(y1 / step); i++)
			ys.push(i);
		for (const major of [false, true]) {
			ctx.beginPath();
			for (const i of xs)
				if ((i % every === 0) === major) {
					ctx.moveTo(sx(i * step), sy(y0));
					ctx.lineTo(sx(i * step), sy(y1));
				}
			for (const i of ys)
				if ((i % every === 0) === major) {
					ctx.moveTo(sx(x0), sy(i * step));
					ctx.lineTo(sx(x1), sy(i * step));
				}
			ctx.lineWidth = pixelRatio;
			ctx.setLineDash([]);
			ctx.strokeStyle = major ? 'rgba(128, 128, 128, 0.8)' : 'rgba(128, 128, 128, 0.4)';
			ctx.stroke();
		}

		const th = 15 * pixelRatio, text = (i: number) => String(i * step);
		ctx.font = `${11 * pixelRatio}px sans-serif`;
		const tw = Math.ceil(Math.max(0, ...ys.filter(i => i % every === 0).map(i => ctx.measureText(text(i)).width))) + 6 * pixelRatio;
		const ty = Math.max(0, Math.min(H - th, o.y - th)), lx = Math.max(0, Math.min(W - tw, o.x - tw));
		const strip = (x: number, y: number, w: number, h: number, draw: () => void) => {
			ctx.save();
			ctx.beginPath();
			ctx.rect(x, y, w, h);
			ctx.clip();
			ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
			ctx.fillRect(x, y, w, h);
			ctx.fillStyle = '#000';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			draw();
			ctx.restore();
		};
		strip(sx(x0) - 0.5, ty, sx(x1) - sx(x0), th, () => xs.forEach(i => i % every === 0 && ctx.fillText(text(i), sx(i * step) + 3 * pixelRatio, ty + th / 2)));
		strip(lx, sy(y0) - 0.5, tw, sy(y1) - sy(y0), () => ys.forEach(i => i % every === 0 && ctx.fillText(text(i), lx + 3 * pixelRatio, sy(i * step) - th / 2 + pixelRatio)));
	}

	draw() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
		if (!this.active)
			return;

		const screen		= (p: float2) => this.host.toScreen(p);
		const pixelRatio	= window.devicePixelRatio || 1;
		if (this.grid)
			this.drawGrid(screen, pixelRatio);
		if (this.suspended || this.aside)
			return;		// (and the selection is not where it was while what it selects is carried)

		const outline = (path: () => void, dash = '#000') => {
			ctx.lineWidth = pixelRatio;
			ctx.setLineDash([]);
			ctx.strokeStyle = '#fff';
			ctx.beginPath();
			path();
			ctx.stroke();
			ctx.setLineDash([4 * pixelRatio, 4 * pixelRatio]);
			ctx.strokeStyle = dash;
			ctx.beginPath();
			path();
			ctx.stroke();
		};

		const s = this.selected;
		if (s) {
			// a pixel's edge is on the screen's pixels' edges, to be sharp
			const loops = s.outline();
			outline(() => {
				for (const loop of loops) {
					for (let i = 0; i < loop.length; i += 2) {
						const p = screen(float2(loop[i], loop[i + 1]));
						i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
					}
					ctx.closePath();
				}
			});
		}
		if (this.previewSelection) {
			const loops = this.previewSelection.outline();
			outline(() => {
				for (const loop of loops) {
					for (let i = 0; i < loop.length; i += 2) {
						const p = screen(float2(loop[i], loop[i + 1]));
						i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
					}
					ctx.closePath();
				}
			}, '#e60');
		}
		const draft = this.corners ? [...this.corners.points, ...(this.pointer ? [this.pointer] : [])] : this.draft;
		if (draft?.length) {
			outline(() => {
				draft.forEach((q, i) => {
					const p = screen(q);
					i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
				});
				if (!this.corners)
					ctx.closePath();
			});
		}

		if (this.pointer && ['brush', 'pencil', 'eraser', 'stamp', 'line'].includes(this.tool)) {
			const r = Math.max(this.size.state.value / this.host.pixelSize() / 2, 2 * pixelRatio);
			const centre = screen(this.pointer!);
			outline(() => ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2));
		}

		// where the clone stamp copies from: what is under the pointer once a stroke has set how far away that is
		const stamp = this.tool === 'stamp' ? this.stamp : undefined;
		if (stamp) {
			const at = stamp.offset && this.pointer ? this.pointer.add(stamp.offset).add(stamp.shown).sub(stamp.at) : stamp.shown;
			const c = screen(at), r = 6 * pixelRatio;
			outline(() => {
				ctx.moveTo(c.x - r, c.y);
				ctx.lineTo(c.x + r, c.y);
				ctx.moveTo(c.x, c.y - r);
				ctx.lineTo(c.x, c.y + r);
			});
		}
	}
}

//-----------------------------------------------------------------------------
// operations: one undoable change to an image
//-----------------------------------------------------------------------------

export const TILE = 64;

// The image is changed in tiles, and the first time a tile is touched its original pixels are kept. That is what undo needs,
// and it also lets a stroke be correct where it overlaps itself: every pixel is worked out from its original value and
// the greatest coverage the stroke has given it, so a translucent stroke is no darker where it crosses itself. And a preview
// (a line being dragged out) is `reset` and drawn again.

class Tile<T extends PixelStorage> extends float2.extent {
	before:	T;					// the original pixels, packed
	cover:	Float32Array;		// the greatest coverage so far, per pixel
	constructor(image: Pixels<4, T>, r: float2.extent) {
		super(r.min, r.max.min(float2(image.width, image.height)));
		// packed at the width of the tile as it falls on the image, which is less than TILE at the right and bottom edges
		this.before = readRect(image, this);
		const {x: w, y: h} = this.size();
		this.cover = new Float32Array(w * h);
	 }
}

class PatchTile<T extends PixelStorage> extends float2.extent {
	before:	T;	// the original pixels, packed
	constructor(tile: Tile<T>, public after:T) {
		super(tile.min, tile.max);
		this.before = tile.before;
	}
}

interface Patch<T extends PixelStorage> {
	tiles: PatchTile<T>[];
}

function applyPatch<T extends PixelStorage>(image: Pixels<4, T>, patch: Patch<T>, which: 'before' | 'after') {
	let dirty: float2.extent | undefined;
	for (const t of patch.tiles) {
		writeRect(image, t, t[which]);
		dirty = unionRect(dirty, t);
	}
	return dirty;
}

class Tiles<T extends PixelStorage> {
	protected tiles = new Map<number, Tile<T>>();
	protected dirty: float2.extent | undefined;

	constructor(readonly image: Pixels<4, T>) {}

	protected tile(x: number, y: number) {
		const tx	= Math.floor(x / TILE), ty = Math.floor(y / TILE);
		const key	= ty * 65536 + tx;
		let t = this.tiles.get(key);
		if (!t) {
			t = new Tile<T>(this.image, new float2.extent(float2(tx, ty).scale(TILE), float2(tx + 1, ty + 1).scale(TILE)));
			this.tiles.set(key, t);
		}
		return t;
	}

	// the area changed since the last call
	take() {
		const r = this.dirty;
		this.dirty = undefined;
		return r;
	}
	// back to the original, to draw again
	reset() {
		for (const t of this.tiles.values()) {
			writeRect(this.image, t, t.before);
			t.cover.fill(0);
			// a copy: a pixel put afterwards grows the dirty area in place, and it must not be the tile that does
			this.dirty = (this.dirty ?? t).union(t);
		}
	}
	corrupt(x: number, y: number) {
		const p = this.dirty;
		if (!p)
			this.dirty = new float2.extent(float2(x, y), float2(x + 1, y + 1));
		else {
			// in place, as this is done for every pixel
			p.min.x = Math.min(p.min.x, x);
			p.min.y = Math.min(p.min.y, y);
			p.max.x = Math.max(p.max.x, x + 1);
			p.max.y = Math.max(p.max.y, y + 1);
		}
	}

	// what changed, to undo or redo; nothing if nothing did
	commit(): Patch<T> | undefined {
		const tiles: PatchTile<T>[] = [];
		for (const t of this.tiles.values()) {
			const after = readRect(this.image, t);
			if (after.some((v, i) => v !== t.before[i]))
				tiles.push(new PatchTile(t, after));
		}
		return tiles.length ? {tiles} : undefined;
	}
}

abstract class Operation extends Tiles<PixelStorage> {
	constructor(image: Pixels<4>, readonly selection?: Shape | undefined) { super(image); }

	bounds(): float2.extent {
		const ext = imageRect(this.image);
		return this.selection ? ext.intersect(this.selection) : ext;
	}
	coverage(x: number, y: number, c: number) {
		if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height)
			return;

		if (this.selection)
			c *= this.selection.at(x, y) / 255;

		const t		= this.tile(x, y);
		const i		= (y - t.min.y) * (t.max.x - t.min.x) + (x - t.min.x);

		if (c > t.cover[i]) {
			t.cover[i]	= c;
			const b		= i * 4;
			return {before: t.before, offset: b, coverage: c};
		}
	}
	put(x: number, y: number, c: number) {
		const t = this.coverage(x, y, c);
		if (t) {
			const r = this.tileput(loadRGBA(t.before, t.offset), x, y, t.coverage);
			if (r) {
				saveRGBA(this.image.data, (y * this.image.width + x) * 4, r);
				this.corrupt(x, y);
			}
		}
	}
	abstract tileput(before: RGBA, x: number, y: number, c: number): RGBA | undefined;

	// What put does for every pixel of `area` (at full coverage, the selection's coverage the weight of each): all at once, as it is for
	// a filter of a whole picture. The pixel is the picture's, as put has it
	fill(area: float2.extent = this.bounds()) {
		const {width, height, data: d} = this.image, sel = this.selection;
		const a = area.intersect(new float2.extent(float2(0, 0), float2(width, height)));
		if (a.empty())
			return;

		for (let ty = Math.floor(a.min.y / TILE); ty * TILE < a.max.y; ty++) {
			for (let tx = Math.floor(a.min.x / TILE); tx * TILE < a.max.x; tx++) {
				const t = this.tile(tx * TILE, ty * TILE), tw = t.max.x - t.min.x, b = t.before, cover = t.cover;
				const x0 = Math.max(a.min.x, t.min.x), x1 = Math.min(a.max.x, t.max.x);
				const y0 = Math.max(a.min.y, t.min.y), y1 = Math.min(a.max.y, t.max.y);
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						const c = sel ? sel.at(x, y) / 255 : 1, i = (y - t.min.y) * tw + (x - t.min.x);
						if (c <= 0 || c <= cover[i])
							continue;
						const res	= this.tileput(loadRGBA(b, i * 4), x, y, c);
						if (res) {
							cover[i]	= c;
							const o		= (y * width + x) * 4;
							d[o]		= res.r;
							d[o + 1]	= res.g;
							d[o + 2]	= res.b;
							d[o + 3]	= res.a;
						}
					}
				}
			}
		}
		this.dirty = unionRect(this.dirty, a);
	}

}

class OperationPaint extends Operation {
	constructor(image: Pixels<4>, selection: Shape | undefined, public colour: RGBA, public opacity: number) { super(image, selection); }
	// give a pixel coverage `c` (0..1) of `colour`; a pixel only ever gains coverage until the operation is reset
	tileput(before: RGBA, x: number, y: number, c: number) {
		const a		= c * this.opacity * this.colour.a / 255;
		const dstA	= before.a / 255;
		const outA	= a + dstA * (1 - a);
		if (outA > 0) {
			const w = dstA * (1 - a);
			before.r = Math.round((this.colour.r * a + before.r * w) / outA);
			before.g = Math.round((this.colour.g * a + before.g * w) / outA);
			before.b = Math.round((this.colour.b * a + before.b * w) / outA);
		}
		before.a = Math.round(outA * 255);
		return before;
	}
}

class OperationErase extends Operation {
	constructor(image: Pixels<4>, selection?: Shape | undefined, public opacity = 1) { super(image, selection); }
	tileput(before: RGBA, x: number, y: number, c: number) {
		return {...before, a: Math.round(before.a * (1 - c * this.opacity))};
	}
}


class OperationReplace extends Operation {
	constructor(image: Pixels<4>, selection: Shape | undefined, public from: Pixels<4> = Pixels(new Uint8ClampedArray(4), 1, 1, 4), public strength = 1) { super(image, selection); }

	// where `from`'s corner is in the picture: the area it was made for, which fill is given
	private origin = float2(0, 0);

	fill(area: float2.extent = this.bounds()) {
		this.origin = area.min;
		super.fill(area);
	}

	at(x: number, y: number) {
		return loadRGBA(this.from.data, ((y - this.origin.y) * this.from.width + (x - this.origin.x)) * 4);
	}

	tileput(before: RGBA, x: number, y: number, c: number): RGBA {
		c *= this.strength;
		const s = this.at(x, y);
		return c === 1 ? s : {
			r: Math.round(before.r + (s.r - before.r) * c),
			g: Math.round(before.g + (s.g - before.g) * c),
			b: Math.round(before.b + (s.b - before.b) * c),
			a: Math.round(before.a + (s.a - before.a) * c),
		};
	}

}
class OperationComputed extends Operation {
	constructor(image: Pixels<4>, selection: Shape | undefined, public f: (x: number, y: number) => RGBA | undefined, public opacity = 1) { super(image, selection); }
	// give a pixel coverage `c` (0..1) of `colour`; a pixel only ever gains coverage until the operation is reset
	tileput(before: RGBA, x: number, y: number, c: number) {
		const colour	= this.f(x, y);
		if (!colour)
			return;
		
		const a		= c * this.opacity * colour.a / 255;

		const dstA	= before.a / 255;
		const outA	= a + dstA * (1 - a);
		if (outA > 0) {
			const w = dstA * (1 - a);
			before.r = Math.round((colour.r * a + before.r * w) / outA);
			before.g = Math.round((colour.g * a + before.g * w) / outA);
			before.b = Math.round((colour.b * a + before.b * w) / outA);
		}
		before.a = Math.round(outA * 255);
		return before;
	}
}

//-----------------------------------------------------------------------------
// brush and pencil
//-----------------------------------------------------------------------------

function smooth(c: number) {
	return c * c * (3 - 2 * c);
}

// A soft round brush dragged from one point to the next: coverage depends only on the distance from the segment, so
// a stroke is even however the pointer moved. Hardness 1 is a hard edge (still antialiased); less than that fades
// from that fraction of the radius. It paints the operation's colour, or each pixel the colour `colour` gives it (none where
// it gives none).
function brushSegment(op: Operation, p0: float2, p1: float2, size: number, hardness: number) {
	const r		= size / 2;
	const f		= Math.max(r * (1 - hardness), 1);
	const reach	= r + 1;
	const d		= p1.sub(p0), len2 = d.lensq();
	const a		= roundOut(new float2.extent(p0.min(p1), p0.max(p1)).grow(float2(reach, reach))).intersect(op.bounds());

	// (in numbers, not vectors, as this is done for every pixel)
	const {x: x0, y: y0} = p0, {x: dx, y: dy} = d;
	for (let y = a.min.y; y < a.max.y; y++) {
		const py = y + 0.5 - y0;
		for (let x = a.min.x; x < a.max.x; x++) {
			// the distance of the pixel's centre from the segment
			const px = x + 0.5 - x0;
			const t	 = len2 > 0 ? clamp01((px * dx + py * dy) / len2) : 0;
			const ex = px - dx * t, ey = py - dy * t;
			const c	 = clamp01((r + 0.5 - Math.sqrt(ex * ex + ey * ey)) / f);
			op.put(x, y, f > 1 ? smooth(c) : c);
		}
	}
}

// A hard, unantialiased square-ish dot of `size` pixels at every pixel the line from one point to the next passes through
function pencilSegment(op: Operation, p0: float2, p1: float2, size: number) {
	const r		= size / 2;
	const r2	= (r + 1e-6) * (r + 1e-6);
	const odd	= Math.round(size) % 2 === 1;
	// the dot's centre is a pixel's centre for an odd size, a pixel corner for an even one (in numbers, not vectors, as this is
	// done for every pixel)
	const dot = (cx: number, cy: number) => {
		for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
			const dy = y + 0.5 - cy, dy2 = dy * dy;
			for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
				const dx = x + 0.5 - cx;
				if (dx * dx + dy2 <= r2)
					op.put(x, y, 1);
			}
		}
	};

	// Bresenham over the pixels
	let ix = Math.floor(p0.x), iy = Math.floor(p0.y);
	const ex = Math.floor(p1.x), ey = Math.floor(p1.y);
	const dx = Math.abs(ex - ix), dy = -Math.abs(ey - iy);
	const sx = ix < ex ? 1 : -1, sy = iy < ey ? 1 : -1;
	let err = dx + dy;
	for (;;) {
		dot(odd ? ix + 0.5 : ix + 1, odd ? iy + 0.5 : iy + 1);
		if (ix === ex && iy === ey)
			break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			ix += sx;
		}
		if (e2 <= dx) {
			err += dx;
			iy += sy;
		}
	}
}

//-----------------------------------------------------------------------------
// shapes
//-----------------------------------------------------------------------------

// how much of the pixel starting at p lies in [a, b)
const overlap = (p: number, a: number, b: number) => clamp01(Math.min(p + 1, b) - Math.max(p, a));

export function ellipsePoints(area: float2.extent) {
	const c = area.centre(), ry = area.max.y - c.y, x0 = area.min.x, x1 = area.max.x;

	const ellipse: curveVertex[] = [
		{x: x0, y: c.y, flags: CurveFlag.ON_BEGIN},
		{x: x0, y: c.y - ry * 2, flags: CurveFlag.OFF_ARC},   // on the tangent line at the start, 2*ry away
		{x: x1, y: c.y - ry * 2, flags: CurveFlag.OFF_ARC},   // on the tangent line at the end,area.max.y away
		{x: x1, y: c.y, flags: CurveFlag.ON_CURVE},
		{x: x1, y: c.y + ry * 2, flags: CurveFlag.OFF_ARC},
		{x: x0, y: c.y + ry * 2, flags: CurveFlag.OFF_ARC},
	];
	return curveFlatten(ellipse, 0.1)[0];
}

// coverage of the pixel at (px, py) by an ellipse, from an approximation to the distance to its edge
function ellipseCover(px: number, py: number, cx: number, cy: number, rx: number, ry: number) {
	if (rx <= 0 || ry <= 0)
		return 0;
	const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
	const k0 = Math.hypot(dx / rx, dy / ry);
	const k1 = Math.hypot(dx / (rx * rx), dy / (ry * ry));
	return clamp01(0.5 - (k1 === 0 ? -Math.min(rx, ry) : k0 * (k0 - 1) / k1));
}

function rectCover(px: number, py: number, cx: number, cy: number, rx: number, ry: number) {
	return overlap(px, cx - rx, cx + rx) * overlap(py, cy - ry, cy + ry);
}


//-----------------------------------------------------------------------------
// bucket
//-----------------------------------------------------------------------------

// Paint every pixel that is within `tolerance` of the one at (sx, sy): those connected to it (not crossing the selection's
// edge), or all of them
function floodFill(op: OperationPaint, sx: number, sy: number, tolerance: number, contiguous: boolean) {
	const {data: data, width, height} = op.image;
	if (sx < 0 || sy < 0 || sx >= width || sy >= height)
		return;

	const s = (sy * width + sx) * 4;
	const target = [data[s], data[s + 1], data[s + 2], data[s + 3]];
	const visited = new Uint8Array(width * height);

	const matches = (x: number, y: number) => {
		const i = y * width + x;
		if (visited[i] || (op.selection && !op.selection.at(x, y)))
			return false;
		const o = i * 4;
		if (data[o + 3] === 0 && target[3] === 0)
			return true;
		return Math.abs(data[o] - target[0]) <= tolerance
			&& Math.abs(data[o + 1] - target[1]) <= tolerance
			&& Math.abs(data[o + 2] - target[2]) <= tolerance
			&& Math.abs(data[o + 3] - target[3]) <= tolerance;
	};

	if (!contiguous) {
		const matched: number[] = [];
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				if (matches(x, y))
					matched.push(x, y);
		for (let i = 0; i < matched.length; i += 2)
			op.put(matched[i], matched[i + 1], 1);
		return;
	}

	const stack = [sx, sy];
	while (stack.length) {
		const y = stack.pop()!, x = stack.pop()!;
		if (!matches(x, y))
			continue;

		let x1 = x;
		while (x1 > 0 && matches(x1 - 1, y))
			x1--;

		let up = false, down = false;
		for (let xi = x1; xi < width && matches(xi, y); xi++) {
			visited[y * width + xi] = 1;
			op.put(xi, y, 1);

			if (y > 0) {
				const m = matches(xi, y - 1);
				if (m && !up)
					stack.push(xi, y - 1);
				up = m;
			}
			if (y < height - 1) {
				const m = matches(xi, y + 1);
				if (m && !down)
					stack.push(xi, y + 1);
				down = m;
			}
		}
	}
}

//-----------------------------------------------------------------------------
// whole-area operations
//-----------------------------------------------------------------------------

