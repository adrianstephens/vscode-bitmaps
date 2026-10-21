// The font viewer's page: a grid of the font's glyphs, drawn from outlines the extension sends as they scroll into
// view, a line of sample text set in the font, and the metrics of the glyph that is selected.
import { vscode, createElement, createSVGElement, RPC, handleResult, Splitter } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Tree } from '@isopodlabs/vscode_utils/webview/tree.js';
import { PathEditor, ViewOptions, svgPath } from './pathedit.js';
import { svgFace, toggleItem, type CascadeItem } from './cascade.js';
import { createSession } from './svgsession.js';
import type { curveVertex } from '@isopodlabs/binary_fonts';

export interface FontInfo {
	file:		string;
	faces:		string[];						// the names of the fonts in a collection
	face:		number;
	family:		string;
	style:		string;
	numGlyphs:	number;
	unitsPerEm:	number;
	ascent:		number;
	descent:	number;							// negative, below the baseline
	lineGap:	number;
	advances:	number[];						// per glyph
	unicodes:	Record<number, number[]>;		// glyph -> the codepoints that map to it
	names:		[string, string][];
	convertible?: boolean;			// whether it could be edited if converted to TrueType outlines
	editable?:	boolean;			// whether its glyphs can be edited and saved
}

// one entry of a table, as the tree shows it
export interface TableNode {
	key?:		string;
	type:		'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'bytes' | 'array' | 'object' | 'error';
	value:		string;
	count?:		number;			// entries, when it has any to open
}

// what the inspector draws of a glyph
export interface GlyphDetail {
	path:		string;			// its outline, y down
	points:		curveVertex[];	// each point as the font stores it, y down; flags 0 begins a contour
	markup:		string;			// its drawing, in colour where it has one
	colored?:	boolean;		// whether that drawing has colours of its own
	components:	number[];		// the glyphs a composite is made of
	error?:		string;			// why its outline could not be read
	svg?:		{text: string, editable: boolean};	// its drawing in colour, as a document of its own: edited in place of its outline
	bitmap?:	{ppem: number, editable: boolean};	// the picture it has at the largest size, which the bitmap editor can open
}

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'face', face: number}
	| {command: 'getGlyphs', ids: number[]}
	| {command: 'getTable', path: string[]}
	| {command: 'getGlyphDetail', id: number}
	| {command: 'status', text: string}
	| {command: 'convertFont'}
	| {command: 'editGlyph', id: number, points: curveVertex[], label: string}
	| {command: 'editGlyphSvg', id: number, text: string, label: string}
	| {command: 'editGlyphBitmap', id: number}
	| {command: 'shapePoints', name: string, attributes: Record<string, string>}
	| {command: 'simplifyPoints', points: curveVertex[], tol: number, cubic: boolean}
	| {command: 'fitStroke', stroke: number[], tol: number};

export type MessageIn =
	| {command: 'font', info: FontInfo}
	| {command: 'glyphChanged', id: number, own?: boolean}
	| {command: 'error', message: string}
	| {command: 'fitToWindow'};

const $		= <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const post	= (message: MessageOut) => vscode.postMessage(message);

const grid		= $('font-grid');
const detail	= $('font-detail');
const meta		= $('font-meta');
const sampleIn	= $<HTMLInputElement>('font-sample');
const sampleOut	= $('font-sample-out');
const sizeIn	= $<HTMLInputElement>('font-size');
const sampleBox	= $('font-sample-box');
const mappedIn	= $<HTMLInputElement>('font-unicode');
const faceSel	= $<HTMLSelectElement>('font-face');
const errorBox	= $('scad-error');

const num = (n: number) => +n.toFixed(2);

let info:		FontInfo | undefined;
let shown:		number[] = [];						// the glyph ids in the grid
let selected	= -1;
const markup	= new Map<number, string>();		// outlines already fetched
const pending	= new Set<number>();

const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const char = (cp: number) => cp < 0x20 || (cp >= 0x7F && cp < 0xA0) ? '' : String.fromCodePoint(cp);

