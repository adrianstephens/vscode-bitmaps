// The material properties, and the shading maths the shader does with them.
//
// The syntax is color(c, alpha, $specular = , $roughness = , $ior = , $metallic = ), with the same names as `$`
// variables for a whole scope. The `$` spelling is the one to prefer: OpenSCAD ignores config variables without a
// word, where a plain `ior =` gets it to warn that color() has no such parameter -- and both leave the file
// rendering there as its plain colour, which a material() module of our own would not (OpenSCAD drops the subtree).
//
// The shading itself cannot be run here (there is no GPU), so what is checked is the part that can be: the maths,
// taken out of the shader the viewer actually ships, and glsl's own refract.
const fs = require('fs');
const { makeMap } = require('./glsl.js');
const { evaluate } = require('./scadhost.js');
const { FileReader } = require('../out/src/filereader.js');
const { emitGlsl, materials } = require('../out/src/scad/sdf.js');
const { float3, approx_equal } = require('@isopodlabs/maths/vector');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const TEMPLATE = fs.readFileSync(__dirname + '/../assets/sdf.frag', 'utf8');
// lift a function's text out of the shader, so the test runs the shipped one rather than a copy of it
function fromTemplate(name) {
	const at = TEMPLATE.indexOf(`${name}(`);
	if (at < 0)
		throw new Error(`${name} is not in the template`);
	const start = TEMPLATE.lastIndexOf('\n', TEMPLATE.lastIndexOf('\n', at) - 1) + 1;
	let depth = 0, i = TEMPLATE.indexOf('{', at);
	const from = i;
	for (; i < TEMPLATE.length; i++) {
		if (TEMPLATE[i] === '{') depth++;
		else if (TEMPLATE[i] === '}' && --depth === 0) break;
	}
	return TEMPLATE.slice(start, i + 1);
}

const files = new FileReader();
const build = async (src) => {
	const { sdf, warnings } = await files.with(() => evaluate(src, '/tmp/material.scad', files));
	// the viewer's own camera variables are not what this is about
	return {sdf, warnings: warnings.filter(w => !w.startsWith('$vp')), palette: materials(sdf)};
};
// by colour, not by position: a scope that sets a `$` variable can add an entry that nothing ends up wearing
const ONE = async (src, rgb = float3(1, 0, 0)) => (await build(src)).palette.find(m => approx_equal(m.rgb, rgb));
const WHITE = [1, 1, 1];

