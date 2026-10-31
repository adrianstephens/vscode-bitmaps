// The bitmap viewer's page for real, in headless Chrome, as the other viewers' tests do theirs (pagehost.js): each kind of picture
// loaded in turn (a plain image, a picture of layers, an array of slices, a cubemap), and what is done to them through the page's
// own menu and pointer: a transform entered at the first click and its handles under the cursor, what a selection carries when it
// is transformed, the layers carried with the canvas, and a plain image made into a cubemap.
const fs = require('fs');
const path = require('path');
const {openPage, pause} = require('./pagehost');
const {menu} = require('./cascadehost');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const W = 700, H = 500;

(async () => {
	const problems = [], edits = [], errors = [], waiting = new Map();
	let ready;
	const readyP = new Promise(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		// (reading a layered picture's composite for the tooltip is a known complaint of the GPU; it does not stop anything)
		problems: m => m.includes('HALF_FLOAT') || m.includes('willReadFrequently') || problems.push(m),
		host: (m, reply) => {
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
	// the picture as the extension would ask for it to save it: its pixels as rgba (and its layers, and its kind)
	const raw = async () => {
		const id = ++rid;
		const got = new Promise(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const px = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
	// what is drawn over the picture: the tools' (selection, brush) and a transform's box
	const ink = () => page.$$eval('#overlay, #transform-overlay', cs => { let n = 0; for (const c of cs) { const d = c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; } return n; });
	const cursor = () => page.$eval('#viewport', e => e.style.cursor);
	const filled = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(f(i % w, Math.floor(i / w)), i * 4); return d; };
	// where a point of a picture w x h, fitted, is on the screen
	const where = (w, h) => { const s = Math.min(W / w, H / h, 16); return (x, y) => [(W - w * s) / 2 + x * s, (H - h * s) / 2 + y * s]; };
	const load = async (message, settle = 500) => { await send(message); await pause(settle); };
	const drag = async (a, b, steps = 6) => {
		await page.mouse.move(...a);
		await page.mouse.down();
		await page.mouse.move(...b, {steps});
		await page.mouse.up();
		await pause(150);
	};
	const ORANGE = [200, 120, 40, 255];

	// a plain image: a transform is entered at the first click, and its handles show under the cursor
	{
		await load({command: 'load2d', image: {data: filled(100, 80, () => ORANGE), width: 100, height: 80}});
		const at = where(100, 80);
		check(await ink() === 0, 'no tools are drawn before a transform');
		await menu(page, 350, 250, ['transform', 'transform-image']);
		check(await ink() > 0, 'a transform is entered by the first click (its box is drawn)');
		await page.mouse.move(...at(0, 0));
		await pause(100);
		check(await cursor() === 'nwse-resize', `a corner handle has its cursor (${await cursor()})`);
		await page.mouse.move(...at(50, 0));
		await pause(100);
		check(await cursor() === 'ns-resize', `and an edge handle (${await cursor()})`);
		await page.keyboard.press('Escape');
		await pause(150);
		check(await ink() === 0 && edits.length === 0, 'cancelling leaves nothing drawn, and nothing done');
	}

	// a selection carried: the selected part moves, its place is left open, the rest is as it was, and it is one edit
	{
		const at = where(100, 80);
		await menu(page, 350, 250, ['select', 'marquee']);
		await drag(at(20, 10), at(60, 50));
		check(await ink() > 0, 'a rectangular selection is drawn');
		await menu(page, 350, 250, ['transform', 'transform-image']);
		await drag(at(20, 10), at(30, 20));
		await page.keyboard.press('Enter');
		await pause(400);
		check(edits.at(-1) === 'Free Transform', `it is one edit (${edits.at(-1)})`);
		const r = await raw();
		check(px(r, 22, 12)[3] === 0, `where the selected part was, and is not now, is open (${px(r, 22, 12)})`);
		check(px(r, 45, 35)[3] === 255 && px(r, 45, 35)[0] === 200, `and the part carried is where it landed (${px(r, 45, 35)})`);
		check(px(r, 5, 5)[3] === 255 && px(r, 90, 70)[3] === 255, 'the rest is as it was');
		await send({command: 'undo'});
		await pause(300);
		const u = await raw();
		check(px(u, 22, 12)[3] === 255, 'undone, the picture is whole again');
		edits.length = 0;
	}

	// a picture of layers: flipped with its canvas, each layer where it should be
	{
		const lay = (name, left, top, w, h, c) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, () => c)});
		await load({command: 'load2d', image: {data: filled(100, 80, () => [255, 255, 255, 255]), width: 100, height: 80},
			layers: [lay('back', 0, 0, 100, 80, [0, 0, 255, 255]), lay('small', 10, 8, 40, 30, [255, 0, 0, 255]), lay('top', 60, 40, 20, 20, [0, 255, 0, 255])]}, 700);
		let r = await raw();
		check(r.layers && r.layers.length === 3 && r.layers[1].left === 10 && r.layers[1].width === 40, 'three layers are saved as three, where they were');
		await send({command: 'imageOp', op: 'flipHorizontal'});
		await pause(400);
		r = await raw();
		check(edits.at(-1) === 'Flip Horizontal', `flipping is one edit (${edits.at(-1)})`);
		check(r.layers[1].left === 50 && r.layers[1].top === 8 && r.layers[1].width === 40, `a layer goes with the canvas (${r.layers[1].left},${r.layers[1].top})`);
		await send({command: 'imageOp', op: 'rotateClockwise'});
		await pause(400);
		r = await raw();
		check(r.width === 80 && r.height === 100 && r.layers[1].width === 30 && r.layers[1].height === 40, `and turns (${r.width}x${r.height}, layer ${r.layers[1].width}x${r.layers[1].height})`);
		await send({command: 'undo'});
		await send({command: 'undo'});
		await pause(300);
		r = await raw();
		check(r.width === 100 && r.layers[1].left === 10, 'both undone, they are where they were');

		// a transform of the current layer is entered at the first click, too
		await menu(page, 350, 250, ['transform', 'transform-layer']);
		check(await ink() > 0, 'a layer is carried from the first click');
		await page.keyboard.press('Escape');
		await pause(150);

		// a layered picture cannot be made into a cubemap, and says so
		errors.length = 0;
		await send({command: 'imageOp', op: 'toCubemap'});
		await pause(300);
		check(errors.length === 1, `making it a cubemap is refused (${errors})`);
		edits.length = 0;
	}

	// an array of slices: a slice is carried from the first click
	{
		await load({command: 'load2dArray', image: {data: filled(64, 48 * 3, (x, y) => [60 + 40 * Math.floor(y / 48), 100 + x * 2, 50 + (y % 48) * 3, 255]), width: 64, height: 48 * 3}, layers: 3}, 700);
		check((await raw()).type === '2d-array', 'it is saved as an array');
		await menu(page, 350, 250, ['transform', 'transform-layer']);
		check(await ink() > 0, 'a slice is carried from the first click');
		await page.keyboard.press('Escape');
		await pause(150);
	}

	// a cubemap, and a plain image made into one
	{
		await load({command: 'loadCube', image: {data: filled(64, 64 * 6, (x, y) => [40 * Math.floor(y / 64) + 20, 100 + x * 2, 50 + (y % 64) * 3, 255]), width: 64, height: 64 * 6}}, 800);
		check((await raw()).type === 'cube', 'it is saved as a cube');
		await menu(page, 350, 250, ['transform', 'transform-layer']);
		check(await ink() > 0, 'a face is carried from the first click');
		await page.keyboard.press('Escape');
		await pause(150);

		// a stroke across the edge between two faces paints both, as one edit
		{
			await load({command: 'loadCube', image: {data: filled(64, 64 * 6, () => [255, 255, 255, 255]), width: 64, height: 64 * 6}}, 800);
			await menu(page, 350, 250, ['fold']);
			await pause(800);
			await page.keyboard.press('b');
			edits.length = 0;
			const at = (x, y) => [(W - 256) / 2 + x, (H - 192) / 2 + y];	// (unfolded, a face is a pixel to a pixel)
			await drag(at(100, 96), at(156, 96), 20);
			const r = await raw(), face = (i, x, y) => px({data: r.data.subarray(i * 64 * 64 * 4), width: 64}, x, y);
			check(face(4, 62, 32)[0] < 128, `+Z is painted up to its edge (${face(4, 62, 32)})`);
			check(face(0, 1, 32)[0] < 128, `+X is painted from its edge (${face(0, 1, 32)})`);
			check(face(0, 50, 32)[0] === 255 && face(4, 20, 32)[0] === 255, `and not beyond the stroke (${face(0, 50, 32)} ${face(4, 20, 32)})`);
			check(edits.length === 1, `it is one edit (${edits})`);
			await send({command: 'undo'});
			await pause(300);
			const u = await raw();
			check(u.data.every(v => v === 255), 'undone, both faces are whole again');
		}

		// a cross of 4 x 3 faces, as a plain image, is made into a cubemap
		await load({command: 'load2d', image: {data: filled(256, 192, (x, y) => [x, y, 128, 255]), width: 256, height: 192}});
		errors.length = 0;
		await send({command: 'imageOp', op: 'toCubemap'});
		await pause(800);
		const r = await raw();
		check(errors.length === 0 && r.type === 'cube' && r.width === 64 && r.height === 64 * 6, `a cross of faces becomes a cubemap (${errors} ${r.type} ${r.width}x${r.height})`);
	}

	// a warp: the grid dragged in its middle bends the picture (the edge between two colours bows down there, and the canvas grows to fit),
	// as one edit that undoes
	{
		const BLUE = [40, 80, 200, 255];
		await load({command: 'load2d', image: {data: filled(100, 80, (x, y) => y < 40 ? ORANGE : BLUE), width: 100, height: 80}});
		edits.length = 0;
		const at = where(100, 80);
		await menu(page, 350, 250, ['transform', 'transform-image', 'warp']);
		check(await ink() > 0, 'a warp shows its grid');
		await page.mouse.move(...at(0, 0));
		await pause(100);
		check(await cursor() === 'crosshair', `a corner of its grid is a handle (${await cursor()})`);
		await page.mouse.move(...at(50, 40));
		await pause(100);
		check(await cursor() === 'move', `and the grid can be taken hold of anywhere (${await cursor()})`);
		await drag(at(50, 40), at(50, 60));
		await page.keyboard.press('Enter');
		await pause(500);
		check(edits.at(-1) === 'Warp', `it is one edit (${edits.at(-1)})`);
		const r = await raw();
		const edge = x => { let y = 0; while (y < r.height && !(px(r, x, y)[2] > 150 && px(r, x, y)[3] > 200)) y++; return y; };
		check(r.height > 80 && r.width === 100, `the canvas grows to fit what was pulled down (${r.width}x${r.height})`);
		check(Math.abs(edge(50) - 60) <= 1 && edge(3) < edge(50) - 10, `the middle of the edge between the colours comes down with the pointer, its ends less (${edge(3)} ${edge(50)})`);
		check(px(r, 3, 3)[0] === 200, `what is by a corner stays (${px(r, 3, 3)})`);
		await send({command: 'undo'});
		await pause(300);
		const u = await raw();
		check(u.height === 80 && px(u, 50, 45)[2] === 200, 'undone, the picture is as it was');
	}

	check(problems.length === 0, `no page errors or warnings:\n     ${problems.join('\n     ')}`);
	await view.close();
	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exit(bad ? 1 : 0);
})();