// an <svg> of one glyph, with the glyph's em box and its vertical metrics as the frame
function glyphSvg(id: number, guides = false) {
	const f = info!;
	const adv = f.advances[id] ?? f.unitsPerEm, pad = f.unitsPerEm * 0.1;
	const svg = createSVGElement('svg', {viewBox: `${-pad} ${-f.ascent - pad} ${adv + pad * 2} ${f.ascent - f.descent + pad * 2}`});
	svg.dataset.glyph = String(id);
	if (guides) {
		const w = f.unitsPerEm / 200;
		svg.innerHTML = `<g class="guides" stroke-width="${w}">
			<line x1="${-pad}" x2="${adv + pad}" y1="0" y2="0" class="base"/>
			<line x1="${-pad}" x2="${adv + pad}" y1="${-f.ascent}" y2="${-f.ascent}"/>
			<line x1="${-pad}" x2="${adv + pad}" y1="${-f.descent}" y2="${-f.descent}"/>
			<line x1="0" x2="0" y1="${-f.ascent}" y2="${-f.descent}"/>
			<line x1="${adv}" x2="${adv}" y1="${-f.ascent}" y2="${-f.descent}"/>
		</g>`;
	}
	fill(svg, id);
	return svg;
}

// a glyph's drawing with its ids its own, since the ids of different glyphs' gradients and parts would otherwise meet in one page
function scopeIds(markup: string, id: number) {
	if (!markup.includes('id="'))
		return markup;
	const prefix = `g${id}-`;
	return markup.replace(/\bid="([^"]*)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`).replace(/href="#/g, `href="#${prefix}`);
}

// draws the glyph's outlines into an <svg> if they are here, and asks for them if not
const waiting = new Map<number, Set<SVGElement>>();
function fill(svg: SVGElement, id: number) {
	const m = markup.get(id);
	if (m !== undefined) {
		svg.querySelector('.outline')?.remove();
		svg.appendChild(createSVGElement('g', {class: 'outline'}, {innerHTML: scopeIds(m, id)}));
		return;
	}
	if (!waiting.has(id))
		waiting.set(id, new Set());
	waiting.get(id)!.add(svg);
	request(id);
}

let timer = 0;
function request(id: number) {
	if (pending.has(id))
		return;
	pending.add(id);
	clearTimeout(timer);
	timer = window.setTimeout(flush, 30);
}

function flush() {
	const ids = [...pending].slice(0, 256);
	ids.forEach(id => pending.delete(id));
	if (!ids.length)
		return;
	RPC<Record<number, string>>({command: 'getGlyphs', ids})
		.then(result => {
			for (const id of ids) {
				markup.set(id, result[id] ?? '');
				for (const svg of waiting.get(id) ?? [])
					if (svg.isConnected)
						fill(svg, id);
				waiting.delete(id);
			}
		})
		.catch(error => showError(String(error?.message ?? error)));
	if (pending.size)
		timer = window.setTimeout(flush, 0);
}

//--- the grid ----------------------------------------------------------------

const observer = new IntersectionObserver(entries => {
	for (const e of entries) {
		if (!e.isIntersecting)
			continue;
		const cell = e.target as HTMLElement;
		observer.unobserve(cell);
		const id = +cell.dataset.id!;
		cell.insertBefore(glyphSvg(id), cell.firstChild);
	}
}, {root: grid, rootMargin: '300px'});

function buildGrid() {
	const f = info!;
	observer.disconnect();
	grid.textContent = '';
	shown = [];
	for (let id = 0; id < f.numGlyphs; id++)
		if (!mappedIn.checked || f.unicodes[id])
			shown.push(id);
	const frag = document.createDocumentFragment();
	for (const id of shown) {
		const cell = createElement('div', {className: 'glyph-cell', dataset: {id: String(id)}});
		const cp = f.unicodes[id]?.[0];
		cell.appendChild(createElement('span', {textContent: cp !== undefined ? hex(cp) : `#${id}`}));
		frag.appendChild(cell);
	}
	grid.appendChild(frag);
	grid.querySelectorAll('.glyph-cell').forEach(c => observer.observe(c));
	if (selected >= 0)
		select(selected);
}

grid.addEventListener('dblclick', e => {
	const cell = (e.target as HTMLElement).closest<HTMLElement>('.glyph-cell');
	if (cell)
		inspect(+cell.dataset.id!);
});
detail.addEventListener('click', e => {
	if (selected >= 0 && (e.target as Element).closest('svg'))
		inspect(selected);
});

grid.addEventListener('click', e => {
	const cell = (e.target as HTMLElement).closest<HTMLElement>('.glyph-cell');
	if (cell)
		select(+cell.dataset.id!);
});

//--- the selected glyph ------------------------------------------------------

