// Runs the GLSL sdf.ts emits for real, in headless Chrome, instead of glsl.js's hand-written interpreter of it.
// glsl.js is not a GLSL implementation -- its own comment says so -- so a divergence it reports could be a bug in
// the generator, or just as easily a gap in its own ~500-line reimplementation of GLSL's rules. Compiling and
// running the actual text in the actual engine the webview uses (Chromium/ANGLE) removes that second unknown.
//
// One page stays open for the whole test process: relaunching Chrome is expensive, recompiling a shader is not.
// Every point handed to one call goes through a single draw + readback, not one round trip each -- puppeteer's
// page.evaluate() has enough overhead (~1-5ms) that one-call-per-point would dominate the wall clock at the point
// counts these tests use (thousands per case).
//
// The technique: points go in as a data texture, an attributeless full-screen triangle (gl_VertexID, no buffers)
// runs the fragment shader once per texel, and texelFetch(gl_FragCoord) recovers which point that texel is for.
// map()'s vec2 result is written straight to an RGBA32F framebuffer and read back with one readPixels().
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZE = 256;					// 256*256 = 65536 points per batch -- comfortably above any one test's case

// The functions the generated code calls but does not itself define -- sdTri2, sdNgon -- live here, spliced in by
// the real pipeline before the generated code (webview/sdf.ts's `source.frag.replace('//@lib', source.lib)`, into
// assets/sdf.frag's //@lib marker). Without this, a shape that reaches those functions compiles here but not in
// the real shader -- or, before this line existed, "compiles" here and nowhere else, which looked like a shader bug
// and was actually a gap in this harness's own assembly.
const SDFLIB = fs.readFileSync(path.join(__dirname, '..', 'assets', 'sdflib.frag'), 'utf8');

let pagePromise;
function getPage() {
	if (!pagePromise) {
		pagePromise = (async () => {
			const puppeteer = require('puppeteer-core');
			const browser = await puppeteer.launch({
				executablePath: CHROME,
				headless: true,
				args: ['--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
			});
			const page = await browser.newPage();
			page.on('pageerror', e => console.error('webgl.js: uncaught in page:', e));
			await page.evaluate(INIT_PAGE, SIZE);
			return {browser, page};
		})();
	}
	return pagePromise;
}

// Runs inside the page: one WebGL2 context, one input texture and one output framebuffer, all reused by every
// shader this process compiles. `window.__run` is what Node calls per batch.
function INIT_PAGE(size) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const gl = canvas.getContext('webgl2');
	if (!gl)
		throw new Error('no WebGL2 context');
	if (!gl.getExtension('EXT_color_buffer_float'))
		throw new Error('no EXT_color_buffer_float (float framebuffers unreadable)');

	const VS = `#version 300 es
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
	function compile(type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(sh);
			const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
			throw new Error(`${log}\n${numbered}`);
		}
		return sh;
	}
	const vs = compile(gl.VERTEX_SHADER, VS);

	const pointsTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, pointsTex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB32F, size, size);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	const outTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, outTex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, size, size);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
	const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
	if (status !== gl.FRAMEBUFFER_COMPLETE)
		throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);

	// compiles `userSrc` (the generator's helpers + its map()) into a program that samples the points texture and
	// writes vec2 map(p) to the output; returns the flat [d0, mat0, d1, mat1, ...] readback
	window.__run = (userSrc, entry, flat, count, batch) => {
		const fsSrc = `#version 300 es
precision highp float;
uniform sampler2D uPoints;
out vec4 fragColor;
${userSrc}
void main() {
	vec3 p = texelFetch(uPoints, ivec2(gl_FragCoord.xy), 0).xyz;
	vec2 r = ${entry}(p);
	fragColor = vec4(r, 0.0, 0.0);
}`;
		const prog = gl.createProgram();
		gl.attachShader(prog, vs);
		const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(prog);
			gl.deleteShader(fs); gl.deleteProgram(prog);
			throw new Error(`${log}\n${fsSrc}`);
		}

		const buf = new Float32Array(size * size * 3);
		buf.set(flat);
		gl.bindTexture(gl.TEXTURE_2D, pointsTex);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGB, gl.FLOAT, buf);

		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, size, size);
		gl.useProgram(prog);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, pointsTex);
		gl.uniform1i(gl.getUniformLocation(prog, 'uPoints'), 0);
		// the batch texture sdBatch() reads (see sdf.ts's emitBatch): RGBA32F, 1024 texels to a row
		let batchTex = null;
		if (batch && batch.length) {
			const texels = batch.length / 4, rows = Math.ceil(texels / 1024);
			const padded = new Float32Array(rows * 1024 * 4);
			padded.set(batch);
			batchTex = gl.createTexture();
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, batchTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, rows, 0, gl.RGBA, gl.FLOAT, padded);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.uniform1i(gl.getUniformLocation(prog, 'u_batch'), 1);
			gl.activeTexture(gl.TEXTURE0);
		}
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		if (batchTex)
			gl.deleteTexture(batchTex);

		const out = new Float32Array(size * size * 4);
		gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, out);
		gl.deleteShader(fs);
		gl.deleteProgram(prog);

		// only the requested prefix, and only the two channels map() actually writes
		const trimmed = new Float32Array(count * 2);
		for (let i = 0; i < count; i++) {
			trimmed[i * 2] = out[i * 4];
			trimmed[i * 2 + 1] = out[i * 4 + 1];
		}
		return Array.from(trimmed);
	};
}

// Compiles `src` (the generator's helpers followed by its `entry` function, `map` by default) once, returning
// (`batch`, if the generated code needs it, is emitGlsl's data: the texture sdBatch() walks)
// {at(points), one(point)}. `at` batches -- points beyond one texture's worth (65536) are chunked transparently.
// `src` may not itself declare `map` under a different name; `entry` names whichever function to call, matching
// glsl.js's makeMap signature so a call site can switch between them by changing the require.
async function makeShader(src, entry = 'map', batch) {
	const {page} = await getPage();
	return {
		async at(points) {
			const results = [];
			const fullSrc = SDFLIB + '\n' + src;
			for (let i = 0; i < points.length; i += SIZE * SIZE) {
				const chunk = points.slice(i, i + SIZE * SIZE);
				const flat = new Float32Array(chunk.length * 3);
				chunk.forEach((p, j) => { flat[j * 3] = p[0]; flat[j * 3 + 1] = p[1]; flat[j * 3 + 2] = p[2]; });
				const out = await page.evaluate((userSrc, ent, flatArr, count, data) => window.__run(userSrc, ent, flatArr, count, data),
					fullSrc, entry, Array.from(flat), chunk.length, batch ? Array.from(batch) : []);
				for (let j = 0; j < chunk.length; j++)
					results.push([out[j * 2], out[j * 2 + 1]]);
			}
			return results;
		},
		async one(point) {
			return (await this.at([point]))[0];
		},
	};
}

async function close() {
	if (!pagePromise)
		return;
	const {browser} = await pagePromise;
	pagePromise = undefined;
	await browser.close();
}

module.exports = {makeShader, close};
