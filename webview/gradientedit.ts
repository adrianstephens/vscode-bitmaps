// Editing a gradient on the drawing: the stops are shown along the gradient's axis in place of a shape's points, and the pointer,
// the menu and the status are for them. The gradient is in its own space, which `matrix` takes to the editor's; `points` are its
// start and end (or, for a radial one, the centre, a place a radius away and the focus) in it, as x, y and 1. It knows nothing of
// where a gradient is kept: a page says how to get the stops (options), and how the geometry is written (commit, updateContent).
// The SVG editor (svgsession.ts) and the bitmap editor's shape layers (shapeedit.ts) each describe their own.

import { float2, float2x3 } from '@isopodlabs/maths/vector';
import { type DragHandler, type PathEditor } from './pathedit.js';
import { choiceItem, valueItem, svgFace, swatchFace, colourItems, type CascadeItem } from './cascade.js';
import { type RGB, toHex, toCss, mixColour, clamp01, lerp } from './colour.js';

const STOP_HIT = 10;		// pixels from a stop (or the gradient's axis) that a press takes it
const num = (n: number) => +n.toFixed(3);

export interface Stop {
	offset:		number;			// 0 to 1 along the gradient
	color:		RGB;
	opacity:	number;
}

export type Spread = 'pad' | 'reflect' | 'repeat';

export type Paint =
	| {type: 'unset', effective?: string}		// inherited, as the page shows it
	| {type: 'none'}
	| {type: 'color', color: RGB}
	| {type: 'linear' | 'radial', stops: Stop[], spread: Spread}
	| {type: 'other', text: string};			// currentColor, a pattern: something the controls do not make

export type PaintMode = 'unset' | 'none' | 'color' | 'linear' | 'radial';

export interface PaintOptions {
	label:		string;
	modes:		PaintMode[];						// which the shape may be given
	get():		Paint;
	// final is false while a control is still being dragged, and true when it is let go
	set(paint: Paint, final: boolean): void;
	opacity?:	{get(): number, set(value: number, final: boolean): void};
	// the gradient's geometry is edited on the drawing, which the page shows or hides
	handles?:	{get(): boolean, set(on: boolean): void};
	// where a colour is the editable part of the paint, as a colour font's layers are
	editable?:	boolean;
}


export const cssOf = (s: Stop) => toCss(s.color, s.opacity);


// the colour a gradient has at an offset
export function colourAt(stops: Stop[], t: number): Stop {
	const sorted = [...stops].sort((a, b) => a.offset - b.offset), i = sorted.findIndex(s => s.offset >= t);
	if (i <= 0)
		return {...sorted[i < 0 ? sorted.length - 1 : 0], offset: t};
	const a = sorted[i - 1], b = sorted[i], u = (t - a.offset) / ((b.offset - a.offset) || 1);
	return {offset: t, color: mixColour(a.color, b.color, u), opacity: lerp(a.opacity, b.opacity, u)};
}

// the stops with another at an offset, which keeps them in order, and where it is
function withStop(stops: Stop[], t: number) {
	t = Math.round(clamp01(t) * 1000) / 1000;
	const at = stops.findIndex(s => s.offset > t), index = at < 0 ? stops.length : at;
	return {stops: [...stops.slice(0, index), colourAt(stops, t), ...stops.slice(index)], index};
}


export abstract class GradientEditor {
	/** The paint being edited (its stops are what the handles show), if there still is one. */
	abstract options(): PaintOptions | undefined;
	/** The geometry was changed by dragging, and is let go: it is written where it belongs and recorded. */
	abstract commit(): void;
	/** The gradient as shown while its geometry changes. */
	abstract updateContent(): void;

	/** Whether a gradient has a spread (what lies beyond its ends), which the menu of its last stop sets. */
	protected readonly spreads: boolean = true;

	constructor(readonly prop: string, readonly points: float2[], readonly matrix: float2x3, protected readonly redraw: () => void, public stop = 0) {}

	describe() {
		return `${this.prop} gradient \u00b7 drag a stop to move it (the first and last move the ends) \u00b7 right-click a stop for its menu, or the line to add one`;
	}

	// where the stops lie: along the axis, the line between the start and end
	private track(ed: PathEditor) {
		const a = ed.toScreen(this.points[0]), d = ed.toScreen(this.points[1]).sub(a);
		if (d.len() < 24)
			return;
		return {a, d, at: (t: number) => a.add(d.scale(t))};
	}

