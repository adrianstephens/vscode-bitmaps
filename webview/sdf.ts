// The scad viewer's page: it fetches the raymarcher from the extension, splices in the map() the extension generated
// from the file, and draws it. Everything about the model is in that shader, so the page only has to place the
// camera, keep it lit as the model turns, and say so when the shader will not compile.
import { vscode, RPC, handleResult } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, Offscreen, rectGeometry } from './opengl.js';
import { vec, E3, float3, float3x3 } from '@isopodlabs/maths/vector';
import { Orbit, DEFAULT_FOVY } from './orbit.js';

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders'}
	| {command: 'getGlyphs'};

// $vpt/$vpr/$vpd/$vpf, present only where the file assigned them itself at its own top level -- see Evaluated.camera
export interface ScriptCamera { vpt?: [number, number, number], vpr?: [number, number, number], vpd?: number, vpf?: number }

export type MessageIn =
	| {command: 'sdf', code: string, data: Float32Array, center: vec<number, E3>, half: vec<number, E3>, info: string, warnings: string[], camera: ScriptCamera}
	| {command: 'error', message: string}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'};

export interface GlyphAtlas {
	chars: string, width: number, height: number, cellW: number, data: Uint8Array,
	pitch: number, spread: number, cellX0: number, cellY0: number, cellWEm: number, cellHEm: number, capHeight: number,
}

const $			= <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const post		= (message: MessageOut) => vscode.postMessage(message);

const canvas	= $<HTMLCanvasElement>('viewport');
const tooltip	= $<HTMLElement>('scad-tooltip');
const infoBox	= $<HTMLElement>('scad-info');
const errorBox	= $<HTMLElement>('scad-error');

const canvas3d	= new Canvas3D(canvas, {depth: false, onError: message => post({command: 'error', message})});
// RGBA32F is what the picker reads a hit back through: a plain float format, not the linearly-filtered kind the
// (now removed) voxel cache wanted, so only the base extension is asked for.
canvas3d.gl.getExtension('EXT_color_buffer_float');


// the file's own $vpt/$vpr/$vpd/$vpf, as of the last model it sent -- homeView()'s to apply, not live: like
// OpenSCAD's own preview, orbiting the camera never re-evaluates the file, so these only change on an edit
let scriptCamera: ScriptCamera = {};

let program:	ShaderProgram | undefined;
let pickProgram: ShaderProgram | undefined;			// answers what is under a point instead of drawing the picture
let pickTarget:	Offscreen | undefined;					// a single pixel, read back after each of the picker's passes
let source:		{vert: string, frag: string, lib: string, pick: string} | undefined;
let floorOn		= 1;
let debug		= 0;		// h: 0 the picture, 1 the marching steps taken per pixel
let center		= float3(0, 0, 0);
let half		= float3(1, 1, 1);
let frame		= 0;

// While the view is being moved the page is drawn at a fraction of its size, and the full picture is drawn once it has
// been still for a moment: the cost of a frame is the pixels in it.
const MOVING_SCALE	= 0.5;
const SETTLE_MS		= 180;
let renderScale		= 1;
let settle:		ReturnType<typeof setTimeout> | undefined;

// what the info line says: the model, then what the page knows about how it is drawing it
let infoText		= '';
let perfNote		= '';

// The numbers along the floor's axes are drawn by the shader from a distance atlas of the digits, baked by the
// extension from the same glyph curves text() draws with and sent once. Which numbers show, and how strongly, is the
// shader's business: each grid level owns its numbers and fades them exactly as it fades its lines.
let glyphs:			GlyphAtlas | undefined;
let glyphTexture:	WebGLTexture | null = null;

// The big unions the generator does not unroll (see sdf.ts's emitBatch) keep their leaves in a float texture, one
// RGBA32F texel to four numbers and 1024 texels to a row, which sdBatch() walks. It is bound to unit 1, whatever the
// model is, so the sampler never points at the glyph atlas.
const BATCH_UNIT = 1;
let batchTexture: WebGLTexture | null = null;


function showInfo() {
	infoBox.textContent = [infoText, debug ? 'steps' : '', perfNote].filter(Boolean).join(' \u00b7 ');
}

