#version 300 es
// A mesh, or its lines, placed by its instance's transform and seen by the camera
in vec3		a_position;
in vec3		a_normal;	// zero where the file gives none, and the face's own is used
in vec4		a_color;
in vec2		a_uv;
in float	a_face;		// the face of the mesh this corner is of, for the picker
in float	a_edges;	// which sides of this corner's triangle are edges of the file's face (bits 0, 1, 2: v0-v1, v1-v2, v2-v0)
uniform mat4	u_model;
uniform mat4	u_viewProj;
out vec3		v_world;
out vec3		v_normal;
out vec4		v_color;
out vec2		v_uv;
flat out float	v_face;
flat out float	v_edges;
out vec3		v_bary;

void main() {
	vec4 world	= u_model * vec4(a_position, 1.0);
	v_world		= world.xyz;
	// the transforms here are rotations, scales and mirrors, so the inverse transpose is what turns a normal
	v_normal	= transpose(inverse(mat3(u_model))) * a_normal;
	v_color		= a_color;
	v_uv		= a_uv;
	v_face		= a_face;
	v_edges		= a_edges;
	// the corners are not indexed, so which corner of its triangle this is comes from the vertex number
	int k		= gl_VertexID % 3;
	v_bary		= vec3(k == 0, k == 1, k == 2);
	gl_Position	= u_viewProj * world;
}
