import * as path from 'path';
import * as vscode from 'vscode';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import * as webview from "@isopodlabs/vscode_utils/webview";
import { JSX, CSP, CSPdefault, ImportMap, Nonce } from '@isopodlabs/vscode_utils/jsx-runtime';
import type { MessageIn, MessageOut, MessageRpc, RawImage, LayerData, shaderType } from "../webview/bitmap"
import { setActiveViewer, readShader } from './extension';
import { SCHEME, embedded } from './embedded';
import { installedFonts, glyphOutlines } from './fonts';
import { openSvg } from './SvgViewer';
// The neural network weights the editor's AI tools run, which are too large to ship in the extension: fetched the first
// time one is needed (after asking), checked against a hash, and kept in the extension's global storage.
import * as crypto from 'crypto';


class RawImage2 extends bitmap.LayerImage {
	blocks?: bitmap.psd.LayerBlocks;
	private layers: RawImage2[] | undefined;

	constructor(raw: RawImage) {
		super(raw.type ?? '2d', raw.width, raw.height, {
			RGBA: {
				width:	raw.width,
				height: raw.height,
				getPixels: async (options) => new Uint8Array(raw.data),
			}
		});
		this.layers = raw.layers?.map(l => {
			const layer = new RawImage2(l);
			layer.name		= l.name;
			layer.left		= l.left;
			layer.top		= l.top;
			layer.opacity	= l.opacity;
			layer.visible	= l.visible;
			layer.blendMode	= l.blend;
			layer.clipped	= l.clipped;
			layer.blocks	= l.blocks;
			layer.vectorMaskDensity = l.vectorMaskDensity;
			layer.vectorMaskFeather = l.vectorMaskFeather;
			if (l.mask) {
				const {data, ...mask} = l.mask;
				layer.mask = {...mask, getPixels: async () => new Uint8Array(data)};
			}
			return layer;
		});
		if (!this.depth && raw.layers)
			this.depth = raw.layers.length;
	}

	getLayer(layer: string | number) {
		return typeof layer === 'number' ? this.layers?.[layer] : undefined;
	}
}

// How an edited image is written, by file extension: a type the webview's canvas can encode, or its raw pixels for us to encode here
interface SaveFormat {
	type:		string;
	encode?:	(image: RawImage, yielder: bitmap.Yielder) => Promise<Uint8Array>;
}
const extension = (uri: {path: string}) => path.posix.extname(uri.path).toLowerCase();
function savefromRaw<T extends {save: (image: bitmap.Image, yielder: bitmap.Yielder) => Promise<Uint8Array>}>(type: T): SaveFormat {
	return {type: 'image/x-rgba', encode: (image, yielder) => type.save(new RawImage2(image), yielder)};
}
const saveFormats: Record<string, SaveFormat> = {
	'.png':		{type: 'image/png'},
	'.jpg':		{type: 'image/jpeg'},
	'.jpeg':	{type: 'image/jpeg'},
	'.bmp':		savefromRaw(bitmap.BMP),
	'.gif':		savefromRaw(bitmap.GIF),
	'.dds':		savefromRaw(bitmap.DDS),
	'.psd':		savefromRaw(bitmap.PSD),
	'.tga':		savefromRaw(bitmap.TGA),
	'.tif':		savefromRaw(bitmap.TIFF),
	'.tiff':	savefromRaw(bitmap.TIFF),
	'.webp':	savefromRaw(bitmap.WebP),
};

let untitledCount = 0;

export async function newBitmap() {
	const text = await vscode.window.showInputBox({prompt: 'Size of the new bitmap', value: '512x512', validateInput: s => parseSize(s) ? undefined : 'Width and height in pixels, like 512x512'});
	const size = text && parseSize(text);
	if (size) {
		const [width, height] = size;
		await BitmapViewerProvider.open(`Untitled-${++untitledCount}.png`, new RawImage2({width, height, data: new Uint8Array(width * height * 4).fill(255).buffer}));
	}
}
export function parseSize(text: string): [number, number] | undefined {
	const m = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/.exec(text);
	if (m && +m[1] > 0 && +m[2] > 0 && +m[1] <= 16384 && +m[2] <= 16384)
		return [+m[1], +m[2]];
}

