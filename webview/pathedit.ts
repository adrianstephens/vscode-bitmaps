// The outline editor shared by the font viewer's glyph inspector and the SVG editor: a pan and zoom view over a grid, the
// points of one outline drawn over whatever the page shows, and the editing of them (drag, nudge, insert, delete, toggle,
// select a contour, drag a contour) with a menu of icons (cascade.ts) that the right button brings up. What is being edited is a
// curve as binary_fonts has it: a list of vertices, x, y and flags, where ON_BEGIN begins a contour, which is closed back to its begin
// point unless its last point is ON_END (SVG only), ON_CURVE is on-curve, OFF_BEZ2 a quadratic control and OFF_BEZ3 a cubic control.
// A control after a control stands for the on-curve point halfway between them, as in TrueType.
// A page subclasses it for what it draws under the points and what its edits do.

import { createSVGElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Cascade, CascadeItem, svgFace, valueFace, valueItem, toggleItem, choiceItem } from './cascade.js';
import { TransformMode, partAt, transformCursor, dragMode, dragQuad, boxHandles, transformIcons, HANDLE, rectToQuad, rectCorners, applyH } from './transformbox.js';
import { float2, float2x3, float3x3, lerp, mid } from '@isopodlabs/maths/vector';
import { bezier2, bezier3, bezierClosest } from '@isopodlabs/maths/geometry';
import { parseCurve, curveVertex, ON_BEGIN, ON_CURVE, ON_END, OFF_BEZ2, OFF_BEZ3 } from '@isopodlabs/binary_fonts';


export type ShapeKind = 'rect' | 'ellipse' | 'line';
export interface ToolChoice { value: string, face: string, caption: string }

export const isBegin	= (flags: number) => flags === ON_BEGIN;
export const isControl	= (flags: number) => flags === OFF_BEZ2 || flags === OFF_BEZ3;

// x' = a x + c y + e, y' = b x + d y + f
// a matrix as the six numbers of an SVG transform: columns x and y, then the translation
export const svgMatrix = (m: float2x3) => `${m.x.x} ${m.x.y} ${m.y.x} ${m.y.y} ${m.z.x} ${m.z.y}`;

// a homography which is affine, as a matrix of the 2D transform
const affineOf = (h: float3x3) => float2x3(float2(h.x.x / h.z.z, h.x.y / h.z.z), float2(h.y.x / h.z.z, h.y.y / h.z.z), float2(h.z.x / h.z.z, h.z.y / h.z.z));

const num	= (n: number) => +n.toFixed(2);
const clean	= (n: number) => +n.toFixed(4);

const KIND = ['begin', 'on-curve', 'quadratic control', 'cubic control', 'end (open)'];

// the outline as path data: contours that begin at an ON_BEGIN, left open where they end at an ON_END
export function svgPath(p: Iterable<curveVertex>) {
	let d = '';
	parseCurve(p).run({
		Begin:	a => { d += `M${a.x},${a.y}`; },
		// the line that closes a contour is the path's own Z
		Line:	(_a, b) => { /*if (p[at![1]].flags !== ON_BEGIN)*/ d += `L${b.x},${b.y}`; },
		Bezier2: (_a, b, c) => { d += `Q${b.x},${b.y},${c.x},${c.y}`; },
		Bezier3: (_a, b, c, e) => { d += `C${b.x},${b.y},${c.x},${c.y},${e.x},${e.y}`; },
		End:	open => { d += open ? '' : 'Z'; },
	});
	return d;
}

// where the contour of point i begins and ends (exclusive)
function contourRange(p: curveVertex[], i: number) {
	const n = p.length;
	let s = i, e = i + 1;
	while (s > 0 && !isBegin(p[s].flags))
		s--;
	while (e < n && !isBegin(p[e].flags))
		e++;
	return {s, e};
}

// copy of parseCurve because I don't want those 'at's
function pieces(curves: Iterable<curveVertex>) {

	interface taggedVert { pt: float2; at: number; }

	const out: Piece[] = [];
	const add = (points: taggedVert[]) => out.push({points: points.map(v => v.pt), at: points.map(v => v.at)});

	let start:	taggedVert	= {pt: float2(0, 0), at: -1};
	let prev:	taggedVert	= {pt: float2(0, 0), at: -1};
	let prev2:	taggedVert	= {pt: float2(0, 0), at: -1};
	let prev3:	taggedVert	= {pt: float2(0, 0), at: -1};

	let prev_flags		= ON_BEGIN;
	let prev2_flags 	= ON_BEGIN;

	function on_curve(pt: taggedVert) {
		switch (prev_flags) {
			case ON_BEGIN:
			case ON_CURVE:
			case OFF_BEZ2:	add([prev2, prev, pt]); break;
			case OFF_BEZ3:	add([prev3, prev2, prev, pt]); break;
		}
	}

	let at = 0;
	for (const i of curves) {
		let flags	= i.flags;
		let pt		= {pt: float2(i.x, i.y), at: at++};
		switch (flags) {
			case ON_BEGIN:
				if (prev_flags)
					on_curve(start);
				start	= pt;
				break;

			case ON_CURVE:
				on_curve(pt);
				break;

			case ON_END:
				on_curve(pt);
				flags = ON_BEGIN;
				break;

			case OFF_BEZ2:
				if (prev_flags > 1) {
					const implied = {pt: mid(prev.pt, pt.pt), at: -1};
					on_curve(implied);
					prev = implied;
				}
				break;

			case OFF_BEZ3:
				if (prev_flags == 8) {
					on_curve(pt);
					[pt, prev] = [prev, pt];

				} else if (prev_flags > 2 && prev2_flags > 1) {
					const implied = {pt: mid(prev.pt, pt.pt), at: -1};
					on_curve(implied,);
					prev	= implied;
					flags	= OFF_BEZ2;
				}
				break;

			default:
				break;
		}

		[prev3, prev2, prev]		= [prev2, prev, pt];
		[prev2_flags, prev_flags]	= [prev_flags, flags];
	}

	if (prev_flags)
		on_curve(start);
	return out;
}

// what a press on something other than a point drags: the page is told how far (in world units, snapped) and when it ends
// (`raw`: not snapped or rounded, and from the first movement, as a pen's stroke is)
// A page that keeps what is edited as an element with a transform of its own can take a free transform as that, and leave the
// points as they are. It gives a function which carries the element by a matrix of the world, from where it was when the
// function was made: shown as it is carried, or (with a label) done for good. Such a matrix can only be affine.
export type ElementTransform = (m: float2x3, label?: string) => void;

export interface DragHandler { move(dx: number, dy: number, e: PointerEvent): void; end(moved: boolean): void; raw?: boolean }

// a line, a quadratic or a cubic of the outline: the points that define it, and where each is in the outline (-1 if implied)
export interface Piece { points: float2[], at: number[] }

const curveOf = ({points}: Piece) => points.length === 4 ? new bezier3(points[0], points[1], points[2], points[3])
	: new bezier2(points[0], points.length === 2 ? lerp(points[0], points[1], 0.5) : points[1], points[points.length - 1]);

// what is drawn and how points land, which a page may share between the editors it has over the same place
export class ViewOptions {
	constructor(private values: Record<string, boolean> = {}) {}
	get(name: string) { return this.values[name] ?? DEFAULT_OPTIONS[name] ?? true; }
	set(name: string, on: boolean) { this.values[name] = on; }
}
const DEFAULT_OPTIONS: Record<string, boolean> = {numbers: false, snap: false};

export const icons = {
	...transformIcons,
	transform:	'<path d="M4 4.5h8v7H4z"/><rect x="2.5" y="3" width="3" height="3"/><rect x="10.5" y="3" width="3" height="3"/><rect x="10.5" y="10" width="3" height="3"/><rect x="2.5" y="10" width="3" height="3"/>',
	editPoints:	'<path d="M2 12 C5 2 11 2 14 12"/><rect x="1" y="11" width="3" height="3"/><rect x="12" y="11" width="3" height="3"/><circle cx="8" cy="4.5" r="1.3"/>',
	view:		'<path d="M1 8 C4 3 12 3 15 8 C12 13 4 13 1 8Z"/><circle cx="8" cy="8" r="2"/>',
	deletePoint:'<rect x="5" y="5" width="6" height="6"/><path d="M2 2L14 14M14 2L2 14"/>',
	simplify:	'<path d="M2 12C5 3 11 3 14 12"/><rect x="1" y="11" width="3" height="3"/><rect x="12" y="11" width="3" height="3"/>',
	deleteContour:'<path d="M3 3H13V13H3Z"/><path d="M5 5L11 11M11 5L5 11"/>',
	selectContour:'<path d="M3 3H13V13H3Z" stroke-dasharray="2 2"/><rect x="2" y="2" width="3" height="3"/>',
	insert:		'<path d="M2 12H14"/><rect x="6" y="10" width="4" height="4"/><path d="M8 2V7M5.5 4.5H10.5"/>',
	toggle:		'<rect x="2" y="9" width="4" height="4"/><circle cx="11" cy="5" r="2.5"/><path d="M6 11L9 7"/>',
	align:		'<path d="M2 13L14 3"/><rect x="6" y="6" width="4" height="4"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="4" r="1.5"/>',
	insertControl:'<path d="M2 13C2 5 8 3 14 3"/><circle cx="8" cy="4.5" r="1.6"/><rect x="1" y="12" width="3" height="3"/><rect x="12" y="1" width="3" height="3"/>',
	fit:		'<path d="M2 6V2H6M10 2H14V6M14 10V14H10M6 14H2V10"/>',
	grid:		'<path d="M2 2H14V14H2ZM6 2V14M10 2V14M2 6H14M2 10H14"/>',
	outline:	'<path d="M3 13C3 4 8 2 13 3C14 8 12 13 3 13Z"/>',
	polygon:	'<path d="M3 13L5 3L13 5L12 13Z" stroke-dasharray="2 1.5"/>',
	points:		'<rect x="2" y="9" width="4" height="4"/><circle cx="11" cy="4.5" r="2"/><rect x="10" y="10" width="4" height="4"/>',
	numbers:	'<path d="M4 3V13M2.5 4.5L4 3M8 5C8 2 13 2 13 5C13 8 8 9 8 13H13"/>',
	snap:		'<path d="M2 14H14M2 14V2M5 14V11M8 14V11M11 14V11"/><circle cx="8" cy="6" r="2"/>',
	metrics:	'<path d="M1 4H15M1 8H15M1 12H15" stroke-dasharray="3 2"/>',
	fill:		'<path d="M3 13C3 4 8 2 13 3C14 8 12 13 3 13Z" fill="currentColor" fill-opacity="0.45"/>',
};

