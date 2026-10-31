// The path a ray takes through a transparent medium, and the speckles it must not produce.
//
// A slab has a closed-form answer to test against: the ray that comes out of a parallel-sided slab is parallel to the
// one that went in, only displaced sideways. With a colourless medium (no absorption) and nothing else in the scene,
// what the transmitted ray sees is therefore exactly the background in the *incident* direction, at every angle.
//
// A sphere has a weaker but still decisive invariant: with a colourless sphere and nothing else in the scene,
// everything coming through must be a *background* colour -- the two wash colours mixed, nothing else. A march that
// loses the ray and re-hits the glass returns the surface's own shading instead, which is not on that line. That is
// the speckle, and it is why the sweep goes out to the silhouette: a flat face never makes a refracted ray graze.
//
// Both probes call the template's own throughMedium, trace and normalAt, with the three uniforms the harness cannot
// set substituted for the scene's own box. Each scene needs its own substitution: sharing one leaves trace() testing
// hits against another model's box, which silently makes it find nothing and the test check nothing.
const fs = require('fs');
const { makeMap } = require('./glsl.js');
const { evaluate } = require('./scadhost.js');
const { emitGlsl, SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

// (the template as the page has it, the floor's functions in it)
const TEMPLATE = fs.readFileSync(__dirname + '/../assets/sdf.frag', 'utf8').replace('//@floor', fs.readFileSync(__dirname + '/../assets/floor.frag', 'utf8'));
// a function of the template: where it is defined (a type and its name at the start of a line), not where it is called
function fromTemplate(name) {
	const def = new RegExp(`^\\w+\\s+${name}\\(`, 'm').exec(TEMPLATE);
	const at = def ? def.index + def[0].length - name.length - 1 : -1;
	if (at < 0)
		throw new Error(`${name} is not in the template`);
	const start = TEMPLATE.lastIndexOf('\n', TEMPLATE.lastIndexOf('\n', at) - 1) + 1;
	let depth = 0, i = TEMPLATE.indexOf('{', at);
	for (; i < TEMPLATE.length; i++) {
		if (TEMPLATE[i] === '{') depth++;
		else if (TEMPLATE[i] === '}' && --depth === 0) break;
	}
	return TEMPLATE.slice(start, i + 1);
}

// build the scene, and a probe function of (eps, scale) that the glass path is called from
function scene(src, probe) {
	const { sdf } = evaluate(src, 'glass.js');
	const g = emitGlsl(sdf);
	const box = bounds3(sdf);
	const half = (['x', 'y', 'z']).map(c => (box.max[c] - box.min[c]) / 2);
	const centre = (['x', 'y', 'z']).map(c => (box.max[c] + box.min[c]) / 2);
	const scale = Math.max(...half);
	const eps = scale * 2e-4;
	const v3 = (v) => `vec3(${v.map(x => x.toFixed(9)).join(', ')})`;
	// the floor is off here -- u_floorOn of 0 -- so this stays a test of the glass path alone; how a bent ray sees
	// the floor is the floor test's business
	const template = ['normalAt', 'trace', 'background', 'fresnel', 'localLight', 'floorShade', 'seen', 'throughMedium']
		.map(fromTemplate).join('\n')
		.replace(/u_basis/g, 'mat3(1.0)')
		.replace(/u_floorOn/g, '0.0')
		.replace(/u_center/g, v3(centre))
		.replace(/u_half/g, v3(half));
	// (and the template's globals, which its functions keep what they find in)
	const code = ['int g_steps = 0;', 'vec3 g_hit = vec3(0.0);', 'vec3 g_normal = vec3(0.0);', ...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}',
		template, probe(eps.toFixed(9), scale.toFixed(9))].join('\n');
	return {probe: makeMap(code, 'probe'), eps, scale, half};
}

