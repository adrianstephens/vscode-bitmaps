// Draws a model with the viewer's real raymarcher (assets/sdf.frag, spliced with sdflib.frag and the generated map())
// in headless Chrome, and reports what it cost: the time to compile and link the shader and draw the first frame, and
// then the time per frame. Only the model and the floor are drawn -- no labels -- from straight above, framed the way
// webview/sdf.ts's homeView() frames a model. Shared by the tests that need a picture or a cost rather than a value.
const fs = require('fs');
const path = require('path');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const asset = name => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8');

let browserPromise;
function getBrowser() {
	browserPromise ??= require('puppeteer-core').launch({executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']});
	return browserPromise;
}
async function close() {
	if (browserPromise)
		await (await browserPromise).close();
	browserPromise = undefined;
}

// runs in the page
function IN_PAGE({vert, frag, width, height, uniforms, frames, batch}) {
	const canvas = document.createElement('canvas');
	canvas.width = width; canvas.height = height;
	const gl = canvas.getContext('webgl2', {preserveDrawingBuffer: true});
	const one = new Uint8Array(4);
	const t0 = performance.now();
	const compile = (type, src) => {
		const s = gl.createShader(type);
		gl.shaderSource(s, src); gl.compileShader(s);
		return s;
	};
	const program = gl.createProgram();
	const vs = compile(gl.VERTEX_SHADER, vert), fs = compile(gl.FRAGMENT_SHADER, frag);
	gl.attachShader(program, vs); gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		return {error: gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program)};
	gl.useProgram(program);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(program, 'a_position');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
	gl.viewport(0, 0, width, height);
	if (batch.length) {
		// the leaves of a big union, which sdBatch() walks (see sdf.ts's emitBatch): RGBA32F, 1024 texels to a row
		const rows = Math.ceil(batch.length / 4 / 1024), padded = new Float32Array(rows * 1024 * 4);
		padded.set(batch);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, rows, 0, gl.RGBA, gl.FLOAT, padded);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.uniform1i(gl.getUniformLocation(program, 'u_batch'), 1);
		gl.activeTexture(gl.TEXTURE0);
	}
	for (const name in uniforms) {
		const l = gl.getUniformLocation(program, name), v = uniforms[name];
		if (!l) continue;
		if (name === 'u_basis') gl.uniformMatrix3fv(l, false, v);
		else if (Array.isArray(v)) (v.length === 3 ? gl.uniform3fv : gl.uniform4fv).call(gl, l, v);
		else gl.uniform1f(l, v);
	}
	const draw = () => { gl.drawArrays(gl.TRIANGLES, 0, 6); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); };
	draw();
	const compileMs = performance.now() - t0;
	let frameMs = Infinity;
	for (let round = 0; round < 3; round++) {
		const t = performance.now();
		for (let i = 0; i < frames; i++) draw();
		frameMs = Math.min(frameMs, (performance.now() - t) / frames);
	}
	return {compileMs, frameMs, png: canvas.toDataURL('image/png')};
}

// -> {compileMs, frameMs, png (a data URL)}, or {error} if the shader did not compile
async function render(sdf, {width = 800, height = 600, frames = 3, basis = [1, 0, 0, 0, 1, 0, 0, 0, 1], zoom = 1, at} = {}) {
	const box = bounds3(sdf);
	const g = emitGlsl(sdf);
	const code = [...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n');
	const frag = asset('sdf.frag').replace('//@floor', asset('floor.frag')).replace('//@lib', asset('sdflib.frag')).replace('//@sdf', code);
	const middle = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
	const half = [(box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2, (box.max.z - box.min.z) / 2];
	const fovy = 1 / Math.tan(Math.PI / 6);
	const distance = Math.hypot(...half) / Math.sin(Math.atan(1 / fovy)) * 1.1 / zoom;
	// the camera looks at `at` (the model's middle unless told otherwise), from `distance` back along the basis' third axis
	const target = at ?? middle;
	const origin = [target[0] + basis[6] * distance, target[1] + basis[7] * distance, target[2] + basis[8] * distance];
	const page = await (await getBrowser()).newPage();
	try {
		return await page.evaluate(IN_PAGE, {
			vert: asset('sdf.vert'), frag, width, height, frames, batch: Array.from(g.data),
			uniforms: {
				u_floorOn: 1, u_pixel: 2 / (fovy * height), u_labelPixel: 2 / (fovy * height), u_debug: 0,
				u_center: middle, u_half: half, u_origin: origin,
				u_basis: basis, u_fovy: fovy, u_aspect: width / height,
				u_glyphInfo: [0, 0, 0, 0],
			},
		});
	} finally {
		await page.close();
	}
}

module.exports = { render, close };