function select(id: number) {
	const f = info!;
	selected = id;
	grid.querySelectorAll('.selected').forEach(c => c.classList.remove('selected'));
	grid.querySelector(`[data-id="${id}"]`)?.classList.add('selected');

	const cps = f.unicodes[id] ?? [];
	detail.textContent = '';
	detail.appendChild(glyphSvg(id, true));
	const rows: [string, string][] = [
		['Glyph', `${id} of ${f.numGlyphs}`],
		['Advance', `${f.advances[id] ?? 0} units`],
		['Unicode', cps.length ? cps.map(cp => `${hex(cp)}${char(cp) ? ' ' + char(cp) : ''}`).join(', ') : 'unmapped'],
	];
	detail.appendChild(table(rows));
}

function table(rows: [string, string][]) {
	const t = createElement('table');
	for (const [k, v] of rows) {
		const tr = t.insertRow();
		tr.insertCell().textContent = k;
		tr.insertCell().textContent = v;
	}
	return t;
}

//--- the inspector -----------------------------------------------------------

const inspector		= $('font-inspector');
const inspView		= $('insp-view');
// what is said about what is under the pointer goes to the editor's status bar, which the extension owns
let lastStatus = '';
const inspStatus = {
	set textContent(text: string) {
		if (text !== lastStatus)
			post({command: 'status', text: lastStatus = text});
	}
};

let inspecting	= -1;
let glyph:		GlyphDetail | undefined;
let colourMode	= false;		// whether the glyph's drawing in colour is what is edited, and not its outline

// the glyph's outline, drawn over its metrics in the view the SVG editor shares, and edited as points
class GlyphEditor extends PathEditor {
	protected extraViews = ['metrics', 'fill'];
	protected yUp = true;
	
	points()				{ return glyph?.points; }
	simplifyPoints(points: curveVertex[], tol: number) { return RPC<curveVertex[]>({command: 'simplifyPoints', points, tol, cubic: false}); }
	// a glyph is edited when the font can be written and the glyph is a plain outline (not made of other glyphs)
	canEdit()				{ return !!(info?.editable && glyph && !glyph.components.length && !glyph.error); }
	active()				{ return !!info && inspecting >= 0 && !colourMode; }
	status(text: string)	{ inspStatus.textContent = text; }

	commit(label: string) {
		if (inspecting >= 0 && glyph)
			post({command: 'editGlyph', id: inspecting, points: glyph.points, label});
	}

	draw() {
		super.draw();
	}

	// the extent of what the glyph occupies: its advance and the font's vertical metrics, and any ink outside them
	bounds() {
		const f = info!;
		let x0 = 0, x1 = f.advances[inspecting] || f.unitsPerEm, y0 = -f.ascent, y1 = -f.descent;
		const p = glyph?.points ?? [];
		for (const v of p) {
			x0 = Math.min(x0, v.x);
			x1 = Math.max(x1, v.x);
			y0 = Math.min(y0, v.y);
			y1 = Math.max(y1, v.y);
		}
		return {x0, y0, x1, y1};
	}

	metricGuides(X: (x: number) => number, Y: (y: number) => number, w: number, h: number) {
		return this.guides(X, Y, w, h);
	}

	protected guides(X: (x: number) => number, Y: (y: number) => number, w: number, h: number) {
		const f = info!, adv = f.advances[inspecting] ?? 0;
		const line = (cls: string, x1: number, y1: number, x2: number, y2: number, label: string, lx: number, ly: number) =>
			`<line class="${cls}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/><text class="insp-metric" x="${num(lx)}" y="${num(ly)}">${label}</text>`;
		return [
			line('insp-base', 0, Y(0), w, Y(0), 'baseline', 4, Y(0) - 3),
			line('insp-metric-line', 0, Y(-f.ascent), w, Y(-f.ascent), `ascent ${f.ascent}`, 4, Y(-f.ascent) - 3),
			line('insp-metric-line', 0, Y(-f.descent), w, Y(-f.descent), `descent ${f.descent}`, 4, Y(-f.descent) - 3),
			line('insp-metric-line', X(0), 0, X(0), h, 'origin', X(0) + 3, h - 4),
			line('insp-metric-line', X(adv), 0, X(adv), h, `advance ${adv}`, X(adv) + 3, h - 4),
		].join('');
	}

	// an outline that can be edited is drawn from the points being edited, a colour glyph in colours that come from other
	// glyphs and not from the outline being edited
	//protected outline() {
	//	return glyph ? this.canEdit() ? svgPath(glyph.points) : glyph.path : '';
	//}

