// The numbers along the floor's axes, checked in the real raymarcher: the atlas the extension bakes from the font's
// own curves, the shader that reads it (assets/sdf.frag's axisLabels), and the whole thing drawn in headless Chrome
// exactly as webview/sdf.ts assembles and draws it. Three things matter about the labels, and each is measured:
//   * they exist, and only beside the axes: two renders differing only in the label step must agree everywhere
//     else on screen, and differ in the band next to each axis;
//   * they are part of the floor rather than laid over the picture: nothing changes where the model stands in front;
//   * they are cheap: a frame costs about what it did without them.
// Pass an output directory as the first argument to keep the two pictures (labels.png, plain.png).
const fs = require('fs');
const path = require('path');
const { evaluate } = require('./scadhost.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();
// (the atlas is the extension's, which needs vscode only to be loaded: anything stands in for it)
const Module = require('module');
const loadModule = Module._load;
const anything = new Proxy(function () {}, {get: (_, k) => k === '__esModule' ? true : anything, apply: () => anything, construct: () => anything});
Module._load = function (request, ...rest) { return request === 'vscode' ? anything : loadModule.call(this, request, ...rest); };
const { digitAtlas } = require('../out/src/extension.js');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const asset = name => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

// runs in the page: draws the model twice (with and without labels) and times both
function RENDER(input) {
	const {vert, frag, atlas, width, height, uniforms, frames} = input;
	const canvas = document.createElement('canvas');
	canvas.width = width; canvas.height = height;
	const gl = canvas.getContext('webgl2', {preserveDrawingBuffer: true});
	const shader = (type, src) => {
		const s = gl.createShader(type);
		gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
			throw new Error(gl.getShaderInfoLog(s));
		return s;
	};
	const program = gl.createProgram();
	gl.attachShader(program, shader(gl.VERTEX_SHADER, vert));
	gl.attachShader(program, shader(gl.FRAGMENT_SHADER, frag));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		throw new Error(gl.getProgramInfoLog(program));
	gl.useProgram(program);

	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(program, 'a_position');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	const texture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, Uint8Array.from(atlas.data));
	for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
		gl.texParameteri(gl.TEXTURE_2D, p, v);

	const set = (u) => {
		for (const name in u) {
			const l = gl.getUniformLocation(program, name), v = u[name];
			if (!l) continue;
			if (name === 'u_basis') gl.uniformMatrix3fv(l, false, v);
			else if (Array.isArray(v)) (v.length === 3 ? gl.uniform3fv : gl.uniform4fv).call(gl, l, v);
			else if (name === 'u_glyphs') gl.uniform1i(l, v);
			else gl.uniform1f(l, v);
		}
	};
	const draw = (on) => {
		gl.viewport(0, 0, width, height);
		set({...uniforms, ...(on ? {} : {u_glyphInfo: [0, 0, 0, 0]})});
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	};
	const pixels = () => { const out = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
	const one = new Uint8Array(4);
	const time = (on) => {
		draw(on); pixels();							// warm up: compile, first-use costs
		let best = Infinity;
		for (let round = 0; round < 5; round++) {
			const t0 = performance.now();
			// reading a pixel back is what makes each frame finish before the next starts; without it the draws queue
			// and the clock measures how fast they are submitted
			for (let i = 0; i < frames; i++) { draw(on); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); }
			best = Math.min(best, (performance.now() - t0) / frames);
		}
		return best;
	};

	draw(true);
	const labelled = pixels();
	const png = canvas.toDataURL('image/png');
	draw(false);
	const plain = pixels();
	const pngPlain = canvas.toDataURL('image/png');
	const msLabels = time(true), msPlain = time(false);
	return {labelled: Array.from(labelled), plain: Array.from(plain), png, pngPlain, msLabels, msPlain};
}

