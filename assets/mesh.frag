#version 300 es
precision highp float;
in vec3			v_world;
in vec3			v_normal;
in vec4			v_color;
in vec2			v_uv;
flat in float	v_face;
uniform vec3	u_origin;		// the camera
uniform mat3	u_basis;		// its right, up and back axes
uniform float	u_lit;			// 0 for lines, which are drawn as they are coloured
uniform float	u_textured;
uniform sampler2D u_texture;
uniform float	u_pick;			// 0 the picture; 1 position and instance; 2 face; 3 colour
uniform float	u_instance;
uniform float	u_mirrored;		// 1 when the instance's transform turns the winding inside out
out vec4		fragColor;

void main() {
	if (u_pick > 1.5 && u_pick < 2.5) {
		fragColor = vec4(v_face, 0.0, 0.0, 1.0);
		return;
	}
	if (u_pick > 0.5 && u_pick < 1.5) {
		fragColor = vec4(v_world, u_instance);
		return;
	}
	vec4 base = v_color;
	// a texture coordinate's v runs up the image (OBJ's, 3MF's and PLY's alike), and the image's first row is its top
	if (u_textured > 0.5)
		base *= texture(u_texture, vec2(v_uv.x, 1.0 - v_uv.y));
	if (u_pick > 2.5) {
		fragColor = base;
		return;
	}
	if (u_lit < 0.5) {
		fragColor = vec4(base.rgb * base.a, base.a);
		return;
	}
	// the file's normal where it has one, else the face's own from how the position changes across the pixel
	vec3 view	= normalize(u_origin - v_world);
	vec3 n		= dot(v_normal, v_normal) > 0.25 ? normalize(v_normal) : normalize(cross(dFdx(v_world), dFdy(v_world)));
	if (dot(n, view) < 0.0)
		n = -n;
	// a face seen from behind -- the inside of a solid, or a face wound the wrong way -- is tinted, so it shows
	bool back	= gl_FrontFacing == (u_mirrored > 0.5);
	if (back)
		base.rgb = mix(base.rgb, vec3(0.75, 0.25, 0.2), 0.45);

	// two lights in the camera's own frame, so the model stays lit as it is turned, as the scad viewer has them
	vec3	key		= normalize(u_basis * vec3(-0.4, 0.6, 0.7));
	vec3	fill	= normalize(u_basis * vec3(0.7, -0.2, 0.5));
	float	diffuse	= 0.25 + 0.85 * (max(dot(n, key), 0.0) + 0.35 * max(dot(n, fill), 0.0));
	float	spec	= 0.25 * pow(max(dot(n, normalize(key + view)), 0.0), 40.0);
	vec3	colour	= base.rgb * diffuse + vec3(spec);
	fragColor = vec4(colour * base.a, base.a);
}
