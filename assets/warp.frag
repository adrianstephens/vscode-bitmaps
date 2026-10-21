#version 300 es
// An image carried onto a plane by a homography, as warp in raster.ts makes it: each pixel drawn is the image where the
// inverse takes it, bilinearly, from colours weighted by their alpha so that transparent pixels lend none of their colour;
// where it is shrunk, from several such samples a pixel (as many as that pixel needs, up to 4x4). Outside the image is
// transparent, or for a mask u_outside. The pixel drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j, column i, of what
// is read back, so the rows come out first row first, as an image has them.
precision highp float;
precision highp int;
uniform sampler2D	u_image;	// rgba, not premultiplied; or a mask, in r
uniform mat3		u_inverse;	// from the pixels drawn (the first from 0 to 1) to the image's
uniform float		u_mask;		// 1: one channel, u_outside outside the image
uniform float		u_outside;	// 0..1
out vec4			fragColor;

vec3 carry(vec2 p) {
	vec3 q = u_inverse * vec3(p, 1.0);
	return vec3(q.xy / q.z, q.z);
}

// the image at a point: premultiplied, or a mask's value in r
vec4 at(vec2 s) {
	ivec2 size	= textureSize(u_image, 0);
	vec2 f		= s - 0.5;
	vec2 f0		= floor(f), t = f - f0;
	ivec2 i0	= ivec2(f0);
	vec4 value	= vec4(0.0);
	for (int k = 0; k < 4; k++) {
		ivec2 i		= i0 + ivec2(k & 1, k >> 1);
		float w		= ((k & 1) != 0 ? t.x : 1.0 - t.x) * ((k & 2) != 0 ? t.y : 1.0 - t.y);
		if (w == 0.0)
			continue;
		if (any(lessThan(i, ivec2(0))) || any(greaterThanEqual(i, size))) {
			value.r += u_mask * u_outside * w;
			continue;
		}
		vec4 c = texelFetch(u_image, i, 0);
		value += (u_mask > 0.5 ? vec4(c.r, 0.0, 0.0, 0.0) : vec4(c.rgb * c.a, c.a)) * w;
	}
	return value;
}

void main() {
	vec2 pixel = floor(gl_FragCoord.xy);

	// how many samples a side: by how far apart the samples of this pixel's neighbours are in the image
	vec3 p = carry(pixel + 0.5), px = carry(pixel + vec2(1.5, 0.5)), py = carry(pixel + vec2(0.5, 1.5));
	float spread = p.z > 0.0 ? max(length(px.xy - p.xy), length(py.xy - p.xy)) : 1.0;
	int n = int(clamp(ceil(spread - 1e-3), 1.0, 4.0));	// (float can make a rotation's spread of 1 a hair more)

	vec4 sum = vec4(0.0);
	for (int j = 0; j < n; j++) {
		for (int i = 0; i < n; i++) {
			vec3 s = carry(pixel + (vec2(i, j) + 0.5) / float(n));
			if (s.z <= 0.0)
				sum.r += u_mask * u_outside;	// behind the horizon
			else
				sum += at(s.xy);
		}
	}
	float nn = float(n * n);
	if (u_mask > 0.5)
		fragColor = vec4(sum.r / nn);
	else
		fragColor = sum.a > 0.0 ? vec4(sum.rgb / sum.a, sum.a / nn) : vec4(0.0);
}
