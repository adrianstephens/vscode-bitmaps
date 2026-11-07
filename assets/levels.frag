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
	vec4 c = texelFetch(u_image, u_origin + ivec2(gl_FragCoord.xy), 0);
	vec3 v = clamp((c.rgb - u_black) / max(u_white - u_black, 1.0 / 255.0), 0.0, 1.0);
	fragColor = selected(ivec2(gl_FragCoord.xy), c, vec4(pow(v, vec3(1.0 / u_gamma)), c.a));
}
