// The font viewer: a font file read by @isopodlabs/binary_fonts, drawn by webview/font.ts. The page asks for the
// outlines of only the glyphs it is showing, so a font of tens of thousands of glyphs opens at once.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import { type Font, parseSVGshape, makeCurve, bezier3Curve } from '@isopodlabs/binary_fonts';
import type { MessageIn, MessageOut } from '../webview/font';

import { setActiveViewer } from './extension';
import { embedded, type EmbeddedImage } from './embedded';
import { webviewPage } from './BitmapViewer';

import { FontModel, fontInfo, clean, glyphMarkup, glyphDetail, children, type EditStep, type FontChange } from './fontmodel';

// a font file open for editing: the model (fontmodel.ts), the edits made to it (which VS Code undoes and redoes through the events
// this fires), and the file it is saved to
export class FontDocument extends FontModel implements vscode.CustomDocument {
	error?:			string;

	// the bitmaps being edited in the bitmap editor, by glyph
	private readonly bitmaps = new Map<number, {image: EmbeddedImage, ppem: number}>();
	private saved?:	Uint8Array;		// what the file held when last read or written
	private readonly changed = new vscode.EventEmitter<FontChange>();

	readonly onDidChange	= this.changed.event;
	readonly edited			= new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FontDocument>>();

	constructor(public readonly uri: vscode.Uri, private readonly backup?: vscode.Uri) {
		super(uri.fsPath);
		this.onDidChange(() => this.syncBitmaps());
	}

	protected onEdit(step: EditStep) {
		this.edited.fire({document: this, ...step});
	}
	protected onChange(change: FontChange) {
		this.changed.fire(change);
	}

	dispose() {
		this.bitmaps.forEach(({image}) => image.dispose());
		this.changed.dispose();
		this.edited.dispose();
	}

	async load(bytes?: Uint8Array) {
		const data = bytes ?? await vscode.workspace.fs.readFile(this.uri);
		await this.open(data, !!bytes);
		this.saved = bytes ? undefined : data;
	}

	// the file changed on disk: read it again, unless that is what this wrote
	async reloadIfChanged() {
		if (this.dirty)
			return;
		const data = await vscode.workspace.fs.readFile(this.uri);
		if (this.saved && data.length === this.saved.length && data.every((b, i) => b === this.saved![i]))
			return;
		await this.load();
		this.onChange({kind: 'reload'});
	}

	async revert() {
		await this.load();
		this.onChange({kind: 'reload'});
	}

	// a glyph's bitmap at the largest size shown in the bitmap editor: saved back to the font if that can be written
	async openBitmap(font: Font, id: number) {
		const ppem	= font.bitmapPpem(), picture = font.getGlyphImage(id, ppem);
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

	async write(target: vscode.Uri) {
		const data = await this.encode(target.fsPath);
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
			case 'getGlyphDetail':
				return glyphDetail(this.fonts[this.face], message.id, this.document.svgEditable && this.face === 0, this.document.bitmapEditable && this.face === 0);
			case 'shapePoints':
				return bezier3Curve(makeCurve(parseSVGshape(message, true) ?? {run() {}}), 1e-6);
//				return shapePoints(message.name, message.attributes);
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
