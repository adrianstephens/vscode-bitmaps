import { Pixels } from './opengl.ts';
import { RGB } from './colour.ts';
import { curveVertex, ON_BEGIN, ON_CURVE, ON_END } from '@isopodlabs/binary_fonts/curves';
import {ShadePass } from './raster.ts'

const flattenPass = (u_mode: number, grow = 0, extra: Record<string, any> = {}, float = true): ShadePass => ({uniforms: {u_mode, ...extra}, float, grow: [grow, grow]});

// The picture smoothed without crossing edges, by flatten.frag (three times: each look is 2 pixels, so the first two passes draw 4 and 2 more than is wanted)
export function smoothedWith(run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, image: Pixels<4>) {
	return run(image, [flattenPass(0, 4), flattenPass(0, 2), flattenPass(0, 0, {}, false)], 6);
}

// The picture as `colours` flat colours with clean edges, which is what makes it small as vector shapes: first smoothed without crossing edges
// (a bilateral filter, which takes the grain and texture out of an area), then every pixel given the nearest of the colours k-means finds in
// it, then the specks and ragged edges that leaves tidied by taking the commonest colour round each pixel. Transparency is kept. The pixels
// are all done by flatten.frag; `run` gives it an image and its passes (and how far each pixel looks round it), and the colours are found
// here, from a sample of the smoothed picture. Nothing where there is no GPU.
export function flattenWith(run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, image: Pixels<4>, colours: number): Pixels<4> | undefined {
	const {width: W, height: H} = image, n = W * H, k = Math.max(2, Math.min(64, Math.round(colours)));
	// (the last pass of a run is bytes, which is what it is read as)
	const mode = flattenPass;

	const smooth = smoothedWith(run, image);
	if (!smooth)
		return undefined;
	const cur = smooth.data as Uint8ClampedArray;

	// the colours: k-means on a sample of the opaque pixels, started by k-means++ (each new centre likely to be far from those so far)
	const opaque: number[] = [], stride = Math.max(1, Math.floor(n / 20000));
	for (let i = 0; i < n; i += stride)
		if (cur[i * 4 + 3] >= 128)
			opaque.push(i);
	if (!opaque.length)
		return image;
	const centres = new Float32Array(k * 3), near = new Float64Array(opaque.length).fill(Infinity);
	let seed = 12345;
	const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
	const dist = (i: number, c: number) => (cur[i * 4] - centres[c * 3]) ** 2 + (cur[i * 4 + 1] - centres[c * 3 + 1]) ** 2 + (cur[i * 4 + 2] - centres[c * 3 + 2]) ** 2;
	for (let c = 0; c < k; c++) {
		let pick = opaque[Math.floor(random() * opaque.length)];
		if (c) {
			let t = random() * near.reduce((p, d) => p + d, 0);
			for (let j = 0; j < opaque.length; j++)
				if ((t -= near[j]) <= 0) {
					pick = opaque[j];
					break;
				}
		}
		centres.set([cur[pick * 4], cur[pick * 4 + 1], cur[pick * 4 + 2]], c * 3);
		opaque.forEach((p, j) => near[j] = Math.min(near[j], dist(p, c)));
	}
	for (let iter = 0; iter < 10; iter++) {
		const sum = new Float64Array(k * 3), count = new Float64Array(k);
		for (const p of opaque) {
			let best = 0, bd = Infinity;
			for (let c = 0; c < k; c++) {
				const d = dist(p, c);
				if (d < bd) {
					bd = d;
					best = c;
				}
			}
			sum[best * 3] += cur[p * 4];
			sum[best * 3 + 1] += cur[p * 4 + 1];
			sum[best * 3 + 2] += cur[p * 4 + 2];
			count[best]++;
		}
		for (let c = 0; c < k; c++)
			if (count[c])
				for (let j = 0; j < 3; j++)
					centres.set([sum[c * 3 + j] / count[c]], c * 3 + j);
	}

	// every pixel's colour, tidied twice (so a label is looked at 4 pixels round), and made the colour
	const table = new Float32Array(192);
	table.set(centres.map(Math.round));
	const using = {u_centres: table, u_count: k};
	return run(smooth, [mode(1, 4, using), mode(2, 2), mode(2), mode(3, 0, using, false)], 4);
}

// A picture `amount` (0..1) of the way from `base` to `over` (the same size), keeping the base's transparency
export function mixed(base: Pixels<4>, over: Pixels<4>, amount: number): Pixels<4> {
	const a = base.data as Uint8ClampedArray, b = over.data as Uint8ClampedArray, out = new Uint8ClampedArray(a.length);
	for (let i = 0; i < a.length; i += 4) {
		out[i]		= a[i] + (b[i] - a[i]) * amount;
		out[i + 1]	= a[i + 1] + (b[i + 1] - a[i + 1]) * amount;
		out[i + 2]	= a[i + 2] + (b[i + 2] - a[i + 2]) * amount;
		out[i + 3]	= a[i + 3];
	}
	return Pixels(out, base.width, base.height, 4);
}

//-----------------------------------------------------------------------------
// gradient regions
//-----------------------------------------------------------------------------

/** A picture as regions in each of which the colour is a plane over the picture, which is a linear gradient in a vector picture. A region
 *  is a set of cells (squares of `cell` pixels). */