function sizeCanvas() {
	const ratio	= (window.devicePixelRatio || 1) * renderScale;
	const rect	= canvas.getBoundingClientRect();
	const w		= Math.max(1, Math.floor(rect.width * ratio));
	const h		= Math.max(1, Math.floor(rect.height * ratio));
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width	= w;
		canvas.height	= h;
	}
}

function render() {
	frame ||= requestAnimationFrame(() => {
		frame = 0;
		draw();
	});
}

// Called whenever the view moves: draws small now, and full size again when it has stopped.
function moving() {
	renderScale = MOVING_SCALE;
	clearTimeout(settle);
	settle = setTimeout(() => {
		renderScale = 1;
		render();
	}, SETTLE_MS);
}


function glyphUniforms() {
	if (!glyphs || !floorOn)
		return {u_glyphInfo: [0, 0, 0, 0]};
	canvas3d.bindTexture(canvas3d.gl.TEXTURE_2D, glyphTexture, 0);
	return {
		u_glyphs:		0,
		u_glyphCell:	[glyphs.cellX0, glyphs.cellY0, glyphs.cellWEm, glyphs.cellHEm],
		u_glyphInfo:	[glyphs.pitch, glyphs.spread, glyphs.chars.length, glyphs.capHeight],
	};
}

function setBatch(data: Float32Array) {
	const gl = canvas3d.gl;
	if (data.length === 0) {
		if (batchTexture)
			gl.deleteTexture(batchTexture);
		batchTexture = null;
		return;
	}
	const rows		= Math.ceil(data.length / 4 / 1024);
	const padded	= new Float32Array(rows * 1024 * 4);
	padded.set(data);

//	batchTexture ??= canvas3d.createTexture(1024, rows, padded, {format: 'rgba32f', min: 'nearest', mag: 'nearest'});
	batchTexture ??= gl.createTexture();
	gl.activeTexture(gl.TEXTURE0 + BATCH_UNIT);
	gl.bindTexture(gl.TEXTURE_2D, batchTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, rows, 0, gl.RGBA, gl.FLOAT, padded);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.activeTexture(gl.TEXTURE0);
}

function batchUniforms() {
	if (!batchTexture)
		return {};
	canvas3d.bindTexture(canvas3d.gl.TEXTURE_2D, batchTexture, BATCH_UNIT);
	return {u_batch: BATCH_UNIT};
}

function draw() {
	sizeCanvas();
	canvas3d.initViewport();
	const gl = canvas3d.gl;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.clearColor(0.08, 0.09, 0.11, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);
	if (!program)
		return;
	program.draw({
		u_floorOn:		floorOn,
		// the world size of a pixel one unit away: orbit.fovy is the cotangent of half the vertical field of view
		u_pixel:		2 / (orbit.fovy * canvas.height),
		// the same for the display, whatever size the frame is being drawn at (it is half size while the view moves), so
		// the floor's numbers keep their size on screen
		u_labelPixel:	2 / (orbit.fovy * Math.max(1, canvas.getBoundingClientRect().height * (window.devicePixelRatio || 1))),
		u_debug:		debug,
		u_center:		center._values,
		u_half:			half._values,
		u_origin:		cameraOrigin()._values,
		u_basis:		orbit.basis.flat(),
		u_fovy:			orbit.fovy,
		u_aspect:		canvas.width / canvas.height,
		...glyphUniforms(),
		...batchUniforms(),
	});
}

// where the camera is: the point the shader's own u_origin uniform carries, which the picker needs in JS too
const cameraOrigin	= () => orbit.eye;
const size			= () => half.len();

const rad 			= (deg: number) => deg * Math.PI / 180;

function homeView() {
	const cam		= scriptCamera;
	const target	= cam.vpt ? float3(cam.vpt[0], cam.vpt[1], cam.vpt[2]) : center;
	orbit.look(target,
		cam.vpd ?? size() / Math.sin(Math.atan(1 / orbit.fovy)) * 1.1,
		cam.vpr ? float3.rotateZ(rad(cam.vpr[2])).matmul(float3.rotateY(rad(cam.vpr[1]))).matmul(float3.rotateX(rad(cam.vpr[0]))) : float3x3.identity()
	);
}

new ResizeObserver(draw).observe(canvas);

//--- interaction -------------------------------------------------------------

