// The 2-D path: circle, square, polygon, offset, linear_extrude and rotate_extrude.
//
// Every check is against geometry worked out here rather than against another route through the same formula -- the
// point of the rim and rotation bugs was that agreeing with yourself proves nothing:
//   * polygon() is checked against square(), two different distance functions for the same region;
//   * circle($fn = n) is checked against a regular n-gon built from half-planes and edge segments;
//   * offset() is checked by asking where its boundary is: a round join reaches 2 from a corner along the diagonal,
//     a mitred one would reach 2*sqrt(2), so a point just outside the arc settles which was drawn;
//   * rotate_extrude() is checked by putting points on the surface it should have, and by a point the wedge must cut.
// The shader side is compiled and run for real in headless Chrome (test/webgl.js), not through a hand-written
// reimplementation of GLSL -- see fields.js for why that matters.
//
// A 2-D shape has no thickness, so it is only a solid inside an extrusion; on its own it is reported and dropped,
// which is why every shape below is extruded. The extrusion's field is max(shape, slab), so at z = 0 with a tall
// extrusion the slab term is far below and the shape's own value is what is measured.
const { makeShader, close } = require('./webgl.js');
const { evaluate } = require('./scadhost.js');
const { emitGlsl, emptyReason, SDF } = require('../out/src/scad/sdf.js');
const evalSdf3 = (s, p) => new SDF(s).eval(p);
const { float3 } = require('@isopodlabs/maths/vector');

// evalSdf takes a float3 (@isopodlabs/maths); everything else here uses [x,y,z] arrays, so it is shadowed
// to match -- passing it an array unwrapped silently returns NaN instead of erroring, which is why every check
// below was vacuous until this wrapper went in: a NaN error is never ">" the running worst (a false pass), and
// !Number.isFinite(NaN) trips the *other* branch instantly (a false fail from the wrong cause).
const evalSdf = (sdf, p) => evalSdf3(sdf, float3(p[0], p[1], p[2]));

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// compiles `src`'s shader and hands back {sdf, warnings, shader}, where shader is {at(points), one(point)} -- see
// webgl.js. Every point actually sampled goes through agree() below in one batch; shader.one() is for the rare
// ad-hoc single point that isn't part of a points array.
async function build(src) {
	const { sdf, warnings } = evaluate(src, 'twod.js');
	const g = emitGlsl(sdf);
	const shader = await makeShader([...g.helpers, 'vec2 map(vec3 p) {', ...g.body, '\treturn d;', '}'].join('\n'), 'map', g.data);
	return {sdf, warnings, shader};
}
async function agree(label, src, points) {
	const { sdf, shader } = await build(src);
	const results = await shader.at(points);
	let worst = 0, at = null;
	for (let i = 0; i < points.length; i++) {
		const d = results[i][0];
		if (!Number.isFinite(d))
			throw new Error(`${label}: the shader gave ${d} at [${points[i]}]`);
		const e = Math.abs(d - evalSdf(sdf, points[i]));
		if (e > worst) { worst = e; at = points[i]; }
	}
	check(worst < 1e-4, `${label}: shader and mirror differ by ${worst.toExponential(3)} at [${at}]`);
	return {sdf, shader};
}
let seed = 5;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const box = (n, r = 8) => Array.from({length: n}, () => [(rand() - 0.5) * r, (rand() - 0.5) * r, (rand() - 0.5) * r]);
// a tall centred extrusion, so that at z = 0 the slab term is -100 and never interferes
const FLAT = (shape) => `linear_extrude(height = 200, center = true) ${shape}`;
const flat = (p) => [p[0], p[1], 0];

