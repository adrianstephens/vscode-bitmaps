#version 300 es
precision highp float;
in vec2			v_ndc;
uniform vec3	u_center;	// the middle of the box the model is in
uniform vec3	u_half;		// and half its size
uniform vec3	u_origin;	// the camera, in the model's own units
uniform mat3	u_basis;	// camera right, up and back axes in the model's space
uniform float	u_fovy;		// cot of half the vertical field of view
uniform float	u_aspect;
uniform float	u_floorOn;	// whether the floor and its grid are drawn
uniform float	u_debug;	// 0 the picture, 1 the marching steps taken
out vec4		fragColor;

// how much work the pixel cost: the marching steps taken
int				g_steps = 0;

//@floor

//@lib

// The SDF the extension generated from the .scad file is spliced in here: the functions it needs, then map().
// map() returns the distance in .x and the material in .y, and the material functions the palette needs -- matColor,
// matOpacity, matSpec, matRough, matIor, matMetal -- are generated along with it.
//@sdf

// The model's surface normal, from the field around the point rather than from any one primitive. Only the distance
// half of map() is needed here: the material is decided at the hit itself.
vec3 normalAt(vec3 p, float h) {
	// the tetrahedron form: four taps rather than six for the same gradient
	vec2 k = vec2(1.0, -1.0);
	return normalize(
		k.xyy * map(p + k.xyy * h).x +
		k.yyx * map(p + k.yyx * h).x +
		k.yxy * map(p + k.yxy * h).x +
		k.xxx * map(p + k.xxx * h).x);
}

// Sphere tracing: from where the ray enters the model's box to where it leaves it. The field is a lower bound on
// the distance, so a step can never pass through the surface; a little is held back because the support function a
// Minkowski operand contributes is an approximation near a vertex. The material is picked up at the hit, from the
// same map() call that found it, rather than by asking the field again once the surface has been located.
float trace(vec3 ro, vec3 rd, out vec3 hit, out float mat, int budget) {
	vec3	inv		= 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-20);
	vec3	t0		= (u_center - u_half - ro) * inv;
	vec3	t1		= (u_center + u_half - ro) * inv;
	vec3	lo		= min(t0, t1), hi = max(t0, t1);
	float	scale	= max(max(u_half.x, u_half.y), u_half.z);
	float	eps		= scale * 2e-4;
	mat			= 0.0;
	float	tEnter	= max(max(lo.x, lo.y), max(lo.z, 0.0));
	float	tLeave	= min(min(hi.x, hi.y), hi.z);
	if (tEnter > tLeave)
		return -1.0;

	float	t		= tEnter;
	// A camera inside the solid -- zoomed into a wall on its way into something hollow -- would see the wall at no
	// distance at all, which fills the view. So a ray that starts inside is carried through to where it comes out,
	// and the march starts from there: the wall around the camera is clipped away, as a near plane would.
	if (tEnter == 0.0 && map(ro).x < 0.0) {
		for (int i = 0; i < 128; ++i) {
			float d = map(ro + rd * t).x;
			if (d >= 0.0)
				break;
			t += max(-d, eps);
			if (t > tLeave)
				return -1.0;
		}
		t += eps * 2.0;
	}
	for (int i = 0; i < 384; ++i) {
		if (i >= budget)
			break;
		hit				= ro + rd * t;
		g_steps++;
		vec2	field	= map(hit);			// 'sample' is a reserved word in glsl es 3.00
		if (field.x < eps) {
			mat			= field.y;
			return t;
		}
		t += field.x * 0.9;
		if (t > tLeave + scale * 0.05)
			break;
	}
	return -1.0;
}

// The floor is not part of the model: it never enters the field or the bounding box. A plane is a
// closed-form intersection, so it costs one division rather than a march, and the marcher's own hit distance decides
// which of the two is in front.

