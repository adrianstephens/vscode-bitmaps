#version 300 es
precision highp float;
uniform sampler2D	u_texture;
uniform vec2		u_size;			// of the layer in pixels
uniform float		u_edge;			// the width of its outline, in its own pixels
uniform float		u_opacity;
uniform float		u_veil;			// how much of a veil is over the layer
uniform vec4		u_outline;		// premultiplied
in vec2				v_uv;
out vec4			fragColor;

void main() {
	vec4 colour	= texture(u_texture, v_uv);
	colour		= vec4(colour.rgb * colour.a, colour.a) * u_opacity;
	// a faint veil, so that a layer with little in it still shows where it is
	colour		= colour + vec4(u_veil) * (1.0 - colour.a);

	vec2 d		= min(v_uv, 1.0 - v_uv) * u_size;
	if (min(d.x, d.y) < u_edge)
		colour	= u_outline + colour * (1.0 - u_outline.a);
	fragColor	= colour;
}
