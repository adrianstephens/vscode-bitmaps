// The mesh viewer's page for real, in headless Chrome: the compiled out/webview/mesh.js, sent what the extension would
// send it (renderData over models read by @isopodlabs/binary_meshes), and the picture it draws checked pixel by pixel --
// colours, textures the right way up, instances, the floor -- its picker asked what is where, and its camera moved.
//   MESHVIEW_FILES=a.stl:b.3mf...  draws those files instead, reporting how long each took
//   MESHVIEW_SHOTS=dir             keeps the pictures
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { renderData } = require('../out/src/meshdata.js');
const meshes = require('@isopodlabs/binary_meshes');
const { openPage, asset, pause } = require('./pagehost.js');

const W = 400, H = 300;
let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const encode = s => new TextEncoder().encode(s);

// a 2x2 texture: red, green / blue, white, as a PNG (row 0 the top)
function png2x2() {
	const crc = buf => {
		let crc = 0xffffffff;
		for (const b of buf) {
			let c = (crc ^ b) & 0xff;
			for (let k = 0; k < 8; k++)
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crc = (crc >>> 8) ^ c;
		}
		return (crc ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
		len.writeUInt32BE(data.length);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
	const rows = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
	return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
	let ready;
	const readyPromise = new Promise(r => ready = r);
	// the extension's side: the shaders assembled as MeshViewer's getShaders does
	const view = await openPage({script: 'mesh.js', width: W, height: H, problems: m => check(false, m), host: (m, reply) => {
		if (m.command === 'getShaders')
			return reply({vert: asset('mesh.vert'), frag: asset('mesh.frag'), floorVert: asset('sdf.vert'), floorFrag: asset('meshfloor.frag').replace('//@floor', asset('floor.frag'))});
		if (m.command === 'getGlyphs')
			return reply(undefined);
		if (m.command === 'ready')
			ready();
		else if (m.command === 'error')
			check(false, `the page reported: ${m.message}`);
	}});
	try {
		await readyPromise;
		// a new model keeps the camera, as a reload of the same file does; fit, as the toolbar's button does, to see it
		const show = async (model, format, name, fit = false) => {
			const message = await renderData(model, format);
			await view.send(message);
			if (fit)
				await view.send({command: 'fitToWindow'});
			await pause(300);
			return {message, ...await view.shot(name), info: await view.info()};
		};

		for (const file of process.env.MESHVIEW_FILES?.split(':') ?? []) {
			const t0 = Date.now(), ext = path.extname(file).toLowerCase(), dir = path.dirname(file);
			const model = await meshes.formatOf(ext).read(new Uint8Array(fs.readFileSync(file)), {file: n => fs.existsSync(path.resolve(dir, n)) ? new Uint8Array(fs.readFileSync(path.resolve(dir, n))) : undefined});
			const t1 = Date.now();
			const {message, info} = await show(model, ext, path.basename(file), true);
			const bytes = message.meshes.reduce((n, m) => n + [m.positions, m.colors, m.faces, m.normals, m.uvs, m.lines].reduce((k, a) => k + (a?.byteLength ?? 0), 0), 0);
			console.log(`${path.basename(file)}: read ${t1 - t0} ms, prepared and drawn ${Date.now() - t1} ms, ${(bytes / 1e6).toFixed(1)} MB sent; ${info}`);
		}
		if (process.env.MESHVIEW_FILES)
			return;

		//--- a red cube, its faces coloured by the file ---------------------------------------------------------
		{
			const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(p => p.map(v => v * 10));
			const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
			const off = `OFF\n8 6 0\n${P.map(p => p.join(' ')).join('\n')}\n${F.map(f => `4 ${f.join(' ')} 255 0 0`).join('\n')}\n`;
			const {at, width, height, info, count} = await show(meshes.OFF.read(encode(off)), '.off', 'cube');
			const [r, g, b] = at(width >> 1, height >> 1);
			check(r > 120 && g < 60 && b < 60, `the cube's middle should be lit red, not ${[r, g, b]}`);
			const corner = at(3, 3);
			check(corner[0] < 90 && Math.abs(corner[0] - corner[2]) < 40, `the top corner should be background, not ${corner}`);
			check(/OFF · 1 mesh · 12 triangles/.test(info), `info: ${info}`);
			const tip = await view.tooltipAt(W / 2, H / 2);
			check(/face \d/.test(tip) && /rgb\(255, 0, 0\)/.test(tip), `the tooltip should say the face and its colour: ${JSON.stringify(tip)}`);
			// the floor, below and around the cube, is drawn: somewhere along the bottom is floor-grey, not background
			const lower = [...Array(20)].map((_, i) => at(Math.round(width * (i + 0.5) / 20), height - 20));
			check(lower.some(([r, g, b]) => r > 40 && Math.abs(r - g) < 25 && Math.abs(g - b) < 30), `the floor should show near the bottom: ${JSON.stringify(lower.slice(0, 5))}`);

			// the camera: zooming in on the cube makes more of the picture red, and turning moves where it is
			const red = ([r, g, b]) => r > 100 && g < 60 && b < 60;
			const before = count(red);
			await view.zoom(W / 2, H / 2, 60);		// the wheel toward you (positive) closes in
			const zoomed = await view.shot('cube-zoomed');
			check(zoomed.count(red) > before * 1.5, `zooming in should enlarge the cube: ${before} red pixels, then ${zoomed.count(red)}`);
			await view.turn(W / 2, H / 2, 120, 0);
			const turned = await view.shot('cube-turned');
			const samples = [...Array(15)].flatMap((_, i) => [...Array(12)].map((_, j) => [Math.round(W * (i + 0.5) / 15), Math.round(H * (j + 0.5) / 12)]));
			const moved = samples.filter(([x, y]) => red(zoomed.at(x, y)) !== red(turned.at(x, y))).length;
			check(moved > 5, `turning should change the picture: ${moved} of ${samples.length} samples changed`);
			console.log(`red cube: middle ${[r, g, b]}, tooltip ${JSON.stringify(tip.split('\n')[2])}; zoom ${before} -> ${zoomed.count(red)} red pixels, turn changed ${moved} samples`);
		}

		//--- a textured quad: an OBJ, its .mtl and its PNG read through the file callback ------------------------
		{
			const files = {'q.mtl': encode('newmtl t\nKd 1 1 1\nmap_Kd t.png\n'), 't.png': png2x2()};
			const obj = 'mtllib q.mtl\nv -10 -10 0\nv 10 -10 0\nv 10 10 0\nv -10 10 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl t\nf 1/1 2/2 3/3 4/4\n';
			const {message} = await show(meshes.OBJ.read(encode(obj), {file: n => files[n]}), '.obj', 'quad', true);
			check(message.textures.length === 1 && message.textures[0]?.width === 2, `the texture should be decoded: ${JSON.stringify(message.warnings)}`);
			check(message.meshes[0].runs[0].texture === 0, 'the quad should be one textured run');
			await view.page.keyboard.press('u');		// OBJ is y up by default; this quad lies in z = 0, so stand it z up
			await view.page.keyboard.press('g');		// and without the floor, which it lies in
			await pause(300);
			// which way up (three corners fix it: a flip or a mirror changes one): v runs up the image, so the image's top
			// row (red, green) is at y > 0 and its bottom (blue, white) at y < 0. Points of the quad are found by the
			// picker, which says where each is and its colour there.
			const seen = {};
			for (let i = 1; i < 16; i++)
				for (let j = 1; j < 12; j++) {
					const tip = await view.tooltipAt(W * i / 16, H * j / 12, 40);
					const m = /^\((-?[\d.]+), (-?[\d.]+), [^)]*\)[\s\S]*rgb\((\d+), (\d+), (\d+)\)/.exec(tip);
					if (!m)
						continue;
					const [x, y, ...c] = m.slice(1).map(Number);
					// near a corner a texel's own colour dominates what linear filtering blends in from its neighbours
					if (Math.abs(x) > 6 && Math.abs(y) > 6)
						seen[`${y > 0 ? 'top' : 'bottom'} ${x > 0 ? 'right' : 'left'}`] = Math.min(...c) > 170 ? 'white' : ['red', 'green', 'blue'][c.indexOf(Math.max(...c))];
				}
			const expect = {'top left': 'red', 'top right': 'green', 'bottom left': 'blue', 'bottom right': 'white'};
			check(Object.keys(seen).length >= 3 && Object.entries(seen).every(([k, c]) => expect[k] === c), `the texture should be the right way up: ${JSON.stringify(seen)}`);
			await view.page.keyboard.press('g');
			console.log(`textured quad: ${JSON.stringify(seen)}`);
		}

		//--- a block inserted twice, from a DXF: one mesh, two instances ------------------------------------------
		{
			const pt = (n, [x, y, z]) => [10 + n, x, 20 + n, y, 30 + n, z];
			const face = corners => [0, '3DFACE', 8, '0', 62, 3, ...corners.flatMap((c, i) => pt(i, c))];
			const box = [[[0, 0, 0], [5, 0, 0], [5, 5, 0], [0, 5, 0]], [[0, 0, 0], [5, 0, 0], [5, 0, 5], [0, 0, 5]], [[0, 0, 0], [0, 5, 0], [0, 5, 5], [0, 0, 5]]];
			const dxf = [
				0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 8, '0', 2, 'b', 70, 0, ...pt(0, [0, 0, 0]), ...box.flatMap(face), 0, 'ENDBLK', 0, 'ENDSEC',
				0, 'SECTION', 2, 'ENTITIES',
				0, 'INSERT', 8, '0', 2, 'b', ...pt(0, [-10, 0, 0]), 0, 'INSERT', 8, '0', 2, 'b', ...pt(0, [10, 0, 0]),
				0, 'ENDSEC', 0, 'EOF',
			].join('\n');
			const {message, at, width, height, info} = await show(meshes.DXF.read(encode(dxf)), '.dxf', 'inserts', true);
			check(message.meshes.filter(m => m.faces.length).length === 1 && message.instances.filter(i => message.meshes[i.mesh].faces.length).length === 2, `one block mesh placed twice: ${info}`);
			// both copies drawn green: the left and right halves each have green in them
			const greenIn = (x0, x1) => [...Array(40)].some((_, i) => [...Array(30)].some((_, j) => {
				const [r, g, b] = at(Math.round(x0 + (x1 - x0) * i / 40), Math.round(height * j / 30));
				return g > 1.6 * r && g > 1.6 * b;
			}));
			check(greenIn(0, width / 2) && greenIn(width / 2, width), 'both inserts should be drawn');
			console.log(`DXF: ${info}`);
		}
	} finally {
		await view.close();
	}
	console.log(bad ? `${bad} FAILED` : 'ok: the mesh viewer draws colours, textures and instances, over the floor, says what is under the cursor, and moves');
	process.exit(bad ? 1 : 0);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
