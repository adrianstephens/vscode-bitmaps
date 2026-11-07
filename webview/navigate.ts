// How the pointer moves a picture's view: the part the 2D view (pan.ts) and the 3D cameras (orbit.ts) have in common. A press
// of the left button or the right takes hold of the point of the picture under the cursor -- the anchor -- and a drag moves
// the view about it; the wheel zooms about it. What an anchor is, and what holding on to it means, is the view's own: a
// point of the image, or of space. A right button let go without having moved is a click, for a menu.
//
// What has the pointer and the keys over an element is a stack (Input): the view at the bottom, and over it whatever else takes presses
// there -- the tools, an editor, a transform under way. A press, the wheel, a right click, the cursor and a key go to the top of the stack
// first, and down it until one takes them.

const CLICK = 4;	// how far (in window pixels) the pointer may go between press and release for it to be a click

// what follows a press that has been taken, until the button is let go
export interface Drag {
	coalesced?:	boolean;							// it has every point the pointer passed through, not only where it is at each frame
	move?(e: PointerEvent): void;
	end?(e: PointerEvent, moved: boolean): void;	// let go, or the pointer lost (cancelled, or a menu took the release); whether it went further than a click
}

// something in the stack over an element
export interface InputLayer {
	holds?:		boolean;										// it has the picture while it is in the stack: those under it are told (covered)
	press?(e: PointerEvent): Drag | true | undefined;			// it takes the press, and follows it with a drag (or has done what it does with it); undefined: it is for those under it
	hover?(e: PointerEvent): string | undefined;				// the pointer is over it: the cursor it shows there; undefined: what those under it show (which have the pointer too)
	leave?():	void;											// the pointer has gone, or one over it shows its cursor now
	wheel?(e: WheelEvent): boolean;								// it takes the wheel
	menu?(e: MouseEvent): boolean;								// it takes the right click: the browser's menu is not shown, and those under it do not see it
	key?(e: KeyboardEvent): boolean;							// it takes a key (not one typed into a field, which is the field's)
	keyUp?(e: KeyboardEvent): boolean;
	covered?(by: number | undefined): void;						// the place of the nearest layer over it that holds the picture, or undefined if none does
}

// where layers are in the stack, from the bottom: the page's own (the menu), the view, the tools, an editor over the picture, a
// transform under way, the view again while it is held on to (Space), and the 3D view of a picture's layers
export const Place = {page: 0, view: 1, tools: 2, editor: 3, transform: 4, panning: 5, fan: 6} as const;

const mac = navigator.platform.toLowerCase().includes('mac');

// a key typed into a field (or its copy and paste), which is the field's
export function typing(target: EventTarget | null) {
	const t = target as HTMLElement | null;
	return !!t?.tagName && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
		|| (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes((t as HTMLInputElement).type)));
}

export class Input {
	private static readonly all = new WeakMap<HTMLElement | SVGElement, Input>();

	// the stack over an element (made the first time it is asked for)
	static on(element: HTMLElement | SVGElement) {
		let input = this.all.get(element);
		if (!input)
			this.all.set(element, input = new Input(element));
		return input;
	}

	private layers:		{layer: InputLayer, place: number, by?: number}[] = [];	// from the top
	private hovered		= new Set<InputLayer>();	// those the pointer is over, as the last move had it
	private drag:		Drag | undefined;			// a press being followed
	private last:		{e: PointerEvent, element: HTMLElement} | undefined;	// where the pointer last moved, for the cursor

	private constructor(element: HTMLElement | SVGElement) {
		this.include(element);
		window.addEventListener('keydown', e => {
			if (!e.defaultPrevented && !typing(e.target) && this.layers.some(({layer}) => layer.key?.(e)))
				e.preventDefault();
		});
		window.addEventListener('keyup', e => {
			if (this.layers.some(({layer}) => layer.keyUp?.(e)))
				e.preventDefault();
		});
	}

	// Another element whose pointer is this stack's: something over the first, as part of the picture (an editor's drawing)
	include(element: HTMLElement | SVGElement) {
		const el = element as HTMLElement;		// (as one or the other has, it has a style)
		Input.all.set(el, this);
		el.addEventListener('pointerdown', e => this.down(e, el));
		el.addEventListener('pointermove', e => {
			this.last = {e, element: el};
			if (!this.drag)
				this.hover(e, el);
		});
		el.addEventListener('pointerleave', () => {
			if (!this.drag)
				this.leave(new Set());
		});
		el.addEventListener('wheel', e => {
			if (this.layers.some(({layer}) => layer.wheel?.(e)))
				e.preventDefault();
		}, {passive: false});
		el.addEventListener('contextmenu', e => {
			if (this.layers.some(({layer}) => layer.menu?.(e)))
				e.preventDefault();
		});
	}

	// A layer, over those already at its place, until the function this gives back is called
	add(layer: InputLayer, place: number = Place.view): () => void {
		const i = this.layers.findIndex(l => l.place <= place);
		this.layers.splice(i < 0 ? this.layers.length : i, 0, {layer, place});
		this.changed();
		return () => {
			const i = this.layers.findIndex(l => l.layer === layer);
			if (i >= 0) {
				this.layers.splice(i, 1);
				if (this.hovered.delete(layer))
					layer.leave?.();
				this.changed();
			}
		};
	}

