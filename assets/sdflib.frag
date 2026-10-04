// The functions the generated code measures its primitives with, spliced into the raymarcher at the //@lib marker.

// A regular n-gon of circumradius r, laid out as OpenSCAD lays one out: primitives.cc's generate_circle puts its
// first vertex at angle 0, so there is a vertex on +x and the edges are centred half a sector further round. Folded
// into one sector, the distance is to that sector's edge plane, which for a convex polygon is the signed distance
// outside it. This is what a cylinder with $fn is drawn as. It is defined before the splice below because the
// generated model calls it.
float sdNgon(vec2 p, float r, float n) {
	float sector	= 3.14159265358979 / n;
	float angle		= atan(p.x, p.y) - (1.5707963267948966 - sector);
	float fold		= angle - 2.0 * sector * floor(angle / (2.0 * sector) + 0.5);
	return length(p) * cos(fold) - r * cos(sector);
}

// The signed distance in 2-D from q to the triangle abc: positive outside, negative inside, for vertices wound
// anticlockwise in the face's own frame. A face of a polyhedron is measured with this rather than by its plane, which
// is what makes a polyhedron grown by a ball come out round at its edges and corners. Defined before the splice below
// because the generated model calls it.
float sdTri2(vec2 q, vec2 a, vec2 b, vec2 c) {
	vec2	e0 = b - a, e1 = c - b, e2 = a - c;
	vec2	w0 = q - a, w1 = q - b, w2 = q - c;
	float	d0 = dot(w0, e0) / dot(e0, e0), d1 = dot(w1, e1) / dot(e1, e1), d2 = dot(w2, e2) / dot(e2, e2);
	float	s0 = e0.x * w0.y - e0.y * w0.x;
	float	s1 = e1.x * w1.y - e1.y * w1.x;
	float	s2 = e2.x * w2.y - e2.y * w2.x;
	vec2	c0 = w0 - clamp(d0, 0.0, 1.0) * e0;
	vec2	c1 = w1 - clamp(d1, 0.0, 1.0) * e1;
	vec2	c2 = w2 - clamp(d2, 0.0, 1.0) * e2;
	float	d = sqrt(min(min(dot(c0, c0), dot(c1, c1)), dot(c2, c2)));
	return (s0 < 0.0 || s1 < 0.0 || s2 < 0.0) ? d : -d;
}

