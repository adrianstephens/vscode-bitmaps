import { Tooltip, Splitter, vscode, RPC, handleResult } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Tree } from '@isopodlabs/vscode_utils/webview/tree.js';
import { Canvas3D, ShaderProgram, rectGeometry } from './opengl.ts';
import { float3, float3x3, orthonormalise } from '@isopodlabs/maths/vector';

// The tensor viewer of a GGUF file: the tensor list, and the values of the tensor in one float volume texture (a matrix is a stack of
// one slice) which is coloured by the shaders. A stack of slices (a tensor with more than two dimensions) is shown as a grid of the slices
// or one slice (pan, zoom, values on hover), or as a volume (orbit, zoom), each by its own shader.
//
// The extension does not reduce a matrix, nor a stack of slices: it streams them in bands of whole rows and tensorscale.frag reduces each
// band with offscreen passes, so the full thing is never held in RAM or VRAM. The passes draw straight into the texture the display
// shaders sample, so the reduced picture stays on the GPU; only its values are read back, for the colour scale and the tooltips. A
// quantised tensor's bands cross as raw blocks instead of floats, and dequant.frag expands them on the GPU first. See reduceTensor.

type V3 = [number, number, number];

export type TensorShader = 'bg' | 'tensor3d' | 'tensorgrid' | 'tensorslice' | 'tensorscale' | 'dequant';

// A quantisation a band's raw bytes are in, which the viewer expands on the GPU: elements per block and bytes per block.
export interface Quant {
	dtype:	number;
	name:	string;
	block:	number;
	size:	number;
}

export type TensorOut =
	| {command: 'ready', gpuReduce: boolean, maxTile: number, maxTexture: number}
	| {command: 'error', message: string}
	| {command: 'getShaders', type: TensorShader, requestId: number}//result: {vert: string, frag: string}
	| {command: 'getBand', token: number, slice: number, y0: number, y1: number, requestId: number}//result: {data: Float32Array | Uint8Array, firstBlock?: number, error?: string}
	| {command: 'selectTensor', index: number};

export type TensorIn =
	| {command: 'tensorSelected', index: number}
	| {command: 'volume', values: Float32Array, dims: V3, extent: V3, scale: number, info: string}	// a matrix or stack of slices; dims: voxels per axis, extent: elements they were reduced from, scale: the magnitude with the full colour
	| {command: 'tensorReduce', token: number, dims: V3, extent: V3, info: string, bandRows: number, quant?: Quant}	// a matrix or stack whose reduction the viewer does; bandRows is the most source rows of a slice one band holds; quant is the band's format when the viewer expands it on the GPU, else the bands are f32
	| {command: 'stepSlice', delta: number}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'}
	| {command: 'scaleTensor'};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas		= $<HTMLCanvasElement>('viewport');
const infoBox		= $<HTMLElement>('tensor-info');
const labels		= $<HTMLCanvasElement>('labels');
const labelContext 	= labels.getContext('2d')!;
const labelFont		= getComputedStyle(document.body).fontFamily;
const tooltip		= new Tooltip();
const post			= (message: TensorOut) => vscode.postMessage(message);

const canvas3d		= new Canvas3D(canvas, {depth: false, onError: message => post({command: 'error', message})});	// everything is a full canvas rectangle, drawn back to front

// Whether the viewer can reduce a matrix itself, and the largest texture it can stage a band in. R32F colour attachments need
// EXT_color_buffer_float; without it the extension reduces the matrix and sends the values (or the stack's volume) as before.
const gpuReduce		= !!canvas3d.gl.getExtension('EXT_color_buffer_float');
const maxTile		= Math.min(2048, canvas3d.gl.getParameter(canvas3d.gl.MAX_3D_TEXTURE_SIZE) as number);
const maxTexture	= canvas3d.gl.getParameter(canvas3d.gl.MAX_TEXTURE_SIZE) as number;

//-----------------------------------------------------------------------------
// GL
//-----------------------------------------------------------------------------

const programs: Partial<Record<TensorShader, ShaderProgram>> = {};

async function load(type: TensorShader) {
	const {vert, frag} = await RPC<{vert: string, frag: string}>({command: 'getShaders', type});
	programs[type] = canvas3d.createProgram({vert, frag}, rectGeometry);
}

//-----------------------------------------------------------------------------
// state
//-----------------------------------------------------------------------------

const fovy = 1 / Math.tan(Math.PI / 6);

let mode: 'none' | 'stack' = 'none';

let scale		= 1;
let offset		= {x: 0, y: 0};

