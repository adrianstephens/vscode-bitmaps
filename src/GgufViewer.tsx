import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import * as bin from '@isopodlabs/binary';
import { gguf } from '@isopodlabs/binary_ml';
import * as webview from '@isopodlabs/vscode_utils/webview';
import type { JSX } from '@isopodlabs/vscode_utils/jsx-runtime';
import { webviewPage } from './BitmapViewer';
import type { TensorOut, TensorIn, TensorShader, Quant } from '../webview/tensor';
import { files, setActiveViewer, readShader } from './extension';

// Turns a tensor (e.g. from a GGUF file) into a grid of values to draw, reading only what is needed to fill it.
// Tensor elements are in ggml order: shape[0] varies fastest, so a 2D tensor is a matrix with shape[0] columns and shape[1] rows.
/*
interface TensorSource {
	name:			string;
	shape:			bigint[];
	parameterCount():	number;
	read(start?: number, count?: number): Promise<Float32Array>;
}
*/
const MAX_IMAGE		= 2048;		// largest image dimension; bigger tensors are reduced
const STACK_SIDE	= 2048;		// most voxels along a side of the volume a stack of slices is reduced to (its texture can't be larger)
const STACK_VOXELS	= 16 << 20;	// and in all
const ROWS_PER_BIN	= 3;		// rows read for each output row when reducing, however many it covers
const CHUNK			= 1 << 22;	// elements per read
const BAND_ELEMENTS	= 1 << 24;	// most elements of a matrix, or of one slice of a stack, the viewer is sent at once when it reduces on the GPU

type Cancelled = () => boolean;

type V3 = [number, number, number];

// A matrix or stack of slices, as the viewer draws them from the values (a matrix is a stack of one slice):
// voxels along each axis, index (z * dims[1] + y) * dims[0] + x, of elements which they were reduced from; scale is the magnitude which gets the full colour
interface Rendered {
	values:	Float32Array;
	dims:	V3;
	extent:	V3;
	scale:	number;
	info:	string;
}

// source range [a, b) of bin i when reducing (or repeating) S source elements into n bins
function Bin(i: number, n: number, S: number): [number, number] {
	const a = Math.floor(i * S / n);
	return [a, Math.min(S, Math.max(a + 1, Math.floor((i + 1) * S / n)))];
}

// up to count evenly spread indices from [a, b)
function spread(a: number, b: number, count: number) {
	const len = b - a;
	if (len <= count)
		return Array.from({length: len}, (_, i) => a + i);
	return Array.from({length: count}, (_, i) => a + Math.floor((i + 0.5) * len / count));
}

// Reads the W x H matrix at element offset base, reduced to outW x outH. Each output element is the value of largest magnitude
// among the elements it covers (of up to ROWS_PER_BIN rows of them), so outliers stay visible.
async function sampleMatrix(t: gguf.Tensor, base: number, W: number, H: number, outW: number, outH: number, cancelled: Cancelled = () => false, rowsPerBin = ROWS_PER_BIN) {
	const out		= new Float32Array(outW * outH);
	const rows		= Array.from({length: outH}, (_, j) => spread(...Bin(j, outH, H), rowsPerBin));
	const cols		= Array.from({length: outW}, (_, i) => Bin(i, outW, W));
	const chunkRows	= Math.max(1, Math.floor(CHUNK / W));

	// the value of largest magnitude in each column of the source rows `src` covers
	const fold = (best: Float32Array, src: Float32Array) => {
		for (let i = 0; i < outW; i++) {
			const [c0, c1] = cols[i];
			let v = best[i], a = Math.abs(v);
			for (let c = c0; c < c1; c++) {
				const x = src[c], ax = Math.abs(x);
				if (ax > a) {
					v = x;
					a = ax;
				}
			}
			best[i] = v;
		}
	};

	// Sampling spreads the rows of each output row across the whole matrix, so consecutive output rows are served by
	// rows far apart and a read per sampled row pays the round trip rather than the decode: 262144 reads for a
	// 512 x 2048 x 256 stack, which costs several times as much as reading every row of it once. Read one contiguous
	// range covering as many output rows as it can hold instead, and reduce them all from it.
	for (let j = 0; j < outH; ) {
		if (cancelled())
			throw new Error('cancelled');

		const lo = rows[j][0];
		let end = j, hi = lo;
		while (end < outH && rows[end][rows[end].length - 1] < lo + chunkRows) {
			hi = rows[end][rows[end].length - 1] + 1;
			++end;
		}
		if (end === j) {						// one output row spans more rows than a single read: take this one a row at a time
			const best = new Float32Array(outW);
			for (const r of rows[j])
				fold(best, await t.read(base + r * W, W));
			out.set(best, j * outW);
			++j;
			continue;
		}
		const chunk = await t.read(base + lo * W, (hi - lo) * W);
		for (; j < end; j++) {
			const best = new Float32Array(outW);
			for (const r of rows[j])
				fold(best, chunk.subarray((r - lo) * W, (r - lo + 1) * W));
			out.set(best, j * outW);
		}
	}
	return out;
}