	overlay(ed: PathEditor) {
		const track = this.track(ed), paint = this.options()?.get();
		if (!track || (paint?.type !== 'linear' && paint?.type !== 'radial'))
			return '';
		const current = Math.min(this.stop, paint.stops.length - 1);
		const line = `M${num(track.a.x)},${num(track.a.y)}l${num(track.d.x)},${num(track.d.y)}`;
		// a radial gradient's stops are each a circle (drawn through its space, which may make it an ellipse), dotted
		const rings = paint.type !== 'radial' ? '' : paint.stops.map((s, i) => {
			const p = this.points, r = p[1].sub(p[0]).len() * s.offset;
			if (r <= 0)
				return '';
			const d = Array.from({length: 64}, (_, k) => { const q = ed.toScreen(p[0].add(float2.cossin(k * Math.PI / 32).scale(r))); return `${num(q.x)},${num(q.y)}`; }).join('L');
			return `<path d="M${d}Z" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="3" stroke-dasharray="1 5" stroke-linecap="round"/>`
				+ `<path d="M${d}Z" fill="none" stroke="${i === current ? '#fff' : cssOf({...s, opacity: 1})}" stroke-width="1.5" stroke-dasharray="1 5" stroke-linecap="round"/>`;
		}).join('');
		return rings + `<path d="${line}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="4" stroke-linecap="round"/><path d="${line}" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`
			+ paint.stops.map((s, i) => {
				const {x, y} = track.at(s.offset), on = i === current;
				return `<circle cx="${num(x)}" cy="${num(y)}" r="${on ? 9 : 7}" fill="${cssOf(s)}" stroke="${on ? '#fff' : '#000'}" stroke-width="${on ? 3 : 2}"/>`
					+ (on ? `<circle cx="${num(x)}" cy="${num(y)}" r="10.5" fill="none" stroke="#000" stroke-opacity="0.6"/>` : '');
			}).join('');
	}

	// the stop (or the axis, where one may be added) under a place on the screen, with where along the axis that is
	private hit(ed: PathEditor, sp: float2) {
		const track = this.track(ed), options = this.options(), paint = options?.get();
		if (!track || !options || (paint?.type !== 'linear' && paint?.type !== 'radial'))
			return;
		const len2 = track.d.lensq();
		const along = (p: float2) => clamp01(p.sub(track.a).dot(track.d) / len2);
		let index = -1, near = STOP_HIT;
		paint.stops.forEach((s, i) => {
			const d = track.at(s.offset).sub(sp).len() - (i === this.stop ? 0.5 : 0);
			if (d <= near) {
				near = d;
				index = i;
			}
		});
		const t = along(sp);
		if (index < 0 && track.at(t).sub(sp).len() > STOP_HIT)
			return;
		return {options, paint, index, t, along};
	}

	// a press on a stop selects it and drags it along the axis; the first and last are the ends of the gradient, which they move
	// instead. The axis between the stops is for the menu, which adds one there.
	capture(ed: PathEditor, sp: float2): DragHandler | undefined {
		const hit = this.hit(ed, sp);
		if (!hit || hit.index < 0)
			return;
		const {options, paint, along, index} = hit;
		let moved = false;
		this.stop = index;
		ed.draw();
		const here = (ev: PointerEvent) => {
			const r = ed.svg.getBoundingClientRect();
			return float2(ev.clientX - r.left, ev.clientY - r.top);
		};
		const last = paint.stops.length - 1;
		if (index === 0 || index === last) {
			const was = this.points.slice();
			const o0 = paint.stops[0].offset, o1 = paint.stops[last].offset;
			const start = ed.toLocal(sp);
			return {
				raw:	true,
				move:	(_d, ev) => this.moveEnd(index, ed.toLocal(here(ev)), start, was, o0, o1),
				end:	moved => {
					if (moved)
						this.commit();
				},
			};
		}
		return {
			raw:	true,
			move:	(_d, ev) => {
				const now = options.get();
				if ('stops' in now) {
					const stops = now.stops.map(s => ({...s}));
					// between its neighbours, which keeps the stops in order
					stops[index].offset = Math.round(Math.min(stops[index + 1]?.offset ?? 1, Math.max(stops[index - 1]?.offset ?? 0, along(here(ev)))) * 1000) / 1000;
					options.set({...now, stops}, false);
					moved = true;
				}
			},
			end:	() => {
				if (moved)
					options.set(options.get(), true);
			},
		};
	}

	// the whole menu, over a stop or the axis: what the stop has, or adding one
	menu(ed: PathEditor, sp: float2): CascadeItem[] | undefined {
		const hit = this.hit(ed, sp);
		if (!hit)
			return;
		if (hit.index >= 0)
			this.stop = hit.index;
		ed.draw();
		return this.items(hit.options, hit.index, hit.t);
	}