	protected updateContent(g: SVGGElement) {
		const painted = !!glyph && (glyph.colored || !this.canEdit());
		const markup = !glyph ? '' : painted ? glyph.markup : `<path fill="currentColor" fill-rule="evenodd" d="${this.canEdit() ? svgPath(glyph.points) : glyph.path}"/>`;
		g.innerHTML = this.option('fill') && markup ? `<g class="insp-fill${glyph?.colored ? ' colored' : ''}">${markup}</g>` : '';
	}

	describe() {
		if (!glyph)
			return 'loading…';
		const f = info!, n = glyph.points.length, contours = glyph.points.filter(v => v.flags === 0).length;
		const u = f.unicodes[inspecting];
		return [
			`glyph ${inspecting}`,
			u?.length ? u.map(hex).join(' ') : 'unmapped',
			`advance ${f.advances[inspecting] ?? 0}`,
			`${n} points, ${contours} contour${contours === 1 ? '' : 's'}`,
			glyph.components.length ? `composite of ${glyph.components.join(', ')}` : '',
			glyph.error ?? (glyph.markup && !n ? 'drawn as a bitmap or in colour' : ''),
			this.canEdit() ? 'drag a point to edit; right-click for more' : f.editable ? 'a composite: right-click to decompose it' : f.convertible ? 'read only: right-click to convert to TrueType and edit' : 'read only',
		].filter(Boolean).join(' · ');
	}

	protected formatPoint(x: number, y: number) {
		return `(${x}, ${-y})`;
	}
	protected defaultSize() {
		return info!.unitsPerEm / 5;
	}
	protected readOnlyReason() {
		return info?.convertible ? 'read only: right-click and choose Convert to TrueType outlines to edit this font'
			: info?.editable && glyph?.components.length ? 'a composite: right-click and choose Decompose to edit it'
			: 'this font cannot be edited';
	}

	protected pageItems(): CascadeItem[] {
		const op = (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});
		const items = glyphItems();
		if (!this.canEdit() && info?.editable && glyph?.components.length)
			items.push(op('decompose', '<rect x="2" y="2" width="12" height="12"/><path d="M8 2V14M2 8H14"/>', 'Decompose the composite into plain outlines', () => this.commit('Decompose glyph')));
		else if (!this.canEdit() && info?.convertible)
			items.push(op('convert', '<path d="M3 13C3 4 8 2 13 3"/><path d="M3 3L13 13" stroke-dasharray="2 2"/>', 'Convert to TrueType outlines to edit', () => post({command: 'convertFont'})));
		return items;
	}
}

// what the glyph inspector's menu offers over the glyph: leaving it, stepping through the glyphs, the colour drawing
function glyphItems(): CascadeItem[] {
	const op = (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});
	const items = [
		op('back', '<path d="M10 3L5 8L10 13"/>', 'Back to the glyphs (Esc)', closeInspector),
		op('previous', '<path d="M3 8H13M7 4L3 8L7 12"/>', 'Previous glyph (←)', () => stepInspector(-1)),
		op('next', '<path d="M3 8H13M9 4L13 8L9 12"/>', 'Next glyph (→)', () => stepInspector(1)),
	];
	if (glyph?.bitmap)
		items.push(op('bitmap', '<rect x="2" y="3" width="12" height="10"/><circle cx="6" cy="7" r="1.3"/><path d="M3 12L7 8L10 11L12 9L14 12"/>', glyph.bitmap.editable ? 'Edit the bitmap in the bitmap editor' : 'Open the bitmap in the bitmap editor (it cannot be saved back to this font)', () => post({command: 'editGlyphBitmap', id: inspecting})));
	if (glyph?.svg)
		items.push({...toggleItem('Edit the colour drawing', svgFace('<circle cx="8" cy="8" r="6"/><circle cx="5.5" cy="6.5" r="1" fill="currentColor"/><circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="10.5" cy="9" r="1" fill="currentColor"/>'), () => colourMode, setColourMode), id: 'colour'});
	return items;
}

const viewOptions = new ViewOptions({snap: true});
const editor = new GlyphEditor(inspView, viewOptions);

