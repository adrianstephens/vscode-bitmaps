// The floor both 3D viewers draw: the grid and its levels, the haze that dissolves it, where a ray meets it, the
// background, and the numbers along its axes. Spliced into a shader at its //@floor marker; the shader declares
// u_half (half the model's box), u_origin (the camera) and u_basis (its axes), which these read.
uniform float	u_pixel;	// the world size of a pixel one unit of distance from the camera, for the grid's own width
uniform float	u_labelPixel;	// the same for a pixel of the *display*, which is smaller than u_pixel while the view is moving and drawn small
uniform highp sampler2D u_glyphs;	// signed-distance atlas of the characters a number is spelled with (see fonts.ts's digitAtlas)
uniform vec4	u_glyphCell;	// em position of a cell's left and bottom edge, and its width and height in ems
uniform vec4	u_glyphInfo;	// em advance of a cell, em distance a texel saturates at, number of cells (0: no numbers), em height of a digit

// The most a line's half-width grows to, in pixels of the display, and the number of levels that keeps the top one at it: the top level
// is at least 1000 * LINE_CAP pixels apart (the finest is at least one, each is ten times the last), which is where a line of a
// thousandth of its spacing reaches the cap. Change them together.
const float LINE_CAP = 3.0;
const int LINE_LEVELS = 5;

// How much a line of a grid of spacing s is drawn at when a pixel is w: a line is a thousandth of its spacing wide, and fades out as it
// gets narrower than half a pixel. The numbers beside the axes come and go by the same test, so they stay with their lines.
float gridLineFade(float s, float w) {
	return min(s / 1000.0 / w * 2.0, 1.0);
}

// How much of a line of a grid of spacing s covers this point: 1 on a line, 0 between them. w is half the width a
// line should have here, which the caller works out from how far away the floor was hit -- without it a grid aliases
// into moire at any distance, and the lines get fainter as they get further away because they are drawn wider. d is the pixel of
// the display: a line is a thousandth of its spacing wide but never wider than that, so the coarsest levels, which a view this close
// to the floor sees only as lines through the origin, are all one width and the axis does not change width as a level leaves.
float gridLine(vec2 p, float s, float w, float d) {
	vec2 g = abs(fract(p / s - 0.5) - 0.5) * s;
	float x = min(s / 1000.0, d * LINE_CAP);
	return 1.0 - smoothstep(x, x + w, min(g.x, g.y));
}

