// anything with pixels: an ImageData, or a bare {data, width, height}
export interface PixelData {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

import { float2, float3, normalise } from '@isopodlabs/maths/vector';

//-----------------------------------------------------------------------------
// shaders
//-----------------------------------------------------------------------------

type Uniforms<T extends string = string> = Record<T, (value: any) => void>;

function uniformSetter(gl: WebGL2RenderingContext, type: number, loc: WebGLUniformLocation): (value: any) => void {
	switch (type) {
		case gl.FLOAT:       	return value => gl.uniform1f(loc, value);
		case gl.FLOAT_VEC2:  	return value => gl.uniform2f(loc, value[0], value[1]);
		case gl.FLOAT_VEC3:  	return value => gl.uniform3f(loc, value[0], value[1], value[2]);
		case gl.FLOAT_VEC4:  	return value => gl.uniform4f(loc, value[0], value[1], value[2], value[3]);

		case gl.FLOAT_MAT2:  	return value => gl.uniformMatrix2fv(loc, false, value);
		case gl.FLOAT_MAT3:  	return value => gl.uniformMatrix3fv(loc, false, value);
		case gl.FLOAT_MAT4:  	return value => gl.uniformMatrix4fv(loc, false, value);

    	case gl.FLOAT_MAT2x3:	return value => gl.uniformMatrix2x3fv(loc, false, value);
    	case gl.FLOAT_MAT2x4:	return value => gl.uniformMatrix2x4fv(loc, false, value);
    	case gl.FLOAT_MAT3x2:	return value => gl.uniformMatrix3x2fv(loc, false, value);
    	case gl.FLOAT_MAT3x4:	return value => gl.uniformMatrix3x4fv(loc, false, value);
    	case gl.FLOAT_MAT4x2:	return value => gl.uniformMatrix4x2fv(loc, false, value);
    	case gl.FLOAT_MAT4x3:	return value => gl.uniformMatrix4x3fv(loc, false, value);

		case gl.BOOL_VEC2:
		case gl.INT_VEC2:  	return value => gl.uniform2i(loc, value[0], value[1]);
		case gl.BOOL_VEC3:
		case gl.INT_VEC3:  	return value => gl.uniform3i(loc, value[0], value[1], value[2]);
		case gl.BOOL_VEC4:
		case gl.INT_VEC4:  	return value => gl.uniform4i(loc, value[0], value[1], value[2], value[3]);

		default:
		case gl.BOOL:
		case gl.INT:
		case gl.SAMPLER_2D:
		case gl.SAMPLER_3D:
		case gl.SAMPLER_CUBE:	return value => gl.uniform1i(loc, value);
	}
}

function getAllUniforms(gl: WebGL2RenderingContext, program: WebGLProgram) {
	const uniforms	= {} as Uniforms<string>;
	const count		= gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < count; i++) {
		const info = gl.getActiveUniform(program, i);
		if (info) {
			const name		= info.name.replace(/\[0\]$/, ''); // normalize array names
			const location	= gl.getUniformLocation(program, name);
			uniforms[name]	= uniformSetter(gl, info.type, location!);
		}
	}
	return uniforms;
}

export class ShaderProgram {
	program:	WebGLProgram;
	uniforms:	Uniforms;
	vao:		WebGLVertexArrayObject|null = null;
	vertexCount = 0;

	constructor(public gl: WebGL2RenderingContext, vertSource: string, fragSource: string) {
		this.program = createProgram(gl, vertSource, fragSource);
		this.uniforms = getAllUniforms(gl, this.program);
	}
	setVao(attrib: string, componentCount: number, data: Float32Array) {
		this.vao = createVao(this.gl, this.program, attrib, componentCount, data);
		this.vertexCount = data.length / componentCount;
	}
	use(uniforms?: Record<string, any>) {
		this.gl.useProgram(this.program);
		if (uniforms) {
			for (const name in uniforms)
				this.uniforms[name]?.(uniforms[name]);
		}
		if (this.vao)
			this.gl.bindVertexArray(this.vao);
	}
	// draw the triangles of the vertex data given to setVao
	draw(uniforms?: Record<string, any>) {
		this.use(uniforms);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertexCount);
	}
};

