// What the launch configurations of the web pages do first (node web/start.js): build what the pages load, and make sure the server is
// there, and then finish -- an ordinary task, so that the debugger does not have to wait for background tasks to say they are ready. The server
// is left running (detached) for the next launch; stop it with the process that `lsof -i :8000` names.
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..'), port = +process.argv[2] || 8000;
const run = (command, args) => {
	const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
	if (result.status !== 0) {
		console.error(`web/start: ${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
		process.exit(1);
	}
};
const listening = () => new Promise(resolve => {
	const socket = net.connect(port, '127.0.0.1');
	socket.on('connect', () => { socket.destroy(); resolve(true); });
	socket.on('error', () => resolve(false));
});

(async () => {
	// the page's scripts (as `npm run build-link` does for the extension) and the bundles of the evaluators
	run('npm', ['run', 'build-link']);
	run('node', ['web/build.js']);

	if (await listening()) {
		console.log(`web/start: the server is already on port ${port}`);
		return;
	}
	fs.mkdirSync(path.join(root, 'out', 'web'), {recursive: true});
	const log = fs.openSync(path.join(root, 'out', 'web', 'serve.log'), 'a');
	spawn(process.execPath, ['web/serve.js', String(port)], {cwd: root, detached: true, stdio: ['ignore', log, log]}).unref();
	for (let i = 0; i < 50 && !await listening(); i++)
		await new Promise(r => setTimeout(r, 100));
	if (!await listening()) {
		console.error('web/start: the server did not start (see out/web/serve.log)');
		process.exit(1);
	}
	console.log(`web/start: serving http://localhost:${port}/`);
})();
