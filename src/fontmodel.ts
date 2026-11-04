// A font as the font viewer has it: the model of one open for editing (the font as read, the edits made to it, and the bytes it is saved as;
// the application, the extension or a web page's host, says what is done with an edit and with a change by what it provides for onEdit and
// onChange), and what the viewer's page is shown of a font (its summary, the markup and detail of a glyph, and the tables as a tree).
// No `vscode` here: web/tsconfig.json builds this file again as an ES module for a web page's host.
import { load, Font, TTF_OTF, WOFF, WOFF2, curveVertex, ON_BEGIN, parseCurve, makeSVGPath } from '@isopodlabs/binary_fonts';
import { float2 } from '@isopodlabs/maths/vector';
import type { FontInfo, GlyphDetail, TableNode } from '../webview/font.js';

// the points the page edits (y down), as the outline Font.setGlyph takes them
export function curveOf(points: curveVertex[]) {
	if (points.length && points[0].flags !== ON_BEGIN)
		throw new Error('an outline begins with a begin point');
	return points.map(v => curveVertex(v.x, -v.y, v.flags));
}

// an edit that has been made, and how to take it back and put it back
export interface EditStep {
	label:	string;
	undo():	void;
	redo():	void;
}

// what the page should show again: a glyph (`own` when the page itself made the change that is being reported), or the whole font
export type FontChange = {kind: 'glyph', id: number, own?: boolean} | {kind: 'reload'};

// Only a single TrueType font can be edited, as it is only that which binary_fonts can write.
export abstract class FontModel {
	fonts: Font[]	= [];
	editable		= false;
	convertible		= false;
	svgEditable		= false;		// whether the SVG drawings of its glyphs can be edited
	bitmapEditable	= false;		// whether the bitmaps of its glyphs can be edited (sbix ones, which can be written)
	dirty			= false;		// whether there are edits that are not in the file

	protected data?: Uint8Array;	// the file as it was read, from which a font that is converted is read again
	private latest?: {kind: 'outline' | 'svg', id: number, redo: () => void} | 'shown';

	// `name` is the file's name, which says what it is: .ttf, .otf, .woff or .woff2 (the formats that can be edited)
	constructor(public readonly name: string) {}

	// an edit has been made: the application puts it where undo and redo find it
	protected abstract onEdit(step: EditStep): void;
	// the font is changed (by an edit, or by undoing or redoing one), and what shows it should be drawn again
	protected abstract onChange(change: FontChange): void;

	// the file's bytes are read; `dirty` when they hold edits that were not saved (a backup)
	async open(data: Uint8Array, dirty = false) {
		this.latest = 'shown';
		const result = await load(data);
		if (!result)
			throw new Error('not a font this reads');
		this.fonts = result instanceof Font ? [result] : result.fonts;
		if (!this.fonts.length)
			throw new Error('the file holds no fonts');

		this.data			= data;
		this.editable		= result instanceof Font && !!result.glyphdata && /\.(ttf|woff2?)$/i.test(this.name);
		this.convertible	= result instanceof Font && !result.glyphdata && !!result.rawTables.get('CFF ') && /\.otf$/i.test(this.name);
		this.svgEditable	= result instanceof Font && /\.(ttf|otf|woff2?)$/i.test(this.name);
		this.bitmapEditable = result instanceof Font && !!result.sbix && /\.(ttf|otf|woff2?)$/i.test(this.name);
		this.dirty			= dirty;
	}

	// a font with CFF outlines is made a TrueType one, the only kind that can be edited and written. The font as it was
	// is kept, and what undo and redo swap in and out.
	async convert() {
		const before = this.fonts[0];
		const converted = await load(this.data!);
		if (!(converted instanceof Font) || !converted.convertToTrueType())
			throw new Error('this font cannot be converted');
		const swap = (font: Font, editable: boolean) => {
			this.fonts = [font];
			this.editable = editable;
			this.convertible = !editable;
			this.onChange({kind: 'reload'});
		};
		this.dirty = true;
		this.latest = undefined;
		swap(converted, true);
		this.onEdit({label: 'Convert to TrueType outlines', undo: () => swap(before, false), redo: () => swap(converted, true)});
	}

	// An edit of a glyph, which `make` makes and says how to undo and redo. A later step of the last edit changes that edit: it undoes
	// to what was before the first step, and redoes to this one.
	private glyphEdit(kind: 'outline' | 'svg', id: number, label: string, continues: boolean, make: () => {undo: () => void, redo: () => void}) {
		const latest = this.latest;
		if (continues && latest === 'shown')
			return;
		if (continues && typeof latest === 'object' && latest.kind === kind && latest.id === id) {
			latest.redo = make().redo;
			this.onChange({kind: 'glyph', id, own: true});
			return;
		}
		const {undo, redo} = make();
		const made = this.latest = {kind, id, redo};
		this.dirty = true;
		const apply = (f: ()=>void) => {
			this.latest = 'shown';
			f();
			this.onChange({kind: 'glyph', id});
		};
		this.onEdit({label, undo: () => apply(undo), redo: () => apply(made.redo)});
		this.onChange({kind: 'glyph', id, own: true});
	}