// The exact distance to a smooth taper (cylinder(r1, r2) with r1 != r2, z-up, spanning z0 to z1): Inigo Quilez's
// capped-cone construction, adapted from its canonical form (the axis along y, centred on the origin) by recentring
// p.z on the cone's own mid-height and using half of z1 - z0 in place of its h. It handles r1 or r2 being 0 (a
// point) as a special case of the same formula rather than needing one of its own. Kept in step by hand with
// coneDistance in sdf.ts, since nothing generates either from the other.
float sdCone(vec3 p, float z0, float z1, float r1, float r2) {
	float hy = (z1 - z0) * 0.5;
	vec2 q = vec2(length(p.xy), p.z - (z0 + z1) * 0.5);
	vec2 k1 = vec2(r2, hy);
	vec2 k2 = vec2(r2 - r1, 2.0 * hy);
	vec2 ca = vec2(q.x - min(q.x, q.y < 0.0 ? r1 : r2), abs(q.y) - hy);
	vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
	float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
	return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

// The exact distance to the hull of two balls of different radii, a.k.a. a "round cone": Inigo Quilez's construction,
// with a spherical cap at each end and a smoothly tangent conical collar between them -- what a mixed hull() (see
// weightedHull3 in sdf.ts) needs along an edge between two points of any radii, including zero for a sharp corner.
// Degenerates to a plain capsule at r1 = r2. Guarded for two further degenerate inputs: coincident centres (a = b,
// where whichever radius is bigger is the whole answer), and a radius difference bigger than the distance between
// the centres (the smaller ball is entirely in the bigger one's shadow along the axis, so again the bigger ball
// alone is the answer). Kept in step by hand with roundConeDistance in sdf.ts, since nothing generates either from
// the other.
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
	vec3 ba = b - a;
	float l2 = dot(ba, ba);
	if (l2 < 1e-18)
		return length(p - a) - max(r1, r2);
	float rr = r1 - r2;
	float a2 = l2 - rr * rr;
	if (a2 <= 0.0)
		return r1 >= r2 ? length(p - a) - r1 : length(p - b) - r2;
	float il2 = 1.0 / l2;
	vec3 pa = p - a;
	float y = dot(pa, ba);
	float z = y - l2;
	vec3 w = pa * l2 - ba * y;
	float x2 = dot(w, w);
	float y2 = y * y * l2;
	float z2 = z * z * l2;
	float k = sign(rr) * rr * rr * x2;
	if (sign(z) * a2 * z2 > k)
		return sqrt(x2 + z2) * il2 - r2;
	if (sign(y) * a2 * y2 < k)
		return sqrt(x2 + y2) * il2 - r1;
	return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// Unsigned distance from p to the quadratic Bezier through a, control point c, and b: the exact nearest point,
// found by solving for the zero of the derivative of |B(t)-p|^2 (a cubic in t) via Cardano's method -- one or three
// real roots, each clamped to [0,1] since the curve is only defined on that range. Used for text()'s glyph
// outlines, built from the font's own quadratic curves rather than a flattened polygon, so a letterform stays exact
// at any zoom instead of faceted at whatever segment count it was tessellated to. Kept in step by hand with
// bezierDistance2 in sdf.ts, since nothing generates either from the other.
float sdBezier2(vec2 p, vec2 a, vec2 c, vec2 b) {
	vec2 A = c - a;
	vec2 B = a - 2.0 * c + b;
	vec2 C = A * 2.0;
	vec2 D = a - p;
	float bb = dot(B, B);
	if (bb < 1e-9) {
		// the control point is the midpoint of a and b: not really a curve, just the line from a to b
		vec2 e = b - a, w = p - a;
		float t = clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
		vec2 cc = w - t * e;
		return length(cc);
	}
	float kk = 1.0 / bb;
	float kx = kk * dot(A, B);
	float ky = kk * (2.0 * dot(A, A) + dot(D, B)) / 3.0;
	float kz = kk * dot(D, A);
	float p1 = ky - kx * kx;
	float p3 = p1 * p1 * p1;
	float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
	float h = q * q + 4.0 * p3;
	float res;
	if (h >= 0.0) {
		h = sqrt(h);
		vec2 x = (vec2(h, -h) - q) / 2.0;
		vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
		float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
		vec2 qq = D + (C + B * t) * t;
		res = dot(qq, qq);
	} else {
		float z = sqrt(-p1);
		float v = acos(q / (p1 * z * 2.0)) / 3.0;
		float m = cos(v), n = sin(v) * 1.7320508075688772;
		vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
		vec2 qx = D + (C + B * t.x) * t.x;
		vec2 qy = D + (C + B * t.y) * t.y;
		vec2 qz = D + (C + B * t.z) * t.z;
		res = min(dot(qx, qx), min(dot(qy, qy), dot(qz, qz)));
	}
	return sqrt(res);
}

// The even-odd crossing multiplier a quadratic Bezier (a, c, b) contributes to a horizontal ray cast from p towards
// +x -- the curved generalisation of the straight-edge crossing test text()'s glyph shapes also use for their line
// segments (see evaluate.ts's emit() for 'curvepath2'). A curve need not be monotonic in y the way a straight edge
// always is, so it can cross the ray 0, 1 or 2 times within one segment; each root of y(t) = p.y counts only where
// the crossing is transversal (y'(t) != 0 there -- a tangency touches the ray without crossing it), and only for t
// in [0, 1), the same half-open convention the straight-edge test uses so a curve shares no double-count with the
// segment before it at their shared point.
float bezierCrossing2(vec2 p, vec2 a, vec2 c, vec2 b) {
	float A = a.y - 2.0 * c.y + b.y;
	float B = 2.0 * (c.y - a.y);
	float C = a.y - p.y;
	float mult = 1.0;
	if (abs(A) < 1e-12) {
		if (abs(B) > 1e-12) {
			float t = -C / B;
			if (t >= 0.0 && t < 1.0) {
				float x = (1.0 - t) * (1.0 - t) * a.x + 2.0 * (1.0 - t) * t * c.x + t * t * b.x;
				if (x > p.x) mult = -mult;
			}
		}
	} else {
		float disc = B * B - 4.0 * A * C;
		if (disc >= 0.0) {
			float sq = sqrt(disc);
			float t1 = (-B - sq) / (2.0 * A);
			float t2 = (-B + sq) / (2.0 * A);
			if (t1 >= 0.0 && t1 < 1.0 && abs(2.0 * A * t1 + B) > 1e-12) {
				float x = (1.0 - t1) * (1.0 - t1) * a.x + 2.0 * (1.0 - t1) * t1 * c.x + t1 * t1 * b.x;
				if (x > p.x) mult = -mult;
			}
			if (t2 >= 0.0 && t2 < 1.0 && abs(2.0 * A * t2 + B) > 1e-12) {
				float x = (1.0 - t2) * (1.0 - t2) * a.x + 2.0 * (1.0 - t2) * t2 * c.x + t2 * t2 * b.x;
				if (x > p.x) mult = -mult;
			}
		}
	}
	return mult;
}

// A big union of simple shapes, walked as data rather than emitted as code (batchUnion / emitBatch in sdf.ts, which
// says how the texture is laid out). The hierarchy is walked nearest box first with an explicit stack, and whatever
// cannot beat the best found so far is skipped -- except a box that holds the point, which is always asked, since
// inside a shape the field goes negative and inside a union it is the deepest that counts. The earlier leaf wins a tie,
// as opUnion does.
uniform highp sampler2D u_batch;

vec4 batchTexel(int i) {
	return texelFetch(u_batch, ivec2(i & 1023, i >> 10), 0);
}

// A heightmap's field (surface(): heightmap() and heightmapDistance() in sdf.ts, which say why it is this bound and
// which this must agree with). Its heights start at texel `heights`, four to a texel, and its tiles at `tiles`, two
// floats each: the highest point near the tile, and 1 / sqrt(1 + L^2) for the steepest slope near it.
float heightmapValue(int base, int k) {
	vec4 t = batchTexel(base + (k >> 2));
	int c = k & 3;
	return c == 0 ? t.x : c == 1 ? t.y : c == 2 ? t.z : t.w;
}

float sdHeightmap(vec3 p, int heights, int tiles, int cols, int rows, int tile, int tilesX, int tilesY, float bottom, float top) {
	float W = float(cols - 1), H = float(rows - 1);
	vec3 q = abs(p - vec3(W * 0.5, H * 0.5, (bottom + top) * 0.5)) - vec3(W * 0.5, H * 0.5, (top - bottom) * 0.5);
	float box = length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);

	vec2 c = clamp(p.xy, vec2(0.0), vec2(W, H));
	int ci = min(int(floor(c.x)), cols - 2), cj = min(int(floor(c.y)), rows - 2);
	float du = c.x - float(ci) - 0.5, dv = c.y - float(cj) - 0.5;
	int k = cj * cols + ci;
	float v1 = heightmapValue(heights, k), v2 = heightmapValue(heights, k + 1);
	float v3 = heightmapValue(heights, k + cols), v4 = heightmapValue(heights, k + cols + 1);
	float m = (v1 + v2 + v3 + v4) * 0.25, h;
	if (dv <= -abs(du))
		h = m + (v2 - v1) * du + 2.0 * (m - (v1 + v2) * 0.5) * dv;
	else if (dv >= abs(du))
		h = m + (v4 - v3) * du + 2.0 * ((v3 + v4) * 0.5 - m) * dv;
	else if (du < 0.0)
		h = m + (v3 - v1) * dv + 2.0 * (m - (v1 + v3) * 0.5) * du;
	else
		h = m + (v4 - v2) * dv + 2.0 * ((v2 + v4) * 0.5 - m) * du;

	int tx = min(ci / tile, tilesX - 1), ty = min(cj / tile, tilesY - 1);
	float edge = 1e20;
	if (tx - 1 > 0)			edge = min(edge, p.x - float((tx - 1) * tile));
	if (tx + 1 < tilesX - 1)	edge = min(edge, float((tx + 2) * tile) - p.x);
	if (ty - 1 > 0)			edge = min(edge, p.y - float((ty - 1) * tile));
	if (ty + 1 < tilesY - 1)	edge = min(edge, float((ty + 2) * tile) - p.y);
	int t = ty * tilesX + tx;
	float nearTop = heightmapValue(tiles, 2 * t), nearSlope = heightmapValue(tiles, 2 * t + 1);
	float gap = p.z - h;
	float terrain = gap > 0.0
		? min(max(gap * nearSlope, p.z - nearTop), edge)
		: -min(-gap * nearSlope, edge);
	return max(box, terrain);
}

