import { installedFonts } from '../src/fonts';

// The installed fonts as the text layers' font menu has them: each with the PostScript name a PSD finds it by
(async () => {
	const t = Date.now();
	const fonts = await installedFonts();
	const find = (ps: string) => fonts.find(f => f.postscript === ps);
	console.log(fonts.length, 'fonts in', Date.now() - t, 'ms');
	for (const ps of ['ArialMT', 'Arial-BoldMT', 'TimesNewRomanPS-BoldMT', 'GillSans-SemiBold', 'Helvetica-Oblique'])
		console.log(ps.padEnd(24), JSON.stringify(find(ps)));
})();