// vertex data for a shader program: `size` components per vertex
export interface Geometry {
	size: number;
	data: Float32Array;
}

// two triangles covering the canvas
export const rectGeometry: Geometry = {size: 2, data: new Float32Array([
	-1, -1,		1, -1,		-1, 1,
	-1, 1,		1, -1,		1, 1
])};

// the cube from -1 to 1
export const cubeGeometry: Geometry = {size: 3, data: new Float32Array([
	+1, -1, +1,		+1, -1, -1,		+1, +1, +1,		+1, +1, +1,		+1, -1, -1,		+1, +1, -1,	// +X
	-1, +1, -1,		-1, -1, -1,		-1, +1, +1,		-1, +1, +1,		-1, -1, -1,		-1, -1, +1,	// -X
	+1, +1, -1,		-1, +1, -1,		+1, +1, +1,		+1, +1, +1,		-1, +1, -1,		-1, +1, +1,	// +Y
	-1, -1, +1,		-1, -1, -1,		+1, -1, +1,		+1, -1, +1,		-1, -1, -1,		+1, -1, -1,	// -Y
	-1, +1, +1,		-1, -1, +1,		+1, +1, +1,		+1, +1, +1,		-1, -1, +1,		+1, -1, +1,	// +Z
	+1, -1, -1,		-1, -1, -1,		+1, +1, -1,		+1, +1, -1,		-1, -1, -1,		-1, +1, -1,	// -Z
])};


function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
	const shader = gl.createShader(type);
	if (!shader)
		throw new Error('Failed to create shader');
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
		throw new Error(gl.getShaderInfoLog(shader) || 'Unknown shader error');
	return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertSource: string, fragSource: string) {
	const vertex = createShader(gl, gl.VERTEX_SHADER, vertSource);
	const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragSource);
	const program = gl.createProgram();
	if (!program)
		throw new Error('Failed to create program');
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		throw new Error(gl.getProgramInfoLog(program) || 'Unable to link program');
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	return program;
}

function createVao(gl: WebGL2RenderingContext, program: WebGLProgram, attrib: string, componentCount: number, data: Float32Array) {
	const vao = gl.createVertexArray();
	if (!vao)
		throw new Error('Unable to create VAO');

	const buffer = gl.createBuffer();
	if (!buffer)
		throw new Error('Unable to create buffer');

	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

	const location = gl.getAttribLocation(program, attrib);
	if (location < 0)
		throw new Error(`Shader attribute ${attrib} not found`);
	gl.enableVertexAttribArray(location);
	gl.vertexAttribPointer(location, componentCount, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return vao;
}

// one attribute's data: `size` components per vertex; bytes are normalised to 0..1
export interface Attribute {
	size:	number;
	data:	Float32Array | Uint8Array;
}

// A vertex array of several attributes, by name. One the program does not use is left out; one it uses that is not
// given reads the constant the caller sets with vertexAttrib*, 0 by default.
export function createVertexArray(gl: WebGL2RenderingContext, program: WebGLProgram, attributes: Record<string, Attribute | undefined>) {
	const vao = gl.createVertexArray();
	if (!vao)
		throw new Error('Unable to create VAO');
	gl.bindVertexArray(vao);
	for (const [name, attribute] of Object.entries(attributes)) {
		const location = gl.getAttribLocation(program, name);
		if (location < 0 || !attribute)
			continue;
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, attribute.data, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(location);
		const bytes = attribute.data instanceof Uint8Array;
		gl.vertexAttribPointer(location, attribute.size, bytes ? gl.UNSIGNED_BYTE : gl.FLOAT, bytes, 0, 0);
	}
	gl.bindVertexArray(null);
	return vao;
}

//-----------------------------------------------------------------------------
// textures
//-----------------------------------------------------------------------------

type Filter			= 'nearest' | 'linear';
type TextureFormat	= 'rgba8' | 'r8' | 'r8ui' | 'r16f' | 'r32f' | 'rgba16f' | 'rgba32f';

export interface TextureOptions {
	format?:	TextureFormat;
	min?:		Filter;	// minification filter (default linear)
	mag?:		Filter;	// magnification filter (default nearest)
}

function textureFormat(gl: WebGL2RenderingContext, format: TextureFormat) {
	return format === 'r16f'
		? {internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT}
		: format === 'r32f'
		? {internal: gl.R32F, format: gl.RED, type: gl.FLOAT}
		: format === 'rgba16f'
		? {internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT}
		: format === 'rgba32f'
		? {internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT}
		: format === 'r8'
		? {internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE}
		: format === 'r8ui'
		? {internal: gl.R8UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE}
		: {internal: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE};
}

// a new texture, bound to target, with the filtering set up
function newTexture(gl: WebGL2RenderingContext, target: number, options: TextureOptions = {}) {
	const filter = (f: Filter) => f === 'nearest' ? gl.NEAREST : gl.LINEAR;
	const texture = gl.createTexture();
	gl.bindTexture(target, texture);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter(options.min ?? 'linear'));
	gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter(options.mag ?? 'nearest'));
	gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	if (target === gl.TEXTURE_CUBE_MAP || target === gl.TEXTURE_3D)
		gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
	return texture;
}

