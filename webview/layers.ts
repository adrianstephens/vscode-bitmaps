// Layers for the bitmap editor: the stack of them, their blend modes, and how the whole-document operations (flip,
// rotate, crop) move them. The pixel work is plain, and tested outside a webview. Making the picture of them is on the GPU,
// in gpulayers.ts.

import { float2 } from '@isopodlabs/maths/vector';
import { Pixels, imageSize } from './raster.js';
import type { EditOp } from './paint.js';

export interface PlacedPixels {
	left:		number;
	top:		number;
	image:		Pixels;		// 8-bit rgba, not premultiplied
}

export function pixelRect(p: PlacedPixels) {
	return float2.extent.fromSize(float2(p.left, p.top), imageSize(p.image));
}

// A layer's mask: it hides the layer where it is dark. Its pixels are one byte each, over a rectangle which need not be the
// layer's, outside which it is `default`.
export interface LayerMask extends PlacedPixels {
	default:	number;		// 0..255
	disabled:	boolean;
	inverted:	boolean;
}

export interface Layer extends PlacedPixels {
	name:		string;
	opacity:	number;		// 0..1
	visible:	boolean;
	blend:		string;		// the file's blend mode: a key of BLEND_MODES, or any other, which is normal
	mask?:		LayerMask;
	clipped?:	boolean;	// clipped to the layer below: shown only where that layer (and the others clipped to it) are, and blended with them
}


export interface Snapshot {
	width:		number;
	height:		number;
	layers:		Layer[];
	current:	number;
}

export class LayerStack {
	constructor(public width: number, public height: number, public layers: Layer[]) {}

	index(layer?: Layer) {
		return layer ? this.layers.indexOf(layer) : -1;
	}

	// (which layer is current is the painter's; a snapshot is given the index of it, to hand back to whatever restores it)
	snapshot(current: number): Snapshot {
		return {width: this.width, height: this.height, layers: this.layers.slice(), current};
	}

	restore(s: Snapshot) {
		this.width	= s.width;
		this.height	= s.height;
		this.layers	= s.layers.slice();
	}
}

export function blankLayer(width: number, height: number, name: string): Layer {
	return {name, left: 0, top: 0, opacity: 1, visible: true, blend: 'norm', image: {data: new Uint8ClampedArray(width * height * 4), width, height}};
}

// A layer's pixels over the whole canvas, which is what the tools draw on (anything outside the canvas is lost).
// It changes the layer itself, so that everything which holds the layer sees it.
export function expand(layer: Layer, width: number, height: number) {
	const old = layer.image;
	if (layer.left === 0 && layer.top === 0 && old.width === width && old.height === height)
		return;

	const data = new Uint8ClampedArray(width * height * 4);
	const x0 = Math.max(0, layer.left), x1 = Math.min(width, layer.left + old.width);
	const y0 = Math.max(0, layer.top), y1 = Math.min(height, layer.top + old.height);
	for (let y = y0; y < y1; y++) {
		const s = ((y - layer.top) * old.width + (x0 - layer.left)) * 4;
		if (x1 > x0)
			data.set(old.data.subarray(s, s + (x1 - x0) * 4), (y * width + x0) * 4);
	}
	layer.image	= {data, width, height};
	layer.left	= layer.top = 0;
}

//-----------------------------------------------------------------------------
// blend modes
//-----------------------------------------------------------------------------

// PSD's blend mode keys, and the numbers composite.frag knows them by. A group's pass through, and any key not here, is
// normal.
export const BLEND_MODES: Record<string, number> = {
	'norm': 0,		// normal
	'diss': 1,		// dissolve
	'dark': 2,		// darken
	'mul ': 3,		// multiply
	'idiv': 4,		// colour burn
	'lbrn': 5,		// linear burn
	'dkCl': 6,		// darker colour
	'lite': 7,		// lighten
	'scrn': 8,		// screen
	'div ': 9,		// colour dodge
	'lddg': 10,		// linear dodge (add)
	'lgCl': 11,		// lighter colour
	'over': 12,		// overlay
	'sLit': 13,		// soft light
	'hLit': 14,		// hard light
	'vLit': 15,		// vivid light
	'lLit': 16,		// linear light
	'pLit': 17,		// pin light
	'hMix': 18,		// hard mix
	'diff': 19,		// difference
	'smud': 20,		// exclusion
	'fsub': 21,		// subtract
	'fdiv': 22,		// divide
	'hue ': 23,
	'sat ': 24,		// saturation
	'colr': 25,		// colour
	'lum ': 26,		// luminosity
};

