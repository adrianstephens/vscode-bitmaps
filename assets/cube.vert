#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform mat4	u_mvp;
uniform float	u_flatten;
out vec3 v_direction;

vec2 faceUV(int face, vec3 pos) {
	return	face == 0 ? vec2(-pos.z, -pos.y)	// +X
		:	face == 1 ? vec2( pos.z, -pos.y)   	// -X
		:	face == 2 ? vec2( pos.x,  pos.z)   	// +Y
		:	face == 3 ? vec2( pos.x, -pos.z)   	// -Y
		:	face == 4 ? vec2( pos.x, -pos.y)   	// +Z
		:				vec2(-pos.x, -pos.y);  	// -Z
}

const vec2 faceOffset[] = vec2[](
	vec2( 2.0,  0.0), // +X
	vec2(-2.0,  0.0), // -X
	vec2( 2.0,  2.0), // +Y
	vec2( 2.0, -2.0), // -Y
	vec2( 0.0,  0.0), // +Z
	vec2( 4.0,  0.0)  // -Z
);

struct FaceRot {
	vec3 axis;
	vec3 pivot;
};
const FaceRot faceAxis[] = FaceRot[](
	FaceRot(vec3( 0.0, -1.0, 0.0), vec3( 1.0,  0.0, 1.0)), // +X
	FaceRot(vec3( 0.0,  1.0, 0.0), vec3(-1.0,  0.0, 1.0)), // -X
	FaceRot(vec3( 1.0,  0.0, 0.0), vec3( 0.0,  1.0, 1.0)), // +Y
	FaceRot(vec3(-1.0,  0.0, 0.0), vec3( 0.0, -1.0, 1.0))	// -Y
);

vec3 rotateAroundAxis(vec3 p, vec3 axis, float angle) {
    vec3 n = normalize(axis);
    float c = cos(angle);
    float s = sin(angle);
    float d = dot(n, p);
    return p * c + cross(n, p) * s + n * d * (1.0 - c);
}

void main() {
	int face = gl_VertexID / 6;
	vec3 worldPos = a_position;

	float angle = radians(90.0) * u_flatten;
	if (face < 4) {
		vec3 pivot = faceAxis[face].pivot;
		vec3 axis = faceAxis[face].axis;
		worldPos = rotateAroundAxis(worldPos - pivot, axis, angle) + pivot;
	} else if (face == 5) {
        vec3 pivot = vec3(2.0, 0.0, 0.0);
        worldPos = rotateAroundAxis(worldPos - pivot, vec3(0.0, -1.0, 0.0), angle * 2.0) + pivot;
	}


	v_direction = a_position; // keep cube direction for cubemap lookup
	gl_Position = u_mvp * vec4(worldPos, 1.0);
}