// the values: a matrix is a stack of one slice
let volume:		{dims: V3, extent: V3, half: V3, values: Float32Array, scale: number, info: string} | undefined;
let stackView:	TensorView = 'grid';	// how a stack is shown; see shownView
let layer		= 0;	// the slice shown, when stackView is 'slice'
let volumeTex:	WebGLTexture | null = null;
let basis		= float3x3.identity();	// camera right, up and back axes in the volume's space
let distance	= 3;

let frame = 0;
function render() {
	frame ||= requestAnimationFrame(() => {
		frame = 0;
		draw();
	});
}

function draw() {
	canvas3d.initViewport();
	const viewport = [canvas.width, canvas.height];
	const gl = canvas3d.gl;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);	// a reduction in progress has its own framebuffer bound

	if (mode === 'stack' && volume) {
		canvas3d.bindTexture(gl.TEXTURE_3D, volumeTex);
		const common = {u_volume: 0, u_dims: volume.dims, u_range: volume.scale};
		const flatUniforms = {...common, u_viewport: viewport, u_scale: scale, u_offset: [offset.x, offset.y]};

		const view = shownView();
		if (view === 'slice') {
			programs.tensorslice!.draw({...flatUniforms, u_layer: layerIndex()});

		} else if (view === 'grid') {
			const g = gridLayout();
			programs.tensorgrid!.draw({...flatUniforms, u_size: [g.width, g.height], u_gap: g.gap, u_vertical: g.vertical ? 1 : 0});

		} else {
			programs.bg!.draw({u_viewport: viewport});
			programs.tensor3d!.draw({
				...common,
				u_half:		volume.half,
				u_origin:	basis.z.scale(distance)._values,
				u_basis:	basis.flat(),
				u_fovy:		fovy,
				u_aspect:	canvas.width / canvas.height,
			});
		}
	}
	drawLabels();
}

function resizeCanvas() {
	canvas3d.resize();
	labels.width	= canvas.width;
	labels.height	= canvas.height;
	if (flat()) {
		scale	= clampScale(scale);
		offset	= clampOffset(offset.x, offset.y);
	}
	// Resizing clears the canvas, so draw now, before the browser next paints: waiting for an animation frame shows the empty canvas in between
	draw();
}
new ResizeObserver(resizeCanvas).observe(canvas);

// The slice numbers of a grid go above the slices when they are side by side, and to the left of them when they are stacked:
// the view leaves room there (the margin). When the view is panned so that room is off the canvas, a label stays at the canvas edge.
function labelStyle() {
	const ratio = window.devicePixelRatio || 1, size = 11 * ratio, pad = 3 * ratio;
	labelContext.font			= `${size}px ${labelFont}`;
	labelContext.textBaseline	= 'top';
	return {size, pad, height: size + 2 * pad};
}

// the room the view leaves for the slice numbers, in canvas pixels
function labelMargin() {
	if (mode !== 'stack' || !volume || shownView() !== 'grid')
		return {x: 0, y: 0};
	const {pad, height} = labelStyle();
	if (!gridLayout().vertical)
		return {x: 0, y: height + pad};
	const nines = '9'.repeat(String(volume.extent[2] - 1).length);	// as wide as a range of slice numbers gets
	return {x: labelContext.measureText(`${nines}..${nines}`).width + 3 * pad, y: 0};
}

// When the slices are too small on the screen for a number each, a label covers a group of them ('8..15');
// groups start at multiples of their size, so they stay put as the view moves.
function drawLabels() {
	const c = labelContext;
	c.clearRect(0, 0, labels.width, labels.height);
	if (mode !== 'stack' || !volume || shownView() !== 'grid')
		return;

	const {size, pad, height} = labelStyle();
	const g = gridLayout(), [, , nz] = volume.dims, total = volume.extent[2];
	const range = (first: number, last: number) => {	// of the slices the layers first..last stand for
		const a = Math.floor(first * total / nz), b = Math.max(a, Math.floor((last + 1) * total / nz) - 1);
		return a === b ? String(a) : `${a}..${b}`;
	};

	const pitch = g.pitch * scale;
	let group = 1;
	while (group < nz && group * pitch < (g.vertical ? size : c.measureText(range(Math.max(0, nz - group), nz - 1)).width) + 3 * pad)
		++group;

	const start = g.vertical ? offset.y : offset.x, extent = g.vertical ? labels.height : labels.width;
	const first = Math.max(0, Math.floor(-start / (pitch * group))), last = Math.ceil((extent - start) / (pitch * group));
	for (let k = first; k <= last; k++) {
		const z = k * group;
		if (z >= nz)
			break;
		const text	= range(z, Math.min(nz - 1, z + group - 1)), width = c.measureText(text).width + 2 * pad;
		const from	= (g.vertical ? offset.y : offset.x) + z * pitch;								// the slices' edge along the line
		const to	= (g.vertical ? offset.y : offset.x) + (Math.min(nz, z + group) * g.pitch - g.gap) * scale;
		const along	= (length: number) => Math.min(Math.max(from, 0), Math.max(from, to - length));	// kept on the canvas, within the slices

		const x = g.vertical ? Math.max(0, offset.x - width - pad) : along(width);
		const y = g.vertical ? along(height) : Math.max(0, offset.y - height - pad);
		if (x + width < 0 || x > labels.width || y + height < 0 || y > labels.height)
			continue;
		c.fillStyle = 'rgba(0, 0, 0, 0.65)';
		c.fillRect(x, y, width, height);
		c.fillStyle = '#fff';
		c.fillText(text, x + pad, y + pad);
	}
}