// The modes by kind, with a name and a short name for each, which is how a menu lists them
export const BLEND_GROUPS: {name: string, modes: {key: string, name: string, short: string}[]}[] = [
	{name: 'Normal', modes: [
		{key: 'norm', name: 'Normal', short: 'Norm'}, {key: 'diss', name: 'Dissolve', short: 'Diss'}]},
	{name: 'Darken', modes: [
		{key: 'dark', name: 'Darken', short: 'Dark'}, {key: 'mul ', name: 'Multiply', short: 'Mul'}, {key: 'idiv', name: 'Colour Burn', short: 'Burn'},
		{key: 'lbrn', name: 'Linear Burn', short: 'LBrn'}, {key: 'dkCl', name: 'Darker Colour', short: 'DkCl'}]},
	{name: 'Lighten', modes: [
		{key: 'lite', name: 'Lighten', short: 'Lite'}, {key: 'scrn', name: 'Screen', short: 'Scrn'}, {key: 'div ', name: 'Colour Dodge', short: 'Dodge'},
		{key: 'lddg', name: 'Linear Dodge (Add)', short: 'Add'}, {key: 'lgCl', name: 'Lighter Colour', short: 'LtCl'}]},
	{name: 'Contrast', modes: [
		{key: 'over', name: 'Overlay', short: 'Over'}, {key: 'sLit', name: 'Soft Light', short: 'Soft'}, {key: 'hLit', name: 'Hard Light', short: 'Hard'},
		{key: 'vLit', name: 'Vivid Light', short: 'Vivid'}, {key: 'lLit', name: 'Linear Light', short: 'LLit'}, {key: 'pLit', name: 'Pin Light', short: 'Pin'},
		{key: 'hMix', name: 'Hard Mix', short: 'Mix'}]},
	{name: 'Comparative', modes: [
		{key: 'diff', name: 'Difference', short: 'Diff'}, {key: 'smud', name: 'Exclusion', short: 'Excl'}, {key: 'fsub', name: 'Subtract', short: 'Sub'},
		{key: 'fdiv', name: 'Divide', short: 'Div'}]},
	{name: 'Component', modes: [
		{key: 'hue ', name: 'Hue', short: 'Hue'}, {key: 'sat ', name: 'Saturation', short: 'Sat'}, {key: 'colr', name: 'Colour', short: 'Col'},
		{key: 'lum ', name: 'Luminosity', short: 'Lum'}]},
];

export function blendModeNumber(key: string) {
	return BLEND_MODES[key] ?? 0;
}

//-----------------------------------------------------------------------------
// layer ops
// What can be done to a picture's layers: choose one, show or hide it, change its opacity or blend mode, add one, delete
// one, move one up or down. Every change but choosing a layer is one undoable edit. Where they are listed and chosen from
// is the tool menu (bitmap.ts).
//-----------------------------------------------------------------------------

export type LayerOp = 'newLayer' | 'deleteLayer' | 'raiseLayer' | 'lowerLayer';

export interface LayerOpsHost {
	stack():	LayerStack | undefined;
	layer():	Layer | undefined;			// the current layer: the one the tools draw on
	select(layer: Layer): void;				// make it the current layer
	// An undoable change has been made, and done; undo and redo undo and redo it
	record(label: string, undo: () => void, redo: () => void): void;
	changed():	void;	// what is shown has changed: compose it again
}

// how long after the last change of an opacity (which is changed a step at a time) it is one edit
const OPACITY_EDIT_MS = 500;

export class LayerOps {
	private opacityEdit: {layer: Layer, before: number, timer: ReturnType<typeof setTimeout>} | undefined;
	private drag: {layer: Layer, order: Layer[]} | undefined;

