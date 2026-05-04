#version 300 es
precision highp float;
uniform sampler2D	u_texture;
uniform vec2		u_size;
uniform vec2		u_viewport;
uniform float		u_scale;
uniform vec2		u_offset;
out vec4			fragColor;

const float HEX_A	= 0.620403;	// ≈ sqrt(2.0 / (3.0 * sqrt(3.0)))
const float SQRTrPI	= 0.5641895835477; // sqrt(1.0 / pi)

vec4 background(vec2 frag) {
	ivec2 grid	= ivec2(floor(frag / 64.0));
	int checker = (grid.x + grid.y) & 1;
	return checker == 0
		? vec4(0.24, 0.24, 0.24, 1.0)
		: vec4(0.12, 0.12, 0.12, 1.0);
}

vec4 sampleTex(vec2 uv) {
	return texture(u_texture, (floor(uv) + 0.5) / u_size);
}
vec3 premultiply(vec4 c) {
	return c.rgb * c.a;
}
vec4 blend(vec4 a, vec4 b) {
	return a * (1.0 - b.a) + b;
}
vec3 toCMY(vec3 rgb) {
	return 1.0 - rgb;
}

vec2 texelToHex(vec2 uv) {
	return vec2(
		uv.x - uv.y * 0.57735026919,	// 1/sqrt(3)
		uv.y * 1.15470053838			// 2/sqrt(3)
	);
}
vec2 hexToTexel(ivec2 h) {
	float q = float(h.x);
	float r = float(h.y);
	return vec2(
		q + 0.5 * r,
		r * 0.86602540378	// sqrt(3)/2
	);
}

float oblate(vec2 uv, float p) {
	vec2 dist = pow(fract(uv) - 0.5, vec2(p));
	return pow(dist.x + dist.y, 1.0 / p);
}

const ivec2 neighbor[7] = ivec2[7](ivec2(0, 0), ivec2(1, 0), ivec2(1, -1), ivec2(0, -1), ivec2(-1, 0), ivec2(-1, 1), ivec2(0, 1));

float disc(float dist, float radius, float edge) {
	return smoothstep(radius + edge, radius - edge, dist);
}
vec3 sampleHexRGB(vec2 uv, float scale, float edge) {
	// 1. texel -> hex space
	ivec2	base	= ivec2(round(texelToHex(uv) / HEX_A));
	vec3	result	= vec3(0.0);

	// 7 neighbors (center + 6)
	for (int i = 0; i < 7; i++) {
		ivec2 hex = base + neighbor[i];

		// 2. hex -> texel center
		vec2 center = hexToTexel(hex) * HEX_A;
		float dist = length(uv - center);

		vec3 texel = toCMY(premultiply(sampleTex(center)));
		//vec3 texel = premultiply(sampleTex(center));

		// 3. assign channel from hex index
		int channel = (hex.x + 2 * hex.y) % 3;
		if (channel == 0)
			result.r += disc(dist, texel.r * scale, edge);
		else if (channel == 1)
			result.g += disc(dist, texel.g * scale, edge);
		else
			result.b += disc(dist, texel.b * scale, edge);
	}

	return result;
}

void main() {
	vec2 frag	= vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor = background(frag);

	vec2 texel = (frag - u_offset) / u_scale;	// texel coordinates in top-left space

	if (texel.x >= 0.0 && texel.y >= 0.0 && texel.x < u_size.x && texel.y < u_size.y) {
		//vec4 color = premultiply(sampleTex(texel));
		vec4 color = sampleTex(texel);

		if (u_scale >= 10.0) {
			float edge = 1.0 / u_scale;
			float dist = oblate(fract(texel - 0.5) - 0.5, 4.0);
			vec4 discs = color * disc(dist, 0.45, edge);

			//vec3	discs = sampleHexRGB(texel, SQRTrPI, edge);// * HEX_A));
			//vec3	discs = toCMY(sampleHexRGB(texel, SQRTrPI, edge));
			float t		= clamp((u_scale - 10.0) / 10.0, 0.0, 1.0);
			//fragColor	= vec4(mix(color, discs, t), 1.0);
			fragColor	= blend(fragColor, mix(color, discs, t));
		} else {
			fragColor	= blend(fragColor, color);
		}
	}
}
