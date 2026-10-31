// The font viewer: a font file read by @isopodlabs/binary_fonts, drawn by webview/font.ts. The page asks for the
// outlines of only the glyphs it is showing, so a font of tens of thousands of glyphs opens at once.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import { load, Font, WOFF, WOFF2, TTF_OTF, parseCurve, curveVertex, parseSVGshape, makeSVGPath, makeCurve, bezier3Curve, curveSimplify, ON_BEGIN, ON_CURVE, ON_END } from '@isopodlabs/binary_fonts';
import type { FontInfo, GlyphDetail, TableNode, MessageIn, MessageOut } from '../webview/font';

import { float2 } from '@isopodlabs/maths/vector';
import { setActiveViewer } from './extension';
import { embedded, type EmbeddedImage } from './embedded';
import { webviewPage } from './BitmapViewer';

// a path or basic shape as the points the SVG editor takes, left open where a contour's last point is ON_END
export function shapePoints(name: string, attributes: Record<string, string>) {
	return bezier3Curve(makeCurve(parseSVGshape({name, attributes}, true) ?? {run() {}}), 1e-6);
}

// points as the editor has them with fewer of them, the outline kept within tol; quadratics only unless cubic curves are allowed
export function simplifyPoints(points: curveVertex[], tol: number, cubic: boolean) {
	return curveSimplify(points, tol, {quadratic: !cubic});
}

// a stroke (x, y in pairs) as the points of an open path of cubics that follows it to within tol
export function fitStroke(stroke: number[], tol: number) {
	// samples closer together than tol are only noise
	const kept: float2[] = [];
	for (let i = 0; i < stroke.length; i += 2) {
		const p = float2(stroke[i], stroke[i + 1]);
		if (!kept.length || p.sub(kept[kept.length - 1]).len() >= tol)
			kept.push(p);
		else if (i === stroke.length - 2)
			kept[kept.length - 1] = p;
	}
	return kept.length < 2 ? [] : curveSimplify(kept.map((p, i) => curveVertex(p.x, p.y, i ? i === kept.length - 1 ? ON_END : ON_CURVE : ON_BEGIN)), tol, {corner: Math.PI / 3, noisy: true});
}

// names in a font file are UTF-16 that the reader leaves as bytes, so a NUL sits before each Latin character
const clean = (s?: string) => s?.replace(/\0/g, '').trim() ?? '';

const NAMES: [number, string][] = [
	[1, 'Family'], [2, 'Style'], [4, 'Full name'], [3, 'Identifier'], [5, 'Version'], [6, 'PostScript name'],
	[0, 'Copyright'], [7, 'Trademark'], [8, 'Manufacturer'], [9, 'Designer'], [10, 'Description'],
	[11, 'Vendor URL'], [12, 'Designer URL'], [13, 'License'], [14, 'License URL'],
];

export function fontInfo(font: Font, file: string, face: number, faces: string[]): FontInfo {
	const n			= font.numGlyphs();
	const mapping	= font.getGlyphMapping();
	const unicodes: Record<number, number[]> = {};
	// the codepoints of each glyph, found from the glyph mapping (indexed by codepoint)
	mapping?.forEach((id, cp) => {
		if (id)
			(unicodes[id] ??= []).push(cp);
	});

	const upm = font.head?.units_per_em || 1000;
	const advances = Array.from({length: n}, (_, i) => {
		const m = font.hmtx?.metrics;
		return m ? (m[Math.min(i, m.length - 1)]?.advance ?? 0) : upm;
	});

	const names: [string, string][] = [];
	for (const [id, label] of NAMES) {
		const value = clean(font.name?.get(id as any));
		if (value)
			names.push([label, value]);
	}

	return {
		file:		path.basename(file),
		faces,
		face,
		family:		clean(font.family()) || path.basename(file),
		style:		clean(font.subfamily()),
		numGlyphs:	n,
		unitsPerEm:	upm,
		ascent:		font.hhea?.ascent ?? upm * 0.8,
		descent:	font.hhea?.descent ?? -upm * 0.2,
		lineGap:	font.hhea?.lineGap ?? 0,
		advances,
		unicodes,
		names,
	};
}

const compact = {indent: '', newline: ''};

// a glyph's drawing as the markup inside an <svg> in font units (y down, baseline at 0), or '' where it has none
// (a glyph of the SVG table is drawn as the editor has it, so that what it is edited as is what is shown)
export function glyphMarkup(font: Font, id: number): string {
	try {
		const svg = font.getGlyphSVG(id, 7);
		if (svg)
			return svg.toString(compact).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
	} catch {}
	return '';
}

