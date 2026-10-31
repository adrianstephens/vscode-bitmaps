import * as fs from 'fs';
import * as path from 'path';
import * as bitmap from '@isopodlabs/binary_bitmaps';
const {openPage, pause} = require('./pagehost');
const {menu, strips} = require('./cascadehost');

// Shape layers edited in place (shapeedit.ts over LayeredMode), in headless Chrome (npx tsc -b first, then
// TS_NODE_TRANSPILE_ONLY=1 node -r <ts-node>/register test/shapepage.ts [file.psd], default /Volumes/Public/gradshape.psd): with a shape
// layer current the path editor is over the picture and the menu is its own (fill, tools, points) with the layers after it, not the
// paint tools; a point dragged is one edit that changes the picture and the layer's path, and undoes; another layer chosen brings the
// tools back.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 500;

(async () => {
	const file = process.argv[2] ?? '/Volumes/Public/gradshape.psd';
	const psd = await bitmap.PSD.load(new Uint8Array(fs.readFileSync(file)));
	const layers: any[] = [];
	for (let i = 0, layer: bitmap.psd.PSDLayerImage | undefined; (layer = psd.getLayer(i)); i++) {
		const {name, left, top, opacity, visible, blendMode, clipped, blocks} = layer;
		layers.push({
			name, left, top, opacity, visible, blend: blendMode, clipped, blocks, width: layer.width, height: layer.height,
			data: new Uint8Array((await layer.getPixels({plane: 'RGBA'})).pixels as Uint8Array),
			mask: layer.mask && {...layer.mask, data: new Uint8Array(await layer.mask.getPixels() as Uint8Array)},
		});
	}
	const composite = await psd.getPixels({plane: 'RGBA'});
	const top = layers.length - 1;
	console.log(`${file}: ${layers.map(l => `${l.name}${l.blocks?.vmsk || l.blocks?.vsms ? ' (shape)' : ''}`).join(', ')}`);

	const problems: string[] = [], edits: string[] = [], errors: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready!: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => m.includes('HALF_FLOAT') || m.includes('willReadFrequently') || problems.push(m),
		host: (m: any, reply: (r: unknown) => void) => {
			if ('resultId' in m)
				waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready')
				ready();
			else if (m.command === 'edited')
				edits.push(m.label);
			else if (m.command === 'error')
				errors.push(m.message);
		},
	});
	await readyP;
	const {page, send} = view;

	let rid = 100;
	const raw = async (): Promise<any> => {
		const id = ++rid;
		const got = new Promise(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const sum = (r: any) => { let s = 0; for (let i = 0; i < r.data.length; i += 4) s += r.data[i] + r.data[i + 1] + r.data[i + 2]; return s; };

	await send({command: 'load2d', image: {data: new Uint8Array(composite.pixels as Uint8Array), width: psd.width, height: psd.height}, layers});
	await pause(1000);

	const shown = () => page.$eval('.pathedit-host', (e: HTMLElement) => e.style.display !== 'none').catch(() => false);
	check(await shown(), 'the top layer is a shape: the shape editor is over the picture');

	// the menu is the shape editor's, with the layers after it
	const at = {x: 20, y: H - 20};		// (a corner, off the shape)
	const ids = (await strips(page, at.x, at.y, []))[0] ?? [];
	await page.keyboard.press('Escape');
	await pause(200);
	check(['tool', 'transform', 'edit', 'view', 'layer'].every(id => ids.includes(id)) && !ids.includes('paint') && !ids.includes('brush'), `its menu has the shape's tools and the layers, not the paint tools (${ids.join(' ')})`);
	check(ids.includes('fx'), 'and the layer style, in an fx item');

	// a point dragged
	const points = await page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.map(e => { const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; }));
	check(points.length > 0, `its points are shown (${points.length})`);
	let r = await raw();
	const before = sum(r), path0 = JSON.stringify(r.layers?.[top]?.blocks?.vmsk ?? r.layers?.[top]?.blocks?.vsms);
	const p = points[0];
	edits.length = 0;
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	for (let k = 1; k <= 10; k++) {
		await page.mouse.move(p.x + 4 * k, p.y + 3 * k);
		await pause(20);
	}
	await pause(100);
	r = await raw();
	check(sum(r) !== before && !edits.length, `while it is dragged the picture shows it, and it is not yet an edit (${edits.join(', ')})`);
	await page.mouse.up();
	await pause(400);
	r = await raw();
	const path1 = JSON.stringify(r.layers?.[top]?.blocks?.vmsk ?? r.layers?.[top]?.blocks?.vsms);
	check(edits.join() === 'Move point', `the drag is one edit (${edits.join(', ')})`);
	check(sum(r) !== before, 'the picture has changed');
	check(path1 !== path0, 'and so has the path the layer keeps');
	const knots = (j: string) => (JSON.parse(j).paths as any[]).filter(k => k.anchor);
	check(knots(path1).length === knots(path0).length && knots(path1).every((k, i) => k.before.x !== k.anchor.x || k.before.y !== k.anchor.y || k.after.x !== k.anchor.x || k.after.y !== k.anchor.y || knots(path0)[i].before.x === knots(path0)[i].anchor.x), 'a contour keeps its knots and their handles, so its curves stay curves');

	await send({command: 'undo'});
	await pause(400);
	r = await raw();
	check(sum(r) === before && JSON.stringify(r.layers?.[top]?.blocks?.vmsk ?? r.layers?.[top]?.blocks?.vsms) === path0, 'undone, the picture and the path are as they were');
	const back = await page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.map(e => { const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; }));
	check(Math.abs(back[0].x - p.x) < 1 && Math.abs(back[0].y - p.y) < 1, `and the editor shows the point where it was (${back[0]?.x},${back[0]?.y} / ${p.x},${p.y})`);
	await send({command: 'redo'});
	await pause(400);
	r = await raw();
	check(JSON.stringify(r.layers?.[top]?.blocks?.vmsk ?? r.layers?.[top]?.blocks?.vsms) === path1, 'redone, it is moved again');

	// a stroke the file has can be removed (it is turned off, with its settings kept), and comes back with the undo
	const strokeOn = async () => (await raw()).layers?.[top]?.blocks?.vstk?.descriptor?.items?.strokeEnabled?.value;
	const hadStroke = await strokeOn() !== false && !!(await raw()).layers?.[top]?.blocks?.vstk;
	if (hadStroke) {
		await menu(page, at.x, at.y, ['stroke', 'stroke-remove']);
		await pause(400);
		check(await strokeOn() === false, `the stroke can be removed (${await strokeOn()})`);
		await send({command: 'undo'});
		await pause(300);
		check(await strokeOn() !== false, 'and comes back with the undo');
	}

	// the grid can be shown over the picture
	// (which is the tools' canvas's, under the shape editor, as it is for any layer)
	const gridPath = () => page.$eval('#overlay', (c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
	const gridBefore = await gridPath();
	await menu(page, at.x, at.y, ['view', 'grid']);
	await pause(300);
	const gridAfter = await gridPath();
	check(gridAfter > 0 && gridBefore <= 0, `the shape editor's view menu shows the grid, drawn on the tools' canvas (${gridBefore} then ${gridAfter})`);
	await page.keyboard.press('Escape');
	await pause(200);
	// its fill can be put on or taken away, whichever it has now, and each undoes
	const fillOn = async () => (await raw()).layers?.[top]?.blocks?.vstk?.descriptor?.items?.fillEnabled?.value !== false;
	const hasFill = ids.includes('fill');
	const give = () => menu(page, at.x, at.y, ['fill-add']), take = () => menu(page, at.x, at.y, ['fill', 'fill-remove']);
	console.log(`${hasFill ? 'has' : 'has no'} fill to begin with`);
	await (hasFill ? take : give)();
	await pause(400);
	check(await fillOn() === !hasFill, `the fill is ${hasFill ? 'removed' : 'added'} (${await fillOn()})`);
	await (hasFill ? give : take)();
	await pause(400);
	check(await fillOn() === hasFill, `and the other way (${await fillOn()})`);
	await send({command: 'undo'});
	await pause(300);
	check(await fillOn() === !hasFill, 'which undoes');
	await send({command: 'undo'});
	await pause(300);
	check(await fillOn() === hasFill, 'as does the first');

	// the wheel zooms the picture's view, which the editor follows
	const z0 = (await page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.map(e => e.getBoundingClientRect().x)));
	await page.mouse.move(W / 2, H / 2);
	await page.mouse.wheel({deltaY: -200});
	await pause(300);
	const z1 = (await page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.map(e => e.getBoundingClientRect().x)));
	check(z0.length > 1 && Math.abs((z1[1] - z1[0]) / (z0[1] - z0[0])) > 1.05, `the wheel zooms in (${(z1[1] - z1[0]).toFixed(1)} from ${(z0[1] - z0[0]).toFixed(1)})`);

	// Space held over the editor gives the pointer to the picture's view: a drag from a point moves the view (the editor following it),
	// not the point, and is no edit; let go, the point is the editor's again
	const pts = () => page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.map(e => { const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; }));
	const svgCursor = () => page.$eval('.pathedit-host svg', (e: Element) => (e as SVGElement).style.cursor);
	const s0 = await pts(), pathS = JSON.stringify((await raw()).layers?.[top]?.blocks?.vmsk ?? (await raw()).layers?.[top]?.blocks?.vsms);
	edits.length = 0;
	await page.mouse.move(s0[0].x, s0[0].y);
	await pause(100);
	check(await svgCursor() === 'crosshair', `over a point the cursor is the editor's (${await svgCursor()})`);
	await page.keyboard.down(' ');
	await pause(100);
	check(await svgCursor() === 'grab', `with Space held it is the view's (${await svgCursor()})`);
	await page.mouse.down();
	await page.mouse.move(s0[0].x + 30, s0[0].y + 20, {steps: 6});
	await page.mouse.up();
	await page.keyboard.up(' ');
	await pause(300);
	const s1 = await pts(), r1 = await raw();
	const dx = s1[0].x - s0[0].x, dy = s1[0].y - s0[0].y;
	check((Math.abs(dx) > 5 || Math.abs(dy) > 5) && s1.every((q, i) => Math.abs(q.x - s0[i].x - dx) < 1 && Math.abs(q.y - s0[i].y - dy) < 1), `the view moved, all the points with it (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
	check(!edits.length && JSON.stringify(r1.layers?.[top]?.blocks?.vmsk ?? r1.layers?.[top]?.blocks?.vsms) === pathS, `and the path did not (${edits.join(', ')})`);
	await page.mouse.move(s1[0].x, s1[0].y);
	await pause(100);
	check(await svgCursor() === 'crosshair', `let go of Space, the point is the editor's again (${await svgCursor()})`);

	// a layer that is not a shape brings the tools back
	const plain = layers.findIndex(l => !l.blocks?.vmsk && !l.blocks?.vsms);
	if (plain >= 0) {
		await menu(page, at.x, at.y, ['layer', `layer-${plain}`]);
		await page.keyboard.press('Escape');
		await pause(300);
		check(!(await shown()), `layer ${plain} (${layers[plain].name}) is not a shape: the editor is gone`);
		const tools = (await strips(page, W / 2, H / 2, []))[0] ?? [];
		await page.keyboard.press('Escape');
		check(tools.includes('paint') && tools.includes('select'), `and the menu is the paint tools' (${tools.join(' ')})`);
		check(tools.includes('fx'), 'with the layer style, in an fx item');
		// the grid turned on in the shape editor is on over the picture here too, and goes with this menu's toggle
		const inked = () => page.$eval('#overlay', (c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
		await pause(300);
		const views = (await strips(page, W / 2, H / 2, ['view'])).at(-1) ?? [];
		await page.keyboard.press('Escape');
		await pause(200);
		check(views.includes('grid') && await inked() > 0, `the grid is shown with the paint tools, its toggle in View (${await inked()} pixels; ${views.join(' ')})`);
		await menu(page, W / 2, H / 2, ['view', 'grid']);
		await page.keyboard.press('Escape');		// (a toggle leaves the menu open)
		await pause(300);
		check(await inked() === 0, 'and turned off by the menu');
		await pause(200);
		await menu(page, W / 2, H / 2, ['layer', `layer-${top}`]);
		await page.keyboard.press('Escape');
		await pause(300);
		check(await shown(), 'the shape chosen again, the editor is back');
	}

	check(!errors.length, `no errors (${errors.join('; ')})`);
	check(!problems.length, `no page problems (${problems.join('; ')})`);
	await view.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
