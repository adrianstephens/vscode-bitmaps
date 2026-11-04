#version 300 es
// Ink lines drawn from a picture, by u_mode, as a difference of Gaussians of its brightness (a pixel is dark where it is darker than the
// neighbourhood round it by more than u_contrast, as a step between areas would be, which is where an artist would put a line):
//   0  the brightness blurred across, by two Gaussians (u_sigma, and 1.6 times that), in r and g
//   1  those blurred down
//   2  the lines: white, and darker as the narrower Gaussian falls further below the wider past u_contrast; with the picture's own alpha
// The pixel drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of what is read back.
precision highp float;
precision highp int;
uniform sampler2D	u_image;
uniform sampler2D	u_original;
uniform ivec2		u_origin;		// where this pass's own (0, 0) is in u_image
uniform ivec2		u_originalAt;	// where it is in u_original
uniform int			u_mode;
uniform int			u_radius;		// the most the Gaussians reach, in pixels (up to 32)
uniform float		u_sigma;
uniform float		u_contrast;		// 0..1
out vec4			fragColor;

// (transparent is white, as paper is)
float brightness(vec4 c) {
	return mix(1.0, dot(c.rgb, vec3(0.299, 0.587, 0.114)), c.a);
}

void main() {
	ivec2 size	= textureSize(u_image, 0);
	ivec2 at	= u_origin + ivec2(gl_FragCoord.xy);
	if (u_mode == 2) {
		vec2 g		= texelFetch(u_image, at, 0).rg;
		// (a step of height h between two areas leaves the Gaussians about h / 6 apart at its darker side, so that is scaled back to h)
		float dark	= tanh(max(0.0, (g.g - g.r) * 6.0 - u_contrast) * 12.0);
		float a		= texelFetch(u_original, u_originalAt + ivec2(gl_FragCoord.xy), 0).a;
		fragColor	= vec4(vec3(1.0 - dark), a);
		return;
	}
	float wide = u_sigma * 1.6, sum1 = 0.0, sum2 = 0.0, n1 = 0.0, n2 = 0.0;
	for (int i = -32; i <= 32; i++) {
		if (i < -u_radius || i > u_radius)
			continue;
		ivec2 q	= clamp(at + (u_mode == 0 ? ivec2(i, 0) : ivec2(0, i)), ivec2(0), size - 1);
		vec4 c	= texelFetch(u_image, q, 0);
		float v	= u_mode == 0 ? brightness(c) : c.r;
		float w1 = exp(-float(i * i) / (2.0 * u_sigma * u_sigma)), w2 = exp(-float(i * i) / (2.0 * wide * wide));
		sum1 += (u_mode == 0 ? v : c.r) * w1;
		sum2 += (u_mode == 0 ? v : c.g) * w2;
		n1 += w1;
		n2 += w2;
	}
	fragColor = vec4(sum1 / n1, sum2 / n2, 0.0, 1.0);
}
