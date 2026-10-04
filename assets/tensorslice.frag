#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D	u_volume;	// the values, one float per voxel
uniform float		u_range;	// the magnitude which gets the full colour
uniform vec3		u_dims;		// voxels along each axis; x and y are a slice, z counts the slices
uniform vec2		u_viewport;
uniform float		u_scale;
uniform vec2		u_offset;
uniform int			u_layer;		// the slice shown
out vec4			fragColor;

const vec3	MID		= vec3(40.0) / 255.0;
const vec3	WARM	= vec3(255.0, 90.0, 60.0) / 255.0;
const vec3	COOL	= vec3(60.0, 150.0, 255.0) / 255.0;

vec4 background(vec2 frag) {
	ivec2 grid	= ivec2(floor(frag / 64.0));
	int checker = (grid.x + grid.y) & 1;
	return checker == 0
		? vec4(0.24, 0.24, 0.24, 1.0)
		: vec4(0.12, 0.12, 0.12, 1.0);
}

// diverging colours: zero is dark grey, positive values warm, negative cool, NaN magenta (tensor.frag does the same for the volume)
vec4 colour(int x, int y, int z) {
	float raw = texelFetch(u_volume, ivec3(x, y, z), 0).r;
	if (isnan(raw))
		return vec4(1.0, 0.0, 1.0, 1.0);
	float v = clamp(raw / u_range, -1.0, 1.0);	// sqrt lifts the many small values so structure shows
	return vec4(mix(MID, v >= 0.0 ? WARM : COOL, sqrt(abs(v))), 1.0);
}

// One slice of the stack, panned and zoomed like a bitmap.
void main() {
	vec2 frag	= vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor	= background(frag);

	vec2 texel	= (frag - u_offset) / u_scale;	// texel coordinates in top-left space
	if (texel.x >= 0.0 && texel.y >= 0.0 && texel.x < u_dims.x && texel.y < u_dims.y)
		fragColor = colour(int(texel.x), int(texel.y), u_layer);
}
