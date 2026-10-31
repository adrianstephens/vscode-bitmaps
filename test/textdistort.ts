import { glyphOutlines } from '../src/fonts';

// Text carried by a free distort (textedit.ts distortText): the transform and the warp's two distortions it finds put the corners of the text's
// extent where the map put them, and the text drawn that way has its pixels at the map's corners; and a text layer's outlines (from the fonts, by
// the extension) carried by textCurve come where the drawn text is. Run: npx tsc -p webview/tsconfig.json, then npx ts-node test/textdistort.ts
const {openPage} = require('./pagehost');
let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const view = await openPage({modules: {t: 'textedit.js?internals', s: 'shapeedit.js', v: '@isopodlabs/maths/vector'}, programs: true}), {page} = view;

	await page.evaluate(() => { (window as any).make = () => (window as any).t.readText((window as any).t.newTextBlocks('Hello World', (window as any).v.float2(30, 90), (window as any).t.defaultStyle('ArialMT', 40, {r: 0, g: 0, b: 0}), 0)); });
	// the map: a mild projective one (a keystone and a shear, a little perspective)
	const MAP = '({x, y}) => { const z = 1 + 0.0006 * x + 0.0004 * y; return window.v.float2((0.95 * x + 0.12 * y + 10) / z, (0.05 * x + 1.02 * y + 6) / z); }';

	// 1: after a distort the corners of the text's extent are where the map puts them
	const r1 = await page.evaluate((mapSrc: string) => {
		const t = (window as any).t, v = (window as any).v, spec = (window as any).make(), map = eval(mapSrc);
		const layout = t.layoutText(spec), c = layout.area.centre(), half = layout.area.size().scale(0.5);
		const corner = (s: any, x: number, y: number) => {
			const q = c.add(v.float2(x, y).mul(half)), P = s.warp ? t.warpFunction(s.warp, layout.area)(q) : q, [a, b, c2, d, e, f] = s.transform, tx = P.x, ty = P.y;
			return v.float2(a * tx + c2 * ty + e, b * tx + d * ty + f);
		};
		const before = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => corner(spec, x, y));
		const ok = t.distortText(spec, layout, map);
		const after = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => corner(spec, x, y));
		const want = before.map((p: any) => map(p));
		const err = Math.max(...after.map((p: any, i: number) => Math.hypot(p.x - want[i].x, p.y - want[i].y)));
		return {ok, err, warp: spec.warp, transform: spec.transform};
	}, MAP);
	check(r1.ok, 'a mild distort is carried by the transform and the warp');
	check(r1.err < 1e-6, `its corners are where the map put them (error ${r1.err})`);
	check(!!r1.warp && r1.warp.bend === 0 && (r1.warp.horizontal !== 0 || r1.warp.vertical !== 0), `the warp is a distortion only ${JSON.stringify(r1.warp)}`);

	// 2: a bend is not something a distort can be added to
	const r2 = await page.evaluate(() => { const t = (window as any).t, spec = (window as any).make(); spec.warp = {style: 'warpArc', bend: 50, horizontal: 0, vertical: 0, down: false}; const was = JSON.stringify(spec); return {ok: t.distortText(spec, t.layoutText(spec), (p: any) => (window as any).v.float2(p.x + 0.2 * p.y * p.y / 100, p.y)), same: JSON.stringify(spec) === was}; });
	check(!r2.ok && r2.same, 'a text that is bent is refused, and left as it was');

	// 3: the outlines the extension draws come where the text is drawn
	const spec = await page.evaluate(() => JSON.stringify((window as any).t.glyphRuns((window as any).make())));
	const {runs} = JSON.parse(spec);
	const outline = await glyphOutlines(runs);
	check(outline.missing === 0 && outline.curve.length > 0, `the fonts gave outlines (${outline.curve.length} points, ${outline.missing} missing)`);
	const r3 = await page.evaluate((curve: any[], mapSrc: string) => {
		const t = (window as any).t, spec = (window as any).make();
		for (const distort of [false, true]) {
			if (distort && !t.distortText(spec, t.layoutText(spec), eval(mapSrc)))
				return {error: 'no distort'};
			if (distort)
				break;
		}
		const {left, top, image: img} = t.renderText(spec, t.layoutText(spec)), alpha = (x: number, y: number) => { let m = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const X = Math.round(x) - left + i, Y = Math.round(y) - top + j; if (X >= 0 && Y >= 0 && X < img.width && Y < img.height) m = Math.max(m, img.data[(Y * img.width + X) * 4 + 3]); } return m; };
		const pts = t.textCurve(spec, curve).filter((v: any) => v.flags === 1);
		const near = pts.filter((v: any) => alpha(v.x, v.y) > 40).length;
		return {n: pts.length, near};
	}, outline.curve, MAP);
	check(!r3.error && r3.near >= r3.n * 0.95, `the outlines' points are on the drawn, distorted text (${r3.near}/${r3.n})`);
	// 4: bent text (the outlines cut into pieces and bent) is where the drawn bent text is; and the shape's vector mask has the contours back
	const r4 = await page.evaluate((curve: any[]) => {
		const t = (window as any).t, s = (window as any).s, spec = (window as any).make();
		spec.warp = {style: 'warpArc', bend: 40, horizontal: 0, vertical: 0, down: false};
		const {left, top, image: img} = t.renderText(spec, t.layoutText(spec)), alpha = (x: number, y: number) => { let m = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const X = Math.round(x) - left + i, Y = Math.round(y) - top + j; if (X >= 0 && Y >= 0 && X < img.width && Y < img.height) m = Math.max(m, img.data[(Y * img.width + X) * 4 + 3]); } return m; };
		const bent = t.textCurve(spec, curve), pts = bent.filter((v: any) => v.flags === 1);
		const blocks = s.shapeBlocks(undefined, bent, {r: 255, g: 0, b: 0}, 400, 200), back = s.pathsToCurve(s.findVectorMask(blocks), 400, 200);
		const begins = (c: any[]) => c.filter((v: any) => v.flags === 0).length;
		return {n: pts.length, near: pts.filter((v: any) => alpha(v.x, v.y) > 40).length, begins: begins(bent), back: begins(back), colour: s.solidColour(blocks)};
	}, outline.curve);
	check(r4.near >= r4.n * 0.95, `bent text's outlines are on the drawn bent text (${r4.near}/${r4.n})`);
	check(r4.begins > 0 && r4.back === r4.begins, `the shape's vector mask has the contours (${r4.back}/${r4.begins}) and the fill is the text's colour ${JSON.stringify(r4.colour)}`);
	await view.close();
	process.exit(bad ? 1 : 0);
})();
