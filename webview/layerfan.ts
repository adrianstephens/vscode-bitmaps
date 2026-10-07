// A picture's layers fanned out in 3D when the pointer is at the right edge of the window or of the picture: the stack
// turns and its layers draw apart, so that a corner of each shows, with a label (its name, whether it is shown, and for
// the chosen layer its opacity). Pointing at a layer, or its label, and clicking chooses it.

import { Canvas3D, ShaderProgram } from './opengl.js';
import { Layer, LayerStack } from './layers.js';
import { LayerOps } from './layerops.js';

export interface LayerFanHost {
	canvas3d:	Canvas3D;
	canvas:		HTMLCanvasElement;
	stage:		HTMLElement;		// what the labels go in, which the canvas fills
	stack():	LayerStack | null;
	view():		{scale: number, offset: {x: number, y: number}};
	programs():	{background: ShaderProgram, layer: ShaderProgram} | undefined;
	layerTexture(layer: Layer): WebGLTexture | undefined;	// a layer's pixels, as the picture is made from
	maskTexture(layer: Layer): WebGLTexture | undefined;	// and its mask's, or something to bind if it has none
	render():	void;
	opened(open: boolean): void;	// the fan has come up, or gone away: the rest of what is drawn on the picture makes way
}

const OPEN_MS		= 260;
const LEAVE_MS		= 200;
const LABEL_HEIGHT	= 20;	// in css pixels, what a label takes of the height
const EDGE			= 28;	// how close to the right edge of the window the pointer must be (in css pixels)
const PITCH			= 0.42;	// how far the stack turns, in radians
const YAW			= -0.48;
const FLOOR			= 0.2;	// the least that shows of a layer's opacity, and of what its mask and clipping take away

type Matrix = number[];		// 4x4, column by column

const identity = (): Matrix => [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
function multiply(a: Matrix, b: Matrix): Matrix {
	const r = new Array(16).fill(0);
	for (let c = 0; c < 4; c++)
		for (let k = 0; k < 4; k++)
			for (let row = 0; row < 4; row++)
				r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
	return r;
}
const translation = (x: number, y: number, z: number): Matrix => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; };
const scaling = (s: number): Matrix => { const m = identity(); m[0] = m[5] = m[10] = s; return m; };
function rotationX(a: number): Matrix { const m = identity(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function rotationY(a: number): Matrix { const m = identity(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }

type Point = {x: number, y: number};

// is the point inside the convex quadrilateral
function inside(quad: Point[], p: Point) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i], b = quad[(i + 1) % 4];
		const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (cross !== 0) {
			if (sign && (cross > 0) !== (sign > 0))
				return false;
			sign = cross;
		}
	}
	return true;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
	const e = document.createElement(tag);
	if (cls)
		e.className = cls;
	if (text !== undefined)
		e.textContent = text;
	return e;
}

interface Label {
	name:		string;
	element:	HTMLElement;
	visible:	HTMLInputElement;
	opacity?:	HTMLInputElement;
}

export class LayerFan {
	t = 0;								// how far open: 0 closed, 1 open
	private target = 0;
	private frame = 0;
	private last = 0;
	private leaving: ReturnType<typeof setTimeout> | undefined;
	private suppressed = false;			// not to open again until the pointer has been away from the edge

	private labels = new Map<Layer, Label>();
	private labelCurrent: Layer | undefined;
	private dragged: Layer | undefined;	// the layer whose label is being dragged, and where that label is (css pixels from the top)
	private dragY = 0;
	private justDragged = false;
	private slots = new Map<Layer, number>();	// where each label belongs, which is where it was put unless it is being dragged
	private labelBox = make('div', 'layer-labels hidden');
	private quads: Point[][] = [];		// where each layer's pixels were drawn, in canvas pixels
	private frames: Point[][] = [];	// and the whole canvas at each layer's depth, which the layers are on like sheets in a stack
	private empty: WebGLTexture | undefined;
	private anchors: Point[] = [];		// where the top right corner of the canvas is at each layer, which its label is by
	private hover: Layer | undefined;
	private cursor = '';

	constructor(private host: LayerFanHost, private ops: LayerOps) {
		host.stage.append(this.labelBox);

		host.stage.addEventListener('pointermove', e => this.pointerMove(e));
		host.stage.addEventListener('pointerleave', e => {
			if (this.target && !(e.relatedTarget as Element | null)?.closest?.('.layer-labels'))
				this.close();
		});
		window.addEventListener('keydown', e => {
			if (e.key === 'Escape' && this.t > 0)
				this.close(true);
		});
	}

