// The digit atlas the floor's axis numbers are drawn from, baked from the font the web pages carry (npx tsc -b first, then
// npx ts-node -T test/glyphatlas.ts): every character has a cell, a texel is above one half inside a glyph and below it outside, and the
// font file is the one that is meant to travel with the pages (under the OFL, so its licence must travel with it).
const { digitAtlasOf, DIGITS } = require('../out/src/glyphatlas.js');
import * as fs from 'fs';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const bytes = new Uint8Array(fs.readFileSync('assets/inter-digits.woff'));
	const atlas = await digitAtlasOf(bytes);
	check(!!atlas, 'the font gives an atlas');
	if (!atlas)
		return process.exit(1);

	check(atlas.chars === DIGITS && atlas.chars === '0123456789-', `it has the digits and the minus sign (${atlas.chars})`);
	check(atlas.width === atlas.cellW * atlas.chars.length && atlas.data.length === atlas.width * atlas.height, `a row of ${atlas.chars.length} cells of ${atlas.cellW} x ${atlas.height}`);

	const texel = (cell: number, fx: number, fy: number) => atlas.data[Math.floor(fy * atlas.height) * atlas.width + cell * atlas.cellW + Math.floor(fx * atlas.cellW)];
	for (let cell = 0; cell < atlas.chars.length; cell++) {
		let inside = 0, outside = 0;
		for (let j = 0; j < atlas.height; j++)
			for (let i = 0; i < atlas.cellW; i++) {
				const v = atlas.data[j * atlas.width + cell * atlas.cellW + i];
				if (v > 128) inside++; else if (v < 128) outside++;
			}
		check(inside > 20 && outside > inside, `'${atlas.chars[cell]}' has ink (${inside} texels) with room round it (${outside})`);
	}
	// the bar of the minus sign crosses the middle of its cell, and the middle of a 0 is in its counter
	const column = Array.from({length: atlas.height}, (_, j) => texel(10, 0.5, (j + 0.5) / atlas.height));
	check(column.some(v => v > 128), `the minus sign's bar crosses the middle of its cell (the column peaks at ${Math.max(...column)})`);
	check(texel(0, 0.5, 0.5) < 128, `the middle of '0' is in its counter (${texel(0, 0.5, 0.5)})`);

	check(fs.existsSync('assets/inter-license.txt') && /SIL OPEN FONT LICENSE/.test(fs.readFileSync('assets/inter-license.txt', 'utf8')), 'the font travels with its licence');
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})();