const VIEW_TOGGLES: Record<string, string> = {
	grid:		'Grid',
	outline:	'Outline', 
	polygon:	'Polygon', 
	points:		'Points',
	numbers:	'Point numbers', 
	snap:		'Snap to the grid', 
	metrics:	'Metrics', 
	fill:		'Fill',
};

interface TransformSet {box: float2.extent, quad: float2[], s: number, orig: curveVertex[], mode: TransformMode, element?: ElementTransform};

export abstract class PathEditor {
	readonly svg	= createSVGElement('svg');
	protected readonly back		= createSVGElement('g');
	protected readonly content	= createSVGElement('g');
	protected readonly front	= createSVGElement('g');

	view			= {x: 0, y: 0, s: 1};		// screen = world * s + (x, y), the world being the page's, y down
	matrix			= float2x3.identity();		// the points' own space to the world
	hover			= -1;
	picked			= -1;
	pickedContour	= -1;						// where the selected contour begins, when a whole contour is selected, or -1
	notice			= '';
	gridStep		= 1;						// the grid's spacing as last drawn, which points snap to
	tool			= 'select';					// what a press on empty ground does: 'select', a shape dragged out, or what a page adds

	protected yUp		= false;			// whether the grid is numbered upward, as a font's is, though the points are y down
	protected rounding	= 1;				// what a point lands on when snapping is off: 0 for anything
	protected cubic		= false;			// whether cubic controls may be made
	protected dragged?: {kind: ShapeKind, corners: number[]};	// the shape being dragged out, from corner to corner in world units
	protected drag?: {x: number, y: number, moved: boolean, point?: number, link?: {anchor: number, other: number, length: number}, custom?: DragHandler & {wx: number, wy: number}, contour?: {s: number, e: number, orig: curveVertex[], wx: number, wy: number, last?: number[], t?: number[], angle?: number}, rotated?: boolean};
	protected extraViews: string[] = [];		// view options beyond the common ones
	protected readonly cascade: Cascade;

	private noticeTimer = 0;
	// a simplification being previewed: the contour (or all of them) as it was, and what it is now, shown in place of it
	private simplifyPx	= 1.5;		// how far it may move the outline, in pixels of the view
	private simplifying?:	{s: number, len: number, orig: curveVertex[], target: curveVertex[], token: number};
	private lastPress?: 	{t: number, x: number, y: number};	// the last press of the line tool, for a double click
	private lineStart?: 	number[];		// where a line begins once its first click is made, before any segment is
	private lineHover?: 	{x: number, y: number, shift: boolean};	// where the pointer is, for the segment on its way
	private chain?:			{s: number};		// the contour a line began, which the next goes on from
	private lastBounds?:	{w: number, h: number};
	private xf?:			TransformSet;

	private menuAt		= {x: 0, y: 0};
	private menuScope:	'points' | 'element' = 'points';	// what a transform from the menu is of: the points (it was opened over one, or the outline) or the element
	private menuCurve:	{piece: Piece, t: number} | undefined;	// the place on the outline that the menu was opened over

	get dragging() { return !!this.drag; }

	constructor(readonly host: HTMLElement, readonly options = new ViewOptions()) {
		this.cascade = new Cascade(host, () => this.menuItems());
		this.svg.append(this.back, this.content, this.front);
		host.appendChild(this.svg);
		this.listen();
		new ResizeObserver(() => this.draw()).observe(host);
	}

	//--- what a page supplies ----------------------------------------------------

	/** The points being edited, which the editor changes in place; undefined when there is nothing to show. */
	abstract points(): curveVertex[] | undefined;
	/** Whether they may be changed. */
	abstract canEdit(): boolean;
	/** Whether they may be added to, removed or made into curves, or only moved. */
	protected structural(): boolean { return true; }
	/** The points were changed: the page records an edit with this label. */
	abstract commit(label: string): void;
	/** What is said of what is under the pointer. */
	abstract status(text: string): void;
	/** Whether the editor is showing at all. */
	abstract active(): boolean;
	/** What the page says when no point or contour is in question. */
	abstract describe(): string;
	/** The extent of what the view fits, in world units. */
	abstract bounds(): {x0: number, y0: number, x1: number, y1: number};

	/** Draws what lies under the outline into the content group, which is in world units. */
	protected updateContent(_g: SVGGElement) {}
	/** Markup in screen units, drawn first: what the grid lies over. */
	protected paper(_X: (x: number) => number, _Y: (y: number) => number, _w: number, _h: number): string { return ''; }
	/** Markup in screen units, drawn over the grid and under the content. */
	protected guides(_X: (x: number) => number, _Y: (y: number) => number, _w: number, _h: number): string { return ''; }
	/** The outline drawn over the content, as path data in the points' own space. */
	//protected outline(): string { return svgPath(this.points() ?? []); }
	/** Markup drawn over everything, in screen units. */
	protected overlay(): string { return ''; }
	protected defaultSize(): number { return 100; }
	protected formatPoint(x: number, y: number): string { return `(${num(x)}, ${num(y)})`; }
	/** Why the points cannot be edited, which a click on one says. */
	protected readOnlyReason(): string { return 'this cannot be edited'; }
	/** A click that neither picked a point nor moved the view; (x, y) is in the view's pixels. */
	protected clicked(_e: PointerEvent, _x: number, _y: number) {}
	/** A press, before anything under it is looked at: the page may take it, as a pen does wherever it lands. */
	protected capture(_e: PointerEvent, _x: number, _y: number): DragHandler | undefined { return undefined; }
	/** Whether shapes may be drawn: by default, when contours may be added. */
	protected canDraw(): boolean { return this.canStructure(); }
	/** The shapes the page can make of a drag. */
	protected shapeKinds(): ShapeKind[] { return ['rect', 'ellipse', 'line']; }
	/** The tools a page has beyond select and the shapes, which it takes the presses of in `capture` when chosen. */
	protected extraTools(): ToolChoice[] { return []; }
	/** Where a line goes on from, in world units, if the last one drawn is to be continued: each press then adds a segment from
	 *  there. By default it is the end of the contour the last line began (a polygon, closed back to its first point). */
	protected lineContinues(): number[] | undefined {
		const p = this.points(), c = this.chain;
		if (!c || !p || !this.canStructure() || c.s >= p.length)
			return;
		const {s, e} = this.contourOf(c.s);
		if (s !== c.s || e !== p.length || p[s].flags !== ON_BEGIN)
			return;
		const w = this.matrix.mulPos(float2(p[(e - 1)].x, p[(e - 1)].y));
		return [w.x, w.y];
	}
	/** Ends the continuing of a line, saying whether there was one. */
	protected endChain(): boolean {
		const c = this.chain, p = this.points(), started = this.lineStart !== undefined;
		this.chain = this.lineStart = undefined;
		if (!c || !p)
			return started;
		// a line that was not gone on from is not a contour, and is taken away as the last one
		if (c.s < p.length && p[c.s].flags === ON_BEGIN && this.contourOf(c.s).e === p.length && p.length - c.s < 3) {
			p.splice(c.s);
			this.pickedContour = -1;
		}
		return true;
	}
	/** What the page does when the tool is changed. */
	protected toolChanged() { this.endChain(); }
	/** A shape was dragged out from corner (x0, y0) to (x1, y1), in world units: the page adds it. By default it is a contour. */
	protected addShape(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number) { this.addShapeContour(kind, x0, y0, x1, y1); }
	/** Whether a press on this part of the drawing drags something (the page's `grab`), and not the view. */
	protected draggable(_target: Element): boolean { return false; }
	/** If the page can carry what is edited by a transform of its own, the way it does that; the points are then left alone. */
	protected beginElementTransform(): ElementTransform | undefined { return undefined; }
	/** A press that took no point or contour: the page may take it to drag something. */
	protected grab(_e: PointerEvent, _x: number, _y: number): DragHandler | undefined { return undefined; }
	/** The points with fewer of them, the outline kept within tol; a page that cannot do this leaves it out, and the menu has no simplify. */
	protected simplifyPoints?(points: curveVertex[], tol: number): Promise<curveVertex[]>;
	/** What the page puts at the head of the menu, ahead of the editing and the view. */
	protected pageItems(_here: {x: number, y: number}): CascadeItem[] { return []; }
	/** Items that are the whole menu for where it was opened, in place of the page's and the editor's. */
	protected menuOnly(_here: {x: number, y: number}): CascadeItem[] | undefined { return undefined; }