export interface GradientRegions {
	cell:		number;
	gw:			number;				// the cells across and down
	gh:			number;
	labels:		Int32Array;			// of each cell, its region (-1 where it has nothing opaque)
	planes:		Float32Array;		// of each region, nine numbers: for each of red, green and blue its value at the centre, and its slope along x and along y
	scale:		number;				// x and y in the planes are from the picture's centre, in units of this many pixels
	size:		Int32Array;			// of each region, its pixels
	tolerance:	number;				// what they were fitted to (levels, as a root mean square)
}

// the sums a region's fit is made from, which add up as regions merge: n, x, y, xx, xy, yy, and for each channel c, x c, y c, cc
const SUMS = 18;

// the sum of squares of what a plane leaves (over the channels) from the sums at `o`, and its planes in `beta` (nine numbers) if asked for
function planeFit(s: Float64Array, o: number, beta?: Float32Array, bo = 0) {
	const n = s[o], sx = s[o + 1], sy = s[o + 2], ridge = 1e-6 * n;
	const a = n, b = sx, c = sy, d = s[o + 3] + ridge, e = s[o + 4], f = s[o + 5] + ridge;
	// the inverse of [[a b c] [b d e] [c e f]], by its cofactors
	const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d, D = a * f - c * c, E = b * c - a * e, F = a * d - b * b;
	const det = a * A + b * B + c * C;
	let total = 0;
	for (let ch = 0; ch < 3; ch++) {
		const k = o + 6 + ch * 4, sc = s[k], sxc = s[k + 1], syc = s[k + 2], scc = s[k + 3];
		if (!(det > 0)) {
			total += Math.max(0, scc - sc * sc / n);
			beta?.set([sc / n, 0, 0], bo + ch * 3);
			continue;
		}
		const b0 = (A * sc + B * sxc + C * syc) / det, b1 = (B * sc + D * sxc + E * syc) / det, b2 = (C * sc + E * sxc + F * syc) / det;
		total += Math.max(0, scc - (b0 * sc + b1 * sxc + b2 * syc));
		beta?.set([b0, b1, b2], bo + ch * 3);
	}
	return total;
}

/** The regions of (a smoothed) picture: squares of it are merged, the pair which costs the least in how far their colours stray from one
 *  plane first, for as long as the union is within `tolerance` (the most its colours may stray from the plane, as a root mean square, in
 *  levels of 255). Regions too small to be of use are then merged into the neighbour which fits them best. */
