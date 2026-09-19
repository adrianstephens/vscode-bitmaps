import { Tooltip, vscode, RPC, handleResult, sendResult, RpcMessage } from '@isopodlabs/vscode_utils/webview/shared.js';

interface ImageData0 {
	pixels: ArrayLike<number>;
	width: number;
	height: number;
}

interface float3 {
	x: number;
	y: number;
	z: number;
};

export type shaderType = 'bg'|'2d'|'array2d'|'3d'|'3d2d'|'cube'|'cube2d';
export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'getShaders', type: shaderType, requestId: number}//result: {vert: string, frag: string}};

export type MessageIn =
	| {command: 'load2d', image: ImageData0}
	| {command: 'load2dArray', image: ImageData0, layers: number}
	| {command: 'loadCube', image: ImageData0}
	| {command: 'load3d', image: ImageData0, depth: number}
	| {command: 'loadTexture', data: ArrayBuffer, mimeType: string}
	| {command: 'fitToWindow'}
	| {command: 'resetZoom'};

export type MessageRpc =
	| {command: 'getImage', result: ImageData0}
	| {command: 'getTexture', type: string, result: ArrayBuffer}

const canvas	= document.getElementById('viewport') as HTMLCanvasElement;
const gl		= canvas.getContext('webgl2');

type Uniforms<T extends string = string> = Record<T, (value: any) => void>;

function uniformSetter(type: number, loc: WebGLUniformLocation): (value: any) => void {
	switch (type) {
		case gl!.FLOAT:       	return value => gl!.uniform1f(loc, value);
		case gl!.FLOAT_VEC2:  	return value => gl!.uniform2f(loc, value[0], value[1]);
		case gl!.FLOAT_VEC3:  	return value => gl!.uniform3f(loc, value[0], value[1], value[2]);
		case gl!.FLOAT_VEC4:  	return value => gl!.uniform4f(loc, value[0], value[1], value[2], value[3]);

		case gl!.FLOAT_MAT2:  	return value => gl!.uniformMatrix2fv(loc, false, value);
		case gl!.FLOAT_MAT3:  	return value => gl!.uniformMatrix3fv(loc, false, value);
		case gl!.FLOAT_MAT4:  	return value => gl!.uniformMatrix4fv(loc, false, value);

    	case gl!.FLOAT_MAT2x3:	return value => gl!.uniformMatrix2x3fv(loc, false, value);
    	case gl!.FLOAT_MAT2x4:	return value => gl!.uniformMatrix2x4fv(loc, false, value);
    	case gl!.FLOAT_MAT3x2:	return value => gl!.uniformMatrix3x2fv(loc, false, value);
    	case gl!.FLOAT_MAT3x4:	return value => gl!.uniformMatrix3x4fv(loc, false, value);
    	case gl!.FLOAT_MAT4x2:	return value => gl!.uniformMatrix4x2fv(loc, false, value);
    	case gl!.FLOAT_MAT4x3:	return value => gl!.uniformMatrix4x3fv(loc, false, value);

		case gl!.BOOL_VEC2:
		case gl!.INT_VEC2:  	return value => gl!.uniform2i(loc, value[0], value[1]);
		case gl!.BOOL_VEC3:
		case gl!.INT_VEC3:  	return value => gl!.uniform3i(loc, value[0], value[1], value[2]);
		case gl!.BOOL_VEC4:
		case gl!.INT_VEC4:  	return value => gl!.uniform4i(loc, value[0], value[1], value[2], value[3]);

		default:
		case gl!.BOOL:
		case gl!.INT:
		case gl!.SAMPLER_2D:
		case gl!.SAMPLER_3D:
		case gl!.SAMPLER_CUBE:	return value => gl!.uniform1i(loc, value);
	}
}

function getAllUniforms(program: WebGLProgram) {
	const uniforms	= {} as Uniforms<string>;
	const count		= gl!.getProgramParameter(program, gl!.ACTIVE_UNIFORMS);
	for (let i = 0; i < count; i++) {
		const info = gl!.getActiveUniform(program, i);
		if (info) {
			const name		= info.name.replace(/\[0\]$/, ''); // normalize array names
			const location	= gl!.getUniformLocation(program, name);
			uniforms[name]	= uniformSetter(info.type, location!);
		}
	}
	return uniforms;
}

class ShaderProgram {
	program: WebGLProgram;
	uniforms: Uniforms;
	vao: WebGLVertexArrayObject|null = null;

	constructor(vertSource: string, fragSource: string) {
		this.program = createProgram(vertSource, fragSource);
		this.uniforms = getAllUniforms(this.program);
	}
	setVao(attrib: string, componentCount: number, data: Float32Array) {
		this.vao = createVao(this.program, attrib, componentCount, data);
	}
	use(uniforms?: Record<string, any>) {
		gl!.useProgram(this.program);
		if (uniforms) {
			for (const name in uniforms)
				this.uniforms[name]?.(uniforms[name]);
		}
		if (this.vao)
			gl!.bindVertexArray(this.vao);
	}
};

let texture:	WebGLTexture|null = null;
let image:		ImageData|null= null;
let atlasWidth	= 0;
let atlasHeight = 0;
let pixelRatio  = window.devicePixelRatio || 1;

let programBG:		ShaderProgram;
let program2D:		ShaderProgram;
let program2DArray:	ShaderProgram;
let programCube:	ShaderProgram;
let programCube2D:	ShaderProgram;
let program3D:		ShaderProgram;
let program3D2D:	ShaderProgram;