// a glyph drawn in colour is edited as the SVG it is, by the editor the SVG viewer is: its elements as layers, each with a
// fill and a stroke, and the points of the one selected
const colour = createSession({
	view:			inspView,
	options:		viewOptions,
	views:			['metrics'],
	pageItems: 	() => glyphItems(),
	tree:			$('font-layer-tree'),
	props:			$('font-layer-props'),
	active:			() => colourMode && inspecting >= 0,
	home:			() => `glyph${inspecting}`,
	guides:			(X, Y, w, h) => editor.metricGuides(X, Y, w, h),
}, {
	save:			(text, label)		=> post({command: 'editGlyphSvg', id: inspecting, text, label}),
	shapePoints:	(name, attributes)	=> RPC<curveVertex[]>({command: 'shapePoints', name, attributes}),
	simplifyPoints:	(points, tol)		=> RPC<curveVertex[]>({command: 'simplifyPoints', points, tol, cubic: true}),
	fitStroke:		(stroke, tol)		=> RPC<curveVertex[]>({command: 'fitStroke', stroke, tol}),
	status:			text				=> { inspStatus.textContent = text; },
	error:			message				=> message ? showError(message) : errorBox.classList.add('hidden'),
});

// the drawing in colour is what is edited, or the outline
function setColourMode(on: boolean) {
	colourMode = on && !!glyph?.svg;
	$('font-layers').classList.toggle('hidden', !colourMode);
	if (colourMode) {
		colour.load(glyph!.svg!.text, `glyph ${inspecting}`, !glyph!.svg!.editable);
		colour.editor.fit();
	}
	editor.draw();
	colour.editor.draw();
}

function inspect(id: number) {
	editor.reset();
	inspecting = id;
	glyph = undefined;
	colourMode = false;
	$('font-layers').classList.add('hidden');
	grid.classList.add('hidden');
	inspector.classList.remove('hidden');
	if (id !== selected)
		select(id);
	$('insp-title').textContent = `Glyph ${id}`;
	editor.draw();
	RPC<GlyphDetail>({command: 'getGlyphDetail', id})
		.then(g => {
			if (inspecting !== id)
				return;
			glyph = g;
			setColourMode(true);
			editor.fit();
		})
		.catch(error => showError(String(error?.message ?? error)));
}

// a glyph was changed, here or by an undo or redo: whatever shows it is drawn again from the font
function glyphChanged(id: number, own = false) {
	markup.delete(id);
	// a drawing of the SVG table may share what it draws with others
	if (colourMode) {
		markup.clear();
		grid.querySelectorAll<SVGElement>('svg[data-glyph]').forEach(svg => fill(svg, +svg.dataset.glyph!));
	}
	grid.querySelectorAll<SVGElement>(`[data-id="${id}"] svg`).forEach(svg => fill(svg, id));
	if (selected === id)
		select(id);
	setSample();
	if (inspecting === id && !editor.dragging) {
		RPC<GlyphDetail>({command: 'getGlyphDetail', id})
			.then(g => {
				if (inspecting === id && !editor.dragging) {
					glyph = g;
					if (editor.picked >= g.points.length)
						editor.picked = -1;
					// what the colour editor has is what was just made, unless this is an undo or a redo
					if (colourMode && (!own || !g.svg))
						setColourMode(true);
					editor.draw();
				}
			})
			.catch(error => showError(String(error?.message ?? error)));
	}
}

function closeInspector() {
	if (inspecting < 0)
		return;
	inspecting = -1;
	inspStatus.textContent = '';
	inspector.classList.add('hidden');
	grid.classList.remove('hidden');
	grid.querySelector('.selected')?.scrollIntoView({block: 'nearest'});
}

function stepInspector(by: number) {
	const i = shown.indexOf(inspecting) + by;
	if (i >= 0 && i < shown.length)
		inspect(shown[i]);
}

document.addEventListener('keydown', e => {
	const target = e.target as HTMLInputElement;
	if (inspecting < 0 || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && target.type !== 'checkbox'))
		return;
	if (!(colourMode ? colour.key(e) : editor.key(e))) {
		switch (e.key) {
			case 'Escape':		closeInspector(); break;
			case 'ArrowLeft':	stepInspector(-1); break;
			case 'ArrowRight':	stepInspector(1); break;
			default:			return;
		}
	}
	e.preventDefault();
});

//--- sample text -------------------------------------------------------------

// glyph for each codepoint of the text, which is all the page can do without the font's layout tables
// The sample is drawn from the font's glyphs, one for each character (no kerning or ligatures: the page has no layout
// engine), and edited through the hidden input that holds its text: the input takes the keys, the clipboard and input
// methods, and what is drawn is its text, caret and selection.
let sampleLayout: {x: number, ids: number[], scale: number} | undefined;

