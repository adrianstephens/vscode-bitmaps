#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;	// a quad from -1 to 1
uniform mat4	u_mvp;			// from screen pixels, where the layer lies when flat, to the clip space it is drawn in
uniform vec4	u_rect;			// where the layer lies when flat, in screen pixels: left, top, width, height
out vec2		v_uv;

void main() {
	v_uv		= vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);	// the top row first, as an image has it
	gl_Position	= u_mvp * vec4(u_rect.xy + v_uv * u_rect.zw, 0.0, 1.0);
}
