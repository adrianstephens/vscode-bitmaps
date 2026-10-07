// The font viewer: a font file read by @isopodlabs/binary_fonts, drawn by webview/font.ts. The page asks for the
// outlines of only the glyphs it is showing, so a font of tens of thousands of glyphs opens at once.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import { load, Font, WOFF, WOFF2, TTF_OTF, parseCurve, curveVertex } from '@isopodlabs/binary_fonts';
import type { FontInfo, GlyphDetail, TableNode, MessageIn, MessageOut } from '../webview/font';

import { setActiveViewer } from './extension';
import { webviewPage } from './BitmapViewer';

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

// the size of the largest bitmap strike, in pixels per em, or 0 where the font has none
function bitmapPpem(font: Font): number {
	try {
		const sizes = font.sbix?.strikes.map(s => s.ppem) ?? font.CBLC?.bitmapSizes.map(s => s.ppemX) ?? font.EBLC?.bitmapSizes.map(s => s.ppemX) ?? [];
		return Math.max(0, ...sizes);
	} catch {
		return 0;
	}
}

// a bitmap glyph (emoji and the like) as an <image> in font units, placed by the strike's origin offset
function bitmapMarkup(font: Font, id: number): string {
	try {
		const ppem = bitmapPpem(font);
		const image = ppem && font.getGlyphImage(id, ppem);
		// a PNG's size is in its header: width and height, big-endian, after the signature and chunk name
		if (!image || !image.type.startsWith('png') || image.data.length < 24)
			return '';
		const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
		const w = view.getUint32(16), h = view.getUint32(20);
		const k = (font.head?.units_per_em || 1000) / ppem;
		const x = image.originOffset.x * k, y = image.originOffset.y * k;
		return `<image href="data:image/png;base64,${Buffer.from(image.data).toString('base64')}" x="${x}" y="${-(y + h * k)}" width="${w * k}" height="${h * k}"/>`;
	} catch {
		return '';
	}
}

// a glyph's drawing as the markup inside an <svg> in font units (y down, baseline at 0), or '' where it has none
export function glyphMarkup(font: Font, id: number): string {
	try {
		const svg = font.getGlyphSVG(id, true);
		const markup = svg ? String(svg).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/fill="black"/g, 'fill="currentColor"') : '';
		// outlines with no path to them are a glyph drawn some other way
		if (markup.replace(/<path[^>]* d=""[^>]*\/>/g, '').includes('<'))
			return markup;
	} catch {}
	return bitmapMarkup(font, id);
}

