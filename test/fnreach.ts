import { float3 } from '@isopodlabs/maths/vector';
import { mesher, checkMesh, volume } from '@isopodlabs/binary_meshes';
import { parse } from '../src/scad/parser';
import { evaluate } from '../src/scad/evaluate';

// A height field with a cliff 30 times steeper than the slope the file states. The field is a bound on distance only if the
// slope is, so a mesher that trusts it drops the cubes the cliff passes through; it looks at the gradient instead, and gets
// the mesh a true slope does.
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL:', what); bad++; } };
const files: any = {resolve: () => undefined, read: () => undefined};

const model = (slope: string) => `surface_fn(function(x, y) 3 * atan(40 * x) / 90 + 0.2 * y, x = [-2, 2], y = [-2, 2], bottom = -4${slope});`;

async function mesh(slope: string) {
	const {sdf} = evaluate(parse(model(slope), 'reach.scad', files), 'reach.scad', files, {$preview: false});
	return mesher.meshAdaptive(sdf, {cells: 128, tolerance: 0.05});
}

// The shader's march (a step of 0.9 of the field, 384 of them at most) over the cliff, from the side: the field is divided by
// the slope where it is, so rays get to the cliff's face in a few steps; one bound for the whole field, the cliff's, would
// divide every step by it and run out of steps first.
function marches(slope: string) {
	const {sdf} = evaluate(parse(model(slope), 'reach.scad', files), 'reach.scad', files, {$preview: false});
	// whether a ray gets to the surface, stepping by the given share of the field, in at most `budget` steps
	let phantom = 0;
	// (a hit is real if there is solid within a little of it, in some direction)
	const solid = (p: float3) => sdf.eval(p) < 0 || Array.from({length: 60}, (_, k) => {
		const a = Math.acos(1 - 2 * (k + 0.5) / 60), b = k * 2.399963;
		return sdf.eval(p.add(float3(Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a)).scale(0.05)));
	}).some(v => v < 0);
	const hits = (ro: float3, rd: float3, share: number, budget: number) => {
		let p = ro;
		for (let n = 0; n < budget; n++) {
			const d = sdf.eval(p);
			if (d < 1e-3) {
				if (!solid(p))
					++phantom;
				return true;
			}
			p = p.add(rd.scale(d * share));
			if (p.sub(ro).len() > 40)
				break;
		}
		return false;
	};
	let missed = 0, rays = 0;
	for (let i = 0; i < 100; i++) {
		const rd = float3(-0.8, 0.1 * Math.sin(i), -0.4).scale(1 / Math.hypot(0.8, 0.1 * Math.sin(i), 0.4));
		const ro = float3(0.05 * i - 2.5, -1 + 0.02 * i, 2.5).sub(rd.scale(8));
		if (!hits(ro, rd, 0.1, 20000))
			continue;
		++rays;
		if (!hits(ro, rd, 0.9, 384))
			++missed;
	}
	check(phantom === 0, `${slope || 'omitted'}: ${phantom} hits with no surface near them`);
	check(rays > 20, `${slope || 'omitted'}: only ${rays} rays reach the surface`);
	return missed;
}

(async () => {
	check(marches('') === 0, `omitted: rays missed within 384 steps`);
	const truth = await mesh(', slope = 100');
	for (const [label, slope] of [['too small', ', slope = 3'], ['omitted', ''], ['too large', ', slope = 2000']] as const) {
		const m = await mesh(slope), c = checkMesh(m);
		check(c.open === 0, `${label}: ${c.open} open edges`);
		check(Math.abs(volume(m) - volume(truth)) < 0.01 * Math.abs(volume(truth)), `${label}: volume ${volume(m)} against ${volume(truth)}`);
	}
	console.log(bad ? `${bad} failed` : 'fnreach: all passed');
	process.exit(bad ? 1 : 0);
})();
