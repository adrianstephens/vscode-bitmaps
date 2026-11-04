// Stands in for the extension on a plain web page: the bitmap editor's messages to the extension (acquireVsCodeApi().postMessage)
// are answered here, and what the extension would send is posted back to the page as a window message.
// Files are opened by picker, drop, paste or ?src=url; what the browser can decode itself (PNG, JPEG, GIF, WebP) is loaded through
// createImageBitmap, and the rest is read by @isopodlabs/binary_bitmaps. Ctrl/Cmd+S saves.
import {send, download, request, installHost, openers, takeHandoff} from './common.js';

// the shader pair of each kind of program (as BitmapViewer.tsx's table)
const shaders = {
	'bg':		['bitmap.vert',		'background.frag'],
	'2d':		['bitmap.vert',		'bitmap.frag'],
	'array2d':	['bitmap.vert',		'array2d.frag'],
	'cube':		['cube.vert',		'cube.frag'],
	'cube2d':	['bitmap.vert',		'cube2d.frag'],
	'3d':		['volume.vert',		'volume.frag'],
	'3d2d':		['bitmap.vert',		'volume2d.frag'],
	'layer':	['layer.vert',		'layer.frag'],
	'composite':['bitmap.vert',		'composite.frag'],
	'planes':	['planes.vert',		'planes.frag'],
	'warp':		['bitmap.vert',		'warp.frag'],
	'blur':		['bitmap.vert',		'blur.frag'],
	'levels':	['bitmap.vert',		'levels.frag'],
	'gradient':	['bitmap.vert',		'gradient.frag'],
	'convolve':	['bitmap.vert',		'convolve.frag'],
	'flatten':	['bitmap.vert',		'flatten.frag'],
	'ink':		['bitmap.vert',		'ink.frag'],
	'effect':	['bitmap.vert',		'effect.frag'],
	'textwarp':	['textwarp.vert',	'textwarp.frag'],
};

// the networks the AI tools run, by name (as src/models.ts); fetched once and kept by the browser's cache
const models = {
	'sam-encoder':	'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx',
	'sam-decoder':	'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx',
	'lama':			'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
	'esrgan':		'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx',
};

const text	= async name => { const r = await fetch(`../assets/${name}`); if (!r.ok) throw new Error(`${name}: ${r.status}`); return r.text(); };

let current = {name: 'image.png', type: 'image/png'};	// what the open file is called, for saving

// the browser decodes what it can (PNG, JPEG, GIF, WebP); the rest is read by @isopodlabs/binary_bitmaps
const native = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// the pixels as the page is given them
const toImage = result => ({width: result.width, height: result.height, data: result.pixels, channels: 4});
// what VS Code's messaging drops on the way to the page, and structured clone refuses
const withoutFunctions = o => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'function'));
const toBuffer = pixels => new Uint8Array(pixels).buffer;

async function decode(blob, ext) {
	if (native.has(ext)) {
		const bitmap = await createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
		const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', {willReadFrequently: true});
		ctx.drawImage(bitmap, 0, 0);
		const {width, height, data} = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		return {command: 'load2d', image: {width, height, data, channels: 4}};
	}

	const bitmaps	= await import('@isopodlabs/binary_bitmaps');
	const data		= new Uint8Array(await blob.arrayBuffer());
	const formats	= {'.bmp': bitmaps.BMP, '.dds': bitmaps.DDS, '.psd': bitmaps.PSD, '.tga': bitmaps.TGA, '.tif': bitmaps.TIFF, '.tiff': bitmaps.TIFF};
	const format	= formats[ext];
	if (!format)
		throw new Error(`Unsupported file type: ${ext}`);
	const image		= await format.load(data);
	let layers;

	if (ext === '.psd') {
		// layers can be edited and put back if they are plain 8-bit RGB
		const count = image.psd.layerAndMaskInfo?.layerInfo?.layers.length ?? 0;
		if (count && image.psd.depth === 8 && image.psd.colorMode === 'RGB') {
			layers = [];
			for (let i = 0, layer; (layer = image.getLayer(i)); i++) {
				const {name, left, top, opacity, visible, blendMode, clipped, blocks} = layer;
				layers.push({
					name, left, top, opacity, visible, blend: blendMode, clipped, blocks,
					width: layer.width, height: layer.height,
					data: toBuffer((await layer.getPixels({plane: 'RGBA'})).pixels),
					mask: layer.mask && withoutFunctions({...layer.mask, data: toBuffer(await layer.mask.getPixels())}),
					vectorMaskDensity: layer.vectorMaskDensity, vectorMaskFeather: layer.vectorMaskFeather,
				});
			}
		}
	}

	const result = await image.getPixels({plane: 'RGBA'});
	switch (image.type) {
		case 'cube':		return {command: 'loadCube', image: toImage(result)};
		case '3d':			return {command: 'load3d', image: toImage(result), depth: image.depth};
		case '2d-array':	return {command: 'load2dArray', image: toImage(result), layers: image.depth};
		default:			return {command: 'load2d', image: toImage(result), layers};
	}
}

