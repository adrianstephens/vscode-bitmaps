// A picture's layers (or an array's slices) -- sheets -- shown in 3D: they draw apart into a stack of sheets one behind another, the top
// layer nearest, seen from the side so that the sheets behind show beyond the front one. It is turned on and off from the
// tool menu (bitmap.ts), which is also where a layer is chosen and its opacity, visibility and the rest are set; pointing
// at a sheet and clicking chooses it.
//
// The stack is a real 3D model with one view and one projection -- one MVP for every layer. The layers differ in nothing
// but how deep they lie: layer i lies at z = (n - 1 - i) * gap, so the last layer (the top of the picture) is nearest
// the camera. The camera is an Orbit (orbit.ts), which the user moves as in the other 3D views. It only starts from a
// pose found by hand (below), and the stack opens from the flat picture by blending from its matrix to that one. They are
// drawn in the order they are stacked in the picture, so the top layer is the one drawn over the rest.

import { createElement } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D } from './opengl.js';
import { Orbit } from './orbit.js';
import { Input, Place } from './navigate.js';
import { float2, float3, float3x3, float4, float4x4, lerp, normalise, matmulExt } from '@isopodlabs/maths/vector';

// where a sheet is, and how it is to be drawn, as the fan lays it out
export interface Placement {
	matrix:		float4x4;		// from the model's measure to clip space: the same for every sheet, which differ only in how deep they lie
	depth:		number;			// how deep this one lies
	open:		number;			// how far open the fan is: 0 closed, 1 open
	sheet:		float2.extent;	// the whole sheet, in the model's own measure (the longest side is 1)
	current:	boolean;		// it is the one chosen
	hovered:	boolean;		// it is the one pointed at
	outline:	[number, number, number, number];	// the colour of its outline, premultiplied and faded in as the fan opens
	edge(css: number): number;	// an outline this many window pixels wide, in the model's measure at this depth
	longest:	number;			// the picture's longest side, in its own pixels
}

export interface SheetFanHost {
	canvas3d:	Canvas3D;
	canvas:		HTMLCanvasElement;
	width:		number;			// of each sheet, in the picture's pixels
	height:		number;
	count:		number;
	current:	number;			// the sheet chosen
	redraw():	void;	// something has changed: the picture is to be drawn again (by the mode, which draws the fan while it is up)
	tip(text: string | undefined, clientX: number, clientY: number): void;	// the name of what the pointer is over, near it; or nothing
	opened(open: boolean): void;	// it has come up, or gone away: the rest of what is drawn on the picture makes way
	flatView():		float4x4;
	bounds(i: number):	float2.extent | undefined;	// where on its sheet its pixels lie (all of it, if undefined)
	drawSheet(i: number, at: Placement): void;	// the sheet, and its outline
	sheetName(i: number):	string;
	choose(i: number):	void;
	reorderer(i: number): {begin(): void, to(index: number): void, drop(): void} | undefined;	// moving it to another place in the order
	sheetMenu(i: number | undefined, clientX: number, clientY: number): void;	// a right click (not a drag, which turns the fan), over a sheet if it is
}

const OPEN_MS		= 260;
const SLIDE_MS		= 140;		// a sheet making way for one being moved takes this long to go one place
// The camera the fan starts from, as it was posed by hand and read off. All in
// the model's own measure (the picture's longest side is 1), with x across, y down, the front sheet's top left corner at
// the origin and the layers behind it along +z.
const FOCAL			= 1.732;	// the cotangent of half the field of view (a field of 60 degrees)
const EYE			= {x: 0.6834, y: 0.1147, z: -0.6704};	// where the eye is, as offsets from the middle of the front sheet
const YAW			= -0.558;	// how far the camera stands round to the right, so it looks back and to the left (radians)
const PITCH			= -0.09;	// and how far it is tipped (radians)
const DEFAULT_GAP	= 0.08;		// how far one layer lies behind the next
const ASPECT		= 1330 / 1475;	// the window's width over its height when the camera was posed (1330 x 1475)

// where a point of the model lands, in canvas pixels
function project(mvp: float4x4, x: number, y: number, z: number, size: float2): float2 {
	const clip = mvp.mul(float4(x, y, z, 1));
	return float2((clip.x / clip.w + 1) / 2 * size.x, (1 - clip.y / clip.w) / 2 * size.y);
}

function corners(rect: float2.extent, depth: number, mvp: float4x4, size: float2): float2[] {
	const p = (x: number, y: number) => project(mvp, x, y, depth, size);
	return [p(rect.min.x, rect.min.y), p(rect.max.x, rect.min.y), p(rect.max.x, rect.max.y), p(rect.min.x, rect.max.y)];
}