	//--- options ------------------------------------------------------------------

	option(name: string) {
		return this.options.get(name);
	}

	//--- coordinates --------------------------------------------------------------

	toScreen(x: number, y: number): [number, number] {
		const w = this.matrix.mulPos(float2(x, y));
		return [w.x * this.view.s + this.view.x, w.y * this.view.s + this.view.y];
	}
	toWorld(sx: number, sy: number): [number, number] {
		return [(sx - this.view.x) / this.view.s, (sy - this.view.y) / this.view.s];
	}
	toLocal(sx: number, sy: number): [number, number] {
		const l = this.matrix.inverse().mulPos(float2(...this.toWorld(sx, sy)));
		return [l.x, l.y];
	}
	private local(e: {clientX: number, clientY: number}) {
		const rect = this.svg.getBoundingClientRect();
		return {x: e.clientX - rect.left, y: e.clientY - rect.top};
	}
	private snapped(sx: number, sy: number): [number, number] {
		const step = this.option('snap') ? this.gridStep : this.rounding;
		let [wx, wy] = this.toWorld(sx, sy);
		if (step) {
			wx = Math.round(wx / step) * step;
			wy = Math.round(wy / step) * step;
		}
		const {x, y} = this.matrix.inverse().mulPos(float2(wx, wy));
		return this.rounding ? [Math.round(x), Math.round(y)] : [clean(x), clean(y)];
	}

	//--- the view -----------------------------------------------------------------

	reset() {
		this.endSimplify(false);
		this.xf		= undefined;
		this.chain	= this.lineStart = undefined;
		this.notice	= '';
		this.hover	= this.picked = this.pickedContour = -1;
		this.drag	= undefined;
	}

	// the bounds in the middle of the view, at the scale that fits them or the one given
	fit(scale?: number) {
		const w		= this.host.clientWidth, h = this.host.clientHeight, b = this.bounds();
		const s		= scale ?? Math.max(0.001, Math.min((w - 80) / (b.x1 - b.x0 || 1), (h - 80) / (b.y1 - b.y0 || 1)));
		this.view	= {s, x: (w - (b.x1 - b.x0) * s) / 2 - b.x0 * s, y: (h - (b.y1 - b.y0) * s) / 2 - b.y0 * s};
		this.draw();
	}

	// zoom about a point of the view, which stays where it is
	zoom(factor: number, cx = this.host.clientWidth / 2, cy = this.host.clientHeight / 2) {
		const s = Math.max(0.005, Math.min(this.view.s * factor, 4000));
		factor = s / this.view.s;
		this.view = {s, x: cx - (cx - this.view.x) * factor, y: cy - (cy - this.view.y) * factor};
		this.draw();
	}

	// what the status line says for a few seconds in place of what is under the pointer: why something was not done
	refuse(message: string) {
		this.notice = message;
		this.draw();
		clearTimeout(this.noticeTimer);
		this.noticeTimer = window.setTimeout(() => { this.notice = ''; this.draw(); }, 4000);
	}

	//--- drawing ------------------------------------------------------------------

	draw() {
		this.svg.style.display = this.active() ? '' : 'none';
		this.svg.classList.toggle('drawing', this.tool !== 'select' && this.active() && this.canDraw());
		this.svg.dataset.tool = this.tool;
		if (!this.active())
			return;
		const w = this.host.clientWidth, h = this.host.clientHeight, {s} = this.view;
		if (!w || !h)
			return;

		const editable	= this.canEdit();
		const points	= this.points();
		if (this.xf && (editable || !points || points.length < this.xf.s + this.xf.orig.length))
			this.xf = undefined;
		
		const X = (x: number) => x * s + this.view.x, Y = (y: number) => y * s + this.view.y;
		if (!this.lastBounds || this.lastBounds.w !== w || this.lastBounds.h !== h) {
			this.svg.setAttribute('width', String(w));
			this.svg.setAttribute('height', String(h));
			this.lastBounds = {w, h};
		}

		let back = this.paper(X, Y, w, h);

		// a grid of round numbers of the page's units, as fine as keeps its lines apart on the screen
		if (this.option('grid')) {
			const raw	= 12 / s, pow = 10 ** Math.floor(Math.log10(raw));
			const step	= this.gridStep = [1, 2, 5, 10].map(k => k * pow).find(v => v >= raw)!;
			const every	= Math.round(step / pow) === 5 ? 2 : 5;
			let minor = '', major = '', labels = '';
			const lines = (from: number, to: number, vertical: boolean, flip: number) => {
				for (let k = Math.ceil(from / step); k <= Math.floor(to / step); k++) {
					const v = clean(k * step), at = vertical ? X(v) : Y(v * flip);
					const d = vertical ? `M${num(at)},0V${h}` : `M0,${num(at)}H${w}`;
					if (k % every === 0) {
						major += d;
						labels += vertical ? `<text x="${num(at) + 3}" y="11">${v}</text>` : `<text class="right" x="${w - 3}" y="${num(at) - 3}">${v}</text>`;
					} else
						minor += d;
				}
			};
			lines(-this.view.x / s, (w - this.view.x) / s, true, 1);
			if (this.yUp)
				lines(-(h - this.view.y) / s, this.view.y / s, false, -1);
			else
				lines(-this.view.y / s, (h - this.view.y) / s, false, 1);
			back += `<path class="insp-minor" d="${minor}"/><path class="insp-major" d="${major}"/><g class="insp-labels">${labels}</g>`;
		}

		if (this.option('metrics'))
			back += this.guides(X, Y, w, h);
		this.back.innerHTML = back;

		this.content.setAttribute('transform', `translate(${num(this.view.x)} ${num(this.view.y)}) scale(${s})`);
		this.updateContent(this.content);

		const g = `<g transform="translate(${num(this.view.x)} ${num(this.view.y)}) scale(${s}) matrix(${svgMatrix(this.matrix)})">`;
		const out: string[] = [];
		if (points) {
			const n = points.length;

			if (this.option('outline'))
				out.push(`${g}<path class="insp-outline" vector-effect="non-scaling-stroke" d="${svgPath(points)}"/></g>`);

			// each contour has a wide invisible stroke to be picked by, and the selected one is drawn over the rest
			if (editable && this.structural()) {
				if (this.pickedContour >= 0 && !isBegin(points[this.pickedContour].flags))
					this.pickedContour = -1;
				let hits = '';
				for (let c = 0; c < n;) {
					let e = c + 1;
					while (e < n && !isBegin(points[e].flags))
						e++;
					const d = svgPath(points.slice(c, e));
					hits += `<path class="insp-hit" data-contour="${c}" vector-effect="non-scaling-stroke" d="${d}"/>`;
					if (c === this.pickedContour)
						hits += `<path class="insp-selected" vector-effect="non-scaling-stroke" d="${d}"/>`;
					c = e;
				}
				out.push(`${g}${hits}</g>`);
			}

			const screen = (i: number) => this.toScreen(points[i].x, points[i].y);
			if (this.option('polygon')) {
				let d = '';
				for (let s = 0; s < n;) {
					let e = s + 1;
					while (e < n && !isBegin(points[e].flags))
						e++;
					for (let i = s; i < e; i++) {
						const [x, y] = screen(i);
						d += `${i === s ? 'M' : 'L'}${num(x)},${num(y)}`;
					}
					d += points[(e - 1)].flags !== ON_END ? 'Z' : '';
					s = e;
				}
				out.push(`<path class="insp-polygon" d="${d}"/>`);
			}
			if (this.option('points') || this.pickedContour >= 0 || this.picked >= 0) {
				const contour = this.pickedContour >= 0 ? this.contourOf(this.pickedContour) : this.picked >= 0 ? this.contourOf(this.picked) : undefined;
				for (let i = 0; i < n; i++) {
					const inContour = contour && i >= contour.s && i < contour.e;
					if (inContour || this.option('points')) {
						const [sx, sy] = screen(i), x = num(sx), y = num(sy), flags = points[i].flags;
						const cls	= `insp-pt k${flags}${i === this.picked ? ' picked' : i === this.hover ? ' hover' : ''}${inContour ? ' in-contour' : ''}`;
						const r		= i === this.hover || i === this.picked ? 5 : 3.5;
						out.push(isControl(flags)
							? `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`
							: `<rect class="${cls}" x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}"/>`);
						if (this.option('numbers'))
							out.push(`<text class="insp-num" x="${x + 6}" y="${y - 6}">${i}</text>`);
					}
				}
			}
		}
		out.push(this.shapePreview(), this.overlay(), this.transformMarkup());
		this.front.innerHTML = out.join('');
		this.report();
	}

	private report() {
		if (this.notice)
			return this.status(this.notice);
		const points = this.points();
		if (points && this.pickedContour >= 0 && this.hover < 0) {
			const {s, e} = this.contourOf(this.pickedContour);
			return this.status(`contour of ${e - s} points selected · drag to move, Del to delete`);
		}
		const shown = this.hover >= 0 ? this.hover : this.picked;
		if (points && shown >= 0 && shown < points.length)
			this.status(`point ${shown} · ${KIND[points[shown].flags] ?? 'flags ' + points[shown].flags} · ${this.formatPoint(points[shown].x, points[shown].y)}`);
		else
			this.status(this.describe());
	}

