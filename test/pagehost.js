// A webview page of this extension, run for real in headless Chrome with a stand-in for the extension on the other
// side: the page's files served as the webview's resource roots would serve them, its messages to the extension handed
// to `host`, and what the extension would send it posted to it. The 3D viewers' page, or the bitmap viewer's (`bitmap`), whose
// shaders are served from BitmapViewer.tsx's own table; or, for a test of some of the bitmap viewer's modules, a page of just those.
const fs = require('fs');
const path = require('path');
const http = require('http');
const bitmaps = require('@isopodlabs/binary_bitmaps');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');
const asset = name => fs.readFileSync(path.join(ROOT, 'assets', name), 'utf8');

// the bitmap viewer's shaders by name, read from the table BitmapViewer.tsx serves its page from (so no test keeps a list of its own)
const shaderFiles = () => Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'src', 'BitmapViewer.tsx'), 'utf8')
	.matchAll(/'([\w-]+)':\s*\{\s*vert:\s*'([^']+)',\s*frag:\s*'([^']+)'/g)].map(([, name, vert, frag]) => [name, {vert: asset(vert), frag: asset(frag)}]));

// The page's own script, or (for a test of some modules rather than the whole viewer) one that loads `modules` ({name: 'file.js'} of
// out/webview, or a package's '@...', each put on window as its name), the shaders first if `programs`, and then sets window.ready.
// 'file.js?internals' is the module with what it does not export exported too (see `internals`).
function entry(script, modules, programs) {
	if (!modules)
		return `<script type="module" src="/out/webview/${script}"></script>`;
	return `<script type="module">
		import {handleResult} from '@isopodlabs/vscode_utils/webview/shared.js';
		window.addEventListener('message', e => handleResult(e.data));
		${programs ? `await (await import('/out/webview/modes.js')).loadPrograms();` : ''}
		${Object.entries(modules).map(([name, file]) => `window.${name} = await import('${file.startsWith('@') ? file : `/out/webview/${file}`}');`).join('\n')}
		window.ready = true;
	</script>`;
}

// A module of tsc's with everything it declares at its top level exported, for a test of what the module keeps to itself: the source
// says by not exporting it that nothing else uses it, and the test does not change that. (It is a module of its own, apart from the file
// as other modules import it, so its state is its own.)
const internals = js => js.replace(/^(?=(?:async function|function|const|let|class) )/gm, 'export ');

// `bitmap` serves the bitmap viewer's page (its stage, overlay and menu styles) in place of the 3D viewers'
function serve(script, width, height, bitmap, modules, programs) {
	const types = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'};
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const url = decodeURIComponent(req.url.split('?')[0]);
			if (url === '/index.html') {
				res.writeHead(200, {'content-type': 'text/html'});
				res.end(bitmap ? `<!DOCTYPE html><html><head>
					<script type="importmap">${JSON.stringify({imports: {
						'@isopodlabs/vscode_utils/webview/': '/node_modules/@isopodlabs/vscode_utils/dist/webview/',
						'@isopodlabs/maths/vector': '/node_modules/@isopodlabs/maths/esm/vector.js', '@isopodlabs/maths/geometry': '/node_modules/@isopodlabs/maths/esm/geometry.js', '@isopodlabs/binary_fonts': '/node_modules/@isopodlabs/binary_fonts/esm/browser.js', '@isopodlabs/binary': '/node_modules/@isopodlabs/binary/esm/index.js', '@isopodlabs/xml': '/node_modules/@isopodlabs/xml/esm/xml.js', '@isopodlabs/maths/linear': '/node_modules/@isopodlabs/maths/esm/linear.js',
						'@isopodlabs/maths/quaternion': '/node_modules/@isopodlabs/maths/esm/quaternion.js',
					}})}</script>
					<link rel="stylesheet" href="/node_modules/@isopodlabs/vscode_utils/assets/shared.css">
					<link rel="stylesheet" href="/assets/bitmap.css">
					<link rel="stylesheet" href="/assets/cascade.css">
					<script>
						// what the page sends the extension, with its buffers as text (page.evaluate and exposeFunction carry only JSON)
						const b64 = buffer => { let s = ''; for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b); return btoa(s); };
						const enc = v => v instanceof ArrayBuffer ? {__buffer: b64(v)} : ArrayBuffer.isView(v) ? {__buffer: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))} : Array.isArray(v) ? v.map(enc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
						window.acquireVsCodeApi = () => ({postMessage: m => window.toHost(enc(m))});
					</script>
				</head><body>
					<div id="bitmap-root"><div id="bitmap-main"><div id="bitmap-stage"><canvas id="viewport"></canvas><canvas id="overlay" class="hidden"></canvas><canvas id="transform-overlay" class="hidden"></canvas></div></div></div>
					${entry(script, modules, programs)}</body></html>` : `<!DOCTYPE html><html><head>
					<script type="importmap">${JSON.stringify({imports: {
						'@isopodlabs/vscode_utils/webview/': '/node_modules/@isopodlabs/vscode_utils/dist/webview/',
						'@isopodlabs/maths/vector': '/node_modules/@isopodlabs/maths/esm/vector.js', '@isopodlabs/maths/geometry': '/node_modules/@isopodlabs/maths/esm/geometry.js', '@isopodlabs/binary_fonts': '/node_modules/@isopodlabs/binary_fonts/esm/browser.js', '@isopodlabs/binary': '/node_modules/@isopodlabs/binary/esm/index.js', '@isopodlabs/xml': '/node_modules/@isopodlabs/xml/esm/xml.js', '@isopodlabs/maths/linear': '/node_modules/@isopodlabs/maths/esm/linear.js',
						'@isopodlabs/maths/quaternion': '/node_modules/@isopodlabs/maths/esm/quaternion.js',
					}})}</script>
					<link rel="stylesheet" href="/assets/scad.css">
					<link rel="stylesheet" href="/assets/cascade.css">
					<style>html, body, #main { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden } canvas { width: 100%; height: 100%; display: block } .hidden { display: none }</style>
					<script>window.acquireVsCodeApi = () => ({postMessage: m => window.toHost(m)});</script>
				</head><body><div id="main"><canvas id="viewport"></canvas><div id="scad-tooltip" class="hidden"></div><div id="scad-info"></div><pre id="scad-error" class="hidden"></pre></div>
				<script type="module" src="/out/webview/${script}"></script></body></html>`);
				return;
			}
			const file = path.join(ROOT, url);
			if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream'});
			res.end(/[?&]internals\b/.test(req.url) && file.endsWith('.js') ? internals(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file));
		});
		server.listen(0, () => resolve(server));
	});
}

