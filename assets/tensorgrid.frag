#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D	u_volume;	// the values, one float per voxel
uniform float		u_range;	// the magnitude which gets the full colour
uniform vec3		u_dims;		// voxels along each axis; x and y are a slice, z counts the slices
uniform vec2		u_viewport;
uniform float		u_scale;
uniform vec2		u_offset;
uniform vec2		u_size;		// size of the whole grid, in texels
uniform float		u_gap;		// texels between slices
uniform int			u_vertical;	// slices are stacked (1), or set side by side (0)
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

const vec4	GAP		= vec4(0,0,0,0);//vec3(110.0 / 255.0), 1.0);

// All the slices of the stack in a line, with a gap between them, panned and zoomed like a bitmap.
void main() {
	vec2 frag	= vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
	fragColor	= background(frag);

	vec2 texel	= (frag - u_offset) / u_scale;	// texel coordinates in top-left space
	if (texel.x < 0.0 || texel.y < 0.0 || texel.x >= u_size.x || texel.y >= u_size.y)
		return;

	bool vertical	= u_vertical != 0;
	float length_	= vertical ? u_dims.y : u_dims.x;	// of a slice, along the line
	float along		= vertical ? texel.y : texel.x;
	float pitch		= length_ + u_gap;
	float z			= min(floor(along / pitch), u_dims.z - 1.0);
	float inside	= along - z * pitch;
	if (inside < length_) {
		ivec2 xy = ivec2(vertical ? vec2(texel.x, inside) : vec2(inside, texel.y));
		fragColor = colour(xy.x, xy.y, int(z));
	}
}
