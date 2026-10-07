// The .scad viewer: it parses and evaluates the document into a field, generates the raymarcher for that field, and
// hands it to the page. It is a custom *text* editor, so the document is the ordinary TextDocument: typing in it (or
// in a text editor beside it) re-renders, and nothing is written back.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';

import { files, setActiveViewer, readShader } from './extension';
import { webviewPage } from './BitmapViewer';
import type { MessageOut, MessageIn } from '../webview/sdf';
import { evaluateWithFiles, FileCacheEntry } from './scad/evaluate';
import { buildIndex, digitAtlas } from './scad/fonts';
import { bounds3, emitGlsl, countPrimitives, emptyReason, materials, union } from './scad/sdf';
import { float3 } from '@isopodlabs/maths/vector';

import { meshAdaptive, checkMesh, Cancelled } from './scad/mesher';
import { STL } from '@isopodlabs/binary_meshes';

const DEBOUNCE = 250;		// ms of quiet before a keystroke is evaluated

class ScadViewer extends webview.Panel<MessageOut, MessageIn> {
	private pendingRender?:	ReturnType<typeof setTimeout>;
	private disposed	= false;
	private watch:		vscode.Disposable;
	// a render that waits on a surface()'s PNG can be overtaken by a later edit's, and only the latest is drawn
	private renders		= 0;
	// what the files this document reads amount to, so an edit does not rebuild an imported mesh that has not changed
	private fileCache	= new Map<string, FileCacheEntry>();

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: vscode.TextDocument) {
		super(webviewPanel, assets);

		webviewPanel.webview.options = {enableScripts: true, localResourceRoots: assets.localRoots()};
		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/sdf.js', `OpenSCAD · ${path.basename(document.uri.fsPath)}`, [
			<div id="main">
				<canvas id="viewport" />
				<div id="scad-tooltip" class="hidden" />
				<div id="scad-info" />
				<pre id="scad-error" class="hidden" />
			</div>,
		], 'tensors', ['assets/scad.css']);

		this.watch = vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document === this.document) {
				if (this.pendingRender)
					clearTimeout(this.pendingRender);
				this.pendingRender = setTimeout(() => {
					this.pendingRender = undefined;
					if (!this.disposed)
						this.render();
				}, DEBOUNCE);
			}
		});
	}

	dispose() {
		this.disposed = true;
		this.watch.dispose();
		if (this.pendingRender)
			clearTimeout(this.pendingRender);
	}


	// what the current text says the model is
	private async model(): Promise<Extract<MessageIn, {command: 'sdf'}> | {error: string}> {
		const text = this.document.getText();
		const name = this.document.uri.fsPath;
		try {
			const evaluated = await evaluateWithFiles(text, name, files, this.fileCache);
			const {warnings} = evaluated;
			let sdf = evaluated.sdf;
			if (evaluated.flat) {
				// 2-D shapes outside an extrude are drawn as sheets, a thousandth of the picture thick
				const all = bounds3(union([sdf, evaluated.flat(0)]));
				if (all)
					sdf = union([sdf, evaluated.flat(Math.max(all.max.x - all.min.x, all.max.y - all.min.y, all.max.z - all.min.z) * 1e-3)]);
			}
			const empty = emptyReason(sdf, warnings);
			if (empty)
				return {error: empty};
			const box = bounds3(sdf)!;

			const {helpers, body, data} = emitGlsl(sdf);
			// map() returns the distance and the material together, so both come out of the one evaluation
			const code = [...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n');
			const size = box.max.sub(box.min);
			const center = box.max.add(box.min).scale(0.5);
			const count = countPrimitives(sdf);
			const mm = size._values.map(v => v.toFixed(1)).join(' x ');
			const materials_ = materials(sdf).length - 1;
			return {
				command:	'sdf',
				code, data, center,
				half:		size.scale(0.5).add(float3(1e-3, 1e-3, 1e-3)),
				info:		`${count} primitives, ${mm} mm, ${helpers.length} generated functions${materials_ ? `, ${materials_} material${materials_ === 1 ? '' : 's'}` : ''}`,
				warnings,
				camera:		evaluated.camera,
			};
		} catch (error: any) {
			return {error: `${error?.message ?? error}`};
		}
	}


	private async render() {
		const which = ++this.renders;
		const model = await this.model();
		if (which !== this.renders || this.disposed)
			return;
		if ('error' in model) {
			this.postMessage({command: 'error', message: model.error});
			return;
		}
		this.postMessage(model);
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'getShaders':
				return {
					vert:	await readShader(this.localUri('assets/sdf.vert')),
					lib:	await readShader(this.localUri('assets/sdflib.frag')),
					frag:	(await readShader(this.localUri('assets/sdf.frag'))).replace('//@floor', await readShader(this.localUri('assets/floor.frag'))),
					pick:	await readShader(this.localUri('assets/sdfpick.frag')),
				};

			// undefined when no usable font is installed, in which case the floor simply goes without numbers
			case 'getGlyphs':
				return digitAtlas();

			case 'ready':
				this.render();
				break;

			case 'error':
				vscode.window.showErrorMessage(`OpenSCAD: ${message.message}`);
				break;
		}
	}
}