	//--- the contours ---------------------------------------------------------------

	// where the contour of point i begins and ends (exclusive)
	contourOf(i: number) {
		return contourRange(this.points()!, i);
	}

	contourCurve(i: number): Iterable<curveVertex> {
		const p = this.points()!;
		const {s, e} = contourRange(p, i);
		return {
			[Symbol.iterator]: () => {
				i = s;
				return {
					next: () => i >= e ? {done: true, value: p[0]} : {value: p[i++]}
				};
			}
		};
	}

	// the point of the outline nearest a place on the screen, if one is near enough to be meant
	pointAt(x: number, y: number) {
		let best = -1, bestD = 10 * 10;
		if (this.option('points') || this.pickedContour >= 0 || this.picked >= 0) {
			const p = this.points() ?? [];
			const {s, e} = this.option('points') ? {s: 0, e: p.length} : this.contourOf(this.pickedContour >= 0 ? this.pickedContour : this.picked);
			for (let i = s; i < e; i++) {
				const [sx, sy] = this.toScreen(p[i].x, p[i].y);
				const d = (sx - x) ** 2 + (sy - y) ** 2;
				if (d < bestD) {
					bestD = d;
					best = i;
				}
			}
		}
		return best;
	}

	//--- editing --------------------------------------------------------------------

	private canStructure() {
		return this.canEdit() && this.structural();
	}


	//--- drawing shapes -------------------------------------------------------------

	// the corners of a shape dragged from `a` to `b`: Shift makes it square, round or (a line) a multiple of 45 degrees, and
	// Alt draws it outwards from `a`
	setTool(tool: string) {
		this.endTransform(true);
		this.tool = tool;
		this.toolChanged();
		this.draw();
	}

	private shapeCorners(kind: ShapeKind, a: number[], b: number[], shift: boolean, alt: boolean) {
		let [x, y] = b, [x0, y0] = a;
		if (shift) {
			if (kind === 'line') {
				const angle = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(x - x0, y - y0);
				x = x0 + Math.cos(angle) * d;
				y = y0 + Math.sin(angle) * d;
			} else {
				const d = Math.max(Math.abs(x - x0), Math.abs(y - y0));
				x = x0 + Math.sign(x - x0 || 1) * d;
				y = y0 + Math.sign(y - y0 || 1) * d;
			}
		}
		if (alt) {
			x0 = 2 * a[0] - x;
			y0 = 2 * a[1] - y;
		}
		return [x0, y0, x, y];
	}

	// a press with a shape tool chosen drags the shape out, which is shown as it goes and added when it ends
	private shapeDrag(sx: number, sy: number, ev: PointerEvent): DragHandler | undefined {
		const kind = this.tool as ShapeKind;
		if (!this.shapeKinds().includes(kind) || !this.canDraw())
			return;
		// the first corner is on the grid when points snap to it
		const step = this.option('snap') ? this.gridStep : this.rounding;
		let [x, y] = this.toWorld(sx, sy);
		if (step) {
			x = Math.round(x / step) * step;
			y = Math.round(y / step) * step;
		}
		if (kind === 'line') {
			// a line is clicked out: the first click sets where it begins, and each after commits a segment to the click and goes on
			// from there; the segment on its way follows the pointer
			const from = this.lineContinues() ?? this.lineStart;
			// a double click ends it: its first click made the last corner
			const now = performance.now(), last = this.lastPress;
			this.lastPress = {t: now, x: sx, y: sy};
			if (from && last && now - last.t < 500 && Math.hypot(sx - last.x, sy - last.y) < 5) {
				this.endChain();
				this.draw();
				return {move() {}, end: () => this.draw()};
			}
			if (!from) {
				this.lineStart = [x, y];
			} else {
				const c = this.shapeCorners('line', from, [x, y], ev.shiftKey, false);
				if (Math.hypot(c[2] - c[0], c[3] - c[1]) * this.view.s >= 3) {
					this.lineStart = undefined;
					this.addShape('line', c[0], c[1], c[2], c[3]);
				}
			}
			this.lineHover = {x, y, shift: ev.shiftKey};
			this.draw();
			return {move: (dx, dy, e) => { this.lineHover = {x: x + dx, y: y + dy, shift: e.shiftKey}; }, end: () => this.draw()};
		}
		const start = [x, y];
		let corners = [x, y, x, y];
		return {
			move:	(dx, dy, e) => {
				corners = this.shapeCorners(kind, start, [x + dx, y + dy], e.shiftKey, e.altKey);
				this.dragged = {kind, corners};
			},
			end:	moved => {
				this.dragged = undefined;
				if (moved && Math.hypot(corners[2] - corners[0], corners[3] - corners[1]) * this.view.s >= 3)
					this.addShape(kind, corners[0], corners[1], corners[2], corners[3]);
				this.draw();
			},
		};
	}

	private shapePreview() {
		const v = this.view;
		// where a line that goes on will go on from
		const end = this.tool === 'line' ? this.lineContinues() ?? this.lineStart : undefined;
		const h = this.lineHover;
		if (end && h && !this.dragged) {
			const c = this.shapeCorners('line', end, [h.x, h.y], h.shift, false);
			this.dragged = undefined;
			return `<circle class="insp-draw" cx="${num(end[0] * v.s + v.x)}" cy="${num(end[1] * v.s + v.y)}" r="5" fill="none"/><path class="insp-draw" d="M${num(c[0] * v.s + v.x)},${num(c[1] * v.s + v.y)}L${num(c[2] * v.s + v.x)},${num(c[3] * v.s + v.y)}" fill="none"/>`;
		}
		const marker = end ? `<circle class="insp-draw" cx="${num(end[0] * v.s + v.x)}" cy="${num(end[1] * v.s + v.y)}" r="5" fill="none"/>` : '';
		if (!this.dragged)
			return marker;
		const [x0, y0, x1, y1] = this.dragged.corners.map((c, i) => num(c * v.s + (i % 2 ? v.y : v.x)));
		return marker + (this.dragged.kind === 'line' ? `<path class="insp-draw" d="M${x0},${y0}L${x1},${y1}" fill="none"/>`
			: this.dragged.kind === 'rect' ? `<rect class="insp-draw" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="none"/>`
			: `<ellipse class="insp-draw" cx="${num((x0 + x1) / 2)}" cy="${num((y0 + y1) / 2)}" rx="${num(Math.abs(x1 - x0) / 2)}" ry="${num(Math.abs(y1 - y0) / 2)}" fill="none"/>`);
	}

	// a rectangle or ellipse as a contour, running the way a TrueType outer contour does; an ellipse is made of cubic curves
	// where the points may be cubic, and of eight quadratic ones where not
	protected addShapeContour(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number) {
		if (!this.canStructure())
			return;
		const inv = this.matrix.inverse(), p = this.points()!;
		const first = p.length;
		const put = (x: number, y: number, flags: number) => {
			const l = inv.mulPos(float2(x, y));
			p.push(curveVertex(this.rounding ? Math.round(l.x) : clean(l.x), this.rounding ? Math.round(l.y) : clean(l.y), flags));
		};
		const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
		if (kind === 'line') {
			// a polygon, a corner for each press: it closes when it comes back to where it began, and Enter or Escape leaves it as it
			// is. Two points are no outline (a font drops them), so the first line is only shown, and the corner after it is the first
			// edit, of a polygon that has three.
			const c = this.chain, end = this.lineContinues();
			if (c && end) {
				const q = this.matrix.mulPos(float2(p[c.s].x, p[c.s].y)), count = p.length - c.s;
				if (count >= 3 && Math.hypot(x1 - q.x, y1 - q.y) * this.view.s < 6) {
					this.chain = undefined;
					this.pickedContour = c.s;
					this.commit('Close contour');
					this.draw();
					return;
				}
				put(x1, y1, ON_CURVE);
				this.pickedContour = c.s;
				this.commit(count === 2 ? 'Draw polygon' : 'Extend contour');
				this.draw();
				return;
			}
			put(x0, y0, ON_BEGIN);
			put(x1, y1, ON_CURVE);
			this.chain = {s: first};
			this.picked = -1;
			this.pickedContour = first;
			this.draw();
			return;
		}
		if (kind === 'rect') {
			put(l, b, ON_BEGIN);
			put(l, t, ON_CURVE);
			put(r, t, ON_CURVE);
			put(r, b, ON_CURVE);
		} else {
			// from the left, round clockwise as seen: P(a) is the point at angle a, and the tangent there goes with a falling
			const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
			const P = (a: number, k = 1) => [cx + Math.cos(a) * rx * k, cy - Math.sin(a) * ry * k];
			const T = (a: number) => [Math.sin(a) * rx, Math.cos(a) * ry];
			put(...(P(Math.PI) as [number, number]), ON_BEGIN);
			if (this.cubic) {
				const k = 0.5523;
				for (let i = 0; i < 4; i++) {
					const a = Math.PI - i * Math.PI / 2, c = a - Math.PI / 2, [px, py] = P(a), [qx, qy] = P(c), t0 = T(a), t1 = T(c);
					put(px + t0[0] * k, py + t0[1] * k, OFF_BEZ3);
					put(qx - t1[0] * k, qy - t1[1] * k, OFF_BEZ3);
					if (i < 3)
						put(qx, qy, ON_CURVE);
				}
			} else {
				for (let i = 0; i < 8; i++) {
					const a = Math.PI - i * Math.PI / 4;
					put(...(P(a - Math.PI / 8, 1 / Math.cos(Math.PI / 8)) as [number, number]), OFF_BEZ2);
					if (i < 7)
						put(...(P(a - Math.PI / 4) as [number, number]), ON_CURVE);
				}
			}
		}
		this.picked = -1;
		this.pickedContour = first;
		this.commit(`Draw ${kind}`);
		this.draw();
	}

