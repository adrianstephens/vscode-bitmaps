// text()'s two jobs: finding a system font by name (matching OpenSCAD/fontconfig's own convention -- a font=
// argument names a family, optionally with :style=, matched against the font's own name table rather than a
// filename), and turning a string into the multi-path outlines polygon2 already knows how to fill. Everything here
// is synchronous, matching the rest of the evaluator: binary_fonts' table getters are synchronous too (see the
// loadTable fix in font.ts -- they used to be Promises even for a table that never awaits real I/O, which they
// only did because going through the generic reader dispatch calls a ReadClass's unconditionally-async static
// get() instead of its own synchronous constructor).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as bin from '@isopodlabs/binary';
import { load, loadAsync, Font, bezier2Curve, curvepathDistance2, mapCurve } from '@isopodlabs/binary_fonts';
import { float2 } from '@isopodlabs/maths/vector';
import type { ScadFiles } from './evaluate';

//-----------------------------------------------------------------------------
// finding a font by name
//-----------------------------------------------------------------------------

interface FontEntry {
	family:		string;
	subfamily:	string;
	filePath:	string;
	ttcIndex?:	number;		// which font within a .ttc/.otc collection
}

// built once per extension-host lifetime, the same as fontconfig's own cache -- scanning every system font
// directory's files eagerly is the only way to answer "is there a font of this name" at all
let index: FontEntry[] | undefined;
let indexPending: Promise<FontEntry[]|undefined> | undefined;
const fontCache = new Map<string, Font>();

// the Preferred Family/Subfamily names (16/17) exist only when a family groups more than the four styles a name
// table can otherwise express, so they are what a menu actually shows when present -- see the ID table in font.ts

// one scan per extension-host lifetime, the same as fontconfig's own cache: the scan opens every installed
// font file, so a second preview -- or one opened while the first is still scanning -- must reuse the first
// result rather than repeat it. Clearing indexPending on failure lets a later preview retry.
export function buildIndex() {
	if (!indexPending) {
		const fontDirs	= process.platform === 'darwin' ? ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')]
						: process.platform === 'win32'	? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts'), path.join(os.homedir(), 'AppData/Local/Microsoft/Windows/Fonts')]
						: ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts')];
		indexPending = Promise.all(fontDirs.map(walk)).then(entries => index = entries.flat().filter(f => !!f)).catch(e => {
			indexPending = undefined;
			throw e;
		});
	}
	return indexPending;

	async function walk(dir: string) {
		try {
			const direntries = await fs.promises.readdir(dir, {withFileTypes: true});
			return (await Promise.all(direntries.map(async (e): Promise<FontEntry|(FontEntry|undefined)[]|undefined> => {
				const filePath = path.join(dir, e.name);
				if (e.isDirectory()) {
					return await walk(filePath);
				} else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) {
					try {
						const file = await fs.promises.open(filePath, 'r');
						try {
							const stream = new bin.async.stream(
								(offset, data) => file.read(data, 0, data.length, offset).then(r => r.bytesRead),
							);

							const result = await loadAsync(stream);
							if (result) {
								if ('fonts' in result) {
									return await Promise.all(result.fonts.map(async (f, ttcIndex) => {
										const font = await f;
										const family = font.family();
										if (family)
											return {family, subfamily: font.subfamily(), filePath, ttcIndex} as FontEntry;
									}));
								} else {
									const family = result.family();
									if (family)
										return {family, subfamily: result.subfamily(), filePath} as FontEntry;
								}
							}
						} finally {
							// family()/subfamily() read lazily through this stream, so the descriptor has to stay
							// open until those have resolved -- leaving it to the GC is what emitted
							// "Closing file descriptor N on garbage collection" once per installed font
							await file.close().catch(() => {});
						}
					} catch {
					}
				}
			}))).flat();
		} catch {
		}
	}
}

// a handful of names near-universally installed (or their common substitutes), tried in order when the requested
// family is not found -- real OpenSCAD falls back to whatever fontconfig's own default sans-serif resolves to
const DEFAULT_FAMILIES = ['Liberation Sans', 'Arial', 'Helvetica', 'DejaVu Sans', 'Verdana', 'Segoe UI'];

