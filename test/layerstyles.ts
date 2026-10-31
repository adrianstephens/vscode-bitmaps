import * as fs from 'fs';
import * as path from 'path';

// The GPU's shadows, glows and overlays (layerfx.ts) over a square, in headless Chrome, read back and checked at points in and
// around it: a drop shadow falls beneath the layer, down and to the right of a light at 120 degrees; an inner shadow lies inside the edge.
const ROOT = path.join(__dirname, '..');
const {openPage} = require('./pagehost');

(async () => {
	const view = await openPage({modules: {gl: 'opengl.js', fx: 'layerfx.js', R: 'raster.js', V: '@isopodlabs/maths/vector'}}), {page} = view;
	await page.evaluate(() => { const c = document.createElement('canvas'); c.id = 'c'; c.width = c.height = 64; document.body.appendChild(c); });

	const code = {vert: fs.readFileSync(path.join(ROOT, 'assets/bitmap.vert'), 'utf8'), frag: fs.readFileSync(path.join(ROOT, 'assets/effect.frag'), 'utf8')};

	let bad = 0;
	const check = (what: string, ok: boolean) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

	type Out = {left: number, top: number, width: number, height: number, data: number[], ms: number};
	// a square of 60 at (50, 50) on a canvas of 160 (or of `canvas`), with the style (the rest of its spec)
	const run = (spec: Record<string, unknown>, canvas = 160, side = 60, at = 50): Promise<Out | null> => page.evaluate((code: any, spec: any, canvas: number, side: number, at: number) => {
		const w = globalThis as any, document = w.document;
		const c3 = new w.gl.Canvas3D(document.getElementById('c'), {depth: false});
		const program = c3.createProgram(code, w.gl.rectGeometry);
		const r = new w.fx.EffectRenderer(c3, program);
		const alpha = new Uint8ClampedArray(side * side).fill(255);
		spec.shape = new w.R.Shape(new w.V.float2.extent(w.V.float2(at, at), w.V.float2(at + side, at + side)), alpha);
		const t = performance.now();
		const texture = r.render(spec, canvas, canvas);
		const ext = w.fx.effectRegion(spec, canvas, canvas), region = ext && {left: ext.min.x, top: ext.min.y, width: ext.max.x - ext.min.x, height: ext.max.y - ext.min.y};
		if (!texture) return null;
		const gl = c3.gl;
		const fb = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		const data = new Uint8Array(region.width * region.height * 4);
		gl.readPixels(0, 0, region.width, region.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
		const ms = Math.round(performance.now() - t);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return {...region, data: Array.from(data), ms};
	}, code, spec, canvas, side, at);
	const alphaAt = (e: Out, x: number, y: number) => {
		const dx = x - e.left, dy = y - e.top;
		return dx < 0 || dy < 0 || dx >= e.width || dy >= e.height ? 0 : e.data[(dy * e.width + dx) * 4 + 3];
	};
	const red = (e: Out, x: number, y: number) => e.data[((y - e.top) * e.width + x - e.left) * 4];

	const rad = (deg: number) => deg * Math.PI / 180;
	const shadow = (inside: boolean, angle: number, distance: number, size: number, more: Record<string, unknown> = {}) => ({
		kind: 'shadow', inside, colour: {r: 0, g: 0, b: 0}, dx: -Math.cos(rad(angle)) * distance, dy: Math.sin(rad(angle)) * distance, size, spread: 0, knockout: !inside, ...more,
	});
	const glow = (inside: boolean, size: number, more: Record<string, unknown> = {}) => ({kind: 'glow', inside, colour: {r: 0, g: 0, b: 255}, dx: 0, dy: 0, size, spread: 0, range: 0.5, ...more});

	let e = (await run(shadow(false, 120, 10, 8)))!;
	check('a drop shadow is made', !!e);
	check('drop shadow is knocked out under the layer', alphaAt(e, 80, 80) === 0);
	check('drop shadow falls to the lower right', alphaAt(e, 112, 112) > alphaAt(e, 48, 48) + 40);
	check('drop shadow does not reach the far upper left', alphaAt(e, 30, 30) === 0);

	e = (await run(shadow(false, 120, 0, 0, {knockout: false})))!;
	check('without knockout the shadow shows under the layer', alphaAt(e, 80, 80) === 255);
	e = (await run(shadow(false, 120, 20, 0, {knockout: false})))!;
	check('a hard shadow is the shape shifted (10 right, 17 down)', alphaAt(e, 118, 115) === 255 && alphaAt(e, 121, 115) === 0 && alphaAt(e, 100, 126) === 255 && alphaAt(e, 100, 128) === 0 && alphaAt(e, 55, 80) === 0);

	e = (await run(shadow(false, 120, 0, 10, {spread: 5, knockout: false})))!;
	const plain = (await run(shadow(false, 120, 0, 10, {knockout: false})))!;
	check('spread makes the shadow stronger at the edge and reach further', alphaAt(e, 46, 80) > alphaAt(plain, 46, 80) && alphaAt(e, 40, 80) > alphaAt(plain, 40, 80));

	e = (await run(shadow(true, 120, 6, 6)))!;
	check('inner shadow is made over the shape only', e.left === 50 && e.width === 60 && alphaAt(e, 52, 52) > 40 && alphaAt(e, 80, 80) < 5);

	e = (await run(glow(false, 10)))!;
	check('outer glow is full strength at the edge with a range of 50%', alphaAt(e, 49, 80) > 220);
	check('outer glow falls off outside the edge', alphaAt(e, 49, 80) > alphaAt(e, 40, 80) && alphaAt(e, 40, 80) > alphaAt(e, 30, 80));
	check('outer glow is in its colour', red(e, 49, 80) === 0 && e.data[((80 - e.top) * e.width + 49 - e.left) * 4 + 2] === 255);
	e = (await run(glow(false, 10, {range: 1})))!;
	check('with a range of 100% it is only half strength there', Math.abs(alphaAt(e, 49, 80) - 128) < 30);
	e = (await run(glow(false, 10, {precise: true})))!;
	check('precise outer glow falls off to nothing', alphaAt(e, 48, 80) > alphaAt(e, 42, 80) && alphaAt(e, 35, 80) === 0);
	e = (await run(glow(true, 10)))!;
	check('inner glow is brightest at the edge', alphaAt(e, 51, 80) > alphaAt(e, 60, 80) && alphaAt(e, 80, 80) < 5);
	e = (await run(glow(true, 10, {centre: true})))!;
	check('centre inner glow is brightest in the middle', alphaAt(e, 80, 80) > alphaAt(e, 52, 80));

	e = (await run({kind: 'fill', inside: true, colour: {r: 255, g: 0, b: 0}, dx: 0, dy: 0, size: 0, spread: 0}))!;
	check('colour overlay is the shape in the colour', alphaAt(e, 80, 80) === 255 && alphaAt(e, 49, 80) === 0 && red(e, 80, 80) === 255);

	// a bevel lit from above (90 degrees, altitude 30): the highlight is on the top edge, the shadow on the bottom, and the sides get a little shadow
	const bevel = (highlight: boolean, more: Record<string, unknown> = {}) => ({
		kind: 'bevel', inside: true, colour: highlight ? {r: 255, g: 255, b: 255} : {r: 0, g: 0, b: 0}, dx: 0, dy: 0, size: 20, spread: 0,
		bevel: {depth: 22, altitude: 30, angle: 90, direction: 1, highlight, mask: 'inside', ...more},
	});
	const hi = (await run(bevel(true)))!, sh = (await run(bevel(false)))!;
	check('a bevel highlight is on the top edge', alphaAt(hi, 80, 51) > 200 && alphaAt(hi, 80, 108) === 0 && alphaAt(hi, 80, 80) === 0);
	check('a bevel shadow is on the bottom edge, and fully dark at it', alphaAt(sh, 80, 108) === 255 && alphaAt(sh, 80, 51) === 0 && alphaAt(sh, 80, 80) === 0);
	check('a bevel shadow is on the sides, less than at the bottom', alphaAt(sh, 51, 80) > 30 && alphaAt(sh, 51, 80) < alphaAt(sh, 80, 108));
	check('a bevel ends where its size does', alphaAt(hi, 80, 50 + 22) === 0 && alphaAt(hi, 80, 50 + 10) > 60);
	const down = (await run(bevel(true, {direction: -1})))!;
	check('a bevel that is down has its highlight on the bottom edge', alphaAt(down, 80, 108) > 200 && alphaAt(down, 80, 51) === 0);
	const outer = (await run({...bevel(true, {mask: 'outside'}), inside: false}))!;
	check('an outer bevel is outside the shape', alphaAt(outer, 80, 80) === 0 && alphaAt(outer, 80, 48) > 40);

	// a contour that inverts the falloff
	e = (await run(shadow(false, 120, 0, 10, {knockout: false, contour: [{x: 0, y: 1}, {x: 1, y: 0}]})))!;
	check('a contour reshapes the falloff', alphaAt(e, 36, 80) > 200 && alphaAt(e, 40, 80) > alphaAt(e, 49, 80));

	// the whole of a big canvas with a wide shadow and spread: what the slow way took many seconds
	const big = (await run(shadow(false, 120, 40, 120, {spread: 60}), 2400, 2200, 100))!;
	check(`a 2200 pixel shape with a 120 pixel shadow and spread is made (${big?.ms} ms)`, !!big && alphaAt(big, 1300, 1300) === 0 && alphaAt(big, 2350, 2350) > 10);

	await view.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})();