// the point inside the convex polygon
function inside(convex: float2[], p: float2) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = convex[i], b = convex[(i + 1) % 4];
		const cross = b.sub(a).cross(p.sub(a));//(b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (cross !== 0) {
			if (sign && (cross > 0) !== (sign > 0))
				return false;
			sign = cross;
		}
	}
	return sign !== 0;		// (a polygon with no area, as of a layer with no pixels, holds nothing)
}

export class SheetFan {
	t = 0;								// how far open: 0 closed, 1 open
	gap = DEFAULT_GAP;					// how far one layer lies behind the next
	private target 				= 0;
	private frame 				= 0;
	private last 				= 0;
	private quads: float2[][] 	= [];		// where each layer's pixels were drawn, in canvas pixels
	private frames: float2[][] 	= [];		// and the whole sheet at its depth, which the layers lie on like sheets in a stack
	private hover: number | undefined;
	private handle: HTMLElement | undefined;	// what the sheet under the pointer is taken hold of by to move it in the order
	private grab: number | undefined;			// that sheet
	private dragIndex = -1;				// where the one being moved is
	private pos:	number[]	= [];		// where each sheet is drawn, in places from the back (fractional while it slides or is carried)
	private slotFrames: float2[][] = [];	// the places in the stack, as the sheets lie in them at rest
	private slotPts: float2[]	= [];		// the handle at each
	private order:	number[]	= [];		// the sheets from the back, as they are drawn
	private slideFrame			= 0;
	private slideTime			= 0;
	private off:	(() => void) | undefined;	// it has the pointer, over everything, while it is up: how it gives it back
	private orbit:	Orbit;		// the camera, which the user moves about the stack
	private dims = {u: 1, v: 1, n: 1};	// the stack as the model has it: each sheet u across and v down, n of them

	constructor(private host: SheetFanHost) {
		this.orbit = new Orbit(host.canvas, {
			anchor:	(x, y) => this.pick(x, y) ?? this.orbit.along(x, y, this.centre(), this.size()),
			size:	() => this.size(),
			redraw: () => host.redraw(),
			home:	() => this.resetCamera(),
			click:	(x, y) => {
				const i = this.layerAt(host.canvas3d.toCanvas(x, y));
				if (i >= 0)
					this.choose(i);
			},
			contextMenu: (x, y) => {
				const i = this.layerAt(host.canvas3d.toCanvas(x, y));
				this.host.sheetMenu(i >= 0 ? i : undefined, x, y);
			},
		});
		this.orbit.enabled = false;
	}

	// shown, or on its way to be
	get on() {
		return !!this.target;
	}

	get active() {
		return this.t > 0;
	}

	// what moves it
	get navigation() {
		return this.orbit;
	}

	// The layer under the point: the one drawn last which has drawn there, or whose sheet covers it. The layers are
	// drawn in the order they are stacked in the picture, so the top layer of the picture is the one in front.
	private layerAt(p: float2) {
		for (let k = this.order.length - 1; k >= 0; k--) {
			const i = this.order[k];
			if ((this.quads[i].length && inside(this.quads[i], p)) || (this.frames[i]?.length && inside(this.frames[i], p)))
				return i;
		}
		return -1;
	}

	// the sheet the pointer is over, picked out and named beside it (a click chooses it); and the cursor for that
	private pointerMove(e: PointerEvent) {
		if (!this.t || e.buttons)
			return '';
		const at = this.layerAt(this.host.canvas3d.toCanvas(e.clientX, e.clientY)), hover = at >= 0 ? at : undefined;
		const moved = this.grab !== hover;
		this.grab = hover;
		if (hover !== this.hover) {
			this.hover = hover;
			this.host.redraw();
		} else if (moved) {
			this.host.redraw();	// (the handle goes to the sheet)
		}
		this.host.tip(hover !== undefined ? this.host.sheetName(hover) : undefined, e.clientX, e.clientY);
		return hover !== undefined ? 'pointer' : '';
	}

	// the stack comes up from the flat picture, or goes back to it
	show(on: boolean) {
		if (on === !!this.target)
			return;
		if (on) {
			const source = this.host;
			if (!source)
				return;
			this.home();
			// (what is dragged is the camera's: the left button pans and the right turns, and a click is on a sheet; while it closes the
			// camera is still, and nothing under it has the pointer either)
			this.off ??= Input.on(this.host.canvas).add({
				holds:	true,
				press:	e => this.orbit.press(e) ?? true,
				hover:	e => this.pointerMove(e),
				wheel:	e => (this.orbit.wheel(e), true),
				menu:	() => true,
				key:	e => e.key === 'Escape' && (this.show(false), true),
			}, Place.fan);
			this.host.opened(true);
		}
		this.target = on ? 1 : 0;
		this.orbit.enabled = on;
		this.animate();
	}

