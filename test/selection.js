// The bitmap editor's selection (webview/bitmapSelection.ts) on its own: a coverage mask in a box of whole pixels, made from
// rectangles, ellipses, polygons, curves and the wand, and combined, inverted and outlined.
// (The selected pixels of a picture carried by a transform are in raster.js.)

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };

const blank = (w, h, rgba = [0, 0, 0, 0]) => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++)
		data.set(rgba, i * 4);
	return {data, width: w, height: h};
};

(async () => {
	const {Selection} = await import('../out/webview/bitmapSelection.js');
	const {float2} = await import('@isopodlabs/maths/vector');
	const size = float2(30, 30);
	const box = (l, t, r, b) => float2.extent.fromSize(float2(l, t), float2(r - l, b - t));
	const sel = (l, t, r, b) => Selection.rect(box(l, t, r, b));
	// how much is selected, in whole pixels, of a 30 x 30 picture
	const total = s => { let n = 0; for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) n += s ? s.at(x, y) : 0; return n / 255; };

	// the shapes
	{
		const r = sel(2, 3, 8, 9);
		check(r.l === 2 && r.t === 3 && r.r === 8 && r.b === 9 && total(r) === 36, 'a rectangle');
		const all = Selection.all(size);
		check(total(all) === 900 && all.at(29, 29) === 255 && all.at(30, 0) === 0, 'all of a picture');
		const e = Selection.ellipse(box(0, 0, 20, 20), size);
		check(e.at(0, 0) === 0 && e.at(10, 10) === 255, 'an ellipse leaves the corners');
		check(Math.abs(total(e) - Math.PI * 100) < 4, `and has the area of one (${total(e)})`);
	}

	// combining, inverting
	{
		const a = sel(0, 0, 10, 10), b = sel(5, 5, 15, 15);
		check(total(Selection.combine(a, b, 'add')) === 175, 'add: 100 + 100 - 25');
		check(total(Selection.combine(a, b, 'subtract')) === 75, 'subtract: 100 - 25');
		check(total(Selection.combine(a, b, 'intersect')) === 25, 'intersect: 25');
		check(Selection.combine(a, sel(20, 20, 25, 25), 'intersect') === undefined, 'intersect of apart is nothing');
		check(total(a.invert(size)) === 800, 'invert: 900 - 100');
		check(total(Selection.combine(a, undefined, 'replace')) === 0, 'replace by nothing deselects');
	}

	// polygons: the right area and soft edges; one with a hole (opposite winding) is hollow
	const ring = Selection.fromPolygons([
		[float2(2, 2), float2(22, 2), float2(22, 22), float2(2, 22)],
		[float2(8, 8), float2(8, 16), float2(16, 16), float2(16, 8)]], size);
	{
		const tri = Selection.fromPolygons([[float2(0, 0), float2(20, 0), float2(0, 20)]], size);
		check(Math.abs(total(tri) - 200) < 3, `triangle area ${total(tri)}`);
		check(Math.abs(total(ring) - (400 - 64)) < 0.5 && ring.at(12, 12) === 0 && ring.at(4, 4) === 255, `a ring has a hole (${total(ring)})`);
		const soft = Selection.fromPolygons([[float2(0, 0), float2(10.5, 0), float2(10.5, 10), float2(0, 10)]], size);
		check(soft.at(5, 5) === 255 && Math.abs(soft.at(10, 5) - 128) <= 2 && soft.at(11, 5) === 0, `a pixel half inside is half selected (${soft.at(10, 5)})`);
	}

	// a curve of beziers (a circle of four cubics) is a disc
	{
		const k = 0.5523 * 10, cv = (x, y, flags) => ({x, y, flags});
		const circle = [cv(20, 10, 0), cv(20, 10 + k, 3), cv(10 + k, 20, 3), cv(10, 20, 1), cv(10 - k, 20, 3), cv(0, 10 + k, 3), cv(0, 10, 1),
			cv(0, 10 - k, 3), cv(10 - k, 0, 3), cv(10, 0, 1), cv(10 + k, 0, 3), cv(20, 10 - k, 3)];
		const disc = Selection.curve(circle, size);
		check(disc && Math.abs(total(disc) - Math.PI * 100) < 4, `a cubic circle is a disc (${disc && total(disc)})`);
	}

	// the wand
	{
		const im = blank(8, 8, [255, 255, 255, 255]);
		for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) im.data.set([0, 0, 0, 255], (y * 8 + x) * 4);
		im.data.set([0, 0, 0, 255], (0 * 8 + 7) * 4);
		const inner = Selection.wand(im, 3, 3, 10, true);
		check(total(inner) === 16 && inner.at(2, 2) === 255 && inner.at(1, 1) === 0, 'wand takes the connected black square');
		check(total(Selection.wand(im, 3, 3, 10, false)) === 17, 'a non-contiguous wand takes the lone black pixel too');
		check(total(Selection.wand(im, 0, 0, 10, true)) === 64 - 17, 'the white around it');
		check(total(Selection.wand(im, 3, 3, 255, true)) === 64, 'tolerance 255 takes everything');
	}

	// outlines: a box is one loop; a ring is two; an L is six corners
	{
		check(sel(1, 2, 4, 6).outline().length === 1, 'a box has one loop');
		check(ring.outline().length === 2, `a ring has two loops (${ring.outline().length})`);
		const L = Selection.combine(sel(0, 0, 2, 6), sel(0, 4, 6, 6), 'add');
		check(L.outline().length === 1 && L.outline()[0].length === 12, `an L has one loop of six corners (${L.outline().map(l => l.length)})`);
	}

	console.log(bad ? `${bad} FAILED` : 'ok');
	process.exit(bad ? 1 : 0);
})();
