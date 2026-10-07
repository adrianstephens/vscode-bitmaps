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
import { load, loadAsync, Font, makeCurveVertex, bezier2Curve, curvepathDistance2, mapCurve } from '@isopodlabs/binary_fonts';
import { float2 } from '@isopodlabs/maths/vector';
import type { GlyphAtlas } from '../../webview/sdf';

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
let indexPending: Promise<FontEntry[]> | undefined;
const fontCache = new Map<string, Font>();

// the Preferred Family/Subfamily names (16/17) exist only when a family groups more than the four styles a name
// table can otherwise express, so they are what a menu actually shows when present -- see the ID table in font.ts

// one scan per extension-host lifetime, the same as fontconfig's own cache: the scan opens every installed
// font file, so a second preview -- or one opened while the first is still scanning -- must reuse the first
// result rather than repeat it. Clearing indexPending on failure lets a later preview retry.
export function buildIndex(): Promise<FontEntry[]> {
	if (!indexPending)
		indexPending = scanFonts().catch(e => {
			indexPending = undefined;
			throw e;
		});
	return indexPending;
}

async function scanFonts(): Promise<FontEntry[]> {
	const entries: FontEntry[] = [];

	async function walk(dir: string) {
		try {
			const direntries = await fs.promises.readdir(dir, {withFileTypes: true});
			await Promise.all(direntries.map(async e => {
				const filePath = path.join(dir, e.name);
				if (e.isDirectory()) {
					await walk(filePath);
				} else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) {
					// one unreadable font must not abandon its siblings: an unawaited sibling keeps reading
					// after buildIndex() has returned, so the index comes out short and its descriptor is
					// never closed at all
					try {
						const file = await fs.promises.open(filePath, 'r');
						try {
							const stream = new bin.async.stream(
								(offset, data) => file.read(data, 0, data.length, offset).then(r => r.bytesRead),
							);

							const result = await loadAsync(stream);
							if (result) {
								if ('fonts' in result) {
									// asyncLoadTTC reads a collection's faces one at a time (they share the stream's
									// buffer) and hands back already-started promises, so awaiting them here is safe
									await Promise.all(result.fonts.map(async (f, ttcIndex) => {
										const font = await f;
										const family = font.family();
										if (family)
											entries.push({family, subfamily: font.subfamily(), filePath, ttcIndex});
									}));
								} else {
									const family = result.family();
									if (family)
										entries.push({family, subfamily: result.subfamily(), filePath});
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
			}));
		} catch {
		}
	}

	const fontDirs	= process.platform === 'darwin' ? ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')]
					: process.platform === 'win32'	? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts'), path.join(os.homedir(), 'AppData/Local/Microsoft/Windows/Fonts')]
					: ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts')];
	await Promise.all(fontDirs.map(walk));

	index = entries;
	return entries;
}

// OpenSCAD's font= is "Family Name" or "Family Name:style=Style Name"
function parseFontSpec(spec: string): {family: string, style?: string} {
	const m = /^(.*?):style=(.*)$/i.exec(spec);
	return m ? {family: m[1].trim(), style: m[2].trim()} : {family: spec.trim()};
}

// a handful of names near-universally installed (or their common substitutes), tried in order when the requested
// family is not found -- real OpenSCAD falls back to whatever fontconfig's own default sans-serif resolves to
const DEFAULT_FAMILIES = ['Liberation Sans', 'Arial', 'Helvetica', 'DejaVu Sans', 'Verdana', 'Segoe UI'];

export function findFont(spec: string | undefined, warn: (message: string) => void): Font | undefined {
	const entries = index ?? [];
	if (entries.length === 0) {
		warn('text(): no system fonts could be found to draw with');
		return undefined;
	}
	const {family, style} = spec ? parseFontSpec(spec) : {family: undefined, style: undefined};

	let candidates: FontEntry[] = [];
	let inexact = false;
	if (family) {
		candidates = entries.filter(e => e.family.toLowerCase() === family.toLowerCase());
		if (!candidates.length) {
			candidates	= entries.filter(e => e.family.toLowerCase().includes(family.toLowerCase()));
			inexact		= true;
		}
	}

	if (!candidates.length) {
		inexact = true;
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
		const result = load(fs.readFileSync(entry.filePath));
		if (result && (!(result instanceof Promise))) {
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
	text:		string;
	size:		number;
	font?:		string;
	halign:		'left' | 'center' | 'right';
	valign:		'top' | 'center' | 'baseline' | 'bottom';
	spacing:	number;
	fn:			number;		// bezier flattening segments -- text() has no circles for $fn to size in the usual way
}

// One contour set per character (never merged into a single multi-path shape): even-odd across unrelated glyphs
// would punch a hole wherever two letters' outlines happened to overlap (an italic script font, tight spacing),
// which is not what a hole in one letter's own counter means. The caller unions them instead, the same as any
// other collection of separate shapes.
export function layoutText(params: TextParams, warn: (message: string) => void) {
	const chars = [...params.text].filter(c => c !== '\n' && c !== '\r');
	if (chars.length === 0)
		return [];

	const font = findFont(params.font, warn);
	if (!font)
		return [];

	const mapping	= font.getGlyphMapping();
	if (!mapping) {
		warn('text(): the chosen font has no character mapping this viewer can read');
		return [];
	}

	const upm		= font.head?.units_per_em || 1000;
	const scale 	= params.size / upm;

//	const n			= Math.max(3, Math.round(params.fn) || 8);
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
			const font		= commonFont() ?? findFont(undefined, () => {});
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
