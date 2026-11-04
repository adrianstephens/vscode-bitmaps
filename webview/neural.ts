// The neural networks the editor uses, run on the GPU through binary_ml's ONNX interpreter; their files come from the extension, which
// fetches them the first time. Object selection is MobileSAM (Segment Anything): its encoder turns the picture into an embedding once,
// and its decoder turns the embedding and a click into a mask, quickly enough to do for every click. Removing an object is LaMa, which
// fills a masked area of a 512 x 512 picture from what is round it. Upscaling is Real-ESRGAN (a compact general model), which makes a picture
// four times the size with sharper edges than any resampling gives, by supplying the detail it expects to have been there. Styles are the
// fast style transfer networks, each of which paints pictures in the manner of one painting; and AdaIN, which paints them in the manner of
// any picture.
import { onnx, onnx_run, onnx_gpu, torch } from '@isopodlabs/binary_ml/browser';
import { RPC, vscode } from '@isopodlabs/vscode_utils/webview/shared.js';
import { float2, float3, float3x3 } from '@isopodlabs/maths/vector';
import { Selection } from './bitmapSelection.js';
import { Mode, working } from './modes.js';
import { Pixels } from './opengl.js';
import { svgFace, type CascadeItem } from './cascade.js';

export const styles = ['mosaic', 'candy', 'rain-princess', 'udnie', 'pointilism'] as const;
export type Style = typeof styles[number];

// A part of a picture (x, y, w, h) carried to be toW x toH, by the same warp as any other scaling: bilinear, and filtered where it is shrunk
function scaled(image: Pixels<4>, x: number, y: number, w: number, h: number, toW: number, toH: number) {
	const sx = toW / w, sy = toH / h;
	const bytes = image.data instanceof Uint8ClampedArray ? image : Pixels(Uint8ClampedArray.from(image.data, v => v * 255), image.width, image.height, 4);
	return Mode.warpPixels(bytes, float3x3(float3(sx, 0, 0), float3(0, sy, 0), float3(-x * sx, -y * sy, 1)), new float2.extent(float2(0, 0), float2(toW, toH)));
}

const SIZE = 1024;	// the longest side of the picture the encoder takes

type GpuSession = InstanceType<typeof onnx_gpu.GpuSession>;
type GpuTensor	= InstanceType<typeof onnx_gpu.GpuTensor>;
type ModelName	= 'sam-encoder' | 'sam-decoder' | 'lama' | 'esrgan' | `style-${Style}` | 'adain-vgg' | 'adain-decoder';

// what the encoder last saw, so that more clicks on the same picture do not encode it again
interface Encoded {
	rgb:		Uint8ClampedArray;	// the picture as the encoder was given it (so a changed picture is noticed)
	embedding:	GpuTensor;
	width:		number;				// its size once resized
	height:		number;
}

let device:		Promise<Awaited<ReturnType<typeof onnx_gpu.createDevice>>> | undefined;
const sessions	= new Map<ModelName, Promise<GpuSession>>();
let encoded:	Encoded | undefined;
let queue:		Promise<unknown> = Promise.resolve();
let report:		((fraction: number) => unknown) | undefined;	// how far the work going on has got, 0..1

function gpuDevice() {
	return device ??= (async () => {
		const gpu = (navigator as Navigator & {gpu?: Parameters<typeof onnx_gpu.createDevice>[0]}).gpu;
		if (!gpu)
			throw new Error('This needs WebGPU, which this editor does not have.');
		return onnx_gpu.createDevice(gpu);
	})().catch(e => { device = undefined; throw e; });
}

// a network, from its file: an ONNX model's graph, unless `graph` makes it of another kind of file
function session(name: ModelName, graph = (data: Uint8Array) => onnx.readOnnxModel(data).graph!) {
	let s = sessions.get(name);
	if (!s) {
		s = (async () => new onnx_gpu.GpuSession(await gpuDevice(), graph(new Uint8Array(await RPC<ArrayBuffer>({command: 'model', name})))))();
		sessions.set(name, s);
		s.catch(() => sessions.delete(name));
	}
	return s;
}