	constructor(private host: LayerOpsHost) {}

	// (whether it is one of the layers': the others are not done)
	run(op: LayerOp | EditOp): boolean {
		switch (op) {
			case 'newLayer':	this.add(); break;
			case 'deleteLayer':	this.remove(); break;
			case 'raiseLayer':	this.move(1); break;
			case 'lowerLayer':	this.move(-1); break;
			default:			return false;
		}
		return true;
	}

	// the current layer: the one the tools draw on, which has to cover the canvas to be drawn on
	choose(index: number) {
		const stack = this.host.stack(), layer = stack?.layers[index];
		if (!stack || !layer)
			return;
		this.host.select(layer);
		expand(layer, stack.width, stack.height);
		this.host.changed();
	}

	setVisible(layer: Layer, visible: boolean) {
		if (layer.visible === visible)
			return;
		this.commitOpacity();
		const set = (v: boolean) => () => {
			layer.visible = v;
			this.host.changed();
		};
		set(visible)();
		this.host.record(visible ? 'Show Layer' : 'Hide Layer', set(!visible), set(visible));
	}

	setBlend(layer: Layer, blend: string) {
		const was = layer.blend;
		if (was === blend)
			return;
		this.commitOpacity();
		const set = (v: string) => () => {
			layer.blend = v;
			this.host.changed();
		};
		set(blend)();
		this.host.record('Layer Blend Mode', set(was), set(blend));
	}

	// the opacity is changed a step at a time, and is one edit once it has been left alone for a while
	setOpacity(layer: Layer, opacity: number) {
		if (this.opacityEdit?.layer !== layer)
			this.commitOpacity();
		const edit = this.opacityEdit ??= {layer, before: layer.opacity, timer: undefined as unknown as ReturnType<typeof setTimeout>};
		clearTimeout(edit.timer);
		edit.timer = setTimeout(() => this.commitOpacity(), OPACITY_EDIT_MS);
		layer.opacity = opacity;
		this.host.changed();
	}

	commitOpacity() {
		const edit = this.opacityEdit;
		this.opacityEdit = undefined;
		if (!edit)
			return;
		clearTimeout(edit.timer);
		const {layer, before} = edit, now = layer.opacity;
		if (now === before)
			return;
		const set = (v: number) => () => {
			layer.opacity = v;
			this.host.changed();
		};
		this.host.record('Layer Opacity', set(before), set(now));
	}

	// Moving a layer by dragging it: it goes wherever it is dragged to as it is, and is one edit when it is dropped
	beginDrag(layer: Layer) {
		const stack = this.host.stack();
		if (stack) {
			this.commitOpacity();
			this.drag = {layer, order: stack.layers.slice()};
		}
	}
	dragTo(index: number) {
		const stack = this.host.stack();
		if (!stack || !this.drag)
			return;
		const layer = this.drag.layer;
		const to = Math.max(0, Math.min(stack.layers.length - 1, index));
		if (stack.layers.indexOf(layer) === to)
			return;
		stack.layers.splice(stack.layers.indexOf(layer), 1);
		stack.layers.splice(to, 0, layer);
		this.host.changed();
	}
	endDrag() {
		const stack = this.host.stack(), drag = this.drag;
		this.drag = undefined;
		if (!stack || !drag || stack.layers.every((l, i) => l === drag.order[i]))
			return;
		const after = stack.layers.slice();
		const put = (order: Layer[]) => () => {
			stack.layers = order.slice();
			this.host.changed();
		};
		this.host.record('Move Layer', put(drag.order), put(after));
	}

	// a new layer, above the current one
	private add() {
		const stack = this.host.stack();
		if (!stack)
			return;
		this.commitOpacity();
		let n = stack.layers.length + 1;
		while (stack.layers.some(l => l.name === `Layer ${n}`))
			n++;
		const layer = blankLayer(stack.width, stack.height, `Layer ${n}`);
		const was = this.host.layer()!, at = stack.layers.indexOf(was) + 1;
		const redo = () => {
			stack.layers.splice(at, 0, layer);
			this.host.select(layer);
			this.host.changed();
		};
		redo();
		this.host.record('New Layer', () => {
			stack.layers.splice(at, 1);
			this.host.select(was);
			this.host.changed();
		}, redo);
	}