// the image encoded as a file of the given type (PNG or JPEG: what a canvas can write)
export async function getImageData(image: ImageData, type: string) {
	const offscreen = new OffscreenCanvas(image.width, image.height);
	const ctx = offscreen.getContext('2d');
	if (!ctx)
		return;
	ctx.putImageData(image, 0, 0);

	if (type === 'image/jpeg') {
		// no alpha in a JPEG: what is transparent becomes white rather than black
		const flat = new OffscreenCanvas(image.width, image.height);
		const flatCtx = flat.getContext('2d')!;
		flatCtx.fillStyle = '#fff';
		flatCtx.fillRect(0, 0, image.width, image.height);
		flatCtx.drawImage(offscreen, 0, 0);
		return flat.convertToBlob({type, quality: 0.92});
	}
	return offscreen.convertToBlob({type});
}

export function getPixel(image: ImageData, x: number, y: number) {
	if (x < 0 || y < 0 || x >= image.width || y >= image.height)
		return;
	const offset = (y * image.width + x) * 4;
	return {
		r: image.data[offset + 0],
		g: image.data[offset + 1],
		b: image.data[offset + 2],
		a: image.data[offset + 3],
	};
}


function setPixel(image: ImageData, x: number, y: number, colour: {r: number, g: number, b: number}) {
	const index = (y * image.width + x) * 4;
	image.data[index + 0] = Math.max(Math.min(colour.r, 255), 0);
	image.data[index + 1] = Math.max(Math.min(colour.g, 255), 0);
	image.data[index + 2] = Math.max(Math.min(colour.b, 255), 0);
	image.data[index + 3] = 255;
}