export function fitGradients(image: Pixels<4>, tolerance: number): GradientRegions {
	const {width: W, height: H} = image, src = image.data as Uint8ClampedArray;
	const cell = Math.max(3, Math.ceil(Math.sqrt(W * H / 120000))), gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), cells = gw * gh;
	const scale = Math.max(W, H) / 2;

	// each square's sums, over the pixels in it which are opaque
	const sums = new Float64Array(cells * SUMS), alive = new Uint8Array(cells), ver = new Int32Array(cells), fit = new Float64Array(cells);
	for (let cy = 0; cy < gh; cy++) {
		for (let cx = 0; cx < gw; cx++) {
			const o = (cy * gw + cx) * SUMS;
			for (let y = cy * cell; y < Math.min(H, (cy + 1) * cell); y++) {
				const ys = (y + 0.5 - H / 2) / scale;
				for (let x = cx * cell; x < Math.min(W, (cx + 1) * cell); x++) {
					const i = (y * W + x) * 4;
					if (src[i + 3] < 128)
						continue;
					const xs = (x + 0.5 - W / 2) / scale;
					sums[o]++;
					sums[o + 1] += xs;
					sums[o + 2] += ys;
					sums[o + 3] += xs * xs;
					sums[o + 4] += xs * ys;
					sums[o + 5] += ys * ys;
					for (let c = 0; c < 3; c++) {
						const v = src[i + c], k = o + 6 + c * 4;
						sums[k] += v;
						sums[k + 1] += xs * v;
						sums[k + 2] += ys * v;
						sums[k + 3] += v * v;
					}
				}
			}
			if (sums[o]) {
				alive[cy * gw + cx] = 1;
				fit[cy * gw + cx] = planeFit(sums, o);
			}
		}
	}

	const parent = Int32Array.from({length: cells}, (_, i) => i), opaque = alive.slice();
	const find = (r: number) => { while (parent[r] !== r) r = parent[r] = parent[parent[r]]; return r; };

	// which regions touch, and the merges to try, the cheapest first (a merge is dropped if either region has changed since it was priced)
	const near: Set<number>[] = Array.from({length: cells}, () => new Set<number>());
	const heap: {cost: number, a: number, b: number, va: number, vb: number}[] = [];
	const push = (item: typeof heap[number]) => {
		let i = heap.push(item) - 1;
		while (i > 0) {
			const up = (i - 1) >> 1;
			if (heap[up].cost <= item.cost)
				break;
			heap[i] = heap[up];
			i = up;
		}
		heap[i] = item;
	};
	const pop = () => {
		const top = heap[0], last = heap.pop()!;
		if (heap.length) {
			let i = 0;
			for (;;) {
				let child = 2 * i + 1;
				if (child >= heap.length)
					break;
				if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost)
					child++;
				if (heap[child].cost >= last.cost)
					break;
				heap[i] = heap[child];
				i = child;
			}
			heap[i] = last;
		}
		return top;
	};
	const joined = new Float64Array(SUMS);
	const unionFit = (a: number, b: number) => {
		for (let k = 0; k < SUMS; k++)
			joined[k] = sums[a * SUMS + k] + sums[b * SUMS + k];
		return planeFit(joined, 0);
	};
	const offer = (a: number, b: number) => push({cost: unionFit(a, b) - fit[a] - fit[b], a, b, va: ver[a], vb: ver[b]});
	const limit = tolerance * tolerance * 3;		// (the sum of squares a pixel may leave, over its channels)

	for (let cy = 0; cy < gh; cy++) {
		for (let cx = 0; cx < gw; cx++) {
			const a = cy * gw + cx;
			if (!alive[a])
				continue;
			for (const b of [cx + 1 < gw ? a + 1 : -1, cy + 1 < gh ? a + gw : -1]) {
				if (b >= 0 && alive[b]) {
					near[a].add(b);
					near[b].add(a);
					offer(a, b);
				}
			}
		}
	}

	const merge = (a: number, b: number) => {
		for (let k = 0; k < SUMS; k++)
			sums[a * SUMS + k] += sums[b * SUMS + k];
		alive[b] = 0;
		parent[b] = a;
		ver[a]++;
		ver[b]++;
		fit[a] = planeFit(sums, a * SUMS);
		near[a].delete(b);
		for (const x of near[b]) {
			if (x !== a) {
				near[x].delete(b);
				near[x].add(a);
				near[a].add(x);
			}
		}
		near[b].clear();
		for (const x of near[a])
			offer(a, x);
	};

	while (heap.length) {
		const {a, b, va, vb} = pop();
		if (!alive[a] || !alive[b] || ver[a] !== va || ver[b] !== vb)
			continue;
		const left = unionFit(a, b);
		if (left <= limit * (sums[a * SUMS] + sums[b * SUMS]))
			merge(a, b);
	}

	// the specks: a region of a few squares goes into the neighbour it suits best
	const tiny = 4 * cell * cell;
	const small: number[] = [];
	for (let r = 0; r < cells; r++)
		if (alive[r] && sums[r * SUMS] < tiny)
			small.push(r);
	small.sort((p, q) => sums[p * SUMS] - sums[q * SUMS]);
	for (const r of small) {
		if (!alive[r] || sums[r * SUMS] >= tiny)
			continue;
		let best = -1, cost = Infinity;
		for (const x of near[r]) {
			const c = unionFit(r, x) - fit[r] - fit[x];
			if (c < cost) {
				cost = c;
				best = x;
			}
		}
		if (best >= 0)
			merge(best, r);
	}

	// the regions as they are now, numbered, with their planes, and each square labelled with the region its own was merged into
	const root = new Int32Array(cells).fill(-1);
	let count = 0;
	for (let r = 0; r < cells; r++)
		if (alive[r])
			root[r] = count++;
	const planes = new Float32Array(count * 9), size = new Int32Array(count), labels = new Int32Array(cells).fill(-1);
	for (let r = 0; r < cells; r++) {
		if (alive[r]) {
			planeFit(sums, r * SUMS, planes, root[r] * 9);
			size[root[r]] = sums[r * SUMS];
		}
		if (opaque[r])
			labels[r] = root[find(r)];
	}
	return {cell, gw, gh, labels, planes, scale, size, tolerance};
}

/** Each pixel's region (-1 where it is transparent): the one round its square whose plane fits its own colour best, so that the regions'
 *  edges are where the picture's are and not on the squares' grid. */
