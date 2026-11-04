import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
const Module = require('module');

// The SVG editor's history, which is the extension's (SvgViewer.tsx's SvgDocument, run here for real, with what VS Code would do with
// its edits done by hand): a colour turned a step at a time from the menu is one edit, whose steps after the first change it; undone,
// it goes back to before the first step, and redone to the last; an undo straight after the turning undoes it, and the steps the page
// had not yet sent are not recorded after it; and a turn after a pause is another edit.
// (npx tsc -b first, then: TS_NODE_TRANSPILE_ONLY=1 node -r <packages>/node_modules/ts-node/register test/svghistory.ts)

const ROOT = path.join(__dirname, '..');
class EventEmitter<T> {
	private listeners: ((e: T) => void)[] = [];
	event = (f: (e: T) => void) => { this.listeners.push(f); return {dispose() {}}; };
	fire(e: T) { this.listeners.forEach(f => f(e)); }
	dispose() {}
}
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
	return request === 'vscode' ? {EventEmitter, workspace: {}, Uri: {}}
		: request === '@isopodlabs/vscode_utils/webview' || request === './extension' || request === './BitmapViewer' ? {Panel: class {}, Assets: class {}, StatusLine: class {}}
		: origLoad.call(this, request, ...rest);
};
const { SvgDocument } = require('../out/src/SvgViewer.js');
const { parseSVGshape, makeCurve, bezier3Curve } = require('@isopodlabs/binary_fonts');
const shapePoints = (name: string, attributes: any) => bezier3Curve(makeCurve(parseSVGshape({name, attributes}, true) ?? {run() {}}), 1e-6);
const { strips } = require('./cascadehost');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

const SAMPLE = fs.readFileSync(path.join(__dirname, 'svgfiles', 'sample.svg'), 'utf8');

