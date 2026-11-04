// The mesh viewer: a file read by @isopodlabs/binary_meshes, drawn by webview/mesh.ts. The file is watched, and drawn
// again when it changes, as an exported STL is each time it is exported.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import * as fs from 'fs';
import * as bin from '@isopodlabs/binary';
import { STL, type Model } from '@isopodlabs/binary_meshes';
import { buildIndex } from './fonts';
import { MeshModel, renderData } from './meshmodel';
import type { MessageIn, MessageOut } from '../webview/mesh';

import { setActiveViewer, readShader, digitAtlas } from './extension';
import { webviewPage } from './BitmapViewer';

class MeshDocument implements vscode.CustomDocument {
	public meshes	= new MeshModel();
	public fileWatcher: vscode.FileSystemWatcher | undefined;
	// set while this writes the file, so that the watcher does not read back what was just written
	writing = false;
	scad	= false

	// not read from a file: there is no file until it is saved
	get untitled()	{ return this.uri.scheme === 'untitled'; }
	get ext() 		{ return path.extname(this.uri.fsPath).toLowerCase(); }

	// onChange is called when the file is changed by something else, as an exported STL is each time it is exported
	constructor(public readonly uri: vscode.Uri, onChange: () => void) {
		if (!this.untitled) {
			const changed = () => !this.writing && onChange();
			this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath)));
			this.fileWatcher.onDidChange(changed);
			this.fileWatcher.onDidCreate(changed);
		}
	}

	init(model: Model) {
		this.scad = true;
		this.meshes.use(model);
	}

	async load(uri: vscode.Uri = this.uri, ext = this.ext) {
		const file		= uri.fsPath;
		const bytes		= await vscode.workspace.fs.readFile(uri);
		const dir		= path.dirname(file);
		await this.meshes.read(bytes, ext, async name => {
			try {
				return await fs.promises.readFile(path.resolve(dir, name));
			} catch {
				return undefined;
			}
		});
	}
	async encode(destination: vscode.Uri) {
		return this.meshes.encode(path.basename(destination.fsPath), this.scad);
	}

	async write(destination: vscode.Uri) {
		this.writing = true;
		try {
			// an STL on disk goes out as its facets are made, rather than as one buffer
			if (destination.scheme === 'file' && path.extname(destination.fsPath).toLowerCase() === '.stl')
				return await this.writeStl(destination.fsPath);
			const {main, mtl} = await this.encode(destination);
			await vscode.workspace.fs.writeFile(destination, main);
			if (mtl)
				await vscode.workspace.fs.writeFile(vscode.Uri.file(destination.fsPath.replace(/\.obj$/i, '.mtl')), mtl);
		} finally {
			// the watcher's event can come after the write returns
			setTimeout(() => this.writing = false, 500);
		}
	}

	async writeStl(file: string) {
		const mesh = await this.meshes.mesh();
		const handle = await fs.promises.open(file, 'w');
		try {
			const out = new bin.async.stream(
				async () => 0,
				async (offset, data) => { await handle.write(data, 0, data.length, offset); },
			);
			await STL.saveAsync(out, mesh, path.basename(file, path.extname(file)));
		} finally {
			await handle.close();
		}
	}

	dispose() {
		this.fileWatcher?.dispose();
	}
}

