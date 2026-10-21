// The SVG editor's free transform in headless Chrome: from the menu over an element it is the element's transform that changes
// (a rect stays a rect), and from the menu over its outline or a point it is the points.
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


	const centre = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('#wave')).click());
	await pause(300);
	const attr = (id, a) => page.$eval('.svg-doc #sd-' + id, (e, a) => e.getAttribute(a), a);
	const pts = () => page.$$eval('#insp-view .insp-pt', p => p.length);
	const rotateBox = async () => {
		const hs = await page.$$eval('.insp-xf-handle', hs => hs.map(h => { const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
		const tr = hs[1], cx = (hs[0][0] + hs[2][0]) / 2, cy = (hs[0][1] + hs[2][1]) / 2;
		const out = [tr[0] + (tr[0] - cx) * 0.3, tr[1] + (tr[1] - cy) * 0.3];
		await page.mouse.move(out[0], out[1]); await page.mouse.down();
		await page.mouse.move(out[0] + 40, out[1] + 60, {steps: 8}); await page.mouse.up(); await pause(300);
		await page.keyboard.press('Enter'); await pause(300);
	};
	const select = id => page.evaluate(id => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent.includes('#' + id)).click(), id).then(() => pause(300));
	// where the menu is opened decides what is transformed: over the element, its transform; over its outline, its points
	await select('tri');
	let c = await centre('.svg-doc #sd-tri');
	await menu(page, c.x, c.y - 5, ['transform', 'transform-free']);
	check(await page.$$eval('.insp-xf-handle', h => h.length) === 8, 'the box shows');
	await rotateBox();
	check(/id="tri"[^>]*transform="matrix\(/.test(text) && /id="tri" d="M120 20 L180 20 L150 70 Z"/.test(text), `over a path's fill its transform changes: ${text.match(/<path[^>]*id="tri"[^>]*/)?.[0]}`);
	await select('tri');
	const edge = await page.$eval('.svg-doc #sd-tri', e => { const q = e.getPointAtLength(e.getTotalLength() * 0.17), m = e.getScreenCTM(); return {x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f}; });
	const t0 = text.match(/<path[^>]*id="tri"[^>]*/)[0];
	await menu(page, edge.x, edge.y, ['transform', 'transform-free']);
	await rotateBox();
	const t1 = text.match(/<path[^>]*id="tri"[^>]*/)[0];
	check(t1.match(/ d="[^"]*"/)[0] !== t0.match(/ d="[^"]*"/)[0] && t1.match(/transform="[^"]*"/)[0] === t0.match(/transform="[^"]*"/)[0], `over its outline its points: ${t1}`);
	// a rect over its fill: it stays a rect
	await select('box');
	c = await centre('.svg-doc #sd-box');
	await menu(page, c.x, c.y, ['transform', 'transform-free']);
	await rotateBox();
	check(/<rect[^>]*id="box"[^>]*transform="matrix\(/.test(text), 'a rect keeps being a rect, with a transform');
	await browser.close();
	server.close();
	process.exit(bad ? 1 : 0);
})();
