// The bitmap editor's tools, chosen with their options from the menu the right button brings up (cascade.ts), the selection,
// and undo history.
// The pixels themselves are changed by edit.ts; this turns pointer and key events into those changes.

import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import type { Layer, LayerOp } from './layers.js';
import { Tiles, Pixels, Patch, applyPatch, RGBA, warpCPU, imageSize, imageRect } from './raster.js';
import { applyH } from './transformbox.js';
import { TransformMode, TransformPart, HANDLE, partAt, transformCursor, dragMode, dragQuad, boxHandles, transformIcons } from './transformbox.js';
import { float2, float3, float3x3 } from '@isopodlabs/maths/vector';
import { Selection, ellipsePoints } from './bitmapSelection.js';
import { Cascade, CascadeItem, svgFace, swatchFace, valueItem, choiceItem, toggleItem, multiplicativeStep } from './cascade.js';

// the whole-image operations, which the extension offers in the editor's title menu
export type EditOp	= 'fill' | 'clear' | 'invert' | 'flipHorizontal' | 'flipVertical' | 'rotateClockwise' | 'rotateAnticlockwise' | 'crop' | 'selectAll' | 'deselect' | 'invertSelection'
	| 'toCubemap';	// (not the tools': the image made into a cubemap, if it is laid out as one, or square, for the same on every face)
export type Tool	= 'hand' | 'marquee' | 'ellipse-marquee' | 'lasso' | 'polygon-lasso' | 'wand' | 'brush' | 'pencil' | 'eraser' | 'bucket' | 'gradient' | 'eyedropper' | 'line' | 'rect' | 'ellipse' | 'transform';

export type ShapeKind = 'line' | 'rect' | 'ellipse';
export type ShapeFill = 'stroke' | 'fill' | 'both';
export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

// what a transform is of: the current layer (or the picture, within its canvas, if it has none), or the whole document
export type TransformTarget = 'layer' | 'image';
export type { TransformMode };

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

// what the editor needs of the viewer it is part of
export interface PaintHost {
	canvas:			HTMLCanvasElement;
	target():									Pixels | undefined;	// what the tools draw on: the current layer's pixels (which cover the canvas), or the picture if there is none
	pick(x: number, y: number):				RGBA | undefined;	// the colour seen at a pixel of the picture (of the current layer, if it is on it)
	toScreen(p: float2):						float2;				// a point of the image, in canvas pixels
	pixelSize():								number;				// how long a canvas pixel is, in the image's pixels
	toImage(clientX: number, clientY: number):	float2;				// image coordinates, not whole pixels
	changed(image: Pixels, rect?: float2.extent): void;				// pixels of an image (all of them, without a rect) have changed
	edited(label: string):						void;				// an undoable change has been made
	redraw():									void;
	menu():									CascadeItem[];		// more for the tool menu, which is all of it where the tools cannot be used
	panelOpened():								void;				// the tool menu has come up over the image
	beginTransform(target: TransformTarget, selection?: Selection):	TransformSession | undefined;	// the current layer or the whole picture is to be transformed (the part of it the selection covers, if there is one)
	transform(change: DocumentChange):			HistoryEntry | undefined;	// flip, rotate or crop the whole document, layers and all, which may change its size: done, and how to undo and redo it
}

// A transform under way, as the viewer has it: what is being transformed, and the showing of it as it is carried
export interface TransformSession {
	box:		float2.extent;				// what is being transformed, in canvas coordinates
	layer?:		Layer;						// and the layer, if it is one
	selection?:	Selection;					// the selection which what is transformed is the part of, if it is
	update(matrix: float3x3): void;			// it is carried by this, from canvas coordinates: the viewer shows it so (and draws the tools again)
	end(): void;							// it is no longer carried
}

export type DocumentChange =
	| {kind: 'flip', horizontal: boolean}
	| {kind: 'rotate', clockwise: boolean}
	| {kind: 'crop', rect: float2.extent}
	| {kind: 'warp', matrix: float3x3, layer?: Layer, selection?: Selection};	// the current layer (cut to the canvas), or the document

