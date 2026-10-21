// surface(): a .dat or PNG heightmap, as OpenSCAD's SurfaceNode.cc builds it -- each cell four triangles meeting at
// the mean of its corners, over a floor one below the lowest height. The field is a bound rather than the distance
// (see heightmap() in sdf.ts), so what is checked is what a bound owes: the right sign everywhere, the surface exactly
// where the heights say, never further than the real distance to OpenSCAD's own triangles, and a mesh with the volume
// the triangles enclose. The shader has to agree with the mirror, and a PNG of every colour type and bit depth has to
// read as the brightness its samples say.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { FileReader } = require('../out/src/scad/filereader.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');
const { float3 } = require('@isopodlabs/maths/vector');

const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
const files = new FileReader();
const run = (src) => files.with(() => evaluate(src, path.join(dir, 'main.scad'), files));

let seed = 11;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// OpenSCAD's own triangles for a grid, to measure the real distance against
function triangles(rows, bottom) {
	const cols = rows[0].length, tris = [];
	const P = (x, y, z) => [x, y, z];
	for (let i = 1; i < rows.length; i++)
		for (let j = 1; j < cols; j++) {
			const v1 = rows[i - 1][j - 1], v2 = rows[i - 1][j], v3 = rows[i][j - 1], v4 = rows[i][j], vx = (v1 + v2 + v3 + v4) / 4;
			const c = P(j - 0.5, i - 0.5, vx);
			tris.push([P(j - 1, i - 1, v1), P(j, i - 1, v2), c], [P(j, i - 1, v2), P(j, i, v4), c], [P(j, i, v4), P(j - 1, i, v3), c], [P(j - 1, i, v3), P(j - 1, i - 1, v1), c]);
		}
	// the walls and the floor, as triangles too
	const W = cols - 1, H = rows.length - 1;
	const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d]);
	for (let i = 1; i <= H; i++) {
		quad(P(0, i - 1, bottom), P(0, i - 1, rows[i - 1][0]), P(0, i, rows[i][0]), P(0, i, bottom));
		quad(P(W, i - 1, bottom), P(W, i - 1, rows[i - 1][W]), P(W, i, rows[i][W]), P(W, i, bottom));
	}
	for (let j = 1; j <= W; j++) {
		quad(P(j - 1, 0, bottom), P(j - 1, 0, rows[0][j - 1]), P(j, 0, rows[0][j]), P(j, 0, bottom));
		quad(P(j - 1, H, bottom), P(j - 1, H, rows[H][j - 1]), P(j, H, rows[H][j]), P(j, H, bottom));
	}
	quad(P(0, 0, bottom), P(W, 0, bottom), P(W, H, bottom), P(0, H, bottom));
	return tris;
}

// the height of the top surface over (x, y), from whichever of the first `count` triangles (the top ones) lies under
// it, or undefined off the grid: an independent reading of what is inside
function heightUnder(tris, count, x, y) {
	for (let k = 0; k < count; k++) {
		const [a, b, c] = tris[k];
		const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
		const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
		const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
		const l3 = 1 - l1 - l2;
		if (l1 >= -1e-12 && l2 >= -1e-12 && l3 >= -1e-12)
			return l1 * a[2] + l2 * b[2] + l3 * c[2];
	}
	return undefined;
}

// the distance from p to a triangle (Ericson's closest point)
function triDist(p, [a, b, c]) {
	const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	const add = (u, v, s) => [u[0] + v[0] * s, u[1] + v[1] * s, u[2] + v[2] * s];
	const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
	const d1 = dot(ab, ap), d2 = dot(ac, ap);
	let q;
	if (d1 <= 0 && d2 <= 0) q = a;
	else {
		const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
		const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
		const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
		if (d3 >= 0 && d4 <= d3) q = b;
		else if (d6 >= 0 && d5 <= d6) q = c;
		else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = add(a, ab, d1 / (d1 - d3));
		else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = add(a, ac, d2 / (d2 - d6));
		else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) q = add(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
		else { const den = 1 / (va + vb + vc); q = add(add(a, ab, vb * den), ac, vc * den); }
	}
	const d = sub(p, q);
	return Math.sqrt(dot(d, d));
}

