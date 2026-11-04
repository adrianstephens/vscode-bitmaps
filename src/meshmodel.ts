// A mesh model as the mesh viewer's page takes it, and the work on it that the application around it asks for: reading a file, simplifying
// to a tolerance, and writing a format. No `vscode` here (the extension's MeshViewer and a web page's host both use it).
import * as bitmap from '@isopodlabs/binary_bitmaps';
import { Model, Mesh, Material, Attribute, placed, transform, faceTriangles, formatOf, STL, OBJ, PLY, GLB, GLTF, ThreeMF, smoothNormals, progressive, type Progression } from '@isopodlabs/binary_meshes';
import type { RenderData, MeshData, InstanceData, TextureData } from '../webview/mesh';

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

export function meshData(mesh: Mesh, materials: Material[], textures: (TextureData | undefined)[]): MeshData {
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
		: bitmap.WebP.check(data) ? bitmap.WebP.load(data)
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

// A model, and what has been made of it: how far its meshes may stray from the file's, and the collapses that make that so
export class MeshModel {
	model?: Model;
	// how far the meshes may stray from the file's; 0 is the file as it is
	tolerance = 0;
	// each mesh's collapses, found on the first simplify and kept until the model is replaced, so a tolerance is a replay
	private progressions?: Promise<Progression[]>;

	// the model of a file's bytes (`file` reads the files it names: an OBJ's .mtl, the images of its textures)
	async read(bytes: Uint8Array, ext: string, file: (name: string) => Promise<Uint8Array | undefined>) {
		const format = formatOf(ext);
		if (!format)
			throw new Error(`${ext} is not a mesh format this reads`);
		return this.use(await format.read(bytes, {file}));
	}

	// a model that was made, not read
	use(model: Model) {
		this.model = model;
		this.progressions = undefined;
		this.tolerance = 0;
		return model;
	}

	// each mesh the build places, once, simplified to `maxError` and as the page takes them; built a little at a time, and given up
	// when `cancelled` (the model has been replaced meanwhile)
	async simplify(maxError: number, cancelled: () => boolean = () => false): Promise<MeshData[]> {
		const model = this.model;
		if (!model)
			return [];
		const yielding = bitmap.Yielder(15, cancelled);
		this.progressions ??= Promise.all([...new Set(placed(model.build).map(p => p.mesh))].map(m => progressive(m, {}, yielding)));
		return (await this.progressions).map(p => meshData(p.within(maxError), model.materials, []));
	}

	// the meshes of the model, simplified to the tolerance, placed and made one
	async mesh(): Promise<Mesh> {
		const model = this.model;
		if (!model)
			throw new Error('the file has not been read');
		const originals = [...new Set(placed(model.build).map(p => p.mesh))];
		const simplified = this.tolerance && this.progressions ? (await this.progressions).map(p => p.within(this.tolerance)) : originals;
		return combine(placed(model.build).map(({mesh, transform: m}) => ({...transform(simplified[originals.indexOf(mesh)], m), faceMaterials: simplified[originals.indexOf(mesh)].faceMaterials})));
	}

	// the model as a file of a name would hold it (and the .mtl beside an OBJ, when it has materials); `scad` when it was made by a .scad, in
	// millimetres and Z up, where glTF is metres and Y up
	async encode(name: string, scad = false): Promise<{main: Uint8Array, mtl?: Uint8Array}> {
		const dot = name.lastIndexOf('.'), ext = name.slice(dot < 0 ? name.length : dot).toLowerCase(), base = name.slice(name.lastIndexOf('/') + 1, dot < 0 ? name.length : dot);
		const mesh = await this.mesh(), materials = this.model!.materials;
		switch (ext) {
			case '.stl':	return {main: STL.save(mesh, base)};
			case '.obj':	return {main: OBJ.save(mesh, materials, materials.length ? base + '.mtl' : undefined), mtl: materials.length ? OBJ.saveMtl(materials) : undefined};
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
}