// the picture with its longest side SIZE, as the encoder's HWC rgb
function resized(image: Pixels<4>, size: number) {
	const {width, height} = image;
	const scale	= size / Math.max(width, height);
	const w		= Math.round(width * scale), h = Math.round(height * scale);
	const rgba	= scaled(image, 0, 0, width, height, w, h).data;

	const rgb = new Uint8ClampedArray(w * h * 3);
	for (let i = 0, n = w * h; i < n; i++) {
		rgb[i * 3]		= rgba[i * 4];
		rgb[i * 3 + 1]	= rgba[i * 4 + 1];
		rgb[i * 3 + 2]	= rgba[i * 4 + 2];
	}
	return {rgb, w, h};
}

async function encode(encoder: GpuSession, image: Pixels<4>): Promise<Encoded> {
	const {rgb, w, h} = resized(image, SIZE);
	if (encoded && encoded.width === w && encoded.height === h && encoded.rgb.every((v, i) => v === rgb[i]))
		return encoded;

	encoded?.embedding.free();
	encoded = undefined;
	const out = await encoder.run({input_image: new onnx_run.Tensor('f32', [h, w, 3], Float32Array.from(rgb))}, ['image_embeddings'], stage(0, 0.9));
	return encoded = {rgb, embedding: out.image_embeddings as GpuTensor, width: w, height: h};
}

