// The icon menu (cascade.ts) over a picture with a stack (navigate.ts Input), in headless Chrome with the real mouse: a left press on the
// picture while the menu is open closes it and does only that (the tools under it are not given it); the next press is theirs. A press
// away from the picture closes it too, and goes on to what it was on. The menu does not come up while the page does not have the focus.
// Run: npx tsc -b, then npx ts-node -T test/cascadedismiss.ts
const {openPage, pause} = require('./pagehost');
let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

(async () => {
	const view = await openPage({modules: {n: 'navigate.js', c: 'cascade.js'}}), {page} = view;

	await page.evaluate(() => {
		const w = window as any, {Input, Place} = w.n, {Cascade, svgFace} = w.c;
		const stage = document.createElement('div');
		Object.assign(stage.style, {position: 'absolute', left: '0', top: '0', width: '300px', height: '300px'});
		const picture = document.createElement('div');
		Object.assign(picture.style, {position: 'absolute', inset: '0'});
		stage.append(picture);
		const outside = document.createElement('button');
		Object.assign(outside.style, {position: 'absolute', left: '320px', top: '10px', width: '60px', height: '30px'});
		document.body.append(stage, outside);

		w.log = [] as string[];
		outside.addEventListener('pointerdown', () => w.log.push('outside'));
		const icon = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
		w.menu = new Cascade(stage, () => [{id: 'a', face: () => svgFace(icon), caption: () => 'A', select: () => {}}]);
		const input = Input.on(picture);
		input.add({press: (e: PointerEvent) => e.button === 0 ? (w.log.push('tools'), true) : undefined}, Place.tools);
		input.add({menu: (e: MouseEvent) => (w.menu.open(e.clientX, e.clientY), true)}, Place.page);
	});
	const state = () => page.evaluate(() => { const w = window as any, l = w.log.join(','); w.log = []; return {log: l, open: w.menu.isOpen}; });

	await page.mouse.click(50, 50, {button: 'right'});
	await pause(100);
	check((await state()).open, 'the right click opens the menu');

	await page.mouse.click(250, 250);
	await pause(50);
	let s = await state();
	check(!s.open && s.log === '', `a press on the picture closes the menu, and the tools are not given it (${s.log})`);

	await page.mouse.click(250, 250);
	s = await state();
	check(s.log === 'tools', `the next press is the tools' (${s.log})`);

	await page.mouse.click(50, 50, {button: 'right'});
	await pause(100);
	await page.mouse.click(350, 25);
	await pause(50);
	s = await state();
	check(!s.open && s.log === 'outside', `a press away from the picture closes the menu and goes on to what it was on (${s.log})`);

	// the page without the focus (VS Code's window right-clicked while another application has it): the menu does not come up
	await page.evaluate(() => { document.hasFocus = () => false; });
	await page.mouse.click(50, 50, {button: 'right'});
	await pause(100);
	check(!(await state()).open, 'the right click does not open the menu while the page does not have the focus');

	await view.close();
	console.log(bad ? `${bad} failed` : 'all ok');
	process.exit(bad ? 1 : 0);
})();