(async () => {

//--- polygon() against square(): one region, two distance functions --------------------------------------
{
	const pts = box(4000, 12).map(flat);
	const { sdf: poly } = await agree('polygon', FLAT('polygon(points = [[0,0],[10,0],[10,10],[0,10]]);'), pts);
	const { sdf: sq } = await agree('square', FLAT('square([10, 10]);'), pts);
	const { sdf: cen } = await agree('centred square', FLAT('square([10, 10], center = true);'), pts);
	let worst = 0, wcen = 0;
	for (const p of pts) {
		worst = Math.max(worst, Math.abs(evalSdf(poly, p) - evalSdf(sq, p)));
		wcen = Math.max(wcen, Math.abs(evalSdf(poly, p) - evalSdf(cen, [p[0] - 5, p[1] - 5, 0])));
	}
	console.log(`polygon vs square: ${worst.toExponential(3)}, and centred by 5 ${wcen.toExponential(3)}`);
	check(worst < 1e-12 && wcen < 1e-12, 'polygon() and square() describe different regions');
}

//--- a concave polygon, against the same region built as two squares ------------------------------------
{
	// the L below is [0,10]x[0,6] with the notch [0,4]x[2,6] removed -- the notch is the whole point: a crossing
	// count that builds its edge the other way round still gets a convex outline right, and fills this in
	const L = [[0, 0], [10, 0], [10, 6], [4, 6], [4, 2], [0, 2]];
	const pts = box(6000, 14).map(flat);
	const { sdf: poly } = await agree('concave polygon', FLAT(`polygon(points = ${JSON.stringify(L)});`), pts);
	const { sdf: cut } = await agree('the same L as a difference', FLAT('difference() { square([10, 6]); translate([0, 2]) square([4, 4]); }'), pts);
	let wrong = 0, over = 0;
	for (const p of pts) {
		const a = evalSdf(poly, p), b = evalSdf(cut, p);
		if (Math.sign(a) !== Math.sign(b))
			wrong++;
		// the polygon's distance is the exact one and the difference's field is max(base, -cut), a lower bound, so
		// the bound must never come out above it
		if (b > a + 1e-9)
			over = Math.max(over, b - a);
	}
	// and the notch itself must be empty: points inside it are outside the L
	const inNotch = [[2, 4], [1, 3], [3.5, 5.5]].filter(p => evalSdf(poly, [p[0], p[1], 0]) < 0).length;
	check(wrong === 0, `${wrong} of ${pts.length} points are classified differently by the L and its difference`);
	check(over === 0, `the difference's bound comes out above the polygon's exact distance by ${over.toExponential(2)}`);
	check(inNotch === 0, 'the notch of a concave polygon is being filled in');
	console.log(`concave polygon: ${wrong} classification differences, its bound above the exact distance by ${over.toExponential(2)}, notch points inside ${inNotch}`);
}

//--- circle($fn) against the n-gon it is, from half-planes and edge segments -----------------------------
{
	// the exact distance to a regular n-gon: the furthest half-plane inside, the nearest edge segment outside
	function ngon(x, y, r, n) {
		const apothem = r * Math.cos(Math.PI / n);
		let inside = true, deepest = -Infinity;
		for (let i = 0; i < n; i++) {
			const a = (2 * i + 1) * Math.PI / n;			// edge midpoints, the vertices being on even multiples
			const d = x * Math.cos(a) + y * Math.sin(a) - apothem;
			if (d > 0)
				inside = false;
			deepest = Math.max(deepest, d);
		}
		if (inside)
			return deepest;
		let best = Infinity;
		for (let i = 0; i < n; i++) {
			const p0 = [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)];
			const p1 = [r * Math.cos(2 * Math.PI * (i + 1) / n), r * Math.sin(2 * Math.PI * (i + 1) / n)];
			const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
			const t = Math.max(0, Math.min(1, ((x - p0[0]) * ex + (y - p0[1]) * ey) / (ex * ex + ey * ey)));
			best = Math.min(best, Math.hypot(x - (p0[0] + t * ex), y - (p0[1] + t * ey)));
		}
		return best;
	}
	const pts = box(3000, 14).map(flat);
	const { sdf } = await agree('circle $fn=6', FLAT('circle(r = 5, $fn = 6);'), pts);
	const { sdf: smooth } = await agree('circle', FLAT('circle(r = 5);'), pts);
	let wsmooth = 0, wsign = 0, wover = 0, surface = 0;
	const exact = (p) => ngon(p[0], p[1], 5, 6);
	for (const p of pts) {
		const got = evalSdf(sdf, p), want = exact(p);
		wsmooth = Math.max(wsmooth, Math.abs(evalSdf(smooth, p) - (Math.hypot(p[0], p[1]) - 5)));
		if (Math.sign(got) !== Math.sign(want))
			wsign++;
		if (got > want + 1e-9)					// a sphere tracer must never step past the surface
			wover = Math.max(wover, got - want);
	}
	// the vertices and the edge midpoints are the surface, and the field must be zero on them
	const onEdge = [];
	for (let i = 0; i < 6; i++) {
		onEdge.push([5 * Math.cos(2 * Math.PI * i / 6), 5 * Math.sin(2 * Math.PI * i / 6)]);
		onEdge.push([5 * Math.cos(Math.PI / 6) * Math.cos((2 * i + 1) * Math.PI / 6),
					 5 * Math.cos(Math.PI / 6) * Math.sin((2 * i + 1) * Math.PI / 6)]);
	}
	for (const p of onEdge)
		surface = Math.max(surface, Math.abs(evalSdf(sdf, [p[0], p[1], 0])));
	console.log(`circle: $fn=6 vs the hexagon — ${wsign} sign mismatches, overestimate ${wover.toExponential(2)}, on the surface ${surface.toExponential(2)}, smooth vs hypot-r ${wsmooth.toExponential(3)}`);
	check(wsmooth < 1e-12, 'a smooth circle is not its radial distance');
	check(wsign === 0 && wover === 0, `a $fn=6 circle is not that hexagon (${wsign} mismatches, over by ${wover})`);
	check(surface < 1e-12, `the hexagon's vertices and edge midpoints are ${surface.toExponential(3)} off the surface`);
}

//--- offset(): round joins, checked by where the boundary is --------------------------------------------
{
	const src = FLAT('offset(r = 2) square([10, 10], center = true);');
	const { sdf, shader } = await agree('offset', src,
		[...box(2000, 20).map(flat), [7, 0, 0], [0, 7, 0], [5 + 2 * Math.SQRT1_2, 5 + 2 * Math.SQRT1_2, 0]]);
	const d = (p) => evalSdf(sdf, p);
	const diag = 5 + 2 * Math.SQRT1_2;
	console.log(`offset(r=2): wall ${d([7, 0, 0]).toExponential(2)}, round join on the diagonal ${d([diag, diag, 0]).toExponential(2)}, beyond it ${d([6.9, 6.9, 0]).toFixed(3)}`);
	check(near(d([7, 0, 0]), 0, 1e-12), 'the offset wall should be at 7');
	check(near(d([diag, diag, 0]), 0, 1e-12), 'the round join should reach 2 along the diagonal');
	// a mitred join would reach 7 on the diagonal too, so this point tells them apart
	check(d([6.9, 6.9, 0]) > 0.4, `a mitred corner would still be inside here (d = ${d([6.9, 6.9, 0]).toFixed(3)})`);
	check((await shader.one([7, 0, 0]))[0] < 1e-4, 'the shader does not put the offset wall at 7');
	// and a shrink, which is the other sign
	const { sdf: shrink } = await build(FLAT('offset(r = -2) square([10, 10], center = true);'));
	check(near(evalSdf(shrink, [3, 0, 0]), 0, 1e-12), 'offset(r = -2) should put the wall at 3');
}

//--- offset(delta): exact mitred corners for a single convex outline, honest round fallback otherwise ----
{
	// a mitred corner reaches all the way to the diagonal point a round join stops short of (see the r = 2 case
	// above, where that same point was the one that told a mitre and a round join apart)
	const src = FLAT('offset(delta = 2) square([10, 10], center = true);');
	const { sdf, shader } = await agree('offset(delta)', src,
		[...box(2000, 20).map(flat), [7, 0, 0], [7, 7, 0], [7.1, 7.1, 0]]);
	const d = (p) => evalSdf(sdf, p);
	console.log(`offset(delta=2): wall ${d([7, 0, 0]).toExponential(2)}, mitred corner ${d([7, 7, 0]).toExponential(2)}`);
	check(near(d([7, 0, 0]), 0, 1e-9), 'the offset wall should be at 7');
	check(near(d([7, 7, 0]), 0, 1e-9), 'a mitred corner should reach exactly (7, 7)');
	check(d([7.1, 7.1, 0]) > 0, 'just past the mitred corner should be outside');
	check((await shader.one([7, 7, 0]))[0] < 1e-4, 'the shader should put the mitred corner at (7, 7) too');

	// a shrink mitres inward the same way, until it passes the point where an edge would disappear -- past that,
	// the exact construction is not attempted at all, and the honest round fallback (with its warning) takes over
	const { sdf: shrink, warnings: shrinkWarnings } = await build(FLAT('offset(delta = -2) square([10, 10], center = true);'));
	check(shrinkWarnings.length === 0, `a valid shrink should not warn: ${JSON.stringify(shrinkWarnings)}`);
	check(near(evalSdf(shrink, [3, 3, 0]), 0, 1e-9), 'a mitred shrink should reach exactly (3, 3)');
	const { warnings: collapseWarnings } = await build(FLAT('offset(delta = -10) square([10, 10], center = true);'));
	check(collapseWarnings.some(w => /mitred corners are drawn round/.test(w)), 'a shrink past collapse should fall back to the round approximation, honestly');

	// a convex polygon() and an $fn-sided circle are mitred exactly too; a concave polygon, several paths, or a
	// union of shapes are not a single convex outline, so they still fall back
	const hex = [[2, 0], [1, 1.7320508], [-1, 1.7320508], [-2, 0], [-1, -1.7320508], [1, -1.7320508]];
	check((await build(FLAT(`offset(delta = 0.5) polygon(points = ${JSON.stringify(hex)});`))).warnings.length === 0,
		'a convex polygon() should be mitred exactly, not warned about');
	check((await build(FLAT('offset(delta = 1) circle(r = 5, $fn = 8);'))).warnings.length === 0,
		'an $fn-sided circle should be mitred exactly, not warned about');
	check((await build(FLAT('offset(delta = 1) circle(r = 5);'))).warnings.some(w => /mitred corners are drawn round/.test(w)),
		'a smooth circle has no vertices to mitre, so it should still fall back');
	const L = [[0, 0], [10, 0], [10, 6], [4, 6], [4, 2], [0, 2]];
	check((await build(FLAT(`offset(delta = 1) polygon(points = ${JSON.stringify(L)});`))).warnings.some(w => /mitred corners are drawn round/.test(w)),
		'a concave polygon should still fall back');
	check((await build(FLAT('offset(delta = 1) { square(4); translate([10, 0]) square(4); }'))).warnings.some(w => /mitred corners are drawn round/.test(w)),
		'a union of shapes is not one convex outline, so it should still fall back');
}

//--- linear_extrude and rotate_extrude ------------------------------------------------------------------
{
	const pts = box(3000, 24);
	const { sdf: ext } = await agree('linear_extrude', 'linear_extrude(height = 5) circle(r = 10);', pts);
	const { sdf: extc } = await agree('centred extrude', 'linear_extrude(height = 5, center = true) square([4, 6], center = true);', pts);
	const { sdf: rev } = await agree('rotate_extrude', 'rotate_extrude() translate([3, 0]) square([2, 2]);', pts);
	const { sdf: wedge } = await agree('partial revolve', 'rotate_extrude(angle = 90) translate([3, 0]) square([2, 2]);', pts);
	// the extruded circle is a cylinder: radius 10, z in [0, 5] -- the standard rounded-box combination (Inigo
	// Quilez's sdBox/sdCylinder), not plain max(), since past a corner the nearest point is the rim itself
	const cylinderSdf = (p) => {
		const d2 = Math.hypot(p[0], p[1]) - 10, dz = Math.max(-p[2], p[2] - 5);
		return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
	};
	let worst = 0;
	for (const p of pts)
		worst = Math.max(worst, Math.abs(evalSdf(ext, p) - cylinderSdf(p)));
	check(worst < 1e-12, `the extruded circle is not a cylinder (${worst.toExponential(3)})`);
	// The centred extrusion is a box, but max(shape, slab) is a *lower bound* on its distance away from the surface,
	// so what is checked is the classification and the surface, not a value far outside.
	let wrongSign = 0, samples = 0;
	const exactBox = (p) => {
		const q = [Math.abs(p[0]) - 2, Math.abs(p[1]) - 3, Math.abs(p[2]) - 2.5];
		return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0);
	};
	for (const p of pts) {
		const want = exactBox(p), got = evalSdf(extc, p);
		samples++;
		if (Math.sign(got) !== Math.sign(want) && Math.abs(want) > 1e-9)
			wrongSign++;
		if (got > want + 1e-9)			// a lower bound, or the tracer could step through the surface
			check(false, `the extruded field overestimates at [${p}]: ${got} > ${want}`);
	}
	check(wrongSign === 0, `${wrongSign} of ${samples} points are classified wrongly by the centred extrusion`);
	// points built on the box's own faces are the surface, and there the field is exact
	let onSurface = 0;
	for (let i = 0; i < 300; i++) {
		const a = (rand() - 0.5) * 2, b = (rand() - 0.5) * 2;
		onSurface = Math.max(onSurface, Math.abs(evalSdf(extc, [2, 3 * a, 2.5 * b])));
		onSurface = Math.max(onSurface, Math.abs(evalSdf(extc, [2 * a, 3, 2.5 * b])));
		onSurface = Math.max(onSurface, Math.abs(evalSdf(extc, [2 * a, 3 * b, 2.5])));
	}
	check(onSurface < 1e-12, `the centred extrusion's surface is off by ${onSurface.toExponential(3)}`);
	// the revolve is a tube of inner radius 3, outer 5, height 2: points on that surface must measure zero
	const tube = [];
	for (const r of [3, 5])
		for (let a = 0; a < 12; a++)
			for (const z of [0, 2]) {
				const t = 2 * Math.PI * a / 12;
				tube.push([r * Math.cos(t), r * Math.sin(t), z]);
			}
	let wrev = 0;
	for (const p of tube)
		wrev = Math.max(wrev, Math.abs(evalSdf(rev, p)));
	check(wrev < 1e-12, `points on the revolved tube are ${wrev.toExponential(3)} from its surface`);
	console.log(`revolve: surface points off by ${wrev.toExponential(3)}`);
	// a quarter turn keeps +x and cuts the rest away: this point is inside the full tube but at 181 degrees
	check(evalSdf(wedge, [4, 0.2, 1]) < 0, 'the 90 degree revolve should still contain +x');
	check(evalSdf(wedge, [-4.2, -0.1, 1]) > 0, 'the 90 degree revolve should have nothing at 181 degrees');
	check(evalSdf(rev, [-4.2, -0.1, 1]) < 0, 'the full revolve should have something there');
}