	// the layer given, or the current one
	remove(layer = this.host.layer()) {
		const stack = this.host.stack();
		if (!stack || !layer || stack.layers.length < 2)
			return;
		this.commitOpacity();
		const at = stack.layers.indexOf(layer), wasCurrent = layer === this.host.layer();
		const redo = () => {
			stack.layers.splice(at, 1);
			if (wasCurrent) {
				const next = stack.layers[Math.min(at, stack.layers.length - 1)];
				this.host.select(next);
				expand(next, stack.width, stack.height);
			}
			this.host.changed();
		};
		redo();
		this.host.record('Delete Layer', () => {
			stack.layers.splice(at, 0, layer);
			if (wasCurrent)
				this.host.select(layer);
			this.host.changed();
		}, redo);
	}

	// up (1) or down (-1) one place: the layer given, or the current one
	move(direction: 1 | -1, layer = this.host.layer()) {
		const stack = this.host.stack();
		if (!stack || !layer)
			return;
		const from = stack.layers.indexOf(layer), to = from + direction;
		if (to < 0 || to >= stack.layers.length)
			return;
		this.commitOpacity();
		const swap = (a: number, b: number) => () => {
			const t = stack.layers[a];
			stack.layers[a] = stack.layers[b];
			stack.layers[b] = t;
			this.host.changed();
		};
		swap(from, to)();
		this.host.record(direction > 0 ? 'Raise Layer' : 'Lower Layer', swap(to, from), swap(from, to));
	}
}

//-----------------------------------------------------------------------------
// GPU
//-----------------------------------------------------------------------------

// A picture's layers on the GPU: each layer is a texture of its own, and the picture is made from them by drawing them
// one over another, each with its blend mode, in float buffers. Only what has changed is made again: a stroke on a layer
// is a rectangle of its texture and of the picture; showing, hiding, reordering and opacity are only the drawing.

import { Canvas3D, ShaderProgram, Offscreen } from './opengl.js';

export class LayerCompositor {
	private textures = new Map<Layer, {texture: WebGLTexture, image: unknown}>();
	private masks = new Map<Layer, {texture: WebGLTexture, image: unknown}>();
	private noMask: WebGLTexture | undefined;		// for a layer which has none, as something has to be bound
	private result: Offscreen | undefined;			// the picture
	private scratch: Offscreen[] = [];				// what is drawn into on the way to it
	private groups: Offscreen[] = [];				// and where a layer with layers clipped to it is made first, which is only if there are some
	private float: boolean;
	width = 0;
	height = 0;

	constructor(private canvas3d: Canvas3D, private program: ShaderProgram) {
		// half floats keep the picture exact however many layers are drawn over each other; bytes are the way out when
		// they can't be drawn into
		this.float = !!canvas3d.gl.getExtension('EXT_color_buffer_float');
	}

	// the picture, which changes when the size does; undefined before it is first made
	get texture() {
		return this.result?.texture;
	}

	//-------------------------------------------------------------------------
	// the layers' textures
	//-------------------------------------------------------------------------

	// a layer's texture, made now if it has not been (or the layer's pixels are another image's, as when it is expanded)
	layerTexture(layer: Layer) {
		const entry = this.textures.get(layer);
		if (entry && entry.image === layer.image)
			return entry.texture;
		if (entry)
			this.canvas3d.gl.deleteTexture(entry.texture);
		if (!layer.image.width || !layer.image.height) {
			this.textures.delete(layer);
			return undefined;
		}
		const texture = this.canvas3d.createTextureFromImage(layer.image);
		this.textures.set(layer, {texture, image: layer.image});
		return texture;
	}

