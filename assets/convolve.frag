#version 300 es
// A convolution of an area of the image by a square kernel (up to 7 by 7; beyond the edge is the edge's own). A smoothing kernel
// (its weights positive, adding to 1) takes the colours weighted by their alpha, and gives the alpha convolved too, as blur.frag
// does; any other works on the colours alone (their luminance, if `u_grey`), adds `u_bias` to what it makes, and leaves the alpha.
// The pixel drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of what is read back.
precision highp float;
precision highp int;
uniform sampler2D	u_image;	// rgba, not premultiplied
uniform ivec2		u_origin;	// where this pass's own (0, 0) is in u_image
uniform int			u_size;		// 1, 3, 5 or 7
uniform float		u_kernel[49];	// u_size by u_size of them, a row at a time
uniform float		u_bias;		// 0..1
uniform float		u_grey;		// 1: from the luminance, to grey
uniform float		u_smooth;	// 1: a smoothing kernel
out vec4			fragColor;

void main() {
	ivec2 size	= textureSize(u_image, 0);
	ivec2 at	= u_origin + ivec2(gl_FragCoord.xy);
	int half_	= u_size / 2;
	vec4 sum	= vec4(0.0);
	for (int j = 0; j < u_size; j++) {
		for (int i = 0; i < u_size; i++) {
			vec4 c	= texelFetch(u_image, clamp(at + ivec2(i - half_, j - half_), ivec2(0), size - 1), 0);
			float w	= u_kernel[j * u_size + i];
			if (u_smooth > 0.5)
				sum += vec4(c.rgb * c.a, c.a) * w;
			else
				sum.rgb += (u_grey > 0.5 ? vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))) : c.rgb) * w;
		}
	}
	if (u_smooth > 0.5)
		fragColor = sum.a > 0.0 ? vec4(sum.rgb / sum.a, sum.a) : vec4(0.0);
	else
		fragColor = vec4(clamp(sum.rgb + u_bias, 0.0, 1.0), texelFetch(u_image, at, 0).a);
}