export interface HistoryEntry {
	undo(): void;
	redo(): void;
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
	transform:			{
		icon:		'<path d="M4 3.5h8.5V12H4z"/><rect x="2.5" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="10.5" width="3" height="3" fill="currentColor"/><rect x="2.5" y="10.5" width="3" height="3" fill="currentColor"/>',
		key:		'',		// chosen from the menu, as a free transform or one of the image
		label:		'Transform',
	},

};

// the tools that share a place in the menu, which shows the one last used
const toolGroups: Tool[][] = [
	['marquee', 'ellipse-marquee', 'lasso', 'polygon-lasso', 'wand'],
	['brush', 'pencil', 'eraser'],
	['bucket', 'gradient'],
	['line', 'rect', 'ellipse'],
];

// icons of things in the menu that are not tools
const menuIcons = {
	...transformIcons,
	selectAll:	'<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M5.5 8l2 2 3-4"/>',
	deselect:	'<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
	invertSelection: '<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 1.5"/><path d="M2.5 2.5h11v11z" fill="currentColor"/>',
	selectNew:	'<rect x="3.5" y="3.5" width="9" height="9"/>',
	selectAdd:	'<rect x="2.5" y="2.5" width="7" height="7"/><rect x="6.5" y="6.5" width="7" height="7"/>',
	selectSub:	'<path d="M2.5 2.5h7v4h4v7h-7v-4h-4z"/>',
	selectInt:	'<rect x="2.5" y="2.5" width="7" height="7"/><rect x="6.5" y="6.5" width="7" height="7"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/>',
	crop:		'<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>',
	swap:		'<path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/>',
	contiguous:	'<path d="M2.5 8h3l2-3 2 6 2-3h2"/>',
	filled:		'<rect x="2.5" y="3.5" width="11" height="9" fill="currentColor"/>',
	outline:	'<rect x="2.5" y="3.5" width="11" height="9"/>',
	both:		'<rect x="2.5" y="3.5" width="11" height="9" fill="currentColor" fill-opacity="0.4" stroke-width="2"/>',
	image:		'<rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="2 1.5"/><path d="M5 11l6-6M8 5h3v3M5 8v3h3"/>',
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

const MAX_HISTORY = 200;


const hex = (c: RGBA) => '#' + [c.r, c.g, c.b, c.a].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const parseHex = (s: string): RGBA => ({r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16), a: 255});

export class Painter {
	private tool:		Tool	= 'hand';
	private fg			= RGBA(0, 0, 0, 255);
	private bg			= RGBA(255, 255, 255, 255);
	private size		= 10;
	private hardness	= 0.8;
	private opacity		= 1;
	private tolerance	= 32;
	private contiguous	= true;
	private shapeFill: ShapeFill = 'fill';

	private selection:	Selection | undefined;
	private selectMode:	SelectMode = 'replace';
	private draft:		float2[] | undefined;			// the outline of a selection being drawn, in image coordinates
	private corners:	{points: float2[], mode: SelectMode} | undefined;	// a polygonal lasso under way
	private history:	HistoryEntry[] = [];
	private position	= 0;
	private pointer:	float2 | undefined;
	private spaceDown	= false;
	private active		= false;
	private transformMode: TransformMode = 'free';
	private xf: {session: TransformSession, layer?: Layer, selection?: Selection, box: float2.extent, quad: float2[], previous: Tool} | undefined;	// a transform under way

	private ctx:		CanvasRenderingContext2D;
	private menu:		Cascade;
	private lastOfGroup	= new Map<Tool[], Tool>();
	private colourInput	= createElement('input');	// the system's colour picker, for the colour being chosen
	private picking:	'fg' | 'bg' = 'fg';