// everything the inspector draws of a glyph: its outline as a path and as the points it is made of (y down, as the
// page draws), and what is drawn of it in colour
export function glyphDetail(font: Font, id: number): GlyphDetail {
	let curves: ReturnType<Font['getGlyphCurves']> = [];
	let error: string | undefined;
	try {
		curves = font.getGlyphCurves(id);
	} catch (e: any) {
		error = `outline could not be read: ${e?.message ?? e}`;
	}

	let path = '';
	parseCurve(curves).run({
		Begin:		a => { path += `M${a.x},${-a.y}`; },
		End:		() => { path += 'Z'; },
		Line:		(_a, b) => { path += `L${b.x},${-b.y}`; },
		Bezier2:	(_a, b, c) => { path += `Q${b.x},${-b.y},${c.x},${-c.y}`; },
		Bezier3:	(_a, b, c, d) => { path += `C${b.x},${-b.y},${c.x},${-c.y},${d.x},${-d.y}`; },
		Arc:		(_a, _b, _c, d) => { path += `L${d.x},${-d.y}`; },
		Arc3:		(_a, _b, c) => { path += `L${c.x},${-c.y}`; },
	});

	const points = curves.flatMap(v => [v.x, -v.y, v.flags]);
	let components: number[] = [];
	try {
		components = font.getGlyph(id)?.refs?.map(r => r.glyph) ?? [];
	} catch {}
	const markup = glyphMarkup(font, id);
	// drawn in colours of its own (a colour font's), which the outline being edited is not what makes
	const colored = /url\(#|fill="#|fill="rgb/.test(markup);
	return {path, points, markup, colored, components, error};
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

// the points the page edits, as the outline Font.setGlyph takes: x, y (down), flags in threes, a contour from each 0
export function curveOf(points: number[]) {
	const curve = [];
	for (let i = 0; i < points.length; i += 3) {
		if (i === 0 && points[2] !== 0)
			throw new Error('an outline begins with a begin point');
		curve.push(curveVertex(points[i], -points[i + 1], points[i + 2]));
	}
	return curve;
}

// a font file open for editing: the font as read, the edits made to it (which VS Code undoes and redoes through the
// events this fires), and the file it is saved to. Only a single TrueType font can be edited, as it is only that
// which binary_fonts can write.
export class FontDocument implements vscode.CustomDocument {
	fonts:		Font[] = [];
	editable	= false;
	convertible	= false;
	private data?:	Uint8Array;
	error?:		string;
	private saved?:	Uint8Array;		// what the file held when last read or written
	// whether there are edits that are not in the file: from an edit until the save or revert, and from the start for a document
	// restored from a backup. A file that changes on disk meanwhile is not read over them.
	dirty = false;
	private readonly changed = new vscode.EventEmitter<{kind: 'glyph', id: number} | {kind: 'reload'}>();
	readonly onDidChange = this.changed.event;
	readonly edited = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FontDocument>>();

	constructor(public readonly uri: vscode.Uri, private readonly backup?: vscode.Uri) {}

	dispose() {
		this.changed.dispose();
		this.edited.dispose();
	}

	async load(bytes?: Uint8Array) {
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
		swap(converted, true);
		this.edited.fire({document: this, label: 'Convert to TrueType outlines', undo: () => swap(before, false), redo: () => swap(converted, true)});
	}

	// replaces a glyph's outline, and says how to undo that
	edit(id: number, points: number[], label: string) {
		const font = this.fonts[0];
		if (!this.editable || !font.glyphdata || !(id >= 0 && id < font.glyphdata.length))
			throw new Error('this font cannot be edited');
		this.dirty = true;
		const before = font.snapshotGlyph(id);
		font.setGlyph(id, {curve: curveOf(points)});
		const after = font.snapshotGlyph(id);
		const apply = (snap: typeof before) => {
			font.restoreGlyph(id, snap);
			this.changed.fire({kind: 'glyph', id});
		};
		this.edited.fire({document: this, label, undo: () => apply(before), redo: () => apply(after)});
		this.changed.fire({kind: 'glyph', id});
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
class StatusLine {
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
					<div id="font-meta" />
					<div id="font-tables" />
				</div>
				<div id="font-splitter" class="splitter" />
				<div id="font-grid" />
				<div id="font-inspector" class="hidden">
					<div id="insp-bar">
						<button id="insp-back" title="Back to the glyphs (Esc)">◂ Glyphs</button>
						<button id="insp-prev" title="Previous glyph (←)">‹</button>
						<span id="insp-title" />
						<button id="insp-next" title="Next glyph (→)">›</button>
						<span class="insp-sep" />
						<label><input id="insp-grid" type="checkbox" checked /> Grid</label>
						<label><input id="insp-metrics" type="checkbox" checked /> Metrics</label>
						<label><input id="insp-fill" type="checkbox" checked /> Fill</label>
						<label><input id="insp-outline" type="checkbox" checked /> Outline</label>
						<label><input id="insp-polygon" type="checkbox" checked /> Polygon</label>
						<label><input id="insp-points" type="checkbox" checked /> Points</label>
						<label><input id="insp-numbers" type="checkbox" /> Numbers</label>
						<span class="insp-sep" />
						<label id="insp-snap-label" class="hidden"><input id="insp-snap" type="checkbox" checked /> Snap</label>
						<span class="insp-sep" />
						<button id="insp-fit" title="Fit the glyph (0)">Fit</button>
					</div>
					<div id="insp-view" />
					<div id="insp-menu" class="hidden" />
				</div>
			</div>,
			<pre id="scad-error" class="hidden" />,
		], 'tensors', ['assets/font.css', 'assets/scad.css']);

		const file = document.uri.fsPath;
		const watch = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
		const reload = () => document.reloadIfChanged().catch(error => this.postMessage({command: 'error', message: `${path.basename(file)}: ${error?.message ?? error}`}));
		watch.onDidChange(reload);
		watch.onDidCreate(reload);
		this.subscriptions.push(watch, document.onDidChange(change => {
			if (change.kind === 'reload')
				this.send();
			else
				this.postMessage({command: 'glyphChanged', id: change.id});
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
					this.document.edit(message.id, message.points, message.label);
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
			case 'getGlyphDetail':
				return glyphDetail(this.fonts[this.face], message.id);
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
