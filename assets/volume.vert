#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
uniform float u_size;
uniform float u_flatten;
out vec3 v_world;
flat out mat3 v_hullInverse;

// Unfolding moves each slice (a one voxel thick slab of spheres) rigidly:
//	slice k (centre z_k in [-1,1]) is translated by z_k * (0, flatten * size, -flatten)
// so at flatten=1 the slices are stacked in y (2 units apart) all on the z=0 plane.
// volume.frag traces the spheres exactly; this draws a parallelepiped bounding the moved slabs.
// The slab centres lie on the segment +/- (0, shift, thickness); the parallelepiped has sides along that
// segment and along y or z (whichever is more perpendicular to it), and is the unit cube when flatten=0.

void main() {
	float r			= 1.0 / u_size;								// sphere radius
	float shift		= max(u_flatten * (u_size - 1.0), 1e-5);	// y offset of the outermost slab centres
	float thick		= max((1.0 - u_flatten) * (1.0 - r), 1e-5);	// z offset of the outermost slab centres

	mat3 hull = mat3(1.0);	// unit cube -> world
	if (u_flatten <= 0.0) {
		// not unfolded: the cube itself
	} else if (shift >= thick) {
		float s		= 1.0 + 1.0 / shift;
		hull		= mat3(vec3(1, 0, 0), vec3(0, s * shift, s * thick), vec3(0, 0, r + thick / shift));
	} else {
		float s		= 1.0 + r / thick;
		hull		= mat3(vec3(1, 0, 0), vec3(0, s * shift, s * thick), vec3(0, 1.0 + r * shift / thick, 0));
	}

	vec3 world		= hull * a_position;
	v_world			= world;
	v_hullInverse	= inverse(hull);
	gl_Position		= u_mvp * vec4(world, 1.0);
}