	private items(options: PaintOptions, index: number, at: number): CascadeItem[] {
		const now 		= () => options.get(), prop = this.prop;
		const stopNow	= () => { const p = now(); return 'stops' in p ? {p, i: Math.min(index, p.stops.length - 1)} : undefined; };
		const g			= () => stopNow()!, the = () => g().p.stops[g().i];
		const edit		= (change: (s: Stop, all: Stop[], i: number) => void, final: boolean) => {
			const q = stopNow();
			if (q) {
				const stops = q.p.stops.map(s => ({...s}));
				change(stops[q.i], stops, q.i);
				options.set({...q.p, stops}, final);
				this.redraw();
			}
		};
		const op		= (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});
		const idp		= `${prop}-stop`;

		if (!stopNow())
			return [];
		
		if (index < 0)
			return [op(`${idp}-add`, '<circle cx="8" cy="8" r="5"/><path d="M8 5.5V10.5M5.5 8H10.5"/>', 'Add a stop here', () => {
				const q = g().p, more = withStop(q.stops, at);
				this.stop = more.index;
				options.set({...q, stops: more.stops}, true);
				this.redraw();
			})];
		return [
			{id: `${idp}-colour`, face: () => swatchFace(toHex(the().color)), caption: () => `Stop colour ${toHex(the().color)}`, children: () =>
				colourItems(idp, () => the().color, (c, final) => edit(s => { s.color = c; }, final)),
			},
			{
				...valueItem({
					label:		'alpha',
					caption:	'Stop opacity',
					get:		() => Math.round(the().opacity * 100),
					set:		v => edit(s => { s.opacity = Math.round(v) / 100; }, false),
					min:		0,
					max:		100,
					step:		(v, steps) => v + 5 * steps,
					presets:	[0, 25, 50, 75, 100],
					format:		v => `${Math.round(v)}%`,
				}),
				id:			`${idp}-opacity`,
			},
			// what a gradient does beyond its last stop (and before its first)
			...(this.spreads && index === g().p.stops.length - 1 ? [choiceItem({
				caption: 'Spread',
				get: () => { const q = now(); return 'stops' in q ? q.spread : 'pad'; },
				set: v => { const q = now(); if ('stops' in q) options.set({...q, spread: v}, true); }
			}, (['pad', 'reflect', 'repeat'] as const).map(v => ({
				value:		v,
				face:		svgFace(`<rect x="2" y="3" width="12" height="10" fill="none"/><path d="${{pad: 'M6 8H2M10 8H14M6 5V11M10 5V11', reflect: 'M2 6L6 10L10 6L14 10', repeat: 'M2 10L6 6V10L10 6V10L14 6'}[v]}"/>`),
				caption:	v,
			})))] : []),
			// the ends are the gradient's own, so only the stops between them can go
			...(index > 0 && index < g().p.stops.length - 1 ? [op(`${idp}-remove`, '<circle cx="8" cy="8" r="5"/><path d="M5.5 8H10.5"/>', 'Remove this stop', () => {
				const q = g().p, i = g().i;
				options.set({...q, stops: q.stops.filter((_, k) => k !== i)}, true);
				this.stop = Math.max(0, i - 1);
				this.redraw();
			})] : []),
		];
	}

	/** An end of the gradient (its first or last stop) is dragged to q, from where it was pressed (`start`), the handles as they were
	 *  (`was`) and the offsets of the first and last stops. It sets the handles. */
	protected moveEnd(index: number, q: float2, start: float2, was: float2[], o0: number, o1: number) {
		const p = this.points, radial = p.length > 2, span = o1 - o0;
		if (radial) {
			if (index === 0)
				p[0] = was[0].add(q.sub(start));								// the centre; what is set by it goes with it
			else if (o1 > 1e-6)
				p[1] = was[0].add(q.sub(was[0]).scale(1 / o1));
		} else if (span > 1e-6) {
			// the other end stays where it is, and the gradient runs from this one to it
			const v = was[1].sub(was[0]);
			const f = was[0].add(v.scale(index === 0 ? o1 : o0));
			const n = (index === 0 ? f.sub(q) : q.sub(f)).scale(1 / span);
			p[0] = (index === 0 ? q : f).sub(n.scale(o0));
			p[1] = p[0].add(n);
		} else {
			const k = index === 0 ? 0 : 1;
			p[k] = was[k].add(q.sub(start));
		}
	}
}
