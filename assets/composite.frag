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
uniform float		u_maskDensity;	// how much it hides of what it hides, 0..1 (its feather is in its pixels already)
uniform float		u_hasMask;
uniform sampler2D	u_vmask;		// its vector mask, drawn, in the same way
uniform vec2		u_vmaskOrigin;
uniform vec2		u_vmaskSize;
uniform float		u_vmaskDefault;
uniform float		u_vmaskInvert;
uniform float		u_vmaskDensity;
uniform float		u_hasVmask;
uniform float		u_clip;			// the layer is clipped to what it goes over: its alpha is not added to that, which stays as it is
uniform float		u_through;		// the layer is what a group passing through made over this same backdrop, shown as much as its opacity and masks say
uniform int			u_adjust;		// an adjustment layer, which has no pixels but is what it does to the backdrop's colours: 1 a table, 2 a threshold, 3 hue/saturation, 4 black and white, 5 colour balance
uniform sampler2D	u_lut;			// 256 by 4: the composite's table, then red's, green's and blue's
uniform float		u_level;		// a threshold: 0..255
uniform vec3		u_bal0;			// colour balance: the shifts of red, green and blue in the shadows, midtones and highlights
uniform vec3		u_bal1;
uniform vec3		u_bal2;
uniform float		u_preserve;		// and whether the lightness stays
uniform vec3		u_bw0;			// black and white: what red, yellow and green come out as
uniform vec3		u_bw1;			// and cyan, blue and magenta
uniform vec3		u_hsl;			// hue/saturation: the hue in degrees, then the saturation and the lightness, -1..1
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

vec3 toHsl(vec3 c) {
	float hi = max(max(c.r, c.g), c.b), lo = min(min(c.r, c.g), c.b), l = (hi + lo) * 0.5, d = hi - lo;
	if (d <= 0.0)
		return vec3(0.0, 0.0, l);
	float s = l < 0.5 ? d / (hi + lo) : d / (2.0 - hi - lo);
	float h = hi == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : hi == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
	return vec3(h / 6.0, s, l);
}
vec3 fromHsl(vec3 c) {
	vec3 k = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
	return c.z + c.y * (1.0 - abs(2.0 * c.z - 1.0)) * (k - 0.5);
}

// the colour as an adjustment layer makes it: each channel's table, then the composite's
vec3 adjusted(vec3 c) {
	if (u_adjust == 5) {
		// The midtones weigh most at the middle and fall off slowly (the curve is fitted to Photoshop's picture); the shadows and
		// highlights are taken as what is left of the same total, below and above the middle.
		float l = lum(c);
		float mids = 0.0;
		float t = clamp(l, 0.0, 1.0) * 10.0;
		float table[11] = float[11](0.08, 0.16, 0.23, 0.26, 0.265, 0.255, 0.23, 0.18, 0.12, 0.06, 0.02);
		int k = min(int(t), 9);
		mids = mix(table[k], table[k + 1], t - float(k));
		float rest = max(0.0, 0.27 - mids);
		float shadows = l < 0.5 ? rest : 0.0, highs = l < 0.5 ? 0.0 : rest;
		vec3 v = clamp(c + u_bal0 * shadows + u_bal1 * mids + u_bal2 * highs, 0.0, 1.0);
		return u_preserve > 0.5 ? clamp(v + (l - lum(v)), 0.0, 1.0) : v;
	}
	if (u_adjust == 4) {
		// the colour is the least of it (white), the most of its dominant colour over the middle one, and the middle over the least of its second
		float hi = max(max(c.r, c.g), c.b), lo = min(min(c.r, c.g), c.b), mid = c.r + c.g + c.b - hi - lo;
		float first, second;
		if (c.r >= c.g && c.r >= c.b) {
			first = u_bw0.x;
			second = c.g >= c.b ? u_bw0.y : u_bw1.z;
		} else if (c.g >= c.b) {
			first = u_bw0.z;
			second = c.r >= c.b ? u_bw0.y : u_bw1.x;
		} else {
			first = u_bw1.y;
			second = c.r >= c.g ? u_bw1.z : u_bw1.x;
		}
		return vec3(clamp(lo + (hi - mid) * first + (mid - lo) * second, 0.0, 1.0));
	}
	if (u_adjust == 3) {
		vec3 h = toHsl(c);
		h.x = fract(h.x + u_hsl.x / 360.0);
		h.y = u_hsl.y < 0.0 ? h.y * (1.0 + u_hsl.y) : h.y + (1.0 - h.y) * u_hsl.y;
		h.z = u_hsl.z < 0.0 ? h.z * (1.0 + u_hsl.z) : h.z + (1.0 - h.z) * u_hsl.z;
		return clamp(fromHsl(h), 0.0, 1.0);
	}
	if (u_adjust == 2)
		return vec3(dot(c, vec3(0.299, 0.587, 0.114)) * 255.0 >= u_level - 0.5 ? 1.0 : 0.0);
	vec3 v;
	for (int i = 0; i < 3; i++) {
		float channel = texelFetch(u_lut, ivec2(int(c[i] * 255.0 + 0.5), i + 1), 0).r;
		v[i] = texelFetch(u_lut, ivec2(int(channel * 255.0 + 0.5), 0), 0).r;
	}
	return v;
}

// how much of the layer a mask leaves at a pixel of the canvas: inverted if it says so, and what it hides made less by its density
float masked(sampler2D mask, ivec2 p, vec2 origin, vec2 size, float outside, float invert, float density) {
	ivec2 m	= p - ivec2(origin);
	float v	= any(lessThan(m, ivec2(0))) || any(greaterThanEqual(m, ivec2(size))) ? outside : texelFetch(mask, m, 0).r;
	return 1.0 - (1.0 - (invert > 0.5 ? 1.0 - v : v)) * density;
}

void main() {
	ivec2 p		= ivec2(gl_FragCoord.xy);
	vec4 below	= texelFetch(u_backdrop, p, 0);

	ivec2 q		= p - ivec2(u_origin);
	if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(u_size)))) {
		fragColor = below;
		return;
	}

	vec4 layer	= u_adjust > 0 ? vec4(adjusted(below.rgb), 1.0) : texelFetch(u_layer, q, 0);
	int mode	= int(u_mode + 0.5);
	float shown	= u_opacity;
	if (u_hasMask > 0.5)
		shown *= masked(u_mask, p, u_maskOrigin, u_maskSize, u_maskDefault, u_maskInvert, u_maskDensity);
	if (u_hasVmask > 0.5)
		shown *= masked(u_vmask, p, u_vmaskOrigin, u_vmaskSize, u_vmaskDefault, u_vmaskInvert, u_vmaskDensity);
	if (u_through > 0.5) {
		// (mixed premultiplied, as the backdrop and what was made over it may differ in alpha)
		float alpha	= mix(below.a, layer.a, shown);
		fragColor	= alpha > 0.0 ? vec4(mix(below.rgb * below.a, layer.rgb * layer.a, shown) / alpha, alpha) : vec4(0.0);
		return;
	}
	float a		= layer.a * shown;
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
	fragColor	= vec4(colour, u_clip > 0.5 || u_adjust > 0 ? b : alpha);
}
