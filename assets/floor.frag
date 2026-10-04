// The floor both 3D viewers draw: the grid and its levels, the haze that dissolves it, where a ray meets it, the
// background, and the numbers along its axes. Spliced into a shader at its //@floor marker; the shader declares
// u_half (half the model's box), u_origin (the camera) and u_basis (its axes), which these read.
uniform float	u_pixel;	// the world size of a pixel one unit of distance from the camera, for the grid's own width
uniform float	u_labelPixel;	// the same for a pixel of the *display*, which is smaller than u_pixel while the view is moving and drawn small
uniform highp sampler2D u_glyphs;	// signed-distance atlas of the characters a number is spelled with (see fonts.ts's digitAtlas)
uniform vec4	u_glyphCell;	// em position of a cell's left and bottom edge, and its width and height in ems
uniform vec4	u_glyphInfo;	// em advance of a cell, em distance a texel saturates at, number of cells (0: no numbers), em height of a digit

// How much of a line of a grid of spacing s covers this point: 1 on a line, 0 between them. w is half the width a
// line should have here, which the caller works out from how far away the floor was hit -- without it a grid aliases
// into moire at any distance, and the lines get fainter as they get further away because they are drawn wider.
float gridLine(vec2 p, float s, float w) {
	vec2 g = abs(fract(p / s - 0.5) - 0.5) * s;
	return 1.0 - smoothstep(0.0, w, min(g.x, g.y));
}

// Three levels of grid, in the model's own units, which are mm. Each fades out once its spacing is down to the size
// of a pixel: a 1mm grid over a 90mm model is a moire pattern at a glance, so it is drawn only where it can be seen.
// The fade and the weight of a level are defined once, here, because the numbers beside the axes belong to the same
// levels and must come and go exactly as their lines do.
float gridLevelSpacing(int level) {
	return pow(10.0, float(level));
}
// A level is drawn while its lines are far enough apart to be resolved: below about two pixels of spacing they
// cannot be, and that is the moire. Written as pixels of spacing rather than as a width, because it is the spacing
// that aliases -- a line thinner than a pixel is only fainter, its width being a fraction of the spacing with a floor
// of one pixel, so the two come to the same test.
float gridLevelFade(float s, float w) {
	return smoothstep(2.0, 6.0, s / w);
}
// How strongly a level is drawn: the finer the level, the fainter, so the coarse lines read as the structure.
float gridLevelWeight(int level) {
	return level == 0 ? 0.35 : level == 1 ? 0.65 : 1.0;
}
// All the levels' lines together, each at its own fade and weight.
float floorGrid(vec2 p, float w) {
	float lines = 0.0;
	for (int i = 0; i < 3; i++) {
		float s = gridLevelSpacing(i);
		lines = max(lines, gridLine(p, s, min(w * 0.9 + s * 0.002, s * 0.15)) * gridLevelFade(s, w) * gridLevelWeight(i));
	}
	return lines;
}

// How much of the floor is still itself this far along the ray: what recedes into the air, rather than what is far
// from the model. Fading by the radius in the plane put a fixed circle of haze around the model, which is not what
// haze does -- it has to move with the view. The form is the exponential that 1/z approximates, which does not need
// clamping to reach the background, with a near plane so the ground the model stands on stays clear. Both distances
// are in the model's own size, so it suits a part and a tray alike.
float floorFade(float dist) {
	float scale = max(max(u_half.x, u_half.y), u_half.z);
	return exp(-max(0.0, dist - scale * 1.5) / (scale * 3.0));
}

// Where a ray meets the floor, or -1. The floor is the plane z = 0, wherever the model is: it is where the file's own
// origin is, not a stand the model is put on. It is the whole plane: what limits it is floorFade, which dissolves it
// into the background.
float floorHit(vec3 ro, vec3 rd, out vec3 at) {
	at = vec3(0.0);
	if (abs(rd.z) < 1e-6)
		return -1.0;
	float t = -ro.z / rd.z;
	if (t <= 0.0)
		return -1.0;
	at = ro + rd * t;
	return t;
}

