const {openPage, pause} = require('./pagehost');
const {menu} = require('./cascadehost');

// What has the pointer and the keys over the bitmap viewer's picture (navigate.ts Input), in headless Chrome (npx tsc -b first, then
// TS_NODE_TRANSPILE_ONLY=1 npx ts-node test/pagekeys.ts): with a layer's transform under way, Space held gives a drag to the view, which moves
// the picture and the transform's box with it and is no edit; let go, a drag moves the box and Enter applies it, as one edit; Escape leaves a
// transform without one; and with none under way, a tool's key is the tools'.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 500;

(async () => {
	const problems: string[] = [], edits: string[] = [], waiting = new Map<number, (r: any) => void>();
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
	const cursor = () => page.$eval('#viewport', (e: HTMLElement) => e.style.cursor);
	const cursorAt = async (x: number, y: number) => { await page.mouse.move(x, y); await pause(100); return cursor(); };
	const drag = async (x: number, y: number, dx: number, dy: number) => {
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + dx, y + dy, {steps: 6});
		await page.mouse.up();
		await pause(200);
	};
	const filled = (w: number, h: number, c: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(c, i * 4); return d; };
	const lay = (name: string, left: number, top: number, w: number, h: number, c: number[]) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, c)});

	// 100 x 80, fitted: 6.25 window pixels to one, the height filling the window and the width with room either side (to move it into)
	await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80},
		layers: [lay('back', 0, 0, 100, 80, [255, 255, 255, 255]), lay('small', 10, 8, 40, 30, [255, 0, 0, 255])]});
	await pause(700);
	const S = 6.25, at = (x: number, y: number) => ({x: (W - 100 * S) / 2 + x * S, y: y * S});

	// the small layer's transform: its top left corner handle is at the layer's corner
	await menu(page, 600, 450, ['transform', 'transform-layer']);
	await pause(200);
	const c0 = at(10, 8);
	check(await cursorAt(c0.x, c0.y) === 'nwse-resize', `the transform's corner handle has its cursor (${await cursor()})`);

	// Space: the view has the pointer
	await page.keyboard.down(' ');
	await pause(100);
	check(await cursor() === 'grab', `with Space held the cursor is the view's (${await cursor()})`);
	await drag(at(30, 20).x, at(30, 20).y, 30, 0);
	await page.keyboard.up(' ');
	await pause(100);
	check(await cursorAt(c0.x + 30, c0.y) === 'nwse-resize', `the picture moved, with the box (${await cursor()})`);
	check(await cursorAt(c0.x, c0.y) !== 'nwse-resize', 'the handle is no longer where it was');
	await page.keyboard.press('Enter');
	await pause(300);
	let r = await raw();
	check(!edits.length && r.layers?.[1]?.left === 10, `Enter applies a box not moved: nothing is done (${edits.join(', ')}, left ${r.layers?.[1]?.left})`);

	// without Space a drag moves the box, and Enter makes that one edit
	await menu(page, 600, 450, ['transform', 'transform-layer']);
	await pause(200);
	const mid = at(30, 20);
	await drag(mid.x + 30, mid.y, 5 * S, 0);
	await page.keyboard.press('Enter');
	await pause(400);
	r = await raw();
	check(edits.join() === 'Free Transform' && r.layers?.[1]?.left === 15, `a drag moves the box, and Enter applies it as one edit (${edits.join(', ')}, left ${r.layers?.[1]?.left})`);

	// Escape leaves one without an edit
	edits.length = 0;
	await menu(page, 600, 450, ['transform', 'transform-layer']);
	await pause(200);
	await drag(mid.x + 60, mid.y, 5 * S, 0);
	await page.keyboard.press('Escape');
	await pause(400);
	r = await raw();
	check(!edits.length && r.layers?.[1]?.left === 15, `Escape leaves it as it was (${edits.join(', ')}, left ${r.layers?.[1]?.left})`);

	// with no transform, a tool's key is the tools': B the brush, whose cursor is its own; H the hand
	await page.keyboard.press('b');
	const brush = await cursorAt(W / 2, H / 2);
	await page.keyboard.press('h');
	const hand = await cursorAt(W / 2, H / 2 + 5);
	check(brush.startsWith('url(') && hand === 'grab', `B and H choose the brush and the hand (${brush.slice(0, 12)}, ${hand})`);

	check(!problems.length, `no page problems (${problems.slice(0, 3).join(' | ')})`);
	await view.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