	// A press, offered to the layers at or under a place, from the top, until one takes it
	press(e: PointerEvent, place = Infinity): Drag | true | undefined {
		for (const l of this.layers) {
			const taken = l.place <= place ? l.layer.press?.(e) : undefined;
			if (taken)
				return taken;
		}
	}

	// the cursor shown again, as the layers have it now (one has changed what it shows)
	refresh() {
		if (this.last && !this.drag)
			this.hover(this.last.e, this.last.element);
	}

	private hover(e: PointerEvent, element: HTMLElement) {
		let cursor: string | undefined;
		const now = new Set<InputLayer>();
		for (const {layer} of this.layers) {
			now.add(layer);
			if ((cursor = layer.hover?.(e)) !== undefined)
				break;
		}
		this.leave(now);
		element.style.cursor = cursor ?? '';
	}

	// those the pointer was over and is not now are told
	private leave(now: Set<InputLayer>) {
		for (const layer of this.hovered) {
			if (!now.has(layer))
				layer.leave?.();
		}
		this.hovered = now;
	}

	// those which care are told what holds the picture over them, and the cursor is shown as it now is
	private changed() {
		let over: number | undefined;
		for (const l of this.layers) {
			if (l.by !== over) {
				l.by = over;
				l.layer.covered?.(over);
			}
			if (l.layer.holds)
				over = l.place;
		}
		this.refresh();
	}

	private down(down: PointerEvent, element: HTMLElement) {
		// (Ctrl with the left button, on a Mac, is the right button's click: it is for the menu, not for a drag)
		if (this.drag || (down.button === 0 && down.ctrlKey && mac))
			return;
		const drag = this.press(down);
		if (!drag || drag === true)
			return;

		element.setPointerCapture(down.pointerId);
		this.drag = drag;
		let moved = false;
		const move = (e: PointerEvent) => {
			if (e.pointerId !== down.pointerId)
				return;
			moved ||= Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) >= CLICK;
			const events = drag.coalesced ? e.getCoalescedEvents?.() ?? [] : [];
			for (const c of events.length ? events : [e])
				drag.move?.(c);
		};
		// the end of a drag is the pointer's release, or its capture being lost (a context menu opening takes the release)
		const end = (e: PointerEvent) => {
			if (e.pointerId !== down.pointerId || this.drag !== drag)
				return;
			this.drag = undefined;
			element.removeEventListener('pointermove', move);
			element.removeEventListener('pointerup', end);
			element.removeEventListener('pointercancel', end);
			element.removeEventListener('lostpointercapture', end);
			drag.end?.(e, moved);
			this.refresh();
		};
		element.addEventListener('pointermove', move);
		element.addEventListener('pointerup', end);
		element.addEventListener('pointercancel', end);
		element.addEventListener('lostpointercapture', end);
	}
}

export interface NavigateHooks {
	redraw():		void;								// the view has moved
	dragStart?():	void;
	contextMenu?(clientX: number, clientY: number): void;	// a right click (not a drag)
	click?(clientX: number, clientY: number): void;			// a left click (not a drag)
	zoomed?(clientX: number, clientY: number): void;
	active?():		boolean;							// whether this view is the one in use just now, as well as being enabled
	home?():		void;								// the view put where it starts
}

// (a layer of the pointer's stack, which whoever has the view puts there)
export abstract class Navigate<A, H extends NavigateHooks = NavigateHooks> implements InputLayer {
	dragging	= false;
	enabled		= true;						// a view which is not in use leaves the pointer and the wheel to the page

	constructor(protected canvas: HTMLCanvasElement, protected hooks: H) {}

	// whether it is in use
	get live() {
		return this.enabled && (this.hooks.active?.() ?? true);
	}

	// the point of the picture under a point of the window, which a drag or a zoom holds on to
	protected abstract anchorAt(clientX: number, clientY: number): A;
	// a press of this button on the anchor: how the view follows the pointer from then on; undefined if the button does
	// nothing to the view
	protected abstract grab(anchor: A, event: PointerEvent): ((event: PointerEvent) => void) | undefined;
	// the view zoomed about the anchor, by this factor (more than 1 is nearer)
	protected abstract zoom(anchor: A, factor: number, event: WheelEvent): void;

	// the view put where it starts, or to fit what it shows; or to the size things are (for a 2D view, 100%)
	fit() {
		this.hooks.home?.();
	}
	reset() {
		this.fit();
	}

	press(event: PointerEvent): Drag | undefined {
		if (!this.live || (event.button !== 0 && event.button !== 2))
			return;
		const move = this.grab(this.anchorAt(event.clientX, event.clientY), event);
		if (!move)
			return;
		this.dragging = true;
		this.hooks.dragStart?.();
		return {
			move,
			end: (_, moved) => {
				this.dragging = false;
				if (!moved)
					(event.button === 2 ? this.hooks.contextMenu : this.hooks.click)?.(event.clientX, event.clientY);
			},
		};
	}

	// (a right click is a turn of the camera, or a click for the menu: which, it knows when the button is let go)
	menu() {
		return this.live && !!this.hooks.contextMenu;
	}

	wheel(event: WheelEvent) {
		if (!this.live)
			return false;
		this.zoom(this.anchorAt(event.clientX, event.clientY), 1.01 ** -event.deltaY, event);
		this.hooks.redraw();
		this.hooks.zoomed?.(event.clientX, event.clientY);
		return true;
	}
}
