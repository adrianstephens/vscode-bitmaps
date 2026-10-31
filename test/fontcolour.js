// Editing a colour glyph in the font viewer's page, in headless Chrome: a font whose glyphs are SVG documents (the SVG table)
// opened in the glyph inspector, where the drawing is edited by the SVG editor's session: its layers listed, a layer's fill
// changed, a point moved, and each edit put back into the font's table by what FontDocument.editSvg does (here, the same
// Font methods), then the font written and read again.
//   FONTCOLOUR_FILE=x.otf   the font (default: House of the Dragon, from ~/Library/Fonts; the test is skipped without one)
//   FONTCOLOUR_SHOT=x.png   keeps a picture
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');
const { load, Font, TTF_OTF } = require('@isopodlabs/binary_fonts');

const ROOT = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' || request === '@isopodlabs/vscode_utils/webview' || request === './extension' || request === './BitmapViewer'
		? {Panel: class {}, Assets: class {}, EventEmitter: class {}} : origLoad.call(this, request, ...rest);
};
const { fontInfo, glyphMarkup, glyphDetail, children } = require('../out/src/FontViewer.js');
const { shapePoints } = require('../out/src/FontViewer.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const cascade = require('./cascadehost');
const pause = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const file = process.env.FONTCOLOUR_FILE || path.join(process.env.HOME, 'Library/Fonts/HouseOfTheDragonColor-rge8L.otf');
	if (!fs.existsSync(file)) {
		console.log(`font colour skipped: no ${file}`);
		return;
	}
	let font = await load(new Uint8Array(fs.readFileSync(file)));
	if (!(font instanceof Font))
		font = font.fonts[0];
	const info = {...fontInfo(font, file, 0, ['Face']), editable: false};
	// the documents of the font's SVG table, each with the glyphs it draws and its text
	const svgDocuments = f => f['SVG '].documents.map(d => ({start: d.startGlyphID, end: d.endGlyphID, text: new TextDecoder().decode(d.doc.subarray(0, d.doc_length))}));
	const docIndex = id => svgDocuments(font).findIndex(d => id >= d.start && id <= d.end);
	const glyphId = +process.env.FONTCOLOUR_GLYPH || svgDocuments(font)[0].start;

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
				<div id="font-sample-box"><input id="font-sample" type="text" value="ab"><div id="font-sample-out"></div></div>
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
	await page.setViewport({width: 1200, height: 800});
	page.on('pageerror', e => check(false, `page error: ${e.message}`));
	page.on('console', m => m.type() === 'error' && !m.text().includes('404') && check(false, `page console: ${m.text()}`));
	const edits = [];
	const reply = (id, result) => page.evaluate((id, result) => window.postMessage({resultId: id, result}, '*'), id, result);
	await page.exposeFunction('toHost', m => {
		if (m.command === 'ready')
			page.evaluate(i => window.postMessage({command: 'font', info: i}, '*'), info);
		else if (m.command === 'getGlyphs')
			reply(m.requestId, Object.fromEntries(m.ids.map(i => [i, glyphMarkup(font, i)])));
		else if (m.command === 'getGlyphDetail')
			reply(m.requestId, glyphDetail(font, m.id, true));
		else if (m.command === 'getTable')
			reply(m.requestId, children(font, m.path));
		else if (m.command === 'shapePoints')
			reply(m.requestId, shapePoints(m.name, m.attributes));
		else if (m.command === 'editGlyphSvg') {
			edits.push(m);
			font.setGlyphSVG(m.id, m.text);
			page.evaluate(id => window.postMessage({command: 'glyphChanged', id, own: true}, '*'), m.id);
		} else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	});
	await page.goto(`http://localhost:${server.address().port}/index.html`);
	await pause(1200);

	const before = svgDocuments(font)[docIndex(glyphId)].text;

	// the colour glyph's thumbnail is drawn in its colours
	check(await page.$eval(`[data-id="${glyphId}"] svg`, e => e.querySelectorAll('path[fill^="#"]').length) > 0, 'the grid draws the glyph in colour');
	await page.evaluate(id => document.querySelector(`[data-id="${id}"]`).dispatchEvent(new MouseEvent('dblclick', {bubbles: true})), glyphId);
	await pause(800);
	check(!(await page.$eval('#font-inspector', e => e.classList.contains('hidden'))), 'the inspector opened');
	const vbox = await (await page.$('#insp-view')).boundingBox();
	const out = await cascade.strips(page, vbox.x + 40, vbox.y + 40, []);
	check(out[0].includes('colour') && out[0].includes('back') && out[0].includes('tool'), `a colour glyph's menu: ${out[0]}`);
	await page.keyboard.press('Escape');
	check(!(await page.$eval('#font-layers', e => e.classList.contains('hidden'))), 'its layers are listed');
	const rows = await page.$$eval('#font-layer-tree .select', r => r.map(x => x.textContent));
	check(rows.length >= 3 && rows[0].startsWith('svg'), `the layers: ${rows.slice(0, 6).join(' | ')}`);
	check(await page.$$eval('#insp-view svg', s => s.filter(x => x.style.display !== 'none').length) === 1, 'one editor shows');

	// the drawing is selected by layer, and a layer's fill is changed
	const pathRow = await page.$$eval('#font-layer-tree .select', r => r.findIndex(x => x.textContent.startsWith('path')));
	await page.evaluate(i => document.querySelectorAll('#font-layer-tree .select')[i].click(), pathRow);
	await pause(500);
	check(await page.$$eval('#insp-view .insp-pt', p => p.length) > 3, 'a layer shows its points');
	const fillBox = await page.$$eval('.fill-box .fill-colour', c => c.length);
	check(fillBox >= 1, 'it has fill options');
	const was = await page.$eval('.layer-props .fill-box .fill-colour', c => c.value);
	await page.evaluate(() => { const i = document.querySelector('.layer-props .fill-box .fill-colour'); i.value = '#123456'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); });
	await pause(400);
	check(edits.length >= 1 && edits.at(-1).label === 'Change fill', `a fill change was sent: ${edits.at(-1)?.label}`);
	const after = svgDocuments(font)[docIndex(glyphId)].text;
	check(after !== before && after.includes('#123456'), `the font's SVG table has the new colour (was ${was})`);
	check(await page.$$eval('#insp-view .svg-doc [fill="#123456"]', e => e.length) === 1, 'the drawing shows it');
	if (process.env.FONTCOLOUR_SHOT)
		await page.screenshot({path: process.env.FONTCOLOUR_SHOT.replace(/\.png$/, '-fill.png')});
	check(after.length < before.length * 1.2 && after.length > before.length * 0.8, `and little else changed: ${before.length} -> ${after.length}`);

	// a point moved
	const n = edits.length;
	const p0 = await page.$eval('#insp-view .insp-pt', e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
	await page.mouse.move(p0.x, p0.y);
	await page.mouse.down();
	await page.mouse.move(p0.x + 25, p0.y + 15, {steps: 5});
	await page.mouse.up();
	await pause(400);
	check(edits.length === n + 1 && edits.at(-1).label === 'Move point', `moving a point is an edit: ${edits.at(-1)?.label}`);
	check(svgDocuments(font)[docIndex(glyphId)].text !== after, 'the outline in the table moved');
	// the glyph still draws, in its colours, in the grid
	check(await page.$eval(`[data-id="${glyphId}"] svg`, e => e.querySelectorAll('path').length) > 0, 'the grid shows the edited glyph');

	// the outline instead
	await cascade.menu(page, vbox.x + 40, vbox.y + 40, ['colour']);
	await page.keyboard.press('Escape');
	await pause(300);
	check(await page.$eval('#font-layers', e => e.classList.contains('hidden')), 'the layers are put away');
	check(await page.$$eval('#insp-view svg', s => s.filter(x => x.style.display !== 'none').length) === 1, 'the other editor shows');
	await cascade.menu(page, vbox.x + 40, vbox.y + 40, ['colour']);
	await page.keyboard.press('Escape');
	await pause(300);

	if (process.env.FONTCOLOUR_SHOT)
		await page.screenshot({path: process.env.FONTCOLOUR_SHOT});

	// written as a font and read again, with the edits in it
	const again = await load(TTF_OTF.write(font));
	const font2 = again instanceof Font ? again : again.fonts[0];
	check(svgDocuments(font2)[docIndex(glyphId)].text === svgDocuments(font)[docIndex(glyphId)].text, 'the font written and read again has the edited drawing');

	await browser.close();
	server.close();
	console.log(bad ? `${bad} FAILED` : 'font colour ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
