// The outline editor shared by the font viewer's glyph inspector and the SVG editor: a pan and zoom view over a grid, the
// points of one outline drawn over whatever the page shows, and the editing of them (drag, nudge, insert, delete, toggle,
// select a contour, drag a contour) with a menu of icons (cascade.ts) that the right button brings up. What is being edited is a
// curve as binary_fonts has it: a list of vertices, x, y and flags, where ON_BEGIN begins a contour, which is closed back to its begin
// point unless its last point is ON_END (SVG only), ON_CURVE is on-curve, OFF_BEZ2 a quadratic control and OFF_BEZ3 a cubic control.
// A control after a control stands for the on-curve point halfway between them, as in TrueType.
// A page subclasses it for what it draws under the points and what its edits do.

import { createSVGElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Cascade, CascadeItem, icons as cascadeIcons, svgFace, valueFace, valueItem, toggleItem, choiceItem } from './cascade.js';
import { Input, type InputLayer, type Drag } from './navigate.js';
import { TransformMode, BoxTransform, modeChoices, transformIcons, HANDLE, carryPoint } from './transformbox.js';
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
const xy	= (p: float2) => `${num(p.x)},${num(p.y)}`;
const vec	= (v: {x: number, y: number}) => float2(v.x, v.y);
const roundTo = (p: float2, step: number) => step ? float2(Math.round(p.x / step) * step, Math.round(p.y / step) * step) : p;

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
			case ON_CURVE:	add([prev, pt]); break;
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

export interface DragHandler { move(d: float2, e: PointerEvent): void; end(moved: boolean): void; raw?: boolean }

// a line, a quadratic or a cubic of the outline: the points that define it, and where each is in the outline (-1 if implied)
export interface Piece { points: float2[], at: number[] }

const curveOf = ({points}: Piece) => points.length === 4 ? new bezier3(points[0], points[1], points[2], points[3])
	: new bezier2(points[0], points.length === 2 ? lerp(points[0], points[1], 0.5) : points[1], points[points.length - 1]);

// what is drawn and how points land, which a page may share between the editors it has over the same place
// (the grid is one only if it is given: an editor over a picture that has its own has none)
export class ViewOptions {
	constructor(private values: Record<string, boolean> = {}) {}
	has(name: string) { return name in this.values || name !== 'grid'; }
	get(name: string) { return this.values[name] ?? DEFAULT_OPTIONS[name] ?? true; }
	set(name: string, on: boolean) { this.values[name] = on; }
}
const DEFAULT_OPTIONS: Record<string, boolean> = {numbers: false, snap: false};

/** The grid's spacing at a scale (screen pixels to a unit): round numbers, 1, 2, 5 or 10 of a power of ten, at least `gap` pixels apart
 *  (and no finer than `least`), with every `every`th line major. */
export function gridSpacing(scale: number, gap = 12, least = 0) {
	const raw = gap / scale, pow = 10 ** Math.floor(Math.log10(raw));
	const step = Math.max(least, [1, 2, 5, 10].map(k => k * pow).find(v => v >= raw)!);
	return {step, every: Math.round(step / 10 ** Math.floor(Math.log10(step))) === 5 ? 2 : 5};
}

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
	grid:		cascadeIcons.grid,
	outline:	'<path d="M3 13C3 4 8 2 13 3C14 8 12 13 3 13Z"/>',
	polygon:	'<path d="M3 13L5 3L13 5L12 13Z" stroke-dasharray="2 1.5"/>',
	points:		'<rect x="2" y="9" width="4" height="4"/><circle cx="11" cy="4.5" r="2"/><rect x="10" y="10" width="4" height="4"/>',
	numbers:	'<path d="M4 3V13M2.5 4.5L4 3M8 5C8 2 13 2 13 5C13 8 8 9 8 13H13"/>',
	snap:		'<path d="M2 14H14M2 14V2M5 14V11M8 14V11M11 14V11"/><circle cx="8" cy="6" r="2"/>',
	metrics:	'<path d="M1 4H15M1 8H15M1 12H15" stroke-dasharray="3 2"/>',
	fill:		'<path d="M3 13C3 4 8 2 13 3C14 8 12 13 3 13Z" fill="currentColor" fill-opacity="0.45"/>',
};

const VIEW_TOGGLES: Record<string, string> = {
	outline:	'Outline', 
	polygon:	'Polygon', 
	points:		'Points',
	numbers:	'Point numbers', 
	grid:		'Grid',
	snap:		'Snap to the grid', 
	metrics:	'Metrics', 
	fill:		'Fill',
};

// a transform under way: the box, and what it carries (the points from s on, as they were, or the element by a transform of its own);
// for a warp, the points were cut finer first, and `before` is what they were
interface TransformSet {box: BoxTransform, s: number, orig: curveVertex[], before?: curveVertex[], element?: ElementTransform};

const WARP_CUTS = 4;	// what each piece of an outline is cut into for a warp, so that it bends as the warp does

export abstract class PathEditor {
	readonly svg	= createSVGElement('svg');
	protected readonly back		= createSVGElement('g');
	protected readonly content	= createSVGElement('g');
	protected readonly front	= createSVGElement('g');

	view			= {t: float2(0, 0), s: 1};	// screen = world * s + t, the world being the page's, y down
	matrix			= float2x3.identity();		// the points' own space to the world
	hover			= -1;
	picked			= -1;
	pickedContour	= -1;						// where the selected contour begins, when a whole contour is selected, or -1
	notice			= '';
	gridStep		= {step: 1, every: 5};		// the grid's spacing as last drawn, which points snap to
	tool			= 'select';					// what a press on empty ground does: 'select', a shape dragged out, or what a page adds

