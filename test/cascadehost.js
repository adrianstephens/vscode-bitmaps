// Driving the icon menu (webview/cascade.ts) from a page test: the right button where given, then the icons by their ids,
// each hovered (which brings out its strip) until the last, which is clicked.
const pause = ms => new Promise(r => setTimeout(r, ms));

async function menu(page, x, y, ids) {
	await page.mouse.click(x, y, {button: 'right'});
	for (const [i, id] of ids.entries()) {
		await pause(250);
		const c = await page.$eval(`.cascade:not(.hidden) .cascade-strip.shown [data-id="${id}"]`, e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
		if (i === ids.length - 1)
			await page.mouse.click(c.x, c.y);
		else
			await page.mouse.move(c.x, c.y);
	}
	await pause(150);
}

// the ids in the strips that are out, innermost last, after opening the menu and hovering the ids given
async function strips(page, x, y, ids) {
	await page.mouse.click(x, y, {button: 'right'});
	for (const id of ids) {
		await pause(250);
		const c = await page.$eval(`.cascade:not(.hidden) .cascade-strip.shown [data-id="${id}"]`, e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
		await page.mouse.move(c.x, c.y);
	}
	await pause(250);
	return page.$$eval('.cascade:not(.hidden) .cascade-strip.shown', ss => ss.map(s => [...s.children].map(b => b.dataset.id ?? '')));
}

module.exports = {menu, strips};
