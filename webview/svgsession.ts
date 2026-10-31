// The SVG editor as a part a page can hold: a drawing kept as a DOM, shown (with scripts and outside references left out, and
// its styles and ids kept to itself) under the point editor the font viewer's glyph inspector also uses, with an outline of
// its elements and the fill and stroke of the one that is selected. The SVG editor's page is one of these, and the font
// viewer holds another for the glyphs of a colour font. Every edit hands the host the whole text of the drawing.
import { createElement, createSVGElement, SVG_NS } from '@isopodlabs/vscode_utils/webview/shared.js';
import { PathEditor, ViewOptions, svgPath, type DragHandler, type ElementTransform, type ShapeKind, type ToolChoice } from './pathedit.js';
import { float2, float2x3 } from '@isopodlabs/maths/vector';
import type { curveVertex } from '@isopodlabs/binary_fonts';
import { choiceItem, valueItem, svgFace, swatchFace, colourItems, type CascadeItem } from './cascade.js';
import { Tree } from '@isopodlabs/vscode_utils/webview/tree.js';
import { type RGB, toHex, fromHex, mixColour, clamp01 } from './colour.js';
import { Steps } from './history.js';
import { GradientEditor, cssOf, type Stop, type Spread, type Paint, type PaintMode, type PaintOptions } from './gradientedit.js';
export { cssOf, type Stop, type Spread, type Paint, type PaintMode, type PaintOptions } from './gradientedit.js';

export interface SessionUi {
	view:		HTMLElement;		// where the drawing is shown
	tree:		HTMLElement;		// the outline of the drawing's elements
	props:		HTMLElement;		// the selected element's properties
	options?:	ViewOptions;		// shared with another editor over the same place
	views?:		string[];			// view options beyond the common ones, which the menu offers
	pageItems?(): CascadeItem[];	// what the page adds to the head of the menu
	active?():	boolean;			// whether it is the one showing, where the page has another editor over the same place
	home?():	string | undefined;	// the id of the element that new shapes go in, where not the drawing's root
	guides?(X: (x: number) => number, Y: (y: number) => number, w: number, h: number): string;
}

export interface SessionBackend {
	// the drawing's text after an edit; `continues` if it is a later step of the one before (a value still being turned), which
	// changes that edit rather than being another (if it is still the last: else it is dropped, as the drawing is loaded again)
	save(text: string, label: string, continues?: boolean): void;
	// a path or basic shape as the points the editor takes
	shapePoints(name: string, attributes: Record<string, string>): Promise<curveVertex[]>;
	// the points with fewer of them, the outline kept within tol
	simplifyPoints(points: curveVertex[], tol: number): Promise<curveVertex[]>;
	// a stroke (x, y in pairs) as the points of a smooth open path that follows it to within tol
	fitStroke?(stroke: number[], tol: number): Promise<curveVertex[]>;
	status(text: string): void;
	error(message?: string): void;		// undefined takes the last one down
	// the host opens the image of an <image> element, named by its id, to be edited, and sends back what is saved (setImage)
	editImage?(id: string, href: string): void;
}

export interface Session {
	editor:		PathEditor;
	load(text: string, file: string, readOnly?: boolean): void;
	key(e: KeyboardEvent): boolean;
	setImage(id: string, href: string): void;
	hasDocument(): boolean;
}

const elementIcons = {
	element:	'<rect x="3" y="3" width="10" height="10" stroke-dasharray="2 1.5"/><rect x="1" y="1" width="3" height="3"/><rect x="12" y="12" width="3" height="3"/>',
	parent:		'<rect x="2" y="2" width="12" height="12"/><rect x="5" y="6" width="6" height="6"/>',
	duplicate:	'<rect x="2" y="2" width="8" height="8"/><rect x="6" y="6" width="8" height="8"/>',
	image:		'<rect x="2" y="3" width="12" height="10"/><circle cx="6" cy="7" r="1.3"/><path d="M3 12L7 8L10 11L12 9L14 12"/>',
	remove:		'<rect x="3" y="3" width="10" height="10"/><path d="M5 5L11 11M11 5L5 11"/>',
	order:		'<rect x="2" y="2" width="8" height="8"/><rect x="6" y="6" width="8" height="8" fill="currentColor" fill-opacity="0.4"/>',
	front:		'<rect x="2" y="2" width="8" height="8"/><rect x="6" y="6" width="8" height="8" fill="currentColor"/>',
	forward:	'<rect x="2" y="2" width="8" height="8"/><rect x="6" y="6" width="8" height="8" fill="currentColor" fill-opacity="0.4"/><path d="M12 1V4"/>',
	backward:	'<rect x="6" y="6" width="8" height="8"/><rect x="2" y="2" width="8" height="8" fill="currentColor" fill-opacity="0.4"/><path d="M4 12V15"/>',
	back:		'<rect x="6" y="6" width="8" height="8"/><rect x="2" y="2" width="8" height="8" fill="currentColor"/>',
};

