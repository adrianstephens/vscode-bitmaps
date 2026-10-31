import * as fs from 'fs';
import * as path from 'path';
const {openPage, pause} = require('./pagehost');
const {menu, strips} = require('./cascadehost');		// (only for the shape editor's own items)
import * as items from './menuitems';

// The layer style and adjustment layer menus (layerfx.ts) in the bitmap viewer's page, in headless Chrome (npx tsc -b first, then
// npx ts-node test/layerfxpage.ts): a drop shadow given to a layer from its menu darkens the picture where it falls, and is one edit
// that undoes and redoes; a new invert or threshold layer changes the picture below it, and a threshold's level turned by the wheel is
// one edit once it is left alone.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 500;

(async () => {
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
			else if (m.command === 'fitStroke') {		// (the extension's fit is not here: the stroke's first, middle and last points will do)
				const q = m.stroke as number[], n = q.length / 2, at = (i: number, flags: number) => ({x: q[2 * i], y: q[2 * i + 1], flags});
				reply([at(0, 0), at(n >> 1, 1), at(n - 1, 4)]);
			}
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
	const px = (r: any, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)) as number[];
	const filled = (w: number, h: number, f: (x: number, y: number) => number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(f(i % w, Math.floor(i / w)), i * 4); return d; };
	const lay = (name: string, left: number, top: number, w: number, h: number, c: number[]) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, () => c)});
	const at = 350, bt = 250;		// where the menu is brought up

	// white, under a red square from (30, 25) to (70, 55)
	await send({command: 'load2d', image: {data: filled(100, 80, () => [255, 255, 255, 255]), width: 100, height: 80},
		layers: [lay('back', 0, 0, 100, 80, [255, 255, 255, 255]), lay('square', 30, 25, 40, 30, [255, 0, 0, 255])]});
	await pause(700);

	let r = await raw();
	const shade = () => px(r, 72, 58);		// below and to the right of the square, where a light from 120 degrees casts its shadow
	check(shade()[0] === 255, `no shadow at first (${shade()})`);

	// a step of the menu (the layers' items are the mode's), and what it has made
	const choose = async (path: string[]) => {
		await items.choose(page, path);
		await pause(300);
		r = await raw();
	};
	const square = () => px(r, 50, 40).slice(0, 3).join();

	// the opacity turned is one edit; an undo straight after it undoes it, and nothing is recorded later
	for (let i = 0; i < 4; i++) {
		await items.turn(page, ['layer', 'layer-1', 'opacity'], -2);
		await pause(30);
	}
	r = await raw();
	const turned = r.layers?.[1]?.opacity;
	check(turned < 1 && edits.length === 1 && edits[0] === 'Layer Opacity', `opacity turned down is one edit (${turned}; ${edits.join(', ')})`);
	await send({command: 'undo'});
	await pause(900);
	r = await raw();
	check(r.layers?.[1]?.opacity === 1 && edits.length === 1, `an undo straight after puts it back, and nothing more is recorded (${r.layers?.[1]?.opacity}; ${edits.join(', ')})`);
	await send({command: 'redo'});
	await pause(300);
	r = await raw();
	check(r.layers?.[1]?.opacity === turned, `redone, it is as turned (${r.layers?.[1]?.opacity})`);
	await send({command: 'undo'});
	await pause(300);

	// hidden, as an edit
	await choose(['layer', 'layer-1', 'visible']);
	check(square() === '255,255,255' && edits[edits.length - 1] === 'Hide Layer', `the Visible toggle hides the layer (${square()}; ${edits[edits.length - 1]})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(square() === '255,0,0', `undone, it shows (${square()})`);

	// a blend mode is seen while the pointer is on it, taken back when it moves to another, and an edit only when chosen
	edits.length = 0;
	const blend = (mode: string) => ['layer', 'layer-1', 'blend', 'blend-comparative', mode];
	await items.hover(page, blend('blend-diff'), true);
	r = await raw();
	check(square() === '0,255,255', `difference is previewed (${square()})`);
	await items.hover(page, blend('blend-diff'), false);
	await items.hover(page, blend('blend-fdiv'), true);
	r = await raw();
	check(square() === '255,255,255', `then divide, in its place (${square()})`);
	check(!edits.length, `previews are not edits (${edits.join(', ')})`);
	await items.hover(page, blend('blend-fdiv'), false);
	await pause(300);
	r = await raw();
	check(square() === '255,0,0', `the pointer gone, the layer's own mode is back (${square()})`);
	await choose(blend('blend-diff'));
	check(square() === '0,255,255' && r.layers?.[1]?.blend === 'diff' && edits.join() === 'Layer Blend Mode', `chosen, it is one edit (${square()}; ${edits.join(', ')})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(square() === '255,0,0' && r.layers?.[1]?.blend === 'norm', `undone, it is normal again (${square()})`);
	edits.length = 0;

	const fx = await items.ids(page, ['layer', 'layer-1', 'fx']);
	check(['fx-drop', 'fx-inner-shadow', 'fx-outer-glow', 'fx-inner-glow', 'fx-bevel', 'fx-colour', 'fx-gradient', 'fx-stroke'].every(id => fx.includes(id)), `the style lists its effects (${fx.join(' ')})`);

	await choose(['layer', 'layer-1', 'fx', 'fx-drop']);
	check(shade()[0] < 240, `a drop shadow added from the menu falls beneath the square (${shade()})`);
	check(!!r.layers?.[1]?.blocks?.lfx2, 'and is kept in the layer\'s blocks, to be saved');
	check(edits.filter(e => e === 'Layer Style').length === 1, `as one edit (${edits.join(', ')})`);

	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(shade()[0] === 255, `undone, it is gone (${shade()})`);
	await send({command: 'redo'});
	await pause(300);
	r = await raw();
	check(shade()[0] < 240, `redone, it is back (${shade()})`);

	await choose(['layer', 'layer-1', 'fx', 'fx-drop']);
	check(shade()[0] === 255, `clicked again, it is turned off (${shade()})`);

	// adjustment layers, above the current one
	edits.length = 0;
	await items.choose(page, ['layer', 'new-adjustment', 'new-nvrt']);
	await pause(300);
	r = await raw();
	check(r.layers?.length === 3 && !!r.layers[2].blocks?.nvrt && r.layers[2].name === 'Invert 1', `a new invert layer (${r.layers?.map((l: any) => l.name)})`);
	check(px(r, 5, 5)[0] === 0 && px(r, 50, 40).slice(0, 3).join() === '0,255,255', `inverts what is below it (${px(r, 5, 5)} ${px(r, 50, 40)})`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(r.layers?.length === 2 && px(r, 5, 5)[0] === 255, 'undone, it is gone');

	// a solid colour fill layer covers what is below it, and has its colour and a layer style in its menu
	await items.choose(page, ['layer', 'new-adjustment', 'new-SoCo']);
	await pause(300);
	r = await raw();
	check(!!r.layers?.[2]?.blocks?.SoCo?.descriptor && px(r, 50, 40).slice(0, 3).join() === '255,255,255', `a new solid colour layer covers the square in white (${px(r, 50, 40)})`);
	const fill = await items.ids(page, ['layer', 'layer-2']);
	check(fill.includes('adjustment') && fill.includes('fx'), `and has its colour and a style (${fill.join(' ')})`);

	// the shape editor is over it, not the paint tools: with no contours it fills all, and drawing one gives it a vector mask
	const editing = () => page.$eval('.pathedit-host', (e: HTMLElement) => e.style.display !== 'none').catch(() => false);
	await pause(300);
	const top = (await strips(page, at, bt, []))[0] ?? [];
	await page.keyboard.press('Escape');
	await pause(200);
	check(top.includes('fx') && top.includes('fill') && !top.includes('adjustment'), `its menu has the shape editor's fill and the style, and no second fill (${top.join(' ')})`);
	// a stroke can be added to it, and taken away (a shape's own; one a file had is kept, turned off)
	const stroked = async () => ((await raw()).layers?.[2]?.blocks?.vstk?.descriptor?.items?.strokeEnabled?.value);
	await menu(page, at, bt, ['stroke-add']);
	await pause(400);
	check(await stroked() === true, `a stroke can be added (${await stroked()})`);
	await menu(page, at, bt, ['stroke', 'stroke-remove']);
	await pause(400);
	check(await stroked() !== true, `and removed (${await stroked()})`);
	await send({command: 'undo'});
	await pause(300);
	check(await stroked() === true, 'which undoes');
	await send({command: 'undo'});
	await pause(300);
	check(await stroked() === undefined, 'as does the addition');
	const points = () => page.$$eval('.pathedit-host svg .insp-pt', (es: Element[]) => es.length);
	check(await editing() && !r.layers?.[2]?.blocks?.vmsk && await points() === 0, 'which is edited with the shape editor, with no contours and no vector mask');
	await menu(page, at, bt, ['tool', 'rect']);
	await pause(200);
	const box = await page.$eval('.pathedit-host svg', (e: Element) => { const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; });
	await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
	await page.mouse.down();
	await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.6, {steps: 4});
	await page.mouse.up();
	await pause(400);
	r = await raw();
	check(!!r.layers?.[2]?.blocks?.vmsk && await points() > 0, `a rectangle drawn gives the fill a vector mask (${!!r.layers?.[2]?.blocks?.vmsk}, ${await points()} points)`);
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	check(!r.layers?.[2]?.blocks?.vmsk && r.layers?.length === 3, 'and undone, it has none');
	// an ellipse is made of curves: knots with handles, not corners
	await menu(page, at, bt, ['tool', 'ellipse']);
	await pause(200);
	await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
	await page.mouse.down();
	await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.6, {steps: 4});
	await page.mouse.up();
	await pause(400);
	r = await raw();
	const knots = ((r.layers?.[2]?.blocks?.vmsk?.paths ?? []) as any[]).filter(k => k.anchor);
	check(knots.length === 4 && knots.every(k => k.before.x !== k.anchor.x || k.before.y !== k.anchor.y), `an ellipse drawn has four knots with handles (${knots.length})`);
	await send({command: 'undo'});
	await pause(300);

	await menu(page, at, bt, ['tool', 'freehand']);
	await pause(200);
	await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
	await page.mouse.down();
	await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.7, {steps: 6});
	await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.3, {steps: 6});
	await page.mouse.up();
	await pause(600);
	r = await raw();
	check(!!r.layers?.[2]?.blocks?.vmsk, `a stroke drawn freehand makes the fill a contour (${!!r.layers?.[2]?.blocks?.vmsk})`);
	await send({command: 'undo'});
	await pause(300);
	await send({command: 'undo'});
	await pause(300);

	// and so does a gradient one, which is made black to white and can be edited from its menu
	await items.choose(page, ['layer', 'new-adjustment', 'new-GdFl']);
	await pause(300);
	r = await raw();
	const grad = [px(r, 50, 2)[0], px(r, 50, r.height - 3)[0]];
	check(!!r.layers?.[2]?.blocks?.GdFl?.descriptor && grad[0] !== grad[1], `a new gradient layer shades across the picture (${grad})`);
	const gfill = [await items.ids(page, ['layer', 'layer-2'])];
	await pause(200);
	check(gfill[gfill.length - 1].includes('adjustment') && gfill[gfill.length - 1].includes('fx'), `and has its gradient and a style (${gfill[gfill.length - 1].join(' ')})`);
	await send({command: 'undo'});
	await pause(300);

	await items.choose(page, ['layer', 'new-adjustment', 'new-thrs']);
	await pause(300);
	r = await raw();
	check(px(r, 5, 5).slice(0, 3).join() === '255,255,255' && px(r, 50, 40).slice(0, 3).join() === '0,0,0', `a threshold at 128 makes white white and red black (${px(r, 5, 5)} ${px(r, 50, 40)})`);

	// its level turned down by the wheel, past red's luminance
	edits.length = 0;
	const thr = await items.ids(page, ['layer', 'layer-2', 'adjustment']);
	check(thr.includes('thrs-level'), `a threshold layer has its level (${thr})`);
	for (let i = 0; i < 12; i++) {
		await items.turn(page, ['layer', 'layer-2', 'adjustment', 'thrs-level'], -4);
		await pause(30);
	}
	await pause(800);
	r = await raw();
	const level = r.layers?.[2]?.blocks?.thrs?.level;
	check(level < 128, `the wheel lowers the level (${level})`);
	check(level < 70 ? px(r, 50, 40)[0] === 255 : true, `and red, brighter than it, turns white (${px(r, 50, 40)})`);
	check(edits.length === 1 && edits[0] === 'Adjustment', `the turning is one edit (${edits.join(', ')})`);

	check(!problems.length, `no page problems (${problems.slice(0, 3).join(' | ')})`);
	check(!errors.length, `no errors (${errors.join(' | ')})`);
	await view.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exitCode = bad ? 1 : 0;
})();