// What is seen in a direction that hits nothing: a soft wash, so an empty view still reads as a 3d view rather than a
// failure. It varies with the direction rather than the screen, so a reflected or refracted ray sees a horizon.
vec3 background(vec3 rd) {
	return mix(vec3(0.10, 0.11, 0.13), vec3(0.22, 0.24, 0.28), clamp(rd.z * 0.5 + 0.5, 0.0, 1.0));
}

// Numbers along the floor's x and y axes, read from a distance atlas of the characters rather than drawn from their
// outlines: the cost is a comparison per floor pixel away from the axes, and in the narrow band beside them a couple
// of texture fetches per pixel. Cells are one em advance wide, so a run of characters is laid out by index alone.

// The signed distance in ems (negative inside) from q, a point in ems from the origin of the character in cell g, to
// its outline. Sampled at an explicit level: this is reached from inside branches that not every pixel takes, where
// the implicit derivatives an ordinary lookup would need are undefined.
float glyphDistance(int g, vec2 q) {
	q.x = clamp(q.x, u_glyphCell.x, u_glyphCell.x + u_glyphCell.z);
	vec2 uv = vec2((float(g) + (q.x - u_glyphCell.x) / u_glyphCell.z) / u_glyphInfo.z, (q.y - u_glyphCell.y) / u_glyphCell.w);
	return (0.5 - textureLod(u_glyphs, uv, 0.0).r) * 2.0 * u_glyphInfo.y;
}

// How many characters an integer takes to spell.
int labelLength(int value) {
	int a = abs(value);
	return (a >= 10000 ? 5 : a >= 1000 ? 4 : a >= 100 ? 3 : a >= 10 ? 2 : 1) + (value < 0 ? 1 : 0);
}

// The character in slot k of the integer's spelling: cell 10 is the minus sign, cells 0-9 the digits.
int labelCell(int value, int k) {
	if (value < 0) {
		if (k == 0)
			return 10;
		k--;
	}
	int a = abs(value);
	int digits = labelLength(a);
	int scale = 1;
	for (int i = 0; i < 4; i++)
		if (i < digits - 1 - k)
			scale *= 10;
	return (a / scale) % 10;
}

// How much of the integer's spelling covers a point q, in ems from the left end of the text at its baseline, as
// (fill, halo). pixel is the size of a pixel in ems. Each point can only be near the character it falls in or the
// one beside it, so those two are all that is looked up.
vec2 labelCoverage(int value, vec2 q, float pixel) {
	float pitch = u_glyphInfo.x;
	int n = labelLength(value);
	int slot = int(floor(q.x / pitch));
	int other = slot + (q.x / pitch - float(slot) < 0.5 ? -1 : 1);
	float d = 1.0;
	for (int i = 0; i < 2; i++) {
		int k = i == 0 ? slot : other;
		if (k >= 0 && k < n)
			d = min(d, glyphDistance(labelCell(value, k), vec2(q.x - float(k) * pitch, q.y)));
	}
	return vec2(clamp(0.5 - d / pixel, 0.0, 1.0), clamp(0.5 - (d - 0.07) / pixel, 0.0, 1.0));
}

// The size of a pixel at a point on the floor, in the model's units: what the grid's own fade is measured against,
// worked out for a label's anchor rather than for each pixel, so a label is one size and fades as one piece.
float pixelAt(vec3 anchor) {
	return length(anchor - u_origin) * u_pixel;
}
// The same for a pixel of the display rather than of this drawing: while the view moves the page is drawn at half
// size, and a label sized in drawing pixels would double on screen for as long as it did. The fade is measured in
// drawing pixels, as the grid's is, so that the numbers and their lines still come and go together.
float displayPixelAt(vec3 anchor) {
	return length(anchor - u_origin) * u_labelPixel;
}

