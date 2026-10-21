#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray	u_texture;
uniform vec3			u_size;		// x=width, y=height, z=planes
uniform int				u_layer;	// which plane this is
uniform float			u_opacity;	// how much of it shows
uniform float			u_edge;		// the width of its outline, in pixels of the plane
uniform vec4			u_outline;	// premultiplied
in vec2					v_uv;
out vec4				fragColor;

void main() {
	ivec2 texel	= ivec2(min(floor(v_uv * u_size.xy), u_size.xy - 1.0));
	vec4 colour	= texelFetch(u_texture, ivec3(texel, u_layer), 0);
	colour		= vec4(colour.rgb * colour.a, colour.a) * u_opacity;
	// a veil, so that a plane with little in it still shows where it is
	colour		+= vec4(0.5, 0.5, 0.5, 0.5) * 0.12 * (1.0 - colour.a);
	vec2 d		= min(v_uv, 1.0 - v_uv) * u_size.xy;
	if (min(d.x, d.y) < u_edge)
		colour	= u_outline + colour * (1.0 - u_outline.a);
	fragColor	= colour;
}