// A PNG, written by hand, of any colour type and bit depth, plain or Adam7-interlaced: samplesAt(x, y) gives the
// pixel's samples at that depth (a palette index for type 3), and every row takes the next of the five filters in turn.
const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
function writePng(file, width, height, colour, depth, samplesAt, palette, interlace = false) {
	const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type, body) => {
		const out = Buffer.alloc(12 + body.length);
		out.writeUInt32BE(body.length, 0);
		out.write(type, 4, 'latin1');
		body.copy(out, 8);
		out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
		return out;
	};
	const channels = CHANNELS[colour], bpp = Math.max(1, (channels * depth) >> 3);
	// the filtered rows of a w x h image whose pixel (x, y) is at(x, y)
	const encode = (w, h, at) => {
		const stride = (w * channels * depth + 7) >> 3;
		const plain = Buffer.alloc(h * stride);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				at(x, y).forEach((v, s) => {
					const i = x * channels + s;
					if (depth === 16)
						plain.writeUInt16BE(v, y * stride + i * 2);
					else if (depth === 8)
						plain[y * stride + i] = v;
					else
						plain[y * stride + ((i * depth) >> 3)] |= v << (8 - depth - ((i * depth) & 7));
				});
		const raw = Buffer.alloc(h * (stride + 1));
		for (let y = 0; y < h; y++) {
			const filter = y % 5;
			raw[y * (stride + 1)] = filter;
			for (let x = 0; x < stride; x++) {
				const a = x >= bpp ? plain[y * stride + x - bpp] : 0, b = y > 0 ? plain[(y - 1) * stride + x] : 0, c = y > 0 && x >= bpp ? plain[(y - 1) * stride + x - bpp] : 0;
				const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
				const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
				raw[y * (stride + 1) + 1 + x] = (plain[y * stride + x] - predict) & 0xff;
			}
		}
		return raw;
	};
	const data = interlace
		? Buffer.concat(ADAM7.map(([x0, y0, dx, dy]) => {
			const w = Math.max(0, Math.ceil((width - x0) / dx)), h = Math.max(0, Math.ceil((height - y0) / dy));
			return w && h ? encode(w, h, (x, y) => samplesAt(x0 + x * dx, y0 + y * dy)) : Buffer.alloc(0);
		}))
		: encode(width, height, samplesAt);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colour; ihdr[12] = interlace ? 1 : 0;
	fs.writeFileSync(file, Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
		// a palette's transparency too, which the decode has to parse past (and surface() then ignores, as OpenSCAD does)
		...(palette ? [chunk('PLTE', Buffer.from(palette.flat())), chunk('tRNS', Buffer.from(palette.map((_, i) => 255 - i)))] : []),
		chunk('IDAT', zlib.deflateSync(data)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {

//--- a .dat: where the surface is, what the bound owes, and the volume -------------------------------------
{
	// rough enough that tiles differ: a ridge, a cliff and noise, 30 x 22
	const rows = Array.from({length: 22}, (_, i) => Array.from({length: 30}, (_, j) => Math.sin(j / 3) * 4 + (j > 18 ? 9 : 0) + rand() * 1.5 + i * 0.2));
	fs.writeFileSync(path.join(dir, 'grid.dat'), '# a comment\n\n' + rows.map(r => r.join(' ')).join('\n') + '\n');
	const lowest = Math.min(1, ...rows.flat()), bottom = lowest - 1;
	const { sdf, warnings } = await run('surface("grid.dat");');
	check(warnings.length === 0, `a readable .dat should draw without complaint: ${warnings}`);
	check(sdf.k === 'heightmap' && sdf.cols === 30 && sdf.rows === 22, `the grid should be 30 by 22, not ${sdf.cols} by ${sdf.rows}`);

	// on every grid point and cell centre, the field is zero at the height
	let worstOn = 0;
	for (let i = 0; i < 22; i++)
		for (let j = 0; j < 30; j++)
			worstOn = Math.max(worstOn, Math.abs(evalSdf(sdf, [j, i, rows[i][j]])));
	for (let i = 1; i < 22; i++)
		for (let j = 1; j < 30; j++) {
			const m = (rows[i - 1][j - 1] + rows[i - 1][j] + rows[i][j - 1] + rows[i][j]) / 4;
			worstOn = Math.max(worstOn, Math.abs(evalSdf(sdf, [j - 0.5, i - 0.5, m])));
		}
	check(worstOn < 1e-4, `the surface should pass through every height and cell centre, off by ${worstOn}`);

	// against OpenSCAD's own triangles: the sign right, and never further than the real distance
	const tris = triangles(rows, bottom);
	let over = 0, wrongSign = 0, ratio = 0, n = 0, insideCount = 0;
	for (let k = 0; k < 800; k++) {
		const p = [rand() * 36 - 3, rand() * 28 - 3, bottom - 3 + rand() * 25];
		const d = evalSdf(sdf, p);
		const real = tris.reduce((m, t) => Math.min(m, triDist(p, t)), Infinity);
		const top = heightUnder(tris, 21 * 29 * 4, p[0], p[1]);
		const inside = top !== undefined && p[2] > bottom && p[2] < top;
		insideCount += inside ? 1 : 0;
		if (Math.abs(d) > real + 1e-5)
			over = Math.max(over, Math.abs(d) - real);
		// the sign: a point strictly below the interpolated surface and inside the box is inside
		if ((d < 0) !== inside && real > 1e-6)
			wrongSign++;
		if (d > 0) { ratio += d / real; n++; }
	}
	check(over === 0, `the field should never be further than the real distance, but was by ${over}`);
	check(wrongSign === 0, `${wrongSign} of 800 points on the wrong side`);
	check(insideCount > 100, `only ${insideCount} of the sampled points were inside, too few to test the sign`);
	console.log(`dat: on the surface to ${worstOn.toExponential(1)}; ${insideCount} of 800 samples inside; outside, the bound is ${(100 * ratio / n).toFixed(0)}% of the real distance on average`);

	// the enclosed volume: each cell's four triangles average to its mean height
	let volume = 0;
	for (let i = 1; i < 22; i++)
		for (let j = 1; j < 30; j++)
			volume += (rows[i - 1][j - 1] + rows[i - 1][j] + rows[i][j - 1] + rows[i][j]) / 4 - bottom;
	const stats = checkMesh(await meshUniform(sdf, { cells: 96 }));
	check(Math.abs(stats.volume - volume) / volume < 5e-3, `the mesh should enclose ${volume.toFixed(2)}, not ${stats.volume.toFixed(2)}`);
	console.log(`dat: mesh volume ${stats.volume.toFixed(2)} against ${volume.toFixed(2)}`);

	// center = true puts the grid's middle at the origin
	const { sdf: centred } = await run('surface("grid.dat", center = true);');
	check(Math.abs(evalSdf(centred, [-14.5, -10.5, rows[0][0]])) < 1e-4, 'center = true should put the first height at (-14.5, -10.5)');

	// the shader agrees with the mirror
	const g = emitGlsl(sdf);
	const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
	const pts = Array.from({length: 400}, () => [rand() * 36 - 3, rand() * 28 - 3, bottom - 3 + rand() * 25]);
	const results = await shader.at(pts);
	const worst = pts.reduce((w, p, i) => Math.max(w, Math.abs(results[i][0] - evalSdf(sdf, p))), 0);
	check(worst < 1e-3, `the shader and the mirror differ by ${worst}`);
	console.log(`dat: shader agrees to ${worst.toExponential(1)}`);
}

//--- a PNG: every colour type and depth, the orientation, invert -------------------------------------------
{
	const W = 13, H = 7;
	const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const palette = Array.from({length: 256}, (_, i) => [(i * 37) & 0xff, (i * 91) & 0xff, (i * 13) & 0xff]);
	// each case: colour type, depth, and a pixel's samples at that depth -- varied enough in every channel that a
	// sample read from the wrong place, at the wrong depth or with the wrong scale would show
	const cases = [];
	for (const depth of [1, 2, 4, 8, 16])
		cases.push([0, depth]);
	for (const depth of [1, 2, 4, 8])
		cases.push([3, depth]);
	for (const colour of [2, 4, 6])
		for (const depth of [8, 16])
			cases.push([colour, depth]);
	// each read by surface() itself, plain and interlaced: the pixel at (x, y) should stand at (x, H - 1 - y), 100 times
	// its brightness high -- exactly, bar float32 rounding, since the brightness comes as unrounded floats
	let worst = 0;
	for (const [colour, depth] of cases)
		for (const interlace of [false, true]) {
			const max = (1 << depth) - 1, channels = CHANNELS[colour];
			const samplesAt = (x, y) => Array.from({length: channels}, (_, s) => (x * 7919 + y * 104729 + s * 15485863 + x * y * 31) % (max + 1));
			const expected = (x, y) => {
				const v = samplesAt(x, y);
				if (colour === 3)
					return luma(...palette[v[0]]) / 255;
				return channels >= 3 ? luma(v[0], v[1], v[2]) / max : v[0] / max;
			};
			const name = `type${colour}-${depth}${interlace ? '-interlaced' : ''}.png`;
			writePng(path.join(dir, name), W, H, colour, depth, samplesAt, colour === 3 ? palette.slice(0, max + 1) : undefined, interlace);
			const { sdf, warnings } = await run(`surface("${name}");`);
			if (sdf.k !== 'heightmap') {
				check(false, `${name} should draw: ${warnings}`);
				continue;
			}
			let off = 0;
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++)
					off = Math.max(off, Math.abs(evalSdf(sdf, [x, H - 1 - y, 100 * expected(x, y)])));
			check(off < 2e-5, `${name} stands off its heights by ${off}`);
			worst = Math.max(worst, off);
		}

	// an image smaller than Adam7's 8 x 8 tile has passes with no pixels, which carry no rows at all
	{
		const tiny = (x, y) => [[10, 200, 30], [255, 0, 90]][y][x];
		writePng(path.join(dir, 'tiny.png'), 3, 2, 0, 8, (x, y) => [tiny(x, y)], undefined, true);
		const { sdf } = await run('surface("tiny.png");');
		let off = 0;
		for (let y = 0; y < 2; y++)
			for (let x = 0; x < 3; x++)
				off = Math.max(off, Math.abs(evalSdf(sdf, [x, 1 - y, 100 * tiny(x, y) / 255])));
		check(off < 2e-5, `an interlaced 3 x 2 image with empty passes stands off its heights by ${off}`);
	}

	// OpenSCAD's orientation: the image's top row is furthest along y, and heights run 0..100 by brightness -- at the
	// full 16 bits, which a byte per sample would round to steps of 100 / 255
	const samplesAt = (x, y) => [(x * 4099 + y * 1543) % 65536];
	writePng(path.join(dir, 'image.png'), W, H, 0, 16, samplesAt);
	const heightOf = (x, y) => 100 * samplesAt(x, y)[0] / 65535;
	const { sdf, warnings } = await run('surface("image.png");');
	check(warnings.length === 0, `a PNG should draw without complaint: ${warnings}`);
	let off = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			off = Math.max(off, Math.abs(evalSdf(sdf, [x, H - 1 - y, heightOf(x, y)])));
	check(off < 1e-3, `pixel (x, y) should stand at (x, ${H - 1} - y) at its full 16-bit height, off by ${off}`);
	const { sdf: inverted } = await run('surface("image.png", invert = true);');
	check(Math.abs(evalSdf(inverted, [3, H - 1 - 4, -heightOf(3, 4)])) < 1e-3, 'invert = true should make the heights negative');
	console.log(`png: ${cases.length} colour types and depths, plain and interlaced, stand at their heights to ${worst.toExponential(1)}; 16-bit to ${off.toExponential(1)}`);
}

//--- what it says when it cannot --------------------------------------------------------------------------
{
	const missing = await run('surface("nowhere.dat");');
	check(missing.sdf.k === 'empty' && missing.warnings.some(w => w.includes('not found')), 'a missing file should be reported');
	fs.writeFileSync(path.join(dir, 'bad.dat'), '1 2 3\n4 five 6\n');
	const badValue = await run('surface("bad.dat");');
	check(badValue.warnings.some(w => w.includes('not a number')), 'a non-number in a .dat should be reported');
	fs.writeFileSync(path.join(dir, 'one.dat'), '1 2 3\n');
	const oneRow = await run('surface("one.dat");');
	check(oneRow.warnings.some(w => w.includes('fewer than two')), 'a single row should be reported as no surface');
	console.log('reports: checked');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'ok: surface() stands where its heights say, bounds3 its distance honestly, and reads .dat and PNG');
await close();
process.exit(bad ? 1 : 0);

})();
