// The camera the 3D viewers share, and how the pointer moves it. Left drags pan and right drags turn, both about the point
// that was under the cursor when the button went down: a pan keeps that point under the cursor wherever it goes, and a
// turn orbits about it, so it stays where it was clicked. The wheel moves toward or away from the point under the cursor.
import { float3, float3x3, float3x4, float4x4, orthonormalise } from '@isopodlabs/maths/vector';

export interface OrbitHooks {
	anchor(clientX: number, clientY: number): float3;	// the point under the cursor a drag or zoom holds on to
	size():			number;								// how big the model is, which bounds a zoom
	changed():		void;								// the view has moved
	dragStart?():	void;
	zoomed?(clientX: number, clientY: number): void;
}

export const DEFAULT_FOVY = 1 / Math.tan(Math.PI / 6);

export class Orbit {
	basis		= float3x3.identity();		// camera right, up and back
	eye			= float3(0, 0, 6);			// where the camera is
	fovy		= DEFAULT_FOVY;				// the cotangent of half the vertical field of view
	dragging	= false;

	constructor(private canvas: HTMLCanvasElement, private hooks: OrbitHooks) {
		canvas.addEventListener('contextmenu', event => event.preventDefault());
		canvas.addEventListener('pointerdown', event => this.pointerDown(event));
		canvas.addEventListener('wheel', event => this.wheel(event), {passive: false});
	}

	// The ray through a point of the canvas, in the camera's frame and unnormalised, so that a point d in front of the
	// camera and on that ray is at eye + basis * (ray * d).
	ray(clientX: number, clientY: number) {
		const rect = this.canvas.getBoundingClientRect();
		const x = ((clientX - rect.left) / rect.width) * 2 - 1;
		const y = 1 - ((clientY - rect.top) / rect.height) * 2;
		return float3(x * (rect.width / rect.height) / this.fovy, y / this.fovy, -1);
	}

	// where there is nothing under the cursor to hold on to: the point as far along its ray as center is in front
	along(clientX: number, clientY: number, center: float3, size: number) {
		const depth = Math.max(center.sub(this.eye).dot(this.basis.z.neg()), size * 0.2);
		return this.basis.mul(this.ray(clientX, clientY)).scale(depth).add(this.eye);
	}

	// looking at target from distance away, along basis's back axis
	look(target: float3, distance: number, basis = float3x3.identity()) {
		this.basis	= basis;
		this.eye	= basis.z.scale(distance).add(target);
	}

	toview(): float3x4 {
		return float3x4(
			this.basis.x, this.basis.y, this.basis.z, this.eye
		).inverse();
	}
	projection(center: float3, aspect: number): float4x4 {
		const dist	= this.eye.sub(center).len(), s = this.hooks.size();
		const near	= Math.max(s * 1e-3, (dist - s * 2) * 0.5), far = dist + s * 40;
		const f		= this.fovy;
		return float4x4.perspective(f, aspect, near, far);
	}

	private pointerDown(event: PointerEvent) {
		if (event.button !== 0 && event.button !== 2)
			return;
		const canvas	= this.canvas;
		const rotating	= event.button === 2;
		this.dragging	= true;
		this.hooks.dragStart?.();
		canvas.setPointerCapture(event.pointerId);
		const anchor	= this.hooks.anchor(event.clientX, event.clientY);
		// how far in front of the camera the anchor is, which a pan keeps
		const depth		= anchor.sub(this.eye).dot(this.basis.z.neg());
		let last		= {x: event.clientX, y: event.clientY};
		const onMove = (e: PointerEvent) => {
			if (rotating) {
				// in css pixels, so how far a drag turns the model does not depend on the size the frame is drawn at
				const dx = e.clientX - last.x, dy = e.clientY - last.y;
				let turn = float3.rotate(this.basis.y, -dx * 0.01);
				turn = float3.rotate(turn.mul(this.basis.x), -dy * 0.01).matmul(turn);
				this.basis = turn.matmul(this.basis);
				orthonormalise(this.basis);
				this.eye = anchor.add(turn.mul(this.eye.sub(anchor)));
			} else {
				this.eye = anchor.sub(this.basis.mul(this.ray(e.clientX, e.clientY)).scale(depth));
			}
			last = {x: e.clientX, y: e.clientY};
			this.hooks.changed();
		};
		const onUp = () => {
			this.dragging = false;
			canvas.removeEventListener('pointermove', onMove);
			canvas.removeEventListener('pointerup', onUp);
			canvas.removeEventListener('pointercancel', onUp);
		};
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('pointercancel', onUp);
	}

	private wheel(event: WheelEvent) {
		event.preventDefault();
		const anchor	= this.hooks.anchor(event.clientX, event.clientY);
		const scale		= this.hooks.size();
		const factor	= 1.01 ** -event.deltaY;
		const offset	= this.eye.sub(anchor), dist = offset.len();
		// Close to a surface, zooming in stops closing on it by a fraction of the distance -- which never arrives -- and
		// steps along the cursor's ray instead, so it goes through the wall and into whatever is hollow behind it.
		const near = scale * 0.05;
		if (factor < 1 && dist * factor < near) {
			const ray = this.basis.mul(this.ray(event.clientX, event.clientY));
			this.eye = this.eye.add(ray.scale(near * (1 - factor) / ray.len()));
		} else {
			this.eye = anchor.add(offset.scale(Math.min(scale * 20, dist * factor) / dist));
		}
		this.hooks.changed();
		this.hooks.zoomed?.(event.clientX, event.clientY);
	}
}