	protected yUp		= false;			// whether the grid is numbered upward, as a font's is, though the points are y down
	protected rounding	= 1;				// what a point lands on when snapping is off: 0 for anything
	protected cubic		= false;			// whether cubic controls may be made
	protected dragged?: {kind: ShapeKind, corners: [float2, float2]};	// the shape being dragged out, from corner to corner in world units
	protected drag?: {at: float2, moved: boolean, point?: number, link?: {anchor: number, other: number, length: number}, custom?: DragHandler & {w: float2}, contour?: {s: number, e: number, orig: curveVertex[], w: float2, last?: float2, t?: float2, angle?: number}, rotated?: boolean};
	protected extraViews: string[] = [];		// view options beyond the common ones
	protected readonly cascade: Cascade;

	private noticeTimer = 0;
	// a simplification being previewed: the contour (or all of them) as it was, and what it is now, shown in place of it
	private simplifyPx	= 1.5;		// how far it may move the outline, in pixels of the view
	private simplifying?:	{s: number, len: number, orig: curveVertex[], target: curveVertex[], token: number};
	private lastPress?: 	{t: number, p: float2};	// the last press of the line tool, for a double click
	private lineStart?: 	float2;			// where a line begins once its first click is made, before any segment is
	private lineHover?: 	{p: float2, shift: boolean};	// where the pointer is, for the segment on its way
	private chain?:			{s: number};		// the contour a line began, which the next goes on from
	private lastBounds?:	{w: number, h: number};
	private xf?:			TransformSet;

	private menuAt		= float2(0, 0);
	private menuScope:	'points' | 'element' = 'points';	// what a transform from the menu is of: the points (it was opened over one, or the outline) or the element
	private menuCurve:	{piece: Piece, t: number} | undefined;	// the place on the outline that the menu was opened over

	get dragging() { return !!this.drag; }

	// (own: the editor has the pointer over its drawing to itself; or the page puts it in the stack over something else)
	constructor(readonly host: HTMLElement, readonly options = new ViewOptions({grid: true}), own = true) {
		this.cascade = new Cascade(host, () => this.only() ?? this.items());
		this.svg.append(this.back, this.content, this.front);
		host.appendChild(this.svg);
		if (own)
			Input.on(this.svg).add(this.input);
		new ResizeObserver(() => this.draw()).observe(host);
	}

	//--- what a page supplies ----------------------------------------------------

