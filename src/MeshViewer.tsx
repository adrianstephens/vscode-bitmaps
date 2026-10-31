// The mesh viewer: a file read by @isopodlabs/binary_meshes, drawn by webview/mesh.ts. The file is watched, and drawn
// again when it changes, as an exported STL is each time it is exported.
import * as vscode from 'vscode';
import * as webview from '@isopodlabs/vscode_utils/webview';
import * as path from 'path';
import * as fs from 'fs';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import { Model, Mesh, Material, Attribute, placed, transform, faceTriangles, formatOf, STL, OBJ, PLY, GLB, GLTF, ThreeMF, smoothNormals, progressive, type Progression } from '@isopodlabs/binary_meshes';
import { buildIndex } from './fonts';
import type { RenderData, MeshData, InstanceData, TextureData, MessageIn, MessageOut } from '../webview/mesh';

import { setActiveViewer, readShader, digitAtlas } from './extension';
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
	// a triangle's sides that are sides of the file's face too, not cuts across it, as bits 0, 1, 2 for v0-v1, v1-v2, v2-v0
	const corners = order.flatMap(f => {
		const n = mesh.faces[f].length, side = (a: number, b: number) => (b - a + n) % n === 1 || (a - b + n) % n === 1;
		return faceTriangles(mesh, mesh.faces[f]).flatMap(([a, b, c]) => {
			const edges = (side(a, b) ? 1 : 0) | (side(b, c) ? 2 : 0) | (side(c, a) ? 4 : 0);
			return [a, b, c].map(k => ({f, k, edges}));
		});
	});

	const n			= corners.length;
	const positions	= new Float32Array(n * 3);
	// a normal per face is what the page works out from the face itself; only one that varies across a face is sent
	// (a file without normals gets them worked out, smooth except across sharp edges)
	const smooth	= mesh.normals ? (mesh.normals.per === 'face' ? undefined : mesh.normals) : smoothNormals(mesh);
	const normals	= smooth && new Float32Array(n * 3);
	const colors	= new Uint8Array(n * 4);
	const textured	= order.some(f => textureOf(f) >= 0);
	const uvs		= textured ? new Float32Array(n * 2) : undefined;
	const faces		= new Float32Array(n);
	const edges		= new Float32Array(n);
	corners.forEach(({f, k, edges: e}, i) => {
		edges[i] = e;
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
	return {positions, normals, colors, uvs, faces, edges, runs, lines, ...faceLabels(mesh, materials)};
}

// a texture's pixels, by what its bytes say it is
async function decode(data: Uint8Array): Promise<TextureData> {
	const image = bitmap.PNG.check(data) ? await bitmap.PNG.load(data)
		: data[0] === 0xFF && data[1] === 0xD8 ? bitmap.JPEG.load(data)
		: data[0] === 0x42 && data[1] === 0x4D ? bitmap.BMP.load(data)
		: data[0] === 0x47 && data[1] === 0x49 ? bitmap.GIF.load(data)
		: bitmap.TGA.load(data);
	const {width, height, pixels} = await image.getPixels({plane: 'RGBA'});
	return {width, height, data: new Uint8ClampedArray(pixels)};
}

// the model as the page takes it; y up for the formats whose files are usually drawn so
export async function renderData(model: Model, format: string): Promise<RenderData> {
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
		meshes:		data,
		instances,
		textures,
		unit:		model.unit ?? '',
		up:			format === '.obj' || format === '.ply' || format === '.gltf' || format === '.glb' ? 'y' : 'z',
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

// Models made by the extension rather than read from a file (a .scad's mesh), waiting for their editor to take them: the
// editor opens on an untitled document, so that Save As is what chooses the file and so the format
const pending = new Map<string, {model: Model, scad: boolean}>();
const viewers = new Map<string, MeshViewer>();

export async function openModel(name: string, model: Model) {
	const uri = vscode.Uri.from({scheme: 'untitled', path: name}), key = uri.toString();
	pending.set(key, {model, scad: true});
	// already open from an earlier run: it shows the new one
	await viewers.get(key)?.reload();
	await vscode.commands.executeCommand('vscode.openWith', uri, 'mesh.viewer', {viewColumn: vscode.ViewColumn.Beside, preview: false});
}

// the meshes placed, as one: their points where they are placed, and the materials of their faces
function combine(parts: Mesh[]): Mesh {
	const points: Mesh['points'] = [], faces: number[][] = [], faceMaterials: number[] = [];
	// (pushed one at a time: a spread of a large mesh's points is more arguments than the stack holds)
	for (const m of parts) {
		const base = points.length;
		for (const p of m.points)
			points.push(p);
		m.faces.forEach((f, i) => {
			faces.push(base ? f.map(v => v + base) : f);
			faceMaterials.push(m.faceMaterials?.[i] ?? -1);
		});
	}
	return faceMaterials.some(m => m >= 0) ? {points, faces, faceMaterials} : {points, faces};
}

class MeshDocument implements vscode.CustomDocument {
	// how far the meshes may stray from the file's; 0 is the file as it is. Changing it is what makes the document unsaved.
	tolerance = 0;
	announced = false;
	// not read from a file: there is no file until it is saved
	get untitled() { return this.uri.scheme === 'untitled'; }
	constructor(public readonly uri: vscode.Uri) {}
	dispose() {}
}

class MeshViewer extends webview.Panel<MessageOut, MessageIn> {
	private watch: vscode.FileSystemWatcher;
	private model?: Model;
	// each mesh's collapses, found on the first simplify and kept until the file is read again, so a tolerance is a replay
	private progressions?: Promise<Progression[]>;

	// set while this writes the file, so that the watcher does not read back what was just written
	private writing = false;

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

		const file = document.uri.fsPath;
		// (nothing to watch for what is not in a file yet)
		this.watch = vscode.workspace.createFileSystemWatcher(document.untitled ? '**/.mesh-untitled' : new vscode.RelativePattern(path.dirname(file), path.basename(file)));
		this.watch.onDidChange(() => !this.writing && this.load());
		this.watch.onDidCreate(() => !this.writing && this.load());
	}

	dispose() {
		this.watch.dispose();
	}

	// the meshes of the model, simplified to the document's tolerance, placed and made one
	private async mesh(): Promise<Mesh> {
		const model = this.model;
		if (!model)
			throw new Error('the file has not been read');
		const originals = [...new Set(placed(model.build).map(p => p.mesh))];
		const simplified = this.document.tolerance && this.progressions ? (await this.progressions).map(p => p.within(this.document.tolerance)) : originals;
		return combine(placed(model.build).map(({mesh, transform: m}) => ({...transform(simplified[originals.indexOf(mesh)], m), faceMaterials: simplified[originals.indexOf(mesh)].faceMaterials})));
	}

	// the file as it would be saved, by the extension of where it goes (and the .mtl beside an OBJ, when it has materials)
	async encode(destination: vscode.Uri): Promise<{main: Uint8Array, mtl?: Uint8Array}> {
		const model = this.model!, ext = path.extname(destination.fsPath).toLowerCase(), mesh = await this.mesh();
		// from a .scad: millimetres, Z up, where glTF is metres and Y up
		const scad = pending.get(this.document.uri.toString())?.scad;
		const materials = model.materials, name = path.basename(destination.fsPath, ext);
		switch (ext) {
			case '.stl':	return {main: STL.save(mesh, name)};
			case '.obj':	return {main: OBJ.save(mesh, materials, materials.length ? name + '.mtl' : undefined), mtl: materials.length ? OBJ.saveMtl(materials) : undefined};
			case '.ply':	return {main: PLY.save(mesh, materials)};
			case '.glb':	return {main: GLB.save(mesh, materials, scad ? {metresPerUnit: 0.001, yUp: true} : undefined)};
			case '.gltf':	return {main: GLTF.saveText(mesh, materials, scad ? {metresPerUnit: 0.001, yUp: true} : undefined)};
			case '.3mf':	return {main: await ThreeMF.save(mesh, scad ? 'millimeter' : undefined, materials)};
		}
		const format = formatOf(ext);
		if (!format?.save)
			throw new Error(`${ext} files cannot be written; use Save As to write another format`);
		return {main: await format.save(mesh)};
	}

	async write(destination: vscode.Uri) {
		const {main, mtl} = await this.encode(destination);
		this.writing = true;
		try {
			await vscode.workspace.fs.writeFile(destination, main);
			if (mtl)
				await vscode.workspace.fs.writeFile(vscode.Uri.file(destination.fsPath.replace(/\.obj$/i, '.mtl')), mtl);
		} finally {
			// the watcher's event can come after the write returns
			setTimeout(() => this.writing = false, 500);
		}
	}

	// a backup is an STL: geometry only, which is all that has to be kept of the work
	async backup(destination: vscode.Uri) {
		await vscode.workspace.fs.writeFile(destination, (await this.encode(vscode.Uri.file('backup.stl'))).main);
	}

	reload() {
		return this.load();
	}

	// the tolerance set from outside the page (undo, redo, revert)
	setTolerance(maxError: number) {
		this.document.tolerance = maxError;
		this.postMessage({command: 'tolerance', maxError});
	}

	private async load() {
		const uri = this.document.uri, ext = path.extname(uri.fsPath).toLowerCase();
		try {
			const made = pending.get(uri.toString());
			if (made) {
				this.model = made.model;
				this.progressions = undefined;
				this.document.tolerance = 0;
				this.postMessage({command: 'model', ...await renderData(this.model, ext)});
				return;
			}
			const format = formatOf(ext);
			if (!format)
				throw new Error(`${ext} is not a mesh format this reads`);
			const bytes = await vscode.workspace.fs.readFile(uri);
			// the files it names (an OBJ's .mtl, the images of its textures), beside it
			const dir = path.dirname(uri.fsPath);
			this.model = await format.read(bytes, {file: async name => {
				try {
					return await fs.promises.readFile(path.resolve(dir, name));
				} catch {
					return undefined;
				}
			}});
			this.progressions = undefined;
			this.document.tolerance = 0;
			this.postMessage({command: 'model', ...await renderData(this.model, ext)});
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
			case 'simplify': {
				// what renderData sends, in its order: each mesh the build places, once
				const model = this.model;
				if (!model)
					return [];
				// built a little at a time, so the editor stays alive; given up if the file is read again meanwhile
				const yielding = bitmap.Yielder(15, () => this.model !== model);
				this.progressions ??= Promise.all([...new Set(placed(model.build).map(p => p.mesh))].map(m => progressive(m, {}, yielding)));
				const meshes = (await this.progressions).map(p => meshData(p.within(message.maxError), model.materials, []));
				const before = this.document.tolerance, after = message.maxError;
				if (this.model === model && before !== after) {
					this.document.tolerance = after;
					this.changed('Simplify', () => this.setTolerance(before), () => this.setTolerance(after));
				}
				return meshes;
			}
			case 'ready':
				this.load();
				break;
			case 'error':
				vscode.window.showErrorMessage(`Mesh viewer: ${message.message}`);
				break;
		}
	}
}

export class MeshViewerProvider implements vscode.CustomEditorProvider<MeshDocument> {
	private readonly assets: webview.Assets;
	private readonly editors = new Map<MeshDocument, MeshViewer>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MeshDocument>>();
	readonly onDidChangeCustomDocument = this.changeEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('mesh.viewer', this, {webviewOptions: {retainContextWhenHidden: true}}),
		);
	}

	openCustomDocument(uri: vscode.Uri) {
		return new MeshDocument(uri);
	}

	async saveCustomDocument(document: MeshDocument) {
		await this.editors.get(document)?.write(document.uri);
	}

	async saveCustomDocumentAs(document: MeshDocument, destination: vscode.Uri) {
		await this.editors.get(document)?.write(destination);
	}

	async revertCustomDocument(document: MeshDocument) {
		this.editors.get(document)?.setTolerance(0);
	}

	async backupCustomDocument(document: MeshDocument, context: vscode.CustomDocumentBackupContext) {
		await this.editors.get(document)?.backup(context.destination);
		return {
			id: context.destination.toString(),
			delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} },
		};
	}

	async resolveCustomEditor(document: MeshDocument, webviewPanel: vscode.WebviewPanel) {
		// the floor's numbers are drawn in a font found among those installed
		await buildIndex();
		const editor = new MeshViewer(webviewPanel, this.assets, document, (label, undo, redo) => this.changeEmitter.fire({document, label, undo, redo}));
		this.editors.set(document, editor);
		viewers.set(document.uri.toString(), editor);
		// a mesh that is only in memory is unsaved from the start, so closing it asks
		if (document.untitled && !document.announced) {
			document.announced = true;
			this.changeEmitter.fire({document, label: 'Generate', undo() {}, redo() {}});
		}
		setActiveViewer(editor);
		webviewPanel.onDidDispose(() => {
			this.editors.delete(document);
			viewers.delete(document.uri.toString());
			editor.dispose();
		});
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
		});
	}
}