// How much light reflects off a boundary rather than crossing it, at a given angle: Schlick's approximation, with f0
// the reflectance head-on. A dielectric's f0 comes from its index of refraction, a metal's from its colour.
vec3 fresnel(vec3 f0, float cosTheta) {
	return f0 + (vec3(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// What a surface sends back to one eye, from the two analytic lights: a diffuse term, and a specular lobe whose width
// is the roughness. diffuseWeight is how much of the *diffuse* survives -- a transmissive surface scatters almost
// none of it, because what does not reflect goes through -- and it deliberately does not touch the highlight. The
// highlight is the light source reflecting off the surface, which is a reflection and has nothing to do with what
// passes through; scaling it by the transmission is what made glass lose its highlight entirely and show nothing
// until the index was high enough for the traced reflection to be visible on its own.
// This is all a secondary hit gets -- a ray that has already bent once is shaded where it lands rather than traced
// again -- and it calls with a weight of 1, having no transmission of its own to account for.
vec3 localLight(vec3 n, vec3 view, float mat, float diffuseWeight) {
	vec3	base	= matColor(mat);
	float	rough	= clamp(matRough(mat), 0.03, 1.0);
	float	spec	= matSpec(mat);
	float	ior		= max(matIor(mat), 1.0);
	float	metal	= clamp(matMetal(mat), 0.0, 1.0);
	float	ndv		= clamp(dot(n, view), 1e-4, 1.0);
	float	f		= (ior - 1.0) / (ior + 1.0);
	vec3	f0		= mix(vec3(f * f) * spec, base, metal);
	vec3	fres	= fresnel(f0, ndv);

	// two lights in the camera's own frame, so the model stays lit as it is turned
	vec3	key		= normalize(u_basis * vec3(-0.4, 0.6, 0.7));
	vec3	fill	= normalize(u_basis * vec3(0.7, -0.2, 0.5));
	float	ndl0	= max(dot(n, key), 0.0), ndl1 = max(dot(n, fill), 0.0);
	// Blinn-Phong with the exponent taken from the roughness: smooth is a small tight highlight, rough is a broad dim
	// one. a rough surface also has no mirror to speak of, which is what the Fresnel term already says at grazing
	float	power	= 2.0 / (rough * rough * rough * rough) - 2.0;
	float	lobe0	= pow(max(dot(n, normalize(key + view)), 0.0), power) * (power + 8.0) / (8.0 * 3.14159265);
	float	lobe1	= pow(max(dot(n, normalize(fill + view)), 0.0), power) * (power + 8.0) / (8.0 * 3.14159265);

	// a metal has no diffuse: what is not reflected is absorbed
	vec3	diffuse	= diffuseWeight * (1.0 - metal) * base * (0.25 + 0.85 * (ndl0 + 0.35 * ndl1));
	vec3	high	= spec * fres * (lobe0 * ndl0 + 0.35 * lobe1 * ndl1);
	return diffuse * (vec3(1.0) - fres) + high;
}

// The floor's own colour: the grid, the two lights, the darkening where the model is near it, and the haze that
// dissolves it into the background with distance. Every ray that meets the floor gets this, not only the first one.
// The floor only hides the background: whatever of the model is on the far side of it is seen through it, tinted,
// with the grid and the numbers still drawn over it. through is 1 when there is such a hit, and behind is its colour.
vec3 floorShade(vec3 rd, float ft, vec3 at, vec3 behind, float through) {
	float	w		= ft * u_pixel;
	float	lines	= floorGrid(at.xy, w);
	// The field's own distance at that point stands in for a contact shadow: the model is near if that distance is
	// small. Its reach is a length in the model's own units rather than in pixels -- tied to the pixel size, the
	// shadow shrank to nothing as the camera came closer -- with a floor of a few pixels so that it does not vanish
	// from a distance either.
	float	near	= map(at).x;
	float	reach	= max(max(max(u_half.x, u_half.y), u_half.z) * 0.3, w * 6.0);
	float	shade	= floorLight();
	float	contact	= 0.4 + 0.6 * smoothstep(0.0, reach, near);
	float	fade	= floorFade(ft);
	vec3	past	= mix(mix(behind, vec3(0.30, 0.42, 0.60), 0.3), FLOOR_LINE * shade, lines * 0.8);
	vec3	surface	= mix(floorColour(lines) * shade * contact, past, through);
	return withAxisLabels(mix(mix(background(rd), behind, through), surface, fade), at, w, fade);
}

// What a ray sees: the floor and the model, whichever is in front, or the background if neither. Only the first ray
// needs the hit itself -- its normal, its material, whether it is glass -- so main() does its own tracing; every ray
// bent or bounced from there wants the colour alone, and this is where the floor joins in for them.
vec3 seen(vec3 ro, vec3 rd, int budget) {
	vec3	hit;
	float	mat;
	float	t = trace(ro, rd, hit, mat, budget);
	vec3	model = t < 0.0 ? background(rd)
		: localLight(normalAt(hit, max(max(u_half.x, u_half.y), u_half.z) * 5e-4), -rd, mat, 1.0);
	if (u_floorOn > 0.5) {
		vec3	at;
		float	ft = floorHit(ro, rd, at);
		if (ft > 0.0 && (t < 0.0 || ft < t))
			return floorShade(rd, ft, at, model, t < 0.0 ? 0.0 : 1.0);
	}
	return model;
}


// The view through a medium: bend in at the surface, march to wherever it leaves, and if the far side turns it back
// inside by total internal reflection, keep going until it gets out or runs out of bounces. The colour is what the
// medium swallows on the way -- Beer-Lambert, using the surface colour as the absorption spectrum, so a red
// The view through a medium: bend in at the surface, march to wherever it leaves, and if the far side turns it back
// inside by total internal reflection, keep going until it gets out or runs out of bounces. The colour is what the
// medium swallows on the way -- Beer-Lambert, using the surface colour as the absorption spectrum, so a red
// transparent color() is red glass rather than a red-tinted surface. Returns a weight of zero if the ray cannot enter.
//
// Every step off a surface is taken along the surface's own normal, never along the ray. A refracted ray can leave a
// surface almost tangentially -- at the rim of a sphere, where the surface curves away from it -- and a step along
// such a ray stays outside the surface it just entered, so the next thing it finds is that same surface. That is
// surface acne: the ray sees the glass instead of what is behind it. Measured along the normal, the start is on the
// right side of the surface whatever the angle.
vec3 throughMedium(vec3 at, vec3 n, vec3 rd, float ior, vec3 base, float eps, float scale) {
	vec3	dir		= refract(rd, n, 1.0 / ior);
	vec3	tint	= vec3(1.0);
	if (length(dir) < 1e-6)
		return vec3(0.0);
	vec3	from	= at - n * eps * 2.0;				// just inside, along the normal

	for (int k = 0; k < 4; k++) {
		// inside, the field is negative and its magnitude is the distance to the surface being left
		vec3	q		= from;
		vec3	back	= from;
		float	travelled = 0.0;
		bool	left	= false;
		for (int i = 0; i < 192; i++) {
			float d = map(q).x;
			// the march has to have gone somewhere before "near the surface" can mean "through it": without that, a
			// start that is a hair inside counts as an exit and the ray never crosses anything
			if (d > -eps * 0.5 && travelled > eps * 4.0) {
				// the field is only a bound, so a step can carry past a surface. Between the last point that was
				// inside and this one, the crossing can be found by halving: without it a thin or concave wall lets
				// the ray out through the wrong side.
				if (d > 0.0) {
					for (int j = 0; j < 8; j++) {
						vec3 mid = 0.5 * (back + q);
						if (map(mid).x > 0.0)
							q = mid;
						else
							back = mid;
					}
				}
				left = true;
				break;
			}
			back = q;
			float step = max(-d * 0.8, eps * 0.25);
			q += dir * step;
			travelled += step;
		}
		tint *= exp(-(1.0 - base) * travelled * 0.08);
		if (!left)
			return background(dir) * tint;				// lost inside something too thin to march through

		vec3	exit	= normalAt(q, eps);
		vec3	next	= refract(dir, -exit, ior);
		if (length(next) > 1e-6) {
			// leave along the normal, not along the ray, and see the floor as well as the model through there
			return tint * seen(q + exit * eps * 2.0, next, 128);
		}
		dir	= reflect(dir, -exit);						// total internal reflection: stay inside
		from = q - exit * eps * 2.0;
	}
	return background(dir) * tint;
}

// The colour of the first hit on the model: its lights, and for a metal or a transmissive material, what it reflects
// and what is seen through it.
vec3 shadeHit(vec3 rd, vec3 hit, float mat, float scale, float eps) {
	vec3	n		= normalAt(hit, scale * 5e-4);
	vec3	view	= -rd;
	vec3	base	= matColor(mat);
	float	opacity	= clamp(matOpacity(mat), 0.0, 1.0);
	float	metal	= clamp(matMetal(mat), 0.0, 1.0);
	float	ior		= max(matIor(mat), 1.0);
	float	spec	= matSpec(mat);
	float	f		= (ior - 1.0) / (ior + 1.0);
	vec3	f0		= mix(vec3(f * f) * spec, base, metal);
	vec3	fres	= fresnel(f0, clamp(dot(n, view), 1e-4, 1.0));
	// An experiment: alpha as the transmission whatever the material, with no contribution from metal. A conductor's
	// Fresnel term already reflects most of the light, so this is close to a no-op for a bright metal and leaks the
	// complementary colour through a tinted one -- which is what the (1 - metal) factor was there to prevent.
	float	transmit = 1.0 - opacity;

	// The material the hit carries: index 0 is the viewer's own, and each color() or `$` variable in the file is
	// another, chosen by the operand that decided the field at that point (see the generated matColor and friends).
	// Only the diffuse is what passes through: the surface keeps the part of its response the transmission does not
	// take, and the highlight is kept whole, being a reflection like any other.
	vec3	lit		= localLight(n, view, mat, 1.0 - transmit);

	// A metal reflects the scene as well as the lights; a transmissive surface reflects and transmits.
	if (transmit > 0.01 || metal > 0.01) {
		// what reflects: one more surface, shaded where it lands
		vec3	rdir	= reflect(rd, n);
		vec3	mirror	= seen(hit + n * eps * 4.0, rdir, 128);
		lit += fres * mirror;
		if (transmit > 0.01) {
			vec3	through	= throughMedium(hit, n, rd, ior, base, eps, scale);
			// a ray that cannot get in at all -- the eye inside the glass, past the critical angle -- is all
			// reflection, so what the transmission would have carried stays on this side of the surface
			lit += length(through) < 1e-6 ? (vec3(1.0) - fres) * mirror : (1.0 - fres) * transmit * through;
		}
	}

	return lit;
}

void render() {
	vec3	rd		= u_basis * normalize(vec3(v_ndc.x * u_aspect / u_fovy, v_ndc.y / u_fovy, -1.0));
	vec3	hit;
	float	mat;

	float	scale	= max(max(u_half.x, u_half.y), u_half.z);
	float	eps		= scale * 2e-4;
	float	t		= trace(u_origin, rd, hit, mat, 384);

	vec3	lit		= t < 0.0 ? background(rd) : shadeHit(rd, hit, mat, scale, eps);

	// the floor, if it is on and in front of whatever the model put there, which it then shows through a tint
	if (u_floorOn > 0.5) {
		vec3	at;
		float	ft = floorHit(u_origin, rd, at);
		if (ft > 0.0 && (t < 0.0 || ft < t))
			lit = floorShade(rd, ft, at, lit, t < 0.0 ? 0.0 : 1.0);
	}

	fragColor = vec4(pow(clamp(lit, 0.0, 1.0), vec3(0.4545)), 1.0);
}

// blue for little work through green to red for a lot
vec3 heat(float x) {
	x = clamp(x, 0.0, 1.0);
	return clamp(vec3(x * 2.0 - 1.0, 1.0 - abs(x * 2.0 - 1.0), 1.0 - x * 2.0), 0.0, 1.0);
}

void main() {
	render();
	if (u_debug > 0.5)
		fragColor = vec4(heat(float(g_steps) / 96.0), 1.0);
}
