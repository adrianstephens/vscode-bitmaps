// The bitmap editor's transforms, which are not its tools: a free transform or warp of the current layer (or of what is selected of
// it) or of the whole picture, dragged by its box (transformbox.ts) and applied with Enter; and the flips, turns and crop of the
// whole document. While a transform is under way it has the pointer, and Enter and Escape: the tools (paint.ts) give way to it.

import { float2 } from '@isopodlabs/maths/vector';
import { Pixels, RGBAPixels, imageRect } from './opengl.js';
import { Selection } from './bitmapSelection.js';
import { History, type HistoryEntry } from './history.js';
import { Input, Place, type Drag } from './navigate.js';
import { CascadeItem, svgFace, choiceItem } from './cascade.js';
import { TransformMode, HANDLE, BoxTransform, modeChoices, transformIcons, type Carry, carriedBounds, shiftCarry } from './transformbox.js';

export type { TransformMode };

// what a transform is of: the current layer (or the picture, within its canvas, if it has none), or the whole document
export type TransformTarget = 'layer' | 'image';

// A transform under way, as the viewer has it: what is being transformed, and the showing of it as it is carried
export interface TransformSession {
	box:		float2.extent;				// what is being transformed, in canvas coordinates
	target:		TransformTarget;			// the current layer, or the whole picture
	selection?:	Selection;					// the selection which what is transformed is the part of, if it is
	update(carry: Carry): void;				// it is carried by this, from canvas coordinates: the viewer shows it so (and draws the tools again)
	end(): void;							// it is no longer carried
}

export type DocumentChange =
	| {kind: 'flip', horizontal: boolean}
	| {kind: 'rotate', clockwise: boolean}
	| {kind: 'crop', rect: float2.extent}
	| {kind: 'warp', carry: Carry, target: TransformTarget, selection?: Selection};	// the current layer (cut to the canvas), or the document

// what the transforms need of the viewer they are part of
export interface TransformHost {
	canvas:			HTMLCanvasElement;
	target():									RGBAPixels | undefined;	// the current layer's pixels (which cover the canvas), or the picture if there is none: what a selection is of
	selection():								Selection | undefined;	// what is selected: what a transform carries, if anything is, and which goes with it
	setSelection(sel: Selection | undefined):	void;					// what is selected: what a transform carries, if anything is, and which goes with it
	toScreen(p: float2):						float2;				// a point of the image, in canvas pixels
	pixelSize():								number;				// how long a canvas pixel is, in the image's pixels
	toImage(x: number, y: number):				float2;				// image coordinates, not whole pixels
	redraw():									void;
	transformable?():							'none' | 'affine' | 'any';	// how what is current may be transformed: not by these (it has a transform of its own), only by scaling, rotating and skewing (as text is), or any way
	transformMenu?():							CascadeItem[];		// more for the transform's menu, where what is transformed has transforms of its own
	beginTransform(target: TransformTarget, selection?: Selection):	TransformSession | undefined;	// the current layer or the whole picture is to be transformed (the part of it the selection covers, if there is one)
	transform(change: DocumentChange):			HistoryEntry | undefined;	// flip, rotate or crop the whole document, layers and all, which may change its size: done, and how to undo and redo it
	carryPixels<P extends Pixels>(image: P, carry: Carry, area: float2.extent): P;	// pixels carried (from their own coordinates) onto an area, which is what is made of them
}

const icons = {
	transform:	'<path d="M4 3.5h8.5V12H4z"/><rect x="2.5" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="2" width="3" height="3" fill="currentColor"/><rect x="11" y="10.5" width="3" height="3" fill="currentColor"/><rect x="2.5" y="10.5" width="3" height="3" fill="currentColor"/>',
	image:		'<rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="2 1.5"/><path d="M5 11l6-6M8 5h3v3M5 8v3h3"/>',
	crop:		'<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>',
};

export class Transformer {
	private active	= false;
	private mode:	TransformMode = 'free';
	private xf:		{session: TransformSession, box: BoxTransform} | undefined;	// a transform under way
	private off:	(() => void) | undefined;	// (which has the pointer, over the tools, until this gives it back)
	private ctx:	CanvasRenderingContext2D;

	constructor(public host: TransformHost, private overlay: HTMLCanvasElement, private readonly history: History) {
		this.ctx = overlay.getContext('2d')!;
	}

	// whether there is anything to transform
	enabled(on: boolean) {
		this.active = on;
		this.overlay.classList.toggle('hidden', !on);
		if (!on)
			this.end(false);
	}

	resize() {
		this.overlay.width	= this.host.canvas.width;
		this.overlay.height	= this.host.canvas.height;
	}

	// a transform is under way (its box and handles may be anywhere, including off the picture)
	get transforming() {
		return !!this.xf;
	}

	private get transformable() {
		return this.host.transformable?.() ?? 'any';
	}

	//-------------------------------------------------------------------------
	// the menu
	//-------------------------------------------------------------------------