// A triangle mesh's signed distance (meshfield.ts, which lays out the data and must agree with this): the nearest
// triangle by the hierarchy at `nodes`, signed by the pseudonormal of its nearest part. A triangle is ten texels from
// `tris`: a, b, c, the face normal, the edges' pseudonormals (ab, bc, ca) and the corners' (a, b, c).
float meshBoxDist2(vec3 p, int node, int nodes) {
	vec3 d = max(max(batchTexel(nodes + 2 * node).xyz - p, p - batchTexel(nodes + 2 * node + 1).xyz), vec3(0.0));
	return dot(d, d);
}

// the nearest point of the triangle at texel t to p, and which part of it: its pseudonormal's texel offset
vec3 meshNearest(vec3 p, int t, out int part) {
	vec3 a = batchTexel(t).xyz, b = batchTexel(t + 1).xyz, c = batchTexel(t + 2).xyz;
	vec3 ab = b - a, ac = c - a, ap = p - a;
	float d1 = dot(ab, ap), d2 = dot(ac, ap);
	if (d1 <= 0.0 && d2 <= 0.0) { part = 7; return a; }
	vec3 bp = p - b;
	float d3 = dot(ab, bp), d4 = dot(ac, bp);
	if (d3 >= 0.0 && d4 <= d3) { part = 8; return b; }
	float vc = d1 * d4 - d3 * d2;
	if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) { part = 4; return a + ab * (d1 / (d1 - d3)); }
	vec3 cp = p - c;
	float d5 = dot(ab, cp), d6 = dot(ac, cp);
	if (d6 >= 0.0 && d5 <= d6) { part = 9; return c; }
	float vb = d5 * d2 - d1 * d6;
	if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) { part = 6; return a + ac * (d2 / (d2 - d6)); }
	float va = d3 * d6 - d5 * d4;
	if (va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) { part = 5; return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); }
	float den = 1.0 / (va + vb + vc);
	part = 3;
	return a + ab * (vb * den) + ac * (vc * den);
}

