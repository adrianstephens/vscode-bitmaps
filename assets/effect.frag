#version 300 es
// The passes that make a layer style's shadow, glow or overlay (see gpueffects.ts), each drawn by u_op over a target: the style is made
// at a lower resolution when it is wide, and the last pass puts it back over the part of the canvas it covers, in its colour.
//   0	build:	the shape's alpha (u_shape), shifted by u_offset and averaged down by u_k, or what is not the shape (u_invert)
//   1	dilate:	the largest value within u_radius along u_step: four of these, along a square and a diamond, spread an edge round
//   2	blur:	a gaussian along u_step (or, for a bevel, a raised cosine as wide as the bevel: it ends where the bevel does)
//   3	step:	for the 'precise' technique, one pixel more of spread; the second channel counts the steps a pixel was in
//   4	final:	the style over the canvas, in its colour, with its contour, range and the shape's knockout; or (u_mode 2) a bevel's highlight
//			or shadow, which is the blurred shape as a surface lit from an angle
precision highp float;
precision highp int;
precision highp sampler2D;
uniform int			u_op;
uniform sampler2D	u_src;			// what the last pass drew
uniform sampler2D	u_shape;		// the shape's alpha, one channel
uniform sampler2D	u_contour;		// 256 by 1: the contour's curve
uniform ivec2		u_shapeOrigin;	// where the shape's (0, 0) is on the canvas
uniform ivec2		u_shapeSize;
uniform float		u_flatShape;	// 1: the shape is all of its rectangle, and u_shape is not read
uniform ivec2		u_step;
uniform int			u_radius;
uniform float		u_sigma;
uniform float		u_hann;			// 1: the weights are a raised cosine over the radius, and not a gaussian
uniform ivec2		u_workOrigin;	// where the working image's (0, 0) is on the canvas
uniform ivec2		u_offset;
uniform int			u_k;			// the canvas pixels to a working pixel, along a side
uniform float		u_invert;
uniform int			u_square;		// a step goes to all eight neighbours, and not just the four
uniform ivec2		u_outOrigin;	// where the result's (0, 0) is on the canvas
uniform vec3		u_colour;
uniform int			u_mode;			// 0: from the working image; 1: the shape itself
uniform float		u_precise;
uniform float		u_steps;		// the steps there were, and the spread, both in working pixels
uniform float		u_spread;
uniform float		u_range;		// above 0: the value which counts as full
uniform float		u_centre;
uniform float		u_inside;
uniform float		u_knockout;
uniform float		u_hasContour;
uniform float		u_depth;		// a bevel: the height the shape's edge rises, in pixels
uniform float		u_altitude;		// the light's, in radians
uniform float		u_azimuth;		// and its direction: the angle it is at, in radians
uniform float		u_direction;	// 1: up, -1: down
uniform float		u_highlight;	// 1: the highlight, 0: the shadow
uniform int			u_bevelMask;	// 0: all of it (emboss); 1: inside the shape; 2: outside it; 3: both, inside up and outside down (pillow)
out vec4			fragColor;

float shapeAlpha(ivec2 canvas) {
	ivec2 q = canvas - u_shapeOrigin;
	if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, u_shapeSize)))
		return 0.0;
	return u_flatShape > 0.5 ? 1.0 : texelFetch(u_shape, q, 0).r;
}

vec4 fetchClamped(ivec2 at) {
	return texelFetch(u_src, clamp(at, ivec2(0), textureSize(u_src, 0) - 1), 0);
}

// the working image at a place on the canvas, between its pixels' middles (and its first channel)
vec4 workAt4(vec2 canvas) {
	vec2 w = (canvas + 0.5 - vec2(u_workOrigin)) / float(u_k) - 0.5;
	ivec2 w0 = ivec2(floor(w));
	vec2 f = w - floor(w);
	return mix(mix(fetchClamped(w0), fetchClamped(w0 + ivec2(1, 0)), f.x), mix(fetchClamped(w0 + ivec2(0, 1)), fetchClamped(w0 + ivec2(1, 1)), f.x), f.y);
}
float workAt(vec2 canvas) { return workAt4(canvas).r; }

