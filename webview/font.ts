// The font viewer's page: a grid of the font's glyphs, drawn from outlines the extension sends as they scroll into
// view, a line of sample text set in the font, and the metrics of the glyph that is selected.
import { vscode, RPC, handleResult, Splitter } from '@isopodlabs/vscode_utils/webview/shared.js';

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
	points:		number[];		// x, y (down), flags of each point as the font stores them; flags 0 begins a contour
	markup:		string;			// its drawing, in colour where it has one
	colored?:	boolean;		// whether that drawing has colours of its own
	components:	number[];		// the glyphs a composite is made of
	error?:		string;			// why its outline could not be read
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
	| {command: 'editGlyph', id: number, points: number[], label: string};

export type MessageIn =
	| {command: 'font', info: FontInfo}
	| {command: 'glyphChanged', id: number}
	| {command: 'error', message: string}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'};

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

const SVG = 'http://www.w3.org/2000/svg';

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
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', `${-pad} ${-f.ascent - pad} ${adv + pad * 2} ${f.ascent - f.descent + pad * 2}`);
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

// draws the glyph's outlines into an <svg> if they are here, and asks for them if not
const waiting = new Map<number, Set<SVGElement>>();
function fill(svg: SVGElement, id: number) {
	const m = markup.get(id);
	if (m !== undefined) {
		svg.querySelector('.outline')?.remove();
		const g = document.createElementNS(SVG, 'g');
		g.setAttribute('class', 'outline');
		g.innerHTML = m;
		svg.appendChild(g);
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
		const cell = document.createElement('div');
		cell.className = 'glyph-cell';
		cell.dataset.id = String(id);
		const label = document.createElement('span');
		const cp = f.unicodes[id]?.[0];
		label.textContent = cp !== undefined ? hex(cp) : `#${id}`;
		cell.appendChild(label);
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
	const t = document.createElement('table');
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
const inspOption	= (name: string) => $<HTMLInputElement>('insp-' + name).checked;
const inspSvg		= document.createElementNS(SVG, 'svg');
inspView.appendChild(inspSvg);

const KIND = ['begin', 'on-curve', 'quadratic control', 'cubic control'];

let inspecting	= -1;
let glyph:		GlyphDetail | undefined;
let view		= {x: 0, y: 0, s: 1};		// screen = world * s + (x, y), the world being the font's, y down
let hover		= -1;
let gridStep	= 1;				// the grid's spacing as last drawn, which points snap to
let picked		= -1;
let pickedContour = -1;			// where the selected contour begins, when a whole contour is selected, or -1

function inspect(id: number) {
	notice = '';
	inspecting = id;
	glyph = undefined;
	hover = picked = pickedContour = -1;
	grid.classList.add('hidden');
	inspector.classList.remove('hidden');
	if (id !== selected)
		select(id);
	$('insp-title').textContent = `Glyph ${id}`;
	drawInspector();
	RPC<GlyphDetail>({command: 'getGlyphDetail', id})
		.then(g => {
			if (inspecting !== id)
				return;
			glyph = g;
			fitInspector();
			drawInspector();
		})
		.catch(error => showError(String(error?.message ?? error)));
}

// a glyph was changed, here or by an undo or redo: whatever shows it is drawn again from the font
function glyphChanged(id: number) {
	markup.delete(id);
	grid.querySelectorAll<SVGElement>(`[data-id="${id}"] svg`).forEach(svg => fill(svg, id));
	if (selected === id)
		select(id);
	setSample();
	if (inspecting === id && !drag) {
		RPC<GlyphDetail>({command: 'getGlyphDetail', id})
			.then(g => {
				if (inspecting === id && !drag) {
					glyph = g;
					if (picked >= g.points.length / 3)
						picked = -1;
					drawInspector();
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

// the extent of what the glyph occupies: its advance and the font's vertical metrics, and any ink outside them
function fitInspector() {
	const f = info!, w = inspView.clientWidth, h = inspView.clientHeight;
	let x0 = 0, x1 = f.advances[inspecting] || f.unitsPerEm, y0 = -f.ascent, y1 = -f.descent;
	const p = glyph?.points ?? [];
	for (let i = 0; i < p.length; i += 3) {
		x0 = Math.min(x0, p[i]);
		x1 = Math.max(x1, p[i]);
		y0 = Math.min(y0, p[i + 1]);
		y1 = Math.max(y1, p[i + 1]);
	}
	const s = Math.max(0.001, Math.min((w - 80) / (x1 - x0), (h - 80) / (y1 - y0)));
	view = {s, x: (w - (x1 - x0) * s) / 2 - x0 * s, y: (h - (y1 - y0) * s) / 2 - y0 * s};
}

// zoom about a point of the view, which stays where it is
function zoomInspector(factor: number, cx = inspView.clientWidth / 2, cy = inspView.clientHeight / 2) {
	const s = Math.max(0.005, Math.min(view.s * factor, 400));
	factor = s / view.s;
	view = {s, x: cx - (cx - view.x) * factor, y: cy - (cy - view.y) * factor};
	drawInspector();
}

const num = (n: number) => +n.toFixed(2);

function drawInspector() {
	const f = info;
	if (!f || inspecting < 0)
		return;
	$('insp-snap-label').classList.toggle('hidden', !canEdit());
	const w = inspView.clientWidth, h = inspView.clientHeight, {s} = view;
	const X = (x: number) => x * s + view.x, Y = (y: number) => y * s + view.y;
	inspSvg.setAttribute('width', String(w));
	inspSvg.setAttribute('height', String(h));
	const out: string[] = [];

	// a grid of round numbers of font units, as fine as keeps its lines apart on the screen
	if (inspOption('grid')) {
		const raw = 12 / s, pow = 10 ** Math.floor(Math.log10(raw));
		const step = gridStep = [1, 2, 5, 10].map(k => k * pow).find(v => v >= raw)!;
		const every = Math.round(step / pow) === 5 ? 2 : 5;
		let minor = '', major = '', labels = '';
		const lines = (from: number, to: number, vertical: boolean, flip: number) => {
			for (let k = Math.ceil(from / step); k <= Math.floor(to / step); k++) {
				const v = k * step, at = vertical ? X(v) : Y(v * flip);
				const d = vertical ? `M${num(at)},0V${h}` : `M0,${num(at)}H${w}`;
				if (k % every === 0) {
					major += d;
					labels += vertical ? `<text x="${num(at) + 3}" y="11">${num(v)}</text>` : `<text class="right" x="${w - 3}" y="${num(at) - 3}">${num(v)}</text>`;
				} else
					minor += d;
			}
		};
		lines(-view.x / s, (w - view.x) / s, true, 1);
		lines(-(h - view.y) / s, view.y / s, false, -1);
		out.push(`<path class="insp-minor" d="${minor}"/><path class="insp-major" d="${major}"/><g class="insp-labels">${labels}</g>`);
	}

	if (inspOption('metrics')) {
		const adv = f.advances[inspecting] ?? 0;
		const line = (cls: string, x1: number, y1: number, x2: number, y2: number, label: string, lx: number, ly: number) =>
			`<line class="${cls}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/><text class="insp-metric" x="${num(lx)}" y="${num(ly)}">${label}</text>`;
		out.push(
			line('insp-base', 0, Y(0), w, Y(0), 'baseline', 4, Y(0) - 3),
			line('insp-metric-line', 0, Y(-f.ascent), w, Y(-f.ascent), `ascent ${f.ascent}`, 4, Y(-f.ascent) - 3),
			line('insp-metric-line', 0, Y(-f.descent), w, Y(-f.descent), `descent ${f.descent}`, 4, Y(-f.descent) - 3),
			line('insp-metric-line', X(0), 0, X(0), h, 'origin', X(0) + 3, h - 4),
			line('insp-metric-line', X(adv), 0, X(adv), h, `advance ${adv}`, X(adv) + 3, h - 4),
		);
	}

	if (glyph) {
		const g = `<g transform="translate(${num(view.x)} ${num(view.y)}) scale(${s})">`;
		// an outline that can be edited is drawn from the points being edited
		const path = canEdit() ? pathOf(glyph.points) : glyph.path;
		// a colour glyph is drawn in its colours, which come from other glyphs and not from the outline being edited
		const painted = glyph.colored || !canEdit();
		if (inspOption('fill') && (painted ? glyph.markup : path))
			out.push(`${g}<g class="insp-fill${glyph.colored ? ' colored' : ''}">${painted ? glyph.markup : `<path fill="currentColor" d="${path}"/>`}</g></g>`);
		if (inspOption('outline') && path)
			out.push(`${g}<path class="insp-outline" vector-effect="non-scaling-stroke" d="${path}"/></g>`);
		// each contour has a wide invisible stroke to be picked by, and the selected one is drawn over the rest
		if (canEdit()) {
			if (pickedContour >= 0 && glyph.points[pickedContour * 3 + 2] !== 0)
				pickedContour = -1;
			const q = glyph.points, count = q.length / 3;
			let hits = '';
			for (let c = 0; c < count;) {
				let e = c + 1;
				while (e < count && q[e * 3 + 2] !== 0)
					e++;
				const d = pathOf(q.slice(c * 3, e * 3));
				hits += `<path class="insp-hit" data-contour="${c}" vector-effect="non-scaling-stroke" d="${d}"/>`;
				if (c === pickedContour)
					hits += `<path class="insp-selected" vector-effect="non-scaling-stroke" d="${d}"/>`;
				c = e;
			}
			out.push(`${g}${hits}</g>`);
		}

		const p = glyph.points, n = p.length / 3;
		if (inspOption('polygon')) {
			let d = '';
			for (let i = 0; i < n; i++)
				d += `${p[i * 3 + 2] === 0 ? (i ? 'Z' : '') + 'M' : 'L'}${num(X(p[i * 3]))},${num(Y(p[i * 3 + 1]))}`;
			out.push(`<path class="insp-polygon" d="${d}${n ? 'Z' : ''}"/>`);
		}
		if (inspOption('points') || inspOption('numbers')) {
			for (let i = 0; i < n; i++) {
				const x = num(X(p[i * 3])), y = num(Y(p[i * 3 + 1])), flags = p[i * 3 + 2];
				const cls = `insp-pt k${flags}${i === picked ? ' picked' : i === hover ? ' hover' : ''}${pickedContour >= 0 && i >= pickedContour && i < contourOf(pickedContour).e ? ' in-contour' : ''}`;
				const r = i === hover || i === picked ? 5 : 3.5;
				if (inspOption('points'))
					out.push(flags >= 2
						? `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`
						: `<rect class="${cls}" x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}"/>`);
				if (inspOption('numbers'))
					out.push(`<text class="insp-num" x="${x + 6}" y="${y - 6}">${i}</text>`);
			}
		}
	}
	inspSvg.innerHTML = out.join('');

	if (notice) {
		inspStatus.textContent = notice;
		return;
	}
	if (glyph && pickedContour >= 0 && hover < 0) {
		const {s: a, e: b} = contourOf(pickedContour);
		inspStatus.textContent = `contour of ${b - a} points selected · drag to move, Del to delete`;
		return;
	}
	const shownPoint = hover >= 0 ? hover : picked;
	if (glyph && shownPoint >= 0) {
		const p = glyph.points, k = p[shownPoint * 3 + 2];
		inspStatus.textContent = `point ${shownPoint} · ${KIND[k] ?? 'flags ' + k} · (${p[shownPoint * 3]}, ${-p[shownPoint * 3 + 1]})`;
	} else if (glyph) {
		const n = glyph.points.length / 3, contours = glyph.points.filter((v, i) => i % 3 === 2 && v === 0).length;
		const u = info!.unicodes[inspecting];
		inspStatus.textContent = [
			`glyph ${inspecting}`,
			u?.length ? u.map(hex).join(' ') : 'unmapped',
			`advance ${f.advances[inspecting] ?? 0}`,
			`${n} points, ${contours} contour${contours === 1 ? '' : 's'}`,
			glyph.components.length ? `composite of ${glyph.components.join(', ')}` : '',
			glyph.error ?? (glyph.markup && !n ? 'drawn as a bitmap or in colour' : ''),
			canEdit() ? 'drag a point to edit; right-click for more' : info!.editable ? 'a composite: right-click to decompose it' : info!.convertible ? 'read only: right-click to convert to TrueType and edit' : 'read only',
		].filter(Boolean).join(' · ');
	} else
		inspStatus.textContent = 'loading…';
}

// the point of the glyph nearest a place on the screen, if one is near enough to be meant
function pointAt(x: number, y: number) {
	const p = glyph?.points ?? [];
	let best = -1, bestD = 10 * 10;
	for (let i = 0; i < p.length / 3; i++) {
		const dx = p[i * 3] * view.s + view.x - x, dy = p[i * 3 + 1] * view.s + view.y - y;
		if (dx * dx + dy * dy < bestD) {
			bestD = dx * dx + dy * dy;
			best = i;
		}
	}
	return best;
}

//--- editing -----------------------------------------------------------------

// a glyph is edited when the font can be written and the glyph is a plain outline (not made of other glyphs)
const canEdit = () => !!(info?.editable && glyph && !glyph.components.length && !glyph.error);

// the outline of points as the extension reads them: contours that begin at a 0, of on-curve points (1) and quadratic
// controls (2), a control after a control standing for the on-curve point halfway between
function pathOf(p: number[]) {
	let d = '';
	const n = p.length / 3;
	for (let s = 0; s < n;) {
		let e = s + 1;
		while (e < n && p[e * 3 + 2] !== 0)
			e++;
		const at = (i: number) => `${p[i * 3]},${p[i * 3 + 1]}`;
		d += `M${at(s)}`;
		for (let i = s + 1; i < e;) {
			if (p[i * 3 + 2] === 1) {
				d += `L${at(i)}`;
				i++;
			} else {
				const next = i + 1 < e ? i + 1 : s;
				if (p[next * 3 + 2] !== 2 || next === s) {
					d += `Q${at(i)},${at(next)}`;
					i += 2;
				} else {
					d += `Q${at(i)},${(p[i * 3] + p[next * 3]) / 2},${(p[i * 3 + 1] + p[next * 3 + 1]) / 2}`;
					i++;
				}
			}
		}
		d += 'Z';
		s = e;
	}
	return d;
}

// where the contour of point i begins and ends (exclusive)
function contourOf(i: number) {
	const p = glyph!.points, n = p.length / 3;
	let s = i, e = i + 1;
	while (s > 0 && p[s * 3 + 2] !== 0)
		s--;
	while (e < n && p[e * 3 + 2] !== 0)
		e++;
	return {s, e};
}

function commit(label: string) {
	if (inspecting >= 0 && glyph)
		post({command: 'editGlyph', id: inspecting, points: glyph.points, label});
}

// what the status line says for a few seconds in place of what is under the pointer: why something was not done
let notice = '', noticeTimer = 0;
function refuse(message: string) {
	notice = message;
	drawInspector();
	clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => { notice = ''; drawInspector(); }, 4000);
}

// a square, wound as TrueType outer contours are, centred on a place of the view (the middle if none)
function newContour(at?: {x: number, y: number}) {
	if (!canEdit())
		return;
	const size = Math.max(gridStep, Math.round(info!.unitsPerEm / 5 / gridStep) * gridStep);
	const x = at?.x ?? inspView.clientWidth / 2, y = at?.y ?? inspView.clientHeight / 2;
	const cx = Math.round(((x - view.x) / view.s - size / 2) / gridStep) * gridStep;
	const cy = Math.round(((y - view.y) / view.s + size / 2) / gridStep) * gridStep;
	const first = glyph!.points.length / 3;
	glyph!.points.push(cx, cy, 0, cx, cy - size, 1, cx + size, cy - size, 1, cx + size, cy, 1);
	picked = -1;
	pickedContour = first;
	commit('Add contour');
	drawInspector();
}

function nudge(dx: number, dy: number) {
	if (!canEdit() || (picked < 0 && pickedContour < 0))
		return;
	const p = glyph!.points;
	const [from, to] = picked >= 0 ? [picked, picked + 1] : [pickedContour, contourOf(pickedContour).e];
	for (let i = from; i < to; i++) {
		p[i * 3] += dx;
		p[i * 3 + 1] += dy;
	}
	drawInspector();
	commit(picked >= 0 ? 'Move point' : 'Move contour');
}

function selectContour(of: number) {
	pickedContour = contourOf(of).s;
	picked = -1;
	drawInspector();
}

function deleteContour() {
	if (!canEdit() || pickedContour < 0)
		return;
	const {s, e} = contourOf(pickedContour);
	glyph!.points.splice(s * 3, (e - s) * 3);
	pickedContour = hover = -1;
	commit('Delete contour');
	drawInspector();
}

function deletePoint() {
	if (pickedContour >= 0 && picked < 0)
		return deleteContour();
	if (!canEdit() || picked < 0)
		return;
	const p = glyph!.points, {s, e} = contourOf(picked);
	if (e - s <= 3)
		return refuse('a contour needs at least 3 points');
	if (picked === s) {
		if (p[(s + 1) * 3 + 2] !== 1)
			return refuse('the next point must be on-curve to begin the contour');
		p[(s + 1) * 3 + 2] = 0;
	}
	p.splice(picked * 3, 3);
	picked = -1;
	hover = -1;
	pickedContour = -1;
	commit('Delete point');
	drawInspector();
}

function togglePoint() {
	if (!canEdit() || picked < 0)
		return;
	const p = glyph!.points;
	if (p[picked * 3 + 2] === 0)
		return refuse('a contour begins on-curve');
	p[picked * 3 + 2] = p[picked * 3 + 2] === 1 ? 2 : 1;
	commit('Change point type');
	drawInspector();
}

// a point halfway between this and the next: it leaves the shape as it was between two on-curve points, or two controls
function insertPoint() {
	if (!canEdit() || picked < 0)
		return;
	const p = glyph!.points, {s, e} = contourOf(picked);
	const j = picked + 1 < e ? picked + 1 : s;
	const on = (i: number) => p[i * 3 + 2] !== 2;
	if (on(picked) !== on(j))
		return refuse('insert between two on-curve points, or two controls');
	p.splice((picked + 1) * 3, 0, Math.round((p[picked * 3] + p[j * 3]) / 2), Math.round((p[picked * 3 + 1] + p[j * 3 + 1]) / 2), 1);
	picked++;
	pickedContour = -1;
	commit('Insert point');
	drawInspector();
}

let drag: {x: number, y: number, moved: boolean, point?: number, contour?: {s: number, e: number, orig: number[], wx: number, wy: number}} | undefined;
inspSvg.addEventListener('pointerdown', e => {
	// the right button (or Ctrl with the left, which a Mac takes for it) is for the context menu, not for dragging
	if (e.button === 2 || (e.button === 0 && e.ctrlKey))
		return;
	inspSvg.setPointerCapture(e.pointerId);
	const rect = inspSvg.getBoundingClientRect();
	const point = canEdit() ? pointAt(e.clientX - rect.left, e.clientY - rect.top) : -1;
	// a point of a glyph that cannot be edited says why, instead of nothing happening
	if (!canEdit() && glyph && pointAt(e.clientX - rect.left, e.clientY - rect.top) >= 0)
		refuse(info?.convertible ? 'read only: right-click and choose Convert to TrueType outlines to edit this font'
			: info?.editable && glyph.components.length ? 'a composite: right-click and choose Decompose to edit it'
			: 'this font cannot be edited');
	drag = {x: e.clientX, y: e.clientY, moved: false, point: point >= 0 ? point : undefined};
	if (point >= 0) {
		picked = point;
		pickedContour = -1;
		drawInspector();
		return;
	}
	// a contour is picked by its outline, and is then dragged as a whole
	const hit = canEdit() ? (e.target as Element).closest<SVGElement>('[data-contour]') : null;
	if (hit) {
		const {s: a, e: b} = contourOf(+hit.dataset.contour!);
		picked = -1;
		pickedContour = a;
		drag.contour = {s: a, e: b, orig: glyph!.points.slice(a * 3, b * 3), wx: (e.clientX - rect.left - view.x) / view.s, wy: (e.clientY - rect.top - view.y) / view.s};
		drawInspector();
	}
});
inspSvg.addEventListener('pointermove', e => {
	const rect = inspSvg.getBoundingClientRect();
	if (drag?.point !== undefined) {
		if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2)
			drag.moved = true;
		if (drag.moved) {
			let x = (e.clientX - rect.left - view.x) / view.s, y = (e.clientY - rect.top - view.y) / view.s;
			const step = inspOption('snap') ? gridStep : 1;
			x = Math.round(x / step) * step;
			y = Math.round(y / step) * step;
			glyph!.points[drag.point * 3] = x;
			glyph!.points[drag.point * 3 + 1] = y;
			drawInspector();
		}
		return;
	}
	if (drag?.contour) {
		if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2)
			drag.moved = true;
		if (drag.moved) {
			const step = inspOption('snap') ? gridStep : 1;
			const dx = Math.round(((e.clientX - rect.left - view.x) / view.s - drag.contour.wx) / step) * step;
			const dy = Math.round(((e.clientY - rect.top - view.y) / view.s - drag.contour.wy) / step) * step;
			const {s: a, orig} = drag.contour;
			for (let i = 0; i < orig.length; i += 3) {
				glyph!.points[a * 3 + i] = orig[i] + dx;
				glyph!.points[a * 3 + i + 1] = orig[i + 1] + dy;
			}
			drawInspector();
		}
		return;
	}
	if (drag) {
		if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3)
			drag.moved = true;
		if (drag.moved) {
			view.x += e.clientX - drag.x;
			view.y += e.clientY - drag.y;
			drag.x = e.clientX;
			drag.y = e.clientY;
			drawInspector();
		}
		return;
	}
	const at = pointAt(e.clientX - rect.left, e.clientY - rect.top);
	if (at !== hover) {
		hover = at;
		drawInspector();
	}
});
inspSvg.addEventListener('pointerleave', () => {
	if (!drag && hover >= 0) {
		hover = -1;
		drawInspector();
	}
});
inspSvg.addEventListener('pointerup', e => {
	if (inspSvg.hasPointerCapture(e.pointerId))
		inspSvg.releasePointerCapture(e.pointerId);
	if (drag?.point !== undefined && drag.moved)
		commit('Move point');
	else if (drag?.contour) {
		if (drag.moved)
			commit('Move contour');
	} else if (drag && !drag.moved) {
		const rect = inspSvg.getBoundingClientRect();
		picked = pointAt(e.clientX - rect.left, e.clientY - rect.top);
		if (picked >= 0 || drag.point === undefined)
			pickedContour = -1;
		drawInspector();
	}
	drag = undefined;
});
//--- the context menu --------------------------------------------------------

const menu = $('insp-menu');
interface MenuItem { label: string; keys?: string; run: () => void; enabled?: boolean }

function closeMenu() {
	menu.classList.add('hidden');
}

function showMenu(items: (MenuItem | '-')[], x: number, y: number) {
	menu.textContent = '';
	for (const item of items) {
		const row = document.createElement('div');
		if (item === '-') {
			row.className = 'menu-sep';
		} else {
			row.className = 'menu-item' + (item.enabled === false ? ' disabled' : '');
			const label = document.createElement('span');
			label.textContent = item.label;
			const keys = document.createElement('span');
			keys.className = 'menu-keys';
			keys.textContent = item.keys ?? '';
			row.append(label, keys);
			if (item.enabled !== false)
				row.addEventListener('click', () => { closeMenu(); item.run(); });
		}
		menu.appendChild(row);
	}
	menu.classList.remove('hidden');
	// kept inside the window
	menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
	menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
}

inspSvg.addEventListener('contextmenu', e => {
	e.preventDefault();
	const rect = inspSvg.getBoundingClientRect();
	const here = {x: e.clientX - rect.left, y: e.clientY - rect.top};
	if (canEdit()) {
		const at = pointAt(here.x, here.y);
		const hit = (e.target as Element).closest<SVGElement>('[data-contour]');
		if (at >= 0) {
			picked = at;
			pickedContour = -1;
		} else if (hit) {
			picked = -1;
			pickedContour = contourOf(+hit.dataset.contour!).s;
		}
		drawInspector();
	}
	const items: (MenuItem | '-')[] = [];
	if (canEdit()) {
		const point = picked >= 0, contour = pickedContour >= 0;
		items.push(
			{label: 'Delete point', keys: point ? 'Del' : '', run: deletePoint, enabled: point},
			{label: 'Delete contour', keys: contour ? 'Del' : '', run: () => { if (picked >= 0) selectContour(picked); deleteContour(); }, enabled: contour || point},
			{label: 'Select contour', run: () => selectContour(picked), enabled: point},
			'-',
			{label: 'Toggle on-curve / control', keys: 'T', run: togglePoint, enabled: point},
			{label: 'Insert point after', keys: 'I', run: insertPoint, enabled: point},
			'-',
			{label: 'New contour here', run: () => newContour(here)},
			'-',
		);
	} else if (info?.editable && glyph?.components.length) {
		items.push({label: 'Decompose', run: () => commit('Decompose glyph')}, '-');
	} else if (info?.convertible) {
		items.push({label: 'Convert to TrueType outlines…', run: () => post({command: 'convertFont'})}, '-');
	}
	items.push(
		{label: 'Fit glyph', keys: '0', run: () => { fitInspector(); drawInspector(); }},
		{label: 'Zoom in', keys: '+', run: () => zoomInspector(1.5)},
		{label: 'Zoom out', keys: '-', run: () => zoomInspector(1 / 1.5)},
		'-',
		{label: 'Back to the glyphs', keys: 'Esc', run: closeInspector},
	);
	showMenu(items, e.clientX, e.clientY);
});
document.addEventListener('pointerdown', e => {
	if (!menu.contains(e.target as Node))
		closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

inspSvg.addEventListener('wheel', e => {
	e.preventDefault();
	const rect = inspSvg.getBoundingClientRect();
	zoomInspector(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - rect.left, e.clientY - rect.top);
}, {passive: false});

$('insp-back').addEventListener('click', closeInspector);
$('insp-prev').addEventListener('click', () => stepInspector(-1));
$('insp-next').addEventListener('click', () => stepInspector(1));
$('insp-fit').addEventListener('click', () => { fitInspector(); drawInspector(); });
for (const name of ['grid', 'metrics', 'fill', 'outline', 'polygon', 'points', 'numbers'])
	$('insp-' + name).addEventListener('change', drawInspector);
new ResizeObserver(drawInspector).observe(inspView);

document.addEventListener('keydown', e => {
	if (inspecting < 0 || (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text')
		return;
	if (canEdit() && (picked >= 0 || pickedContour >= 0)) {
		const d = e.shiftKey ? 10 : 1;
		switch (e.key) {
			case 'ArrowLeft':	nudge(-d, 0); break;
			case 'ArrowRight':	nudge(d, 0); break;
			case 'ArrowUp':		nudge(0, -d); break;
			case 'ArrowDown':	nudge(0, d); break;
			case 'Delete': case 'Backspace': deletePoint(); break;
			case 't':			togglePoint(); break;
			case 'i':			insertPoint(); break;
		}
		if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 't', 'i'].includes(e.key)) {
			e.preventDefault();
			return;
		}
	}
	switch (e.key) {
		case 'Escape':		if (!menu.classList.contains('hidden')) closeMenu(); else closeInspector(); break;
		case 'ArrowLeft':	stepInspector(-1); break;
		case 'ArrowRight':	stepInspector(1); break;
		case '+': case '=':	zoomInspector(1.5); break;
		case '-':			zoomInspector(1 / 1.5); break;
		case '0':			fitInspector(); drawInspector(); break;
		default:			return;
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
	const svg = document.createElementNS(SVG, 'svg');
	for (const id of ids) {
		const g = document.createElementNS(SVG, 'g');
		g.setAttribute('transform', `translate(${x} 0)`);
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

const tablesView	= $('font-tables');

function row(node: TableNode, path: string[]) {
	const li = document.createElement('li');
	const line = document.createElement('div');
	line.className = 'tree-row';
	const twisty = document.createElement('span');
	twisty.className = 'twisty';
	const openable = !!node.count;
	twisty.textContent = openable ? '▸' : '';
	const key = document.createElement('span');
	key.className = 'tree-key';
	key.textContent = node.key ?? '';
	const value = document.createElement('span');
	value.className = 'tree-value ' + node.type;
	value.textContent = node.value;
	line.append(twisty, key, value);
	li.appendChild(line);

	if (openable) {
		let list: HTMLElement | undefined;
		line.classList.add('openable');
		line.addEventListener('click', async () => {
			if (list) {
				const hide = !list.classList.toggle('hidden');
				twisty.textContent = hide ? '▾' : '▸';
				return;
			}
			list = document.createElement('ul');
			li.appendChild(list);
			twisty.textContent = '▾';
			fillList(list, path, await RPC<TableNode[]>({command: 'getTable', path}));
		});
	}
	return li;
}

function fillList(list: HTMLElement, path: string[], nodes: TableNode[]) {
	for (const node of nodes)
		list.appendChild(row(node, [...path, node.key!]));
}

async function buildTables() {
	tablesView.textContent = '';
	const heading = document.createElement('div');
	heading.className = 'tree-heading';
	heading.textContent = 'Tables';
	tablesView.appendChild(heading);
	const list = document.createElement('ul');
	list.className = 'tree';
	tablesView.appendChild(list);
	try {
		fillList(list, [], await RPC<TableNode[]>({command: 'getTable', path: []}));
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
		['File', info.file],
		['Family', info.family],
		['Style', info.style],
		['Glyphs', info.numGlyphs.toLocaleString()],
		['Mapped', Object.keys(info.unicodes).length.toLocaleString()],
		['Units/em', String(info.unitsPerEm)],
		['Ascent', String(info.ascent)],
		['Descent', String(info.descent)],
		['Line gap', String(info.lineGap)],
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
			glyphChanged(message.id);
			break;
		case 'error':
			showError(message.message);
			break;
	}
});

post({command: 'ready'});
