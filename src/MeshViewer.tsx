// The mesh viewer: a file read by @isopodlabs/binary_meshes, drawn by webview/mesh.ts. The file is watched, and drawn
// again when it changes, as an exported STL is each time it is exported.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import { Model, Mesh, Material, Attribute, placed, faceTriangles, formatOf } from '@isopodlabs/binary_meshes';
import { buildIndex, digitAtlas } from './scad/fonts';
import type { MeshData, InstanceData, TextureData, MessageIn, MessageOut } from '../webview/mesh';

import { setActiveViewer, readShader } from './extension';
import { webviewPage } from './BitmapViewer';

const DEFAULT_COLOR = [0.72, 0.76, 0.82, 1];

// an attribute's value at corner k of face f, whose vertex is v, or undefined where it has none
function valueAt<T>(a: Attribute<T> | undefined, f: number, k: number, v: number): T | undefined {
	if (!a)
		return undefined;
	const i = a.per === 'corner' ? a.indices[f][k] : a.indices ? a.indices[a.per === 'vertex' ? v : f] : a.per === 'vertex' ? v : f;
	return i >= 0 ? a.values[i] : undefined;
}

// what a face is, in words: its material, and the face sets (layers, groups, volumes...) it is in
function faceLabels(mesh: Mesh, materials: Material[]) {
	const parts: string[][] = mesh.faces.map((_, f) => {
		const m = mesh.faceMaterials?.[f] ?? -1;
		return m >= 0 ? [`material ${materials[m]?.name ?? m}`] : [];
	});
	for (const [kind, sets] of Object.entries(mesh.faceSets ?? {}))
		for (const [name, faces] of Object.entries(sets))
			faces.forEach(f => parts[f].push(`${kind} ${name}`));
	const labels: string[] = [], index = new Map<string, number>();
	const faceLabels = Uint32Array.from(parts, p => {
		const label = p.join(', ');
		if (!index.has(label))
			index.set(label, labels.push(label) - 1);
		return index.get(label)!;
	});
	return {labels, faceLabels};
}

function meshData(mesh: Mesh, materials: Material[], textures: (TextureData | undefined)[]): MeshData {
	const material = (f: number) => materials[mesh.faceMaterials?.[f] ?? -1];
	// a face is textured when its material has a texture that could be decoded and the mesh gives texture coordinates
	const textureOf = (f: number) => {
		const t = material(f)?.texture;
		return mesh.uvs && t !== undefined && textures[t] ? t : -1;
	};
	const order = mesh.faces.map((_, f) => f).sort((a, b) => textureOf(a) - textureOf(b));
	const corners = order.flatMap(f => faceTriangles(mesh, mesh.faces[f]).flat().map(k => ({f, k})));

	const n			= corners.length;
	const positions	= new Float32Array(n * 3);
	// a normal per face is what the page works out from the face itself; only one that varies across a face is sent
	const smooth	= mesh.normals?.per === 'face' ? undefined : mesh.normals;
	const normals	= smooth && new Float32Array(n * 3);
	const colors	= new Uint8Array(n * 4);
	const textured	= order.some(f => textureOf(f) >= 0);
	const uvs		= textured ? new Float32Array(n * 2) : undefined;
	const faces		= new Float32Array(n);
	corners.forEach(({f, k}, i) => {
		const v = mesh.faces[f][k], p = mesh.points[v];
		positions.set([p.x, p.y, p.z], i * 3);
		const normal = valueAt(smooth, f, k, v);
		if (normals && normal)
			normals.set([normal.x, normal.y, normal.z], i * 3);
		const c = valueAt(mesh.colors, f, k, v);
		const rgba = c ? [c.x, c.y, c.z, c.w] : material(f)?.color ? [material(f).color!.x, material(f).color!.y, material(f).color!.z, material(f).color!.w] : DEFAULT_COLOR;
		colors.set(rgba.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255)), i * 4);
		const uv = uvs && valueAt(mesh.uvs, f, k, v);
		if (uv)
			uvs!.set([uv.x, uv.y], i * 2);
		faces[i] = f;
	});

	// runs of corners that share a texture, in the order the faces were sorted into
	const runs: MeshData['runs'] = [];
	corners.forEach(({f}, i) => {
		const texture = textureOf(f);
		if (runs.at(-1)?.texture === texture)
			runs.at(-1)!.count++;
		else
			runs.push({texture, first: i, count: 1});
	});

	const lines = new Float32Array((mesh.lines ?? []).flatMap(l => l.slice(1).flatMap((v, j) => [l[j], v])).flatMap(v => [mesh.points[v].x, mesh.points[v].y, mesh.points[v].z]));
	return {positions, normals, colors, uvs, faces, runs, lines, ...faceLabels(mesh, materials)};
}

// a texture's pixels, by what its bytes say it is
async function decode(data: Uint8Array): Promise<TextureData> {
	const image = bitmap.PNG.check(data) ? await bitmap.PNG.load(data)
		: data[0] === 0xFF && data[1] === 0xD8 ? bitmap.JPEG.load(data)
		: data[0] === 0x42 && data[1] === 0x4D ? bitmap.BMP.load(data)
		: data[0] === 0x47 && data[1] === 0x49 ? bitmap.GIF.load(data)
		: bitmap.TGA.load(data);
	const {width, height, pixels} = await image.getPixels({plane: 'RGBA'});
	return {width, height, pixels: new Uint8Array(pixels)};
}

