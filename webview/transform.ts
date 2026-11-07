// The bitmap editor's transforms, which are not its tools: a free transform or warp of the current layer (or of what is selected of
// it) or of the whole picture, dragged by its box (transformbox.ts) and applied with Enter. While a transform is under way it has the
// pointer, and Enter and Escape: the tools (paint.ts) give way to it. (The flips, turns and crop of the whole document are the modes'.)

import { float2 } from '@isopodlabs/maths/vector';
import { Selection } from './bitmapSelection.js';
import { History, type HistoryEntry } from './history.js';
import { Input, Place, type Drag } from './navigate.js';
import { CascadeItem, svgFace, choiceItem, icons as cascadeIcons } from './cascade.js';
import { TransformMode, HANDLE, BoxTransform, modeChoices, type Carry } from './transformbox.js';
export type { TransformMode };

// A transform under way, as the viewer has it: what is being transformed, and the showing of it as it is carried
export interface TransformSession {
	box:		float2.extent;				// what is being transformed, in canvas coordinates
	label:		string;						// what the edit it comes to is called
	selection?:	Selection;					// the selection which what is transformed is the part of, if it is
	pinned?:	boolean;					// the box itself is not to be moved (the whole document is where it is, whatever is done to it)
	update(carry: Carry): void;				// it is carried by this, from canvas coordinates: the viewer shows it so (and draws the tools again)
	end(carry?: Carry): HistoryEntry | undefined;	// it is no longer carried; if it is to be left carried by `carry`, that is done (which may change the picture's size), and how to undo and redo it
}

// what the transforms need of the viewer they are part of
export interface TransformHost {
	toScreen(p: float2):						float2;				// a point of the image, in canvas pixels
	pixelSize():								number;				// how long a canvas pixel is, in the image's pixels
	toImage(x: number, y: number):				float2;				// image coordinates, not whole pixels
}

export class Transformer {
	private active	= false;
	private mode:	TransformMode = 'free';
	private xf:		{id: string, session: TransformSession, box: BoxTransform} | undefined;	// a transform under way
	private off:	(() => void) | undefined;	// (which has the pointer, over the tools, until this gives it back)
	private ctx:	CanvasRenderingContext2D;

	constructor(private host: TransformHost, private canvas: HTMLCanvasElement, private overlay: HTMLCanvasElement, private readonly history: History) {
		this.ctx = overlay.getContext('2d')!;
	}

	// whether there is anything to transform
	get isEnabled() {
		return this.active;
	}

	enabled(on: boolean) {
		this.active = on;
		this.overlay.classList.toggle('hidden', !on);
		if (!on)
			this.end(false);
	}

	resize() {
		this.overlay.width	= this.canvas.width;
		this.overlay.height	= this.canvas.height;
	}

	// a transform is under way (its box and handles may be anywhere, including off the picture)
	get transforming() {
		return !!this.xf;
	}

	//-------------------------------------------------------------------------
	// the menu
	//-------------------------------------------------------------------------

	// the Transform item, of what begins a transform (nothing, if there is nothing to transform)
	menu(children: CascadeItem[]): CascadeItem[] {
		return this.active && children.length ? [{
			id:			'transform',
			face:		() => svgFace(cascadeIcons.transform),
			caption:	() => 'Transform',
			active:		() => !!this.xf,
			children:	() => children,
		}] : [];
	}

	// An item which begins a transform (of what `begin` makes a session of), and has its mode chosen in its strip. Choosing a mode starts
	// the transform unless it is already under way (a text layer's own transform cannot distort or warp: those modes are not offered it,
	// which needs it made into pixels); a warp that has been bent is applied before another mode is begun
	item(id: string, icon: string, caption: string, begin: () => TransformSession | undefined, affine = false): CascadeItem {
		const mode = choiceItem({caption: 'Mode', get: () => this.mode, set: v => {
			this.mode = v;
			if (this.xf?.id !== id || !this.xf.box.setMode(v))
				this.start(id, begin, affine);
			return false;
		}}, modeChoices(affine));
		return {
			id,
			face:		() => svgFace(icon),
			caption:	() => caption,
			active:		() => this.xf?.id === id,
			select:		() => this.start(id, begin, affine),
			children:	mode.children,
		};
	}