// canvas pixels of a pointer position
const canvasPoint = (event: {clientX: number, clientY: number}) => canvas3d.toCanvas(event.clientX, event.clientY);

//-----------------------------------------------------------------------------
// matrix
//-----------------------------------------------------------------------------

// a matrix is one slice, whatever the choice of view
const shownView = () => volume && volume.extent[2] === 1 ? 'slice' : stackView;

// The image which is panned and zoomed: the grid of slices or a slice (not the volume)
function flat(): {width: number, height: number} | undefined {
	if (mode === 'stack' && volume) {
		const view = shownView();
		if (view !== 'volume')
			return view === 'slice' ? {width: volume.dims[0], height: volume.dims[1]} : gridLayout();
	}
}

// The slices in a line, wide ones stacked and tall ones side by side, with a gap of a few texels between them
function gridLayout() {
	const [nx, ny, nz] = volume!.dims;
	const vertical	= nx >= ny;
	const length	= vertical ? ny : nx;
	const gap		= Math.min(Math.max(2, Math.round(Math.max(Math.max(nx, ny) / 128, nz * length / 250))), Math.max(2, length / 8));	// enough to see when the whole line is fitted to the window
	const pitch		= length + gap, along = nz * pitch - gap;
	return {width: vertical ? nx : along, height: vertical ? along : ny, gap, pitch, vertical};
}

// the layer of the volume which a slice of the stack is in (layers are more than a slice when it was reduced)
const layerIndex = () => volume ? Math.min(volume.dims[2] - 1, Math.floor(layer * volume.dims[2] / volume.extent[2])) : 0;

const fitScale = () => {
	const f = flat(), m = labelMargin();
	return f ? Math.min((canvas.width - m.x) / f.width, (canvas.height - m.y) / f.height) : 1;
};
const clampScale = (s: number) => Math.min(256, Math.max(fitScale(), s));

function clampOffset(x: number, y: number) {
	const f = flat(), m = labelMargin();
	if (!f)
		return {x, y};
	const w = f.width * scale, h = f.height * scale;
	return {
		x: Math.min(Math.max(m.x, canvas.width - w), Math.max(Math.min(m.x, canvas.width - w), x)),
		y: Math.min(Math.max(m.y, canvas.height - h), Math.max(Math.min(m.y, canvas.height - h), y)),
	};
}

function centreFlat() {
	const f = flat(), m = labelMargin();
	if (f)
		offset = {x: m.x + (canvas.width - m.x - f.width * scale) / 2, y: m.y + (canvas.height - m.y - f.height * scale) / 2};
}

function fitFlat() {
	scale = Math.min(32, fitScale());
	centreFlat();
}

//-----------------------------------------------------------------------------
// volume
//-----------------------------------------------------------------------------

function homeView() {
	basis = float3x3.identity();
	if (volume)
		distance = 1.05 * fovy * Math.hypot(...volume.half);
}

// Shows a matrix or stack of slices whose values the extension reduced
function setVolume(message: Extract<TensorIn, {command: 'volume'}>) {
	applyVolume(message.values, message.dims, message.extent, message.scale, message.info);
}

function applyVolume(values: Float32Array, dims: V3, extent: V3, scale: number, info: string) {
	applyVolumeTexture(canvas3d.create3DTexture(dims, values, {format: 'r32f', min: 'nearest'}), values, dims, extent, scale, info);
}

// Shows a volume as the given texture, which it takes over; the values are only for the tooltips and the colour scale and
// need not have come from the texture (reduceTensor keeps the reduced picture on the GPU and reads the values back beside it).
function applyVolumeTexture(texture: WebGLTexture, values: Float32Array, dims: V3, extent: V3, scale: number, info: string) {
	if (volumeTex)
		canvas3d.deleteTexture(volumeTex);
	volumeTex = texture;

	// the box is as long along its axes as the elements the voxels stand for, its longest side 2
	const longest = Math.max(...extent);
	volume	= {dims, extent, half: extent.map(e => e / longest) as V3, values, scale, info};
	mode	= 'stack';
	({view: stackView, slice: layer} = sidebar.state());
	homeView();
	if (flat())
		fitFlat();
	showInfo();
	render();
}