// An overview of a W x H x D volume of dims[0] x dims[1] x dims[2] voxels, index (z * dims[1] + y) * dims[0] + x
async function sampleVolume(t: gguf.Tensor, W: number, H: number, D: number, dims: V3, cancelled: Cancelled = () => false) {
	const [nx, ny, nz] = dims;
	const out = new Float32Array(nx * ny * nz);
	for (let z = 0; z < nz; z++) {
		const slice = out.subarray(z * nx * ny, (z + 1) * nx * ny);
		for (const s of spread(...Bin(z, nz, D), 2)) {
			const m = await sampleMatrix(t, s * W * H, W, H, nx, ny, cancelled, 2);
			for (let i = 0; i < m.length; i++) {
				if (Math.abs(m[i]) > Math.abs(slice[i]))
					slice[i] = m[i];
			}
		}
	}
	return out;
}

// magnitude below which `percentile` of the finite values lie
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


const indent = (s: string, n: number) => s.split('\n').map(l => '\t'.repeat(n) + l.trim()).join('\n');

export const DequantShader = {
	// vertex shader
	vert:
`#version 300 es
in vec2 a_position;
void main() {
	gl_Position = vec4(a_position, 0.0, 1.0);
}
	// fragment shader
`,
	frag:
`#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D	u_raw;			// the band's raw block bytes, one byte per texel
uniform int			u_rawWidth;		// bytes per row of u_raw
uniform int			u_block;		// elements per quantisation block
uniform int			u_blockSize;	// bytes per block
uniform int			u_firstBlock;	// the first block the band holds
uniform int			u_format;		// the ggml quantisation type
uniform int			u_rowStride;	// elements per row of the matrix
uniform ivec2		u_origin;		// the tile's top-left in the matrix (x, y)
out float			fragColor;

uint u8(int i)	{ return texelFetch(u_raw, ivec2(i % u_rawWidth, i / u_rawWidth), 0).r; }
uint u16(int i)	{ return u8(i) | (u8(i + 1) << 8); }
uint u32(int i)	{ return u8(i) | (u8(i + 1) << 8) | (u8(i + 2) << 16) | (u8(i + 3) << 24); }

float f16(uint h) {
	int e = int((h >> 10) & 31u), m = int(h & 1023u), s = (h & 32768u) != 0u ? -1 : 1;
	return e == 0 ? float(s * m) * exp2(-24.0)
		: e == 31 ? (m != 0 ? uintBitsToFloat(0x7fc00000u) : float(s) * uintBitsToFloat(0x7f800000u))
		: float(s) * (1.0 + float(m) / 1024.0) * exp2(float(e - 15));
}
float f16At(int i)	{ return f16(u16(i)); }
float i8At(int i)	{ int b = int(u8(i)); return float((b << 24) >> 24); }	// a byte as a signed value

// the nibble a 4-bit format keeps element off of a block in
uint nibble(int base, int qo, int off) {
	uint b = u8(base + qo + (off & 15));
	return off < 16 ? (b & 15u) : (b >> 4);
}

const float IQ4NL[16] = float[16](${gguf.iq4nl.map(x => x.toFixed(1)).join(', ')});
const float MXFP4[16] = float[16](${gguf.mxfp4.map(x => x.toFixed(1)).join(', ')});

void main() {
	ivec2	tile	= ivec2(gl_FragCoord.xy);
	int		idx		= (u_origin.y + tile.y) * u_rowStride + u_origin.x + tile.x;	// the element in the matrix
	int		rel		= idx - u_firstBlock * u_block;
	int		off		= rel - (rel / u_block) * u_block;								// its place in its block
	int		base	= (rel / u_block) * u_blockSize;								// and the block's bytes in the band
	int		f		= u_format;
	float	w		= 0.0;
	if (false) {
`
+ Object.entries(gguf.QuantizationTypes).map(([f, q]) => q.glsl ? `\t} else if (f == ${f}) {\t// ${q.name}\n${indent(q.glsl, 2)}\n` : '').join('')
+ `	}
	fragColor = w;
}
`
};


