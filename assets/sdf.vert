#version 300 es
in vec2 a_position;
out vec2 v_ndc;

void main() {
	v_ndc		= a_position;
	gl_Position	= vec4(a_position, 0.0, 1.0);
}
