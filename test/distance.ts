// a disc: the band round its edge is as wide as it was asked to be, on the side it was asked for (raster.ts distanceTo, strokeAlpha)
// Run in a page (pagehost.js), where the viewer's modules load as it has them. Run: npx tsc -b, then npx ts-node test/<this>.ts
const {openPage} = require('./pagehost');

(async () => {
	const view = await openPage({modules: {R: 'raster.js'}});
	const out: string[] = await view.page.evaluate(() => {
		const {R: {distanceTo, strokeAlpha}} = window as any;
		const log: string[] = [];
		const n = 101, r = 30, cx = 50, cy = 50;
		const alpha = new Uint8Array(n * n);
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) alpha[y * n + x] = Math.hypot(x - cx, y - cy) <= r ? 255 : 0;
		let bad = 0;
		const check = (ok: boolean, what: string) => { if (!ok) { log.push('FAIL: ' + what); bad++; } };

		const d = distanceTo(i => alpha[i] > 0, n, n);
		check(d[cy * n + cx] === 0 && Math.abs(d[cy * n + (cx + r + 10)] - 10) < 1.01, 'distance to the disc');

		for (const align of ['outside', 'inside', 'center'] as const) {
			const s = strokeAlpha(alpha, n, n, 10, align);
			// along the row through the middle: the band's width, and where it lies
			let lo = Infinity, hi = -Infinity, total = 0;
			for (let x = 0; x < n; x++) { const v = s[cy * n + x] / 255; total += v; if (v > 0.5) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }
			const expect = {outside: [cx + r, cx + r + 10], inside: [cx + r - 10, cx + r], center: [cx + r - 5, cx + r + 5]}[align];
			// (the row crosses the band twice, on the left and the right)
			log.push(`${align.padEnd(8)} covered ${total.toFixed(1)} pixels of the row (about ${(2 * 10).toFixed(0)} expected), band from x=${lo} to ${hi}`);
			check(Math.abs(total - 20) < 2.5, `${align}: width`);
			check(hi >= expect[1] - 1 && hi <= expect[1] + 1.5, `${align}: outer edge at ${expect[1]}, found ${hi}`);
		}
		log.push(bad ? `${bad} problems` : 'morph ok');
		return log;
	});
	console.log(out.join('\n'));
	await view.close();
	process.exitCode = out.some(l => l.includes('FAIL')) ? 1 : 0;
})();
