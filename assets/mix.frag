#version 300 es
// An effect's result (computed apart, and arriving when it does) shown over the image it is for, as much of it as `u_strength` says: the
// colours that far from the image's to the result's, the alpha the image's own unless the strength is all (as vectorise.ts's `mixed` has
// it, and the effect's whole result when it is). The result covers a part of the image, from `u_otherAt`; the rest is as it was. It draws
// into the image's own texture, so the pixel at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of the image.
precision highp float;
precision highp int;
uniform sampler2D	u_image;		// rgba, not premultiplied: the image as it was
uniform sampler2D	u_other;		// the effect's result, over the part of the image it is for
uniform ivec2		u_otherAt;		// where its first pixel is in the image
uniform float		u_strength;		// 0..1

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
	ivec2 p		= ivec2(gl_FragCoord.xy);
	vec4 was	= texelFetch(u_image, p, 0);
	ivec2 o		= p - u_otherAt;
	if (any(lessThan(o, ivec2(0))) || any(greaterThanEqual(o, textureSize(u_other, 0)))) {
		fragColor = was;
		return;
	}
	vec4 over	= texelFetch(u_other, o, 0);
	fragColor	= selected(p, was, vec4(mix(was.rgb, over.rgb, u_strength), u_strength < 1.0 ? was.a : over.a));
}