	// A contour dragged: it is moved by the pointer's moves, and with Alt turned about the middle of its box (as it was picked)
	// by the angle the pointer goes round the middle of the contour as it is; the two add up, so Alt may be pressed and let go
	// during the drag. Shift turns it in steps of 15 degrees, and the move keeps to the grid.
	private dragContour(c: NonNullable<PathEditor['drag']>['contour'] & {}, wx: number, wy: number, alt: boolean, shift: boolean) {
		const world = c.orig.map(v => {
			const w = this.matrix.mulPos(float2(v.x, v.y));
			return [w.x, w.y];
		});
		const xs = world.map(w => w[0]), ys = world.map(w => w[1]);
		const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
		const last = c.last ?? [c.wx, c.wy], t = c.t ??= [0, 0];
		c.angle ??= 0;
		if (alt)
			c.angle += Math.atan2(wy - (cy + t[1]), wx - (cx + t[0])) - Math.atan2(last[1] - (cy + t[1]), last[0] - (cx + t[0]));
		else {
			t[0] += wx - last[0];
			t[1] += wy - last[1];
		}
		c.last = [wx, wy];
		const angle = shift ? Math.round(c.angle / (Math.PI / 12)) * Math.PI / 12 : c.angle;
		const step = this.option('snap') ? this.gridStep : this.rounding;
		const [tx, ty] = step ? t.map(v => Math.round(v / step) * step) : t;
		const cos = Math.cos(angle), sin = Math.sin(angle), inv = this.matrix.inverse(), p = this.points()!;
		world.forEach(([x, y], i) => {
			const l = inv.mulPos(float2(cx + (x - cx) * cos - (y - cy) * sin + tx, cy + (x - cx) * sin + (y - cy) * cos + ty));
			p[c.s + i].x = this.rounding ? Math.round(l.x) : clean(l.x);
			p[c.s + i].y = this.rounding ? Math.round(l.y) : clean(l.y);
		});
		this.drag!.rotated = angle !== 0;
	}

	private shift(i: number, dx: number, dy: number) {
		const v = this.points()![i];
		v.x = clean(v.x + dx);
		v.y = clean(v.y + dy);
	}

	// the controls either side of an on-curve point, which go where it goes
	private handlesOf(k: number) {
		const p = this.points()!, {s, e} = this.contourOf(k), out: number[] = [];
		if (isControl(p[k].flags))
			return out;
		const before = k > s ? k - 1 : e - 1;
		if (before !== k && isControl(p[before].flags))
			out.push(before);
		if (k + 1 < e && isControl(p[k + 1].flags))
			out.push(k + 1);
		return out;
	}

	// the control on the other side of an on-curve point from control k, with the point
	private oppositeOf(k: number) {
		const p = this.points()!, {s, e} = this.contourOf(k);
		if (!isControl(p[k].flags))
			return;
		const wrap = (i: number) => i < s ? e - 1 : i >= e ? s : i;
		for (const d of [-1, 1]) {
			const anchor = wrap(k + d), other = wrap(anchor + d);
			if (anchor !== k && other !== k && !isControl(p[anchor].flags) && isControl(p[other].flags))
				return {anchor, other};
		}
	}

	// that control and how far it is from the point, when the two are in line with it (a smooth join)
	private linkOf(k: number) {
		const o = this.oppositeOf(k);
		if (!o)
			return;
		const p = this.points()!, {anchor, other} = o;
		const ax = p[k].x - p[anchor].x, ay = p[k].y - p[anchor].y, bx = p[other].x - p[anchor].x, by = p[other].y - p[anchor].y;
		const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
		// opposite directions, within about a degree
		if (la > 0 && lb > 0 && ax * bx + ay * by < 0 && Math.abs(ax * by - ay * bx) < 0.02 * la * lb)
			return {anchor, other, length: lb};
	}

	// the opposite control turned to point away from the picked one, at the distance it was
	alignOpposite() {
		const o = this.picked >= 0 ? this.oppositeOf(this.picked) : undefined;
		if (!this.canStructure() || !o)
			return;
		const p = this.points()!, a = p[o.anchor];
		if (p[this.picked].x === a.x && p[this.picked].y === a.y)
			return this.refuse('the control is on its point, so has no direction');
		this.keepStraight({...o, length: Math.hypot(p[o.other].x - a.x, p[o.other].y - a.y)}, p[this.picked]);
		this.commit('Align handles');
		this.draw();
	}

	// the linked control turned to stay in line with the one dragged, at the distance it was
	private keepStraight(link: {anchor: number, other: number, length: number}, dragged: curveVertex) {
		const p = this.points()!, a = p[link.anchor], o = p[link.other];
		const dx = a.x - dragged.x, dy = a.y - dragged.y, d = Math.hypot(dx, dy);
		if (d === 0)
			return;
		o.x = clean(a.x + dx / d * link.length);
		o.y = clean(a.y + dy / d * link.length);
	}

	nudge(dx: number, dy: number) {
		if (!this.canEdit() || (this.picked < 0 && this.pickedContour < 0))
			return;
		const [from, to] = this.picked >= 0 ? [this.picked, this.picked + 1] : [this.pickedContour, this.contourOf(this.pickedContour).e];
		for (let i = from; i < to; i++)
			this.shift(i, dx, dy);
		if (this.picked >= 0)
			this.handlesOf(this.picked).forEach(i => this.shift(i, dx, dy));
		this.draw();
		this.commit(this.picked >= 0 ? 'Move point' : 'Move contour');
	}

	selectContour(of: number) {
		if (!this.canStructure())
			return;
		this.pickedContour = this.contourOf(of).s;
		this.picked = -1;
		this.draw();
	}

	deleteContour() {
		if (!this.canStructure() || this.pickedContour < 0)
			return;
		const {s, e} = this.contourOf(this.pickedContour);
		this.points()!.splice(s, e - s);
		this.pickedContour = this.hover = -1;
		this.commit('Delete contour');
		this.draw();
	}

	// The selected contour, or all of them when none is, with fewer points, within `simplifyPx` pixels of the view of where they
	// were. The result is shown in place while the tolerance is set (the menu's value item) and then kept (Enter, a click on its
	// icon or on the drawing) or put back (Escape).
	private beginSimplify() {
		const p = this.points();
		if (!p || !this.simplifyPoints || !this.canStructure() || this.simplifying)
			return;
		const pick = this.pickedContour >= 0 ? this.pickedContour : this.picked >= 0 ? this.contourOf(this.picked).s : -1;
		const {s, e} = pick >= 0 ? this.contourOf(pick) : {s: 0, e: p.length};
		this.simplifying = {s, len: e - s, orig: p.slice(s, e).map(v => ({...v})), target: p, token: 0};
		void this.previewSimplify();
	}

	private setSimplify(px: number) {
		this.simplifyPx = px;
		if (this.simplifying)
			void this.previewSimplify();
		else
			this.beginSimplify();
	}

	// the contour as it was, simplified to the tolerance that is set, in place of what is there
	private async previewSimplify() {
		const sim = this.simplifying, simplify = this.simplifyPoints?.bind(this);
		if (!sim || !simplify)
			return;
		const token = ++sim.token;
		const tol = this.simplifyPx / (Math.sqrt(Math.abs(this.matrix.det())) * this.view.s);
		try {
			const result = await simplify(sim.orig, this.rounding ? tol / 2 : tol);
			if (this.simplifying !== sim || token !== sim.token || this.points() !== sim.target)
				return;
			const out = result.map(v => curveVertex(this.rounding ? Math.round(v.x) : clean(v.x), this.rounding ? Math.round(v.y) : clean(v.y), v.flags));
			sim.target.splice(sim.s, sim.len, ...out);
			sim.len = out.length;
			this.picked = this.pickedContour = this.hover = -1;
			this.notice = `${sim.orig.length} → ${sim.len} points within ${this.simplifyPx} px · Enter keeps it, Esc puts it back`;
			this.draw();
		} catch (error: any) {
			this.refuse(String(error?.message ?? error));
		}
	}

	// the preview kept (recorded as an edit) or put back as it was
	private endSimplify(apply: boolean) {
		const sim = this.simplifying;
		if (!sim)
			return;
		this.simplifying = undefined;
		sim.token++;
		if (this.points() !== sim.target)
			return;
		if (apply) {
			this.commit('Simplify');
			this.refuse(`${sim.orig.length} points simplified to ${sim.len}`);
		} else {
			sim.target.splice(sim.s, sim.len, ...sim.orig);
			this.notice = '';
			this.draw();
		}
	}

