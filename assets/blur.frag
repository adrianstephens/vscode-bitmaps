#version 300 es
// One pass of blurPixels' gaussian (raster.ts), along a line of the image: the first reads the image itself (colours weighted by their
// alpha, so that a transparent pixel lends none of its colour; beyond the edge is the edge's own), and writes those premultiplied,
// into a float target; the second reads that target along the other way and gives the colours back, not premultiplied. The pixel
// drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of what is read back, as an image has them.
precision highp float;
precision highp int;
uniform sampler2D	u_image;	// the first pass: rgba, not premultiplied; the second: what the first drew (premultiplied)
uniform ivec2		u_origin;	// where this pass's own (0, 0) is in u_image
uniform ivec2		u_step;		// one tap along: (1, 0) or (0, 1)
uniform int			u_radius;	// the taps either side
uniform float		u_sigma;
uniform float		u_norm;		// the sum of all the weights
uniform float		u_first;	// 1: the first pass
uniform sampler2D	u_original;	// the image itself, for the sharpen
uniform ivec2		u_originalAt;	// where the pixel drawn first is in it
uniform float		u_amount;	// above 0: sharpen by this much
uniform float		u_plain;	// 1: the values are on their own, in every channel (a mask), and not colours weighted by their alpha
uniform float		u_zero;		// 1: beyond the edge is nothing, and not the edge's own
uniform vec4		u_fill;		// or (with u_zero) this, for a mask, which is what it is outside its pixels

// Only for the filter shown on the picture as it is changed (see paint.ts's previewShade), which draws into the picture's own texture:
// the filter is limited to the selection's box, and the mask's coverage says how much of it a pixel takes. (Off, in the filter's own passes.)
uniform sampler2D	u_selection;	// the selection's coverage over its box, in r (when u_masked)
uniform vec4		u_selected;		// the selection's box: corner and size
uniform float		u_bounded;		// 1: limited to the selection, 0: all of it
uniform float		u_masked;		// 1: the box has u_selection's coverage, 0: all of it is selected
out vec4			fragColor;

vec4 selected(ivec2 p, vec4 was, vec4 now) {
	if (u_bounded < 0.5)
		return now;
	ivec2 s = p - ivec2(u_selected.xy);
	if (any(lessThan(s, ivec2(0))) || any(greaterThanEqual(s, ivec2(u_selected.zw))))
		return was;
	float cover	= u_masked > 0.5 ? texelFetch(u_selection, s, 0).r : 1.0;
	float a		= mix(was.a, now.a, cover);
	return vec4(a > 0.0 ? mix(was.rgb * was.a, now.rgb * now.a, cover) / a : now.rgb, a);
}

void main() {
	ivec2 size	= textureSize(u_image, 0);
	ivec2 at	= u_origin + ivec2(gl_FragCoord.xy);
	vec4 sum	= vec4(0.0);
	for (int i = -u_radius; i <= u_radius; i++) {
		ivec2 q	= at + u_step * i;
		if (u_zero > 0.5 && (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size)))) {
			sum	+= u_fill * exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
			continue;
		}
		vec4 c	= texelFetch(u_image, clamp(q, ivec2(0), size - 1), 0);
		sum		+= (u_first > 0.5 && u_plain < 0.5 ? vec4(c.rgb * c.a, c.a) : c) * exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
	}
	sum /= u_norm;
	if (u_first > 0.5 || u_plain > 0.5)
		fragColor = sum;
	else {
		vec4 blurred = sum.a > 0.0 ? vec4(sum.rgb / sum.a, sum.a) : vec4(0.0);
		ivec2 p = u_originalAt + ivec2(gl_FragCoord.xy);
		vec4 c	= texelFetch(u_original, p, 0);
		if (u_amount > 0.0)
			blurred = vec4(c.a > 0.0 ? c.rgb + (c.rgb - blurred.rgb) * u_amount : c.rgb, c.a);
		fragColor = selected(p, c, blurred);
	}
}
