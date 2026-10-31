// Audits the assembled shader for the failures glsl reports as syntax errors: an identifier that is actually a
// keyword, a function used before it is defined, or unbalanced brackets. Runs every mode, since each emits its own
// code path, and checks declared names as well as bare words.
const fs = require('fs');
const { evaluate } = require('./scadhost.js');
const { emitGlsl } = require('../out/src/scad/sdf.js');

const PATH = '/Volumes/DevSSD/dev/packages/rhombic_dodecahedron_system.scad';
const TEMPLATE = fs.readFileSync('/Volumes/DevSSD/dev/vscode-extensions/bitmaps/assets/sdf.frag', 'utf8').replace('//@floor', fs.readFileSync('/Volumes/DevSSD/dev/vscode-extensions/bitmaps/assets/floor.frag', 'utf8'));
const PICK_TEMPLATE = fs.readFileSync('/Volumes/DevSSD/dev/vscode-extensions/bitmaps/assets/sdfpick.frag', 'utf8');
const LIB = fs.readFileSync('/Volumes/DevSSD/dev/vscode-extensions/bitmaps/assets/sdflib.frag', 'utf8');

// GLSL ES 3.00 keywords, then the words it reserves for future use. Using any of these as a name is a syntax error
// or a redefinition, which is what "ERROR: 0:50: 'in' : syntax error" was.
const KEYWORDS = ['attribute','const','uniform','varying','break','continue','do','for','while','if','else','in','out','inout',
	'float','int','void','bool','true','false','invariant','discard','return','mat2','mat3','mat4','mat2x2','mat2x3','mat2x4',
	'mat3x2','mat3x3','mat3x4','mat4x2','mat4x3','mat4x4','vec2','vec3','vec4','ivec2','ivec3','ivec4','bvec2','bvec3','bvec4',
	'uint','uvec2','uvec3','uvec4','lowp','mediump','highp','precision','sampler2D','sampler3D','samplerCube','sampler2DShadow',
	'samplerCubeShadow','sampler2DArray','sampler2DArrayShadow','isampler2D','isampler3D','isamplerCube','isampler2DArray',
	'usampler2D','usampler3D','usamplerCube','usampler2DArray','struct','switch','case','default','centroid','flat','smooth',
	'noperspective','patch','sample','subroutine','layout',
	'common','partition','active','asm','class','union','enum','typedef','template','this','resource','goto','inline','noinline',
	'public','static','extern','external','interface','long','short','double','half','fixed','unsigned','superp','input','output',
	'hvec2','hvec3','hvec4','fvec2','fvec3','fvec4','dvec2','dvec3','dvec4','sampler3DRect','filter','image1D','image2D','image3D',
	'imageCube','iimage1D','iimage2D','iimage3D','iimageCube','uimage1D','uimage2D','uimage3D','uimageCube','sizeof','cast',
	'namespace','using'];
const GLSL_TYPES = 'float|int|void|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|uvec2|uvec3|uvec4|mat2|mat3|mat4|mat2x2|mat2x3|mat2x4|mat3x2|mat3x3|mat3x4|mat4x2|mat4x3|mat4x4|sampler2D|sampler3D|usampler2D';
const BUILTIN = new Set(['vec2','vec3','vec4','ivec2','ivec3','ivec4','mat2','mat3','mat4','float','int','bool','min','max','abs','clamp','mix','dot',
	'length','normalize','pow','sqrt','floor','ceil','atan','asin','acos','cos','sin','tan','exp','log','mod','step','smoothstep',
	'fract','sign','textureLod','equal','greaterThan','greaterThanEqual','lessThan','lessThanEqual','texelFetch','texture','distance','reflect','refract',
	'main','if','for','while','return','discard','precision']);
// keywords a shader may legitimately contain as syntax rather than as a name
const AS_SYNTAX = new Set(['in','out','inout','attribute','varying','uniform','const','precision','highp','lowp','mediump','layout',
	'flat','smooth','sample','struct','switch','case','default','break','continue','do','invariant','centroid','patch','subroutine',
	'noperspective']);

