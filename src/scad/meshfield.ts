// A polyhedron as a field (the other way from mesher.ts): an import()ed STL, OFF or OBJ, or a polyhedron() that is not
// convex, given as its triangles. Its field is the
// real signed distance: the nearest triangle, found by walking a hierarchy of boxes nearest first and skipping any box
// further than the best so far, signed by the angle-weighted pseudonormal of whichever part of that triangle is
// nearest -- its face, one of its edges or one of its corners (Baerentzen and Aanaes, 2005). For a closed mesh wound
// consistently that sign is exact wherever the point is; for one that is not, it is a guess, and reported as one.
//
// sdMesh in sdflib.frag walks the same hierarchy in the same order over the same data, so the two must agree.
import { float3 } from '@isopodlabs/maths/vector';
import type { Mesh } from '@isopodlabs/binary_meshes';

export interface TriMesh {
	k:			'trimesh';
	points:		float3[];			// the welded corners
	tris:		Uint32Array;		// three corners a triangle, in the hierarchy's leaf order
	closed:		boolean;			// every edge shared by exactly two triangles, running opposite ways in them
	min:		float3;
	max:		float3;
	// the hierarchy, two vec4s a node: (box min, left) and (box max, right), where a leaf has left = -(first + 1) and
	// right = its count of triangles, which are that run of `tris`
	nodes:		Float32Array;
	// ten vec4s a triangle: its corners a, b, c; its face normal; its edges' pseudonormals (ab, bc, ca); its corners'
	// pseudonormals (a, b, c)
	triData:	Float32Array;
}

const LEAF = 4;
export const TRI_TEXELS = 10;