const toBuffer = (data: bitmap.Result['pixels']) => new Uint8Array(data).buffer;

class BitmapDocument implements vscode.CustomDocument {
	public fileWatcher: vscode.Disposable | undefined;
	public image?: bitmap.Image;

	// not read from a file: there is no file until it is saved
	public announced = false;
	get untitled() { return this.uri.scheme === 'untitled'; }
	get ext() 		{ return path.extname(this.uri.fsPath).toLowerCase(); }

	// a PSD whose layers can't be edited (they are not 8-bit RGB) is shown flat, and must not be saved over as if it were
	public layersNotEditable = false;
	public layers: LayerData[] | undefined;

	// set while this writes the file, so that the watcher does not read back what was just written (which would lose the undo history)
	private writing = false;

	// onChange is called when the file is changed by something else
	constructor(public readonly uri: vscode.Uri, onChange: () => void) {
		const changed = () => !this.writing && onChange();
		if (uri.scheme === SCHEME) {
			this.fileWatcher = embedded.onChange(uri, changed);
		} else if (!this.untitled) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath)));
			watcher.onDidChange(changed);
			watcher.onDidCreate(changed);
			this.fileWatcher = watcher;
		}
	}

	init(image: bitmap.Image) {
		this.image = image;
	}

	async load(uri: vscode.Uri = this.uri, ext = this.ext) {
		const data = await vscode.workspace.fs.readFile(uri);
		// a backup of unsaved edits is a PNG, unless the format has more than a PNG can hold
		if (bitmap.PNG.check(data))
			ext = '.png';
		switch (ext) {
			case '.bmp':
				this.image = bitmap.BMP.load(data);
				break;

			case '.png':
				this.image = await bitmap.PNG.load(data);
				break;

			case '.jpg':
			case '.jpeg':
				this.image = bitmap.JPEG.load(data);
				break;

			case '.gif':
				this.image = bitmap.GIF.load(data);
				break;

			case '.dds':
				this.image = bitmap.DDS.load(data);
				break;

			case '.psd': {
				const psd = await bitmap.PSD.load(data);
				// layers can be edited and put back if they are plain 8-bit RGB
				const count = psd.psd.layerAndMaskInfo?.layerInfo?.layers.length ?? 0;
				const editable = psd.psd.depth === 8 && psd.psd.colorMode === 'RGB';
				this.layersNotEditable = count > 0 && !editable;
				if (count && editable) {
					this.layers = [];
					for (let i = 0, layer: bitmap.psd.PSDLayerImage | undefined; (layer = psd.getLayer(i)); i++) {
						const {name, left, top, opacity, visible, blendMode, clipped, blocks} = layer;
						this.layers.push({
							name: name!, left: left!, top: top!, opacity: opacity!, visible: visible!, blend: blendMode!, clipped, blocks,
							width: layer.width, height: layer.height,
							data: toBuffer((await layer.getPixels({plane: 'RGBA'})).pixels),
							mask: layer.mask && {...layer.mask, data: toBuffer(await layer.mask.getPixels())},
							vectorMaskDensity: layer.vectorMaskDensity, vectorMaskFeather: layer.vectorMaskFeather,
						});
					}
				}
				this.image = psd;
				break;
			}
			case '.tga':
				this.image = bitmap.TGA.load(data);
				break;

			case '.tif':
			case '.tiff':
				this.image = bitmap.TIFF.load(data);
				break;

			case '.webp':
				this.image = bitmap.WebP.load(data);
				break;

			default:
				throw new Error(`Unsupported file type: ${ext}`);
		}
	}

	// the image as the webview has it, encoded as a file
	async encode(format: SaveFormat, cancellation: vscode.CancellationToken) {
		const ed = BitmapViewerProvider.provider.getEditor(this);
		const result = ed && await ed.RPC({ command: 'getTexture', type: format.type });
		if (!result)
			throw new Error('The image could not be read back from the editor.');
		if ('data' in result)
			return format.encode!(result, bitmap.Yielder(15, ()=>cancellation.isCancellationRequested));
		return new Uint8Array(result);
	}

	async write(destination: vscode.Uri, cancellation: vscode.CancellationToken) {
		const format = saveFormats[extension(destination)];
		if (!format)
			throw new Error(`Bitmap Explorer can't save ${extension(destination) || 'this'} files; use Save As to choose another type.`);
		if (extension(destination) === '.psd' && this.layersNotEditable)
			throw new Error('The layers of this PSD cannot be edited (only 8-bit RGB layers can), so saving would flatten it; use Save As to write it under another name.');
		const bytes = await this.encode(format, cancellation);
		this.writing = true;
		try {
			await vscode.workspace.fs.writeFile(destination, bytes);
		} finally {
			// the watcher's event can come after the write returns
			setTimeout(() => this.writing = false, 500);
		}
		return bytes;
	}


	dispose(): void {
		this.fileWatcher?.dispose();
	}
}

