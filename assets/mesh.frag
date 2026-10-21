#version 300 es
precision highp float;
in vec3			v_world;
in vec3			v_normal;
in vec4			v_color;
in vec2			v_uv;
flat in float	v_face;
flat in float	v_edges;
in vec3			v_bary;
uniform vec3	u_origin;		// the camera
uniform mat3	u_basis;		// its right, up and back axes
uniform float	u_lit;			// 0 for lines, which are drawn as they are coloured
uniform float	u_textured;
uniform sampler2D u_texture;
uniform float	u_pick;			// 0 the picture; 1 position and instance; 2 face; 3 colour
uniform float	u_instance;
uniform float	u_shade;		// 0 smooth (the file's normals), 1 flat (each face's own), 2 unlit
uniform float	u_wire;			// 0 solid, 1 solid with the edges drawn over it, 2 the edges alone
uniform float	u_plain;		// 1 to ignore the file's colours and textures
uniform float	u_backs;		// 0 tint faces seen from behind, 1 draw them as they are
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
	vec4 base = u_plain > 0.5 ? vec4(0.72, 0.76, 0.82, 1.0) : v_color;
	// a texture coordinate's v runs up the image (OBJ's, 3MF's and PLY's alike), and the image's first row is its top
	if (u_textured > 0.5 && u_plain < 0.5)
		base *= texture(u_texture, vec2(v_uv.x, 1.0 - v_uv.y));
	if (u_pick > 2.5) {
		fragColor = base;
		return;
	}
	// how near this pixel is to one of the face's edges, in pixels (a triangulated face's inner sides do not count)
	float edge = 0.0;
	if (u_wire > 0.5 && u_lit > 0.5) {
		int bits	= int(v_edges + 0.5);
		vec3 d		= v_bary / max(sqrt(dFdx(v_bary) * dFdx(v_bary) + dFdy(v_bary) * dFdy(v_bary)), 1e-6);
		float m		= 1e3;
		// the side opposite corner 2 is v0-v1, opposite 0 is v1-v2, opposite 1 is v2-v0
		if ((bits & 1) != 0) m = min(m, d.z);
		if ((bits & 2) != 0) m = min(m, d.x);
		if ((bits & 4) != 0) m = min(m, d.y);
		edge = 1.0 - smoothstep(0.0, 2.0, m);
		if (u_wire > 1.5 && edge < 0.02)
			discard;
	}
	if (u_lit < 0.5 || u_shade > 1.5 || u_wire > 1.5) {
		vec3 c = u_wire > 1.5 ? base.rgb * 1.15 : base.rgb;
		if (u_wire < 1.5 && u_lit > 0.5 && u_wire > 0.5)
			c = mix(c, vec3(0.03, 0.04, 0.06), edge * 0.85);
		// the wireframe alone is as opaque as the edge is near, so its lines blend into what is behind
		float a = u_wire > 1.5 && u_lit > 0.5 ? base.a * edge : base.a;
		fragColor = vec4(c * a, a);
		return;
	}
	// the file's normal where it has one, else the face's own from how the position changes across the pixel
	vec3 view	= normalize(u_origin - v_world);
	vec3 n		= u_shade < 0.5 && dot(v_normal, v_normal) > 0.25 ? normalize(v_normal) : normalize(cross(dFdx(v_world), dFdy(v_world)));
	if (dot(n, view) < 0.0)
		n = -n;
	// a face seen from behind -- the inside of a solid, or a face wound the wrong way -- is tinted, so it shows
	bool back	= gl_FrontFacing == (u_mirrored > 0.5);
	if (back && u_backs < 0.5)
		base.rgb = mix(base.rgb, vec3(0.75, 0.25, 0.2), 0.45);

	// two lights in the camera's own frame, so the model stays lit as it is turned, as the scad viewer has them
	vec3	key		= normalize(u_basis * vec3(-0.4, 0.6, 0.7));
	vec3	fill	= normalize(u_basis * vec3(0.7, -0.2, 0.5));
	float	diffuse	= 0.25 + 0.85 * (max(dot(n, key), 0.0) + 0.35 * max(dot(n, fill), 0.0));
	float	spec	= 0.25 * pow(max(dot(n, normalize(key + view)), 0.0), 40.0);
	vec3	colour	= base.rgb * diffuse + vec3(spec);
	colour = mix(colour, vec3(0.03, 0.04, 0.06), edge * 0.85);
	fragColor = vec4(colour * base.a, base.a);
}
