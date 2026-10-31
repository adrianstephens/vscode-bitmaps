#version 300 es
// The flat text (premultiplied, so that what is filtered is colour weighted by its coverage) as the warp's mesh carries it, with the
// colour drawn not premultiplied, as an image has it.
precision highp float;
uniform sampler2D	u_text;
in vec2				v_uv;
out vec4			fragColor;
void main() {
	vec4 t = texture(u_text, v_uv);
	fragColor = t.a > 0.0 ? vec4(t.rgb / t.a, t.a) : vec4(0.0);
}
