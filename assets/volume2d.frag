#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D	u_texture;
uniform vec3		u_size;
uniform vec2		u_viewport;
uniform float		u_scale;
uniform vec2		u_offset;
out vec4			fragColor;

vec4 background(vec2 frag) {
	ivec2 grid	= ivec2(floor(frag / 64.0));
	int checker = (grid.x + grid.y) & 1;
	return checker == 0
		? vec4(0.24, 0.24, 0.24, 1.0)
		: vec4(0.12, 0.12, 0.12, 1.0);
}

vec4 blend(vec4 a, vec4 b) {
	return a * (1.0 - b.a) + b;
}

float oblate(vec2 uv, float p) {
	vec2 dist = pow(fract(uv) - 0.5, vec2(p));
	return pow(dist.x + dist.y, 1.0 / p);
}

float disc(float dist, float radius, float edge) {
	return smoothstep(radius + edge, radius - edge, dist);
}
vec4 sampleTex(vec2 uv) {
    float z  = uv.y / u_size.y;
    vec3 pixelUV  = (floor(vec3(uv.x, fract(z) * u_size.y, z)) + 0.5) / u_size;
    return texture(u_texture, pixelUV);
}

void main() {
	vec2 frag	= vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor	= background(frag);

	vec2 texel = (frag - u_offset) / u_scale;    // texel coordinates in top-left space

	if (texel.x >= 0.0 && texel.y >= 0.0 && texel.x < u_size.x && texel.y < u_size.y * u_size.z) {
		vec4 color = sampleTex(texel);
		if (u_scale >= 10.0) {
			float edge = 1.0 / u_scale;
			float dist = oblate(fract(texel - 0.5) - 0.5, 4.0);
			vec4 discs = color * disc(dist, 0.45, edge);
			float t = clamp((u_scale - 10.0) / 10.0, 0.0, 1.0);
			color = mix(color, discs, t);
		}
		fragColor = blend(fragColor, color);
	}
}
