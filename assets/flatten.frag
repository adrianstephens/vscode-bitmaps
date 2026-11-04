#version 300 es
// The passes of Flatten (see raster.ts's flattenWith), by u_mode:
//   0  smoothing without crossing edges: each pixel the mean of the 5 x 5 round it, weighted by how near its colour is (a bilateral filter)
//   1  each pixel's label: the 1-based index of the nearest of u_count colours (u_centres, as r g b, 0..255), or 0 where it is transparent
//   2  tidied: the commonest label of the 5 x 5 round it, which takes out specks and ragged edges
//   3  the picture: each label as its colour, with the picture's own transparency (and its own pixel where it has none)
// Labels are kept in the red of a float target (which holds them exactly). The pixel drawn at gl_FragCoord (i + 0.5, j + 0.5) is row j,
// column i, of what is read back.
precision highp float;
precision highp int;
uniform sampler2D	u_image;
uniform sampler2D	u_original;
uniform ivec2		u_origin;		// where this pass's own (0, 0) is in u_image
uniform ivec2		u_originalAt;	// where it is in u_original
uniform int			u_mode;
uniform int			u_count;
uniform float		u_centres[192];
out vec4			fragColor;

void main() {
	ivec2 size	= textureSize(u_image, 0);
	ivec2 at	= u_origin + ivec2(gl_FragCoord.xy);
	vec4 here	= texelFetch(u_image, at, 0);

	if (u_mode == 0) {
		vec3 c	= here.rgb * 255.0;
		vec3 sum = vec3(0.0);
		float total = 0.0;
		for (int j = -2; j <= 2; j++) {
			for (int i = -2; i <= 2; i++) {
				vec3 d	= texelFetch(u_image, clamp(at + ivec2(i, j), ivec2(0), size - 1), 0).rgb * 255.0;
				vec3 e	= d - c;
				float w	= exp(-dot(e, e) / (2.0 * 28.0 * 28.0));
				sum		+= d * w;
				total	+= w;
			}
		}
		fragColor = vec4(sum / total / 255.0, here.a);
	} else if (u_mode == 1) {
		float best = 0.0;
		if (here.a >= 0.5) {
			vec3 c = here.rgb * 255.0;
			float nearest = 1e30;
			for (int k = 0; k < u_count; k++) {
				vec3 e = c - vec3(u_centres[k * 3], u_centres[k * 3 + 1], u_centres[k * 3 + 2]);
				float d = dot(e, e);
				if (d < nearest) {
					nearest = d;
					best = float(k + 1);
				}
			}
		}
		fragColor = vec4(best, 0.0, 0.0, here.a);
	} else if (u_mode == 2) {
		float labels[25];
		for (int j = 0; j < 5; j++)
			for (int i = 0; i < 5; i++)
				labels[j * 5 + i] = texelFetch(u_image, clamp(at + ivec2(i - 2, j - 2), ivec2(0), size - 1), 0).r;
		float pick = here.r;
		if (pick > 0.0) {
			int most = 0;
			for (int a = 0; a < 25; a++) {
				if (labels[a] == 0.0)
					continue;
				int n = 0;
				for (int b = 0; b < 25; b++)
					n += labels[b] == labels[a] ? 1 : 0;
				// (the commonest; of equals, the pixel's own, else the lowest)
				if (n > most || n == most && (labels[a] == here.r || labels[a] < pick && pick != here.r)) {
					most = n;
					pick = labels[a];
				}
			}
		}
		fragColor = vec4(pick, 0.0, 0.0, here.a);
	} else {
		int k = int(here.r) - 1;
		vec4 original = texelFetch(u_original, u_originalAt + ivec2(gl_FragCoord.xy), 0);
		fragColor = k < 0 ? original : vec4(vec3(u_centres[k * 3], u_centres[k * 3 + 1], u_centres[k * 3 + 2]) / 255.0, original.a);
	}
}