// the point a drag or a zoom holds on to: what the picker finds under the cursor, the model or the floor
const orbit: Orbit = new Orbit(canvas, {
	anchor:		(x, y): float3 => {
		const hit = pickAt(x, y);
		return hit && hit.kind > -0.5 ? hit.pos : orbit.along(x, y, center, size());
	},
	size,
	changed:	() => {
		moving();
		render();
	},
	dragStart:	() => hideTooltip(),
	zoomed:		(x, y) => schedulePick(x, y),
});

//--- the tooltip ---------------------------------------------------------

function hideTooltip() {
	tooltip.classList.add('hidden');
}

// A hover is answered by the picker rather than the mirror: the mirror is the CPU's copy of the field and never
// leaves the extension host, so the one thing the page can ask is the same GPU shader that already drew the pixel,
// traced again for the single point under the cursor. Three passes -- position and kind, then normal and material,
// then colour and opacity -- since a pass only has the one vec4 a fragment shader returns, and reading three floats
// back a few times a second costs nothing next to drawing the picture itself.
const pickPixel = new Float32Array(4);

// What is under a point of the canvas: kind 1 the model, 0 the floor, -1 nothing; undefined if there is no picker.
// full also reads the normal, the material and the colour, which only the tooltip wants.
function pickAt(clientX: number, clientY: number, full = false) {
	if (!program || !pickProgram || !pickTarget)
		return undefined;
	const rect = canvas.getBoundingClientRect();
	const ndc = {
		x: ((clientX - rect.left) / rect.width) * 2 - 1,
		y: 1 - ((clientY - rect.top) / rect.height) * 2,
	};
	const common = {
		u_center:		center._values,
		u_half:			half._values,
		u_origin:		cameraOrigin()._values,
		u_basis:		orbit.basis.flat(),
		u_fovy:			orbit.fovy,
		u_aspect:		canvas.width / canvas.height,
		u_floorOn:		floorOn,
		u_pickNdc:		[ndc.x, ndc.y],
		...batchUniforms(),
	};
	// The canvas keeps blending on for the picture, where it never shows -- every branch of the main shader writes
	// alpha 1, so the "over" it blends with is always the whole fragment. Here alpha carries a real number (the
	// kind, the material, the opacity), and blending it against whatever the last pass left in the same one-pixel
	// target corrupts exactly the channel this reads, so it is turned off for these draws alone.
	const gl = canvas3d.gl;
	gl.disable(gl.BLEND);
	const read = (mode: number) => {
		pickTarget!.begin();
		pickProgram!.draw({...common, u_pickMode: mode});
		pickTarget!.readPixels(pickPixel);
		pickTarget!.end();
		return float3(pickPixel[0], pickPixel[1], pickPixel[2]);
	};

	const pos = read(0), kind = pickPixel[3];
	const normal = full && kind > -0.5 ? read(1) : float3(0, 0, 0), mat = pickPixel[3];
	const colour = full && kind > 0.5 ? read(2) : undefined;
	const opacity = pickPixel[3];
	gl.enable(gl.BLEND);
	return {pos, kind, normal, mat, colour, opacity};
}

function pick(clientX: number, clientY: number) {
	const rect = canvas.getBoundingClientRect();
	const hit = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
		? pickAt(clientX, clientY, true) : undefined;
	if (!hit || hit.kind < -0.5) {
		hideTooltip();
		return;
	}
	const {pos, kind, normal, mat, colour, opacity} = hit;

	const p3 = (v: float3) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
	const lines = [
		`(${p3(pos)}) mm`,
		`${pos.sub(cameraOrigin()).len().toFixed(1)} mm from the camera`,
	];
	if (kind > 0.5 && colour) {
		lines.push(
			`normal (${p3(normal)})`,
			`material ${Math.round(mat)}: rgb(${Math.round(colour.x * 255)}, ${Math.round(colour.y * 255)}, ${Math.round(colour.z * 255)})${opacity < 0.99 ? `, opacity ${opacity.toFixed(2)}` : ''}`,
		);
	} else {
		lines.push('floor');
	}
	tooltip.textContent = lines.join('\n');
	tooltip.style.left = `${clientX - rect.left + 14}px`;
	tooltip.style.top = `${clientY - rect.top + 14}px`;
	tooltip.classList.remove('hidden');
}

// Coalesced to one pick a frame: the pointer can move many times before the next paint, and only the last position by then is worth asking about.
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

