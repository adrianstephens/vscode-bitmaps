#version 300 es
precision highp float;
uniform samplerCube u_texture;
uniform float	u_size;
uniform vec2	u_viewport;
uniform float	u_scale;
uniform vec2	u_offset;
out vec4		fragColor;

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

const int faces[12] = int[12](
    -1,  2, -1, -1,  // row 0
     1,  4,  0,  5,  // row 1
    -1,  3, -1, -1   // row 2
);

vec3 faceDirection(int face, vec2 uv) {
    if (face == 0) return vec3( 1.0, -uv.y, -uv.x);
    if (face == 1) return vec3(-1.0, -uv.y,  uv.x);
    if (face == 2) return vec3( uv.x,  1.0,  uv.y);
    if (face == 3) return vec3( uv.x, -1.0, -uv.y);
    if (face == 4) return vec3( uv.x, -uv.y,  1.0);
    return vec3(-uv.x, -uv.y, -1.0);
}

vec4 sampleTex(vec2 uv) {
    vec2 coord = uv / u_size;
    int x = int(floor(coord.x));
    int y = int(floor(coord.y));
    int face = faces[y * 4 + x];
    if (face < 0)
        return vec4(0.0);

    vec3 dir = faceDirection(face, fract(coord) * 2.0 - 1.0);
    return texture(u_texture, dir);
}

void main() {
    vec2 frag = vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor = background(frag);

    vec2 texel = (frag - u_offset) / u_scale;

    if (texel.x >= 0.0 && texel.y >= 0.0 && texel.x < u_size * 4.0 && texel.y < u_size * 3.0) {
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