const tooltip = new Tooltip();

let mode		= '';
let currentLayer = 0;
let scale       = 1;
let offset    	= {x: 0, y: 0};
let view		= {
	x: {x: 1, y: 0, z: 0},
	y: {x: 0, y: 1, z: 0},
	z: {x: 0, y: 0, z: 1},
	w: {x: 0, y: 0, z: -3},
};
let flatten		= 0;
let sliceHeight	= 0;
const fovy0 = 1 / Math.tan(Math.PI / 6);
let fovy = fovy0;

const rectVerts		= new Float32Array([
	-1, -1,		1, -1,		-1, 1,
	-1, 1,		1, -1,		1, 1
]);

const cubeVerts 	= new Float32Array([
	+1, -1, +1,		+1, -1, -1,		+1, +1, +1,		+1, +1, +1,		+1, -1, -1,		+1, +1, -1,	// +X
	-1, +1, -1,		-1, -1, -1,		-1, +1, +1,		-1, +1, +1,		-1, -1, -1,		-1, -1, +1,	// -X
	+1, +1, -1,		-1, +1, -1,		+1, +1, +1,		+1, +1, +1,		-1, +1, -1,		-1, +1, +1,	// +Y
	-1, -1, +1,		-1, -1, -1,		+1, -1, +1,		+1, -1, +1,		-1, -1, -1,		+1, -1, -1,	// -Y
	-1, +1, +1,		-1, -1, +1,		+1, +1, +1,		+1, +1, +1,		-1, -1, +1,		+1, -1, +1,	// +Z
	+1, -1, -1,		-1, -1, -1,		+1, +1, -1,		+1, +1, -1,		-1, -1, -1,		-1, +1, -1,	// -Z
]);


function postMessage(message: MessageOut) {
	vscode.postMessage(message);
}

function createShader(type: number, source: string) {
	const shader = gl!.createShader(type);
	if (!shader)
		throw new Error('Failed to create shader');
	gl!.shaderSource(shader, source);
	gl!.compileShader(shader);
	if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS))
		throw new Error(gl!.getShaderInfoLog(shader) || 'Unknown shader error');
	return shader;
}

function createProgram(vertSource: string, fragSource: string) {
	const vertex = createShader(gl!.VERTEX_SHADER, vertSource);
	const fragment = createShader(gl!.FRAGMENT_SHADER, fragSource);
	const program = gl!.createProgram();
	if (!program)
		throw new Error('Failed to create program');
	gl!.attachShader(program, vertex);
	gl!.attachShader(program, fragment);
	gl!.linkProgram(program);
	if (!gl!.getProgramParameter(program, gl!.LINK_STATUS))
		throw new Error(gl!.getProgramInfoLog(program) || 'Unable to link program');
	gl!.deleteShader(vertex);
	gl!.deleteShader(fragment);
	return program;
}

function createVao(program: WebGLProgram, attrib: string, componentCount: number, data: Float32Array) {
	const vao = gl!.createVertexArray();
	if (!vao)
		throw new Error('Unable to create VAO');

	const buffer = gl!.createBuffer();
	if (!buffer)
		throw new Error('Unable to create buffer');

	gl!.bindVertexArray(vao);
	gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
	gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);

	const location = gl!.getAttribLocation(program, attrib);
	if (location < 0)
		throw new Error(`Shader attribute ${attrib} not found`);
	gl!.enableVertexAttribArray(location);
	gl!.vertexAttribPointer(location, componentCount, gl!.FLOAT, false, 0, 0);
	gl!.bindVertexArray(null);
	return vao;
}

function convertImage(image: ImageData0) {
	return new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height);
}

function createTextureFromImage(image: ImageData) {
	const texture = gl!.createTexture();
	gl!.bindTexture(gl!.TEXTURE_2D, texture);
	gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
	gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
	gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
	gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
	gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, image.width, image.height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, image.data);
//	gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.LUMINANCE, image.width, image.height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, image.data);
	gl!.bindTexture(gl!.TEXTURE_2D, null);
	return texture;
}

