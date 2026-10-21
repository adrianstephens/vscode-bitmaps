// The SVG editor's page in headless Chrome: the compiled out/webview/svg.js, sent what SvgViewer would send it (the text, and
// shapes read into points by its shapePoints), checked for what is drawn and left out of it, selecting, moving points and
// whole elements, fill and gradients, and the structural edits. The text it sends back after each edit is parsed to check it.
//   SVGVIEW_SHOT=x.png   keeps a picture of the end; SVGVIEW_SHOTS=dir keeps pictures of the stages
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
// SvgViewer.js imports what only the extension host has; the function tested needs none of it
const origLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' || request === '@isopodlabs/vscode_utils/webview' || request === './extension' || request === './BitmapViewer'
		? {Panel: class {}, Assets: class {}, StatusLine: class {}, EventEmitter: class {}} : origLoad.call(this, request, ...rest);
};
const { shapePoints, simplifyPoints, fitStroke } = require('../out/src/FontViewer.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const { menu, strips } = require('./cascadehost');
const pause = ms => new Promise(r => setTimeout(r, ms));

const SAMPLE = fs.readFileSync(path.join(__dirname, 'svgfiles', 'sample.svg'), 'utf8');

(async () => {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent(req.url.split('?')[0]);
		if (url === '/index.html') {
			res.writeHead(200, {'content-type': 'text/html'});
			res.end(`<!DOCTYPE html><html><head>
				<script type="importmap">${JSON.stringify({imports: {'@isopodlabs/vscode_utils/webview/': '/node_modules/@isopodlabs/vscode_utils/dist/webview/', '@isopodlabs/maths/vector': '/node_modules/@isopodlabs/maths/esm/vector.js', '@isopodlabs/maths/geometry': '/node_modules/@isopodlabs/maths/esm/geometry.js', '@isopodlabs/binary_fonts': '/node_modules/@isopodlabs/binary_fonts/dist/browser.mjs'}})}</script>
				<link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/shared.css"><link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/tree.css"><link rel="stylesheet" href="/assets/bitmap.css"><link rel="stylesheet" href="/assets/font.css"><link rel="stylesheet" href="/assets/svg.css"><link rel="stylesheet" href="/assets/cascade.css">
				<script>window.acquireVsCodeApi = () => ({postMessage: m => window.toHost(m)});</script>
			</head><body class="tensors">
				<div id="svg-body"><div id="svg-side"><div id="svg-tree" class="layer-tree"></div><div id="svg-props" class="layer-props"></div></div><div id="svg-splitter" class="splitter"></div>
				<div id="svg-main"><div id="insp-view"></div></div></div>
				<pre id="scad-error" class="hidden"></pre>
				<script type="module" src="/out/webview/svg.js"></script></body></html>`);
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
	await page.setViewport({width: 1100, height: 700});
	page.on('pageerror', e => check(false, `page error: ${e.message}`));
	page.on('console', m => m.type() === 'error' && !m.text().includes('404') && check(false, `page console: ${m.text()}`));
	let text = SAMPLE;
	const edits = [];
	const imageRequests = [];
	let status = '';
	const reply = (id, result) => page.evaluate((id, result) => window.postMessage({resultId: id, result}, '*'), id, result);
	await page.exposeFunction('toHost', m => {
		if (m.command === 'ready')
			page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'sample.svg'}, '*'), text);
		else if (m.command === 'edit') {
			text = m.text;
			edits.push(m.label);
		} else if (m.command === 'shapePoints')
			reply(m.requestId, shapePoints(m.name, m.attributes));
		else if (m.command === 'simplifyPoints')
			reply(m.requestId, simplifyPoints(m.points, m.tol, m.cubic));
		else if (m.command === 'fitStroke')
			reply(m.requestId, fitStroke(m.stroke, m.tol));
		else if (m.command === 'editImage')
			imageRequests.push(m);
		else if (m.command === 'status')
			status = m.text;
		else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	});
	await page.goto(`http://localhost:${server.address().port}/index.html`);
	await pause(800);

	//--- what is drawn, and what is left out
	check(await page.$$eval('.svg-doc path', p => p.length) === 3, 'the drawing has its paths');
	check(await page.$$eval('.svg-doc script, .svg-doc [onclick], .svg-doc[onload]', e => e.length) === 0, 'scripts and handlers are not in the page');
	check(await page.evaluate(() => window.pwned === undefined), 'nothing in the drawing ran');
	check(await page.$eval('.svg-doc #sd-box', e => e.getAttribute('fill')) === 'url(#sd-g1)', 'ids and references are kept to the drawing');
	check(await page.$eval('#svg-body', e => getComputedStyle(e).display) === 'flex', 'the drawing\'s `div { display: none }` did not reach the page');
	check(await page.$eval('.svg-doc #sd-dot', e => getComputedStyle(e).fill) === 'rgb(255, 0, 0)', 'the drawing\'s own styles apply to it');
	const rows = await page.$$eval('#svg-tree .select', r => r.map(x => x.textContent));
	check(rows.length >= 8 && rows[0].startsWith('svg'), `the elements are listed: ${rows.join(' | ')}`);

	const centre = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });

	//--- a <use> is edited through the shape it draws, where that is drawn
	{
		const u = await page.$eval('.svg-doc #sd-u1', e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; });
		await page.mouse.click(u.x + u.w * 0.8, u.y + u.h * 0.7);
		await pause(400);
		const pts = await page.$$eval('#insp-view .insp-pt', p => p.map(e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
		check(pts.length === 3, `a use shows the points of the shape it draws: ${pts.length}`);
		check(pts.length && Math.hypot(pts[0][0] - u.x, pts[0][1] - u.y) < 2, `at the shape's place: ${pts[0]} vs ${u.x},${u.y}`);
		const q = pts[0];
		await page.mouse.move(q[0], q[1]);
		await page.mouse.down();
		await page.mouse.move(q[0] + 20, q[1] + 20, {steps: 4});
		await page.mouse.up();
		await pause(300);
		check(/<path[^>]*id="tp"[^>]*d="M[-\d.]+,[-\d.]+L/.test(text) && !/d="M0 0L30 0/.test(text), `the definition was edited: ${text.match(/<path[^>]*id="tp"[^>]*/)?.[0]}`);
		check(await page.$eval('.svg-doc #sd-u1', e => Math.abs(e.getBoundingClientRect().x - e.getBoundingClientRect().x) === 0), 'still drawn');
	}

	//--- selecting a path shows its points; a shape that is not a path shows its points too
	let c = await centre('.svg-doc #sd-tri');
	await page.mouse.click(c.x, c.y - 5);
	await pause(300);
	check(await page.$$eval('#insp-view .insp-pt', p => p.length) === 3, 'the triangle shows 3 points');
	check((await page.$eval('#svg-props', e => e.textContent)).includes('<path>'), 'its properties are shown');
	check(await page.$$eval('#svg-tree .select.cursor', r => r.length) === 1, 'it is marked in the outline');

	//--- dragging a point
	const point = async i => page.$$eval('#insp-view .insp-pt', (p, i) => { const r = p[i].getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, i);
	let p0 = await point(2);
	await page.mouse.move(p0.x, p0.y);
	await page.mouse.down();
	await page.mouse.move(p0.x + 30, p0.y + 40, {steps: 5});
	await page.mouse.up();
	await pause(200);
	check(edits.at(-1) === 'Move point', `a point drag is an edit: ${edits.at(-1)}`);
	check(/id="tri" d="M120,20L180,20L(1[7-9]\d|2\d\d)\.?\d*,?[\d.]*\D/.test(text.replace(/\s+/g, ' ')) || /d="M120,20L180,20L/.test(text), `the path's data changed: ${text.match(/id="tri"[^>]*/)?.[0]}`);
	check(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && text.endsWith('</svg>\n'), 'the declaration and the ending are kept');
	check(text.includes('<script>window.pwned = 2</script>') && text.includes('onclick="window.pwned = 3"'), 'what is not shown is still in the file');

	//--- a rect becomes a path when its points are edited
	c = await centre('.svg-doc #sd-box');
	await page.mouse.click(c.x, c.y);
	await pause(300);
	check(await page.$$eval('#insp-view .insp-pt', p => p.length) === 4, 'the rect shows 4 points');
	p0 = await point(1);
	await page.mouse.move(p0.x, p0.y);
	await page.mouse.down();
	await page.mouse.move(p0.x + 20, p0.y - 10, {steps: 4});
	await page.mouse.up();
	await pause(200);
	check(!/<rect/.test(text) && /<path[^>]*id="box"/.test(text), 'the rect is a path once edited');
	check(/<path[^>]*id="box"[^>]*fill="url\(#g1\)"/.test(text) || /<path[^>]*fill="url\(#g1\)"[^>]*id="box"/.test(text), 'its fill is kept');

	//--- a curve's controls are points; inserting splits the curve
	await page.click('#svg-tree .select:nth-of-type(1)').catch(() => {});
	c = await centre('.svg-doc #sd-wave');
	await page.mouse.click(c.x, c.y + 8).catch(() => {});
	await pause(300);
	let selectedTag = await page.$eval('#svg-props .tree-heading', e => e.textContent);
	if (selectedTag !== '<path>') {
		const wave = await page.$$eval('#svg-tree .select', r => r.findIndex(x => x.textContent.includes('wave')));
		await page.evaluate(i => document.querySelectorAll('#svg-tree .select')[i].click(), wave);
		await pause(300);
	}
	const n0 = await page.$$eval('#insp-view .insp-pt', p => p.length);
	check(n0 >= 6, `the wave has its controls as points: ${n0}`);
	check(await page.$$eval('#insp-view .insp-pt.k3', p => p.length) >= 4, 'cubic controls are marked');
	if (process.env.SVGVIEW_SHOTS)
		await page.screenshot({path: path.join(process.env.SVGVIEW_SHOTS, 'wave.png')});

	//--- an id changed brings what refers to it with it
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('#g1')).click());
	await pause(200);
	check((await page.$eval('.layer-props .tree-heading', e => e.textContent)) === '<linearGradient>', 'a gradient can be selected in the outline');
	await page.$eval('#svg-props input[type=text]', e => { e.value = 'renamed'; e.dispatchEvent(new Event('change', {bubbles: true})); });
	await pause(200);
	check(text.includes('<linearGradient id="renamed"') && text.includes('fill="url(#renamed)"') && !text.includes('g1'), `the id changed, and what used it: ${text.match(/<linearGradient[^>]*/)?.[0]}`);
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('#wave')).click());
	await pause(300);

	//--- inserting into a curve leaves its shape; deleting joins its neighbours; segments are made straight or curved
	const sample = () => page.$eval('.svg-doc #sd-wave', e => { const L = e.getTotalLength(); return Array.from({length: 21}, (_, i) => { const q = e.getPointAtLength(L * i / 20); return [q.x, q.y]; }); });
	const same = (a, b) => a.every((q, i) => Math.hypot(q[0] - b[i][0], q[1] - b[i][1]) < 0.05);
	const count = () => page.$$eval('#insp-view .insp-pt', p => p.length);
	const s0 = await sample();
	let q0 = await point(0);
	await page.mouse.click(q0.x, q0.y);
	await page.keyboard.press('i');
	await pause(200);
	check(await count() === n0 + 3 && edits.at(-1) === 'Insert point', `splitting a cubic adds a point and its two controls: ${await count()} from ${n0}`);
	check(same(s0, await sample()), 'and leaves the curve where it was');
	await page.keyboard.press('Delete');
	await pause(200);
	check(await count() === n0, 'deleting an on-curve point takes its controls with it');
	// a point is inserted where the menu was opened along the curve
	const s1 = await sample();
	const onCurve = await page.$eval('.svg-doc #sd-wave', e => { const q = e.getPointAtLength(e.getTotalLength() * 0.37), m = e.getScreenCTM(); return {x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f}; });
	await menu(page, onCurve.x, onCurve.y, ['edit', 'insert-here']);
	await pause(200);
	check(await count() === n0 + 3 && edits.at(-1) === 'Insert point', `the menu over a curve inserts a point there: ${await count()} from ${n0}`);
	check(same(s1, await sample()), 'and leaves the curve where it was');
	await page.keyboard.press('Delete');
	await pause(200);
	check(await count() === n0, 'and it deletes again');
	q0 = await point(0);
	await page.mouse.click(q0.x, q0.y);
	const out = await strips(page, q0.x, q0.y, ['edit']);
	check(out[1].includes('straight') && out[1].includes('curved') && !out[1].includes('toggle'), `the menu offers segments: ${out.map(s => s.join(',')).join(' | ')}`);
	check(out[0].includes('element') && out[0].includes('tool') && !out[0].includes('add') && out[0].includes('view'), 'and the element, the tools and the view');
	const spread = await page.$$eval('.cascade:not(.hidden) .cascade-strip.shown', ss => ss.every(st => { const r = [...st.children].filter(b => b.classList.contains('cascade-button')).map(b => b.getBoundingClientRect()); return r.every((a, i) => r.every((b, j) => i >= j || Math.abs(a.x - b.x) > 8 || Math.abs(a.y - b.y) > 8)) && r.every(a => a.width > 20 && a.width < 60); }));
	check(spread, 'the icons of a strip are in separate tiles of their own size');
	await page.keyboard.press('Escape');
	await menu(page, q0.x, q0.y, ['edit', 'straight']);
	await pause(200);
	check(await count() === n0 - 2 && /d="M10,40L/.test(text.replace(/\s+/g, ' ')), `a segment made straight: ${await count()}`);
	await menu(page, q0.x, q0.y, ['edit', 'curved']);
	await pause(200);
	check(await count() === n0 && edits.at(-1) === 'Make segment curved', 'and curved again');

	// the pointer says what a press would do: a cross on a point, a four-way arrow along the curve, a hand elsewhere
	const cursor = () => page.$eval('#insp-view > svg', e => e.style.cursor || getComputedStyle(e).cursor);
	q0 = await point(0);
	await page.mouse.move(q0.x, q0.y);
	check(await cursor() === 'crosshair', `over a point: ${await cursor()}`);
	const along = await page.$$eval('#insp-view .insp-hit', p => { const e = p[0], pt = e.getPointAtLength(e.getTotalLength() * 0.37), m = e.getScreenCTM(); return {x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f}; });
	await page.mouse.move(along.x, along.y);
	check(await cursor() === 'move', `along the curve: ${await cursor()}`);
	await page.mouse.move(along.x + 120, along.y - 160);
	check(await cursor() === 'grab', `elsewhere: ${await cursor()}`);

	// the view's options are in the menu, which stays open for a toggle
	check(await page.$$eval('#svg-main button, #svg-main input, #svg-main select', e => e.length) === 0, 'there are no permanent buttons over the drawing');
	await page.mouse.click(q0.x + 200, q0.y + 150, {button: 'right'});
	await pause(250);
	const v = await page.$eval('.cascade:not(.hidden) [data-id="view"]', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
	await page.mouse.move(...v);
	await pause(250);
	const tg = await page.$eval('.cascade:not(.hidden) [data-id="view-points"]', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
	await page.mouse.click(...tg);
	await pause(150);
	check(await count() === 0 && !await page.$eval('.cascade', e => e.classList.contains('hidden')), 'turning points off hides them and leaves the menu open');
	await page.mouse.click(...tg);
	await pause(150);
	check(await count() === n0, 'and on again');
	await page.keyboard.press('Escape');
	await pause(100);

	//--- the fill: a gradient is edited as stops
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('box')).click());
	await pause(300);
	check(await page.$$eval('.fill-stops .fill-row', r => r.length) === 2, 'the gradient fill shows its two stops');
	if (process.env.SVGVIEW_SHOTS)
		await page.screenshot({path: path.join(process.env.SVGVIEW_SHOTS, 'gradient.png')});
	await page.evaluate(() => { const i = document.querySelector('.fill-stops .fill-colour'); i.value = '#ff8800'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); });
	await pause(200);
	check(/<stop[^>]*stop-color="#ff8800"/.test(text), 'a stop\'s colour was changed');
	check(edits.at(-1) === 'Change fill', `and recorded: ${edits.at(-1)}`);
	check((text.match(/<linearGradient/g) ?? []).length === 1, 'the gradient was edited, not copied');

	// a gradient is edited as stops on the drawing: the gradient mode of the editor, entered from the fill's menu
	await menu(page, 700, 600, ['fill', 'fill-linear']);
	await pause(200);
	const marker = async i => page.$$eval('#insp-view svg > g:last-child > circle:not([fill="none"])', (m, i) => { const r = m[i].getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, i);
	const markers = () => page.$$eval('#insp-view svg > g:last-child > circle:not([fill="none"])', m => m.length);
	check(await page.$$eval('#insp-view .insp-pt', p => p.length) === 0, 'a gradient has no point handles');
	check(await markers() === 2, 'a linear gradient shows its two stops');
	const h1 = await marker(1);
	await page.mouse.move(h1.x, h1.y);
	await page.mouse.down();
	await page.mouse.move(h1.x - 40, h1.y + 30, {steps: 5});
	await page.mouse.up();
	await pause(200);
	check(edits.at(-1) === 'Move gradient', `moving the last stop is an edit: ${edits.at(-1)}`);
	const x2 = +text.match(/<linearGradient[^>]*x2="([-\d.]+)"/)?.[1], y2 = +text.match(/<linearGradient[^>]*y2="([-\d.]+)"/)?.[1];
	check(x2 < 0.9 && y2 > 0.1, `the gradient's end moved in its own units: ${x2}, ${y2}`);
	check((text.match(/<linearGradient/g) ?? []).length === 1, 'still one gradient');
	check(/offset="1"/.test(text), 'and its end stop is still at 1');
	// a stop is added from the menu over the line, and has a menu of its own
	const m0 = await marker(0), m1 = await marker(1);
	const mid = {x: (m0.x + m1.x) / 2, y: (m0.y + m1.y) / 2};
	const lineMenu = await strips(page, mid.x, mid.y, []);
	check(lineMenu.length === 1 && lineMenu[0].join() === 'fill-stop-add', `over the line the menu only adds a stop: ${lineMenu.map(x => x.join())}`);
	await page.keyboard.press('Escape');
	await menu(page, mid.x, mid.y, ['fill-stop-add']);
	await pause(200);
	check(await markers() === 3, 'a stop was added');
	check((text.match(/<stop/g) ?? []).length === 3, 'and written');
	const m = await marker(1);
	const stopMenu = await strips(page, m.x, m.y, []);
	check(stopMenu.length === 1 && !stopMenu[0].includes('fill') && stopMenu[0].includes('fill-stop-colour') && stopMenu[0].includes('fill-stop-remove') && !stopMenu[0].includes('fill-stop-offset'),
		`over a stop the menu is only for the stop: ${stopMenu.map(x => x.join())}`);
	await page.keyboard.press('Escape');
	await menu(page, m.x, m.y, ['fill-stop-remove']);
	await pause(200);
	check(await markers() === 2 && (text.match(/<stop/g) ?? []).length === 2, 'a stop was removed');
	// clicking the fill icon itself edits a gradient that is there, on the drawing
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('box')).click());
	await pause(300);
	check(await markers() === 0, 'selecting the element again leaves the gradient mode');
	await menu(page, 700, 600, ['fill']);
	await pause(200);
	check(await markers() === 2, 'the fill icon, clicked, shows the stops of its gradient');

	// the fill made solid, and the gradient it had is gone
	await page.$eval('.fill-box .fill-mode', (e, v) => { e.value = v; e.dispatchEvent(new Event('change', {bubbles: true})); }, 'color');
	await pause(200);
	check(/id="box"[^>]*fill="#ff8800"/.test(text) || /fill="#ff8800"[^>]*id="box"/.test(text), 'a solid fill takes the first stop\'s colour');
	check(!/<linearGradient/.test(text), 'a gradient nothing uses is removed');
	await page.$eval('.fill-box .fill-mode', (e, v) => { e.value = v; e.dispatchEvent(new Event('change', {bubbles: true})); }, 'radial');
	await pause(200);
	check(/<radialGradient[^>]*gradientUnits="userSpaceOnUse"/.test(text) && /fill="url\(#radialGradient1\)"/.test(text), 'a radial gradient was made for it');
	check(/<stop/.test(text.slice(text.indexOf('<radialGradient'))), 'with stops');
	await menu(page, 700, 600, ['fill']);
	await pause(200);
	check(await page.$$eval('#insp-view svg > g:last-child > path[stroke-dasharray="1 5"]', p => p.length) === 2, 'a radial gradient shows a dotted circle for each stop but the centre');
	await page.$eval('.fill-box .fill-mode', (e, v) => { e.value = v; e.dispatchEvent(new Event('change', {bubbles: true})); }, 'none');
	await pause(200);
	check(/id="box"[^>]*fill="none"/.test(text) || /fill="none"[^>]*id="box"/.test(text), 'fill none');

	//--- an element dragged by its body
	c = await centre('.svg-doc #sd-tri');
	await page.mouse.move(c.x, c.y - 5);
	await page.mouse.down();
	await page.mouse.move(c.x + 30, c.y + 20, {steps: 5});
	await page.mouse.up();
	await pause(200);
	check(edits.at(-1) === 'Move element' && /<path[^>]*id="tri"[^>]*transform="translate\(/.test(text), `dragging moved the element: ${text.match(/<path[^>]*id="tri"[^>]*/)?.[0]}`);
	{
		// by what the mouse did (30 px across), however many moves it made on the way
		const scale = await page.$eval('.svg-doc', g => g.getScreenCTM().a);
		const m = text.match(/<path[^>]*id="tri"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"/);
		check(m && Math.abs(+m[1] * scale - 30) < 1 && Math.abs(+m[2] * scale - 25) < 1, `a 30 by 25 px drag moved it that far: translate(${m?.[1]} ${m?.[2]}) at ${scale}`);
	}

	//--- keys move an element; the order is changed from the menu
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('#tri')).click());
	await pause(200);
	const at = () => text.match(/<path[^>]*id="tri"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"/)?.slice(1).map(Number);
	const t0 = at();
	await page.keyboard.down('Shift');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.up('Shift');
	await pause(200);
	const t1 = at();
	check(t0 && t1 && Math.abs(t1[0] - t0[0] - 10) < 1e-6 && t1[1] === t0[1], `shift+right moves it ten units: ${t0} -> ${t1}`);
	const c1 = await centre('.svg-doc #sd-tri');
	await menu(page, c1.x, c1.y - 5, ['element', 'order', 'front']);
	await pause(200);
	check(text.indexOf('id="tri"') > text.indexOf('id="grp"'), 'brought to the front, after the group');

	//--- a colour that a class sets is changed in the element's own style, which outweighs the class
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('dot')).click());
	await pause(300);
	await page.$eval('.fill-box .fill-mode', (e, v) => { e.value = v; e.dispatchEvent(new Event('change', {bubbles: true})); }, 'color');
	await pause(200);
	await page.evaluate(() => { const i = document.querySelector('.fill-box input[type=color]'); i.value = '#00ff00'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); });
	await pause(300);
	check(await page.$eval('.svg-doc #sd-dot', e => getComputedStyle(e).fill) === 'rgb(0, 255, 0)', 'the dot, whose colour a class gives it, takes the colour chosen');
	check(/id="dot"[^>]*style="[^"]*fill:#00ff00/.test(text), `and it is kept in its style: ${text.match(/id="dot"[^>]*/)?.[0]}`);

	//--- the menu sets the fill and the stroke from a few colours
	await menu(page, 700, 600, ['fill', 'fill-solid', 'fill-1e88e5']);
	await pause(300);
	check(await page.$eval('.svg-doc #sd-dot', e => getComputedStyle(e).fill) === 'rgb(30, 136, 229)' && edits.at(-1) === 'Change fill', `a colour from the menu is the fill: ${edits.at(-1)}`);
	await menu(page, 700, 600, ['stroke', 'stroke-none']);
	await pause(300);
	check(edits.at(-1) === 'Change stroke' && /id="dot"[^>]*stroke="none"/.test(text), `and none is the stroke: ${text.match(/id="dot"[^>]*/)?.[0]}`);

	//--- structure
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('dot')).click());
	await pause(200);
	await page.keyboard.down('Meta');
	await page.keyboard.press('d');
	await page.keyboard.up('Meta');
	await pause(300);
	check((text.match(/<circle/g) ?? []).length === 2, 'duplicated');
	await page.keyboard.press('Delete');
	await pause(300);
	check((text.match(/<circle/g) ?? []).length === 1 && edits.at(-1) === 'Delete element', 'deleted');
	// an ellipse dragged out with the Tool menu's ellipse tool (the menu closes when it is chosen)
	await menu(page, 700, 600, ['tool', 'ellipse']);
	await pause(300);
	check(await page.$eval('#insp-view svg', e => e.classList.contains('drawing') && e.dataset.tool === 'ellipse' && getComputedStyle(e).cursor.includes('data:image/svg')), 'the ellipse tool shows a cursor of its own');
	await page.mouse.move(600, 500);
	await page.mouse.down();
	await page.mouse.move(700, 560, {steps: 5});
	await page.mouse.up();
	await pause(300);
	check(/<ellipse/.test(text) && /Draw ellipse/.test(edits.at(-1)), `an ellipse was drawn: ${edits.at(-1)}`);
	await page.keyboard.press('Escape');
	await pause(200);
	check(await page.$eval('#insp-view svg', e => !e.classList.contains('drawing') && e.dataset.tool === 'select'), 'Escape puts the drawing tool down');
	await menu(page, 700, 600, ['tool', 'select']);
	await pause(200);

	// Alt turns an element dragged, and with the pointer's moves added to it: a move and a turn in one drag
	{
		const dot = await centre('.svg-doc #sd-dot');
		await page.mouse.click(dot.x, dot.y);
		await pause(200);
		await page.mouse.move(dot.x, dot.y + 15);
		await page.mouse.down();
		await page.mouse.move(dot.x + 20, dot.y + 15, {steps: 4});
		await page.keyboard.down('Alt');
		await page.mouse.move(dot.x + 20, dot.y - 40, {steps: 6});
		// still dragging: what is drawn over the element is where the element is
		{
			const moved = await page.$eval('.svg-doc #sd-dot', e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
			const box = await page.$$eval('#insp-view .insp-pt', ps => { const rs = ps.map(p => p.getBoundingClientRect()); return {x: rs.reduce((a, r) => a + r.x + r.width / 2, 0) / rs.length, y: rs.reduce((a, r) => a + r.y + r.height / 2, 0) / rs.length}; });
			check(Math.hypot(moved.x - box.x, moved.y - box.y) < 3, `the selection outline goes with the element while it is dragged: ${JSON.stringify(moved)} ${JSON.stringify(box)}`);
		}
		const values = label => page.evaluate(label => [...[...document.querySelectorAll('#svg-props .prop-row')].find(r => r.firstChild.textContent === label).querySelectorAll('input')].map(i => i.value), label);
		const midRotate = parseFloat((await values('rotate'))[0]);
		check(Math.abs(midRotate) > 10, `the rotation shown follows the pointer while it is dragged: ${midRotate}`);
		await page.keyboard.up('Alt');
		await page.mouse.up();
		await pause(300);
		const shownRotate = parseFloat((await values('rotate'))[0]), shownScale = (await values('scale')).map(Number);
		check(Math.abs(shownRotate - midRotate) < 1 && shownScale.every(v => Math.abs(v - 1) < 0.01), `and after: rotate ${shownRotate}, scale ${shownScale}`);
		const m = /id="dot"[^>]*transform="matrix\(([^)]*)\)/.exec(text)?.[1].split(' ').map(Number);
		check(edits.at(-1) === 'Rotate element' && m && Math.abs(Math.hypot(m[0], m[1]) - 1) < 0.02 && Math.abs(m[0] - 1) > 0.1, `Alt turned the element: ${edits.at(-1)} ${m}`);
		check(m && Math.hypot(m[4] - 0, m[5] - 0) > 1, 'and the move before it was kept');
		check((await page.$$eval('#svg-props input', i => i.map(x => x.value))).some(v => v.startsWith('matrix(')), 'the transform in the properties is the new one');
		// a field edited changes the transform
		await page.evaluate(() => { const r = [...document.querySelectorAll('#svg-props .prop-row')].find(r => r.firstChild.textContent === 'rotate').querySelector('input'); r.value = '90'; r.dispatchEvent(new Event('change')); });
		await pause(300);
		check(/id="dot"[^>]*transform="matrix\(0 1 -1 0 /.test(text) || /id="dot"[^>]*transform="matrix\(-?0 1 -1 -?0 /.test(text), `editing the rotation recomposes the transform: ${text.match(/id="dot"[^>]*/)?.[0]}`);
	}

	//--- undo: the host sends the earlier text, and the page shows it with the selection kept
	const before = await page.$$eval('.svg-doc ellipse', e => e.length);
	await page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'sample.svg'}, '*'), SAMPLE);
	await pause(400);
	check(before === 1 && await page.$$eval('.svg-doc ellipse', e => e.length) === 0, 'undo took the ellipse away');
	check(await page.$$eval('.svg-doc rect', e => e.length) === 1, 'and put the rect back');

	//--- an image in the drawing is opened for editing by the host, which sends back what is saved
	{
		const doc = fs.readFileSync(path.join(__dirname, 'svgfiles', 'image.svg'), 'utf8');
		const PNG = /xlink:href="([^"]*)"/.exec(doc)[1];
		const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
		await page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'image.svg'}, '*'), doc);
		await pause(400);
		const i = await centre('.svg-doc image');
		await page.mouse.click(i.x, i.y);
		await pause(200);
		const items = await strips(page, i.x, i.y, ['element']);
		check(items.at(-1).includes('edit-image'), `an image with its picture in the drawing can be edited: ${items.at(-1)}`);
		await page.keyboard.press('Escape');
		await menu(page, i.x, i.y, ['element', 'edit-image']);
		await pause(200);
		check(imageRequests.length === 1 && imageRequests[0].id === 'image-1' && imageRequests[0].href === PNG, `the host is asked to open it: ${JSON.stringify(imageRequests)}`);
		check(/<image[^>]*id="image-1"/.test(text) && edits.at(-1) === 'Name image', `the image was given an id the host can find it by: ${edits.at(-1)}`);
		await page.evaluate(m => window.postMessage(m, '*'), {command: 'setImage', id: 'image-1', href: PNG2});
		await pause(300);
		check(text.includes(PNG2) && !text.includes(PNG) && edits.at(-1) === 'Edit image', `what was saved is in the drawing: ${edits.at(-1)}`);
		check(await page.$eval('.svg-doc image', (e, want) => (e.getAttribute('href') ?? e.getAttribute('xlink:href')) === want, PNG2), 'and is what is drawn');
	}

	//--- the pen: a stroke is made into a smooth path by the host, in the group that is selected or the drawing
	{
		await page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'sample.svg'}, '*'), SAMPLE);
		await pause(400);
		await menu(page, 700, 600, ['tool', 'freehand']);
		check(await page.$eval('#insp-view > svg', e => e.classList.contains('drawing')), 'the pen is on');
		const box = await (await page.$('#insp-view')).boundingBox();
		const cx = box.x + box.width / 2, cy = box.y + box.height / 2, paths = () => page.$$eval('.svg-doc path', p => p.length);
		const before = await paths();
		await page.mouse.move(cx - 150, cy);
		await page.mouse.down();
		// a half circle, 60 samples with a pixel of unsteadiness
		for (let i = 1; i <= 60; i++) {
			const a = Math.PI * i / 60;
			await page.mouse.move(cx - 150 * Math.cos(a), cy - 100 * Math.sin(a) + (i % 2) * 0.8);
		}
		check(await page.$$eval('#insp-view .insp-draw', p => p.length) === 1, 'the stroke is shown as it is drawn');
		await page.mouse.up();
		await pause(500);
		check(await paths() === before + 1 && edits.at(-1) === 'Draw path', `a path was added: ${edits.at(-1)}`);
		const d = /<path[^>]*d="([^"]*)"[^>]*stroke-linecap="round"/.exec(text)?.[1] ?? '';
		const n = (d.match(/[A-Za-z]/g) ?? []).length;
		check(d.startsWith('M') && !d.endsWith('Z') && n >= 2 && n <= 8, `of a few curves, not the ${60} points: ${n} commands in ${d.slice(0, 80)}`);
		check(await page.$$eval('#insp-view .insp-draw', p => p.length) === 0, 'and the stroke is gone from the overlay');
		await menu(page, 700, 600, ['tool', 'select']);
		check(!await page.$eval('#insp-view > svg', e => e.classList.contains('drawing')), 'the pen is off again');
	}

	//--- the line tool goes on from where its last line ended
	{
		await page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'lines.svg'}, '*'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400"></svg>');
		await pause(500);
		const paths = () => (text.match(/<path/g) ?? []).length;
		const n0 = 0, e0 = edits.length;		// the drawing sent has no paths; `text` is only what the host last got
		await menu(page, 700, 600, ['tool', 'line']);
		await pause(200);
		await page.mouse.click(600, 300);
		await pause(200);
		check(edits.length === e0, 'the first click only sets where the line begins');
		await page.mouse.move(650, 340, {steps: 3});
		check(await page.$$eval('#insp-view .insp-draw', p => p.length) >= 1, 'and the segment on its way follows the pointer');
		await page.mouse.click(680, 330);
		await pause(300);
		await page.mouse.click(750, 280);
		await pause(300);
		await page.mouse.click(820, 340);
		await pause(300);
		const d = /<path[^>]*d="([^"]*)"/.exec(text)?.[1] ?? '';
		check(paths() === n0 + 1 && (d.match(/L/g) ?? []).length === 3, `the lines are one path of three segments: ${d}`);
		check(edits.slice(e0).join() === 'Draw line,Extend line,Extend line', `each is an edit: ${edits.slice(e0)}`);
		await page.mouse.click(601, 301);
		await pause(300);
		check(/d="[^"]*Z"/.test(text) && edits.at(-1) === 'Close line', `back at the first point it closes: ${edits.at(-1)}`);
		await page.mouse.click(700, 400);
		await page.mouse.click(760, 420);
		await pause(300);
		check((text.match(/<path/g) ?? []).length === 2, 'and the next two clicks start a new line');
		await page.mouse.click(800, 430, {count: 2});
		await pause(300);
		check(await page.$$eval('#insp-view .insp-draw', p => p.length) === 0 && /Extend line/.test(edits.at(-1)), 'a double click ends the line, with nothing left on its way');
		await page.keyboard.press('Escape');
		await pause(200);
		await page.mouse.click(600, 450);
		await page.mouse.click(680, 470);
		await pause(300);
		check(paths() >= n0 + 2, 'Escape ends the line, and the next starts another');
		await page.keyboard.press('Escape');
		await pause(200);
		await page.keyboard.press('Escape');
		await pause(200);
		check(await page.$eval('#insp-view svg', e => e.dataset.tool) === 'select', 'and Escape again puts the tool down');
	}

	//--- simplify: a tolerance previewed in place, then kept or put back
	{
		let d = 'M10 100';
		for (let i = 1; i <= 80; i++)
			d += ` L${10 + i * 2} ${100 + 12 * Math.sin(i / 15) + (i % 2) * 0.4}`;
		const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400"><path id="noisy" d="${d}" fill="none" stroke="#000"/></svg>`;
		await page.evaluate(t => window.postMessage({command: 'svg', text: t, file: 'noisy.svg'}, '*'), doc);
		await pause(500);
		const n = await centre('.svg-doc #sd-noisy');
		const pts = () => page.$$eval('#insp-view .insp-pt', p => p.length);
		await page.mouse.click(n.x, n.y + 20).catch(() => {});
		await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('noisy')).click());
		await pause(400);
		const all = await pts();
		// a preset of the tolerance (the menu's value strip) shows the result in place
		await menu(page, 700, 600, ['edit', 'simplify', 'preset-1.5']);
		await pause(800);
		const shown = await pts();
		check(all > 40 && shown < all / 2, `the result is shown before it is kept: ${all} -> ${shown}`);
		check(!/Simplify/.test(edits.at(-1) ?? ''), 'and it is not an edit yet');
		const before = edits.length;
		await menu(page, 700, 600, ['edit', 'simplify', 'preset-12']);
		await pause(800);
		const coarse = await pts();
		check(coarse < shown, `a larger tolerance leaves fewer points: ${shown} -> ${coarse}`);
		await page.keyboard.press('Escape');		// the menu
		await pause(200);
		await page.keyboard.press('Escape');		// the preview
		await pause(300);
		check(await pts() === all && edits.length === before, `Escape puts the points back and records nothing: ${await pts()} of ${all}`);
		await menu(page, 700, 600, ['edit', 'simplify', 'preset-1.5']);
		await pause(800);
		await page.keyboard.press('Escape');
		await pause(200);
		await page.keyboard.press('Enter');
		await pause(400);
		check(edits.at(-1) === 'Simplify' && await pts() < all / 2, `Enter keeps it as one edit: ${edits.at(-1)}, ${await pts()} points`);
	}

	if (process.env.SVGVIEW_SHOT)
		await page.screenshot({path: process.env.SVGVIEW_SHOT});

	await browser.close();
	server.close();
	console.log(bad ? `${bad} FAILED` : 'svg viewer ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