	// replaces a glyph's outline
	edit(id: number, points: curveVertex[], label: string, continues = false) {
		const font = this.fonts[0];
		if (!this.editable || !font.glyphdata || !(id >= 0 && id < font.glyphdata.length))
			throw new Error('this font cannot be edited');
		this.glyphEdit('outline', id, label, continues, () => font.setGlyph(id, {curve: curveOf(points)})!);
	}

	// a glyph's SVG drawing replaced by an edited one, which goes into the document of the SVG table that has it
	editSvg(id: number, text: string, label: string, continues = false) {
		const font = this.fonts[0];
		try {
			this.glyphEdit('svg', id, label, continues, () => font.setGlyphSVG(id, text));
		} catch (e) {
			throw new Error('the SVG drawing of this glyph cannot be edited');
		}
	}

	// a glyph's bitmap replaced by an edited one (a PNG), in the strike of the size it was taken from
	editBitmap(id: number, ppem: number, data: Uint8Array, label: string) {
		const font	= this.fonts[0];
		const was	= font.getGlyphImage(id, ppem);
		const {undo, redo} = font.setGlyphImage(id, ppem, {type: 'png ', originOffset: was?.originOffset ?? float2(0, 0), data});
		this.dirty	= true;
		this.latest = undefined;
		const apply = (f: ()=>void) => {
			f();
			this.onChange({kind: 'glyph', id});
		};
		this.onEdit({label, undo: () => apply(undo), redo: () => apply(redo)});
		this.onChange({kind: 'glyph', id});
	}

	// as an SFNT file whatever it was read from, which is what a backup holds and what open() reads
	bytes() {
		return TTF_OTF.write(this.fonts[0]);
	}

	// the font in the format a file of this name has: WOFF for .woff, WOFF2 for .woff2, else an SFNT (TrueType or OpenType)
	async encode(name: string) {
		const font = this.fonts[0];
		return /\.woff2$/i.test(name) ? await WOFF2.write(font) : /\.woff$/i.test(name) ? await WOFF.write(font) : TTF_OTF.write(font);
	}
}

//-----------------------------------------------------------------------------
//	what the page is shown of a font
//-----------------------------------------------------------------------------

// the name of a file, from its path
const base = (file: string) => file.split(/[\\/]/).pop() ?? file;

// names in a font file are UTF-16 that the reader leaves as bytes, so a NUL sits before each Latin character
export const clean = (s?: string) => s?.replace(/\0/g, '').trim() ?? '';

const NAMES: [number, string][] = [
	[1, 'Family'], [2, 'Style'], [4, 'Full name'], [3, 'Identifier'], [5, 'Version'], [6, 'PostScript name'],
	[0, 'Copyright'], [7, 'Trademark'], [8, 'Manufacturer'], [9, 'Designer'], [10, 'Description'],
	[11, 'Vendor URL'], [12, 'Designer URL'], [13, 'License'], [14, 'License URL'],
];

export function fontInfo(font: Font, file: string, face: number, faces: string[]): FontInfo {
	const n			= font.numGlyphs();
	const mapping	= font.getGlyphMapping();
	const unicodes: Record<number, number[]> = {};
	// the codepoints of each glyph, found from the glyph mapping (indexed by codepoint)
	mapping?.forEach((id, cp) => {
		if (id)
			(unicodes[id] ??= []).push(cp);
	});

	const upm = font.head?.units_per_em || 1000;
	const advances = Array.from({length: n}, (_, i) => {
		const m = font.hmtx?.metrics;
		return m ? (m[Math.min(i, m.length - 1)]?.advance ?? 0) : upm;
	});

	const names: [string, string][] = [];
	for (const [id, label] of NAMES) {
		const value = clean(font.name?.get(id as any));
		if (value)
			names.push([label, value]);
	}

	return {
		file:		base(file),
		faces,
		face,
		family:		clean(font.family()) || base(file),
		style:		clean(font.subfamily()),
		numGlyphs:	n,
		unitsPerEm:	upm,
		ascent:		font.hhea?.ascent ?? upm * 0.8,
		descent:	font.hhea?.descent ?? -upm * 0.2,
		lineGap:	font.hhea?.lineGap ?? 0,
		advances,
		unicodes,
		names,
	};
}

const compact = {indent: '', newline: ''};

// a glyph's drawing as the markup inside an <svg> in font units (y down, baseline at 0), or '' where it has none
// (a glyph of the SVG table is drawn as the editor has it, so that what it is edited as is what is shown)
export function glyphMarkup(font: Font, id: number): string {
	try {
		const svg = font.getGlyphSVG(id, 7);
		if (svg)
			return svg.toString(compact).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
	} catch {}
	return '';
}

