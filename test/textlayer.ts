const {openPage, pause} = require('./pagehost');
const {menu, strips} = require('./cascadehost');		// (for what is not the mode's: the transforms, and the tools' place in the menu)
import * as items from './menuitems';

// Text layers in the bitmap viewer's page, in headless Chrome (npx tsc -b first, then npx ts-node test/textlayer.ts): a new text layer
// from the layer menu has its text box out to be typed into; what is typed is the layer's text, as an edit that undoes; the text carried
// by the transform tool stays text, set again where it was carried; and rasterized, it is pixels with no text.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const W = 700, H = 500, at = 350, bt = 400;		// (the menu is brought up below the text)

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
	// the dark pixels of a layer: how many, and the middle of them across
	const ink = (l: any) => {
		const d = new Uint8Array(l.data);
		let n = 0, sx = 0;
		for (let i = 0; i < l.width * l.height; i++) {
			if (d[i * 4 + 3] > 128 && d[i * 4] < 128) {
				n++;
				sx += l.left + i % l.width;
			}
		}
		return {n, x: n ? sx / n : NaN};
	};
	const editor = () => page.$eval('.textedit-host', (e: HTMLElement) => ({
		shown: e.style.display !== 'none',
		focused: document.activeElement?.classList.contains('textedit-input') ?? false,
		text: (e.querySelector('.textedit-input') as HTMLTextAreaElement).value,
	}));

	const W0 = 200, H0 = 120;
	const white = new Uint8ClampedArray(W0 * H0 * 4).fill(255);
	await send({command: 'load2d', image: {data: white, width: W0, height: H0},
		layers: [{name: 'back', left: 0, top: 0, width: W0, height: H0, opacity: 1, visible: true, blend: 'norm', data: white}]});
	await pause(700);

	// a new text layer, from the layer chooser's strip
	await items.choose(page, ['layer', 'New text layer']);
	await pause(400);
	let r = await raw(), e = await editor();
	const made = r.layers?.[1];
	check(r.layers?.length === 2 && made?.name === 'Text 1' && !!made?.blocks?.TySh, `a text layer is made (${r.layers?.map((l: any) => l.name)})`);
	check(edits.at(-1) === 'New Layer', `as an edit (${edits.at(-1)})`);
	check(e.shown && e.focused && e.text === 'Text', `its text box is out, to be typed into (${JSON.stringify(e)})`);
	const first = ink(made);
	check(first.n > 0, `and the text is drawn (${first.n} pixels)`);

	// what is typed is the layer's text
	await page.keyboard.press('End');
	await page.keyboard.type(' typed in');
	await pause(300);
	r = await raw();
	const typed = ink(r.layers[1]);
	check(typed.n > first.n * 2, `what is typed is drawn (${first.n} -> ${typed.n} pixels)`);
	check(edits.at(-1) === 'Edit Text', `as an edit (${edits.slice(-3)})`);

	// and undoes, as one edit: the text box has the text again
	await page.keyboard.press('Escape');		// (the keys were the text box's)
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	e = await editor();
	check(ink(r.layers[1]).n === first.n && e.text === 'Text', `typing undoes as one edit (${ink(r.layers[1]).n} pixels, "${e.text}")`);

	// while it is the current layer, the text's settings are in the menu in place of the tools
	const top = (await strips(page, at, bt, []))[0];
	await page.keyboard.press('Escape');
	check(top.includes('text-colour') && !top.includes('paint'), `the menu has the text's settings, not the tools (${top})`);

	// carried by the transform tool, it is still text, set again where it was carried
	const box = await page.$eval('.textedit-frame', (f: Element) => { const b = f.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; });
	await menu(page, at, bt, ['transform', 'transform-layer']);
	await page.mouse.move(box.x, box.y);
	await page.mouse.down();
	for (let i = 1; i <= 5; i++) {
		await page.mouse.move(box.x + i * 14, box.y);
		await pause(20);
	}
	await page.mouse.up();
	await page.keyboard.press('Enter');
	await pause(400);
	r = await raw();
	const moved = ink(r.layers[1]), box2 = await page.$eval('.textedit-frame', (f: Element) => f.getBoundingClientRect().x + f.getBoundingClientRect().width / 2);
	check(!!r.layers[1].blocks?.TySh, 'carried, it is still text');
	check(moved.x - first.x > 5 && Math.abs(moved.n - first.n) < first.n * 0.1, `drawn again where it was carried (${first.x.toFixed(1)} -> ${moved.x.toFixed(1)}, ${first.n} -> ${moved.n} pixels)`);
	check(box2 - box.x > 40, `and its text box went with it (${box.x.toFixed(0)} -> ${box2.toFixed(0)})`);

	// rasterized from the layer's menu: no text, and no text box
	await items.choose(page, ['layer', 'layer-1', 'Rasterize text']);
	await pause(400);
	r = await raw();
	e = await editor();
	check(!r.layers[1].blocks?.TySh && ink(r.layers[1]).n === moved.n, `rasterized, it is its pixels and no text (${edits.at(-1)})`);
	check(!e.shown, 'and the text box goes');
	await send({command: 'undo'});
	await pause(300);
	r = await raw();
	e = await editor();
	check(!!r.layers[1].blocks?.TySh && e.shown, 'undone, it is text again, with its box');

	check(problems.length === 0, `no page problems (${problems})`);
	await view.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})();
