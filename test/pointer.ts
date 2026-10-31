// The stack of what has the pointer and the keys over an element (navigate.ts Input), in headless Chrome with the real mouse and keyboard: a
// press goes to the top layer that takes it, by place and then the last added; one layer can hand a press to those under a place (as Space
// hands it to the view); a drag is followed to its release, and tells a click from a drag; those under a layer that holds are told so, and told
// again when it goes; the cursor is the top one's that has one, and those under it are told the pointer has left them; the wheel, the right
// click and a key go to the first that takes them, but not a key typed into a field; another element can be the stack's too (an editor's
// drawing over the picture). Run: npx tsc -b, then npx ts-node test/pointer.ts
const {openPage, pause} = require('./pagehost');
let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const view = await openPage({modules: {n: 'navigate.js'}}), {page} = view;

	// an element, a stack over it, and what each layer has been given
	await page.evaluate(() => {
		const w = window as any, {Input, Place} = w.n;
		const el = document.createElement('div');
		el.id = 'stage';
		Object.assign(el.style, {position: 'absolute', left: '0', top: '0', width: '300px', height: '200px'});
		document.body.append(el);
		w.log = [] as string[];
		w.stack = Input.on(el);
		w.Place = Place;
		// a layer that writes what it is given, and takes presses of these buttons with a drag
		w.layer = (name: string, buttons: number[], extra = {}) => ({
			press: (e: PointerEvent) => buttons.includes(e.button) ? {
				move:	(m: PointerEvent) => w.log.push(`${name} move ${m.clientX}`),
				end:	(_: PointerEvent, moved: boolean) => w.log.push(`${name} end ${moved ? 'drag' : 'click'}`),
			} : undefined,
			...extra,
		});
	});
	const log = async () => page.evaluate(() => { const w = window as any, l = w.log; w.log = []; return l; });
	const run = (src: string) => page.evaluate(src);

	// the view at the bottom, the tools over it (added after, though at a lower place they are under anything added at a higher one)
	await run(`window.offTools = stack.add(layer('tools', [0], {hover: () => 'crosshair', covered: by => log.push('tools covered ' + by),
			key: e => e.key === 't' && (log.push('tools key'), true)}), Place.tools);
		window.offView = stack.add(layer('view', [0, 2], {wheel: () => (log.push('view wheel'), true), menu: () => true}), Place.view);`);

	await page.mouse.move(50, 50);
	await page.mouse.down();
	await page.mouse.move(80, 50);
	await page.mouse.move(120, 60);
	await page.mouse.up();
	let l = await log();
	check(l[0] === 'tools move 80' && l.at(-1) === 'tools end drag' && !l.some((s: string) => s.startsWith('view')), `the tools over the view take a left drag (${l})`);

	await page.mouse.click(60, 60, {button: 'right'});
	l = await log();
	check(l.includes('view end click') && !l.some((s: string) => s.startsWith('tools')), `the right button passes the tools by, to the view, as a click (${l})`);

	await page.mouse.move(100, 100);
	check(await page.$eval('#stage', (e: HTMLElement) => e.style.cursor) === 'crosshair', 'the cursor is the tools\'');

	// a layer at the tools' place added later is over them, and can give the press to the view under them
	await run(`window.offGate = stack.add({press: e => stack.press(e, Place.view)}, Place.tools);`);
	await page.mouse.click(70, 70);
	l = await log();
	check(l.length === 1 && l[0] === 'view end click', `a press handed down to the view's place goes past the tools (${l})`);
	await run('offGate()');

	// a transform over the tools holds the picture: they are told, and told again when it has gone
	await run(`window.offXf = stack.add({holds: true, ...layer('xf', [0], {hover: () => 'move', key: e => e.key === 'Enter' && (log.push('xf key'), true)})}, Place.transform);`);
	l = await log();
	check(l.length === 1 && l[0] === `tools covered ${4}`, `the tools are told a transform holds the picture (${l})`);
	await page.mouse.move(110, 100);
	check(await page.$eval('#stage', (e: HTMLElement) => e.style.cursor) === 'move', 'the cursor is the transform\'s');

	// Space: the view over everything, for now
	// the keys: the transform's own, and those it does not take go on down
	await page.keyboard.press('Enter');
	await page.keyboard.press('t');
	l = await log();
	check(l.join() === 'xf key,tools key', `a key goes to the first that takes it (${l})`);

	// (a layer over the transform with no cursor of its own, which has the pointer with it until Space comes over them)
	await run(`window.offSeen = stack.add({hover: () => undefined, leave: () => log.push('under left')}, Place.transform + 0.5);`);
	await run(`window.offPan = stack.add({press: e => stack.press(e, Place.view), hover: () => 'grab'}, Place.panning);`);
	l = await log();
	check(l.join() === 'under left', `those under Space are told the pointer has left them (${l})`);
	await page.mouse.move(100, 100);
	await page.mouse.down();
	await page.mouse.move(150, 100);
	await page.mouse.up();
	l = await log();
	check(l[0] === 'view move 150' && l.at(-1) === 'view end drag' && !l.some((s: string) => /^(xf|tools)/.test(s)), `while Space is held a drag is the view's (${l})`);
	check(await page.$eval('#stage', (e: HTMLElement) => e.style.cursor) === 'grab', 'and the cursor is the hand');
	await run('offSeen()');
	await run('offPan()');
	await page.mouse.click(100, 100);
	l = await log();
	check(l.length === 1 && l[0] === 'xf end click', `let go of Space, the transform has the press again (${l})`);

	await run('offXf()');
	l = await log();
	check(l.length === 1 && l[0] === 'tools covered undefined', `the tools are told it has gone (${l})`);
	check(await page.$eval('#stage', (e: HTMLElement) => e.style.cursor) === 'crosshair', 'and the cursor is theirs again, without the pointer moving');

	// the wheel and the right click go to the first that takes them, and the browser does not have them
	const wheeled = await page.evaluate(() => {
		const e = new WheelEvent('wheel', {deltaY: 10, cancelable: true, bubbles: true});
		document.getElementById('stage')!.dispatchEvent(e);
		return e.defaultPrevented;
	});
	l = await log();
	check(wheeled && l.length === 1 && l[0] === 'view wheel', `the wheel is the view's (${l})`);
	const menued = await page.evaluate(() => {
		const e = new MouseEvent('contextmenu', {cancelable: true, bubbles: true});
		document.getElementById('stage')!.dispatchEvent(e);
		return e.defaultPrevented;
	});
	check(menued, 'a right click a layer takes keeps the browser\'s menu away');

	// a drag lost (its capture taken) ends as a release would, once
	await page.mouse.move(50, 50);
	await page.mouse.down();
	await page.mouse.move(90, 50);
	await page.evaluate(() => document.getElementById('stage')!.releasePointerCapture(1));
	await page.mouse.up();
	l = await log();
	check(l.filter((s: string) => s.startsWith('tools end')).length === 1, `a drag whose capture is lost ends once (${l})`);

	// a key typed into a field is the field's
	await page.evaluate(() => { const i = document.createElement('input'); i.id = 'field'; document.body.append(i); i.focus(); });
	await page.keyboard.press('t');
	l = await log();
	check(l.length === 0, `a key typed into a field is not the stack's (${l})`);
	await page.evaluate(() => (document.getElementById('field') as HTMLElement).blur());

	// a drawing over the element, whose pointer is the stack's
	await page.evaluate(() => {
		const w = window as any, over = document.createElement('div');
		over.id = 'over';
		Object.assign(over.style, {position: 'absolute', left: '0', top: '0', width: '100px', height: '100px'});
		document.body.append(over);
		w.stack.include(over);
		w.offEd = w.stack.add({holds: true, ...w.layer('editor', [0], {hover: () => 'crosshair'})}, w.Place.editor);
	});
	await page.mouse.click(30, 30);
	await page.mouse.click(200, 150);
	l = await log();
	check(l.join() === 'tools covered 3,editor end click,editor end click', `presses on the drawing over it and on the element are the same stack's (${l})`);
	check(await page.$eval('#over', (e: HTMLElement) => e.style.cursor) === 'crosshair', 'and the cursor over the drawing is set on it');

	await view.close();
	console.log(bad ? `${bad} FAILED` : 'all passed');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
