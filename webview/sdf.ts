// The scad viewer's page: it fetches the raymarcher from the extension, splices in the map() the extension generated
// from the file, and draws it. Everything about the model is in that shader, so the page only has to place the
// camera, keep it lit as the model turns, and say so when the shader will not compile.
import { vscode, RPC, handleResult } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Canvas3D, ShaderProgram, Offscreen, rectGeometry } from './opengl.js';
import { vec, E3, float3, float3x3 } from '@isopodlabs/maths/vector';
import { Orbit, DEFAULT_FOVY } from './orbit.js';
import { Input } from './navigate.js';
import { Gizmo } from './gizmo.js';
import { Cascade, CascadeItem, svgFace, toggleItem } from './cascade.js';

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders'}
	| {command: 'getGlyphs'}
	| {command: 'run', name: string | undefined};

// $vpt/$vpr/$vpd/$vpf, present only where the file assigned them itself at its own top level -- see Evaluated.camera
export interface ScriptCamera { vpt?: float3, vpr?: float3, vpd?: number, vpf?: number }

export type MessageIn =
	| {command: 'sdf', code: string, data: Float32Array, center: vec<number, E3>, half: vec<number, E3>, info: string, warnings: string[], camera: ScriptCamera}
	| {command: 'error', message: string}
	| {command: 'modules', names: string[], running: string | undefined}
	| {command: 'fitToWindow'};

export interface GlyphAtlas {
	chars: string, width: number, height: number, cellW: number, data: Uint8Array<ArrayBuffer>,
	pitch: number, spread: number, cellX0: number, cellY0: number, cellWEm: number, cellHEm: number, capHeight: number,
}

const $			= <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const post		= (message: MessageOut) => vscode.postMessage(message);

const canvas	= $<HTMLCanvasElement>('viewport');
const tooltip	= $<HTMLElement>('scad-tooltip');
const infoBox	= $<HTMLElement>('scad-info');
const errorBox	= $<HTMLElement>('scad-error');

const canvas3d	= new Canvas3D(canvas, {depth: false, onError: message => post({command: 'error', message})});
canvas3d.gl.getExtension('EXT_color_buffer_float');

const pickTarget = canvas3d.createOffscreen(1, 1, 'rgba32f');// a single pixel, read back after each of the picker's passes

let program:	ShaderProgram | undefined;
let pickProgram: ShaderProgram | undefined;			// answers what is under a point instead of drawing the picture

let scriptCamera: ScriptCamera = {};
let source:		{vert: string, frag: string, lib: string, pick: string} | undefined;
let modules:	string[] = [];		// the file's own modules, when it draws nothing itself: a menu item runs one
let running:	string | undefined;
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
// how long one draw call of a band of rows is allowed to take, and how many rows the first one has (see draw)
const BAND_MS		= 30;
const FIRST_BAND	= 8;
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
	canvas3d.bindTexture2D(glyphTexture, 0);
	return {
		u_glyphs:		0,
		u_glyphCell:	[glyphs.cellX0, glyphs.cellY0, glyphs.cellWEm, glyphs.cellHEm],
		u_glyphInfo:	[glyphs.pitch, glyphs.spread, glyphs.chars.length, glyphs.capHeight],
	};
}

function batchUniforms() {
	if (!batchTexture)
		return {};
	canvas3d.bindTexture2D(batchTexture, BATCH_UNIT);
	return {u_batch: BATCH_UNIT};
}

function draw() {
	gizmo.show(true);
	sizeCanvas();
	canvas3d.initViewport();
	const gl = canvas3d.gl;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.clearColor(0.08, 0.09, 0.11, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);
	if (!program)
		return;
	const uniforms = {
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
	};

	// A model can cost seconds a frame (a big union of polygons whose boxes all overlap prunes nothing), and one draw
	// call that long is what the system's GPU watchdog kills the whole GPU process for. So the picture is drawn in
	// bands of rows, each followed by a one-pixel read-back, which waits for it: the first band is small, and a band
	// is only made larger as long as the ones so far were quick, so the cost of any one call stays near BAND_MS.
	const width = canvas.width, rows = canvas.height;
	const pixel = new Uint8Array(4);
	let band = FIRST_BAND, worst = 0;
	gl.enable(gl.SCISSOR_TEST);
	for (let y = 0; y < rows;) {
		const h = Math.min(band, rows - y);
		gl.scissor(0, y, width, h);
		const t0 = performance.now();
		program.draw(uniforms);
		gl.readPixels(0, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
		worst = Math.max(worst, (performance.now() - t0) / h);
		y += h;
		band = Math.max(1, Math.min(band * 2, Math.floor(BAND_MS / Math.max(worst, 1e-3))));
	}
	gl.disable(gl.SCISSOR_TEST);
}

// where the camera is: the point the shader's own u_origin uniform carries, which the picker needs in JS too
const cameraOrigin	= () => orbit.eye;
const size			= () => half.len();

const rad 			= (deg: number) => deg * Math.PI / 180;

function homeView() {
	const cam		= scriptCamera;
	const target	= cam.vpt ? float3(cam.vpt.x, cam.vpt.y, cam.vpt.z) : center;
	orbit.look(target,
		cam.vpd ?? size() / Math.sin(Math.atan(1 / orbit.fovy)) * 1.1,
		cam.vpr ? float3.rotateZ(rad(cam.vpr.z)).matmul(float3.rotateY(rad(cam.vpr.y))).matmul(float3.rotateX(rad(cam.vpr.x))) : float3x3.identity()
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
	redraw:	() => {
		moving();
		render();
	},
	dragStart:	() => hideTooltip(),
	zoomed:		(x, y) => schedulePick(x, y),
	contextMenu:(x, y) => { hideTooltip(); menu.open(x, y); }
});
Input.on(canvas).add(orbit);
const gizmo = new Gizmo(canvas, orbit.gizmoHooks());

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
		const pixel = pickTarget!.readPixels();
		pickTarget!.end();
		return pixel;
	};

	const pixel = read(0);
	const pos = float3(pixel[0], pixel[1], pixel[2]);
	const kind = pixel[3];
	const normal = full && kind > -0.5 ? float3.load(read(1)) : float3(0, 0, 0), mat = pickPixel[3];
	const colour = full && kind > 0.5 ? float3.load(read(2)) : undefined;
	const opacity = pickPixel[3];
	gl.enable(gl.BLEND);
	return {pos, kind, normal, mat, colour, opacity};
}

