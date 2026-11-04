// A menu of icons brought up at the pointer, which takes no room until it is wanted: the first strip runs down from the
// pointer, and the pointer resting on an icon brings out that icon's own strip beside it, across from a downward strip and
// down from an across one, so the strips step down and to the right. Moving to another icon of a strip takes back what came
// out of the one before. An icon may answer the wheel (to change a value it shows) as well as a click; one that does nothing
// when clicked passes the click back to the icon it came out of, so clicking a tool's option chooses the tool. A value with a
// strip of presets can also be dragged: the left button held on it or on a preset, the pointer's place along the strip is the
// value. An icon with `drag` can be picked up and moved to another place in its strip (opt-in, per icon): it stays under the
// pointer along the strip while the others slide aside to make room.
// The icons of the strip under the pointer grow as it passes along them, as the Mac's dock's do (by --cascade-magnify, from the
// bitmaps.cascadeMagnify setting). The first strip grows both ways about the pointer, so the icon under it stays under it; the
// others stay against the icon they came out of and stretch away from it, and follow that icon as it moves.
// It knows nothing of what its items do; an editor describes them as CascadeItems. Styles are in assets/cascade.css.

import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { type RGB, toHex, fromHex, sameColour } from './colour.js';

export interface CascadeDrag {
	begin():			void,
	to(place: number):	void,
	drop():				void
};
// a way of moving a layer as the menu's strip has it, which lists the last first
export function reversed(r: CascadeDrag, count: () => number): CascadeDrag {
	return {begin: r.begin, to: (place: number) => r.to(count() - 1 - place), drop: r.drop};
}

export interface CascadeItem {
	id?:				string;				// the icon's data-id, for finding it from outside
	face():				string;				// the inside of the icon, as HTML: see svgFace, valueFace, swatchFace
	caption():			string;				// shown beside the icon while the pointer is on it
	children?():		CascadeItem[];		// the strip that comes out of this icon
	active?():			boolean;			// marked, as the current tool or the chosen option is
	select?():			boolean | void;		// a click on it, or the right button let go on it: true keeps the menu open
	click?():			boolean | void;		// a click on this icon itself (not on one of its strip's that has no `select`): true if it took the click, which closes the menu
	wheel?(steps: number): number;			// the wheel turned over it, with up positive; returns how much of steps was used
	gauge?():			number;				// where a value falls along the strip that comes out of this icon, drawn as a bar through
											// it: in icons, 0 the middle of the first, 1.5 halfway from the second to the third
	scrub?(position: number): void;			// the pointer dragged to a place along that strip, in the same terms as gauge
	// Having this makes the icon draggable to another place in its strip, among the icons that have it: it is told at the
	// start, and where it is to be (a place in the strip) as it is dragged, and at the end. The strip's icons are
	// reordered as it goes.
	hover?(on: boolean): void;				// the pointer has come to rest on this icon, or gone from it to another
	track?:				number;				// a button this many pixels long along its strip, standing for the whole range of its owner's scrub (see sliderItem): a press on it sets the value there
	drag?:				CascadeDrag;
}

/** Items from different places made one list: of those with the same id, the later ones' strips come after the first's in its, and it
 *  stands where the last was (so each place can have its View item, and the page has one). Of two without strips the first is kept. */
export function mergeItems(items: CascadeItem[]): CascadeItem[] {
	const out: CascadeItem[] = [];
	for (const item of items) {
		const i = item.id === undefined ? -1 : out.findIndex(o => o.id === item.id);
		if (i < 0) {
			out.push(item);
			continue;
		}
		const [first] = out.splice(i, 1);
		const a = first.children, b = item.children;
		out.push(a && b ? {...first, children: () => mergeItems([...a.call(first), ...b.call(item)])} : first);
	}
	return out;
}

// faces