//--- a stretched 2-D shape, against the 3-D prism it stands in for --------------------------------------
{
	// The file this came from grows a hexagon prism with a flat disc, `scale([sqrt(2),1,1]) cylinder($fn = 6)` and
	// `scale([1,1,0]) sphere(r)`. The 2-D form of that is an offset of the stretched hexagon inside an extrude, and
	// the two must agree exactly: the 3-D one goes through the flat-brush dilation, the 2-D one through offset of a
	// polygon, so this compares two unrelated routes to the same solid. It is also the check that a 2-D shape under
	// a stretching frame is *that shape* rather than a bound on it, which is what it is without bake2().
	const threeD = `
minkowski() {
	scale([sqrt(2), 1, 1]) cylinder(h = 20, r = 50.2 / cos(30) / 2, center = true, $fn = 6);
	scale([1,1,0]) sphere(r = 4);
}`;
	const twoD = `
linear_extrude(height = 20, center = true)
	offset(r = 4) scale([sqrt(2), 1, 1]) circle(r = 50.2 / cos(30) / 2, $fn = 6);`;
	const viaMinkowski = `
linear_extrude(height = 20, center = true)
	minkowski() {
		scale([sqrt(2), 1, 1]) circle(r = 50.2 / cos(30) / 2, $fn = 6);
		circle(r = 4);
	}`;
	const pts = box(3000, 60);
	const { sdf: a } = await agree('the 3-D prism', threeD, pts);
	const { sdf: b } = await agree('the 2-D offset', twoD, pts);
	const { sdf: c } = await agree('the 2-D minkowski', viaMinkowski, pts);
	const d1 = Math.max(...pts.map(p => Math.abs(evalSdf(a, p) - evalSdf(b, p))));
	const d2 = Math.max(...pts.map(p => Math.abs(evalSdf(a, p) - evalSdf(c, p))));
	console.log(`the flat-brush prism: 2-D offset differs by ${d1.toExponential(2)}, 2-D minkowski by ${d2.toExponential(2)}`);
	check(d1 < 1e-12, `the 2-D offset of the stretched hexagon is not the 3-D prism (${d1.toExponential(3)})`);
	check(d2 < 1e-12, `the 2-D minkowski of the stretched hexagon is not the 3-D prism (${d2.toExponential(3)})`);
	// the order matters: scaling the offset stretches its round joins into ellipses, which no offset can be
	const { sdf: outer } = await build(`linear_extrude(height = 20, center = true)
	scale([sqrt(2), 1, 1]) offset(r = 4) circle(r = 50.2 / cos(30) / 2, $fn = 6);`);
	const difference = Math.max(...pts.map(p => Math.abs(evalSdf(outer, p) - evalSdf(a, p))));
	check(difference > 0.5, 'scaling an offset should not be the same shape as offsetting the scaled one');
	console.log(`  and scale(offset(...)) differs from it by ${difference.toFixed(3)}, as it should`);
}

