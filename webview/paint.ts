// The bitmap editor's tools, with their options for the menu the right button brings up (cascade.ts), and the selection.
// The pixels themselves are changed by the Operations here; this turns pointer and key events into those changes.
// Transforms are not tools (transform.ts): the tools give way to one while it is under way.

import { float2 } from '@isopodlabs/maths/vector';
import { CurveFlag, curveFlatten, curveVertex } from '@isopodlabs/binary_fonts/curves';
import { createElement, RPC } from '@isopodlabs/vscode_utils/webview/shared.js';
import * as xml from '@isopodlabs/xml';

import { Mode, postMessage, working, filterPrograms, CoordinateInterface } from './modes.js';
import { RGBA, asRGBA, fromHex, toHex } from './colour.js';
import { Canvas3D, Pixels, imageSize, imageRect, unionRect, getPixel, Offscreen, readRect, writeRect } from './opengl.js';
import { blurWith, crop, levelsPixels, levelsUniforms, kernelUniforms, Levels, boxKernel, embossKernel, edgeKernel } from './raster.js';
import { flattenWith, gradientsWith, traceWith, inkWith, mixed, type Traced, type TracedFill } from './vectorise.js';
import { Selection } from './bitmapSelection.js';
import { segment, removeObject, stylise, styleFrom, styles, type Style } from './neural.js';
import { History, type HistoryEntry } from './history.js';
import { Input, Place, type Drag } from './navigate.js';
import type { PixelLayer } from './layers.js';
import { newShapeLayer, type NewPaint } from './shapeedit.js';
import { gridSpacing, fitRuns, svgPath } from './pathedit.js';
import { Cascade, CascadeItem, svgFace, swatchFace, valueItem, choiceItem, toggleItem, multiplicativeStep, colourItems, valueFace, ValueOptions, sliderItem } from './cascade.js';

type FilterKind		= 'blur' | 'sharpen' | 'levels' | 'boxBlur' | 'emboss' | 'edges';
type Region		= {image: Pixels<4>, selection: Selection | undefined, x0: number, y0: number, w: number, h: number, id: string};
type FilterUsing	= {blurRadius?: number, sharpenRadius?: number, boxSize?: number};
type Tool			= 'hand' | 'marquee' | 'ellipse-marquee' | 'lasso' | 'polygon-lasso' | 'wand' | 'segment' | 'brush' | 'pencil' | 'eraser' | 'stamp' | 'bucket' | 'gradient' | 'eyedropper' | 'line' | 'rect' | 'ellipse';
type ShapeKind		= 'line' | 'rect' | 'ellipse';
type ShapeFill		= 'stroke' | 'fill' | 'both';
type SelectMode		= 'replace' | 'add' | 'subtract' | 'intersect';

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

export interface CloneSource {
	from?:		Pixels<4>;	// what the clone stamp copies from, chosen now (what the tools draw on, or all the picture shows) and read as each stroke begins
	at:			float2;
	offset?:	float2;
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
	layerPictures?(): {name: string, image: Pixels<4>}[];		// the pictures of the layers other than the current one, which can be taken as a style	// layers put above the current one (a picture without them gets them, over itself), as one edit
}

// An image shown as a filter's shader draws it from its pixels, by drawing into the texture it is shown from (which its own pixels
// are put back into at the end)
function previewShade(host: PaintHost, image: Pixels<4>, program: string, extra: Pixels[] = []): ShadePreview | undefined {
	const canvas3d = host.canvas3d;
	const shader = filterPrograms[program];
	const target = shader && host.shownBy(image);
	if (!target)
		return undefined;
	const textures = [image, ...extra].map(p => canvas3d.createTextureFromImage(p, {format: p.channels === 1 ? 'r8' : 'rgba8', min: 'nearest', mag: 'nearest'}));
	return {
		show: uniforms => {
			const gl = canvas3d.gl;
			gl.disable(gl.BLEND);
			target.begin();
			textures.forEach((t, i) => canvas3d.bindTexture2D(t, i));
			shader.draw({u_image: 0, ...uniforms});
			textures.forEach((_, i) => canvas3d.bindTexture2D(null, i));
			target.end();
		},
		end: () => {
			target.delete(true);
			for (const t of textures)
				canvas3d.deleteTexture(t);
			host.changed(image);
		},
	};
}