// the field of a polyhedron, or undefined when no face of it has any area
export function trimesh(corners: float3[], faces: number[][]): TriMesh | undefined {
	// weld corners at the same place, since a triangle soup (an STL) repeats each at every triangle that uses it; the
	// hash only picks a bucket, the corners in it are compared exactly
	const buckets = new Map<number, number[]>(), points: float3[] = [], remap = new Int32Array(corners.length);
	corners.forEach((c, k) => {
		const hash = c.x * 0.7548776662 + c.y * 0.5698402910 + c.z * 0.3141592653;
		const bucket = buckets.get(hash);
		let i = bucket?.find(i => points[i].x === c.x && points[i].y === c.y && points[i].z === c.z);
		if (i === undefined) {
			i = points.length;
			points.push(c);
			if (bucket)
				bucket.push(i);
			else
				buckets.set(hash, [i]);
		}
		remap[k] = i;
	});
	const np = points.length, P = new Float64Array(np * 3);
	points.forEach((p, i) => P.set([p.x, p.y, p.z], i * 3));

	const tri: number[] = [];
	const add = (a: number, b: number, c: number) => {
		const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
		const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
		if (uy * vz - uz * vy || uz * vx - ux * vz || ux * vy - uy * vx)
			tri.push(a, b, c);
	};
	for (const face of faces) {
		const loop = face.filter(i => i >= 0 && i < corners.length).map(i => remap[i]);
		if (loop.length === 3)
			add(loop[0], loop[1], loop[2]);
		else
			for (const [a, b, c] of triangulate(loop, points))
				add(a, b, c);
	}
	const count = tri.length / 3;
	if (count === 0)
		return undefined;

	// wound so the normals face out, whichever way the source winds them (polyhedron() clockwise, STL anticlockwise)
	let volume = 0;
	for (let t = 0; t < tri.length; t += 3)
		volume += points[tri[t]].dot(points[tri[t + 1]].cross(points[tri[t + 2]]));
	if (volume < 0)
		for (let t = 0; t < tri.length; t += 3)
			[tri[t + 1], tri[t + 2]] = [tri[t + 2], tri[t + 1]];

	// the pseudonormals: a corner's is its triangles' normals weighted by the angle each makes there, an edge's the sum
	// of its two triangles' normals; each triangle keeps which three edges are its own
	const faceN = new Float64Array(count * 3), vertexN = new Float64Array(np * 3);
	const edgeOf = new Map<number, number>(), triEdge = new Int32Array(count * 3);
	const edgeN = new Float64Array(count * 9), uses = new Int32Array(count * 3), forward = new Int32Array(count * 3);
	let edges = 0;
	for (let t = 0; t < count; t++) {
		const i = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
		const e1 = [0, 1, 2].map(a => P[i[1] * 3 + a] - P[i[0] * 3 + a]), e2 = [0, 1, 2].map(a => P[i[2] * 3 + a] - P[i[0] * 3 + a]);
		const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
		const len = Math.hypot(n[0], n[1], n[2]);
		faceN.set(n.map(x => x / len), t * 3);
		for (let k = 0; k < 3; k++) {
			const a = i[k], b = i[(k + 1) % 3], c = i[(k + 2) % 3];
			const u = [0, 1, 2].map(x => P[b * 3 + x] - P[a * 3 + x]), v = [0, 1, 2].map(x => P[c * 3 + x] - P[a * 3 + x]);
			const angle = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2])))));
			for (let x = 0; x < 3; x++)
				vertexN[a * 3 + x] += faceN[t * 3 + x] * angle;
			const key = Math.min(a, b) * np + Math.max(a, b);
			let e = edgeOf.get(key);
			if (e === undefined)
				edgeOf.set(key, e = edges++);
			for (let x = 0; x < 3; x++)
				edgeN[e * 3 + x] += faceN[t * 3 + x];
			uses[e]++;
			forward[e] += a < b ? 1 : -1;
			triEdge[t * 3 + k] = e;
		}
	}
	let closed = true;
	for (let e = 0; e < edges; e++)
		closed &&= uses[e] === 2 && forward[e] === 0;

	// the hierarchy: split each run of triangles at the median of their centres along its widest axis
	const order = Uint32Array.from({length: count}, (_, t) => t);
	const lo = new Float64Array(count * 3), hi = new Float64Array(count * 3), mid = new Float64Array(count * 3);
	for (let t = 0; t < count; t++)
		for (let a = 0; a < 3; a++) {
			const x = P[tri[t * 3] * 3 + a], y = P[tri[t * 3 + 1] * 3 + a], z = P[tri[t * 3 + 2] * 3 + a];
			lo[t * 3 + a] = Math.min(x, y, z);
			hi[t * 3 + a] = Math.max(x, y, z);
			mid[t * 3 + a] = (lo[t * 3 + a] + hi[t * 3 + a]) / 2;
		}
	const nodes = new Float32Array(2 * count * 8);		// a leaf holds at least one triangle, so at most 2 count - 1 nodes
	let used = 0;
	const build = (first: number, n: number): number => {
		const at = used++;
		const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
		const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
		for (let k = first; k < first + n; k++) {
			const t = order[k];
			for (let a = 0; a < 3; a++) {
				bmin[a] = Math.min(bmin[a], lo[t * 3 + a]);
				bmax[a] = Math.max(bmax[a], hi[t * 3 + a]);
				cmin[a] = Math.min(cmin[a], mid[t * 3 + a]);
				cmax[a] = Math.max(cmax[a], mid[t * 3 + a]);
			}
		}
		// padded a hair, so that float32 rounding in the texture cannot put a triangle outside its box
		const pad = 1e-6 * Math.max(1, ...bmin.map(Math.abs), ...bmax.map(Math.abs));
		nodes.set([bmin[0] - pad, bmin[1] - pad, bmin[2] - pad], at * 8);
		nodes.set([bmax[0] + pad, bmax[1] + pad, bmax[2] + pad], at * 8 + 4);
		if (n <= LEAF) {
			nodes[at * 8 + 3] = -(first + 1);
			nodes[at * 8 + 7] = n;
			return at;
		}
		const axis = [0, 1, 2].reduce((best, a) => cmax[a] - cmin[a] > cmax[best] - cmin[best] ? a : best, 0);
		const half = n >> 1;
		select(order, first, first + n - 1, first + half, t => mid[t * 3 + axis]);
		nodes[at * 8 + 3] = build(first, half);
		nodes[at * 8 + 7] = build(first + half, n - half);
		return at;
	};
	build(0, count);

	const tris = new Uint32Array(count * 3), triData = new Float32Array(count * TRI_TEXELS * 4);
	for (let k = 0; k < count; k++) {
		const t = order[k], i = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
		tris.set(i, k * 3);
		const put = (slot: number, from: Float64Array, at: number) => triData.set(from.subarray(at * 3, at * 3 + 3), (k * TRI_TEXELS + slot) * 4);
		i.forEach((v, j) => {
			put(j, P, v);
			put(4 + j, edgeN, triEdge[t * 3 + j]);
			put(7 + j, vertexN, v);
		});
		put(3, faceN, t);
	}

	const box = [0, 1, 2].map(a => {
		let min = Infinity, max = -Infinity;
		for (let i = a; i < P.length; i += 3) {
			min = Math.min(min, P[i]);
			max = Math.max(max, P[i]);
		}
		return [min, max];
	});
	return {k: 'trimesh', points, tris, closed, min: float3(box[0][0], box[1][0], box[2][0]), max: float3(box[0][1], box[1][1], box[2][1]), nodes: nodes.slice(0, used * 8), triData};
}

