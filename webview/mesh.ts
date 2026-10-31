// The mesh viewer's page: it draws the meshes the extension read from a file, each where the file places it, over the
// floor the scad viewer draws, and says what is under the cursor.
import { vscode, RPC, handleResult } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, RGBAPixels, ShaderProgram, Offscreen, rectGeometry, createVertexArray } from './opengl.js';
import { Orbit } from './orbit.js';
import { Input } from './navigate.js';
import { Gizmo } from './gizmo.js';
import { Cascade, CascadeItem, svgFace, choiceItem, toggleItem, sliderItem, valueFace, icons as commonIcons } from './cascade.js';
import { float3, float4, float3x3, float3x4, float4x4, matmul, matmulExt} from '@isopodlabs/maths/vector';
import type { GlyphAtlas } from './sdf.js';

// one mesh as the page draws it: a vertex per corner of each triangle, in runs that share a texture
export interface MeshData {
	positions:	Float32Array;		// 3 a corner
	normals?:	Float32Array;		// 3 a corner, when the file has normals
	colors:		Uint8Array;			// rgba a corner
	uvs?:		Float32Array;		// 2 a corner, when a run is textured
	faces:		Float32Array;		// the face of the file's mesh each corner is of
	edges:		Float32Array;		// per corner, which sides of its triangle are sides of the file's face (bits 0, 1, 2)
	runs:		{texture: number, first: number, count: number}[];	// texture -1: none
	lines:		Float32Array;		// 3 an end, two ends a segment
	labels:		string[];			// what a face is, as faceLabels names it
	faceLabels:	Uint32Array;		// per face of the file's mesh, an index into labels
}

export interface InstanceData {
	mesh:		number;
	transform:	float3x4;			// 12: the columns of a 3x4 matrix
	object:		string;
}

export type TextureData = RGBAPixels;

export interface RenderData {
	meshes:		MeshData[],
	instances:	InstanceData[],
	textures:	(RGBAPixels | undefined)[],
	info:		string,
	warnings:	string[],
	unit:		string,
	up:			'y' | 'z'
}

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders'}
	| {command: 'getGlyphs'}
	| {command: 'simplify', maxError: number};		// replied to with every mesh, as MeshData in the model's order

export type MessageIn =
	| ({command: 'model'} & RenderData)
	| {command: 'error', message: string}
	| {command: 'fitToWindow'}
	| {command: 'tolerance', maxError: number};		// the simplification set from outside the page

interface Shaders { vert: string, frag: string, floorVert: string, floorFrag: string }

const $			= <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const post		= (message: MessageOut) => vscode.postMessage(message);

const canvas	= $<HTMLCanvasElement>('viewport');
const tooltip	= $<HTMLElement>('scad-tooltip');
const infoBox	= $<HTMLElement>('scad-info');
const errorBox	= $<HTMLElement>('scad-error');

const canvas3d	= new Canvas3D(canvas, {onError: message => post({command: 'error', message})});
const gl		= canvas3d.gl;
gl.getExtension('EXT_color_buffer_float');

//--- matrices ----------------------------------------------------------------

// a 3x4 matrix's columns, as the extension sends them, made square
const affine	= (m: number[]) => new Float32Array([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]);

//--- the model ---------------------------------------------------------------

let program:		ShaderProgram | undefined;
let floorProgram:	ShaderProgram | undefined;
let gpuMeshes:		GpuMesh[] = [];
let gpuTextures:	(WebGLTexture | undefined)[] = [];
let model:			RenderData | undefined;
let up:				'y' | 'z' = 'z';
let floorOn			= true;

// how the model is drawn, which the menu changes
const view = {
	display:	'solid' as 'solid' | 'wire' | 'edges',		// edges: all of it, with the edges over
	shading:	'smooth' as 'smooth' | 'flat' | 'unlit',
	colours:	true,
	lines:		true,
	backs:		'tint' as 'tint' | 'plain' | 'hide',
};
let center			= float3(0, 0, 0);
let half			= float3(1, 1, 1);
const size			= () => half.len();

interface GpuMesh {
	vao:		WebGLVertexArrayObject;
	lines?:		{vao: WebGLVertexArrayObject, count: number};
	data:		MeshData;
}

