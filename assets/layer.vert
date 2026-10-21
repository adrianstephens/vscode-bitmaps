#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;	// a quad from -1 to 1
uniform mat4	u_mvp;			// from the layer's own measure (0 to 1 across and down it) to clip space: where it lies, how deep, and the view
uniform mat3	u_clip;			// from the same to where a clip is measured
out vec2		v_uv;
out vec3		v_clip;			// where each point lands there (homogeneous, so that it is interpolated as it should be)

void main() {
	v_uv		= vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);	// the top row first, as an image has it
	v_clip		= u_clip * vec3(v_uv, 1.0);
	gl_Position	= u_mvp * vec4(v_uv, 0.0, 1.0);
}
