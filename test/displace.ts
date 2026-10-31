// texture() and displace(): an image looked up as a function of (u, v), and a shape's surface moved along its normal by a
// function. What is checked: the lookup (pixel centres, between them, repeating and held edges, the rows' order, its slope)
// here and in the shader; displace()'s field (where the surface goes, a step that never passes through it, the body's
// colour kept, the normal it is given) here and in the shader; that it meshes closed; and what is reported.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { float3 } from '@isopodlabs/maths/vector';
import { mesher, checkMesh } from '@isopodlabs/binary_meshes';
import { parse } from '../src/scad/parser';
import { evaluate } from '../src/scad/evaluate';
import { FileReader } from '../src/filereader';
import { SDF, emitGlsl, type Sdf } from '../src/scad/sdf';
import type { ColorFn, DisplaceFn } from '../src/scad/fnsurface';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeShader, close } = require('./webgl.js');

let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL:', what); bad++; } };
const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => Array.from(a).every((v, i) => Math.abs(v - b[i]) <= tol);

let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// a PNG of 8-bit rgba, its rows top down
function png(width: number, height: number, rgba: number[]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(zlib.crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const raw = Buffer.alloc(height * (width * 4 + 1));
	for (let j = 0; j < height; j++)
		raw.set(rgba.slice(j * width * 4, (j + 1) * width * 4), j * (width * 4 + 1) + 1);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'displace-'));
// top row white then half-transparent blue, bottom row red then green: (u, v) = (0.25, 0.25) is the red
fs.writeFileSync(path.join(dir, 't.png'), png(2, 2, [255, 255, 255, 255, 0, 0, 255, 128, 255, 0, 0, 255, 0, 255, 0, 255]));
// a ramp across, for slopes: 8 wide, 1 high, red 0, 32, 64 ...
fs.writeFileSync(path.join(dir, 'ramp.png'), png(8, 1, Array.from({length: 8}, (_, i) => [i * 32, 0, 0, 255]).flat()));

const files = new FileReader();
const run = (source: string) => files.with(() => {
	const r = evaluate(parse(source, path.join(dir, 'main.scad'), files), path.join(dir, 'main.scad'), files, {$preview: false});
	return {sdf: r.sdf, warnings: r.warnings.filter((w: string) => !w.startsWith('$vp'))};
});

function find<K extends Sdf['k']>(s: Sdf, k: K, out: (Sdf & {k: K})[] = []): (Sdf & {k: K})[] {
	if (s.k === k)
		out.push(s as Sdf & {k: K});
	for (const c of (s as {children?: Sdf[]}).children ?? [])
		find(c, k, out);
	const body = (s as {body?: Sdf}).body;
	if (body)
		find(body, k, out);
	return out;
}
const colorFn = (s: Sdf) => find(s, 'material').map(m => m.mat.colorFn).find(f => f) as ColorFn;

// The generated field and colours in the real shader, at points: [map(p).x, map(p).y] or the colour packed in two
async function shaderAt(sdf: Sdf, points: number[][], probe: string): Promise<number[][]> {
	const g = emitGlsl(sdf);
	const code = ['vec3 g_hit;', 'vec3 g_normal;', ...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}', probe].join('\n');
	return (await makeShader(code, 'probe', g.data)).at(points);
}