	get active() {
		return this.t > 0;
	}

	//-------------------------------------------------------------------------
	// coming and going
	//-------------------------------------------------------------------------

	private inTrigger(p: Point) {
		const stack = this.host.stack();
		if (!stack)
			return false;
		const dpr = window.devicePixelRatio || 1;
		if (p.x >= this.host.canvas.width - EDGE * dpr)
			return true;

		// or the right edge of the picture, which is inside the window when it is zoomed out
		const {scale, offset} = this.host.view();
		return Math.abs(p.x - (offset.x + stack.width * scale)) <= 10 * dpr
			&& p.y >= offset.y && p.y <= offset.y + stack.height * scale;
	}

	// over one of the layers, or one of the labels
	private overFan(p: Point, target: EventTarget | null) {
		return !!(target as Element | null)?.closest?.('.layer-labels') || this.layerAt(p) >= 0;
	}

	// The layer under the point: by what it has drawn there if it has (the top layer first), else by its sheet
	private layerAt(p: Point) {
		for (const quads of [this.quads, this.frames])
			for (let i = quads.length - 1; i >= 0; i--)
				if (quads[i].length && inside(quads[i], p))
					return i;
		return -1;
	}

	private pointerMove(e: PointerEvent) {
		if (!this.host.stack() || e.buttons)
			return;
		const p = this.host.canvas3d.toCanvas(e.clientX, e.clientY);
		const trigger = this.inTrigger(p);
		if (!trigger)
			this.suppressed = false;

		if (!this.target) {
			if (trigger && !this.suppressed)
				this.open();
			return;
		}

		const stack = this.host.stack()!;
		const hover = (e.target as Element).closest?.('.layer-labels') ? this.hover : stack.layers[this.layerAt(p)];
		if (hover !== this.hover) {
			this.hover = hover;
			this.host.canvas.style.cursor = hover ? 'pointer' : '';
			this.host.render();
		}
		// Not at once: on the way from the edge to a label the pointer crosses what is neither. Away for a moment is gone.
		if (trigger || this.overFan(p, e.target)) {
			clearTimeout(this.leaving);
			this.leaving = undefined;
		} else if (this.leaving === undefined) {
			this.leaving = setTimeout(() => {
				this.leaving = undefined;
				this.close();
			}, LEAVE_MS);
		}
	}

	private open() {
		if (!this.host.stack() || !this.host.programs())
			return;
		this.cursor = this.host.canvas.style.cursor;
		this.target = 1;
		this.host.opened(true);
		this.animate();
	}

	// suppress: and not open again until the pointer has been away from the edge
	close(suppress = false) {
		if (suppress)
			this.suppressed = true;
		if (!this.target && !this.t)
			return;
		this.target = 0;
		this.animate();
	}

	// the fan is gone, at once
	reset() {
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.target = 0;
		this.t = 0;
		this.release();
	}

	private animate() {
		if (this.frame)
			return;
		this.last = performance.now();
		const step = (now: number) => {
			const dt = now - this.last;
			this.last = now;
			this.t = this.target ? Math.min(1, this.t + dt / OPEN_MS) : Math.max(0, this.t - dt / OPEN_MS);
			this.frame = 0;
			if (this.t === 0 && !this.target)
				this.release();
			this.host.render();
			if (this.t !== this.target)
				this.frame = requestAnimationFrame(step);
		};
		this.frame = requestAnimationFrame(step);
	}

	private release() {
		clearTimeout(this.leaving);
		this.leaving = undefined;
		const gl = this.host.canvas3d.gl;
		if (this.empty)
			gl.deleteTexture(this.empty);
		this.empty = undefined;
		this.labelBox.replaceChildren();
		this.labelBox.classList.add('hidden');
		this.labels.clear();
		this.labelCurrent = undefined;
		this.quads = [];
		this.hover = undefined;
		this.host.canvas.style.cursor = this.cursor;
		this.host.opened(false);
	}

	// a click on a layer or its label chooses it
	pointerDown(event: PointerEvent) {
		if (!this.t)
			return false;
		if (event.button === 0) {
			const i = this.layerAt(this.host.canvas3d.toCanvas(event.clientX, event.clientY));
			if (i >= 0)
				this.choose(i);
		}
		return true;
	}

	private choose(index: number) {
		this.ops.choose(index);
		this.close(true);
	}

	//-------------------------------------------------------------------------
	// drawing
	//-------------------------------------------------------------------------