// everything the inspector draws of a glyph: its outline as a path and as the points it is made of (y down, as the
// page draws), and what is drawn of it in colour
// the em box of a glyph, which a drawing of it is shown in: from the top of the ascent to the bottom of the descent, y down
function emBox(font: Font, id: number) {
	const upm		= font.head?.units_per_em || 1000, m = font.hmtx?.metrics;
	const advance	= m ? (m[Math.min(id, m.length - 1)]?.advance ?? upm) : upm;
	const ascent	= font.hhea?.ascent ?? upm * 0.8, descent = font.hhea?.descent ?? -upm * 0.2;
	return `0 ${-ascent} ${advance} ${ascent - descent}`;
}

// a glyph that is drawn in colour as a document of its own: from the SVG table (which can be edited), or from the colour
// layers or a bitmap (which cannot)
export function glyphSvg(font: Font, id: number, editable: boolean): GlyphDetail['svg'] {
	const viewBox = emBox(font, id);
	try {
		const table = font.getGlyphSVG(id, 0), svg = table ?? font.getGlyphSVG(id, 5);
		if (svg) {
			Object.assign(svg.attributes, {viewBox, width: undefined, height: undefined});
			return {text: svg.toString(compact), editable: !!table && editable};
		}
	} catch {}
}

export function glyphDetail(font: Font, id: number, svgEditable = false, bitmapEditable = false): GlyphDetail {
	let curves: curveVertex[] = [];
	let error: string | undefined;
	try {
		curves = font.getGlyphCurves(id);
	} catch (e: any) {
		error = `outline could not be read: ${e?.message ?? e}`;
	}

	const path		= makeSVGPath(parseCurve(curves));
	const points	= curves.map(v => curveVertex(v.x, -v.y, v.flags));
	let components: number[] = [];
	try {
		components = font.getGlyph(id)?.refs?.map(r => r.glyph) ?? [];
	} catch {}
	const markup	= glyphMarkup(font, id);
	// drawn in colours of its own (a colour font's), which the outline being edited is not what makes
	const colored = /url\(#|fill="#|fill="rgb/.test(markup);
	const ppem		= font.bitmapPpem();
	const bitmap	= ppem && font.getGlyphImage(id, ppem)?.type === 'png ' ? {ppem, editable: bitmapEditable && !!font.sbix} : undefined;
	return {path, points, markup, colored, components, error, svg: glyphSvg(font, id, svgEditable), bitmap};
}

const MAX_CHILDREN = 1000;

class TableError {
	constructor(public message: string) {}
}

// containers are walked as arrays of their entries, so a path of keys and indices reaches anything in a table
function plain(v: any): any {
	if (v instanceof Map)
		return Array.from(v, ([k, x]) => [k, x]);
	if (v instanceof Set)
		return Array.from(v);
	return v;
}

function describe(v: any): TableNode {
	const base = {type: typeof v as TableNode['type']};
	if (v === null || v === undefined)
		return {type: 'null', value: String(v)};
	if (typeof v === 'string')
		return {...base, value: JSON.stringify(clean(v))};
	if (typeof v === 'number')
		return {...base, value: Number.isInteger(v) && Math.abs(v) >= 256 ? `${v} (0x${(v >>> 0).toString(16)})` : String(v)};
	if (typeof v === 'bigint' || typeof v === 'boolean')
		return {...base, value: String(v)};
	if (typeof v === 'function')
		return {type: 'null', value: 'function'};
	if (ArrayBuffer.isView(v)) {
		const bytes = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, 16));
		return {type: 'bytes', value: `${v.constructor.name}(${(v as any).length ?? v.byteLength}) ${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ')}${v.byteLength > 16 ? ' …' : ''}`};
	}
	const o = plain(v);
	if (Array.isArray(o))
		return {type: 'array', value: `[${o.length}]`, count: o.length};
	const n = Object.keys(o).length;
	return {type: 'object', value: `${o.constructor?.name && o.constructor !== Object ? o.constructor.name + ' ' : ''}{${n}}`, count: n};
}