// everything the inspector draws of a glyph: its outline as a path and as the points it is made of (y down, as the
// page draws), and what is drawn of it in colour
// the em box of a glyph, which a drawing of it is shown in: from the top of the ascent to the bottom of the descent, y down
function emBox(font: Font, id: number) {
	const upm		= font.head?.units_per_em || 1000, m = font.hmtx?.metrics;
	const advance	= m ? (m[Math.min(id, m.length - 1)]?.advance ?? upm) : upm;
	const ascent	= font.hhea?.ascent ?? upm * 0.8, descent = font.hhea?.descent ?? -upm * 0.2;
	return `0 ${-ascent} ${advance} ${ascent - descent}`;
}

// a glyph that is drawn in colour as a document of its own: from the SVG table (which can be edited), or from the colour
// layers or a bitmap (which cannot)
export function glyphSvg(font: Font, id: number, editable: boolean): GlyphDetail['svg'] {
	const viewBox = emBox(font, id);
	try {
		const table = font.getGlyphSVG(id, 0), svg = table ?? font.getGlyphSVG(id, 5);
		if (svg) {
			Object.assign(svg.attributes, {viewBox, width: undefined, height: undefined});
			return {text: svg.toString(compact), editable: !!table && editable};
		}
	} catch {}
}

export function glyphDetail(font: Font, id: number, svgEditable = false, bitmapEditable = false): GlyphDetail {
	let curves: curveVertex[] = [];
	let error: string | undefined;
	try {
		curves = font.getGlyphCurves(id);
	} catch (e: any) {
		error = `outline could not be read: ${e?.message ?? e}`;
	}

	const path		= makeSVGPath(parseCurve(curves));
	const points	= curves.map(v => curveVertex(v.x, -v.y, v.flags));
	let components: number[] = [];
	try {
		components = font.getGlyph(id)?.refs?.map(r => r.glyph) ?? [];
	} catch {}
	const markup	= glyphMarkup(font, id);
	// drawn in colours of its own (a colour font's), which the outline being edited is not what makes
	const colored = /url\(#|fill="#|fill="rgb/.test(markup);
	const ppem		= font.bitmapPpem();
	const bitmap	= ppem && font.getGlyphImage(id, ppem)?.type === 'png ' ? {ppem, editable: bitmapEditable && !!font.sbix} : undefined;
	return {path, points, markup, colored, components, error, svg: glyphSvg(font, id, svgEditable), bitmap};
}

const MAX_CHILDREN = 1000;

class TableError {
	constructor(public message: string) {}
}

// containers are walked as arrays of their entries, so a path of keys and indices reaches anything in a table
function plain(v: any): any {
	if (v instanceof Map)
		return Array.from(v, ([k, x]) => [k, x]);
	if (v instanceof Set)
		return Array.from(v);
	return v;
}

function describe(v: any): TableNode {
	const base = {type: typeof v as TableNode['type']};
	if (v === null || v === undefined)
		return {type: 'null', value: String(v)};
	if (typeof v === 'string')
		return {...base, value: JSON.stringify(clean(v))};
	if (typeof v === 'number')
		return {...base, value: Number.isInteger(v) && Math.abs(v) >= 256 ? `${v} (0x${(v >>> 0).toString(16)})` : String(v)};
	if (typeof v === 'bigint' || typeof v === 'boolean')
		return {...base, value: String(v)};
	if (typeof v === 'function')
		return {type: 'null', value: 'function'};
	if (ArrayBuffer.isView(v)) {
		const bytes = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, 16));
		return {type: 'bytes', value: `${v.constructor.name}(${(v as any).length ?? v.byteLength}) ${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ')}${v.byteLength > 16 ? ' …' : ''}`};
	}
	const o = plain(v);
	if (Array.isArray(o))
		return {type: 'array', value: `[${o.length}]`, count: o.length};
	const n = Object.keys(o).length;
	return {type: 'object', value: `${o.constructor?.name && o.constructor !== Object ? o.constructor.name + ' ' : ''}{${n}}`, count: n};
}

// the children of the value at a path from the font: its entries, each described
export function children(font: Font, keys: string[]): TableNode[] {
	let v: any = font;
	for (const k of keys) {
		v = plain(v)?.[k];
		if (v === undefined)
			return [];
	}
	v = plain(v);
	if (!v || typeof v !== 'object' || ArrayBuffer.isView(v))
		return [];
	// a table is read when first touched, so one that cannot be read shows why instead of hiding the rest
	const entries: [string, any][] = [];
	for (const k of Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v)) {
		try {
			if (v[k] !== undefined)
				entries.push([k, v[k]]);
		} catch (error: any) {
			entries.push([k, new TableError(String(error?.message ?? error))]);
		}
	}
	const result: TableNode[] = entries.slice(0, MAX_CHILDREN).map(([key, x]) => ({key, ...(x instanceof TableError ? {type: 'error' as const, value: x.message} : describe(x))}));
	if (entries.length > MAX_CHILDREN)
		result.push({key: '…', type: 'null', value: `${entries.length - MAX_CHILDREN} more not shown`});
	return result;
}
