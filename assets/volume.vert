#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
uniform float u_size;
uniform float u_flatten;
out vec3 v_cube;

void main() {
	v_cube = a_position;
	vec3 sheared = vec3(a_position.x, a_position.y + a_position.z * u_flatten * u_size, a_position.z * (1.0 - u_flatten));
	gl_Position = u_mvp * vec4(sheared, 1.0);
}