	// the labels, brought up to date with the layers
	private sync(stack: LayerStack) {
		// the labels are made again when a layer comes or goes, is renamed, or another is chosen, but not when they are
		// reordered, which they are kept through (one of them may be being dragged)
		if (this.labelCurrent !== stack.layer || this.labels.size !== stack.layers.length
			|| stack.layers.some(l => this.labels.get(l)?.name !== l.name))
			this.buildLabels(stack);
		for (const layer of stack.layers) {
			const label = this.labels.get(layer)!;
			label.visible.checked = layer.visible;
			if (label.opacity && document.activeElement !== label.opacity)
				label.opacity.value = String(Math.round(layer.opacity * 100));
		}
	}

	private buildLabels(stack: LayerStack) {
		this.labelBox.replaceChildren();
		this.labelBox.classList.remove('hidden');
		this.labels.clear();
		this.labelCurrent = stack.layer;
		const indexOf = (layer: Layer) => this.host.stack()?.layers.indexOf(layer) ?? -1;

		for (const layer of stack.layers) {
			const element = make('div', 'layer-label' + (layer === stack.layer ? ' current' : ''));
			const visible = make('input');
			visible.type	= 'checkbox';
			visible.title	= 'Show or hide';
			visible.addEventListener('click', e => e.stopPropagation());
			visible.addEventListener('change', () => this.ops.setVisible(indexOf(layer), visible.checked));
			const name = make('span', 'layer-name', layer.name);
			element.append(visible, name);

			let opacity: HTMLInputElement | undefined;
			if (layer === stack.layer) {
				opacity = make('input');
				opacity.type	= 'range';
				opacity.min		= '0';
				opacity.max		= '100';
				opacity.title	= 'Opacity';
				opacity.addEventListener('click', e => e.stopPropagation());
				opacity.addEventListener('pointerdown', () => this.ops.beginOpacity());
				opacity.addEventListener('input', () => this.ops.setOpacity(Number(opacity!.value) / 100));
				opacity.addEventListener('change', () => this.ops.endOpacity());
				element.append(opacity);
			}

			// the pointer is on the label, not the picture: nothing there to draw or pan with
			element.addEventListener('pointerdown', e => {
				e.stopPropagation();
				if (e.button === 0 && !(e.target as Element).closest('input'))
					this.dragLabel(layer, element, e);
			});
			element.addEventListener('pointerenter', () => {
				this.hover = layer;
				this.host.render();
			});
			element.addEventListener('click', () => {
				if (this.justDragged)
					this.justDragged = false;	// the end of a drag, not a click
				else
					this.choose(indexOf(layer));
			});
			this.labelBox.append(element);
			this.labels.set(layer, {name: layer.name, element, visible, opacity});
		}
	}

	// A label dragged up or down moves its layer in the stack, as far as the other labels are: the layer is where the
	// label is among them, as the pointer moves
	private dragLabel(layer: Layer, element: HTMLElement, down: PointerEvent) {
		element.setPointerCapture(down.pointerId);
		const stage = this.host.stage.getBoundingClientRect();
		const grab = down.clientY - element.getBoundingClientRect().y;	// where in the label it was taken hold of
		let dragging = false;

		const move = (e: PointerEvent) => {
			if (!dragging) {
				if (Math.abs(e.clientY - down.clientY) < 4)
					return;
				dragging = true;
				this.dragged = layer;
				element.classList.add('dragging');
				this.ops.beginDrag(layer);
			}
			this.dragY = e.clientY - stage.y - grab;
			// above as many of the other labels as it is, it is above as many of the other layers
			const centre = this.dragY + LABEL_HEIGHT / 2;
			let below = 0;
			for (const [other, y] of this.slots)
				if (other !== layer && y + LABEL_HEIGHT / 2 > centre)
					below++;
			this.ops.dragTo(below);
			this.host.render();
		};
		const up = () => {
			element.removeEventListener('pointermove', move);
			element.removeEventListener('pointerup', up);
			element.removeEventListener('pointercancel', up);
			if (dragging) {
				this.justDragged = true;
				setTimeout(() => this.justDragged = false, 0);	// a click after a drag is not one
				this.dragged = undefined;
				element.classList.remove('dragging');
				this.ops.endDrag();
			}
			this.host.render();
		};
		element.addEventListener('pointermove', move);
		element.addEventListener('pointerup', up);
		element.addEventListener('pointercancel', up);
	}

