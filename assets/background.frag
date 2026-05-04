#version 300 es
precision highp float;
uniform vec2		u_viewport;
out vec4			fragColor;

vec4 background(vec2 frag) {
	ivec2 grid	= ivec2(floor(frag / 64.0));
	int checker = (grid.x + grid.y) & 1;
	return checker == 0
		? vec4(0.24, 0.24, 0.24, 1.0)
		: vec4(0.12, 0.12, 0.12, 1.0);
}

void main() {
	vec2 frag	= vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor	= background(frag);
}
