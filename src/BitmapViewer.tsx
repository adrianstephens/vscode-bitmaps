import * as path from 'path';
import * as vscode from 'vscode';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import * as webview from "@isopodlabs/vscode_utils/webview";
import { JSX, CSP, CSPdefault, ImportMap, Nonce } from '@isopodlabs/vscode_utils/jsx-runtime';
import type { MessageIn, MessageOut, MessageRpc, RawImage, LayerData, shaderType } from "../webview/bitmap"
import { setActiveViewer, readShader } from './extension';


class RawImage2 extends bitmap.LayerImage {
	private layers: RawImage2[] | undefined;

	constructor(raw: RawImage) {
		super('2d', raw.width, raw.height, {
			RGBA: {
				width:	raw.width,
				height: raw.height,
				getPixels: async (options) => new Uint8Array(raw.pixels),
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
			if (l.mask) {
				const {pixels, ...mask} = l.mask;
				layer.mask = {...mask, getPixels: async () => new Uint8Array(pixels)};
			}
			return layer;
		});
	}

	getLayer(layer: string | number) {
		return typeof layer === 'number' ? this.layers?.[layer] : undefined;
	}
}

// How an edited image is written, by file extension: a type the webview's canvas can encode, or its raw pixels for us to encode here
interface SaveFormat {
	type:		string;
	encode?:	(image: RawImage) => Promise<Uint8Array>;
}
const extension = (uri: {path: string}) => path.posix.extname(uri.path).toLowerCase();
function savefromRaw<T extends {save: (image: bitmap.Image) => Promise<Uint8Array>}>(type: T): SaveFormat {
	return {type: 'image/x-rgba', encode: image => type.save(new RawImage2(image))};
}
const saveFormats: Record<string, SaveFormat> = {
	'.png':		{type: 'image/png'},
	'.jpg':		{type: 'image/jpeg'},
	'.jpeg':	{type: 'image/jpeg'},
	'.bmp':		savefromRaw(bitmap.BMP),
	'.gif':		savefromRaw(bitmap.GIF),
//	'.dds':		savefromRaw(bitmap.DDS),
	'.psd':		savefromRaw(bitmap.PSD),
	'.tga':		savefromRaw(bitmap.TGA),
	'.tif':		savefromRaw(bitmap.TIFF),
	'.tiff':	savefromRaw(bitmap.TIFF),
};

class BitmapDocument implements vscode.CustomDocument {
	public fileWatcher: vscode.FileSystemWatcher | undefined;
	// a PSD whose layers can't be edited (they are not 8-bit RGB) is shown flat, and must not be saved over as if it were
	public layersNotEditable = false;
	constructor(public readonly uri: vscode.Uri, public data: Uint8Array) {}
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
};

// the page of a webview: the shared styles, an import map for the utilities, the body and the script which runs it
export function webviewPage(webviewPanel: vscode.WebviewPanel, assets: webview.Assets, uri: (name: string) => vscode.Uri, script: string, title: string, body: JSX.Element[], bodyClass?: string, stylesheets: string[] = []) {
	const nonce = Nonce();
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
				}} />
				<link rel="stylesheet" type="text/css" href={uri('node_modules/@isopodlabs/vscode_utils/assets/shared.css')}/>
				{stylesheets.map(name => <link rel="stylesheet" type="text/css" href={uri(name)}/>)}
				<link rel="stylesheet" type="text/css" href={uri('assets/bitmap.css')}/>

				<title>{title}</title>
			</head>
			<body class={bodyClass}>
				{body}
				<script type="module" nonce={nonce} src={uri(script)} />
			</body>
		</html>
	);
}

// the webview which displays an image; subclasses decide what to show in it
export abstract class ViewerPanel extends webview.Panel<MessageOut, MessageIn, MessageRpc> {

	constructor(webviewPanel: vscode.WebviewPanel, assets: webview.Assets) {
		super(webviewPanel, assets);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: assets.localRoots(),
		};