// A case is a label and the source to build: the file's own modes, which each take a different path through the
// evaluator, and a couple of synthetic ones for the constructs the file does not use -- a color(), which brings
// matColor and the material-carrying combinators with it, and the 2-D shapes, which bring their own emitters.
const CASES = [
	['die', () => fs.readFileSync(PATH, 'utf8').replace(/mode = "[a-z]+"/, 'mode = "die"')],
	['tray', () => fs.readFileSync(PATH, 'utf8').replace(/mode = "[a-z]+"/, 'mode = "tray"')],
	['lid', () => fs.readFileSync(PATH, 'utf8').replace(/mode = "[a-z]+"/, 'mode = "lid"')],
	['colour', () => `
color("red") cube([4, 4, 4], center = true);
color("#0f0") translate([8, 0, 0]) sphere(r = 3);
difference() {
	color([0.1, 0.2, 0.3]) cylinder(h = 20, r = 6, center = true, $fn = 6);
	color("yellow") sphere(r = 4);
}`],
	['2-D', () => `
linear_extrude(height = 4) offset(r = 1) polygon(points = [[0,0],[10,0],[10,6],[4,6],[4,2],[0,2]]);
translate([0, 12, 0]) rotate_extrude(angle = 270) translate([3, 0]) square([2, 4]);
linear_extrude(height = 3) circle(r = 5, $fn = 5);
`],
];

function assemble(mode, source, template = TEMPLATE) {
	const { sdf, warnings } = evaluate(source, PATH);
	if (!sdf)
		return undefined;
	const emitted = emitGlsl(sdf);
	const { helpers, body } = emitted;
	return {full: template.replace('//@lib', LIB).replace('//@sdf', [...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n')), warnings};
}

function audit(mode, source, template = TEMPLATE) {
	const built = assemble(mode, source, template);
	if (!built) { console.log(`${mode}: no geometry`); return 0; }
	const code = built.full.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	let bad = 0;

	// every name the shader declares, including function parameters
	const declared = new Set([...code.matchAll(new RegExp(`\\b(?:${GLSL_TYPES})\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'))].map(m => m[1]));
	const clashes = [...declared].filter(n => KEYWORDS.includes(n));
	if (clashes.length) { console.log(`${mode}: KEYWORD USED AS A NAME: ${clashes.join(', ')}`); bad += clashes.length; }

	// a function used before it is defined
	const defs = [...code.matchAll(new RegExp(`\\b(?:${GLSL_TYPES})\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g'))];
	const seen = new Set();
	for (let i = 0; i < defs.length; i++) {
		const name = defs[i][1];
		const body = code.slice(defs[i].index, i + 1 < defs.length ? defs[i + 1].index : code.length);
		for (const call of new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]))) {
			if (call === name || BUILTIN.has(call) || seen.has(call))
				continue;
			console.log(`${mode}: ${defs.some((d, j) => j > i && d[1] === call) ? `USED BEFORE DEFINED: ${name} calls ${call}` : `UNDEFINED CALL: ${name} calls ${call}`}`);
			++bad;
		}
		seen.add(name);
	}

	// A sampler3D has no default precision in the fragment language, unlike sampler2D and samplerCube, so leaving it
	// off is a compile error: "ERROR: 0:14: 'sampler3D' : No precision specified". Nothing else in the shader has to
	// say lowp/mediump/highp, which is why this is worth checking on its own.
	// Every uniform a shader reads has to be one it declared. A shader is assembled from a template and generated
	// code that only know each other by name, so a uniform one of them expects and the other never declares is a
	// compile error that says nothing about which half is missing it.
	const used = new Set([...code.matchAll(/\b(u_[A-Za-z0-9_]+)\b/g)].map(m => m[1]));
	const declaredUniforms = new Set([...code.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(u_[A-Za-z0-9_]+)/g)].map(m => m[1]));
	const undeclared = [...used].filter(n => !declaredUniforms.has(n));
	if (undeclared.length) { console.log(`${mode}: UNIFORM USED BUT NOT DECLARED: ${undeclared.join(', ')}`); bad += undeclared.length; }

	const bare = [...built.full.matchAll(/\buniform\s+((?:(?:lowp|mediump|highp)\s+)?)(sampler\w+)/g)]
		.filter(m => !m[1].trim()).map(m => m[2]);
	if (bare.length) { console.log(`${mode}: SAMPLER WITHOUT A PRECISION: ${bare.join(', ')}`); bad += bare.length; }

	const open = (built.full.match(/\{/g) || []).length, close = (built.full.match(/\}/g) || []).length;
	if (open !== close) { console.log(`${mode}: unbalanced braces ${open}/${close}`); ++bad; }
	console.log(`${mode}: ${defs.length} functions, ${built.full.split('\n').length} lines, ${built.warnings.length ? built.warnings.join('; ') : 'no warnings'}, ${bad ? `${bad} PROBLEMS` : 'clean'}`);
	return bad;
}

// The emitted matrices, against a hand-written transform. glsl builds mat3(...) from its *columns*, so if the
// emitter passes a row-major inverse the shader applies the transpose -- which is invisible to any test that uses
// the same inverse to place its own probe points.
function matrices() {
	let bad = 0;
	const { sdf } = evaluate('rotate([45,0,0]) cube([1,1,1]);', 'm.scad');
	const g = emitGlsl(sdf);
	const code = [...g.helpers, ...g.body].join('\n');
	const m = /mat3\(([^)]*)\)/.exec(code);
	if (!m) { console.log('matrices: no mat3 emitted at all'); return 1; }
	const n = m[1].split(',').map(Number);
	const M = [[n[0], n[3], n[6]], [n[1], n[4], n[7]], [n[2], n[5], n[8]]];      // glsl reads these as columns
	const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
	const L = [[1, 0, 0], [0, c, -s], [0, s, c]];                                 // rotate([45,0,0]), by hand
	const mul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)));
	const I = mul(M, L);
	const ok = I.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-9));
	console.log(`matrices: the shader's mat3 times the hand-written rotate([45,0,0]) is ${ok ? 'the identity' : 'NOT the identity'}`);
	if (!ok) { console.log(`   got ${I.map(r => r.map(v => +v.toFixed(3)).join(' ')).join(' | ')}`); ++bad; }
	return bad;
}