async function open(blob, name = 'image') {
	current = {name, type: blob.type || 'image/png'};
	try {
		send(await decode(blob, name.slice(name.lastIndexOf('.')).toLowerCase()));
		welcome.remove();
	} catch (error) {
		console.error(error);
		welcome.message(`${name}: ${error.message ?? error}`);
	}
}

// what is shown until a file is open
const welcome = openers('Drop an image here, paste one, or', 'Open image…', 'image/*', file => open(file, file.name), file => file.type.startsWith('image/'));

// The fonts of this machine, which Chromium lets a page list (once the user allows it); other browsers have none
let fontList;
const localFonts = async () => fontList ??= await window.queryLocalFonts?.().catch(() => []) ?? [];
const fontCache = new Map();

async function loadFont(data) {
	let font = fontCache.get(data.postscriptName);
	if (!font) {
		const {load, Font} = await import('@isopodlabs/binary_fonts');
		const result = await load(new Uint8Array(await (await data.blob()).arrayBuffer()));
		// a collection: the face of this name
		font = result instanceof Font ? result : result?.fonts.find(f => `${f.name?.get(6)}`.replace(/\0/g, '') === data.postscriptName) ?? result?.fonts[0];
		fontCache.set(data.postscriptName, font);
	}
	return font;
}

// The outlines of runs of text as contours of cubics (as glyphOutlines in src/fonts.ts)
async function glyphOutlines(runs) {
	const {curveVertex, parseCurve, mapCurve, ON_BEGIN, ON_CURVE, OFF_BEZ3} = await import('@isopodlabs/binary_fonts');
	const {float2} = await import('@isopodlabs/maths/vector');
	const fonts		= await localFonts();
	const slanted	= f => /italic|oblique/i.test(f.style);
	const weighty	= f => /bold|black|heavy/i.test(f.style) && !/semi|demi/i.test(f.style);
	const curve		= [];
	let missing		= 0;

	for (const run of runs) {
		const family	= fonts.filter(f => f.family.toLowerCase() === run.family.toLowerCase());
		const data		= fonts.find(f => f.postscriptName === run.font)
			?? family.find(f => weighty(f) === run.bold && slanted(f) === run.italic)
			?? family.find(f => /^(regular|book)$/i.test(f.style))
			?? family[0];
		const font		= data && await loadFont(data), mapping = font?.getGlyphMapping();
		if (!font || !mapping) {
			missing += run.chars.filter(c => c.ch.trim()).length;
			continue;
		}
		const scale = run.size / (font.head?.units_per_em || 1000);
		for (const {ch, x} of run.chars) {
			if (!ch.trim())
				continue;
			try {
				const gid	= mapping[ch.codePointAt(0)] || 0;
				// (as cubics only: a quadratic is the cubic with the controls two thirds of the way to its own)
				const put	= (p, flags) => curve.push(curveVertex(p.x, p.y, flags));
				parseCurve(mapCurve(font.getGlyphCurves(gid), p => float2(run.x + x + p.x * scale * run.hscale, run.y - p.y * scale * run.vscale))).run({
					Begin:	a => put(a, ON_BEGIN),
					Line:	(_a, b) => put(b, ON_CURVE),
					Bezier2: (a, b, c) => { put(a.add(b.sub(a).scale(2 / 3)), OFF_BEZ3); put(c.add(b.sub(c).scale(2 / 3)), OFF_BEZ3); put(c, ON_CURVE); },
					Bezier3: (_a, b, c, d) => { put(b, OFF_BEZ3); put(c, OFF_BEZ3); put(d, ON_CURVE); },
				});
			} catch {
				missing++;
			}
		}
	}
	return {curve, missing};
}