// the mask of the object at a point of the picture, 0..255 for each pixel of the box that holds it; undefined if there is none
async function mask(image: Pixels<4>, x: number, y: number) {
	const [encoder, decoder] = await Promise.all([session('sam-encoder'), session('sam-decoder')]);
	const {embedding, width: w, height: h} = await encode(encoder, image);

	const f32	= (shape: number[], values: ArrayLike<number>) => new onnx_run.Tensor('f32', shape, Float32Array.from(values));
	const scale	= w / image.width;
	const out	= await decoder.run({
		image_embeddings:	embedding,
		point_coords:		f32([1, 2, 2], [(x + 0.5) * scale, (y + 0.5) * scale, 0, 0]),	// the second point is the padding the model wants
		point_labels:		f32([1, 2], [1, -1]),
		mask_input:			f32([1, 1, 256, 256], new Float32Array(256 * 256)),
		has_mask_input:		f32([1], [0]),
		orig_im_size:		f32([2], [h, w]),
	}, ['masks'], stage(0.9, 1));
	const logits	= out.masks;
	const data		= (('read' in logits ? await logits.read() : logits) as InstanceType<typeof onnx_run.Tensor>).data as Float32Array;
	if ('free' in logits)
		logits.free();

	// logits at the encoder's size, sampled at each pixel of the picture; a pixel is selected where they are positive, and soft over a few units around that
	const {width, height} = image;
	const coverage = new Uint8Array(width * height);
	let l = width, t = height, r = 0, b = 0;
	for (let py = 0; py < height; py++) {
		const fy = Math.min(h - 1, Math.max(0, (py + 0.5) * scale - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
		for (let px = 0; px < width; px++) {
			const fx	= Math.min(w - 1, Math.max(0, (px + 0.5) * scale - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
			const v		= (data[y0 * w + x0] * (1 - tx) + data[y0 * w + x1] * tx) * (1 - ty) + (data[y1 * w + x0] * (1 - tx) + data[y1 * w + x1] * tx) * ty;
			const c		= Math.round(Math.min(255, Math.max(0, 128 + v * 32)));
			if (c) {
				coverage[py * width + px] = c;
				if (px < l) l = px;
				if (px >= r) r = px + 1;
				if (py < t) t = py;
				if (py >= b) b = py + 1;
			}
		}
	}
	if (r <= l || b <= t)
		return undefined;

	const bw = r - l, box = new Uint8ClampedArray(bw * (b - t));
	for (let py = t; py < b; py++)
		box.set(coverage.subarray(py * width + l, py * width + r), (py - t) * bw);
	return new Selection(new float2.extent(float2(l, t), float2(r, b)), box);
}

// Neural work goes one at a time, as the GPU's buffers are the running network's to reuse, and is shown over the picture as `label` while
// it goes on. A failure (no GPU, the model not fetched) is reported to the extension, and gives nothing.
function queued<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
	const result = queue.then(() => working(label, progress => {
		report = progress;
		return work().finally(() => report = undefined);
	}));
	queue = result.catch(() => {});
	return result.catch(e => {
		vscode.postMessage({command: 'error', message: e instanceof Error ? e.message : String(e)});
		return undefined;
	});
}

// a network's run as the part of the work from `from` to `to` (what GpuSession.run tells as the GPU gets on)
const stage = (from: number, to: number) => (done: number, total: number) => report?.(from + (to - from) * done / total);

// The object at a point of the picture as a selection.
export function segment(image: Pixels<4>, x: number, y: number): Promise<Selection | undefined> {
	if (x < 0 || y < 0 || x >= image.width || y >= image.height)
		return Promise.resolve(undefined);
	return queued('Finding the object', () => mask(image, x, y));
}

//-----------------------------------------------------------------------------
// removing an object
//-----------------------------------------------------------------------------

const LAMA = 512;	// the size of the picture LaMa takes

// The pixels with which to fill the selection, for the selection's bounds (the picture's size there), taken from the network's picture of the
// selection and what is round it: undefined if there is no selection.
async function filled(image: Pixels<4>, selection: Selection) {
	const net = await session('lama');
	const {width: W, height: H} = image;
	const bx0 = Math.max(0, Math.floor(selection.min.x)), by0 = Math.max(0, Math.floor(selection.min.y));
	const bx1 = Math.min(W, Math.ceil(selection.max.x)), by1 = Math.min(H, Math.ceil(selection.max.y));
	const bw = bx1 - bx0, bh = by1 - by0;
	if (bw <= 0 || bh <= 0)
		return undefined;

	// the part of the picture the network sees: the selection and room round it to take from, square where the picture is big enough
	const room = Math.max(32, Math.max(bw, bh) / 2);
	let cw = Math.min(W, bw + 2 * room), ch = Math.min(H, bh + 2 * room);
	const side = Math.min(Math.max(cw, ch), Math.min(W, H));
	if (Math.max(cw, ch) <= Math.min(W, H))
		cw = ch = side;
	cw = Math.round(cw);
	ch = Math.round(ch);
	const cx = Math.round(Math.min(W - cw, Math.max(0, (bx0 + bx1 - cw) / 2))), cy = Math.round(Math.min(H - ch, Math.max(0, (by0 + by1 - ch) / 2)));
	const scale = LAMA / Math.max(cw, ch), w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));

	// the picture and mask as planes of the 512 x 512 the network takes (the part which the crop does not fill is left empty)
	const rgba	= scaled(image, cx, cy, cw, ch, w, h).data;
	const img	= new Float32Array(3 * LAMA * LAMA);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x, o = y * LAMA + x;
			img[o]					= rgba[i * 4] / 255;
			img[LAMA * LAMA + o]	= rgba[i * 4 + 1] / 255;
			img[2 * LAMA * LAMA + o]= rgba[i * 4 + 2] / 255;
		}
	}
	// the selection as the network sees it (carried by the same scaling as the picture), grown a little (a mask which just touches the object leaves its edge in the picture)
	const toNet = float3x3(float3(scale, 0, 0), float3(0, scale, 0), float3(-cx * scale, -cy * scale, 1));
	const near = selection.transform(toNet)?.growClamp(4, float2(LAMA, LAMA)), msk = new Float32Array(LAMA * LAMA);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			if (near?.at(x, y)) {
				msk[y * LAMA + x] = 1;
				for (let c = 0; c < 3; c++)
					img[c * LAMA * LAMA + y * LAMA + x] = 0;	// (the network does not look at what the mask covers)
			}

	const out = await net.run({
		image:	new onnx_run.Tensor('f32', [1, 3, LAMA, LAMA], img),
		mask:	new onnx_run.Tensor('f32', [1, 1, LAMA, LAMA], msk),
	}, ['output'], stage(0, 1)).then(r => r.output);
	const result = ('read' in out ? await out.read() : out) as InstanceType<typeof onnx_run.Tensor>;
	const plane = result.data as Float32Array;
	if ('free' in out)
		out.free();

	// its picture (the colours come out 0..255), carried back by the inverse of the scaling and laid on the selection's bounds
	const back = new Uint8ClampedArray(LAMA * LAMA * 4), area = new float2.extent(float2(bx0, by0), float2(bx1, by1));
	for (let i = 0; i < LAMA * LAMA; i++) {
		back[i * 4]		= plane[i];
		back[i * 4 + 1]	= plane[LAMA * LAMA + i];
		back[i * 4 + 2]	= plane[2 * LAMA * LAMA + i];
		back[i * 4 + 3]	= i % LAMA < w && i / LAMA < h ? 255 : 0;	// (the network's picture is empty where the crop did not fill it)
	}
	const pixels = Mode.warpPixels(Pixels(back, LAMA, LAMA, 4), toNet.inverse(), area), src = image.data;
	for (let y = 0; y < bh; y++)
		for (let x = 0; x < bw; x++)
			pixels.data[(y * bw + x) * 4 + 3] = src[((by0 + y) * W + bx0 + x) * 4 + 3];	// (the picture's own transparency stays)
	return {area, pixels};
}