// the children of the value at a path from the font: its entries, each described
export function children(font: Font, keys: string[]): TableNode[] {
	let v: any = font;
	for (const k of keys) {
		v = plain(v)?.[k];
		if (v === undefined)
			return [];
	}
	v = plain(v);
	if (!v || typeof v !== 'object' || ArrayBuffer.isView(v))
		return [];
	// a table is read when first touched, so one that cannot be read shows why instead of hiding the rest
	const entries: [string, any][] = [];
	for (const k of Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v)) {
		try {
			if (v[k] !== undefined)
				entries.push([k, v[k]]);
		} catch (error: any) {
			entries.push([k, new TableError(String(error?.message ?? error))]);
		}
	}
	const result: TableNode[] = entries.slice(0, MAX_CHILDREN).map(([key, x]) => ({key, ...(x instanceof TableError ? {type: 'error' as const, value: x.message} : describe(x))}));
	if (entries.length > MAX_CHILDREN)
		result.push({key: '…', type: 'null', value: `${entries.length - MAX_CHILDREN} more not shown`});
	return result;
}

// the points the page edits (y down), as the outline Font.setGlyph takes them
export function curveOf(points: curveVertex[]) {
	if (points.length && points[0].flags !== ON_BEGIN)
		throw new Error('an outline begins with a begin point');
	return points.map(v => curveVertex(v.x, -v.y, v.flags));
}

// a font file open for editing: the font as read, the edits made to it (which VS Code undoes and redoes through the
// events this fires), and the file it is saved to. Only a single TrueType font can be edited, as it is only that
// which binary_fonts can write.
export class FontDocument implements vscode.CustomDocument {
	fonts:		Font[] = [];
	editable	= false;
	convertible	= false;
	svgEditable	= false;		// whether the SVG drawings of its glyphs can be edited
	bitmapEditable = false;		// whether the bitmaps of its glyphs can be edited (sbix ones, which can be written)
	// the bitmaps being edited in the bitmap editor, by glyph
	private readonly bitmaps = new Map<number, {image: EmbeddedImage, ppem: number}>();
	private data?:	Uint8Array;
	error?:		string;
	private saved?:	Uint8Array;		// what the file held when last read or written
	// whether there are edits that are not in the file: from an edit until the save or revert, and from the start for a document
	// restored from a backup. A file that changes on disk meanwhile is not read over them.
	dirty = false;
	private readonly changed = new vscode.EventEmitter<{kind: 'glyph', id: number, own?: boolean} | {kind: 'reload'}>();
	readonly onDidChange = this.changed.event;
	readonly edited = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FontDocument>>();
	// The last edit of a glyph's outline or drawing, while nothing has been done since, which a later step of it (a nudge, a value still
	// being turned) changes. 'shown' after an undo, a redo or a reload: the page has been shown the glyph again, so a step of it on
	// its way is dropped. (after an edit from elsewhere, as of a bitmap, a step is an edit of its own)
	private latest?: {kind: 'outline' | 'svg', id: number, redo: () => void} | 'shown';

	constructor(public readonly uri: vscode.Uri, private readonly backup?: vscode.Uri) {
		this.onDidChange(() => this.syncBitmaps());
	}

	dispose() {
		this.bitmaps.forEach(({image}) => image.dispose());
		this.changed.dispose();
		this.edited.dispose();
	}

	async load(bytes?: Uint8Array) {
		this.latest = 'shown';
		const data = bytes ?? await vscode.workspace.fs.readFile(this.uri);
		const result = await load(data);
		if (!result)
			throw new Error('not a font this reads');
		this.fonts = result instanceof Font ? [result] : result.fonts;
		if (!this.fonts.length)
			throw new Error('the file holds no fonts');
		this.data = data;
		this.editable = result instanceof Font && !!result.glyphdata && /\.(ttf|woff2?)$/i.test(this.uri.fsPath);
		this.convertible = result instanceof Font && !result.glyphdata && !!result.rawTables.get('CFF ') && /\.otf$/i.test(this.uri.fsPath);
		this.svgEditable = result instanceof Font && /\.(ttf|otf|woff2?)$/i.test(this.uri.fsPath);
		this.bitmapEditable = result instanceof Font && !!result.sbix && /\.(ttf|otf|woff2?)$/i.test(this.uri.fsPath);
		this.saved = bytes ? undefined : data;
		this.dirty = !!bytes;
	}

	// the file changed on disk: read it again, unless that is what this wrote
	async reloadIfChanged() {
		if (this.dirty)
			return;
		const data = await vscode.workspace.fs.readFile(this.uri);
		if (this.saved && data.length === this.saved.length && data.every((b, i) => b === this.saved![i]))
			return;
		await this.load();
		this.changed.fire({kind: 'reload'});
	}