function setSample() {
	const f = info;
	sampleOut.textContent = '';
	if (!f)
		return;
	const reverse = new Map<number, number>();
	for (const [id, cps] of Object.entries(f.unicodes))
		for (const cp of cps)
			if (!reverse.has(cp))
				reverse.set(cp, +id);

	const chars = [...sampleIn.value];
	const size = Math.max(1, +sizeIn.value || 56), scale = size / f.unitsPerEm;
	const ids = chars.map(c => reverse.get(c.codePointAt(0)!) ?? 0);
	// the position of the text's start in font units of each character, as the caret is placed by them
	const starts: number[] = [];
	let x = 0;
	const svg = createSVGElement('svg');
	for (const id of ids) {
		const g = createSVGElement('g', {transform: `translate(${x} 0)`});
		svg.appendChild(g);
		fill(g as unknown as SVGElement, id);
		starts.push(x);
		x += f.advances[id] ?? 0;
	}
	starts.push(x);

	// the selection and caret, by character: the input counts UTF-16 units, so astral characters are two
	const unit = (n: number) => [...sampleIn.value.slice(0, n)].length;
	const a = unit(sampleIn.selectionStart ?? 0), b = unit(sampleIn.selectionEnd ?? 0);
	const top = -f.ascent, height = f.ascent - f.descent;
	if (a !== b)
		svg.insertAdjacentHTML('afterbegin', `<rect class="sample-selection" x="${starts[a]}" y="${top}" width="${starts[b] - starts[a]}" height="${height}"/>`);
	else if (document.activeElement === sampleIn)
		svg.insertAdjacentHTML('beforeend', `<rect class="sample-caret" x="${starts[a] - f.unitsPerEm / 60}" y="${top}" width="${f.unitsPerEm / 30}" height="${height}"/>`);

	const width = Math.max(x + f.unitsPerEm / 30, 1);
	svg.setAttribute('viewBox', `0 ${top} ${width} ${height}`);
	svg.setAttribute('width', String(width * scale));
	svg.setAttribute('height', String(height * scale));
	sampleOut.appendChild(svg);
	sampleLayout = {x, ids, scale};
	sampleStarts = starts;
}
let sampleStarts: number[] = [];

// a click puts the caret in the gap nearest it, and a drag selects from where it began
function sampleIndexAt(clientX: number) {
	const svg = sampleOut.querySelector('svg');
	if (!svg || !sampleLayout)
		return 0;
	const x = (clientX - svg.getBoundingClientRect().left) / sampleLayout.scale;
	let best = 0;
	sampleStarts.forEach((s, i) => {
		if (Math.abs(s - x) < Math.abs(sampleStarts[best] - x))
			best = i;
	});
	return best;
}
const toUnits = (chars: number) => [...sampleIn.value].slice(0, chars).join('').length;

let sampleAnchor = -1;
sampleBox.addEventListener('pointerdown', e => {
	e.preventDefault();
	sampleIn.focus();
	sampleAnchor = sampleIndexAt(e.clientX);
	sampleBox.setPointerCapture(e.pointerId);
	const at = toUnits(sampleAnchor);
	sampleIn.setSelectionRange(at, at);
	setSample();
});
sampleBox.addEventListener('pointermove', e => {
	if (sampleAnchor < 0)
		return;
	const here = sampleIndexAt(e.clientX);
	sampleIn.setSelectionRange(toUnits(Math.min(sampleAnchor, here)), toUnits(Math.max(sampleAnchor, here)));
	setSample();
});
sampleBox.addEventListener('pointerup', () => { sampleAnchor = -1; });

// the wheel sets the size, as it zooms the inspector; a sideways wheel scrolls a long line
sampleBox.addEventListener('wheel', e => {
	if (Math.abs(e.deltaX) > Math.abs(e.deltaY))
		return;
	e.preventDefault();
	sizeIn.value = String(Math.round(Math.min(1000, Math.max(6, +sizeIn.value * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))))));
	setSample();
}, {passive: false});

//--- the tables -----------------------------------------------------------

// the shared tree: a table entry with entries of its own is a caret, whose children are asked for the first time it opens
const tablesView	= $('font-tables');
const tablesRoot	= createElement('div', {className: 'tree', tabIndex: 0});
tablesView.append(createElement('div', {className: 'tree-heading', textContent: 'Tables'}), tablesRoot);