function showInfo() {
	if (!volume)
		return;
	const slices = volume.extent[2], view = shownView();
	infoBox.textContent = slices === 1 ? volume.info : `${volume.info}; ${view === 'grid' ? `all ${slices} slices` : view === 'slice' ? `slice ${layer} of ${slices}` : 'opacity shows magnitude'}`;
}

// the sidebar chose how to show the stack
function setStackView(view: TensorView, slice: number) {
	const changed = view !== stackView;
	stackView	= view;
	layer		= slice;
	if (mode === 'stack') {
		if (changed && flat())
			fitFlat();
		showInfo();
		render();
	}
}

//-----------------------------------------------------------------------------
// reducing a matrix on the GPU
//-----------------------------------------------------------------------------

// The extension streams a matrix, or a stack of slices, in bands of whole rows (bounded so neither side holds much of it) and
// tensorscale.frag reduces each band into the volume texture in an offscreen pass. Each pass covers exactly the source texels of the
// output texels it draws, so the passes never overlap in output and need no accumulation: one band per pass, holding as many output
// rows as the staging texture can, split into groups of columns when a whole row of the source would not fit a texture. A stack is
// reduced a slice at a time, into one layer of the volume per pass. This mirrors sampleMatrix and sampleVolume in GgufViewer.tsx,
// which reduce the same way but on the CPU.
//
// tensorscale.frag takes the texels between the fragment's corners and closes the far side with ceil, so a bin reaches into the next
// bin's first texel when the division is not exact. The band and the column group hold exactly the bins they cover and the shader
// clamps its footprint to them, so each output value is written by exactly one pass and no texel a bin covers is dropped.

let reducing = 0;	// the tensor being reduced; a new selection stops the loop (the extension stops being asked for bands)

// magnitude below which `percentile` of the finite values lie (GgufViewer.tsx's robustScale, for the values it reduces itself)
function robustScale(values: ArrayLike<number>, count = values.length, percentile = 0.999) {
	let max = 0;
	for (let i = 0; i < count; i++) {
		const a = Math.abs(values[i]);
		if (a > max && a < Infinity)
			max = a;
	}
	if (max === 0)
		return 1;

	const bins	= 4096;
	const hist	= new Uint32Array(bins);
	let total	= 0;
	for (let i = 0; i < count; i++) {
		const a = Math.abs(values[i]);
		if (a < Infinity) {
			++hist[Math.min(bins - 1, Math.floor(a / max * bins))];
			++total;
		}
	}
	let sum = 0;
	for (let b = 0; b < bins; b++) {
		sum += hist[b];
		if (sum >= total * percentile)
			return (b + 1) / bins * max;
	}
	return max;
}

