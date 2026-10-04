#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D	u_volume;	// the texels of the source band the pass draws
uniform vec3		u_dims;		// source texels in the band: x and y are the rows it holds, z the slices of it
uniform vec2		u_scale;	// output texels per source texel of the slice
uniform vec2		u_offset;	// the band's first source texel, in output texel space
uniform int			u_layer;	// the slice of the band (a stack's band holds one, so 0)
out float fragColor;

void main() {
	vec2	frag	= gl_FragCoord.xy;	// the centre of the fragment, in top-left texel space of the output

	// shrunk: the fragment covers several source texels and shows the one of largest magnitude among them, so that a strong value is not lost as the view zooms out. The maximum is by
	// magnitude (as sampleMatrix does when reducing): for diverging data a large negative is as strong as a large positive, and its sign keeps its colour. NaN counts as empty.
	vec2	lo = (frag - u_offset - vec2(0.5)) / u_scale;				// the fragment's corners in top-left texel space
	vec2	hi = (frag - u_offset + vec2(0.5)) / u_scale;
	ivec2	a = max(ivec2(floor(lo)), ivec2(0));						// of the source texels it spans: those between its corners, clamped to the band
	ivec2	b = min(ivec2(ceil(hi)), ivec2(int(u_dims.x), int(u_dims.y)));

	float	best = 0.0;
	for (int y = a.y; y < b.y; ++y) {
		for (int x = a.x; x < b.x; ++x) {
			float raw = texelFetch(u_volume, ivec3(x, y, u_layer), 0).r;
			if (abs(raw) > abs(best))
				best	= raw;
		}
	}

	fragColor = best;
}