// What to put in the selection's place so that the object in it is gone: the pixels for the area they cover (the selection's bounds)
export function removeObject(image: Pixels<4>, selection: Selection) {
	return queued('Removing the object', () => filled(image, selection));
}

//-----------------------------------------------------------------------------
// upscaling
//-----------------------------------------------------------------------------

const TILE = 160, MARGIN = 12;	// the network is given the picture a tile at a time (with some of what is round it, which the tile's edges need)
const MAX_PIXELS = 64e6;		// of the picture four times the size (which is made whatever the scale asked for), or of the one asked for if that is bigger

// The picture `factor` times the size. The network makes it four times the size, so other scales are that resampled smoothly (a second
// pass of the network is worse than resampling: it makes up detail where it had made some up already).
async function enlarged(image: Pixels<4>, factor: 2 | 4 | 8) {
	const {width: W, height: H} = image;
	if (W * H * Math.max(16, factor * factor) > MAX_PIXELS)
		throw new Error(`A picture of ${W} x ${H} is too big to upscale.`);
	const net = await session('esrgan');
	const src = image.data instanceof Uint8ClampedArray ? image.data : Uint8ClampedArray.from(image.data, v => v * 255);
	const BW = W * 4, big = new Uint8ClampedArray(BW * H * 4 * 4);

	const tiles = Math.ceil(W / TILE) * Math.ceil(H / TILE);
	let tile = 0;
	for (let y0 = 0; y0 < H; y0 += TILE) {
		for (let x0 = 0; x0 < W; x0 += TILE, tile++) {
			const x1 = Math.min(W, x0 + TILE), y1 = Math.min(H, y0 + TILE);
			const ex0 = Math.max(0, x0 - MARGIN), ex1 = Math.min(W, x1 + MARGIN), ey0 = Math.max(0, y0 - MARGIN), ey1 = Math.min(H, y1 + MARGIN);
			const w = ex1 - ex0, h = ey1 - ey0, plane = new Float32Array(3 * w * h);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const o = ((ey0 + y) * W + ex0 + x) * 4, i = y * w + x;
					plane[i]				= src[o] / 255;
					plane[w * h + i]		= src[o + 1] / 255;
					plane[2 * w * h + i]	= src[o + 2] / 255;
				}
			const out = await net.run({input: new onnx_run.Tensor('f32', [1, 3, h, w], plane)}, ['output'], stage(tile / tiles, (tile + 1) / tiles)).then(r => r.output);
			const result = (('read' in out ? await out.read() : out) as InstanceType<typeof onnx_run.Tensor>).data as Float32Array;
			if ('free' in out)
				out.free();

			// the part of its picture which is the tile (the rest is the margin), into the picture
			const ow = w * 4, oh = h * 4, plane4 = ow * oh;
			for (let y = (y0 - ey0) * 4; y < (y1 - ey0) * 4; y++) {
				for (let x = (x0 - ex0) * 4; x < (x1 - ex0) * 4; x++) {
					const o = ((ey0 * 4 + y) * BW + ex0 * 4 + x) * 4, i = y * ow + x;
					big[o]		= result[i] * 255 + 0.5;
					big[o + 1]	= result[plane4 + i] * 255 + 0.5;
					big[o + 2]	= result[2 * plane4 + i] * 255 + 0.5;
					big[o + 3]	= 255;
				}
			}
		}
	}

	// the transparency, which the network does not see, is the picture's own made bigger
	if (src.some((v, i) => i % 4 === 3 && v < 255)) {
		const alpha = new Uint8ClampedArray(W * H * 4);
		for (let i = 0; i < W * H; i++)
			alpha.set([src[i * 4 + 3], src[i * 4 + 3], src[i * 4 + 3], 255], i * 4);
		const a = scaled(Pixels(alpha, W, H, 4), 0, 0, W, H, BW, H * 4).data;
		for (let i = 0; i < BW * H * 4; i++)
			big[i * 4 + 3] = a[i * 4];
	}

	if (factor === 4)
		return Pixels(big, BW, H * 4, 4);
	return scaled(Pixels(big, BW, H * 4, 4), 0, 0, BW, H * 4, W * factor, H * factor);
}

