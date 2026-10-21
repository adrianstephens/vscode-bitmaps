// A menu of icons brought up at the pointer, which takes no room until it is wanted: the first strip runs down from the
// pointer, and the pointer resting on an icon brings out that icon's own strip beside it, across from a downward strip and
// down from an across one, so the strips step down and to the right. Moving to another icon of a strip takes back what came
// out of the one before. An icon may answer the wheel (to change a value it shows) as well as a click; one that does nothing
// when clicked passes the click back to the icon it came out of, so clicking a tool's option chooses the tool. A value with a
// strip of presets can also be dragged: the left button held on it or on a preset, the pointer's place along the strip is the
// value.
// It knows nothing of what its items do; an editor describes them as CascadeItems. Styles are in assets/cascade.css.

import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';

export interface CascadeItem {
	id?:			string;				// the icon's data-id, for finding it from outside
	face():			string;				// the inside of the icon, as HTML: see svgFace, valueFace, swatchFace
	caption():		string;				// shown beside the icon while the pointer is on it
	children?():	CascadeItem[];		// the strip that comes out of this icon
	active?():		boolean;			// marked, as the current tool or the chosen option is
	select?():		boolean | void;		// a click on it, or the right button let go on it: true keeps the menu open
	click?():		boolean | void;	// a click on this icon itself (not on one of its strip's that has no `select`): true if it took the click, which closes the menu
	wheel?(steps: number): number;		// the wheel turned over it, with up positive; returns how much of steps was used
	gauge?():		number;				// where a value falls along the strip that comes out of this icon, drawn as a bar through
										// it: in icons, 0 the middle of the first, 1.5 halfway from the second to the third
	scrub?(position: number): void;		// the pointer dragged to a place along that strip, in the same terms as gauge
	// The icon dragged to another place in its strip, among those that can be: it is told at the start, and where it is to
	// be (a place in the strip) as it is dragged, and at the end. The strip's icons are reordered as it goes.
	hover?(on: boolean): void;			// the pointer has come to rest on this icon, or gone from it to another
	drag?:			{begin(): void, to(place: number): void, drop(): void};
}