export function labelPixels(image: Pixels<4>, fit: GradientRegions): Int32Array {
	const {width: W, height: H} = image, src = image.data as Uint8ClampedArray, out = new Int32Array(W * H).fill(-1);
	const {cell, gw, gh, labels, planes, scale} = fit, near: number[] = [];
	for (let cy = 0; cy < gh; cy++) {
		for (let cx = 0; cx < gw; cx++) {
			// the regions of this square and those next to it
			near.length = 0;
			for (let y = Math.max(0, cy - 1); y <= Math.min(gh - 1, cy + 1); y++)
				for (let x = Math.max(0, cx - 1); x <= Math.min(gw - 1, cx + 1); x++) {
					const l = labels[y * gw + x];
					if (l >= 0 && !near.includes(l))
						near.push(l);
				}
			if (!near.length)
				continue;
			for (let y = cy * cell; y < Math.min(H, (cy + 1) * cell); y++) {
				const ys = (y + 0.5 - H / 2) / scale;
				for (let x = cx * cell; x < Math.min(W, (cx + 1) * cell); x++) {
					const i = (y * W + x) * 4, xs = (x + 0.5 - W / 2) / scale;
					if (src[i + 3] < 128)
						continue;
					let best = near[0], bd = Infinity;
					for (const l of near) {
						const p = l * 9;
						let d = 0;
						for (let c = 0; c < 3; c++) {
							const e = src[i + c] - (planes[p + c * 3] + planes[p + c * 3 + 1] * xs + planes[p + c * 3 + 2] * ys);
							d += e * e;
						}
						if (d < bd) {
							bd = d;
							best = l;
						}
					}
					out[y * W + x] = best;
				}
			}
		}
	}

	// the edges then made smooth: a pixel on one goes to whichever region round it costs least, in how far its colour is from the region's
	// plane and in how many of its neighbours are of another region (so a step the picture does not insist on is straightened)
	const cost = (i: number, x: number, y: number, l: number) => {
		const p = l * 9, xs = (x + 0.5 - W / 2) / scale, ys = (y + 0.5 - H / 2) / scale;
		let d = 0;
		for (let c = 0; c < 3; c++) {
			const e = src[i * 4 + c] - (planes[p + c * 3] + planes[p + c * 3 + 1] * xs + planes[p + c * 3 + 2] * ys);
			d += e * e;
		}
		return d;
	};
	const lambda = fit.tolerance * fit.tolerance * 0.3;		// (more and the edges stay on the squares' grid where the colour changes slowly)
	const DX = [-1, 1, 0, 0, -1, 1, -1, 1], DY = [0, 0, -1, 1, -1, -1, 1, 1], WT = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2];
	const others = new Int32Array(8);
	// (a pixel's choice rests only on its neighbours, so after the first pass only those next to a change are looked at again)
	let todo = Int32Array.from({length: W * H}, (_, i) => i);
	const marked = new Uint8Array(W * H);
	for (let pass = 0; pass < 8 && todo.length; pass++) {
		const next: number[] = [];
		const back = pass & 1;		// (each way in turn, so that the edges are not pushed one way)
		for (let k = 0; k < todo.length; k++) {
			const i = todo[back ? todo.length - 1 - k : k], own = out[i], x = i % W, y = (i - x) / W;
			marked[i] = 0;
			if (own < 0)
				continue;
			near.length = 0;
			for (let j = 0; j < 8; j++) {
				const nx = x + DX[j], ny = y + DY[j];
				const l = nx >= 0 && ny >= 0 && nx < W && ny < H ? out[ny * W + nx] : -1;
				others[j] = l;
				if (l >= 0 && l !== own && !near.includes(l))
					near.push(l);
			}
			if (!near.length)
				continue;
			let best = own, bd = Infinity;
			for (let c = -1; c < near.length; c++) {
				const l = c < 0 ? own : near[c];
				let d = cost(i, x, y, l);
				for (let j = 0; j < 8; j++)
					if (others[j] >= 0 && others[j] !== l)
						d += lambda * WT[j];
				if (d < bd) {
					bd = d;
					best = l;
				}
			}
			if (best !== own) {
				out[i] = best;
				for (let j = -1; j < 8; j++) {
					const nx = j < 0 ? x : x + DX[j], ny = j < 0 ? y : y + DY[j];
					if (nx >= 0 && ny >= 0 && nx < W && ny < H && !marked[ny * W + nx]) {
						marked[ny * W + nx] = 1;
						next.push(ny * W + nx);
					}
				}
			}
		}
		todo = Int32Array.from(next).sort();
	}
	return out;
}

/** The picture the regions describe: each pixel the plane of its region. Transparency is the picture's own. */
export function paintGradients(image: Pixels<4>, fit: GradientRegions): Pixels<4> {
	const {width: W, height: H} = image, src = image.data as Uint8ClampedArray, out = new Uint8ClampedArray(src.length);
	const {planes, scale} = fit, labels = labelPixels(image, fit);
	for (let y = 0; y < H; y++) {
		const ys = (y + 0.5 - H / 2) / scale;
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4, l = labels[y * W + x], xs = (x + 0.5 - W / 2) / scale;
			if (l < 0) {
				out.set(src.subarray(i, i + 4), i);
				continue;
			}
			const p = l * 9;
			for (let c = 0; c < 3; c++)
				out[i + c] = planes[p + c * 3] + planes[p + c * 3 + 1] * xs + planes[p + c * 3 + 2] * ys;
			out[i + 3] = src[i + 3];
		}
	}
	return Pixels(out, W, H, 4);
}

/** The picture reduced to regions of smooth colour, each a linear gradient, where the colours stray from a region's plane by no more than
 *  `tolerance` levels; nothing where there is no GPU (which does the smoothing it starts with). */
export function gradientsWith(run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, image: Pixels<4>, tolerance: number): Pixels<4> | undefined {
	const smooth = smoothedWith(run, image);
	return smooth && paintGradients(smooth, fitGradients(smooth, tolerance));
}

//-----------------------------------------------------------------------------
// tracing regions as vector shapes
//-----------------------------------------------------------------------------

// Corners (x, y in pairs) with their pixel steps taken out: each corner is cut back along both its sides, by up to `cut` pixels (half
// a short side, so that a staircase is a slope); the ends of a run that is not closed stay where they are
function softened(corners: number[], closed: boolean, cut = 2.5): Float32Array {
	const n = corners.length / 2, sides = closed ? n : n - 1, out: number[] = closed ? [] : [corners[0], corners[1]];
	for (let i = 0; i < sides; i++) {
		const j = (i + 1) % n, x0 = corners[i * 2], y0 = corners[i * 2 + 1], x1 = corners[j * 2], y1 = corners[j * 2 + 1];
		const L = Math.abs(x1 - x0) + Math.abs(y1 - y0), ux = Math.sign(x1 - x0), uy = Math.sign(y1 - y0);
		const a = closed || i > 0 ? Math.min(L / 2, cut) : 0, b = closed || i < sides - 1 ? Math.min(L / 2, cut) : 0;
		if (a > 0)
			out.push(x0 + ux * a, y0 + uy * a);
		if (L > a + b)
			out.push(x1 - ux * b, y1 - uy * b);
	}
	return Float32Array.from(out);
}