		webviewPanel.webview.html = webviewPage(webviewPanel, assets, name => this.webviewUri(name), 'out/webview/bitmap.js', 'Bitmap Viewer', [
			<div id="bitmap-root">
				<div id="bitmap-main">
					<div id="paint-options" class="hidden" />
					<div id="bitmap-stage">
						<canvas id="viewport" />
						<canvas id="overlay" class="hidden" />
						<div id="layer-control" class="hidden">
							<input id="layer-slider" type="range" min="0" max="0" value="0" />
							<span id="layer-label">0 / 0</span>
						</div>
					</div>
				</div>
			</div>,
		]);
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'getShaders': {
				return {
					vert: await readShader(this.localUri('assets/' + shaders[message.type].vert)),
					frag: await readShader(this.localUri('assets/' + shaders[message.type].frag)),
				};
			}

			case 'ready':
				this.loadImage();
				break;

			case 'edited':
				this.edited(message.label);
				break;

			case 'error':
				vscode.window.showErrorMessage(message.message);
				break;
		}
	}
	abstract loadImage(): Promise<void>;
	edited(label: string) {}
}

class BitmapViewer extends ViewerPanel {
	constructor(
		webviewPanel: vscode.WebviewPanel,
		assets: webview.Assets,
		public document: BitmapDocument,
		private onEdited: (label: string) => void,
	) {
		super(webviewPanel, assets);
	}

	edited(label: string) {
		this.onEdited(label);
	}

	async loadImage() {
		try {
			const data		= this.document.data;
			let image: bitmap.Image;
			let layers: LayerData[] | undefined;

			// a backup of unsaved edits is a PNG whatever the file is called
			const ext = bitmap.PNG.check(data) ? '.png' : path.posix.extname(this.document.uri.path).toLowerCase();
			switch (ext) {
				case '.bmp':
					image = bitmap.BMP.load(data);
					break;

				case '.png':
					image = await bitmap.PNG.load(data);
					break;

				case '.jpg':
				case '.jpeg':
					image = bitmap.JPEG.load(data);
					break;

				case '.gif':
					image = bitmap.GIF.load(data);
					break;

				case '.dds':
					image = bitmap.DDS.load(data);
					break;

				case '.psd': {
					const psd = await bitmap.PSD.load(data);
					// layers can be edited and put back if they are plain 8-bit RGB
					const count = psd.psd.layerAndMaskInfo?.layerInfo?.layers.length ?? 0;
					const editable = psd.psd.depth === 8 && psd.psd.colorMode === 'RGB';
					this.document.layersNotEditable = count > 0 && !editable;
					if (count && editable) {
						layers = [];
						for (let i = 0, layer: bitmap.LayerImage | undefined; (layer = psd.getLayer(i)); i++) {
							const {name, left, top, opacity, visible, blendMode, clipped} = layer;
							layers.push({
								name: name!, left: left!, top: top!, opacity: opacity!, visible: visible!, blend: blendMode!, clipped,
								width: layer.width, height: layer.height,
								pixels: (await layer.getPixels({plane: 'RGBA'})).pixels,
								mask: layer.mask && {...layer.mask, pixels: await layer.mask.getPixels()},
							});
						}
					}
					image = psd;
					break;
				}
				case '.tga':
					image = bitmap.TGA.load(data);
					break;

				case '.tif':
				case '.tiff':
					image = bitmap.TIFF.load(data);
					break;

				default:
					throw new Error(`Unsupported file type: ${ext}`);
			}

			switch (image.type) {
				case 'cube': {
//					const faces = await Promise.all(Array.from({length: 6}, async (_, i) => image.getPixels({ planes: 'RGBA', layer: i })));
					const result = await image.getPixels({ plane: 'RGBA' });
					this.postMessage({
						command: 'loadCube',
						image: result
					});
					break;
				}
				case '2d': {
					const result = await image.getPixels({ plane: 'RGBA' });
//					const result = await image.getPixels({ plane: 'R' });
					this.postMessage({
						command: 'load2d',
						image: result,
						layers,
					});
					break;
				}
				case '3d': {
					const result = await image.getPixels({ plane: 'RGBA' });
					const depth = image.depth!;
					this.postMessage({
						command: 'load3d',
						image: result,
						depth,
					});
					break;
				}
				case '2d-array': {
					const result = await image.getPixels({ plane: 'RGBA' });
					this.postMessage({
						command: 'load2dArray',
						image: result,
						layers: image.depth!,
					});
					break;
				}
			}
		} catch (error: any) {
			vscode.window.showErrorMessage(error.message);
		}

	}
}