class MeshViewer extends webview.Panel<MessageOut, MessageIn> {
	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: MeshDocument, private changed: (label: string, undo: () => void, redo: () => void) => void) {
		super(webviewPanel, assets);

		webviewPanel.webview.options = {enableScripts: true, localResourceRoots: assets.localRoots()};
		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/mesh.js', `Mesh · ${path.basename(document.uri.fsPath)}`, [
			<div id="main">
				<canvas id="viewport" />
				<div id="scad-tooltip" class="hidden" />
				<div id="scad-info" />
				<pre id="scad-error" class="hidden" />
			</div>,
		], 'tensors', ['assets/scad.css']);

	}

	edited(label: string, undo = ()=>{}, redo = ()=>{}) {
		this.changed(label, undo, redo);
	}

	async upload() {
		this.postMessage({command: 'model', ...await renderData(this.document.meshes.model!, this.document.ext)});
	}

	// the tolerance set from outside the page (undo, redo, revert)
	setTolerance(maxError: number) {
		this.document.meshes.tolerance = maxError;
		this.postMessage({command: 'tolerance', maxError});
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'getShaders': {
				const floor = await readShader(this.localUri('assets/floor.frag'));
				return {
					vert:		await readShader(this.localUri('assets/mesh.vert')),
					frag:		await readShader(this.localUri('assets/mesh.frag')),
					floorVert:	await readShader(this.localUri('assets/sdf.vert')),
					floorFrag:	(await readShader(this.localUri('assets/meshfloor.frag'))).replace('//@floor', floor),
				};
			}
			case 'getGlyphs':
				return digitAtlas();
			case 'simplify': {
				const meshes0 = this.document.meshes;
				const model = meshes0.model;
				// given up if the file is read again meanwhile
				const meshes = await meshes0.simplify(message.maxError, () => meshes0.model !== model);
				const before = meshes0.tolerance, after = message.maxError;
				if (model && meshes0.model === model && before !== after) {
					meshes0.tolerance = after;
					this.changed('Simplify', () => this.setTolerance(before), () => this.setTolerance(after));
				}
				return meshes;
			}
			case 'ready':
				this.upload();
				break;
			case 'error':
				vscode.window.showErrorMessage(`Mesh viewer: ${message.message}`);
				break;
		}
	}
}

export class MeshViewerProvider implements vscode.CustomEditorProvider<MeshDocument> {
	static provider: MeshViewerProvider;
	pending = new Map<string, Model>();
	editors = new Map<string, MeshViewer>();
	private readonly assets: webview.Assets;
	private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MeshDocument>>();
	readonly onDidChangeCustomDocument = this.changeEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		MeshViewerProvider.provider = this;
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('mesh.viewer', this, {webviewOptions: {retainContextWhenHidden: true}}),
		);
	}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext) {
		const key = uri.toString();
		const doc = new MeshDocument(uri, async () => {
			try {
				await doc.load();
				await this.editors.get(key)?.upload();
			} catch (error) {
				console.error('Failed to reload mesh document', error);
			}
		});

		if (this.pending.has(key)) {
			doc.init(this.pending.get(key)!);
			this.pending.delete(key);
		} else if (openContext.backupId) {
			await doc.load(vscode.Uri.parse(openContext.backupId), '.stl');
		} else {
			await doc.load();
		}

		return doc;
	}

	async saveCustomDocument(document: MeshDocument) {
		await document.write(document.uri);
	}

	async saveCustomDocumentAs(document: MeshDocument, destination: vscode.Uri) {
		await document.write(destination);
	}

	async revertCustomDocument(document: MeshDocument) {
		this.editors.get(document.uri.toString())?.setTolerance(0);
	}

	async backupCustomDocument(document: MeshDocument, context: vscode.CustomDocumentBackupContext) {
		await vscode.workspace.fs.writeFile(context.destination, (await document.encode(vscode.Uri.file('backup.stl'))).main);
		return {
			id: context.destination.toString(),
			delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} },
		};
	}

	async resolveCustomEditor(document: MeshDocument, webviewPanel: vscode.WebviewPanel) {
		// the floor's numbers are drawn in a font found among those installed
		await buildIndex();
		const editor = new MeshViewer(webviewPanel, this.assets, document, (label, undo, redo) => this.changeEmitter.fire({
			document, label, undo, redo
		}));
		this.editors.set(document.uri.toString(), editor);

		setActiveViewer(editor);
		webviewPanel.onDidDispose(() => {
			this.editors.delete(document.uri.toString());
		});
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
		});
	}

	static async open(name: string, model: Model) {
		const provider = this.provider;
		const uri = vscode.Uri.from({scheme: 'untitled', path: '/'+ name}), key = uri.toString();
		// already open from an earlier run: it shows the new one
		const open = provider.editors.get(key);
		if (open) {
			open.document.init(model);
			await open.upload();
		} else {
			provider.pending.set(key, model);
		}
		await vscode.commands.executeCommand('vscode.openWith', uri, 'mesh.viewer', {viewColumn: vscode.ViewColumn.Beside, preview: false});
		provider.editors.get(key)?.edited('Generate');
	}
}
