#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 v_world;
flat in mat3 v_hullInverse;	// world -> unit cube of the bounding hull (see volume.vert)
uniform sampler3D	u_texture;
uniform float		u_size;
uniform float		u_opacity;
uniform vec3		u_origin;
uniform vec3		u_light;		// direction towards the light
uniform float		u_flatten;
out vec4 fragColor;

// Each voxel is a sphere. Unfolding (u_flatten 0 -> 1) moves each z slice as a rigid slab of spheres:
// slice k, centred at z_k = (2k + 1 - size) / size, is translated by z_k * (0, flatten * size, -flatten)
// (see volume.vert), ending up stacked in y, 2 units apart, on the z=0 plane - the atlas layout of volume2d.frag.
// Rays are traced through the sphere lattice exactly by walking its grid: every voxel the ray crosses gets one ray/sphere test.
// Voxel units are used throughout the walks: the sphere in voxel v has centre v + 0.5 and radius 0.5, and distances along the ray are in voxels.

vec2 intersectBox(vec3 ro, vec3 rd) {
	vec3 t0		= (vec3(-1) - ro) / rd;
	vec3 t1		= (vec3( 1) - ro) / rd;
	vec3 tmin	= min(t0, t1);
	vec3 tmax	= max(t0, t1);
	return vec2(
		max(max(tmin.x, tmin.y), tmin.z),
		min(min(tmax.x, tmax.y), tmax.z)
	);
}

// Composites a sphere the ray passes through into accum, shaded on the surface facing the viewer.
// voxelLocal is a point on the ray inside the sphere, relative to its centre; voxel the sphere's voxel coordinates.
void shade(inout vec4 accum, vec3 voxelLocal, vec3 rd, vec3 voxel) {
	float b		= dot(voxelLocal, rd);
	float h		= sqrt(max(b * b - dot(voxelLocal, voxelLocal) + 0.5 * 0.5, 0.0));

	vec3 normal		= (voxelLocal + (-b - h) * rd) * 2.0;			// entry point on the sphere
	float diffuse	= max(dot(normal, u_light), 0.0);
	vec3 halfDir	= normalize(u_light - rd);						// -rd points towards the viewer
	float specular	= pow(max(dot(normal, halfDir), 0.0), 64.0);

	vec4 samp	= textureLod(u_texture, (voxel + 0.5) / u_size, 0.0);
	vec3 colour	= mix(samp.rgb * diffuse + specular, samp.rgb, u_flatten);	// flat and unlit when unfolded, like the 2D view
	// alpha is for a ray through the diameter (1 voxel); a shorter chord through the sphere is proportionally more transparent
	float alpha = 1.0 - pow(max(1.0 - samp.a * u_opacity, 0.0), max(2.0 * h, 1e-4));
	accum.rgb	+= (1.0 - accum.a) * colour * alpha;
	accum.a		+= (1.0 - accum.a) * alpha;
}