	async revert() {
		await this.load();
		this.changed.fire({kind: 'reload'});
	}

	// a font with CFF outlines is made a TrueType one, the only kind that can be edited and written. The font as it was
	// is kept, and what undo and redo swap in and out.
	async convert() {
		const before = this.fonts[0];
		const converted = await load(this.data!);
		if (!(converted instanceof Font) || !converted.convertToTrueType())
			throw new Error('this font cannot be converted');
		const swap = (font: Font, editable: boolean) => {
			this.fonts = [font];
			this.editable = editable;
			this.convertible = !editable;
			this.changed.fire({kind: 'reload'});
		};
		this.dirty = true;
		this.latest = undefined;
		swap(converted, true);
		this.edited.fire({document: this, label: 'Convert to TrueType outlines', undo: () => swap(before, false), redo: () => swap(converted, true)});
	}

	// An edit of a glyph, which `make` makes and says how to undo and redo. A later step of the last edit changes that edit: it undoes
	// to what was before the first step, and redoes to this one.
	private glyphEdit(kind: 'outline' | 'svg', id: number, label: string, continues: boolean, make: () => {undo: () => void, redo: () => void}) {
		const latest = this.latest;
		if (continues && latest === 'shown')
			return;
		if (continues && typeof latest === 'object' && latest.kind === kind && latest.id === id) {
			latest.redo = make().redo;
			this.changed.fire({kind: 'glyph', id, own: true});
			return;
		}
		const {undo, redo} = make();
		const made = this.latest = {kind, id, redo};
		this.dirty = true;
		const apply = (f: ()=>void) => {
			this.latest = 'shown';
			f();
			this.changed.fire({kind: 'glyph', id});
		};
		this.edited.fire({document: this, label, undo: () => apply(undo), redo: () => apply(made.redo)});
		this.changed.fire({kind: 'glyph', id, own: true});
	}

	// replaces a glyph's outline
	edit(id: number, points: curveVertex[], label: string, continues = false) {
		const font = this.fonts[0];
		if (!this.editable || !font.glyphdata || !(id >= 0 && id < font.glyphdata.length))
			throw new Error('this font cannot be edited');
		this.glyphEdit('outline', id, label, continues, () => font.setGlyph(id, {curve: curveOf(points)})!);
	}

	// a glyph's SVG drawing replaced by an edited one, which goes into the document of the SVG table that has it
	editSvg(id: number, text: string, label: string, continues = false) {
		const font = this.fonts[0];
		try {
			this.glyphEdit('svg', id, label, continues, () => font.setGlyphSVG(id, text));
		} catch (e) {
			throw new Error('the SVG drawing of this glyph cannot be edited');
		}
	}

	// a glyph's bitmap replaced by an edited one (a PNG), in the strike of the size it was taken from
	editBitmap(id: number, ppem: number, data: Uint8Array, label: string) {
		const font = this.fonts[0];
		const was = font.getGlyphImage(id, ppem);
		const {undo, redo} = font.setGlyphImage(id, ppem, {type: 'png ', originOffset: was?.originOffset ?? float2(0, 0), data});
		this.dirty = true;
		this.latest = undefined;
		const apply = (f: ()=>void) => {
			f();
			this.changed.fire({kind: 'glyph', id});
		};
		this.edited.fire({document: this, label, undo: () => apply(undo), redo: () => apply(redo)});
		this.changed.fire({kind: 'glyph', id});
	}

	// a glyph's bitmap at the largest size shown in the bitmap editor: saved back to the font if that can be written
	async openBitmap(font: Font, id: number) {
		const ppem = font.bitmapPpem(), picture = font.getGlyphImage(id, ppem);
		if (!picture || picture.type !== 'png ')
			throw new Error('this glyph has no PNG bitmap');
		this.bitmaps.get(id)?.image.dispose();
		const image = embedded.add(`glyph-${id}-${ppem}ppem.png`, picture.data, data => this.editBitmap(id, ppem, data, 'Edit bitmap'));
		if (!this.bitmapEditable)
			image.lose('this font\'s bitmaps cannot be written back');
		this.bitmaps.set(id, {image, ppem});
		await vscode.commands.executeCommand('vscode.openWith', image.uri, 'bitmap.viewer');
	}

