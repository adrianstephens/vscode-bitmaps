// The bitmap editor's tools: the options for the current tool (the tools themselves are chosen from a panel the right button brings up), the selection, and undo history.
// The pixels themselves are changed by edit.ts; this turns pointer and key events into those changes.

import {
	RGBA, Rect, Pixels, Selection, Patch, Operation, ShapeKind,
	applyPatch, brushSegment, pencilSegment, drawShape, drawGradient, floodFill, fillArea, invertArea,
} from './edit.js';

// the whole-image operations, which the extension offers in the editor's title menu
export type EditOp = 'fill' | 'clear' | 'invert' | 'flipHorizontal' | 'flipVertical' | 'rotateClockwise' | 'rotateAnticlockwise' | 'crop' | 'selectAll' | 'deselect';

export type Tool = 'hand' | 'marquee' | 'ellipse-marquee' | 'brush' | 'pencil' | 'eraser' | 'bucket' | 'gradient' | 'eyedropper' | 'line' | 'rect' | 'ellipse';

// what the editor needs of the viewer it is part of
export interface PaintHost {
	canvas:			HTMLCanvasElement;
	image():		Pixels | null;			// what the tools draw on: the picture, or the current layer, which covers the canvas
	pick(x: number, y: number): {r: number, g: number, b: number, a: number} | undefined;	// the colour seen at a pixel of the picture
	view():			{scale: number, offset: {x: number, y: number}};
	toImage(clientX: number, clientY: number): {x: number, y: number};	// image coordinates, not whole pixels
	changed(image: Pixels, rect?: Rect): void;	// pixels of an image (all of them, without a rect) have changed
	// flip, rotate or crop the whole document, layers and all, which may change its size: done, and how to undo and redo it
	transform(change: DocumentChange): HistoryEntry | undefined;
	edited(label: string): void;			// an undoable change has been made
	panelOpened(): void;					// the tool panel has come up over the image
}

export type DocumentChange =
	| {kind: 'flip', horizontal: boolean}
	| {kind: 'rotate', clockwise: boolean}
	| {kind: 'crop', rect: Rect};

export interface HistoryEntry {
	undo(): void;
	redo(): void;
}

const icons: Record<Tool, string> = {
	'hand':				'<path d="M8 1.5v13M1.5 8h13M8 1.5L6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
	'marquee':			'<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.5"/>',
	'ellipse-marquee':	'<ellipse cx="8" cy="8" rx="5.5" ry="4.5" stroke-dasharray="2 1.5"/>',
	'brush':			'<path d="M13.5 2.5l-6 6"/><path d="M7.5 8.5c-2 0-3 1-3 3 0 1-1 2-2 2.5 3 .5 6-.5 6-3.5z" fill="currentColor"/>',
	'pencil':			'<path d="M11 2.5l2.5 2.5-7.5 7.5-3.5 1 1-3.5z"/><path d="M9.5 4l2.5 2.5"/>',
	'eraser':			'<path d="M9.5 2.5l4 4-6 6h-3l-2-2z"/><path d="M5 7l4 4M7.5 13.5h6.5"/>',
	'bucket':			'<path d="M3 8l5-5 5 5-4.5 4.5a1.5 1.5 0 0 1-2 0z"/><path d="M13.5 10.5c0 1-1 1.5-1 2.2a1 1 0 0 0 2 0c0-.7-1-1.2-1-2.2z" fill="currentColor"/>',
	'gradient':			'<defs><linearGradient id="g"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="2.5" y="2.5" width="11" height="11" fill="url(#g)"/>',
	'eyedropper':		'<path d="M13 3a1.5 1.5 0 0 0-2.1 0L9 4.9 7.9 3.8 7 4.7l.9.9-5 5v2.9h2.9l5-5 .9.9.9-.9-1.1-1.1L13 5.1A1.5 1.5 0 0 0 13 3z"/>',
	'line':				'<path d="M2.5 13.5l11-11"/>',
	'rect':				'<rect x="2.5" y="3.5" width="11" height="9"/>',
	'ellipse':			'<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>',
};

const toolNames: Record<Tool, string> = {
	'hand':				'Hand',
	'marquee':			'Rectangular Marquee',
	'ellipse-marquee':	'Elliptical Marquee',
	'brush':			'Brush',
	'pencil':			'Pencil',
	'eraser':			'Eraser',
	'bucket':			'Paint Bucket',
	'gradient':			'Gradient',
	'eyedropper':		'Eyedropper',
	'line':				'Line',
	'rect':				'Rectangle',
	'ellipse':			'Ellipse',
};

