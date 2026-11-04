// Stands in for the extension on a plain web page, for the mesh viewer (see host.js): a mesh opened by picker, drop, paste or ?src=url is read
// here by src/meshmodel.ts (bundled for the browser by web/build.js), and the page is given what it draws and what it asks to be simplified to.
// Other files dropped with it are the files it names (an OBJ's .mtl, the images of its textures). Save writes the mesh as simplified, in the
// format chosen beside it.
import {send, download, installHost, digitAtlas, openers, takeHandoff} from './common.js';

const $ = id => document.getElementById(id);
const formats = ['.stl', '.obj', '.ply', '.glb', '.gltf', '.3mf'];
const meshExtensions = /\.(stl|off|obj|ply|amf|3mf|gltf|glb|dxf|dwg)$/i;

let bundle, meshes, name = 'model.stl', ext = '.stl';
let named = new Map();			// the other files, by name

$('mesh-format').replaceChildren(...formats.map(f => new Option(f.slice(1).toUpperCase(), f)));

async function open(files) {
	const list = [...files], main = list.find(f => meshExtensions.test(f.name));
	if (!main) {
		welcome.message(`${list[0]?.name ?? 'that'}: not a mesh format this reads`);
		return;
	}
	try {
		bundle ??= await import('../out/web/mesh.js');
		named = new Map(list.filter(f => f !== main).map(f => [f.name.toLowerCase(), f]));
		const next = new bundle.MeshModel();
		ext = main.name.slice(main.name.lastIndexOf('.')).toLowerCase();
		await next.read(new Uint8Array(await main.arrayBuffer()), ext, async file => {
			const f = named.get(file.split(/[\\/]/).pop().toLowerCase());
			return f && new Uint8Array(await f.arrayBuffer());
		});
		meshes = next;
		name = main.name;
		$('mesh-name').textContent = name;
		$('mesh-format').value = formats.includes(ext) ? ext : '.stl';
		welcome.remove();
		send({command: 'model', ...await bundle.renderData(meshes.model, ext)});
	} catch (error) {
		console.error(error);
		if (meshes)
			send({command: 'error', message: `${main.name}: ${error?.message ?? error}`});
		else
			welcome.message(`${main.name}: ${error?.message ?? error}`);
	}
}
const welcome = openers('Drop a mesh here (and the files it names), paste one, or', 'Open mesh…', '.stl,.off,.obj,.ply,.amf,.3mf,.gltf,.glb,.dxf,.dwg,.mtl,image/*', file => open([file]), file => meshExtensions.test(file.name));

// dropping more than one file: the mesh and what it names
addEventListener('drop', e => {
	const files = [...(e.dataTransfer?.files ?? [])];
	if (files.length > 1) {
		e.stopImmediatePropagation();
		open(files);
	}
}, true);
$('mesh-open').onclick = () => Object.assign(document.createElement('input'), {type: 'file', multiple: true, onchange: e => open(e.target.files)}).click();

const shaders = async () => {
	const text = async file => { const r = await fetch(`../assets/${file}`); if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.text(); };
	const [vert, frag, floorVert, floorFrag, floor] = await Promise.all(['mesh.vert', 'mesh.frag', 'sdf.vert', 'meshfloor.frag', 'floor.frag'].map(text));
	return {vert, frag, floorVert, floorFrag: floorFrag.replace('//@floor', floor)};
};

async function command(message) {
	switch (message.command) {
		case 'ready': {
			const src = new URLSearchParams(location.search).get('src');
			if (src)
				open([Object.assign(await (await fetch(src)).blob(), {name: src.split('/').pop()})]);
			else if (location.search.includes('handoff')) {
				const file = await takeHandoff();
				if (file)
					open([file]);
			}
			break;
		}
		case 'getShaders':
			return shaders();
		case 'getGlyphs':
			return digitAtlas();
		case 'simplify': {
			const current = meshes?.model;
			const result = await meshes?.simplify(message.maxError, () => meshes?.model !== current) ?? [];
			if (meshes?.model === current)
				meshes.tolerance = message.maxError;
			return result;
		}
		case 'error':
			console.error(message.message);
			break;
	}
}

installHost(command);

async function save() {
	if (!meshes)
		return;
	const format = $('mesh-format').value, base = name.replace(/\.\w+$/, '');
	try {
		const {main, mtl} = await meshes.encode(base + format);
		download(new Blob([main]), base + format);
		if (mtl)
			download(new Blob([mtl]), base + '.mtl');
	} catch (error) {
		send({command: 'error', message: `${error?.message ?? error}`});
	}
}
$('mesh-save').onclick = save;
addEventListener('keydown', e => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
		e.preventDefault();
		save();
	}
});

await import('../out/webview/mesh.js');
