// A signed-distance atlas of the characters a number is spelled with, baked from glyph curves, for the raymarcher's floor to sample: the
// labels along the axes are then a texture fetch per character in a narrow band, not a curve evaluation. One row of equal cells, each holding
// one character centred in a fixed pitch (digits are tabular, so this loses nothing), with a margin of `spread` around the glyphs for the
// distance to fall off into. Texel = 0.5 on the outline, larger inside, smaller outside, saturating `spread` either way; all lengths are in
// ems, which the shader scales to whatever size a label wants.
// No `vscode` or files here: the extension bakes it from a font it finds on the machine, and a web page from the font it carries
// (assets/inter-digits.woff, under the SIL Open Font License in assets/inter-license.txt); web/tsconfig.json and web/build.js build this again for the page.
import { load, Font, bezier2Curve, mapCurve, curveDistance } from '@isopodlabs/binary_fonts';
import { float2 } from '@isopodlabs/maths/vector';
import type { GlyphAtlas } from '../webview/sdf';

export const DIGITS = '0123456789-';

export function bakeCharacters(font: Font, chars: string): GlyphAtlas | undefined {
	const mapping	= font.getGlyphMapping();
	if (!mapping)
		return;

	const upm		= font.head?.units_per_em || 1000;
	const hmtx		= font.hmtx;
	const advanceOf = (gid: number) => hmtx && hmtx.metrics.length ? hmtx.metrics[Math.min(gid, hmtx.metrics.length - 1)].advance / upm : 0.6;
	const glyphs = [...chars].map(ch => {
		const gid = mapping[ch.codePointAt(0)!] || 0;
		return {advance: advanceOf(gid), curves: bezier2Curve(mapCurve(font.getGlyphCurves(gid), p => float2(p.x / upm, p.y / upm)), 1 / upm)};
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
				const d = curveDistance(float2(x, y), g.curves);
				data[j * width + cell * cellW + i] = Math.max(0, Math.min(255, Math.round(255 * (0.5 - 0.5 * d / spread))));
			}
		}
	});
	return {chars, width, height, cellW, data, pitch, spread, cellX0, cellY0, cellWEm, cellHEm, capHeight: maxY};
}

/** The digits' atlas from the bytes of a font file (a page's, which fetched one), or undefined if they cannot be read from it. */
export async function digitAtlasOf(bytes: Uint8Array): Promise<GlyphAtlas | undefined> {
	const result = await load(bytes);
	const font = result instanceof Font ? result : result?.fonts[0];
	return font && bakeCharacters(font, DIGITS);
}