	// the bitmaps being edited are what the font now holds: it may have been edited, undone or read again
	private syncBitmaps() {
		if (!this.bitmapEditable)
			return;
		for (const [id, {image, ppem}] of this.bitmaps) {
			const picture = this.fonts[0].getGlyphImage(id, ppem);
			if (picture?.type === 'png ')
				image.update(picture.data);
			else
				image.lose(`the font no longer has a bitmap for glyph ${id}`);
		}
	}

	bytes() {
		// as an SFNT file whatever it was read from, which is what a backup holds and what load() reads
		return TTF_OTF.write(this.fonts[0]);
	}

	// the file is written in the format its name says: WOFF for .woff, WOFF2 for .woff2, else an SFNT (TrueType or OpenType)
	async write(target: vscode.Uri) {
		const font = this.fonts[0];
		const data = /\.woff2$/i.test(target.fsPath) ? await WOFF2.write(font) : /\.woff$/i.test(target.fsPath) ? await WOFF.write(font) : TTF_OTF.write(font);
		await vscode.workspace.fs.writeFile(target, data);
		if (target.toString() === this.uri.toString()) {
			this.saved = data;
			this.dirty = false;
		}
	}
}

// what the inspector says about what is under the pointer is shown in the status bar while that editor is the active one
export class StatusLine {
	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	private owner?: object;

	show(owner: object, text: string) {
		this.owner = owner;
		this.item.text = text;
		text ? this.item.show() : this.item.hide();
	}
	hide(owner: object) {
		if (this.owner === owner)
			this.item.hide();
	}
	dispose() {
		this.item.dispose();
	}
}

class FontViewer extends webview.Panel<MessageOut, MessageIn> {
	private status = '';

	private readonly subscriptions: vscode.Disposable[] = [];
	private face = 0;

	private get fonts() {
		return this.document.fonts;
	}

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: FontDocument, private readonly statusLine: StatusLine) {
		super(webviewPanel, assets);
		webviewPanel.webview.options = {enableScripts: true, localResourceRoots: assets.localRoots()};
		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/font.js', `Font · ${path.basename(document.uri.fsPath)}`, [
			<div id="font-toolbar">
				<select id="font-face" class="hidden" />
				<label>Size <input id="font-size" type="number" min="6" max="1000" value="56" /> px</label>
				<label><input id="font-unicode" type="checkbox" /> Mapped only</label>
			</div>,
			<div id="font-sample-box" title="Type to change the sample; scroll to change the size">
				<input id="font-sample" type="text" value="The quick brown fox jumps over the lazy dog 0123456789" spellcheck="false" autocomplete="off" />
				<div id="font-sample-out" />
			</div>,
			<div id="font-body">
				<div id="font-side">
					<div id="font-detail" />
					<div id="font-layers" class="hidden">
						<div id="font-layer-tree" class="layer-tree" />
						<div id="font-layer-props" class="layer-props" />
					</div>
					<div id="font-meta" />
					<div id="font-tables" />
				</div>
				<div id="font-splitter" class="splitter" />
				<div id="font-grid" />
				<div id="font-inspector" class="hidden">
					<div id="insp-bar"><span id="insp-title" /></div>
					<div id="insp-view" />
				</div>
			</div>,
			<pre id="scad-error" class="hidden" />,
		], 'tensors', ['node_modules/@isopodlabs/vscode_utils/assets/tree.css', 'assets/pathedit.css', 'assets/font.css', 'assets/svg.css', 'assets/scad.css']);

		const file = document.uri.fsPath;
		const watch = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
		const reload = () => document.reloadIfChanged().catch(error => this.postMessage({command: 'error', message: `${path.basename(file)}: ${error?.message ?? error}`}));
		watch.onDidChange(reload);
		watch.onDidCreate(reload);
		this.subscriptions.push(watch, document.onDidChange(change => {
			if (change.kind === 'reload')
				this.send();
			else
				this.postMessage({command: 'glyphChanged', id: change.id, own: change.own});
		}));
	}

	dispose() {
		this.statusLine.hide(this);
		this.subscriptions.forEach(s => s.dispose());
	}

	// shown when this is the active editor, and taken down when another is
	activated(active: boolean) {
		if (active)
			this.statusLine.show(this, this.status);
		else
			this.statusLine.hide(this);
	}

	private send() {
		this.face = Math.min(this.face, this.fonts.length - 1);
		const faces = this.fonts.map((f, i) => [clean(f.family()), clean(f.subfamily())].filter(Boolean).join(' ') || `Face ${i + 1}`);
		this.postMessage({command: 'font', info: {...fontInfo(this.fonts[this.face], this.document.uri.fsPath, this.face, faces), editable: this.document.editable, convertible: this.document.convertible}});
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'ready':
				if (this.document.error || !this.fonts.length)
					this.postMessage({command: 'error', message: `${path.basename(this.document.uri.fsPath)}: ${this.document.error ?? 'no font'}`});
				else
					this.send();
				break;
			case 'status':
				this.status = message.text;
				if (this.webviewPanel.active)
					this.statusLine.show(this, this.status);
				break;
			case 'convertFont': {
				const convert = 'Convert';
				const choice = await vscode.window.showWarningMessage(
					'Edit this font?',
					{modal: true, detail: 'Its CFF outlines are converted to TrueType (quadratic) outlines, and hinting is lost. Saving writes the TrueType font to this file. The conversion can be undone until then.'},
					convert);
				if (choice === convert)
					await this.document.convert().catch(error => vscode.window.showErrorMessage(`Font editor: ${error?.message ?? error}`));
				break;
			}
			case 'editGlyph':
				try {
					this.document.edit(message.id, message.points, message.label, message.continues);
				} catch (error: any) {
					vscode.window.showErrorMessage(`Font editor: ${error?.message ?? error}`);
				}
				break;
			case 'face':
				this.face = Math.max(0, Math.min(message.face, this.fonts.length - 1));
				this.send();
				break;
			case 'getGlyphs': {
				const font = this.fonts[this.face];
				return Object.fromEntries(message.ids.map(id => [id, glyphMarkup(font, id)]));
			}
			case 'editGlyphSvg':
				try {
					this.document.editSvg(message.id, message.text, message.label, message.continues);
				} catch (error: any) {
					vscode.window.showErrorMessage(`Font editor: ${error?.message ?? error}`);
				}
				break;
			case 'shapePoints':
				return shapePoints(message.name, message.attributes);
			case 'simplifyPoints':
				return simplifyPoints(message.points, message.tol, message.cubic);
			case 'fitStroke':
				return fitStroke(message.stroke, message.tol);
			case 'getGlyphDetail':
				return glyphDetail(this.fonts[this.face], message.id, this.document.svgEditable && this.face === 0, this.document.bitmapEditable && this.face === 0);
			case 'editGlyphBitmap':
				await this.document.openBitmap(this.fonts[this.face], message.id);
				break;
			case 'getTable':
				return children(this.fonts[this.face], message.path);
			case 'error':
				vscode.window.showErrorMessage(`Font viewer: ${message.message}`);
				break;
		}
	}
}