//--- polygon() with paths=: more than one loop is a hole, by the even-odd fill rule ----------------------
{
	// a 10x10 square with a 4x4 hole cut from its middle, built two ways: as one polygon() with two paths (the
	// even-odd rule in polygonDistance2 is what turns the second loop into a hole rather than a separate island),
	// and as the same region cut with difference() -- an independent distance function to check it against
	const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
	const inner = [[3, 3], [7, 3], [7, 7], [3, 7]];
	const src = `polygon(points = ${JSON.stringify([...outer, ...inner])}, paths = [[0,1,2,3],[4,5,6,7]]);`;
	const pts = box(6000, 14).map(flat);
	const { sdf: poly } = await agree('polygon with a hole', FLAT(src), pts);
	const { sdf: cut } = await agree('the same shape as a difference', FLAT('difference() { square([10, 10]); translate([3, 3]) square([4, 4]); }'), pts);
	let wrong = 0, over = 0;
	for (const p of pts) {
		const a = evalSdf(poly, p), b = evalSdf(cut, p);
		if (Math.sign(a) !== Math.sign(b))
			wrong++;
		if (b > a + 1e-9)
			over = Math.max(over, b - a);
	}
	check(wrong === 0, `${wrong} of ${pts.length} points are classified differently by the polygon hole and its difference`);
	check(over === 0, `the difference's bound comes out above the polygon's exact distance by ${over.toExponential(2)}`);
	check(evalSdf(poly, [1, 1, 0]) < 0, 'a point in the ring between the loops should be inside');
	check(evalSdf(poly, [5, 5, 0]) > 0, 'a point in the hole should be outside');
	check(evalSdf(poly, [-1, -1, 0]) > 0, 'a point outside the outer loop should be outside');
	console.log(`polygon hole: ${wrong} classification differences, its bound above the exact distance by ${over.toExponential(2)}`);
}