// The finest level's spacing for a pixel of size w: the decade that is one to ten pixels, so the finest level is always on the
// point of being resolved and fades in as the view closes on it (gridLine fades a line out once it is narrower than a pixel), and the
// coarser two are a decade apiece above.
// It goes by the pixel, not the model, and has no floor: the camera can get as close to the floor as it likes.
float viewGridStep(float w) {
	return pow(10.0, floor(log(w) / 2.302585 + 1e-4) + 1.0);
}
// All the levels' lines together. A level's line is a thousandth of its spacing wide, so the coarser levels read as the structure
// without needing a weight. There are LINE_LEVELS, the top one always wide enough to be at the width cap: the set of levels moves a decade
// as the view closes in, and what leaves at the top must look like what replaces it.
float floorGrid(vec2 p, float w) {
	float lines = 0.0;
	float d = w * u_labelPixel / u_pixel;		// the pixel of the display: the levels and fades go by it, so they hold while the view is drawn small
	float s = viewGridStep(d);

	for (int i = 0; i < LINE_LEVELS; i++) {
		lines = max(lines, gridLine(p, s, w, d) * gridLineFade(s, d));
		s *= 10.0;
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
	return exp(-max(0.0, dist + scale * 1.5) / (scale * 8.0));
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
	int n = 1;
	for (int i = 0; i < 8; i++)
		if (a >= int(pow(10.0, float(i + 1)) + 0.5))
			n = i + 2;
	return n + (value < 0 ? 1 : 0);
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
	for (int i = 0; i < 8; i++)
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

// The size of a pixel of the display at a point on the floor, in the model's units, worked out for a label's anchor rather than
// for each pixel, so a label is one size and fades as one piece. It is the display's pixel and not this drawing's: while the view
// moves the page is drawn at half size, and a label sized in drawing pixels would double on screen for as long as it did. The
// grid's levels and fades go by it too (floorGrid), so nothing changes when the drawing is made smaller.
float displayPixelAt(vec3 anchor) {
	return length(anchor - u_origin) * u_labelPixel;
}

// The size of a level's numbers in ems, as a fraction of its spacing, so they scale with the grid squares they belong to.
const float LABEL_EM = 0.1;
// The sizes on the display, in pixels of em, over which a level's numbers fade out as they grow. They are not held to a comfortable
// size: the camera closing on the floor only makes a level's numbers bigger until they fade, and by then the next level is there. The
// end must not pass LABEL_EM * 1000, the largest a level's spacing gets to be in pixels, or the level that is dropped at the top
// as the view closes in would still be showing.
const vec2 LABEL_FADE = vec2(75.0, 100.0);

// How much a level's numbers show at a point where a pixel of the display is dp: in as their lines do (gridLineFade), out as they grow
// large (LABEL_FADE). It is a function of the spacing in pixels alone, so a level seen at a given size looks the same whichever of
// the levels it is, and nothing pops as the set of levels moves a decade.
float labelAlpha(float step, float dp) {
	return gridLineFade(step, dp) * (1.0 - smoothstep(LABEL_FADE.x, LABEL_FADE.y, LABEL_EM * step / dp));
}

// (fill, halo) of one grid level's numbers at a point of the floor: every step along x is written under the x axis,
// centred on its tick, and every step along y to the left of the y axis, right-aligned against it and centred on its
// tick. A tick that the next level also numbers is shared with it: that level's number shows as much as it does, and this one's
// the rest, so the number crosses over as the coarser one fades out. The coarsest level numbers every tick. w is the size of a
// pixel here.
vec2 levelLabels(vec3 at, float w, int level) {
	vec2 p = at.xy;
	vec2 result = vec2(0.0);
	bool coarsest = level == 2;
	float scale = pow(10.0, float(level));

	// The step of a level goes by the pixel at the axis, not at this fragment: the axis is where the numbers are, and a floor seen
	// at a slant has pixels of every size along it, so a step taken from the fragment would change partway across a number.
	float stepX = viewGridStep(displayPixelAt(vec3(p.x, 0.0, at.z))) * scale;
	if (stepX >= 1.0) {
		float em = stepX * LABEL_EM;
		float reach = em * (0.3 + u_glyphInfo.w + u_glyphInfo.y);		// the furthest from an axis any number of this level reaches
		int unit = int(stepX + 0.5);
		if (p.y < u_glyphInfo.y * em && p.y > -reach) {
			float i = floor(p.x / stepX + 0.5);
			int value = int(i) * unit;
			if (abs(i) <= 60.0) {
				vec3 anchor = vec3(i * stepX, 0.0, at.z);
				float dp = displayPixelAt(anchor);
				float alpha = labelAlpha(stepX, dp);
				if (!coarsest && value % (unit * 10) == 0)
					alpha *= 1.0 - labelAlpha(stepX * 10.0, dp);
				if (alpha > 0.0) {
					float cap = u_glyphInfo.w * em, gap = 0.3 * em;
					float width = float(labelLength(value)) * u_glyphInfo.x * em;
					vec2 q = vec2(p.x - i * stepX + width * 0.5, p.y + gap + cap) / em;
					result = max(result, labelCoverage(value, q, w / em) * alpha);
				}
			}
		}
	}
	float stepY = viewGridStep(displayPixelAt(vec3(0.0, p.y, at.z))) * scale;
	if (stepY >= 1.0) {
		float em = stepY * LABEL_EM;
		int unit = int(stepY + 0.5);
		if (p.x < u_glyphInfo.y * em && p.x > -(em * (0.3 + 9.0 * u_glyphInfo.x + u_glyphInfo.y))) {
			float i = floor(p.y / stepY + 0.5);
			int value = int(i) * unit;
			if (i != 0.0 && abs(i) <= 60.0) {
				vec3 anchor = vec3(0.0, i * stepY, at.z);
				float dp = displayPixelAt(anchor);
				float alpha = labelAlpha(stepY, dp);
				if (!coarsest && value % (unit * 10) == 0)
					alpha *= 1.0 - labelAlpha(stepY * 10.0, dp);
				if (alpha > 0.0) {
					float cap = u_glyphInfo.w * em, gap = 0.3 * em;
					float width = float(labelLength(value)) * u_glyphInfo.x * em;
					vec2 q = vec2(p.x + gap + width, p.y - i * stepY + cap * 0.5) / em;
					result = max(result, labelCoverage(value, q, w / em) * alpha);
				}
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

// The numbers go on last and unlit: they are annotation, not part of the floor, so neither shadow nor light should touch
// them -- only the haze, which is what fade is. w is the size of a pixel at the point.
vec3 withAxisLabels(vec3 colour, vec3 at, float w, float fade) {
	vec2 label = axisLabels(at, w);
	colour = mix(colour, vec3(0.03, 0.04, 0.05), label.y * 0.8 * fade);
	return mix(colour, vec3(0.96, 0.97, 1.0), label.x * fade);
}