// What the tensor looks like, for a chooser: a grid, a slice or a volume are possible when it has a third dimension
function dimensions(t: gguf.Tensor) {
	return t.shape.map(Number).filter(d => d !== 1);	// dimensions of size 1 don't change the layout
}

function Slices(dims: number[]) {
	return dims.slice(2).reduce((a, b) => a * b, 1);
}

// The volume a W x H x D stack of slices is reduced to: `block` x `block` elements of a slice make a voxel, `zBlock` slices a layer.
// Slices are kept apart as long as they can be, so a slice can be shown from the volume as it is.
function volumeShape(W: number, H: number, D: number) {
	let block = Math.max(1, Math.ceil(Math.max(W, H) / STACK_SIDE)), zBlock = Math.max(1, Math.ceil(D / STACK_SIDE));
	let dims: V3;
	for (;;) {
		dims = [Math.ceil(W / block), Math.ceil(H / block), Math.ceil(D / zBlock)];
		if (dims.reduce((a, b) => a * b, 1) <= STACK_VOXELS)
			break;
		if (dims[2] > 64)
			++block;
		else
			++zBlock;
	}
	return {block, zBlock, dims};
}

// The most source elements one output element of a reduction of S elements into n is reduced from: the shader closes a bin with
// ceil, so a bin can reach a texel past floor((i + 1) * S / n). This is the size of the source block a pass has to hold.
function binSize(S: number, n: number) {
	let bin = 0;
	for (let i = 0; i < n; i++)
		bin = Math.max(bin, Math.ceil((i + 1) * S / n) - Math.floor(i * S / n));
	return bin;
}


async function renderTensor(t: gguf.Tensor, cancelled: Cancelled = () => false): Promise<Rendered> {
	const dims	= dimensions(t);
	const n		= t.parameterCount();

	// a vector (or single value) is folded into a square
	if (dims.length <= 1) {
		const width		= Math.max(1, Math.ceil(Math.sqrt(n)));
		const height	= Math.ceil(n / width);
		if (n <= MAX_IMAGE * MAX_IMAGE) {
			const values = new Float32Array(width * height);
			values.set(await t.read());
			return {values, dims: [width, height, 1], extent: [width, height, 1], scale: robustScale(values, n), info: `${n} values folded into ${width} x ${height}`};
		}
		dims.splice(0, dims.length, width, Math.floor(n / width));
	}

	const [W, H] = dims;

	// a stack of slices is one volume, which the viewer shows as a grid of the slices, one slice, or a volume
	if (dims.length > 2) {
		const D = Slices(dims);
		const {block, zBlock, dims: dims2} = volumeShape(W, H, D);

		const values	= await sampleVolume(t, W, H, D, dims2, cancelled);
		const scale		= robustScale(values);
		const reduced	= block > 1 || zBlock > 1 ? `, reduced to ${dims2.join(' x ')} voxels of ${block} x ${block} x ${zBlock} elements` : '';
		return {values, dims: dims2, extent: [W, H, D], scale, info: `${W} x ${H} x ${D}${reduced}; full colour at +-${scale.toPrecision(3)}`};
	}

	// the size of the image which holds a W x H matrix
	const block		= Math.max(1, Math.ceil(Math.max(W, H) / MAX_IMAGE));
	const width		= Math.ceil(W / block), height = Math.ceil(H / block);
	const values	= block === 1 && width === W && height === H && n === W * H
		? await t.read()
		: await sampleMatrix(t, 0, W, H, width, height, cancelled);
	const scale = robustScale(values);
	const how	= block > 1 ? `; each pixel is the largest of ${block} x ${block} elements` : '';
	return {values, dims: [width, height, 1], extent: [W, H, 1], scale, info: `${W} x ${H}${how}; full colour at +-${scale.toPrecision(3)}`};
}

