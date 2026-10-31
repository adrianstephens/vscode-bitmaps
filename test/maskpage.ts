const {openPage, pause} = require('./pagehost');
const {menu} = require('./cascadehost');		// (only for what is not the mode's: the transforms, and the shape editor's tools)
import * as items from './menuitems';

// Layer masks and vector masks in the bitmap viewer's page, in headless Chrome (npx tsc -b first, then npx ts-node test/maskpage.ts):
// a mask added from a layer's menu hides it, is one edit that undoes and redoes, and is turned off, inverted, made the selection and
// back into a mask, applied to the layer's pixels and deleted; a vector mask on a layer of pixels (which is not a shape) hides what
// is outside its path, and is turned off, inverted, rasterized into the mask and deleted.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 700;		// (tall enough for the menu's first strip, which is longer while a mask is edited)

(async () => {
	const problems: string[] = [], edits: string[] = [], errors: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready!: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => m.includes('HALF_FLOAT') || m.includes('willReadFrequently') || problems.push(m),
		host: (m: any) => {
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
	const {send} = view;
	const page = view.page;

	let rid = 100;
	const raw = async (): Promise<any> => {
		const id = ++rid;
		const got = new Promise(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const filled = (w: number, h: number, c: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(c, i * 4); return d; };
	const lay = (name: string, left: number, top: number, w: number, h: number, c: number[], more = {}) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, c), ...more});
	const at = 350, bt = 250;		// where the menu is brought up

	let r: any;
	const px = (x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)).join();
	const RED = '255,0,0', WHITE = '255,255,255';
	// the square's left half and its right half, as the picture shows them
	const halves = () => `${px(40, 40) === RED ? 'red' : px(40, 40) === WHITE ? 'white' : px(40, 40)}/${px(60, 40) === RED ? 'red' : px(60, 40) === WHITE ? 'white' : px(60, 40)}`;
	const step = async (ids: string[]) => {
		await items.choose(page, ['layer', 'layer-1', ...ids]);
		await pause(300);
		r = await raw();
	};
	const undo = async () => { await send({command: 'undo'}); await pause(300); r = await raw(); };
	const redo = async () => { await send({command: 'redo'}); await pause(300); r = await raw(); };
	const last = () => edits[edits.length - 1];

	// white, under a red square from (30, 25) to (70, 55)
	const back = lay('back', 0, 0, 100, 80, [255, 255, 255, 255]);
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255])]});
	await pause(700);
	r = await raw();
	check(halves() === 'red/red', `the square shows (${halves()})`);

	//-------------------------------------------------------------------------
	// a mask added, turned off and on, inverted, deleted
	//-------------------------------------------------------------------------

	await step(['mask', 'mask-hide']);
	check(halves() === 'white/white' && r.layers?.[1]?.mask?.default === 0 && last() === 'Add Layer Mask', `a mask that hides all hides it, as one edit (${halves()}; ${last()})`);
	await undo();
	check(halves() === 'red/red' && !r.layers?.[1]?.mask, `undone, there is no mask (${halves()})`);
	await redo();
	check(halves() === 'white/white', `redone, it is hidden again (${halves()})`);

	await step(['mask', 'mask-invert']);
	check(halves() === 'red/red' && r.layers?.[1]?.mask?.inverted && last() === 'Invert Layer Mask', `inverted, the mask shows all (${halves()}; ${last()})`);
	await undo();
	await step(['mask', 'mask-on']);
	check(halves() === 'red/red' && r.layers?.[1]?.mask?.disabled && last() === 'Disable Layer Mask', `turned off, it hides nothing (${halves()}; ${last()})`);
	await undo();
	check(halves() === 'white/white', `undone, it hides all again (${halves()})`);

	await step(['mask', 'mask-delete']);
	check(halves() === 'red/red' && !r.layers?.[1]?.mask && last() === 'Delete Layer Mask', `deleted (${halves()}; ${last()})`);

	//-------------------------------------------------------------------------
	// a mask of part of the layer: made the selection, which makes a mask again; applied to the layer's pixels
	//-------------------------------------------------------------------------

	const leftHalf = {left: 30, top: 25, width: 20, height: 30, default: 0, disabled: false, inverted: false, data: new Uint8ClampedArray(20 * 30).fill(255)};
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {mask: leftHalf})]});
	await pause(700);
	r = await raw();
	check(halves() === 'red/white', `a file's mask of the left half shows only that (${halves()})`);

	edits.length = 0;
	await step(['mask', 'mask-select']);
	check(last() === 'Load Selection', `the mask is made the selection (${edits.join(', ')})`);
	await step(['mask', 'mask-delete']);
	check(halves() === 'red/red', `the mask deleted, it all shows (${halves()})`);
	await step(['mask', 'mask-selection']);
	check(halves() === 'red/white' && last() === 'Add Layer Mask', `a mask from the selection shows the left half again (${halves()}; ${last()})`);

	await step(['mask', 'mask-apply']);
	const square = r.layers?.[1];
	check(halves() === 'red/white' && !square?.mask && last() === 'Apply Layer Mask', `applied, the picture is the same and the mask is gone (${halves()}; ${last()})`);
	check(!!square && square.width <= 21, `the layer's pixels are only the left half now (${square?.left}, ${square?.width} wide)`);
	await undo();
	check(halves() === 'red/white' && !!r.layers?.[1]?.mask && r.layers?.[1]?.width === 40, `undone, the mask is back over all the pixels (${r.layers?.[1]?.width} wide)`);

	//-------------------------------------------------------------------------
	// the mask painted: the pencil's black hides, and white shows again; a stroke is an edit that undoes
	//-------------------------------------------------------------------------

	const scale = Math.min(W / 100, H / 80, 16);
	const screen = (x: number, y: number): [number, number] => [(W - 100 * scale) / 2 + (x + 0.5) * scale, (H - 80 * scale) / 2 + (y + 0.5) * scale];
	const stroke = async (x0: number, y0: number, x1: number, y1: number) => {
		await page.mouse.move(...screen(x0, y0));
		await page.mouse.down();
		await page.mouse.move(...screen(x1, y1), {steps: 6});
		await page.mouse.up();
		await pause(300);
		r = await raw();
	};
	const maskValue = (x: number, y: number) => { const m = r.layers?.[1]?.mask; return m && new Uint8Array(m.data)[(y - m.top) * m.width + (x - m.left)]; };

	await page.keyboard.press('Escape');		// (what was selected from the mask would keep the strokes to the left half)
	// (choosing the layer makes its pixels what is drawn on, and choosing its mask makes that, as a layer is chosen)
	await step([]);
	await step(['mask']);
	check(halves() === 'red/white', `the mask chosen to be painted changes nothing yet (${halves()})`);
	check(await items.active(page, ['layer', 'layer-1', 'mask']), 'and its icon is marked, as what is drawn on');
	let top = await items.ids(page);
	check(top.includes('mask-density') && top.includes('mask-feather'), `the menu itself has the mask's density and feather (${top.join(' ')})`);
	await items.turn(page, ['mask-density'], -2);
	await pause(300);
	r = await raw();
	check(r.layers?.[1]?.mask?.density < 255, `turned there, the mask's density changes (${r.layers?.[1]?.mask?.density})`);
	await undo();
	await page.keyboard.press('n');
	await stroke(36, 40, 44, 40);
	check(halves() === 'white/white' && last() === 'Pencil', `black pencilled on the mask hides the layer there (${halves()}; ${last()})`);
	check(px(40, 30) === RED && r.layers?.[1]?.width === 40, `the rest of it is as it was, and the layer's own pixels are not drawn on (${px(40, 30)}; ${r.layers?.[1]?.width} wide)`);
	check(maskValue(40, 40) === 0 && maskValue(40, 30) === 255 && r.layers?.[1]?.mask?.width === 100, `the mask holds the stroke, and now covers the canvas (${maskValue(40, 40)}, ${maskValue(40, 30)}; ${r.layers?.[1]?.mask?.width} wide)`);
	await undo();
	check(halves() === 'red/white' && maskValue(40, 40) === 255, `undone, it shows again (${halves()}; ${maskValue(40, 40)})`);
	await redo();
	check(halves() === 'white/white', `redone, it is hidden (${halves()})`);

	// white (the colours swapped) shows what the mask hid
	await page.keyboard.press('x');
	await stroke(56, 40, 64, 40);
	check(halves() === 'white/red' && maskValue(60, 40) === 255, `white pencilled shows the right half there (${halves()}; ${maskValue(60, 40)})`);
	await page.keyboard.press('x');

	// the layer chosen again, the pencil draws on its pixels
	await step([]);
	await stroke(36, 30, 44, 30);
	check(px(40, 30) === '0,0,0' && maskValue(40, 30) === 255, `the layer chosen, the pencil draws on its pixels again (${px(40, 30)}; ${maskValue(40, 30)})`);
	top = await items.ids(page);
	check(!top.includes('mask-density'), `and the menu has the mask's settings no more (${top.join(' ')})`);
	await undo();

	//-------------------------------------------------------------------------
	// a vector mask on a layer of pixels: the left half of the square, as a path
	//-------------------------------------------------------------------------

	const knot = (x: number, y: number) => ({selector: 2, before: {y: y / 80, x: x / 100}, anchor: {y: y / 80, x: x / 100}, after: {y: y / 80, x: x / 100}});
	const vmsk = (flags: number) => ({key: 'vmsk', version: 3, flags, paths: [
		{selector: 6, reserved: new Uint8Array(24)},
		{selector: 8, initialFill: 0, reserved: new Uint8Array(22)},
		{selector: 0, count: 4, operation: 1, shape: 0, reserved: new Uint8Array(18)},
		knot(30, 25), knot(50, 25), knot(50, 55), knot(30, 55),
	]});
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {blocks: {vmsk: vmsk(0)}})]});
	await pause(700);
	r = await raw();
	check(halves() === 'red/white', `a vector mask hides what is outside its path (${halves()})`);

	await step(['vector-mask', 'vector-mask-invert']);
	check(halves() === 'white/red' && (r.layers?.[1]?.blocks?.vmsk?.flags & 1) === 1 && last() === 'Invert Vector Mask', `inverted, it hides what is inside (${halves()}; ${last()})`);
	await undo();
	await step(['vector-mask', 'vector-mask-on']);
	check(halves() === 'red/red' && (r.layers?.[1]?.blocks?.vmsk?.flags & 4) === 4, `turned off, it hides nothing (${halves()})`);
	await undo();
	check(halves() === 'red/white', `undone, it hides the right half again (${halves()})`);

	// with a mask as well, which hides the top of the square: each hides what it hides
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {
		blocks: {vmsk: vmsk(0)}, mask: {left: 0, top: 35, width: 100, height: 45, default: 0, disabled: false, inverted: false, data: new Uint8ClampedArray(100 * 45).fill(255)},
	})]});
	await pause(700);
	r = await raw();
	const quarters = () => [px(40, 30), px(40, 45), px(60, 45)].map(c => c === RED ? 'red' : c === WHITE ? 'white' : c).join('/');
	check(quarters() === 'white/red/white', `with a mask too, only what both show shows (${quarters()})`);
	await step(['vector-mask', 'vector-mask-rasterize']);
	check(quarters() === 'white/red/white' && !r.layers?.[1]?.blocks?.vmsk && !!r.layers?.[1]?.mask && last() === 'Rasterize Vector Mask', `rasterized into the mask, the picture is the same (${quarters()}; ${last()})`);
	await undo();
	check(quarters() === 'white/red/white' && !!r.layers?.[1]?.blocks?.vmsk, `undone, the vector mask is back (${quarters()})`);
	await step(['vector-mask', 'vector-mask-delete']);
	check(quarters() === 'white/red/red' && !r.layers?.[1]?.blocks?.vmsk && last() === 'Delete Vector Mask', `deleted, only the mask hides (${quarters()}; ${last()})`);

	//-------------------------------------------------------------------------
	// a vector mask added, which shows all until a path is drawn in the shape editor, and then what is inside it
	//-------------------------------------------------------------------------

	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255])]});
	await pause(700);
	const editorShown = () => page.$eval('.pathedit-host', (e: HTMLElement) => e.style.display !== 'none').catch(() => false);
	const knots = () => ((r.layers?.[1]?.blocks?.vmsk?.paths ?? []) as any[]).filter(k => k.anchor).length;
	await step(['vector-mask-add']);
	check(halves() === 'red/red' && !!r.layers?.[1]?.blocks?.vmsk && last() === 'Add Vector Mask', `a vector mask added hides nothing (${halves()}; ${last()})`);
	check(await editorShown(), 'and its path is edited at once, with the shape editor');

	await menu(page, at, bt, ['tool', 'rect']);
	await pause(200);
	const corner = (x: number, y: number) => screen(x - 0.5, y - 0.5);
	await page.mouse.move(...corner(30, 25));
	await page.mouse.down();
	await page.mouse.move(...corner(50, 55), {steps: 4});
	await page.mouse.up();
	await pause(400);
	r = await raw();
	check(halves() === 'red/white' && knots() === 4, `a rectangle drawn over the left half shows only that (${halves()}; ${knots()} knots; ${last()})`);
	check(r.layers?.[1]?.width === 40 && !r.layers?.[1]?.blocks?.SoCo, `the layer's pixels are its own, and it has no fill (${r.layers?.[1]?.width} wide)`);
	await undo();
	check(halves() === 'red/red' && knots() === 0 && await editorShown(), `undone, the mask has no path and shows all, still edited (${halves()}; ${knots()} knots)`);
	await redo();
	check(halves() === 'red/white', `redone, it shows the left half (${halves()})`);

	await step([]);		// (the layer chosen: its pixels are what is drawn on)
	check(!(await editorShown()) && halves() === 'red/white', 'the path no longer edited, the editor goes, and the mask stays');
	await stroke(36, 30, 44, 30);
	check(px(40, 30) === '0,0,0' && last() === 'Pencil', `and the tools draw on the layer again (${px(40, 30)}; ${last()})`);
	await step(['vector-mask']);
	check(await editorShown(), 'the vector mask chosen, its path is edited again');
	const editorTop = await items.ids(page);		// (the editor's menu has the picture's)
	check(editorTop.includes('vector-mask-density') && editorTop.includes('vector-mask-feather'), `and the editor's menu has its density and feather (${editorTop.join(' ')})`);
	await step([]);
	check(!(await editorShown()), 'and the layer chosen, it is not');

	//-------------------------------------------------------------------------
	// the masks seen: a badge on the layer's icon, and over the picture (a red veil over what they hide) or alone (in grey)
	//-------------------------------------------------------------------------

	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {mask: leftHalf})]});
	await pause(700);
	// (the layers' faces, top first, as the layer strip has them: a thumbnail, with a second picture for the badge)
	const badges = async () => (await items.faces(page, ['layer'])).filter(f => f.includes('<img')).map(f => f.split('<img').length - 1).join();
	check(await badges() === '2,1', `the masked layer's icon has a badge, the other none (${await badges()})`);

	const seen = async (x: number, y: number) => (await view.shot()).at(...screen(x, y).map(Math.round) as [number, number]).join();
	const plain = [await seen(40, 40), await seen(60, 40), await seen(10, 10)];
	// (in the View item, for the current layer)
	const viewStep = async (id: string) => {
		await items.choose(page, ['view', id]);
		await pause(300);
		r = await raw();
	};
	await viewStep('mask-over');
	const over = [await seen(40, 40), await seen(60, 40), await seen(10, 10)];
	const pink = (c: string) => { const [r, g, b] = c.split(',').map(Number); return r > 240 && g > 100 && g < 160 && b > 100 && b < 160; };
	check(over[0] === RED && pink(over[1]) && pink(over[2]), `over the picture, what the mask hides is veiled in red (${plain.join(' ')} -> ${over.join(' ')})`);
	await viewStep('mask-alone');
	const alone = [await seen(40, 40), await seen(60, 40), await seen(10, 10)];
	check(alone.join(' ') === '255,255,255 0,0,0 0,0,0', `alone, it is white where it shows the layer and black elsewhere (${alone.join(' ')})`);
	await viewStep('mask-alone');
	const after = [await seen(40, 40), await seen(60, 40), await seen(10, 10)];
	check(after.join(' ') === plain.join(' '), `seen no more, the picture is as it was (${after.join(' ')})`);
	check(!r.layers?.[1]?.mask?.disabled && edits.length === edits.filter(e => e).length, 'seeing the mask is not an edit');

	//-------------------------------------------------------------------------
	// a mask's density and feather, turned by the wheel; and a vector mask not linked to its layer, which stays where it is as it moves
	//-------------------------------------------------------------------------

	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {mask: leftHalf})]});
	await pause(700);
	const turn = async (ids: string[], steps: number) => {
		await items.turn(page, ['layer', 'layer-1', ...ids], steps);
		await pause(300);
		r = await raw();
	};
	const between = (c: string) => { const [red, g, b] = c.split(',').map(Number); return red > 240 && g > 10 && g < 245 && g === b; };

	edits.length = 0;
	await turn(['mask', 'mask-density'], -4);
	const density = r.layers?.[1]?.mask?.density;
	check(density !== undefined && density < 255 && between(px(60, 40)) && px(40, 40) === RED, `the density turned down, what the mask hides partly shows (${density}; ${px(60, 40)})`);
	check(edits.join() === 'Mask Density', `as one edit (${edits.join(', ')})`);
	await undo();
	check(r.layers?.[1]?.mask?.density === undefined && px(60, 40) === WHITE, `undone, it hides all of it again (${px(60, 40)})`);

	await turn(['mask', 'mask-feather'], 2);
	const feather = r.layers?.[1]?.mask?.feather;
	check(feather > 0 && between(px(50, 40)) && between(px(49, 40)) && px(40, 40) === RED, `feathered, the mask's edge is soft (${feather}; ${px(49, 40)} ${px(50, 40)})`);
	await undo();

	// the vector mask over the left half, not linked: the layer carried 10 pixels to the right shows only where the mask still is
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers: [back, lay('square', 30, 25, 40, 30, [255, 0, 0, 255], {blocks: {vmsk: vmsk(2)}})]});
	await pause(700);
	const carry = async () => {
		await menu(page, at, bt, ['transform', 'transform-layer']);
		const [x0, y0] = screen(45, 40);
		await page.mouse.move(x0, y0);
		await page.mouse.down();
		for (let i = 1; i <= 5; i++) {
			await page.mouse.move(x0 + i * 2 * scale, y0);
			await pause(20);
		}
		await page.mouse.up();
		await page.keyboard.press('Enter');
		await pause(400);
		r = await raw();
	};
	await carry();
	const paths = () => JSON.stringify(((r.layers?.[1]?.blocks?.vmsk?.paths ?? []) as any[]).filter(k => k.anchor).map(k => k.anchor));
	check(px(35, 40) === WHITE && px(45, 40) === RED && px(55, 40) === WHITE, `not linked, the mask stays as the layer moves (${px(35, 40)} ${px(45, 40)} ${px(55, 40)})`);
	await undo();
	await step(['vector-mask', 'vector-mask-linked']);
	check(last() === 'Link Vector Mask' && !(r.layers?.[1]?.blocks?.vmsk?.flags & 2), `linked from the menu (${last()})`);
	const before = paths();
	await carry();
	check(px(35, 40) === WHITE && px(45, 40) === RED && px(55, 40) === RED && paths() !== before, `linked, it goes with the layer (${px(35, 40)} ${px(45, 40)} ${px(55, 40)})`);

	check(!problems.length && !errors.length, `no problems (${[...problems, ...errors].join('; ')})`);
	await view.close();
	console.log(bad ? `${bad} FAILED` : 'all ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
