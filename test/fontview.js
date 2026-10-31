// The font viewer's page in headless Chrome: the compiled out/webview/font.js, sent what FontViewer would send it
// (fontInfo and glyphMarkup over a font read by @isopodlabs/binary_fonts), checked for the grid, the outlines drawn
// into it, the selection and the sample line.
//   FONTVIEW_FILE=x.ttf   the font to use (default: Arial's, from macOS)
//   FONTVIEW_SHOT=x.png   keeps a picture
//   FONTVIEW_INSPECT_SHOT=x.png   keeps a picture of the glyph inspector
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');
const { load, Font } = require('@isopodlabs/binary_fonts');

const ROOT = path.join(__dirname, '..');
// FontViewer.js imports what only the extension host has; the functions tested need none of it
const origLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' || request === '@isopodlabs/vscode_utils/webview' || request === './extension' || request === './BitmapViewer'
		? {Panel: class {}, Assets: class {}, EventEmitter: class {}} : origLoad.call(this, request, ...rest);
};
const { fontInfo, glyphMarkup, glyphDetail, children, curveOf } = require('../out/src/FontViewer.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const cascade = require('./cascadehost');
const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const file = process.env.FONTVIEW_FILE || '/System/Library/Fonts/Supplemental/Arial.ttf';
	let font = await load(new Uint8Array(fs.readFileSync(file)));
	if (!(font instanceof Font))
		font = font.fonts[0];
	// FONTVIEW_DECOMPOSE=1 makes the composites among the first glyphs plain outlines, as Decompose does
	if (process.env.FONTVIEW_DECOMPOSE)
		for (let i = 0; i < 80; i++)
			if (font.getGlyph(i)?.refs)
				font.setGlyph(i, {curve: curveOf(glyphDetail(font, i).points)});
	const info = {...fontInfo(font, file, 0, ['Face']), editable: !!font.glyphdata};
	check(info.numGlyphs > 10 && info.family.length > 0, `info ${info.family} ${info.numGlyphs}`);

	const server = http.createServer((req, res) => {
		const url = decodeURIComponent(req.url.split('?')[0]);
		if (url === '/index.html') {
			res.writeHead(200, {'content-type': 'text/html'});
			res.end(`<!DOCTYPE html><html><head>
				<script type="importmap">${JSON.stringify({imports: {'@isopodlabs/vscode_utils/webview/': '/node_modules/@isopodlabs/vscode_utils/dist/webview/', '@isopodlabs/maths/vector': '/node_modules/@isopodlabs/maths/esm/vector.js', '@isopodlabs/maths/geometry': '/node_modules/@isopodlabs/maths/esm/geometry.js', '@isopodlabs/binary_fonts': '/node_modules/@isopodlabs/binary_fonts/dist/browser.mjs'}})}</script>
				<link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/shared.css"><link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/tree.css"><link rel="stylesheet" href="/assets/bitmap.css"><link rel="stylesheet" href="/assets/pathedit.css"><link rel="stylesheet" href="/assets/font.css"><link rel="stylesheet" href="/assets/svg.css"><link rel="stylesheet" href="/assets/cascade.css">
				<script>window.acquireVsCodeApi = () => ({postMessage: m => window.toHost(m)});</script>
			</head><body class="tensors">
				<div id="font-toolbar"><select id="font-face" class="hidden"></select><label>Size <input id="font-size" type="number" min="6" max="1000" value="56"> px</label><label><input id="font-unicode" type="checkbox"> Mapped only</label></div>
				<div id="font-sample-box"><input id="font-sample" type="text" value="The quick brown fox"><div id="font-sample-out"></div></div>
				<div id="font-body"><div id="font-side"><div id="font-detail"></div><div id="font-layers" class="hidden"><div id="font-layer-tree" class="layer-tree"></div><div id="font-layer-props" class="layer-props"></div></div><div id="font-meta"></div><div id="font-tables"></div></div><div id="font-splitter" class="splitter"></div><div id="font-grid"></div><div id="font-inspector" class="hidden"><div id="insp-bar"><span id="insp-title"></span></div><div id="insp-view"></div></div></div>
				<pre id="scad-error" class="hidden"></pre>
				<script type="module" src="/out/webview/font.js"></script></body></html>`);
			return;
		}
		const f = path.join(ROOT, url);
		if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, {'content-type': {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'}[path.extname(f)] ?? 'application/octet-stream'});
		res.end(fs.readFileSync(f));
	});
	await new Promise(r => server.listen(0, r));

	const browser = await require('puppeteer-core').launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
	const page = await browser.newPage();
	await page.setViewport({width: 1000, height: 700});
	page.on('pageerror', e => check(false, `page error: ${e.message}`));
	let requested = 0;
	const edits = [];
	const bitmapRequests = [];
	let status = '';			// what the page last asked to be in the status bar
	await page.exposeFunction('toHost', m => {
		if (m.command === 'ready')
			page.evaluate(i => window.postMessage({command: 'font', info: i}, '*'), info);
		else if (m.command === 'getGlyphs') {
			requested += m.ids.length;
			page.evaluate((id, result) => window.postMessage({resultId: id, result}, '*'), m.requestId, Object.fromEntries(m.ids.map(i => [i, glyphMarkup(font, i)])));
		} else if (m.command === 'status') {
			status = m.text;
		} else if (m.command === 'editGlyph') {
			edits.push(m);
			font.setGlyph(m.id, {curve: curveOf(m.points)});
			page.evaluate(id => window.postMessage({command: 'glyphChanged', id}, '*'), m.id);
		} else if (m.command === 'getGlyphDetail')
			page.evaluate((id, result) => window.postMessage({resultId: id, result}, '*'), m.requestId, {...glyphDetail(font, m.id), bitmap: {ppem: 100, editable: true}});
		else if (m.command === 'editGlyphBitmap')
			bitmapRequests.push(m);
		else if (m.command === 'getTable')
			page.evaluate((id, result) => window.postMessage({resultId: id, result}, '*'), m.requestId, children(font, m.path));
		else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	});
	await page.goto(`http://localhost:${server.address().port}/index.html`);
	await pause(1000);

	const cells = await page.$$eval('.glyph-cell', c => c.length);
	check(cells === info.numGlyphs, `${cells} cells for ${info.numGlyphs} glyphs`);
	const drawn = await page.$$eval('.glyph-cell svg .outline path', p => p.length);
	check(drawn > 20, `${drawn} outlines drawn`);
	check(requested < info.numGlyphs, `only the visible glyphs asked for (${requested} of ${info.numGlyphs})`);
	const sample = await page.$$eval('#font-sample-out svg g path', p => p.length);
	check(sample > 10, `${sample} outlines in the sample line`);

	await page.click('.glyph-cell:nth-child(40)');
	await pause(300);
	check(await page.$eval('#font-detail svg .outline path', p => !!p).catch(() => false), 'selected glyph drawn large');
	check((await page.$eval('#font-detail', e => e.textContent)).includes('Advance'), 'selected glyph metrics');
	await page.click('#font-unicode');
	await pause(300);
	const mapped = await page.$$eval('.glyph-cell', c => c.length);
	check(mapped < cells && mapped > 0, `mapped only: ${mapped} of ${cells}`);

	await pause(300);
	// the tables are the shared tree: a table is a caret whose rows are asked for when it first opens
	const tops = await page.$$eval('#font-tables .tree > *', l => l.map(e => e.querySelector('.tree-key').textContent));
	check(tops.includes('head') && tops.includes('cmap'), `tables listed: ${tops.join(' ')}`);
	await page.evaluate(() => [...document.querySelectorAll('#font-tables .tree > .caret')].find(c => c.querySelector('.tree-key').textContent === 'head').id = 'test-head');
	check(await page.$eval('#test-head > .children', c => c.childElementCount === 0), 'head not read before it opens');
	await page.click('#test-head > .select');
	await pause(300);
	check(await page.$eval('#test-head', c => c.classList.contains('caret-down')), 'head opened');
	const head = await page.$$eval('#test-head > .children .tree-key', k => k.map(e => e.textContent));
	check(head.includes('units_per_em'), `head rows: ${head.slice(0, 5).join(' ')}`);
	const upm = await page.evaluate(() => [...document.querySelectorAll('#test-head > .children > .select')].find(l => l.querySelector('.tree-key').textContent === 'units_per_em')?.querySelector('.tree-value').textContent);
	check(upm?.startsWith(String(info.unitsPerEm)), `units_per_em ${upm}`);
	// the keyboard: down moves into the open table, left goes back to it, left again closes it
	await page.keyboard.press('ArrowDown');
	check(await page.$eval('#font-tables .select.cursor', e => e.querySelector('.tree-key').textContent) === head[0], 'down moves to the first row');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	check(await page.$eval('#test-head', c => !c.classList.contains('caret-down') && c.querySelector(':scope > .select').classList.contains('cursor')), 'left returns to the table and closes it');
	await page.keyboard.press('ArrowRight');
	await pause(300);
	check(await page.$eval('#test-head > .children', c => c.childElementCount) === head.length, 'reopened without reading it twice');

	// the icon menu: right-click, then the icons by id
	const menu = (ids, x, y) => cascade.menu(page, x, y, ids);

	// whether the open glyph can be edited: its contours have outlines to pick them by
	const editable = () => page.$$eval('#insp-view .insp-hit', e => e.length > 0);

	// the sample: typed into, sized by number and by wheel
	await page.click('#font-sample-out');
	await page.$eval('#font-sample', e => e.select());
	await page.keyboard.type('HEH');
	await pause(300);
	check((await page.$$eval('#font-sample-out svg > g', g => g.length)) === 3, 'typing changed the sample');
	check(await page.$$eval('#font-sample-out .sample-caret', c => c.length) === 1, 'the sample has a caret');
	const sw0 = await page.$eval('#font-sample-out svg', e => e.getBoundingClientRect().width);
	await page.mouse.move(100, 70);
	await page.mouse.wheel({deltaY: -300});
	await pause(300);
	const size = await page.$eval('#font-size', e => +e.value);
	check(size > 56 && (await page.$eval('#font-sample-out svg', e => e.getBoundingClientRect().width)) > sw0, `the wheel set the size (${size})`);
	await page.$eval('#font-size', e => { e.value = '30'; e.dispatchEvent(new Event('input')); });
	check((await page.$eval('#font-sample-out svg', e => e.getBoundingClientRect().width)) < sw0, 'the size field set the size');

	// the inspector: a glyph opened, its points and grid drawn, zoomed, stepped
	await page.click('#font-unicode');			// all glyphs again
	await pause(200);
	const cell = process.env.FONTVIEW_CELL || 40;
	await page.click(`.glyph-cell:nth-child(${cell})`);
	await page.click(`.glyph-cell:nth-child(${cell})`, {count: 2});
	await pause(600);
	check(!(await page.$eval('#font-inspector', e => e.classList.contains('hidden'))), 'inspector opened');
	check(await page.$eval('#font-grid', e => e.classList.contains('hidden')), 'grid hidden while inspecting');
	const pts = await page.$$eval('#insp-view .insp-pt', p => p.length);
	check(pts > 4, `${pts} points drawn`);
	check(await page.$$eval('#insp-view .insp-major', p => p.length === 1 && p[0].getAttribute('d').length > 20), 'grid drawn');
	check(await page.$$eval('#insp-view .insp-outline', p => p.length) === 1, 'outline drawn');
	{
		// what is under the pointer goes to the status bar
		const p0 = await page.$eval('#insp-view .insp-pt', e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
		await page.mouse.move(p0.x, p0.y);
		await pause(200);
		check(/^point \d+ ·/.test(status), `hovering a point gives the status bar its details (${status})`);
		await page.mouse.move(1, 1);
		await pause(100);
		check(/^glyph \d+/.test(status), `and moving off gives the glyph's (${status})`);
	}
	const at0 = await page.$eval('#insp-view .insp-pt', e => e.getBoundingClientRect().x);
	const box2 = await (await page.$('#insp-view')).boundingBox();
	await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
	await page.mouse.wheel({deltaY: -300});
	await pause(200);
	check((await page.$eval('#insp-view .insp-pt', e => e.getBoundingClientRect().x)) !== at0, 'wheel zoomed');
	const title = await page.$eval('#insp-title', e => e.textContent);
	await page.keyboard.press('ArrowRight');
	await pause(500);
	check((await page.$eval('#insp-title', e => e.textContent)) !== title, 'arrow key stepped to the next glyph');
	// a composite is decomposed from the menu, and is then edited like any other
	// pressing a point of a glyph that cannot be edited says why
	if (!info.editable || !await editable()) {
		const q = await page.$eval('#insp-view .insp-pt', e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }).catch(() => undefined);
		if (q) {
			await page.mouse.move(q.x, q.y);
			await page.mouse.down();
			await page.mouse.up();
			check(/read only|composite|cannot be edited/.test(status), 'pressing a point of a read-only glyph says why');
		}
	}
	// a glyph with a bitmap offers it to the bitmap editor
	{
		const gid = +(await page.$eval('#insp-title', e => e.textContent)).replace('Glyph ', '');
		const vb = await (await page.$('#insp-view')).boundingBox();
		await menu(['bitmap'], vb.x + 20, vb.y + 20);
		await pause(200);
		check(bitmapRequests.length === 1 && bitmapRequests[0].id === gid, `the host is asked to open the bitmap of glyph ${gid}: ${JSON.stringify(bitmapRequests)}`);
	}
	if (info.editable && !await editable()) {
		const vb = await (await page.$('#insp-view')).boundingBox();
		await menu(['decompose'], vb.x + 20, vb.y + 20);
		await pause(500);
		check(await editable(), 'after Decompose the glyph can be edited');
	}
	if (info.editable && await editable()) {
		// editing: drag a point, delete it, insert one, and the font is what the host was told
		const gid = +(await page.$eval('#insp-title', e => e.textContent)).replace('Glyph ', '');
		const orig = glyphDetail(font, gid).points.slice();		// (after any Decompose)
		const pt = async i => page.$$eval('#insp-view .insp-pt', (p, i) => { const r = p[i].getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, i);
		if (!process.env.FONTVIEW_SNAP) {
			// off: whole units (FONTVIEW_SNAP=1 leaves it on, as the page has it)
			const vb0 = await (await page.$('#insp-view')).boundingBox();
			await menu(['view', 'view-snap'], vb0.x + 30, vb0.y + 30);
			await page.keyboard.press('Escape');
		}
		// the right button does not drag: a right-drag from a point leaves it where it is, and the menu opens
		const r0 = await pt(2), editsBefore = edits.length;
		await page.mouse.move(r0.x, r0.y);
		await page.mouse.down({button: 'right'});
		await page.mouse.move(r0.x + 50, r0.y + 30, {steps: 4});
		await page.mouse.up({button: 'right'});
		await pause(300);
		check(edits.length === editsBefore, 'a drag with the right button moved nothing');
		check(!(await page.$eval('.cascade', e => e.classList.contains('hidden'))), 'the right button opened the menu');
		await page.keyboard.press('Escape');
		await pause(100);
		const a = await pt(2);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(a.x + 40, a.y + 20, {steps: 5});
		await page.mouse.up();
		await pause(400);
		const drag0 = edits.length - 1;
		check(edits.at(-1).label === 'Move point', `a drag was reported (${edits.map(e => e.label)})`);
		if (process.env.FONTVIEW_DRAG_SHOT)
			await page.screenshot({path: process.env.FONTVIEW_DRAG_SHOT});
		const moved = edits[drag0].points;
		check(moved[2].x !== orig[2].x && moved[2].y !== orig[2].y && moved.length === orig.length, 'the dragged point moved');
		check(moved.every((v, i) => i === 2 || (v.x === orig[i].x && v.y === orig[i].y && v.flags === orig[i].flags)), 'the others did not');
		check(font.getGlyph(edits[drag0].id).curve[2].x === Math.round(moved[2].x), 'the font holds the move');

		// a point is inserted where the menu was opened along a curve, whatever the outline's pieces are
		const nA = (await page.$$('#insp-view .insp-pt')).length, curveA = font.getGlyph(edits.at(-1).id).curve.length;
		const onOutline = await page.$$eval('#insp-view .insp-hit', p => { const e = p[0], pt = e.getPointAtLength(e.getTotalLength() * 0.37), m = e.getScreenCTM(); return {x: pt.x * m.a + m.e, y: pt.y * m.d + m.f}; });
		await menu(['edit', 'insert-here'], onOutline.x, onOutline.y);
		check(edits.at(-1).label === 'Insert point' && (await page.$$('#insp-view .insp-pt')).length > nA && font.getGlyph(edits.at(-1).id).curve.length > curveA, `a point was inserted along the outline: ${edits.at(-1).label}, ${nA} to ${(await page.$$('#insp-view .insp-pt')).length}`);

		const n0 = (await page.$$('#insp-view .insp-pt')).length;
		await page.keyboard.press('Delete');
		await pause(300);
		check((await page.$$('#insp-view .insp-pt')).length === n0 - 1 && edits.at(-1).label === 'Delete point', 'point deleted');
		const c = await pt(3);
		await page.mouse.click(c.x, c.y);
		await pause(200);
		await page.keyboard.press('ArrowRight');
		await pause(300);
		check(edits.at(-1).label === 'Move point', 'arrow nudged the picked point');
		// a contour is added by drawing a rectangle, which leaves it selected; Escape then puts the tool down
		const n1 = (await page.$$('#insp-view .insp-pt')).length;
		const vb = await (await page.$('#insp-view')).boundingBox();
		await menu(['tool', 'rect'], vb.x + 60, vb.y + 60);
		await pause(200);
		await page.mouse.move(vb.x + 60, vb.y + 60);
		await page.mouse.down();
		await page.mouse.move(vb.x + 120, vb.y + 100, {steps: 4});
		await page.mouse.up();
		await pause(300);
		check(edits.at(-1).label === 'Draw rect' && (await page.$$('#insp-view .insp-pt')).length === n1 + 4, `a contour was added: ${edits.at(-1).label}`);
		await page.keyboard.press('Escape');
		await pause(200);
		const last = edits.at(-1).points;
		check(font.getGlyph(edits.at(-1).id).curve.length >= 4 && last.slice(-4).map(v => v.flags).join() === '0,1,1,1', 'the new contour is in the font');

		// the new contour is selected: a contour is dragged by its outline, nudged by the arrows, deleted by Del
		check(await page.$$eval('#insp-view .insp-selected', p => p.length) === 1, 'the new contour is selected');
		await page.mouse.move(0, 0);
		const edge = await page.$$eval('#insp-view .insp-hit', p => { const e = p[p.length - 1], l = e.getTotalLength() * 0.1, pt = e.getPointAtLength(l), m = e.getScreenCTM(); return {x: pt.x * m.a + m.e, y: pt.y * m.d + m.f}; });
		const sq0 = edits.at(-1).points.slice(-4).map(v => ({...v}));
		await page.mouse.move(edge.x, edge.y);
		await page.mouse.down();
		await page.mouse.move(edge.x + 30, edge.y - 20, {steps: 4});
		await page.mouse.up();
		await pause(300);
		const sq1 = edits.at(-1).points.slice(-4);
		const dx = sq1[0].x - sq0[0].x, dy = sq1[0].y - sq0[0].y;
		check(edits.at(-1).label === 'Move contour' && (dx !== 0 || dy !== 0) && sq1.every((v, i) => v.x - sq0[i].x === dx && v.y - sq0[i].y === dy && v.flags === sq0[i].flags), `the contour moved as a whole (${dx}, ${dy})`);
		const nOther = edits.at(-1).points.length - 4;
		await page.keyboard.press('ArrowRight');
		await pause(200);
		check(edits.at(-1).label === 'Move contour' && edits.at(-1).points.slice(-4)[0].x === sq1[0].x + 1, 'an arrow nudged the contour');
		await page.keyboard.press('Delete');
		await pause(300);
		check(edits.at(-1).label === 'Delete contour' && edits.at(-1).points.length === nOther, 'the contour was deleted');

		// the line tool builds a polygon: a corner for each press, closed by coming back to the first
		await menu(['tool', 'line'], vb.x + 60, vb.y + 60);
		await pause(200);
		const e0 = edits.length, base = edits.at(-1).points.length;
		await page.mouse.click(vb.x + 140, vb.y + 140);
		await page.mouse.click(vb.x + 220, vb.y + 150);
		await pause(300);
		await page.mouse.click(vb.x + 260, vb.y + 230);
		await pause(300);
		await page.mouse.click(vb.x + 200, vb.y + 260);
		await pause(300);
		check(edits.slice(e0).map(x => x.label).join() === 'Draw polygon,Extend contour', `a polygon, a corner at a time, the first edit being the third point: ${edits.slice(e0).map(x => x.label)}`);
		check(edits.at(-1).points.length === base + 4 && edits.at(-1).points.slice(-4).map(v => v.flags).join() === '0,1,1,1', 'it is one contour of four points');
		await page.mouse.click(vb.x + 141, vb.y + 141);
		await pause(300);
		check(edits.at(-1).label === 'Close contour' && edits.at(-1).points.length === base + 4, `coming back to the first point closes it without adding one: ${edits.at(-1).label}`);
		// a line that is not gone on from is not left as a contour
		const kept = edits.length;
		await page.mouse.click(vb.x + 300, vb.y + 120);
		await page.mouse.click(vb.x + 340, vb.y + 140);
		await pause(200);
		const shown = (await page.$$('#insp-view .insp-pt')).length;
		await page.keyboard.press('Enter');
		await pause(200);
		check(edits.length === kept && (await page.$$('#insp-view .insp-pt')).length === shown - 2, 'Enter takes away a first line that was not gone on from, without an edit');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	}

	if (process.env.FONTVIEW_INSPECT_SHOT)
		await page.screenshot({path: process.env.FONTVIEW_INSPECT_SHOT});
	await page.keyboard.press('Escape');
	check(await page.$eval('#font-inspector', e => e.classList.contains('hidden')), 'escape closed the inspector');

	const width = () => page.$eval('#font-side', e => e.getBoundingClientRect().width);
	const w0 = await width(), box = await (await page.$('#font-splitter')).boundingBox();
	await page.mouse.move(box.x + 2, box.y + 50);
	await page.mouse.down();
	await page.mouse.move(box.x + 102, box.y + 50, {steps: 5});
	await page.mouse.up();
	const w1 = await width();
	check(Math.abs(w1 - w0 - 100) < 3, `splitter widened the side panel (dragged right) from ${w0} to ${w1}`);

	if (process.env.FONTVIEW_SHOT)
		await page.screenshot({path: process.env.FONTVIEW_SHOT});
	await browser.close();
	server.close();
	console.log(bad ? `${bad} failed` : 'font viewer ok');
	process.exit(bad ? 1 : 0);
})();