// the extension's side of the conversation
async function command(message) {
	switch (message.command) {
		case 'getShaders': {
			const [vert, frag] = shaders[message.type];
			return {vert: await text(vert), frag: await text(frag)};
		}
		case 'model': {
			const r = await fetch(models[message.name]);
			if (!r.ok)
				throw new Error(`${message.name}: ${r.status}`);
			return r.arrayBuffer();
		}
		case 'installedFonts':
			return (await localFonts()).flatMap(f => f.postscriptName ? [{family: f.family, style: f.style, postscript: f.postscriptName}] : []);
		case 'glyphOutlines':
			return glyphOutlines(message.runs);
		case 'ready': {
			const src = new URLSearchParams(location.search).get('src');
			if (src)
				open(await (await fetch(src)).blob(), src.split('/').pop());
			else if (location.search.includes('handoff')) {
				const file = await takeHandoff();
				if (file)
					open(file, file.name);
			}
			break;
		}
		case 'error':
			alert(message.message);
			break;
		case 'edited':
			break;
		case 'saveSvg':
			download(new Blob([message.text], {type: 'image/svg+xml'}), current.name.replace(/\.\w+$/, '') + '.svg');
			break;
		default:
			throw new Error(`'${message.command}' is not available on the web yet`);
	}
}

// An image as @isopodlabs/binary_bitmaps writes it, from the raw pixels (and layers) the page gives (as RawImage2 in BitmapViewer.tsx)
function rawImage(bitmaps, raw) {
	const image = new bitmaps.LayerImage(raw.type ?? '2d', raw.width, raw.height, {
		RGBA: {width: raw.width, height: raw.height, getPixels: async () => new Uint8Array(raw.data)},
	});
	const layers = raw.layers?.map(l => {
		const layer = rawImage(bitmaps, l);
		Object.assign(layer, {name: l.name, left: l.left, top: l.top, opacity: l.opacity, visible: l.visible, blendMode: l.blend, clipped: l.clipped, blocks: l.blocks, vectorMaskDensity: l.vectorMaskDensity, vectorMaskFeather: l.vectorMaskFeather});
		if (l.mask) {
			const {data, ...mask} = l.mask;
			layer.mask = {...mask, getPixels: async () => new Uint8Array(data)};
		}
		return layer;
	});
	image.getLayer = i => typeof i === 'number' ? layers?.[i] : undefined;
	if (!image.depth && layers)
		image.depth = layers.length;
	return image;
}

// how an edited image is written, by file extension: a type the page's canvas can encode, or its raw pixels for the package to
const saveFormats = {
	'.png': {type: 'image/png'},	'.jpg': {type: 'image/jpeg'},	'.jpeg': {type: 'image/jpeg'},
	'.bmp': {format: 'BMP'},		'.gif': {format: 'GIF'},		'.dds': {format: 'DDS'},	'.psd': {format: 'PSD'},
	'.tga': {format: 'TGA'},		'.tif': {format: 'TIFF'},		'.tiff': {format: 'TIFF'},	'.webp': {format: 'WebP'},
};
const extensionOf = name => name.slice(name.lastIndexOf('.')).toLowerCase();

// save the image, in the format of the file it came from (or PNG if that can't be written)
window.save = async (ext = extensionOf(current.name)) => {
	const how = saveFormats[ext] ?? saveFormats['.png'];
	const name = current.name.replace(/\.\w+$/, '') + (saveFormats[ext] ? ext : '.png');
	if (how.type) {
		const data = await request({command: 'getTexture', type: how.type});
		if (data)
			download(new Blob([data], {type: how.type}), name);
	} else {
		const bitmaps	= await import('@isopodlabs/binary_bitmaps');
		const raw		= await request({command: 'getTexture', type: 'image/x-rgba'});
		if (raw)
			download(new Blob([await bitmaps[how.format].save(rawImage(bitmaps, raw), bitmaps.Yielder())]), name);
	}
};
addEventListener('keydown', e => {
	if ((e.metaKey || e.ctrlKey) && e.key === 's') {
		e.preventDefault();
		window.save().catch(error => console.error(error));
	}
});

installHost(command);

await import('../out/webview/bitmap.js');
