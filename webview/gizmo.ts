// An orientation indicator for the 3D views: the model's X, Y and Z axes as the camera sees them, in a corner of the canvas.
// Clicking an axis turns the view (over a short time) to look along it, from that axis's side, or from the opposite side
// when it is already the way the view looks.
//
// The view's rotation, here, is the matrix whose columns are where the model's axes point in the camera's frame (right, up,
// and towards the viewer).
import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { float3, float3x3 } from '@isopodlabs/maths/vector';
import { unitQuaternion } from '@isopodlabs/maths/quaternion';

const SIZE		= 72;
const DOT		= 5.5;
const TURN_MS	= 300;
const AXES		= [{name: 'X', colour: '#e5534b'}, {name: 'Y', colour: '#57ab5a'}, {name: 'Z', colour: '#539bf5'}];
const UNIT		= [float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, 1)];

export interface GizmoHooks {
	begin?():			void;					// a turn is starting
	rotation():			float3x3;
	setRotation(rotation: float3x3): void;	// the view has been turned to this: redraw
}

// The view looking at the model from the side of axis (with the sign), with the model axis nearest to the current up as up
function alignedRotation(current: float3x3, axis: number, sign: number) {
	const back	= UNIT[axis].scale(sign);
	if (current.z.dot(back) > 0.999)	// looking that way already: look from the other side
		return alignedRotation(current, axis, -sign);
	let up = UNIT[(axis + 1) % 3], best = -2;
	for (let j = 0; j < 3; j++) {
		if (j === axis)
			continue;
		for (const s of [1, -1]) {
			const candidate = UNIT[j].scale(s), d = current.y.dot(candidate);
			if (d > best) {
				best	= d;
				up		= candidate;
			}
		}
	}
	return float3x3(up.cross(back), up, back).transpose();	// the camera's axes are the rows
}

export class Gizmo {
	private element:	HTMLCanvasElement;
	private context:	CanvasRenderingContext2D;
	private ratio		= 0;
	private dots:		{x: number, y: number, axis: number, depth: number}[] = [];
	private turn		= 0;

	constructor(canvas: HTMLCanvasElement, private hooks: GizmoHooks) {
		const element	= this.element = createElement('canvas');
		Object.assign(element.style, {position: 'absolute', top: '8px', right: '8px', width: SIZE + 'px', height: SIZE + 'px', display: 'none'});
		canvas.parentElement!.appendChild(element);
		this.context	= element.getContext('2d')!;
		element.addEventListener('pointermove', event => element.style.cursor = this.hit(event) ? 'pointer' : '');
		element.addEventListener('click', event => {
			const hit = this.hit(event);
			if (hit)
				this.turnTo(alignedRotation(this.hooks.rotation(), hit.axis, 1));
		});
		// the wheel and the pointer's other buttons are for the view behind
		element.addEventListener('wheel', event => event.stopPropagation());
	}

	// it is done with
	dispose() {
		this.element.remove();
	}

	show(on: boolean) {
		this.element.style.display = on ? '' : 'none';
		if (on)
			this.draw();
	}

	// the dot under the pointer, the nearer if two overlap
	private hit(event: MouseEvent) {
		const rect = this.element.getBoundingClientRect();
		const x = event.clientX - rect.left, y = event.clientY - rect.top;
		let found: typeof this.dots[number] | undefined;
		for (const dot of this.dots)
			if (Math.hypot(dot.x - x, dot.y - y) <= DOT + 2 && (!found || dot.depth > found.depth))
				found = dot;
		return found;
	}

	private turnTo(target: float3x3) {
		const id		= ++this.turn;
		this.hooks.begin?.();
		const start		= unitQuaternion.from3x3(this.hooks.rotation());
		const end		= unitQuaternion.from3x3(target);
		const t0		= performance.now();
		const step = (now: number) => {
			if (id !== this.turn)
				return;	// superseded
			const t = Math.min(1, (now - t0) / TURN_MS), s = t * t * (3 - 2 * t);
			this.hooks.setRotation(t === 1 ? target : unitQuaternion.slerp(start, end, s).to3x3());
			if (t < 1)
				requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	draw() {
		const rotation = this.hooks.rotation();
		const ratio = window.devicePixelRatio || 1, ctx = this.context;
		if (ratio !== this.ratio) {
			this.ratio = ratio;
			this.element.width = this.element.height = Math.round(SIZE * ratio);
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, SIZE, SIZE);
		const c = SIZE / 2, r = c - 11;
		ctx.beginPath();
		ctx.arc(c, c, c - 1, 0, 2 * Math.PI);
		ctx.fillStyle = 'rgba(128,128,128,0.18)';
		ctx.fill();

		// far axes first, so near ones are drawn over them
		this.dots = [rotation.x, rotation.y, rotation.z].map((v, axis) => ({x: c + v.x * r, y: c - v.y * r, axis, depth: v.z}));
		ctx.font			= 'bold 10px sans-serif';
		ctx.textAlign		= 'center';
		ctx.textBaseline	= 'middle';
		ctx.lineWidth		= 2;
		ctx.lineCap			= 'round';
		for (const {x, y, axis, depth} of [...this.dots].sort((a, b) => a.depth - b.depth)) {
			const {name, colour} = AXES[axis];
			ctx.globalAlpha	= depth < 0 ? 0.5 : 1;
			ctx.strokeStyle	= ctx.fillStyle = colour;
			ctx.beginPath();
			ctx.moveTo(c, c);
			ctx.lineTo(x, y);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(x, y, DOT, 0, 2 * Math.PI);
			ctx.fill();
			ctx.fillStyle = '#fff';
			ctx.fillText(name, x, y + 0.5);
		}
		ctx.globalAlpha = 1;
	}
}