export const icons = {
	view:		'<path d="M1 8 C4 3 12 3 15 8 C12 13 4 13 1 8Z"/><circle cx="8" cy="8" r="2"/>',
	transform:	'<path d="M4 3.5h8.5V12H4z"/><rect x="2.5" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="10.5" width="3" height="3" fill="currentColor"/><rect x="2.5" y="10.5" width="3" height="3" fill="currentColor"/>',
	image:		'<rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="2 1.5"/><path d="M5 11l6-6M8 5h3v3M5 8v3h3"/>',
	grid:		'<path d="M2 2H14V14H2ZM6 2V14M10 2V14M2 6H14M2 10H14"/>',
	metrics:	'<path d="M1 4H15M1 8H15M1 12H15" stroke-dasharray="3 2"/>',
	fill:		'<path d="M3 13C3 4 8 2 13 3C14 8 12 13 3 13Z" fill="currentColor" fill-opacity="0.45"/>',
};

export const svgFace = (body: string) =>
	`<svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

export const valueFace = (label: string, value: string) =>
	`<span class="cascade-value"><small>${label}</small>${value}</span>`;

export const swatchFace = (colour: string, second?: string) => second
	? `<span class="cascade-swatch2"><span style="background:${second}"></span><span style="background:${colour}"></span></span>`
	: `<span class="cascade-swatch" style="background:${colour}"></span>`;

export function opItem(icon: string, caption: string, run: () => boolean|void, id?: string): CascadeItem {
	return {
		id,
		face:		() => svgFace(icon),
		caption:	() => caption,
		select:		run,
	};
}

// a number that the wheel changes, and that a strip of presets can set
export interface ValueOptionsBase {
	id?:			string;				// the icon's data-id, for finding it from outside
	label:			string;				// short, to fit on the icon
	caption:		string;
	min:			number;
	max:			number;
	set(v: number): void;
	step?(value: number, steps: number): number;	// the value after turning the wheel; by default up or down by one
	resolution?:	number;				// what a value dragged along the presets is rounded to; by default 1
	format?(value: number): string;
}

// a number that the wheel changes, and that a strip of presets can set
export interface ValueOptions extends ValueOptionsBase {
	get():			number;
	presets?:		number[];				// increasing
}

export function valueItem(o: ValueOptions): CascadeItem {
	const format = o.format ?? (v => String(Math.round(v)));
	const resolution = o.resolution;
	const quant: (v: number) => number = resolution === undefined ? v => Math.round(v) : resolution === 0 ? v => v : v => Math.round(v / resolution) * resolution;
	const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));

	return {
		id:			o.id,
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

export function valueItemPersist(o: ValueOptions) {
	let value = o.min;
	const set = o.set;
	return valueItem({...o, 
		get: () => value, set: v => set(value = v),
	})
}

export interface SliderOptions extends ValueOptionsBase {
	get():			number;
	length?:		number;					// of the slider, in pixels; by default 160
	markers?:		number[] | number;		// values to mark with a tick along the bar
}

// a value like valueItem's, but whose strip is one bar and not a row of presets: the pointer's place along it is the value, linearly
// from min to max (the same wheel, and a drag as well as a press)
export function sliderItem(o: SliderOptions): CascadeItem {
	const format 	= o.format ?? (v => String(Math.round(v)));
	const item = valueItem(o);
	const resolution = o.resolution;
	const quant: (v: number) => number = resolution === undefined ? v => Math.round(v) : resolution === 0 ? v => v : v => Math.round(v / resolution) * resolution;
	const clamp		= (v: number) => Math.min(o.max, Math.max(o.min, v));
	const markers	= Array.isArray(o.markers) ? o.markers : o.markers ? Array.from({length: o.markers }, (_, i) => i * (o.max - o.min) / (o.markers as number - 1) + o.min) : [];
	const marks		= markers.map(v => `<span class="cascade-mark" style="--at:${(v - o.min) / (o.max - o.min) * 100}%"><small>${format(v)}</small></span>`).join('');
	
	return {
		...item,
		caption:	() => `${o.caption} ${format(o.get())} (scroll or drag)`,
		// one button, so its position is -0.5 at its start and 0.5 at its end
		gauge:		() => (clamp(o.get()) - o.min) / (o.max - o.min) - 0.5,
		scrub:		p => o.set(clamp(quant(o.min + (p + 0.5) * (o.max - o.min)))),
		children:	() => [{
			id:			'slider',
			track:		o.length ?? 160,
			face:		() => marks,
			caption:	() => `${o.caption} ${format(o.get())}`,
		}],
	};
}
export function sliderItemPersist(o: ValueOptions) {
	let value = o.min;
	const set = o.set;
	return sliderItem({...o, 
		get: () => value, set: v => set(value = v),
	})
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

export const COLOURS = ['#000000', '#ffffff', '#808080', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'].map(fromHex);

/** A red, a green and a blue for a colour (#rrggbb) that `put` takes, with swatches to choose from before them, under a custom colour
 *  (none, and they come first). `final` is false for a step of a value being turned or dragged (which the steps of are one edit,
 *  see history.ts), and true for a swatch chosen. */
export function colourItems(idp: string, get: () => RGB, put: (colour: RGB, final: boolean) => void, known = () => true, swatches: RGB[] = COLOURS): CascadeItem[] {
	const channels: CascadeItem[] = (['r', 'g', 'b'] as const).map((channel, i) => ({
		...sliderItem({
			length:		128,
			markers:	[0, 64, 128, 192, 255],
			label:		channel.toUpperCase(),
			caption:	['Red', 'Green', 'Blue'][i],
			get:		() => Math.round(get()[channel]),
			set:		v => put({...get(), [channel]: Math.round(Math.min(255, Math.max(0, v)))}, false),
			min:		0,
			max:		255,
			step:		(v, steps) => v + 4 * steps,
		}),
		id:			`${idp}-${channel}`,
	}));
	if (!swatches.length)
		return channels;
	return [
		...swatches.map(c => ({id: `${idp}-${toHex(c).slice(1)}`, face: () => swatchFace(toHex(c)), caption: () => toHex(c), active: () => known() && sameColour(get(), c), select: () => { put(c, true); }})),
		{id: `${idp}-custom`, face: () => swatchFace(toHex(get())), caption: () => `Custom colour ${toHex(get())}`, children: () => channels},
	];
}

interface Strip {
	element:	HTMLElement;
	items:		CascadeItem[];
	buttons:	HTMLElement[];
	vertical:	boolean;
	reverse:	boolean;		// turned back, so it runs left or up from the icon it came out of
	length:		number;			// along it, as laid out
	x:			number;			// where it is in the stage, which the buttons' places are measured from
	y:			number;
	open:		number;			// the button whose strip is out, or -1
	owner?:		CascadeItem;	// the icon it came out of
	base:		{cx: number, cy: number};	// the middle of that icon, as it was when this strip was placed beside it
	gauge?:		HTMLElement;
	reach:		number;			// how far either side of the pointer its icons are magnified (0 if they are not)
	room:		number;			// how far it can stretch back past its start (the rest of the stretch pushes it on)
	mag?:		{scale: number, shift: number}[];	// each button's magnification, and how far that moves it along the strip
}

const GAP			= 3;	// between the icons of a strip, and between a strip and the icon it came out of
const WHEEL_STEP	= 50;	// pixels of a smooth wheel (a trackpad) to a step
const WHEEL_PAUSE	= 250;	// ms without the wheel after which the next movement is a new gesture
const RELEASE_DELAY	= 300;	// the right button let go this long after the menu opened chooses the icon under it
const DRAG_START	= 4;	// pixels the pointer moves with the button down before it is a drag and not a click
const MAGNIFY		= 1.6;	// the most an icon grows under the pointer, without --cascade-magnify

// the magnification around the pointer, as a fraction of the most, is a bump of (1 + cos(πt)) / 2 out to t = ±1 (the strip's reach):
// how much of the bump's area is before t
const bumpArea	= (t: number) => t <= -1 ? 0 : t >= 1 ? 1 : (t + 1) / 2 + Math.sin(Math.PI * t) / (2 * Math.PI);

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
	private reorder?:	{strip: Strip, item: CascadeItem, button: HTMLElement, x: number, y: number, grab: number, moved: boolean};	// an icon being dragged to another place in its strip
	private magnify		= MAGNIFY;
	private captioned?:	{level: number, index: number};	// the icon the caption is beside

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
			this.track(e);
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
				const strip = this.strips[hit.level], button = strip.buttons[hit.index];
				this.reorder = {strip, item, button, x: e.clientX, y: e.clientY, grab: this.along(strip, e) - this.start(strip, button), moved: false};
				button.setPointerCapture(e.pointerId);
				return;
			}
			const strip = item.scrub ? this.strips[hit.level + 1] : this.strips[hit.level];
			const owner = strip?.owner;
			if (owner?.scrub && (!item.scrub || owner === item)) {
				this.drag = {strip, owner, x: e.clientX, y: e.clientY, moved: false};
				this.strips[hit.level].buttons[hit.index].setPointerCapture(e.pointerId);
				if (item.track)
					this.dragTo(e, true);
			}
		});
		// a press away from the menu closes it; one on the picture it is over does only that (it does not paint, or select)
		window.addEventListener('pointerdown', e => {
			if (this.isOpen && !this.root.contains(e.target as Node) && e.button !== 2) {
				this.close();
				if (this.stage.contains(e.target as Node)) {
					e.stopPropagation();
					e.preventDefault();
				}
			}
		}, true);
		window.addEventListener('pointerup', e => {
			if (this.reorder && e.button === 0) {
				const r = this.reorder;
				this.reorder = undefined;
				this.dragged = r.moved;
				if (r.moved) {
					this.settle(r.button);
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

	// the first strip, running down from a point on the screen. Not while the page does not have the focus (a right click on VS Code's window
	// while another application has it): the pointer's moves would not come to the menu, which could only be closed
	open(x: number, y: number, items = this.items()) {
		if (!document.hasFocus())
			return;
		this.closeFrom(0, false);
		this.root.classList.remove('hidden');
		this.openedAt = performance.now();
		const stage = this.stage.getBoundingClientRect();
		x -= stage.left, y -= stage.top;
		const style = getComputedStyle(this.root);
		const size = parseFloat(style.getPropertyValue('--cascade-size')) || 32;
		this.magnify = Math.max(1, parseFloat(style.getPropertyValue('--cascade-magnify')) || MAGNIFY);
		this.addStrip(items, true, {x: x - size / 2, y, w: size, h: 0, cx: x, cy: y});
	}

	close() {
		if (!this.isOpen)
			return;
		this.drag = undefined;
		if (this.reorder?.moved)
			this.settle(this.reorder.button, false);
		this.reorder = undefined;
		this.light(undefined);
		this.closeFrom(0, false);
		this.captioned = undefined;
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
		element.classList.toggle('vertical', vertical);
		element.classList.toggle('tape', items.some(i => i.track));		// (before it is first laid out, or its icons would start from their scaled down selves)
		element.style.gap = `${GAP}px`;
		const buttons = items.map((item, i) => {
			const b = createElement('div', {className: 'cascade-button'});
			if (item.id)
				b.dataset.id = item.id;
			if (item.track) {
				b.classList.add('track');
				b.style[vertical ? 'height' : 'width'] = `${item.track}px`;
			}
			b.style.setProperty('--i', String(i));
			this.paint(b, item, false);
			return b;
		});
		element.append(...buttons);
		this.root.append(element);

		const w = element.offsetWidth, h = element.offsetHeight;
		const W = this.stage.clientWidth, H = this.stage.clientHeight;
		// room for its icons to be magnified: it stretches by up to grow away from where it came out, and bulges by up to bulge either side
		// (it goes the other way if that is short of room for its stretch and the other has more, but is only moved across for its bulge)
		const tape	= element.classList.contains('tape');
		const reach	= this.magnify > 1 && !tape ? 2 * ((vertical ? buttons[0].offsetHeight : buttons[0].offsetWidth) + GAP) : 0;
		const grow	= (this.magnify - 1) * reach, bulge = reach && (this.magnify - 1) * (vertical ? buttons[0].offsetWidth : buttons[0].offsetHeight) / 2;
		let x: number, y: number, reverse = false;
		if (vertical) {
			x = from.x + (from.w - buttons[0].offsetWidth) / 2;
			y = from.y + from.h + GAP;
			if (H - y - h < grow && from.y - GAP - h > H - y - h) {
				// upwards, the first icon still next to where it came from
				y = from.y - GAP - h;
				element.style.flexDirection = 'column-reverse';
				reverse = true;
			}
		} else {
			x = from.x + from.w + GAP;
			y = from.y;
			if (W - x - w < grow && from.x - GAP - w > W - x - w) {
				x = from.x - GAP - w;
				element.style.flexDirection = 'row-reverse';
				reverse = true;
			}
		}
		const [bx, by] = vertical ? [bulge, 0] : [0, bulge];
		x = Math.max(bx, Math.min(x, W - w - bx));
		y = Math.max(by, Math.min(y, H - h - by));
		element.style.left	= `${x}px`;
		element.style.top	= `${y}px`;

		// a slider's bar comes out of its owner like a tape measure's tape: slid along from behind the owner's edge, cut off there
		if (tape) {
			const near = `-${GAP}px`, far = '-100vmax';		// (the far sides open, for the shadow and the ticks' numbers)
			element.style.setProperty(vertical ? '--ty' : '--tx', `${(reverse ? 1 : -1) * ((vertical ? h : w) + GAP)}px`);
			element.style.clipPath = `inset(${(vertical
				? reverse ? [far, far, near, far] : [near, far, far, far]
				: reverse ? [far, near, far, far] : [far, far, far, near]
			).join(' ')})`;
		}

		// each icon comes out from the one it belongs to
		for (const b of buttons) {
			b.style.setProperty('--dx', `${from.cx - (x + b.offsetLeft + b.offsetWidth / 2)}px`);
			b.style.setProperty('--dy', `${from.cy - (y + b.offsetTop + b.offsetHeight / 2)}px`);
		}
		const strip: Strip = {element, items, buttons, vertical, reverse, length: vertical ? h : w, x, y, open: -1, owner, base: {cx: from.cx, cy: from.cy}, reach,
			room: owner ? 0 : vertical ? (reverse ? H - y - h : y) : (reverse ? W - x - w : x)};
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
		const n			= centres.length;
		const p			= Math.max(-0.5, Math.min(n - 0.5, s.owner.gauge()));
		const start		= at(-0.5), end = at(n - 0.5), value = at(p);
		const [lo, hi]	= [Math.min(start, end), Math.max(start, end)];
		const g			= s.gauge, fill = g.firstElementChild as HTMLElement;
		const [pos, len] = s.vertical ? ['top', 'height'] as const : ['left', 'width'] as const;
		g.classList.toggle('vertical', s.vertical);
		g.style[pos]	= `${lo}px`;
		g.style[len]	= `${hi - lo}px`;
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
		if (this.captioned && this.captioned.level >= level)
			this.captioned = undefined;
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

		// (beside the icon as big as it can get, so it does not grow into its strip)
		const children = item.children?.();
		if (children?.length)
			this.addStrip(children, !s.vertical, this.place(s, index, true), item);
		this.captioned = {level, index};
		this.showCaption();
	}

	// the middles of a strip's icons along it, from the strip's start, and how far apart they are (negative in a turned back strip)
	private centres(s: Strip) {
		const centres = s.buttons.map((b, i) => (s.vertical ? b.offsetTop + b.offsetHeight / 2 : b.offsetLeft + b.offsetWidth / 2) + (s.mag?.[i].shift ?? 0));
		const size = s.vertical ? s.buttons[0].offsetHeight : s.buttons[0].offsetWidth;
		return {centres, spacing: centres.length > 1 ? centres[1] - centres[0] : size};
	}

	// the value of a drag, from the pointer's place along the strip of presets, in icons as gauge has it
	private dragTo(e: PointerEvent, now = false) {
		const d = this.drag!;
		if (!now && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START)
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

	// where the pointer is along a strip, from its start
	private along(s: Strip, e: MouseEvent) {
		const stage = this.stage.getBoundingClientRect();
		return s.vertical ? e.clientY - stage.top - s.y : e.clientX - stage.left - s.x;
	}

	// where a button's layout puts it along its strip
	private start(s: Strip, b: HTMLElement) {
		return s.vertical ? b.offsetTop : b.offsetLeft;
	}

	// the icon dragged with the pointer along its strip, and the others making way for it by sliding to the places it leaves
	private reorderTo(e: PointerEvent) {
		const r = this.reorder!, s = r.strip, button = r.button;
		if (!r.moved) {
			if (Math.hypot(e.clientX - r.x, e.clientY - r.y) < DRAG_START)
				return;
			r.moved = true;
			this.closeFrom(this.strips.indexOf(s) + 1, false);
			// (all at their own size while it is, as the places they are dragged between are worked out from their layout)
			s.mag = undefined;
			this.magnified(this.strips.indexOf(s));
			button.classList.add('dragging');
			r.item.drag!.begin();
		}
		const size	= s.vertical ? button.offsetHeight : button.offsetWidth;
		const {centres} = this.centres(s);
		const slots	= s.items.flatMap((item, i) => item.drag ? [i] : []);
		const first	= Math.min(...slots.map(i => centres[i])) - size / 2, last = Math.max(...slots.map(i => centres[i])) - size / 2;
		const at	= Math.max(first, Math.min(last, this.along(s, e) - r.grab));	// where the dragged icon starts along the strip

		let to = -1;
		for (const i of slots) {
			if (to < 0 || Math.abs(centres[i] - (at + size / 2)) < Math.abs(centres[to] - (at + size / 2)))
				to = i;
		}
		const from = s.items.indexOf(r.item);
		if (to >= 0 && to !== from) {
			// the others slide from where they are seen to where they are now (an animation still running is taken from where it is)
			const others = s.buttons.filter(b => b !== button);
			const seen = others.map(b => b.getBoundingClientRect());
			r.item.drag!.to(to);
			const [item] = s.items.splice(from, 1), [b] = s.buttons.splice(from, 1);
			s.items.splice(to, 0, item);
			s.buttons.splice(to, 0, b);
			s.element.append(...s.buttons);
			s.open = -1;
			this.refresh();
			others.forEach((o, i) => {
				o.getAnimations().forEach(a => a.cancel());
				const now = o.getBoundingClientRect();
				const dx = seen[i].left - now.left, dy = seen[i].top - now.top;
				if (dx || dy)
					o.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], {duration: 140, easing: 'ease-out'});
			});
		}
		const d = at - this.start(s, button);
		button.style.transform = s.vertical ? `translate(0, ${d}px)` : `translate(${d}px, 0)`;
	}

	// the dragged icon let go: it slides from where the pointer left it into its place
	private settle(button: HTMLElement, animate = true) {
		const from = button.getBoundingClientRect();
		button.classList.remove('dragging');
		button.style.transform = '';
		if (!animate)
			return;
		const to = button.getBoundingClientRect();
		const dx = from.left - to.left, dy = from.top - to.top;
		if (!dx && !dy)
			return;
		button.style.transition = 'none';		// (or the css transition would play against this)
		const a = button.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], {duration: 140, easing: 'ease-out'});
		a.onfinish = a.oncancel = () => { button.style.transition = ''; };
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
		if (!item.select()) {
			this.close();
			return;
		}
		// (an icon whose click brings its strip into being, or takes it away, as an effect switched on or off, shows or loses it now)
		const own = this.strips[level], opened = this.strips.length > level + 1;
		if (own.items[index] === item && own.open === index && opened !== !!item.children?.().length) {
			own.open = -1;
			this.hover(level, index);
		}
		this.refresh();
	}

	// beside the icon, on the side away from where its strip comes out, and moved on past any icons in the way
	private showCaption() {
		if (!this.captioned)
			return;
		const {level, index} = this.captioned, s = this.strips[level], item = s.items[index], vertical = s.vertical, r = this.place(s, index);
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

	// an icon's rectangle in the stage, where it ends up (not where its animation has it now), magnified as it is, or as much as it can be
	private place(s: Strip, index: number, full = false) {
		const b = s.buttons[index], m = s.mag?.[index];
		const scale = full && s.reach ? this.magnify : m?.scale ?? 1, shift = m?.shift ?? 0;
		const cx = s.x + b.offsetLeft + b.offsetWidth / 2 + (s.vertical ? 0 : shift), cy = s.y + b.offsetTop + b.offsetHeight / 2 + (s.vertical ? shift : 0);
		const w = b.offsetWidth * scale, h = b.offsetHeight * scale;
		return {x: cx - w / 2, y: cy - h / 2, w, h, cx, cy};
	}

	//-------------------------------------------------------------------------
	// magnification: a strip's icons are stretched along it by a bump centred on the place in its layout that the stretching puts
	// under the pointer (so the icon drawn under the pointer is the one under it in the layout): about that place as far back as the
	// strip has room, and pushed on from its start beyond that

	// the buttons' extents along a strip, from the end it came out at, as laid out
	private extents(s: Strip) {
		return s.buttons.map(b => {
			const o = s.vertical ? b.offsetTop : b.offsetLeft, n = s.vertical ? b.offsetHeight : b.offsetWidth;
			return s.reverse ? [s.length - o - n, s.length - o] : [o, o + n];
		});
	}

	// each button's magnification and move along the strip, for the bump at a place in the layout
	private stretch(s: Strip, at: number) {
		const area	= (x: number) => (this.magnify - 1) * s.reach * bumpArea((x - at) / s.reach);
		const back	= Math.min(s.room, area(at) - area(0));
		const v		= (x: number) => x + area(x) - area(0) - back;
		return this.extents(s).map(([a, b]) => {
			const va = v(a), vb = v(b);
			return {scale: (vb - va) / (b - a), shift: (va + vb - a - b) / 2 * (s.reverse ? -1 : 1)};
		});
	}

	// the place in the layout that the stretching puts p along the strip: where v(at) = p, which only grows with at (and is p
	// itself while the strip has room behind it)
	private bumpFor(s: Strip, p: number) {
		const extra = (this.magnify - 1) * s.reach;
		let lo = Math.max(0, p - extra / 2), hi = Math.max(0, p);
		for (let i = 0; i < 24; i++) {
			const at = (lo + hi) / 2;
			if (at + Math.max(0, extra * (0.5 - bumpArea(-at / s.reach)) - s.room) < p)
				lo = at;
			else
				hi = at;
		}
		return (lo + hi) / 2;
	}

	// the strip under the pointer magnified about it (the deepest, for where they overlap)
	private track(e: MouseEvent) {
		if (!this.isOpen || this.magnify <= 1)
			return;
		const stage = this.stage.getBoundingClientRect();
		const px = e.clientX - stage.left, py = e.clientY - stage.top;
		for (let level = this.strips.length; level--;) {
			const s = this.strips[level];
			const along = s.vertical ? py - s.y : px - s.x, across = s.vertical ? px - s.x : py - s.y;
			const p = s.reverse ? s.length - along : along;
			if (!s.reach) {
				if (p >= 0 && p < s.length && across >= 0 && across < (s.vertical ? s.element.offsetWidth : s.element.offsetHeight))
					return;
				continue;
			}
			if (p < -GAP)
				continue;
			const at = this.bumpFor(s, p);
			const i = this.extents(s).findIndex(([a, b]) => at >= a - GAP && at < b);
			if (i < 0)
				continue;
			const mag = this.stretch(s, at), b = s.buttons[i];
			const [mid, size] = s.vertical ? [b.offsetLeft + b.offsetWidth / 2, b.offsetWidth] : [b.offsetTop + b.offsetHeight / 2, b.offsetHeight];
			if (Math.abs(across - mid) > mag[i].scale * size / 2)
				continue;
			s.mag = mag;
			this.magnified(level);
			return;
		}
	}

	// a strip's buttons drawn as magnified, with the strips that came out of it following the icon they came out of
	private magnified(level: number) {
		const s = this.strips[level];
		s.buttons.forEach((b, i) => {
			const {scale, shift} = s.mag?.[i] ?? {scale: 1, shift: 0};
			b.style.scale		= scale === 1 ? '' : `${scale}`;
			b.style.translate	= shift ? (s.vertical ? `0 ${shift}px` : `${shift}px 0`) : '';
		});
		this.placeGauge(s);
		const next = this.strips[level + 1];
		if (next && s.open >= 0) {
			const r = this.place(s, s.open), dx = r.cx - next.base.cx, dy = r.cy - next.base.cy;
			if (dx || dy) {
				for (const n of this.strips.slice(level + 1)) {
					n.x += dx;
					n.y += dy;
					n.base.cx += dx;
					n.base.cy += dy;
					n.element.style.left	= `${n.x}px`;
					n.element.style.top		= `${n.y}px`;
				}
			}
		}
		if (this.captioned && this.captioned.level >= level)
			this.showCaption();
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