// Reorders order[lo..hi] so the element at k is the one a sort by key would put there, with nothing after it keyed
// lower and nothing before it keyed higher (Hoare's selection): the median split, without sorting either half. Mutates order.
function select(order: Uint32Array, lo: number, hi: number, k: number, key: (t: number) => number) {
	while (hi > lo) {
		const pivot = key(order[(lo + hi) >> 1]);
		let i = lo, j = hi;
		while (i <= j) {
			while (key(order[i]) < pivot)
				i++;
			while (key(order[j]) > pivot)
				j--;
			if (i <= j) {
				[order[i], order[j]] = [order[j], order[i]];
				i++;
				j--;
			}
		}
		if (k <= j)
			hi = j;
		else if (k >= i)
			lo = i;
		else
			return;
	}
}

// A face's triangles, keeping its winding: its corners flattened onto the plane of its Newell normal and ear-clipped,
// so that a concave face (the L-shaped end of an L) is covered by its own area and not its hull's.
function triangulate(loop: number[], points: float3[]): number[][] {
	if (loop.length <= 3)
		return loop.length === 3 ? [loop] : [];
	let n = float3(0, 0, 0);
	loop.forEach((i, k) => n = n.add(points[i].cross(points[loop[(k + 1) % loop.length]])));
	// the two axes the normal is least along, ordered so the face runs anticlockwise in them
	const drop = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 'x' : Math.abs(n.y) >= Math.abs(n.z) ? 'y' : 'z';
	const [u, v] = ({x: ['y', 'z'], y: ['z', 'x'], z: ['x', 'y']} as const)[drop];
	const flip = n[drop] < 0 ? -1 : 1;
	const at = (i: number) => [points[i][u], points[i][v] * flip];
	const turn = (a: number, b: number, c: number) => {
		const [ax, ay] = at(a), [bx, by] = at(b), [cx, cy] = at(c);
		return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	};
	const within = (p: number, a: number, b: number, c: number) => turn(a, b, p) > 0 && turn(b, c, p) > 0 && turn(c, a, p) > 0;

	const left = [...loop], out: number[][] = [];
	while (left.length > 3) {
		const ear = left.findIndex((b, k) => {
			const a = left[(k + left.length - 1) % left.length], c = left[(k + 1) % left.length];
			return turn(a, b, c) > 0 && !left.some(p => p !== a && p !== b && p !== c && within(p, a, b, c));
		});
		// a face with no ear folds over itself; its first corner is taken as one, as a fan would
		const k = Math.max(ear, 0);
		out.push([left[(k + left.length - 1) % left.length], left[k], left[(k + 1) % left.length]]);
		left.splice(k, 1);
	}
	out.push(left);
	return out;
}