	// the menu's simplify: the tolerance is a value to wheel or drag along presets, which shows the result as it is set; a click
	// on it keeps what is shown
	private simplifyItem(): CascadeItem {
		const tolerance = valueItem({
			label:		'tol',
			caption:	'Simplify, staying within',
			get:		() => this.simplifyPx,
			set:		v => this.setSimplify(v),
			min:		0.25,
			max:		20,
			step:		(v, steps) => {
				return Math.round(v * 1.2 ** steps * 4) / 4;
				//return n === v ? v + Math.sign(steps) * 0.25 : n;
			},
			presets:	[0.5, 1, 1.5, 2, 3, 5, 8, 12, 20],
			resolution:	0.25,
			format:		v => `${+v.toFixed(2)} px`,
		});
		return {
			...tolerance,
			id:			'simplify',
			face:		() => this.simplifying ? valueFace('tol', `${+this.simplifyPx.toFixed(2)}`) : svgFace(icons.simplify),
			caption:	() => this.simplifying ? `${tolerance.caption()} · click to keep it` : 'Simplify the outline: scroll or drag to see the result',
			active:		() => !!this.simplifying,
			select:		() => {
				if (!this.simplifying) {
					this.beginSimplify();
					return true;
				}
				this.endSimplify(true);
			},
		};
	}

	deletePoint() {
		if (this.pickedContour >= 0 && this.picked < 0)
			return this.deleteContour();
		if (!this.canStructure() || this.picked < 0)
			return;
		const p = this.points()!, k = this.picked, {s, e} = this.contourOf(k);
		const flag = (i: number) => i >= s && i < e ? p[i].flags : -1;
		const open = flag(e - 1) === ON_END;
		let from = k, count = 1;
		const last = open && k === e - 1;
		if (last) {
			// the end of an open contour goes with the controls before it, and the on-curve point then before it ends the contour
			while (isControl(flag(from - 1))) {
				from--;
				count++;
			}
		}
		if (e - s - count < (open ? 2 : 3))
			return this.refuse(`a contour needs at least ${open ? 2 : 3} points`);
		if (k === s) {
			if (flag(s + 1) !== ON_CURVE || flag(e - 1) === OFF_BEZ3)
				return this.refuse('the next point must be on-curve to begin the contour');
			p[(s + 1)].flags = flag(s);
		}
		p.splice(from, count);
		if (last)
			p[(from - 1)].flags = ON_END;
		this.reflag(from > s ? from - 1 : from);
		this.picked = this.hover = this.pickedContour = -1;
		this.commit('Delete point');
		this.draw();
	}

	togglePoint() {
		if (!this.canStructure() || this.picked < 0)
			return;
		const p = this.points()!, flags = p[this.picked].flags;
		if (isBegin(flags) || flags === ON_END)
			return this.refuse('a contour begins and ends on-curve');
		p[this.picked].flags = isControl(flags) ? ON_CURVE : OFF_BEZ2;
		this.reflag(this.picked);
		this.commit('Change point type');
		this.draw();
	}

	// the controls between two on-curve points, which are quadratic when there is one of them or cubics cannot be made, and
	// cubic when there are more (as a chain of cubics with an on-curve point implied between each pair, where an odd one is
	// the control of a quadratic). The contour of point `at` is set to that after an edit.
	private reflag(at: number) {
		const p = this.points()!, {s, e} = this.contourOf(Math.max(0, Math.min(at, p.length - 1)));
		for (let i = s; i < e; i++) {
			if (!isControl(p[i].flags))
				continue;
			let j = i;
			while (j < e && isControl(p[j].flags))
				j++;
			const flags = this.cubic && j - i > 1 ? OFF_BEZ3 : OFF_BEZ2;
			for (let k = i; k < j; k++)
				p[k].flags = flags;
			i = j;
		}
	}

	// what the outline is drawn as: a line, a quadratic or a cubic each, with where each of its points is in the points, or -1 for
	// one that is implied (halfway between two controls)
	private pieces() {
		return pieces(this.points()!);
	}

	// the place on the outline nearest a place on the screen, if near enough to be meant: the piece it is on, and how far along it
	curveAt(sx: number, sy: number) {
		if (!this.points())
			return;
		const [lx, ly] = this.toLocal(sx, sy), here = float2(lx, ly);
		let best: {piece: Piece, t: number} | undefined, bestD = 8 * 8;
		for (const piece of this.pieces()) {
			const bez = curveOf(piece), {t} = bezierClosest(here, bez), q = bez.evaluate(t);
			const [x, y] = this.toScreen(q.x, q.y);
			const d = (x - sx) ** 2 + (y - sy) ** 2;
			if (d < bestD && t > 0.001 && t < 0.999) {
				bestD = d;
				best = {piece, t};
			}
		}
		return best;
	}

	// a point put on a piece of the outline, leaving the shape as it was: the piece's controls become those of its two halves, and
	// a point of it that was only implied is made real. The new points are on whole units where the outline is in them, which
	// moves the curve by up to a unit or so.
	insertAt(piece: Piece, t: number) {
		if (!this.canStructure())
			return;
		const {points, at} = piece, last = points.length - 1;
		const make = (x: number, y: number, flags: number) => curveVertex(this.rounding ? Math.round(x) : clean(x), this.rounding ? Math.round(y) : clean(y), flags);
		const p = this.points()!;
		if (last === 1) {
			const q = lerp(points[0], points[1], t);
			p.splice(at[0] + 1, 0, make(q.x, q.y, ON_CURVE));
			this.picked = at[0] + 1;
		} else {
			const inner = curveOf(piece).split(t).control.slice(1, -1), middle = (inner.length - 1) / 2, flags = last === 2 ? OFF_BEZ2 : OFF_BEZ3;
			const start = at[0] < 0 ? [make(points[0].x, points[0].y, ON_CURVE)] : [], end = at[last] < 0 ? [make(points[last].x, points[last].y, ON_CURVE)] : [];
			p.splice(at[1], last - 1, ...start, ...inner.map((v, k) => make(v.x, v.y, k === middle ? ON_CURVE : flags)), ...end);
			this.picked = at[1] + start.length + middle;
		}
		this.pickedContour = -1;
		this.reflag(this.picked);
		this.commit('Insert point');
		this.draw();
	}

	// a control put on a piece of the outline, leaving the shape as it was: a line becomes a quadratic, with its control halfway, and
	// a quadratic a cubic, with the two controls that give the same curve. A cubic cannot be raised.
	insertControl(piece: Piece) {
		if (!this.canStructure() || !this.canRaise(piece))
			return;
		const {points, at} = piece, p = this.points()!;
		const make = (q: float2, flags: number) => curveVertex(this.rounding ? Math.round(q.x) : clean(q.x), this.rounding ? Math.round(q.y) : clean(q.y), flags);
		if (points.length === 2) {
			p.splice(at[0] + 1, 0, make(lerp(points[0], points[1], 0.5), OFF_BEZ2));
			this.picked = at[0] + 1;
		} else {
			// an on-curve point that was only implied is made real, as the controls either side of it no longer imply it
			const [a, c, b] = points;
			const start = at[0] < 0 ? [make(a, ON_CURVE)] : [], end = at[2] < 0 ? [make(b, ON_CURVE)] : [];
			p.splice(at[1], 1, ...start, make(lerp(a, c, 2 / 3), OFF_BEZ3), make(lerp(b, c, 2 / 3), OFF_BEZ3), ...end);
			this.picked = at[1] + start.length;
		}
		this.pickedContour = -1;
		this.reflag(this.picked);
		this.commit('Insert control');
		this.draw();
	}

	canRaise(piece: Piece) {
		return piece.points.length === 2 || (piece.points.length === 3 && this.cubic);
	}

	//--- the pointer ----------------------------------------------------------------

