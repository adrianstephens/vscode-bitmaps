// The mesh viewer's page: it draws the meshes the extension read from a file, each where the file places it, over the
// floor the scad viewer draws, and says what is under the cursor.
import { vscode, RPC, handleResult } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, Offscreen, rectGeometry, createVertexArray } from './opengl.js';
import { Orbit } from './orbit.js';
import { float3, float4, float3x3, float3x4, float4x4, matmul, matmulExt} from '@isopodlabs/maths/vector';
import type { GlyphAtlas } from './sdf.js';

// one mesh as the page draws it: a vertex per corner of each triangle, in runs that share a texture
export interface MeshData {
	positions:	Float32Array;		// 3 a corner
	normals?:	Float32Array;		// 3 a corner, when the file has normals
	colors:		Uint8Array;			// rgba a corner
	uvs?:		Float32Array;		// 2 a corner, when a run is textured
	faces:		Float32Array;		// the face of the file's mesh each corner is of
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

export interface TextureData {
	width:		number;
	height:		number;
	pixels:		Uint8Array;			// rgba, row 0 the top
}

export interface Model {
	meshes:		MeshData[],
	instances:	InstanceData[],
	textures:	(TextureData | undefined)[],
	info:		string,
	warnings:	string[],
	unit:		string,
	up:			'y' | 'z'
}

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders'}
	| {command: 'getGlyphs'};

export type MessageIn =
	| ({command: 'model'} & Model)
	| {command: 'error', message: string}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'};

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
let model:			Model | undefined;
let up:				'y' | 'z' = 'z';
let floorOn			= true;
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
	half	= empty ? float3(1, 1, 1) : ext.extent().scale(0.5).max(float3(1e-6, 1e-6, 1e-6));
}

//--- drawing -----------------------------------------------------------------

const orbit: Orbit = new Orbit(canvas, {
	anchor:		(x, y): float3 => pickAt(x, y)?.pos ?? floorAt(x, y) ?? orbit.along(x, y, center, size()),
	size,
	changed:	() => render(),
	dragStart:	() => hideTooltip(),
	zoomed:		(x, y) => schedulePick(x, y),
});

function home() {
	// from in front, to the right and above, as the scad viewer starts
	const rz = float3.rotateZ(25 * Math.PI / 180), rx = float3.rotateX(55 * Math.PI / 180);
	orbit.look(center, size() / Math.sin(Math.atan(1 / orbit.fovy)) * 1.1, rz.matmul(rx) as float3x3);
}

// Each instance of each mesh, in the program's current mode; window turns clip space for the picker
function drawMeshes(viewProj: float4x4, pick: number) {
	const p = program!;
	for (const [index, instance] of (model?.instances ?? []).entries()) {
		const mesh = gpuMeshes[instance.mesh], m = instanceMatrix(instance);
		p.use({u_model: affine(m.flat()), u_viewProj: viewProj.flat(), u_pick: pick, u_instance: index, u_mirrored: m.det() < 0 ? 1 : 0, u_lit: 1});
		gl.bindVertexArray(mesh.vao);
		for (const run of mesh.data.runs) {
			const texture = run.texture >= 0 ? gpuTextures[run.texture] : undefined;
			if (texture)
				canvas3d.bindTexture(gl.TEXTURE_2D, texture, 0);
			p.use({u_textured: texture ? 1 : 0, u_texture: 0});
			gl.drawArrays(gl.TRIANGLES, run.first, run.count);
		}
		if (mesh.lines && !pick) {
			p.use({u_lit: 0, u_textured: 0});
			gl.bindVertexArray(mesh.lines.vao);
			gl.vertexAttrib4f(gl.getAttribLocation(p.program, 'a_color'), 0.85, 0.87, 0.9, 1);
			gl.drawArrays(gl.LINES, 0, mesh.lines.count);
		}
	}
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
	canvas3d.bindTexture(gl.TEXTURE_2D, glyphTexture, 1);
	return {
		u_glyphs:		1,
		u_glyphCell:	[glyphs.cellX0, glyphs.cellY0, glyphs.cellWEm, glyphs.cellHEm],
		u_glyphInfo:	[glyphs.pitch, glyphs.spread, glyphs.chars.length, glyphs.capHeight],
	};
}

//--- what is under the cursor ------------------------------------------------

let pickTarget: Offscreen | undefined;
const pickPixel = new Float32Array(4);

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
		pickTarget!.readPixels(pickPixel);
		pickTarget!.end();
		return [...pickPixel];
	};
	const first = read(1);
	const result = first[3] < 0 ? undefined : {
		pos:		float3(first[0], first[1], first[2]),
		instance:	Math.round(first[3]),
		face:		full ? Math.round(read(2)[0]) : -1,
		colour:		full ? read(3) : undefined,
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
	const data		= model.meshes[instance.mesh];
	const p3		= (v: float3) => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
	const label		= hit.face >= 0 ? data.labels[data.faceLabels[hit.face]] : '';
	const c			= hit.colour!;
	tooltip.textContent = [
		`(${p3(hit.pos)})${model.unit ? ` ${model.unit}` : ''}`,
		`${hit.pos.sub(orbit.eye).len().toFixed(2)} from the camera`,
		`${instance.object || 'object'}, face ${hit.face}${label ? `: ${label}` : ''}`,
		`rgb(${[c[0], c[1], c[2]].map(v => Math.round(v * 255)).join(', ')})${c[3] < 0.99 ? `, alpha ${c[3].toFixed(2)}` : ''}`,
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

// g the floor; u which axis is up
window.addEventListener('keydown', event => {
	switch (event.key.toLowerCase()) {
		case 'g':
			floorOn = !floorOn;
			break;
		case 'u':
			up = up === 'z' ? 'y' : 'z';
			measure();
			home();
			showInfo();
			break;
		default:
			return;
	}
	render();
});

function showInfo() {
	if (model)
		infoBox.textContent = `${model.info} · ${up} up${model.warnings.length ? ` — ${model.warnings.join('; ')}` : ''}`;
}

//--- messages ----------------------------------------------------------------

function fixFloat3({x, y, z}: float3) { return float3(x, y, z); }
function fixFloat3x4({x, y, z, w}: float3x4) { return float3x4(fixFloat3(x), fixFloat3(y), fixFloat3(z), fixFloat3(w)); }

function setModel(m: Model) {
	const first = !model;

	for (const i of m.instances) {
		i.transform = fixFloat3x4(i.transform);
	}

	model	= m;
	up		= m.up;
	
	for (const m of gpuMeshes)
		gl.deleteVertexArray(m.vao);
	gpuTextures.forEach(t => t && gl.deleteTexture(t));

	gpuMeshes	= m.meshes.map(makeGpuMesh);
	gpuTextures	= m.textures.map(t => t && canvas3d.createTextureFromImage({data: t.pixels, width: t.width, height: t.height}, {min: 'linear', mag: 'linear'}));

	measure();
	if (first)
		home();
	errorBox.classList.add('hidden');
	hideTooltip();
	showInfo();
	draw();
}

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'model':
			if (program)
				setModel(message);
			break;
		case 'error':
			errorBox.textContent = message.message;
			errorBox.classList.remove('hidden');
			break;
		case 'fitToWindow':
		case 'resetZoom':
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