// faces
export const svgFace = (body: string) =>
	`<svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

export const valueFace = (label: string, value: string) =>
	`<span class="cascade-value"><small>${label}</small>${value}</span>`;

export const swatchFace = (colour: string, second?: string) => second
	? `<span class="cascade-swatch2"><span style="background:${second}"></span><span style="background:${colour}"></span></span>`
	: `<span class="cascade-swatch" style="background:${colour}"></span>`;

// a number that the wheel changes, and that a strip of presets can set
export interface ValueOptions {
	label:		string;					// short, to fit on the icon
	caption:	string;
	get():		number;
	set(v: number): void;
	min:		number;
	max:		number;
	step?:		(value: number, steps: number) => number;	// the value after turning the wheel; by default up or down by one
	presets?:	number[];				// increasing
	resolution?: number;				// what a value dragged along the presets is rounded to; by default 1
	format?:	(value: number) => string;
}

export function valueItem(o: ValueOptions): CascadeItem {
	const format = o.format ?? (v => String(Math.round(v)));
	const resolution = o.resolution;
	const quant: (v: number) => number = resolution === undefined ? v => Math.round(v) : resolution === 0 ? v => v : v => Math.round(v / resolution) * resolution;
	const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));

	return {
		face:		() => valueFace(o.label, format(o.get())),
		caption:	() => `${o.caption} ${format(o.get())} (scroll${o.presets ? ' or drag' : ''})`,
		wheel:		steps => {
			const v = o.get();
			if (o.step) {
				o.set(clamp(o.step(v, steps)));
				return steps;
			} else {
				const v1 = quant(v + steps);
				o.set(clamp(v1));
				return clamp(v1) !== v1 ? steps : v1 - v;		// the wheel is all used up at either end
			}
		},
		gauge:		o.presets && (() => presetPosition(o.presets!, clamp(o.get()), o.min, o.max)),
		scrub:		o.presets && (p => o.set(clamp(quant(presetValue(o.presets!, p, o.min, o.max))))),
		children:	o.presets && (() => o.presets!.map(v => ({
			id:			`preset-${v}`,
			face:		() => valueFace('', format(v)),
			caption:	() => `${o.caption} ${format(v)}`,
			active:		() => o.get() === v,
			select:		() => { o.set(v); return true; },
		}))),
	};
}

// where a value falls among increasing presets, in presets: between them in proportion, and beyond them out to half a
// preset at the least and most it can be
function presetPosition(presets: number[], v: number, min: number, max: number) {
	const n = presets.length, first = presets[0], last = presets[n - 1];
	if (v <= first)
		return first > min ? -0.5 * (first - v) / (first - min) : 0;
	if (v >= last)
		return n - 1 + (max > last ? 0.5 * (v - last) / (max - last) : 0);
	const i = presets.findIndex((p, i) => v >= p && v < presets[i + 1]);
	return i + (v - presets[i]) / (presets[i + 1] - presets[i]);
}

// and back
function presetValue(presets: number[], p: number, min: number, max: number) {
	const n = presets.length, first = presets[0], last = presets[n - 1];
	if (p <= 0)
		return first + 2 * p * (first - min);
	if (p >= n - 1)
		return last + 2 * (p - (n - 1)) * (max - last);
	const i = Math.floor(p);
	return presets[i] + (p - i) * (presets[i + 1] - presets[i]);
}

// a step that grows with the value, for sizes
export const multiplicativeStep = (factor = 1.15) => (v: number, steps: number) =>
	Math.round(v * factor ** steps + Math.sign(steps));

// one of a few choices, which the wheel goes through and whose strip shows them all
// a choice among values, which keeps the menu open for the next setting unless `closes`
export function choiceItem<T>(caption: string, choices: {value: T, face: string, caption: string}[], get: () => T, set: (v: T) => void, closes = false): CascadeItem {
	const current = () => Math.max(0, choices.findIndex(c => c.value === get()));
	return {
		face:		() => choices[current()].face,
		caption:	() => `${caption}: ${choices[current()].caption}`,
		wheel:		steps => {
			const delta = Math.round(steps);
			if (delta)
				set(choices[(current() + delta + choices.length) % choices.length].value);
			return delta;
		},
		children:	() => choices.map(c => ({
			id:			typeof c.value === 'string' ? c.value : undefined,
			face:		() => c.face,
			caption:	() => c.caption,
			active:		() => get() === c.value,
			select:		() => { set(c.value); return !closes; },
		})),
	};
}

export function toggleItem(caption: string, face: string, get: () => boolean, set: (v: boolean) => void): CascadeItem {
	return {
		face:		() => face,
		caption:	() => `${caption}: ${get() ? 'on' : 'off'}`,
		active:		get,
		select:		() => { set(!get()); return true; },
		wheel:		steps => {
			const delta = Math.round(steps);
			if (delta)
				set(delta > 0);
			return delta;
		}
	};
}

interface Strip {
	element:	HTMLElement;
	items:		CascadeItem[];
	buttons:	HTMLElement[];
	vertical:	boolean;
	x:			number;			// where it is in the stage, which the buttons' places are measured from
	y:			number;
	open:		number;			// the button whose strip is out, or -1
	owner?:		CascadeItem;	// the icon it came out of
	gauge?:		HTMLElement;
}

const GAP = 3;				// between the icons of a strip, and between a strip and the icon it came out of
const WHEEL_STEP = 50;		// pixels of a smooth wheel (a trackpad) to a step
const WHEEL_PAUSE = 250;		// ms without the wheel after which the next movement is a new gesture
const RELEASE_DELAY = 300;	// the right button let go this long after the menu opened chooses the icon under it
const DRAG_START = 4;		// pixels the pointer moves with the button down before it is a drag and not a click

export class Cascade {
	private root		= createElement('div', {className: 'cascade hidden'});
	private caption		= createElement('div', {className: 'cascade-caption'});
	private strips:		Strip[] = [];
	private openedAt	= 0;
	private stepAccum	= 0;
	private wheelItem?:	CascadeItem;	// what the wheel last turned, and when: leftovers from a different icon or an earlier gesture are dropped
	private wheelTime	= 0;
	private drag?:		{strip: Strip, owner: CascadeItem, x: number, y: number, moved: boolean};
	private lit?:		CascadeItem;	// the icon last rested on
	private dragged		= false;	// the click that ends a drag is not a click
	private reorder?:	{strip: Strip, item: CascadeItem, x: number, y: number, moved: boolean};	// an icon being dragged to another place in its strip

	constructor(private stage: HTMLElement, private items: () => CascadeItem[]) {
		this.root.append(this.caption);
		stage.append(this.root);

		window.addEventListener('pointermove', e => {
			if (this.drag) {
				this.dragTo(e);
				return;
			}
			if (this.reorder) {
				this.reorderTo(e);
				return;
			}
			const hit = this.hit(e);
			if (hit)
				this.hover(hit.level, hit.index);
		});
		// the left button down on a value or one of its presets, which a drag along the presets sets
		this.root.addEventListener('pointerdown', e => {
			this.dragged = false;
			const hit = e.button === 0 && this.hit(e);
			if (!hit)
				return;
			const item = this.strips[hit.level].items[hit.index];
			if (item.drag) {
				this.reorder = {strip: this.strips[hit.level], item, x: e.clientX, y: e.clientY, moved: false};
				this.strips[hit.level].buttons[hit.index].setPointerCapture(e.pointerId);
				return;
			}
			const strip = item.scrub ? this.strips[hit.level + 1] : this.strips[hit.level];
			const owner = strip?.owner;
			if (owner?.scrub && (!item.scrub || owner === item)) {
				this.drag = {strip, owner, x: e.clientX, y: e.clientY, moved: false};
				this.strips[hit.level].buttons[hit.index].setPointerCapture(e.pointerId);
			}
		});
		window.addEventListener('pointerdown', e => {
			if (this.isOpen && !this.root.contains(e.target as Node) && e.button !== 2)
				this.close();
		}, true);
		window.addEventListener('pointerup', e => {
			if (this.reorder && e.button === 0) {
				const r = this.reorder;
				this.reorder = undefined;
				this.dragged = r.moved;
				if (r.moved) {
					r.strip.buttons.forEach(b => b.classList.remove('dragging'));
					r.item.drag!.drop();
					this.refresh();
				}
			}
			if (this.drag && e.button === 0) {
				this.dragged	= this.drag.moved;
				this.drag		= undefined;
			}
			// press, move and let go: the right button held since the menu opened (where the context menu comes on the press)
			if (this.isOpen && e.button === 2 && performance.now() - this.openedAt > RELEASE_DELAY) {
				const hit = this.hit(e);
				if (hit)
					this.choose(hit.level, hit.index);
			}
		});
		this.root.addEventListener('click', e => {
			if (this.dragged) {
				this.dragged = false;
				return;
			}
			const hit = this.hit(e);
			if (hit)
				this.choose(hit.level, hit.index);
		});
		this.root.addEventListener('wheel', e => {
			e.preventDefault();
			const hit = this.hit(e);
			const item = hit && this.strips[hit.level].items[hit.index];
			if (!item?.wheel)
				return;

			const delta = e.deltaY / -WHEEL_STEP;
			if (item !== this.wheelItem || e.timeStamp - this.wheelTime > WHEEL_PAUSE || Math.sign(delta) !== Math.sign(this.stepAccum))
				this.stepAccum = 0;
			this.wheelItem = item;
			this.wheelTime = e.timeStamp;
			this.stepAccum += delta;
			const used = item.wheel(this.stepAccum);
			if (used)
				this.refresh();

			this.stepAccum -= used;

		}, {passive: false});
		window.addEventListener('keydown', e => {
			// Escape closes the menu and does nothing else
			if (this.isOpen && e.key === 'Escape') {
				this.close();
				e.stopPropagation();
			}
		}, true);
		window.addEventListener('blur', () => this.close());
	}

	get isOpen() {
		return !this.root.classList.contains('hidden');
	}

	contains(node: Node) {
		return this.root.contains(node);
	}

	// the first strip, running down from a point on the screen
	open(clientX: number, clientY: number, items = this.items()) {
		this.closeFrom(0, false);
		this.root.classList.remove('hidden');
		this.openedAt = performance.now();
		const stage = this.stage.getBoundingClientRect();
		const x = clientX - stage.left, y = clientY - stage.top;
		this.addStrip(items, true, {x: x - 16, y, w: 32, h: 0, cx: x, cy: y});
	}

	close() {
		if (!this.isOpen)
			return;
		this.drag = undefined;
		this.light(undefined);
		this.closeFrom(0, false);
		this.caption.classList.remove('shown');
		this.root.classList.add('hidden');
	}

	private light(item: CascadeItem | undefined) {
		if (this.lit === item)
			return;
		this.lit?.hover?.(false);
		this.lit = item;
		item?.hover?.(true);
	}

	// the icons again, after what they show has changed
	refresh() {
		for (const s of this.strips) {
			s.items.forEach((item, i) => this.paint(s.buttons[i], item, i === s.open));
			this.placeGauge(s);
		}
		// the caption is of the deepest icon the pointer has rested on
		const s = [...this.strips].reverse().find(s => s.open >= 0);
		if (s)
			this.caption.textContent = s.items[s.open].caption();
	}

	//-------------------------------------------------------------------------

	private paint(button: HTMLElement, item: CascadeItem, open: boolean) {
		const face = item.face();
		if (button.dataset.face !== face) {
			button.innerHTML = face;
			button.dataset.face = face;
		}
		button.classList.toggle('active', item.active?.() ?? false);
		button.classList.toggle('open', open);
		button.classList.toggle('wheel', !!item.wheel);
	}

	// a strip beside the rectangle (in the stage) of the icon it comes out of, turned back if there is no room
	private addStrip(items: CascadeItem[], vertical: boolean, from: {x: number, y: number, w: number, h: number, cx: number, cy: number}, owner?: CascadeItem) {
		const element = createElement('div', {className: 'cascade-strip'});
		element.style.flexDirection = vertical ? 'column' : 'row';
		element.style.gap = `${GAP}px`;
		const buttons = items.map((item, i) => {
			const b = createElement('div', {className: 'cascade-button'});
			if (item.id)
				b.dataset.id = item.id;
			b.style.setProperty('--i', String(i));
			this.paint(b, item, false);
			return b;
		});
		element.append(...buttons);
		this.root.append(element);

		const w = element.offsetWidth, h = element.offsetHeight;
		const W = this.stage.clientWidth, H = this.stage.clientHeight;
		let x: number, y: number;
		if (vertical) {
			x = from.x + (from.w - buttons[0].offsetWidth) / 2;
			y = from.y + from.h + GAP;
			if (y + h > H && from.y - GAP - h >= 0) {
				// upwards, the first icon still next to where it came from
				y = from.y - GAP - h;
				element.style.flexDirection = 'column-reverse';
			}
		} else {
			x = from.x + from.w + GAP;
			y = from.y;
			if (x + w > W && from.x - GAP - w >= 0) {
				x = from.x - GAP - w;
				element.style.flexDirection = 'row-reverse';
			}
		}
		x = Math.max(0, Math.min(x, W - w));
		y = Math.max(0, Math.min(y, H - h));
		element.style.left	= `${x}px`;
		element.style.top	= `${y}px`;

		// each icon comes out from the one it belongs to
		for (const b of buttons) {
			b.style.setProperty('--dx', `${from.cx - (x + b.offsetLeft + b.offsetWidth / 2)}px`);
			b.style.setProperty('--dy', `${from.cy - (y + b.offsetTop + b.offsetHeight / 2)}px`);
		}
		const strip: Strip = {element, items, buttons, vertical, x, y, open: -1, owner};
		if (owner?.gauge) {
			strip.gauge = createElement('div', {className: 'cascade-gauge', innerHTML: '<div></div>'});
			strip.gauge.style.setProperty('--n', String(buttons.length));
			element.append(strip.gauge);
			this.placeGauge(strip);
		}
		void element.offsetWidth;
		element.classList.add('shown');
		this.strips.push(strip);
	}

	// the bar along a strip of presets, filled from the start of the first to where the value falls
	private placeGauge(s: Strip) {
		if (!s.gauge || !s.owner?.gauge)
			return;
		const {centres, spacing} = this.centres(s);
		const at = (p: number) => {
			const i = Math.max(0, Math.min(centres.length - 2, Math.floor(p)));
			return centres.length > 1 ? centres[i] + (p - i) * (centres[i + 1] - centres[i]) : centres[0] + p * spacing;
		};
		const n = centres.length;
		const p = Math.max(-0.5, Math.min(n - 0.5, s.owner.gauge()));
		const start = at(-0.5), end = at(n - 0.5), value = at(p);
		const [lo, hi] = [Math.min(start, end), Math.max(start, end)];
		const g = s.gauge, fill = g.firstElementChild as HTMLElement;
		const [pos, len] = s.vertical ? ['top', 'height'] as const : ['left', 'width'] as const;
		g.classList.toggle('vertical', s.vertical);
		g.style[pos] = `${lo}px`;
		g.style[len] = `${hi - lo}px`;
		fill.style[pos] = `${Math.min(start, value) - lo}px`;
		fill.style[len] = `${Math.abs(value - start)}px`;
	}

	// take back the strips from a level on, sliding them back into where they came from
	private closeFrom(level: number, animate = true) {
		for (const s of this.strips.splice(level)) {
			if (animate) {
				s.element.classList.add('closing');
				s.element.classList.remove('shown');
				setTimeout(() => s.element.remove(), 150);
			} else {
				s.element.remove();
			}
		}
		const parent = this.strips[level - 1];
		if (parent && parent.open >= 0) {
			parent.buttons[parent.open].classList.remove('open');
			parent.open = -1;
		}
	}

	private hover(level: number, index: number) {
		const s = this.strips[level];
		if (s.open === index)
			return;
		this.closeFrom(level + 1);
		s.open = index;
		const button = s.buttons[index], item = s.items[index];
		this.light(item);
		button.classList.add('open');
		this.stepAccum = 0;

		const r = this.place(s, index);
		const children = item.children?.();
		if (children?.length)
			this.addStrip(children, !s.vertical, r, item);
		this.showCaption(item, s.vertical, r);
	}

	// the middles of a strip's icons along it, from the strip's start, and how far apart they are (negative in a turned back strip)
	private centres(s: Strip) {
		const centres = s.buttons.map(b => s.vertical ? b.offsetTop + b.offsetHeight / 2 : b.offsetLeft + b.offsetWidth / 2);
		const size = s.vertical ? s.buttons[0].offsetHeight : s.buttons[0].offsetWidth;
		return {centres, spacing: centres.length > 1 ? centres[1] - centres[0] : size};
	}

	// the value of a drag, from the pointer's place along the strip of presets, in icons as gauge has it
	private dragTo(e: PointerEvent) {
		const d = this.drag!;
		if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START)
			return;
		d.moved = true;
		const stage	= this.stage.getBoundingClientRect();
		const c		= d.strip.vertical ? e.clientY - stage.top - d.strip.y : e.clientX - stage.left - d.strip.x;
		const {centres, spacing} = this.centres(d.strip);
		const n		= centres.length;
		let p		= (c - centres[0]) / spacing;
		for (let i = 0; i < n - 1; i++) {
			const t = (c - centres[i]) / (centres[i + 1] - centres[i]);
			p = i + t;
			if (t <= 1)
				break;
		}
		d.owner.scrub!(Math.max(-0.5, Math.min(n - 0.5, p)));
		this.refresh();
		this.caption.textContent = d.owner.caption();
	}

	// the icon dragged to where the pointer is among those of its strip which can be dragged, the others making way
	private reorderTo(e: PointerEvent) {
		const r = this.reorder!, s = r.strip;
		if (!r.moved) {
			if (Math.hypot(e.clientX - r.x, e.clientY - r.y) < DRAG_START)
				return;
			r.moved = true;
			this.closeFrom(this.strips.indexOf(s) + 1, false);
			s.buttons[s.items.indexOf(r.item)].classList.add('dragging');
			r.item.drag!.begin();
		}
		const stage	= this.stage.getBoundingClientRect();
		const c		= s.vertical ? e.clientY - stage.top - s.y : e.clientX - stage.left - s.x;
		const {centres} = this.centres(s);
		let to = -1;
		s.items.forEach((item, i) => {
			if (item.drag && (to < 0 || Math.abs(centres[i] - c) < Math.abs(centres[to] - c)))
				to = i;
		});
		const from = s.items.indexOf(r.item);
		if (to < 0 || to === from)
			return;
		r.item.drag!.to(to);
		const [item] = s.items.splice(from, 1), [button] = s.buttons.splice(from, 1);
		s.items.splice(to, 0, item);
		s.buttons.splice(to, 0, button);
		s.element.append(...s.buttons);
		s.open = -1;
		this.refresh();
	}

	// a click on an icon, or on the nearest one it came out of that does something
	private choose(level: number, index: number) {
		let item = this.strips[level].items[index];
		if (item.click?.()) {
			this.close();
			return;
		}
		for (let l = level; !item.select && l-- > 0;)
			item = this.strips[l].items[this.strips[l].open];
		if (!item.select) {
			this.hover(level, index);
			return;
		}
		if (item.select())
			this.refresh();
		else
			this.close();
	}

	// beside the icon, on the side away from where its strip comes out, and moved on past any icons in the way
	private showCaption(item: CascadeItem, vertical: boolean, r: {x: number, y: number, w: number, h: number}) {
		const c = this.caption;
		c.textContent = item.caption();
		c.classList.add('shown');
		const W		= this.stage.clientWidth, H = this.stage.clientHeight;
		const cw	= c.offsetWidth, ch = c.offsetHeight;
		const icons	= this.strips.flatMap(s => s.buttons.map((_, i) => this.place(s, i)));
		const slide = (x: number, y: number, dx: number, dy: number) => {
			for (let q; (q = icons.find(q => x < q.x + q.w && x + cw > q.x && y < q.y + q.h && y + ch > q.y));) {
				if (dx)
					x = dx < 0 ? q.x - GAP - cw : q.x + q.w + GAP;
				else
					y = dy < 0 ? q.y - GAP - ch : q.y + q.h + GAP;
			}
			return {x, y};
		};
		const cx	= r.x + (r.w - cw) / 2, cy = r.y + (r.h - ch) / 2;
		const places = vertical
			? [slide(r.x - GAP - cw, cy, -1, 0), slide(r.x + r.w + GAP, cy, 1, 0)]
			: [slide(cx, r.y - GAP - ch, 0, -1), slide(cx, r.y + r.h + GAP, 0, 1)];
		const {x, y}	= places.find(p => p.x >= 0 && p.x + cw <= W && p.y >= 0 && p.y + ch <= H) ?? places[0];
		c.style.left	= `${Math.max(0, Math.min(x, W - cw))}px`;
		c.style.top		= `${Math.max(0, Math.min(y, H - ch))}px`;
	}

	// an icon's rectangle in the stage, where it ends up (not where its animation has it now)
	private place(s: Strip, index: number) {
		const b = s.buttons[index];
		const x = s.x + b.offsetLeft, y = s.y + b.offsetTop, w = b.offsetWidth, h = b.offsetHeight;
		return {x, y, w, h, cx: x + w / 2, cy: y + h / 2};
	}

	// the icon under the pointer, by where the icons end up: one sliding out must not be taken for under it
	private hit(e: MouseEvent) {
		if (!this.isOpen)
			return undefined;
		const stage = this.stage.getBoundingClientRect();
		const px = e.clientX - stage.left, py = e.clientY - stage.top;
		for (let level = this.strips.length; level--;) {
			const s = this.strips[level];
			for (let index = 0; index < s.buttons.length; index++) {
				const r = this.place(s, index);
				if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)
					return {level, index};
			}
		}
		return undefined;
	}
}