export function bitmapToImage(bitmap: ImageBitmap) {
	const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = offscreen.getContext('2d');
	if (!ctx)
		throw new Error('Unable to create offscreen context');
	ctx.drawImage(bitmap, 0, 0);
	return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

//-----------------------------------------------------------------------------
// Canvas3D
//-----------------------------------------------------------------------------

function getScreenRayDirection(rect: DOMRect, x: number, y: number, fovy: number): float3 {
	const ndcX	= ((x - rect.left) / rect.width) * 2 - 1;
	const ndcY	= 1 - ((y - rect.top) / rect.height) * 2;

	const aspect = rect.width / rect.height;
	return normalise(float3(ndcX * aspect / fovy, ndcY / fovy, -1));
}

function pointerToCanvas(rect: DOMRect, x: number, y: number): float2 {
	const pixelRatio  = window.devicePixelRatio || 1;
	return float2((x - rect.left) * pixelRatio, (y - rect.top) * pixelRatio);
}

export interface Canvas3DOptions {
	depth?: boolean;						// depth testing (default true)
	onError?: (message: string) => void;	// called if there's no WebGL 2, before throwing
}

export interface Offscreen {
	texture:		WebGLTexture;
	framebuffer:	WebGLFramebuffer;
	begin(layer?: number): void;						// layer: the slice of a 3D texture the passes draw into
	end(): void;
	readPixels(out: Float32Array | Uint8Array, layer?: number): void;	// the colour attachment, in the format the offscreen was made with
	delete(keepTexture?: boolean): void;				// keepTexture: the texture is the caller's now (it is the display texture)
}

// a framebuffer with a texture attached to it, drawing into which replaces the texture; shared by the 2D and 3D kinds.
// attach re-points the colour attachment at one slice of a 3D texture, which is how a reduction writes each slice of a
// volume: only one slice can be attached at a time, so the passes for a slice draw it while it is.
function makeOffscreen(gl: WebGL2RenderingContext, texture: WebGLTexture, framebuffer: WebGLFramebuffer, width: number, height: number, f: {format: number, type: number}, name: string, attach?: (layer: number) => void): Offscreen {
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
		gl.deleteFramebuffer(framebuffer);
		gl.deleteTexture(texture);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		throw new Error(`Unable to make a ${name} framebuffer`);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	return {
		texture,
		framebuffer,
		begin(layer = 0) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			attach?.(layer);
			gl.viewport(0, 0, width, height);
		},
		end() {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		},
		readPixels(out, layer = 0) {
			// rows come back from y=0 up, so a texture whose row 0 is the first row of the data needs no reversal
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			attach?.(layer);
			gl.readPixels(0, 0, width, height, f.format, f.type, out);
		},
		delete(keepTexture = false) {
			gl.deleteFramebuffer(framebuffer);
			if (!keepTexture)
				gl.deleteTexture(texture);
		},
	};
}