//--- what it says when nothing is drawn ----------------------------------------------------------------
{
	// An empty field on its own says nothing about why. The warnings do: this is the shape of the report that would
	// have named the undef in a file that rendered as "nothing is drawn", and it is checked here because the message
	// is otherwise only reachable from inside the editor.
	const { sdf, warnings } = evaluate('circle(r = 5);', 'twod.js');
	const reason = emptyReason(sdf, warnings);
	console.log(`nothing to draw says: ${JSON.stringify(reason)}`);
	check(!!reason, 'a 2-D shape with no extrusion should leave nothing to draw');
	check(emptyReason((await build('cube(1);')).sdf, []) === undefined, 'a field with something in it should have no report');
	const undef = evaluate('polyhedron(points = [[1, 2, dir_nothing]], faces = [[0, 0, 0]]);', 'twod.js');
	const undefReason = emptyReason(undef.sdf, undef.warnings);
	check(!!undefReason && /dir_nothing|not a 3-vector/.test(undefReason),
		`an undef should be named in the report, got ${JSON.stringify(undefReason)}`);
}

//--- what it reports ------------------------------------------------------------------------------------
{
	const w = async (src) => (await build(src)).warnings.join(' | ');
	check(await w('linear_extrude(height = 2) offset(delta = 1) square(2);') === '', 'offset(delta) on a square is mitred exactly, so it should not warn');
	check(/mitred corners/.test(await w('linear_extrude(height = 2) offset(delta = 1) circle(r = 5);')), 'offset(delta) on a smooth circle has nothing to mitre, so it should report the round fallback');
	check(/twist/.test(await w('linear_extrude(height = 2, twist = 90) square(2);')), 'a twisted extrusion should be reported');
	check(await w('linear_extrude(height = 2) polygon(points = [[0,0],[1,0],[1,1]], paths = [[0,1,2]]);') === '', 'a polygon() with one usable path should not warn');
	check(/not a 2-D shape/.test(await w('linear_extrude(height = 2) cube(2);')), 'extruding a solid should be reported');
	check(await w('linear_extrude(height = 2) square(2);') === '', 'a plain extrusion should not warn');
	console.log('warnings: 6 cases checked');
}

