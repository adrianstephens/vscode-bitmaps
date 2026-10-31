#version 300 es
// A mesh of the flat text, each vertex already where the warp puts it (in clip space, as drawn into an image's rows first row first)
in vec2 a_position;
in vec2 a_uv;		// where in the flat text, 0 to 1
out vec2 v_uv;
void main() {
	v_uv = a_uv;
	gl_Position = vec4(a_position, 0.0, 1.0);
}