// The picture `factor` times the size, with detail the network supplies; nothing if it could not be done
export function upscale(image: Pixels<4>, factor: 2 | 4 | 8) {
	return queued(`Upscaling ${factor}\u00d7`, () => enlarged(image, factor));
}

// The menu item which upscales a picture (`run` is given 'upscale2', 'upscale4' or 'upscale8')
export function upscaleItem(run: (op: string) => unknown): CascadeItem {
	const icon = '<path d="M2.5 13.5v-4h4v4z M2.5 13.5l9-9M7.5 2.5h6v6"/>';
	const by = (factor: 2 | 4 | 8): CascadeItem => ({
		id:			`upscale${factor}`,
		face:		() => svgFace(icon),
		caption:	() => `Upscale ${factor}x (the first use fetches a neural network, and takes a moment)`,
		select:		() => (run(`upscale${factor}`), true),
	});
	return {
		id:			'upscale',
		face:		() => svgFace(icon),
		caption:	() => 'Upscale with a neural network: sharper than resampling, but it makes up detail',
		children:	() => [by(2), by(4), by(8)],
	};
}

//-----------------------------------------------------------------------------
// styles
//-----------------------------------------------------------------------------

const STYLE_SIZE = 1024;	// the longest side the picture is given to the network at (its normalisation is over the whole picture, so it is not done in tiles)

// The picture painted in a style. The network takes colours 0..255, and sizes which are
// multiples of 4 (it halves twice and doubles twice), so the picture is resampled to that and back.
async function painted(image: Pixels<4>, style: Style) {
	const net = await session(`style-${style}`);
	const {width: W, height: H} = image, scale = Math.min(1, STYLE_SIZE / Math.max(W, H));
	const w = Math.max(4, Math.round(W * scale / 4) * 4), h = Math.max(4, Math.round(H * scale / 4) * 4);
	const src = image.data instanceof Uint8ClampedArray ? image.data : Uint8ClampedArray.from(image.data, v => v * 255);
	const rgba = scaled(Pixels(src, W, H, 4), 0, 0, W, H, w, h).data, wh = w * h, plane = new Float32Array(3 * wh);
	for (let i = 0; i < wh; i++) {
		plane[i]			= rgba[i * 4];
		plane[wh + i]		= rgba[i * 4 + 1];
		plane[2 * wh + i]	= rgba[i * 4 + 2];
	}
	const out = await net.run({input1: new onnx_run.Tensor('f32', [1, 3, h, w], plane)}, ['output1'], stage(0, 1)).then(r => r.output1);
	const result = (('read' in out ? await out.read() : out) as InstanceType<typeof onnx_run.Tensor>).data as Float32Array;
	if ('free' in out)
		out.free();

	const art = new Uint8ClampedArray(wh * 4);
	for (let i = 0; i < wh; i++)
		art.set([result[i] + 0.5, result[wh + i] + 0.5, result[2 * wh + i] + 0.5, 255], i * 4);
	const big = w === W && h === H ? art : scaled(Pixels(art, w, h, 4), 0, 0, w, h, W, H).data;
	for (let i = 0; i < W * H; i++)
		big[i * 4 + 3] = src[i * 4 + 3];	// (the picture's own transparency stays)
	return Pixels(big as Uint8ClampedArray<ArrayBuffer>, W, H, 4);
}