/** The edges between the regions of a labelled picture (-1 for none), each traced once, so that neighbours made of them meet exactly */
export interface TracedEdges {
	runs:		Float32Array[];		// points (x, y in pairs, the pixels' steps taken out) from one place where three or more regions meet to the next,
	closed:		boolean[];			// or round a region within another, which go back to where they began
	regions:	{run: number, reversed: boolean}[][][];		// of each region, its outlines (its holes among them), each the runs round it in turn
}

/** The edges between the regions of a labelled picture. An outline goes clockwise (on the screen) round a region's outer edge, and the other
 *  way round a hole; pixels which meet only at a corner are not joined. */
export function traceEdges(labels: Int32Array, W: number, H: number): TracedEdges {
	const V = W + 1, at = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H ? -1 : labels[y * W + x];
	let count = 0;
	for (let i = 0; i < labels.length; i++)
		if (labels[i] >= count)
			count = labels[i] + 1;

	// an edge goes from a corner of the pixels (v) one way (d: right, down, left, up), with its region on its right and another on its left
	const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
	const right = (v: number, d: number) => { const x = v % V, y = (v - x) / V; return at(x - (d === 1 || d === 2 ? 1 : 0), y - (d >= 2 ? 1 : 0)); };
	const left = (v: number, d: number) => { const x = v % V, y = (v - x) / V; return at(x - (d >= 2 ? 1 : 0), y - (d === 0 || d === 3 ? 1 : 0)); };
	const edge = (v: number, d: number) => { const r = right(v, d); return r >= 0 && r !== left(v, d) ? r : -1; };
	const ahead = (v: number, d: number) => v + DX[d] + DY[d] * V;
	// where runs end: a corner with three or more regions round it, or two that meet only at the corner, or a corner of the picture (kept square)
	const junction = (v: number) => {
		const x = v % V, y = (v - x) / V, a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x - 1, y), d = at(x, y);
		const n = 1 + +(b !== a) + +(c !== a && c !== b) + +(d !== a && d !== b && d !== c);
		return n > 2 || (n === 2 && a === d && b === c) || ((x === 0 || x === W) && (y === 0 || y === H));
	};

	const runs: Float32Array[] = [], closed: boolean[] = [], regions: TracedEdges['regions'] = Array.from({length: count}, () => []);
	const owner = new Int32Array(V * (H + 1) * 4), walked = new Uint8Array(owner.length);		// (of each edge, its run + 1, negative if reversed)

	// a run made of edges (v, d in pairs), which its other side shares, reversed
	const made = (edges: number[], ring: boolean) => {
		const id = runs.length, corners: number[] = [];
		for (let k = 0; k < edges.length; k += 2) {
			const v = edges[k], d = edges[k + 1];
			if (k === 0 ? !ring || d !== edges[edges.length - 1] : d !== edges[k - 1])
				corners.push(v % V, Math.trunc(v / V));
			owner[v * 4 + d] = id + 1;
			owner[ahead(v, d) * 4 + ((d + 2) & 3)] = -(id + 1);
		}
		if (!ring) {
			const v = ahead(edges[edges.length - 2], edges[edges.length - 1]);
			corners.push(v % V, Math.trunc(v / V));
		}
		runs.push(softened(corners, ring));
		closed.push(ring);
		return id;
	};

	for (let v0 = 0; v0 < V * (H + 1); v0++) {
		for (let d0 = 0; d0 < 4; d0++) {
			const l = edge(v0, d0);
			if (l < 0 || walked[v0 * 4 + d0])
				continue;
			// the outline round: at each corner on to the edge of the same region that turns most to the right
			const edges: number[] = [];
			let v = v0, d = d0;
			do {
				walked[v * 4 + d] = 1;
				edges.push(v, d);
				v = ahead(v, d);
				d = [(d + 1) & 3, d, (d + 3) & 3].find(n => edge(v, n) === l)!;
			} while (v !== v0 || d !== d0);

			// cut into runs where it passes a junction, begun at one
			const n = edges.length / 2;
			let first = -1;
			for (let k = 0; k < n && first < 0; k++)
				if (junction(edges[k * 2]))
					first = k;
			const outline: {run: number, reversed: boolean}[] = [];
			const piece = (part: number[], ring: boolean) => {
				const o = owner[part[0] * 4 + part[1]];
				outline.push(o ? {run: Math.abs(o) - 1, reversed: o < 0} : {run: made(part, ring), reversed: false});
			};
			if (first < 0) {
				piece(edges, true);
			} else {
				let part: number[] = [];
				for (let k = 0; k < n; k++) {
					const i = ((first + k) % n) * 2;
					if (part.length && junction(edges[i])) {
						piece(part, false);
						part = [];
					}
					part.push(edges[i], edges[i + 1]);
				}
				piece(part, false);
			}
			regions[l].push(outline);
		}
	}
	return {runs, closed, regions};
}