async function reduceTensor(message: Extract<TensorIn, {command: 'tensorReduce'}>) {
	const {token, dims, extent, info, quant, bandRows} = message;
	const [outW, outH, outZ]	= dims;
	const [W, H, D]				= extent;

	reducing = token;
	if (!gpuReduce)
		throw new Error('This GPU cannot draw to a float texture, so the reduction cannot be done here');

	infoBox.textContent = `${info}; reducing ${W} x ${H}${D > 1 ? ` x ${D}` : ''}`;

	const gl		= canvas3d.gl;
	// The passes draw straight into the texture the display shaders sample, so the reduced picture never leaves the GPU: a
	// matrix is its one slice and a stack of slices is all of them, each slice drawn while the framebuffer has it attached
	// (begin(z)). The values read back afterwards are only for the colour scale and the tooltips.
	const offscreen	= canvas3d.createOffscreen3D(dims, 'r32f');
	const staging	= canvas3d.createOffscreen3D([maxTile, maxTile, 1], 'r32f');
	const values	= new Float32Array(outW * outH * outZ);
	const blending	= gl.isEnabled(gl.BLEND);
	// The source crosses a band of whole rows at a time, bounded so neither side holds much of it and so it fits the staging
	// texture beside the columns.
	const rowsAtOnce = Math.max(1, Math.min(maxTile, bandRows ?? 1));
	let keep		= false;	// the texture becomes the display texture when the reduction finishes
	gl.disable(gl.BLEND);	// the passes overwrite the output; blending is for the display shaders

	// A quantised tensor's bands are raw blocks, which dequant.frag expands into the staging texture. The widest band sets
	// the raw texture's size, so it is made once and refilled for each band; the last row is padded because a texture's
	// bytes are a rectangle of texels and the shader never reads past the band anyway.
	let raw: WebGLTexture | undefined, rawWidth = 0, rawHeight = 0, padded: Uint8Array | undefined;
	if (quant) {
		// a band's blocks can start before the band does, so its bytes are at most one block more than its elements need
		const maxBytes = Math.ceil(Math.min(H, rowsAtOnce) * W / quant.block) * quant.size + quant.size;
		rawWidth	= Math.max(1, Math.min(maxTexture, maxBytes));
		rawHeight	= Math.ceil(maxBytes / rawWidth);
		raw			= canvas3d.createTexture(rawWidth, rawHeight, null, {format: 'r8ui', min: 'nearest', mag: 'nearest'});
		padded		= new Uint8Array(rawWidth * rawHeight);
	}

	try {
		for (let z = 0; z < outZ; z++) {
			// A layer of the volume comes from one slice of the stack (the extension only sends a stack the GPU can reduce a
			// layer at a time; see volumePlan), and the pass for a slice draws it while the framebuffer has it attached.
			const slice = z;
			offscreen.begin(z);

			for (let oy0 = 0; oy0 < outH; ) {
				// as many output rows as one band of source rows holds
				let oy1 = oy0 + 1;
				while (oy1 < outH && Math.ceil((oy1 + 1) * H / outH) - Math.floor(oy0 * H / outH) <= rowsAtOnce)
					++oy1;
				const ry0 = Math.floor(oy0 * H / outH), ry1 = Math.min(H, Math.ceil(oy1 * H / outH)), rows = ry1 - ry0;

				const band = await RPC<{data: Float32Array | Uint8Array, firstBlock?: number, error?: string}>({command: 'getBand', token, slice, y0: ry0, y1: ry1});
				if (token !== reducing)
					return;
				if (band.error)
					throw new Error(band.error);

				if (quant) {
					const bytes = band.data as Uint8Array;
					const bandHeight = Math.ceil(bytes.length / rawWidth);
					padded!.set(bytes);
					gl.bindTexture(gl.TEXTURE_2D, raw!);
					gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rawWidth, bandHeight, gl.RED_INTEGER, gl.UNSIGNED_BYTE, padded!.subarray(0, rawWidth * bandHeight));
				} else if ((band.data as Float32Array).length !== rows * W) {
					throw new Error(`The extension sent ${(band.data as Float32Array).length} of ${rows * W} values for a band of the tensor`);
				}
				const firstBlock = band.firstBlock ?? 0;

				for (let ox0 = 0; ox0 < outW; ) {
					const cx0 = Math.floor(ox0 * W / outW);
					let ox1 = Math.min(outW, Math.max(ox0 + 1, Math.floor((cx0 + maxTile) * outW / W)));	// columns whose source fits the staging texture
					while (ox1 > ox0 + 1 && Math.min(W, Math.ceil(ox1 * W / outW)) - cx0 > maxTile)
						--ox1;
					const cw = Math.min(W, Math.ceil(ox1 * W / outW)) - cx0;

					if (quant) {
						// The tile's elements, expanded from the band's raw blocks into the staging texture. The origin is counted from
						// the tensor's start rather than the slice's, because dequant.frag works out the element's index from it and
						// subtracts firstBlock * block, and firstBlock (from readRaw) is the band's block in the whole tensor.
						gl.bindFramebuffer(gl.FRAMEBUFFER, staging.framebuffer);
						gl.viewport(0, 0, cw, rows);
						gl.activeTexture(gl.TEXTURE0);
						gl.bindTexture(gl.TEXTURE_2D, raw!);
						programs.dequant!.draw({
							u_raw:		0,
							u_rawWidth:	rawWidth,
							u_block:	quant.block,
							u_blockSize:	quant.size,
							u_firstBlock:	firstBlock,
							u_format:	quant.dtype,
							u_rowStride:	W,
							u_origin:	[cx0, slice * H + ry0],
						});
					} else {
						gl.bindTexture(gl.TEXTURE_3D, staging.texture);
						gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W);			// take the group's columns from the band, without copying them
						gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, cx0);
						gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, cw, rows, 1, gl.RED, gl.FLOAT, band.data as Float32Array);
						gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
						gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
					}

					// The band's output rows, drawn in one pass. tensorscale.frag takes the fragment's position as the output texel
					// it is, so each of them is written from the footprint its own position gives it - the same value a pass per
					// row would give, since the band holds exactly the rows their footprints close over.
					gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen.framebuffer);	// draw() may have claimed it for the canvas
					gl.viewport(ox0, oy0, ox1 - ox0, oy1 - oy0);
					canvas3d.bindTexture(gl.TEXTURE_3D, staging.texture, 0);
					programs.tensorscale!.draw({
						u_volume:	0,
						u_dims:		[cw, rows, 1],
						u_scale:	[outW / W, outH / H],
						u_offset:	[cx0 * outW / W, ry0 * outH / H],
						u_layer:	0,
					});
					ox0 = ox1;
				}
				oy0 = oy1;
			}
			offscreen.readPixels(values.subarray(z * outW * outH, (z + 1) * outW * outH), z);
		}
		keep = true;
	} finally {
		// A reduction the viewer has moved on from must not unbind the framebuffer or re-enable blending under its replacement
		if (token === reducing) {
			offscreen.end();
			if (blending)
				gl.enable(gl.BLEND);
		}
		offscreen.delete(keep && token === reducing);
		staging.delete();
		if (raw)
			canvas3d.deleteTexture(raw);
	}

	if (token !== reducing)
		return;

	const scale = robustScale(values);
	applyVolumeTexture(offscreen.texture, values, dims, extent, scale, `${info}; full colour at +-${scale.toPrecision(3)}`);
}

