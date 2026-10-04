#version 300 es
precision highp float;
// The mesh viewer's background and floor: full-screen passes, the floor giving each pixel the depth of where its ray
// meets the plane z = 0, so it hides what is under it and is hidden by what stands in front of it
in vec2			v_ndc;
uniform vec3	u_half;			// half the size of the box the model is in
uniform vec3	u_origin;		// the camera
uniform mat3	u_basis;		// its right, up and back axes
uniform float	u_fovy;
uniform float	u_aspect;
uniform mat4	u_viewProj;
uniform float	u_floor;		// 0 the background, 1 the floor
out vec4		fragColor;

//@floor

void main() {
	vec3 rd = normalize(u_basis * vec3(v_ndc.x * u_aspect / u_fovy, v_ndc.y / u_fovy, -1.0));
	if (u_floor < 0.5) {
		fragColor = vec4(background(rd), 1.0);
		return;
	}
	vec3	at;
	float	t = floorHit(u_origin, rd, at);
	if (t <= 0.0)
		discard;
	vec4	clip	= u_viewProj * vec4(at, 1.0);
	gl_FragDepth	= clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
	float	w		= t * u_pixel;
	float	fade	= floorFade(t);
	// a little of what is under the floor shows through it, as the scad viewer lets it
	vec3	colour	= withAxisLabels(floorColour(floorGrid(at.xy, w)) * floorLight(), at, w, 1.0);
	float	alpha	= fade * 0.9;
	fragColor = vec4(colour * alpha, alpha);
}