(async () => {
	const atlas = digitAtlas();
	check(!!atlas, 'the digit atlas should bake on a machine with a usable sans font');
	if (!atlas) { process.exit(1); }
	const bytes = atlas.data;
	check(bytes.length === atlas.width * atlas.height, `atlas is ${bytes.length} bytes, expected ${atlas.width * atlas.height}`);
	// the '1' has ink down its middle and none at its cell's corner; the minus sign has ink at mid-height and none at the top
	const texel = (cell, u, v) => bytes[Math.min(atlas.height - 1, Math.floor(v * atlas.height)) * atlas.width + cell * atlas.cellW + Math.min(atlas.cellW - 1, Math.floor(u * atlas.cellW))];
	const uAt = x => (x - atlas.cellX0) / atlas.cellWEm, vAt = y => (y - atlas.cellY0) / atlas.cellHEm;
	check(texel(1, uAt(atlas.pitch / 2), vAt(atlas.capHeight / 2)) > 128, "the middle of a '1' should be inside it");
	check(texel(1, 0.02, 0.02) < 64, "a corner of a '1' cell should be well outside it");
	check(texel(10, uAt(atlas.pitch / 2), vAt(atlas.capHeight * 0.35)) > 128 && texel(10, uAt(atlas.pitch / 2), vAt(atlas.capHeight * 0.85)) < 64, 'the minus sign should be a bar at mid-height');
	console.log(`atlas: ${atlas.width}x${atlas.height}, ${atlas.chars.length} cells of ${atlas.cellW}x${atlas.height}, digit height ${atlas.capHeight.toFixed(3)} em, ${(atlas.data.length / 1024).toFixed(1)} KB as sent`);
	// page.evaluate's own argument passing is JSON, not postMessage's structured clone, so the atlas -- a
	// Uint8Array in the real webview -- goes over as a plain array here instead, the same as sdBatch's data does
	// in test/webgl.js, and RENDER above turns it back into one
	const atlasSent = {...atlas, data: Array.from(atlas.data)};

	// a cube standing on the origin, so the axes run out from under it and it stands in front of some of the floor
	const {sdf} = evaluate('cube([30, 20, 10], center = true); translate([45, -25, -5]) cylinder(h = 14, r = 5);', 'floorlabels.js');
	const box = bounds3(sdf);
	const g = emitGlsl(sdf);
	const code = [...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n');
	const frag = asset('sdf.frag').replace('//@floor', asset('floor.frag')).replace('//@lib', asset('sdflib.frag')).replace('//@sdf', code);

	const width = 800, height = 600, fovy = 1 / Math.tan(Math.PI / 6), tilt = 52 * Math.PI / 180;
	const s = Math.sin(tilt), c = Math.cos(tilt);
	const center = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
	const half = [(box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2, (box.max.z - box.min.z) / 2];
	const back = [0, -s, c];
	const uniformsAt = (distance, scale = 1) => ({
		u_floorOn: 1, u_pixel: 2 / (fovy * height * scale), u_labelPixel: 2 / (fovy * height), u_debug: 0,
		u_center: center, u_half: half,
		u_origin: center.map((v, i) => v + back[i] * distance),
		u_basis: [1, 0, 0,  0, c, s,  ...back],
		u_fovy: fovy, u_aspect: width / height,
		u_glyphs: 0,
		u_glyphCell: [atlas.cellX0, atlas.cellY0, atlas.cellWEm, atlas.cellHEm],
		u_glyphInfo: [atlas.pitch, atlas.spread, atlas.chars.length, atlas.capHeight],
	});

	const puppeteer = require('puppeteer-core');
	const browser = await puppeteer.launch({executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']});
	try {
		const page = await browser.newPage();
		page.on('pageerror', e => console.error('in page:', e));
		const counts = {};
		// close in, the middle distance, and well out: as the camera pulls back the finer grid levels fade out and
		// their numbers with them, leaving only the coarser, exactly as the lines do
		for (const distance of [15, 120, 220]) {
			const r = await page.evaluate(RENDER, {vert: asset('sdf.vert'), frag, atlas: atlasSent, width, height, uniforms: uniformsAt(distance), frames: distance === 120 ? 40 : 4});
			let differing = 0;
			for (let i = 0; i < width * height; i++) {
				const d = Math.abs(r.labelled[i * 4] - r.plain[i * 4]) + Math.abs(r.labelled[i * 4 + 1] - r.plain[i * 4 + 1]) + Math.abs(r.labelled[i * 4 + 2] - r.plain[i * 4 + 2]);
				if (d > 6) differing++;
			}
			counts[distance] = differing;
			check(differing > 0, `no labels at all at distance ${distance}`);
			check(differing < width * height * 0.08, `${differing} pixels differ at distance ${distance} -- labels should be a thin annotation, not much of the picture`);

			if (distance === 120) {
				// three corners of the picture that hold floor but neither axis (the x axis runs across the middle and the
				// y axis up the left of centre for this camera), where nothing may change
				let outside = 0;
				for (const [x0, x1, y0, y1] of [[0, 200, 0, 250], [600, 800, 0, 250], [550, 800, 450, 600]])
					for (let y = y0; y < y1; y++)
						for (let x = x0; x < x1; x++) {
							const i = ((height - 1 - y) * width + x) * 4;		// readPixels is bottom-up
							if (Math.abs(r.labelled[i] - r.plain[i]) + Math.abs(r.labelled[i + 1] - r.plain[i + 1]) > 6) outside++;
						}
				check(outside === 0, `${outside} pixels away from both axes differ`);

				const ratio = r.msLabels / r.msPlain;
				console.log(`frame cost at ${width}x${height}: ${r.msPlain.toFixed(2)} ms plain, ${r.msLabels.toFixed(2)} ms with labels (x${ratio.toFixed(2)})`);
				check(ratio < 1.35, `labels cost ${(ratio * 100 - 100).toFixed(0)}% more per frame; they should be a thin band of extra work`);

				const out = process.argv[2];
				if (out) {
					fs.mkdirSync(out, {recursive: true});
					fs.writeFileSync(path.join(out, 'labels.png'), Buffer.from(r.png.split(',')[1], 'base64'));
					fs.writeFileSync(path.join(out, 'plain.png'), Buffer.from(r.pngPlain.split(',')[1], 'base64'));
					console.log(`pictures written to ${out}`);
				}
			} else if (process.argv[2]) {
				fs.writeFileSync(path.join(process.argv[2], `labels-${distance}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
			}
		}
		// While the view moves the page is drawn at half size. The numbers must not grow with the pixels: the same scene
		// (close in, where a comfortable size on screen is what limits them rather than the grid squares they sit in)
		// drawn at half the width and height should put about a quarter of the pixels on numbers, not the same number
		// of them (which is what numbers twice the size on screen come to)
		{
			const full = await page.evaluate(RENDER, {vert: asset('sdf.vert'), frag, atlas: atlasSent, width, height, uniforms: uniformsAt(15), frames: 1});
			const halfW = width / 2, halfH = height / 2;
			const half = await page.evaluate(RENDER, {vert: asset('sdf.vert'), frag, atlas: atlasSent, width: halfW, height: halfH, uniforms: uniformsAt(15, 0.5), frames: 1});
			const count = (r, n) => { let c = 0; for (let i = 0; i < n; i++) if (Math.abs(r.labelled[i * 4] - r.plain[i * 4]) + Math.abs(r.labelled[i * 4 + 1] - r.plain[i * 4 + 1]) + Math.abs(r.labelled[i * 4 + 2] - r.plain[i * 4 + 2]) > 6) c++; return c; };
			const fullCount = count(full, width * height), halfCount = count(half, halfW * halfH);
			const ratio = halfCount * 4 / fullCount;
			console.log(`half-size drawing: ${halfCount} pixels carry numbers against ${fullCount} at full size (scaled to the same area: x${ratio.toFixed(2)})`);
			check(ratio > 0.7 && ratio < 1.5, `the numbers are ${ratio.toFixed(2)}x the area at half size; they should cover the same part of the picture (about 4x would be twice the size)`);
		}
		console.log(`pixels carrying numbers: ${Object.entries(counts).map(([d, n]) => `${n} at distance ${d}`).join(', ')}`);
	} finally {
		await browser.close();
	}
	console.log(bad ? `\n${bad} FAILED` : '\nthe axis numbers are drawn by the floor shader, only beside the axes, and cost about nothing');
	process.exit(bad ? 1 : 0);
})();
