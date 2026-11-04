// hull() of smooth cylinders that are alike (npx tsc -b first, then npx ts-node -T test/hullcylinders.ts): the same radius and length,
// pointing the same way, standing on one plane. Exact -- a rounded polygon extruded -- so no fallback warning and the volume of that shape;
// other cylinders still fall back to the union, with the warning (test/hull.js has the case of two on one axis).
const { evaluate, meshUniform, checkMesh } = require('./scadhost.js');
const { SDF } = require('../out/src/scad/sdf.js');
const { float3 } = require('@isopodlabs/maths/vector');

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };
const fellBack = (warnings: string[]) => warnings.some(w => /hull this viewer cannot build exactly/.test(w));

// a polygon of area A and perimeter P, grown by r and extruded by h: (A + P r + pi r^2) h
const rounded = (area: number, perimeter: number, r: number, h: number) => (area + perimeter * r + Math.PI * r * r) * h;

const corners = (rot = '') => `${rot} hull() for (x = [6, 54], y = [6, 34]) translate([x, y, 0]) cylinder(r = 6, h = 24);`;

(async () => {
	const cases: [string, string, number | null, boolean][] = [
		['four corners of a rounded box', corners(), rounded(48 * 28, 2 * (48 + 28), 6, 24), true],
		['the same, turned on its side', corners('rotate([90, 0, 0])'), rounded(48 * 28, 2 * (48 + 28), 6, 24), true],
		['two (a stadium)', 'hull() { cylinder(r = 4, h = 10); translate([20, 0, 0]) cylinder(r = 4, h = 10); }', (Math.PI * 16 + 2 * 4 * 20) * 10, true],
		['three (a rounded triangle)', 'hull() { cylinder(r = 3, h = 5); translate([20, 0, 0]) cylinder(r = 3, h = 5); translate([0, 20, 0]) cylinder(r = 3, h = 5); }', rounded(200, 20 + 20 + Math.hypot(20, 20), 3, 5), true],
		['one (itself)', 'hull() { cylinder(r = 4, h = 10); }', Math.PI * 16 * 10, true],
		['different radii (fallback)', 'hull() { cylinder(r = 4, h = 10); translate([20, 0, 0]) cylinder(r = 6, h = 10); }', null, false],
		['different lengths (fallback)', 'hull() { cylinder(r = 4, h = 10); translate([20, 0, 0]) cylinder(r = 4, h = 14); }', null, false],
		['standing on different planes (fallback)', 'hull() { cylinder(r = 4, h = 10); translate([20, 0, 5]) cylinder(r = 4, h = 10); }', null, false],
	];
	for (const [label, source, volume, exact] of cases) {
		const { sdf, warnings } = evaluate(source, 'hullcylinders.ts');
		const problems: string[] = [];
		if (exact === fellBack(warnings))
			problems.push(exact ? 'fell back when an exact hull should have been possible' : 'built something exact where a fallback was expected');
		if (volume !== null) {
			const stats = checkMesh(await meshUniform(sdf, {cells: 110}));
			if (Math.abs(stats.volume - volume) / volume > 5e-3)
				problems.push(`volume ${stats.volume.toFixed(1)}, wanted ${volume.toFixed(1)}`);
		}
		check(problems.length === 0, `${label}${problems.length ? ': ' + problems.join('; ') : ''}`);
	}

	// the middle of the four corners is inside the hull, and was not inside what the fallback drew
	const { sdf } = evaluate(corners(), 'hullcylinders.ts');
	const inside = new SDF(sdf).eval(float3(30, 20, 12)) < 0, outside = new SDF(sdf).eval(float3(30, -1, 12)) > 0;
	check(inside && outside, `the middle of the corners is inside the hull (${inside}), and beyond an edge is outside it (${outside})`);

	console.log(bad ? `${bad} failed` : 'all passed');
	process.exit(bad ? 1 : 0);
})();