// The picture painted in a style (nothing if it could not be done)
export function stylise(image: Pixels<4>, style: Style) {
	return queued('Styling', () => painted(image, style));
}

//-----------------------------------------------------------------------------
// a style from any picture
//-----------------------------------------------------------------------------

// AdaIN (Huang and Belongie, 2017; the weights are github.com/naoto0804/pytorch-AdaIN's, PyTorch checkpoints made into graphs here). VGG-19,
// as far as relu4_1, makes a picture 512 features at an eighth of its size; the picture's features are given the mean and spread, feature by
// feature, of the style's; and the decoder makes a picture of them. Colours are 0..1 in and out.

// A checkpoint's Sequential of convolutions as a graph from 'in' to 'out': a 3x3 convolution is padded by reflection first, and what lies
// between one convolution and the next is what their indices leave room for: the pad alone, a ReLU and the pad, or a ReLU, a resampling
// and the pad. The convolutions are those numbered up to `last`, which is followed by a ReLU if `relu`.
function sequential(dict: Record<string, torch.TorchTensor>, last: number, resample: (x: string, out: string) => onnx.MadeNode, relu: boolean, extra: Record<string, {shape: number[], data: Float32Array}> = {}) {
	const convs = Object.keys(dict).filter(k => k.endsWith('.weight')).map(k => parseInt(k)).filter(k => k <= last).sort((a, b) => a - b);
	const nodes: onnx.MadeNode[] = [], weights = {...extra};
	let x = 'in';
	convs.forEach((k, i) => {
		const w = dict[`${k}.weight`], gap = i + 1 < convs.length ? convs[i + 1] - k : relu ? 3 : 0;
		weights[`w${k}`] = {shape: w.shape, data: w.data as Float32Array};
		weights[`b${k}`] = {shape: dict[`${k}.bias`].shape, data: dict[`${k}.bias`].data as Float32Array};
		if (w.shape[2] === 3)
			nodes.push({op: 'Pad', inputs: [x], outputs: [x = `p${k}`], attrs: {mode: 'reflect', pads: [0, 0, 1, 1, 0, 0, 1, 1]}});
		nodes.push({op: 'Conv', inputs: [x, `w${k}`, `b${k}`], outputs: [x = `c${k}`], attrs: {kernel_shape: [w.shape[2], w.shape[3]]}});
		if (gap >= 3)
			nodes.push({op: 'Relu', inputs: [x], outputs: [x = `r${k}`]});
		if (gap === 4)
			nodes.push(resample(x, x = `s${k}`));
	});
	nodes[nodes.length - 1].outputs = ['out'];
	return onnx.makeGraph(nodes, weights, ['in'], ['out']);
}

const encoder = () => session('adain-vgg', data => sequential(torch.readStateDict(data), 29,
	(x, out) => ({op: 'MaxPool', inputs: [x], outputs: [out], attrs: {kernel_shape: [2, 2], strides: [2, 2], ceil_mode: 1}}), true));
const decoder = () => session('adain-decoder', data => sequential(torch.readStateDict(data), Infinity,
	(x, out) => ({op: 'Upsample', inputs: [x, 'scales'], outputs: [out], attrs: {mode: 'nearest'}}), false,
	{scales: {shape: [4], data: Float32Array.of(1, 1, 2, 2)}}));

// a picture resized (its longest side `size`, each side a multiple of 8) as the networks' planes of 0..1, over white where it is transparent
function planes(image: Pixels<4>, size: number) {
	const {width: W, height: H} = image, scale = size / Math.max(W, H);
	const w = Math.max(8, Math.round(W * scale / 8) * 8), h = Math.max(8, Math.round(H * scale / 8) * 8), wh = w * h;
	const rgba = scaled(image, 0, 0, W, H, w, h).data, out = new Float32Array(3 * wh);
	for (let i = 0; i < wh; i++) {
		const a = rgba[i * 4 + 3] / 255;
		for (let c = 0; c < 3; c++)
			out[c * wh + i] = (rgba[i * 4 + c] * a + 255 * (1 - a)) / 255;
	}
	return {data: out, w, h};
}

