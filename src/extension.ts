import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BitmapViewerProvider } from './BitmapViewer';
import { GgufViewerProvider } from './GgufViewer';
import { ScadViewerProvider, exportStl, exportCsg } from './ScadViewer';
import { MeshViewerProvider } from './MeshViewer';
import { FontViewerProvider } from './FontViewer';
import type { MessageIn, EditOp, LayerOp } from '../webview/bitmap';
import type { GlyphAtlas } from '../webview/sdf';
import { findFont, glyphContours } from './scad/fonts';
import { load, Font, curvepathDistance2 } from '@isopodlabs/binary_fonts';
import { float2 } from '@isopodlabs/maths/vector';

// `use`/`include`/surface()/import() read files from inside the synchronous parser and evaluator, and a blocking
// readFileSync/existsSync there stalls the extension host (keystrokes are dropped). So they read from a cache that
// is filled asynchronously instead: a path not in the cache is recorded as a miss and answered with a placeholder,
// the run's result is thrown away, and withFiles() loads what was missed (concurrently, off the main thread) and
// runs again. Only the files a document actually touches are loaded, and a run that misses nothing is the real one.
//
// Resolution order: a path that is not there relative to the including file falls back to each directory in
// scad.libraryPath, the way OpenSCAD's own OPENSCADPATH lets a library like MCAD resolve without every project
// vendoring its own copy. A path found in neither resolves to nothing, which is what OpenSCAD does with a missing
// library. The setting is read fresh on every call, so a change takes effect on the next edit.
//
// Between runs an entry is kept only while its mtime and size still match (one async stat each, at the start of
// withFiles), and a missing file is looked for again.
interface FileEntry {
	mtimeMs: number,
	size: number,
	value?: any
}

type Reader<T = any> = (bytes: Uint8Array) => T | Promise<T>;

class FileReader {

	fileEntries		= new Map<string, FileEntry | null>();	// null: looked for and not there
	missingStats	= new Set<string>();
	missingBytes	= new Map<string, Reader|undefined>();
	filesQueue		= Promise.resolve(null as unknown);

	private contents(full: string, reader?: Reader) {
		const entry = this.fileEntries.get(full);
		if (entry === null)
			throw new Error(`ENOENT: ${full}`);
		if (entry?.value)
			return entry;
		this.missingBytes.set(full, reader);
		return undefined;
	}


	exists(full: string): boolean | undefined {
		const entry = this.fileEntries.get(full);
		if (entry === undefined)
			this.missingStats.add(full);
		else
			return !!entry;
	}

	resolve(written: string, fromDir: string) {
		const candidates = path.isAbsolute(written) ? [written] : [
			path.join(fromDir, written),
			...(vscode.workspace.getConfiguration('scad').get<string[]>('libraryPath') ?? []).map(dir => path.join(dir, written)),
		];
		let found: string | undefined, complete = true;
		for (const full of candidates) {
			const x = this.exists(full);
			if (x === undefined) {
				complete = false;
			} else if (x && complete && !found) {
				found = full;
			}
		}
		return found;
	}
	read(full: string): string {
		return this.contents(full, bytes => new TextDecoder('utf-8').decode(bytes))?.value ?? '';
	}

	readBinary<T>(full: string, reader: (bytes: Uint8Array) => T | Promise<T>) {
		return this.contents(full, reader)?.value;
	}

	/** Run `run` -- which reads through `files` -- and give its result, loading whatever it asked for that was not
	 *  cached yet and running it again until nothing is missing. Runs are queued, since they share the cache. */
	with<T>(run: () => T | Promise<T>): Promise<T> {
		const loadFile = async (full: string) => {
			try {
				const stat = await fs.promises.stat(full);
				const entry: FileEntry = {mtimeMs: stat.mtimeMs, size: stat.size};
				this.fileEntries.set(full, entry);
				if (stat.isFile())
					return entry;
			} catch {
				this.fileEntries.set(full, null);
			}
		}

		const result = this.filesQueue.then(async () => {
			// drop what changed on disk since the last run, and retry what was missing
			await Promise.all([...this.fileEntries].map(async ([full, entry]) => {
				if (entry) {
					try {
						const stat = await fs.promises.stat(full);
						if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size)
							return;
					} catch {}
				}
				this.fileEntries.delete(full);
			}));
			for (;;) {
				let value: T | undefined, error: unknown, failed = false;
				try {
					value = await run();
				} catch (e) {
					error = e;
					failed = true;
				}
				if (!this.missingStats.size && !this.missingBytes.size) {
					if (failed)
						throw error;
					return value as T;
				}
				// a miss means this run saw placeholders, so whatever it made or threw is not to be believed
				const bytes = [...this.missingBytes], stats = [...this.missingStats].filter(full => !this.missingBytes.has(full));
				this.missingBytes.clear();
				this.missingStats.clear();
				await Promise.all([
					...bytes.map(async ([full, reader]) =>  {
						const entry = await loadFile(full);
						if (entry) {
							const bytes = await fs.promises.readFile(full);
							entry.value = reader ? await reader(bytes) : bytes;
						}
					}),
					...stats.map(loadFile)
				]);
			}
		});
		this.filesQueue = result.catch(() => {});
		return result;

	}
}
export const files = new FileReader;

