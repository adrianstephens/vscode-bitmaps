// The scad viewer's page for real, in headless Chrome, as meshview.js does the mesh viewer's: a model evaluated and
// generated as ScadViewer does, the page's picture checked, its picker asked what is under the cursor, and its camera
// (the orbit the two viewers share) zoomed and turned.
const { evaluate } = require('../out/src/scad/evaluate.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();
const { openPage, asset, pause } = require('./pagehost.js');

const W = 400, H = 300;
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

// the 'sdf' message ScadViewer.model() makes of a file
function sdfMessage(source) {
	const {sdf, warnings, camera} = evaluate(source, '/tmp/test.scad');
	const box = bounds3(sdf), {helpers, body, data} = emitGlsl(sdf);
	const plain = v => ({x: v.x, y: v.y, z: v.z});
	return {
		command:	'sdf',
		code:		[...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n'),
		batch:		Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
		center:		plain(box.max.add(box.min).scale(0.5)),
		half:		plain(box.max.sub(box.min).scale(0.5)),
		info:		'test', warnings, camera,
	};
}

(async () => {
	let ready;
	const readyPromise = new Promise(r => ready = r);
	const view = await openPage({script: 'sdf.js', width: W, height: H, problems: m => check(false, m), host: (m, reply) => {
		if (m.command === 'getShaders')
			return reply({vert: asset('sdf.vert'), lib: asset('sdflib.frag'), frag: asset('sdf.frag').replace('//@floor', asset('floor.frag')), pick: asset('sdfpick.frag')});
		if (m.command === 'getGlyphs')
			return reply(undefined);
		if (m.command === 'ready')
			ready();
		else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	}});
	try {
		await readyPromise;
		await view.send(sdfMessage('color("red") cube(10, center = true);'));
		// the scad page draws smaller while it settles, so wait for the full-size frame
		await pause(600);
		const first = await view.shot('scad');
		const red = ([r, g, b]) => r > 100 && g < 70 && b < 70;
		check(red(first.at(W >> 1, H >> 1)), `the cube's middle should be red, not ${first.at(W >> 1, H >> 1)}`);
		const tip = await view.tooltipAt(W / 2, H / 2);
		check(/material/.test(tip), `the tooltip should describe the model: ${JSON.stringify(tip)}`);
		const before = first.count(red);
		await view.zoom(W / 2, H / 2, 60);
		await pause(300);
		const zoomed = await view.shot('scad-zoomed');
		check(zoomed.count(red) > before * 1.5, `zooming in should enlarge the cube: ${before} red pixels, then ${zoomed.count(red)}`);
		await view.turn(W / 2, H / 2, 120, 0);
		await pause(300);
		const turned = await view.shot('scad-turned');
		const samples = [...Array(15)].flatMap((_, i) => [...Array(12)].map((_, j) => [Math.round(W * (i + 0.5) / 15), Math.round(H * (j + 0.5) / 12)]));
		const moved = samples.filter(([x, y]) => red(zoomed.at(x, y)) !== red(turned.at(x, y))).length;
		check(moved > 5, `turning should change the picture: ${moved} of ${samples.length} samples changed`);
		console.log(`scad cube: tooltip ${JSON.stringify(tip.split('\n')[0])}; zoom ${before} -> ${zoomed.count(red)} red pixels, turn changed ${moved} samples`);
	} finally {
		await view.close();
	}
	console.log(bad ? `${bad} FAILED` : 'ok: the scad viewer draws, picks, zooms and turns');
	process.exit(bad ? 1 : 0);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