interface ShaderSource {
	vert: string;
	frag: string;
}
const shaders: Record<shaderType, ShaderSource> = {
	'bg':		{ vert: 'bitmap.vert',	frag: 'background.frag'	},
	'2d':		{ vert: 'bitmap.vert',	frag: 'bitmap.frag'		},
	'array2d':	{ vert: 'bitmap.vert',	frag: 'array2d.frag'	},
	'cube':		{ vert: 'cube.vert',	frag: 'cube.frag'		},
	'cube2d':	{ vert: 'bitmap.vert',	frag: 'cube2d.frag'		},
	'3d':		{ vert: 'volume.vert',	frag: 'volume.frag'		},
	'3d2d':		{ vert: 'bitmap.vert',	frag: 'volume2d.frag'	},
	'layer':	{ vert: 'layer.vert',	frag: 'layer.frag'		},
	'composite':{ vert: 'bitmap.vert',	frag: 'composite.frag'	},
	'planes':	{ vert: 'planes.vert',	frag: 'planes.frag'		},
	'warp':		{ vert: 'bitmap.vert',	frag: 'warp.frag'		},
	'blur':		{ vert: 'bitmap.vert',	frag: 'blur.frag'		},
	'levels':	{ vert: 'bitmap.vert',	frag: 'levels.frag'		},
	'gradient':	{ vert: 'bitmap.vert',	frag: 'gradient.frag'	},
	'mix':		{ vert: 'bitmap.vert',	frag: 'mix.frag'		},
	'convolve':	{ vert: 'bitmap.vert',	frag: 'convolve.frag'	},
	'flatten':	{ vert: 'bitmap.vert',	frag: 'flatten.frag'	},
	'ink':		{ vert: 'bitmap.vert',	frag: 'ink.frag'		},
	'effect':	{ vert: 'bitmap.vert',	frag: 'effect.frag'		},
	'textwarp':	{ vert: 'textwarp.vert',	frag: 'textwarp.frag'	},
};

// the page of a webview: the shared styles, an import map for the utilities, the body and the script which runs it
export function webviewPage(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, uri: (name: string) => vscode.Uri, script: string, title: string, body: JSX.Element[], bodyClass?: string, stylesheets: string[] = []) {
	const nonce = Nonce();
	const config	= vscode.workspace.getConfiguration('bitmaps');
	const size		= Math.max(16, Math.min(96, config.get<number>('cascadeIconSize') ?? 32));
	const magnify	= Math.max(1, Math.min(3, config.get<number>('cascadeMagnify') ?? 1.6));
	return '<!DOCTYPE html>' + JSX.render(
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<CSP
					csp={[CSPdefault(assets.root), CSP.self, CSP.unsafe_inline]}
					script={nonce}
					img={[CSPdefault(assets.root), CSP.self, vscode.Uri.parse('data:')]}
				/>
				<ImportMap nonce={nonce} webview={webviewPanel.webview} map={{
					"@isopodlabs/vscode_utils/webview/": assets.uri('node_modules/@isopodlabs/vscode_utils/dist/webview/'),
					"@isopodlabs/maths/vector": assets.uri('node_modules/@isopodlabs/maths/esm/vector.js'),
					"@isopodlabs/maths/quaternion": assets.uri('node_modules/@isopodlabs/maths/esm/quaternion.js'),
					"@isopodlabs/maths/geometry": assets.uri('node_modules/@isopodlabs/maths/esm/geometry.js'),
					"@isopodlabs/maths/linear": assets.uri('node_modules/@isopodlabs/maths/esm/linear.js'),
					"@isopodlabs/binary": assets.uri('node_modules/@isopodlabs/binary/esm/index.js'),
					"@isopodlabs/binary_ml/browser": assets.uri('node_modules/@isopodlabs/binary_ml/esm/browser.js'),
					"@isopodlabs/xml": assets.uri('node_modules/@isopodlabs/xml/esm/xml.js'),
					"@isopodlabs/binary_fonts": assets.uri('node_modules/@isopodlabs/binary_fonts/esm/browser.js'),
					"@isopodlabs/binary_fonts/curves": assets.uri('node_modules/@isopodlabs/binary_fonts/esm/curves.js'),
				}} />
				<link rel="stylesheet" type="text/css" href={uri('node_modules/@isopodlabs/vscode_utils/assets/shared.css')}/>
				{stylesheets.map(name => <link rel="stylesheet" type="text/css" href={uri(name)}/>)}
				<link rel="stylesheet" type="text/css" href={uri('assets/bitmap.css')}/>
				<link rel="stylesheet" type="text/css" href={uri('assets/cascade.css')}/>

				<title>{title}</title>
			</head>
			<body class={bodyClass} style={`--cascade-size:${size}px;--cascade-scale:${size / 32};--cascade-magnify:${magnify}`}>
				{body}
				<script type="module" nonce={nonce} src={uri(script)} />
			</body>
		</html>
	);
}