export class Canvas3D {
	gl;
	constructor(public canvas: HTMLCanvasElement, options: Canvas3DOptions = {}) {
		const gl = canvas.getContext('webgl2');
		if (!gl) {
			const message = 'WebGL 2 not supported';
			options.onError?.(message);
			throw new Error(message);
		}
		this.gl = gl;
		if (options.depth ?? true) {
			gl.enable(gl.DEPTH_TEST);
			gl.depthFunc(gl.LEQUAL);
		}
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		//	gl.enable(gl.CULL_FACE);
		this.resize();
	}
	resize() {
		const pixelRatio = window.devicePixelRatio || 1
		const rect = this.canvas.getBoundingClientRect();
		this.canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
		this.canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
	}
	toCanvas(x: number, y: number) {
		return pointerToCanvas(this.canvas.getBoundingClientRect(), x, y);
	}
	rayDirection(x: number, y: number, fov: number) {
		return getScreenRayDirection(this.canvas.getBoundingClientRect(), x, y, fov);
	}
	bindTexture(target: number, texture: WebGLTexture | null, unit = 0) {
		this.gl.activeTexture(this.gl.TEXTURE0 + unit);
		this.gl.bindTexture(target, texture);
	}
	// shaders as fetched from the extension ({vert, frag}), drawing the given geometry
	createProgram(shaders: {vert: string, frag: string}, geometry: Geometry, attrib = 'a_position') {
		const program = new ShaderProgram(this.gl, shaders.vert, shaders.frag);
		program.setVao(attrib, geometry.size, geometry.data);
		return program;
	}
	createShader(type: number, source: string) {
		return createShader(this.gl, type, source);
	}
	createVao(program: WebGLProgram, attrib: string, componentCount: number, data: Float32Array) {
		return createVao(this.gl, program, attrib, componentCount, data);
	}
	createTextureFromImage(image: PixelData, options?: TextureOptions) {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_2D, options);
		const f = textureFormat(gl, options?.format ?? 'rgba8');
		gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, image.width, image.height, 0, f.format, gl.UNSIGNED_BYTE, image.data);
		gl.bindTexture(gl.TEXTURE_2D, null);
		return texture;
	}
	// bring a texture up to date with the pixels of a rectangle of the image it was made from (all of it, without a rect)
	updateTexture(texture: WebGLTexture, image: PixelData, rect?: {x: number, y: number, w: number, h: number}) {
		const gl = this.gl;
		const r = rect ?? {x: 0, y: 0, w: image.width, h: image.height};
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, image.width);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, image.data, (r.y * image.width + r.x) * 4);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
		gl.bindTexture(gl.TEXTURE_2D, null);
	}
	// a texture of raw bytes (no pixels), which null data leaves empty for texSubImage2D to fill; integer formats need
	// nearest filtering, which the caller's options must give
	createTexture(width: number, height: number, data: ArrayBufferView<ArrayBufferLike> | null, options?: TextureOptions) {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_2D, options);
		const f = textureFormat(gl, options?.format ?? 'rgba8');
		gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, width, height, 0, f.format, f.type, data);
		gl.bindTexture(gl.TEXTURE_2D, null);
		return texture;
	}
	createCubeTextureFromImage(image: PixelData, options?: TextureOptions) {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_CUBE_MAP, options);
		const f = textureFormat(gl, options?.format ?? 'rgba8');

		const faces = [
			gl.TEXTURE_CUBE_MAP_POSITIVE_X,
			gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
			gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
			gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
		];

		const height = image.height / 6;
		for (let i = 0; i < faces.length; i++)
			gl.texImage2D(faces[i], 0, f.internal, image.width, height, 0, f.format, gl.UNSIGNED_BYTE, image.data.subarray(i * image.width * 4 * height, (i + 1) * image.width * 4 * height));

		gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
		return texture;
	}
	create2DArrayTexture(image: PixelData, layers: number, options?: TextureOptions) {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_2D_ARRAY, options);
		const f = textureFormat(gl, options?.format ?? 'rgba8');
		gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, f.internal, image.width, image.height / layers, layers, 0, f.format, gl.UNSIGNED_BYTE, image.data);
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
		return texture;
	}
	create3DTexture([width, height, depth]: [number, number, number], data: Uint8Array | Uint8ClampedArray | Float32Array | null, options?: TextureOptions) {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_3D, options);
		const f = textureFormat(gl, options?.format ?? 'rgba8');
		gl.texImage3D(gl.TEXTURE_3D, 0, f.internal, width, height, depth, 0, f.format, f.type, data);
		gl.bindTexture(gl.TEXTURE_3D, null);
		return texture;
	}
	create3DTextureFromImage(image: PixelData, depth: number, options?: TextureOptions) {
		return this.create3DTexture([image.width, image.height / depth, depth], image.data, options);
	}

	deleteTexture(texture: WebGLTexture) { this.gl.deleteTexture(texture); }

	initViewport() {
		this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
	}

	// depth: a depth buffer too, for passes that draw geometry rather than one full-screen shader
	createOffscreen(width: number, height: number, format: TextureFormat = 'rgba8', depth = false): Offscreen {
		const gl = this.gl;
		// The texture holds the colour the shader draws; it needs its filtering set or the framebuffer is incomplete
		const texture = newTexture(gl, gl.TEXTURE_2D, {min: 'nearest', mag: 'nearest', format});
		const f = textureFormat(gl, format);
		gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, width, height, 0, f.format, f.type, null);

		const framebuffer = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		// left bound, a sampler that reads unit 0 while drawing into it would be a feedback loop, and the draw refused
		gl.bindTexture(gl.TEXTURE_2D, null);
		if (depth) {
			const buffer = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, buffer);
		}
		return makeOffscreen(gl, texture, framebuffer, width, height, f, format);
	}

	// An offscreen whose texture is the 3D kind the tensor shaders sample, so a reduction can draw straight into the picture:
	// a reduction of a stack of slices attaches each slice of the volume in turn and draws it (begin's layer).
	createOffscreen3D([width, height, depth]: [number, number, number], format: TextureFormat = 'rgba8', filter: Filter = 'nearest'): Offscreen {
		const gl = this.gl;
		const texture = newTexture(gl, gl.TEXTURE_3D, {min: filter, mag: filter, format});
		const f = textureFormat(gl, format);
		gl.texImage3D(gl.TEXTURE_3D, 0, f.internal, width, height, depth, 0, f.format, f.type, null);

		const framebuffer = gl.createFramebuffer();
		const attach = (layer: number) => gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		attach(0);
		return makeOffscreen(gl, texture, framebuffer, width, height, f, `${format} 3D`, attach);
	}

}