// A matrix, or stack of slices, which the viewer reduces itself, with tensorscale.frag: the shape of the reduction, and the largest
// block of source elements any one output value is reduced from (which has to fit the viewer's staging texture).
interface ReducePlan {
	W: number;
	H: number;
	D: number;			// 1 for a matrix
	outW: number;
	outH: number;
	outD: number;		// 1 for a matrix
	block: number;
	binW: number;
	binH: number;
}

// The plan for a matrix the viewer can reduce on the GPU, or undefined when it shouldn't: a vector keeps the CPU reduction, as does
// a matrix small enough to send unreduced, and one whose bins are too big to stage.
function reducePlan(t: gguf.Tensor): ReducePlan | undefined {
	const dims = dimensions(t);
	if (dims.length !== 2)
		return undefined;

	const [W, H]	= dims;
	const block		= Math.max(1, Math.ceil(Math.max(W, H) / MAX_IMAGE));
	if (block <= 1)
		return undefined;

	const outW = Math.ceil(W / block), outH = Math.ceil(H / block);
	return {W, H, D: 1, outW, outH, outD: 1, block, binW: binSize(W, outW), binH: binSize(H, outH)};
}

// The plan for a stack of slices the viewer can reduce on the GPU, or undefined when it shouldn't: the viewer reduces a stack as a
// volume, one layer per slice, so every slice has to fit the volume texture and each layer's bin the staging tile. A stack whose
// slices would have to be binned into a layer (or which is deeper than the volume texture), and one small enough to send unreduced,
// keep the CPU reduction.
function volumePlan(t: gguf.Tensor): ReducePlan | undefined {
	const dims = dimensions(t);
	if (dims.length <= 2)
		return undefined;

	const [W, H]			= dims;
	const D					= Slices(dims);
	const {block, zBlock, dims: [outW, outH, outD]} = volumeShape(W, H, D);
	if (block <= 1 || zBlock !== 1)		// the viewer has something to reduce, and a layer is one slice
		return undefined;

	return {W, H, D, outW, outH, outD, block, binW: binSize(W, outW), binH: binSize(H, outH)};
}

type Gguf		= Awaited<ReturnType<typeof gguf.readGguf>>;
type GgufTensor	= Gguf['tensors'][number];

// GGUF files are often many GB, so unlike images they are never loaded whole: the header is parsed and tensors are read when shown
class GgufDocument implements vscode.CustomDocument {
	constructor(public readonly uri: vscode.Uri, private file: fs.FileHandle, public readonly gguf: Gguf) {}

	dispose() {
		this.file.close().catch(() => {});
	}

	static async open(uri: vscode.Uri) {
		if (uri.scheme !== 'file')
			throw new Error('The GGUF viewer reads tensors from the file as needed, so it needs a file on disk');

		const file = await fs.open(uri.fsPath, 'r');
		try {
			const stream = new bin.async.stream(
				(offset, data) => file.read(data, 0, data.length, offset).then(r => r.bytesRead),
				undefined,
				undefined,
				(await file.stat()).size
			);
			return new GgufDocument(uri, file, await gguf.readGguf(stream));
		} catch (error) {
			await file.close();
			throw error;
		}
	}
}

const META_ITEMS	= 200;		// most elements of an array shown; tokenizer vocabularies have over a hundred thousand
const META_TEXT		= 2000;		// and characters of a string, for the likes of chat templates

const metaText = (v: any) => typeof v === 'string'
	? JSON.stringify(v.length > META_TEXT ? v.slice(0, META_TEXT) + '…' : v)
	: String(v);