// The voxel a pointer is over: where the ray has become mostly opaque, else the strongest one along it.
// This walks the grid as tensor.frag does.
function pickVoxel(event: {clientX: number, clientY: number}) {
	if (!volume)
		return;
	const {dims, values, scale: colourScale} = volume;
	const rd = basis.mul(canvas3d.rayDirection(event.clientX, event.clientY, fovy))._values;
	const ro = basis.z.scale(distance)._values;

	const half = volume.half, size = half.map((h, i) => 2 * h / dims[i]), unit = Math.cbrt(size[0] * size[1] * size[2]);	// of a voxel, and its mean side
	const sign = [1, -1, -1];
	let tEnter = 0, tLeave = Infinity;
	for (let i = 0; i < 3; i++) {
		const a = (-half[i] - ro[i]) / (rd[i] || 1e-20), b = (half[i] - ro[i]) / (rd[i] || 1e-20);
		tEnter = Math.max(tEnter, Math.min(a, b));
		tLeave = Math.min(tLeave, Math.max(a, b));
	}
	if (tEnter >= tLeave)
		return;

	const o = [0, 1, 2].map(i => (ro[i] + rd[i] * tEnter) * sign[i] / size[i] + dims[i] / 2), d = [0, 1, 2].map(i => rd[i] * sign[i] / size[i]);
	const vox = o.map((x, i) => Math.max(0, Math.min(dims[i] - 1, Math.floor(x))));
	const next = [0, 1, 2].map(i => tEnter + (vox[i] + (d[i] >= 0 ? 1 : 0) - o[i]) / (d[i] || 1e-20));
	const delta = d.map(x => 1 / Math.max(Math.abs(x), 1e-20));

	let t = tEnter, opacity = 0, best: {at: V3, v: number} | undefined;
	for (;;) {
		const tExit = Math.min(next[0], next[1], next[2], tLeave);
		const v = values[(vox[2] * dims[1] + vox[1]) * dims[0] + vox[0]], m = Math.min(1, Math.abs(v) / colourScale);
		if (m > 0.004) {
			if (!best || Math.abs(v) > Math.abs(best.v))
				best = {at: [vox[0], vox[1], vox[2]], v};
			opacity += (1 - opacity) * (1 - (1 - m ** 1.5) ** Math.max((tExit - t) / unit, 1e-4));
			if (opacity >= 0.35)
				return {at: [vox[0], vox[1], vox[2]] as V3, v};
		}
		t = tExit;
		if (t >= tLeave)
			return best;
		const axis = next[0] < next[1] && next[0] < next[2] ? 0 : next[1] < next[2] ? 1 : 2;
		vox[axis] += d[axis] >= 0 ? 1 : -1;
		next[axis] += delta[axis];
		if (vox[axis] < 0 || vox[axis] >= dims[axis])
			return best;
	}
}

//-----------------------------------------------------------------------------
// interaction
//-----------------------------------------------------------------------------

const elements = (i: number, n: number, size: number) => {
	const a = Math.floor(i * size / n), b = Math.max(a + 1, Math.floor((i + 1) * size / n));
	return b - a > 1 ? `${a}..${b - 1}` : String(a);
};