// a picture's features (512 planes at an eighth of its size)
async function features(image: {data: Float32Array, w: number, h: number}, progress: ReturnType<typeof stage>) {
	const out = await (await encoder()).run({in: new onnx_run.Tensor('f32', [1, 3, image.h, image.w], image.data)}, ['out'], progress).then(r => r.out);
	const f = (('read' in out ? await out.read() : out) as InstanceType<typeof onnx_run.Tensor>).data as Float32Array;
	if ('free' in out)
		out.free();
	return f;
}

// each feature's mean and spread (with the 1e-5 the network was trained with)
function moments(f: Float32Array, channels: number) {
	const n = f.length / channels, mean = new Float32Array(channels), std = new Float32Array(channels);
	for (let c = 0; c < channels; c++) {
		let s = 0, ss = 0;
		for (let i = c * n; i < (c + 1) * n; i++)
			s += f[i];
		const m = s / n;
		for (let i = c * n; i < (c + 1) * n; i++)
			ss += (f[i] - m) ** 2;
		mean[c] = m;
		std[c] = Math.sqrt(ss / Math.max(1, n - 1) + 1e-5);
	}
	return {mean, std};
}

// what is kept of the last pictures encoded: a style's moments at each scale, and the features of the picture last painted
const styleMoments = new WeakMap<Pixels<4>, Map<number, ReturnType<typeof moments>>>();
let lastContent: {image: Pixels<4>, w: number, h: number, f: Float32Array} | undefined;

const CHANNELS = 512;

// The picture painted in the manner of another, whose marks are as big as they are when it is `scale` times the size of the picture
async function adain(image: Pixels<4>, style: Pixels<4>, scale: number) {
	const {width: W, height: H} = image, size = Math.min(STYLE_SIZE, Math.max(W, H));
	const content = lastContent?.image === image ? lastContent : (() => {
		const p = planes(image, size);
		return {image, w: p.w, h: p.h, p};
	})();
	const f = 'f' in content ? content.f : await features(content.p, stage(0, 0.45));
	lastContent = {image, w: content.w, h: content.h, f};

	let byScale = styleMoments.get(style);
	if (!byScale)
		styleMoments.set(style, byScale = new Map());
	let s = byScale.get(scale);
	if (!s) {
		const p = planes(style, Math.max(64, Math.min(2048, Math.round(size * scale))));
		byScale.set(scale, s = moments(await features(p, stage(0.45, 0.6)), CHANNELS));
	}

	// the picture's features with the style's moments
	const c = moments(f, CHANNELS), n = f.length / CHANNELS, t = new Float32Array(f.length);
	for (let k = 0; k < CHANNELS; k++) {
		const a = s.std[k] / c.std[k], b = s.mean[k] - c.mean[k] * a;
		for (let i = k * n; i < (k + 1) * n; i++)
			t[i] = f[i] * a + b;
	}
	const {w, h} = lastContent;
	const out = await (await decoder()).run({in: new onnx_run.Tensor('f32', [1, CHANNELS, h / 8, w / 8], t)}, ['out'], stage(0.6, 1)).then(r => r.out);
	const result = (('read' in out ? await out.read() : out) as InstanceType<typeof onnx_run.Tensor>).data as Float32Array;
	if ('free' in out)
		out.free();

	const wh = w * h, art = new Uint8ClampedArray(wh * 4);
	for (let i = 0; i < wh; i++)
		art.set([result[i] * 255 + 0.5, result[wh + i] * 255 + 0.5, result[2 * wh + i] * 255 + 0.5, 255], i * 4);
	const src = image.data as Uint8ClampedArray;
	const big = w === W && h === H ? art : scaled(Pixels(art, w, h, 4), 0, 0, w, h, W, H).data;
	for (let i = 0; i < W * H; i++)
		big[i * 4 + 3] = src[i * 4 + 3];	// (the picture's own transparency stays)
	return Pixels(big as Uint8ClampedArray<ArrayBuffer>, W, H, 4);
}

/** The picture painted in the manner of another (nothing if it could not be done). `scale` is how big the style's marks are: as they are in
 *  it when it is that many times the size of the picture (less for finer, more for bolder). */
export function styleFrom(image: Pixels<4>, style: Pixels<4>, scale: number) {
	return queued('Styling', () => adain(image, style, scale));
}
