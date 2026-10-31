#version 300 es
// The levels filter: the colours of an area of the image, the black and white points stretched to black and white and the middle
// bent by the gamma; the alpha is left alone. The pixel drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of what is read back.
precision highp float;
precision highp int;
uniform sampler2D	u_image;	// rgba, not premultiplied
uniform ivec2		u_origin;	// where this pass's own (0, 0) is in u_image
uniform float		u_black;	// 0..1
uniform float		u_white;	// 0..1
uniform float		u_gamma;	// above 1 lightens the middle
out vec4			fragColor;

void main() {
	vec4 c = texelFetch(u_image, u_origin + ivec2(gl_FragCoord.xy), 0);
	vec3 v = clamp((c.rgb - u_black) / max(u_white - u_black, 1.0 / 255.0), 0.0, 1.0);
	fragColor = vec4(pow(v, vec3(1.0 / u_gamma)), c.a);
}