	draw() {
		const stack = this.host.stack(), programs = this.host.programs();
		if (!stack || !programs) {
			this.reset();
			return;
		}
		this.sync(stack);

		const {canvas3d, canvas} = this.host, gl = canvas3d.gl;
		const {scale, offset} = this.host.view();
		const width = canvas.width, height = canvas.height;
		const dpr = window.devicePixelRatio || 1;
		const n = stack.layers.length;

		const s = this.t * this.t * (3 - 2 * this.t);
		const f = height * 1.1;											// the distance of the eye from the picture plane
		const centre = {x: offset.x + stack.width * scale / 2, y: offset.y + stack.height * scale / 2};
		const gap = n > 1 ? Math.min(0.09 * height, 0.7 * height / (n - 1)) * s : 0;
		const shrink = 1 - 0.3 * s;

		// screen pixels, with the eye at (width / 2, height / 2, f), to clip space
		const a = f / (width / 2), b = -f / (height / 2);
		const projection = identity();
		projection[0] = a;			projection[12] = -a * width / 2;
		projection[5] = b;			projection[13] = -b * height / 2;
		projection[10] = 0;			projection[11] = -1;	projection[15] = f;

		canvas3d.initViewport();
		programs.background.draw({u_viewport: [width, height]});
		const wasDepth = gl.isEnabled(gl.DEPTH_TEST);
		gl.disable(gl.DEPTH_TEST);

		this.quads = [];
		this.frames = [];
		this.anchors = [];
		this.empty ??= canvas3d.createTextureFromImage({data: new Uint8Array(4), width: 1, height: 1});
		// Where each layer goes: the whole stack turned about the middle of the picture, each layer a step nearer than the one
		// below. Turned, the layers' right edges slide along each other; they are shifted across the window (not in the
		// picture's own space, which would change their size) to put the top right corners, which have the labels, in a line.
		const sheet = {x: offset.x, y: offset.y, w: stack.width * scale, h: stack.height * scale};
		const place = (mvp: Matrix, x: number, y: number) => {
			const cx = mvp[0] * x + mvp[4] * y + mvp[12], cy = mvp[1] * x + mvp[5] * y + mvp[13], cw = mvp[3] * x + mvp[7] * y + mvp[15];
			return {x: (cx / cw + 1) / 2 * width, y: (1 - cy / cw) / 2 * height};
		};
		const mvps = stack.layers.map((_, i) => multiply(projection,
			multiply(translation(centre.x - 0.12 * width * s, centre.y, 0),
			multiply(rotationX(PITCH * s),
			multiply(rotationY(YAW * s),
			multiply(translation(0, 0, (i - (n - 1) / 2) * gap),
			multiply(scaling(shrink), translation(-centre.x, -centre.y, 0))))))));
		const corners = mvps.map(mvp => place(mvp, sheet.x + sheet.w, sheet.y).x);
		const line = corners.reduce((sum, x) => sum + x, 0) / Math.max(1, n);
		mvps.forEach((mvp, i) => {
			// a shift of the picture on the screen is a shift in clip space of that much (in units of the window) times w
			const shift = 2 * (line - corners[i]) / width;
			for (let c = 0; c < 4; c++)
				mvp[c * 4] += shift * mvp[c * 4 + 3];
		});

		stack.layers.forEach((layer, i) => {
			const mvp = mvps[i];
			const rect = {x: offset.x + layer.left * scale, y: offset.y + layer.top * scale, w: layer.image.width * scale, h: layer.image.height * scale};
			const project = (x: number, y: number) => place(mvp, x, y);
			this.frames.push([project(sheet.x, sheet.y), project(sheet.x + sheet.w, sheet.y), project(sheet.x + sheet.w, sheet.y + sheet.h), project(sheet.x, sheet.y + sheet.h)]);
			this.anchors.push(this.frames[i][1]);
			this.quads.push(layer.image.width && layer.image.height
				? [project(rect.x, rect.y), project(rect.x + rect.w, rect.y), project(rect.x + rect.w, rect.y + rect.h), project(rect.x, rect.y + rect.h)]
				: []);

			const current = i === stack.current, hovered = layer === this.hover;
			const edge = (width: number) => width * dpr / (scale * shrink);

			// What of the layer the picture shows, which is drawn, but not down to nothing. A layer clipped to another has
			// that one's pixels to be clipped by (the first below it which is not clipped itself); if that one is hidden so is it.
			let base: Layer | undefined;
			if (layer.clipped)
				for (let j = i - 1; j >= 0 && !base; j--)
					if (!stack.layers[j].clipped)
						base = stack.layers[j];
			const shown = layer.visible && (!base || base.visible) ? layer.opacity : 0;
			const mask = layer.mask && !layer.mask.disabled && layer.mask.image.width && layer.mask.image.height ? layer.mask : undefined;
			const clip = base && base.image.width && base.image.height ? base : undefined;
			const flat = {u_mvp: new Float32Array(mvp), u_floor: FLOOR};

			// (the textures are made before any is bound: making one binds it, on the unit which is active)
			const texture = this.host.layerTexture(layer);
			const maskTexture = this.host.maskTexture(layer), baseTexture = clip ? this.host.layerTexture(clip) : undefined;
			if (texture && maskTexture) {
				canvas3d.bindTexture(gl.TEXTURE_2D, texture, 0);
				canvas3d.bindTexture(gl.TEXTURE_2D, maskTexture, 1);
				canvas3d.bindTexture(gl.TEXTURE_2D, baseTexture ?? this.empty!, 2);
				programs.layer.draw({
					...flat,
					u_texture:		0,
					u_mask:			1,
					u_base:			2,
					u_origin:		[layer.left, layer.top],
					u_maskRect:		mask ? [mask.left, mask.top, mask.image.width, mask.image.height] : [0, 0, 0, 0],
					u_maskParams:	[(mask?.defaultColor ?? 255) / 255, mask?.inverted ? 1 : 0, mask ? 1 : 0],
					u_baseRect:		clip ? [clip.left, clip.top, clip.image.width, clip.image.height] : [0, 0, 0, 0],
					u_opacity:		shown,
					u_rect:			[rect.x, rect.y, rect.w, rect.h],
					u_size:			[layer.image.width, layer.image.height],
					u_edge:			0,
					u_veil:			0,
					u_outline:		[0, 0, 0, 0],
				});
			}

			// the sheet it is on, outlined: the corners which show tell the layers apart
			const outline = current ? [0.1, 0.45, 0.9, 1] : hovered ? [0.95, 0.95, 0.95, 0.95] : [0.75, 0.75, 0.75, 0.6];
			canvas3d.bindTexture(gl.TEXTURE_2D, this.empty!, 0);
			programs.layer.draw({
				...flat,
				u_texture:		0,
				u_mask:			1,
				u_base:			2,
				u_origin:		[0, 0],
				u_maskRect:		[0, 0, 0, 0],
				u_maskParams:	[0, 0, 0],
				u_baseRect:		[0, 0, 0, 0],
				u_opacity:		1,
				u_rect:			[sheet.x, sheet.y, sheet.w, sheet.h],
				u_size:			[stack.width, stack.height],
				u_edge:			edge(current || hovered ? 2.5 : 1.5),
				u_veil:			0.05,
				u_outline:		[outline[0] * outline[3], outline[1] * outline[3], outline[2] * outline[3], outline[3]],
			});
		});
		if (wasDepth)
			gl.enable(gl.DEPTH_TEST);

		this.placeLabels(stack, dpr);
	}

