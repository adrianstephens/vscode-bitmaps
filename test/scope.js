// Variable and module-body scoping: OpenSCAD's scopes are not sequentially ordered the way a JS block's are (a
// module instantiation earlier in a scope than the variable assignment it reads still sees it, and the last
// assignment to a name in one scope is what every use of it sees, regardless of where the use appears), let()'s
// bindings ARE sequential (each sees every one before it in the same let, unlike a scope's own variables), and
// $children/children() give a module body access to what was passed to it. None of this had a dedicated test
// before -- it was only ever exercised by chance, through the real OpenSCAD examples survey (test/examples.js),
// which needs that external checkout and skips itself without it.
const { evaluate } = require('./scadhost.js');
const { SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();
const { meshUniform, checkMesh } = require('./scadhost.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

(async () => {

//--- a module instantiation can read a variable assigned later in the same scope ------------------------------
{
	// the exact shape of example001.scad from the real OpenSCAD examples, which this used to get wrong: the
	// difference() reads size/cy_r/cy_h before their own assignments, further down the same module body
	const src = `
module thing() {
	difference() {
		sphere(r = r_from_dia(size));
		cylinder(r = cy_r, h = cy_h, center = true);
	}
	size = 20;
	cy_r = 5;
	cy_h = 50;
}
function r_from_dia(d) = d / 2;
thing();`;
	const { sdf, warnings } = evaluate(src, 'scope.js');
	check(warnings.length === 0, `a forward reference within a scope should not warn: ${JSON.stringify(warnings)}`);
	const stats = checkMesh(await meshUniform(sdf, {cells: 64}));
	check(stats.volume > 100, `the sphere should actually be built at r = 10, not r = 0 (volume ${stats.volume.toFixed(3)})`);
	console.log(`forward reference: volume ${stats.volume.toFixed(3)} (sphere r=10 less a hole)`);
}

//--- the last assignment to a name in a scope is the one every use of it sees ----------------------------------
{
	const { sdf, warnings } = evaluate('x = 1; y = x; x = 2; cube(y, center = true);', 'scope.js');
	check(warnings.length === 0, `re-assigning a name should not warn: ${JSON.stringify(warnings)}`);
	const b = bounds3(sdf);
	check(Math.abs(b.max.x - 1) < 1e-9, `y should see x's LAST assignment (2, giving a cube of size 2, half-extent 1) -- got half-extent ${b.max.x}`);
	console.log(`last assignment wins: cube half-extent ${b.max.x}`);
}

//--- a name that is genuinely never assigned still warns ---------------------------------------------------------
{
	const { warnings } = evaluate('cube(never_defined, center = true);', 'scope.js');
	check(warnings.some(w => /never_defined.*used before/.test(w)), `a truly undefined name should still warn, got ${JSON.stringify(warnings)}`);
}

//--- a self-referential assignment does not hang, and is reported like any other undefined use --------------------
{
	const { warnings } = evaluate('x = x + 1; cube(x, center = true);', 'scope.js');
	check(warnings.some(w => /used before/.test(w)), `x = x + 1 should be reported, not silently NaN or hung, got ${JSON.stringify(warnings)}`);
}

//--- let()'s bindings are sequential: a later one can use an earlier one in the same let() ------------------------
{
	// the exact pattern from list_comprehensions.scad, which this used to get wrong: v's expression uses d, bound
	// just before it in the same let()
	const { sdf, warnings } = evaluate('function f(a, num) = let (d = 360 / num, v = a + d) v; cube(f(10, 4), center = true);', 'scope.js');
	check(warnings.length === 0, `a let() binding using an earlier one should not warn: ${JSON.stringify(warnings)}`);
	const b = bounds3(sdf);
	check(Math.abs(b.max.x - 50) < 1e-9, `f(10, 4) should be 10 + 360/4 = 100 (half-extent 50), got half-extent ${b.max.x}`);
	console.log(`sequential let(): cube half-extent ${b.max.x}`);
}

//--- $children counts what was actually passed, and children(i) reaches the i'th one -----------------------------
{
	const src = `
module wrap() {
	if ($children == 0)
		sphere(r = 1);
	else
		for (i = [0 : $children - 1])
			translate([i * 10, 0, 0]) children(i);
}
wrap();
wrap() { cube(2, center = true); }
wrap() { cube(2, center = true); sphere(3); }`;
	const { sdf, warnings } = evaluate(src, 'scope.js');
	check(warnings.length === 0, `\$children/children(i) should not warn: ${JSON.stringify(warnings)}`);
	const b = bounds3(sdf);
	// the second wrap() has two children: children(0) (the cube) stays at the origin, children(1) (the sphere,
	// r = 3) is translated to x = 1 * 10, so the far edge is at 10 + 3 = 13
	check(Math.abs(b.max.x - 13) < 1e-6, `the widest reach should be the second wrap()'s sphere at x = 10 + 3 = 13, got ${b.max.x}`);
	console.log(`\$children/children(i): bounds3 reach x = ${b.max.x}`);
}

//--- children() with no argument draws all of them, and warns outside a module call --------------------------------
{
	const { sdf, warnings } = evaluate('module wrap() { children(); } wrap() { cube(2, center = true); sphere(3); }', 'scope.js');
	check(warnings.length === 0, `children() should not warn: ${JSON.stringify(warnings)}`);
	const b = bounds3(sdf);
	check(Math.abs(b.max.x - 3) < 1e-9, `children() with no args should draw both children (the sphere reaches furthest, to 3), got ${b.max.x}`);

	const { warnings: w2 } = evaluate('children();', 'scope.js');
	check(w2.some(w => /children\(\) outside a module call/.test(w)), `children() at the top level should say so, got ${JSON.stringify(w2)}`);
}

console.log(bad ? `\n${bad} FAILED` : '\nscopes resolve variables the way OpenSCAD does, let() is sequential, and $children/children() work');
process.exit(bad ? 1 : 0);

})();