function makeGpuMesh(data: MeshData) {
	return {
		vao:	createVertexArray(gl, program!.program, {
			a_position:	{size: 3, data: data.positions},
			a_normal:	data.normals && {size: 3, data: data.normals},
			a_color:	{size: 4, data: data.colors},
			a_uv:		data.uvs && {size: 2, data: data.uvs},
			a_face:		{size: 1, data: data.faces},
			a_edges:	{size: 1, data: data.edges},
		}),
		lines: data.lines.length ? {vao: createVertexArray(gl, program!.program, {a_position: {size: 3, data: data.lines}}), count: data.lines.length / 3} : undefined,
		data
	};
}

const Y_UP = float3x3(float3(1, 0, 0), float3(0, 0, 1), float3(0, -1, 0));
const instanceMatrix = (i: InstanceData) => up === 'z' ? i.transform : i.transform.mulAffine(Y_UP);

// the box everything placed is in, from each mesh's own box turned by where it is placed
function measure() {
	const boxes = gpuMeshes.map(({data: {positions: p, lines: l}}) => {
		const ext = new float3.extent;
		for (const a of [p, l])
			for (let i = 0; i < a.length; i += 3)
				ext.add(float3(a[i], a[i + 1], a[i + 2]));
		return ext;
	});
	let ext = new float3.extent;
	for (const instance of model?.instances ?? []) {
		const box = boxes[instance.mesh], m = instanceMatrix(instance);
		if (box.min.x > box.max.x)
			continue;
		for (let c = 0; c < 8; c++) {
			const p = m.mul({x: c & 1 ? box.max.x : box.min.x, y: c & 2 ? box.max.y : box.min.y, z: c & 4 ? box.max.z : box.min.z, w:1});
			ext.add(p);
		}
//		ext.combine(box);
	}
	const empty = ext.min.x > ext.max.x;
	center	= empty ? float3(0, 0, 0) : ext.centre();
	half	= empty ? float3(1, 1, 1) : ext.size().scale(0.5).max(float3(1e-6, 1e-6, 1e-6));
}

//--- drawing -----------------------------------------------------------------

const orbit: Orbit = new Orbit(canvas, {
	anchor:		(x, y): float3 => pickAt(x, y)?.pos ?? floorAt(x, y) ?? orbit.along(x, y, center, size()),
	size,
	redraw:	() => render(),
	dragStart:	() => hideTooltip(),
	zoomed:		(x, y) => schedulePick(x, y),
	contextMenu:(x, y) => { hideTooltip(); menu.open(x, y); }

});
Input.on(canvas).add(orbit);
const gizmo = new Gizmo(canvas, orbit.gizmoHooks());

function home() {
	// from in front, to the right and above, as the scad viewer starts
	const rz = float3.rotateZ(25 * Math.PI / 180), rx = float3.rotateX(55 * Math.PI / 180);
	orbit.look(center, size() / Math.sin(Math.atan(1 / orbit.fovy)) * 1.1, rz.matmul(rx) as float3x3);
}

// Each instance of each mesh, in the program's current mode; window turns clip space for the picker
function drawMeshes(viewProj: float4x4, pick: number) {
	const p = program!;
	for (const [index, instance] of (model?.instances ?? []).entries()) {
		const mesh = gpuMeshes[instance.mesh], m = instanceMatrix(instance), mirrored = m.det() < 0;
		p.use({
			u_model: affine(m.flat()), u_viewProj: viewProj.flat(), u_pick: pick, u_instance: index, u_mirrored: mirrored ? 1 : 0, u_lit: 1,
			u_shade:	view.shading === 'smooth' ? 0 : view.shading === 'flat' ? 1 : 2,
			u_wire:		view.display === 'solid' ? 0 : view.display === 'edges' ? 1 : 2,
			u_plain:	view.colours ? 0 : 1,
			u_backs:	view.backs === 'tint' ? 0 : 1,
		});
		if (view.backs === 'hide') {
			gl.enable(gl.CULL_FACE);
			gl.frontFace(mirrored ? gl.CW : gl.CCW);
		}
		gl.bindVertexArray(mesh.vao);
		for (const run of mesh.data.runs) {
			const texture = run.texture >= 0 ? gpuTextures[run.texture] : undefined;
			if (texture)
				canvas3d.bindTexture2D(texture, 0);
			p.use({u_textured: texture ? 1 : 0, u_texture: 0});
			gl.drawArrays(gl.TRIANGLES, run.first, run.count);
		}
		if (mesh.lines && !pick && view.lines) {
			p.use({u_lit: 0, u_textured: 0});
			gl.bindVertexArray(mesh.lines.vao);
			gl.vertexAttrib4f(gl.getAttribLocation(p.program, 'a_color'), 0.85, 0.87, 0.9, 1);
			gl.drawArrays(gl.LINES, 0, mesh.lines.count);
		}
	}
	gl.disable(gl.CULL_FACE);
	gl.bindVertexArray(null);
}