(async () => {
	//--- the lookup, here --------------------------------------------------------------------------------------------
	{
		const r = await run(`img = texture("t.png"); held = texture("t.png", repeat = false);
			translate([0, 0, 0]) cube(img(0.25, 0.25)[0] + 1);
			translate([10, 0, 0]) cube(img([0.75, 0.25])[1] * 3 + 1);
			color(function(x, y, z) img(x, y)) sphere(1);`);
		check(r.warnings.length === 0, `${r.warnings}`);
		const b = r.sdf.bounds()!;
		check(Math.abs(b.max.y - 4) < 1e-6, `img(0.75, 0.25) is the green, so the second cube is 4: ${b.max.y}`);
		const parts = find(r.sdf.root, 'box');
		check(parts.some(p => Math.abs(p.size.x - 2) < 1e-6), 'img(0.25, 0.25) is the red, so the first cube is 2');
		const fn = colorFn(r.sdf.root);
		check(near(fn.at(0.25, 0.25, 0), [1, 0, 0], 1e-6), `the bottom left pixel is red: ${fn.at(0.25, 0.25, 0)}`);
		check(near(fn.at(0.25, 0.75, 0), [1, 1, 1], 1e-6), `the top left is white: ${fn.at(0.25, 0.75, 0)}`);
		check(near(fn.at(0.5, 0.5, 0), [0.5, 0.5, 0.5], 1e-6), `the middle is the four's mean: ${fn.at(0.5, 0.5, 0)}`);
		check(near(fn.at(1.25, -0.75, 0), [1, 0, 0], 1e-6), `it repeats: ${fn.at(1.25, -0.75, 0)}`);
		check(near(fn.at(0.375, 0.25, 0), [0.75, 0.25, 0], 1e-6), `a quarter of a pixel on is three quarters red: ${fn.at(0.375, 0.25, 0)}`);
		const h = await run(`held = texture("t.png", repeat = false); color(function(x, y, z) held(x, y)) sphere(1);`);
		const hf = colorFn(h.sdf.root);
		check(near(hf.at(-3, 0.25, 0), [1, 0, 0], 1e-6) && near(hf.at(5, 0.25, 0), [0, 1, 0], 1e-6), `held edges: ${hf.at(-3, 0.25, 0)} ${hf.at(5, 0.25, 0)}`);
		console.log('texture(): pixel centres, between them, the rows\' order, repeating and held');

		// and in the shader: colours that are functions of the point, the point anywhere and the image either way
		for (const [what, s, f] of [['repeating', r.sdf.root, fn], ['held', h.sdf.root, hf]] as const) {
			const pts = Array.from({length: 300}, () => [rand() * 4 - 2, rand() * 4 - 2, 0]);
			const got = await shaderAt(s, pts, 'vec2 probe(vec3 p) { g_hit = p; vec3 c = matColor(1.0); return vec2(c.x + 4.0 * c.y, c.z); }');
			let worst = 0;
			pts.forEach((p, i) => {
				const c = f.at(p[0], p[1], p[2]);
				worst = Math.max(worst, Math.abs(got[i][0] - (c[0] + 4 * c[1])), Math.abs(got[i][1] - c[2]));
			});
			check(worst < 1e-4, `${what}: the shader's lookup and the mirror's differ by ${worst}`);
			console.log(`texture() ${what}: shader agrees to ${worst.toExponential(1)}`);
		}
	}

	//--- its slope: what a displacement's step is bounded by --------------------------------------------------------
	{
		const r = await run(`ramp = texture("ramp.png"); displace(function(x, y, z) ramp(x / 8, y)[0] * 3 + 0.1 * x) cube(8);`);
		check(r.warnings.length === 0, `${r.warnings}`);
		const fn = find(r.sdf.root, 'displace')[0].fn as DisplaceFn;
		// inside a pixel the lookup is linear in x: 32/255 across a pixel, which is a unit of x, times 3, and the 0.1
		const want = Math.hypot(32 / 255 * 3 + 0.1, 0);
		let worst = 0;
		for (const x of [1.2, 2.7, 4.1, 5.9])
			worst = Math.max(worst, Math.abs(fn.slope(x, 0.5, 0) - want));
		check(worst < 1e-6, `the slope of a lookup is the pixel's: off by ${worst}`);
		console.log('a lookup\'s slope is the slope between its pixels');
	}

	//--- displace() --------------------------------------------------------------------------------------------------
	{
		const r = await run('displace(function(x, y, z) 0.5) sphere(5);');
		check(r.warnings.length === 0, `${r.warnings}`);
		const s = r.sdf;
		check(Math.abs(s.eval(float3(5.5, 0, 0))) < 1e-9 && Math.abs(s.eval(float3(0, 7, 0)) - 1.5) < 1e-9, 'a constant moves the surface out by it');
		const b = s.bounds()!;
		check(b.max.x >= 5.5 && b.max.x < 5.6, `the box grows with it: ${b.max.x}`);
		check(s.eval(float3(0, 0, 0)) < 0, 'and the middle is inside');

		// h read at the body's surface, as a mesh is displaced: (5, 0, 0) moves out by 0.5. Read where the moved point is,
		// the surface is where x - 5 = 0.1 x instead.
		const at = (await run('displace(function(x, y, z) 0.1 * x) sphere(5);')).sdf, there = (await run('displace(function(x, y, z) 0.1 * x, base = false) sphere(5);')).sdf;
		check(Math.abs(at.eval(float3(5.5, 0, 0))) < 1e-6, `h at the base: the surface at 5.5, not ${at.eval(float3(5.5, 0, 0))} from it`);
		check(Math.abs(there.eval(float3(5 / 0.9, 0, 0))) < 1e-6, `h at the point: the surface at 5.56, not ${there.eval(float3(5 / 0.9, 0, 0))} from it`);
		console.log('displace(): h read at the base point, or with base = false where the point is');
	}
	const wavy = 'displace(function(x, y, z) 0.4 * sin(x * 60) * sin(y * 60) * sin(z * 60)) sphere(5);';
	{
		const r = await run(wavy);
		check(r.warnings.length === 0, `${r.warnings}`);
		const s = r.sdf, body = new SDF({k: 'sphere', r: 5});
		const fn = find(s.root, 'displace')[0].fn as DisplaceFn;
		// the true field: the sphere's distance less h at the point of the sphere under p
		const field = (p: float3) => {
			const q = p.scale(5 / p.len());
			return body.eval(p) - fn.value(q.x, q.y, q.z);
		};
		// The step is a bound: from any point no surface is nearer than it says. Checked as a raymarcher uses it, stepping
		// in from outside on rays through the middle until it reaches the surface: the true field (the body's distance less
		// h) never changes sign on the way, and where it stops is on the surface.
		let crossed = 0, off = 0;
		for (let i = 0; i < 200; i++) {
			const r3 = float3(rand() - 0.5, rand() - 0.5, rand() - 0.5), d = r3.scale(1 / r3.len()), from = d.scale(12);
			let t = 0;
			for (let k = 0; k < 2000; k++) {
				const p = from.sub(d.scale(t)), step = s.eval(p);
				if (field(p) < -1e-6)
					crossed++;
				if (step < 1e-5)
					break;
				t += step;
			}
			off = Math.max(off, Math.abs(field(from.sub(d.scale(t)))));
		}
		check(crossed === 0, `${crossed} steps went through the surface`);
		check(off < 1e-4, `a march ends on the surface, to ${off}`);
		// and how fast the estimate changes is no more than a distance does
		let steep = 0;
		for (let i = 0; i < 20000; i++) {
			const p = float3(rand() * 12 - 6, rand() * 12 - 6, rand() * 12 - 6), q = p.add(float3(rand() - 0.5, rand() - 0.5, rand() - 0.5).scale(0.05));
			steep = Math.max(steep, Math.abs(s.eval(p) - s.eval(q)) / p.sub(q).len());
		}
		check(steep <= 1.0001, `the estimate changes ${steep} per unit`);
		console.log(`displace(): marches onto the surface (to ${off.toExponential(1)}) without passing it; changes ${steep.toFixed(3)} per unit`);

		const mesh = await mesher.meshAdaptive(s, {cells: 64});
		const stats = checkMesh(mesh);
		check(stats.open === 0 && stats.nonManifold === 0 && stats.inconsistent === 0, `the mesh: ${JSON.stringify(stats)}`);
		const ball = 4 / 3 * Math.PI * 125;
		check(Math.abs(stats.volume - ball) / ball < 0.05, `about a ball's volume: ${stats.volume} for ${ball}`);
		console.log(`displace() meshes closed: ${stats.triangles} triangles`);
	}

	//--- the wavy sphere both ways in the shader -------------------------------------------------------------------
	for (const base of [true, false]) {
		const s = (await run(wavy.replace(') sphere', `, base = ${base}) sphere`))).sdf;
		const pts = Array.from({length: 1000}, () => [rand() * 14 - 7, rand() * 14 - 7, rand() * 14 - 7]);
		const got = await shaderAt(s.root, pts, 'vec2 probe(vec3 p) { return map(p); }');
		let worst = 0;
		pts.forEach((p, i) => {
			const want = s.eval(float3(p[0], p[1], p[2]));
			worst = Math.max(worst, Math.abs(got[i][0] - want) / (1 + Math.abs(want)));
		});
		check(worst < 2e-3, `base = ${base}: the shader's field and the mirror's differ by ${worst}`);
		console.log(`displace(base = ${base}): shader agrees to ${worst.toExponential(1)}`);
	}

	//--- with the normal and a texture, coloured, moved: the shader and the mirror ------------------------------------
	{
		const r = await run(`img = texture("t.png");
			translate([3, 1, 0]) rotate([0, 0, 30])
			displace(function(x, y, z, nx, ny, nz) 0.3 * img(atan2(y, x) / 360, z / 10)[0] * (1 - abs(nz)))
			color("red") cylinder(r = 4, h = 10);`);
		check(r.warnings.length === 0, `${r.warnings}`);
		const s = r.sdf;
		const d = find(s.root, 'displace')[0];
		check(d.fn.normal, 'a function of six is given the normal');
		const b = s.bounds()!;
		const pts = Array.from({length: 2000}, () => [0, 1, 2].map(k => b.min[(['x', 'y', 'z'] as const)[k]] - 1 + rand() * (b.max[(['x', 'y', 'z'] as const)[k]] - b.min[(['x', 'y', 'z'] as const)[k]] + 2)));
		const got = await shaderAt(s.root, pts, 'vec2 probe(vec3 p) { return map(p); }');
		let worst = 0, wrongColour = 0;
		pts.forEach((p, i) => {
			const want = s.eval(float3(p[0], p[1], p[2]));
			worst = Math.max(worst, Math.abs(got[i][0] - want) / (1 + Math.abs(want)));
			if (Math.abs(want) < 0.5 && Math.round(got[i][1]) !== s.material(float3(p[0], p[1], p[2])))
				wrongColour++;
		});
		check(worst < 2e-3, `the shader's field and the mirror's differ by ${worst}`);
		check(wrongColour === 0, `${wrongColour} points near the surface have another colour`);
		check(s.material(float3(3, 1, 5)) === 1, 'the body\'s colour shows through');
		// the side of the cylinder moves by the red of the image there, its caps (nz = 1) not at all
		const capTop = s.eval(float3(3, 1, 10));
		check(Math.abs(capTop) < 1e-6, `the top cap does not move: ${capTop}`);
		console.log(`displace() with the normal and a texture: shader agrees to ${worst.toExponential(1)}`);
	}

	//--- what is reported --------------------------------------------------------------------------------------------
	for (const [source, what] of [
		['displace(3) cube(1);', 'not a function'],
		['displace(function(x, y, z) [x, y]) cube(1);', 'a vector'],
		['displace(function(x, y) x) cube(1);', 'too few parameters'],
		['displace(function(x, y, z) 1) square(1);', 'a 2-D shape'],
		['img = texture("nosuch.png"); color(function(x, y, z) img(x, y)) cube(1);', 'a missing image'],
		['img = texture("t.png"); color(img) cube(1);', 'a texture as a colour, which takes (u, v)'],
		['img = texture("t.png"); color(function(x, y, z) img(x)) cube(1);', 'a lookup without v'],
	]) {
		const r = await run(source);
		check(r.warnings.length > 0, `${what} should be reported`);
	}
	console.log('errors are reported');

	await close();
	fs.rmSync(dir, {recursive: true});
	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exit(bad ? 1 : 0);
})();
