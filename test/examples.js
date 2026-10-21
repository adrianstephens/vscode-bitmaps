// A survey, not a pass/fail suite: every .scad file under the real OpenSCAD project's examples/ is evaluated, GLSL-
// emitted and meshed, and the result reported one line per file. Real-world files exercise constructs no hand-
// written test thinks to try, so this is where a gap in the evaluator actually shows up -- a warning about a
// genuinely unimplemented feature (import(), surface(), an MCAD library this repo doesn't have) is expected and
// fine; what makes a file FAIL here is evaluate()/emitGlsl()/meshUniform() throwing, which is always a bug, and is the
// only thing that fails the run.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../out/src/scad/evaluate.js');
const { FileReader } = require('../out/src/scad/filereader.js');
const { emitGlsl, emptyReason } = require('../out/src/scad/sdf.js');
const { meshUniform, checkMesh } = require('../out/src/scad/mesher.js');

const ROOT = '/Volumes/DevSSD/dev/github/openscad/examples';

function findScadFiles(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, e.name);
		if (e.isDirectory())
			out.push(...findScadFiles(full));
		else if (e.name.endsWith('.scad'))
			out.push(full);
	}
	return out;
}

// use<>/include<> resolved against the real examples tree, so a file that pulls in a sibling (logo_and_text.scad's
// use <logo.scad>) is exercised properly; a library this repo doesn't have (MCAD) fails to resolve and is reported
// as the warning loadUsedLibraries already gives for that, not a crash
const files = new FileReader();

(async () => {
	if (!fs.existsSync(ROOT)) {
		console.log(`${ROOT} not found -- skipping (this survey only runs where the openscad checkout is available)`);
		process.exit(0);
	}
	const scadFiles = findScadFiles(ROOT).sort();
	let crashes = 0, empties = 0, clean = 0, warned = 0;

	for (const file of scadFiles) {
		const rel = path.relative(ROOT, file);
		const src = fs.readFileSync(file, 'utf8');
		let sdf, warnings = [], stage = 'evaluate', crash = null;
		try {
			({sdf, warnings} = await files.with(() => evaluate(src, file, files)));
			stage = 'emitGlsl';
			emitGlsl(sdf);
			stage = 'meshUniform';
		} catch (e) {
			crash = `${stage}: ${e.message}`;
		}

		let status;
		if (crash) {
			status = `CRASH in ${crash}`;
			crashes++;
		} else {
			const reason = emptyReason(sdf, []);
			if (reason) {
				status = 'empty';
				empties++;
			} else {
				try {
					const stats = checkMesh(await meshUniform(sdf, {cells: 48}));
					const problems = [];
					if (stats.open) problems.push(`${stats.open} open`);
					if (stats.nonManifold) problems.push(`${stats.nonManifold} non-manifold`);
					status = `${stats.volume.toFixed(1)} vol${problems.length ? ', ' + problems.join(', ') : ''}`;
				} catch (e) {
					status = `CRASH in meshUniform: ${e.message}`;
					crashes++;
				}
			}
			if (!crash) {
				if (warnings.length) warned++; else clean++;
			}
		}
		console.log(`${rel.padEnd(38)} ${status}`);
		for (const w of warnings)
			console.log(`    ${w}`);
	}

	console.log(`\n${scadFiles.length} files: ${clean} clean, ${warned} warned, ${empties} drew nothing, ${crashes} crashed`);
	process.exit(crashes ? 1 : 0);
})();
