// Driving the icon menu (webview/cascade.ts) from a page test: the right button where given, then the icons by their ids,
// each hovered (which brings out its strip) until the last, which is clicked.
const pause = ms => new Promise(r => setTimeout(r, ms));

// the pointer onto an icon of a strip that is out: the icons grow about the pointer as it comes, which can leave it short of
// the one it was after, so it is moved on to where that one is now until that is the one open
async function aim(page, id) {
	for (let tries = 0; tries < 4; tries++) {
		const c = await page.$eval(`.cascade:not(.hidden) .cascade-strip.shown [data-id="${id}"]`, e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, open: e.classList.contains('open')}; });
		if (c.open)
			return c;
		await page.mouse.move(c.x, c.y);
		await pause(100);
	}
}

async function menu(page, x, y, ids) {
	await page.mouse.click(x, y, {button: 'right'});
	for (const [i, id] of ids.entries()) {
		await pause(250);
		await aim(page, id);
		if (i === ids.length - 1) {
			await page.mouse.down();
			await page.mouse.up();
		}
	}
	await pause(150);
}

// the ids in the strips that are out, innermost last, after opening the menu and hovering the ids given
async function strips(page, x, y, ids) {
	await page.mouse.click(x, y, {button: 'right'});
	for (const id of ids) {
		await pause(250);
		await aim(page, id);
	}
	await pause(250);
	return page.$$eval('.cascade:not(.hidden) .cascade-strip.shown', ss => ss.map(s => [...s.children].map(b => b.dataset.id ?? '')));
}

module.exports = {menu, strips, aim};