/** A picture traced as shapes and strokes, in its pixels (y down) */
export interface Traced {
	width:		number;
	height:		number;
	shapes:		{curve: curveVertex[], fill: TracedFill}[];		// closed contours (its holes among them), which its neighbours meet exactly
	strokes:	{curve: curveVertex[], width: number}[];		// ink lines, in black: open or closed contours (a dot is an open one of two points at the same place)
}
/** A shape's paint: a colour, or a linear gradient from one colour to another */
export type TracedFill = RGB | {from: {x: number, y: number}, to: {x: number, y: number}, stops: [RGB, RGB]};

/** How far some work has got (0..1): waited on, it gives the page a moment to show it, between parts of work that keep it busy */
export type Progress = (fraction: number) => Promise<void> | void;

/** Runs of points (x, y in pairs), each closed or not, as curves which follow them, each one contour; the ends of a run which is not closed
 *  are kept */
export type FitRuns = (runs: Float32Array[], closed: boolean[]) => Promise<curveVertex[][]>;

// a contour the other way round: an open one's first point is its end now and its last its begin, and a closed one begins where it did
function reversed(c: curveVertex[], closed: boolean) {
	const n = c.length, order = closed ? [0, ...Array.from({length: n - 1}, (_, i) => n - 1 - i)] : Array.from({length: n}, (_, i) => n - 1 - i);
	return order.map((k, i) => {
		const v = c[k], on = v.flags === ON_BEGIN || v.flags === ON_END || v.flags === ON_CURVE;
		return curveVertex(v.x, v.y, i === 0 ? ON_BEGIN : i === n - 1 && !closed ? ON_END : on ? ON_CURVE : v.flags);
	});
}

/** The regions as shapes: each its outlines, which its neighbours meet exactly, with a linear gradient (or a colour, where it changes little) */
export async function gradientShapes(image: Pixels<4>, fit: GradientRegions, fitRuns: FitRuns, progress?: Progress): Promise<Traced['shapes']> {
	const {width: W, height: H} = image, {planes, scale} = fit;
	const labels = labelPixels(image, fit);
	await progress?.(0.3);
	const {runs, closed, regions} = traceEdges(labels, W, H);
	await progress?.(0.5);
	const fitted = await fitRuns(runs, closed);
	await progress?.(0.9);

	// each region's outlines as closed contours, made of the runs' curves (which its neighbours share): each run goes on from where the one
	// before it ends, and the last ends where the first begins; a hole goes the other way round from the outline it is in, as filling
	// what is wound round (not only what is crossed an odd number of times) needs
	const curves = regions.map(outlines => outlines.flatMap(outline => {
		const out: curveVertex[] = [];
		for (const {run, reversed: back} of outline) {
			const c = back ? reversed(fitted[run], closed[run]) : fitted[run];
			if (!c.length)
				continue;
			for (let i = out.length ? 1 : 0; i < c.length; i++)
				out.push(c[i].flags === ON_END ? curveVertex(c[i].x, c[i].y, ON_CURVE) : c[i]);
		}
		if (out.length > 1 && !closed[outline[0].run])
			out.pop();
		return out.length > 2 ? out : [];
	}));

	// each region's centre, where its gradient is taken from
	const middle = new Float64Array(regions.length * 3);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const l = labels[y * W + x];
			if (l >= 0) {
				middle[l * 3] += x + 0.5;
				middle[l * 3 + 1] += y + 0.5;
				middle[l * 3 + 2]++;
			}
		}

	const shapes: Traced['shapes'] = [];
	for (let l = 0; l < regions.length; l++) {
		const n = middle[l * 3 + 2];
		if (!curves[l].length || !n)
			continue;
		const b = planes.subarray(l * 9, l * 9 + 9), mx = middle[l * 3] / n, my = middle[l * 3 + 1] / n;

		// a gradient has one direction: that of the colour's steepest change (the rank-one part of its slopes), as far as the region goes;
		// what changes across it is lost, which is nothing on average when it is measured from the region's centre
		let sxx = 0, sxy = 0, syy = 0;
		for (let c = 0; c < 3; c++) {
			const gx = b[c * 3 + 1] / scale, gy = b[c * 3 + 2] / scale;
			sxx += gx * gx;
			sxy += gx * gy;
			syy += gy * gy;
		}
		const angle = Math.atan2(2 * sxy, sxx - syy) / 2, ux = Math.cos(angle), uy = Math.sin(angle);
		let lo = Infinity, hi = -Infinity;
		for (const v of curves[l]) {
			const t = (v.x - mx) * ux + (v.y - my) * uy;
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
		}
		const xs = (mx - W / 2) / scale, ys = (my - H / 2) / scale;
		const mid = [0, 1, 2].map(c => b[c * 3] + b[c * 3 + 1] * xs + b[c * 3 + 2] * ys);
		const v = [0, 1, 2].map(c => (b[c * 3 + 1] * ux + b[c * 3 + 2] * uy) / scale);		// the colour's change a pixel along (ux, uy)
		const at = (t: number) => { const [r, g, b] = [0, 1, 2].map(c => Math.max(0, Math.min(255, Math.round(mid[c] + v[c] * t)))); return {r, g, b}; };
		shapes.push({curve: curves[l], fill: Math.max(...v.map(Math.abs)) * (hi - lo) < 2 ? at(0)
			: {from: {x: mx + ux * lo, y: my + uy * lo}, to: {x: mx + ux * hi, y: my + uy * hi}, stops: [at(lo), at(hi)]}});
	}
	return shapes;
}