//--- a slab, against the closed form ---------------------------------------------------------------------
{
	// 40 x 40 across, 10 thick, centred, colourless, with the entry on the +z face and the ray tilted by p.x
	const slab = scene('color("white", 0.0, $ior = 1.5) linear_extrude(height = 10, center = true) square([40, 40], center = true);',
		(eps, scale) => ['vec2 probe(vec3 p) {',
			'\tvec3 rd = normalize(vec3(p.x, 0.0, -p.y));',			// p.x is sin(theta), p.y is cos(theta)
			'\tvec3 at = vec3(0.0, 0.0, p.z);',
			`\tvec3 c = throughMedium(at, vec3(0.0, 0.0, 1.0), rd, 1.5, matColor(1.0), ${eps}, ${scale});`,
			'\treturn vec2(c.x, c.y);',
			'}'].join('\n'));
	const background = (dz) => [0.10, 0.11, 0.13].map((lo, i) => lo + ([0.22, 0.24, 0.28][i] - lo) * Math.min(1, Math.max(0, dz * 0.5 + 0.5)));
	let worst = 0, worstAt = null, jump = 0, jumpAt = null, previous = null, seen = 0;
	for (let deg = 0; deg <= 70; deg += 0.25) {
		const th = deg * Math.PI / 180;
		const c = slab.probe([Math.sin(th), Math.cos(th), slab.half[2]]);
		if (!Number.isFinite(c[0])) { check(false, `the transmitted ray is not finite at ${deg} degrees`); break; }
		seen++;
		const want = background(-Math.cos(th));
		if (Math.abs(c[0] - want[0]) > worst) { worst = Math.abs(c[0] - want[0]); worstAt = deg; }
		if (previous !== null && Math.abs(c[0] - previous) > jump) { jump = Math.abs(c[0] - previous); jumpAt = deg; }
		previous = c[0];
	}
	console.log(`a slab of glass at ${seen} angles: furthest from what a slab must show ${worst.toFixed(4)} at ${worstAt} degrees`);
	console.log(`  largest jump between neighbouring angles ${jump.toFixed(4)} at ${jumpAt} degrees`);
	check(worst < 0.02, `the transmitted ray does not see what is behind the slab (off by ${worst.toFixed(4)} at ${worstAt} degrees)`);
	check(jump < 0.01, `the transmission jumps by ${jump.toFixed(4)} at ${jumpAt} degrees, which is the acne`);
}

//--- a sphere, out to the silhouette ----------------------------------------------------------------------
{
	const R = 20;
	const sphere = scene('color("white", 0.0, $ior = 1.5) sphere(r = 20);', (eps, scale) => ['vec2 probe(vec3 p) {',
		'\tfloat b = p.x;',
		`\tvec3 at = vec3(0.0, b, sqrt(${(R * R).toFixed(9)} - b * b));`,		// an entry point on the +z side
		`\tvec3 rd = normalize(at - vec3(0.0, 0.0, ${(3 * R).toFixed(9)}));`,
		`\tvec3 c = throughMedium(at, normalize(at), rd, 1.5, matColor(1.0), ${eps}, ${scale});`,
		'\treturn vec2(c.x, c.y);',
		'}'].join('\n'));
	// the wash runs from (0.10,0.11,0.13) to (0.22,0.24,0.28), so its red and green channels lie on a line
	const onLine = ([r, g]) => {
		const t = (r - 0.10) / 0.12;
		return t > -0.02 && t < 1.02 && Math.abs(g - (0.11 + 0.13 * t)) < 0.004;
	};
	let offLine = 0, worst = 0, worstAt = null, jump = 0, jumpAt = null, previous = null, seen = 0;
	for (let f = 0; f <= 0.995; f += 0.005) {
		const c = sphere.probe([f * R, 0, 0]);
		if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) { check(false, `the ray through the glass sphere is not finite at ${(f * 100).toFixed(1)}% of the radius`); break; }
		seen++;
		if (!onLine(c)) {
			offLine++;
			if (Math.abs(c[0] - c[1]) > worst) { worst = Math.abs(c[0] - c[1]); worstAt = f; }
		}
		if (previous !== null && f < 0.9) {
			const d = Math.abs(c[0] - previous[0]) + Math.abs(c[1] - previous[1]);
			if (d > jump) { jump = d; jumpAt = f; }
		}
		previous = c;
	}
	console.log(`a glass sphere at ${seen} points across its radius: ${offLine} do not show the background`);
	if (worstAt !== null)
		console.log(`  furthest off it at ${(worstAt * 100).toFixed(1)}% of the radius; largest jump inside 90% of it ${jump.toFixed(4)}`);
	check(offLine === 0, `${offLine} points through the glass sphere show something other than what is behind it, by up to ${worst.toFixed(3)}`);
	check(jump < 0.02, `the transmitted colour jumps by ${jump.toFixed(4)} between neighbouring points at ${(jumpAt * 100).toFixed(1)}% of the radius, which is the acne`);
}

console.log(bad ? `${bad} FAILED` : 'ok: a ray crosses glass without losing itself, whether the surface is flat or curved');
process.exit(bad ? 1 : 0);