float sdMesh(vec3 p, int nodes, int tris) {
	float best = 1e30, sgn = 1.0;
	int stackNode[32];
	float stackGap[32];
	stackNode[0] = 0;
	stackGap[0] = 0.0;
	int sp = 1;
	for (int it = 0; it < 8192; it++) {
		if (sp == 0)
			break;
		sp--;
		if (stackGap[sp] > 0.0 && stackGap[sp] >= best)
			continue;
		int n = stackNode[sp];
		vec4 lo = batchTexel(nodes + 2 * n), hi = batchTexel(nodes + 2 * n + 1);
		if (lo.w < 0.0) {
			int first = int(-lo.w + 0.5) - 1, count = int(hi.w + 0.5);
			for (int k = 0; k < 4; k++) {
				if (k >= count)
					break;
				int t = tris + (first + k) * 10, part;
				vec3 d = p - meshNearest(p, t, part);
				float d2 = dot(d, d);
				if (d2 < best) {
					best = d2;
					sgn = dot(d, batchTexel(t + part).xyz) < 0.0 ? -1.0 : 1.0;
				}
			}
		} else {
			int l = int(lo.w + 0.5), r = int(hi.w + 0.5);
			float gl = meshBoxDist2(p, l, nodes), gr = meshBoxDist2(p, r, nodes);
			// the farther child goes on first so that the nearer is taken off first
			if (gl < gr) {
				stackNode[sp] = r; stackGap[sp] = gr; sp++;
				stackNode[sp] = l; stackGap[sp] = gl; sp++;
			} else {
				stackNode[sp] = l; stackGap[sp] = gl; sp++;
				stackNode[sp] = r; stackGap[sp] = gr; sp++;
			}
		}
	}
	return sgn * sqrt(best);
}

float batchBoxDist(vec3 p, vec3 lo, vec3 hi) {
	return length(max(max(lo - p, p - hi), vec3(0.0)));
}

// The signed distance in the plane to a closed path of lines and quadratic Beziers whose n segments start at texel
// `at`, two texels each: (start, end) and (control, kind), kind 0 a line and 1 a curve. This is what curvepath2 and
// polygon2 emit as unrolled code, with the segments read from the texture instead, so a glyph costs no more shader
// than a circle. The sign is the even-odd parity of the crossings of every segment together, as it is there.
float batchPath(vec2 p, int at, int n) {
	float d2 = 1e30, s = 1.0;
	for (int i = 0; i < n; i++) {
		vec4 ab = batchTexel(at + 2 * i), cq = batchTexel(at + 2 * i + 1);
		vec2 a = ab.xy, b = ab.zw;
		if (cq.z < 0.5) {
			vec2 e = b - a, w = p - a;
			vec2 c = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
			d2 = min(d2, dot(c, c));
			float c0 = p.y >= a.y ? 1.0 : 0.0, c1 = p.y < b.y ? 1.0 : 0.0, c2 = e.x * w.y > e.y * w.x ? 1.0 : 0.0;
			if (c0 * c1 * c2 > 0.5 || (1.0 - c0) * (1.0 - c1) * (1.0 - c2) > 0.5)
				s = -s;
		} else {
			float dd = sdBezier2(p, a, cq.xy, b);
			d2 = min(d2, dd * dd);
			s *= bezierCrossing2(p, a, cq.xy, b);
		}
	}
	return s * sqrt(d2);
}

