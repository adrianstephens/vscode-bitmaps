// What can be done to a picture's layers: choose one, show or hide it, change its opacity, add one, delete one, move one
// up or down. Every change but choosing a layer is one undoable edit. Where they are listed and chosen from is layerfan.ts.

import { Layer, LayerStack, blankLayer, expand } from './layers.js';

export type LayerOp = 'newLayer' | 'deleteLayer' | 'raiseLayer' | 'lowerLayer';

export interface LayerOpsHost {
	stack():	LayerStack | null;
	// An undoable change has been made, and done; undo and redo undo and redo it
	record(label: string, undo: () => void, redo: () => void): void;
	changed():	void;	// what is shown has changed: compose it again
}

export class LayerOps {
	private opacityBefore = 1;
	private drag: {layer: Layer, order: Layer[], current: Layer} | undefined;

	constructor(private host: LayerOpsHost) {}

	run(op: LayerOp) {
		switch (op) {
			case 'newLayer':	this.add(); break;
			case 'deleteLayer':	this.remove(); break;
			case 'raiseLayer':	this.move(1); break;
			case 'lowerLayer':	this.move(-1); break;
		}
	}

	// the current layer: the one the tools draw on, which has to cover the canvas to be drawn on
	choose(index: number) {
		const stack = this.host.stack();
		if (!stack || !stack.layers[index])
			return;
		stack.current = index;
		expand(stack.layer, stack.width, stack.height);
		this.host.changed();
	}

	setVisible(index: number, visible: boolean) {
		const stack = this.host.stack(), layer = stack?.layers[index];
		if (!layer || layer.visible === visible)
			return;
		const set = (v: boolean) => () => {
			layer.visible = v;
			this.host.changed();
		};
		set(visible)();
		this.host.record(visible ? 'Show Layer' : 'Hide Layer', set(!visible), set(visible));
	}

	// the opacity is dragged live, and is one edit once let go
	beginOpacity() {
		this.opacityBefore = this.host.stack()?.layer.opacity ?? 1;
	}
	setOpacity(opacity: number) {
		const layer = this.host.stack()?.layer;
		if (layer) {
			layer.opacity = opacity;
			this.host.changed();
		}
	}
	endOpacity() {
		const layer = this.host.stack()?.layer;
		if (!layer || layer.opacity === this.opacityBefore)
			return;
		const was = this.opacityBefore, now = layer.opacity;
		const set = (v: number) => () => {
			layer.opacity = v;
			this.host.changed();
		};
		this.host.record('Layer Opacity', set(was), set(now));
	}

	// Moving a layer by dragging it: it goes wherever it is dragged to as it is, and is one edit when it is dropped
	beginDrag(layer: Layer) {
		const stack = this.host.stack();
		if (stack)
			this.drag = {layer, order: stack.layers.slice(), current: stack.layer};
	}
	dragTo(index: number) {
		const stack = this.host.stack();
		if (!stack || !this.drag)
			return;
		const {layer, current} = this.drag;
		const to = Math.max(0, Math.min(stack.layers.length - 1, index));
		if (stack.layers.indexOf(layer) === to)
			return;
		stack.layers.splice(stack.layers.indexOf(layer), 1);
		stack.layers.splice(to, 0, layer);
		stack.current = stack.layers.indexOf(current);	// the same layer is chosen, wherever it has got to
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
			stack.current = stack.layers.indexOf(drag.current);
			this.host.changed();
		};
		this.host.record('Move Layer', put(drag.order), put(after));
	}

	private add() {
		const stack = this.host.stack();
		if (!stack)
			return;
		let n = stack.layers.length + 1;
		while (stack.layers.some(l => l.name === `Layer ${n}`))
			n++;
		const layer = blankLayer(stack.width, stack.height, `Layer ${n}`);
		const at = stack.current + 1, was = stack.current;
		const redo = () => {
			stack.layers.splice(at, 0, layer);
			stack.current = at;
			this.host.changed();
		};
		redo();
		this.host.record('New Layer', () => {
			stack.layers.splice(at, 1);
			stack.current = Math.min(was, stack.layers.length - 1);
			this.host.changed();
		}, redo);
	}

	private remove() {
		const stack = this.host.stack();
		if (!stack || stack.layers.length < 2)
			return;
		const at = stack.current, layer = stack.layer;
		const redo = () => {
			stack.layers.splice(at, 1);
			stack.current = Math.min(at, stack.layers.length - 1);
			expand(stack.layer, stack.width, stack.height);
			this.host.changed();
		};
		redo();
		this.host.record('Delete Layer', () => {
			stack.layers.splice(at, 0, layer);
			stack.current = at;
			this.host.changed();
		}, redo);
	}

	private move(direction: 1 | -1) {
		const stack = this.host.stack();
		if (!stack)
			return;
		const from = stack.current, to = from + direction;
		if (to < 0 || to >= stack.layers.length)
			return;
		const swap = (a: number, b: number) => () => {
			const t = stack.layers[a];
			stack.layers[a] = stack.layers[b];
			stack.layers[b] = t;
			stack.current = b;
			this.host.changed();
		};
		swap(from, to)();
		this.host.record(direction > 0 ? 'Raise Layer' : 'Lower Layer', swap(to, from), swap(from, to));
	}
}