// The nearest point of triangle abc to p, and which part of it that is: 0 the face, 1..3 the edges ab, bc, ca, and
// 4..6 the corners a, b, c (Ericson's regions, in Real-Time Collision Detection)
function nearest(px: number, py: number, pz: number, d: Float32Array, at: number): {qx: number, qy: number, qz: number, part: number} {
	const ax = d[at], ay = d[at + 1], az = d[at + 2];
	const bx = d[at + 4], by = d[at + 5], bz = d[at + 6];
	const cx = d[at + 8], cy = d[at + 9], cz = d[at + 10];
	const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
	if (d1 <= 0 && d2 <= 0)
		return {qx: ax, qy: ay, qz: az, part: 4};
	const bpx = px - bx, bpy = py - by, bpz = pz - bz;
	const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
	if (d3 >= 0 && d4 <= d3)
		return {qx: bx, qy: by, qz: bz, part: 5};
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const v = d1 / (d1 - d3);
		return {qx: ax + abx * v, qy: ay + aby * v, qz: az + abz * v, part: 1};
	}
	const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
	const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
	if (d6 >= 0 && d5 <= d6)
		return {qx: cx, qy: cy, qz: cz, part: 6};
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const w = d2 / (d2 - d6);
		return {qx: ax + acx * w, qy: ay + acy * w, qz: az + acz * w, part: 3};
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
		return {qx: bx + (cx - bx) * w, qy: by + (cy - by) * w, qz: bz + (cz - bz) * w, part: 2};
	}
	const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
	return {qx: ax + abx * v + acx * w, qy: ay + aby * v + acy * w, qz: az + abz * v + acz * w, part: 0};
}

// which of a triangle's ten vec4s holds the pseudonormal of each part nearest() names
const PART_NORMAL = [3, 4, 5, 6, 7, 8, 9];

function boxDistance2(p: float3, n: Float32Array, at: number): number {
	const dx = Math.max(n[at] - p.x, 0, p.x - n[at + 4]);
	const dy = Math.max(n[at + 1] - p.y, 0, p.y - n[at + 5]);
	const dz = Math.max(n[at + 2] - p.z, 0, p.z - n[at + 6]);
	return dx * dx + dy * dy + dz * dz;
}

export function trimeshDistance(s: TriMesh, p: float3): number {
	const nodes = s.nodes, data = s.triData;
	let best = Infinity, sign = 1;
	const stack: {node: number, gap: number}[] = [{node: 0, gap: 0}];
	while (stack.length) {
		const {node, gap} = stack.pop()!;
		if (gap > 0 && gap >= best)
			continue;
		const left = nodes[node * 8 + 3], right = nodes[node * 8 + 7];
		if (left < 0) {
			const first = -left - 1;
			for (let k = first; k < first + right; k++) {
				const at = k * TRI_TEXELS * 4;
				const {qx, qy, qz, part} = nearest(p.x, p.y, p.z, data, at);
				const dx = p.x - qx, dy = p.y - qy, dz = p.z - qz, d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < best) {
					best = d2;
					const n = at + PART_NORMAL[part] * 4;
					sign = dx * data[n] + dy * data[n + 1] + dz * data[n + 2] < 0 ? -1 : 1;
				}
			}
		} else {
			const gl = boxDistance2(p, nodes, left * 8), gr = boxDistance2(p, nodes, right * 8);
			// the farther child goes on first so that the nearer is taken off first
			if (gl < gr)
				stack.push({node: right, gap: gr}, {node: left, gap: gl});
			else
				stack.push({node: left, gap: gl}, {node: right, gap: gr});
		}
	}
	return sign * Math.sqrt(best);
}

// the same mesh with every corner moved by f (a stretch, which the field cannot follow any other way), wound the
// other way round if f turns it inside out
export function mapTrimesh(s: TriMesh, f: (p: float3) => float3, mirrors: boolean): TriMesh | undefined {
	const faces: number[][] = [];
	for (let t = 0; t < s.tris.length; t += 3)
		faces.push(mirrors ? [s.tris[t], s.tris[t + 2], s.tris[t + 1]] : [s.tris[t], s.tris[t + 1], s.tris[t + 2]]);
	return trimesh(s.points.map(f), faces);
}
