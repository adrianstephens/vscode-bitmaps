// The .scad viewer: it parses and evaluates the document into a field, generates the raymarcher for that field, and
// hands it to the page. It is a custom *text* editor, so the document is the ordinary TextDocument: typing in it (or
// in a text editor beside it) re-renders, and nothing is written back.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';

import { parse, type UserModule } from './scad/parser';
import { files, setActiveViewer, readShader, digitAtlas } from './extension';
import { webviewPage } from './BitmapViewer';
import type { MessageOut, MessageIn } from '../webview/sdf';
import { evaluate, evaluateCsg } from './scad/evaluate';
import { buildIndex } from './fonts';
import * as SDF from './scad/sdf';
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
	// a module the menu asked to run, called after the file's own text; the file draws nothing itself when it is offered
	private run?:		string;
	// what the files this document reads amount to, so an edit does not rebuild an imported mesh that has not changed

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
	private async render() {
		const which		= ++this.renders;
		const source	= this.document.getText();
		const name		= this.document.uri.fsPath;
		try {
			const file		= await files.with(() => parse(source, name, files));
			const modules	= [...file.scope.modules.values()];
			const callable	= (m: UserModule) => m.parameters.every(p => p.expr);
			const names		= [...modules.filter(callable), ...modules.filter(m => !callable(m))].map(m => m.name);

			if (this.run && !names.includes(this.run))
				this.run = undefined;

			//const text = this.run ? `${source}\n${this.run}();\n` : source;
			const {sdf, warnings, box, camera} = await files.with(() => evaluate(file, name, files, {$preview: true, $entry: this.run}));

			this.postMessage({command: 'modules', names: !box || this.run ? names : [], running: this.run});

			if (!box || !Number.isFinite(box.min.x) || !Number.isFinite(box.min.y) || !Number.isFinite(box.min.z)) {
				//this.postMessage({command: 'error', message: `nothing is drawn: ${!box ? 'no geometry reached the top level (check the conditions around it)' : 'the geometry has no finite extent'}.${warnings.length ? `\n\nThe evaluator also reported:\n  ${warnings.join('\n  ')}` : ''}`});
				return;
			}
		
			const center	= box.max.add(box.min).scale(0.5);
			const size		= box.max.sub(box.min);
			
			let stripped = false;
			let sdf2 = sdf.walk((sdf, process) => {
				switch (sdf.k) {
					case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2': case 'offset':
						stripped = true;
						return SDF.empty;
					case 'offset': case 'extrude': case 'revolve':
						return sdf;			// these are what a 2-D shape is for
					default:
						return process(sdf);
				}
			});

			if (stripped) {
				warnings.push('a 2-D shape (circle, square or polygon) outside linear_extrude/rotate_extrude, which the viewer draws as a flat sheet and an export leaves out');

				const thickness = Math.max(size.x, size.y, size.z) * 1e-3;
				const sheet = (body: SDF.Sdf): SDF.Sdf => ({k: 'extrude', h: thickness, center: true, body});

				const flat = sdf.walk((s, process) => {
					switch (s.k) {
						case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2': case 'offset':
							return sheet(s);
						case 'union':
							// one sheet for a union of shapes, as one extrude takes them, so a big union is still one the batch can hold
							return s.children.every(SDF.is2d) ? sheet(s) : process(s);
						case 'intersection':
							return s.children.every(SDF.is2d) ? sheet(s) : SDF.empty;
						case 'difference':
							return SDF.is2d(s.base) ? sheet(s) : SDF.empty;
						case 'domain':
							return SDF.is2d(s.body) ? sheet(s) : SDF.empty;
						case 'material':
							return process(s);
						default:
							return SDF.empty;
					}
				});
				
				sdf2 = SDF.union([sdf2, flat]);
			}

			const palette	= SDF.materials(sdf2);

			const {helpers, body, data} = SDF.emitGlsl(sdf2);
			// map() returns the distance and the material together, so both come out of the one evaluation
			const code		= [...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n');
			const count		= SDF.countPrimitives(sdf2);

			if (which !== this.renders || this.disposed)
				return;

			this.postMessage({
				command:	'sdf',
				code, data, center,
				half:		size.scale(0.5).add(float3(1e-3, 1e-3, 1e-3)),
				info:		`${count} primitives, ${size._values.map(v => v.toFixed(1)).join(' x ')} mm, ${helpers.length} generated functions${palette.length > 1 ? `, ${palette.length - 1} material${palette.length === 2 ? '' : 's'}` : ''}`,
				warnings,
				camera,
			});
		} catch (error: any) {
			this.postMessage({command: 'error', message: `${error?.message ?? error}`});
		}
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

			case 'run':
				this.run = message.name;
				this.render();
				break;

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
		const file		= await files.with(() => parse(document.getText(), target.fsPath, files));
		const result	= await files.with(() => evaluate(file, target.fsPath, files, {$preview: false}));
		const sdf		= result.sdf;
		const box		= sdf.bounds()!;

		if (!box)
			throw `nothing is drawn: no geometry reached the top level (check the conditions around it)`;

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

export async function exportCsg(target: vscode.Uri, destination: vscode.Uri) {
	try {
		const document	= await vscode.workspace.openTextDocument(target);
		const result	= await files.with(() => evaluateCsg(document.getText(), target.fsPath, files));
		await vscode.workspace.fs.writeFile(destination, Buffer.from(result.csg, 'utf8'));
		await vscode.commands.executeCommand('vscode.open', destination, {viewColumn: vscode.ViewColumn.Beside, preview: false});
		if (result.warnings.length)
			vscode.window.showWarningMessage(`Exported ${path.basename(destination.fsPath)}, with: ${result.warnings.join('; ')}`);
		else
			vscode.window.showInformationMessage(`Exported ${path.basename(destination.fsPath)}`);
	} catch (error: any) {
		vscode.window.showErrorMessage(`Export CSG: ${error?.message ?? error}`);
	}
}