/** Ink lines (black on white, as inkWith makes them) as strokes: the ink thinned to lines a pixel wide, followed from end to end (or
 *  round), each as wide as the ink was along it, on average. Specks are left out, and so are spurs, which are only the thinning's. */
export async function inkStrokes(ink: Pixels<4>, fitRuns: FitRuns): Promise<Traced['strokes']> {
	const {width: W, height: H} = ink, src = ink.data as Uint8ClampedArray, N = W * H;
	const on = new Uint8Array(N);
	for (let i = 0; i < N; i++)
		on[i] = src[i * 4] < 128 && src[i * 4 + 3] >= 128 ? 1 : 0;

	// how far each inked pixel is from the nearest one without ink (in thirds of a pixel, by a 3-4 chamfer), beyond the picture being none
	const dist = new Int32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (on[i])
				dist[i] = Math.min(x > 0 ? dist[i - 1] + 3 : 3, y > 0 ? dist[i - W] + 3 : 3, x > 0 && y > 0 ? dist[i - W - 1] + 4 : 4, x < W - 1 && y > 0 ? dist[i - W + 1] + 4 : 4);
		}
	for (let y = H; y--;)
		for (let x = W; x--;) {
			const i = y * W + x;
			if (on[i])
				dist[i] = Math.min(dist[i], x < W - 1 ? dist[i + 1] + 3 : 3, y < H - 1 ? dist[i + W] + 3 : 3, x < W - 1 && y < H - 1 ? dist[i + W + 1] + 4 : 4, x > 0 && y < H - 1 ? dist[i + W - 1] + 4 : 4);
		}

	// the neighbours of a pixel, round from the east: E, NE, N, NW, W, SW, S, SE (none beyond the picture)
	const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, -1, -1, -1, 0, 1, 1, 1];
	const ring = (sk: Uint8Array, i: number, p: Uint8Array) => {
		const x = i % W, y = (i - x) / W;
		for (let k = 0; k < 8; k++) {
			const nx = x + DX[k], ny = y + DY[k];
			p[k] = nx >= 0 && ny >= 0 && nx < W && ny < H ? sk[ny * W + nx] : 0;
		}
		return p;
	};
	const p = new Uint8Array(8);

	// thinned (Zhang and Suen), each pass taking what is on the outside of the lines, from the south-east and then the north-west
	const sk = on.slice();
	let live = Int32Array.from({length: N}, (_, i) => i).filter(i => on[i]);
	for (let changed = true; changed;) {
		changed = false;
		for (const step of [0, 1]) {
			const gone: number[] = [];
			for (const i of live) {
				if (!sk[i])
					continue;
				ring(sk, i, p);
				const [E, , Nn, , Ww, , S] = p;
				let count = 0, rises = 0;
				for (let k = 0; k < 8; k++) {
					count += p[k];
					// (the zero-to-one changes, going round from the north)
					if (!p[(k + 2) & 7] && p[(k + 1) & 7])
						rises++;
				}
				if (count >= 2 && count <= 6 && rises === 1 && (step ? !(Nn && E && Ww) && !(Nn && S && Ww) : !(Nn && E && S) && !(E && S && Ww)))
					gone.push(i);
			}
			for (const i of gone)
				sk[i] = 0;
			changed ||= gone.length > 0;
		}
		live = live.filter(i => sk[i]);
	}
	// and its staircases taken down to single steps: a pixel at the corner of one is let go where that leaves its neighbours joined
	for (const i of live) {
		ring(sk, i, p);
		const [E, , Nn, , Ww, , S] = p;
		if (!((Nn && E) || (E && S) || (S && Ww) || (Ww && Nn)))
			continue;
		let joins = 0;
		for (let k = 0; k < 8; k += 2)
			joins += +!p[k] - +(!p[k] && !p[k + 1] && !p[(k + 2) & 7]);
		if (joins === 1)
			sk[i] = 0;
	}
	live = live.filter(i => sk[i]);

	// followed: from each end or junction (a pixel with other than two neighbours) to the next, and then round what is left, which are loops
	const neighbours = new Uint8Array(N);
	for (const i of live)
		neighbours[i] = ring(sk, i, p).reduce((a, b) => a + b, 0);
	const node = (i: number) => neighbours[i] !== 2;
	const seen = new Uint8Array(N), chains: {pixels: number[], closed: boolean}[] = [];
	const next = (i: number, not: number) => {
		const x = i % W, y = (i - x) / W;
		for (let k = 0; k < 8; k++) {
			const nx = x + DX[k], ny = y + DY[k], j = ny * W + nx;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && sk[j] && j !== not && !(seen[j] && !node(j)))
				return j;
		}
		return -1;
	};
	const follow = (from: number, first: number) => {
		const pixels = [from];
		let prev = from, at = first;
		while (at >= 0) {
			pixels.push(at);
			if (node(at) || at === from)
				break;
			seen[at] = 1;
			const n = next(at, prev);
			prev = at;
			at = n;
		}
		return pixels;
	};
	const dots: number[] = [];
	for (const i of live) {
		if (!node(i))
			continue;
		if (!neighbours[i])
			dots.push(i);
		const x = i % W, y = (i - x) / W;
		for (let k = 0; k < 8; k++) {
			const nx = x + DX[k], ny = y + DY[k], j = ny * W + nx;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && sk[j] && !node(j) && !seen[j])
				chains.push({pixels: follow(i, j), closed: false});
		}
	}
	for (const i of live)
		if (!seen[i] && !node(i)) {
			const pixels = follow(i, next(i, -1));
			seen[i] = 1;
			pixels.pop();		// (which is where it began)
			chains.push({pixels, closed: true});
		}

	// how wide the ink is at a pixel of its middle
	const width = (i: number) => Math.max(1, 2 * dist[i] / 3 - 1);
	const kept = chains.filter(({pixels, closed}) => {
		const ends = closed ? 0 : (neighbours[pixels[0]] === 1 ? 1 : 0) + (neighbours[pixels[pixels.length - 1]] === 1 ? 1 : 0);
		const w = pixels.reduce((a, i) => a + width(i), 0) / pixels.length;
		return pixels.length >= 3 && !(ends === 1 && pixels.length < 2 * w + 3);
	});

	// the pixels' centres, smoothed a little along the line (its ends kept), to be fitted with curves
	const runs = kept.map(({pixels, closed}) => {
		let pts = pixels.flatMap(i => [i % W + 0.5, Math.trunc(i / W) + 0.5]);
		const n = pixels.length;
		for (let pass = 0; pass < 2; pass++) {
			const was = pts;
			pts = was.slice();
			for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) {
				const a = (k + n - 1) % n, b = (k + 1) % n;
				pts[k * 2] = (was[a * 2] + 2 * was[k * 2] + was[b * 2]) / 4;
				pts[k * 2 + 1] = (was[a * 2 + 1] + 2 * was[k * 2 + 1] + was[b * 2 + 1]) / 4;
			}
		}
		return Float32Array.from(pts);
	});
	const fitted = await fitRuns(runs, kept.map(c => c.closed));

	const strokes: Traced['strokes'] = kept.map(({pixels}, r) => ({curve: fitted[r], width: Math.round(2 * pixels.reduce((a, i) => a + width(i), 0) / pixels.length) / 2}));
	// (a dot is kept where it is wider than a speck)
	for (const i of dots) {
		const x = i % W + 0.5, y = Math.trunc(i / W) + 0.5;
		if (width(i) >= 2)
			strokes.push({curve: [curveVertex(x, y, ON_BEGIN), curveVertex(x, y, ON_END)], width: Math.round(width(i) * 2) / 2});
	}
	return strokes.filter(s => s.curve.length);
}

