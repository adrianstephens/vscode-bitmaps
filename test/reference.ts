// What the GPU's filters are checked against: the sums they make, worked out plainly (the viewer itself has only the GPU's).

export type Image = {data: ArrayLike<number>, width: number, height: number};

/** A gaussian blur, in place, of `channels` interleaved channels, as two passes along the lines. Beyond the edges it takes zero,
 *  or the edge's own value. */
export function gaussian(f: Float32Array, width: number, height: number, sigma: number, channels = 1, edge: 'zero' | 'clamp' = 'zero') {
	const rad = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(rad * 2 + 1);
	let sum = 0;
	for (let i = -rad; i <= rad; i++)
		sum += k[i + rad] = Math.exp(-i * i / (2 * sigma * sigma));
	for (let i = 0; i < k.length; i++)
		k[i] /= sum;
	const pass = (src: Float32Array, dst: Float32Array, count: number, step: number, lines: number, lineStep: number) => {
		for (let line = 0; line < lines; line++)
			for (let x = 0; x < count; x++)
				for (let c = 0; c < channels; c++) {
					let a = 0;
					for (let i = -rad; i <= rad; i++) {
						const at = x + i;
						if (at < 0 || at >= count) {
							if (edge === 'zero')
								continue;
						}
						a += src[line * lineStep + c + Math.min(count - 1, Math.max(0, at)) * step] * k[i + rad];
					}
					dst[line * lineStep + c + x * step] = a;
				}
	};
	const tmp = new Float32Array(f.length);
	pass(f, tmp, width, channels, height, width * channels);
	pass(tmp, f, height, width * channels, width, channels);
}

/** An rgba image blurred with its colours weighted by their alpha, beyond its edges taken to be its edge */
export function blurPixels(image: Image, sigma: number) {
	const {width, height, data} = image, f = new Float32Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const a = data[i * 4 + 3] / 255;
		f.set([data[i * 4] * a, data[i * 4 + 1] * a, data[i * 4 + 2] * a, data[i * 4 + 3]], i * 4);
	}
	gaussian(f, width, height, sigma, 4, 'clamp');
	const out = new Uint8ClampedArray(f.length);
	for (let i = 0; i < width * height; i++) {
		const a = f[i * 4 + 3] / 255;
		out.set([a > 0 ? f[i * 4] / a : 0, a > 0 ? f[i * 4 + 1] / a : 0, a > 0 ? f[i * 4 + 2] / a : 0, f[i * 4 + 3]], i * 4);
	}
	return out;
}

/** An unsharp mask: each colour pushed away from the blurred one by `amount`, the alpha left alone */
export function unsharp(image: Image, blurred: ArrayLike<number>, amount: number) {
	const out = new Uint8ClampedArray(image.data.length);
	for (let i = 0; i < out.length; i += 4) {
		out[i + 3] = image.data[i + 3];
		for (let c = 0; c < 3; c++) {
			const v = image.data[i + c];
			out[i + c] = image.data[i + 3] ? v + (v - blurred[i + c]) * amount : v;
		}
	}
	return out;
}

export interface Kernel {size: number, weights: number[], bias?: number, grey?: boolean, smooth?: boolean}

/** An rgba image convolved with a kernel (as raster.ts has them), beyond its edges taken to be its edge */
export function convolve(image: Image, kernel: Kernel) {
	const {width, height, data} = image, {size, weights} = kernel, half = size >> 1, bias = (kernel.bias ?? 0) * 255;
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let j = 0; j < size; j++) {
				const sy = Math.min(height - 1, Math.max(0, y + j - half));
				for (let i = 0; i < size; i++) {
					const sx = Math.min(width - 1, Math.max(0, x + i - half)), o = (sy * width + sx) * 4, w = weights[j * size + i];
					if (kernel.smooth) {
						const k = data[o + 3] / 255 * w;
						r += data[o] * k; g += data[o + 1] * k; b += data[o + 2] * k; a += data[o + 3] * w;
					} else if (kernel.grey) {
						const l = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) * w;
						r += l; g += l; b += l;
					} else {
						r += data[o] * w; g += data[o + 1] * w; b += data[o + 2] * w;
					}
				}
			}
			const d = (y * width + x) * 4;
			if (kernel.smooth) {
				const k = a > 0 ? 255 / a : 0;
				out.set([r * k, g * k, b * k, a], d);
			} else {
				out.set([r + bias, g + bias, b + bias, data[d + 3]], d);
			}
		}
	}
	return out;
}