// (fill, halo) of one grid level's numbers at a point of the floor: every step along x is written under the x axis,
// centred on its tick, and every step along y to the left of the y axis, right-aligned against it and centred on its
// tick. A tick that a coarser level already numbers is left to it. A level's numbers fade and weigh exactly as its
// lines do (the same gridLevelFade and gridLevelWeight, measured at the label's anchor). Their size is a fraction of
// the spacing, so they scale with the grid squares they belong to -- but never past a comfortable size on the screen,
// or the coarse levels' numbers would fill the view once the camera is close. w is the size of a pixel here.
vec2 levelLabels(vec3 at, float w, int level) {
	vec2 p = at.xy;
	float stepSize = gridLevelSpacing(level);
	float weight = gridLevelWeight(level);
	bool coarsest = level == 2;
	float emMax = stepSize * 0.4;
	float reach = emMax * (0.3 + u_glyphInfo.w + u_glyphInfo.y);		// the furthest from an axis any number of this level reaches
	int unit = int(stepSize + 0.5);
	vec2 result = vec2(0.0);

	if (p.y < u_glyphInfo.y * emMax && p.y > -reach) {
		float i = floor(p.x / stepSize + 0.5);
		int value = int(i) * unit;
		if (abs(i) <= 60.0 && (coarsest || (value != 0 && value % (unit * 10) != 0))) {
			vec3 anchor = vec3(i * stepSize, 0.0, at.z);
			float alpha = gridLevelFade(stepSize, pixelAt(anchor)) * weight;
			if (alpha > 0.0) {
				float em = min(emMax, 22.0 * displayPixelAt(anchor));
				float cap = u_glyphInfo.w * em, gap = 0.3 * em;
				float width = float(labelLength(value)) * u_glyphInfo.x * em;
				vec2 q = vec2(p.x - i * stepSize + width * 0.5, p.y + gap + cap) / em;
				result = max(result, labelCoverage(value, q, w / em) * alpha);
			}
		}
	}
	if (p.x < u_glyphInfo.y * emMax && p.x > -(emMax * (0.3 + 5.0 * u_glyphInfo.x + u_glyphInfo.y))) {
		float i = floor(p.y / stepSize + 0.5);
		int value = int(i) * unit;
		if (i != 0.0 && abs(i) <= 60.0 && (coarsest || value % (unit * 10) != 0)) {
			vec3 anchor = vec3(0.0, i * stepSize, at.z);
			float alpha = gridLevelFade(stepSize, pixelAt(anchor)) * weight;
			if (alpha > 0.0) {
				float em = min(emMax, 22.0 * displayPixelAt(anchor));
				float cap = u_glyphInfo.w * em, gap = 0.3 * em;
				float width = float(labelLength(value)) * u_glyphInfo.x * em;
				vec2 q = vec2(p.x + gap + width, p.y - i * stepSize + cap * 0.5) / em;
				result = max(result, labelCoverage(value, q, w / em) * alpha);
			}
		}
	}
	return result;
}

// (fill, halo) of the numbers beside the axes: each grid level's, from the coarsest to the finest.
vec2 axisLabels(vec3 at, float w) {
	vec2 result = vec2(0.0);
	if (u_glyphInfo.z < 1.0)
		return result;
	for (int i = 0; i < 3; i++)
		result = max(result, levelLabels(at, w, i));
	return result;
}

// The floor's colour between its lines and on them, and how the two lights in the camera's frame (as the models' own
// shading has them) light it
const vec3 FLOOR_BASE = vec3(0.26, 0.28, 0.31);
const vec3 FLOOR_LINE = vec3(0.62, 0.65, 0.70);
vec3 floorColour(float lines) {
	return mix(FLOOR_BASE, FLOOR_LINE, lines);
}
float floorLight() {
	vec3 key	= normalize(u_basis * vec3(-0.4, 0.6, 0.7));
	vec3 fill	= normalize(u_basis * vec3(0.7, -0.2, 0.5));
	return 0.45 + 0.55 * max(key.z, 0.0) + 0.2 * max(fill.z, 0.0);
}

// The numbers go on last and unlit: they are annotation, not part of the floor, so neither shadow nor light should touch
// them -- only the haze, which is what fade is. w is the size of a pixel at the point.
vec3 withAxisLabels(vec3 colour, vec3 at, float w, float fade) {
	vec2 label = axisLabels(at, w);
	colour = mix(colour, vec3(0.03, 0.04, 0.05), label.y * 0.8 * fade);
	return mix(colour, vec3(0.96, 0.97, 1.0), label.x * fade);
}
