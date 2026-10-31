// The gradient tool through the bitmap viewer's page, in headless Chrome (pagehost.js): while it is dragged the GPU shows it and the
// pixels are as they were; let go, the pixels are the gradient (black to white, every channel), as the preview showed it, and undo takes
// it away. Within an elliptical selection, and on a layer, the same; and a move over a big picture is quick.
// Run: npx tsc -b, then TS_NODE_TRANSPILE_ONLY=1 npx ts-node test/gradienttool.ts
const fs = require('fs');
const path = require('path');
const {openPage, pause} = require('./pagehost');

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const W = 700, H = 500;

(async () => {
	const edits: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: W, height: H, bitmap: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail') && !m.includes('GPU stall')) { console.log('   page:', m); bad++; } },
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
		},
	});
	await readyP;
	const {page, send, shot} = view;
	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const px = (r: any, x: number, y: number) => Array.from(new Uint8ClampedArray(r.data).subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
	const where = (w: number, h: number) => { const s = Math.min(W / w, H / h, 16); return (x: number, y: number): [number, number] => [(W - w * s) / 2 + x * s, (H - h * s) / 2 + y * s]; };
	const white = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).fill(255);
	const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
	// the tool chosen (g goes bucket, then gradient), and black to white
	const gradientTool = async () => {
		await page.keyboard.press('g');
		await page.keyboard.press('g');
		await page.keyboard.press('d');
	};

	// a plain picture: shown on the GPU while dragged, the pixels made when let go
	{
		await send({command: 'load2d', image: {data: white(100, 80), width: 100, height: 80}});
		await pause(500);
		await gradientTool();
		const at = where(100, 80);
		await page.mouse.move(...at(10, 40));
		await page.mouse.down();
		await page.mouse.move(...at(90, 40), {steps: 8});
		await frames();
		const s = await shot();
		const left = s.at(...at(5, 40).map(Math.round) as [number, number]), mid = s.at(...at(50, 40).map(Math.round) as [number, number]), right = s.at(...at(95, 40).map(Math.round) as [number, number]);
		check(left[0] < 10 && right[0] > 245 && mid[0] > 100 && mid[0] < 160, `the gradient is shown as it is dragged (${left} ${mid} ${right})`);
		let r = await raw();
		check(px(r, 5, 40)[0] === 255 && px(r, 50, 40)[0] === 255, `the pixels are as they were while it is dragged (${px(r, 5, 40)} ${px(r, 50, 40)})`);
		await page.mouse.up();
		await pause(300);
		check(edits.at(-1) === 'Gradient', `it is an edit called Gradient (${edits.at(-1)})`);
		r = await raw();
		const m = px(r, 50, 40);
		check(px(r, 5, 40)[0] === 0 && px(r, 95, 40)[0] === 255 && m[0] > 120 && m[0] < 140, `the pixels are the gradient (${px(r, 5, 40)} ${m} ${px(r, 95, 40)})`);
		check(m[0] === m[1] && m[1] === m[2] && m[3] === 255, `every channel, black to white (${m})`);
		const after = await shot();
		const shown = after.at(...at(50, 40).map(Math.round) as [number, number]);
		check(Math.abs(shown[0] - mid[0]) <= 2, `what is shown after is what the preview showed (${shown} ${mid})`);
		await send({command: 'undo'});
		await pause(300);
		r = await raw();
		check(px(r, 5, 40)[0] === 255, 'undone');
	}

	// within an elliptical selection: outside it untouched, in the preview and after
	{
		await page.keyboard.press('Escape');
		await send({command: 'load2d', image: {data: white(100, 80), width: 100, height: 80}});
		await pause(500);
		await page.keyboard.press('m');
		await page.keyboard.press('m');
		const at = where(100, 80);
		await page.mouse.move(...at(20, 20));
		await page.mouse.down();
		await page.mouse.move(...at(80, 60), {steps: 6});
		await page.mouse.up();
		await pause(200);
		await gradientTool();
		await page.mouse.move(...at(20, 40));
		await page.mouse.down();
		await page.mouse.move(...at(80, 40), {steps: 8});
		await frames();
		const s = await shot();
		const corner = s.at(...at(22, 22).map(Math.round) as [number, number]), inside = s.at(...at(25, 40).map(Math.round) as [number, number]);
		check(corner[0] > 245 && inside[0] < 60, `the preview is only within the selection (corner ${corner}, inside ${inside})`);
		await page.mouse.up();
		await pause(300);
		const r = await raw();
		check(px(r, 22, 22)[0] === 255 && px(r, 25, 40)[0] < 60, `and so are the pixels (${px(r, 22, 22)} ${px(r, 25, 40)})`);
		check(Math.abs(px(r, 25, 40)[0] - inside[0]) <= 2, `as the preview showed them (${px(r, 25, 40)} ${inside})`);
		await page.keyboard.press('Escape');
	}

	// on a layer
	{
		const w = 100, h = 80;
		await send({command: 'load2d', image: {data: white(w, h), width: w, height: h}, layers: [{name: 'a', left: 0, top: 0, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: white(w, h)}]});
		await pause(800);
		await gradientTool();
		const at = where(w, h);
		await page.mouse.move(...at(10, 40));
		await page.mouse.down();
		await page.mouse.move(...at(90, 40), {steps: 8});
		await frames();
		const s = await shot(), left = s.at(...at(5, 40).map(Math.round) as [number, number]);
		check(left[0] < 10, `a layer's gradient is shown as it is dragged (${left})`);
		await page.mouse.up();
		await pause(300);
		check(edits.at(-1) === 'Gradient', `on a layer it is an edit (${edits.at(-1)})`);
		const after = await shot(), shown = after.at(...at(5, 40).map(Math.round) as [number, number]);
		check(shown[0] < 10, `and is there once let go (${shown})`);
	}

	// a big picture: each move is the GPU's, the pixels made once
	{
		const w = 4000, h = 3000;
		await send({command: 'load2d', image: {data: white(w, h), width: w, height: h}});
		await pause(2000);
		await gradientTool();
		const at = where(w, h);
		await page.mouse.move(...at(500, 1500));
		await page.mouse.down();
		await page.mouse.move(...at(1000, 1500));
		await frames();
		const t0 = Date.now();
		for (let i = 1; i <= 10; i++) {
			await page.mouse.move(...at(1000 + i * 200, 1500 + i * 50));
			await frames();
		}
		const each = (Date.now() - t0) / 10;
		const t1 = Date.now();
		await page.mouse.up();
		await frames();
		const done = Date.now() - t1;
		console.log(`   4000x3000: ${each.toFixed(0)} ms a move, ${done} ms to let go`);
		check(each < 100, `a move over a big picture is quick (${each.toFixed(0)} ms)`);
	}

	console.log(bad ? `${bad} problems` : 'gradient tool ok');
	process.exit(bad ? 1 : 0);
})();
