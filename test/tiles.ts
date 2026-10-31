// An operation on an image whose size is not a multiple of the tile: reset puts back exactly what was there, and commit finds only what changed (raster.ts Tiles)
// Run in a page (pagehost.js), where the viewer's modules load as it has them. Run: npx tsc -b, then npx ts-node test/<this>.ts
const {openPage} = require('./pagehost');

(async () => {
	const view = await openPage({modules: {R: 'raster.js'}});
	const out: string[] = await view.page.evaluate(() => {
		const {R: {Tiles}} = window as any;
		const log: string[] = [];
		const W = 100, H = 70;
		const data = new Uint8ClampedArray(W * H * 4).map((_, i) => (i * 7) & 255);
		const image = {width: W, height: H, data} as any;
		const original = data.slice();

		class T extends Tiles {
			touch(x: number, y: number) { const t = this.tile(x, y); data[(y * W + x) * 4] = 255 - data[(y * W + x) * 4]; return t; }
			patch() { return this.commit(); }
		}
		const t = new T(image);
		t.touch(90, 65);
		t.touch(10, 10);
		const changed = t.patch()!.tiles.length;
		t.reset();
		let bad = data.some((v, i) => v !== original[i]) ? 1 : 0;
		if (changed !== 2) { log.push(`   FAIL: tiles changed ${changed}`); bad++; }
		if (bad) { log.push('   FAIL: reset did not restore the image'); return log; }

		// drawn again after a reset (a shape being dragged out), the tile is still all of what it was
		class U extends Tiles {
			put(x: number, y: number) { const t = this.tile(x, y); const i = (y - t.min.y) * (t.max.x - t.min.x) + (x - t.min.x); data[(y * W + x) * 4 + 1] = t.before[i * 4 + 1] ^ 1; }
			extents() { return [...this.tiles.values()].map(t => `${t.min.x},${t.min.y}-${t.max.x},${t.max.y}`).join(' '); }
		}
		const u = new U(image);
		u.put(5, 5);
		const before = u.extents();
		u.reset();
		u.take();
		(u as any).dirty = undefined;
		u.reset();
		(u as any).dirty.max.y = 9999;
		if (u.extents() !== before) { log.push(`   FAIL: the dirty area is the tile ${before} ${u.extents()}`); return log; }
		log.push('tiles ok');
		return log;
	});
	console.log(out.join('\n'));
	await view.close();
	process.exitCode = out.some(l => l.includes('FAIL')) ? 1 : 0;
})();