void main() {
	float size		= u_size;
	float unfold	= u_flatten;
	float radius	= 1.0 / size;						// sphere radius
	int isize		= int(size);

	// trace within the bounding hull of the unfolded slices; it is an affine image of the cube, so t is the same along the world ray
	vec3 rd			= normalize(v_world - u_origin);
	vec2 bounds		= intersectBox(v_hullInverse * u_origin, v_hullInverse * rd);
	bounds.x		= max(bounds.x, 0.0);
	if (bounds.x > bounds.y)
		discard;

	vec3 ray0		= u_origin + rd * bounds.x;
	vec4 accum		= vec4(0.0);

	vec3 sgn		= mix(vec3(-1.0), vec3(1.0), greaterThanEqual(rd, vec3(0.0)));
	vec3 rdSafe		= sgn * max(abs(rd), 1e-7);
	vec3 tDelta		= 1.0 / abs(rdSafe);				// ray distance to cross a voxel along each axis
	ivec3 stp		= ivec3(sgn);

	if (unfold <= 0.0) {
		// Not unfolded: one lattice; walk its voxels (Amanatides & Woo) front to back.
		vec3 origin		= (ray0 * 0.5 + 0.5) * size;
		ivec3 voxel		= ivec3(clamp(floor(origin), 0.0, size - 1.0));
		vec3 tMax		= (vec3(voxel) + step(0.0, sgn) - origin) * sgn * tDelta;	// ray distance to the next voxel boundary on each axis

		for (int i = 0; i < 1024; ++i) {
			if (accum.a >= 0.95)
				break;

			vec3 q		= origin - (vec3(voxel) + 0.5);
			float b		= dot(q, rd);
			float disc	= b * b - dot(q, q) + 0.5 * 0.5;
			if (disc >= 0.0 && -b + sqrt(disc) > 0.0)
				shade(accum, q + rd * max(-b, 0.0), rd, vec3(voxel));	// a point inside the sphere on the ray

			if (tMax.x < tMax.y && tMax.x < tMax.z) {
				voxel.x += stp.x;
				tMax.x	+= tDelta.x;
				if (voxel.x < 0 || voxel.x >= isize)
					break;
			} else if (tMax.y < tMax.z) {
				voxel.y += stp.y;
				tMax.y	+= tDelta.y;
				if (voxel.y < 0 || voxel.y >= isize)
					break;
			} else {
				voxel.z += stp.z;
				tMax.z	+= tDelta.z;
				if (voxel.z < 0 || voxel.z >= isize)
					break;
			}
		}

	} else {
		// Unfolded: each slice is its own one voxel thick lattice, translated rigidly, so walk the slices the ray crosses
		// and, in each, the voxels of the layer. Slices are taken in order of depth along the ray; where they overlap
		// this is only approximately front to back (which matters only for translucent voxels, within a voxel).

		// range of slices which could be touched by the ray, by z extent and by y extent
		float squash	= 1.0 / max(1.0 - unfold, 1e-4);	// slice z spacing is (1 - unfold) times normal
		float stretch	= 1.0 / max(unfold, 1e-6);			// slice y spacing is unfold * size times normal
		vec3 ray1		= u_origin + rd * bounds.y;
		vec2 yRange		= vec2(min(ray0.y, ray1.y), max(ray0.y, ray1.y));
		vec2 zRange		= vec2(min(ray0.z, ray1.z), max(ray0.z, ray1.z));
		vec2 kz			= (size * (zRange + vec2(-radius, radius)) * squash + (size - 1.0)) * 0.5;
		vec2 ky			= ((yRange + vec2(-(1.0 + radius), 1.0 + radius)) * stretch + (size - 1.0)) * 0.5;
		float kLo		= ceil(max(max(kz.x, ky.x), 0.0) - 0.001);
		float kHi		= floor(min(min(kz.y, ky.y), size - 1.0) + 0.001);
		float count		= kHi - kLo + 1.0;

		// slice centres advance by (0, 2 * unfold, 2 * (1 - unfold) / size) per slice
		bool ascending	= 2.0 * unfold * rd.y + 2.0 * (1.0 - unfold) / size * rd.z > 0.0;
		float chord		= (bounds.y - bounds.x) * size * 0.5;	// in voxels

		for (int n = 0; n < 1024; ++n) {
			if (float(n) >= count || accum.a >= 0.95)
				break;

			float k		= ascending ? kLo + float(n) : kHi - float(n);
			float zk	= (2.0 * k + 1.0 - size) / size;
			vec3 origin	= ((ray0 - zk * vec3(0.0, unfold * size, -unfold)) * 0.5 + 0.5) * size;	// ray start in the slice's voxel space

			// the part of the ray inside the slice's layer of voxels
			vec3 tA		= (vec3(0.0, 0.0, k) - origin) / rdSafe;
			vec3 tB		= (vec3(size, size, k + 1.0) - origin) / rdSafe;
			vec3 tMin	= min(tA, tB);
			vec3 tMaxB	= max(tA, tB);
			float s0	= max(max(max(tMin.x, tMin.y), tMin.z), 0.0);
			float s1	= min(min(min(tMaxB.x, tMaxB.y), tMaxB.z), chord);
			if (s0 >= s1)
				continue;

			// walk that part in x and y (Amanatides & Woo in 2D)
			vec3 p		= origin + rd * s0;
			ivec2 cell	= ivec2(clamp(floor(p.xy), 0.0, size - 1.0));
			vec2 tMax	= s0 + (vec2(cell) + step(0.0, sgn.xy) - p.xy) * sgn.xy * tDelta.xy;
			float sCur	= s0;

			for (int i = 0; i < 1024; ++i) {
				if (accum.a >= 0.95 || sCur >= s1)
					break;

				vec3 q		= origin - vec3(vec2(cell) + 0.5, k + 0.5);
				float b		= dot(q, rd);
				float disc	= b * b - dot(q, q) + 0.5 * 0.5;
				if (disc >= 0.0 && -b + sqrt(disc) > 0.0)
					shade(accum, q + rd * max(-b, 0.0), rd, vec3(vec2(cell), k));

				if (tMax.x < tMax.y) {
					sCur	= tMax.x;
					tMax.x	+= tDelta.x;
					cell.x	+= stp.x;
					if (cell.x < 0 || cell.x >= isize)
						break;
				} else {
					sCur	= tMax.y;
					tMax.y	+= tDelta.y;
					cell.y	+= stp.y;
					if (cell.y < 0 || cell.y >= isize)
						break;
				}
			}
		}
	}

	fragColor = accum;
}