// the model as the page takes it; y up for the formats whose files are usually drawn so
export async function renderData(model: Model, format: string): Promise<Extract<MessageIn, {command: 'model'}>> {
	const warnings: string[] = [];
	const textures = await Promise.all(model.textures.map(async (t, i) => {
		if (!t.data) {
			warnings.push(`texture ${t.path ?? i} not found`);
			return undefined;
		}
		try {
			return await decode(t.data);
		} catch (error: any) {
			warnings.push(`texture ${t.path ?? i} could not be decoded (${error?.message ?? error})`);
			return undefined;
		}
	}));

	const meshes = new Map<Mesh, number>(), data: MeshData[] = [];
	const instances: InstanceData[] = placed(model.build).map(({mesh, transform: m}) => {
		if (!meshes.has(mesh)) {
			meshes.set(mesh, data.length);
			data.push(meshData(mesh, model.materials, textures));
		}
		return {mesh: meshes.get(mesh)!, transform: m, object: model.objects.find(o => o.mesh === mesh)?.name ?? ''};
	});

	// what of the file is not drawn: a CAD drawing's other entities, and what its reader could not read
	for (const [key, what] of [['entities', 'not drawn'], ['unsupported', 'not read']] as const) {
		const counts = model.extras[key];
		const list: [string, number][] = counts instanceof Map ? [...counts] : counts ? Object.entries(counts) : [];
		if (list.length)
			warnings.push(`${list.reduce((n, [, k]) => n + k, 0)} ${what} (${list.map(([k, n]) => `${n} ${k}`).join(', ')})`);
	}

	const triangles	= data.reduce((n, d) => n + d.faces.length / 3, 0);
	const segments	= data.reduce((n, d) => n + d.lines.length / 6, 0);
	const drawn		= instances.reduce((n, i) => n + data[i.mesh].faces.length / 3, 0);
	return {
		command:	'model',
		meshes:		data,
		instances,
		textures,
		unit:		model.unit ?? '',
		up:			format === '.obj' || format === '.ply' ? 'y' : 'z',
		info:		[
			format.slice(1).toUpperCase(),
			`${data.length} mesh${data.length === 1 ? '' : 'es'}${instances.length !== data.length ? `, ${instances.length} placed` : ''}`,
			`${triangles.toLocaleString()} triangles${drawn !== triangles ? ` (${drawn.toLocaleString()} drawn)` : ''}`,
			segments ? `${segments.toLocaleString()} line segments` : '',
			model.materials.length ? `${model.materials.length} material${model.materials.length === 1 ? '' : 's'}` : '',
			model.unit ?? '',
		].filter(Boolean).join(' · '),
		warnings,
	};
}

class MeshDocument implements vscode.CustomDocument {
	constructor(public readonly uri: vscode.Uri) {}
	dispose() {}
}

class MeshViewer extends webview.Panel<MessageOut, MessageIn> {
	private watch: vscode.FileSystemWatcher;

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: MeshDocument) {
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

		const file = document.uri.fsPath;
		this.watch = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
		this.watch.onDidChange(() => this.load());
		this.watch.onDidCreate(() => this.load());
	}

	dispose() {
		this.watch.dispose();
	}

	private async load() {
		const uri = this.document.uri, ext = path.extname(uri.fsPath).toLowerCase();
		try {
			const format = formatOf(ext);
			if (!format)
				throw new Error(`${ext} is not a mesh format this reads`);
			const bytes = await vscode.workspace.fs.readFile(uri);
			// the files it names (an OBJ's .mtl, the images of its textures), beside it
			const dir = path.dirname(uri.fsPath);
			const model = await format.read(bytes, {file: name => {
				const full = path.resolve(dir, name);
				return fs.existsSync(full) ? new Uint8Array(fs.readFileSync(full)) : undefined;
			}});
			this.postMessage(await renderData(model, ext));
		} catch (error: any) {
			this.postMessage({command: 'error', message: `${path.basename(uri.fsPath)}: ${error?.message ?? error}`});
		}
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
			case 'ready':
				this.load();
				break;
			case 'error':
				vscode.window.showErrorMessage(`Mesh viewer: ${message.message}`);
				break;
		}
	}
}

export class MeshViewerProvider implements vscode.CustomReadonlyEditorProvider<MeshDocument> {
	private readonly assets: webview.Assets;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('mesh.viewer', this, {webviewOptions: {retainContextWhenHidden: true}, supportsMultipleEditorsPerDocument: true}),
		);
	}

	openCustomDocument(uri: vscode.Uri) {
		return new MeshDocument(uri);
	}

	async resolveCustomEditor(document: MeshDocument, webviewPanel: vscode.WebviewPanel) {
		// the floor's numbers are drawn in a font found among those installed
		await buildIndex();
		const editor = new MeshViewer(webviewPanel, this.assets, document);
		setActiveViewer(editor);
		webviewPanel.onDidDispose(() => editor.dispose());
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
		});
	}
}