// The metadata of a file, which the reader nests by the dots of the keys ('a.b.c': 1 is {a: {b: {c: 1}}}), as the rows of a tree:
// a group is a caret which opens and closes, a value a row. Values are text, as they can be bigints.
const metaLabel = (name: string, value?: string) => [
	<span class="key">{name}</span>,
	value === undefined ? undefined : <span class="value">{value}</span>,
];

const metaLeaf = (name: string, value: string) =>
	<div class="select" title={`${name}: ${value}`}>{metaLabel(name, value)}</div>;

const metaGroup = (name: string, value: string | undefined, children: (JSX.Element | undefined)[], open = false) =>
	<div class={open ? 'caret caret-down' : 'caret'}>
		<span class="select">{metaLabel(name, value)}</span>
		<div class="children">{children}</div>
	</div>;

// arrays, typed arrays and the reader's typed arrays (which are proxies, so not ArrayBuffer views) are lists of values
const isArrayLike = (value: any): value is ArrayLike<any> =>
	Array.isArray(value) || ArrayBuffer.isView(value) || (typeof value.length === 'number' && typeof value[Symbol.iterator] === 'function');

function metaRow(name: string, value: any, open = false): JSX.Element {
	if (value && typeof value === 'object') {
		if (isArrayLike(value)) {
			const array = value;
			if (array.length <= 8 && Array.from(array).every(x => typeof x !== 'object'))
				return metaLeaf(name, `[${Array.from(array, metaText).join(', ')}]`);

			const shown = Math.min(array.length, META_ITEMS);
			return metaGroup(name, `[${array.length}]`, [
				...Array.from({length: shown}, (_, i) => metaRow(String(i), array[i])),
				array.length > shown ? metaLeaf('…', `${array.length - shown} more`) : undefined,
			]);
		}
		return metaGroup(name, undefined, Object.entries(value).map(([k, v]) => metaRow(k, v)), open);
	}
	return metaLeaf(name, metaText(value));
}

const shapeText = (t: GgufTensor) => t.shape.join(' × ');

// The shaders which are files in the extension; the viewer's 'dequant' shader comes from binary_ml instead, beside the
// format table it expands (see getShaders).
const shaderFiles: Record<Exclude<TensorShader, 'dequant'>, {vert: string, frag: string}> = {
	'bg':		{vert: 'bitmap.vert',	frag: 'background.frag'},
	'tensor3d':	{vert: 'tensor.vert',	frag: 'tensor.frag'},
	'tensorgrid':	{vert: 'bitmap.vert',	frag: 'tensorgrid.frag'},
	'tensorslice':	{vert: 'bitmap.vert',	frag: 'tensorslice.frag'},
	'tensorscale':	{vert: 'bitmap.vert',	frag: 'tensorscale.frag'},
};

