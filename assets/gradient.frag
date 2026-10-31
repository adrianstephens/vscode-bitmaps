#version 300 es
// The gradient tool's linear gradient over a whole image, as paint.ts's drawGradient puts it (painted over what is there, at the tool's
// opacity, as much as the selection lets through), for the image to be shown so while it is dragged. It draws into the image's own
// texture, so the pixel at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of the image.
precision highp float;
precision highp int;
uniform sampler2D	u_image;		// rgba, not premultiplied: the image as it was
uniform sampler2D	u_selection;	// the selection's coverage over its box, in r (when u_masked)
uniform vec4		u_selected;		// the selection's box: corner and size (everything, without a selection)
uniform float		u_masked;		// 1: the box has u_selection's coverage, 0: all of it is selected
uniform vec4		u_line;			// where the gradient starts, and how far it goes
uniform vec4		u_from;			// the colour at its start, 0..1
uniform vec4		u_to;			// the colour at its end
uniform float		u_opacity;
out vec4			fragColor;

void main() {
	ivec2 p		= ivec2(gl_FragCoord.xy);
	vec4 d		= texelFetch(u_image, p, 0);
	ivec2 s		= p - ivec2(u_selected.xy);
	float len2	= dot(u_line.zw, u_line.zw);
	if (len2 == 0.0 || any(lessThan(s, ivec2(0))) || any(greaterThanEqual(s, ivec2(u_selected.zw)))) {
		fragColor = d;
		return;
	}
	float cover	= u_masked > 0.5 ? texelFetch(u_selection, s, 0).r : 1.0;
	float t		= clamp(dot(vec2(p) + 0.5 - u_line.xy, u_line.zw) / len2, 0.0, 1.0);
	vec4 g		= mix(u_from, u_to, t);
	float a		= cover * u_opacity * g.a;
	float outA	= a + d.a * (1.0 - a);
	fragColor	= vec4(outA > 0.0 ? (g.rgb * a + d.rgb * d.a * (1.0 - a)) / outA : d.rgb, outA);
}