function createCubeTextureFromImage(image: ImageData) {
	const texture = gl!.createTexture();
	gl!.bindTexture(gl!.TEXTURE_CUBE_MAP, texture);
	gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
	gl!.texParameteri(gl!.TEXTURE_CUBE_MAP, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
	gl!.texParameteri(gl!.TEXTURE_CUBE_MAP, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
	gl!.texParameteri(gl!.TEXTURE_CUBE_MAP, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_CUBE_MAP, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_CUBE_MAP, gl!.TEXTURE_WRAP_R, gl!.CLAMP_TO_EDGE);

	const faces = [
		gl!.TEXTURE_CUBE_MAP_POSITIVE_X,
		gl!.TEXTURE_CUBE_MAP_NEGATIVE_X,
		gl!.TEXTURE_CUBE_MAP_POSITIVE_Y,
		gl!.TEXTURE_CUBE_MAP_NEGATIVE_Y,
		gl!.TEXTURE_CUBE_MAP_POSITIVE_Z,
		gl!.TEXTURE_CUBE_MAP_NEGATIVE_Z,
	];

	const height = image.height / 6;
	for (let i = 0; i < faces.length; i++)
		gl!.texImage2D(faces[i], 0, gl!.RGBA, image.width, height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, image.data.subarray(i * image.width * 4 * height, (i + 1) * image.width * 4 * height));

	gl!.bindTexture(gl!.TEXTURE_CUBE_MAP, null);
	return texture;
}

function create2DArrayTexture(image: ImageData, layers: number) {
	const texture = gl!.createTexture();
	const layerHeight = image.height / layers;
	gl!.bindTexture(gl!.TEXTURE_2D_ARRAY, texture);
	gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
	gl!.texParameteri(gl!.TEXTURE_2D_ARRAY, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
	gl!.texParameteri(gl!.TEXTURE_2D_ARRAY, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
	gl!.texParameteri(gl!.TEXTURE_2D_ARRAY, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_2D_ARRAY, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
	gl!.texImage3D(gl!.TEXTURE_2D_ARRAY, 0, gl!.RGBA, image.width, layerHeight, layers, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, image.data);
	gl!.bindTexture(gl!.TEXTURE_2D_ARRAY, null);
	return texture;
}

function create3DTextureFromImage(image: ImageData, depth: number) {
	const texture = gl!.createTexture();
	gl!.bindTexture(gl!.TEXTURE_3D, texture);
	gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
	gl!.texParameteri(gl!.TEXTURE_3D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
	gl!.texParameteri(gl!.TEXTURE_3D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
	gl!.texParameteri(gl!.TEXTURE_3D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_3D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
	gl!.texParameteri(gl!.TEXTURE_3D, gl!.TEXTURE_WRAP_R, gl!.CLAMP_TO_EDGE);
	gl!.texImage3D(gl!.TEXTURE_3D, 0, gl!.RGBA, image.width, image.height / depth, depth, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, image.data);
	gl!.bindTexture(gl!.TEXTURE_3D, null);
	return texture;
}

function mat4Multiply(a: Float32Array, b: Float32Array) {
	return new Float32Array([
		a[0] * b[0] + a[4] * b[1] + a[8]  * b[2] + a[12] * b[3],
		a[1] * b[0] + a[5] * b[1] + a[9]  * b[2] + a[13] * b[3],
		a[2] * b[0] + a[6] * b[1] + a[10] * b[2] + a[14] * b[3],
		a[3] * b[0] + a[7] * b[1] + a[11] * b[2] + a[15] * b[3],
		a[0] * b[4] + a[4] * b[5] + a[8]  * b[6] + a[12] * b[7],
		a[1] * b[4] + a[5] * b[5] + a[9]  * b[6] + a[13] * b[7],
		a[2] * b[4] + a[6] * b[5] + a[10] * b[6] + a[14] * b[7],
		a[3] * b[4] + a[7] * b[5] + a[11] * b[6] + a[15] * b[7],
		a[0] * b[8] + a[4] * b[9] + a[8]  * b[10] + a[12] * b[11],
		a[1] * b[8] + a[5] * b[9] + a[9]  * b[10] + a[13] * b[11],
		a[2] * b[8] + a[6] * b[9] + a[10] * b[10] + a[14] * b[11],
		a[3] * b[8] + a[7] * b[9] + a[11] * b[10] + a[15] * b[11],
		a[0] * b[12] + a[4] * b[13] + a[8]  * b[14] + a[12] * b[15],
		a[1] * b[12] + a[5] * b[13] + a[9]  * b[14] + a[13] * b[15],
		a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14] * b[15],
		a[3] * b[12] + a[7] * b[13] + a[11] * b[14] + a[15] * b[15],
	]);
}

function mat4TransformDir(m: Float32Array, v: {x: number; y: number; z: number}) {
	return {
		x: m[0] * v.x + m[4] * v.y + m[8]  * v.z,
		y: m[1] * v.x + m[5] * v.y + m[9]  * v.z,
		z: m[2] * v.x + m[6] * v.y + m[10] * v.z,
	};
}

function mat4TransformPos(m: Float32Array, v: {x: number; y: number; z: number}) {
	return {
		x: m[0] * v.x + m[4] * v.y + m[8]  * v.z + m[12],
		y: m[1] * v.x + m[5] * v.y + m[9]  * v.z + m[13],
		z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
	};
}

function normalize(v: {x: number; y: number; z: number}) {
	const len = Math.hypot(v.x, v.y, v.z);
	return len === 0 ? {x: 0, y: 0, z: 0} : {x: v.x / len, y: v.y / len, z: v.z / len};
}

function cross(a: float3, b: float3) {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x,
	};
}
function dot(a: float3, b: float3) {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function lerp(a: float3, b: float3, t: number) {
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
		z: a.z + (b.z - a.z) * t,
	};
}

function rotateAroundAxis0(v: float3, n: float3, c: number, s: number) {
	const dotS		= dot(v, n) * (1 - c);
	const crossV	= cross(n, v);
	return {
		x: v.x * c + crossV.x * s + n.x * dotS,
		y: v.y * c + crossV.y * s + n.y * dotS,
		z: v.z * c + crossV.z * s + n.z * dotS,
	};
}

function rotateAroundAxis(v: float3, n: float3, angle: number) {
	return rotateAroundAxis0(v, n, Math.cos(angle), Math.sin(angle));
}

function orthonormalizeCubeBasis() {
	view.x = normalize(view.x);
	view.z = normalize(cross(view.x, view.y));
	view.y = normalize(cross(view.z, view.x));
}

interface quat {
	x: number;
	y: number;
	z: number;
	w: number;
}

// rotation matrix with columns x, y, z
function basisToQuat(x: float3, y: float3, z: float3): quat {
	const trace = x.x + y.y + z.z;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return {x: (y.z - z.y) * s, y: (z.x - x.z) * s, z: (x.y - y.x) * s, w: 0.25 / s};
	}
	if (x.x > y.y && x.x > z.z) {
		const s = 2 * Math.sqrt(1 + x.x - y.y - z.z);
		return {x: 0.25 * s, y: (y.x + x.y) / s, z: (z.x + x.z) / s, w: (y.z - z.y) / s};
	}
	if (y.y > z.z) {
		const s = 2 * Math.sqrt(1 + y.y - x.x - z.z);
		return {x: (y.x + x.y) / s, y: 0.25 * s, z: (z.y + y.z) / s, w: (z.x - x.z) / s};
	}
	const s = 2 * Math.sqrt(1 + z.z - x.x - y.y);
	return {x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: 0.25 * s, w: (x.y - y.x) / s};
}

function quatToBasis({x, y, z, w}: quat) {
	return {
		x: {x: 1 - 2 * (y * y + z * z),	y: 2 * (x * y + w * z),			z: 2 * (x * z - w * y)},
		y: {x: 2 * (x * y - w * z),		y: 1 - 2 * (x * x + z * z),		z: 2 * (y * z + w * x)},
		z: {x: 2 * (x * z + w * y),		y: 2 * (y * z - w * x),			z: 1 - 2 * (x * x + y * y)},
	};
}

function slerp(a: quat, b: quat, t: number): quat {
	let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
	if (d < 0) {	// take the short way round
		d = -d;
		b = {x: -b.x, y: -b.y, z: -b.z, w: -b.w};
	}
	let ta = 1 - t, tb = t;
	if (d < 0.9995) {
		const angle = Math.acos(d);
		const s		= Math.sin(angle);
		ta = Math.sin((1 - t) * angle) / s;
		tb = Math.sin(t * angle) / s;
	}
	const q = {x: a.x * ta + b.x * tb, y: a.y * ta + b.y * tb, z: a.z * ta + b.z * tb, w: a.w * ta + b.w * tb};
	const len = Math.hypot(q.x, q.y, q.z, q.w);
	return {x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len};
}

function mat4OrthoNormalInverse(m: Float32Array) {
	const inv = new Float32Array([
		m[0], m[4], m[8], 0,
		m[1], m[5], m[9], 0,
		m[2], m[6], m[10], 0,
		0, 0, 0, 1,
	]);
	const t = mat4TransformPos(inv, {x: m[12], y: m[13], z: m[14]});
	inv[12] = -t.x;
	inv[13] = -t.y;
	inv[14] = -t.z;
	return inv;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number) {
	const nf = 1.0 / (near - far);
	return new Float32Array([
		fovy / aspect, 0, 0, 0,
		0, fovy, 0, 0,
		0, 0, (far + near) * nf, -1,
		0, 0, (2 * far * near) * nf, 0,
	]);
}

function getScreenRayDirection(clientX: number, clientY: number, fovy: number) {
	const rect	= canvas.getBoundingClientRect();
	const ndcX	= ((clientX - rect.left) / rect.width) * 2 - 1;
	const ndcY	= 1 - ((clientY - rect.top) / rect.height) * 2;

	const aspect = canvas.width / canvas.height;
	return normalize({
		x: ndcX * aspect / fovy,
		y: ndcY / fovy,
		z: -1,
	});
}

function cubePointNormal(point: {x:number,y:number,z:number}) {
    const ax = Math.abs(point.x);
    const ay = Math.abs(point.y);
    const az = Math.abs(point.z);

    return ax >= ay && ax >= az
        ? {x: Math.sign(point.x), y: 0, z: 0}
        : ay >= ax && ay >= az
		? {x: 0, y: Math.sign(point.y), z: 0}
		: {x: 0, y: 0, z: Math.sign(point.z)};
}

function intersectRayCube(origin: {x: number; y: number; z: number}, dir: {x: number; y: number; z: number}) {
	const tx1 = (-1 - origin.x) / dir.x;
	const tx2 = ( 1 - origin.x) / dir.x;
	const tminx = Math.min(tx1, tx2);
	const tmaxx = Math.max(tx1, tx2);

	const ty1 = (-1 - origin.y) / dir.y;
	const ty2 = ( 1 - origin.y) / dir.y;
	const tminy = Math.min(ty1, ty2);
	const tmaxy = Math.max(ty1, ty2);

	const tz1 = (-1 - origin.z) / dir.z;
	const tz2 = ( 1 - origin.z) / dir.z;
	const tminz = Math.min(tz1, tz2);
	const tmaxz = Math.max(tz1, tz2);

	const tmin = Math.max(tminx, tminy, tminz);
	const tmax = Math.min(tmaxx, tmaxy, tmaxz);
	if (tmax < 0 || tmin > tmax)
		return null;
	return {x: origin.x + dir.x * tmin, y: origin.y + dir.y * tmin, z: origin.z + dir.z * tmin};
}

function cubeDirectionToFaceUV(dir: {x: number; y: number; z: number}) {
	const absX = Math.abs(dir.x);
	const absY = Math.abs(dir.y);
	const absZ = Math.abs(dir.z);
	if (absX >= absY && absX >= absZ) {
		return dir.x > 0
			? {face: 0, u: (-dir.z / absX + 1) * 0.5, v: (-dir.y / absX + 1) * 0.5}
			: {face: 1, u: ( dir.z / absX + 1) * 0.5, v: (-dir.y / absX + 1) * 0.5};
	}
	if (absY >= absX && absY >= absZ) {
		return dir.y > 0
			? {face: 2, u: (dir.x / absY + 1) * 0.5, v: ( dir.z / absY + 1) * 0.5}
			: {face: 3, u: (dir.x / absY + 1) * 0.5, v: (-dir.z / absY + 1) * 0.5};
	}
	return dir.z > 0
		? {face: 4, u: ( dir.x / absZ + 1) * 0.5, v: (-dir.y / absZ + 1) * 0.5}
		: {face: 5, u: (-dir.x / absZ + 1) * 0.5, v: (-dir.y / absZ + 1) * 0.5};
}

function getView() {
	return new Float32Array([
		view.x.x, view.x.y, view.x.z, 0,
		view.y.x, view.y.y, view.y.z, 0,
		view.z.x, view.z.y, view.z.z, 0,
		view.w.x, view.w.y, view.w.z, 1,
	]);
}

function render() {
	if (!gl || !texture || !image)
		return;

	gl.viewport(0, 0, canvas.width, canvas.height);

	switch (mode) {
		case '2d': {
			if (!program2D)
				return;

			program2D.use({
				u_texture: 	0,
				u_size:    	[image.width, image.height],
				u_viewport:	[canvas.width, canvas.height],
				u_scale:   	scale,
				u_offset:  	[offset.x, offset.y],
			});

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
			break;
		}
		case '2d-array': {
			if (!program2DArray)
				return;

			program2DArray.use({
				u_texture:	0,
				u_size:		[image.width, sliceHeight, sliceHeight],
				u_viewport:	[canvas.width, canvas.height],
				u_scale:	scale,
				u_offset:	[offset.x, offset.y],
				u_layer:	currentLayer,
			});

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
			break;
		}
		case 'cube': {
			if (flatten === 1) {
				programCube2D.use({
					u_texture:  0,
					u_size:     image.width,
					u_viewport: [canvas.width, canvas.height],
					u_scale:    scale,
					u_offset:   [offset.x, offset.y],
				});
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
				gl.drawArrays(gl.TRIANGLES, 0, 6);
				return;
			}

			programBG!.use({u_viewport: [canvas.width, canvas.height]});
			gl.drawArrays(gl.TRIANGLES, 0, 6);

			gl.clearColor(0.06, 0.06, 0.06, 1);
			gl.clear(gl.DEPTH_BUFFER_BIT);

			const projection	= mat4Perspective(fovy, canvas.width / canvas.height, 0.1, 100.0);
			const mvp			= mat4Multiply(projection, getView());
			programCube.use({
				u_texture: 	0,
				u_size:    	image.width,
				u_mvp:		mvp,
				u_flatten: 	flatten,
			});

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
			gl.drawArrays(gl.TRIANGLES, 0, 36);
			break;
		}
		case '3d': {
			if (flatten === 1) {
				program3D2D.use({
					u_texture: 	0,
					u_size:    	[image.width, sliceHeight, image.height / sliceHeight],
					u_viewport: [canvas.width, canvas.height],
					u_scale:   	scale,
					u_offset:  	[offset.x, offset.y],
				});
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_3D, texture);
				gl.drawArrays(gl.TRIANGLES, 0, 6);
				return;
			}

			programBG!.use({u_viewport: [canvas.width, canvas.height]});
			gl.drawArrays(gl.TRIANGLES, 0, 6);

			gl.clearColor(0.06, 0.06, 0.06, 1);
			gl.clear(gl.DEPTH_BUFFER_BIT);

			const projection	= mat4Perspective(fovy, canvas.width / canvas.height, 0.1, 100.0);
			const view			= getView();
			const iview			= mat4OrthoNormalInverse(view);
			const mvp			= mat4Multiply(projection, view);

			program3D.use({
				u_texture: 	0,
				u_mvp:		mvp,
				u_origin:	iview.slice(12, 15),
				u_opacity:	1.0,
				u_size:    	image.width,
				u_light:	iview.slice(8, 11), // direction towards the light: a headlight, from the camera
				u_flatten: 	flatten,
			});

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_3D, texture);
			gl.drawArrays(gl.TRIANGLES, 0, 36);
			break;
		}
	}
}

function getImageData(image: ImageData, type: string) {
	const offscreen = new OffscreenCanvas(image.width, image.height);
	const ctx = offscreen.getContext('2d');
	if (!ctx)
		return;
	ctx.putImageData(image, 0, 0);
	return offscreen.convertToBlob({ type });
}

function getPixel(image: ImageData, x: number, y: number) {
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


async function setPixel(image: ImageData, x: number, y: number, colour: {r: number, g: number, b: number}) {
	const index = (y * image.width + x) * 4;
	image.data[index + 0] = Math.max(Math.min(colour.r, 255), 0);
	image.data[index + 1] = Math.max(Math.min(colour.g, 255), 0);
	image.data[index + 2] = Math.max(Math.min(colour.b, 255), 0);
	image.data[index + 3] = 255;
	if (texture)
		gl!.deleteTexture(texture);
	texture = createTextureFromImage(image);
	render();
}

function bitmapToImage(bitmap: ImageBitmap) {
	const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = offscreen.getContext('2d');
	if (!ctx)
		throw new Error('Unable to create offscreen context');
	ctx.drawImage(bitmap, 0, 0);
	return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function resizeCanvas() {
	const pixelRatio = window.devicePixelRatio || 1
	const rect = canvas.getBoundingClientRect();
	canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
	canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));

	scale	= clampScale(scale);
	offset	= clampOffset(offset.x, offset.y);
}

const layerSlider = document.getElementById('layer-slider') as HTMLInputElement;
const layerLabel  = document.getElementById('layer-label') as HTMLSpanElement;

layerSlider.addEventListener('input', () => {
	currentLayer = Number(layerSlider.value);
	layerLabel.textContent = `${currentLayer} / ${layerSlider.max}`;
	render();
});

// Orientation in which the unfolded layout is seen face on, matching the 2D view.
// A volume unfolds with slice 0 at the top and image rows running down the screen, so it faces the camera
// with a half turn about x (slice 0 in front, image upright); the cube unfolds around its +Z face.
function homeRotation() {
	return mode === '3d'
		? {x: {x: 1, y: 0, z: 0}, y: {x: 0, y: -1, z: 0}, z: {x: 0, y: 0, z: -1}}
		: {x: {x: 1, y: 0, z: 0}, y: {x: 0, y: 1, z: 0}, z: {x: 0, y: 0, z: 1}};
}

function fitView() {
	if ((mode === 'cube' || mode === '3d') && flatten === 0) {
		const home = homeRotation();
		view.x = home.x;
		view.y = home.y;
		view.z = home.z;
		view.w = {x: 0, y: 0, z: -3};

	} else if (image) {
		scale = Math.min(16, Math.min(canvas.width / atlasWidth, canvas.height / atlasHeight));
		offset = {x: (canvas.width - atlasWidth * scale) / 2, y: (canvas.height - atlasHeight * scale) / 2};
	}
}

function pointerToCanvas(clientX: number, clientY: number) {
	const rect = canvas.getBoundingClientRect();
	return {
		x: (clientX - rect.left) * pixelRatio,
		y: (clientY - rect.top) * pixelRatio
	};
}

function pointerToCube(clientX: number, clientY: number, fovy: number) {
	const dir = getScreenRayDirection(clientX, clientY, fovy);
	const inv = mat4OrthoNormalInverse(getView());
	const dirLocal = mat4TransformDir(inv, dir);
	const orgLocal = mat4TransformPos(inv, {x: 0, y: 0, z: 0});
	return intersectRayCube(orgLocal, dirLocal);
}

function clampDimension(x: number, size: number) {
	return Math.min(size - 1, Math.max(0, Math.floor(x * size)));
}

const cubeFaceNames = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

canvas.addEventListener('pointermove', event => {
	if (image) switch (mode) {
		case '2d': {
			const point = pointerToCanvas(event.clientX, event.clientY);
			const x = Math.floor((point.x - offset.x) / scale);
			const y = Math.floor((point.y - offset.y) / scale);
			const colour = getPixel(image, x, y);
			if (colour) {
				tooltip.show(`Pixel ${x}, ${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
				return;
			}
			break;
		}
		case 'cube': {
			const point = pointerToCube(event.clientX, event.clientY, fovy);
			if (point) {
				const faceUv = cubeDirectionToFaceUV(point);
				const x = clampDimension(faceUv.u, image.width);
				const y = clampDimension(faceUv.v, sliceHeight);
				const colour = getPixel(image, x, y + faceUv.face * sliceHeight);
				if (colour) {
					tooltip.show(`Cube ${cubeFaceNames[faceUv.face]} ${x},${y} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
					return;
				}
			}
			break;
		}
		case '3d': {
			const point = pointerToCube(event.clientX, event.clientY, fovy);
			if (point) {
				const x = clampDimension(point.x, image.width);
				const y = clampDimension(point.y, sliceHeight);
				const z = clampDimension(point.z, image.height / sliceHeight);
				const colour = getPixel(image, x, y + z * sliceHeight);
				if (colour) {
					tooltip.show(`Pixel ${x},${y},${z} — R:${colour.r} G:${colour.g} B:${colour.b} A:${colour.a}`, event.clientX + 12, event.clientY + 12);
					return;
				}
			}
			break;
		}
	}
	tooltip.hide();
});

canvas.addEventListener('pointerleave', () => {
	tooltip.hide();
});

function clampScale(scale: number) {
	const minScale = Math.min(canvas.width / atlasWidth, canvas.height / atlasHeight);
	return Math.min(256, Math.max(minScale, scale));
}

// 1:1, centred - but never below the minimum (fit to window) that zooming allows, or the first wheel tick would jump
function resetScale() {
	scale	= clampScale(1);
	offset	= {x: (canvas.width - atlasWidth * scale) / 2, y: (canvas.height - atlasHeight * scale) / 2};
}

function clampOffset(x: number, y: number) {
	if (!image)
		return {x, y};
	const imageWidthPx	= atlasWidth * scale;
	const imageHeightPx = atlasHeight * scale;
	const minX = Math.min(0, canvas.width - imageWidthPx);
	const maxX = Math.max(0, canvas.width - imageWidthPx);
	const minY = Math.min(0, canvas.height - imageHeightPx);
	const maxY = Math.max(0, canvas.height - imageHeightPx);
	return {
		x: Math.min(maxX, Math.max(minX, x)),
		y: Math.min(maxY, Math.max(minY, y))
	};
}

canvas.addEventListener('pointerdown', event => {
	canvas.setPointerCapture(event.pointerId);
	let onMove: (event: PointerEvent) => void;

	if (flatten === 0 && (mode === 'cube' || mode === '3d')) {
		let prevX = event.clientX;
		let prevY = event.clientY;

		const screenRight = {x: 1, y: 0, z: 0};
		const screenUp = {x: 0, y: 1, z: 0};
		let point = view.w.z < -2 ? pointerToCube(event.clientX, event.clientY, fovy) : null;

		onMove = (event: PointerEvent) => {
			if (point) {
				const targetDir = getScreenRayDirection(event.clientX, event.clientY, fovy);
				const viewPoint = mat4TransformPos(getView(), point);
				const currentDir = normalize(viewPoint);

				const d = dot(currentDir, targetDir);
				if (Math.abs(d - 1) < 1e-6)
					return; // already aligned

				const worldNormal = mat4TransformDir(getView(), cubePointNormal(point));
				if (dot(targetDir, worldNormal) < 0) {
					let axis = cross(targetDir, currentDir);
					if (Math.hypot(axis.x, axis.y, axis.z) < 1e-6) {
						// 180° case: choose any orthogonal axis
						axis = Math.hypot(currentDir.z, currentDir.y) < 1e-6
							? {x: -currentDir.z, y: 0, z: currentDir.x}
							: {x: 0, y:currentDir.z, z: -currentDir.y};
					}

					axis = normalize(axis);
					view.x = rotateAroundAxis0(view.x, axis, d, Math.sqrt(1 - d * d));
					view.y = rotateAroundAxis0(view.y, axis, d, Math.sqrt(1 - d * d));
				}

			} else {
				const dx = (event.clientX - prevX) * 0.01;
				const dy = (event.clientY - prevY) * 0.01;

				view.x = rotateAroundAxis(view.x, screenUp, dx);
				view.y = rotateAroundAxis(view.y, screenUp, dx);

				view.x = rotateAroundAxis(view.x, screenRight, dy);
				view.y = rotateAroundAxis(view.y, screenRight, dy);
			}

			orthonormalizeCubeBasis();
			render();
			prevX = event.clientX;
			prevY = event.clientY;
		};

	} else if (flatten === 1 || mode === '2d') {
		const startPoint = pointerToCanvas(event.clientX, event.clientY);
		const startOffset = offset;

		onMove = (event: PointerEvent) => {
			const current = pointerToCanvas(event.clientX, event.clientY);
			offset = clampOffset(startOffset.x + (current.x - startPoint.x), startOffset.y + (current.y - startPoint.y));
			render();
		};
	} else {
		return; // no interaction while transitioning
	}

	const onUp = () => {
		canvas.removeEventListener('pointermove', onMove);
		canvas.removeEventListener('pointerup', onUp);
		canvas.removeEventListener('pointercancel', onUp);
	};

	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
});

canvas.addEventListener('wheel', event => {
	event.preventDefault();
	const delta = event.deltaY < 0 ? 1.15 : 0.87;

	if ((mode === 'cube' || mode === '3d') && flatten === 0) {
		//view.w.z = Math.max(-10, Math.min(-1.5, view.w.z / delta));
		view.w.z = view.w.z / delta;
		if (view.w.z > -1.5) {
			fovy *= delta;
			if (delta > 1)
				view.w.z = 0;
			else if (fovy < fovy0)
				view.w.z = -1.5;
		}

	} else {
		const centre = pointerToCanvas(event.clientX, event.clientY);
		const scale0 = scale;
		scale	= clampScale(scale * delta);
		offset	= clampOffset(centre.x - (centre.x - offset.x) / scale0 * scale, centre.y - (centre.y - offset.y) / scale0 * scale);
	}

	render();
});

window.addEventListener('resize', () => {
	resizeCanvas();
	render();
});

async function init2d() {
	if (!program2D) {
		const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '2d'});
		program2D	= new ShaderProgram(shaders.vert, shaders.frag);
		program2D.setVao('a_position', 2, rectVerts);
	}
}

function setTexture(newTexture: WebGLTexture) {
	if (texture)
		gl!.deleteTexture(texture);
	texture = newTexture;
}

// Camera position (with the home rotation) at which the unfolded layout lands exactly where the 2D view draws it
// (at the current scale and offset), so the switch between them is seamless.
// The unfolded layout is the plane z=planeZ, 2 world units across `width` atlas texels, with atlas point `centre` on the axis
function flatPosition(fovy: number, centre: {x: number, y: number}, width: number, planeZ: number) {
	const f = canvas.height / 2 * fovy;

	const widthPx		= width * scale;
	const depth			= 2 * f / widthPx;
	const pixelDeltaX	= offset.x + centre.x * scale - canvas.width / 2;
	const pixelDeltaY	= canvas.height / 2 - (offset.y + centre.y * scale);

	return {
		x: pixelDeltaX * depth / f,
		y: pixelDeltaY * depth / f,
		z: -depth - homeRotation().z.z * planeZ,
	};
}

function unfoldedPosition() {
	return mode === '3d'
		? flatPosition(fovy, {x: atlasWidth / 2, y: atlasHeight / 2}, image!.width, 0)
		: flatPosition(fovy, {x: image!.width * 1.5, y: image!.width * 1.5}, image!.width, 1);
}

let animation = 0;

// Animate between the 3D view (target 0) and the unfolded 2D layout (target 1).
// The unfolding itself is done by the shaders (u_flatten); this moves the camera so the layout ends up matching the 2D view.
function animateFlatten(target: number, cameraTarget: float3) {
	const id		= ++animation;
	const flatten0	= flatten;
	const start		= basisToQuat(view.x, view.y, view.z);
	const home		= homeRotation();
	const end		= basisToQuat(home.x, home.y, home.z);
	const w0		= view.w;
	const startTime	= performance.now();

	function step(now: number) {
		if (id !== animation)
			return;	// superseded

		const t		= Math.min(1, (now - startTime) / 300);
		const s		= t * t * (3 - 2 * t);
		flatten		= t === 1 ? target : flatten0 + (target - flatten0) * s;

		const basis	= quatToBasis(slerp(start, end, s));
		view.x		= basis.x;
		view.y		= basis.y;
		view.z		= basis.z;
		view.w		= lerp(w0, cameraTarget, s);
		render();
		if (t < 1)
			requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}

window.addEventListener('message', async event => {
	if (handleResult(event.data))
		return;

	const message = event.data as MessageIn | RpcMessage<MessageRpc>;
	switch (message.command) {
		case 'loadTexture': {
			await init2d();
			const bitmap = await createImageBitmap(new Blob([message.data], {type: message.mimeType}));
			image	= bitmapToImage(bitmap);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			setTexture(createTextureFromImage(image));
			mode	= '2d';
			fitView();
			render();
			break;
		}
		case 'load2d':
			await init2d();
			image	= convertImage(message.image);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			setTexture(createTextureFromImage(image));
			mode	= '2d';
			document.getElementById('layer-control')!.classList.add('hidden');
			fitView();
			render();
			break;

		case 'load2dArray': {
			if (!program2DArray) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'array2d'});
				program2DArray = new ShaderProgram(shaders.vert, shaders.frag);
				program2DArray.setVao('a_position', 2, rectVerts);
			}
			image		= convertImage(message.image);
			sliceHeight	= image.height / message.layers;
			atlasWidth	= image.width;
			atlasHeight	= sliceHeight;
			setTexture(create2DArrayTexture(image, message.layers));
			mode		= '2d-array';
			currentLayer = 0;
			layerSlider.max = String(message.layers - 1);
			layerSlider.value = '0';
			layerLabel.textContent = `0 / ${message.layers - 1}`;
			document.getElementById('layer-control')!.classList.remove('hidden');
			fitView();
			render();
			break;
		}

		case 'loadCube':
			if (!programCube) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'cube'});
				programCube	= new ShaderProgram(shaders.vert, shaders.frag);
				programCube.setVao('a_position', 3, cubeVerts);
				const shaders2d = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'cube2d'});
				programCube2D = new ShaderProgram(shaders2d.vert, shaders2d.frag);
				programCube2D.setVao('a_position', 2, rectVerts);
			}
			image		= convertImage(message.image);
			atlasWidth	= image.width * 4;
			atlasHeight	= image.height / 6 * 3;
			sliceHeight	= image.height / 6;
			setTexture(createCubeTextureFromImage(image));
			mode	= 'cube';
			fitView();
			render();
			break;

		case 'load3d':
			if (!program3D) {
				const shaders = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '3d'});
				program3D	= new ShaderProgram(shaders.vert, shaders.frag);
				program3D.setVao('a_position', 3, cubeVerts);
				const shaders2d = await RPC<{vert: string, frag: string}>({command: 'getShaders', type: '3d2d'});
				program3D2D = new ShaderProgram(shaders2d.vert, shaders2d.frag);
				program3D2D.setVao('a_position', 2, rectVerts);
			}
			image		= convertImage(message.image);
			atlasWidth	= image.width;
			atlasHeight	= image.height;
			sliceHeight	= image.height / message.depth;
			setTexture(create3DTextureFromImage(image, message.depth));
			mode	= '3d';
			fitView();
			render();
			break;

		case 'fitToWindow':
			fitView();
			render();
			break;

		case 'resetZoom':
			if (mode === 'cube' || mode === '3d') {
				if (flatten > 0) {
					// back to 3D: start from the 2D view as it is now
					if (flatten === 1)
						view.w = unfoldedPosition();
					animateFlatten(0, {x: 0, y: 0, z: -3});

				} else {
					resetScale();
					animateFlatten(1, unfoldedPosition());
				}

			} else {
				resetScale();
				render();
			}
			break;

		//RPC cases
		case 'getImage':
			if (image)
				sendResult(message.requestId, { pixels: image.data, width: image.width, height: image.height });
			else
				sendResult(message.requestId);
			break;

		case 'getTexture':
			if (image) {
				getImageData(image, message.type)?.then(async blob => {
					if (blob)
						sendResult(message.requestId, await blob.arrayBuffer());
					else
						sendResult(message.requestId);
				});
			} else {
				sendResult(message.requestId);
			}
			break;
	}

});

if (gl) {
	RPC<{vert: string, frag: string}>({command: 'getShaders', type: 'bg'}).then(shaders => {
		programBG	= new ShaderProgram(shaders.vert, shaders.frag);
		programBG.setVao('a_position', 2, rectVerts);

		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		//	gl.enable(gl.CULL_FACE);
		resizeCanvas();

		postMessage({command: 'ready'});
	});
}