export class FontViewerProvider implements vscode.CustomEditorProvider<FontDocument> {
	private readonly assets: webview.Assets;
	private readonly statusLine = new StatusLine();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FontDocument>>();
	readonly onDidChangeCustomDocument = this.changeEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('font.viewer', this, {webviewOptions: {retainContextWhenHidden: true}, supportsMultipleEditorsPerDocument: true}),
			{dispose: () => this.statusLine.dispose()},
		);
	}

	async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext) {
		const document = new FontDocument(uri);
		// edits that were not saved are in the backup VS Code kept of them
		const backup = context.backupId ? vscode.Uri.parse(context.backupId) : undefined;
		await document.load(backup ? await vscode.workspace.fs.readFile(backup) : undefined).catch(error => { document.error = String(error?.message ?? error); });
		document.edited.event(e => this.changeEmitter.fire(e));
		return document;
	}

	async saveCustomDocument(document: FontDocument) {
		await document.write(document.uri);
	}

	async saveCustomDocumentAs(document: FontDocument, destination: vscode.Uri) {
		await document.write(destination);
	}

	async revertCustomDocument(document: FontDocument) {
		await document.revert();
	}

	async backupCustomDocument(document: FontDocument, context: vscode.CustomDocumentBackupContext) {
		await vscode.workspace.fs.writeFile(context.destination, document.bytes());
		return {
			id: context.destination.toString(),
			delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} },
		};
	}

	async resolveCustomEditor(document: FontDocument, webviewPanel: vscode.WebviewPanel) {
		const editor = new FontViewer(webviewPanel, this.assets, document, this.statusLine);
		setActiveViewer(editor);
		webviewPanel.onDidDispose(() => editor.dispose());
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
			editor.activated(event.webviewPanel.active);
		});
	}
}
