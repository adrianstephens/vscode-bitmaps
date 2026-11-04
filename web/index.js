// The start page: a file dropped, pasted or chosen here is handed to the editor page for its type.
import {openers, handOff} from './common.js';

// the editor of each kind of file, by extension; `page` is missing for an editor that has no web page yet
const editors = [
	{name: 'Bitmap editor',	page: 'bitmap.html',	extensions: 'png jpg jpeg gif webp bmp dds psd tga tif tiff'},
	{name: 'SVG editor',	page: 'svg.html',		extensions: 'svg'},
	{name: 'Font viewer',	page: 'font.html',		extensions: 'ttf otf woff woff2 ttc otc'},
	{name: 'Mesh viewer',	page: 'mesh.html',		extensions: 'stl obj ply glb gltf 3mf off amf dxf dwg'},
	{name: 'SCAD viewer',	page: 'scad.html',		extensions: 'scad'},
];
const editorFor = name => {
	const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	return editors.find(e => e.extensions.split(' ').includes(ext));
};

document.getElementById('types').textContent = editors.filter(e => e.page).map(e => `${e.name}: ${e.extensions.replace(/ /g, ', ')}`).join('   ·   ');

const welcome = openers('Drop a file here, paste one, or', 'Open file…', '', async file => {
	const editor = editorFor(file.name);
	if (!editor)
		return welcome.message(`${file.name}: not a type any editor here opens`);
	if (!editor.page)
		return welcome.message(`${file.name}: the ${editor.name.toLowerCase()} is not available on the web yet`);
	await handOff(file);
	location.href = `./${editor.page}?handoff`;
}, file => !!editorFor(file.name) || file.type.startsWith('image/'));