	menuItems(): CascadeItem[] {
		if (!this.active || this.transformable === 'none')
			return [];

		// choosing a mode starts the transform (of the target) unless it is already under way
		// (a text layer's own transform cannot distort or warp: those modes are not offered it, which needs it made into pixels); a warp
		// that has been bent is applied before another mode is begun
		const mode = (target: TransformTarget) => choiceItem('Mode', modeChoices(this.affine(target)), () => this.mode, v => {
			this.mode = v;
			if (this.xf?.session.target !== target || !this.xf.box.setMode(v))
				this.start(target);
		}, true);

		const op = (o: string, icon: string, caption: string): CascadeItem => ({
			id:			o,
			face:		() => svgFace(icon),
			caption:	() => caption,
			select:		() => this.run(o),
		});

		return [{
			id:			'transform',
			face:		() => svgFace(icons.transform),
			caption:	() => 'Transform',
			active:		() => !!this.xf,
			children:	() => [
				{
					id:			'transform-layer',
					face:		() => svgFace(icons.transform),
					caption:	() => 'Free Transform (Enter applies, Esc cancels)',
					active:		() => this.xf?.session.target === 'layer',
					select:		() => this.start('layer'),
					children:	() => mode('layer').children!(),
				},
				{
					id:			'transform-image',
					face:		() => svgFace(icons.image),
					caption:	() => 'Transform Image: all of it, onto a canvas that fits',
					active:		() => this.xf?.session.target === 'image',
					select:		() => this.start('image'),
					children:	() => mode('image').children!(),
				},
				op('flipHorizontal',		transformIcons.flipH, 'Flip Horizontal'),
				op('flipVertical',			transformIcons.flipV, 'Flip Vertical'),
				op('rotateClockwise',		transformIcons.rotateCW, 'Rotate 90° Clockwise'),
				op('rotateAnticlockwise',	transformIcons.rotateACW, 'Rotate 90° Anticlockwise'),
				op('crop', icons.crop, 'Crop to Selection'),
				...(this.host.transformMenu?.() ?? []),
			],
		}];
	}

	//-------------------------------------------------------------------------
	// whole-document operations
	//-------------------------------------------------------------------------

	// one of them (whether it is one of these: the others are not done); a transform under way is applied first
	run(op: string): boolean {
		if (!this.active || !this.host.target())
			return false;
		this.end(true);
		switch (op) {
			case 'flipHorizontal':		this.change({kind: 'flip', horizontal: true}, 'Flip Horizontal'); break;
			case 'flipVertical':		this.change({kind: 'flip', horizontal: false}, 'Flip Vertical'); break;
			case 'rotateClockwise':		this.change({kind: 'rotate', clockwise: true}, 'Rotate Clockwise'); break;
			case 'rotateAnticlockwise':	this.change({kind: 'rotate', clockwise: false}, 'Rotate Anticlockwise'); break;
			case 'crop': {
				const image = this.host.target(), s = this.host.selection();
				if (!image || !s)
					break;
				const min = float2(Math.max(0, s.min.x), Math.max(0, s.min.y)), max = float2(Math.min(image.width, s.max.x), Math.min(image.height, s.max.y));
				if (max.x > min.x && max.y > min.y)
					this.change({kind: 'crop', rect: new float2.extent(min, max)}, 'Crop');
				break;
			}
			default: return false;
		}
		return true;
	}

	// change the whole document, as an edit
	private change(change: DocumentChange, label: string) {
		const entry = this.host.transform(change);
		if (!entry)
			return;
		// the selection goes with what it selected, if it was that which was transformed: else it does not survive the change
		const before = change.kind === 'warp' ? change.selection : this.host.selection(), image = this.host.target();
		const after = change.kind === 'warp' && change.selection && image ? this.warpSelection(change.selection, change.carry, imageRect(image)) : undefined;
		const use = (run: () => void, selection: Selection | undefined) => () => {
			this.host.setSelection(selection);
			run();
		};
		this.host.setSelection(after);
		this.history.push({undo: use(entry.undo, before), redo: use(entry.redo, after)}, label);
	}

	// A selection, with what it selects carried (from the image's coordinates): where the coverage lands, within the image; nothing if none
	// of it does
	private warpSelection(s: Selection, carry: Carry, within: float2.extent) {
		const area = carriedBounds(carry, s.bounds())?.intersect(within);
		if (!area || area.empty())
			return undefined;
		const coverage = new Uint8ClampedArray(s.width * s.height).fill(255);
		if (s.mask)
			coverage.set(s.mask);
		const warped = this.host.carryPixels(Pixels(coverage, s.width, s.height, 1), shiftCarry(carry, s.min), area);
		return new Selection(area, Uint8Array.from(warped.data)).trimmed();
	}

	//-------------------------------------------------------------------------
	// free transform
	//-------------------------------------------------------------------------

	// whether a transform of the target must stay affine (a text layer's: its own transform cannot distort)
	private affine(target: TransformTarget) {
		return this.transformable === 'affine' && target === 'layer';
	}

	private start(target: TransformTarget) {
		this.end(true);
		const selection = this.host.selection();
		const session = this.host.beginTransform(target, selection && !selection.empty() ? selection : undefined);
		if (!session)
			return;
		const box = new BoxTransform(session.box, this.mode, this.affine(target));
		this.mode = box.mode;
		this.xf = {session, box};
		this.off = Input.on(this.host.canvas).add({holds: true, press: e => this.press(e), hover: e => this.hover(e), key: e => this.key(e)}, Place.transform);
		session.update(box.carry);
	}

	// apply it (as an edit) or not, and give the pointer back to the tools
	end(apply: boolean) {
		const xf = this.xf;
		if (!xf)
			return;
		this.xf = undefined;
		const {session, box} = xf;
		session.end();
		if (apply && box.moved)
			this.change({kind: 'warp', carry: box.carry, target: session.target, selection: session.selection}, box.mode === 'warp' ? 'Warp' : session.target === 'layer' || session.selection ? 'Free Transform' : 'Transform Image');
		else
			this.host.redraw();
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
		return xf && xf.box.cursor(this.partAt(this.host.toImage(e.clientX, e.clientY)), xf.session.target === 'layer' ? 'move' : 'default');
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
		if (part.kind === 'inside' && xf.session.target === 'image' && !xf.session.selection)
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
