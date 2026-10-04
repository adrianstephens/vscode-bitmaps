#version 300 es
precision highp float;
uniform vec3	u_center;	// the middle of the box the model is in
uniform vec3	u_half;		// and half its size
uniform vec3	u_origin;	// the camera, in the model's own units
uniform mat3	u_basis;	// camera right, up and back axes in the model's space
uniform float	u_fovy;		// cot of half the vertical field of view
uniform float	u_aspect;
uniform float	u_floorOn;	// whether the floor counts as something to point at
uniform vec2	u_pickNdc;	// the cursor's own position in NDC (-1..1); this shader draws one pixel, so this replaces
							// the varying the main shader would otherwise get from its vertex
uniform float	u_pickMode;	// which of the three answers this pass reads back: 0 position + kind, 1 normal + material,
							// 2 colour + opacity. Three passes rather than multiple render targets, since it is one
							// pixel at a time and never more than a few of these a second.
out vec4		fragColor;

int				g_steps = 0;	// trace() keeps a count for the main shader's heatmap; unused here, but it still writes to it

//@lib

// The SDF the extension generated from the .scad file: the same map() the main shader traces, so what the cursor is
// resting on is answered by exactly the field that drew it.
//@sdf

// trace(), floorHit() and normalAt() are the main shader's own. Duplicated here rather than shared out to the lib,
// since a one-pixel pass otherwise has nothing in common with the picture worth splitting a file over.
float trace(vec3 ro, vec3 rd, out vec3 hit, out float mat, int budget) {
	vec3	inv		= 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-20);
	vec3	t0		= (u_center - u_half - ro) * inv;
	vec3	t1		= (u_center + u_half - ro) * inv;
	vec3	lo		= min(t0, t1), hi = max(t0, t1);
	float	scale	= max(max(u_half.x, u_half.y), u_half.z);
	float	eps		= scale * 2e-4;
	mat			= 0.0;
	float	tEnter	= max(max(lo.x, lo.y), max(lo.z, 0.0));
	float	tLeave	= min(min(hi.x, hi.y), hi.z);
	if (tEnter > tLeave)
		return -1.0;

	float	t		= tEnter;
	// A camera inside the solid -- zoomed into a wall on its way into something hollow -- would see the wall at no
	// distance at all, which fills the view. So a ray that starts inside is carried through to where it comes out,
	// and the march starts from there: the wall around the camera is clipped away, as a near plane would.
	if (tEnter == 0.0 && map(ro).x < 0.0) {
		for (int i = 0; i < 128; ++i) {
			float d = map(ro + rd * t).x;
			if (d >= 0.0)
				break;
			t += max(-d, eps);
			if (t > tLeave)
				return -1.0;
		}
		t += eps * 2.0;
	}
	for (int i = 0; i < 384; ++i) {
		if (i >= budget)
			break;
		hit				= ro + rd * t;
		g_steps++;
		vec2	field	= map(hit);
		if (field.x < eps) {
			mat			= field.y;
			return t;
		}
		t += field.x * 0.9;
		if (t > tLeave + scale * 0.05)
			break;
	}
	return -1.0;
}

float floorHit(vec3 ro, vec3 rd, out vec3 at) {
	at = vec3(0.0);
	if (abs(rd.z) < 1e-6)
		return -1.0;
	float t = -ro.z / rd.z;
	if (t <= 0.0)
		return -1.0;
	at = ro + rd * t;
	return t;
}

vec3 normalAt(vec3 p, float h) {
	vec2 k = vec2(1.0, -1.0);
	return normalize(
		k.xyy * map(p + k.xyy * h).x +
		k.yyx * map(p + k.yyx * h).x +
		k.yxy * map(p + k.yxy * h).x +
		k.xxx * map(p + k.xxx * h).x);
}

void main() {
	vec3	rd		= u_basis * normalize(vec3(u_pickNdc.x * u_aspect / u_fovy, u_pickNdc.y / u_fovy, -1.0));
	vec3	hit;
	float	mat;
	float	scale	= max(max(u_half.x, u_half.y), u_half.z);
	float	t		= trace(u_origin, rd, hit, mat, 384);

	if (t >= 0.0) {
		// kind 1: a point on the model, in fragColor.a of pass 0
		if (u_pickMode < 0.5)
			fragColor = vec4(hit, 1.0);
		else if (u_pickMode < 1.5)
			fragColor = vec4(normalAt(hit, scale * 5e-4), mat);
		else
			fragColor = vec4(matColor(mat), matOpacity(mat));
		return;
	}
	if (u_floorOn > 0.5) {
		vec3	at;
		float	ft = floorHit(u_origin, rd, at);
		if (ft > 0.0) {
			// kind 0: the floor, which has a position but no material of the model's own
			if (u_pickMode < 0.5)
				fragColor = vec4(at, 0.0);
			else if (u_pickMode < 1.5)
				fragColor = vec4(0.0, 0.0, 1.0, -1.0);
			else
				fragColor = vec4(0.0);
			return;
		}
	}
	// kind -1: the background -- nothing under the cursor at all
	fragColor = vec4(0.0, 0.0, 0.0, -1.0);
}
