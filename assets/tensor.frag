#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_ndc;
uniform sampler3D	u_volume;	// the values, one float per voxel (NaN is drawn as empty)
uniform float		u_range;	// the magnitude which gets the full colour
uniform vec3		u_dims;		// voxels along each axis
uniform vec3		u_half;		// half the box's size along each axis
uniform vec3		u_origin;	// camera position, in the box's space
uniform mat3		u_basis;	// camera right, up and back axes, in the box's space
uniform float		u_fovy;		// cot(half the vertical field of view)
uniform float		u_aspect;
out vec4 fragColor;

// The box is centred on the origin and its longest side is 2 long; its voxels are cuboids (cubes, unless the slices were not reduced as much as their contents).
// Voxel x, y, z run along the box's x, -y, -z, which puts row 0 at the top and slice 0 at the front of the home view.

//const vec3	WARM	= vec3(255.0, 90.0, 60.0) / 255.0;
//const vec3	COOL	= vec3(51.0, 216.0, 246.0) / 255.0;	// WARM + COOL is the same in every channel, so equal amounts of each average to grey
const vec3	WARM	= vec3(255.0, 128.0, 0.0) / 255.0;
const vec3	COOL	= vec3(0.0, 127.0, 255.0) / 255.0;	// WARM + COOL is the same in every channel, so equal amounts of each average to grey
const vec3	FACE	= vec3(0.82, 1.0, 0.68);	// shading by the axis of the face a ray enters a voxel through
const float	DENSITY	= 0.3;	// opacity of a voxel at full magnitude, for a ray crossing it: below 1, so that even the strongest voxels can be seen through
const float	SHARP	= 2.5;	// how much faster opacity falls than magnitude does: the higher, the more only the outliers show, and the more of the rest is see-through

void main() {
	vec3	half_	= u_half;
	vec3	size_	= 2.0 * half_ / u_dims;						// of a voxel
	float	unit	= pow(size_.x * size_.y * size_.z, 1.0 / 3.0);	// and its mean side
	vec3	rd		= u_basis * normalize(vec3(v_ndc.x * u_aspect / u_fovy, v_ndc.y / u_fovy, -1.0));
	vec3	sgn		= vec3(1.0, -1.0, -1.0);

	vec3	inv		= 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-20);
	vec3	t0		= (-half_ - u_origin) * inv;
	vec3	t1		= ( half_ - u_origin) * inv;
	vec3	tmin	= min(t0, t1);
	vec3	tmax	= max(t0, t1);
	float	tEnter	= max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
	float	tLeave	= min(min(tmax.x, tmax.y), tmax.z);

	if (tEnter >= tLeave)
		discard;

	// walk the voxels the ray crosses (Amanatides & Woo), in units of distance along the ray
	vec3	o		= (u_origin + rd * tEnter) * sgn / size_ + 0.5 * u_dims;
	vec3	d		= rd * sgn / size_;
	ivec3	stp		= ivec3(greaterThanEqual(d, vec3(0.0))) * 2 - 1;
	vec3	tDelta	= 1.0 / max(abs(d), 1e-20);
	ivec3	size	= ivec3(u_dims);
	ivec3	vox		= clamp(ivec3(floor(o)), ivec3(0), size - 1);
	vec3	tNext	= tEnter + (vec3(vox + stp) - o) / (d + vec3(equal(d, vec3(0.0))) * 1e-20);

	int		axis	= tmin.x >= tmin.y && tmin.x >= tmin.z ? 0 : tmin.y >= tmin.z ? 1 : 2;
	float	t		= tEnter;
	vec4	accum	= vec4(0.0);

	for (int i = 0; i < 4096; ++i) {
		float tExit = min(min(tNext.x, tNext.y), min(tNext.z, tLeave));
		float raw	= texelFetch(u_volume, vox, 0).r;
		float v		= isnan(raw) ? 0.0 : clamp(raw / u_range, -1.0, 1.0);
		float m		= abs(v);

		if (m > 0.004) {
			// opacity is for a ray crossing one voxel; a shorter chord is proportionally more transparent
			float	a	= 1.0 - pow(1.0 - DENSITY * pow(m, SHARP), max((tExit - t) / unit, 1e-4));
			vec3	rgb	= (v >= 0.0 ? WARM : COOL) * FACE[axis];
			accum	+= (1.0 - accum.a) * vec4(rgb, 1) * a;
		}

		t = tExit;
		if (accum.a >= 0.98 || t >= tLeave)
			break;

		axis		= tNext.x < tNext.y && tNext.x < tNext.z ? 0 : tNext.y < tNext.z ? 1 : 2;
		vox[axis]	+= int(stp[axis]);
		tNext[axis] += tDelta[axis];
		if (vox[axis] < 0 || vox[axis] >= size[axis])
			break;
	}

	fragColor = accum;
}