canvas.addEventListener('pointermove', event => {
	const f = flat();
	if (f) {
		const p = canvasPoint(event), x = Math.floor((p.x - offset.x) / scale), y = Math.floor((p.y - offset.y) / scale);
		if (x >= 0 && y >= 0 && x < f.width && y < f.height) {
			if (volume) {
				// where in which slice (nothing over the gaps between slices of a grid)
				const [nx, ny, nz] = volume.dims;
				let vx = x, vy = y, vz = layerIndex();
				if (shownView() === 'grid') {
					const g = gridLayout(), along = g.vertical ? y : x;
					vz = Math.floor(along / g.pitch);
					const inside = along - vz * g.pitch;
					vx = g.vertical ? x : inside;
					vy = g.vertical ? inside : y;
					if (inside >= (g.vertical ? ny : nx) || vz >= nz)
						vz = -1;
				}
				if (vz >= 0) {
					const {extent} = volume;
					const at = [elements(vx, nx, extent[0]), elements(vy, ny, extent[1]), ...(nz > 1 || extent[2] > 1 ? [elements(vz, nz, extent[2])] : [])];
					tooltip.show(`[${at.join(', ')}] = ${volume.values[(vz * ny + vy) * nx + vx]}`, event.clientX + 12, event.clientY + 12);
					return;
				}
			}
		}
	} else if (mode === 'stack' && volume && !event.buttons) {
		const hit = pickVoxel(event);
		if (hit) {
			const {dims, extent} = volume;
			tooltip.show(`[${[0, 1, 2].map(i => elements(hit.at[i], dims[i], extent[i])).join(', ')}] = ${hit.v}`, event.clientX + 12, event.clientY + 12);
			return;
		}
	}
	tooltip.hide();
});
canvas.addEventListener('pointerleave', () => tooltip.hide());

canvas.addEventListener('pointerdown', event => {
	if (mode === 'none')
		return;
	canvas.setPointerCapture(event.pointerId);
	let last = canvasPoint(event);

	const onMove = (e: PointerEvent) => {
		const p = canvasPoint(e), dx = p.x - last.x, dy = p.y - last.y;
		last = p;
		if (flat()) {
			offset = clampOffset(offset.x + dx, offset.y + dy);
		} else {
			const ratio = canvas.width / canvas.getBoundingClientRect().width;
			basis = float3.rotate(basis.y, -dx / ratio * 0.01).matmul(basis);
			basis = float3.rotate(basis.x, -dy / ratio * 0.01).matmul(basis);
			orthonormalise(basis);
		}
		render();
	};
	const onUp = () => {
		canvas.removeEventListener('pointermove', onMove);
		canvas.removeEventListener('pointerup', onUp);
		canvas.removeEventListener('pointercancel', onUp);
	};
	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
});

canvas.addEventListener('wheel', event => {
	event.preventDefault();
	const delta = 1.01 ** -event.deltaY;// < 0 ? 1.15 : 0.87;
	if (flat()) {
		const centre = canvasPoint(event), before = scale;
		scale	= clampScale(scale * delta);
		offset	= clampOffset(centre.x - (centre.x - offset.x) / before * scale, centre.y - (centre.y - offset.y) / before * scale);
	} else if (mode === 'stack') {
		distance = Math.min(30, Math.max(0.2, distance / delta));
	}
	render();
}, {passive: false});

//-----------------------------------------------------------------------------
// messages
//-----------------------------------------------------------------------------


type TensorView = 'grid' | 'slice' | 'volume';

// The metadata of a file, in the page as a tree: groups (the dotted keys of the file, e.g. 'tokenizer.ggml.model') open and close.
function MetadataTree(root: HTMLElement) {
	const tree = new Tree(root, () => {});
	root.tabIndex = 0;
	tree.enableKeyboardNavigation(() => {});

	root.addEventListener('click', event => {
		const row = (event.target as HTMLElement).closest<HTMLElement>('.select');
		if (row) {
			tree.setCursor(row);
			if (row.parentElement?.classList.contains('caret'))
				tree.toggle(row.parentElement);
		}
	});
}