/** The picture traced: `shapes`, its regions of smooth colour with gradients, within `tolerance` levels, and `lines`, its ink lines at
 *  `contrast`, as strokes over them; nothing where there is no GPU (which does the smoothing and the ink). */
export async function traceWith(image: Pixels<4>, fitRuns: FitRuns,
	shapes?: {run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, tolerance: number},
	lines?: {run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, contrast: number},
	progress?: Progress
): Promise<Traced | undefined> {
	const traced: Traced = {width: image.width, height: image.height, shapes: [], strokes: []};
	// (the shapes are most of the work, where there are both)
	const split = !shapes ? 0 : !lines ? 1 : 0.85, part = (from: number, to: number): Progress => f => progress?.(from + (to - from) * f);
	if (shapes) {
		const smooth = smoothedWith(shapes.run, image);
		if (!smooth)
			return;
		await progress?.(split * 0.05);
		const fit = fitGradients(smooth, shapes.tolerance);
		await progress?.(split * 0.4);
		traced.shapes = await gradientShapes(smooth, fit, fitRuns, part(split * 0.4, split));
	}
	if (lines) {
		const ink = inkWith(lines.run, image, lines.contrast);
		if (!ink)
			return;
		await progress?.(split + (1 - split) * 0.2);
		traced.strokes = await inkStrokes(ink, fitRuns);
	}
	await progress?.(1);
	return traced;
}

//-----------------------------------------------------------------------------
// ink lines
//-----------------------------------------------------------------------------

/** The picture as ink lines on white (the picture's transparency kept), by ink.frag: a pixel is as dark as it is darker than what is round it,
 *  by more than `contrast` levels of 255, at the scale of `sigma` pixels (the lines are about that wide). Nothing where there is no GPU. */
export function inkWith(run: (image: Pixels<4>, passes: ShadePass[], reach: number) => Pixels<4> | undefined, image: Pixels<4>, contrast: number, sigma = 1.4): Pixels<4> | undefined {
	const radius = Math.min(32, Math.ceil(3 * 1.6 * sigma)), using = {u_radius: radius, u_sigma: sigma, u_contrast: contrast / 255};
	const pass = (u_mode: number, grow: number, float = true): ShadePass => ({uniforms: {u_mode, ...using}, float, grow: [grow, grow]});
	return run(image, [pass(0, radius), pass(1, 0), pass(2, 0, false)], radius);
}