	// the camera put back where it starts
	resetCamera() {
		const source = this.host;
		if (source && this.target) {
			this.home();
			this.host.redraw();
		}
	}

	// a sheet picked out (white outline) from elsewhere, as the pointer resting on its icon in the menu
	highlight(index: number | undefined) {
		if (index === this.hover)
			return;
		this.hover = index;
		this.host.redraw();
	}

	// Where a sheet is taken hold of: the corner of it that the sheets in front are least likely to cover. Those in front are
	// shifted on the window, relative to the ones behind, one way; so it is the corner furthest the other way, whichever
	// way the stack is seen from.
	private handlePoint(i: number): float2 | undefined {
		const f = this.frames[i];
		return f?.length ? this.handleCorner(f, this.slotFrames[0], this.slotFrames[this.slotFrames.length - 1]) : undefined;
	}

	private handleCorner(f: float2[], first?: float2[], last?: float2[]): float2 {
		const centre = (q: float2[]) => float2((q[0].x + q[2].x) / 2, (q[0].y + q[2].y) / 2);
		const d = first?.length && last?.length ? centre(first).sub(centre(last)) : float2(0, 0);
		if (d.x * d.x + d.y * d.y < 1)
			return f[0];
		const c = centre(f);
		let best = f[0], bestD = -Infinity;
		for (const q of f) {
			const dot = q.sub(c).dot(d);
			if (dot > bestD) {
				bestD = dot;
				best = q;
			}
		}
		return best;
	}