export function findFont(family: string, style: string | undefined, files: ScadFiles | undefined, warn: (message: string) => void): Font | undefined {
	const entries = index ?? [];
	if (entries.length === 0) {
		warn('text(): no system fonts could be found to draw with');
		return undefined;
	}

	let candidates: FontEntry[] = entries.filter(e => e.family.toLowerCase() === family.toLowerCase());
	const inexact = !candidates.length;

	if (!candidates.length)
		candidates	= entries.filter(e => e.family.toLowerCase().includes(family.toLowerCase()));

	if (!candidates.length) {
		for (const def of DEFAULT_FAMILIES) {
			candidates = entries.filter(e => e.family.toLowerCase() === def.toLowerCase());
			if (candidates.length)
				break;
		}
		if (!candidates.length)
			candidates = entries.filter(e => e.family === entries[0].family);
	}
	if (inexact)
		warn(`text(): font "${family}" not found, using "${candidates[0].family}"`);

	const entry = (style ? candidates.find(e => e.subfamily.toLowerCase() === style.toLowerCase()) : undefined)
		?? candidates.find(e => /^regular$/i.test(e.subfamily))
		?? candidates.find(e => /^book$/i.test(e.subfamily))
		?? candidates[0];

	const key = `${entry.filePath}#${entry.ttcIndex ?? 0}`;
	let font = fontCache.get(key);

	if (!font) {
		const result = files?.readBinary(entry.filePath, bytes => load(bytes));
		if (result) {
			font = result instanceof Font ? result : result.fonts[entry.ttcIndex ?? 0];
			fontCache.set(key, font);
		}
	}
	return font;
}

//-----------------------------------------------------------------------------
// glyph outlines and text layout
//-----------------------------------------------------------------------------

// A glyph's own contours, in whatever space `apply` maps its curve's raw points into -- font units for a simple
// glyph, or a composite's own component space for one of its refs, each carrying its own placement matrix that
// this composes with `apply` rather than multiplying matrices together (float2x3.matmul is for a different shape
// of composition and gives nonsense here; chaining the two functions is exact and needs no matrix algebra at all).
export function glyphContours(font: Font, glyphId: number, apply: (p: float2) => float2, tol: number) {
	return bezier2Curve(mapCurve(font.getGlyphCurves(glyphId), apply), tol);
}

export interface TextParams {
	font:		Font;
	text:		string;
	size:		number;
	halign:		'left' | 'center' | 'right';
	valign:		'top' | 'center' | 'baseline' | 'bottom';
	spacing:	number;
}

// One contour set per character (never merged into a single multi-path shape): even-odd across unrelated glyphs
// would punch a hole wherever two letters' outlines happened to overlap (an italic script font, tight spacing),
// which is not what a hole in one letter's own counter means. The caller unions them instead, the same as any
// other collection of separate shapes.
export function layoutText(params: TextParams, files: ScadFiles, warn: (message: string) => void) {
	const chars = [...params.text].filter(c => c !== '\n' && c !== '\r');
	if (chars.length === 0)
		return [];

	const font = params.font;

	const mapping	= font.getGlyphMapping();
	if (!mapping) {
		warn('text(): the chosen font has no character mapping this viewer can read');
		return [];
	}

	const upm		= font.head?.units_per_em || 1000;
	const scale 	= params.size / upm;

	const hmtx		= font.hmtx;
	const advanceOf = (gid: number) => hmtx && hmtx.metrics.length ? hmtx.metrics[Math.min(gid, hmtx.metrics.length - 1)].advance : upm / 2;

	let x = 0;
	const placements: {gid: number, x: number}[] = [];
	for (const ch of chars) {
		const gid = mapping[ch.codePointAt(0)!] || 0;
		placements.push({gid, x});
		x += advanceOf(gid) * params.spacing;
	}
	const totalWidth = x;

	const offsetX	= params.halign === 'center' ? -totalWidth / 2 : params.halign === 'right' ? -totalWidth : 0;
	const ascent	= font.hhea?.ascent || upm * 0.8;
	const descent	= font.hhea?.descent || -upm * 0.2;
	const offsetY	= params.valign === 'top' ? -ascent : params.valign === 'center' ? -(ascent + descent) / 2 : params.valign === 'bottom' ? -descent : 0;

	const result: bezier2Curve[] = [];
	let badGlyphs = 0;
	for (const {gid, x: gx} of placements) {
		const apply = (p: float2) => float2((p.x + gx + offsetX) * scale, (p.y + offsetY) * scale);
		try {
			const contours = glyphContours(font, gid, apply, 1 / upm);
			if (contours.length)
				result.push(contours);
		} catch {
			// a malformed glyph in an otherwise readable font -- skipped rather than losing the whole string to it,
			// the same honest-fallback spirit as everywhere else the evaluator meets something it cannot draw
			badGlyphs++;
		}
	}
	if (badGlyphs)
		warn(`text(): ${badGlyphs} character${badGlyphs > 1 ? 's' : ''} in "${params.text}" could not be read from its font, and ${badGlyphs > 1 ? 'were' : 'was'} skipped`);
	return result;
}

