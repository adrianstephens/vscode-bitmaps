import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BitmapViewerProvider } from './BitmapViewer';
import { GgufViewerProvider } from './GgufViewer';
import { ScadViewerProvider, exportStl } from './ScadViewer';
import { MeshViewerProvider } from './MeshViewer';
import { FontViewerProvider } from './FontViewer';
import type { MessageIn, EditOp, LayerOp } from '../webview/bitmap';

// `use`/`include` read through the file system, as OpenSCAD's own lexer does. A path that is not there relative to
// the including file falls back to each directory in scad.libraryPath, the way OpenSCAD's own OPENSCADPATH lets a
// library like MCAD resolve without every project vendoring its own copy. A path found in neither resolves to
// nothing, which is what OpenSCAD does with a missing library. The setting is read fresh on every call rather than
// cached, so a change takes effect on the next edit without reloading the extension.
export const files = {
	resolve(written: string, fromDir: string) {
		if (path.isAbsolute(written))
			return fs.existsSync(written) ? written : undefined;
		const local = path.join(fromDir, written);
		if (fs.existsSync(local))
			return local;
		const libraryPath = vscode.workspace.getConfiguration('scad').get<string[]>('libraryPath') ?? [];
		for (const dir of libraryPath) {
			const full = path.join(dir, written);
			if (fs.existsSync(full))
				return full;
		}
		return undefined;
	},
	read(full: string) {
		return fs.readFileSync(full, 'utf8');
	},
	// surface()'s file, which may be a PNG
	readBinary(full: string) {
		return new Uint8Array(fs.readFileSync(full));
	},
};


// what the fit and reset commands need of the viewer they apply to: the bitmap viewer and the tensor viewer both have it
export interface Zoomable {
	postMessage(message: {command: 'fitToWindow'} | {command: 'resetZoom'}): unknown;
}
let activeViewer: Zoomable | undefined;
export function setActiveViewer(viewer: Zoomable) {
	activeViewer = viewer;
}

export async function readShader(assetPath: vscode.Uri) {
	return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(assetPath));
}


const editViewer = () => activeViewer as {postMessage(message: MessageIn): unknown} | undefined;
const editOps: (EditOp | LayerOp)[]	= ['fill', 'clear', 'invert', 'flipHorizontal', 'flipVertical', 'rotateClockwise', 'rotateAnticlockwise', 'crop', 'selectAll', 'deselect', 'newLayer', 'deleteLayer', 'raiseLayer', 'lowerLayer'];

export function activate(context: vscode.ExtensionContext) {
	new BitmapViewerProvider(context);
	new GgufViewerProvider(context);
	new ScadViewerProvider(context);
	new MeshViewerProvider(context);
	new FontViewerProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('scad.exportStl', (uri?: vscode.Uri) => {
			if (!uri) {
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				uri = tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText
					? tab.uri : vscode.window.activeTextEditor?.document.uri;
			}
			if (!uri || !uri.fsPath.endsWith('.scad')) {
				vscode.window.showErrorMessage('Export STL: open a .scad file first.');
				return;
			}

			exportStl(uri,
				vscode.Uri.file(uri.fsPath.substring(0, uri.fsPath.length - 5) + '.stl'),
				path.basename(uri.fsPath)
			);
		}),
		// the bitmap editor's whole-image operations (from the title menu), done by the viewer; only its menu offers them,
		// so the active viewer is one that takes them
		...editOps.map(op => vscode.commands.registerCommand(`bitmap.${op}`, () => editViewer()?.postMessage({command: 'imageOp', op}))),
		vscode.commands.registerCommand('bitmap.fit', () => activeViewer?.postMessage({command: 'fitToWindow'})),
		vscode.commands.registerCommand('bitmap.reset', () => activeViewer?.postMessage({command: 'resetZoom'})),
	);

}

export function deactivate() {
}
