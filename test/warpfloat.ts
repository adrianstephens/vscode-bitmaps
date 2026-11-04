const {openPage} = require('./pagehost');

// warp of pictures of floats, in the bitmap viewer's page on the real GPU (npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/warpfloat.ts): the GPU's picture of floats is the picture of bytes (the same pixels over 255)
// and the CPU's, a value beyond 1 stays what it was, and a mask of floats is carried as a mask.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const view = await openPage({programs: true, modules: {M: 'modes.js', R: 'raster.js', B: 'transformbox.js', V: '@isopodlabs/maths/vector'}, problems: (m: string) => m.includes('willReadFrequently') || check(false, m)});
	const r = await view.evaluate(() => {
		const {M, R, V} = window as any, {float2, float3, float3x3} = V, area = (w: number, h: number) => new float2.extent(float2(0, 0), float2(w, h));
		const W = 12, H = 9, bytes = new Uint8ClampedArray(W * H * 4), floats = new Float32Array(W * H * 4), big = new Float32Array(W * H * 4);
		for (let i = 0; i < W * H; i++) {
			const v = [(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 80 + (i * 7) % 176];
			bytes.set(v, i * 4);
			floats.set(v.map(c => c / 255), i * 4);
			big.set([v[0] / 255 * 5, v[1] / 255 * 5, v[2] / 255 * 5, v[3] / 255], i * 4);
		}
		const scale = float3x3(float3(2.5, 0, 0), float3(0, 2.5, 0), float3(0, 0, 1)), turn = float3x3(float3(Math.cos(0.4), Math.sin(0.4), 0), float3(-Math.sin(0.4), Math.cos(0.4), 0), float3(8, -2, 1));
		const out: any = {};
		for (const [name, m, a] of [['scale', scale, area(30, 22)], ['turn', turn, area(20, 20)]] as const) {
			const b = M.Mode.warpPixels({data: bytes, width: W, height: H}, m, a), f = M.Mode.warpPixels({data: floats, width: W, height: H}, m, a);
			const c = R.warpCPU({data: floats, width: W, height: H}, m, a);
			let gpu = 0, cpu = 0;
			for (let i = 0; i < f.data.length; i++) {
				gpu = Math.max(gpu, Math.abs(f.data[i] - b.data[i] / 255));
				cpu = Math.max(cpu, Math.abs(f.data[i] - c.data[i]));
			}
			out[name] = {floats: f.data instanceof Float32Array, gpu, cpu, size: [f.width, f.height]};
		}
		const h = M.Mode.warpPixels({data: big, width: W, height: H}, scale, area(30, 22));
		out.max = Math.max(...Array.from(h.data as Float32Array).filter((_, i) => i % 4 === 0));
		const mask = new Float32Array(W * H).fill(7.5), mm = M.Mode.warpPixels({data: mask, width: W, height: H, channels: 1}, scale, area(40, 22), -3);
		out.mask = {floats: mm.data instanceof Float32Array, length: mm.data.length, inside: mm.data[11 * 40 + 15], outside: mm.data[11 * 40 + 38]};

		// the copies: a move with a smaller area is the part of the picture there, a flip into an area that holds only part of it does not
		// wrap what lands beyond it into the next row, and a shear (which is not a copy: it lands between pixels) is the CPU's resampling
		const px = (img: any, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)).join();
		const src = {data: bytes, width: W, height: H}, Mo = M.Mode;
		const moved = Mo.warpPixels(src, float3x3(float3(1, 0, 0), float3(0, 1, 0), float3(-3, -2, 1)), area(4, 4));
		out.moved = [moved.width, moved.height, px(moved, 0, 0) === px(src, 3, 2), px(moved, 3, 3) === px(src, 6, 5)];
		const flipped = Mo.warpPixels(src, float3x3(float3(-1, 0, 0), float3(0, 1, 0), float3(W, 0, 1)), new float2.extent(float2(4, 0), float2(W, H)));
		let wrapped = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W - 4; x++) if (px(flipped, x, y) !== px(src, W - 1 - (x + 4), y)) wrapped++;
		out.flipped = [flipped.width, wrapped];
		const shear = float3x3(float3(1, 0, 0), float3(1, 1, 0), float3(0, 0, 1)), sa = area(24, 9);
		const sh = Mo.warpPixels(src, shear, sa), shc = R.warpCPU(src, shear, sa);
		let d = 0, copy = 0;
		for (let i = 0; i < sh.data.length; i++) d = Math.max(d, Math.abs(sh.data[i] - shc.data[i]));
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px(sh, x + y + 1, y) === px(src, x, y)) copy++;
		out.shear = {diff: d, copy};

		// every flip and quarter turn, by whole pixels, onto the whole of where it lands and onto a part, for bytes, floats and a mask, each as
		// the pixel by pixel reckoning has it
		let wrong = 0, cases = 0;
		const kinds: [string, any][] = [['bytes', {data: bytes, width: W, height: H}], ['floats', {data: floats, width: W, height: H}],
			['mask', {data: bytes.subarray(0, W * H).slice(), width: W, height: H, channels: 1}]];
		for (const [, img] of kinds) {
			const ch = img.channels ?? 4;
			for (const [xx, xy, yx, yy] of [[1, 0, 0, 1], [-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1], [0, 1, 1, 0], [0, -1, 1, 0], [0, 1, -1, 0], [0, -1, -1, 0]]) {
				const m = float3x3(float3(xx, xy, 0), float3(yx, yy, 0), float3(5, -3, 1));
				for (const a of [new float2.extent(float2(-30, -30), float2(40, 40)), new float2.extent(float2(2, -1), float2(9, 8))]) {
					const got = Mo.warpPixels(img, m, a), aw = a.max.x - a.min.x, ah = a.max.y - a.min.y;
					const want = new (img.data.constructor)(aw * ah * ch);
					for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
						const dx = Math.floor(xx * (x + 0.5) + yx * (y + 0.5) + 5) - a.min.x, dy = Math.floor(xy * (x + 0.5) + yy * (y + 0.5) - 3) - a.min.y;
						if (dx >= 0 && dy >= 0 && dx < aw && dy < ah)
							for (let c = 0; c < ch; c++) want[(dy * aw + dx) * ch + c] = img.data[(y * W + x) * ch + c];
					}
					cases++;
					for (let i = 0; i < want.length; i++) if (got.data[i] !== want[i]) { wrong++; break; }
				}
			}
		}
		out.copies = {cases, wrong};
		return out;
	});
	console.log(JSON.stringify(r));
	for (const k of ['scale', 'turn'])
		check(r[k].floats && r[k].gpu < 0.01 && r[k].cpu < 0.01, `${k}: the floats are a picture of floats, as the bytes' and the CPU's are (off by ${r[k].gpu.toFixed(4)}, ${r[k].cpu.toFixed(4)})`);
	check(r.max > 1.5, `a value beyond 1 is not clipped (${r.max.toFixed(2)})`);
	check(r.mask.floats && r.mask.length === 40 * 22 && Math.abs(r.mask.inside - 7.5) < 1e-4 && Math.abs(r.mask.outside + 3) < 1e-4, `a mask of floats is carried as floats, with the outside value beyond it (${JSON.stringify(r.mask)})`);
	check(r.moved.join() === '4,4,true,true', `a move by whole pixels onto a smaller area is the part of the picture there (${r.moved})`);
	check(r.flipped[0] === 8 && r.flipped[1] === 0, `a flip onto an area holding part of it leaves the rest out, with no wrapping (${r.flipped})`);
	check(r.shear.diff <= 3 && r.shear.copy < 12 * 9 / 2, `a shear is resampled as the CPU does it, not copied (off by ${r.shear.diff.toFixed(1)}, ${r.shear.copy} pixels as a copy)`);
	check(r.copies.cases === 48 && r.copies.wrong === 0, `flips and turns by whole pixels are copied as the pixel by pixel reckoning has them, onto the whole and a part (${r.copies.cases} cases, ${r.copies.wrong} wrong)`);
	await view.close();
	process.exit(bad ? 1 : 0);
})();
