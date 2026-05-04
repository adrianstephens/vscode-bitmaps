import * as path from 'path';
import * as vscode from 'vscode';
import * as bitmap from '@isopodlabs/binary_bitmaps';
import * as webview from "@isopodlabs/vscode_utils/webview";
import { JSX, CSP, CSPdefault, ImportMap, Nonce } from '@isopodlabs/vscode_utils/jsx-runtime';
import type { MessageIn, MessageOut, MessageRpc, shaderType } from "../webview/bitmap"

class BitmapDocument implements vscode.CustomDocument {
	public fileWatcher: vscode.FileSystemWatcher | undefined;
	constructor(public readonly uri: vscode.Uri, public data: Uint8Array) {}
	dispose(): void {
		this.fileWatcher?.dispose();
	}
	ext() {
		return path.posix.extname(this.uri.path).toLowerCase();
	}
	mimetype() {
		const ext = this.ext();
		return ext === '.png' ? 'image/png' :
			ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
			ext === '.bmp' ? 'image/bmp' :
			ext === '.gif' ? 'image/gif' :
			undefined;
	}
}

interface ShaderSource {
	vert: string;
	frag: string;
}
const shaders: Record<shaderType, ShaderSource> = {
	'bg':  		{ vert: 'bitmap.vert',  frag: 'background.frag'},
	'2d':  		{ vert: 'bitmap.vert',  frag: 'bitmap.frag'    },
	'array2d':	{ vert: 'bitmap.vert',  frag: 'array2d.frag'   },
	'cube':		{ vert: 'cube.vert',	frag: 'cube.frag'   	},
	'cube2d':	{ vert: 'bitmap.vert',	frag: 'cube2d.frag'   },
	'3d':  		{ vert: 'volume.vert',  frag: 'volume.frag'    },
	'3d2d':  	{ vert: 'bitmap.vert',  frag: 'volume2d.frag'    },
};

class BitmapViewer extends webview.Panel<MessageOut, MessageIn, MessageRpc> {
	webviewUri: (name: string) => vscode.Uri;
	assetPath: vscode.Uri;

	constructor(
		public webviewPanel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		public document: BitmapDocument
	) {
		super(webviewPanel);
		this.assetPath = vscode.Uri.joinPath(extensionUri, 'assets');

		const webview = webviewPanel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [extensionUri],
		};

		this.webviewUri = (name: string) => {
			return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, name));
		}

		const nonce = Nonce();

		webviewPanel.webview.html = '<!DOCTYPE html>' + JSX.render(
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<CSP
						csp={[CSPdefault(extensionUri), CSP.self, CSP.unsafe_inline]}
						script={nonce}
						img={[CSPdefault(extensionUri), CSP.self, vscode.Uri.parse('data:')]}
					/>
					<ImportMap nonce={nonce} webview={webview} map={{
						"@isopodlabs/vscode_utils/webview/": vscode.Uri.joinPath(extensionUri, 'node_modules/@isopodlabs/vscode_utils/dist/webview/'),
					}} />
					<link rel="stylesheet" type="text/css" href={this.webviewUri('node_modules/@isopodlabs/vscode_utils/assets/shared.css')}/>
					<link rel="stylesheet" type="text/css" href={this.webviewUri('assets/bitmap.css')}/>

					<title>Bitmap Viewer</title>
				</head>
				<body>
					<canvas id="viewport" />
					<div id="layer-control" class="hidden">
						<input id="layer-slider" type="range" min="0" max="0" value="0" />
						<span id="layer-label">0 / 0</span>
					</div>
					<script type="module" nonce={nonce} src={this.webviewUri('out/webview/bitmap.js')} />
				</body>
			</html>
		);
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'getShaders': {
				const loadAsset = async (name: string) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.assetPath, name)).then(data => new TextDecoder('utf-8').decode(data));
				return {
					vert: await loadAsset(shaders[message.type].vert),
					frag: await loadAsset(shaders[message.type].frag),
				}
			}

			case 'ready':
				this.loadImage();
				break;

			case 'error':
				vscode.window.showErrorMessage(message.message);
				break;
		}
	}
	async loadImage() {
		try {
			const data		= this.document.data;
			const mimeType	= this.document.mimetype();

			/*if (mimeType) {
				this.postMessage({ command: 'loadTexture',
					data: data.buffer as ArrayBuffer,
					mimeType: mimeType,
				});
				return;
			}*/

			let image: bitmap.Image;
			switch (this.document.ext()) {
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
					//const layer = psd.getLayer(0);
					image = psd;//layer ?? psd;
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
					throw new Error(`Unsupported file type: ${this.document.ext()}`);
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
						image: result
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
	private active: BitmapViewer | undefined;
	private _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BitmapDocument>>();

	get onDidChangeCustomDocument() {
		return this._onDidChangeCustomDocument.event;
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('bitmap.viewer', this, { webviewOptions: { retainContextWhenHidden: true } }),
			vscode.commands.registerCommand('bitmap.fit', () => this.active?.postMessage({command: 'fitToWindow'})),
			vscode.commands.registerCommand('bitmap.reset', () => this.active?.postMessage({command: 'resetZoom'})),
		);
	}

	private setActive(editor: BitmapViewer) {
		this.active = editor;
	}
	private getEditor(document: BitmapDocument) {
		for (const editor of this.editors) {
			if (editor.document === document)
				return editor;
		}
	}

	private async reloadDocument(document: BitmapDocument) {
		try {
			document.data = await vscode.workspace.fs.readFile(document.uri);
			for (const editor of this.editors) {
				if (editor.document === document)
					editor.loadImage();
			}
		} catch (error) {
			console.error('Failed to reload bitmap document', error);
		}
	}

	async saveCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		const ed = this.getEditor(document);
		if (ed) {
			const result = await ed.RPC({ command: 'getTexture', type: 'image/png' });
			console.log('Got texture data from webview', result);
			const bytes = new Uint8Array(result);
			await vscode.workspace.fs.writeFile(document.uri, bytes);
		}
	}
	async saveCustomDocumentAs(document: BitmapDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken) {
		const ed = this.getEditor(document);
		if (ed) {
			const result = await ed.RPC({ command: 'getTexture', type: 'image/png' });
			if (result) {
				console.log('Got texture data from webview', result);
				const bytes = new Uint8Array(result);
				await vscode.workspace.fs.writeFile(destination, bytes);
			} else {
				console.log('getTexture failed');
			}
		}
	}
	async revertCustomDocument(document: BitmapDocument, cancellation: vscode.CancellationToken) {
		this.reloadDocument(document);
	}

	async backupCustomDocument(document: BitmapDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken) {
		this.saveCustomDocumentAs(document, context.destination, cancellation);
		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {}
			}
		}
	}

	async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		//first check backup location for unsaved changes
		const backupUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'backups', uri.toString().replace(/[:\/\\]/g, '_'));
		try {
			const bytes = await vscode.workspace.fs.readFile(backupUri);
			return new BitmapDocument(uri, bytes);
		} catch {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new BitmapDocument(uri, bytes);
		}
	}

	async resolveCustomEditor(document: BitmapDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		const editor = new BitmapViewer(webviewPanel, this.context.extensionUri, document);
		this.editors.add(editor);
		this.setActive(editor);

		webviewPanel.onDidDispose(() => {
			this.editors.delete(editor);
		});

		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				this.setActive(editor);
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