	// A label by each layer's anchor, but not on top of the others: they are kept in their order, a label's height apart.
	// A label which is being dragged is where it is dragged to; its place is kept among the others, which stay where they
	// are (a gap goes with it, to where it will land).
	private placeLabels(stack: LayerStack, dpr: number) {
		const height = this.host.canvas.height / dpr, width = this.host.canvas.width / dpr;
		const order = this.anchors.map((_, i) => i).sort((a, b) => this.anchors[a].y - this.anchors[b].y);
		const ys = order.map(i => this.anchors[i].y / dpr - LABEL_HEIGHT / 2);
		for (let k = 1; k < ys.length; k++)
			ys[k] = Math.max(ys[k], ys[k - 1] + LABEL_HEIGHT);
		// the last must be in the window, and then the first too, unless there are too many
		const over = ys.length ? ys[ys.length - 1] + LABEL_HEIGHT - height : 0;
		if (over > 0)
			for (let k = 0; k < ys.length; k++)
				ys[k] -= over;
		for (let k = 0; k < ys.length; k++)
			ys[k] = Math.max(ys[k], k * LABEL_HEIGHT);

		this.slots.clear();
		order.forEach((i, k) => this.slots.set(stack.layers[i], ys[k]));
		const put = (layer: Layer, anchor: Point, y: number) => {
			const label = this.labels.get(layer)!;
			label.element.classList.toggle('hovered', layer === this.hover);
			label.element.style.opacity = String(Math.min(1, this.t * 2));
			const x = anchor.x / dpr + 8;
			label.element.style.left	= `${Math.min(x, Math.max(0, width - label.element.offsetWidth - 4))}px`;
			label.element.style.top		= `${y}px`;
		};
		order.forEach((i, k) => {
			const layer = stack.layers[i];
			put(layer, this.anchors[i], layer === this.dragged ? Math.max(0, Math.min(height - LABEL_HEIGHT, this.dragY)) : ys[k]);
		});
	}
}
