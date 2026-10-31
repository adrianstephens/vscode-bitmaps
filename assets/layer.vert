#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;	// a square from -1 to 1, cut into a grid (for a warp to bend)
uniform mat4	u_mvp;			// from the layer's own measure (0 to 1 across and down it) to clip space: where it lies, how deep, and the view; or with a warp, from the canvas
uniform mat3	u_clip;			// from the same to where a clip is measured
uniform vec4	u_span;			// the part of the layer drawn, in its own measure: its corner and its size
uniform float	u_warp;			// 1: what is drawn is bent by the patch first, which puts it on the canvas
uniform vec2	u_patch[16];	// a bicubic patch over what is drawn: four rows of four control points, on the canvas
out vec2		v_uv;
out vec3		v_clip;			// where each point lands there (homogeneous, so that it is interpolated as it should be)

vec4 bernstein(float t) {
	float u = 1.0 - t;
	return vec4(u * u * u, 3.0 * t * u * u, 3.0 * t * t * u, t * t * t);
}

vec2 bend(vec2 t) {
	vec4 bu = bernstein(t.x), bv = bernstein(t.y);
	vec2 p = vec2(0.0);
	for (int k = 0; k < 16; k++)
		p += u_patch[k] * bu[k & 3] * bv[k >> 2];
	return p;
}

void main() {
	vec2 g		= vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);	// the top row first, as an image has it
	v_uv		= u_span.xy + g * u_span.zw;
	if (u_warp > 0.5) {
		vec2 p		= bend(g);
		v_clip		= vec3(p, 1.0);
		gl_Position	= u_mvp * vec4(p, 0.0, 1.0);
	} else {
		v_clip		= u_clip * vec3(v_uv, 1.0);
		gl_Position	= u_mvp * vec4(v_uv, 0.0, 1.0);
	}
}
