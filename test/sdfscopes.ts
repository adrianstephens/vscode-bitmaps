// The glsl that emitGlsl makes declares no name twice in a scope (npx tsc -b first, then npx ts-node -T test/sdfscopes.ts): a shader that does
// does not compile, which is what the viewer shows as "'d_b0' : redefinition". The case that did: a difference whose base is a union that is
// asked term by term (smooth cylinders, which $fn would have made polygons of), when the union's boxes and the cut's box shared a name.
const { evaluate } = require('./scadhost.js');
const { emitGlsl } = require('../out/src/scad/sdf.js');
import * as fs from 'fs';

let bad = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

// the names declared twice in one scope of a function, by the braces
function repeats(code: string) {
	const found: string[] = [];
	let scopes: Set<string>[] = [];
	for (const line of code.split('\n')) {
		if (/^[a-z]\w*\s+\w+\(.*\)\s*\{\s*$/.test(line))
			scopes = [new Set()];
		const m = /^\s*(?:float|vec[234]|int|bool)\s+(\w+)\s*=/.exec(line);
		if (m && scopes.length) {
			if (scopes.at(-1)!.has(m[1]))
				found.push(m[1]);
			scopes.at(-1)!.add(m[1]);
		}
		for (const c of line) {
			if (c === '{')
				scopes.push(new Set());
			else if (c === '}' && scopes.length > 1)
				scopes.pop();
		}
	}
	return found;
}

function glslOf(source: string) {
	const {sdf} = evaluate(source, '/tmp/scopes.scad');
	const {helpers, body} = emitGlsl(sdf);
	return [...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n');
}

const smooth = `
module rounded(w, d, h, r) { hull() for (x = [r, w - r], y = [r, d - r]) translate([x, y, 0]) cylinder(r = r, h = h); }
difference() {
	rounded(60, 40, 24, 6);
	translate([2.5, 2.5, 2.5]) rounded(55, 35, 24, 3.5);
}
for (x = [6, 54], y = [6, 34]) translate([x, y, 0]) difference() { cylinder(r = 3.5, h = 20); translate([0, 0, 2]) cylinder(r = 1.4, h = 24); }
`;
const found = repeats(glslOf(smooth));
check(found.length === 0, `a difference of smooth hulls, with posts: no name twice in a scope (${found.join(',') || 'none'})`);

// every example, with and without its $fn
for (const file of fs.readdirSync('web/examples').filter(f => f.endsWith('.scad'))) {
	const text = fs.readFileSync(`web/examples/${file}`, 'utf8');
	for (const [label, source] of [['as it is', text], ['without $fn', text.replace(/^\s*\$fn\s*=.*$/m, '')]] as const) {
		try {
			const dup = repeats(glslOf(source));
			check(dup.length === 0, `${file} ${label}: no name twice in a scope (${dup.join(',') || 'none'})`);
		} catch (error: any) {
			check(false, `${file} ${label}: ${error.message}`);
		}
	}
}
console.log(bad ? `${bad} failed` : 'all passed');
process.exit(bad ? 1 : 0);