	// a layer's mask as a texture of one byte a pixel; undefined if it has none, or it has no pixels
	maskTexture(layer: Layer) {
		const mask = layer.mask;
		const entry = this.masks.get(layer);
		if (entry && entry.image === mask?.image)
			return entry.texture;
		if (entry)
			this.canvas3d.gl.deleteTexture(entry.texture);
		if (!mask || !mask.image.width || !mask.image.height) {
			this.masks.delete(layer);
			return undefined;
		}
		const texture = this.canvas3d.createTexture(mask.image.width, mask.image.height, mask.image.data, {format: 'r8', min: 'nearest', mag: 'nearest'});
		this.masks.set(layer, {texture, image: mask.image});
		return texture;
	}

	// something to bind where a layer has no mask
	dummyMask() {
		return this.noMask ??= this.canvas3d.createTexture(1, 1, new Uint8Array(1), {format: 'r8', min: 'nearest', mag: 'nearest'});
	}

	// some of a layer's pixels have changed (all of them, without a rect)
	upload(layer: Layer, rect?: float2.extent) {
		const entry = this.textures.get(layer);
		if (entry && entry.image === layer.image)
			this.canvas3d.updateTexture(entry.texture, layer.image, rect);
		// else there is no texture yet, or it is of other pixels: it is made, from these, when it is next wanted
	}

	//-------------------------------------------------------------------------
	// composing
	//-------------------------------------------------------------------------

	private target(width: number, height: number) {
		const canvas3d = this.canvas3d;
		try {
			return canvas3d.createOffscreen(width, height, this.float ? 'rgba16f' : 'rgba8');
		} catch (error) {
			if (!this.float)
				throw error;
			this.float = false;
			return canvas3d.createOffscreen(width, height, 'rgba8');
		}
	}

	private deleteTargets() {
		this.result?.delete();
		for (const s of [...this.scratch, ...this.groups])
			s.delete();
		this.result = undefined;
		this.scratch = [];
		this.groups = [];
	}

