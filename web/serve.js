// A static server for the web editors: node web/serve.js [port]. The pages load dozens of modules at once, which
// python's http.server resets connections under, and `file:` can't load modules at all.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root	= path.join(__dirname, '..');
const port	= +process.argv[2] || 8000;
const types	= {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.frag': 'text/plain', '.vert': 'text/plain', '.ttf': 'font/ttf', '.woff': 'font/woff'};

http.createServer((req, res) => {
	const url = decodeURIComponent(req.url.split('?')[0]);
	if (url === '/')
		return res.writeHead(302, {location: '/web/index.html'}).end();
	const file = path.join(root, url);
	if (!file.startsWith(root))
		return res.writeHead(403).end();
	fs.stat(file, (err, stat) => {
		if (err || !stat.isFile())
			return res.writeHead(404).end('not found');
		res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache'});
		fs.createReadStream(file).pipe(res);
	});
})
	.on('error', error => {
		// already running (from an earlier launch): there is nothing more to do
		if (error.code !== 'EADDRINUSE')
			throw error;
		console.log(`serving http://localhost:${port}/ (already running)`);
	})
	.listen(port, () => console.log(`serving http://localhost:${port}/ (the editors' start page)`));