void main() {
	ivec2 at = ivec2(gl_FragCoord.xy);
	if (u_op == 0) {
		ivec2 base = u_workOrigin + at * u_k;
		float sum = 0.0;
		for (int j = 0; j < u_k; j++)
			for (int i = 0; i < u_k; i++)
				sum += shapeAlpha(base + ivec2(i, j) - u_offset);
		float a = sum / float(u_k * u_k);
		fragColor = vec4(u_invert > 0.5 ? 1.0 - a : a, 0.0, 0.0, 1.0);
	} else if (u_op == 1) {
		float m = 0.0;
		for (int i = -u_radius; i <= u_radius; i++)
			m = max(m, fetchClamped(at + u_step * i).r);
		fragColor = vec4(m, 0.0, 0.0, 1.0);
	} else if (u_op == 2) {
		float sum = 0.0, norm = 0.0;
		for (int i = -u_radius; i <= u_radius; i++) {
			float c = cos(1.5707963 * float(i) / float(u_radius + 1));
			float w = u_hann > 0.5 ? c * c : exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
			sum += fetchClamped(at + u_step * i).r * w;
			norm += w;
		}
		fragColor = vec4(sum / norm, 0.0, 0.0, 1.0);
	} else if (u_op == 3) {
		vec4 c = fetchClamped(at);
		float m = c.r;
		for (int dy = -1; dy <= 1; dy++)
			for (int dx = -1; dx <= 1; dx++)
				if (u_square > 0 || dx == 0 || dy == 0)
					m = max(m, fetchClamped(at + ivec2(dx, dy)).r);
		fragColor = vec4(m, c.g + m, 0.0, 1.0);
	} else {
		ivec2 p = u_outOrigin + at;
		float s = shapeAlpha(p), a = s;
		if (u_mode == 2) {
			// the blurred shape is the height of a surface, and the light on it, against the light on a flat one, is the highlight or shadow
			float dir = u_direction;
			if (u_bevelMask == 3 && s < 0.5)
				dir = -dir;
			float hx = u_depth * 0.5 * (workAt(vec2(p) + vec2(1.0, 0.0)) - workAt(vec2(p) - vec2(1.0, 0.0))) * dir;
			float hy = u_depth * 0.5 * (workAt(vec2(p) + vec2(0.0, 1.0)) - workAt(vec2(p) - vec2(0.0, 1.0))) * dir;
			vec3 n = normalize(vec3(-hx, -hy, 1.0));
			vec3 l = vec3(cos(u_altitude) * cos(u_azimuth), -cos(u_altitude) * sin(u_azimuth), sin(u_altitude));
			float lit = dot(n, l), level = sin(u_altitude);
			a = u_highlight > 0.5 ? clamp((lit - level) / (1.0 - level), 0.0, 1.0) : clamp((level - lit) / level, 0.0, 1.0);
			if (u_bevelMask == 1)
				a *= s;
			else if (u_bevelMask == 2)
				a *= 1.0 - s;
			else if (u_bevelMask == 3)
				a *= s >= 0.5 ? s : 1.0 - s;
		} else if (u_mode == 0) {
			vec4 v = workAt4(vec2(p));
			if (u_precise > 0.5) {
				// the steps this was in: all of them, at the source, and fewer the further from it
				a = v.g <= 0.0 ? 0.0 : clamp(1.0 - max(0.0, u_steps - v.g - u_spread) / max(0.5, u_steps - u_spread), 0.0, 1.0);
			} else {
				a = u_range > 0.0 ? min(1.0, v.r / u_range) : v.r;
			}
			if (u_hasContour > 0.5)
				a = texture(u_contour, vec2((clamp(a, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).r;
			if (u_centre > 0.5)
				a = 1.0 - a;
			if (u_inside > 0.5)
				a *= s;
			else if (u_knockout > 0.5)
				a *= 1.0 - s;
		}
		fragColor = vec4(u_colour, a);
	}
}
