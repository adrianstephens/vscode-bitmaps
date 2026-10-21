// The 2D view of a picture: a zoom and an offset (in canvas pixels) of the picture's top left corner. The left button drags
// the picture, keeping the point of it that was under the cursor there, and the wheel zooms about the cursor. The right
// button is left to the page (the tools bring up their menu).
import { float2, float2x3 } from '@isopodlabs/maths/vector';
import { Navigate } from './navigate.js';
import { pointerToCanvas } from './opengl.js';

const MAX_SCALE	= 256;
const FIT_SCALE	= 16;	// the most a picture is enlarged to fit

export class Pan extends Navigate<float2> {
	scale	= 1;
	offset	= float2(0, 0);
	width	= 0;		// of the picture, in its own pixels
	height	= 0;

	// the zoom, kept between half of what fits and the most
	clampScale(scale: number) {
		if (!this.width || !this.height)
			return scale;
		const min = Math.min(this.canvas.width / this.width, this.canvas.height / this.height) / 2;
		return Math.min(MAX_SCALE, Math.max(min, scale));
	}

	// the offset, kept so that the picture does not leave the window, or if it is smaller than the window is kept inside it
	clampOffset(v: float2) {
		if (!this.width || !this.height)
			return v;
		const w = this.width * this.scale, h = this.height * this.scale;
		const minX = Math.min(0, this.canvas.width - w), maxX = Math.max(0, this.canvas.width - w);
		const minY = Math.min(0, this.canvas.height - h), maxY = Math.max(0, this.canvas.height - h);
		return float2(Math.min(maxX, Math.max(minX, v.x)), Math.min(maxY, Math.max(minY, v.y)));
	}

	// after the window has changed size
	clamp() {
		this.scale	= this.clampScale(this.scale);
		this.offset	= this.clampOffset(this.offset);
	}

	private centre() {
		return float2((this.canvas.width - this.width * this.scale) / 2, (this.canvas.height - this.height * this.scale) / 2);
	}

	matrix() {
		return float2x3(float2(this.scale, 0), float2(0, this.scale), this.offset);
	}

	// the whole picture in the window
	override fit() {
		this.scale	= Math.min(FIT_SCALE, Math.min(this.canvas.width / this.width, this.canvas.height / this.height));
		this.offset	= this.centre();
	}

	// its own size, in the middle
	override reset() {
		this.scale	= this.clampScale(1);
		this.offset	= this.centre();
	}

	// a point of the picture, in canvas pixels
	toScreen(p: float2) {
		return float2(this.offset.x + p.x * this.scale, this.offset.y + p.y * this.scale);
	}

	// how long a canvas pixel is, in the picture's pixels
	pixelSize() {
		return 1 / this.scale;
	}

	// a point of the window, in canvas pixels, which the offset is in
	private toCanvas(clientX: number, clientY: number) {
		return pointerToCanvas(this.canvas.getBoundingClientRect(), clientX, clientY);
	}

	// the point of the picture (not whole pixels) under a point of the window
	toImage(clientX: number, clientY: number) {
		const p = this.toCanvas(clientX, clientY);
		return float2((p.x - this.offset.x) / this.scale, (p.y - this.offset.y) / this.scale);
	}

	protected anchorAt(clientX: number, clientY: number) {
		return this.toImage(clientX, clientY);
	}

	protected grab(anchor: float2, event: PointerEvent) {
		if (event.button !== 0)
			return undefined;
		return (e: PointerEvent) => {
			const p = this.toCanvas(e.clientX, e.clientY);
			this.offset = this.clampOffset(p.sub(anchor.scale(this.scale)));
			this.hooks.redraw();
		};
	}

	protected zoom(anchor: float2, factor: number, event: WheelEvent) {
		const p = this.toCanvas(event.clientX, event.clientY);
		this.scale	= this.clampScale(this.scale * factor);
		this.offset	= this.clampOffset(p.sub(anchor.scale(this.scale)));
	}
}