// g toggles the floor, which is the one thing here that is not the model
window.addEventListener('keydown', event => {
	switch (event.key.toLowerCase()) {
		case 'g':
			floorOn = floorOn ? 0 : 1;
			break;
		case 'h':
			debug = debug ? 0 : 1;
			showInfo();
			break;
		case 'p':
			benchmark();
			return;
		default:
			return;
	}
	render();
});

// How long a frame takes at full size. The GPU runs on after a draw call returns and finish() does not always wait
// for it, but reading a pixel back does, so each draw is followed by one and timed by the clock: the median of
// several, after some frames thrown away while the GPU's clock comes up.
function benchmark() {
	if (!program)
		return;
	const gl		= canvas3d.gl;
	const pixel		= new Uint8Array(4);
	const scale		= renderScale, wasDebug = debug;
	renderScale		= 1;
	debug			= 0;
	const samples: number[] = [];
	for (let i = 0; i < 28; i++) {
		const t0 = performance.now();
		draw();
		gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
		if (i >= 12)
			samples.push(performance.now() - t0);
	}
	perfNote		= `${canvas.width}\u00d7${canvas.height}: ${samples.sort((a, b) => a - b)[samples.length >> 1].toFixed(1)} ms a frame`;
	renderScale = scale; debug = wasDebug;
	showInfo();
	render();
}

//--- the generated model -----------------------------------------------------

// A shader that will not compile is the one failure this page cannot draw around, so the log is put where the model would be rather than only reported.
function compile(code: string) {
	if (!source)
		return false;
	try {
		program = canvas3d.createProgram({vert: source.vert, frag: source.frag.replace('//@lib', source.lib).replace('//@sdf', code)}, rectGeometry);
		errorBox.classList.add('hidden');
	} catch (error: any) {
		program = undefined;
		errorBox.textContent = String(error?.message ?? error);
		errorBox.classList.remove('hidden');
		return false;
	}
	// The picker shares the model's own generated code, but nothing depends on it compiling: if it does not, the
	// tooltip just stays off, which is worth trying quietly rather than turning into a page error of its own.
	try {
		pickProgram = canvas3d.createProgram({vert: source.vert, frag: source.pick.replace('//@lib', source.lib).replace('//@sdf', code)}, rectGeometry);
		pickTarget ??= canvas3d.createOffscreen(1, 1, 'rgba32f');
	} catch (error) {
		pickProgram = undefined;
		console.warn('the pick shader did not compile; the tooltip is disabled', error);
	}
	return true;
}

function setModel(message: Extract<MessageIn, {command: 'sdf'}>) {
	const hadProgram = !!program;
	// the camera is kept across an edit, so a change to the file does not move the view
	const untouched = !hadProgram;// || message.center.some((v, i) => v !== center[i]) || message.half.some((v, i) => v !== half[i]);
	center			= float3(message.center.x, message.center.y, message.center.z);
	half			= float3(message.half.x, message.half.y, message.half.z);
	scriptCamera	= message.camera;
	orbit.fovy		= message.camera.vpf !== undefined ? 1 / Math.tan(message.camera.vpf * Math.PI / 360) : DEFAULT_FOVY;
	program			= undefined;
	setBatch(message.data);
	if (!compile(message.code) || untouched)
		homeView();
	infoText 		= `${message.info}${message.warnings.length ? ` — ${message.warnings.join('; ')}` : ''}`;
	perfNote		= '';
	showInfo();
	draw();
}

//--- messages ----------------------------------------------------------------

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'sdf':
			setModel(message);
			break;
		case 'error':
			errorBox.textContent = message.message;
			errorBox.classList.remove('hidden');
			break;
		case 'fitToWindow':
			homeView();
			render();
			break;
		case 'resetZoom':
			homeView();
			render();
			break;
	}
});

RPC<GlyphAtlas | undefined>({command: 'getGlyphs'}).then(atlas => {
	if (atlas) {
		glyphs			= atlas;
		glyphTexture	??= canvas3d.createTexture(atlas.width, atlas.height, atlas.data, {format: 'r8', min: 'linear', mag: 'linear'});
		render();
	}
}).catch(() => {});		// no numbers on the floor is not worth an error

RPC<{vert: string, frag: string, lib: string, pick: string}>({command: 'getShaders'}).then(shaders => {
	source = shaders;
	homeView();
	post({command: 'ready'});
}).catch(error => post({command: 'error', message: String(error?.message ?? error)}));
