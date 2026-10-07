// A picture's layers on the GPU: each layer is a texture of its own, and the picture is made from them by drawing them
// one over another, each with its blend mode, in float buffers. Only what has changed is made again: a stroke on a layer
// is a rectangle of its texture and of the picture; showing, hiding, reordering and opacity are only the drawing.

import { Canvas3D, ShaderProgram, Offscreen } from './opengl.js';
import { Layer, blendModeNumber } from './layers.js';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export class LayerCompositor {
	private textures = new Map<Layer, {texture: WebGLTexture, image: unknown}>();
	private masks = new Map<Layer, {texture: WebGLTexture, image: unknown}>();
	private noMask: WebGLTexture | undefined;		// for a layer which has none, as something has to be bound
	private result: Offscreen | undefined;			// the picture
	private scratch: Offscreen[] = [];				// what is drawn into on the way to it
	private groups: Offscreen[] = [];				// and where a layer with layers clipped to it is made first, which is only if there are some
	private size = {width: 0, height: 0};
	private float: boolean;

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

	// some of a layer's pixels have changed (all of them, without a rect)
	upload(layer: Layer, rect?: Rect) {
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
	compose(width: number, height: number, layers: Layer[], rect?: Rect) {
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
		this.noMask ??= canvas3d.createTexture(1, 1, new Uint8Array(1), {format: 'r8', min: 'nearest', mag: 'nearest'});

		if (!this.result || this.size.width !== width || this.size.height !== height) {
			this.deleteTargets();
			this.size = {width, height};
			this.result = this.target(width, height);
			this.scratch = [this.target(width, height), this.target(width, height)];
			rect = undefined;
		}

		const x0 = Math.max(0, rect ? rect.x : 0), y0 = Math.max(0, rect ? rect.y : 0);
		const x1 = Math.min(width, rect ? rect.x + rect.w : width), y1 = Math.min(height, rect ? rect.y + rect.h : height);
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
				u_maskDefault:	(mask?.defaultColor ?? 255) / 255,
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
	read(rect: Rect) {
		const gl = this.canvas3d.gl;
		const out = new Uint8ClampedArray(rect.w * rect.h * 4);
		if (!this.result)
			return out;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.result.framebuffer);
		if (this.float) {
			const values = new Float32Array(rect.w * rect.h * 4);
			gl.readPixels(rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.FLOAT, values);
			for (let i = 0; i < values.length; i++)
				out[i] = Math.round(values[i] * 255);
		} else {
			gl.readPixels(rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return out;
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
		this.size = {width: 0, height: 0};
	}
}