class GgufViewer extends webview.Panel<TensorOut, TensorIn> {
	private token = 0;	// identifies the latest request, so an older one still reading can stop
	private gpuReduce = false;	// the viewer told us it can reduce a matrix itself (it has EXT_color_buffer_float)
	private maxTile = MAX_IMAGE;	// and the largest staging texture it can make
	private maxTexture = MAX_IMAGE;	// and the largest 2D texture (which holds a band's raw blocks)
	private streaming: {token: number, tensor: GgufTensor, W: number, H: number, D: number, quant?: Quant} | undefined;	// the tensor getBand reads from; H is the rows of one slice, D the slices

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, public document: GgufDocument) {
		super(webviewPanel, assets);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: assets.localRoots(),
		};
		// the metadata and the tensors are in the page, rather than sent when the viewer is ready
		const {metadata, tensors} = document.gguf;
		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/tensor.js', 'GGUF Tensors', [
			<div id="sidebar">
				<div id="meta-pane" class={Object.keys(metadata).length ? 'pane' : 'pane hidden'}>
					<div class="pane-title">Metadata</div>
					<div id="meta-tree" class="tree">
						{Object.entries(metadata).map(([k, v]) => metaRow(k, v, k === 'general'))}
					</div>
				</div>
				<div id="tensor-pane" class="pane">
					<div class="pane-title">Tensors</div>
					<input id="tensor-filter" type="text" placeholder="Filter by name, type or shape" spellcheck="false" />
					<div id="tensor-count">{`${tensors.length} tensors`}</div>
					<div id="tensor-list" tabindex="0">
						{tensors.map((t, i) =>
							<div class="tensor" data-index={i} data-slices={Slices(dimensions(t))} title={t.name}>
								<div class="name">{t.name}</div>
								<div class="meta">{`${t.typeName()}  ${shapeText(t)}`}</div>
							</div>
						)}
					</div>
					<div id="tensor-controls" class="hidden">
						<div>
							<label><input type="radio" name="tensor-view" value="grid" checked /> Grid</label>
							<label><input type="radio" name="tensor-view" value="slice" /> Slice</label>
							<label><input type="radio" name="tensor-view" value="volume" /> Volume</label>
						</div>
						<div id="slice-row">
							<input id="slice-slider" type="range" min="0" max="0" value="0" />
							<input id="slice-number" type="number" min="0" max="0" value="0" />
							<span id="slice-total" />
						</div>
					</div>
				</div>
			</div>,
			<div class="splitter" id="splitter" />,
			<div id="main">
				<canvas id="viewport" />
				<canvas id="labels" />
				<div id="tensor-info" />
			</div>,
		], 'tensors', ['node_modules/@isopodlabs/vscode_utils/assets/tree.css']);
	}

	async command(message: TensorOut) {
		switch (message.command) {
			case 'getShaders':
				// the dequantising shader is binary_ml's, so the format table and the GPU expansion of each format stay together
				if (message.type === 'dequant')
					return DequantShader;
				return {
					vert: await readShader(this.localUri('assets/' + shaderFiles[message.type].vert)),
					frag: await readShader(this.localUri('assets/' + shaderFiles[message.type].frag)),
				};

			case 'ready': {
				this.gpuReduce	= message.gpuReduce;
				this.maxTile	= message.maxTile;
				this.maxTexture	= message.maxTexture;
				const tensors = this.document.gguf.tensors;
				const first = tensors.find(t => dimensions(t).length >= 2) ?? tensors[0];
				if (first)
					this.show(first);
				else
					vscode.window.showInformationMessage('This GGUF file contains no tensors');
				break;
			}

			case 'getBand': {
				// a band of whole rows of one slice of the tensor being reduced: the viewer asked for it, so it is still showing that tensor
				const s = this.streaming, slice = message.slice ?? 0;
				if (!s || s.token !== message.token || slice < 0 || slice >= s.D || message.y0 < 0 || message.y0 >= message.y1 || message.y1 > s.H)
					return {data: new Float32Array(0)};
				try {
					const start = (slice * s.H + message.y0) * s.W, count = (message.y1 - message.y0) * s.W;
					// a quantised tensor's band is raw blocks, which the viewer expands on the GPU; firstBlock says which block they start at
					if (s.quant) {
						const raw = await s.tensor.readRaw(start, count);
						return {data: raw.bytes as Uint8Array, firstBlock: raw.first};
					}
					return {data: await s.tensor.read(start, count)};
				} catch (error: any) {
					// the viewer waits for this reply, so a failed read has to come back as one rather than as a rejected request
					return {data: new Float32Array(0), error: `${s.tensor.name}: ${error.message}`};
				}
			}

			case 'error':
				vscode.window.showErrorMessage(message.message);
				break;

			case 'selectTensor': {
				const tensor = this.document.gguf.tensors[message.index];
				if (tensor)
					this.show(tensor);
				break;
			}
		}
	}

	// a matrix or stack of slices the viewer can reduce is streamed to it in bands; anything else (a vector, or a stack whose
	// slices the viewer cannot hold) is reduced here and sent whole.
	async show(tensor: GgufTensor) {
		const token = ++this.token;
		this.webviewPanel.title = `${path.basename(this.document.uri.fsPath)} · ${tensor.name}`;

		this.postMessage({command: 'tensorSelected', index: this.document.gguf.tensors.indexOf(tensor)});

		// The viewer reduces a reduced matrix, or stack of slices, itself when its bins fit the viewer's staging texture and a band
		// of whole rows fits what is sent at once; the reduction then happens on the GPU, and neither side ever holds the tensor. A
		// quantised tensor whose format binary_ml can expand on the GPU crosses as raw blocks; any other crosses already expanded.
		const plan = this.gpuReduce ? reducePlan(tensor) ?? volumePlan(tensor) : undefined;
		if (plan && plan.outW <= this.maxTile && plan.outH <= this.maxTile && plan.outD <= this.maxTile && plan.binW <= this.maxTile && plan.binH <= this.maxTile && plan.binH * plan.W <= BAND_ELEMENTS) {
			// the viewer groups a band's output rows, so it needs the most source rows of a slice the extension will send at once
			const bandRows	= Math.max(1, Math.min(this.maxTile, Math.floor(BAND_ELEMENTS / plan.W)));
			const format	= gguf.QuantizationTypes[tensor.dtype];
			// a band's blocks can start before the band does, so its bytes are at most one block more than its elements need
			const bandBytes	= Math.ceil(Math.min(plan.H, bandRows) * plan.W / (format?.block ?? 1)) * (format?.size ?? 1) + (format?.size ?? 1);
			let quant: Quant | undefined;
			if (format?.block && format?.glsl && bandBytes <= this.maxTexture * this.maxTexture)
				quant = {dtype: tensor.dtype, name: format.name, block: format.block, size: format.size};
			this.streaming = {token, tensor, W: plan.W, H: plan.H, D: plan.D, quant};
			const volume	= plan.D > 1 ? ` x ${plan.D}` : '';
			const how		= `; each ${plan.D > 1 ? 'voxel' : 'pixel'} is the largest of ${plan.block} x ${plan.block}${plan.D > 1 ? ' x 1' : ''} elements${quant ? `, expanded from ${quant.name} on the GPU` : ''}`;
			this.postMessage({command: 'tensorReduce', token, dims: [plan.outW, plan.outH, plan.outD], extent: [plan.W, plan.H, plan.D], info: `${plan.W} x ${plan.H}${volume}${how}`, bandRows, quant});
			return;
		}

		this.streaming = undefined;
		try {
			const rendered = await vscode.window.withProgress(
				{location: vscode.ProgressLocation.Window, title: `Reading ${tensor.name}`},
				() => renderTensor(tensor, () => token !== this.token)
			);
			if (token !== this.token)
				return;

			const info = `${tensor.typeName()} ${shapeText(tensor)}; ${rendered.info}`;
			this.postMessage({command: 'volume', values: rendered.values, dims: rendered.dims, extent: rendered.extent, scale: rendered.scale, info});
		} catch (error: any) {
			if (token === this.token)
				vscode.window.showErrorMessage(`${tensor.name}: ${error.message}`);
		}
	}

	// step through the slices of a tensor with more than two dimensions
	step(delta: number) {
		this.postMessage({command: 'stepSlice', delta});
	}
}

export class GgufViewerProvider implements vscode.CustomReadonlyEditorProvider<GgufDocument> {
	private readonly assets: webview.Assets;
	private active: GgufViewer | undefined;

	constructor(context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('gguf.viewer', this, {webviewOptions: {retainContextWhenHidden: true}, supportsMultipleEditorsPerDocument: true}),
			vscode.commands.registerCommand('gguf.nextSlice',		() => this.active?.step(1)),
			vscode.commands.registerCommand('gguf.previousSlice',	() => this.active?.step(-1)),
		);
	}

	openCustomDocument(uri: vscode.Uri) {
		return GgufDocument.open(uri);
	}

	async resolveCustomEditor(document: GgufDocument, webviewPanel: vscode.WebviewPanel) {
		const editor = new GgufViewer(webviewPanel, this.assets, document);
		const activate = () => {
			this.active = editor;
			setActiveViewer(editor);
		};
		activate();

		webviewPanel.onDidDispose(() => {
			if (this.active === editor)
				this.active = undefined;
		});
		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				activate();
		});
	}
}