export function createSession(ui: SessionUi, backend: SessionBackend): Session {
	let background = 'theme';
	const SCOPE		= 'svg-doc';			// the class of the group the drawing is shown in, which its styles are limited to
	const ID_PREFIX	= 'sd-';				// put before its ids, so they do not meet the page's own

	const treeBox	= ui.tree;
	const propsBox	= ui.props;

	const SHAPES	= new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
	// what is read as geometry, and gone from a shape that becomes a path
	const GEOMETRY	= ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'x1', 'y1', 'x2', 'y2', 'pathLength'];
	const NOT_SHOWN	= new Set(['script', 'foreignObject']);
	const num		= (n: number) => +n.toFixed(3);

	let src:		XMLDocument | undefined;
	let prolog		= '';					// the XML declaration, and the whitespace after the root, which the serialiser leaves out
	let epilog		= '';
	let fileName	= '';
	let readOnly	= false;
	let selected:	Element | undefined;	// in src
	let points:		curveVertex[] | undefined;	// the selected shape's, as the editor takes them
	let pointsD		= '';					// what they were drawn as when read
	let selectToken	= 0;
	// what the editor is doing in place of editing the points of the shape: a gradient's stops are edited on the drawing
	let mode:		SvgGradient | undefined;

	// the drawing as shown: one group, with a copy of each element that is drawn
	const display	= createSVGElement('g', {class: SCOPE});
	const dispOf	= new Map<Element, SVGElement>();
	const srcOf		= new Map<Element, Element>();

	//--- the document --------------------------------------------------------------

	function parse(text: string) {
		const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
		const error = doc.getElementsByTagName('parsererror')[0];
		if (error)
			throw new Error((error.textContent ?? 'not an SVG document').split('\n').find(l => l.trim()) ?? 'not an SVG document');
		if (doc.documentElement.localName !== 'svg')
			throw new Error('the root element is not <svg>');
		prolog = /^\s*(<\?xml[^]*?\?>)/.exec(text)?.[1] ?? '';
		epilog = /\s*$/.exec(text)?.[0] ?? '';
		return doc;
	}

	function serialise() {
		// the serialiser may put a declaration of its own at the start, which the prolog already has (or the drawing did without)
		const body = new XMLSerializer().serializeToString(src!).replace(/^\s*<\?xml[^]*?\?>\s*/, '');
		return (prolog ? prolog + '\n' : '') + body + epilog;
	}

	// An edit, saved: the drawing's text goes to the host, whose history it is. A value changed a step at a time (`key` says what it is
	// of, with the label) is one edit: its first step is saved at once, and the steps after it as changes to that edit, the drawing as
	// it is after each (so that what is done after them is not in it) sent every little while as they come, and at the `last` one.
	const steps = new Steps;
	let continuing: {label: string, text: string, timer: number} | undefined;
	const SEND = 150;

	function save(label: string, key?: unknown, last = false) {
		if (readOnly)
			return;
		if (key !== undefined && steps.step(key, label)) {
			const text = serialise();
			if (continuing)
				continuing.text = text;
			else
				continuing = {label, text, timer: window.setTimeout(sendContinuing, SEND)};
			if (last)
				endSteps();
			return;
		}
		endSteps();
		backend.save(serialise(), label);
		if (key !== undefined && !last)
			steps.step(key, label);
	}
	function sendContinuing() {
		const c = continuing;
		continuing = undefined;
		if (c) {
			clearTimeout(c.timer);
			backend.save(c.text, c.label, true);
		}
	}
	// the steps there have been are sent, and another is another edit
	function endSteps() {
		sendContinuing();
		steps.end();
	}

	const showError = (message: string) => backend.error(message);

	// an element as the indices of it and its parents among their parents' elements
	function indicesOf(e: Element) {
		const path: number[] = [];
		for (let n = e; n.parentElement; n = n.parentElement)
			path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
		return path;
	}
	function elementAt(path: number[]) {
		let e: Element | undefined = src?.documentElement;
		for (const i of path)
			e = e?.children[i];
		return e;
	}

	//--- properties, which may be attributes or in a style attribute ------------------------------

	const declarations = (style: string) => style.split(/;(?![^(]*\))/).flatMap(d => {
		const i = d.indexOf(':');
		return i > 0 ? [[d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string]] : [];
	});

	function getProp(e: Element, name: string) {
		const found = declarations(e.getAttribute('style') ?? '').filter(([k]) => k === name).pop();
		return found ? found[1] : e.getAttribute(name) ?? undefined;
	}

	// whether a rule of the drawing's styles sets a property of an element, which an attribute does not outweigh
	function ruledProp(e: Element, name: string) {
		const d = dispOf.get(e);
		if (!d)
			return false;
		const search = (rules: CSSRuleList): boolean => Array.from(rules).some(r =>
			r instanceof CSSStyleRule ? !!r.style.getPropertyValue(name) && d.matches(r.selectorText) : 'cssRules' in r && search((r as CSSGroupingRule).cssRules));
		return Array.from(document.styleSheets).some(sheet => {
			try {
				return search(sheet.cssRules);
			} catch {
				return false;
			}
		});
	}

	function setProp(e: Element, name: string, value: string | undefined) {
		const decls = declarations(e.getAttribute('style') ?? '');
		// a class that sets it wins over an attribute, so it is set in the element's own style, which wins over the class
		if (value !== undefined && !decls.some(([k]) => k === name) && ruledProp(e, name)) {
			e.setAttribute('style', [...decls.map(([k, v]) => `${k}:${v}`), `${name}:${value}`].join(';'));
			e.removeAttribute(name);
			return;
		}
		if (decls.some(([k]) => k === name)) {
			const next = decls.flatMap(([k, v]) => k !== name ? [[k, v]] : value === undefined ? [] : [[k, value]]);
			if (next.length)
				e.setAttribute('style', next.map(([k, v]) => `${k}:${v}`).join(';'));
			else
				e.removeAttribute('style');
			return;
		}
		if (value === undefined)
			e.removeAttribute(name);
		else
			e.setAttribute(name, value);
	}

	//--- showing it -------------------------------------------------------------------

	const urlRef = /url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g;

	// a rule's selector for the group the drawing is in: the whole drawing is the group, and ids are as they are shown
	const scopeSelector = (sel: string) => ('.' + SCOPE + ' ' + sel.replace(/^(:root|svg|html)\b\s*/, '')).trim().replace(/#([\w-]+)/g, `#${ID_PREFIX}$1`);

	// a drawing's stylesheet limited to the drawing, since a page's styles reach everything in it
	function scopeCss(text: string) {
		const sheet = new CSSStyleSheet();
		try {
			sheet.replaceSync(text.replace(urlRef, (_m, _q, id) => `url(#${ID_PREFIX}${id})`));
		} catch {
			return '';
		}
		const scoped = (rules: CSSRuleList): string => Array.from(rules).map(rule => {
			if (rule instanceof CSSStyleRule)
				return `${rule.selectorText.split(',').map(s => scopeSelector(s.trim())).join(',')}{${rule.style.cssText}}`;
			if (rule instanceof CSSMediaRule)
				return `@media ${rule.conditionText}{${scoped(rule.cssRules)}}`;
			if (rule instanceof CSSSupportsRule)
				return `@supports ${rule.conditionText}{${scoped(rule.cssRules)}}`;
			return rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule ? rule.cssText : '';
		}).join('\n');
		return scoped(sheet.cssRules);
	}

	// an attribute as the page shows it, or undefined for what is not shown: handlers, and references outside the drawing
	function shownValue(name: string, value: string) {
		if (/^on/i.test(name) || /javascript:/i.test(value))
			return;
		if (name === 'id')
			return ID_PREFIX + value;
		if (name === 'href' || name === 'xlink:href')
			return value.startsWith('#') ? '#' + ID_PREFIX + value.slice(1) : /^data:image\//i.test(value) ? value : undefined;
		return value.replace(urlRef, (_m, _q, id) => `url(#${ID_PREFIX}${id})`);
	}

	const ROOT_ONLY = new Set(['width', 'height', 'viewBox', 'x', 'y', 'preserveAspectRatio', 'version', 'baseProfile']);
	function copyAttributes(from: Element, to: Element) {
		const root = from === src?.documentElement;
		for (const a of Array.from(from.attributes)) {
			if (a.name === 'xmlns' || a.name.startsWith('xmlns:') || (root && ROOT_ONLY.has(a.name)))
				continue;
			const value = a.name === 'class' && root ? `${SCOPE} ${a.value}` : shownValue(a.name, a.value);
			if (value !== undefined)
				to.setAttributeNS(a.namespaceURI, a.name, value);
		}
		if (root && !to.hasAttribute('class'))
			to.setAttribute('class', SCOPE);
	}

	function syncAttributes(e: Element) {
		const d = dispOf.get(e);
		if (!d)
			return;
		for (const a of Array.from(d.attributes))
			d.removeAttributeNS(a.namespaceURI, a.localName);
		copyAttributes(e, d);
	}

	function buildNode(n: Node, parent: Element) {
		if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) {
			parent.append(document.createTextNode(n.textContent ?? ''));
			return;
		}
		const e = n as Element;
		if (n.nodeType !== Node.ELEMENT_NODE || e.namespaceURI !== SVG_NS || NOT_SHOWN.has(e.localName))
			return;
		const d = createSVGElement(e.localName);
		copyAttributes(e, d);
		parent.append(d);
		dispOf.set(e, d);
		srcOf.set(d, e);
		if (e.localName === 'style')
			d.textContent = scopeCss(e.textContent ?? '');
		else
			e.childNodes.forEach(c => buildNode(c, d));
	}

	function buildDisplay() {
		display.textContent = '';
		dispOf.clear();
		srcOf.clear();
		const root = src!.documentElement;
		dispOf.set(root, display);
		srcOf.set(display, root);
		for (const a of Array.from(display.attributes))
			display.removeAttribute(a.name);
		copyAttributes(root, display);
		root.childNodes.forEach(c => buildNode(c, display));
	}

	// one element's drawing made again from the document, for what changed in its children
	function rebuildElement(e: Element) {
		const old = dispOf.get(e);
		if (!old || old === display)
			return buildDisplay();
		const fresh = createSVGElement('g');
		buildNode(e, fresh);
		old.replaceWith(...Array.from(fresh.childNodes));
	}

	// the element of the document that a part of the drawing belongs to
	function elementOf(node: Node | null): Element | undefined {
		for (let n = node; n && n !== display.parentNode; n = n.parentNode) {
			const e = srcOf.get(n as Element);
			if (e)
				return e;
		}
	}

	//--- the elements -----------------------------------------------------------------------------

	const isShape = (e?: Element) => !!e && SHAPES.has(e.localName);
	// what editing the points of an element edits: itself if it is a shape, or the shape a <use> draws (shared with whatever else uses it)
	function shapeOf(e?: Element): Element | undefined {
		for (let hops = 0; e && hops < 8; hops++) {
			if (isShape(e))
				return e;
			e = e.localName === 'use' ? elementById(hrefOf(e)) : undefined;
		}
	}
	const attributesOf = (e: Element) => Object.fromEntries(Array.from(e.attributes).map(a => [a.name, a.value]));

	const tree = new Tree(treeBox, () => {});
	tree.enableKeyboardNavigation(() => {});
	const rows = new Map<Element, HTMLElement>();

	function labelOf(e: Element) {
		const id = e.getAttribute('id'), label = e.getAttribute('inkscape:label');
		const text = e.localName === 'text' || e.localName === 'tspan' ? ` “${(e.textContent ?? '').trim().slice(0, 24)}”` : '';
		return [label ?? (id ? '#' + id : ''), text].join('');
	}

	function buildTree() {
		rows.clear();
		treeBox.textContent = '';
		const add = (e: Element, list: HTMLElement) => {
			const children = Array.from(e.children).filter(c => dispOf.has(c));
			const line = createElement(children.length ? 'span' : 'div', {className: 'select'});
			line.append(
				createElement('span', {className: 'tree-key', textContent: e.localName}),
				createElement('span', {className: 'tree-value', textContent: labelOf(e)})
			);
			line.addEventListener('click', ev => {
				ev.stopPropagation();
				select(e);
			});
			rows.set(e, line);
			if (!children.length) {
				list.append(line);
				return;
			}
			const caret = createElement('div', {className: 'caret'});
			const kids = createElement('div', {className: 'children'});
			caret.append(line, kids);
			list.append(caret);
			children.forEach(c => add(c, kids));
			if (e === src!.documentElement)
				tree.open(caret);
		};
		add(src!.documentElement, treeBox);
		tree.fixup(treeBox);
	}

	function markTree() {
		treeBox.querySelectorAll('.select.cursor').forEach(r => r.classList.remove('cursor'));
		const row = selected && rows.get(selected);
		if (!row)
			return;
		row.classList.add('cursor');
		for (let p = row.parentElement; p && p !== treeBox; p = p.parentElement)
			if (p.classList.contains('caret'))
				tree.open(p);
		row.scrollIntoView({block: 'nearest'});
	}

	//--- the matrix of an element into the drawing's own space ----------------------------------------

	const fromDOM = (m: DOMMatrixReadOnly) => float2x3(float2(m.a, m.b), float2(m.c, m.d), float2(m.e, m.f));

	function worldMatrix(d: SVGElement | undefined) {
		const a = editor.svg.getScreenCTM(), b = (d as SVGGraphicsElement | undefined)?.getScreenCTM?.();
		if (!a || !b)
			return float2x3.identity();
		const v = editor.view;
		return fromDOM(new DOMMatrix().translate(v.t.x, v.t.y).scale(v.s).inverse().multiply(a.inverse().multiply(b)));
	}

	// the transform an element has, as a matrix
	function transformOf(d: SVGElement) {
		const m = (d as SVGGraphicsElement).transform?.baseVal?.consolidate()?.matrix;
		return m ? fromDOM(m) : float2x3.identity();
	}

	function transformText(m: float2x3) {
		const [a, b, c, d, e, f] = [m.x.x, m.x.y, m.y.x, m.y.y, m.z.x, m.z.y].map(num);
		if (a === 1 && b === 0 && c === 0 && d === 1)
			return e === 0 && f === 0 ? undefined : `translate(${e} ${f})`;
		return `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
	}

	// a matrix as a translation, a rotation (degrees) and a scale, applied in the order scale, rotate, translate; undefined if
	// it has a shear, which they cannot say
	function decompose(m: float2x3) {
		const a = m.x.x, b = m.x.y, c = m.y.x, d = m.y.y, det = a * d - b * c, sx = Math.hypot(a, b);
		if (sx < 1e-9 || Math.abs(det) < 1e-9)
			return;
		const sy = det / sx;
		if (Math.abs(a * c + b * d) > 1e-6 * sx * Math.abs(sy))
			return;
		return {x: m.z.x, y: m.z.y, rotate: Math.atan2(b, a) * 180 / Math.PI, sx, sy};
	}
	function compose(t: {x: number, y: number, rotate: number, sx: number, sy: number}) {
		const r = t.rotate * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
		return float2x3(float2(t.sx * cos, t.sx * sin), float2(-t.sy * sin, t.sy * cos), float2(t.x, t.y));
	}

	// the displacement of a world distance in the space an element's transform is in, which is its parent's
	function inParent(e: Element, d: float2) {
		return worldMatrix(dispOf.get(e)?.parentNode as SVGElement | undefined).inverse().mulDir(d);
	}

	// `by` is what is applied to the element in its parent's space, which is a move of `d` in the world if none is given
	// puts the selected element's transform, as it is now, into the properties that show it
	let refreshTransform: (() => void) | undefined;
	let refreshStrokeWidth: (() => void) | undefined;

	function moveElement(e: Element, d: float2, label?: string, base?: float2x3, by?: float2x3) {
		const disp = dispOf.get(e);
		if (readOnly || !disp || e === src!.documentElement)
			return;
		const text = transformText((by ?? float2.translate(inParent(e, d))).mulAffine(base ?? transformOf(disp)));
		if (label)
			(text === undefined ? e.removeAttribute('transform') : e.setAttribute('transform', text));
		syncAttributes(e);
		if (!label)
			disp.setAttribute('transform', text ?? '');
		else {
			save(label);
			showProps();		// its transform is one of them
		}
		// the points and outline follow the element as it goes, and so do its properties
		refreshTransform?.();
		updateMatrix();
		editor.draw();
	}

	//--- gradients ------------------------------------------------------------------------------

	const GRADIENTS		= new Set(['linearGradient', 'radialGradient']);
	const idOfUrl		= (value?: string) => value ? /^url\(\s*['"]?#([^)'"]+)/.exec(value)?.[1] : undefined;
	const elementById	= (id?: string) => id ? src!.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`) ?? undefined : undefined;
	const hrefOf		= (e: Element) => (e.getAttribute('href') ?? e.getAttribute('xlink:href') ?? '').replace(/^#/, '');
	const gradientOf	= (value?: string) => {
		const e = elementById(idOfUrl(value));
		return e && GRADIENTS.has(e.localName) ? e : undefined;
	};

	// the gradient that has the stops, which one may take from another it refers to
	function stopHolder(g: Element) {
		for (let e: Element | undefined = g, hops = 0; e && hops < 16; e = elementById(hrefOf(e)), hops++)
			if (Array.from(e.children).some(c => c.localName === 'stop'))
				return e;
	}

	function readStops(g: Element): Stop[] {
		return Array.from(stopHolder(g)?.children ?? []).filter(c => c.localName === 'stop').map(s => {
			const offset = getProp(s, 'offset') ?? '0';
			const c = parseColour(getProp(s, 'stop-color') ?? '#000000');
			return {
				offset: clamp01(offset.endsWith('%') ? parseFloat(offset) / 100 : parseFloat(offset) || 0),
				color: c?.color ?? {r: 0, g: 0, b: 0},
				opacity: (c?.opacity ?? 1) * (parseFloat(getProp(s, 'stop-opacity') ?? '1')),
			};
		});
	}

	function references(id: string) {
		const re = new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
		return Array.from(src!.querySelectorAll('*')).filter(e => Array.from(e.attributes).some(a => re.test(a.value)));
	}

	function uniqueId(base: string) {
		for (let i = 1; ; i++)
			if (!elementById(base + i))
				return base + i;
	}

	function defsOf() {
		const root = src!.documentElement;
		let defs = Array.from(root.children).find(c => c.localName === 'defs');
		if (!defs) {
			defs = createSVGElement('defs', undefined, undefined, src!);
			root.insertBefore(defs, root.firstElementChild);
		}
		return defs;
	}

	const GEOMETRY_ATTRIBUTES = ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod'];

	// a gradient that only this element's property uses, and that has its own stops: edits to it reach nothing else
	function ownGradient(e: Element, prop: string) {
		let g = gradientOf(getProp(e, prop));
		if (!g)
			return;
		const id = g.getAttribute('id')!;
		if (references(id).some(r => r !== e && !(r.localName === 'stop'))) {
			const copy = g.cloneNode(true) as Element;
			copy.setAttribute('id', uniqueId(g.localName));
			g.after(copy);
			setProp(e, prop, `url(#${copy.getAttribute('id')})`);
			g = copy;
		}
		const holder = stopHolder(g);
		if (holder !== g) {
			// what it takes from the gradient it refers to comes into it
			for (let h: Element | undefined = elementById(hrefOf(g)); h; h = elementById(hrefOf(h)))
				for (const a of GEOMETRY_ATTRIBUTES)
					if (!g.hasAttribute(a) && h.hasAttribute(a) && h.localName === g.localName)
						g.setAttribute(a, h.getAttribute(a)!);
			for (const s of readStops(g))
				g.append(stopElement(s));
			g.removeAttribute('href');
			g.removeAttribute('xlink:href');
		}
		return g;
	}

	function stopElement(s: Stop) {
		return createSVGElement('stop', {offset: num(s.offset), 'stop-color': toHex(s.color), 'stop-opacity': s.opacity !== 1 ? num(s.opacity) : undefined}, undefined, src!);
	}

	// the paint a gradient is, for the controls
	function gradientPaint(g: Element): Paint {
		const spread = g.getAttribute('spreadMethod');
		return {type: g.localName === 'radialGradient' ? 'radial' : 'linear', stops: readStops(g), spread: spread === 'reflect' || spread === 'repeat' ? spread : 'pad'};
	}

	// an attribute of a gradient, or of the ones it refers to when it has none
	function inherited(g: Element, name: string, sameType = false) {
		for (let h: Element | undefined = g, hops = 0; h && hops < 16; h = elementById(hrefOf(h)), hops++)
			if (h.hasAttribute(name) && (!sameType || h.localName === g.localName))
				return h.getAttribute(name)!;
	}

	// the handles of a gradient and the matrix from its space to the shape's: its points (start and end, or centre, a place a radius
	// away and the focus), in its own units, which are fractions of the shape's box unless it says otherwise
	function gradientHandles(e: Element, g: Element) {
		const objectUnits = (inherited(g, 'gradientUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
		const box = (dispOf.get(e) as SVGGraphicsElement).getBBox();
		const vb = viewBoxOf();
		const at = (name: string, fallback: number, size: number) => {
			const v = inherited(g, name, true);
			return v === undefined ? fallback : v.endsWith('%') ? parseFloat(v) / 100 * (objectUnits ? 1 : size) : parseFloat(v) || 0;
		};
		const [w, h, diagonal] = [vb.w, vb.h, Math.hypot(vb.w, vb.h) / Math.SQRT2];
		const points = g.localName === 'linearGradient'
			? [float2(at('x1', 0, w), at('y1', 0, h)), float2(at('x2', objectUnits ? 1 : w, w), at('y2', 0, h))]
			: (() => {
				const cx = at('cx', objectUnits ? 0.5 : w / 2, w), cy = at('cy', objectUnits ? 0.5 : h / 2, h), r = at('r', objectUnits ? 0.5 : diagonal / 2, diagonal);
				return [float2(cx, cy), float2(cx + r, cy), float2(at('fx', cx, w), at('fy', cy, h))];
			})();
		const transform = createSVGElement('g', {transform: inherited(g, 'gradientTransform') ?? ''});
		return {points, matrix: (objectUnits ? float2x3(float2(box.width, 0), float2(0, box.height), float2(box.x, box.y)) : float2x3.identity()).mulAffine(transformOf(transform))};
	}

	// a gradient's geometry written from handles
	function setHandles(g: Element, p: float2[]) {
		const set = (name: string, v: number | undefined) => v === undefined ? g.removeAttribute(name) : g.setAttribute(name, String(+v.toFixed(5)));
		if (g.localName === 'linearGradient') {
			set('x1', p[0].x);
			set('y1', p[0].y);
			set('x2', p[1].x);
			set('y2', p[1].y);
			return;
		}
		const focused = p[2].sub(p[0]).len() > 1e-9;
		set('cx', p[0].x);
		set('cy', p[0].y);
		set('r', p[1].sub(p[0]).len());
		set('fx', focused ? p[2].x : undefined);
		set('fy', focused ? p[2].y : undefined);
	}

	function enterGradient(e: Element, prop: 'fill' | 'stroke', stop = 0) {
		const g = gradientOf(getProp(e, prop));
		if (!g)
			return;
		const {points: p, matrix} = gradientHandles(e, g);
		mode = new SvgGradient(prop, p, matrix, stop);
		updateMatrix();
		editor.reset();
		editor.draw();
	}

	function exitGradient() {
		mode = undefined;
		updateMatrix();
		editor.reset();
		editor.draw();
	}

	// a gradient made for an element: across its box, in the element's own units
	function newGradient(e: Element, type: 'linear' | 'radial', stops: Stop[]) {
		const box = (dispOf.get(e) as SVGGraphicsElement | undefined)?.getBBox?.() ?? new DOMRect(0, 0, 100, 100);
		const g = createSVGElement(type + 'Gradient', {id: uniqueId(type + 'Gradient'), gradientUnits: 'userSpaceOnUse'}, undefined, src!);
		const cx = num(box.x + box.width / 2), cy = num(box.y + box.height / 2);
		if (type === 'linear') {
			g.setAttribute('x1', String(num(box.x)));
			g.setAttribute('y1', String(cy));
			g.setAttribute('x2', String(num(box.x + box.width)));
			g.setAttribute('y2', String(cy));
		} else {
			g.setAttribute('cx', String(cx));
			g.setAttribute('cy', String(cy));
			g.setAttribute('r', String(num(Math.max(box.width, box.height) / 2) || 50));
		}
		stops.forEach(s => g.append(stopElement(s)));
		defsOf().append(g);
		return g;
	}

	// gradients nothing refers to are taken out of the document
	function dropUnused(g?: Element) {
		if (g && GRADIENTS.has(g.localName) && g.getAttribute('id') && !references(g.getAttribute('id')!).length) {
			const holder = elementById(hrefOf(g));
			g.remove();
			dropUnused(holder);
		}
	}

	//--- fill and stroke -------------------------------------------------------------------------

	function paintOptions(e: Element, prop: 'fill' | 'stroke'): PaintOptions {
		const d = dispOf.get(e)!;
		const modes: PaintOptions['modes'] = ['unset', 'none', 'color', 'linear', 'radial'];
		return {
			label: prop === 'fill' ? 'Fill' : 'Stroke',
			modes,
			get(): Paint {
				const v = getProp(e, prop);
				if (v === undefined)
					return {type: 'unset', effective: getComputedStyle(d)[prop]};
				if (v === 'none')
					return {type: 'none'};
				const g = gradientOf(v);
				if (g)
					return gradientPaint(g);
				const c = parseColour(v);
				return c ? {type: 'color', color: c.color} : {type: 'other', text: v};
			},
			set(paint, final) {
				const gradient = 'stops' in paint;
				if (mode && !gradient)
					exitGradient();
				const old = gradientOf(getProp(e, prop));
				if (gradient) {
					let g = ownGradient(e, prop);
					const type = paint.type + 'Gradient';
					if (!g || g.localName !== type) {
						g = newGradient(e, paint.type, paint.stops);
						setProp(e, prop, `url(#${g.getAttribute('id')})`);
						dropUnused(old);
					} else {
						const holder = stopHolder(g) ?? g;
						Array.from(holder.children).filter(c => c.localName === 'stop').forEach(c => c.remove());
						paint.stops.forEach(s => holder.append(stopElement(s)));
						if (paint.spread === 'pad')
							g.removeAttribute('spreadMethod');
						else
							g.setAttribute('spreadMethod', paint.spread);
					}
					syncAttributes(e);
					rebuildElement(defsOf());
				} else {
					setProp(e, prop, paint.type === 'unset' ? undefined : paint.type === 'none' ? 'none' : paint.type === 'color' ? toHex(paint.color) : paint.text);
					syncAttributes(e);
					if (old) {
						dropUnused(old);
						rebuildElement(defsOf());
					}
				}
				save(`Change ${prop}`, e, final);
				if (final)
					showProps();
			},
			handles: {
				get: () => mode?.prop === prop,
				set: on => on ? enterGradient(e, prop) : exitGradient(),
			},
			opacity: {
				get: () => parseFloat(getProp(e, prop + '-opacity') ?? '1'),
				set(v, final) {
					setProp(e, prop + '-opacity', v === 1 ? undefined : String(v));
					syncAttributes(e);
					save(`Change ${prop} opacity`, e, final);
				},
			},
		};
	}

	//--- the properties of what is selected ------------------------------------------------------------

	function field(label: string, input: HTMLElement) {
		const row = createElement('label', {className: 'prop-row'});
		row.append(createElement('span', {textContent: label}), input);
		return row;
	}

	function textInput(value: string, apply: (v: string) => void, placeholder = '') {
		const input = createElement('input', {type: 'text', value, placeholder, spellcheck: false});
		input.addEventListener('change', () => apply(input.value.trim()));
		return input;
	}

	function selectInput(value: string, choices: string[], apply: (v: string) => void) {
		const select = createElement('select');
		for (const c of ['', ...choices])
			select.add(new Option(c || '(default)', c, false, c === value));
		select.addEventListener('change', () => apply(select.value));
		return select;
	}

	// a property set from a control, drawn and recorded
	function setAndSave(e: Element, name: string, value: string | undefined, label = `Change ${name}`) {
		setProp(e, name, value || undefined);
		syncAttributes(e);
		save(label);
		editor.draw();
	}

	// a property that is being adjusted a step at a time (a wheel, a drag): drawn and shown in its panel field as it changes, and
	// the steps one edit
	function adjustProp(e: Element, name: string, value: string | undefined, label: string) {
		setProp(e, name, value || undefined);
		syncAttributes(e);
		editor.draw();
		refreshStrokeWidth?.();
		save(label, e);
	}

	function showProps() {
		buildProps();
		if (readOnly)
			propsBox.querySelectorAll<HTMLInputElement>('input, select, button').forEach(x => { x.disabled = true; });
	}

	function buildProps() {
		propsBox.textContent = '';
		const heading = createElement('div', {className: 'tree-heading'});
		propsBox.append(heading);
		const root = src?.documentElement;
		if (!src || !root)
			return;
		const e = selected;
		if (!e || e === root) {
			heading.textContent = 'Document';
			for (const name of ['width', 'height', 'viewBox'])
				propsBox.append(field(name, textInput(root.getAttribute(name) ?? '', v => {
					if (v)
						root.setAttribute(name, v);
					else
						root.removeAttribute(name);
					save(`Change ${name}`);
					editor.draw();
					if (name === 'viewBox')
						editor.fit();
				})));
			if (!e)
				return;
		}
		heading.textContent = e === root ? 'Document' : `<${e.localName}>`;
		propsBox.append(field('id', textInput(e.getAttribute('id') ?? '', v => {
			const old = e.getAttribute('id');
			if (v && elementById(v) && v !== old)
				return showError(`the id ${v} is already used`);
			if (old && v !== old)
				for (const r of references(old)) {
					for (const a of Array.from(r.attributes))
						r.setAttribute(a.name, a.value.replace(new RegExp(`#${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), `#${v}`));
					syncAttributes(r);
				}
			if (v)
				e.setAttribute('id', v);
			else
				e.removeAttribute('id');
			syncAttributes(e);
			save('Change id');
			buildTree();
			markTree();
		})));
		refreshTransform = refreshStrokeWidth = undefined;
		if (e !== root) {
			const raw = textInput(e.getAttribute('transform') ?? '', v => {
				setProp(e, 'transform', v || undefined);
				syncAttributes(e);
				save('Change transform');
				updateMatrix();
				editor.draw();
				refreshTransform?.();
			}, 'translate(0 0)');
			propsBox.append(field('transform', raw));
			// the same transform as a translation, a rotation and a scale, which show it as it changes
			const names = ['x', 'y', 'rotate', 'sx', 'sy'] as const;
			const boxes = names.map(name => {
				const input = textInput('', v => {
					const d = dispOf.get(e), t = d && decompose(transformOf(d)), n = parseFloat(v);
					if (!t || !isFinite(n))
						return refreshTransform?.();
					t[name] = n;
					const text = transformText(compose(t));
					setProp(e, 'transform', text);
					syncAttributes(e);
					save('Change transform');
					updateMatrix();
					editor.draw();
					refreshTransform?.();
				});
				input.inputMode = 'decimal';
				return input;
			});
			const pair = (a: HTMLInputElement, b: HTMLInputElement) => {
				const box = createElement('div', {className: 'prop-pair'});
				box.append(a, b);
				return box;
			};
			propsBox.append(field('translate', pair(boxes[0], boxes[1])), field('rotate', boxes[2]), field('scale', pair(boxes[3], boxes[4])));
			refreshTransform = () => {
				const d = dispOf.get(e), m = d ? transformOf(d) : float2x3.identity(), t = decompose(m);
				const shown = (n: number) => String(+n.toFixed(3));
				if (document.activeElement !== raw)
					raw.value = d?.getAttribute('transform') ?? '';
				boxes.forEach((box, i) => {
					box.disabled = readOnly || !t;
					box.placeholder = t ? '' : 'skewed';
					if (document.activeElement !== box)
						box.value = t ? shown(t[names[i]]) : '';
				});
			};
			refreshTransform();
		}
		if (e.localName !== 'defs' && e !== root)
			propsBox.append(field('opacity', textInput(getProp(e, 'opacity') ?? '', v => setAndSave(e, 'opacity', v), '1')));

		const strokeWidth = textInput('', v => setAndSave(e, 'stroke-width', v));
		refreshStrokeWidth = () => {
			strokeWidth.placeholder = getComputedStyle(dispOf.get(e)!).strokeWidth;
			if (document.activeElement !== strokeWidth)
				strokeWidth.value = getProp(e, 'stroke-width') ?? '';
		};
		refreshStrokeWidth();
		propsBox.append(
			paintControl(paintOptions(e, 'fill')),
			field('fill rule', selectInput(getProp(e, 'fill-rule') ?? '', ['nonzero', 'evenodd'], v => setAndSave(e, 'fill-rule', v))),
			paintControl(paintOptions(e, 'stroke')),
			field('stroke width', strokeWidth),
			field('line cap', selectInput(getProp(e, 'stroke-linecap') ?? '', ['butt', 'round', 'square'], v => setAndSave(e, 'stroke-linecap', v))),
			field('line join', selectInput(getProp(e, 'stroke-linejoin') ?? '', ['miter', 'round', 'bevel'], v => setAndSave(e, 'stroke-linejoin', v))),
			field('dashes', textInput(getProp(e, 'stroke-dasharray') ?? '', v => setAndSave(e, 'stroke-dasharray', v), 'none')),
		);
	}

	//--- editing the structure ------------------------------------------------------------------

	// the document changed in its structure: all of it is shown again, with the same element selected (or the one given)
	function restructure(label: string, then?: Element) {
		const keep = then ?? (selected && src!.contains(selected) ? selected : undefined);
		buildDisplay();
		buildTree();
		save(label);
		select(keep);
	}

	function deleteElement(e = selected) {
		if (readOnly || !e?.parentElement)
			return;
		e.remove();
		selected = undefined;
		restructure('Delete element');
	}

	// an <image> whose picture is in the drawing itself, as the host can open it to edit
	const hrefAttribute = (e: Element) => Array.from(e.attributes).find(a => a.localName === 'href');
	const editableImage = (e: Element) => e.localName === 'image' && /^data:image\/(png|jpeg);base64,/i.test(hrefAttribute(e)?.value.trim() ?? '');

	function editImage(e: Element) {
		let id = e.getAttribute('id');
		// the host finds the image again by its id, which an element may not have had
		if (!id) {
			let n = 1;
			while (src!.querySelector(`[id="image-${n}"]`))
				n++;
			e.setAttribute('id', id = `image-${n}`);
			syncAttributes(e);
			save('Name image');
		}
		backend.editImage!(id, hrefAttribute(e)!.value.trim());
	}

	function setImage(id: string, href: string) {
		const e = src?.querySelector(`[id="${id}"]`), a = e && hrefAttribute(e);
		if (!e || !a)
			return;
		a.value = href;
		syncAttributes(e);
		save('Edit image');
		editor.draw();
	}

	function duplicateElement(e = selected) {
		if (readOnly || !e?.parentElement)
			return;
		const copy = e.cloneNode(true) as Element;
		copy.removeAttribute('id');
		copy.querySelectorAll('[id]').forEach(c => c.removeAttribute('id'));
		e.after(copy);
		restructure('Duplicate element', copy);
	}

	function reorder(e: Element, to: 'front' | 'forward' | 'backward' | 'back') {
		const parent = e.parentElement;
		if (readOnly || !parent)
			return;
		if (to === 'front')
			parent.append(e);
		else if (to === 'back')
			parent.insertBefore(e, parent.firstElementChild);
		else if (to === 'forward' && e.nextElementSibling)
			e.nextElementSibling.after(e);
		else if (to === 'backward' && e.previousElementSibling)
			e.previousElementSibling.before(e);
		else
			return;
		restructure('Change order', e);
	}

	// a shape that is not a path becomes one, as it is when its points are edited; the new element is the selected one
	function ensurePath(e: Element) {
		if (e.localName === 'path')
			return e;
		const path = createSVGElement('path', undefined, undefined, src!);
		for (const a of Array.from(e.attributes))
			if (!GEOMETRY.includes(a.name))
				path.setAttributeNS(a.namespaceURI, a.name, a.value);
		e.replaceWith(path);
		const d = dispOf.get(e);
		const fresh = createSVGElement('path');
		d?.replaceWith(fresh);
		dispOf.delete(e);
		srcOf.delete(d!);
		dispOf.set(path, fresh);
		srcOf.set(fresh, path);
		if (selected === e)
			selected = path;
		syncAttributes(path);
		buildTree();
		markTree();
		return path;
	}

	function viewBoxOf() {
		const root = src!.documentElement, vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
		if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0)
			return {x: vb[0], y: vb[1], w: vb[2], h: vb[3]};
		const w = parseFloat(root.getAttribute('width') ?? ''), h = parseFloat(root.getAttribute('height') ?? '');
		if (w > 0 && h > 0)
			return {x: 0, y: 0, w, h};
		const b = display.getBBox();
		return b.width > 0 && b.height > 0 ? {x: b.x, y: b.y, w: b.width, h: b.height} : {x: 0, y: 0, w: 100, h: 100};
	}

	//--- drawing freehand ------------------------------------------------------------------------

	let lineChain: {e: Element, start: float2, end: float2, segments: number} | undefined;		// the line being continued, and where it ends in world units
	let stroke: float2[] | undefined;		// the one being drawn, in world units

	// the stroke as a path in the selected group (or the drawing), following it to within two pixels
	async function drawStroke(world: float2[]) {
		if (!src || readOnly || world.length < 2)
			return;
		const parent = newParent();
		const to = worldMatrix(dispOf.get(parent)).inverse();
		const local = world.map(w => to.mulPos(w));
		const unit = Math.sqrt(Math.abs(to.det())) / editor.view.s;		// a pixel of the screen, in the parent's units
		try {
			const points = await backend.fitStroke!(local.flatMap(p => [p.x, p.y]), 2 * unit);
			if (points.length < 2)
				return;
			const e = createSVGElement('path', {
				d: svgPath(points), fill: 'none', stroke: '#4c8bf5', 'stroke-width': num(2 * unit), 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
			}, undefined, src);
			parent.append(e);
			restructure('Draw path', e);
		} catch (error: any) {
			showError(String(error?.message ?? error));
		}
	}

	// where a new element goes: in the group selected, or else where the page says (the part of the drawing that is its own to
	// edit, as a glyph's is within a font's SVG table) or the drawing's root
	function newParent() {
		const root = src!.documentElement, home = ui.home?.();
		const inside = home ? elementById(home) : undefined;
		return selected && selected !== root && selected.localName === 'g' ? selected : inside ?? (selected?.localName === 'svg' ? selected : root);
	}

	function addDragged(kind: ShapeKind, a: float2, b: float2) {
		if (!src || readOnly)
			return;
		// a line that goes on adds a segment to the path it began, or closes it where it came back to its beginning
		if (kind === 'line' && lineChain && src.contains(lineChain.e)) {
			const c = lineChain, e = c.e, q = worldMatrix(dispOf.get(e.parentElement!)).inverse().mulPos(b);
			if (c.segments >= 2 && b.sub(c.start).len() * editor.view.s < 6) {
				e.setAttribute('d', `${e.getAttribute('d')}Z`);
				lineChain = undefined;
				restructure('Close line', e);
				return;
			}
			e.setAttribute('d', `${e.getAttribute('d')}L${num(q.x)} ${num(q.y)}`);
			c.end = b;
			c.segments++;
			restructure('Extend line', e);
			return;
		}
		const parent = newParent();
		const to = worldMatrix(dispOf.get(parent)).inverse();
		const unit = Math.sqrt(Math.abs(to.det())) / editor.view.s;		// a pixel of the screen, in the parent's units
		const p = to.mulPos(a), q = to.mulPos(b);
		if (q.sub(p).len() < 2 * unit)
			return;
		const e = createSVGElement(kind === 'line' ? 'path' : kind, undefined, undefined, src);
		const set = (name: string, v: number) => e.setAttribute(name, String(num(v)));
		if (kind === 'rect') {
			set('x', Math.min(p.x, q.x));
			set('y', Math.min(p.y, q.y));
			set('width', Math.abs(q.x - p.x));
			set('height', Math.abs(q.y - p.y));
		} else if (kind === 'ellipse') {
			set('cx', (p.x + q.x) / 2);
			set('cy', (p.y + q.y) / 2);
			set('rx', Math.abs(q.x - p.x) / 2);
			set('ry', Math.abs(q.y - p.y) / 2);
		} else
			e.setAttribute('d', `M${num(p.x)} ${num(p.y)}L${num(q.x)} ${num(q.y)}`);
		if (kind === 'line') {
			e.setAttribute('fill', 'none');
			e.setAttribute('stroke', '#4c8bf5');
			e.setAttribute('stroke-width', String(num(2 * unit)));
			e.setAttribute('stroke-linecap', 'round');
		} else
			e.setAttribute('fill', '#4c8bf5');
		parent.append(e);
		lineChain = kind === 'line' ? {e, start: a, end: b, segments: 1} : undefined;
		restructure(`Draw ${kind}`, e);
	}

	//--- selecting -----------------------------------------------------------------------------------

	async function select(e: Element | undefined) {
		selected = e && src!.contains(e) ? e : undefined;
		if (selected !== lineChain?.e)
			lineChain = undefined;
		mode = undefined;
		const token = ++selectToken;
		editor.reset();
		points = undefined;
		pointsD = '';
		markTree();
		showProps();
		updateMatrix();
		editor.draw();
		const shape = shapeOf(selected);
		if (!shape)
			return;
		try {
			const result = await backend.shapePoints(shape.localName, attributesOf(shape));
			if (token !== selectToken)
				return;
			points = result;
			pointsD = svgPath(points);
			updateMatrix();
			editor.draw();
		} catch (error: any) {
			showError(String(error?.message ?? error));
		}
	}

	function updateMatrix() {
		let m = selected ? worldMatrix(dispOf.get(selected)) : float2x3.identity();
		const shape = shapeOf(selected);
		if (selected && shape && shape !== selected) {
			// a <use> places what it draws by its x and y, and that has a transform of its own
			const at = float2.translate(float2(parseFloat(selected.getAttribute('x') ?? '0') || 0, parseFloat(selected.getAttribute('y') ?? '0') || 0));
			const own = dispOf.get(shape);
			m = m.mulAffine(at).mulAffine(own ? transformOf(own) : float2x3.identity());
		}
		editor.matrix = mode ? m.mulAffine(mode.matrix) : m;
	}

	//--- the editor ---------------------------------------------------------------------------------------

	let lastStatus = '';

	//--- menus for colours and gradient stops -------------------------------------------------------------------

	// Editing a gradient is a mode of the editor, not more of editing a shape: the stops are shown along the gradient's axis in
	// place of the shape's points, and the pointer, the menu and the status are for them. A gradient is in its own space, which
	// `matrix` takes to the shape's; `points` are its start and end (or centre, a place a radius away and the focus) in it.
	// the gradient being edited, kept in the drawing as attributes
	class SvgGradient extends GradientEditor {
		private saved:	float2[];
		constructor(readonly prop: 'fill' | 'stroke', points: float2[], matrix: float2x3, stop = 0) {
			super(prop, points, matrix, () => editor.draw(), stop);
			this.saved = points.slice();
		}

		options() { return selected ? paintOptions(selected, this.prop) : undefined; }

		// the gradient's geometry, written where it belongs and recorded
		commit() {
			const g = selected && ownGradient(selected, this.prop);
			if (g) {
				setHandles(g, this.points);
				syncAttributes(selected!);
				rebuildElement(defsOf());
				save('Move gradient');
				enterGradient(selected!, this.prop, this.stop);
			}
		}

		// the gradient as shown while its geometry changes
		updateContent() {
			const g = selected && gradientOf(getProp(selected, this.prop)), shown = g && dispOf.get(g);
			const p = this.points, was = this.saved;
			// the focus goes with the centre, and so does the place that sets the radius
			const same = (a: float2, b: float2) => a.x === b.x && a.y === b.y;
			if (g?.localName === 'radialGradient' && !same(p[0], was[0]) && same(p[1], was[1])) {
				const moved = p[0].sub(was[0]);
				p[1] = p[1].add(moved);
				p[2] = p[2].add(moved);
			}
			this.saved = p.slice();
			if (g && shown)
				setHandles(shown, p);
		}
	}

	class SvgPath extends PathEditor {
		constructor() {
			super(ui.view, ui.options);
			this.extraViews = ui.views ?? [];
			this.cubic = true;
			this.rounding = 0;
			this.content.append(display);
		}

		// a gradient's stops are what is shown for it, not points
		points() { return mode ? undefined : points; }
		simplifyPoints(points: curveVertex[], tol: number) { return backend.simplifyPoints(points, tol); }
		canEdit() { return !readOnly && !mode && !!points && !!shapeOf(selected); }
		protected structural() { return !mode; }
		active() { return !!src && (ui.active?.() ?? true); }
		protected guides(X: (x: number) => number, Y: (y: number) => number, w: number, h: number) { return ui.guides?.(X, Y, w, h) ?? ''; }
		status(text: string) {
			if (text !== lastStatus)
				backend.status(lastStatus = text);
		}

		commit(label: string, key?: string) {
			if (mode)
				return mode.commit();
			if (!selected || !points)
				return;
			const e = ensurePath(shapeOf(selected)!);
			e.setAttribute('d', svgPath(points));
			pointsD = svgPath(points);
			syncAttributes(e);
			save(label, key === undefined ? undefined : `${indicesOf(selected).join('.')} ${key}`);
			updateMatrix();
		}

		bounds() {
			const v = viewBoxOf();
			return float2.extent.fromSize(float2(v.x, v.y), float2(v.w, v.h));
		}

		// the drawing is shown as the points are edited, which a shape that is not yet a path becomes
		protected updateContent() {
			if (mode)
				return mode.updateContent();
			if (!selected || !points || !this.canEdit())
				return;
			const d = svgPath(points);
			if (d === pointsD)
				return;
			pointsD = d;
			const e = ensurePath(shapeOf(selected)!);
			dispOf.get(e)?.setAttribute('d', d);
			updateMatrix();
		}

		protected paper(X: (x: number) => number, Y: (y: number) => number) {
			const v = viewBoxOf(), s = this.view.s;
			const fill = {theme: 'none', white: '#fff', black: '#000', checker: 'url(#svg-checker)'}[background] ?? 'none';
			return `<defs><pattern id="svg-checker" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#fff"/><rect width="8" height="8" fill="#ccc"/><rect x="8" y="8" width="8" height="8" fill="#ccc"/></pattern></defs>`
				+ `<rect class="svg-paper" x="${num(X(v.x))}" y="${num(Y(v.y))}" width="${num(v.w * s)}" height="${num(v.h * s)}" fill="${fill}"/>`;
		}

		// what is not a shape that has points is marked by its box
		protected overlay() {
			if (mode)
				return mode.overlay(this);
			if (stroke?.length) {
				return `<path class="insp-draw" d="M${stroke.map(w => { const p = this.worldToScreen(w); return `${num(p.x)},${num(p.y)}`; }).join('L')}" fill="none"/>`;
			}
			const d = selected && selected !== src?.documentElement && !points && !shapeOf(selected) ? dispOf.get(selected) as SVGGraphicsElement | undefined : undefined;
			const box = d?.getBBox?.();
			if (!box)
				return '';
			const corners = float2.extent.fromSize(float2(box.x, box.y), float2(box.width, box.height)).corners()
				.map(c => { const p = this.toScreen(c); return `${num(p.x)},${num(p.y)}`; });
			return `<path class="insp-selected" d="M${corners.join('L')}Z" fill="none"/>`;
		}

		describe() {
			const e = selected;
			if (mode)
				return mode.describe();
			if (!e || e === src?.documentElement) {
				const v = viewBoxOf();
				return `${fileName} · ${num(v.w)} × ${num(v.h)} · click a shape to edit it`;
			}
			const p = points;
			return [
				`<${e.localName}>${e.getAttribute('id') ? ' #' + e.getAttribute('id') : ''}`,
				p ? `${p.length} points, ${p.filter(v => v.flags === 0).length} contours` : '',
				shapeOf(e) ? (e.localName === 'use' ? 'edits the shape it draws, wherever else that is used' : e.localName === 'path' ? 'drag a point to edit; right-click for more' : 'editing its points makes it a path') : 'drag to move it',
			].filter(Boolean).join(' · ');
		}

		protected canDraw() { return !readOnly; }
		protected lineContinues() { return lineChain && src?.contains(lineChain.e) ? lineChain.end : undefined; }
		protected endChain() {
			const was = !!lineChain;
			lineChain = undefined;
			return super.endChain() || was;
		}
		protected toolChanged() {
			lineChain = undefined;
			super.toolChanged();
		}
		protected shapeKinds(): ShapeKind[] { return ['rect', 'ellipse', 'line']; }
		protected extraTools(): ToolChoice[] {
			return backend.fitStroke ? [{value: 'freehand', face: svgFace('<path d="M2 13C4 4 7 4 8 8S12 12 14 3"/>'), caption: 'Freehand (Shift moves the view)'}] : [];
		}
		protected addShape(kind: ShapeKind, a: float2, b: float2) { addDragged(kind, a, b); }

		protected defaultSize() {
			const v = viewBoxOf();
			return Math.min(v.w, v.h) / 5;
		}
		protected readOnlyReason() {
			return readOnly ? 'this drawing is read only' : 'only paths and basic shapes have points to edit';
		}

		protected draggable(target: Element) {
			const hit = elementOf(target);
			return !readOnly && !!hit && hit !== src?.documentElement;
		}

		// A free transform started from the menu over the element (not over its points or outline) changes its transform, as
		// dragging it does, so that a rect stays a rect.
		protected beginElementTransform(): ElementTransform | undefined {
			const e = selected, d = e && dispOf.get(e);
			if (readOnly || mode || !e || !d || e === src?.documentElement)
				return;
			const base = transformOf(d), parent = worldMatrix(d.parentNode as SVGElement), inv = parent.inverse();
			// the matrix is of the world, so it is taken to the element's parent's space and back
			return (m, label) => moveElement(e, float2(0, 0), label, base, inv.mulAffine(m).mulAffine(parent));
		}

		// a press on a drawn element selects it, and drags it if it goes on to move
		protected grab(e: PointerEvent, at: float2): DragHandler | undefined {
			if (readOnly)
				return;
			const hit = elementOf(e.target as Node);
			if (!hit || hit === src?.documentElement)
				return;
			if (!selected || (hit !== selected && !selected.contains(hit)))
				select(hit);
			const target = selected && (hit === selected || selected.contains(hit)) ? selected : hit;
			const d = dispOf.get(target) as SVGGraphicsElement | undefined, base = d ? transformOf(d) : undefined;
			// d is the whole distance from the press, so it applies to the transform as it was then. Without Alt a move of the
			// pointer moves the element; with it, it turns the element about the middle of its box by the angle the pointer goes round
			// it (Shift: in steps of 15 degrees). Both are kept, so Alt may be pressed and let go during the drag.
			const here = (ev: PointerEvent) => {
				const r = this.svg.getBoundingClientRect();
				return this.toWorld(float2(ev.clientX - r.left, ev.clientY - r.top));
			};
			let last = this.toWorld(at), lastD = float2(0, 0), t = float2(0, 0), angle = 0, turned = false;
			const box = d?.getBBox?.();
			const parent = d ? worldMatrix(d.parentNode as SVGElement).inverse() : float2x3.identity();
			const c0 = base && box ? base.mulPos(float2(box.x + box.width / 2, box.y + box.height / 2)) : undefined;
			return {
				move: (d, ev) => {
					const now = here(ev);
					if (ev.altKey && c0) {
						const c = c0.add(inParent(target, t));
						angle += parent.mulPos(now).sub(c).atan2() - parent.mulPos(last).sub(c).atan2();
					} else {
						t = t.add(d.sub(lastD));
					}
					last = now;
					lastD = d;
					let by = float2.translate(inParent(target, t));
					if (c0 && angle !== 0) {
						const th = ev.shiftKey ? Math.round(angle / (Math.PI / 12)) * Math.PI / 12 : angle, cos = Math.cos(th), sin = Math.sin(th), tp = inParent(target, t);
						by = float2x3(float2(cos, sin), float2(-sin, cos), float2(c0.x - (cos * c0.x - sin * c0.y) + tp.x, c0.y - (sin * c0.x + cos * c0.y) + tp.y));
						turned = th !== 0;
					}
					moveElement(target, d, undefined, base, by);
				},
				end: moved => {
					if (moved)
						moveElement(target, float2(0, 0), turned ? 'Rotate element' : 'Move element');
				},
			};
		}


		// with the pen, a press anywhere starts a stroke (unless Shift is held, which moves the view); the stroke is shown as it is drawn
		protected capture(e: PointerEvent, at: float2): DragHandler | undefined {
			if (mode && !readOnly)
				return mode.capture(this, at);
			if (this.tool !== 'freehand' || readOnly || e.shiftKey)
				return;
			const w = this.toWorld(at);
			const mine: float2[] = stroke = [w];
			return {
				raw:	true,
				move:	d => { mine.push(w.add(d)); },
				end:	moved => {
					stroke = undefined;
					this.draw();
					if (moved)
						void drawStroke(mine);
				},
			};
		}

		protected clicked(_e: PointerEvent) {
			select(undefined);
		}

		// over the stops of a gradient, the menu is only for the stop there (or for adding one)
		protected menuOnly(here: float2): CascadeItem[] | undefined {
			return mode && !readOnly ? mode.menu(this, here) : undefined;
		}

		protected pageItems(): CascadeItem[] {
			const op = (id: string, icon: string, caption: string, run: () => void): CascadeItem => ({id, face: () => svgFace(icon), caption: () => caption, select: () => { run(); }});
			const items = ui.pageItems?.() ?? [];
			const e = selected;
			if (!readOnly) {
				// the fill and the stroke of the element, with a few colours to hand and none or the default; the panel has the rest
				if (e && e !== src?.documentElement)
					for (const prop of ['fill', 'stroke'] as const) {
						const paint		= paintOptions(e, prop), now = () => paint.get();
						const set		= (p: Paint) => { paint.set(p, true); };
						const isGradient = (p: Paint, type: 'linear' | 'radial') => p.type === type;
						const setGradient = (type: 'linear' | 'radial') => {
							const p			= now();
							const color		= p.type === 'color' ? p.color : GREY;
							const stops		= 'stops' in p ? p.stops : defaultStops(color);
							const spread	= 'stops' in p ? p.spread : 'pad';
							set({type, stops, spread});
							paint.handles!.set(true);
						}
						const defaultStops = (color: RGB) => [{offset: 0, color, opacity: 1}, {offset: 1, color, opacity: 0}];
						const svgGradient = (prefix: string, type: 'linear' | 'radial', stops: Stop[]) => {
							// the icon is inline in the page, so the gradient's id has to be unique there: one per property
							const id		= `${prefix}-${prop}-${type}`;
							const stops2	= stops.map(s => `<stop offset="${s.offset}" stop-color="${toHex(s.color)}" stop-opacity="${s.opacity}"/>`).join('');
							const grad		= type === 'radial'
								? `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops2}</radialGradient>`
								: `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stops2}</linearGradient>`;
							return svgFace(`<defs>${grad}</defs><rect x="2" y="2" width="12" height="12" fill="url(#${id})"/>`);
						};

						items.push({
							id:			prop,
							face:		() => {
								const p = now();
								switch (p.type) {
									case 'color':		return swatchFace(toHex(p.color));
									case 'none':		return svgFace('<rect x="2" y="2" width="12" height="12"/><path d="M2 14L14 2"/>');
									case 'linear': case 'radial':	return svgGradient('face', p.type, p.stops);
									default: 			return svgFace(`<rect x="2" y="2" width="12" height="12" ${prop === 'fill' ? 'fill="currentColor" fill-opacity="0.35"' : 'stroke-dasharray="2 1.5"'}/>`);
								}
								//return p.kind === 'color' ? swatchFace(p.color) : svgFace(p.kind === 'none' ? '<rect x="2" y="2" width="12" height="12"/><path d="M2 14L14 2"/>' : `<rect x="2" y="2" width="12" height="12" ${prop === 'fill' ? 'fill="currentColor" fill-opacity="0.35"' : 'stroke-dasharray="2 1.5"'}/>`);
							},
							caption:	() => {
								const p = now();
								return `${prop === 'fill' ? 'Fill' : 'Stroke'}: ${p.type === 'color' ? toHex(p.color) : p.type === 'unset' ? 'default' : p.type === 'other' ? p.text : p.type}`;
							},
							// the icon itself stands for what is there: a gradient is edited on the drawing
							click:		() => {
								if ('stops' in now()) {
									enterGradient(e, prop);
									return true;
								}
								return false;
							},
							children:	() => {
								const colourNow = () => { const p = now(); return p.type === 'color' ? p.color : GREY; };
								const children: CascadeItem[] = [
									{id: `${prop}-none`, face: () => svgFace('<rect x="2" y="2" width="12" height="12"/><path d="M2 14L14 2"/>'), caption: () => 'None', active: () => now().type === 'none', select: () => set({type: 'none'})},
									{id: `${prop}-unset`, face: () => svgFace('<rect x="2" y="2" width="12" height="12" stroke-dasharray="2 1.5"/>'), caption: () => 'Default (inherited)', active: () => now().type === 'unset', select: () => set({type: 'unset', effective: ''})},
									{id: `${prop}-solid`, face: () => svgFace('<rect x="2" y="2" width="12" height="12" fill="currentColor"/>'), caption: () => 'Solid colour', children: () =>
										colourItems(prop, colourNow, (c, final) => paint.set({type: 'color', color: c}, final), () => now().type === 'color'),
									},
									{id: `${prop}-linear`, face: () => svgGradient('sel', 'linear', defaultStops(GREY)), caption: () => 'Linear gradient', active: () => isGradient(now(), 'linear'), select: () => setGradient('linear')},
									{id: `${prop}-radial`, face: () => svgGradient('sel', 'radial', defaultStops(GREY)), caption: () => 'Radial gradient', active: () => isGradient(now(), 'radial'), select: () => setGradient('radial')},
								];
								if (prop === 'stroke')
									children.unshift({
										...valueItem({
											label:		'width',
											caption:	'Stroke width',
											get:		() => parseFloat(getComputedStyle(dispOf.get(e)!).strokeWidth) || 0,
											set:		v => adjustProp(e, 'stroke-width', String(v), 'Change stroke width'),
											min:		0.25,
											max:		100,
											step:		(v, steps) => {
												//return v * 1.2 ** steps;
												return Math.round(v * 1.2 ** steps * 100) / 100;
												//return n === v ? v + Math.sign(steps) * 0.01 : n;
											},
											presets:	[0.5, 1, 2, 3, 5, 8, 12, 20, 50],
											resolution:	0.01,
											format:		v => `${+v.toFixed(2)}`,
										}),
										id:			'stroke-width',
									});
								// opacity, and the red, green and blue of a colour, adjusted as they are turned: the turning is one edit
								children.push({
									...valueItem({
										label:		'alpha',
										caption:	`${prop === 'fill' ? 'Fill' : 'Stroke'} opacity`,
										get:		() => Math.round(paint.opacity!.get() * 100),
										set:		v => paint.opacity!.set(Math.round(v) / 100, false),
										min:		0,
										max:		100,
										step:		(v, steps) => v + 5 * steps,
										presets:	[0, 25, 50, 75, 100],
										format:		v => `${Math.round(v)}%`,
									}),
									id:			`${prop}-opacity`,
								});
								// the other properties the panel has, as choices of the value, with the default first
								const choose = (id: string, caption: string, name: string, choices: [string, string, string][]): CascadeItem => {
									// a value the panel (or the file) has that is none of the choices is one more, shown while it is the value
									const item = () => {
										const now = getProp(e, name) ?? '';
										const list = choices.map(([value, face, text]) => ({value, face: svgFace(face), caption: text}));
										if (!list.some(c => c.value === now))
											list.push({value: now, face: svgFace('<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>'), caption: `custom (${now})`});
										return choiceItem(caption, list, () => getProp(e, name) ?? '', v => { setAndSave(e, name, v); showProps(); });
									};
									return {id, face: () => item().face(), caption: () => item().caption(), wheel: steps => item().wheel!(steps), children: () => item().children!()};
								};
								if (prop === 'fill')
									children.push(choose('fill-rule', 'Fill rule', 'fill-rule', [
										['',		'<path d="M8 2L14 13H2ZM8 6L11 11H5Z" stroke-dasharray="2 1.5"/>',	'default (nonzero)'],
										['nonzero',	'<path d="M8 2L14 13H2ZM8 6L11 11H5Z" fill="currentColor" fill-opacity="0.5"/>',	'nonzero'],
										['evenodd',	'<path d="M8 2L14 13H2ZM8 6L11 11H5Z" fill="currentColor" fill-opacity="0.5" fill-rule="evenodd"/>',	'evenodd'],
									]));
								else
									children.push(
										choose('stroke-linecap', 'Line cap', 'stroke-linecap', [
											['',		'<path d="M4 8H12" stroke-dasharray="2 1.5"/>',	'default (butt)'],
											['butt',	'<path d="M4 8H12" stroke-width="5" stroke-linecap="butt"/>',	'butt'],
											['round',	'<path d="M5 8H11" stroke-width="5" stroke-linecap="round"/>',	'round'],
											['square',	'<path d="M5 8H11" stroke-width="5" stroke-linecap="square"/>',	'square'],
										]),
										choose('stroke-linejoin', 'Line join', 'stroke-linejoin', [
											['',		'<path d="M3 13L8 4L13 13" stroke-dasharray="2 1.5"/>',	'default (miter)'],
											['miter',	'<path d="M3 13L8 4L13 13" stroke-width="3" stroke-linejoin="miter"/>',	'miter'],
											['round',	'<path d="M3 13L8 4L13 13" stroke-width="3" stroke-linejoin="round"/>',	'round'],
											['bevel',	'<path d="M3 13L8 4L13 13" stroke-width="3" stroke-linejoin="bevel"/>',	'bevel'],
										]),
										choose('stroke-dasharray', 'Dashes', 'stroke-dasharray', [
											['',		'<path d="M2 8H14"/>',	'solid'],
											['4 2',		'<path d="M2 8H14" stroke-dasharray="4 2"/>',	'dashed'],
											['1 3',		'<path d="M2 8H14" stroke-dasharray="0.1 3" stroke-width="2"/>',	'dotted'],
											['8 3 2 3',	'<path d="M2 8H14" stroke-dasharray="5 2 1 2"/>',	'dash dot'],
										]),
									);
								return children;
							},
						});
					}
				if (e && e !== src?.documentElement)
					items.push({
						id:			'element',
						face:		() => svgFace(elementIcons.element),
						caption:	() => 'Element',
						children:	() => [
							op('select-parent', elementIcons.parent, 'Select parent', () => select(e.parentElement && e.parentElement !== src!.documentElement ? e.parentElement : undefined)),
							op('duplicate', elementIcons.duplicate, 'Duplicate (Ctrl+D)', () => duplicateElement(e)),
							op('delete-element', elementIcons.remove, 'Delete element (Del)', () => deleteElement(e)),
							...(backend.editImage && editableImage(e) ? [op('edit-image', elementIcons.image, 'Edit image', () => editImage(e))] : []),
							{
								id:			'order',
								face:		() => svgFace(elementIcons.order),
								caption:	() => 'Order',
								children:	() => [
									op('front', elementIcons.front, 'Bring to front', () => reorder(e, 'front')),
									op('forward', elementIcons.forward, 'Bring forward', () => reorder(e, 'forward')),
									op('backward', elementIcons.backward, 'Send backward', () => reorder(e, 'backward')),
									op('back', elementIcons.back, 'Send to back', () => reorder(e, 'back')),
								],
							},
						],
					});
			}
			const swatch = (fill: string) => svgFace(`<rect x="2" y="2" width="12" height="12" fill="${fill}"/>`);
			items.push({
				...choiceItem('Background', [
					{value: 'theme', face: svgFace('<rect x="2" y="2" width="12" height="12" stroke-dasharray="2 2"/>'), caption: 'Editor'},
					{value: 'white', face: swatch('#fff'), caption: 'White'},
					{value: 'black', face: swatch('#000'), caption: 'Black'},
					{value: 'checker', face: svgFace('<rect x="2" y="2" width="12" height="12"/><rect x="2" y="2" width="6" height="6" fill="currentColor"/><rect x="8" y="8" width="6" height="6" fill="currentColor"/>'), caption: 'Checker'},
				], () => background, v => { background = v; this.draw(); }),
				id: 'background',
			});
			return items;
		}
	}
	const editor = new SvgPath();


	//--- the host's ---------------------------------------------------------------------------------------------

	// the drawing from its text, with what was selected still so when it is there; a drawing that is read only has its
	// controls shown and nothing to change them with
	function load(text: string, file: string, only = false) {
		// (steps not yet sent are of the drawing as it was: an undo, say, has taken it back)
		if (continuing)
			clearTimeout(continuing.timer);
		continuing = undefined;
		steps.end();
		const keep = file === fileName && selected && indicesOf(selected);
		const first = !src;
		try {
			src = parse(text);
		} catch (error: any) {
			showError(`${file}: ${error?.message ?? error}`);
			return;
		}
		backend.error();
		fileName = file;
		readOnly = only;
		buildDisplay();
		buildTree();
		selected = undefined;
		select(keep ? elementAt(keep) : undefined);
		if (first)
			editor.fit();
		else
			editor.draw();
	}

	// the keys of editing and of the view; true when one was used
	function key(e: KeyboardEvent) {
		if (!src)
			return false;
		if (editor.key(e))
			return true;
		if (readOnly)
			return false;
		const step = e.shiftKey ? 10 : 1;
		if ((e.metaKey || e.ctrlKey) && e.key === 'd')
			duplicateElement();
		else if (selected && selected !== src.documentElement && ['Delete', 'Backspace'].includes(e.key))
			deleteElement();
		else if (selected && selected !== src.documentElement && e.key.startsWith('Arrow'))
			moveElement(selected, float2(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0), 'Move element');
		else if (e.key === 'Escape' && selected)
			select(undefined);
		else
			return false;
		return true;
	}

	return {editor, load, key, setImage, hasDocument: () => !!src};
}

//-----------------------------------------------------------------------------
// Fill options as a panel of controls: what a shape is painted with (nothing, a colour, a gradient, or what it inherits),
// with the colour and opacity, and for a gradient its stops. It knows nothing of where a paint is kept: the SVG editor keeps
// them in attributes, the font viewer in a colour font's palette, and each describes its own as a PaintOptions.
//-----------------------------------------------------------------------------

const MODE_NAMES: Record<PaintMode, string> = {unset: 'Inherit', none: 'None', color: 'Colour', linear: 'Linear', radial: 'Radial'};

let probe: HTMLElement | undefined;

const GREY: RGB = {r: 128, g: 128, b: 128};

/** A CSS colour and an opacity, or undefined for what is not a colour (none, a url, currentColor). */
export function parseColour(text: string): {color: RGB, opacity: number} | undefined {
	if (!text || /^(none|currentcolor|inherit|transparent)$/i.test(text) || text.startsWith('url('))
		return /^transparent$/i.test(text) ? {color: {r: 0, g: 0, b: 0}, opacity: 0} : undefined;
	probe ??= document.body.appendChild(createElement('span', {hidden: true}));
	probe.style.color = '';
	probe.style.color = text;
	if (!probe.style.color)
		return;
	const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(getComputedStyle(probe).color);
	if (!m)
		return;
	const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
	return {color: {r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3])}, opacity: a};
}

function number(value: number, min: number, max: number, step: number, on: (v: number, final: boolean) => void, className = 'fill-num') {
	// type, min, max and step come before value, which they constrain
	const input = createElement('input', {className, type: 'number', min: String(min), max: String(max), step: String(step), value: String(+value.toFixed(3))});
	const read = () => Math.max(min, Math.min(max, +input.value || 0));
	input.addEventListener('input', () => on(read(), false));
	input.addEventListener('change', () => on(read(), true));
	return input;
}

function colour(value: RGB, on: (v: RGB, final: boolean) => void) {
	const input = createElement('input', {className: 'fill-colour', type: 'color', value: toHex(value)});
	input.addEventListener('input', () => on(fromHex(input.value), false));
	input.addEventListener('change', () => on(fromHex(input.value), true));
	return input;
}

function gradientBar(stops: Stop[]) {
	const bar = createElement('div', {className: 'fill-bar'});
	const css = [...stops].sort((a, b) => a.offset - b.offset).map(s => `${cssOf(s)} ${s.offset * 100}%`).join(',');
	bar.style.background = `linear-gradient(90deg,${css || 'transparent,transparent'}), repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 0 0 / 10px 10px`;
	return bar;
}

// a stop between two others, in the colours between theirs
function between(a: Stop, b: Stop): Stop {
	return {offset: (a.offset + b.offset) / 2, color: mixColour(a.color, b.color, 0.5), opacity: (a.opacity + b.opacity) / 2};
}

/** The controls for one paint: its mode, and what that mode takes. */
export function paintControl(o: PaintOptions): HTMLElement {
	const box = createElement('div', {className: 'fill-box'});
	let paint = o.get();
	const body = createElement('div', {className: 'fill-body'});

	const change = (next: Paint, final: boolean) => {
		paint = next;
		o.set(next, final);
	};

	const draw = () => {
		body.textContent = '';
		if (paint.type === 'unset') {
			const note = createElement('div', {className: 'fill-note'});
			note.append(createElement('span', {className: 'fill-swatch'}), 'inherited');
			if (paint.effective)
				(note.firstChild as HTMLElement).style.background = paint.effective;
			body.append(note);
		} else if (paint.type === 'color') {
			const row = createElement('div', {className: 'fill-row'});
			row.append(colour(paint.color, (color, final) => change({type: 'color', color}, final)));
			if (o.opacity)
				row.append(createElement('label', {textContent: 'Opacity'}), number(o.opacity.get(), 0, 1, 0.05, o.opacity.set));
			body.append(row);
		} else if (paint.type === 'other') {
			body.append(createElement('div', {className: 'fill-note', textContent: paint.text}));
		} else if (paint.type === 'linear' || paint.type === 'radial') {
			const g = paint;
			body.append(gradientBar(g.stops));
			const list = createElement('div', {className: 'fill-stops'});
			const update = (final: boolean) => change({...g, stops: g.stops.map(s => ({...s}))}, final);
			g.stops.forEach((stop, i) => {
				const row = createElement('div', {className: 'fill-row'});
				row.append(
					colour(stop.color, (color, final) => { stop.color = color; refreshBar(); update(final); }),
					number(stop.offset, 0, 1, 0.01, (v, final) => { stop.offset = v; refreshBar(); update(final); }),
					number(stop.opacity, 0, 1, 0.05, (v, final) => { stop.opacity = v; refreshBar(); update(final); }, 'fill-num fill-op'),
				);
				if (o.editable !== false && g.stops.length > 2) {
					const remove = createElement('button', {className: 'fill-small', textContent: '×'});
					remove.title = 'Remove this stop';
					remove.addEventListener('click', () => { g.stops.splice(i, 1); change({...g}, true); draw(); });
					row.append(remove);
				}
				list.append(row);
			});
			const refreshBar = () => {
				const fresh = gradientBar(g.stops);
				body.querySelector('.fill-bar')?.replaceWith(fresh);
			};
			body.append(list);
			const tools = createElement('div', {className: 'fill-row'});
			if (o.editable !== false) {
				const add = createElement('button', {className: 'fill-small', textContent: '+ Stop'});
				add.addEventListener('click', () => {
					const sorted = [...g.stops].sort((a, b) => a.offset - b.offset);
					const i = Math.max(0, sorted.length - 2);
					g.stops.push(between(sorted[i], sorted[i + 1] ?? sorted[i]));
					change({...g}, true);
					draw();
				});
				const spread = createElement('select');
				for (const s of ['pad', 'reflect', 'repeat'] as Spread[])
					spread.add(new Option(s, s, false, s === g.spread));
				spread.title = 'What lies beyond the ends of the gradient';
				spread.addEventListener('change', () => change({...g, spread: spread.value as Spread}, true));
				tools.append(add, spread);
			}
			body.append(tools);
			if (o.opacity) {
				const row = createElement('div', {className: 'fill-row'});
				row.append(createElement('label', {textContent: 'Opacity'}), number(o.opacity.get(), 0, 1, 0.05, o.opacity.set));
				body.append(row);
			}
		}
	};

	const modes = createElement('select', {className: 'fill-mode'});
	const current = (): PaintMode => paint.type === 'other' ? 'color' : paint.type;
	for (const mode of o.modes)
		modes.add(new Option(MODE_NAMES[mode], mode));
	const mark = () => { modes.value = current(); };
	modes.addEventListener('change', () => {
		const mode = modes.value as PaintMode;
		if (mode === current() && paint.type !== 'other')
			return;
		const was = paint;
		const colourOf = was.type === 'color' ? was.color : 'stops' in was ? was.stops[0].color : GREY;
		if (mode === 'unset' || mode === 'none')
			change({type: mode}, true);
		else if (mode === 'color')
			change({type: 'color', color: colourOf}, true);
		else
			change({type: mode, spread: 'pad', stops: 'stops' in was ? was.stops : [{offset: 0, color: colourOf, opacity: 1}, {offset: 1, color: colourOf, opacity: 0}]}, true);
		mark();
		draw();
	});
	const title = createElement('div', {className: 'fill-title', textContent: o.label});
	title.append(modes);
	box.append(title, body);
	mark();
	draw();
	return box;
}
