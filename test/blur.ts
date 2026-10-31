// The GPU's gaussian blur (blur.frag, through raster.ts's blur and blurMask) against the plain sum: every pixel the weighted sum of the
// ones round it, in two dimensions at once. Run in a page (pagehost.js), where the viewer's modules load as it has them.
// Run: npx tsc -b, then npx ts-node test/<this>.ts
import * as fs from 'fs';
import * as path from 'path';
const {openPage} = require('./pagehost');

const asset = (n: string) => fs.readFileSync(path.join(__dirname, '..', 'assets', n), 'utf8');

(async () => {
	const view = await openPage({modules: {R: 'raster.js', gl: 'opengl.js', V: '@isopodlabs/maths/vector'}});
	await view.page.evaluate(() => { const c = document.createElement('canvas'); c.id = 'c'; c.width = c.height = 64; document.body.appendChild(c); });
	const out: string[] = await view.page.evaluate((code: any) => {
		const {R: {blur, blurMask, featherReach}, gl: {Canvas3D, rectGeometry}, V: {float2}} = window as any;
		const log: string[] = [];
		let bad = 0;
		const check = (ok: boolean, what: string) => { if (!ok) { log.push('FAIL: ' + what); bad++; } };
		let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

		const c3 = new Canvas3D(document.getElementById('c'), {depth: false});
		const program = c3.createProgram(code, rectGeometry);
		const whole = (w: number, h: number) => new float2.extent(float2(0, 0), float2(w, h));

		// the sum itself: beyond the edges, `fill` (with 'zero') or the edge's own value
		function direct(f: ArrayLike<number>, w: number, h: number, sigma: number, channels: number, edge: 'zero' | 'clamp', fill = 0) {
			const rad = Math.max(1, Math.ceil(sigma * 3)), k: number[] = [];
			let sum = 0;
			for (let i = -rad; i <= rad; i++) sum += k[i + rad] = Math.exp(-i * i / (2 * sigma * sigma));
			const out = new Float32Array(w * h * channels);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) {
				let a = 0;
				for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) {
					let xx = x + i, yy = y + j, v: number;
					if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
						if (edge === 'zero') {
							a += fill * k[i + rad] * k[j + rad];
							continue;
						}
						xx = Math.min(w - 1, Math.max(0, xx)); yy = Math.min(h - 1, Math.max(0, yy));
					}
					v = f[(yy * w + xx) * channels + c];
					a += v * k[i + rad] * k[j + rad];
				}
				out[(y * w + x) * channels + c] = a / (sum * sum);
			}
			return out;
		}
		const worstOf = (got: ArrayLike<number>, want: ArrayLike<number>) => Array.from(got).reduce((m, v, i) => Math.max(m, Math.abs(v - want[i])), 0);

		// values (a mask's, or opaque colours, where the alpha weighting changes nothing), either way at the edges
		for (const edge of ['zero', 'clamp'] as const) for (const [w, h, sigma, channels] of [[12, 9, 1.5, 1], [20, 14, 3, 4], [5, 5, 4, 1], [40, 7, 2, 4]] as const) {
			const data = new Uint8ClampedArray(w * h * channels).map((_, i) => channels === 4 && i % 4 === 3 ? 255 : rnd() * 255);
			const got = blur(c3, program, {data, width: w, height: h, channels: channels === 1 ? 1 : undefined}, whole(w, h), sigma, edge);
			const want = direct(data, w, h, sigma, channels, edge);
			if (channels === 4 && edge === 'zero')		// (beyond the edge is transparent, so the colour is the edge's and only the alpha fades)
				continue;
			const worst = got ? worstOf(got.data, want) : Infinity;
			check(worst <= 1.5, `${edge} ${w}x${h} sigma ${sigma} x${channels}: differs by ${worst}`);
		}

		// a flat colour stays as it is with the edges taken as the edge, and fades with them taken as zero
		const flat = new Uint8ClampedArray(16 * 16).fill(100), mask = {data: flat, width: 16, height: 16, channels: 1};
		const kept = blur(c3, program, mask, whole(16, 16), 2, 'clamp'), faded = blur(c3, program, mask, whole(16, 16), 2, 'zero');
		check(!!kept && kept.data.every((v: number) => Math.abs(v - 100) <= 1), 'flat stays flat with clamped edges');
		check(!!faded && faded.data[0] < 40 && Math.abs(faded.data[8 * 16 + 8] - 100) <= 1, `flat fades at the edge with zero beyond it (${faded?.data[0]})`);

		// pixels: weighted by alpha, so a transparent neighbour does not darken a colour
		const w = 8, h = 8, data = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 4 ? [200, 50, 20, 255] : [0, 0, 0, 0], (y * w + x) * 4);
		const image = {data, width: w, height: h}, all = blur(c3, program, image, whole(w, h), 1.5);
		const at = (x: number, y: number) => Array.from(all.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)) as number[];
		check(at(3, 4)[3] > 100 && at(3, 4)[3] < 255 && Math.abs(at(3, 4)[0] - 200) <= 1 && Math.abs(at(3, 4)[1] - 50) <= 1, `colour kept where alpha fades: ${at(3, 4)}`);
		check(at(7, 4)[3] < 5, `far side stays clear: ${at(7, 4)}`);
		const part = blur(c3, program, image, new float2.extent(float2(2, 2), float2(6, 6)), 1.5);
		check(part?.width === 4 && part.height === 4 && Array.from(part.data.subarray(0, 4)).join() === at(2, 2).join(), 'a part of the image is the same as in the whole');

		// a mask blurred where it lies, what is beyond its pixels being its default: into a rectangle as much bigger as the blur reaches
		for (const [mw, mh, sigma, outside] of [[10, 8, 2, 0], [6, 12, 1.2, 255], [20, 20, 3.5, 90]] as const) {
			const values = new Uint8ClampedArray(mw * mh).map(() => rnd() * 255);
			const texture = c3.createTexture(mw, mh, values, {format: 'r8', min: 'nearest', mag: 'nearest'});
			const soft = blurMask(c3, program, texture, mw, mh, sigma, outside / 255);
			const reach = featherReach({feather: sigma, image: {width: mw, height: mh}}), bw = mw + reach * 2, bh = mh + reach * 2;
			if (!soft) {
				check(false, `the mask ${mw}x${mh} could not be blurred`);
				continue;
			}
			const read = soft.readPixels(), got = new Float32Array(bw * bh);
			for (let i = 0; i < got.length; i++)
				got[i] = read[i * 4];
			const padded = new Float32Array(bw * bh).fill(outside);
			for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) padded[(y + reach) * bw + x + reach] = values[y * mw + x];
			const worst = worstOf(got, direct(padded, bw, bh, sigma, 1, 'zero', outside));
			check(read.length === bw * bh * 4 && worst <= 1.5, `a mask ${mw}x${mh}, sigma ${sigma}, ${outside} beyond it: ${read.length / 4} pixels for ${bw}x${bh}, differs by ${worst}`);
			soft.delete();
			c3.deleteTexture(texture);
		}

		log.push(bad ? `${bad} problems` : 'blur ok');
		return log;
	}, {vert: asset('bitmap.vert'), frag: asset('blur.frag')});
	console.log(out.join('\n'));
	await view.close();
	process.exitCode = out.some(l => l.includes('FAIL')) ? 1 : 0;
})();