// The distance to the leaf whose five texels start at o, and its material and order. The shapes are the ones the
// generated code would have drawn: kind 0 a sphere, 1 a box, 2 a cylinder, 3 a square, 4 a circle, 5 a path of lines and curves.
float batchLeaf(int o, vec3 p, out float material, out float order) {
	vec4 r0 = batchTexel(o), r1 = batchTexel(o + 1), r2 = batchTexel(o + 2), r3 = batchTexel(o + 3), r4 = batchTexel(o + 4);
	vec3 q = vec3(dot(r0.xyz, p) + r0.w, dot(r1.xyz, p) + r1.w, dot(r2.xyz, p) + r2.w);
	int kind = int(r3.y + 0.5);
	vec4 a = vec4(r3.w, r4.xyz);
	float d;
	if (kind == 0) {
		d = length(q) - a.x;
	} else if (kind == 1) {
		vec3 h = a.xyz * 0.5, w = abs(q - (a.w > 0.5 ? vec3(0.0) : h)) - h;
		d = length(max(w, vec3(0.0))) + min(max(w.x, max(w.y, w.z)), 0.0);
	} else if (kind == 2) {
		d = max(length(q.xy) - a.x, a.z > 0.5 ? abs(q.z) - a.y * 0.5 : max(-q.z, q.z - a.y));
	} else if (kind == 3) {
		vec2 h = a.xy * 0.5, w = abs(q.xy - (a.z > 0.5 ? vec2(0.0) : h)) - h;
		d = length(max(w, vec2(0.0))) + min(max(w.x, w.y), 0.0);
	} else if (kind == 5) {
		d = batchPath(q.xy, int(a.x + 0.5), int(a.y + 0.5));
	} else {
		d = length(q.xy) - a.x;
	}
	material = r3.z;
	order = r4.w;
	return d * r3.x;
}

// (distance, material) of the nearest leaf of the hierarchy whose nodes start at texel `nodes` and leaves at `leaves`.
vec2 sdBatch(vec3 p, int nodes, int leaves) {
	vec2 best = vec2(1e20, 0.0);
	float bestOrder = 1e9;
	int stackNode[32];
	float stackGap[32];
	stackNode[0] = 0;
	stackGap[0] = 0.0;
	int sp = 1;
	for (int it = 0; it < 4096; it++) {
		if (sp == 0)
			break;
		sp--;
		if (stackGap[sp] > 0.0 && stackGap[sp] >= best.x)
			continue;
		int n = stackNode[sp];
		vec4 a = batchTexel(nodes + 2 * n);
		if (a.w < 0.0) {
			float material, order;
			float d = batchLeaf(leaves + 5 * (int(-a.w + 0.5) - 1), p, material, order);
			if (d < best.x || (d == best.x && order < bestOrder)) {
				best = vec2(d, material);
				bestOrder = order;
			}
		} else {
			vec4 b = batchTexel(nodes + 2 * n + 1);
			int l = int(a.w + 0.5), r = int(b.w + 0.5);
			float gl = batchBoxDist(p, batchTexel(nodes + 2 * l).xyz, batchTexel(nodes + 2 * l + 1).xyz);
			float gr = batchBoxDist(p, batchTexel(nodes + 2 * r).xyz, batchTexel(nodes + 2 * r + 1).xyz);
			// the farther child goes on first so that the nearer is taken off first
			if (gl < gr) {
				stackNode[sp] = r; stackGap[sp] = gr; sp++;
				stackNode[sp] = l; stackGap[sp] = gl; sp++;
			} else {
				stackNode[sp] = l; stackGap[sp] = gl; sp++;
				stackNode[sp] = r; stackGap[sp] = gr; sp++;
			}
		}
	}
	return best;
}
