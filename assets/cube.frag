#version 300 es
precision highp float;
in vec3 v_direction;
uniform samplerCube u_texture;
uniform float		u_size;
out vec4 fragColor;

float oblate(vec2 uv, float p) {
	vec2 dist = pow(fract(uv) - 0.5, vec2(p));
	return pow(dist.x + dist.y, 1.0 / p);
}
float disc(float dist, float radius, float edge) {
	return smoothstep(radius + edge, radius - edge, dist);
}

void main() {
	// 1. Project 3D vector to 2D UV of the active face
	vec3 absDir = abs(v_direction);
	float maxAxis = max(absDir.x, max(absDir.y, absDir.z));
	vec2 uv = absDir.x == maxAxis ? v_direction.zy / v_direction.x 
			: absDir.y == maxAxis ? v_direction.xz / v_direction.y
			: v_direction.xy / v_direction.z;

	uv = (uv * 0.5 + 0.5) * u_size; // Map from [-1, 1] to [0, u_size]

	// 3. Draw circles: Distance from center of the "texel"
	float dist = oblate(fract(uv) - 0.5, 4.0);
	float d = length(fwidth(uv));
	float t = smoothstep(0.5, 0.25, d);
	float circleMask = mix(1.0, disc(dist, 0.5, d), t);

	// 4. Explicit lookup at the center of the texel to avoid bleeding
	vec3 snappedDir = floor(v_direction * u_size + 0.5) / u_size;
	vec4 texColor	= textureLod(u_texture, snappedDir, 0.0);

	fragColor = texColor * circleMask;
//	fragColor = texture(u_texture, normalize(v_direction));
}
