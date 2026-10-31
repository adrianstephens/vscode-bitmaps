// The SVG editor: a drawing shown and edited by webview/svg.ts, which shares its point editor with the font viewer's glyph
// inspector. The page holds the drawing as a DOM and sends the whole text back after each edit, which is what VS Code
// undoes and redoes here; this reads shapes as the points the editor takes (the page has no path parser).
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import type { MessageIn, MessageOut } from '../webview/svg';

import { setActiveViewer } from './extension';
import { webviewPage } from './BitmapViewer';
import { StatusLine, shapePoints, simplifyPoints, fitStroke } from './FontViewer';
import { embedded, parseDataUri, dataUri, sameBytes, type EmbeddedImage } from './embedded';
import * as xml from '@isopodlabs/xml';

export class SvgDocument implements vscode.CustomDocument {
	text		= '';
	error?:		string;
	private saved?:	string;			// what the file held when last read or written
	// whether there are edits that are not in the file: a file that changes on disk meanwhile is not read over them
	dirty		= false;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	readonly edited = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SvgDocument>>();
	private latest?: {after: string};	// the last edit, while nothing has been done since: a later step of it changes it

	constructor(public readonly uri: vscode.Uri) {}

	dispose() {
		this.changed.dispose();
		this.edited.dispose();
	}

	async load(text?: string) {
		this.latest	= undefined;
		const data = text ?? new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.uri));
		this.text	= data.replace(/^﻿/, '');
		this.saved	= text === undefined ? this.text : undefined;
		this.dirty	= text !== undefined;
	}

	async reloadIfChanged() {
		if (this.dirty)
			return;
		const data = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.uri)).replace(/^﻿/, '');
		if (data === this.saved)
			return;
		await this.load();
		this.changed.fire();
	}

	async revert() {
		await this.load();
		this.changed.fire();
	}

	// The page changed the drawing: the text it now has, and how to go back to what it was. A later step of the last edit (a value still
	// being turned) changes that edit, if nothing has been done since; if something has (an undo), the page is shown the drawing again,
	// and the step is dropped.
	edit(text: string, label: string, continues = false) {
		if (continues) {
			if (this.latest) {
				this.latest.after = text;
				this.text = text;
			}
			return;
		}
		const before = this.text, latest = this.latest = {after: text};
		this.text = text;
		this.dirty = true;
		const apply = (t: string) => {
			this.latest = undefined;
			this.text = t;
			this.changed.fire();
		};
		this.edited.fire({document: this, label, undo: () => apply(before), redo: () => apply(latest.after)});
	}

	async write(target: vscode.Uri) {
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(this.text));
		if (target.toString() === this.uri.toString()) {
			this.saved = this.text;
			this.dirty = false;
		}
	}
}

// an element of a parsed drawing, found by its id
function findById(e: xml.Element, id: string): xml.Element | undefined {
	return e.attributes.id === id ? e : e.allElements().map(c => findById(c, id)).find(found => found);
}

class SvgViewer extends webview.Panel<MessageOut, MessageIn> {
	private status = '';
	// the images of the drawing being edited in the bitmap editor, by the id of their element
	private readonly images = new Map<string, {image: EmbeddedImage, mime: string}>();
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: SvgDocument, private readonly statusLine: StatusLine) {
		super(webviewPanel, assets);
		webviewPanel.webview.options = {enableScripts: true, localResourceRoots: assets.localRoots()};
		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/svg.js', `SVG · ${path.basename(document.uri.fsPath)}`, [
			<div id="svg-body">
				<div id="svg-side">
					<div id="svg-tree" class="layer-tree" />
					<div id="svg-props" class="layer-props" />
				</div>
				<div id="svg-splitter" class="splitter" />
				<div id="svg-main">
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
		this.subscriptions.push(watch, document.onDidChange(() => { this.send(); this.syncImages(); }));
	}

	dispose() {
		this.images.forEach(({image}) => image.dispose());
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

	// the images being edited are what the drawing now holds: it may have been edited, undone or read again
	private syncImages() {
		if (!this.images.size)
			return;
		const root = xml.parse(this.document.text).firstElement();
		for (const [id, {image, mime}] of this.images) {
			const element = root && findById(root, id);
			const picture = element && parseDataUri(element.attributes.href ?? element.attributes['xlink:href'] ?? '');
			if (!picture || picture.mime !== mime)
				image.lose(`the drawing no longer has the image ${id}`);
			else
				image.update(picture.data);
		}
	}

	private async editImage(id: string, href: string) {
		const picture = parseDataUri(href);
		if (!picture)
			return;
		this.images.get(id)?.image.dispose();
		const image = embedded.add(`${id}${picture.extension}`, picture.data, data => this.postMessage({command: 'setImage', id, href: dataUri(picture.mime, data)}));
		this.images.set(id, {image, mime: picture.mime});
		await vscode.commands.executeCommand('vscode.openWith', image.uri, 'bitmap.viewer');
	}

	private send() {
		this.postMessage({command: 'svg', text: this.document.text, file: path.basename(this.document.uri.fsPath)});
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'ready':
				if (this.document.error)
					this.postMessage({command: 'error', message: `${path.basename(this.document.uri.fsPath)}: ${this.document.error}`});
				else
					this.send();
				break;
			case 'status':
				this.status = message.text;
				if (this.webviewPanel.active)
					this.statusLine.show(this, this.status);
				break;
			case 'edit':
				this.document.edit(message.text, message.label, message.continues);
				this.syncImages();
				break;
			case 'editImage':
				await this.editImage(message.id, message.href);
				break;
			case 'shapePoints':
				return shapePoints(message.name, message.attributes);
			case 'simplifyPoints':
				return simplifyPoints(message.points, message.tol, message.cubic);
			case 'fitStroke':
				return fitStroke(message.stroke, message.tol);
			case 'error':
				vscode.window.showErrorMessage(`SVG editor: ${message.message}`);
				break;
		}
	}
}

export class SvgViewerProvider implements vscode.CustomEditorProvider<SvgDocument> {
	private readonly assets: webview.Assets;
	private readonly statusLine = new StatusLine();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SvgDocument>>();
	readonly onDidChangeCustomDocument = this.changeEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('svg.viewer', this, {webviewOptions: {retainContextWhenHidden: true}}),
			{dispose: () => this.statusLine.dispose()},
		);
	}

	async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext) {
		const document = new SvgDocument(uri);
		// edits that were not saved are in the backup VS Code kept of them
		const backup = context.backupId ? vscode.Uri.parse(context.backupId) : undefined;
		await document.load(backup ? new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(backup)) : undefined).catch(error => { document.error = String(error?.message ?? error); });
		document.edited.event(e => this.changeEmitter.fire(e));
		return document;
	}

	async saveCustomDocument(document: SvgDocument) {
		await document.write(document.uri);
	}

	async saveCustomDocumentAs(document: SvgDocument, destination: vscode.Uri) {
		await document.write(destination);
	}

	async revertCustomDocument(document: SvgDocument) {
		await document.revert();
	}

	async backupCustomDocument(document: SvgDocument, context: vscode.CustomDocumentBackupContext) {
		await vscode.workspace.fs.writeFile(context.destination, new TextEncoder().encode(document.text));
		return {
			id: context.destination.toString(),
			delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} },
		};
	}

	async resolveCustomEditor(document: SvgDocument, webviewPanel: vscode.WebviewPanel) {
		const editor = new SvgViewer(webviewPanel, this.assets, document, this.statusLine);
		setActiveViewer(editor);
		webviewPanel.onDidDispose(() => editor.dispose());
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
			editor.activated(event.webviewPanel.active);
		});
	}
}
