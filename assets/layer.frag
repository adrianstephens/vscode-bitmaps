#version 300 es
precision highp float;
uniform sampler2D	u_texture;
uniform sampler2D	u_mask;			// the layer's mask, one channel
uniform sampler2D	u_base;			// the layer it is clipped to
uniform vec2		u_size;			// of the layer in pixels
uniform vec2		u_origin;		// where its first pixel is on the canvas
uniform vec4		u_maskRect;		// where the mask is, on the canvas: left, top, width, height
uniform vec4		u_maskParams;	// what it is outside there (0..1), whether it is inverted, whether there is one, and its density (0..1)
uniform sampler2D	u_vmask;		// its vector mask, drawn, in the same way
uniform vec4		u_vmaskRect;
uniform vec4		u_vmaskParams;
uniform int			u_view;			// 0: the layer; 1: what its masks hide, under a red veil; 2: its masks alone, in grey
uniform vec4		u_baseRect;		// where the layer it is clipped to is (its width is 0 if there is none)
uniform float		u_edge;			// the width of its outline, in its own pixels
uniform float		u_opacity;		// how much of the layer shows (0..1): its opacity, which is nothing if it is hidden
uniform float		u_floor;		// the least of it that shows of what its mask and clipping take away, and its opacity
uniform float		u_veil;			// how much of a veil is over the layer
uniform vec4		u_outline;		// premultiplied
uniform vec2		u_clipSize;		// what lies outside this, from the corner at 0, is not drawn (nothing is clipped if it is 0)
in vec2				v_uv;
in vec3				v_clip;
out vec4			fragColor;

// how much of the layer a mask leaves at a pixel of the canvas: inverted if it says so, and what it hides made less by its density
float masked(sampler2D mask, vec2 canvas, vec4 rect, vec4 params) {
	if (params.z < 0.5)
		return 1.0;
	ivec2 m	= ivec2(canvas - rect.xy);
	float v	= any(lessThan(m, ivec2(0))) || any(greaterThanEqual(m, ivec2(rect.zw))) ? params.x : texelFetch(mask, m, 0).r;
	return 1.0 - (1.0 - (params.y > 0.5 ? 1.0 - v : v)) * params.w;
}

void main() {
	if (u_clipSize.x > 0.0) {
		vec2 q = v_clip.xy / v_clip.z;
		if (v_clip.z <= 0.0 || any(lessThan(q, vec2(0.0))) || any(greaterThan(q, u_clipSize)))
			discard;
	}
	vec4 colour	= texture(u_texture, v_uv);
	colour		= vec4(colour.rgb * colour.a, colour.a);

	// How much of it the picture would show, as the opacity, the mask and what it is clipped to leave of it: this is
	// kept, but not down to nothing, so that what they take away can still be seen
	vec2 canvas	= u_origin + floor(v_uv * u_size);
	float masks	= masked(u_mask, canvas, u_maskRect, u_maskParams) * masked(u_vmask, canvas, u_vmaskRect, u_vmaskParams);
	if (u_view == 1) {
		fragColor = vec4(1.0, 0.0, 0.0, 1.0) * 0.5 * (1.0 - masks);	// (premultiplied)
		return;
	}
	if (u_view == 2) {
		fragColor = vec4(vec3(masks), 1.0);
		return;
	}
	float shown	= u_opacity * masks;
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
