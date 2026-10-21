// rands(): OpenSCAD's own numbers for a given seed. The Mersenne Twister is checked against its published outputs,
// the seed hash against Python's (whose scheme OpenSCAD's hash_floating_point copies -- an integer-valued float hashes
// to the integer), and rands() itself for the properties a file relies on: a seed always gives the same numbers,
// values stay in range, and the degenerate arguments behave as OpenSCAD's do.
const { MT19937, seedOf } = require('../out/src/scad/random.js');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { SDF } = require('../out/src/scad/sdf.js');
const bounds3 = s => new SDF(s).bounds();

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

{
	const a = new MT19937(5489);
	check(a.next() === 3499211612, 'mt19937 seeded 5489 should start at 3499211612');
	for (let i = 1; i < 9999; i++) a.next();
	check(a.next() === 4123659995, "mt19937's 10000th output from the default seed should be 4123659995 (the C++ standard's own check value)");
	check(new MT19937(1).next() === 1791095845, 'mt19937 seeded 1 should start at 1791095845');
	console.log('mersenne twister: matches the reference outputs');
}
{
	check([0, 1, 18, 1000000].every(n => seedOf(n) === n), 'an integer-valued seed should hash to itself');
	check(seedOf(0.5) === 2 ** 30, '0.5 should hash to 2^30 (its inverse of 2 mod 2^31-1)');
	check(seedOf(-1) === 0xffffffff, '-1 should become the uint32 of -1');
	check(seedOf(1.0000001) !== seedOf(1), 'nearby seeds should not hash alike');
}
{
	// echo() prints its arguments formatted; numbers come out at full precision, so the list parses back exactly
	const drawn = (src) => { let v; const log = console.log; console.log = (_, x) => { v = JSON.parse(x); }; try { evaluate(src, 'random.js'); } finally { console.log = log; } return v; };
	const first = drawn('echo(rands(0, 1, 5, 18));'), again = drawn('echo(rands(0, 1, 5, 18));');
	check(Array.isArray(first) && first.length === 5, 'rands should give the number asked for');
	check(JSON.stringify(first) === JSON.stringify(again), 'the same seed should give the same numbers');
	check(JSON.stringify(first) !== JSON.stringify(drawn('echo(rands(0, 1, 5, 19));')), 'a different seed should give different numbers');
	const wide = drawn('echo(rands(-3, 7, 2000, 5));');
	check(wide.every(v => v >= -3 && v < 7), 'values should lie in [min, max)');
	check(Math.abs(wide.reduce((a, b) => a + b, 0) / wide.length - 2) < 0.3, 'values should be spread evenly over the range');
	check(JSON.stringify(drawn('echo(rands(0, 10, 3, 18));')) === JSON.stringify(drawn('echo(rands(0, 1, 3, 18));').map(v => v * 10)), 'a range should scale the same underlying draws');
	check(JSON.stringify(drawn('echo(rands(5, 5, 3));')) === '[5,5,5]', 'min == max should repeat the value');
	check(JSON.stringify(drawn('echo(rands(9, 1, 100, 2));')) === JSON.stringify(drawn('echo(rands(1, 9, 100, 2));')), 'a reversed range should be swapped');
	check(drawn('echo(rands(0, 1, 0, 1));').length === 0, 'asking for none should give none');
	const quiet = (src) => { const log = console.log; console.log = () => {}; try { return evaluate(src, 'random.js'); } finally { console.log = log; } };
	check(quiet('echo(rands(0, 1));').warnings.some(w => /rands\(\)/.test(w)), 'too few arguments should be reported');
	console.log(`rands: seed 18 gives ${first.map(v => v.toFixed(4)).join(', ')}`);
}
{
	// the example that needed it: a tree of recursive modules placed by 4x4 matrices built from seeded random numbers
	const fs = require('fs');
	const file = '/Volumes/DevSSD/dev/github/openscad/examples/Advanced/module_recursion.scad';
	if (fs.existsSync(file)) {
		const { warnings } = evaluate(fs.readFileSync(file, 'utf8'), file);
		check(!warnings.some(w => /multmatrix|rands/.test(w)), `module_recursion.scad still reports ${JSON.stringify(warnings)}`);
	}
}

console.log(bad ? `\n${bad} FAILED` : '\nrands reproduces the Mersenne Twister, hashes seeds as OpenSCAD does, and behaves at its edges');
process.exit(bad ? 1 : 0);
