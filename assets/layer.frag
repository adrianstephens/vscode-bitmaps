#version 300 es
precision highp float;
uniform sampler2D	u_texture;
uniform sampler2D	u_mask;			// the layer's mask, one channel
uniform sampler2D	u_base;			// the layer it is clipped to
uniform vec2		u_size;			// of the layer in pixels
uniform vec2		u_origin;		// where its first pixel is on the canvas
uniform vec4		u_maskRect;		// where the mask is, on the canvas: left, top, width, height
uniform vec3		u_maskParams;	// what it is outside there (0..1), whether it is inverted, whether there is one
uniform vec4		u_baseRect;		// where the layer it is clipped to is (its width is 0 if there is none)
uniform float		u_edge;			// the width of its outline, in its own pixels
uniform float		u_opacity;		// how much of the layer shows (0..1): its opacity, which is nothing if it is hidden
uniform float		u_floor;		// the least of it that shows of what its mask and clipping take away, and its opacity
uniform float		u_veil;			// how much of a veil is over the layer
uniform vec4		u_outline;		// premultiplied
in vec2				v_uv;
out vec4			fragColor;

void main() {
	vec4 colour	= texture(u_texture, v_uv);
	colour		= vec4(colour.rgb * colour.a, colour.a);

	// How much of it the picture would show, as the opacity, the mask and what it is clipped to leave of it: this is
	// kept, but not down to nothing, so that what they take away can still be seen
	vec2 canvas	= u_origin + floor(v_uv * u_size);
	float shown	= u_opacity;
	if (u_maskParams.z > 0.5) {
		ivec2 m		= ivec2(canvas - u_maskRect.xy);
		float mask	= any(lessThan(m, ivec2(0))) || any(greaterThanEqual(m, ivec2(u_maskRect.zw))) ? u_maskParams.x : texelFetch(u_mask, m, 0).r;
		shown		*= u_maskParams.y > 0.5 ? 1.0 - mask : mask;
	}
	if (u_baseRect.z > 0.0) {
		ivec2 q		= ivec2(canvas - u_baseRect.xy);
		shown		*= any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(u_baseRect.zw))) ? 0.0 : texelFetch(u_base, q, 0).a;
	}
	colour		*= u_floor + (1.0 - u_floor) * shown;

	// a faint veil, so that a layer with little in it still shows where it is
	colour		= colour + vec4(u_veil) * (1.0 - colour.a);

	vec2 d		= min(v_uv, 1.0 - v_uv) * u_size;
	if (min(d.x, d.y) < u_edge)
		colour	= u_outline + colour * (1.0 - u_outline.a);
	fragColor	= colour;
}