export class ScadViewerProvider implements vscode.CustomTextEditorProvider {
	private readonly assets: webview.Assets;
	private active: ScadViewer | undefined;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('scad.viewer', this, {webviewOptions: {retainContextWhenHidden: true}, supportsMultipleEditorsPerDocument: true}),
			// the preview is opened beside the text rather than instead of it, so the file stays editable; as a preview
			// tab it is replaced by the next file opened there rather than piling up
			vscode.commands.registerCommand('scad.openPreview', async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri;
				if (target)
					await vscode.commands.executeCommand('vscode.openWith', target, 'scad.viewer', {viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true});
			}),
		);
	}

	async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel) {
		await buildIndex();
		const editor = new ScadViewer(webviewPanel, this.assets, document);
		const activate = () => {
			this.active = editor;
			setActiveViewer(editor);
		};
		activate();

		webviewPanel.onDidDispose(() => {
			editor.dispose();
			if (this.active === editor)
				this.active = undefined;
		});
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				activate();
		});
	}
}

export async function exportStl(target: vscode.Uri, destination: vscode.Uri, name: string) {
	// what the file says now, saved or not -- the same text the preview draws
	const document = await vscode.workspace.openTextDocument(target);

	try {
		// a final export, not the live preview -- OpenSCAD's own $preview is false for this too
		const result	= await evaluateWithFiles(document.getText(), target.fsPath, files, new Map<string, FileCacheEntry>, false);
		const empty		= emptyReason(result.sdf, result.warnings);
		if (empty)
			throw empty;

		const sdf		= result.sdf;
		const box		= bounds3(sdf)!;
		const size		= box.max.sub(box.min);
		const longest	= Math.max(size.x, size.y, size.z);

		// How fine: how far the mesh may lie from the surface where it is not divided further. Flat faces are exact whatever it
		// is, and the cells at creases and thin features are a few times smaller than it, so what it costs is the length of the
		// curved and creased parts, not the area of the model.
		const choices = [
			{label: 'Draft', tolerance: 0.1, detail: 'quick, for a look'},
			{label: 'Standard', tolerance: 0.02, detail: 'a good default'},
			{label: 'Fine', tolerance: 0.005, detail: 'smooth curves; slower, and a larger file'},
		].map(c => ({...c, description: `within ${c.tolerance} mm`}));
		const picked = await vscode.window.showQuickPick(choices, {
			title: `Export STL -- ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm`,
			placeHolder: 'How finely to mesh the model',
		});
		if (!picked)
			return;

		// next to the source, as OpenSCAD puts it, and replaced each time: it is an output of the file, not something to keep

		const started	= Date.now();
		const mesh		= await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Exporting STL', cancellable: true}, (progress, token) =>
			meshAdaptive(sdf, {
				// the smallest cells, a few times the tolerance
				cells: Math.min(8192, Math.max(256, Math.ceil(longest / (picked.tolerance * 4)))),
				tolerance: picked.tolerance,
				progress: message => progress.report({message}),
				cancelled: () => token.isCancellationRequested,
			})
		);
		
		if (!mesh.faces.length)
			throw 'the model produced no surface. Try a finer setting.';

		await vscode.workspace.fs.writeFile(destination, STL.save(mesh, name));

		// shown beside the source, in whatever editor is registered for .stl
		await vscode.commands.executeCommand('vscode.open', destination, {viewColumn: vscode.ViewColumn.Beside, preview: false});

		const stats		= checkMesh(mesh);
		const seconds	= ((Date.now() - started) / 1000).toFixed(1);
		const problems	= [
			stats.open			? `${stats.open} open edges` : '',
			stats.nonManifold	? `${stats.nonManifold} non-manifold edges` : '',
			stats.inconsistent	? `${stats.inconsistent} flipped edges` : '',
		].filter(Boolean);

		const summary = `Exported ${stats.triangles.toLocaleString()} triangles (within ${picked.tolerance} mm, ${seconds} s) to ${name}`;
		// a wall or gap thinner than the finest cell passes between its corners, and is left out rather than drawn wrong
		const thin = mesh.thin ? ` ${mesh.thin.toLocaleString()} of the finest cells (${mesh.cell.toPrecision(2)} mm) hold a wall or gap thinner than they are, which the mesh leaves out; a finer setting would keep it.` : '';
		if (problems.length)
			vscode.window.showWarningMessage(`${summary}. The surface is not perfectly closed (${problems.join(', ')}); most slicers repair this, but check the preview.${thin}`);
		else if (thin)
			vscode.window.showWarningMessage(`${summary}. Closed surface, volume ${stats.volume.toFixed(1)} mm³.${thin}`);
		else
			vscode.window.showInformationMessage(`${summary}. Closed surface, volume ${stats.volume.toFixed(1)} mm³.`);

	} catch (error: any) {
		if (error instanceof Cancelled)
			vscode.window.showInformationMessage('Export STL cancelled.');
		else
			vscode.window.showErrorMessage(`Export STL: ${error?.message ?? error}`);
	}
}