function floorUniforms(viewProj: float4x4) {
	return {
		u_half:			half._values,
		u_origin:		orbit.eye._values,
		u_basis:		orbit.basis.flat(),
		u_fovy:			orbit.fovy,
		u_aspect:		canvas.width / canvas.height,
		u_viewProj:		viewProj.flat(),
		u_pixel:		2 / (orbit.fovy * canvas.height),
		u_labelPixel:	2 / (orbit.fovy * canvas.height),
		...glyphUniforms(),
	};
}

let frame = 0;
function render() {
	frame ||= requestAnimationFrame(() => {
		frame = 0;
		draw();
	});
}

function draw() {
	gizmo.show(true);
	canvas3d.resize();
	canvas3d.initViewport();
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.clearColor(0.08, 0.09, 0.11, 1);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	if (!program || !floorProgram)
		return;
	const viewProj = matmulExt(orbit.projection(center, canvas.width / canvas.height), orbit.toview());
	gl.depthMask(false);
	floorProgram.draw({...floorUniforms(viewProj), u_floor: 0});
	gl.depthMask(true);
	program.use({u_origin: orbit.eye._values, u_basis: orbit.basis.flat()});
	drawMeshes(viewProj, 0);
	if (floorOn)
		floorProgram.draw({...floorUniforms(viewProj), u_floor: 1});
}

new ResizeObserver(draw).observe(canvas);

//--- the floor's numbers -----------------------------------------------------

let glyphs:			GlyphAtlas | undefined;
let glyphTexture:	WebGLTexture | null = null;

function setGlyphs(atlas: GlyphAtlas) {
	glyphs = atlas;
	glyphTexture = canvas3d.createTexture(atlas.width, atlas.height, atlas.data, {format: 'r8', min: 'linear', mag: 'linear'});
}

function glyphUniforms() {
	if (!glyphs)
		return {u_glyphInfo: [0, 0, 0, 0]};
	canvas3d.bindTexture2D(glyphTexture, 1);
	return {
		u_glyphs:		1,
		u_glyphCell:	[glyphs.cellX0, glyphs.cellY0, glyphs.cellWEm, glyphs.cellHEm],
		u_glyphInfo:	[glyphs.pitch, glyphs.spread, glyphs.chars.length, glyphs.capHeight],
	};
}

//--- what is under the cursor ------------------------------------------------

let pickTarget: Offscreen | undefined;

// what turns clip space so the pixel under (ndcX, ndcY) fills the viewport: for drawing that one pixel alone
function pickWindow(ndcX: number, ndcY: number, width: number, height: number): float4x4 {
	return float4x4(
		float4(width, 0, 0, 0),
		float4(0, height, 0, 0),
		float4(0, 0, 1, 0),
		float4(-ndcX * width, -ndcY * height, 0, 1)
	);
}