function pick(clientX: number, clientY: number) {
	const rect = canvas.getBoundingClientRect();
	const hit = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom ? pickAt(clientX, clientY, true) : undefined;
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

//--- the menu ----------------------------------------------------------------

const icons = {
	floor:	'<path d="M2 11l3-5h6l3 5zM6 6l-1 5M10 6l1 5M3.5 8.500h9"/>',
	steps:	'<path d="M2 13h3V9h3V5h3V2h3"/>',
	fit:	'<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
	run:	'<path d="M4 2.500v11l9-5.500z"/>',
	timer:	'<circle cx="8" cy="9" r="5"/><path d="M8 9V6M6.500 2h3"/>',
};

const menu = new Cascade($('main'), (): CascadeItem[] => [
	toggleItem('Floor', svgFace(icons.floor), () => !!floorOn, v => { floorOn = v ? 1 : 0; render(); }),
	toggleItem('Marching steps per pixel', svgFace(icons.steps), () => !!debug, v => { debug = v ? 1 : 0; showInfo(); render(); }),
	{
		face:		() => svgFace(icons.fit),
		caption:	() => 'Fit to window',
		select:		() => { homeView(); render(); },
	},
	...(modules.length ? [{
		face:		() => svgFace(icons.run),
		caption:	() => running ? `Running ${running}()` : 'Run a module',
		children:	() => modules.map(name => ({
			face:		() => `<span class="cascade-value">${name}</span>`,
			caption:	() => `${name}()`,
			active:		() => name === running,
			// choosing the one running again goes back to the file as it was
			select:		() => { post({command: 'run', name: name === running ? undefined : name}); },
		})),
	}] : []),
	{
		face:		() => svgFace(icons.timer),
		caption:	() => 'Time a frame',
		select:		() => { benchmark(); },
	},
]);

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
	menu.refresh();
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

async function setModel(code: string, data: Float32Array) {
	if (!source)
		source = await RPC<{vert: string, frag: string, lib: string, pick: string}>({command: 'getShaders'});

	program		= canvas3d.createProgram({vert: source.vert, frag: source.frag.replace('//@lib', source.lib).replace('//@sdf', code)}, rectGeometry);
	pickProgram	= canvas3d.createProgram({vert: source.vert, frag: source.pick.replace('//@lib', source.lib).replace('//@sdf', code)}, rectGeometry);

	if (data.length === 0) {
		if (batchTexture)
			canvas3d.deleteTexture(batchTexture);
		batchTexture = null;
		return;
	}
	const rows		= Math.ceil(data.length / 4 / 1024);
	const padded	= new Float32Array(rows * 1024 * 4);
	padded.set(data);

	// (the last model's is no use to this one, whatever its size: the data is what the shader walks)
	if (batchTexture)
		canvas3d.deleteTexture(batchTexture);
	batchTexture = canvas3d.createTexture(1024, rows, padded, {format: 'rgba32f', min: 'nearest', mag: 'nearest'});
}

//--- messages ----------------------------------------------------------------

window.addEventListener('message', async event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'sdf':
			try {
				const newCenter	= float3(message.center.x, message.center.y, message.center.z);
				const newHalf	= float3(message.half.x, message.half.y, message.half.z);

				const untouched = program && newCenter.eq(center) && newHalf.eq(half);
				await setModel(message.code, message.data);
				center			= newCenter;
				half			= newHalf;
				scriptCamera	= message.camera;
				orbit.fovy		= message.camera.vpf !== undefined ? 1 / Math.tan(message.camera.vpf * Math.PI / 360) : DEFAULT_FOVY;

				infoText 		= `${message.info}${message.warnings.length ? ` — ${message.warnings.join('; ')}` : ''}`;
				perfNote		= '';
				showInfo();
				draw();
				errorBox.classList.add('hidden');
				if (!untouched)
					homeView();
				render();

			} catch(error: any) {
				program = undefined;
				errorBox.textContent = String(error?.message ?? error);
				errorBox.classList.remove('hidden');
			}
			break;

		case 'error':
			errorBox.textContent = message.message;
			errorBox.classList.remove('hidden');
			break;
		case 'modules':
			modules	= message.names;
			running	= message.running;
			menu.refresh();
			break;
		case 'fitToWindow':
			homeView();
			render();
			break;
	}
});

// (the page is ready with the numbers or without them)
RPC<GlyphAtlas | undefined>({command: 'getGlyphs'}).then(atlas => {
	if (atlas) {
		glyphs			= atlas;
		glyphTexture	??= canvas3d.createTexture(atlas.width, atlas.height, atlas.data, {format: 'r8', min: 'linear', mag: 'linear'});
	}
}).catch(() => {})		// no numbers on the floor is not worth an error
	.finally(() => post({command: 'ready'}));