	// a sheet's handle taken hold of: the sheet is carried along the stack with the pointer, and goes to the place it is nearest,
	// the sheets between sliding up to make room
	private startDrag(handle: HTMLElement, down: PointerEvent) {
		const index = this.grab ?? -1;
		const mover = index >= 0 ? this.host.reorderer(index) : undefined;
		if (!mover)
			return;
		handle.setPointerCapture(down.pointerId);
		const n = this.host.count;
		// where the pointer is along the stack, in places: the line through the handles of the first and last place
		const along = (e: PointerEvent) => {
			const a = this.slotPts[0], b = this.slotPts[n - 1];
			if (!a || !b)
				return index;
			const d = b.sub(a), len2 = d.dot(d);
			return len2 < 1 ? index : this.host.canvas3d.toCanvas(e.clientX, e.clientY).sub(a).dot(d) / len2 * (n - 1);
		};
		const grab = along(down) - index;
		let moved = false;
		const move = (e: PointerEvent) => {
			if (!moved) {
				if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4)
					return;
				moved = true;
				this.dragIndex = index;
				mover.begin();
			}
			const at = Math.max(0, Math.min(n - 1, along(e) - grab)), best = Math.round(at);
			if (best !== this.dragIndex) {
				const [p] = this.pos.splice(this.dragIndex, 1);
				this.pos.splice(best, 0, p);
				this.dragIndex = best;
				mover.to(best);
			}
			this.hover = this.grab = this.dragIndex;	// (the pointed-at outline stays with the sheet, not the place)
			this.pos[this.dragIndex] = at;
			this.host.redraw();
		};
		const up = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
			if (moved)
				mover.drop();
			this.dragIndex = -1;
			this.host.redraw();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}

	// the handle, at a corner of the sheet under the pointer (or the one being moved); there is no other
	private placeHandle() {
		const index = this.dragIndex >= 0 ? this.dragIndex : this.grab ?? -1;
		const p = index >= 0 ? this.handlePoint(index) : undefined;
		if (!p) {
			this.handle?.remove();
			this.handle = undefined;
			return;
		}
		if (!this.handle) {
			const h = this.handle = createElement('div', {className: 'fan-handle', title: 'Drag to move this layer in the stack', innerHTML: '<svg viewBox="0 0 28 14"><path d="M1 7 8 1.5V5H20V1.5L27 7 20 12.5V9H8V12.5Z"/></svg>'});
			h.addEventListener('pointerdown', e => {
				if (e.button === 0) {
					e.preventDefault();
					e.stopPropagation();
					this.startDrag(h, e);
				}
			});
			// the pointer on the handle is still over the stack: it goes on to whatever sheet it moves over
			h.addEventListener('pointermove', e => this.pointerMove(e));
			this.host.canvas.parentElement!.append(h);
		}
		const dpr = window.devicePixelRatio || 1, canvas = this.host.canvas;
		const margin = 16;	// (kept within the window, where a sheet reaches past it)
		this.handle.style.left = `${Math.max(margin, Math.min(canvas.width / dpr - margin, p.x / dpr))}px`;
		this.handle.style.top = `${Math.max(margin, Math.min(canvas.height / dpr - margin, p.y / dpr))}px`;
		this.handle.style.opacity = String(this.t);
		// along the stack: the way the sheets lie one behind another on the window
		const a = this.slotPts[0], b = this.slotPts[this.slotPts.length - 1];
		if (a && b && a.sub(b).dot(a.sub(b)) >= 1)
			this.handle.style.setProperty('--angle', `${Math.atan2(b.y - a.y, b.x - a.x)}rad`);
		this.handle.classList.toggle('dragging', this.dragIndex >= 0);
	}

	// it is done with (with the mode it is part of, which is being left: so nothing is told)
	dispose() {
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.off?.();
		this.off = undefined;
		this.handle?.remove();
	}

	// the stack is gone, at once
	reset() {
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.target = 0;
		this.t = 0;
		this.orbit.enabled = false;
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
			this.host.redraw();
			if (this.t !== this.target)
				this.frame = requestAnimationFrame(step);
		};
		this.frame = requestAnimationFrame(step);
	}


	private release() {
		this.quads = [];
		this.frames = [];
		this.pos = [];
		this.order = [];
		cancelAnimationFrame(this.slideFrame);
		this.slideFrame = 0;
		this.hover = undefined;
		this.handle?.remove();
		this.handle = undefined;
		this.grab = undefined;
		this.dragIndex = -1;
		this.host.tip(undefined, 0, 0);
		this.off?.();
		this.off = undefined;
		this.host.opened(false);
	}

	//-------------------------------------------------------------------------
	// the camera
	//-------------------------------------------------------------------------

	private centre() {
		return float3(this.dims.u / 2, this.dims.v / 2, (this.dims.n - 1) * this.gap / 2);
	}

	private size() {
		return Math.max(this.dims.u, this.dims.v, (this.dims.n - 1) * this.gap);
	}

	// The camera put where it starts: as posed by hand (above), turned a little about its own up axis if the window is of
	// another shape than it was posed in. A window which shows more or less across carries everything across with it from
	// the middle; this puts the front sheet's right edge back at the same part of the window's width.
	private home() {
		const sheets = this.host;
		const longest = Math.max(sheets.width, sheets.height);
		this.dims = {u: sheets.width / longest, v: sheets.height / longest, n: sheets.count};
		const {u, v} = this.dims;
		// The camera looks down its own -z, as the projection expects: right, up, and back along the way it faces.
		const f		= float3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(YAW) * Math.cos(PITCH));
		const r		= normalise(f.cross(float3(0, -1, 0)));
		const basis	= float3x3(r, r.cross(f), f.neg());
		const eye	= float3(u / 2 + EYE.x, v / 2 + EYE.y, EYE.z);
		const edge	= float3(u, v / 2, 0).sub(eye);
		const where	= (b: float3x3, aspect: number) => FOCAL / aspect * edge.dot(b.x) / -edge.dot(b.z);	// across the window, -1 to 1
		const want	= where(basis, ASPECT), aspect = this.host.canvas.width / this.host.canvas.height;
		const turned = (angle: number) => float3.rotate(basis.y, angle).matmul(basis) as float3x3;
		let lo = -0.8, hi = 0.8, result = basis;
		const glo = where(turned(lo), aspect) - want, ghi = where(turned(hi), aspect) - want;
		if (Number.isFinite(glo) && Number.isFinite(ghi) && glo * ghi < 0) {
			for (let i = 0; i < 40; i++) {
				const mid = (lo + hi) / 2;
				if ((where(turned(mid), aspect) - want) * glo > 0)
					lo = mid;
				else
					hi = mid;
			}
			result = turned((lo + hi) / 2);
		}
		this.orbit.basis	= result;
		this.orbit.eye		= eye;
		this.orbit.fovy		= FOCAL;
	}

	// where the camera's ray through a point of the window meets the nearest sheet
	private pick(clientX: number, clientY: number): float3 | undefined {
		const o = this.orbit, {u, v, n} = this.dims, dir = o.basis.mul(o.ray(clientX, clientY));
		let best: float3 | undefined, bestT = Infinity;
		for (let i = 0; i < n; i++) {
			const t = ((n - 1 - i) * this.gap - o.eye.z) / dir.z;
			if (!(t > 0 && t < bestT))
				continue;
			const x = o.eye.x + dir.x * t, y = o.eye.y + dir.y * t;
			if (x >= 0 && x <= u && y >= 0 && y <= v) {
				bestT	= t;
				best	= float3(x, y, (n - 1 - i) * this.gap);
			}
		}
		return best;
	}


	private choose(index: number) {
		this.host.choose(index);
	}

	//-------------------------------------------------------------------------
	// drawing
	//-------------------------------------------------------------------------

	draw() {
		const sheets = this.host;
		if (!sheets) {
			this.reset();
			return;
		}

		const {canvas3d, canvas}	= this.host, gl = canvas3d.gl;
		const width	= canvas.width, height = canvas.height, size = float2(width, height);
		const dpr	= window.devicePixelRatio || 1;
		const n		= sheets.count;

		const s = this.t * this.t * (3 - 2 * this.t);
		// the model: the picture in its own pixels over its longest side, so a sheet is at most 1 across
		const longest = Math.max(sheets.width, sheets.height);
		const u		= sheets.width / longest, v = sheets.height / longest;
		this.dims	= {u, v, n};
		const flat	= this.host.flatView();
		const fan	= matmulExt(this.orbit.projection(this.centre(), width / height), this.orbit.toview());
		// one MVP for every layer, opening from the flat picture; the layers differ only in how deep they lie
		const mvp	= float4x4(
			lerp(flat.x, fan.x, s), lerp(flat.y, fan.y, s), lerp(flat.z, fan.z, s), lerp(flat.w, fan.w, s)
		);
		const gap = s * (n > 1 ? this.gap : 0);

		const wasDepth = gl.isEnabled(gl.DEPTH_TEST);
		gl.disable(gl.DEPTH_TEST);

		this.quads		= [];
		this.frames		= [];
		const sheet		= new float2.extent(float2(0, 0), float2(u, v));

		// the places in the stack, and where each sheet is drawn: in its place, or on its way there from the one it left
		this.slotFrames	= Array.from({length: n}, (_, k) => corners(sheet, (n - 1 - k) * gap, mvp, size));
		this.slotPts	= this.slotFrames.map(f => this.handleCorner(f, this.slotFrames[0], this.slotFrames[n - 1]));
		if (this.pos.length !== n)
			this.pos = Array.from({length: n}, (_, i) => i);
		const now = performance.now(), dt = Math.min(50, now - this.slideTime);
		this.slideTime = now;
		let sliding = this.dragIndex >= 0;
		this.pos = this.pos.map((p, i) => {
			if (i === this.dragIndex)
				return p;
			const step = dt / SLIDE_MS;
			if (Math.abs(i - p) <= step)
				return i;
			sliding = true;
			return p + Math.sign(i - p) * step;
		});
		if (sliding && !this.slideFrame)
			this.slideFrame = requestAnimationFrame(() => { this.slideFrame = 0; this.host.redraw(); });
		this.order = this.pos.map((_, i) => i).sort((a, b) => this.pos[a] - this.pos[b]);

		// in the order they are stacked in the picture: the bottom sheet first, so the top one -- the nearest -- is the
		// one drawn over the rest
		for (const i of this.order) {
			const depth = (n - 1 - this.pos[i]) * gap;
			this.frames[i] = corners(sheet, depth, mvp, size);
			const b = sheets.bounds(i);
			this.quads[i] = !b ? this.frames[i] : corners(b.scale(1 / longest), depth, mvp, size);

			const current = i === sheets.current, hovered = i === this.hover;
			// one of the model's pixels, on the window, at this depth: what an outline of so many pixels of the window is
			const perPixel = Math.abs(this.frames[i][2].y - this.frames[i][1].y) / Math.max(1e-6, v);
			const o = current ? [0.1, 0.45, 0.9, 1] : hovered ? [0.95, 0.95, 0.95, 0.95] : [0.75, 0.75, 0.75, 0.6];
			sheets.drawSheet(i, {
				matrix: mvp, depth, open: s, sheet, current, hovered, longest,
				outline:	[o[0] * o[3] * s, o[1] * o[3] * s, o[2] * o[3] * s, o[3] * s],
				edge:		css => css * dpr * longest / Math.max(1e-6, perPixel),
			});
		}
		if (wasDepth)
			gl.enable(gl.DEPTH_TEST);
		this.placeHandle();
	}

}