// The mesh under a point of the canvas, drawn again for that one pixel: its position and instance, then its face and
// its colour, each a pass since a pass has one vec4 to give. undefined where there is no mesh.
function pickAt(clientX: number, clientY: number, full = false) {
	if (!program || !model)
		return undefined;
	pickTarget ??= canvas3d.createOffscreen(1, 1, 'rgba32f', true);
	const rect	= canvas.getBoundingClientRect();
	const ndcX	= ((clientX - rect.left) / rect.width) * 2 - 1, ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
	
	const viewProj = matmul(pickWindow(ndcX, ndcY, rect.width, rect.height), matmulExt(orbit.projection(center, rect.width / rect.height), orbit.toview()));
	gl.disable(gl.BLEND);
	const read = (mode: number) => {
		pickTarget!.begin();
		gl.clearColor(0, 0, 0, -1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		program!.use({u_origin: orbit.eye._values, u_basis: orbit.basis.flat()});
		drawMeshes(viewProj, mode);
		const pixels = pickTarget!.readPixels();
		pickTarget!.end();
		return [...pixels];
	};
	const first = read(1);
	const result = first[3] < 0 ? undefined : {
		pos:		float3.load(first),
		instance:	Math.round(first[3]),
		face:		full ? Math.round(read(2)[0]) : -1,
		colour:		full ? float4.load(read(3)) : undefined,
	};
	gl.enable(gl.BLEND);
	return result;
}

// where the cursor's ray meets the floor, when the floor is drawn and in front
function floorAt(clientX: number, clientY: number) {
	const rd = orbit.basis.mul(orbit.ray(clientX, clientY));
	const t = -orbit.eye.z / rd.z;
	return floorOn && t > 0 && Number.isFinite(t) ? orbit.eye.add(rd.scale(t)) : undefined;
}

function hideTooltip() {
	tooltip.classList.add('hidden');
}

function pick(clientX: number, clientY: number) {
	const hit = pickAt(clientX, clientY, true);
	if (!hit || !model) {
		hideTooltip();
		return;
	}
	const instance	= model.instances[hit.instance];
	const data		= gpuMeshes[instance.mesh].data;
	const p3		= (v: float3) => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
	const label		= hit.face >= 0 ? data.labels[data.faceLabels[hit.face]] : '';
	const c			= hit.colour!;
	tooltip.textContent = [
		`(${p3(hit.pos)})${model.unit ? ` ${model.unit}` : ''}`,
		`${hit.pos.sub(orbit.eye).len().toFixed(2)} from the camera`,
		`${instance.object || 'object'}, face ${hit.face}${label ? `: ${label}` : ''}`,
		`rgb(${[c.x, c.y, c.z].map(v => Math.round(v * 255)).join(', ')})${c.w < 0.99 ? `, alpha ${c.w.toFixed(2)}` : ''}`,
	].join('\n');
	const rect = canvas.getBoundingClientRect();
	tooltip.style.left	= `${clientX - rect.left + 14}px`;
	tooltip.style.top	= `${clientY - rect.top + 14}px`;
	tooltip.classList.remove('hidden');
}

// one pick a frame, for the last position the pointer reached
let pickPending: {x: number, y: number} | undefined;
let pickFrame = 0;
function schedulePick(clientX: number, clientY: number) {
	pickPending = {x: clientX, y: clientY};
	pickFrame ||= requestAnimationFrame(() => {
		pickFrame = 0;
		if (pickPending)
			pick(pickPending.x, pickPending.y);
	});
}

canvas.addEventListener('pointermove', event => {
	if (!orbit.dragging)
		schedulePick(event.clientX, event.clientY);
});
canvas.addEventListener('pointerleave', () => {
	pickPending = undefined;
	hideTooltip();
});

//--- the menu ----------------------------------------------------------------

const icons = {
	solid:		'<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" fill="currentColor" fill-opacity=".35"/><path d="M2.5 5L8 8l5.5-3M8 8v6"/>',
	edges:		'<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" fill="currentColor" fill-opacity=".35"/><path d="M2.5 5L8 8l5.5-3M8 8v6M5.2 3.5l5.6 3M10.8 3.5l-5.6 3"/>',
	wire:		'<path d="M8 2l5.5 3v6L8 14l-5.5-3V5zM2.5 5L8 8l5.5-3M8 8v6"/>',
	smooth:		'<circle cx="8" cy="8" r="5.5" fill="currentColor" fill-opacity=".3"/><path d="M4.5 6.5c1-1.5 3-2 4.5-1.5"/>',
	flat:		'<path d="M8 2l5 3.5-1.5 6L8 14l-3.5-2.500L3 5.500z" fill="currentColor" fill-opacity=".3"/><path d="M8 2v5l5-1.500M8 7l-5-1.500M8 7l3.5 4.500M8 7l-3.5 4.5"/>',
	unlit:		'<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11"/>',
	colours:	'<circle cx="6" cy="6" r="3.5" fill="currentColor" fill-opacity=".25"/><circle cx="10" cy="6" r="3.5" fill="currentColor" fill-opacity=".25"/><circle cx="8" cy="10" r="3.5" fill="currentColor" fill-opacity=".25"/>',
	lines:		'<path d="M2 12L7 4l3 5 4-6"/>',
	tint:		'<path d="M3 4h10v8H3z" fill="currentColor" fill-opacity=".3"/><path d="M3 4l10 8"/>',
	plain:		'<path d="M3 4h10v8H3z"/>',
	hide:		'<path d="M3 4h10v8H3z" stroke-dasharray="2 2"/>',
	floor:		'<path d="M2 11l3-5h6l3 5zM6 6l-1 5M10 6l1 5M3.5 8.500h9"/>',
	up:			'<path d="M8 14V3M4.5 6.500L8 3l3.5 3.5"/>',
	fit:		'<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
	simplify:	'<path d="M2 12C5 3 11 3 14 12"/><rect x="1" y="11" width="3" height="3"/><rect x="12" y="11" width="3" height="3"/>',
};

// How far the drawn meshes may stray from the file's, simplified by the extension; 0 draws the file's own. Only one
// request is out at a time: one set while it is out is asked for when it comes back, so a drag shows each result it can.
let tolerance	= 0;
let asking		= false;

function simplifyTo(maxError: number) {
	tolerance = maxError;
	if (asking || !model)
		return;
	asking = true;
	showInfo();
	const asked = model;
	(maxError ? RPC<MeshData[]>({command: 'simplify', maxError}) : Promise.resolve(model.meshes))
		.then(meshes => {
			// a file read again since has replaced what this was made from
			if (model === asked) {
				setMeshes(meshes);
				draw();
			}
		})
		.catch(error => {
			if (model === asked) {
				errorBox.textContent = `simplify: ${error?.message ?? error}`;
				errorBox.classList.remove('hidden');
			}
		})
		.finally(() => {
			asking = false;
			showInfo();
			if (tolerance !== maxError)
				simplifyTo(tolerance);
		});
}

// 1, 2 or 5 times a power of ten, the least not below x
function niceUp(x: number) {
	const p = 10 ** Math.floor(Math.log10(x));
	return [1, 2, 5, 10].map(m => m * p).find(v => v >= x * (1 - 1e-9))!;
}

// The tolerance, on a slider that is logarithmic across three powers of ten up to a hundredth of the model's diagonal
// (from hardly changed to a few dozen triangles), with none at its start. What the slider holds is the place along it.
function simplifyItem(): CascadeItem {
	const DECADES	= 3;
	const top		= niceUp(2 * size() / 100);
	const toleranceAt	= (s: number) => s > 0 ? top * 10 ** (DECADES * (s - 1)) : 0;
	const placeOf		= (t: number) => t > 0 ? 1 + Math.log10(t / top) / DECADES : 0;
	const format		= (t: number) => t ? `${+t.toPrecision(2)}${model?.unit ? ` ${model.unit}` : ''}` : 'off';
	return {
		...sliderItem({
			label:		'tol',
			caption:	'Simplify, staying within',
			get:		() => placeOf(tolerance),
			set:		s => simplifyTo(toleranceAt(s)),
			min:		0,
			max:		1,
			// a notch is a quarter more or less, and the last below the slider's start is none
			step:		(s, steps) => {
				const next = s + steps / 30;
				return next < 1 / 60 ? 0 : next;
			},
			markers:	[0, 1 / 3, 2 / 3, 1],
			resolution:	1 / 300,
			format:		s => format(toleranceAt(s)),
		}),
		id:			'simplify',
		face:		() => tolerance ? valueFace('tol', `${+tolerance.toPrecision(2)}`) : svgFace(icons.simplify),
	};
}

const menu = new Cascade($('main'), (): CascadeItem[] => [
	{
		id:			'view',
		face:		() => svgFace(commonIcons.view),
		caption:	() => 'View',
		children:	() => [
			choiceItem('Display', [
				{value: 'solid' as const,	face: svgFace(icons.solid),	caption: 'Solid'},
				{value: 'edges' as const,	face: svgFace(icons.edges),	caption: 'Solid with edges'},
				{value: 'wire' as const,	face: svgFace(icons.wire),	caption: 'Wireframe'},
			], () => view.display, v => { view.display = v; render(); }),
			choiceItem('Shading', [
				{value: 'smooth' as const,	face: svgFace(icons.smooth),	caption: 'Smooth'},
				{value: 'flat' as const,	face: svgFace(icons.flat),		caption: 'Flat'},
				{value: 'unlit' as const,	face: svgFace(icons.unlit),		caption: 'Unlit'},
			], () => view.shading, v => { view.shading = v; render(); }),
			toggleItem('File colours and textures', svgFace(icons.colours), () => view.colours, v => { view.colours = v; render(); }),
			toggleItem('File lines', svgFace(icons.lines), () => view.lines, v => { view.lines = v; render(); }),
			choiceItem('Back faces', [
				{value: 'tint' as const,	face: svgFace(icons.tint),	caption: 'Tinted'},
				{value: 'plain' as const,	face: svgFace(icons.plain),	caption: 'As front faces'},
				{value: 'hide' as const,	face: svgFace(icons.hide),	caption: 'Hidden'},
			], () => view.backs, v => { view.backs = v; render(); }),
			toggleItem('Floor', svgFace(icons.floor), () => floorOn, v => { floorOn = v; render(); }),
			choiceItem('Up axis', [
				{value: 'z' as const,	face: svgFace(icons.up) + '<small>Z</small>',	caption: 'Z up'},
				{value: 'y' as const,	face: svgFace(icons.up) + '<small>Y</small>',	caption: 'Y up'},
			], () => up, setUp),
			{
				face:		() => svgFace(icons.fit),
				caption:	() => 'Fit to window',
				select:		() => { home(); render(); },
			},
		]
	},
	simplifyItem(),
]);

function setUp(value: 'y' | 'z') {
	up = value;
	measure();
	home();
	showInfo();
	render();
}

// g the floor; u which axis is up; w cycles solid, solid with edges, wireframe
window.addEventListener('keydown', event => {
	if (event.ctrlKey || event.metaKey || event.altKey)
		return;
	switch (event.key.toLowerCase()) {
		case 'g':
			floorOn = !floorOn;
			break;
		case 'u':
			setUp(up === 'z' ? 'y' : 'z');
			break;
		case 'w':
			view.display = view.display === 'solid' ? 'edges' : view.display === 'edges' ? 'wire' : 'solid';
			break;
		default:
			return;
	}
	menu.refresh();
	render();
});

function showInfo() {
	const triangles	= gpuMeshes.reduce((n, m) => n + m.data.faces.length / 3, 0);
	const simplified = asking ? ' · simplifying…' : tolerance ? ` · simplified to ${triangles.toLocaleString()} triangles` : '';
	if (model)
		infoBox.textContent = `${model.info}${simplified} · ${up} up${model.warnings.length ? ` — ${model.warnings.join('; ')}` : ''}`;
}

//--- messages ----------------------------------------------------------------

function fixFloat3({x, y, z}: float3) { return float3(x, y, z); }
function fixFloat3x4({x, y, z, w}: float3x4) { return float3x4(fixFloat3(x), fixFloat3(y), fixFloat3(z), fixFloat3(w)); }

// what is drawn of each of the model's meshes: the file's own, or simplified
function setMeshes(meshes: MeshData[]) {
	for (const m of gpuMeshes) {
		gl.deleteVertexArray(m.vao);
		if (m.lines)
			gl.deleteVertexArray(m.lines.vao);
	}
	gpuMeshes = meshes.map(makeGpuMesh);
	measure();
}

function setModel(m: RenderData) {
	for (const i of m.instances) {
		i.transform = fixFloat3x4(i.transform);
	}

	model		= m;
	up			= m.up;
	tolerance	= 0;
	gpuTextures.forEach(t => t && canvas3d.deleteTexture(t));
	gpuTextures	= m.textures.map(t => t && canvas3d.createTextureFromImage(t, {min: 'linear', mag: 'linear'}));
	setMeshes(m.meshes);
}

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'model':
			if (program) {
				const first = !model;
				setModel(message);
				menu.refresh();
				if (first)
					home();
				errorBox.classList.add('hidden');
				hideTooltip();
				showInfo();
				draw();
			}
			break;
		case 'error':
			errorBox.textContent = message.message;
			errorBox.classList.remove('hidden');
			break;
		case 'tolerance':
			simplifyTo(message.maxError);
			break;
		case 'fitToWindow':
			home();
			render();
			break;
	}
});

RPC<GlyphAtlas | undefined>({command: 'getGlyphs'})
	.then(atlas => {
		if (atlas) {
			setGlyphs(atlas);
			render();
		}
	})
	.catch(() => {});		// no numbers on the floor is not worth an error

RPC<Shaders>({command: 'getShaders'})
	.then(shaders => {
		program			= new ShaderProgram(gl, shaders.vert, shaders.frag);
		floorProgram	= canvas3d.createProgram({vert: shaders.floorVert, frag: shaders.floorFrag}, rectGeometry);
		post({command: 'ready'});
	})
	.catch(error => {
		errorBox.textContent = String(error?.message ?? error);
		errorBox.classList.remove('hidden');
		post({command: 'error', message: String(error?.message ?? error)});
	});
