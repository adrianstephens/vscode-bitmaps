#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;	// a quad from -1 to 1
uniform mat4	u_mvp;
uniform vec2	u_half;			// half the plane's width and height, in the stack's units
uniform float	u_z;			// where the plane lies along the stack
out vec2		v_uv;

void main() {
	v_uv		= vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);	// the top row first, as an image has it
	gl_Position	= u_mvp * vec4(a_position * u_half, u_z, 1.0);
}