// The left of the window: a section with the file's metadata as a tree, above a section with the tensors of the file as a filterable list; a tensor with more than two dimensions
// (a stack of matrices) also gets a choice of a grid of all its slices, one slice (with a slider), or a volume overview.
// `select` is told which tensor is chosen, `show` how a stack of slices is to be shown (which the sidebar keeps between tensors).
function TensorSidebar(select: (index: number) => void, show: (view: TensorView, slice: number) => void) {
	const list = $('tensor-list'), count = $('tensor-count');
	const filter	= $<HTMLInputElement>('tensor-filter'), controls = $('tensor-controls');
	const slider	= $<HTMLInputElement>('slice-slider'), number = $<HTMLInputElement>('slice-number'), total = $('slice-total');
	const radios	= Array.from(document.querySelectorAll<HTMLInputElement>('input[name=tensor-view]'));

	MetadataTree($('meta-tree'));

	// the titles of the two sections open and close them
	document.querySelectorAll('.pane-title').forEach(title => title.addEventListener('click', () => title.parentElement!.classList.toggle('collapsed')));

	// the tensors are in the page: each row has its index, and the number of slices when it has more than two dimensions
	const rows		= Array.from(list.querySelectorAll<HTMLElement>('.tensor'));
	const slices	= rows.map(row => Number(row.dataset.slices));
	const texts		= rows.map(row => Array.from(row.children, c => c.textContent).join(' ').toLowerCase());
	let current	= -1;
	let view:	TensorView		= 'grid';

	const shown = () => rows.filter(r => !r.classList.contains('hidden'));

	function showControls() {
		const count = slices[current] ?? 1;
		controls.classList.toggle('hidden', count <= 1);
		slider.max		= number.max = String(count - 1);
		total.textContent = `of ${count}`;
		slider.disabled	= number.disabled = view !== 'slice';
		radios.forEach(r => r.checked = r.value === view);
	}

	function highlight(index: number) {
		rows[current]?.classList.remove('current');	// not 'selected': shared.css forces a background on that
		current = index;
		rows[current]?.classList.add('current');
		rows[current]?.scrollIntoView({block: 'nearest'});
	}

	function choose(index: number) {
		if (index === current || !rows[index])
			return;
		highlight(index);
		slider.value = number.value = '0';
		showControls();
		select(index);
		show(view, 0);
	}

	function move(delta: number) {
		const visible	= shown();
		const at		= visible.indexOf(rows[current]);
		const next		= visible[Math.max(0, Math.min(visible.length - 1, at < 0 ? 0 : at + delta))];
		if (next)
			choose(Number(next.dataset.index));
	}

	function slice(value: number) {
		const clamped = Math.max(0, Math.min(Number(slider.max), Math.floor(value) || 0));
		slider.value = number.value = String(clamped);
		show(view, clamped);
	}

	list.addEventListener('click', event => {
		const row = (event.target as HTMLElement).closest<HTMLElement>('.tensor');
		if (row)
			choose(Number(row.dataset.index));
	});

	list.addEventListener('keydown', event => {
		const step = {ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -Infinity, End: Infinity}[event.key];
		if (step !== undefined) {
			event.preventDefault();
			move(step);
		}
	});

	filter.addEventListener('input', () => {
		const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
		rows.forEach((row, i) => row.classList.toggle('hidden', !words.every(w => texts[i].includes(w))));
		count.textContent = `${shown().length} / ${rows.length}`;
	});
	filter.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown' || event.key === 'Enter') {
			event.preventDefault();
			list.focus();
			if (shown().length && !shown().includes(rows[current]))
				choose(Number(shown()[0].dataset.index));
		}
	});

	radios.forEach(r => r.addEventListener('change', () => {
		view = r.value as TensorView;
		showControls();
		show(view, Number(slider.value));
	}));
	slider.addEventListener('input', () => slice(Number(slider.value)));
	number.addEventListener('change', () => slice(Number(number.value)));

	new Splitter($('splitter'), () => {});	// resizes the sidebar, its previous sibling, between its min-width and max-width

	return {
		// the extension has shown this tensor (perhaps in response to a click, perhaps not)
		selected(index: number) {
			highlight(index);
			slider.value = number.value = '0';
			showControls();
		},

		state() {
			return {view, slice: Number(slider.value)};
		},

		// step through the slices, as the buttons in the title bar do
		stepSlice(delta: number) {
			if (view === 'volume' || (slices[current] ?? 1) <= 1)
				return;
			const from = view === 'slice' ? Number(slider.value) : 0;
			view = 'slice';
			slice(from + delta);
			showControls();
		},
	};
}

const sidebar = TensorSidebar(index => post({command: 'selectTensor', index}), setStackView);

//-----------------------------------------------------------------------------
// messages
//-----------------------------------------------------------------------------

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;

	const message = event.data as TensorIn;
	switch (message.command) {
		case 'tensorSelected':
			reducing = 0;	// the tensor being reduced is no longer the one selected
			sidebar.selected(message.index);
			break;

		case 'volume':
			reducing = 0;
			tooltip.hide();
			setVolume(message);
			break;

		case 'tensorReduce':
			tooltip.hide();
			reduceTensor(message).catch(error => {
				if (message.token === reducing)
					post({command: 'error', message: String(error?.message ?? error)});
			});
			break;

		case 'stepSlice':
			sidebar.stepSlice(message.delta);
			break;

		case 'fitToWindow':
			if (flat())
				fitFlat();
			else
				homeView();
			render();
			break;

		case 'resetZoom':
			if (flat()) {
				scale = clampScale(1);
				centreFlat();
			} else {
				homeView();
			}
			render();
			break;

		case 'scaleTensor':
			break;
	}
});

Promise.all((['bg', 'tensor3d', 'tensorgrid', 'tensorslice', 'tensorscale', 'dequant'] as const).map(load))
	.then(() => post({command: 'ready', gpuReduce, maxTile, maxTexture}))
	.catch(error => post({command: 'error', message: String(error)}));
