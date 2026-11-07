const {openPage, pause} = require('./pagehost');
import * as items from './menuitems';

// Layer groups in the bitmap viewer's page, in headless Chrome (npx tsc -b first, then npx ts-node test/grouppage.ts). Groups come from a
// PSD's section records (an end, the group's layers, then the group); a group passing through has an adjustment in it change what is
// below the group, a normal one only its own layers; opacity, hiding and a mask apply to the group as one; a layer can be clipped to a
// group; groups are written back as section records; and layers are grouped, ungrouped, moved into and out of groups, added to them,
// dragged between them and deleted with them, each as one edit that undoes.

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const problems: string[] = [], edits: string[] = [], waiting = new Map<number, (r: any) => void>();
	let ready!: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: 500, height: 500, bitmap: true,
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
	const {send, page} = view;

	let rid = 100, r: any;
	const raw = async (): Promise<any> => {
		const id = ++rid;
		const got = new Promise(res => waiting.set(id, res));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return got;
	};
	const settle = async () => { await pause(300); r = await raw(); };
	const choose = async (ids: string[]) => { await items.choose(page, ids); await settle(); };
	const undo = async () => { await send({command: 'undo'}); await settle(); };
	const redo = async () => { await send({command: 'redo'}); await settle(); };
	const last = () => edits[edits.length - 1];

	const px = (x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)) as number[];
	const near = (x: number, y: number, c: number[]) => px(x, y).every((v, i) => Math.abs(v - c[i]) <= 2);
	const at = (x: number, y: number) => px(x, y).join();
	// the records written back: names, with a section's type (and blend mode) after them
	const records = () => (r.layers as any[]).map(l => l.blocks?.lsct ? `${l.name}:${l.blocks.lsct.type}${l.blocks.lsct.blend ? ':' + l.blocks.lsct.blend.key : ''}` : l.name).join(' ');

	const filled = (w: number, h: number, c: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(c, i * 4); return d; };
	const lay = (name: string, left: number, top: number, w: number, h: number, c: number[], more = {}) => ({name, left, top, width: w, height: h, opacity: 1, visible: true, blend: 'norm', data: filled(w, h, c), ...more});
	const empty = (name: string, blocks: any, more = {}) => ({...lay(name, 0, 0, 0, 0, [0, 0, 0, 0]), blocks, ...more});
	const end = () => empty('</Layer group>', {lsct: {key: 'lsct', type: 3}});
	const group = (name: string, blend: string, more = {}) => empty(name, {lsct: {key: 'lsct', type: 1, blend: {key: blend}}}, more);
	const load = async (layers: any[]) => {
		await send({command: 'load2d', image: {data: filled(100, 80, [255, 255, 255, 255]), width: 100, height: 80}, layers});
		await pause(700);
		r = await raw();
	};

	const RED = [255, 0, 0], CYAN = [0, 255, 255], BLUE = [0, 0, 255], YELLOW = [255, 255, 0], GREEN = [0, 255, 0], WHITE = [255, 255, 255];

	//-------------------------------------------------------------------------
	// red, under a group of a blue square with an invert over it: (10, 10) is outside the square, (30, 30) inside
	//-------------------------------------------------------------------------

	const docA = (blend: string) => [lay('back', 0, 0, 100, 80, [255, 0, 0, 255]), end(), lay('square', 20, 20, 20, 20, [0, 0, 255, 255]), empty('inv', {nvrt: {key: 'nvrt'}}), group('G', blend)];
	await load(docA('pass'));
	check(near(10, 10, CYAN) && near(30, 30, YELLOW), `passing through, the invert inverts what is below the group too (${at(10, 10)} / ${at(30, 30)})`);
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `written back as section records (${records()})`);
	check(r.layers[4].blend === 'norm', `the group's record says normal, as Photoshop has it (${r.layers[4].blend})`);

	await load(docA('norm'));
	check(near(10, 10, RED) && near(30, 30, YELLOW), `a normal group is made on its own: the invert changes only its layers (${at(10, 10)} / ${at(30, 30)})`);

	await load(docA('pass'));
	await choose(['layer', 'layer-1', 'blend', 'blend-normal', 'blend-norm']);
	check(near(10, 10, RED) && last() === 'Layer Blend Mode', `made normal from the group's menu (${at(10, 10)}; ${last()})`);
	await choose(['layer', 'layer-1', 'blend', 'blend-normal', 'blend-pass']);
	check(near(10, 10, CYAN) && records().endsWith('G:1:pass'), `and pass through again (${at(10, 10)}; ${records()})`);

	await items.turn(page, ['layer', 'layer-1', 'opacity'], -10);
	await settle();
	check(near(10, 10, [128, 128, 128]) && near(30, 30, [255, 128, 0]), `at half opacity, passing through shows half of what it made (${at(10, 10)} / ${at(30, 30)})`);
	await undo();
	check(near(10, 10, CYAN), `undone (${at(10, 10)})`);

	await choose(['layer', 'layer-1', 'visible']);
	check(near(10, 10, RED) && near(30, 30, RED) && last() === 'Hide Layer', `hidden, none of its layers show (${at(10, 10)} / ${at(30, 30)}; ${last()})`);
	await undo();

	await choose(['layer', 'layer-1', 'mask', 'mask-hide']);
	check(near(10, 10, RED) && near(30, 30, RED) && r.layers[4].mask?.default === 0, `a mask that hides all hides the group (${at(10, 10)} / ${at(30, 30)})`);
	await undo();
	check(near(10, 10, CYAN) && !r.layers[4].mask, `undone (${at(10, 10)})`);

	//-------------------------------------------------------------------------
	// a layer clipped to a group
	//-------------------------------------------------------------------------

	for (const blend of ['norm', 'pass']) {
		await load([lay('back', 0, 0, 100, 80, [255, 255, 255, 255]), end(), lay('square', 20, 20, 20, 20, [0, 0, 255, 255]), group('G', blend), lay('over', 0, 0, 100, 80, [0, 255, 0, 255], {clipped: true})]);
		check(near(10, 10, WHITE) && near(30, 30, GREEN), `clipped to a group (${blend}), a layer shows only where the group does (${at(10, 10)} / ${at(30, 30)})`);
	}

	//-------------------------------------------------------------------------
	// arranging: the current layer is the top one that is not a group (inv)
	//-------------------------------------------------------------------------

	await load(docA('pass'));
	await items.run(page, 'raiseLayer');
	await settle();
	check(records() === 'back </Layer group>:3 square G:1:pass inv' && near(10, 10, CYAN) && last() === 'Raise Layer', `raised from the top of its group, it leaves it (${records()})`);
	await items.run(page, 'lowerLayer');
	await settle();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `lowered onto the group, it goes in at its top (${records()})`);
	await items.run(page, 'lowerLayer');
	await settle();
	check(records() === 'back </Layer group>:3 inv square G:1:pass' && near(30, 30, BLUE), `and down within it (${records()}; ${at(30, 30)})`);
	await undo();
	await undo();
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `all undone (${records()})`);

	await choose(['layer', 'layer-1', 'layer-0', 'group-layer']);
	check(records() === 'back </Layer group>:3 </Layer group>:3 square Group 1:1:pass inv G:1:pass' && last() === 'Group Layers', `a layer put in a group of its own (${records()}; ${last()})`);
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `undone (${records()})`);

	await choose(['layer', 'layer-1', 'ungroup']);
	check(records() === 'back square inv' && near(10, 10, CYAN) && near(30, 30, YELLOW) && last() === 'Ungroup Layers', `ungrouped, its layers are in its place (${records()})`);
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `undone (${records()})`);

	await choose(['layer', 'new-group']);
	await choose(['layer', 'New layer']);
	check(records() === 'back </Layer group>:3 square inv </Layer group>:3 Layer 4 Group 1:1:pass G:1:pass', `a new group goes above the current layer, and a new layer into it (${records()})`);
	await undo();
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `undone (${records()})`);

	// (the fan's sheets are the layers that are not groups: back, square, inv)
	const drag = (from: number, to: number) => page.evaluate(`(async () => {
		const {mode} = await import('/out/webview/modes.js');
		const d = mode.reorderer(${from});
		d.begin(); d.to(${to}); d.drop();
	})()`);
	await drag(0, 2);
	await settle();
	check(records() === '</Layer group>:3 square inv back G:1:pass' && near(10, 10, RED) && near(30, 30, RED) && last() === 'Move Layer', `a sheet dragged above another goes into its group (${records()}; ${at(30, 30)})`);
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass', `undone (${records()})`);

	await choose(['layer', 'layer-1', 'Delete the group']);
	check(records() === 'back' && near(30, 30, RED) && last() === 'Delete Layer', `the group deleted, with its layers (${records()})`);
	await undo();
	check(records() === 'back </Layer group>:3 square inv G:1:pass' && near(10, 10, CYAN), `undone (${records()})`);
	await redo();
	check(records() === 'back', `redone (${records()})`);

	check(!problems.length, `no problems (${problems.join('; ')})`);
	await view.close();
	console.log(bad ? `${bad} FAILED` : 'all ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