// the tools in rows of a kind, as the panel lays them out, with what to show of each
const toolRows: {tool: Tool, caption: string}[][] = [
	[{tool: 'hand',				caption: 'Hand (H, or hold Space)'}],
	[{tool: 'marquee',			caption: 'Rectangular Marquee (M)'},
	 {tool: 'ellipse-marquee',	caption: 'Elliptical Marquee (M)'}],
	[{tool: 'brush',			caption: 'Brush (B)'},
	 {tool: 'pencil',			caption: 'Pencil (N)'},
	 {tool: 'eraser',			caption: 'Eraser (E)'}],
	[{tool: 'bucket',			caption: 'Paint Bucket (G)'},
	 {tool: 'gradient',			caption: 'Gradient (G)'},
	 {tool: 'eyedropper',		caption: 'Eyedropper (I; with Alt, the background)'}],
	[{tool: 'line',				caption: 'Line (U)'},
	 {tool: 'rect',				caption: 'Rectangle (U)'},
	 {tool: 'ellipse',			caption: 'Ellipse (U)'}],
];

// The pointer for a tool: its icon, drawn dark on a light halo to show on any picture, with the hotspot at the working
// point of the tool (the tip of the brush, the pour of the bucket). Tools that mark out an area get cross hairs.
const CURSOR_SIZE = 24;
const cursorHotspots: Partial<Record<Tool, [number, number]>> = {
	'brush':		[3, 21],
	'pencil':		[3, 21],
	'eraser':		[5, 19],
	'bucket':		[12, 19],
	'eyedropper':	[3, 21],
};
const crosshair = '<path d="M8 1.5v4.5M8 10v4.5M1.5 8h4.5M10 8h4.5"/>';