export class BitmapViewerProvider implements vscode.CustomEditorProvider {
	private readonly editors = new Set<BitmapViewer>();
	private readonly assets: webview.Assets;
	private _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BitmapDocument>>();

	get onDidChangeCustomDocument() {
		return this._onDidChangeCustomDocument.event;
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		this.assets = new webview.Assets(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('bitmap.viewer', this, { webviewOptions: { retainContextWhenHidden: true } }),
		);
	}

	private getEditor(document: BitmapDocument) {
		for (const editor of this.editors) {
			if (editor.document === document)
				return editor;
		}
	}

	private async reloadDocument(document: BitmapDocument, force = false) {
		try {
			const data = await vscode.workspace.fs.readFile(document.uri);
			// our own save comes back through the file watcher: it is not a change, and reloading would lose the undo history
			if (!force && data.length === document.data.length && data.every((b, i) => b === document.data[i]))
				return;
			document.data = data;
			for (const editor of this.editors) {
				if (editor.document === document)
					editor.loadImage();
			}
		} catch (error) {
			console.error('Failed to reload bitmap document', error);
		}
	}

	// the image as the webview has it, encoded as a file
	private async encode(document: BitmapDocument, format: SaveFormat) {
		const ed = this.getEditor(document);
		const result = ed && await ed.RPC({ command: 'getTexture', type: format.type });
		if (!result)
			throw new Error('The image could not be read back from the editor.');
		if ('pixels' in result)
			return format.encode!(result);
		return new Uint8Array(result);
	}

	private async write(document: BitmapDocument, destination: vscode.Uri) {
		const format = saveFormats[extension(destination)];
		if (!format)
			throw new Error(`Bitmap Explorer can't save ${extension(destination) || 'this'} files; use Save As to choose another type.`);
		if (extension(destination) === '.psd' && document.layersNotEditable)
			throw new Error('The layers of this PSD cannot be edited (only 8-bit RGB layers can), so saving would flatten it; use Save As to write it under another name.');
		const bytes = await this.encode(document, format);
		await vscode.workspace.fs.writeFile(destination, bytes);
		return bytes;
	}

	async saveCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		document.data = await this.write(document, document.uri);
	}

	async saveCustomDocumentAs(document: BitmapDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken) {
		await this.write(document, destination);
	}

	async revertCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		await this.reloadDocument(document, true);
	}

	async backupCustomDocument(document: BitmapDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken) {
		// a PNG whatever the file's own format is, so that the format need not be one that can be written; but not for
		// layers, which a PNG would flatten
		const layered = extension(document.uri) === '.psd' && !document.layersNotEditable;
		await vscode.workspace.fs.writeFile(context.destination, await this.encode(document, saveFormats[layered ? '.psd' : '.png']));
		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {}
			}
		}
	}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<vscode.CustomDocument> {
		// unsaved changes, if VS Code is restoring them
		if (openContext.backupId) {
			try {
				return new BitmapDocument(uri, await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId)));
			} catch {}
		}
		return new BitmapDocument(uri, await vscode.workspace.fs.readFile(uri));
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

		if (!document.fileWatcher) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath)));
			watcher.onDidChange(() => this.reloadDocument(document));
			watcher.onDidCreate(() => this.reloadDocument(document));
			watcher.onDidDelete(() => {
				// If the file is deleted externally, keep the current view until reload or close.
			});
			document.fileWatcher = watcher;
		}
	}
}
