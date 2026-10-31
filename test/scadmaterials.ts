import { float3 } from '@isopodlabs/maths/vector';
import { mesher, checkMesh } from '@isopodlabs/binary_meshes';
import { parse } from '../src/scad/parser';
import { evaluate } from '../src/scad/evaluate';
import type { ScadFiles } from '../src/filereader';
import type { SDF } from '../src/scad/sdf';

// The 3MF export's colours: the mesher asked for materials puts each seam between two colours on edges of the mesh, so
// that no triangle has a part in each. A triangle is checked a little in from each of its corners, against the colour the
// viewer draws there, wherever that is on the surface (a vertex the mesher had to keep in its cell, short of an edge, is
// not); one with no area, along a seam, has no colour to get wrong. Without materials the seams are a staircase of the
// cells they pass through.
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL:', what); bad++; } };
const files: ScadFiles = {resolve: () => undefined, read: () => undefined};

const CASES: [string, string, number][] = [
	// two prisms that make a box between them, meeting on a slanted plane: the seam crosses the faces where it likes
	['slanted seam', `
color("red") linear_extrude(1) polygon([[0, 0], [1.3, 0], [0.7, 1], [0, 1]]);
color("blue") linear_extrude(1) polygon([[1.3, 0], [2, 0], [2, 1], [0.7, 1]]);`, 2],
	// the same moved as a whole, so the colours are compared in the frame they were written in
	['moved', `
translate([3, 1, 0]) rotate([0, 0, 10]) {
	color("red") linear_extrude(1) polygon([[0, 0], [1.3, 0], [0.7, 1], [0, 1]]);
	color("blue") linear_extrude(1) polygon([[1.3, 0], [2, 0], [2, 1], [0.7, 1]]);
}`, 2],
	// a turned block on a slab: the seam is the crease where the block's sides meet the slab's top
	['crease', `
color("red") cube([3, 3, 1]);
color("blue") translate([1.5, 1.5, 1.25]) rotate([0, 0, 25]) cube([1, 1, 1.5], center = true);`, 9 + 1 * 1 * 1],
];

function mixed(mesh: mesher.AdaptiveMesh, sdf: SDF) {
	let n = 0;
	mesh.faces.forEach((f, i) => {
		const [a, b, c] = f.map(v => mesh.points[v]);
		if (b.sub(a).cross(c.sub(a)).len() < 1e-9)
			return;
		const near = (p: float3, q: float3, r: float3) => p.scale(0.9).add(q.scale(0.05)).add(r.scale(0.05));
		const want = mesh.faceMaterials?.[i] ?? sdf.material(a.add(b).add(c).scale(1 / 3));
		if ([near(a, b, c), near(b, c, a), near(c, a, b)].some(p => Math.abs(sdf.eval(p)) < 1e-6 && sdf.material(p) !== want))
			++n;
	});
	return n;
}

(async () => {
	for (const [label, source, volume] of CASES) {
		const {sdf} = evaluate(parse(source, 'materials.scad', files), 'materials.scad', files, {$preview: false});
		const options = {cells: 96, tolerance: 0.01};
		const plain = await mesher.meshAdaptive(sdf, options);
		const split = await mesher.meshAdaptive(sdf, {...options, materials: true});
		const stats = checkMesh(split);
		const used = new Set(split.faceMaterials);
		console.log(`${label.padEnd(13)} ${split.faces.length} triangles (${plain.faces.length} without materials), ${mixed(plain, sdf)} of two colours without, ${mixed(split, sdf)} with; materials ${[...used].join(',')} of ${sdf.materials().length}`);
		check(!stats.open && !stats.nonManifold && !stats.inconsistent, `${label}: not closed ${JSON.stringify(stats)}`);
		// (a vertex kept in its cell short of an edge it is beside is a little off, with materials or without)
		check(Math.abs(stats.volume - volume) < 1e-4 * volume, `${label}: volume ${stats.volume}, not ${volume}`);
		check(used.size === 2 && !used.has(0), `${label}: materials ${[...used]}`);
		check(mixed(split, sdf) === 0, `${label}: triangles of two colours`);
	}
	console.log(bad ? `${bad} problems` : 'scad materials ok');
	if (bad)
		process.exitCode = 1;
})();