	constructor(public host: PaintHost, private overlay: HTMLCanvasElement) {
		this.ctx = overlay.getContext('2d')!;
		const stage = overlay.parentElement!;
		this.menu = new Cascade(stage, () => this.active ? [...this.menuItems(), ...this.host.menu()] : this.host.menu());

		// out of sight, but where the menu is, which is where the picker comes up
		this.colourInput.type = 'color';
		Object.assign(this.colourInput.style, {position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none'});
		this.colourInput.addEventListener('input', () => {
			this.setColour(this.picking, parseHex(this.colourInput.value));
			this.menu.refresh();
		});
		stage.append(this.colourInput);

		host.canvas.addEventListener('pointermove', e => {
			if (this.active) {
				this.pointer = this.host.toImage(e.clientX, e.clientY);
				if (this.xf && !e.buttons && !this.spaceDown) {
					const part = this.partAt(this.pointer);
					this.host.canvas.style.cursor = transformCursor(this.xf.box, this.xf.quad, part, this.transformMode, this.xf.layer ? 'move' : 'default');
				}
				this.draw();
			}
		});
		// the right button brings up the tools; anything else closes them again
		host.canvas.addEventListener('contextmenu', e => {
			if (this.active || this.host.menu().length) {
				e.preventDefault();
				this.openMenu(e.clientX, e.clientY);
			}
		});
		host.canvas.addEventListener('pointerleave', () => {
			this.pointer = undefined;
			this.draw();
		});

		window.addEventListener('keydown', e => this.keyDown(e));
		window.addEventListener('keyup', e => {
			if (e.key === ' ' && this.spaceDown) {
				this.spaceDown = false;
				this.updateCursor();
			}
		});

		this.setTool('hand');
	}

	//-------------------------------------------------------------------------
	// state
	//-------------------------------------------------------------------------

	// whether there is anything to edit: the tools come up only then
	enabled(on: boolean) {
		this.active = on;
		this.overlay.classList.toggle('hidden', !on);
		if (!on) {
			this.spaceDown = false;
			this.menu.close();
			this.endTransform(false);
		}
		this.updateCursor();
	}

	// a new image: nothing selected, nothing to undo
	reset() {
		this.endTransform(false);
		this.selection	= undefined;
		this.draft		= this.corners = undefined;
		this.history	= [];
		this.position	= 0;
	}

	resize() {
		this.overlay.width	= this.host.canvas.width;
		this.overlay.height	= this.host.canvas.height;
	}

	setTool(tool: Tool) {
		// another tool, chosen while transforming, applies the transform first
		if (this.xf && tool !== 'transform')
			this.endTransform(true, false);
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

	private menuItems(): CascadeItem[] {
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
		const contiguous = toggleItem('Contiguous', svgFace(menuIcons.contiguous), () => this.contiguous, v => this.contiguous = v);
		const shapeFill = choiceItem('Shape', [
			{value: 'fill' as const,	face: svgFace(menuIcons.filled),	caption: 'Filled'},
			{value: 'stroke' as const,	face: svgFace(menuIcons.outline),	caption: 'Outline'},
			{value: 'both' as const,	face: svgFace(menuIcons.both),		caption: 'Filled and outlined'},
		], () => this.shapeFill, v => this.shapeFill = v);

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
			brush:				[size, hardness, opacity],
			pencil:				[size, opacity],
			eraser:				[size, hardness, opacity],
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
		const op = (o: EditOp, icon: string, caption: string): CascadeItem => ({
			id:			o,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => this.run(o),
		});
		const colour = (which: 'fg' | 'bg', caption: string): CascadeItem => ({
			face:		() => swatchFace(hex(this[which])),
			caption:	() => `${caption} ${hex(this[which])}`,
			select:		() => {
				this.picking = which;
				this.colourInput.value = hex(this[which]);
				this.colourInput.showPicker?.() ?? this.colourInput.click();
				return true;
			},
		});

		const mode = choiceItem('Mode', [
			{value: 'free' as const,		face: svgFace(menuIcons.free),			caption: 'Scale and rotate'},
			{value: 'skew' as const,		face: svgFace(menuIcons.skew),			caption: 'Skew'},
			{value: 'distort' as const,		face: svgFace(menuIcons.distort),		caption: 'Distort'},
			{value: 'perspective' as const,	face: svgFace(menuIcons.perspective),	caption: 'Perspective'},
		], () => this.transformMode, v => this.transformMode = v);
		
		const transform: CascadeItem = {
			id:			'transform',
			face:		() => svgFace(toolInfo.transform.icon),
			caption:	() => 'Transform',
			active:		() => !!this.xf,
			children:	() => [
				{
					id:			'transform-layer',
					face:		() => svgFace(toolInfo.transform.icon),
					caption:	() => 'Free Transform (Enter applies, Esc cancels)',
					active:		() => !!this.xf?.layer,
					select:		() => this.startTransform('layer'),
					children:	() => [mode],
				},
				{
					id:			'transform-image',
					face:		() => svgFace(menuIcons.image),
					caption:	() => 'Transform Image: all of it, onto a canvas that fits',
					active:		() => !!this.xf && !this.xf.layer,
					select:		() => this.startTransform('image'),
					children:	() => [mode],
				},
				op('flipHorizontal', menuIcons.flipH, 'Flip Horizontal'),
				op('flipVertical', menuIcons.flipV, 'Flip Vertical'),
				op('rotateClockwise', menuIcons.rotateCW, 'Rotate 90° Clockwise'),
				op('rotateAnticlockwise', menuIcons.rotateACW, 'Rotate 90° Anticlockwise'),
			],
		};

		const [select, paint, fill, shapes] = toolGroups;
		return [
			tool('hand'),
			group(select, 'Select', [
				op('selectAll', menuIcons.selectAll, 'Select All (⌘A)'),
				op('deselect', menuIcons.deselect, 'Deselect (⌘D)'),
				op('invertSelection', menuIcons.invertSelection, 'Invert Selection (⇧⌘I)'),
				op('crop', menuIcons.crop, 'Crop to Selection'),
			]),
			group(paint, 'Paint'),
			group(fill, 'Fill'),
			group(shapes, 'Shapes'),
			transform,
			tool('eyedropper'),
			{
				id:			'colours',
				face:		() => swatchFace(hex(this.fg), hex(this.bg)),
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
		this.host.canvas.style.cursor = !this.active ? '' : this.xf && !this.spaceDown ? '' : cursorFor(this.spaceDown ? 'hand' : this.tool);
	}

	//-------------------------------------------------------------------------
	// transforming
	//-------------------------------------------------------------------------

	// a transform is under way (its box and handles may be anywhere, including off the picture)
	get transforming() {
		return !!this.xf;
	}

	private startTransform(target: TransformTarget) {
		this.endTransform(true, false);
		const begun = this.host.beginTransform(target, this.selection && !this.selection.empty ? this.selection : undefined);
		if (!begun)
			return;
		const {box, layer, selection} = begun;
		this.xf		= {session: begun, layer, selection, box, quad: box.corners(), previous: this.tool};
		this.tool	= 'transform';
		this.updateCursor();
		begun.update(float3x3.fromQuad(box, this.xf.quad));
	}

	// apply it (as an edit) or not, and go back to the tool before
	private endTransform(apply: boolean, restoreTool = true) {
		const xf = this.xf;
		if (!xf)
			return;
		this.xf = undefined;
		xf.session.end();
		const corners	= xf.box.corners();
		const moved		= xf.quad.some((p, i) => Math.abs(p.x - corners[i].x) > 1e-9 || Math.abs(p.y - corners[i].y) > 1e-9);
		if (apply && moved)
			this.transform({kind: 'warp', matrix: float3x3.fromQuad(xf.box, xf.quad), layer: xf.layer, selection: xf.selection}, xf.layer || xf.selection ? 'Free Transform' : 'Transform Image');
		else
			this.host.redraw();
		if (restoreTool)
			this.setTool(xf.previous);
	}

	private partAt(p: float2): TransformPart {
		const xf = this.xf!;
		return partAt(xf.box, xf.quad, p, HANDLE * (window.devicePixelRatio || 1) * this.host.pixelSize());
	}

	// a drag of the box: from where it was when the drag began, by what is under the pointer and the mode
	private transformDrag(event: PointerEvent) {
		const xf = this.xf!, canvas = this.host.canvas;
		const start = this.host.toImage(event.clientX, event.clientY);
		const part = this.partAt(start);
		if (event.detail === 2 && part.kind === 'inside') {
			this.endTransform(true);
			return;
		}
		// the whole document is where it is, whatever is done to it
		if (part.kind === 'inside' && !xf.layer && !xf.selection)
			return;
		canvas.setPointerCapture(event.pointerId);
		const q0 = xf.quad.map(p => p.dup());

		const move = (e: PointerEvent) => {
			const q = dragQuad({
				box: xf.box, q0, part, start,
				mode: dragMode(part, this.transformMode, e), shift: e.shiftKey, alt: e.altKey,
				// by whole pixels, so that a layer only moved is not resampled
				move: d => float2(Math.round(d.x), Math.round(d.y)),
			}, this.host.toImage(e.clientX, e.clientY));
			if (q) {
				xf.quad = q;
				xf.session.update(float3x3.fromQuad(xf.box, q));
			}
		};
		const up = () => {
			canvas.removeEventListener('pointermove', move);
			canvas.removeEventListener('pointerup', up);
			canvas.removeEventListener('pointercancel', up);
			canvas.removeEventListener('lostpointercapture', up);
		};
		canvas.addEventListener('pointermove', move);
		canvas.addEventListener('pointerup', up);
		canvas.addEventListener('pointercancel', up);
		canvas.addEventListener('lostpointercapture', up);
	}

	// one of the whole-image operations (whether it is one of the tools': the others are not done)
	run(op: EditOp | LayerOp): boolean {
		const image = this.host.target();
		if (!this.active || !image)
			return false;
		switch (op) {
			case 'fill':				this.fillSelection(this.fg, 'Fill'); break;
			case 'clear':				this.clearSelection(); break;
			case 'invert':				this.invert(); break;
			case 'flipHorizontal':		this.transform({kind: 'flip', horizontal: true}, 'Flip Horizontal'); break;
			case 'flipVertical':		this.transform({kind: 'flip', horizontal: false}, 'Flip Vertical'); break;
			case 'rotateClockwise':		this.transform({kind: 'rotate', clockwise: true}, 'Rotate Clockwise'); break;
			case 'rotateAnticlockwise':	this.transform({kind: 'rotate', clockwise: false}, 'Rotate Anticlockwise'); break;
			case 'crop':				this.cropToSelection(); break;
			case 'selectAll':
				this.select(Selection.all(imageSize(image)), 'Select All');
				break;
			case 'deselect':
				this.select(undefined, 'Deselect');
				break;
			case 'invertSelection':
				this.select(this.selection ? this.selection.invert(imageSize(image)) : Selection.all(imageSize(image)), 'Invert Selection');
				break;
			default:
				return false;
		}
		return true;
	}

	// the selection becomes this, which is an undoable edit (as in Photoshop) unless nothing changes
	private select(s: Selection | undefined, label = 'Select') {
		const before = this.selection;
		this.draft = this.corners = undefined;
		if (s === before) {
			this.draw();
			return;
		}
		const set = (v: Selection | undefined) => () => {
			this.selection = v;
			this.draft = this.corners = undefined;
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

	//-------------------------------------------------------------------------
	// history
	//-------------------------------------------------------------------------

	private push(entry: HistoryEntry, label: string) {
		this.history.length = this.position;
		this.history.push(entry);
		if (this.history.length > MAX_HISTORY)
			this.history.shift();
		this.position = this.history.length;
		this.host.edited(label);
	}

	undo() {
		if (this.position > 0)
			this.history[--this.position].undo();
	}

	redo() {
		if (this.position < this.history.length)
			this.history[this.position++].redo();
	}

	// an edit made elsewhere (to the layers), already done
	record(label: string, undo: () => void, redo: () => void) {
		this.push({undo, redo}, label);
	}

	// a patch is of the image it was made on, which may not be the one being drawn on when it is undone
	private pushPatch(image: Pixels, patch: Patch, label: string) {
		const apply = (which: 'before' | 'after') => () => this.host.changed(image, applyPatch(image, patch, which));
		this.push({undo: apply('before'), redo: apply('after')}, label);
	}

	// finish an operation: if it changed anything, that is an edit
	private commit(op: Operation, label: string) {
		const patch = op.commit();
		if (patch)
			this.pushPatch(op.image, patch, label);
	}

	private operation(blend: Operation['blend'] = 'paint') {
		const op = new Operation(this.host.target()!, this.selection);
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

	private invert() {
		if (!this.host.target())
			return;
		const op = this.operation();
		op.opacity = 1;
		invertArea(op);
		this.flush(op);
		this.commit(op, 'Invert');
	}

	// change the whole document, which the selection does not survive
	private transform(change: DocumentChange, label: string) {
		const entry = this.host.transform(change);
		if (!entry)
			return;
		// the selection goes with what it selected, if it was that which was transformed: else it does not survive the change
		const before = change.kind === 'warp' ? change.selection : undefined, image = this.host.target();
		const after = before && image && change.kind === 'warp' ? warpSelection(before, change.matrix, imageRect(image)) : undefined;
		const use = (run: () => void, selection: Selection | undefined) => () => {
			this.selection = selection;
			run();
		};
		this.selection = after;
		this.push({undo: use(entry.undo, before), redo: use(entry.redo, after)}, label);
	}

	private cropToSelection() {
		const image = this.host.target(), s = this.selection;
		if (!image || !s)
			return;
		const min = float2(Math.max(0, s.l), Math.max(0, s.t)), max = float2(Math.min(image.width, s.r), Math.min(image.height, s.b));
		if (max.x > min.x && max.y > min.y)
			this.transform({kind: 'crop', rect: new float2.extent(min, max)}, 'Crop');
	}

	//-------------------------------------------------------------------------
	// pointer
	//-------------------------------------------------------------------------

	// Begin a tool's drag; false if the pointer is not for it (the viewer then pans)
	// the tools, brought up at a point of the window
	openMenu(clientX: number, clientY: number, items?: CascadeItem[]) {
		this.host.panelOpened();
		const r = this.overlay.parentElement!.getBoundingClientRect();
		this.colourInput.style.left = `${clientX - r.left}px`;
		this.colourInput.style.top	= `${clientY - r.top}px`;
		this.menu.open(clientX, clientY, items);
	}

	pointerDown(event: PointerEvent) {
		const image = this.host.target();
		if (!this.active || !image || event.button !== 0 || this.tool === 'hand' || this.spaceDown)
			return false;
		// control-click is a right click on a Mac, and opens the context menu
		if (event.ctrlKey && navigator.platform.toLowerCase().includes('mac'))
			return false;
		if (this.xf) {
			this.transformDrag(event);
			return true;
		}

		const canvas = this.host.canvas;
		canvas.setPointerCapture(event.pointerId);
		const start = this.host.toImage(event.clientX, event.clientY);

		const track = (move: (e: PointerEvent, p: float2) => void, up: (e: PointerEvent) => void) => {
			const onMove = (e: PointerEvent) => {
				// every point the pointer passed through, not just where it is when the frame is drawn
				const events = e.getCoalescedEvents?.() ?? [];
				for (const c of events.length ? events : [e])
					move(c, this.host.toImage(c.clientX, c.clientY));
			};
			// the end of a drag is the pointer's release, or its capture being lost (a context menu opening takes the release)
			let done = false;
			const onUp = (e: PointerEvent) => {
				if (done)
					return;
				done = true;
				canvas.removeEventListener('pointermove', onMove);
				canvas.removeEventListener('pointerup', onUp);
				canvas.removeEventListener('pointercancel', onUp);
				canvas.removeEventListener('lostpointercapture', onUp);
				up(e);
			};
			canvas.addEventListener('pointermove', onMove);
			canvas.addEventListener('pointerup', onUp);
			canvas.addEventListener('pointercancel', onUp);
			canvas.addEventListener('lostpointercapture', onUp);
		};

		switch (this.tool) {
			case 'brush':
			case 'pencil':
			case 'eraser': {
				const op = this.operation(this.tool === 'eraser' ? 'erase' : 'paint');
				let last = start;
				const stroke = (to: float2) => {
					if (this.tool === 'pencil')
						pencilSegment(op, last.x, last.y, to.x, to.y, this.size);
					else
						brushSegment(op, last.x, last.y, to.x, to.y, this.size, this.hardness);
					last = to;
					this.flush(op);
				};
				stroke(start);
				track((_, p) => stroke(p), () => this.commit(op, toolInfo[this.tool].label!));
				break;
			}

			case 'line':
			case 'rect':
			case 'ellipse':
			case 'gradient': {
				const op = this.operation();
				const tool = this.tool;
				let end = start;
				let shift = false, alt = false;
				const render = () => {
					op.reset();
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
					render();
				}, () => this.commit(op, toolInfo[tool].label!));
				break;
			}

			case 'bucket': {
				const op = this.operation();
				floodFill(op, Math.floor(start.x), Math.floor(start.y), this.tolerance, this.contiguous);
				this.flush(op);
				this.commit(op, 'Paint Bucket');
				canvas.releasePointerCapture(event.pointerId);
				break;
			}

			case 'eyedropper': {
				// the colour seen, which with layers is not any one layer's
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
						this.join(round ? Selection.ellipse(box, imageSize(image)) : Selection.rect(box), mode);
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
				canvas.releasePointerCapture(event.pointerId);
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
				canvas.releasePointerCapture(event.pointerId);
				this.join(Selection.wand(image, Math.floor(start.x), Math.floor(start.y), this.tolerance, this.contiguous), this.modeFor(event));
				break;
			}
		}
		return true;
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

	private keyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		if (!this.active || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== 'checkbox' && (target as HTMLInputElement).type !== 'range'))
			return;

		const image = this.host.target();
		const mod = e.metaKey || e.ctrlKey;
		const key = e.key.toLowerCase();

		if (mod) {
			if (key === 'a' && image) {
				this.run('selectAll');
				e.preventDefault();
			} else if (key === 'i' && e.shiftKey) {
				this.run('invertSelection');
				e.preventDefault();
			} else if (key === 'd') {
				this.run('deselect');
				e.preventDefault();
			} else if (e.key === 'Backspace') {
				this.fillSelection(this.bg, 'Fill');
				e.preventDefault();
			}
			return;
		}

		if (this.corners) {
			if (e.key === 'Enter') {
				this.finishCorners();
			} else if (e.key === 'Escape') {
				this.corners = undefined;
				this.draw();
			} else if (e.key === 'Backspace' || e.key === 'Delete') {
				this.corners.points.pop();
				if (!this.corners.points.length)
					this.corners = undefined;
				this.draw();
			} else {
				// (any other key goes on to do what it does)
			}
			if (['Enter', 'Escape', 'Backspace', 'Delete'].includes(e.key)) {
				e.preventDefault();
				return;
			}
		}

		if (this.xf && (e.key === 'Enter' || e.key === 'Escape')) {
			this.endTransform(e.key === 'Enter');
			e.preventDefault();
			return;
		}

		if (e.key === ' ') {
			if (!this.spaceDown) {
				this.spaceDown = true;
				this.host.canvas.style.cursor = '';
			}
			e.preventDefault();
		} else if (e.key === 'Escape') {
			// (an open menu takes the key itself)
			this.select(undefined);

		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			if (e.altKey)
				this.fillSelection(this.fg, 'Fill');
			else
				this.clearSelection();
			e.preventDefault();

		} else if (key === 'x') {
			this.swapColours();

		} else if (key === 'd') {
			this.defaultColours();

		} else if (e.key === '[' || e.key === ']') {
			this.size = Math.max(1, Math.min(200, Math.round(this.size * (e.key === ']' ? 1.2 : 1 / 1.2) + (e.key === ']' ? 1 : -1))));
			this.draw();
			this.menu.refresh();

		} else if (!e.altKey) {
			const group = Object.entries(toolInfo).filter(([t, info]) => info.key === e.key).map(([t, info]) => t as Tool);
			if (group.length) {
				const i = group.indexOf(this.tool);
				this.setTool(group[(i + 1) % group.length]);
			}
		}
	}

	//-------------------------------------------------------------------------
	// overlay: the selection and the brush
	//-------------------------------------------------------------------------

	draw() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
		if (!this.active)
			return;

		const screen		= (p: float2) => this.host.toScreen(p);
		const pixelRatio	= window.devicePixelRatio || 1;

		const outline = (path: () => void) => {
			ctx.lineWidth = pixelRatio;
			ctx.setLineDash([]);
			ctx.strokeStyle = '#fff';
			ctx.beginPath();
			path();
			ctx.stroke();
			ctx.setLineDash([4 * pixelRatio, 4 * pixelRatio]);
			ctx.strokeStyle = '#000';
			ctx.beginPath();
			path();
			ctx.stroke();
		};

		const s = this.xf?.selection ? undefined : this.selection;	// (the selection is not where it was while what it selects is carried)
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

		if (this.xf) {
			// the box, with lines through it in thirds, and its handles
			const {corners, edges} = boxHandles(this.xf.box, this.xf.quad);
			const m = float3x3.fromQuad(this.xf.box, this.xf.quad), b = this.xf.box;
			const o = b.min, size = b.extent();
			const at = (u: number, v: number) => screen(applyH(m, o.x + u * size.x, o.y + v * size.y).xy);
			ctx.save();
			ctx.globalAlpha = 0.5;
			ctx.lineWidth = pixelRatio;
			ctx.strokeStyle = '#fff';
			ctx.beginPath();
			for (const t of [1 / 3, 2 / 3]) {
				const [a, c, d, e] = [at(t, 0), at(t, 1), at(0, t), at(1, t)];
				ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
				ctx.moveTo(d.x, d.y); ctx.lineTo(e.x, e.y);
			}
			ctx.stroke();
			ctx.restore();
			outline(() => {
				corners.map(screen).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
				ctx.closePath();
			});
			const r = 3.5 * pixelRatio;
			ctx.setLineDash([]);
			for (const h of [...corners, ...edges].map(p => screen(p.xy))) {
				ctx.fillStyle = '#fff';
				ctx.strokeStyle = '#000';
				ctx.lineWidth = pixelRatio;
				ctx.fillRect(h.x - r, h.y - r, 2 * r, 2 * r);
				ctx.strokeRect(h.x - r, h.y - r, 2 * r, 2 * r);
			}
		}

		if (this.pointer && !this.spaceDown && ['brush', 'pencil', 'eraser', 'line'].includes(this.tool)) {
			const r = Math.max(this.size / this.host.pixelSize() / 2, 2 * pixelRatio);
			const centre = screen(this.pointer!);
			outline(() => ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2));
		}
	}
}

//-----------------------------------------------------------------------------
// operations: one undoable change to an image
//-----------------------------------------------------------------------------

// how a pixel takes its colour: composed over what was there, taking that away, or replacing it
type Blend = 'paint' | 'erase' | 'replace';

class Operation extends Tiles {
	opacity		= 1;
	colour		= RGBA(0, 0, 0, 255);
	blend:		Blend = 'paint';

	constructor(image: Pixels, readonly selection?: Selection | null) { super(image); }

	// where anything can be drawn: the selection, inside the image
	bounds(): float2.extent {
		const ext = new float2.extent(float2(0, 0), float2(this.image.width, this.image.height));
		return this.selection ? ext.intersect(this.selection.bounds()) : ext;
	}

	// how much of a pixel the selection lets through
	private cover(x: number, y: number) {
		return this.selection ? this.selection.at(x, y) / 255 : 1;
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
// from that fraction of the radius.
function brushSegment(op: Operation, x0: number, y0: number, x1: number, y1: number, size: number, hardness: number) {
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
			op.put(x, y, f > 1 ? smooth(c) : c);
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
				c0.g + (c1.g - c0.g) * t,
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
	const {data, width, height} = op.image;
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
	const {data, width} = op.image;
	const bb = op.bounds();
	op.blend = 'replace';
	for (let y = bb.min.y; y < bb.max.y; y++) {
		for (let x = bb.min.x; x < bb.max.x; x++) {
			const o = (y * width + x) * 4;
			op.put(x, y, 1, RGBA(255 - data[o], 255 - data[o + 1], 255 - data[o + 2], data[o + 3]));
		}
	}
}

// A selection, with what it selects carried by a matrix (from the image's coordinates): where the coverage lands, within the image;
// nothing if none of it does
function warpSelection(s: Selection, m: float3x3, within: float2.extent) {
	const area = m.transformExtent(s.bounds())?.roundOut().intersect(within);
	if (!area || area.empty())
		return undefined;
	const coverage = new Uint8ClampedArray(s.width * s.height).fill(255);
	if (s.mask)
		coverage.set(s.mask);
	const local = m.matmul(float3x3.translate(float2(s.l, s.t)));
	const warped = warpCPU({data: coverage, width: s.width, height: s.height}, local, area, 1);
	return new Selection(area.min.x, area.min.y, area.max.x, area.max.y, Uint8Array.from(warped.data)).trimmed();
}