const tablePaths	= new WeakMap<HTMLElement, string[]>();	// the path of each caret whose children are still to be read

const tablesTree	= new Tree(tablesRoot, (caret, down) => {
	const path = tablePaths.get(caret);
	if (!down || !path)
		return;
	tablePaths.delete(caret);
	RPC<TableNode[]>({command: 'getTable', path})
		.then(nodes => fillList(caret.querySelector<HTMLElement>(':scope > .children')!, path, nodes))
		.catch(error => {
			tablePaths.set(caret, path);	// so opening it again tries again
			tablesTree.close(caret);
			showError(String(error?.message ?? error));
		});
});
tablesTree.enableKeyboardNavigation(() => {});

// a click on a row puts the cursor there, and opens or closes it; the tree itself handles a click on the caret's arrow
tablesRoot.addEventListener('click', event => {
	const line = (event.target as HTMLElement).closest<HTMLElement>('.select');
	if (line) {
		tablesTree.setCursor(line);
		if (line.parentElement?.classList.contains('caret'))
			tablesTree.toggle(line.parentElement);
	}
});

function row(node: TableNode, path: string[]) {
	const line	= createElement(node.count ? 'span' : 'div', {className: 'select'});
	line.append(
		createElement('span', {className: 'tree-key', textContent: node.key ?? ''}),
		createElement('span', {className: 'tree-value ' + node.type, textContent: node.value})
	);
	if (!node.count)
		return line;

	const caret		= createElement('div', {className: 'caret'});
	caret.append(line, createElement('div', {className: 'children'}));
	tablePaths.set(caret, path);
	return caret;
}

function fillList(list: HTMLElement, path: string[], nodes: TableNode[]) {
	for (const node of nodes)
		list.appendChild(row(node, [...path, node.key!]));
	tablesTree.fixup(list);
}

async function buildTables() {
	tablesTree.setCursor(null, false);
	tablesRoot.textContent = '';
	try {
		fillList(tablesRoot, [], await RPC<TableNode[]>({command: 'getTable', path: []}));
	} catch (error: any) {
		showError(String(error?.message ?? error));
	}
}


//--- the splitter ------------------------------------------------------------

// the shared splitter sizes the side panel before it; the grid takes the rest
const splitter = new Splitter($('font-splitter'), () => {});
splitter.set(340);

//--- the font ----------------------------------------------------------------

function setFont(next: FontInfo) {
	const faceChanged = !info || info.face !== next.face;
	info = next;
	markup.clear();
	waiting.clear();
	pending.clear();
	errorBox.classList.add('hidden');

	faceSel.classList.toggle('hidden', info.faces.length < 2);
	faceSel.textContent = '';
	info.faces.forEach((name, i) => faceSel.add(new Option(name, String(i), false, i === info!.face)));

	if (faceChanged)
		selected = -1;
	inspecting = -1;
	inspStatus.textContent = '';
	inspector.classList.add('hidden');
	grid.classList.remove('hidden');
	meta.textContent = '';
	meta.appendChild(table([
		['File',		info.file],
		['Family',		info.family],
		['Style',		info.style],
		['Glyphs',		info.numGlyphs.toLocaleString()],
		['Mapped',		Object.keys(info.unicodes).length.toLocaleString()],
		['Units/em',	String(info.unitsPerEm)],
		['Ascent',		String(info.ascent)],
		['Descent',		String(info.descent)],
		['Line gap',	String(info.lineGap)],
		...info.names.filter(([k]) => !['Family', 'Style'].includes(k)),
	]));
	buildGrid();
	setSample();
	buildTables();
	if (selected < 0)
		detail.textContent = 'Select a glyph';
}

function showError(message: string) {
	errorBox.textContent = message;
	errorBox.classList.remove('hidden');
}

for (const type of ['input', 'focus', 'blur', 'keyup', 'select'])
	sampleIn.addEventListener(type, setSample);
sizeIn.addEventListener('input', setSample);
mappedIn.addEventListener('change', buildGrid);
faceSel.addEventListener('change', () => post({command: 'face', face: +faceSel.value}));

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'font':
			setFont(message.info);
			break;
		case 'glyphChanged':
			glyphChanged(message.id, message.own);
			break;
		case 'error':
			showError(message.message);
			break;
	}
});

post({command: 'ready'});
