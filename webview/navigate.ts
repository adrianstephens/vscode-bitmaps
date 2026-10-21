// How the pointer moves a picture's view: the part the 2D view (pan.ts) and the 3D cameras (orbit.ts) have in common. A press
// of the left button or the right takes hold of the point of the picture under the cursor -- the anchor -- and a drag moves
// the view about it; the wheel zooms about it. What an anchor is, and what holding on to it means, is the view's own: a
// point of the image, or of space. A right button let go without having moved is a click, for a menu.

export interface NavigateHooks {
	redraw():		void;								// the view has moved
	dragStart?():	void;
	contextMenu?(clientX: number, clientY: number): void;	// a right click (not a drag)
	zoomed?(clientX: number, clientY: number): void;
	pointerDown?(event: PointerEvent): boolean;		// something else takes this press (a tool, say): it is not for the view
	active?():		boolean;							// whether this view is the one in use just now, as well as being enabled
	home?():		void;								// the view put where it starts
}

export abstract class Navigate<A, H extends NavigateHooks = NavigateHooks> {
	dragging	= false;
	enabled		= true;						// a view which is not in use leaves the pointer and the wheel to the page
	private readonly listeners = new AbortController();
	get signal() {							// (others' listeners go when it does)
		return this.listeners.signal;
	}

	constructor(protected canvas: HTMLCanvasElement, protected hooks: H) {
		const signal = this.listeners.signal;
		canvas.addEventListener('contextmenu', event => this.live && event.preventDefault(), {signal});
		canvas.addEventListener('pointerdown', event => this.pointerDown(event), {signal});
		canvas.addEventListener('wheel', event => this.wheel(event), {passive: false, signal});
	}

	// it is done with: it takes no more of the pointer
	dispose() {
		this.listeners.abort();
	}

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

	private pointerDown(event: PointerEvent) {
		if (!this.live || (event.button !== 0 && event.button !== 2) || this.hooks.pointerDown?.(event))
			return;
		const move = this.grab(this.anchorAt(event.clientX, event.clientY), event);
		if (!move)
			return;
		const canvas	= this.canvas;
		this.dragging	= true;
		this.hooks.dragStart?.();
		canvas.setPointerCapture(event.pointerId);
		let end = {x: event.clientX, y: event.clientY};
		const onMove = (e: PointerEvent) => {
			end = {x: e.clientX, y: e.clientY};
			move(e);
		};
		const onUp = () => {
			this.dragging = false;
			canvas.removeEventListener('pointermove', onMove);
			canvas.removeEventListener('pointerup', onUp);
			canvas.removeEventListener('pointercancel', onUp);

			if (this.hooks.contextMenu && event.button === 2 && Math.hypot(event.clientX - end.x, event.clientY - end.y) < 4)
				this.hooks.contextMenu(event.clientX, event.clientY);
		};
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('pointercancel', onUp);
	}

	private wheel(event: WheelEvent) {
		if (!this.live)
			return;
		event.preventDefault();
		this.zoom(this.anchorAt(event.clientX, event.clientY), 1.01 ** -event.deltaY, event);
		this.hooks.redraw();
		this.hooks.zoomed?.(event.clientX, event.clientY);
	}
}