	//-------------------------------------------------------------------------
	// free transform
	//-------------------------------------------------------------------------

	private start(id: string, begin: () => TransformSession | undefined, affine: boolean) {
		this.end(true);
		const session = begin();
		if (!session)
			return;
		const box = new BoxTransform(session.box, this.mode, affine);
		this.mode = box.mode;
		this.xf = {id, session, box};
		this.off = Input.on(this.canvas).add({holds: true, press: e => this.press(e), hover: e => this.hover(e), key: e => this.key(e)}, Place.transform);
		session.update(box.carry);
	}

	// apply it (as an edit) or not, and give the pointer back to the tools
	end(apply: boolean) {
		if (!this.xf)
			return;
		const {session, box} = this.xf;
		this.xf = undefined;
		const entry = session.end(apply && box.moved ? box.carry : undefined);
		if (entry)
			this.history.push(entry, box.mode === 'warp' ? 'Warp' : session.label);

		this.off?.();
		this.off = undefined;
		this.draw();
	}

	private partAt(p: float2) {
		return this.xf!.box.part(p, HANDLE * (window.devicePixelRatio || 1) * this.host.pixelSize());
	}

	// what the pointer would take hold of
	private hover(e: PointerEvent) {
		const xf = this.xf;
		return xf && xf.box.cursor(this.partAt(this.host.toImage(e.clientX, e.clientY)), xf.session.pinned ? 'default' : 'move');
	}

	// A press, which a transform under way takes: a drag of the box, from where it was when the drag began, by what is under the
	// pointer and the mode
	private press(event: PointerEvent): Drag | true | undefined {
		const xf = this.xf;
		if (!xf || event.button !== 0)
			return;
		const start = this.host.toImage(event.clientX, event.clientY);
		const part = this.partAt(start);
		if (event.detail === 2 && (part.kind === 'inside' || part.kind === 'surface')) {
			this.end(true);
			return true;
		}
		// the whole document is where it is, whatever is done to it
		if (part.kind === 'inside' && xf.session.pinned)
			return true;
		// (by whole pixels, so that a layer only moved is not resampled)
		const to = xf.box.drag(part, start, d => float2(Math.round(d.x), Math.round(d.y)));
		return {move: e => {
			if (to(this.host.toImage(e.clientX, e.clientY), e))
				xf.session.update(xf.box.carry);
		}};
	}

	// Enter applies it, and Escape does not
	private key(e: KeyboardEvent) {
		if (e.key !== 'Enter' && e.key !== 'Escape')
			return false;
		this.end(e.key === 'Enter');
		return true;
	}

	//-------------------------------------------------------------------------
	// overlay: the box
	//-------------------------------------------------------------------------

	draw() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
		const xf = this.xf;
		if (!this.active || !xf)
			return;

		const screen		= (p: float2) => this.host.toScreen(p);
		const pixelRatio	= window.devicePixelRatio || 1;
		const {edge: corners, lines, handles} = xf.box.outline();

		// the box, with lines through it in thirds (or the warp's grid), and its handles
		ctx.save();
		ctx.globalAlpha = 0.5;
		ctx.lineWidth = pixelRatio;
		ctx.strokeStyle = '#fff';
		ctx.beginPath();
		for (const [a, b] of lines) {
			const p = screen(a), q = screen(b);
			ctx.moveTo(p.x, p.y);
			ctx.lineTo(q.x, q.y);
		}
		ctx.stroke();
		ctx.restore();

		// the edge, white under black dashes
		const edge = () => {
			ctx.beginPath();
			corners.map(screen).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
			ctx.closePath();
		};
		ctx.lineWidth = pixelRatio;
		ctx.setLineDash([]);
		ctx.strokeStyle = '#fff';
		edge();
		ctx.stroke();
		ctx.setLineDash([4 * pixelRatio, 4 * pixelRatio]);
		ctx.strokeStyle = '#000';
		edge();
		ctx.stroke();

		const r = 3.5 * pixelRatio;
		ctx.setLineDash([]);
		for (const h of handles.map(screen)) {
			ctx.fillStyle = '#fff';
			ctx.strokeStyle = '#000';
			ctx.fillRect(h.x - r, h.y - r, 2 * r, 2 * r);
			ctx.strokeRect(h.x - r, h.y - r, 2 * r, 2 * r);
		}
	}
}