// typed arrays across page.evaluate, which only carries JSON
const pack = v => ArrayBuffer.isView(v) ? {__typed: v.constructor.name, data: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')}
	: Array.isArray(v) ? v.map(pack) : v && typeof v === 'object' && !(v instanceof Map) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)])) : v;
function unpack(v) {
	const un = v => v && v.__typed ? new globalThis[v.__typed](Uint8Array.from(atob(v.data), c => c.charCodeAt(0)).buffer)
		: Array.isArray(v) ? v.map(un) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, un(x)])) : v;
	return un(v);
}
const unpackInPage = new Function('v', `window.postMessage((${unpack})(v), '*');`);

const pause = ms => new Promise(r => setTimeout(r, ms));

// host(message, reply) answers what the page asks: reply(result) for a request, or nothing for a notice (the bitmap viewer's shaders
// are answered here). problems(msg) is told of anything the page reports or throws. With `modules` (a bitmap page), the page is
// those modules on window, and is ready when this returns.
async function openPage({script, width = 400, height = 300, host = () => {}, problems = m => console.log(`   page: ${m}`), bitmap = false, modules, programs = false}) {
	const server = await serve(script, width, height, bitmap || !!modules, modules, programs);
	const shaders = bitmap || modules ? shaderFiles() : {};
	const browser = await require('puppeteer-core').launch({executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']});
	const page = await browser.newPage();
	await page.setViewport({width, height});
	page.on('pageerror', e => problems(`page error: ${e.message}`));
	page.on('console', m => (m.type() === 'error' || m.type() === 'warn') && !m.text().includes('404') && problems(`page console: ${m.text()}`));
	// (buffers the page sent come as {__buffer: base64})
	const decode = v => v && v.__buffer !== undefined ? Buffer.from(v.__buffer, 'base64') : Array.isArray(v) ? v.map(decode) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)])) : v;
	const reply = m => result => page.evaluate(unpackInPage, pack({resultId: m.requestId, result}));
	await page.exposeFunction('toHost', m => m.command === 'getShaders' && shaders[m.type] ? reply(m)(shaders[m.type]) : host(decode(m), reply(m)));
	await page.goto(`http://localhost:${server.address().port}/index.html`);
	if (modules)
		await page.waitForFunction('window.ready === true');
	return {
		page,
		send:		message => page.evaluate(unpackInPage, pack(message)),
		// fn run in the page on args that may hold typed arrays (page.evaluate alone carries only JSON); what it gives back is JSON
		evaluate:	(fn, ...args) => page.evaluate(`(${fn})(...(${unpack})(${JSON.stringify(pack(args))}))`),
		// the picture as rgba, with a lookup by pixel; kept as name.png in MESHVIEW_SHOTS when that is set
		shot:		async name => {
			const png = await page.screenshot({type: 'png'});
			if (name && process.env.MESHVIEW_SHOTS)
				fs.writeFileSync(path.join(process.env.MESHVIEW_SHOTS, `${name}.png`), png);
			const image = await (await bitmaps.PNG.load(new Uint8Array(png))).getPixels({plane: 'RGBA'});
			const at = (x, y) => Array.from(image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
			return {at, width: image.width, height: image.height, count: test => {
				let n = 0;
				for (let y = 0; y < image.height; y++)
					for (let x = 0; x < image.width; x++)
						n += test(at(x, y)) ? 1 : 0;
				return n;
			}};
		},
		tooltipAt:	async (x, y, wait = 200) => {
			await page.mouse.move(x, y);
			await pause(wait);
			return page.$eval('#scad-tooltip', e => e.classList.contains('hidden') ? '' : e.textContent);
		},
		info:		() => page.$eval('#scad-info', e => e.textContent),
		// a turn: a drag with the right button, as the viewers take one
		turn:		async (x, y, dx, dy) => {
			await page.mouse.move(x, y);
			await page.mouse.down({button: 'right'});
			for (let i = 1; i <= 5; i++)
				await page.mouse.move(x + dx * i / 5, y + dy * i / 5);
			await page.mouse.up({button: 'right'});
			await pause(300);
		},
		zoom:		async (x, y, deltaY) => {
			await page.mouse.move(x, y);
			await page.mouse.wheel({deltaY});
			await pause(300);
		},
		browser,
		close:		async () => {
			await browser.close();
			server.close();
		},
	};
}

module.exports = { openPage, asset, pause };
