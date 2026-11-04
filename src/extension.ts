import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BitmapViewerProvider, newBitmap } from './BitmapViewer';
import { GgufViewerProvider } from './GgufViewer';
import { ScadViewerProvider, exportMesh, exportCsg } from './ScadViewer';
import { MeshViewerProvider } from './MeshViewer';
import { FontViewerProvider } from './FontViewer';
import { SvgViewerProvider, newSvg } from './SvgViewer';
import { SCHEME, embedded } from './embedded';
import type { MessageIn } from '../webview/bitmap';
import type { GlyphAtlas } from '../webview/sdf';
import { findFont } from './fonts';
import { bakeCharacters, DIGITS } from './glyphatlas';
import { FileReader } from './filereader';
import { load, Font } from '@isopodlabs/binary_fonts';

// What `use`/`include`/surface()/import() read through, without blocking the extension host (see FileReader)
export const files = new FileReader(() => vscode.workspace.getConfiguration('scad').get<string[]>('libraryPath') ?? []);

//-----------------------------------------------------------------------------
// the digits for the floor's axis labels
//-----------------------------------------------------------------------------

// A signed-distance atlas of the characters a number is spelled with, baked (in glyphatlas.ts) from the same glyph curves text() draws
// from, for the raymarcher's floor to sample.

// The fonts most machines have, tried by name before the scan of every installed font findFont() would start with --
// a scan that takes a couple of seconds, which is not a price to pay just to draw some digits.
function commonFont(): Font | undefined {
	const windows = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
	const candidates = process.platform === 'darwin'
		? ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']
		: process.platform === 'win32'
		? [path.join(windows, 'arial.ttf'), path.join(windows, 'segoeui.ttf')]
		: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'];
	for (const file of candidates) {
		try {
			const result = load(fs.readFileSync(file));
			if (result && !(result instanceof Promise)) {
				const font = result instanceof Font ? result : result.fonts[0];
				if (font.getGlyphMapping())
					return font;
			}
		} catch {
			// not there, or not readable as a font: try the next
		}
	}
}

let atlas: GlyphAtlas | null | undefined;
export function digitAtlas(): GlyphAtlas | undefined {
	if (atlas === undefined) {
		try {
			const font		= commonFont() ?? findFont('Arial', undefined, files, () => {});
			atlas = (font ? bakeCharacters(font, DIGITS) : undefined) ?? null;
		} catch {
			atlas = null;
		}
	}
	return atlas ?? undefined;
}


// what the fit and reset commands need of the viewer they apply to: the bitmap viewer and the tensor viewer both have it
export interface Zoomable {
	postMessage(message: {command: 'fitToWindow'}): unknown;
}
let activeViewer: Zoomable | undefined;
export function setActiveViewer(viewer: Zoomable) {
	activeViewer = viewer;
}

export async function readShader(assetPath: vscode.Uri) {
	return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(assetPath));
}


const editViewer = () => activeViewer as {postMessage(message: MessageIn): unknown} | undefined;
const editOps	= ['fill', 'clear', 'invert', 'flipHorizontal', 'flipVertical', 'rotateClockwise', 'rotateAnticlockwise', 'crop', 'selectAll', 'deselect', 'newLayer', 'deleteLayer', 'raiseLayer', 'lowerLayer'];

export function activate(context: vscode.ExtensionContext) {
	new BitmapViewerProvider(context);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, embedded, {isCaseSensitive: true}));
	new GgufViewerProvider(context);
	new ScadViewerProvider(context);
	new MeshViewerProvider(context);
	new FontViewerProvider(context);
	new SvgViewerProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('scad.openMesh', (uri?: vscode.Uri) => {
			if (!uri) {
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				uri = tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText
					? tab.uri : vscode.window.activeTextEditor?.document.uri;
			}
			if (!uri || !uri.fsPath.endsWith('.scad')) {
				vscode.window.showErrorMessage('Mesh: open a .scad file first.');
				return;
			}
			exportMesh(uri);
		}),
		vscode.commands.registerCommand('scad.exportCsg', (uri?: vscode.Uri) => {
			if (!uri) {
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				uri = tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText
					? tab.uri : vscode.window.activeTextEditor?.document.uri;
			}
			if (!uri || !uri.fsPath.endsWith('.scad')) {
				vscode.window.showErrorMessage('Export CSG: open a .scad file first.');
				return;
			}
			exportCsg(uri, vscode.Uri.file(uri.fsPath.substring(0, uri.fsPath.length - 5) + '.csg'));
		}),
		// the bitmap editor's whole-image operations (from the title menu), done by the viewer; only its menu offers them,
		// so the active viewer is one that takes them
		...editOps.map(op => vscode.commands.registerCommand(`bitmap.${op}`, () => editViewer()?.postMessage({command: 'imageOp', op}))),
		vscode.commands.registerCommand('bitmap.toCubemap', () => editViewer()?.postMessage({command: 'imageOp', op: 'toCubemap'})),
		vscode.commands.registerCommand('bitmap.new', newBitmap),
		vscode.commands.registerCommand('svg.new', newSvg),
		vscode.commands.registerCommand('bitmap.fit',() => activeViewer?.postMessage({command: 'fitToWindow'})),
	);

}

export function deactivate() {
}