(async () => {
//--- what color() and the `$` variables put in the palette -----------------------------------------------
{
	const byArgument = (await ONE('color("red", 0.6, $ior = 1.5, $roughness = 0.1) cube(1);'));
	console.log(`color("red", 0.6, $ior = 1.5, $roughness = 0.1): ${JSON.stringify(byArgument)}`);
	check(near(byArgument.ior, 1.5), '$ior as an argument did not reach the material');
	check(near(byArgument.roughness, 0.1), '$roughness as an argument did not reach the material');
	check(near(byArgument.opacity, 0.6) && near(byArgument.rgb.x, 1), 'the colour and alpha are wrong');

	// the same properties without the `$`, which OpenSCAD warns about but ignores just the same
	const plain = (await ONE('color("red", 0.6, ior = 1.5, roughness = 0.1) cube(1);'));
	check(near(plain.ior, 1.5) && near(plain.roughness, 0.1), 'the plain spellings did not reach the material');

	// and the `$` variable on its own, which is how a whole model or module gets a material
	const ambient = (await ONE('$ior = 1.5;\ncolor("red") cube(1);'));
	check(near(ambient.ior, 1.5), '$ior before the geometry did not reach it');
	const override = (await ONE('$ior = 1.5;\ncolor("red", 1, $ior = 1.1) cube(1);'));
	check(near(override.ior, 1.1), 'an explicit argument should win over the `$` variable in force');

	// the default, for geometry that says nothing
	const plainest = (await build('cube(1);'));
	check(plainest.palette.length === 1, `geometry with no material should add no palette entry (${plainest.palette.length})`);
	check(/more than two positional/.test((await build('color("red", 1, 1.5) cube(1);')).warnings.join(' | ')),
		'a third positional argument to color() should be reported, since the properties are named');
	check((await build('color("red", 0.6, $ior = 1.5) cube(1);')).warnings.length === 0, 'the `$` spelling should not warn');
}

//--- a `$` variable set in one module reaching another, as $fn does ---------------------------------------
{
	const { palette } = (await build(`
module glass() { $ior = 1.5; $roughness = 0.05; bead(); }
module bead() { color("white", 0.7) sphere(r = 1); }
glass();`));
	const mat = palette.find(m => m.rgb.x === 1 && m.rgb.y === 1 && m.rgb.z === 1);
	console.log(`through a module: ${JSON.stringify(mat)}`);
	check(near(mat.ior, 1.5) && near(mat.roughness, 0.05), 'a $ variable did not reach the module it instantiates');
	// a $variable is its last assignment in the scope wherever it is read, as an ordinary variable is (OpenSCAD evaluates
	// a scope's assignments before any of its statements), so one written after a color() still reaches it
	const { palette: before } = (await build(`color("red") cube(1);\n$roughness = 0.9;\ncolor("blue") cube(1);`));
	const red = before.find(m => near(m.rgb.x, 1) && near(m.rgb.z, 0));
	const blue = before.find(m => near(m.rgb.z, 1) && near(m.rgb.x, 0));
	check(red && blue, 'both colours should be in the palette');
	check(near(red.roughness, 0.9) && near(blue.roughness, 0.9), 'a $variable assigned later in the scope should reach what is written before it');
	check(before.length === 3, `the palette should be the default and the two colours, got ${before.length}`);
}

//--- the palette the shader reads, through the harness ---------------------------------------------------
{
	const { sdf } = (await build(`
color("red", 0.6, $ior = 1.5, $metallic = 1.0) cube(1);
color("blue", 1.0, $roughness = 0.2) translate([3,0,0]) cube(1);`));
	const g = emitGlsl(sdf);
	const map = makeMap([...g.helpers, 'float map(vec3 p) {', '\tfloat m = p.x < 0.0 ? 1.0 : 2.0;',
		'\treturn matIor(m) * 100.0 + matRough(m) * 10.0 + matMetal(m) + dot(matColor(m), vec3(0.001, 0.01, 0.0));', '}'].join('\n'));
	const one = map([-1, 0, 0]), two = map([1, 0, 0]);
	// 1.5*100 + 0.4*10 + 1.0 + red(0.001) = 155.001 ; 1.5*100 + 0.2*10 + 0 + blue(0) = 152
	check(near(one, 155.001, 1e-6), `the generated accessors read material 1 as ${one}`);
	check(near(two, 152.0, 1e-6), `the generated accessors read material 2 as ${two}`);
	console.log(`generated accessors: material 1 -> ${one}, material 2 -> ${two}`);
}

//--- fresnel, from the shipped shader, against Schlick by hand -------------------------------------------
{
	const map = makeMap([fromTemplate('fresnel'), 'float map(vec3 p) { return fresnel(vec3(p.x, 0.0, 0.0), p.y).x; }'].join('\n'));
	let worst = 0;
	for (const f0 of [0.04, 0.2, 1.0])
		for (const cos of [1, 0.9, 0.5, 0.1, 0]) {
			const want = f0 + (1 - f0) * Math.pow(1 - cos, 5);
			worst = Math.max(worst, Math.abs(map([f0, cos, 0]) - want));
		}
	console.log(`fresnel: worst difference from Schlick worked out here ${worst.toExponential(2)}`);
	check(worst < 1e-6, 'the shader\'s fresnel is not Schlick');
	// head-on it is f0, and at grazing incidence it goes to 1 -- which is why glass has a bright rim
	check(near(map([0.04, 1, 0]), 0.04, 1e-6), 'fresnel at normal incidence should be f0');
	check(map([0.04, 0, 0]) > 0.99, 'fresnel at grazing incidence should approach 1');
}

//--- where the highlight's colour comes from -------------------------------------------------------------
{
	// A black material makes this exact: its diffuse term is zero whatever the lighting, so at the peak of the lobe
	// everything the shader returns *is* the highlight. For a dielectric that must be the light's colour -- white,
	// the two lights here being white -- because its f0 comes from the index of refraction, not from the paint. For a
	// metal it must not: f0 is the base colour, which is what makes a metal a metal.
	const peak = async (src) => peakOf(src, 1.0);
	// diffuseWeight is 1 - transmission, which is what the shader passes for the surface it traced to
	const peakOf = async (src, diffuseWeight) => {
		const { sdf } = await build(src);
		const g = emitGlsl(sdf);
		const channel = (component) => makeMap([...g.helpers, fromTemplate('fresnel'),
			fromTemplate('localLight').replace(/u_basis/g, 'mat3(1.0)'),
			'vec2 map(vec3 p) {',
			'\tvec3 view = vec3(0.0, 0.0, 1.0);',
			'\tvec3 n = normalize(normalize(vec3(-0.4, 0.6, 0.7)) + view);',	// facing the key light: lobe at its peak
			`\treturn vec2(localLight(n, view, p.x, ${diffuseWeight.toFixed(1)}).${component}, 0.0);`,
			'}'].join('\n'))([1, 0, 0])[0];
		return [channel('x'), channel('y'), channel('z')];
	};
	const spread = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(...c, 1e-9);
	const black = await peak('color("black", 1, $specular = 1, $roughness = 0.6) cube(1);');
	const dense = await peak('color("black", 1, $specular = 1, $roughness = 0.6, $ior = 3.0) cube(1);');
	const gold = await peak('color([1, 0.75, 0.3], 1, $metallic = 1, $roughness = 0.6) cube(1);');
	const grey = await peak('color([0.8, 0.8, 0.8], 1, $metallic = 1, $roughness = 0.6) cube(1);');
	console.log(`a black dielectric, so this is only its highlight: [${black.map(v => v.toFixed(4))}], spread ${(spread(black) * 100).toFixed(3)}%`);
	console.log(`  the same at $ior = 3: [${dense.map(v => v.toFixed(4))}], ${(dense[0] / black[0]).toFixed(2)}x brighter`);
	console.log(`metals, where f0 is the colour: gold [${gold.map(v => v.toFixed(3))}], grey [${grey.map(v => v.toFixed(3))}]`);
	// ((1.5-1)/(1.5+1))^2 is 4% and ((3-1)/(3+1))^2 is 25%: the highlight belongs to the index
	check(black[0] > 0.02, `a dielectric should have a highlight at the peak (${black[0].toFixed(4)}, about 4% of the light)`);
	check(spread(black) < 0.001, `a dielectric's highlight takes the paint's colour: spread ${(spread(black) * 100).toFixed(2)}%`);
	check(near(dense[0] / black[0], 0.25 / 0.04, 0.05), 'the highlight should grow with the index of refraction');
	check(gold[0] > gold[1] && gold[1] > gold[2], 'a gold metal should reflect gold');
	check(near(grey[0], grey[1]) && near(grey[1], grey[2]), 'a grey metal should reflect grey');

	// and the paint is still what the diffuse shows: a red surface lit away from the highlight is red, with only the
	// grey 4% sitting on it
	const { sdf: redSdf } = (await build('color("red", 1, $specular = 1, $roughness = 0.6) cube(1);'));
	const rg = emitGlsl(redSdf);
	const red = makeMap([...rg.helpers, fromTemplate('fresnel'), fromTemplate('localLight').replace(/u_basis/g, 'mat3(1.0)'),
		'vec2 map(vec3 p) { vec3 view = vec3(0.0, 0.0, 1.0);',
		'\tvec3 n = normalize(vec3(-0.4, 0.6, 0.7));',			// lit, but away from the highlight
		'\tvec3 c = localLight(n, view, 1.0, 1.0); return vec2(c.x, c.y); }'].join('\n'))([1, 0, 0]);
	console.log(`a red lit surface: [${red.map(v => v.toFixed(3))}]`);
	check(red[0] > 0.3 && red[1] < 0.05, `the paint should colour the diffuse, got [${red.map(v => v.toFixed(3))}]`);

	// A transparent material must keep its highlight: the transmission takes the *diffuse*, which is the light that
	// scattered inside it, and not the reflection off its surface. A red surface with a diffuse weight of 0 -- what
	// an opaque-to-transparent surface passes -- should be left with the same grey highlight a black one has.
	const dry = await peakOf('color("red", 1.0, $specular = 1, $roughness = 0.6) cube(1);', 0.0);
	const wet = await peakOf('color("red", 0.0, $specular = 1, $roughness = 0.6) cube(1);', 0.0);
	const opaque = await peakOf('color("red", 1.0, $specular = 1, $roughness = 0.6) cube(1);', 1.0);
	console.log(`  its highlight at full transmission: [${dry.map(v => v.toFixed(4))}] against the opaque [${opaque.map(v => v.toFixed(3))}]`);
	check(dry[0] > 0.02, `a transparent surface lost its highlight (${dry[0].toFixed(4)})`);
	check(spread(dry) < 0.001, `a transparent surface's highlight took the paint's colour: spread ${(spread(dry) * 100).toFixed(2)}%`);
	check(near(dry[0], black[0], 1e-6), 'the highlight should be the same whatever the material is transparent of');
	check(near(wet[0], dry[0], 1e-9), 'the highlight should not depend on the alpha at all');
}

//--- refract, which is glsl's builtin and what the glass path is built on --------------------------------
{
	const map = makeMap(['float map(vec3 p) {',
		'\tvec3 I = normalize(vec3(p.x, p.y, p.z));',
		'\tvec3 R = refract(I, vec3(0.0, 0.0, 1.0), 1.0 / 1.5);',
		'\treturn length(R) < 1e-6 ? -1.0 : -R.z;',			// -R.z is the cosine of the refracted angle
		'}'].join('\n'));
	// 45 degrees in, so asin(sin(45)/1.5) = 28.13 degrees out
	const cosine = map([1, 0, -1]);
	const degrees = Math.acos(cosine) * 180 / Math.PI;
	console.log(`refract: 45 degrees into ior 1.5 comes out at ${degrees.toFixed(2)} degrees (want 28.13)`);
	check(near(degrees, 28.1255, 0.01), `glsl refract does not follow Snell (${degrees})`);

	// past the critical angle glass to air is a mirror: the builtin returns zero, which is how the shader knows
	const critical = Math.asin(1 / 1.5) * 180 / Math.PI;
	const map2 = makeMap(['float map(vec3 p) {',
		'\tvec3 I = normalize(vec3(sin(radians(p.x)), 0.0, -cos(radians(p.x))));',
		'\tvec3 R = refract(I, vec3(0.0, 0.0, 1.0), 1.5);',
		'\treturn length(R) < 1e-6 ? 1.0 : 0.0;',
		'}'].join('\n'));
	check(map2([critical - 2, 0, 0]) === 0 && map2([critical + 2, 0, 0]) === 1,
		`total internal reflection should begin at ${critical.toFixed(1)} degrees`);
	console.log(`refract: total internal reflection starts at ${critical.toFixed(1)} degrees`);
}

console.log(bad ? `${bad} FAILED` : 'ok: the material properties reach the palette, and the shading maths is right');
process.exit(bad ? 1 : 0);
})();