function cursorFor(tool: Tool) {
	if (tool === 'hand')
		return 'grab';
	const hot = cursorHotspots[tool];
	const glyph = hot ? icons[tool] : crosshair;
	const style = 'fill="none" stroke-linejoin="round" stroke-linecap="round"';
	// the glyph twice, thick and light then thin and dark; filled parts of the icon keep their fill
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="0 0 16 16">`
		+ `<g ${style} stroke="#fff" stroke-width="3.2" color="#fff">${glyph}</g>`
		+ `<g ${style} stroke="#000" stroke-width="1.2" color="#000">${glyph}</g></svg>`;
	const [x, y] = hot ?? [CURSOR_SIZE / 2, CURSOR_SIZE / 2];
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
}

// keys that choose a tool; pressing the key again moves on to the next tool of the group
const toolKeys: Record<string, Tool[]> = {
	h: ['hand'],
	m: ['marquee', 'ellipse-marquee'],
	b: ['brush'],
	n: ['pencil'],
	e: ['eraser'],
	g: ['bucket', 'gradient'],
	i: ['eyedropper'],
	u: ['line', 'rect', 'ellipse'],
};

const labels: Partial<Record<Tool, string>> = {
	brush:		'Brush',
	pencil:		'Pencil',
	eraser:		'Eraser',
	bucket:		'Paint Bucket',
	gradient:	'Gradient',
	line:		'Line',
	rect:		'Rectangle',
	ellipse:	'Ellipse',
};

const MAX_HISTORY = 200;


const hex = (c: RGBA) => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const parseHex = (s: string): RGBA => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & {class?: string} = {}, ...children: (Node | string)[]) {
	const e = document.createElement(tag);
	const {class: cls, ...rest} = props;
	Object.assign(e, rest);
	if (cls)
		e.className = cls;
	e.append(...children);
	return e;
}

export class Painter {
	private tool:		Tool	= 'hand';
	private fg:			RGBA	= [0, 0, 0, 255];
	private bg:			RGBA	= [255, 255, 255, 255];
	private size		= 10;
	private hardness	= 0.8;
	private opacity		= 1;
	private tolerance	= 32;
	private contiguous	= true;
	private shapeFill: 'stroke' | 'fill' | 'both' = 'fill';

	private selection:	Selection | null = null;
	private history:	HistoryEntry[] = [];
	private position	= 0;
	private pointer:	{x: number, y: number} | undefined;
	private spaceDown	= false;
	private active		= false;

	private ctx:		CanvasRenderingContext2D;
	private toolName:	HTMLElement;
	private panel:		HTMLElement;
	private panelCaption = element('div', {class: 'tool-caption'});
	private panelButtons = new Map<Tool, HTMLButtonElement>();
	private fgInput:	HTMLInputElement;
	private bgInput:	HTMLInputElement;
	private controls:	{element: HTMLElement, tools: Tool[]}[] = [];
	private sizeControls:	{range: HTMLInputElement, number: HTMLInputElement};

	constructor(private host: PaintHost, private optionbar: HTMLElement, private overlay: HTMLCanvasElement) {
		this.ctx = overlay.getContext('2d')!;

		this.toolName = element('strong', {class: 'paint-tool-name'});
		optionbar.append(this.toolName);

		this.panel = this.buildPanel();

		this.fgInput = element('input', {type: 'color', title: 'Foreground colour', value: hex(this.fg)});
		this.bgInput = element('input', {type: 'color', title: 'Background colour (X swaps)', value: hex(this.bg)});
		this.fgInput.addEventListener('input', () => this.fg = parseHex(this.fgInput.value));
		this.bgInput.addEventListener('input', () => this.bg = parseHex(this.bgInput.value));
		const swap = element('button', {class: 'paint-text', title: 'Swap colours (X)', textContent: '⇄'});
		swap.addEventListener('click', () => this.swapColours());
		const colours = element('span', {class: 'paint-group'}, this.fgInput, swap, this.bgInput);
		optionbar.append(colours);

		const brushy: Tool[] = ['brush', 'eraser'];
		const sized: Tool[] = ['brush', 'pencil', 'eraser', 'line', 'rect', 'ellipse'];
		const opaque: Tool[] = ['brush', 'pencil', 'eraser', 'bucket', 'gradient', 'line', 'rect', 'ellipse'];

		this.sizeControls = this.addRange('Size', sized, 1, 200, this.size, v => this.size = v);
		this.addRange('Hardness', brushy, 0, 100, this.hardness * 100, v => this.hardness = v / 100);
		this.addRange('Opacity', opaque, 1, 100, this.opacity * 100, v => this.opacity = v / 100);
		this.addRange('Tolerance', ['bucket'], 0, 255, this.tolerance, v => this.tolerance = v);

		const contiguous = element('input', {type: 'checkbox', checked: true});
		contiguous.addEventListener('change', () => this.contiguous = contiguous.checked);
		this.addControl('Contiguous', ['bucket'], contiguous);

		const shape = element('select', {}, ...[['fill', 'Filled'], ['stroke', 'Outline'], ['both', 'Both']].map(([value, text]) => element('option', {value, textContent: text})));
		shape.value = this.shapeFill;
		shape.addEventListener('change', () => this.shapeFill = shape.value as Painter['shapeFill']);
		this.addControl('Shape', ['rect', 'ellipse'], shape);

		host.canvas.addEventListener('pointermove', e => {
			if (this.active) {
				this.pointer = host.toImage(e.clientX, e.clientY);
				this.draw();
			}
		});
		// the right button brings up the tools; anything else closes them again
		host.canvas.addEventListener('contextmenu', e => {
			if (this.active) {
				e.preventDefault();
				this.openPanel(e.clientX, e.clientY);
			}
		});
		window.addEventListener('pointerdown', e => {
			if (!this.panel.contains(e.target as Node) && e.button !== 2)
				this.closePanel();
		}, true);
		window.addEventListener('blur', () => this.closePanel());
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

	private addControl(label: string, forTools: Tool[], control: HTMLElement) {
		const e = element('label', {class: 'paint-option'}, label, control);
		this.controls.push({element: e, tools: forTools});
		this.optionbar.append(e);
	}

	private addRange(label: string, forTools: Tool[], min: number, max: number, value: number, set: (value: number) => void) {
		const range = element('input', {type: 'range', min: String(min), max: String(max), value: String(value)});
		const number = element('input', {type: 'number', min: String(min), max: String(max), value: String(Math.round(value))});
		range.addEventListener('input', () => {
			number.value = range.value;
			set(Number(range.value));
		});
		number.addEventListener('input', () => {
			const v = Math.min(max, Math.max(min, Number(number.value) || min));
			range.value = String(v);
			set(v);
		});
		this.addControl(label, forTools, element('span', {class: 'paint-range'}, range, number));
		return {range, number};
	}

	//-------------------------------------------------------------------------
	// state
	//-------------------------------------------------------------------------

	// whether there is anything to edit: the tool bars are shown only then
	enabled(on: boolean) {
		this.active = on;
		this.optionbar.classList.toggle('hidden', !on);
		this.overlay.classList.toggle('hidden', !on);
		if (!on) {
			this.spaceDown = false;
			this.closePanel();
		}
		this.updateCursor();
	}

	// a new image: nothing selected, nothing to undo
	reset() {
		this.selection = null;
		this.history = [];
		this.position = 0;
	}

	resize() {
		this.overlay.width	= this.host.canvas.width;
		this.overlay.height	= this.host.canvas.height;
	}

	setTool(tool: Tool) {
		this.tool = tool;
		this.toolName.textContent = toolNames[tool];
		for (const c of this.controls)
			c.element.classList.toggle('hidden', !c.tools.includes(tool));
		for (const [t, b] of this.panelButtons)
			b.classList.toggle('active', t === tool);
		this.updateCursor();
		this.draw();
	}

	//-------------------------------------------------------------------------
	// the tool panel
	//-------------------------------------------------------------------------

	private buildPanel() {
		const panel = element('div', {class: 'tool-panel hidden'});
		for (const row of toolRows) {
			const r = element('div', {class: 'tool-row'});
			for (const {tool, caption} of row) {
				const b = element('button', {class: 'tool-button'});
				b.dataset.tool = tool;
				b.innerHTML = `<svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${icons[tool]}</svg>`;
				b.addEventListener('pointerenter', () => this.panelCaption.textContent = caption);
				b.addEventListener('focus', () => this.panelCaption.textContent = caption);
				b.addEventListener('click', () => {
					this.setTool(tool);
					this.closePanel();
				});
				this.panelButtons.set(tool, b);
				r.append(b);
			}
			panel.append(r);
		}
		panel.append(this.panelCaption);
		this.overlay.parentElement?.append(panel);
		return panel;
	}

	private openPanel(clientX: number, clientY: number) {
		const stage = this.overlay.parentElement!.getBoundingClientRect();
		this.host.panelOpened();
		this.panelCaption.textContent = toolNames[this.tool];
		this.panel.classList.remove('hidden');
		const x = Math.max(0, Math.min(clientX - stage.left, stage.width - this.panel.offsetWidth));
		const y = Math.max(0, Math.min(clientY - stage.top, stage.height - this.panel.offsetHeight));
		this.panel.style.left	= `${x}px`;
		this.panel.style.top	= `${y}px`;
		this.panelButtons.get(this.tool)?.focus({preventScroll: true});
	}

	private closePanel() {
		this.panel.classList.add('hidden');
	}

	private updateCursor() {
		this.host.canvas.style.cursor = !this.active ? '' : cursorFor(this.spaceDown ? 'hand' : this.tool);
	}

	// one of the whole-image operations
	run(op: EditOp) {
		const image = this.host.image();
		if (!this.active || !image)
			return;
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
				this.selection = {x: 0, y: 0, w: image.width, h: image.height, ellipse: false};
				this.draw();
				break;
			case 'deselect':
				this.selection = null;
				this.draw();
				break;
		}
	}

	private swapColours() {
		[this.fg, this.bg] = [this.bg, this.fg];
		this.fgInput.value = hex(this.fg);
		this.bgInput.value = hex(this.bg);
	}

	private setColour(which: 'fg' | 'bg', colour: RGBA) {
		this[which] = colour;
		(which === 'fg' ? this.fgInput : this.bgInput).value = hex(colour);
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
		const op = new Operation(this.host.image()!, this.selection);
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
		if (!this.host.image())
			return;
		const op = this.operation();
		op.colour = colour;
		fillArea(op);
		this.flush(op);
		this.commit(op, label);
	}

	private clearSelection() {
		if (!this.host.image())
			return;
		const op = this.operation('erase');
		op.opacity = 1;
		fillArea(op);
		this.flush(op);
		this.commit(op, 'Clear');
	}

	private invert() {
		if (!this.host.image())
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
		const use = (run: () => void) => () => {
			this.selection = null;
			run();
		};
		this.selection = null;
		this.push({undo: use(entry.undo), redo: use(entry.redo)}, label);
	}

	private cropToSelection() {
		const image = this.host.image(), s = this.selection;
		if (!image || !s)
			return;
		const x0 = Math.max(0, s.x), y0 = Math.max(0, s.y);
		const x1 = Math.min(image.width, s.x + s.w), y1 = Math.min(image.height, s.y + s.h);
		if (x1 > x0 && y1 > y0)
			this.transform({kind: 'crop', rect: {x: x0, y: y0, w: x1 - x0, h: y1 - y0}}, 'Crop');
	}

	//-------------------------------------------------------------------------
	// pointer
	//-------------------------------------------------------------------------

	// Begin a tool's drag; false if the pointer is not for it (the viewer then pans)
	pointerDown(event: PointerEvent) {
		const image = this.host.image();
		if (!this.active || !image || event.button !== 0 || this.tool === 'hand' || this.spaceDown)
			return false;
		// control-click is a right click on a Mac, and opens the context menu
		if (event.ctrlKey && navigator.platform.toLowerCase().includes('mac'))
			return false;

		const canvas = this.host.canvas;
		canvas.setPointerCapture(event.pointerId);
		const start = this.host.toImage(event.clientX, event.clientY);

		const track = (move: (e: PointerEvent, p: {x: number, y: number}) => void, up: (e: PointerEvent) => void) => {
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
				const stroke = (to: {x: number, y: number}) => {
					if (this.tool === 'pencil')
						pencilSegment(op, last.x, last.y, to.x, to.y, this.size);
					else
						brushSegment(op, last.x, last.y, to.x, to.y, this.size, this.hardness);
					last = to;
					this.flush(op);
				};
				stroke(start);
				track((_, p) => stroke(p), () => this.commit(op, labels[this.tool]!));
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
				}, () => this.commit(op, labels[tool]!));
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
						this.setColour(e.altKey ? 'bg' : 'fg', [c.r, c.g, c.b, 255]);
				};
				sample(event, start);
				track(sample, () => {});
				break;
			}

			case 'marquee':
			case 'ellipse-marquee': {
				const ellipse = this.tool === 'ellipse-marquee';
				let moved = false;
				track((e, p) => {
					moved = true;
					let x = p.x, y = p.y, x0 = start.x, y0 = start.y;
					if (e.shiftKey) {
						const d = Math.max(Math.abs(x - x0), Math.abs(y - y0));
						x = x0 + Math.sign(x - x0 || 1) * d;
						y = y0 + Math.sign(y - y0 || 1) * d;
					}
					if (e.altKey) {
						x0 = 2 * start.x - x;
						y0 = 2 * start.y - y;
					}
					const l = Math.max(0, Math.round(Math.min(x0, x))), t = Math.max(0, Math.round(Math.min(y0, y)));
					const r = Math.min(image.width, Math.round(Math.max(x0, x))), b = Math.min(image.height, Math.round(Math.max(y0, y)));
					this.selection = r > l && b > t ? {x: l, y: t, w: r - l, h: b - t, ellipse} : null;
					this.draw();
				}, () => {
					if (!moved)
						this.selection = null;	// a click on its own deselects
					this.draw();
				});
				break;
			}
		}
		return true;
	}

	//-------------------------------------------------------------------------
	// keys
	//-------------------------------------------------------------------------

	private keyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		if (!this.active || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== 'checkbox' && (target as HTMLInputElement).type !== 'range'))
			return;

		const image = this.host.image();
		const mod = e.metaKey || e.ctrlKey;
		const key = e.key.toLowerCase();

		if (mod) {
			if (key === 'a' && image) {
				this.run('selectAll');
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

		if (e.key === ' ') {
			if (!this.spaceDown) {
				this.spaceDown = true;
				this.host.canvas.style.cursor = '';
			}
			e.preventDefault();
		} else if (e.key === 'Escape') {
			this.closePanel();
			this.selection = null;
			this.draw();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			if (e.altKey)
				this.fillSelection(this.fg, 'Fill');
			else
				this.clearSelection();
			e.preventDefault();
		} else if (key === 'x') {
			this.swapColours();
		} else if (key === 'd') {
			this.setColour('fg', [0, 0, 0, 255]);
			this.setColour('bg', [255, 255, 255, 255]);
		} else if (e.key === '[' || e.key === ']') {
			this.size = Math.max(1, Math.min(200, Math.round(this.size * (e.key === ']' ? 1.2 : 1 / 1.2) + (e.key === ']' ? 1 : -1))));
			this.sizeControls.range.value = this.sizeControls.number.value = String(this.size);
			this.draw();
		} else if (toolKeys[key] && !e.altKey) {
			const group = toolKeys[key];
			const i = group.indexOf(this.tool);
			this.setTool(group[(i + 1) % group.length]);
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

		const {scale, offset} = this.host.view();
		const pixelRatio = window.devicePixelRatio || 1;

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

		const s = this.selection;
		if (s) {
			const x = offset.x + s.x * scale, y = offset.y + s.y * scale, w = s.w * scale, h = s.h * scale;
			outline(() => s.ellipse ? ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2) : ctx.rect(x, y, w, h));
		}

		if (this.pointer && !this.spaceDown && ['brush', 'pencil', 'eraser', 'line'].includes(this.tool)) {
			const r = Math.max(this.size * scale / 2, 2 * pixelRatio);
			outline(() => ctx.arc(offset.x + this.pointer!.x * scale, offset.y + this.pointer!.y * scale, r, 0, Math.PI * 2));
		}
	}
}
