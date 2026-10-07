#version 300 es
// One layer over what is below it, with the layer's blend mode: the backdrop in, the new backdrop out.
// Colours are not premultiplied, and the blending is as the W3C compositing specification has it (which is what Photoshop's
// modes are, bar details): with a the alpha of the layer (its own, and its opacity), and b the backdrop's,
//   result alpha = a + b (1 - a)
//   result colour = ((1 - a) b Cb + a ((1 - b) Cs + b B(Cb, Cs))) / result alpha
precision highp float;
precision highp int;
uniform sampler2D	u_backdrop;
uniform sampler2D	u_layer;
uniform vec2		u_origin;		// where the layer's first pixel is on the canvas
uniform vec2		u_size;			// of the layer, in pixels
uniform float		u_opacity;
uniform float		u_mode;			// which blend mode: see BLEND_MODES in layers.ts
uniform sampler2D	u_mask;			// the layer's mask, one channel, if it has one (u_maskSize is zero if not)
uniform vec2		u_maskOrigin;
uniform vec2		u_maskSize;
uniform float		u_maskDefault;	// what it is outside its rectangle, 0..1
uniform float		u_maskInvert;
uniform float		u_hasMask;
uniform float		u_clip;			// the layer is clipped to what it goes over: its alpha is not added to that, which stays as it is
out vec4			fragColor;

float lum(vec3 c) {
	return dot(c, vec3(0.3, 0.59, 0.11));
}
float sat(vec3 c) {
	return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}
vec3 clipColour(vec3 c) {
	float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
	if (n < 0.0)
		c = l + (c - l) * l / (l - n);
	if (x > 1.0)
		c = l + (c - l) * (1.0 - l) / (x - l);
	return c;
}
vec3 setLum(vec3 c, float l) {
	return clipColour(c + (l - lum(c)));
}
vec3 setSat(vec3 c, float s) {
	float n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
	return x > n ? (c - n) * s / (x - n) : vec3(0.0);
}

float colourBurn(float b, float s) {
	return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);
}
float colourDodge(float b, float s) {
	return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));
}
float hardLight(float b, float s) {
	return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0);
}
float softLight(float b, float s) {
	if (s <= 0.5)
		return b - (1.0 - 2.0 * s) * b * (1.0 - b);
	float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
	return b + (2.0 * s - 1.0) * (d - b);
}

// the modes which work on each channel by itself
float separable(int mode, float b, float s) {
	switch (mode) {
		case 2:		return min(b, s);									// darken
		case 3:		return b * s;										// multiply
		case 4:		return colourBurn(b, s);							// colour burn
		case 5:		return max(0.0, b + s - 1.0);						// linear burn
		case 7:		return max(b, s);									// lighten
		case 8:		return b + s - b * s;								// screen
		case 9:		return colourDodge(b, s);							// colour dodge
		case 10:	return min(1.0, b + s);								// linear dodge (add)
		case 12:	return hardLight(s, b);								// overlay: hard light with the layers the other way round
		case 13:	return softLight(b, s);								// soft light
		case 14:	return hardLight(b, s);								// hard light
		case 15:	return s < 0.5 ? colourBurn(b, 2.0 * s) : colourDodge(b, 2.0 * (s - 0.5));	// vivid light
		case 16:	return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);			// linear light
		case 17:	return s < 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);	// pin light
		case 18:	return b + s >= 1.0 ? 1.0 : 0.0;					// hard mix
		case 19:	return abs(b - s);									// difference
		case 20:	return b + s - 2.0 * b * s;							// exclusion
		case 21:	return max(0.0, b - s);								// subtract
		case 22:	return s <= 0.0 ? 1.0 : min(1.0, b / s);			// divide
	}
	return s;															// normal (and the others which are)
}

vec3 blend(int mode, vec3 b, vec3 s) {
	switch (mode) {
		case 6:		return lum(s) < lum(b) ? s : b;						// darker colour
		case 11:	return lum(s) > lum(b) ? s : b;						// lighter colour
		case 23:	return setLum(setSat(s, sat(b)), lum(b));			// hue
		case 24:	return setLum(setSat(b, sat(s)), lum(b));			// saturation
		case 25:	return setLum(s, lum(b));							// colour
		case 26:	return setLum(b, lum(s));							// luminosity
	}
	return vec3(separable(mode, b.r, s.r), separable(mode, b.g, s.g), separable(mode, b.b, s.b));
}

void main() {
	ivec2 p		= ivec2(gl_FragCoord.xy);
	vec4 below	= texelFetch(u_backdrop, p, 0);

	ivec2 q		= p - ivec2(u_origin);
	if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(u_size)))) {
		fragColor = below;
		return;
	}

	vec4 layer	= texelFetch(u_layer, q, 0);
	int mode	= int(u_mode + 0.5);
	float a		= layer.a * u_opacity;
	if (u_hasMask > 0.5) {
		ivec2 m		= p - ivec2(u_maskOrigin);
		float mask	= any(lessThan(m, ivec2(0))) || any(greaterThanEqual(m, ivec2(u_maskSize))) ? u_maskDefault : texelFetch(u_mask, m, 0).r;
		a			*= u_maskInvert > 0.5 ? 1.0 - mask : mask;
	}
	if (mode == 1)	// dissolve: each pixel is wholly there or not, by chance, as often as it is opaque
		a = fract(sin(dot(vec2(p), vec2(12.9898, 78.233))) * 43758.5453) < a ? 1.0 : 0.0;
	if (a <= 0.0) {
		fragColor = below;
		return;
	}

	float b		= below.a;
	float alpha	= a + b * (1.0 - a);
	vec3 mixed	= blend(mode, below.rgb, layer.rgb);
	vec3 colour	= ((1.0 - a) * b * below.rgb + a * ((1.0 - b) * layer.rgb + b * mixed)) / alpha;
	fragColor	= vec4(colour, u_clip > 0.5 ? b : alpha);
}