const models: Record<string, {url: string, sha256: string}> = {
	'sam-encoder':			{url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx',										sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749'},
	'lama':					{url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',														sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'},
	'esrgan':				{url: 'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx',					sha256: '1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112'},
	'sam-decoder':			{url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx',										sha256: '93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d'},
	'style-mosaic':			{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/mosaic-9.onnx',			sha256: 'fa646dedade881243f8d5a2ceb7de2b93675b21fc24f7482894ac4851a9a0a47'},
	'style-candy':			{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/candy-9.onnx',			sha256: '9d11a3529d1e547da6ae07201d93484dbab2ec0a3614535752c8f40f0fe2968a'},
	'style-rain-princess':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/rain-princess-9.onnx',	sha256: '4162912e6f75fedef6f810ae989b9e10d3d5d43308dab34b027c850cf255e152'},
	'style-udnie':			{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/udnie-9.onnx',			sha256: '8656b6ce7dec8f22ee13c2d557d6b67bd6f550dde88d0f2e7c9972aeb765cc0d'},
	'style-pointilism':		{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/pointilism-9.onnx',		sha256: '5ee2b8d4d6bc60a777f54e0fe96a1b717360a004b79d56c67390d4a975b14d98'},
	// AdaIN, a style from any picture (github.com/naoto0804/pytorch-AdaIN, MIT): VGG-19 as its encoder, and its decoder, as PyTorch checkpoints
	'adain-vgg':			{url: 'https://github.com/naoto0804/pytorch-AdaIN/releases/download/v0.0.0/vgg_normalised.pth',									sha256: '804ca2835ecf7539f0cd2a7ac3c18ce81e6f8468969ae7117ac0c148d286bb4a'},
	'adain-decoder':		{url: 'https://github.com/naoto0804/pytorch-AdaIN/releases/download/v0.0.0/decoder.pth',										sha256: '379ca41d59f3a37eed3599bbbc2560c19da5c458870a5ffd3a9dd41aa88f9472'},
};

type ModelName = keyof typeof models;

let storage: vscode.Uri;
function setModelStorage(uri: vscode.Uri) {
	storage = uri;
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

export async function modelBytes(name: ModelName) {
	const {url, sha256: hash} = models[name];
	const file = vscode.Uri.joinPath(storage, 'models', url.slice(url.lastIndexOf('/') + 1));

	try {
		const data = await vscode.workspace.fs.readFile(file);
		if (sha256(data) === hash)
			return data;
	} catch {
		// not fetched yet
	}

	const host = new URL(url).host;
	if (await vscode.window.showInformationMessage(`This tool runs a neural network that is downloaded once from ${host} and kept on this machine.`, {modal: true}, 'Download') !== 'Download')
		throw new Error('The model was not downloaded.');

	return vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`}, async progress => {
		const response = await fetch(url);
		if (!response.ok || !response.body)
			throw new Error(`Downloading ${url} failed: ${response.status} ${response.statusText}`);

		// read as it comes, so that how much has come can be shown (as a share of all of it, where the server says how much that is)
		const total = Number(response.headers.get('content-length')) || 0, parts: Uint8Array[] = [], reader = response.body.getReader();
		const mb = (n: number) => (n / 2 ** 20).toFixed(1);
		let got = 0;
		for (;;) {
			const {done, value} = await reader.read();
			if (done)
				break;
			parts.push(value);
			got += value.length;
			progress.report(total ? {increment: value.length / total * 100, message: `${mb(got)} of ${mb(total)} MB`} : {message: `${mb(got)} MB`});
		}
		const data = new Uint8Array(got);
		parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
		if (sha256(data) !== hash)
			throw new Error(`${url} is not the file this extension expects.`);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, 'models'));
		await vscode.workspace.fs.writeFile(file, data);
		return data;
	});
}


class BitmapViewer extends webview.Panel<MessageOut, MessageIn, MessageRpc> {
	constructor(
		webviewPanel: vscode.WebviewPanel,
		assets: webview.Assets,
		public document: BitmapDocument,
		private onEdited: (label: string) => void,
	) {
		super(webviewPanel, assets);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: assets.localRoots(),
		};

		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/bitmap.js', 'Bitmap Viewer', [
			<div id="bitmap-root">
				<div id="bitmap-main">
					<div id="bitmap-stage">
						<canvas id="viewport" />
						<canvas id="overlay" class="hidden" />
						<canvas id="transform-overlay" class="hidden" />
					</div>
				</div>
			</div>,
		], undefined, ['assets/pathedit.css']);
	}

	edited(label: string) {
		this.onEdited(label);
	}

	// markup the page has made of the picture: written to a file of the user's choosing, and opened in the SVG editor
	async command(message: MessageOut) {
		switch (message.command) {
			case 'getShaders': {
				return {
					vert: await readShader(this.localUri('assets/' + shaders[message.type].vert)),
					frag: await readShader(this.localUri('assets/' + shaders[message.type].frag)),
				};
			}

			case 'installedFonts':
				return installedFonts();

			case 'model': {
				const data = await modelBytes(message.name);
				return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
			}

			case 'glyphOutlines':
				return glyphOutlines(message.runs);

			case 'ready':
				this.upload();
				break;

			case 'edited':
				this.edited(message.label);
				break;

			case 'error':
				vscode.window.showErrorMessage(message.message);
				break;
			case 'saveSvg': {
				// opened unsaved, so that Save As is what chooses the file
				const base = this.document.uri;
				await openSvg(path.posix.basename(base.path, path.posix.extname(base.path)) + '.svg', message.text);
				break;
			}
		}
	}

	async upload() {
		const toImage = (result: bitmap.Result): {width: number, height: number, data: Uint8ClampedArray<ArrayBuffer>, channels: 4} => ({width: result.width, height: result.height, data: result.pixels as Uint8ClampedArray<ArrayBuffer>, channels: 4});
		const image = this.document.image;

		switch (image?.type) {
			case 'cube': {
//				const faces = await Promise.all(Array.from({length: 6}, async (_, i) => image.getPixels({ planes: 'RGBA', layer: i })));
				const result = await image.getPixels({ plane: 'RGBA' });
				this.postMessage({
					command: 'loadCube',
					image: toImage(result)
				});
				break;
			}
			case '2d': {
				const result = await image.getPixels({ plane: 'RGBA' });
//				const result = await image.getPixels({ plane: 'R' });
				this.postMessage({
					command: 'load2d',
					image:	toImage(result),
					layers:	this.document.layers,
				});
				break;
			}
			case '3d': {
				const result = await image.getPixels({ plane: 'RGBA' });
				const depth = image.depth!;
				this.postMessage({
					command: 'load3d',
					image: toImage(result),
					depth,
				});
				break;
			}
			case '2d-array': {
				const result = await image.getPixels({ plane: 'RGBA' });
				this.postMessage({
					command: 'load2dArray',
					image: toImage(result),
					layers: image.depth!,
				});
				break;
			}
		}
	}
}

export class BitmapViewerProvider implements vscode.CustomEditorProvider {
	static provider: BitmapViewerProvider;
	private readonly assets: webview.Assets;
	private _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BitmapDocument>>();
	pending = new Map<string, bitmap.Image>();
	editors = new Set<BitmapViewer>();

	get onDidChangeCustomDocument() {
		return this._onDidChangeCustomDocument.event;
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		BitmapViewerProvider.provider = this;
		this.assets = new webview.Assets(context.extensionUri);
		setModelStorage(context.globalStorageUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('bitmap.viewer', this, { webviewOptions: { retainContextWhenHidden: true } }),
		);
	}

	private async reloadDocument(document: BitmapDocument) {
		try {
			await document.load();
			for (const editor of this.editors) {
				if (editor.document === document)
					editor.upload();
			}
		} catch (error) {
			console.error('Failed to reload bitmap document', error);
		}
	}

	async saveCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		await document.write(document.uri, cancellation);
	}

	async saveCustomDocumentAs(document: BitmapDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken) {
		await document.write(destination, cancellation);
	}

	async revertCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		await this.reloadDocument(document);
	}

	async backupCustomDocument(document: BitmapDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken) {
		// a PNG whatever the file's own format is, so that the format need not be one that can be written; but not for
		// layers, which a PNG would flatten, nor for a cubemap, which a PNG would turn into a tall picture of its faces
		const ext = extension(document.uri);
		const own = saveFormats[ext];
		let format = saveFormats['.png'];
		if (own?.encode) {
			const raw = this.getEditor(document) && await this.getEditor(document)!.RPC({ command: 'getTexture', type: own.type });
			const structured = raw && 'data' in raw && (raw.type === 'cube' || (raw.layers && ext !== '.psd'));
			if (ext === '.psd' ? !document.layersNotEditable : structured)
				format = own;
		}
		await vscode.workspace.fs.writeFile(context.destination, await document.encode(format, cancellation));
		return {
			id: context.destination.toString(),
			delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} }
		}
	}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<vscode.CustomDocument> {
		const doc = new BitmapDocument(uri, () => this.reloadDocument(doc));

		// unsaved changes come first, if VS Code is restoring them (an untitled picture has nothing else after a restart)
		if (openContext.backupId) {
			await doc.load(vscode.Uri.parse(openContext.backupId));
		} else if (uri.scheme === 'untitled') {
			const image = this.pending.get(uri.toString());
			this.pending.delete(uri.toString());
			if (image)
				doc.init(image);
		} else {
			await doc.load(uri);
		}
		return doc;
	}

	async resolveCustomEditor(document: BitmapDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		const editor: BitmapViewer = new BitmapViewer(webviewPanel, this.assets, document, label => this._onDidChangeCustomDocument.fire({
			document,
			label,
			undo: () => { editor.postMessage({ command: 'undo' }); },
			redo: () => { editor.postMessage({ command: 'redo' }); },
		}));
		this.editors.add(editor);
		setActiveViewer(editor);

		webviewPanel.onDidDispose(() => {
			this.editors.delete(editor);
		});

		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				setActiveViewer(editor);
		});
	}

	getEditor(document: BitmapDocument) {
		for (const editor of this.editors) {
			if (editor.document === document)
				return editor;
		}
	}
	getEditorFor(uri: vscode.Uri) {
		const key = uri.toString();
		for (const editor of this.editors) {
			if (editor.document.uri.toString() === key)
				return editor;
		}
	}

	static async open(name: string, image: bitmap.Image) {
		const provider = this.provider;
		const uri = vscode.Uri.from({scheme: 'untitled', path: '/'+ name}), key = uri.toString();
		// already open from an earlier run: it shows the new one
		const open = provider.getEditorFor(uri);
		if (open) {
			open.document.init(image);
			await open.upload();
		} else {
			provider.pending.set(key, image);
		}
		await vscode.commands.executeCommand('vscode.openWith', uri, 'bitmap.viewer', {viewColumn: vscode.ViewColumn.Beside, preview: false});
		provider.getEditorFor(uri)?.edited('New');
	}

}