	private listen() {
		const svg = this.svg;
		svg.addEventListener('pointerdown', e => {
			// the right button (or Ctrl with the left, which a Mac takes for it) is for the context menu, not for dragging
			if (e.button === 2 || (e.button === 0 && e.ctrlKey))
				return;
			svg.setPointerCapture(e.pointerId);
			// a press on the drawing keeps a simplification that is shown
			this.endSimplify(true);
			const here = this.local(e), editable = this.canEdit();
			const taken = this.xf ? this.transformDrag(e, here.x, here.y) : this.capture(e, here.x, here.y) ?? this.shapeDrag(here.x, here.y, e);
			if (taken) {
				const [wx, wy] = this.toWorld(here.x, here.y);
				this.drag = {x: e.clientX, y: e.clientY, moved: false, custom: {...taken, wx, wy}};
				return;
			}
			const point = editable ? this.pointAt(here.x, here.y) : -1;
			// a point of an outline that cannot be edited says why, instead of nothing happening
			if (!editable && this.points() && this.pointAt(here.x, here.y) >= 0)
				this.refuse(this.readOnlyReason());
			this.drag = {x: e.clientX, y: e.clientY, moved: false, point: point >= 0 ? point : undefined, link: point >= 0 ? this.linkOf(point) : undefined};
			if (point >= 0) {
				this.picked = point;
				this.pickedContour = -1;
				this.draw();
				return;
			}
			// a contour is picked by its outline, and is then dragged as a whole
			const hit = editable ? (e.target as Element).closest<SVGElement>('[data-contour]') : null;
			if (hit) {
				const {s, e: end} = this.contourOf(+hit.dataset.contour!);
				this.picked = -1;
				this.pickedContour = s;
				const [wx, wy] = this.toWorld(here.x, here.y);
				this.drag.contour = {s, e: end, orig: this.points()!.slice(s, end).map(v => ({...v})), wx, wy};
				this.draw();
				return;
			}
			// the page may change what is selected in taking the press, which clears a drag
			const drag = this.drag, handler = this.grab(e, here.x, here.y);
			this.drag = drag;
			if (handler) {
				const [wx, wy] = this.toWorld(here.x, here.y);
				drag.custom = {...handler, wx, wy};
			}
		});
		svg.addEventListener('pointermove', e => {
			const here = this.local(e), drag = this.drag;
			if (drag?.point !== undefined) {
				if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2)
					drag.moved = true;
				if (drag.moved) {
					const [x, y] = this.snapped(here.x, here.y), p = this.points()!;
					const q = p[drag.point], dx = x - q.x, dy = y - q.y;
					q.x = x;
					q.y = y;
					this.handlesOf(drag.point).forEach(i => this.shift(i, dx, dy));
					// Alt breaks the link for the rest of the drag, as letting go of it just before the button would re-join them
					if (e.altKey)
						drag.link = undefined;
					if (drag.link)
						this.keepStraight(drag.link, q);
					this.draw();
				}
				return;
			}
			if (drag?.custom) {
				if (drag.custom.raw || Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3)
					drag.moved = true;
				if (drag.moved) {
					const step = drag.custom.raw ? 0 : this.option('snap') ? this.gridStep : this.rounding;
					const [wx, wy] = this.toWorld(here.x, here.y);
					let dx = wx - drag.custom.wx, dy = wy - drag.custom.wy;
					if (step) {
						dx = Math.round(dx / step) * step;
						dy = Math.round(dy / step) * step;
					}
					drag.custom.move(clean(dx), clean(dy), e);
					this.draw();
				}
				return;
			}
			if (drag?.contour) {
				if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2)
					drag.moved = true;
				if (drag.moved) {
					this.dragContour(drag.contour, ...this.toWorld(here.x, here.y), e.altKey, e.shiftKey);
					this.draw();
				}
				return;
			}
			if (drag) {
				if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3)
					drag.moved = true;
				if (drag.moved) {
					svg.style.cursor = 'grabbing';
					this.view.x += e.clientX - drag.x;
					this.view.y += e.clientY - drag.y;
					drag.x = e.clientX;
					drag.y = e.clientY;
					this.draw();
				}
				return;
			}
			if (this.xf) {
				const xf = this.xf, [wx, wy] = this.toWorld(here.x, here.y);
				svg.style.cursor = transformCursor(xf.box, xf.quad, partAt(xf.box, xf.quad, float2(wx, wy), this.handleRadius()), xf.mode);
				return;
			}
			if (this.tool === 'line' && (this.lineStart || this.lineContinues())) {
				const step = this.option('snap') ? this.gridStep : this.rounding;
				let [x, y] = this.toWorld(here.x, here.y);
				if (step) {
					x = Math.round(x / step) * step;
					y = Math.round(y / step) * step;
				}
				this.lineHover = {x, y, shift: e.shiftKey};
				this.draw();
			}
			const at = this.pointAt(here.x, here.y);
			// a cross on a point, which moves it; a four-way arrow along a curve, which moves the whole contour; an arrow over
			// something the page can drag (a fill); a hand elsewhere, which moves the view
			svg.style.cursor = at >= 0 ? 'crosshair' : (e.target as Element).closest('[data-contour]') ? 'move' : this.draggable(e.target as Element) ? 'default' : 'grab';
			if (at !== this.hover) {
				this.hover = at;
				this.draw();
			}
		});
		svg.addEventListener('pointerleave', () => {
			svg.style.cursor = '';
			if (!this.drag && this.hover >= 0) {
				this.hover = -1;
				this.draw();
			}
		});
		svg.addEventListener('pointerup', e => {
			if (svg.style.cursor === 'grabbing')
				svg.style.cursor = 'grab';
			if (svg.hasPointerCapture(e.pointerId))
				svg.releasePointerCapture(e.pointerId);
			const drag = this.drag;
			this.drag = undefined;
			if (drag?.custom)
				drag.custom.end(drag.moved);
			else if (drag?.point !== undefined && drag.moved)
				this.commit('Move point');
			else if (drag?.contour) {
				if (drag.moved)
					this.commit(drag.rotated ? 'Rotate contour' : 'Move contour');
			} else if (drag && !drag.moved) {
				const here = this.local(e);
				this.picked = this.pointAt(here.x, here.y);
				if (this.picked >= 0 || drag.point === undefined)
					this.pickedContour = -1;
				this.draw();
				if (this.picked < 0)
					this.clicked(e, here.x, here.y);
			}
		});
		svg.addEventListener('wheel', e => {
			e.preventDefault();
			const here = this.local(e);
			this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), here.x, here.y);
		}, {passive: false});
		svg.addEventListener('contextmenu', e => {
			e.preventDefault();
			const here = this.local(e);
			this.menuCurve = undefined;
			if (this.canEdit()) {
				const at = this.pointAt(here.x, here.y);
				const hit = (e.target as Element).closest<SVGElement>('[data-contour]');
				this.menuScope = at >= 0 || hit ? 'points' : 'element';
				if (at >= 0) {
					this.picked = at;
					this.pickedContour = -1;
				} else if (hit) {
					this.menuCurve = this.curveAt(here.x, here.y);
					this.picked = -1;
					this.pickedContour = this.contourOf(+hit.dataset.contour!).s;
				}
				this.draw();
			}
			this.menuAt = here;
			this.cascade.open(e.clientX, e.clientY);
		});
	}

	//--- transforming ---------------------------------------------------------------

	private modeItem(): CascadeItem {
		const face = (icon: string) => svgFace(icon);
		const modes = [
			{value: 'free' as TransformMode,		face: face(icons.free),			caption: 'Scale and rotate'},
			{value: 'skew' as TransformMode,		face: face(icons.skew),			caption: 'Skew'},
			{value: 'distort' as TransformMode,		face: face(icons.distort),		caption: 'Distort'},
			{value: 'perspective' as TransformMode,	face: face(icons.perspective),	caption: 'Perspective'},
		];
		// (a transform of its own cannot distort)
		return choiceItem('Mode', (this.xf ? this.xf.element : this.menuScope === 'element' && this.beginElementTransform()) ? modes.slice(0, 2) : modes, () => this.xfMode, v => { this.xfMode = v; if (this.xf) this.xf.mode = v; });
	}
	private xfMode: TransformMode = 'free';

	private handleRadius() {
		return HANDLE * (window.devicePixelRatio || 1) / this.view.s;
	}

	// the contour selected, or else all of them, with the box round them in the world
	private transformSet(): TransformSet | undefined {
		const p = this.points();
		if (!p || !p.length || !this.canEdit())
			return;
		// from the menu over the element (not its points or outline) a page that can carries it by a transform of its own, all of it
		const element	= this.menuScope === 'element' ? this.beginElementTransform() : undefined;
		const {s, e}	= this.pickedContour >= 0 && this.menuScope === 'points' ? this.contourOf(this.pickedContour) : {s: 0, e: p.length};
		const orig		= p.slice(s, e).map(v => ({...v}));
		const world		= orig.map(v => this.matrix.mulPos(float2(v.x, v.y)));
		const box		= float2.extent.from(world), size = box.extent();
		if (size.x < 1e-6 || size.y < 1e-6) {
			this.refuse('there is no area to transform');
			return;
		}
		return {box, quad: rectCorners(box), s, orig, mode: this.xfMode, element};
	}

	startTransform() {
		this.endTransform(true);
		this.endChain();
		const xf = this.transformSet();
		if (xf) {
			this.xf = xf;
			this.picked = -1;
			this.draw();
		}
	}

	// the points as the box carries them: each from where it was, so that nothing builds up. A mirror turns the contours the
	// other way round, which the outline's fill goes by, so those that close are put back to run as they did.
	private carry(xf: TransformSet, quad: float2[], label?: string) {
		if (xf.element) {
			xf.element(affineOf(rectToQuad(xf.box, quad)), label);
			return;
		}
		const p			= this.points()!, h: float3x3 = rectToQuad(xf.box, quad), inv = this.matrix.inverse();
		const area		= (q: float2[]) => q.reduce((a, c, i) => a + c.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * c.y, 0);
		const mirrored	= area(quad) * area(rectCorners(xf.box)) < 0;
		const moved		= xf.orig.map(v => {
			const w = this.matrix.mulPos(float2(v.x, v.y)), t = applyH(h, w.x, w.y), l = inv.mulPos(float2(t.x, t.y));
			return {...v, x: this.rounding ? Math.round(l.x) : clean(l.x), y: this.rounding ? Math.round(l.y) : clean(l.y)};
		});
		if (mirrored && this.structural()) {
			for (let c = 0; c < moved.length;) {
				let e = c + 1;
				while (e < moved.length && !isBegin(moved[e].flags))
					e++;
				// the begin stays where it is, and the rest come back round
				if (moved[e - 1].flags !== ON_END && moved[c].flags === ON_BEGIN)
					moved.splice(c + 1, e - c - 1, ...moved.slice(c + 1, e).reverse());
				c = e;
			}
		}
		moved.forEach((v, i) => Object.assign(p[xf.s + i], v));
	}

	private transformDrag(e: PointerEvent, sx: number, sy: number): DragHandler | undefined {
		const xf	= this.xf!, [wx, wy] = this.toWorld(sx, sy), start = float2(wx, wy);
		const part	= partAt(xf.box, xf.quad, start, this.handleRadius());
		if (e.detail === 2 && part.kind === 'inside') {
			this.endTransform(true);
			return {move() {}, end() {}};
		}
		const q0	= xf.quad.map(c => c.dup());
		const step	= () => this.option('snap') ? this.gridStep : this.rounding;
		return {
			raw: true,
			move: (dx, dy, ev) => {
				const quad = dragQuad({
					box: xf.box, q0, part, start, mode: dragMode(part, xf.mode, ev), shift: ev.shiftKey, alt: ev.altKey,
					move: d => step() ? float2(Math.round(d.x / step()) * step(), Math.round(d.y / step()) * step()) : d,
				}, float2(start.x + dx, start.y + dy));
				// a transform of its own is affine: the box stays a parallelogram
				if (quad && (!xf.element || quad[0].sub(quad[1]).add(quad[2]).sub(quad[3]).len() < 1e-6 * (1 + quad[0].len()))) {
					xf.quad = quad;
					this.carry(xf, quad);
				}
			},
			end: () => {},
		};
	}

	// apply it (as an edit) or not
	endTransform(apply: boolean) {
		const xf = this.xf;
		if (xf) {
			this.xf = undefined;
			const corners	= rectCorners(xf.box);
			const moved		= xf.quad.some((c, i) => Math.abs(c.x - corners[i].x) > 1e-9 || Math.abs(c.y - corners[i].y) > 1e-9);
			if (apply && moved && xf.element)
				this.carry(xf, xf.quad, 'Transform');
			else if (apply && moved)
				this.commit('Transform');
			else if (moved && xf.element)
				xf.element(float2x3.identity());
			else if (moved) {
				const p = this.points();
				if (p)
					xf.orig.forEach((v, i) => Object.assign(p[xf.s + i], v));
			}
			this.draw();
		}
	}

	// a move of the corners of the box by a function of the middle of the box and the point, done at once
	private quickTransform(label: string, f: (centre: float2, p: float2) => float2) {
		const xf = this.transformSet();
		if (xf) {
			const c = xf.box.centre();
			xf.quad = xf.quad.map(p => f(c, p));
			if (xf.element)
				this.carry(xf, xf.quad, label);
			else {
				this.carry(xf, xf.quad);
				this.commit(label);
			}
			this.draw();
		}
	}

	// the box, as lines through it in thirds and its handles, in screen units
	private transformMarkup() {
		const xf = this.xf;
		if (!xf)
			return '';

		const {s}		= this.view, m = rectToQuad(xf.box, xf.quad), b = xf.box;
		const screen	= (p: float2) => `${num(p.x * s + this.view.x)},${num(p.y * s + this.view.y)}`;
		const o			= b.min, size = b.extent();
		const at		= (u: number, v: number) => screen(applyH(m, o.x + u * size.x, o.y + v * size.y).xy);
		const {corners, edges} = boxHandles(b, xf.quad);

		let thirds = '';
		for (const t of [1 / 3, 2 / 3])
			thirds += `M${at(t, 0)}L${at(t, 1)}M${at(0, t)}L${at(1, t)}`;

		const r			= 4;
		const handles	= [...corners, ...edges].map(h => {
			const [x, y] = screen(h.xy).split(',').map(Number);
			return `<rect class="insp-xf-handle" x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}"/>`;
		}).join('');
		return `<path class="insp-xf-grid" d="${thirds}"/><path class="insp-xf-box" d="M${corners.map(screen).join('L')}Z"/>${handles}`;
	}

	//--- the menu -------------------------------------------------------------------

	private menuItems(): CascadeItem[] {
		const at	= this.menuAt;
		const only	= this.menuOnly(at);
		if (only)
			return only;

		const op = (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});
		if (this.xf)
			return [
				op('transform-apply', icons.transform, 'Apply the transform (Enter)', () => this.endTransform(true)),
				op('transform-cancel', icons.deletePoint, 'Cancel the transform (Esc)', () => this.endTransform(false)),
				this.modeItem(),
			];

		const items = this.pageItems(at);
		if (this.canDraw()) {
			const face = (icon: string) => svgFace(icon);
			const shapes: Record<ShapeKind, ToolChoice> = {
				rect:		{value: 'rect', face: face('<rect x="2" y="4" width="12" height="8"/>'), caption: 'Rectangle (drag; Shift square, Alt from centre)'},
				ellipse:	{value: 'ellipse', face: face('<ellipse cx="8" cy="8" rx="6" ry="4.5"/>'), caption: 'Ellipse (drag; Shift circle, Alt from centre)'},
				line:		{value: 'line', face: face('<path d="M3 13L13 3"/>'), caption: 'Line (drag; Shift to 45 degrees, Alt from centre)'},
			};
			const tools: ToolChoice[] = [
				{value: 'select', face: face('<path d="M4 2L12 8L8 9L6 13Z"/>'), caption: 'Select'},
				...this.shapeKinds().map(k => shapes[k]),
				...this.extraTools(),
			];
			items.push({...choiceItem('Tool', tools, () => this.tool, v => this.setTool(v), true), id: 'tool'});
		}

		if (this.canEdit() && this.points()?.length)
			items.push({
				id:			'transform',
				face:		() => svgFace(icons.transform),
				caption:	() => this.menuScope === 'element' && this.beginElementTransform() ? 'Transform shape' : this.pickedContour >= 0 ? 'Transform contour' : 'Transform outline',
				children:	() => [
					{...op('transform-free', icons.free, 'Free Transform (Enter applies, Esc cancels)', () => this.startTransform()), children: () => [this.modeItem()]},
					op('flip-h', icons.flipH, 'Flip Horizontal', () => this.quickTransform('Flip horizontal', (c, p) => float2(2 * c.x - p.x, p.y))),
					op('flip-v', icons.flipV, 'Flip Vertical', () => this.quickTransform('Flip vertical', (c, p) => float2(p.x, 2 * c.y - p.y))),
					op('rotate-cw', icons.rotateCW, 'Rotate 90° Clockwise', () => this.quickTransform('Rotate clockwise', (c, p) => float2(c.x - (p.y - c.y), c.y + (p.x - c.x)))),
					op('rotate-acw', icons.rotateACW, 'Rotate 90° Anticlockwise', () => this.quickTransform('Rotate anticlockwise', (c, p) => float2(c.x + (p.y - c.y), c.y - (p.x - c.x)))),
				],
			});

		if (this.canStructure())
			items.push({
				id:			'edit',
				face:		() => svgFace(icons.editPoints),
				caption:	() => 'Edit points',
				children:	() => {
					const p = this.points()!, point = this.picked >= 0, contour = this.pickedContour >= 0;
					const out: CascadeItem[] = [];
					const curve = this.menuCurve;
					if (curve) {
						out.push(op('insert-here', icons.insert, 'Insert on-curve point here', () => this.insertAt(curve.piece, curve.t)));
						if (this.canRaise(curve.piece))
							out.push(op('insert-control', icons.insertControl, 'Insert off-curve point here', () => this.insertControl(curve.piece)));
					}
					if (point) {
						out.push(op('delete-point', icons.deletePoint, 'Delete point (Del)', () => this.deletePoint()));
						if (this.oppositeOf(this.picked))
							out.push(op('align', icons.align, 'Align opposite handle', () => this.alignOpposite()));
						out.push(op('toggle', icons.toggle, 'Toggle on-curve / off-curve (T)', () => this.togglePoint()));
						//out.push(op('select-contour', icons.selectContour, 'Select contour', () => this.selectContour(this.picked)));
					}
					if (point || contour)
						out.push(op('delete-contour', icons.deleteContour, 'Delete contour', () => { if (this.picked >= 0) this.selectContour(this.picked); this.deleteContour(); }));
					if (this.simplifyPoints)
						out.push(this.simplifyItem());
					return out;
				},
			});

		items.push({
			id:			'view',
			face:		() => svgFace(icons.view),
			caption:	() => 'View',
			children:	() => [
				op('fit', icons.fit, 'Fit (0)', () => this.fit()),
				...[...Object.keys(VIEW_TOGGLES)].filter(n => this.viewNames().includes(n)).map(n => ({
					...toggleItem(VIEW_TOGGLES[n], svgFace((icons as any)[n]), () => this.option(n), v => { this.options.set(n, v); this.draw(); }),
					id: 'view-' + n,
				})),
			],
		});
		return items;
	}

	private viewNames() {
		return ['grid', 'outline', 'polygon', 'points', 'numbers', 'snap', ...this.extraViews];
	}

	//--- the keyboard ---------------------------------------------------------------

	// the keys of editing and of the view; true when one was used
	key(e: KeyboardEvent): boolean {
		if (this.canEdit() && !this.xf && (this.picked >= 0 || this.pickedContour >= 0)) {
			const d = e.shiftKey ? 10 : 1;
			switch (e.key) {
				case 'ArrowLeft':	this.nudge(-d, 0); 					return true;
				case 'ArrowRight':	this.nudge(d, 0); 					return true;
				case 'ArrowUp':		this.nudge(0, -d); 					return true;
				case 'ArrowDown':	this.nudge(0, d); 					return true;
				case 'Delete': case 'Backspace': this.deletePoint(); 	return true;
				case 't':			this.togglePoint(); 				return true;
			}
		}

		const apply = e.key === 'Enter';
		switch (e.key) {
			case 'Enter': case 'Escape':
				if (this.simplifying)
					this.endSimplify(apply);
				else if (this.xf)
					this.endTransform(apply);
				else if (this.endChain())
					this.draw();
				else if (!apply && this.tool !== 'select')
					this.setTool('select');
				else
					return false;
				return true;
			case '+': case '=':	this.zoom(1.5); 	return true;
			case '-':			this.zoom(1 / 1.5); return true;
			case '0':			this.fit(); 		return true;
		}
		return false;
	}
}
