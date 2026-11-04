// The floor and its grid: the arithmetic, out of the shader the viewer ships.
//
// The floor is not part of the model -- it never enters the field, the bounding box or the voxel cache -- so what it
// has to get right is narrow: be exactly where it says, refuse the rays that do not hit it, and stop drawing a level
// of grid once its lines are closer together than a pixel.
const fs = require('fs');
const { makeMap } = require('./glsl.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const TEMPLATE = fs.readFileSync(__dirname + '/../assets/floor.frag', 'utf8');
function fromTemplate(name) {
	const at = TEMPLATE.indexOf(`${name}(`);
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

// a 40 x 60 x 20 model centred at (5, -3, 10): the floor is at z = 0, and the plate reaches 0.7 * 30 beyond it
const CENTRE = [5, -3, 10], HALF = [20, 30, 10];
const v3 = (v) => `vec3(${v.join(', ')})`;
const constant = (name) => TEMPLATE.match(new RegExp(`^const (?:float|int) ${name} = ([^;]+);`, 'm'))[1];
const source = ['floorFade', 'floorHit', 'gridLineFade', 'gridLine', 'viewGridStep', 'floorGrid'].map(fromTemplate).join('\n')
	.replace(/LINE_CAP/g, constant('LINE_CAP')).replace(/LINE_LEVELS/g, constant('LINE_LEVELS'))
	.replace(/u_center/g, v3(CENTRE)).replace(/u_half/g, v3(HALF));
// a probe takes a point and returns two numbers of its choosing
const probe = (body) => makeMap([source, `vec2 map(vec3 p) { ${body} }`].join('\n'));
const one = (p, body) => probe(body)(p)[0];

const gridLine = (x, y, s, w, d = 1e9) => one([x, y, 0], `return vec2(gridLine(vec2(p.x, p.y), ${s}, ${w}, ${d}), 0.0);`);
const floorGrid = (x, y, w) => one([x, y, 0], `return vec2(floorGrid(vec2(p.x, p.y), ${w}), 0.0);`);
// a ray from above, in the direction p.xy with z = -1, asking floorHit what it found
const castDown = (ro, dir) => {
	const v = probe(`vec3 at; float t = floorHit(${ro}, ${dir}, at); return vec2(t, at.z);`)([0, 0, 0]);
	return {t: v[0], z: v[1]};
};
const refuse = (dir) => castDown('vec3(0.0, 0.0, 60.0)', dir).t;

//--- the grid line ---------------------------------------------------------------------------------------
{
	let onLine = 0, midway = 0;
	for (let k = -3; k <= 3; k++) {
		onLine = Math.max(onLine, Math.abs(gridLine(k * 10, 0, 10, 0.005) - 1), Math.abs(gridLine(0, k * 10, 10, 0.005) - 1));
		midway = Math.max(midway, gridLine(k * 10 + 5, k * 10 + 5, 10, 0.005));
	}
	console.log(`gridLine: ${onLine.toExponential(1)} from 1 on a line, ${midway.toExponential(1)} from 0 midway between them`);
	check(onLine < 1e-6 && midway < 1e-6, 'the lines are not where the spacing says they are');
	check(Math.abs(gridLine(2.5, 3.5, 10, 0.005) - gridLine(12.5, 13.5, 10, 0.005)) < 1e-9, 'the grid is not periodic');
	// a line is a thousandth of its spacing wide, but never wider than LINE_CAP (3) pixels of the display (d): the coarse levels meet at the axis
	// at one width, so it does not change as a level leaves
	check(Math.abs(gridLine(3.02, 3.02, 100000, 0.05, 1) - gridLine(3.02, 3.02, 10000, 0.05, 1)) < 0.05, 'lines past the cap should all be one width');
	check(gridLine(3.02, 3.02, 100000, 0.05, 1) < 1 && gridLine(2.5, 2.5, 100000, 0.05, 1) === 1, 'the cap should be the width');
	check(gridLine(0.5, 5.5, 1000, 0.05) > gridLine(0.5, 5.5, 1, 0.05), 'a coarser line should be wider');
}

//--- the levels follow the view --------------------------------------------------------------------------
{
	// the finest level is the decade that is one to ten pixels, with no floor: closer in, the grid gets finer without limit
	const step = (w) => one([0, 0, 0], `return vec2(viewGridStep(${w}), 0.0);`);
	for (const [w, want] of [[100, 1000], [1, 10], [0.5, 1], [0.05, 0.1], [0.003, 0.01], [0.00002, 0.0001]]) {
		const got = step(w);
		console.log(`viewGridStep: a pixel of ${w} -> ${got}`);
		check(Math.abs(got - want) < 1e-3 * want, `a pixel of ${w} should be gridded from ${want}, not ${got}`);
	}
	// a line is a thousandth of its spacing wide and fades out below half a pixel: a coarse line is drawn where a fine one is not
	const fade = (s, w) => one([0, 0, 0], `return vec2(gridLineFade(${s}, ${w}), 0.0);`);
	check(fade(10, 0.005) === 1, 'a line wider than a pixel should be fully drawn');
	check(fade(1, 1) < 0.01 && fade(100, 1) === 0.2, `the lines should fade by their width (${fade(1, 1)}, ${fade(100, 1)})`);
	check(fade(1000, 1) === 1, 'a coarse line should be fully drawn');
}

//--- where the floor is, and where it is not -------------------------------------------------------------
{
	const plane = CENTRE[2] - HALF[2];
	// 45 degrees down from 60 up, so the ray advances as much in x as it falls in z
	// a steep ray from z = 60, so that the hit lands well inside the plate rather than past its edge
	const dir = [0.2, 0, -1], len = Math.hypot(0.2, 0, 1);
	const steep = castDown('vec3(0.0, 0.0, 60.0)', `normalize(vec3(${dir[0]}, 0.0, ${dir[2]}))`);
	const expected = 60 / (-dir[2] / len);
	console.log(`floorHit: from z = 60 at ${(Math.acos(-dir[2] / len) * 180 / Math.PI).toFixed(1)} degrees down, it meets the plane after ${steep.t.toFixed(3)} (geometry says ${expected.toFixed(3)}), at z = ${steep.z.toFixed(4)} where the plane is ${plane.toFixed(4)}`);
	check(steep.t > 0 && Math.abs(steep.z - plane) < 0.05, `the floor is not at the model's base (z = ${steep.z})`);
	// the plane sits a hair below the base, deliberately, so 60.006 is what it travels rather than 60
	check(Math.abs(steep.t - expected) < 0.02, `the distance along the ray is not what geometry says (${steep.t} against ${expected})`);
	// straight down from above hits the middle of the plate; straight up does not; along the plane does not; and a
	// shallow ray lands past the edge, which the plate must refuse
	check(castDown('vec3(5.0, -3.0, 60.0)', 'vec3(0.0, 0.0, -1.0)').t > 0, 'straight down onto the plate should hit it');
	check(refuse('vec3(0.0, 0.0, 1.0)') === -1, 'a ray pointing up, away from the floor, should not hit it');
	check(refuse('vec3(1.0, 0.0, 0.0)') === -1, 'a ray parallel to the floor should not hit it');
	// the plane is unbounded, so even a very shallow ray meets it -- what takes the edge away is the fade, not a test
	check(refuse('normalize(vec3(10.0, 0.0, -0.01))') > 0, 'the plane is unbounded, so a shallow ray should still meet it');
	// the haze is by distance along the ray, so it recedes with the camera rather than sitting around the model
	const fade = (dist) => one([0, 0, 0], `return vec2(floorFade(${dist}), 0.0);`);
	console.log(`floorFade: at the model ${fade('p.x + 30.0').toFixed(3)}, out at 10 model sizes ${fade('p.x + 300.0').toExponential(1)}`);
	check(one([0, 0, 0], 'return vec2(floorFade(p.x), 0.0);') === 1, 'the floor should be clear at the camera');
	check(fade('p.x + 45.0') > 0.9, 'the ground under the model should still be clear');
	check(fade('p.x + 300.0') < 0.1, 'the floor should have dissolved into the background far away');
	check(fade('p.x + 300.0') > 0, 'an exponential reaches the background without needing to be clamped to it');
}

console.log(bad ? `${bad} FAILED` : 'ok: the floor is where it says, refuses what it should, and its grid fades with distance');
process.exit(bad ? 1 : 0);