//-----------------------------------------------------------------------------
// the digits for the floor's axis labels
//-----------------------------------------------------------------------------

// A signed-distance atlas of the characters a number is spelled with, baked from the same glyph curves text() draws
// from, for the raymarcher's floor to sample: the labels along the axes are then a texture fetch per character in a
// narrow band, not a curve evaluation. One row of equal cells, each holding one character centred in a fixed pitch
// (digits are tabular, so this loses nothing), with a margin of `spread` around the glyphs for the distance to fall
// off into. Texel = 0.5 on the outline, larger inside, smaller outside, saturating `spread` either way; all lengths
// are in ems, which the shader scales to whatever size a label wants.

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
			atlas = (font ? bakeCharacters(font, '0123456789-') : undefined) ?? null;
		} catch {
			atlas = null;
		}
	}
	return atlas ?? undefined;
}

function bakeCharacters(font: Font, chars: string): GlyphAtlas | undefined {
	const mapping	= font.getGlyphMapping();
	if (!mapping)
		return;

	const upm		= font.head?.units_per_em || 1000;
	const hmtx		= font.hmtx;
	const advanceOf = (gid: number) => hmtx && hmtx.metrics.length ? hmtx.metrics[Math.min(gid, hmtx.metrics.length - 1)].advance / upm : 0.6;
	const glyphs = [...chars].map(ch => {
		const gid = mapping[ch.codePointAt(0)!] || 0;
		return {advance: advanceOf(gid), curves: glyphContours(font, gid, p => float2(p.x / upm, p.y / upm), 1 / upm)};
	});
	if (glyphs.some(g => g.curves.length === 0))
		return;

	const	pitch	= Math.max(...glyphs.slice(0, 10).map(g => g.advance));
	let		minY	= Infinity, maxY = -Infinity;
	for (const g of glyphs) {
		// centre each character in the pitch (only '-' is narrower than it), and find how far up and down they reach
		const dx = (pitch - g.advance) / 2;
		for (const v of g.curves) {
			v.x += dx;
			minY = Math.min(minY, v.y);
			maxY = Math.max(maxY, v.y);
		}
	}

	const spread	= 0.12, cellX0 = -spread, cellY0 = minY - spread;
	const cellWEm	= pitch + 2 * spread, cellHEm = maxY - minY + 2 * spread;
	const height	= 48, cellW = Math.ceil(height * cellWEm / cellHEm), width = cellW * chars.length;
	const data		= new Uint8Array(width * height);
	glyphs.forEach((g, cell) => {
		for (let j = 0; j < height; j++) {
			const y = cellY0 + (j + 0.5) / height * cellHEm;
			for (let i = 0; i < cellW; i++) {
				const x = cellX0 + (i + 0.5) / cellW * cellWEm;
				const d = curvepathDistance2(float2(x, y), g.curves);
				data[j * width + cell * cellW + i] = Math.max(0, Math.min(255, Math.round(255 * (0.5 - 0.5 * d / spread))));
			}
		}
	});
	return {chars, width, height, cellW, data, pitch, spread, cellX0, cellY0, cellWEm, cellHEm, capHeight: maxY};
}



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
		vscode.commands.registerCommand('bitmap.fit', () => activeViewer?.postMessage({command: 'fitToWindow'})),
		vscode.commands.registerCommand('bitmap.reset', () => activeViewer?.postMessage({command: 'resetZoom'})),
	);

}

export function deactivate() {
}