//--- projection(): exact shadows where the parts are known, a traced outline otherwise ---------------------
{
	const d = (sdf, x, y) => evalSdf(sdf, [x, y, 0]);
	// a sphere anywhere casts its circle; a turned cube its turned square; an upright cylinder its circle
	const { sdf: ball } = await agree('projected sphere', FLAT('projection() translate([3, 4, 10]) sphere(2);'), box(60).map(flat));
	check(near(d(ball, 3, 4), -2, 1e-9) && near(d(ball, 6, 4), 1, 1e-9), 'a sphere\'s shadow is its circle, wherever it is in z');
	const { sdf: turned } = await agree('projected turned cube', FLAT('projection() rotate([0, 0, 45]) cube(2, center = true);'), box(60).map(flat));
	check(near(d(turned, Math.SQRT2, 0), 0, 1e-9) && d(turned, 1.1, 1.1) > 0, 'a cube turned about z casts a diamond');
	const { sdf: tipped } = await build(FLAT('projection() rotate([45, 0, 0]) cube(2, center = true);'));
	check(near(d(tipped, 0, Math.SQRT2), 0, 1e-9) && near(d(tipped, 1, 0), 0, 1e-9), 'a cube tipped about x casts a rectangle root 2 deep');
	const { sdf: extruded } = await build(FLAT('projection() translate([1, 1, 5]) linear_extrude(3) circle(2);'));
	check(near(d(extruded, 3, 1), 0, 1e-9), 'an extrusion casts its own outline');
	// cut = true: the slice at z = 0, and nothing when the solid does not reach it
	const { sdf: missed, warnings: missedWarnings } = evaluate(FLAT('projection(cut = true) translate([0, 0, 5]) linear_extrude(3) circle(2);'), 'twod.js');
	check(missed.k === 'empty' || missed.body?.k === 'empty', 'a slice that misses the solid is empty');
	check(missedWarnings.length === 0, `an empty slice should not be reported as anything else: ${missedWarnings}`);
	const { sdf: slice } = await build(FLAT('projection(cut = true) translate([0, 0, 3]) sphere(5);'));
	check(Math.abs(d(slice, 4, 0)) < 0.02, 'the slice of a ball of 5 at 3 below its centre is a circle of 4');
	// a cut has no known shadow: it is traced, and says so
	const { sdf: holed, warnings } = evaluate(FLAT('projection() difference() { cube(10, center = true); cylinder(h = 20, r = 3, center = true); }'), 'twod.js');
	check(Math.abs(d(holed, 3, 0)) < 0.02 && Math.abs(d(holed, 5, 0)) < 0.02 && d(holed, 0, 0) > 2.9 && d(holed, 4, 0) < 0, 'a holed cube casts a square with a round hole');
	check(warnings.some(w => w.includes('traced')), 'a traced projection should say so');
	console.log('projection: checked');
}

console.log(bad ? `${bad} FAILED` : 'ok: the 2-D shapes, their offsets and their extrusions measure as they should');
await close();
process.exit(bad ? 1 : 0);

})();
