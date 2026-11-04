// Trace to SVG in the bitmap viewer's page (npx tsc -b first, then npx ts-node -O '{"lib":["es2022","dom"]}' test/tracepage.ts): a picture of
// gradient and flat regions is traced, and the markup the page sends to be saved is drawn again and compared with the picture.
// Neighbouring shapes share their edges, so nothing shows between them. Traced to layers, the picture is the background of shape layers
// (a gradient or colour each, and the ink lines of each width), which make it again, and one undo takes them away.
const {openPage, pause} = require('./pagehost');
import * as items from './menuitems';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const problems: string[] = [], edits: string[] = [];
	let ready: () => void, svg = '';
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: 700, height: 500, bitmap: true, programs: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) problems.push(m); },
		host: (m: any, reply: (r: any) => void) => {
			if (m.command === 'ready') ready();
			else if (m.command === 'saveSvg') svg = m.text;
			else if (m.command === 'edited') edits.push(m.label);
			else if (m.command === 'error') problems.push(m.message);
		},
	});
	await readyP;
	const {send} = view;

	// a ramp on the left, a flat block and a disc on a grey ground on the right
	const w = 160, h = 120, pic = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let c = [150, 150, 150];
			if (x < 70) c = [40 + x * 2.5, 60 + y * 0.5, 200 - x];
			else if (x > 100 && y < 40) c = [30, 60, 200];
			else if ((x - 115) ** 2 + (y - 80) ** 2 < 24 ** 2) c = [40, 170, 60];
			pic.set([...c, 255], (y * w + x) * 4);
		}
	await send({command: 'load2d', image: {data: pic, width: w, height: h}});
	await pause(500);
	await view.page.keyboard.press('Escape');

	// traced as one of shapes, lines or both, the SVG sent to be saved
	const trace = async (kind: string) => {
		svg = '';
		await items.choose(view.page, ['filters', 'traceSvg', kind]);
		for (let i = 0; i < 100 && !svg; i++) await pause(100);
		return svg;
	};
	// drawn again, on nothing (so that a gap between shapes shows)
	const draw = (text: string, w: number, h: number): Promise<number[]> => view.page.evaluate(async (text: string, w: number, h: number) => {
		const img = new Image();
		await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/svg+xml;base64,' + btoa(text); });
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		const g = c.getContext('2d')!;
		g.drawImage(img, 0, 0);
		return Array.from(g.getImageData(0, 0, w, h).data);
	}, text, w, h);

	// what the busy indication over the picture says, each time it changes ('on Styling 40%', 'off ...')
	const watchBusy = () => view.page.evaluate(`window.busySeen = []; new MutationObserver(() => {
		const b = document.getElementById('busy');
		const seen = b && (b.classList.contains('on') ? 'on ' : 'off ') + b.querySelector('.busy-label').textContent;
		if (seen && seen !== window.busySeen[window.busySeen.length - 1])
			window.busySeen.push(seen);
	}).observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true})` as any);
	const busySeen = (): Promise<string[]> => view.page.evaluate('window.busySeen' as any);
	await watchBusy();
	await trace('shapes');
	{
		const seen = await busySeen(), percents = seen.filter(t => t.startsWith('on Tracing ')).map(t => parseInt(t.slice(11)));
		check(seen.includes('on Tracing') && seen.at(-1)!.startsWith('off') && percents.length >= 4 && percents.at(-1) === 100, `tracing is shown as it goes (${percents.join(' ')}), and taken away`);
	}
	check(!!svg, `an SVG is sent (${svg.length} characters)`);
	check(/<svg [^>]*width="160" height="120"/.test(svg), 'it is the size of the picture');
	check(/<linearGradient/.test(svg), `it has gradients (${(svg.match(/<linearGradient/g) || []).length})`);
	const paths = (svg.match(/<path /g) || []).length;
	check(paths >= 3 && paths < 40, `a few paths (${paths})`);
	check(/C[-\d.]+,[-\d.]+,/.test(svg), 'curves are used');

	check(!/stroke="#000"/.test(svg), 'shapes alone have no ink lines');

	// drawn again, how far it is from the picture
	const back = await draw(svg, w, h);
	let gaps = 0;
	for (let i = 3; i < back.length; i += 4)
		if (back[i] < 250)
			gaps++;
	check(gaps === 0, `the shapes leave no gaps between them (${gaps} pixels)`);
	let err = 0, worst = 0;
	for (let i = 0; i < pic.length; i += 4) {
		const e = (Math.abs(back[i] - pic[i]) + Math.abs(back[i + 1] - pic[i + 1]) + Math.abs(back[i + 2] - pic[i + 2])) / 3;
		err += e;
		worst = Math.max(worst, e);
	}
	err /= w * h;
	console.log(`mean error ${err.toFixed(2)} levels, worst ${worst.toFixed(0)}`);
	check(err < 6, `the drawing is close to the picture (${err.toFixed(2)})`);

	// the layers of the picture, and what they make
	const layers = (): Promise<{kind: string, name: string, left: number, top: number, width: number, height: number, blocks: string[]}[]> => view.page.evaluate(`(async () => {
		const {mode} = await import('/out/webview/modes.js');
		return (mode.stack?.layers ?? []).map(l => ({kind: l.kind, name: l.name, left: l.left, top: l.top, width: l.image?.width, height: l.image?.height, blocks: Object.keys(l.blocks ?? {})}));
	})()` as any);
	const picture = (): Promise<number[]> => view.page.evaluate(`(async () => Array.from((await import('/out/webview/modes.js')).mode.picture().data))()` as any);
	// chosen, and waited for until it is a new edit (undoing makes none)
	const choose = async (ids: string[], label: string) => {
		const before = edits.length;
		await items.choose(view.page, ids);
		for (let i = 0; i < 100 && !(edits.length > before && edits.at(-1) === label); i++) await pause(100);
	};
	const away = (a: number[], b: ArrayLike<number>) => { let e = 0; for (let i = 0; i < a.length; i += 4) e += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3; return e / (a.length / 4); };

	// traced to layers: the picture becomes the background of a shape layer for each region, which make it again
	await choose(['filters', 'traceLayers', 'shapes'], 'Trace to Layers');
	let made = await layers();
	const shapes = made.filter(l => l.kind === 'shape');
	check(made.length === 5 && made[0].name === 'Background' && shapes.length === 4, `a shape layer for each region over the picture (${made.map(l => l.kind + ' ' + l.name).join(', ')})`);
	check(shapes.every(l => l.blocks.includes('vmsk') && (l.blocks.includes('SoCo') || l.blocks.includes('GdFl')) && l.blocks.includes('vstk')), `each has an outline, a fill and a seam line (${shapes.map(l => l.blocks.join('+')).join(', ')})`);
	check(shapes.filter(l => l.blocks.includes('GdFl')).length >= 2, 'regions with a slope have a gradient fill');
	check(shapes.slice(0, -1).some(l => l.width < w || l.height < h), `a layer's pixels are only of its box (${shapes.map(l => `${l.width}x${l.height}`).join(' ')})`);
	const layered = await picture();
	check(away(layered, pic) < 6, `the layers make the picture again (${away(layered, pic).toFixed(2)} levels)`);
	await send({command: 'undo'});
	await pause(300);
	made = await layers();
	check(made.length === 0 && away(await picture(), pic) === 0, `undone in one, the picture is as it was (${made.length} layers)`);

	// ink: a ring 3 wide and a bar 5 wide, black on white, traced as lines
	const ink = new Uint8ClampedArray(w * h * 4).fill(255);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const r = Math.hypot(x + 0.5 - 50, y + 0.5 - 50);
			if (Math.abs(r - 30) < 1.5 || (y >= 98 && y < 103 && x >= 20 && x < 140))
				ink.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
		}
	await send({command: 'load2d', image: {data: ink, width: w, height: h}});
	await pause(500);
	await view.page.keyboard.press('Escape');
	await trace('lines');
	const strokes = [...svg.matchAll(/<path d="([^"]*)" stroke-width="([\d.]+)"/g)].map(m => ({d: m[1], w: +m[2]}));
	check(/<g fill="none" stroke="#000"/.test(svg) && !/<linearGradient/.test(svg), 'lines alone are strokes, without shapes');
	check(strokes.length === 2, `a stroke each for the ring and the bar (${strokes.length})`);
	const ring = strokes.find(s => s.d.endsWith('Z')), bar = strokes.find(s => !s.d.endsWith('Z'));
	check(!!ring && Math.abs(ring.w - 3) <= 0.5, `the ring is a closed stroke 3 wide (${ring?.w})`);
	check(!!bar && Math.abs(bar.w - 5) <= 1 && /^M[\d.,]+L[\d.,]+$/.test(bar.d), `the bar is one straight stroke 5 wide (${bar?.w} ${bar?.d})`);
	const drawn = await draw(svg, w, h);
	let both = 0, either = 0;
	for (let i = 0; i < ink.length; i += 4) {
		const a = ink[i] < 128, b = drawn[i + 3] > 128;
		both += +(a && b);
		either += +(a || b);
	}
	check(both / either > 0.75, `the strokes cover the ink (overlap ${(both / either).toFixed(2)})`);

	// to layers: the ink lines of each width are one layer of strokes
	await choose(['filters', 'traceLayers', 'lines'], 'Trace to Layers');
	made = await layers();
	const inks = made.filter(l => l.name.startsWith('Ink'));
	check(inks.length === 2 && inks.every(l => l.kind === 'shape' && l.blocks.includes('vstk')), `a stroked layer for each width (${made.map(l => l.name).join(', ')})`);
	const inked = await picture();
	let dark = 0, darkInked = 0;
	for (let i = 0; i < ink.length; i += 4)
		if (ink[i] < 128) {
			dark++;
			darkInked += +(inked[i] < 128);
		}
	check(darkInked / dark > 0.8, `the strokes cover the ink (${(darkInked / dark).toFixed(2)})`);
	await send({command: 'undo'});
	await pause(300);

	await trace('both');
	check(/<linearGradient|fill="#/.test(svg) && /stroke="#000"/.test(svg), 'both is shapes and strokes');
	check(problems.length === 0, `no problems ${problems.join('; ')}`);
	await view.close?.();
	process.exit(bad ? 1 : 0);
})();