// what a tool shows of its change while it is dragged, where working out the pixels each time would be too slow
export interface ShadePreview {
	show(uniforms: Record<string, any>): void;	// the image as the shader draws it with these
	end(): void;								// the image's own pixels shown again
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
	styleLayer:	'<path d="M2 10.5l6 3 6-3M2 7.5l6 3 6-3-6-3z"/><circle cx="8" cy="7.5" r="1"/>',
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

const crosshair = '<path d="M8 1.5v4.5M8 10v4.5M1.5 8h4.5M10 8h4.5"/>';

function cursorFor(tool: Tool) {
	if (tool === 'hand')
		return 'grab';
	const info = toolInfo[tool];
	const hot = info.hotspot;
	const glyph = hot ? info.icon : crosshair;
	const style = 'fill="none" stroke-linejoin="round" stroke-linecap="round"';
	// the glyph twice, thick and light then thin and dark; filled parts of the icon keep their fill
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="0 0 16 16">`
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



export class Painter {
	private tool:		Tool	= 'hand';
	private fg			= RGBA(0, 0, 0, 255);
	private bg			= RGBA(255, 255, 255, 255);
	private size		= 10;
	private hardness	= 0.8;
	private opacity		= 1;
	private tolerance	= 32;
	private contiguous	= true;
	// how far each of the selection's modifiers goes, in pixels
	private modifyBy: Record<'growSelection' | 'shrinkSelection' | 'borderSelection' | 'smoothSelection' | 'featherSelection', number> = {
		growSelection: 4, shrinkSelection: 4, borderSelection: 4, smoothSelection: 4, featherSelection: 8,
	};
	private inkContrast = 10;		// how much darker, in levels, than what is round it a pixel must be to be inked
	private gradientTolerance = 12;	// how far, in levels, the colours of a gradient region may stray from its gradient
	private traceKind: 'shapes' | 'lines' | 'both' = 'both';	// what Trace to SVG makes: gradient regions, ink lines as strokes, or both
	private styleStrength = Object.fromEntries(styles.map(n => [n, 100])) as Record<Style, number>;	// how far, in percent, each style takes the picture from the original
	private styleChoice: Style = 'mosaic';	// the style the strength is shown on
	// styles taken from pictures (a file, or a layer): each with how big its marks are, as a percentage of the picture's size that the style
	// picture is taken at
	private customStyles: {id: number, name: string, image: Pixels<4>, face: string, scale: number}[] = [];
	private nextStyle = 1;
	private effects:	{image: Pixels<4>, region: string, crop: Pixels<4>, made: Map<string, Promise<Pixels<4> | undefined>>} | undefined;	// what neural and slow filters made of the region they were last shown on, to show at other strengths (being made, as well as made, so that none is made twice)
	private effectToken = 0;		// which showing of one is the latest asked for
	private applying = 0;			// the effects being made to apply (a preview is not shown meanwhile, and the pointer going from the item does not stop them)
	private flatColours	= 8;		// the colours Flatten leaves
	private blurRadius	= 4;		// the gaussian blur of the filter, in pixels
	private boxSize	= 3;		// the box blur filter's side, in pixels
	private sharpenRadius = 2;		// the blur the sharpen filter's unsharp mask is taken against, in pixels
	private levels:	Levels = {black: 0, white: 255, gamma: 1};	// the levels filter's settings
	private shapeFill: ShapeFill = 'fill';
	private aligned		= true;		// the clone stamp keeps its offset from one stroke to the next (or starts each from its source)
	private sample:		'oneLayer' | 'allLayers' = 'oneLayer';	// what the clone stamp copies: the layer it was pointed at on, or all the picture shows
	// where the clone stamp copies from, and once a stroke has begun, how far that is from where it paints
	private stamp:		CloneSource | undefined;

	private selected:	Selection | undefined;
	private selectMode:	SelectMode = 'replace';
	private previewFrame: number | undefined;		// the frame at which a filter's preview is to be shown
	private blurring:	Operation | undefined;			// the filter being previewed, which is not yet an edit
	private preview:	Selection | undefined;			// what the selection would become under the modifier the pointer is on
	private draft:		float2[] | undefined;			// the outline of a selection being drawn, in image coordinates
	private corners:	{points: float2[], mode: SelectMode} | undefined;	// a polygonal lasso under way
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

		this.setTool('hand');
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
		const size = valueItem({
			label: 'size', caption: 'Size', min: 1, max: 200,
			get: () => this.size, set: v => { this.size = v; this.draw(); },
			step: multiplicativeStep(), presets: [1, 2, 5, 10, 20, 50, 100, 200],
		});
		const hardness = valueItem({
			label: 'hard', caption: 'Hardness', min: 0, max: 100,
			get: () => Math.round(this.hardness * 100), set: v => this.hardness = v / 100,
			step: (v, steps) => v + 5 * steps, presets: [0, 25, 50, 75, 100],
		});
		const opacity = valueItem({
			label: 'opacity', caption: 'Opacity', min: 1, max: 100,
			get: () => Math.round(this.opacity * 100), set: v => this.opacity = v / 100,
			step: (v, steps) => v + 5 * steps, presets: [10, 25, 50, 75, 100],
		});
		const tolerance = valueItem({
			label: 'tol', caption: 'Tolerance', min: 0, max: 255,
			get: () => this.tolerance, set: v => this.tolerance = v,
			step: (v, steps) => v + 4 * steps, presets: [0, 8, 16, 32, 64, 128],
		});
		// a selection modifier: clicked it applies, and scrolled over (or dragged along its presets) it changes by how much
		const modifier = (o: keyof Painter['modifyBy'], icon: string, name: string): CascadeItem => {
			const presets = [1, 2, 4, 8, 16, 32, 64, 128];
			const value = valueItem({
				label: 'px', caption: `${name} by`, min: 1, max: 200,
				get: () => this.modifyBy[o], set: v => { this.modifyBy[o] = v; this.previewModifier(o); },
				step: multiplicativeStep(), presets,
			});
			return {
				...value,
				id:			o,
				face:		() => svgFace(icon),
				caption:	() => `${name} by ${this.modifyBy[o]} px (scroll or drag to change)`,
				select:		() => { this.previewModifier(undefined); return this.run(o); },
				hover:		on => this.previewModifier(on ? o : undefined),
				children:	() => value.children!().map((c, i) => ({...c, hover: (on: boolean) => this.previewModifier(on ? o : undefined, presets[i])})),
			};
		};
		// the blur filter: clicked it blurs what is selected (or the layer), and scrolled over (or dragged along its presets) it takes the radius
		const blurPresets = [1, 2, 4, 8, 16, 32, 64];
		const blur = valueItem({
			label: 'px', caption: 'Blur radius', min: 1, max: 100,
			get: () => this.blurRadius, set: v => { this.blurRadius = v; this.previewFilter('blur'); },
			step: multiplicativeStep(), presets: blurPresets,
		});
		const blurItem: CascadeItem = {
			...blur,
			id:			'blur',
			face:		() => svgFace(menuIcons.blur),
			caption:	() => `Gaussian blur of ${this.blurRadius} px (scroll or drag to change)`,
			select:		() => this.run('blur'),
			hover:		on => { if (!on) this.previewFilter(); },
			// choosing a size blurs by it, and pointing at one shows it
			children:	() => blur.children!().map((c, i) => ({...c,
				hover:	(on: boolean) => this.previewFilter(on ? 'blur' : undefined, {blurRadius: blurPresets[i]}),
				select:	() => { this.blurRadius = blurPresets[i]; return this.run('blur'); },
			})),
		};
		// sharpen: an unsharp mask against a blur of this radius, in the same way
		const sharpenItem: CascadeItem = {
			...valueItem({
				label: 'px', caption: 'Sharpen radius', min: 1, max: 100,
				get: () => this.sharpenRadius, set: v => { this.sharpenRadius = v; this.previewFilter('sharpen'); },
				step: multiplicativeStep(), presets: blurPresets,
			}),
			id:			'sharpen',
			face:		() => svgFace(menuIcons.sharpen),
			caption:	() => `Sharpen with a radius of ${this.sharpenRadius} px (scroll or drag to change)`,
			select:		() => this.run('sharpen'),
			hover:		on => { if (!on) this.previewFilter(); },
			children:	() => blurPresets.map(r => ({
				face:		() => valueFace('', String(r)),
				caption:	() => `Sharpen with a radius of ${r} px`,
				hover:		(on: boolean) => this.previewFilter(on ? 'sharpen' : undefined, {sharpenRadius: r}),
				select:		() => { this.sharpenRadius = r; return this.run('sharpen'); },
			})),
		};
		// levels: the black point, white point and gamma, each shown on the picture while it is pointed at, and the icon applies them
		const levelValue = (label: string, caption: string, min: number, max: number, get: () => number, set: (v: number) => void, o: Partial<ValueOptions> = {}) => {
			const item = sliderItem({label, caption, min, max, markers: 5, get, set: v => { set(v); this.previewFilter('levels'); }, ...o});
			return {...item, hover: (on: boolean) => this.previewFilter(on ? 'levels' : undefined)} as CascadeItem;
		};
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
		// the convolution filters: box blur, by the side of the box, and emboss and edge detect, which take nothing
		const boxSizes = [3, 5, 7];
		const boxItem: CascadeItem = {
			...valueItem({
				label: 'box', caption: 'Box blur size', min: 3, max: 7,
				get: () => this.boxSize, set: v => { this.boxSize = v; this.previewFilter('boxBlur'); },
				step: (v, n) => Math.min(7, Math.max(3, v + 2 * Math.sign(n))), presets: boxSizes, resolution: 2,
			}),
			id:			'boxBlur',
			face:		() => svgFace(menuIcons.boxBlur),
			caption:	() => `Box blur ${this.boxSize} px wide (scroll or drag to change)`,
			select:		() => this.run('boxBlur'),
			hover:		on => { if (!on) this.previewFilter(); },
			children:	() => boxSizes.map(n => ({
				face:		() => valueFace('', String(n)),
				caption:	() => `Box blur ${n} px wide`,
				hover:		(on: boolean) => this.previewFilter(on ? 'boxBlur' : undefined, {boxSize: n}),
				select:		() => { this.boxSize = n; return this.run('boxBlur'); },
			})),
		};
		const convolution = (kind: 'emboss' | 'edges', icon: string, caption: string): CascadeItem => ({
			id:			kind,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => this.run(kind),
			hover:		on => this.previewFilter(on ? kind : undefined),
		});
		// styles: a painting's manner given to the picture by a neural network, as much as the strength says; and Flatten, which reduces it to a
		// few flat colours so that it makes simple vector shapes
		const flatPresets = [3, 4, 6, 8, 12, 16, 24], stylePresets = [25, 50, 75, 100];
		const showStyle = (name: Style) => this.previewEffect(`style:${name}`, crop => stylise(crop, name), this.styleStrength[name] / 100);
		const scalePresets = [25, 50, 100, 200];
		const showCustom = (c: Painter['customStyles'][number], scale = c.scale) => this.previewEffect(`custom:${c.id}:${scale}`, crop => styleFrom(crop, c.image, scale / 100));
		const styleItem: CascadeItem = {
			id:			'style',
			face:		() => svgFace(menuIcons.style),
			caption:	() => `Style: ${this.styleChoice} (click to apply; the first use fetches a neural network, and takes a moment)`,
			select:		() => this.run(`style:${this.styleChoice}`),
			// each style is its own strength control: scrolled over or dragged along its presets it takes the strength, clicked it applies
			children:	() => styles.map((name): CascadeItem => ({
				...sliderItem({
					id:			`style:${name}`,
					label: 		name,
					caption: 	`${name} strength`, min: 0, max: 100,
					get: () => this.styleStrength[name], set: v => { this.styleStrength[name] = v; this.styleChoice = name; showStyle(name); },
					step: (v, n) => Math.min(100, Math.max(0, v + 5 * n)), markers: 5,
				}),
				//caption:	() => `${name[0].toUpperCase()}${name.slice(1).replace('-', ' ')} style at ${this.styleStrength[name]}% (scroll or drag to change, click to apply)`,
				hover:		on => { if (on) { this.styleChoice = name; showStyle(name); } else this.endEffect(); },
				select:		() => { this.styleChoice = name; return this.run(`style:${name}`); },
			})).concat(
				// the styles taken from pictures, each of which the wheel makes finer or bolder, and then where more can come from
				this.customStyles.map((c): CascadeItem => ({
					...valueItem({
						id: `custom:${c.id}`, label: '%', caption: `${c.name}: its marks as big as at`, min: 10, max: 400,
						get: () => c.scale, set: v => { c.scale = v; showCustom(c); },
						step: multiplicativeStep(), presets: scalePresets,
					}),
					face:		() => c.face,
					caption:	() => `${c.name}: a style from that picture, its marks as big as they are at ${c.scale}% of this one's size (scroll or drag for finer or bolder, click to apply)`,
					hover:		on => on ? showCustom(c) : this.endEffect(),
					select:		() => this.run(`custom:${c.id}`),
					children:	() => scalePresets.map(n => ({
						id:			`${n}%`,
						face:		() => valueFace('', `${n}%`),
						caption:	() => `${c.name} with its marks as big as at ${n}% (${n < 100 ? 'finer' : n > 100 ? 'bolder' : 'as it is'})`,
						hover:		(on: boolean) => on ? showCustom(c, n) : this.endEffect(),
						select:		() => { c.scale = n; return this.run(`custom:${c.id}`); },
					})),
				})),
				{
					id:			'addStyle',
					face:		() => svgFace(menuIcons.styleAdd),
					caption:	() => 'Custom style: take a style from a picture file (the first use fetches a neural network, and takes a moment)',
					select:		() => this.run('addStyle'),
				},
				...this.host.layerPictures?.().length ? [{
					id:			'styleLayer',
					face:		() => svgFace(menuIcons.styleLayer),
					caption:	() => 'Custom style from a layer',
					children:	() => (this.host.layerPictures?.() ?? []).map(({name}, i): CascadeItem => ({
						id:			`styleLayer:${i}`,
						face:		() => valueFace('', name.slice(0, 6)),
						caption:	() => `Take a style from ${name}`,
						select:		() => this.run(`styleLayer:${i}`),
					})),
				}] : [],
			),
		};
		const previewFlatten = (colours = this.flatColours) => this.previewEffect(`flatten:${colours}`, crop => this.flattened(crop, colours));

		const flatItem: CascadeItem = {
			...valueItem({
				label: 'colours', caption: 'Colours to flatten to', min: 2, max: 64,
				get: () => this.flatColours, set: v => { this.flatColours = v; previewFlatten(); },
				step: multiplicativeStep(), presets: flatPresets,
			}),
			id:			'flatten',
			face:		() => svgFace(menuIcons.flatten),
			caption:	() => `Flatten to ${this.flatColours} colours, which makes simple vector shapes (scroll or drag to change)`,
			select:		() => this.run('flatten'),
			hover:		on => { if (on) previewFlatten(); else this.endEffect(); },
			children:	() => flatPresets.map(n => ({
				face:		() => valueFace('', String(n)),
				caption:	() => `Flatten to ${n} colours`,
				hover:		(on: boolean) => on ? previewFlatten(n) : this.endEffect(),
				select:		() => { this.flatColours = n; return this.run('flatten'); },
			})),
		};
		const inkPresets = [4, 8, 12, 20, 32];
		const previewInk = (contrast = this.inkContrast) => this.previewEffect(`ink:${contrast}`, crop => this.inked(crop, contrast));
		const inkItem: CascadeItem = {
			...valueItem({
				id: 'ink', label: 'ink', caption: 'Ink lines: how much darker than its surroundings a pixel must be', min: 2, max: 60,
				get: () => this.inkContrast, set: v => { this.inkContrast = v; previewInk(); },
				step: multiplicativeStep(), presets: inkPresets,
			}),
			face:		() => svgFace(menuIcons.ink),
			caption:	() => `Ink lines where pixels are ${this.inkContrast} levels darker than round them (scroll or drag to change; lower finds more lines)`,
			select:		() => this.run('ink'),
			hover:		on => { if (on) previewInk(); else this.endEffect(); },
			children:	() => inkPresets.map(n => ({
				face:		() => valueFace('', String(n)),
				caption:	() => `Ink lines at ${n} levels`,
				hover:		(on: boolean) => on ? previewInk(n) : this.endEffect(),
				select:		() => { this.inkContrast = n; return this.run('ink'); },
			})),
		};
		const gradientPresets = [4, 8, 12, 20, 32];
		const previewGradients = (tolerance = this.gradientTolerance) => this.previewEffect(`gradients:${tolerance}`, crop => this.gradients(crop, tolerance));
		const gradientItem: CascadeItem = {
			...valueItem({
				id: 'gradients', label: 'tol', caption: 'Gradient regions: how far colours may stray from a gradient', min: 2, max: 60,
				get: () => this.gradientTolerance, set: v => { this.gradientTolerance = v; previewGradients(); },
				step: multiplicativeStep(), presets: gradientPresets,
			}),
			face:		() => svgFace(menuIcons.gradients),
			caption:	() => `Gradients: smooth regions each with a linear gradient, within ${this.gradientTolerance} levels (scroll or drag to change)`,
			select:		() => this.run('gradients'),
			hover:		on => { if (on) previewGradients(); else this.endEffect(); },
			children:	() => gradientPresets.map(n => ({
				face:		() => valueFace('', String(n)),
				caption:	() => `Gradient regions within ${n} levels`,
				hover:		(on: boolean) => on ? previewGradients(n) : this.endEffect(),
				select:		() => { this.gradientTolerance = n; return this.run('gradients'); },
			})),
		};
		const traceKinds = [
			{value: 'shapes' as const,	icon: menuIcons.gradients,	caption: `Shapes with linear gradients, within ${this.gradientTolerance} levels`},
			{value: 'lines' as const,	icon: menuIcons.ink,		caption: `Ink lines as strokes, at ${this.inkContrast} levels`},
			{value: 'both' as const,	icon: menuIcons.trace,		caption: 'Shapes with ink lines over them'},
		];
		// tracing, to a file or to layers, as one of its kinds, which is kept for the next
		const traceItem = (id: string, icon: string, label: string, where: string): CascadeItem => ({
			id,
			face:		() => svgFace(icon),
			caption:	() => `${label}: the picture (or selection) as ${traceKinds.find(k => k.value === this.traceKind)!.caption.toLowerCase()}, ${where}`,
			select:		() => this.run(id),
			children:	() => traceKinds.map(k => ({
				id:			k.value,
				face:		() => svgFace(k.icon),
				caption:	() => `${label} as ${k.caption.toLowerCase()}`,
				active:		() => this.traceKind === k.value,
				select:		() => { this.traceKind = k.value; return this.run(id); },
			})),
		});
		// all the filters, under one icon
		const filters: CascadeItem = {
			id:			'filters',
			face:		() => svgFace(menuIcons.filters),
			caption:	() => 'Filters',
			children:	() => [
				blurItem,
				sharpenItem,
				levelsItem,
				boxItem,
				convolution('emboss', menuIcons.emboss, 'Emboss'),
				convolution('edges', menuIcons.edges, 'Detect edges'),
				styleItem,
				flatItem,
				gradientItem,
				inkItem,
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
		const contiguous = toggleItem('Contiguous', svgFace(menuIcons.contiguous), () => this.contiguous, v => this.contiguous = v);
		const shapeFill = choiceItem('Shape', [
			{value: 'fill' as const,	face: svgFace(menuIcons.filled),	caption: 'Filled'},
			{value: 'stroke' as const,	face: svgFace(menuIcons.outline),	caption: 'Outline'},
			{value: 'both' as const,	face: svgFace(menuIcons.both),		caption: 'Filled and outlined'},
		], () => this.shapeFill, v => this.shapeFill = v);
		const aligned: CascadeItem = {
			...toggleItem('Aligned', svgFace(menuIcons.aligned), () => this.aligned, v => {
				this.aligned = v;
			//	if (this.stamp)
			//		this.stamp.offset = undefined;
				this.draw();
			}),
			id: 'aligned',
		};
		const sample: CascadeItem = {
			...choiceItem('Sample', [
				{value: 'oneLayer' as const,	face: svgFace(menuIcons.oneLayer),	caption: 'The layer Alt-clicked on'},
				{value: 'allLayers' as const,	face: svgFace(menuIcons.allLayers),	caption: 'All layers'},
			], () => this.sample, v => this.sample = v),
			id: 'sample',
		};

		const selectModes = choiceItem('Selection', [
			{value: 'replace' as const,		face: svgFace(menuIcons.selectNew),	caption: 'New selection'},
			{value: 'add' as const,			face: svgFace(menuIcons.selectAdd),	caption: 'Add to selection (Shift)'},
			{value: 'subtract' as const,	face: svgFace(menuIcons.selectSub),	caption: 'Subtract from selection (Alt)'},
			{value: 'intersect' as const,	face: svgFace(menuIcons.selectInt),	caption: 'Intersect with selection (Shift+Alt)'},
		], () => this.selectMode, v => this.selectMode = v);

		const options: Partial<Record<Tool, CascadeItem[]>> = {
			marquee:			[selectModes],
			'ellipse-marquee':	[selectModes],
			lasso:				[selectModes],
			'polygon-lasso':	[selectModes],
			wand:				[tolerance, contiguous, selectModes],
			segment:			[selectModes],
			brush:				[size, hardness, opacity],
			pencil:				[size, opacity],
			eraser:				[size, hardness, opacity],
			stamp:				[size, hardness, opacity, aligned, sample],
			bucket:				[tolerance, contiguous, opacity],
			gradient:			[opacity],
			line:				[size, opacity],
			rect:				[shapeFill, size, opacity],
			ellipse:			[shapeFill, size, opacity],
		};
		const tool = (t: Tool): CascadeItem => ({
			id:			t,
			face:		() => svgFace(toolInfo[t].icon),
			caption:	() => {
				const info  = toolInfo[t];
				return info.label + (info.key ? ` (${info.key.toUpperCase()})` : '') + (info.hint ? `: ${info.hint}` : '');
			},
			active:		() => this.tool === t,
			select:		() => this.setTool(t),
			children:	options[t] && (() => options[t]!),
		});
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
				modifier('growSelection', menuIcons.growSelection, 'Grow Selection'),
				modifier('shrinkSelection', menuIcons.shrinkSelection, 'Shrink Selection'),
				modifier('borderSelection', menuIcons.borderSelection, 'Border Selection'),
				modifier('smoothSelection', menuIcons.smoothSelection, 'Smooth Selection'),
				modifier('featherSelection', menuIcons.featherSelection, 'Feather Selection'),
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
		const image = this.host.target();
		if (!this.active || !image || this.suspended || this.aside)
			return false;
		if (op.startsWith('custom:')) {
			const c = this.customStyles.find(c => `custom:${c.id}` === op);
			return !!c && (this.applyEffect('Style', `custom:${c.id}:${c.scale}`, crop => styleFrom(crop, c.image, c.scale / 100)), true);
		}
		if (op.startsWith('styleLayer:')) {
			const layer = this.host.layerPictures?.()[Number(op.slice(11))];
			return !!layer && (this.addStyle(layer.name, layer.image), true);
		}
		if (op === 'addStyle')
			return this.addStyleFromFile(), true;
				if (op.startsWith('style:')) {
			const style = op.slice(6) as Style;
			return this.applyEffect('Style', `style:${style}`, crop => stylise(crop, style), this.styleStrength[style] / 100), true;
		}
		switch (op) {
			case 'fill':				return this.fillSelection(this.fg, 'Fill'), true;
			case 'clear':				return this.clearSelection(), true;
			case 'invert':				return this.invert(), true;
			case 'blur':				return this.filter('blur', 'Blur'), true;
			case 'sharpen':				return this.filter('sharpen', 'Sharpen'), true;
			case 'levels':				return this.filter('levels', 'Levels'), true;
			case 'boxBlur':				return this.filter('boxBlur', 'Box Blur'), true;
			case 'emboss':				return this.filter('emboss', 'Emboss'), true;
			case 'edges':				return this.filter('edges', 'Detect Edges'), true;
			case 'removeObject':		return this.removeObject(), true;
			case 'gradients':			return this.applyEffect('Gradients', `gradients:${this.gradientTolerance}`, crop => this.gradients(crop, this.gradientTolerance)), true;
			case 'ink':					return this.applyEffect('Ink', `ink:${this.inkContrast}`, crop => this.inked(crop, this.inkContrast)), true;
			case 'traceSvg':			return this.traceSvg(), true;
			case 'traceLayers':			return this.traceLayers(), true;
			case 'flatten':				return this.applyEffect('Flatten', `flatten:${this.flatColours}`, crop => this.flattened(crop, this.flatColours)), true;
			case 'selectAll':			return this.select(Selection.all(imageSize(image)), 'Select All'), true;
			case 'deselect':			return this.select(undefined, 'Deselect'), true;
			case 'invertSelection':		return this.select(this.selection ? this.selection.invert(imageSize(image)) : Selection.all(imageSize(image)), 'Invert Selection'), true;
			case 'growSelection':
			case 'shrinkSelection':
			case 'borderSelection':
			case 'smoothSelection':
			case 'featherSelection':	return !!this.selection && (this.select(this.modified(op, this.modifyBy[op]), op.replace('Selection', ' Selection').replace(/^./, c => c.toUpperCase())), true);
			default:					return false;
		}
	}

	// the selection as a modifier, of so many pixels, would leave it
	private modified(op: keyof Painter['modifyBy'], n: number) {
		const sel = this.selection!, size = imageSize(this.host.target()!);
		switch (op) {
			case 'growSelection':	return sel.growClamp(n, size);
			case 'shrinkSelection':	return sel.growClamp(-n, size);
			case 'borderSelection':	return sel.border(n, size);
			case 'smoothSelection':	return sel.smooth(n, size, this.maskBlur);
			default:				return sel.feather(n, size, this.maskBlur);
		}
	}

	// show what a modifier would do, with the amount it has (or one that is being considered); nothing stops it
	private previewModifier(op: keyof Painter['modifyBy'] | undefined, amount?: number) {
		this.preview = op && this.active && this.selection && this.host.target() ? this.modified(op, amount ?? this.modifyBy[op]) : undefined;
		this.draw();
	}

	// the selection becomes this, which is an undoable edit (as in Photoshop) unless nothing changes
	select(s: Selection | undefined, label = 'Select') {
		const before = this.selection;
		this.draft = this.corners = this.preview = undefined;
		if (s === before) {
			this.draw();
			return;
		}
		const set = (v: Selection | undefined) => () => {
			this.selected = v;
			this.draft = this.corners = this.preview = undefined;
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
	selectCurve(curve: Parameters<typeof Selection.curve>[0], mode: SelectMode = 'replace') {
		const image = this.host.target();
		if (image)
			this.join(Selection.curve(curve, imageSize(image)), mode);
	}

	private modeFor(e: {shiftKey: boolean, altKey: boolean}): SelectMode {
		return e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : this.selectMode;
	}

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
		const made: {image: Pixels<4>, patch: Patch}[] = [];
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
		this.commitAll([op], label);
	}

	private operation(blend: Blend = 'paint', image = this.host.target()!, selection = this.selection) {
		const op = new Operation(image, selection);
		op.opacity	= this.opacity;
		op.colour	= this.fg;
		op.blend	= blend;
		return op;
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
		if (!this.host.target())
			return;
		const op = this.operation();
		op.colour = colour;
		fillArea(op);
		this.flush(op);
		this.commit(op, label);
	}

	private clearSelection() {
		if (!this.host.target())
			return;
		const op = this.operation('erase');
		op.opacity = 1;
		fillArea(op);
		this.flush(op);
		this.commit(op, 'Clear');
	}

	// fill the selection with what the picture round it suggests (by a neural network, so after a moment)
	private removeObject() {
		const image = this.host.target(), selection = this.selection;
		if (!image || !selection)
			return;
		removeObject(image, selection).then(found => {
			if (!found)
				return;
			const op = this.operation('replace', image, selection);
			op.opacity = 1;
			op.replace(found.area, found.pixels);
			this.flush(op);
			this.commit(op, 'Remove Object');
		});
	}

	// The part of the picture an effect (a style, Flatten) is for: the selection's bounds, or the layer
	private region(): Region | undefined {
		const image = this.host.target(), selection = this.selection;
		if (!image)
			return;
		const bounds = selection ? selection.bounds() : imageRect(image);
		const x0 = Math.max(0, Math.floor(bounds.min.x)), y0 = Math.max(0, Math.floor(bounds.min.y));
		const w = Math.min(image.width, Math.ceil(bounds.max.x)) - x0, h = Math.min(image.height, Math.ceil(bounds.max.y)) - y0;
		if (w > 0 && h > 0)
			return {image, selection, x0, y0, w, h, id: `${x0},${y0},${w},${h}`};
	}

	// what an effect makes of the region at full strength, kept (while the same region is being looked at) for the other strengths
	private async effectOf(r: Region, key: string, make: (crop: Pixels<4>) => Pixels<4> | undefined | Promise<Pixels<4> | undefined>) {
		let fx = this.effects;
		if (fx?.image !== r.image || fx.region !== r.id)
			this.effects = fx = {image: r.image, region: r.id, made: new Map(),
				crop: crop(r.image, new float2.extent(float2(r.x0, r.y0), float2(r.x0 + r.w, r.y0 + r.h)))};
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

	// the effect shown on the picture, at this strength, as an unmade edit (the filter previews' own, so showing another or ending it takes it away)
	private showEffect(r: Region, made: {crop: Pixels<4>, full: Pixels<4>}, strength: number) {
		const op = this.blurring;
		if (op) {
			op.reset();
			this.flush(op);
		}
		const next = op ?? this.operation('replace', r.image, r.selection);
		next.opacity = 1;
		next.replace(new float2.extent(float2(r.x0, r.y0), float2(r.x0 + r.w, r.y0 + r.h)), strength < 1 ? mixed(made.crop, made.full, strength) : made.full);
		this.flush(next);
		this.blurring = next;
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
			const op = this.showEffect(r, made, strength);
			this.blurring = undefined;
			this.effects = undefined;
			this.commit(op, label);
		}).finally(() => this.applying--);
	}

	private invert() {
		if (!this.host.target())
			return;
		const op = this.operation();
		op.opacity = 1;
		invertArea(op);
		this.flush(op);
		this.commit(op, 'Invert');
	}

	// the selection, or the whole layer, filtered: the selection's soft edge is how much of the filter a pixel takes
	private filter(kind: FilterKind, label: string) {
		if (this.previewFrame !== undefined) {
			cancelAnimationFrame(this.previewFrame);
			this.previewFrame = undefined;
		}
		if (this.blurring) {
			// as it was previewed, at the settings it was left with
			this.showFilter(kind);
			const op = this.blurring;
			this.blurring = undefined;
			this.commit(op, label);
			return;
		}
		const op = this.filterOperation(kind);
		if (op)
			this.commit(op, label);
	}

	// a picture reduced to a few colours, on the GPU (nothing where there is none)
	private flattened(image: Pixels<4>, colours: number) {
		return working('Flattening', () => flattenWith((img, passes, reach) => Mode.shade('flatten', img, imageRect(img), passes, reach) as Pixels<4> | undefined, image, colours));
	}

	// the picture (or the selection's bounds) traced as gradient regions and ink lines (as traceKind has it), in its pixels
	private async traced(r: Region) {
		const part = crop(r.image, new float2.extent(float2(r.x0, r.y0), float2(r.x0 + r.w, r.y0 + r.h)));
		const kind = this.traceKind;
		return working('Tracing', progress => traceWith(part, (runs, closed) => fitRuns(runs, closed, 0.75),
			kind !== 'lines' ? {run: (img, passes, reach) => Mode.shade('flatten', img, imageRect(img), passes, reach) as Pixels<4> | undefined, tolerance: this.gradientTolerance} : undefined,
			kind !== 'shapes' ? {run: (img, passes, reach) => Mode.shade('ink', img, imageRect(img), passes, reach) as Pixels<4> | undefined, contrast: this.inkContrast} : undefined,
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
		this.customStyles.push({id: this.nextStyle++, name, image, face, scale: 100});
	}

	// a picture file the user chooses, taken as a style
	private async addStyleFromFile() {
		const file = await RPC<{name: string, data: ArrayBuffer} | undefined>({command: 'pickImage'});
		if (!file)
			return;
		try {
			const bitmap = await createImageBitmap(new Blob([file.data]));
			const ctx = createElement('canvas', {width: bitmap.width, height: bitmap.height}).getContext('2d')!;
			ctx.drawImage(bitmap, 0, 0);
			const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
			this.addStyle(file.name, Pixels(data.data, data.width, data.height, 4));
		} catch {
			postMessage({command: 'error', message: `${file.name} could not be read as a picture.`});
		}
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
		const at = (p: {x: number, y: number}) => ({x: p.x + r.x0, y: p.y + r.y0});
		const moved = (curve: curveVertex[]) => curve.map(v => curveVertex(v.x + r.x0, v.y + r.y0, v.flags));
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

	// a picture as ink lines on white, on the GPU (nothing where there is none)
	private inked(image: Pixels<4>, contrast: number) {
		return inkWith((img, passes, reach) => Mode.shade('ink', img, imageRect(img), passes, reach) as Pixels<4> | undefined, image, contrast);
	}

	// a picture reduced to smooth regions with a linear gradient each, the GPU smoothing it first (nothing where there is none)
	private gradients(image: Pixels<4>, tolerance: number) {
		return working('Finding gradients', () => gradientsWith((img, passes, reach) => Mode.shade('flatten', img, imageRect(img), passes, reach) as Pixels<4> | undefined, image, tolerance));
	}

	// a mask (one value a pixel, 0..255, zero beyond its edges) blurred in place, on the GPU, as bytes (which a selection's coverage
	// is, and which can be drawn into where floats cannot); left as it is where there is no GPU
	private maskBlur = (f: Float32Array, width: number, height: number, sigma: number) => {
		const image = Pixels(Uint8ClampedArray.from(f), width, height, 1), blurred = this.blurred(image, imageRect(image), sigma, 0, 'zero');
		if (blurred)
			f.set(blurred.data);
	};

	// an area of an image blurred, or sharpened by an unsharp mask of this radius, on the GPU; nothing where there is none
	private blurred(image: Pixels, area: float2.extent, radius: number, sharpen = 0, edge: 'zero' | 'clamp' = 'clamp') {
		return blurWith((passes, reach) => Mode.shade('blur', image, area, passes, reach), image, radius, edge, sharpen);
	}

	// the filter as the settings (or those given instead) have it, on an area of an image
	private filtered(kind: FilterKind, image: Pixels, area: float2.extent, using: FilterUsing = {}) {
		switch (kind) {
			case 'blur': {
				const radius = using.blurRadius ?? this.blurRadius;
				return this.blurred(image, area, radius);
			}
			case 'sharpen': {
				const radius = using.sharpenRadius ?? this.sharpenRadius;
				return this.blurred(image, area, radius, 1);
			}
			case 'boxBlur':
			case 'emboss':
			case 'edges': {
				const kernel = kind === 'boxBlur' ? boxKernel(using.boxSize ?? this.boxSize) : kind === 'emboss' ? embossKernel : edgeKernel;
				return Mode.shade('convolve', image, area, kernelUniforms(kernel), kernel.size >> 1);
			}
			case 'levels':
				return Mode.shade('levels', image, area, levelsUniforms(this.levels)) ?? levelsPixels(image, area, this.levels);
		}
	}

	// the operation which has filtered the selection (or layer), if there was anything to filter
	private filterOperation(kind: FilterKind, op = this.operation(), using?: FilterUsing) {
		const image = op.image;
		const area = op.bounds();
		if (area.empty())
			return;
		op.blend = 'replace';
		op.opacity = 1;
		const result = this.filtered(kind, image, area, using) as Pixels<4> | undefined;	// (a picture's pixels in, so a picture's out)
		if (!result)
			return;		// (no GPU to do it)
		op.replace(area, result);
		this.flush(op);
		return op;
	}

	// Show the filter on the picture without making an edit, or (without one) take it away. A filter of a big picture takes a while,
	// so the showing waits for the next frame, and what is asked for in the meantime (the wheel turning, a value dragged) is
	// only shown as it stands then.
	private previewFilter(kind?: FilterKind, using?: FilterUsing) {
		if (this.previewFrame !== undefined) {
			cancelAnimationFrame(this.previewFrame);
			this.previewFrame = undefined;
		}
		if (kind === undefined || !this.host.target()) {
			this.showFilter();
			return;
		}
		this.previewFrame = requestAnimationFrame(() => {
			this.previewFrame = undefined;
			this.showFilter(kind, using);
		});
	}

	// the preview as it is asked for, at once
	private showFilter(kind?: FilterKind, using?: FilterUsing) {
		const op = this.blurring;
		if (op) {
			op.reset();
			this.flush(op);
		}
		if (kind === undefined || !this.host.target()) {
			this.blurring = undefined;
			return;
		}
		this.blurring = this.filterOperation(kind, op ?? this.operation(), using);
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

		const start = this.host.toImage(event.clientX, event.clientY);

		// (every point the pointer passed through, not just where it is when the frame is drawn)
		let drag: Drag | true = true;
		const track = (move: (e: PointerEvent, p: float2) => void, up: (e: PointerEvent) => void) => {
			drag = {coalesced: true, move: e => move(e, this.pointer = this.host.toImage(e.clientX, e.clientY)), end: up};
		};

		switch (this.tool) {
			case 'brush':
			case 'pencil':
			case 'eraser': {
				// (a stroke may go on to other surfaces of the picture, each with an operation of its own: the selection is of the first)
				const blend = this.tool === 'eraser' ? 'erase' : 'paint';
				const ops = new Map<Pixels<4>, Operation>();
				const opOn = (on: Pixels<4>) => {
					let o = ops.get(on);
					if (!o)
						ops.set(on, o = this.operation(blend, on, on === image ? this.selection : undefined));
					return o;
				};
				let op = opOn(image);
				let last = start;
				const segment = (o: Operation, a: float2, b: float2, size: number) => {
					if (this.tool === 'pencil')
						pencilSegment(o, a.x, a.y, b.x, b.y, size);
					else
						brushSegment(o, a.x, a.y, b.x, b.y, size, this.hardness);
				};
				const stroke = (to: float2) => {
					segment(op, last, to, this.size);
					for (const s of this.host.adjoining?.(last, to, this.size) ?? [])
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
					this.stamp = this.host.cloneSource?.(start, this.sample === 'allLayers');
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
				const offset	= stamp.offset ??= float2(Math.round(stamp.at.x - start.x), Math.round(stamp.at.y - start.y));
				const colour	= (x: number, y: number) => asRGBA(getPixel(from, x + offset.x, y + offset.y));
				const op		= this.operation();
				let last = start;
				const stroke = (to: float2) => {
					brushSegment(op, last.x, last.y, to.x, to.y, this.size, this.hardness, colour);
					last = to;
					this.flush(op);
				};
				stroke(start);
				track((_, p) => stroke(p), () => {
					//if (!this.aligned)
					//	stamp.offset = undefined;
					this.commit(op, toolInfo.stamp.label);
					this.draw();
				});
				break;
			}

			case 'line':
			case 'rect':
			case 'ellipse':
			case 'gradient': {
				const op = this.operation();
				const tool = this.tool;
				// (a gradient covers all it can, so the GPU shows it as it is dragged, and its pixels are worked out once, when it is let go)
				const selected = op.selection, m = selected?.mask, mask = m && Pixels(new Uint8ClampedArray(m.buffer as ArrayBuffer, m.byteOffset, m.length), selected.width, selected.height, 1);
				const preview = tool === 'gradient' ? previewShade(this.host, op.image, 'gradient', mask ? [mask] : []) : undefined;
				let end = start;
				let shift = false, alt = false, frame: number | undefined;
				// where it goes from and to
				const ends = (): [number, number, number, number] => {
					let {x, y} = end;
					let x0 = start.x, y0 = start.y;
					if (shift) {
						if (tool === 'line' || tool === 'gradient') {
							// to the nearest multiple of 45 degrees
							const a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * Math.PI / 4;
							const d = Math.hypot(x - x0, y - y0);
							x = x0 + Math.cos(a) * d;
							y = y0 + Math.sin(a) * d;
						} else {
							const d = Math.max(Math.abs(x - x0), Math.abs(y - y0));
							x = x0 + Math.sign(x - x0 || 1) * d;
							y = y0 + Math.sign(y - y0 || 1) * d;
						}
					}
					if (alt) {
						x0 = 2 * start.x - x;
						y0 = 2 * start.y - y;
					}
					return [x0, y0, x, y];
				};
				// (once a frame, however many moves there were)
				const render = () => {
					frame = undefined;
					const [x0, y0, x, y] = ends();
					if (preview) {
						const {fg, bg} = this, box = selected ?? imageRect(op.image);
						preview.show({
							u_selection: 1, u_selected: [box.min.x, box.min.y, box.max.x - box.min.x, box.max.y - box.min.y], u_masked: mask ? 1 : 0,
							u_line: [x0, y0, x - x0, y - y0], u_from: [fg.r / 255, fg.g / 255, fg.b / 255, fg.a / 255], u_to: [bg.r / 255, bg.g / 255, bg.b / 255, bg.a / 255],
							u_opacity: op.opacity,
						});
						return;
					}
					op.reset();
					if (tool === 'gradient')
						drawGradient(op, x0, y0, x, y, this.fg, this.bg);
					else
						drawShape(op, tool as ShapeKind, x0, y0, x, y,
							this.size,
							tool === 'line' ? null : this.shapeFill === 'stroke' ? null : this.shapeFill === 'fill' ? this.fg : this.bg,
							tool === 'line' ? this.fg : this.shapeFill === 'fill' ? null : this.fg);
					this.flush(op);
				};
				track((e, p) => {
					end = p;
					shift = e.shiftKey;
					alt = e.altKey;
					frame ??= requestAnimationFrame(render);
				}, () => {
					if (frame !== undefined)
						cancelAnimationFrame(frame);
					if (preview) {
						drawGradient(op, ...ends(), this.fg, this.bg);
						op.take();			// (all the image is shown again as it ends)
						preview.end();
					} else {
						render();
					}
					this.commit(op, toolInfo[tool].label!);
				});
				break;
			}

			case 'bucket': {
				const op = this.operation();
				floodFill(op, Math.floor(start.x), Math.floor(start.y), this.tolerance, this.contiguous);
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
				const mode = this.modeFor(event);
				// a modifier held when the drag began chose the mode; it constrains or centres only once let go and pressed again
				let shiftFree = !event.shiftKey, altFree = !event.altKey;
				let box: float2.extent | undefined;
				track((e, p) => {
					shiftFree ||= !e.shiftKey;
					altFree ||= !e.altKey;
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
						this.join(round ? Selection.fromPolygons([ellipsePoints(box)], imageSize(image)) : Selection.rect(box), mode);
					else if (mode === 'replace')
						this.select(undefined);	// a click on its own deselects
					else
						this.draw();
				});
				break;
			}

			case 'lasso': {
				const mode = this.modeFor(event);
				const points = [start];
				const pixel = this.host.pixelSize();
				this.draft = points;
				track((_, p) => {
					const last = points[points.length - 1];
					if (Math.hypot(p.x - last.x, p.y - last.y) >= 2 * pixel)
						points.push(p);
					this.draw();
				}, () => {
					this.draft = undefined;
					if (points.length >= 3)
						this.join(Selection.fromPolygons([points], imageSize(image)), mode);
					else if (mode === 'replace')
						this.select(undefined);
					else
						this.draw();
				});
				break;
			}

			case 'polygon-lasso': {
				if (!this.corners) {
					this.corners = {points: [start], mode: this.modeFor(event)};
				} else {
					const pts = this.corners.points, pixel = this.host.pixelSize();
					const near = (q: float2) => Math.hypot(q.x - start.x, q.y - start.y) < 6 * pixel;
					if (near(pts[pts.length - 1]) || (pts.length >= 3 && near(pts[0])))
						this.finishCorners();
					else
						pts.push(start);
				}
				this.draw();
				break;
			}

			case 'wand': {
				this.join(Selection.wand(image, Math.floor(start.x), Math.floor(start.y), this.tolerance, this.contiguous), this.modeFor(event));
				break;
			}

			case 'segment': {
				const mode = this.modeFor(event);
				segment(image, Math.floor(start.x), Math.floor(start.y)).then(found => {
					if (found)
						this.join(found, mode);
				});
				break;
			}
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
			this.join(Selection.fromPolygons([c.points], imageSize(image)), c.mode);
		else if (c.mode === 'replace')
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
			this.size = Math.max(1, Math.min(200, Math.round(this.size * (e.key === ']' ? 1.2 : 1 / 1.2) + (e.key === ']' ? 1 : -1))));
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
		if (this.preview) {
			const loops = this.preview.outline();
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
			const r = Math.max(this.size / this.host.pixelSize() / 2, 2 * pixelRatio);
			const centre = screen(this.pointer!);
			outline(() => ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2));
		}

		// where the clone stamp copies from: what is under the pointer once a stroke has set how far away that is
		const stamp = this.tool === 'stamp' ? this.stamp : undefined;
		if (stamp) {
			const at = stamp.offset && this.pointer ? this.pointer.add(stamp.offset) : stamp.at;
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

class Tile extends float2.extent {
	before:	Uint8ClampedArray;	// the original pixels, packed
	cover:	Float32Array;		// the greatest coverage so far, per pixel
	constructor(image: Pixels<4>, r: float2.extent) {
		super(r.min, r.max.min(float2(image.width, image.height)));
		// packed at the width of the tile as it falls on the image, which is less than TILE at the right and bottom edges
		this.before = readRect(image, this);
		const {x: w, y: h} = this.size();
		this.cover = new Float32Array(w * h);
	 }
}

export class Tiles {
	protected tiles = new Map<number, Tile>();
	protected dirty: float2.extent | undefined;

	constructor(readonly image: Pixels<4>) {}

	protected tile(x: number, y: number) {
		const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
		const key = ty * 65536 + tx;
		let t = this.tiles.get(key);
		if (!t) {
			t = new Tile(this.image, new float2.extent(float2(tx, ty).scale(TILE), float2(tx + 1, ty + 1).scale(TILE)));
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

	// what changed, to undo or redo; nothing if nothing did
	commit(): Patch | undefined {
		const tiles: PatchTile[] = [];
		for (const t of this.tiles.values()) {
			const after = readRect(this.image, t);
			if (after.some((v, i) => v !== t.before[i]))
				tiles.push(new PatchTile(t, after));
		}
		return tiles.length ? {tiles} : undefined;
	}
}

export class PatchTile extends float2.extent {
	before:	Uint8ClampedArray;	// the original pixels, packed
	constructor(tile: Tile, public after:Uint8ClampedArray) {
		super(tile.min, tile.max);
		this.before = tile.before;
	}
}
export interface Patch {
	tiles: PatchTile[];
}

export function applyPatch(image: Pixels<4>, patch: Patch, which: 'before' | 'after') {
	let dirty: float2.extent | undefined;
	for (const t of patch.tiles) {
		writeRect(image, t, t[which]);
		dirty = unionRect(dirty, t);
	}
	return dirty;
}

// how a pixel takes its colour: composed over what was there, taking that away, or replacing it
type Blend = 'paint' | 'erase' | 'replace';

class Operation extends Tiles {
	opacity		= 1;
	colour		= RGBA(0, 0, 0, 255);
	blend:		Blend = 'paint';

	constructor(image: Pixels<4>, readonly selection?: Selection | null) { super(image); }

	// where anything can be drawn: the selection, inside the image
	bounds(): float2.extent {
		const ext = new float2.extent(float2(0, 0), float2(this.image.width, this.image.height));
		return this.selection ? ext.intersect(this.selection.bounds()) : ext;
	}

	// how much of a pixel the selection lets through
	private cover(x: number, y: number) {
		return this.selection ? this.selection.at(x, y) / 255 : 1;
	}

	// What put does for each pixel of `area` with the colours of `src` (the area's size, from its corner), the selection's coverage
	// the weight of each, as 'replace' at full opacity: all at once, as it is for a filter of a whole picture
	replace(area: float2.extent, src: Pixels<4>) {
		const {width, height, data: d} = this.image, s = src.data, sw = src.width, sel = this.selection;
		const a = area.intersect(new float2.extent(float2(0, 0), float2(width, height)));
		if (a.empty())
			return;
		for (let ty = Math.floor(a.min.y / TILE); ty * TILE < a.max.y; ty++) {
			for (let tx = Math.floor(a.min.x / TILE); tx * TILE < a.max.x; tx++) {
				const t = this.tile(tx * TILE, ty * TILE), tw = t.max.x - t.min.x, b = t.before, cover = t.cover;
				const x0 = Math.max(a.min.x, t.min.x), x1 = Math.min(a.max.x, t.max.x), y0 = Math.max(a.min.y, t.min.y), y1 = Math.min(a.max.y, t.max.y);
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						const c = sel ? sel.at(x, y) / 255 : 1, i = (y - t.min.y) * tw + (x - t.min.x);
						if (c <= 0 || c <= cover[i])
							continue;
						cover[i] = c;
						const o = (y * width + x) * 4, k = ((y - area.min.y) * sw + x - area.min.x) * 4, j = i * 4;
						if (c === 1) {
							d[o] = s[k]; d[o + 1] = s[k + 1]; d[o + 2] = s[k + 2]; d[o + 3] = s[k + 3];
						} else {
							d[o]		= Math.round(b[j]		+ (s[k]		- b[j])		* c);
							d[o + 1]	= Math.round(b[j + 1]	+ (s[k + 1]	- b[j + 1])	* c);
							d[o + 2]	= Math.round(b[j + 2]	+ (s[k + 2]	- b[j + 2])	* c);
							d[o + 3]	= Math.round(b[j + 3]	+ (s[k + 3]	- b[j + 3])	* c);
						}
					}
				}
			}
		}
		this.dirty = unionRect(this.dirty, a);
	}

	// give a pixel coverage `c` (0..1) of `colour`; a pixel only ever gains coverage until the operation is reset
	put(x: number, y: number, c: number, colour: RGBA = this.colour) {
		if (c <= 0 || x < 0 || y < 0 || x >= this.image.width || y >= this.image.height || c * this.cover(x, y) <= 0)
			return;
		c *= this.cover(x, y);

		const t		= this.tile(x, y);
		const i		= (y - t.min.y) * (t.max.x - t.min.x) + (x - t.min.x);
		if (c <= t.cover[i])
			return;
		t.cover[i]	= c;

		const a		= c * this.opacity * colour.a / 255;
		const b		= i * 4;
		const o		= (y * this.image.width + x) * 4;
		const d		= this.image.data;
		const dstA	= t.before[b + 3] / 255;

		if (this.blend === 'erase') {
			d[o + 0] = t.before[b + 0];
			d[o + 1] = t.before[b + 1];
			d[o + 2] = t.before[b + 2];
			d[o + 3] = Math.round(dstA * (1 - a) * 255);

		} else if (this.blend === 'replace') {
			d[o + 0] = Math.round(t.before[b + 0] + (colour.r - t.before[b + 0]) * c);
			d[o + 1] = Math.round(t.before[b + 1] + (colour.g - t.before[b + 1]) * c);
			d[o + 2] = Math.round(t.before[b + 2] + (colour.b - t.before[b + 2]) * c);
			d[o + 3] = Math.round(t.before[b + 3] + (colour.a - t.before[b + 3]) * c);

		} else {
			const outA = a + dstA * (1 - a);
			if (outA > 0) {
				const w = dstA * (1 - a);
				d[o + 0] = Math.round((colour.r * a + t.before[b + 0] * w) / outA);
				d[o + 1] = Math.round((colour.g * a + t.before[b + 1] * w) / outA);
				d[o + 2] = Math.round((colour.b * a + t.before[b + 2] * w) / outA);
			}
			d[o + 3] = Math.round(outA * 255);
		}

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
}

//-----------------------------------------------------------------------------
// brush and pencil
//-----------------------------------------------------------------------------

function segmentDistance(px: number, py: number, x0: number, y0: number, dx: number, dy: number, len2: number) {
	const t = len2 > 0 ? clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1) : 0;
	return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

function smooth(c: number) {
	return c * c * (3 - 2 * c);
}

// A soft round brush dragged from one point to the next: coverage depends only on the distance from the segment, so
// a stroke is even however the pointer moved. Hardness 1 is a hard edge (still antialiased); less than that fades
// from that fraction of the radius. It paints the operation's colour, or each pixel the colour `colour` gives it (none where
// it gives none).
function brushSegment(op: Operation, x0: number, y0: number, x1: number, y1: number, size: number, hardness: number, colour?: (x: number, y: number) => RGBA | undefined) {
	const r		= size / 2;
	const f		= Math.max(r * (1 - hardness), 1);
	const reach	= r + 1;
	const bb	= op.bounds();
	const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;

	const xa = Math.max(bb.min.x, Math.floor(Math.min(x0, x1) - reach)), xb = Math.min(bb.max.x, Math.ceil(Math.max(x0, x1) + reach));
	const ya = Math.max(bb.min.y, Math.floor(Math.min(y0, y1) - reach)), yb = Math.min(bb.max.y, Math.ceil(Math.max(y0, y1) + reach));
	for (let y = ya; y < yb; y++) {
		for (let x = xa; x < xb; x++) {
			const c = clamp((r + 0.5 - segmentDistance(x + 0.5, y + 0.5, x0, y0, dx, dy, len2)) / f, 0, 1);
			const k = c > 0 && colour ? colour(x, y) : op.colour;
			if (k)
				op.put(x, y, f > 1 ? smooth(c) : c, k);
		}
	}
}

// A hard, unantialiased square-ish dot of `size` pixels at every pixel the line from one point to the next passes through
function pencilSegment(op: Operation, x0: number, y0: number, x1: number, y1: number, size: number) {
	const r		= size / 2;
	const odd	= Math.round(size) % 2 === 1;
	// the dot's centre is a pixel's centre for an odd size, a pixel corner for an even one
	const dot = (cx: number, cy: number) => {
		for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
			for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
				if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 1e-6)
					op.put(x, y, 1);
	};

	// Bresenham over the pixels
	let ix = Math.floor(x0), iy = Math.floor(y0);
	const ex = Math.floor(x1), ey = Math.floor(y1);
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
const overlap = (p: number, a: number, b: number) => clamp(Math.min(p + 1, b) - Math.max(p, a), 0, 1);

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
	return clamp(0.5 - (k1 === 0 ? -Math.min(rx, ry) : k0 * (k0 - 1) / k1), 0, 1);
}

// A shape dragged out from one corner to the other (a line goes between the two points, with `width`).
// The outline is `width` wide inside the shape. `fill` and `stroke` are the colours to use, or null for none.
function drawShape(op: Operation, kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, width: number, fill: RGBA | null, stroke: RGBA | null) {
	if (kind === 'line') {
		op.colour = stroke ?? fill ?? op.colour;
		brushSegment(op, x0, y0, x1, y1, width, 1);
		return;
	}

	// whole pixels, taking in the one under each end
	const l = Math.floor(Math.min(x0, x1)), t = Math.floor(Math.min(y0, y1));
	const r = Math.floor(Math.max(x0, x1)) + 1, b = Math.floor(Math.max(y0, y1)) + 1;
	const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
	const w = stroke ? Math.max(1, width) : 0;

	const bb = op.bounds();
	for (let y = Math.max(bb.min.y, t - 1); y < Math.min(bb.max.y, b + 1); y++) {
		for (let x = Math.max(bb.min.x, l - 1); x < Math.min(bb.max.x, r + 1); x++) {
			let outer: number, inner = 0;
			if (kind === 'rect') {
				outer = overlap(x, l, r) * overlap(y, t, b);
				if (w)
					inner = r - l > 2 * w && b - t > 2 * w ? overlap(x, l + w, r - w) * overlap(y, t + w, b - w) : 0;
			} else {
				outer = ellipseCover(x, y, cx, cy, rx, ry);
				if (w)
					inner = ellipseCover(x, y, cx, cy, rx - w, ry - w);
			}

			const fa = fill ? outer * fill.a / 255 : 0;
			const sa = stroke ? clamp(outer - inner, 0, 1) * stroke.a / 255 : 0;
			const a = sa + fa * (1 - sa);
			if (a <= 0)
				continue;
			const f = fill ?? stroke!, s = stroke ?? fill!;
			const k = fa * (1 - sa);
			op.put(x, y, 1, RGBA(
				(s.r * sa + f.r * k) / a,
				(s.g * sa + f.g * k) / a,
				(s.b * sa + f.b * k) / a,
				a * 255,
			));
		}
	}
}

// a linear gradient from one colour at the first point to another at the second, over everything the operation may draw on
function drawGradient(op: Operation, x0: number, y0: number, x1: number, y1: number, c0: RGBA, c1: RGBA) {
	const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
	if (len2 === 0)
		return;
	const bb = op.bounds();
	for (let y = bb.min.y; y < bb.max.y; y++) {
		for (let x = bb.min.x; x < bb.max.x; x++) {
			const t = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2, 0, 1);
			op.put(x, y, 1, RGBA(
				c0.r + (c1.r - c0.r) * t,
				c0.g + (c1.g - c0.g) * t,
				c0.b + (c1.b - c0.b) * t,
				c0.a + (c1.a - c0.a) * t,
			));
		}
	}
}

//-----------------------------------------------------------------------------
// bucket
//-----------------------------------------------------------------------------

// Paint every pixel that is within `tolerance` of the one at (sx, sy): those connected to it (not crossing the selection's
// edge), or all of them
function floodFill(op: Operation, sx: number, sy: number, tolerance: number, contiguous: boolean) {
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

// the colour of the operation, everywhere it may draw
function fillArea(op: Operation) {
	const bb = op.bounds();
	for (let y = bb.min.y; y < bb.max.y; y++)
		for (let x = bb.min.x; x < bb.max.x; x++)
			op.put(x, y, 1);
}

function invertArea(op: Operation) {
	const {data: data, width} = op.image;
	const bb = op.bounds();
	op.blend = 'replace';
	for (let y = bb.min.y; y < bb.max.y; y++) {
		for (let x = bb.min.x; x < bb.max.x; x++) {
			const o = (y * width + x) * 4;
			op.put(x, y, 1, RGBA(255 - data[o], 255 - data[o + 1], 255 - data[o + 2], data[o + 3]));
		}
	}
}