// A name declared twice in one scope, which is a redefinition -- including a local shadowing a parameter. Uses brace
// depth so that a legitimate inner-scope shadow is not reported.
function redefinitions(mode, code) {
	const seen = new Set();
	// A unique id per open scope, so two sibling blocks that each declare `perp` are not confused with one block
	// declaring it twice.
	const stack = [0];
	let next = 1, at = 0, bad = 0, pending = 0;
	const re = new RegExp(`\\b(?:${GLSL_TYPES})\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g');
	let m;
	while ((m = re.exec(code))) {
		for (; at < m.index; at++) {
			if (code[at] === '{') { if (pending) pending = 0; else stack.push(next++); }
			else if (code[at] === '}') stack.pop();
		}
		const key = `${stack.join('.')}:${m[1]}`;
		if (seen.has(key)) { console.log(`${mode}: '${m[1]}' is declared twice in one scope`); ++bad; }
		seen.add(key);
		// a function's parameters belong to a scope of their own, which its body then opens
		let k = m.index + m[0].length;
		while (code[k] === ' ' || code[k] === '\t') ++k;
		if (code[k] === '(') {
			stack.push(next++);		// the parameters and the body are one scope, as glsl treats them
			pending = 1;
		}
	}
	return bad;
}

// The rule above only helps if it fires, and a check that has never failed is a check that does nothing.
function samplerRule() {
	const finds = (text) => [...text.matchAll(/\buniform\s+((?:(?:lowp|mediump|highp)\s+)?)(sampler\w+)/g)].filter(m => !m[1].trim()).length;
	const caught = finds('uniform sampler3D u_cache;') === 1 && finds('uniform highp sampler3D u_cache;') === 0 && finds('uniform sampler2D u_tex;') === 1;
	console.log(`samplers: the precision check ${caught ? 'fires on a bare sampler and not on a qualified one' : 'DOES NOT WORK'}`);
	return caught ? 0 : 1;
}

let bad = 0;
for (const [mode, source] of CASES) {
	const src = source();
	const built = assemble(mode, src);
	bad += audit(mode, src);
	if (built)
		bad += redefinitions(mode, built.full.replace(/\/\/[^\n]*/g, ''));
	// the picker gets the same generated code as the picture, spliced into its own, much smaller template
	bad += audit(`${mode} (pick)`, src, PICK_TEMPLATE);
}
bad += matrices();
bad += samplerRule();
console.log(bad ? `\n${bad} problems` : '\nevery mode clean');
process.exit(bad ? 1 : 0);