	// The layers, bottom first, composed into the picture: all of it, or the part inside rect
	compose(width: number, height: number, layers: Layer[], rect?: float2.extent) {
		const {canvas3d} = this, gl = canvas3d.gl;

		// textures for the layers there are, and none for those there are not
		const live = new Set(layers);
		for (const textures of [this.textures, this.masks]) {
			for (const [layer, entry] of textures) {
				if (!live.has(layer)) {
					gl.deleteTexture(entry.texture);
					textures.delete(layer);
				}
			}
		}
		this.dummyMask();

		if (!this.result || this.width !== width || this.height !== height) {
			this.deleteTargets();
			this.width = width;
			this.height = height;
			this.result = this.target(width, height);
			this.scratch = [this.target(width, height), this.target(width, height)];
			rect = undefined;
		}

		const x0 = Math.max(0, rect ? rect.min.x : 0), y0 = Math.max(0, rect ? rect.min.y : 0);
		const x1 = Math.min(width, rect ? rect.max.x : width), y1 = Math.min(height, rect ? rect.max.y : height);
		if (x1 <= x0 || y1 <= y0)
			return;

		// What is to be drawn, bottom first: each layer, with the layers clipped to it (the ones directly above it which say they
		// are), which are drawn onto it first, as a group. Only layers which are shown and reach the part to be made are.
		const reaches = (l: Layer) => l.visible && l.opacity > 0 && l.image.width > 0 && l.image.height > 0
			&& l.left < x1 && l.top < y1 && l.left + l.image.width > x0 && l.top + l.image.height > y0;
		const items: {base: Layer, clipped: Layer[]}[] = [];
		const groups: {base: Layer, clipped: Layer[]}[] = [];
		for (const layer of layers) {
			if (layer.clipped && groups.length)
				groups[groups.length - 1].clipped.push(layer);
			else
				groups.push({base: layer, clipped: []});
		}
		for (const group of groups)
			if (reaches(group.base))
				items.push({base: group.base, clipped: group.clipped.filter(reaches)});

		// Their textures, and the buffers a group needs, first: making either binds it, to whichever texture unit is active,
		// which would be the one of a texture bound to be drawn from
		const textures = new Map<Layer, {texture: WebGLTexture, mask: WebGLTexture | undefined}>();
		for (const item of items) {
			for (const layer of [item.base, ...item.clipped])
				textures.set(layer, {texture: this.layerTexture(layer)!, mask: layer.mask && !layer.mask.disabled ? this.maskTexture(layer) : undefined});
		}
		if (items.some(item => item.clipped.length) && !this.groups.length)
			this.groups = [this.target(width, height), this.target(width, height)];

		const blend = gl.isEnabled(gl.BLEND);
		gl.disable(gl.BLEND);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(x0, y0, x1 - x0, y1 - y0);
		gl.clearColor(0, 0, 0, 0);

		const clear = (target: Offscreen) => {
			target.begin();
			gl.clear(gl.COLOR_BUFFER_BIT);
		};

		// a layer, or what a group has made, over what has been made so far
		const draw = (from: Offscreen, to: Offscreen, layer: Layer, mode: string, opacity: number, clip: boolean, own?: WebGLTexture) => {
			const t = textures.get(layer);
			const mask = own ? undefined : layer.mask;
			to.begin();
			canvas3d.bindTexture(gl.TEXTURE_2D, from.texture, 0);
			canvas3d.bindTexture(gl.TEXTURE_2D, own ?? t!.texture, 1);
			canvas3d.bindTexture(gl.TEXTURE_2D, !own && t!.mask ? t!.mask : this.noMask!, 2);
			this.program.draw({
				u_backdrop:	0,
				u_layer:	1,
				u_origin:	own ? [0, 0] : [layer.left, layer.top],
				u_size:		own ? [width, height] : [layer.image.width, layer.image.height],
				u_opacity:	opacity,
				u_mode:		blendModeNumber(mode),
				u_clip:		clip ? 1 : 0,
				u_mask:			2,
				u_hasMask:		!own && t!.mask ? 1 : 0,
				u_maskOrigin:	[mask?.left ?? 0, mask?.top ?? 0],
				u_maskSize:		[mask?.image.width ?? 0, mask?.image.height ?? 0],
				u_maskDefault:	(mask?.default ?? 255) / 255,
				u_maskInvert:	mask?.inverted ? 1 : 0,
			});
		};

		if (!items.length) {
			clear(this.result);
		} else {
			// each is drawn over what has been made so far, which goes from one scratch buffer to the other, and the last
			// goes into the picture
			let from = this.scratch[0];
			clear(from);
			items.forEach(({base, clipped}, i) => {
				const to = i === items.length - 1 ? this.result! : from === this.scratch[0] ? this.scratch[1] : this.scratch[0];
				if (!clipped.length) {
					draw(from, to, base, base.blend, base.opacity, false);
				} else {
					// The group is made on its own: the layer as it is (its mask applied, whatever its mode and opacity,
					// which are for the group), and each layer clipped to it over that. Its alpha is the layer's, which
					// is what they are clipped to. Then the group goes over what is below, with the layer's mode and opacity.
					const [a, b] = this.groups;
					clear(a);
					draw(a, b, base, 'norm', 1, false);
					let made = b, other = a;
					for (const layer of clipped) {
						draw(made, other, layer, layer.blend, layer.opacity, true);
						[made, other] = [other, made];
					}
					draw(from, to, base, base.blend, base.opacity, false, made.texture);
				}
				from = to;
			});
			for (const unit of [2, 1, 0])
				canvas3d.bindTexture(gl.TEXTURE_2D, null, unit);
		}

		gl.disable(gl.SCISSOR_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		if (blend)
			gl.enable(gl.BLEND);
	}

	// The pixels of the picture inside the rectangle, as 8-bit rgba (not premultiplied), the first row on top
	read(rect: float2.extent) {
		if (!this.result)
			return;

		const out = this.result?.readPixels(rect);
		if (!this.float)
			return out;

		const out2 = new Uint8ClampedArray(out.length);
		for (let i = 0; i < out.length; i++)
			out2[i] = Math.round(out[i] * 255);
		return out2;
	}

	release() {
		const gl = this.canvas3d.gl;
		for (const textures of [this.textures, this.masks]) {
			for (const {texture} of textures.values())
				gl.deleteTexture(texture);
			textures.clear();
		}
		if (this.noMask)
			gl.deleteTexture(this.noMask);
		this.noMask = undefined;
		this.deleteTargets();
		this.width = this.height = 0;
	}
}