(async () => {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url ?? '').split('?')[0]);
		if (url === '/index.html') {
			res.writeHead(200, {'content-type': 'text/html'});
			res.end(`<!DOCTYPE html><html><head>
				<script type="importmap">${JSON.stringify({imports: {'@isopodlabs/vscode_utils/webview/': '/node_modules/@isopodlabs/vscode_utils/dist/webview/', '@isopodlabs/maths/vector': '/node_modules/@isopodlabs/maths/esm/vector.js', '@isopodlabs/maths/geometry': '/node_modules/@isopodlabs/maths/esm/geometry.js', '@isopodlabs/binary_fonts': '/node_modules/@isopodlabs/binary_fonts/esm/browser.js', '@isopodlabs/binary_fonts/curves': '/node_modules/@isopodlabs/binary_fonts/esm/curves.js', '@isopodlabs/binary': '/node_modules/@isopodlabs/binary/esm/index.js', '@isopodlabs/xml': '/node_modules/@isopodlabs/xml/esm/xml.js', '@isopodlabs/maths/linear': '/node_modules/@isopodlabs/maths/esm/linear.js', '@isopodlabs/maths/quaternion': '/node_modules/@isopodlabs/maths/esm/quaternion.js'}})}</script>
				<link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/shared.css"><link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/tree.css"><link rel="stylesheet" href="/assets/bitmap.css"><link rel="stylesheet" href="/assets/pathedit.css"><link rel="stylesheet" href="/assets/font.css"><link rel="stylesheet" href="/assets/svg.css"><link rel="stylesheet" href="/assets/cascade.css">
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
		res.writeHead(200, {'content-type': ({'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'} as Record<string, string>)[path.extname(f)] ?? 'application/octet-stream'});
		res.end(fs.readFileSync(f));
	});
	await new Promise<void>(r => server.listen(0, () => r()));

	const browser = await require('puppeteer-core').launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
	const page = await browser.newPage();
	await page.setViewport({width: 1100, height: 700});
	page.on('pageerror', (e: Error) => check(false, `page error: ${e.message}`));

	// the document, and VS Code's side of its history: the edits it was given, and how far back it has been taken
	const doc = new SvgDocument({fsPath: 'sample.svg', toString: () => 'sample.svg'});
	await doc.load(SAMPLE);
	const vsEdits: {label: string, undo(): void, redo(): void}[] = [];
	let position = 0;
	doc.edited.event((e: any) => { vsEdits.length = position; vsEdits.push(e); position = vsEdits.length; });
	const undo = () => vsEdits[--position].undo();
	const redo = () => vsEdits[position++].redo();
	const show = () => page.evaluate((t: string) => window.postMessage({command: 'svg', text: t, file: 'sample.svg'}, '*'), doc.text);
	doc.onDidChange(() => show());

	const reply = (id: number, result: unknown) => page.evaluate((id: number, result: unknown) => window.postMessage({resultId: id, result}, '*'), id, result);
	await page.exposeFunction('toHost', (m: any) => {
		if (m.command === 'ready')
			show();
		else if (m.command === 'edit')
			doc.edit(m.text, m.label, m.continues);
		else if (m.command === 'shapePoints')
			reply(m.requestId, shapePoints(m.name, m.attributes));
		else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	});
	await page.goto(`http://localhost:${(server.address() as any).port}/index.html`);
	await pause(800);

	const dotFill = () => /id="dot"[^>]*/.exec(doc.text)?.[0] ?? '';
	const shownFill = () => page.$eval('.svg-doc #sd-dot', (e: Element) => getComputedStyle(e).fill);
	await page.evaluate(() => [...document.querySelectorAll('#svg-tree .select')].find(x => x.textContent!.includes('dot'))!.click() as void);
	await pause(300);

	// the red of the dot's fill turned by the wheel on the menu's custom colour
	const turn = async (steps: number, deltaY = -100) => {
		await strips(page, 700, 600, ['fill', 'fill-solid', 'fill-custom', 'fill-r']);
		for (let i = 0; i < steps; i++) {
			await page.mouse.wheel({deltaY});
			await pause(40);
		}
	};

	const original = doc.text, originalShown = await shownFill();
	await turn(6);
	await pause(400);
	await page.keyboard.press('Escape');
	const turned = doc.text;
	check(vsEdits.length === 1 && vsEdits[0].label === 'Change fill', `six steps of the wheel are one edit (${vsEdits.map(e => e.label).join(', ')})`);
	check(turned !== original && dotFill() !== /id="dot"[^>]*/.exec(original)?.[0], `and the document has the last of them (${dotFill()})`);
	check(await shownFill() !== originalShown, `as the page shows (${await shownFill()})`);

	undo();
	await pause(300);
	check(doc.text === original && await shownFill() === originalShown, `undone, it is as it was before the first step (${await shownFill()})`);
	redo();
	await pause(300);
	check(doc.text === turned, 'redone, it is as after the last');

	// turned again, and undone at once: what the page had not sent is not recorded after the undo
	await pause(700);
	const before = doc.text;
	await turn(5);
	undo();
	await pause(800);
	await page.keyboard.press('Escape');
	check(vsEdits.length === 2 && position === 1, `an undo straight after turning leaves the turning undone, and nothing after it (${vsEdits.length} edits, at ${position})`);
	check(doc.text === before, 'the document is as before the turning');
	// (what the page shows is what the document is: shown it again, it is the same)
	await pause(300);
	const shownNow = await shownFill();
	await show();
	await pause(300);
	check(await shownFill() === shownNow, `and the page shows the document (${shownNow})`);

	// a point nudged by the arrow keys, a press after another, is one edit
	const centre = (sel: string) => page.$eval(sel, (e: Element) => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
	const tri = await centre('.svg-doc #sd-tri');
	await page.mouse.click(tri.x, tri.y - 5);
	await pause(300);
	const p2 = await page.$$eval('#insp-view .insp-pt', (p: Element[]) => { const r = p[2].getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
	await page.mouse.click(p2.x, p2.y);
	await pause(300);
	const unNudged = doc.text, n0 = position;
	for (let i = 0; i < 5; i++) {
		await page.keyboard.press('ArrowRight');
		await pause(40);
	}
	await pause(400);
	const triD = (t: string) => /id="tri"[^>]*d="([^"]*)"/.exec(t)?.[1];
	check(position === n0 + 1 && vsEdits[position - 1].label === 'Move point' && triD(doc.text) !== triD(unNudged), `five nudges are one edit (${vsEdits.slice(n0).map(e => e.label).join(', ')}: ${triD(doc.text)})`);
	undo();
	await pause(300);
	check(doc.text === unNudged, `undone, the point is where it was before the first (${triD(doc.text)})`);

	await browser.close();
	server.close();
	console.log(bad ? `${bad} failed` : 'all passed');
	process.exitCode = bad ? 1 : 0;
})();