	/** The points being edited, which the editor changes in place; undefined when there is nothing to show. */
	abstract points(): curveVertex[] | undefined;
	/** Whether they may be changed. */
	abstract canEdit(): boolean;
	/** Whether they may be added to, removed or made into curves, or only moved. */
	protected structural(): boolean { return true; }
	/** The points were changed: the page records an edit with this label. `key`, for a step of something done a step at a time (a
	 *  nudge), says what it is a step of: steps of the same thing in a row are one edit (see Steps in history.ts). */
	abstract commit(label: string, key?: string): void;
	/** What is said of what is under the pointer. */
	abstract status(text: string): void;
	/** Whether the editor is showing at all. */
	abstract active(): boolean;
	/** What the page says when no point or contour is in question. */
	abstract describe(): string;
	/** The extent of what the view fits, in world units. */
	abstract bounds(): float2.extent;

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
	/** A click that neither picked a point nor moved the view; `at` is in the view's pixels. */
	protected clicked(_e: PointerEvent, _at: float2) {}
	/** A press, before anything under it is looked at: the page may take it, as a pen does wherever it lands. */
	protected capture(_e: PointerEvent, _at: float2): DragHandler | undefined { return undefined; }
	/** Whether shapes may be drawn: by default, when contours may be added. */
	protected canDraw(): boolean { return this.canStructure(); }
	/** The shapes the page can make of a drag. */
	protected shapeKinds(): ShapeKind[] { return ['rect', 'ellipse', 'line']; }
	/** The tools a page has beyond select and the shapes, which it takes the presses of in `capture` when chosen. */
	protected extraTools(): ToolChoice[] { return []; }
	/** Where a line goes on from, in world units, if the last one drawn is to be continued: each press then adds a segment from
	 *  there. By default it is the end of the contour the last line began (a polygon, closed back to its first point). */
	protected lineContinues(): float2 | undefined {
		const p = this.points(), c = this.chain;
		if (!c || !p || !this.canStructure() || c.s >= p.length)
			return;
		const {s, e} = this.contourOf(c.s);
		if (s !== c.s || e !== p.length || p[s].flags !== ON_BEGIN)
			return;
		return this.matrix.mulPos(vec(p[e - 1]));
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
	/** A shape was dragged out from corner a to b, in world units: the page adds it. By default it is a contour. */
	protected addShape(kind: ShapeKind, a: float2, b: float2) { this.addShapeContour(kind, a, b); }
	/** Whether a press on this part of the drawing drags something (the page's `grab`), and not the view. */
	protected draggable(_target: Element): boolean { return false; }
	/** If the page can carry what is edited by a transform of its own, the way it does that; the points are then left alone. */
	protected beginElementTransform(): ElementTransform | undefined { return undefined; }
	/** A press that took no point or contour: the page may take it to drag something. */
	protected grab(_e: PointerEvent, _at: float2): DragHandler | undefined { return undefined; }
	/** The points with fewer of them, the outline kept within tol; a page that cannot do this leaves it out, and the menu has no simplify. */
	protected simplifyPoints?(points: curveVertex[], tol: number): Promise<curveVertex[]>;
	/** What the page puts at the head of the menu, ahead of the editing and the view. */
	protected pageItems(_here: float2): CascadeItem[] { return []; }
	/** Items that are the whole menu for where it was opened, in place of the page's and the editor's. */
	protected menuOnly(_here: float2): CascadeItem[] | undefined { return undefined; }
	/** Where the menu comes up: the editor's own, or a page's that the editor's items are in (see `items`). */
	protected showMenu(x: number, y: number) { this.cascade.open(x, y); }
	/** The view moved by a drag on empty ground, by so many of the view's pixels: a page whose view is another's moves that. */
	protected moveView(by: float2) { this.view.t = this.view.t.add(by); this.draw(); }

	//--- options ------------------------------------------------------------------

	option(name: string) {
		return this.options.get(name);
	}

	//--- coordinates --------------------------------------------------------------

	// a point of the points' own space on the screen
	toScreen(p: float2) {
		return this.worldToScreen(this.matrix.mulPos(p));
	}
	worldToScreen(w: float2) {
		return w.scale(this.view.s).add(this.view.t);
	}
	toWorld(sp: float2) {
		return sp.sub(this.view.t).scale(1 / this.view.s);
	}
	toLocal(sp: float2) {
		return this.matrix.inverse().mulPos(this.toWorld(sp));
	}
	private local(e: {clientX: number, clientY: number}) {
		const rect = this.svg.getBoundingClientRect();
		return float2(e.clientX - rect.left, e.clientY - rect.top);
	}
	// what points snap to: the grid when snapping is on, or else the rounding
	private snapStep() {
		return this.option('snap') ? this.gridStep.step : this.rounding;
	}
	// a point of the points' own space as it is kept: on whole units, or to four places
	private landed(l: float2) {
		return this.rounding ? float2(Math.round(l.x), Math.round(l.y)) : float2(clean(l.x), clean(l.y));
	}
	private vertex(l: float2, flags: number) {
		const {x, y} = this.landed(l);
		return curveVertex(x, y, flags);
	}
	private snapped(sp: float2) {
		return this.landed(this.matrix.inverse().mulPos(roundTo(this.toWorld(sp), this.snapStep())));
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
		const host	= float2(this.host.clientWidth, this.host.clientHeight), b = this.bounds(), size = b.size();
		const s		= scale ?? Math.max(0.001, Math.min((host.x - 80) / (size.x || 1), (host.y - 80) / (size.y || 1)));
		this.view	= {s, t: host.sub(size.scale(s)).scale(0.5).sub(b.min.scale(s))};
		this.draw();
	}

	// zoom about a point of the view, which stays where it is
	zoom(factor: number, c = float2(this.host.clientWidth / 2, this.host.clientHeight / 2)) {
		const s = Math.max(0.005, Math.min(this.view.s * factor, 4000));
		factor = s / this.view.s;
		this.view = {s, t: c.sub(c.sub(this.view.t).scale(factor))};
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
		const w = this.host.clientWidth, h = this.host.clientHeight, {s, t} = this.view;
		if (!w || !h)
			return;

		const editable	= this.canEdit();
		const points	= this.points();
		if (this.xf && (!editable || !points || points.length < this.xf.s + this.xf.orig.length))
			this.xf = undefined;
		
		const X = (x: number) => x * s + t.x, Y = (y: number) => y * s + t.y;
		if (!this.lastBounds || this.lastBounds.w !== w || this.lastBounds.h !== h) {
			this.svg.setAttribute('width', String(w));
			this.svg.setAttribute('height', String(h));
			this.lastBounds = {w, h};
		}

		let back = this.paper(X, Y, w, h);

		// a grid of round numbers of the page's units, which points snap to
		if (this.options.has('grid') && this.option('grid')) {
			const {step, every} = this.gridStep = gridSpacing(s);
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
			lines(-t.x / s, (w - t.x) / s, true, 1);
			if (this.yUp)
				lines(-(h - t.y) / s, t.y / s, false, -1);
			else
				lines(-t.y / s, (h - t.y) / s, false, 1);
			back += `<path class="insp-minor" d="${minor}"/><path class="insp-major" d="${major}"/><g class="insp-labels">${labels}</g>`;
		}

		if (this.option('metrics'))
			back += this.guides(X, Y, w, h);
		this.back.innerHTML = back;

		this.content.setAttribute('transform', `translate(${num(t.x)} ${num(t.y)}) scale(${s})`);
		this.updateContent(this.content);

		const g = `<g transform="translate(${num(t.x)} ${num(t.y)}) scale(${s}) matrix(${svgMatrix(this.matrix)})">`;
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

			const screen = (i: number) => this.toScreen(vec(points[i]));
			if (this.option('polygon')) {
				let d = '';
				for (let s = 0; s < n;) {
					let e = s + 1;
					while (e < n && !isBegin(points[e].flags))
						e++;
					for (let i = s; i < e; i++)
						d += `${i === s ? 'M' : 'L'}${xy(screen(i))}`;
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
						const sp = screen(i), x = num(sp.x), y = num(sp.y), flags = points[i].flags;
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
	pointAt(sp: float2) {
		let best = -1, bestD = 10 * 10;
		if (this.option('points') || this.pickedContour >= 0 || this.picked >= 0) {
			const p = this.points() ?? [];
			const {s, e} = this.option('points') ? {s: 0, e: p.length} : this.contourOf(this.pickedContour >= 0 ? this.pickedContour : this.picked);
			for (let i = s; i < e; i++) {
				const d = this.toScreen(vec(p[i])).sub(sp).lensq();
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

	private shapeCorners(kind: ShapeKind, a: float2, b: float2, shift: boolean, alt: boolean): [float2, float2] {
		let d = b.sub(a);
		if (shift) {
			if (kind === 'line') {
				d = float2.cossin(Math.round(d.atan2() / (Math.PI / 4)) * Math.PI / 4).scale(d.len());
			} else {
				const m = Math.max(Math.abs(d.x), Math.abs(d.y));
				d = float2(Math.sign(d.x || 1) * m, Math.sign(d.y || 1) * m);
			}
		}
		return [alt ? a.sub(d) : a, a.add(d)];
	}

	// a press with a shape tool chosen drags the shape out, which is shown as it goes and added when it ends
	private shapeDrag(sp: float2, ev: PointerEvent): DragHandler | undefined {
		const kind = this.tool as ShapeKind;
		if (!this.shapeKinds().includes(kind) || !this.canDraw())
			return;
		// the first corner is on the grid when points snap to it
		const w = roundTo(this.toWorld(sp), this.snapStep());
		if (kind === 'line') {
			// a line is clicked out: the first click sets where it begins, and each after commits a segment to the click and goes on
			// from there; the segment on its way follows the pointer
			const from = this.lineContinues() ?? this.lineStart;
			// a double click ends it: its first click made the last corner
			const now = performance.now(), last = this.lastPress;
			this.lastPress = {t: now, p: sp};
			if (from && last && now - last.t < 500 && sp.sub(last.p).len() < 5) {
				this.endChain();
				this.draw();
				return {move() {}, end: () => this.draw()};
			}
			if (!from) {
				this.lineStart = w;
			} else {
				const [a, b] = this.shapeCorners('line', from, w, ev.shiftKey, false);
				if (b.sub(a).len() * this.view.s >= 3) {
					this.lineStart = undefined;
					this.addShape('line', a, b);
				}
			}
			this.lineHover = {p: w, shift: ev.shiftKey};
			this.draw();
			return {move: (d, e) => { this.lineHover = {p: w.add(d), shift: e.shiftKey}; }, end: () => this.draw()};
		}
		let corners: [float2, float2] = [w, w];
		return {
			move:	(d, e) => {
				corners = this.shapeCorners(kind, w, w.add(d), e.shiftKey, e.altKey);
				this.dragged = {kind, corners};
			},
			end:	moved => {
				this.dragged = undefined;
				if (moved && corners[1].sub(corners[0]).len() * this.view.s >= 3)
					this.addShape(kind, ...corners);
				this.draw();
			},
		};
	}

	private shapePreview() {
		const screen = (w: float2) => this.worldToScreen(w);
		// where a line that goes on will go on from
		const end = this.tool === 'line' ? this.lineContinues() ?? this.lineStart : undefined;
		const h = this.lineHover, e = end && screen(end);
		const marker = e ? `<circle class="insp-draw" cx="${num(e.x)}" cy="${num(e.y)}" r="5" fill="none"/>` : '';
		if (end && h && !this.dragged) {
			const [a, b] = this.shapeCorners('line', end, h.p, h.shift, false).map(screen);
			return `${marker}<path class="insp-draw" d="M${xy(a)}L${xy(b)}" fill="none"/>`;
		}
		if (!this.dragged)
			return marker;
		const [a, b] = this.dragged.corners.map(screen), box = float2.extent.from([a, b]), size = box.size(), c = box.centre();
		return marker + (this.dragged.kind === 'line' ? `<path class="insp-draw" d="M${xy(a)}L${xy(b)}" fill="none"/>`
			: this.dragged.kind === 'rect' ? `<rect class="insp-draw" x="${num(box.min.x)}" y="${num(box.min.y)}" width="${num(size.x)}" height="${num(size.y)}" fill="none"/>`
			: `<ellipse class="insp-draw" cx="${num(c.x)}" cy="${num(c.y)}" rx="${num(size.x / 2)}" ry="${num(size.y / 2)}" fill="none"/>`);
	}

	// a rectangle or ellipse as a contour, running the way a TrueType outer contour does; an ellipse is made of cubic curves
	// where the points may be cubic, and of eight quadratic ones where not
	protected addShapeContour(kind: ShapeKind, a: float2, b: float2) {
		if (!this.canStructure())
			return;
		const inv = this.matrix.inverse(), p = this.points()!;
		const first = p.length;
		const put = (w: float2, flags: number) => { p.push(this.vertex(inv.mulPos(w), flags)); };
		if (kind === 'line') {
			// a polygon, a corner for each press: it closes when it comes back to where it began, and Enter or Escape leaves it as it
			// is. Two points are no outline (a font drops them), so the first line is only shown, and the corner after it is the first
			// edit, of a polygon that has three.
			const c = this.chain, end = this.lineContinues();
			if (c && end) {
				const q = this.matrix.mulPos(vec(p[c.s])), count = p.length - c.s;
				if (count >= 3 && b.sub(q).len() * this.view.s < 6) {
					this.chain = undefined;
					this.pickedContour = c.s;
					this.commit('Close contour');
					this.draw();
					return;
				}
				put(b, ON_CURVE);
				this.pickedContour = c.s;
				this.commit(count === 2 ? 'Draw polygon' : 'Extend contour');
				this.draw();
				return;
			}
			put(a, ON_BEGIN);
			put(b, ON_CURVE);
			this.chain = {s: first};
			this.picked = -1;
			this.pickedContour = first;
			this.draw();
			return;
		}
		const box = float2.extent.from([a, b]), {min, max} = box;
		if (kind === 'rect') {
			put(float2(min.x, max.y), ON_BEGIN);
			put(min, ON_CURVE);
			put(float2(max.x, min.y), ON_CURVE);
			put(max, ON_CURVE);
		} else {
			// from the left, round clockwise as seen: P(a) is the point at angle a, and the tangent there goes with a falling
			const centre = box.centre(), r = box.size().scale(0.5);
			const P = (a: number, k = 1) => centre.add(float2(Math.cos(a), -Math.sin(a)).mul(r).scale(k));
			const T = (a: number) => float2(Math.sin(a), Math.cos(a)).mul(r);
			put(P(Math.PI), ON_BEGIN);
			if (this.cubic) {
				const k = 0.5523;
				for (let i = 0; i < 4; i++) {
					const a0 = Math.PI - i * Math.PI / 2, a1 = a0 - Math.PI / 2, q = P(a1);
					put(P(a0).add(T(a0).scale(k)), OFF_BEZ3);
					put(q.sub(T(a1).scale(k)), OFF_BEZ3);
					if (i < 3)
						put(q, ON_CURVE);
				}
			} else {
				for (let i = 0; i < 8; i++) {
					const a = Math.PI - i * Math.PI / 4;
					put(P(a - Math.PI / 8, 1 / Math.cos(Math.PI / 8)), OFF_BEZ2);
					if (i < 7)
						put(P(a - Math.PI / 4), ON_CURVE);
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
	private dragContour(c: NonNullable<PathEditor['drag']>['contour'] & {}, w: float2, alt: boolean, shift: boolean) {
		const world		= c.orig.map(v => this.matrix.mulPos(vec(v)));
		const centre	= float2.extent.from(world).centre();
		const last		= c.last ?? c.w;
		c.t ??= float2(0, 0);
		c.angle ??= 0;
		if (alt) {
			const o = centre.add(c.t);
			c.angle += w.sub(o).atan2() - last.sub(o).atan2();
		} else {
			c.t = c.t.add(w.sub(last));
		}
		c.last = w;
		const angle = shift ? Math.round(c.angle / (Math.PI / 12)) * Math.PI / 12 : c.angle;
		const t = roundTo(c.t, this.snapStep()), rotate = float2.rotate(angle), inv = this.matrix.inverse(), p = this.points()!;
		world.forEach((v, i) => {
			const l = this.landed(inv.mulPos(rotate.mul(v.sub(centre)).add(centre).add(t)));
			p[c.s + i].x = l.x;
			p[c.s + i].y = l.y;
		});
		this.drag!.rotated = angle !== 0;
	}

	private shift(i: number, d: float2) {
		const v = this.points()![i];
		v.x = clean(v.x + d.x);
		v.y = clean(v.y + d.y);
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
		const p = this.points()!, {anchor, other} = o, at = vec(p[anchor]);
		const a = vec(p[k]).sub(at), b = vec(p[other]).sub(at);
		const la = a.len(), lb = b.len();
		// opposite directions, within about a degree
		if (la > 0 && lb > 0 && a.dot(b) < 0 && Math.abs(a.cross(b)) < 0.02 * la * lb)
			return {anchor, other, length: lb};
	}

	// the opposite control turned to point away from the picked one, at the distance it was
	alignOpposite() {
		const o = this.picked >= 0 ? this.oppositeOf(this.picked) : undefined;
		if (!this.canStructure() || !o)
			return;
		const p = this.points()!, a = vec(p[o.anchor]);
		if (vec(p[this.picked]).eq(a))
			return this.refuse('the control is on its point, so has no direction');
		this.keepStraight({...o, length: vec(p[o.other]).sub(a).len()}, p[this.picked]);
		this.commit('Align handles');
		this.draw();
	}

	// the linked control turned to stay in line with the one dragged, at the distance it was
	private keepStraight(link: {anchor: number, other: number, length: number}, dragged: curveVertex) {
		const p = this.points()!, a = vec(p[link.anchor]), o = p[link.other];
		const d = a.sub(vec(dragged)), len = d.len();
		if (len === 0)
			return;
		const to = a.add(d.scale(link.length / len));
		o.x = clean(to.x);
		o.y = clean(to.y);
	}

	nudge(d: float2) {
		if (!this.canEdit() || (this.picked < 0 && this.pickedContour < 0))
			return;
		const [from, to] = this.picked >= 0 ? [this.picked, this.picked + 1] : [this.pickedContour, this.contourOf(this.pickedContour).e];
		for (let i = from; i < to; i++)
			this.shift(i, d);
		if (this.picked >= 0)
			this.handlesOf(this.picked).forEach(i => this.shift(i, d));
		this.draw();
		this.commit(this.picked >= 0 ? 'Move point' : 'Move contour', this.picked >= 0 ? `point ${this.picked}` : `contour ${this.pickedContour}`);
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
			const out = result.map(v => this.vertex(vec(v), v.flags));
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
	curveAt(sp: float2) {
		if (!this.points())
			return;
		const here = this.toLocal(sp);
		let best: {piece: Piece, t: number} | undefined, bestD = 8 * 8;
		for (const piece of this.pieces()) {
			const bez = curveOf(piece), {t} = bezierClosest(here, bez);
			const d = this.toScreen(bez.evaluate(t)).sub(sp).lensq();
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
		const p = this.points()!;
		if (last === 1) {
			p.splice(at[0] + 1, 0, this.vertex(lerp(points[0], points[1], t), ON_CURVE));
			this.picked = at[0] + 1;
		} else {
			const inner = curveOf(piece).splitAt(t).control.slice(1, -1), middle = (inner.length - 1) / 2, flags = last === 2 ? OFF_BEZ2 : OFF_BEZ3;
			const start = at[0] < 0 ? [this.vertex(points[0], ON_CURVE)] : [], end = at[last] < 0 ? [this.vertex(points[last], ON_CURVE)] : [];
			p.splice(at[1], last - 1, ...start, ...inner.map((v, k) => this.vertex(v, k === middle ? ON_CURVE : flags)), ...end);
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
		const make = (q: float2, flags: number) => this.vertex(q, flags);
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

	// (what is drawn, under the pointer: a layer of the stack over the drawing (navigate.ts), its own unless a page puts it in another's)
	readonly input: InputLayer = {
		press:	e => this.press(e),
		hover:	e => this.active() ? this.hovered(e) : undefined,
		leave:	() => {
			if (!this.drag && this.hover >= 0) {
				this.hover = -1;
				this.draw();
			}
		},
		wheel:	e => {
			if (!this.active())
				return false;
			this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), this.local(e));
			return true;
		},
		menu:	e => this.active() && this.contextMenu(e),
	};

	// A press: of a point, which is dragged; of the outline, which drags its contour; of what the page takes (a handle); or of empty ground,
	// which drags the view. (The right button, or Ctrl with the left, which a Mac takes for it, is for the context menu.)
	private press(e: PointerEvent): Drag | undefined {
		if (!this.active() || e.button !== 0 || e.ctrlKey)
			return;
		this.pressed(e);
		return {move: e => this.dragTo(e), end: e => this.released(e)};
	}

	private pressed(e: PointerEvent) {
		// a press on the drawing keeps a simplification that is shown
		this.endSimplify(true);
		const here = this.local(e), editable = this.canEdit(), at = float2(e.clientX, e.clientY);
		const taken = this.xf ? this.transformDrag(e, here) : this.capture(e, here) ?? this.shapeDrag(here, e);
		if (taken) {
			this.drag = {at, moved: false, custom: {...taken, w: this.toWorld(here)}};
			return;
		}
		const point = editable ? this.pointAt(here) : -1;
		// a point of an outline that cannot be edited says why, instead of nothing happening
		if (!editable && this.points() && this.pointAt(here) >= 0)
			this.refuse(this.readOnlyReason());
		this.drag = {at, moved: false, point: point >= 0 ? point : undefined, link: point >= 0 ? this.linkOf(point) : undefined};
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
			this.drag.contour = {s, e: end, orig: this.points()!.slice(s, end).map(v => ({...v})), w: this.toWorld(here)};
			this.draw();
			return;
		}
		// the page may change what is selected in taking the press, which clears a drag
		const drag = this.drag, handler = this.grab(e, here);
		this.drag = drag;
		if (handler)
			drag.custom = {...handler, w: this.toWorld(here)};
	}

	private dragTo(e: PointerEvent) {
		const here = this.local(e), drag = this.drag;
		// how far the pointer has gone from the press, as the sum of the two ways
		const travel = () => { const d = drag!.at.sub(float2(e.clientX, e.clientY)); return Math.abs(d.x) + Math.abs(d.y); };
		if (drag?.point !== undefined) {
			if (travel() > 2)
				drag.moved = true;
			if (drag.moved) {
				const to = this.snapped(here), p = this.points()!;
				const q = p[drag.point], d = to.sub(vec(q));
				q.x = to.x;
				q.y = to.y;
				this.handlesOf(drag.point).forEach(i => this.shift(i, d));
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
			if (drag.custom.raw || travel() > 3)
				drag.moved = true;
			if (drag.moved) {
				const d = roundTo(this.toWorld(here).sub(drag.custom.w), drag.custom.raw ? 0 : this.snapStep());
				drag.custom.move(float2(clean(d.x), clean(d.y)), e);
				this.draw();
			}
			return;
		}
		if (drag?.contour) {
			if (travel() > 2)
				drag.moved = true;
			if (drag.moved) {
				this.dragContour(drag.contour, this.toWorld(here), e.altKey, e.shiftKey);
				this.draw();
			}
			return;
		}
		if (drag) {
			// (empty ground: the view is moved)
			if (travel() > 3)
				drag.moved = true;
			if (drag.moved) {
				const at = float2(e.clientX, e.clientY);
				this.svg.style.cursor = 'grabbing';
				const by = at.sub(drag.at);
				drag.at = at;
				this.moveView(by);
			}
		}
	}

	// what is under the pointer, and the cursor for it: a cross on a point, which moves it; a four-way arrow along a curve, which moves the
	// whole contour; an arrow over something the page can drag (a fill); a hand elsewhere, which moves the view
	private hovered(e: PointerEvent) {
		const here = this.local(e);
		if (this.xf) {
			const xf = this.xf;
			return xf.box.cursor(xf.box.part(this.toWorld(here), this.handleRadius()));
		}
		if (this.tool === 'line' && (this.lineStart || this.lineContinues())) {
			this.lineHover = {p: roundTo(this.toWorld(here), this.snapStep()), shift: e.shiftKey};
			this.draw();
		}
		const at = this.pointAt(here);
		if (at !== this.hover) {
			this.hover = at;
			this.draw();
		}
		return at >= 0 ? 'crosshair' : (e.target as Element).closest('[data-contour]') ? 'move' : this.draggable(e.target as Element) ? 'default' : 'grab';
	}

	private released(e: PointerEvent) {
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
			this.picked = this.pointAt(here);
			if (this.picked >= 0 || drag.point === undefined)
				this.pickedContour = -1;
			this.draw();
			if (this.picked < 0)
				this.clicked(e, here);
		}
	}

	private contextMenu(e: MouseEvent) {
		const here = this.local(e);
		this.menuCurve = undefined;
		if (this.canEdit()) {
			const at = this.pointAt(here);
			const hit = (e.target as Element).closest<SVGElement>('[data-contour]');
			this.menuScope = at >= 0 || hit ? 'points' : 'element';
			if (at >= 0) {
				this.picked = at;
				this.pickedContour = -1;
			} else if (hit) {
				this.menuCurve = this.curveAt(here);
				this.picked = -1;
				this.pickedContour = this.contourOf(+hit.dataset.contour!).s;
			}
			this.draw();
		}
		this.menuAt = here;
		this.showMenu(e.clientX, e.clientY);
		return true;
	}

	//--- transforming ---------------------------------------------------------------

	private modeItem(): CascadeItem {
		// Choosing one begins the transform, if it is not under way. (A transform of its own cannot distort or warp.) A warp begins again,
		// to cut the outline finer, and one that has been bent is applied before another mode is begun.
		const affine = this.xf ? this.xf.box.affine : this.menuScope === 'element' && !!this.beginElementTransform();
		return {...choiceItem('Mode', modeChoices(affine), () => this.xfMode, v => {
			this.xfMode = v;
			if (!this.xf || (v === 'warp' && this.xf.box.mode !== 'warp') || !this.xf.box.setMode(v))
				this.startTransform();
		}), id: 'transform-mode'};
	}
	private xfMode: TransformMode = 'free';

	private handleRadius() {
		return HANDLE * (window.devicePixelRatio || 1) / this.view.s;
	}

	// the contour selected, or else all of them, with the box round them in the world (for a warp, cut finer)
	private transformSet(mode = this.xfMode): TransformSet | undefined {
		const p = this.points();
		if (!p || !p.length || !this.canEdit())
			return;
		// from the menu over the element (not its points or outline) a page that can carries it by a transform of its own, all of it
		const element	= this.menuScope === 'element' ? this.beginElementTransform() : undefined;
		const {s, e}	= this.pickedContour >= 0 && this.menuScope === 'points' ? this.contourOf(this.pickedContour) : {s: 0, e: p.length};
		const world		= p.slice(s, e).map(v => this.matrix.mulPos(vec(v)));
		const box		= float2.extent.from(world), size = box.size();
		if (size.x < 1e-6 || size.y < 1e-6) {
			this.refuse('there is no area to transform');
			return;
		}
		const xf		= new BoxTransform(box, mode, !!element);
		const refined	= xf.mode === 'warp' && this.canStructure() ? this.refined(p.slice(s, e)) : undefined;
		const before	= refined && p.splice(s, e - s, ...refined);
		return {box: xf, s, orig: p.slice(s, refined ? s + refined.length : e).map(v => ({...v})), before, element};
	}

	// Contours cut finer for a warp to bend: each piece of them into WARP_CUTS, as curves (cubics, or where there are none quadratics),
	// so that even what is straight bends as the warp does
	private refined(p: curveVertex[]) {
		const out: curveVertex[] = [];
		for (let c = 0; c < p.length;) {
			const {e} = contourRange(p, c), contour = p.slice(c, e), all = pieces(contour), open = contour[contour.length - 1].flags === ON_END;
			c = e;
			if (!all.length) {
				out.push(...contour);
				continue;
			}
			out.push(this.vertex(all[0].points[0], ON_BEGIN));
			all.forEach(({points}, n) => {
				const [a, b] = [points[0], points[points.length - 1]];
				const curve = points.length === 4 ? curveOf({points, at: []}) as bezier3<float2>
					: points.length === 3 ? curveOf({points, at: []}) as bezier2<float2>
					: this.cubic ? new bezier3(a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b) : new bezier2(a, lerp(a, b, 0.5), b);
				for (let k = 0; k < WARP_CUTS; k++) {
					const sub = curve.slice(k / WARP_CUTS, (k + 1) / WARP_CUTS);
					if (sub instanceof bezier3)
						out.push(this.vertex(sub.c1, OFF_BEZ3), this.vertex(sub.c2, OFF_BEZ3));
					else
						out.push(this.vertex(sub.c1, OFF_BEZ2));
					// (a closed contour goes back to where it began without its last point)
					const last = n === all.length - 1 && k === WARP_CUTS - 1;
					if (!last || open)
						out.push(this.vertex(sub instanceof bezier3 ? sub.c3 : sub.c2, last ? ON_END : ON_CURVE));
				}
			});
		}
		return out;
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
	private carry(xf: TransformSet, label?: string) {
		if (xf.element) {
			xf.element(affineOf(xf.box.matrix), label);
			return;
		}
		const p			= this.points()!, inv = this.matrix.inverse(), carry = xf.box.carry;
		const area		= (q: float2[]) => q.reduce((a, c, i) => a + c.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * c.y, 0);
		const mirrored	= area(xf.box.corners) * area(xf.box.box.corners()) < 0;
		const moved		= xf.orig.map(v => {
			const t = carryPoint(carry, this.matrix.mulPos(vec(v)));
			if (isFinite(t.x) && isFinite(t.y)) {
				const {x, y} = this.landed(inv.mulPos(t));
				return {...v, x, y};
			}
		});
		if (mirrored && this.structural()) {
			for (let c = 0; c < moved.length;) {
				let e = c + 1;
				while (e < moved.length && moved[e] && !isBegin(moved[e]!.flags))
					e++;
				// the begin stays where it is, and the rest come back round
				if (moved[e - 1]?.flags !== ON_END && moved[c]?.flags === ON_BEGIN)
					moved.splice(c + 1, e - c - 1, ...moved.slice(c + 1, e).reverse());
				c = e;
			}
		}
		moved.forEach((v, i) => Object.assign(p[xf.s + i], v));
	}

	private transformDrag(e: PointerEvent, sp: float2): DragHandler | undefined {
		const xf	= this.xf!, start = this.toWorld(sp);
		const part	= xf.box.part(start, this.handleRadius());
		if (e.detail === 2 && (part.kind === 'inside' || part.kind === 'surface')) {
			this.endTransform(true);
			return {move() {}, end() {}};
		}
		const to	= xf.box.drag(part, start, d => roundTo(d, this.snapStep()));
		return {
			raw: true,
			move: (d, ev) => {
				if (to(start.add(d), ev))
					this.carry(xf);
			},
			end: () => {},
		};
	}

	// apply it (as an edit) or not
	endTransform(apply: boolean) {
		const xf = this.xf;
		if (xf) {
			this.xf = undefined;
			const moved		= xf.box.moved;
			if (apply && moved && xf.element)
				this.carry(xf, 'Transform');
			else if (apply && moved)
				this.commit('Transform');
			else if (moved && xf.element)
				xf.element(float2x3.identity());
			else if (!xf.element) {
				// (and what was cut finer for a warp, as it was before)
				const p = this.points();
				if (p && xf.before)
					p.splice(xf.s, xf.orig.length, ...xf.before);
				else if (p)
					xf.orig.forEach((v, i) => Object.assign(p[xf.s + i], v));
			}
			this.draw();
		}
	}

	// a move of the corners of the box by a function of the middle of the box and the point, done at once
	private quickTransform(label: string, f: (centre: float2, p: float2) => float2) {
		const xf = this.transformSet('free');
		if (xf) {
			const c = xf.box.box.centre();
			xf.box.quad = xf.box.quad.map(p => f(c, p));
			if (xf.element)
				this.carry(xf, label);
			else {
				this.carry(xf);
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

		const screen	= (p: float2) => xy(this.worldToScreen(p));
		const {edge: corners, lines, handles} = xf.box.outline();

		const r			= 4;
		const grid		= lines.map(([a, b]) => `M${screen(a)}L${screen(b)}`).join('');
		const marks		= handles.map(h => {
			const {x, y} = this.worldToScreen(h);
			return `<rect class="insp-xf-handle" x="${num(x) - r}" y="${num(y) - r}" width="${r * 2}" height="${r * 2}"/>`;
		}).join('');
		return `<path class="insp-xf-grid" d="${grid}"/><path class="insp-xf-box" d="M${corners.map(screen).join('L')}Z"/>${marks}`;
	}

	//--- the menu -------------------------------------------------------------------

	private readonly op = (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});

	// the menu when it is the whole menu: a transform under way, or what the page makes of where it came up (a gradient's)
	protected only(): CascadeItem[] | undefined {
		const only = this.menuOnly(this.menuAt);
		if (only)
			return only;
		if (this.xf)
			return [
				this.op('transform-apply', icons.transform, 'Apply the transform (Enter)', () => this.endTransform(true)),
				this.op('transform-cancel', icons.deletePoint, 'Cancel the transform (Esc)', () => this.endTransform(false)),
				this.modeItem(),
			];
	}

	/** The editor's items: the page's, the tools, the editing of points and the View item. They are the menu on a page of its own, or
	 *  are merged into the page's (see mergeItems). */
	items(): CascadeItem[] {
		const at = this.menuAt, op = this.op;
		if (!this.active())
			return [];

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

		items.push(this.viewItem());
		return items;
	}

	private viewItem(): CascadeItem {
		return {id: 'view', face: () => svgFace(icons.view), caption: () => 'View', children: () => [
			this.op('fit', icons.fit, 'Fit (0)', () => this.fit()),
			...this.viewNames().map(n => ({
				...toggleItem(VIEW_TOGGLES[n], svgFace((icons as any)[n]), () => this.option(n), v => { this.options.set(n, v); this.draw(); }),
				id: 'view-' + n,
			})),
		]};
	}

	private viewNames() {
		return [...(this.options.has('grid') ? ['grid'] : []), 'outline', 'polygon', 'points', 'numbers', 'snap', ...this.extraViews];
	}

	//--- the keyboard ---------------------------------------------------------------

	// the keys of editing and of the view; true when one was used
	key(e: KeyboardEvent): boolean {
		if (this.canEdit() && !this.xf && (this.picked >= 0 || this.pickedContour >= 0)) {
			const d = e.shiftKey ? 10 : 1;
			switch (e.key) {
				case 'ArrowLeft':	this.nudge(float2(-d, 0)); 			return true;
				case 'ArrowRight':	this.nudge(float2(d, 0)); 			return true;
				case 'ArrowUp':		this.nudge(float2(0, -d)); 			return true;
				case 'ArrowDown':	this.nudge(float2(0, d)); 			return true;
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
