// Bundles what a web page's host needs of src/ and the packages it uses into out/web/ (node web/build.js): the SCAD evaluator and the mesh
// model (the readers and writers of mesh formats), with the Node
// modules it reaches for put aside (web/shims). esbuild is the packages' (their package.json has it); this project does not add it, as an
// npm install here would replace the linked packages.
const path = require('path');
const fs = require('fs');

function findEsbuild() {
	for (const dir of [__dirname + '/..', __dirname + '/../../../packages']) {
		try { return require(require.resolve('esbuild', {paths: [dir]})); } catch { /* not there */ }
	}
	throw new Error('esbuild is not installed here or in ../../packages');
}

const shim = name => path.join(__dirname, 'shims', name);
const bundles = {
	scad: 'src/scad/render.ts',
	mesh: 'src/meshmodel.ts',
};

(async () => {
	const esbuild = findEsbuild();
	const watching = process.argv.includes('--watch');
	for (const [name, entry] of Object.entries(bundles)) {
		const options = {
			entryPoints:	[path.join(__dirname, '..', entry)],
			outfile:		path.join(__dirname, '..', 'out', 'web', `${name}.js`),
			bundle:			true,
			format:			'esm',
			platform:		'browser',
			conditions:		['browser'],
			sourcemap:		'inline',
			logLevel:		'warning',
			alias:			{'path/posix': shim('path.js'), path: shim('path.js'), fs: shim('node.js'), 'fs/promises': shim('node.js'), os: shim('node.js'), zlib: shim('node.js'), crypto: shim('node.js')},
			inject:			[shim('buffer.js')],
			define:			{'process.env.NODE_ENV': '"production"'},
		};
		if (watching)
			await (await esbuild.context(options)).watch();
		else
			await esbuild.build(options);
		console.log(`${watching ? 'watching' : 'built'} out/web/${name}.js`);
	}
})().catch(error => { console.error(error.message ?? error); process.exit(1); });
