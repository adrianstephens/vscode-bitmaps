// The bitmap editor's pixel work with no page (webview/raster.ts): an image flipped, turned, cropped and warped, the part of a
// picture a selection covers carried by a transform.
// Run in a page (pagehost.js), where the viewer's modules load as it has them. Run: npx tsc -b, then node test/raster.js
const {openPage} = require('./pagehost');

(async () => {
	const view = await openPage({modules: {}});
	const out = await view.page.evaluate(async () => {
		const log = [];
		let bad = 0;
		const check = (ok, msg) => { if (!ok) { log.push(`   FAIL: ${msg}`); bad++; } };

		const blank = (w, h, rgba = [0, 0, 0, 0]) => {
			const data = new Uint8ClampedArray(w * h * 4);
			for (let i = 0; i < w * h; i++)
				data.set(rgba, i * 4);
			return {data, width: w, height: h};
		};
		const px = (im, x, y) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
		const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
		const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

		const R = await import('/out/webview/raster.js');
		const W = await import('/out/webview/transformbox.js');
		const {Selection} = await import('/out/webview/bitmapSelection.js');
		const {float2, float3, float3x3} = await import('@isopodlabs/maths/vector');
		const box = (x, y, w, h) => float2.extent.fromSize(float2(x, y), float2(w, h));

		// the extent of what is not transparent
		{
			const im = blank(20, 20);
			for (const [x, y] of [[5, 6], [9, 8]])
				im.data.set(RED, (y * 20 + x) * 4);
			const e = R.alphaExtent(im);
			check(e.min.x === 5 && e.min.y === 6 && e.max.x === 10 && e.max.y === 9, `the extent of what is there (${e.min.x},${e.min.y} to ${e.max.x},${e.max.y})`);
			const c = R.crop(im, e);
			check(c.width === 5 && c.height === 3 && same(Array.from(c.data.slice(0, 4)), RED) && same(px(c, 4, 2), RED), 'cropped to it, with its pixels');
			check(R.alphaExtent(blank(5, 5)) === undefined, 'an empty one has none');
		}

		// crop, flip, rotate
		{
			const im = blank(3, 2);
			for (let i = 0; i < 6; i++)
				im.data.set([i * 10, 0, 0, 255], i * 4);		// row 0: 0 10 20, row 1: 30 40 50
			const r = v => Array.from({length: v.width * v.height}, (_, i) => v.data[i * 4]);
			check(same(r(R.flip(im, true)), [20, 10, 0, 50, 40, 30]), 'flip horizontal');
			check(same(r(R.flip(im, false)), [30, 40, 50, 0, 10, 20]), 'flip vertical');
			const cw = R.rotate(im, true);
			check(cw.width === 2 && cw.height === 3 && same(r(cw), [30, 0, 40, 10, 50, 20]), `rotate clockwise (${r(cw)})`);
			const ccw = R.rotate(im, false);
			check(same(r(ccw), [20, 50, 10, 40, 0, 30]), `rotate anticlockwise (${r(ccw)})`);
			check(same(r(R.rotate(R.rotate(im, true), false)), r(im)), 'clockwise then anticlockwise is the identity');
			const c = R.crop(im, box(1, 0, 2, 2));
			check(c.width === 2 && same(r(c), [10, 20, 40, 50]), 'crop');
		}

		// transforms: the image carried by a homography
		{
			const im = blank(6, 4);
			for (let i = 0; i < 24; i++)
				im.data.set([i * 10, 255 - i * 10, (i * 37) & 255, 255], i * 4);
			check(same(Array.from(R.warpCPU(im, float3x3.identity(), box(0, 0, 6, 4)).data), Array.from(im.data)), 'a warp by nothing changes nothing');
			// a quarter turn clockwise about the origin, then across by the new width: (x, y) to (4 - y, x)
			const turn = float3x3(float3(0, 1, 0), float3(-1, 0, 0), float3(4, 0, 1));
			check(same(Array.from(R.warpCPU(im, turn, box(0, 0, 4, 6)).data), Array.from(R.rotate(im, true).data)), 'a warp by a quarter turn is the turned image, exactly');
			const blocks = blank(4, 4);
			for (let y = 0; y < 4; y++)
				for (let x = 0; x < 4; x++)
					blocks.data.set((x < 2) === (y < 2) ? RED : BLUE, (y * 4 + x) * 4);
			const half = R.warpCPU(blocks, float3x3(float3(0.5, 0, 0), float3(0, 0.5, 0), float3(0, 0, 1)), box(0, 0, 2, 2));
			check(same(px(half, 0, 0), RED) && same(px(half, 1, 0), BLUE) && same(px(half, 1, 1), RED), `halved, each pixel is the four it came from (${px(half, 0, 0)} ${px(half, 1, 0)})`);
			// transparent pixels lend none of their colour: red beside transparent blue, sampled between them, is red
			const edge = blank(2, 1);
			edge.data.set(RED, 0);
			edge.data.set([0, 0, 255, 0], 4);
			const mid = R.warpCPU(edge, float3x3(float3(1, 0, 0), float3(0, 1, 0), float3(-0.5, 0, 1)), box(0, 0, 1, 1));
			check(px(mid, 0, 0)[0] === 255 && px(mid, 0, 0)[2] === 0 && Math.abs(px(mid, 0, 0)[3] - 128) <= 1, `between red and transparent is half-transparent red (${px(mid, 0, 0)})`);

			// the whole pixels a rectangle covers once it is carried; nothing if it goes behind the horizon
			const b = W.carriedBounds(float3x3.translate(float2(1.5, 2)), box(0, 0, 4, 3));
			check(b.min.x === 1 && b.min.y === 2 && b.max.x === 6 && b.max.y === 5, `the whole pixels it covers (${b.min.x},${b.min.y} to ${b.max.x},${b.max.y})`);
			check(W.carriedBounds(float3x3(float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, -1)), box(0, 0, 4, 3)) === undefined, 'nothing, behind the horizon');
		}

		// the part of a picture a selection covers, carried by a transform
		{
			// a 10 x 10 picture of red, with a blue square of 4 x 4 at (2, 2)
			const im = blank(10, 10, RED);
			for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) im.data.set(BLUE, (y * 10 + x) * 4);
			const square = Selection.rect(box(2, 2, 4, 4));

			const {floating, rest} = R.liftSelection(im, square);
			check(same(px(floating, 3, 3), BLUE) && px(floating, 0, 0)[3] === 0 && px(floating, 7, 7)[3] === 0, 'what is selected is lifted, and only that');
			check(px(rest, 3, 3)[3] === 0 && same(px(rest, 0, 0), RED) && same(px(rest, 7, 7), RED), 'and what is left has a hole where it was');
			check(same(px(im, 3, 3), BLUE), 'the picture is not changed');

			// carried 4 across and 3 down: the square is there, and its old place is open
			const moved = R.warpSelected(im, square, float3x3.translate(float2(4, 3)), R.warpCPU);
			check(same(px(moved, 7, 6), BLUE) && same(px(moved, 6, 5), BLUE), `the selected part is where it was carried (${px(moved, 7, 6)})`);
			check(px(moved, 3, 3)[3] === 0, 'and where it was is open');
			check(same(px(moved, 0, 0), RED) && same(px(moved, 9, 0), RED), 'the rest is as it was');
			// laid over what is there: the part which lands on red is blue, not a mixture
			check(same(px(moved, 6, 5), BLUE) && px(moved, 6, 5)[3] === 255, 'laid over, not mixed in');

			// carried off the edge, what is off it is lost
			const off = R.warpSelected(im, square, float3x3.translate(float2(7, 0)), R.warpCPU);
			check(same(px(off, 9, 2), BLUE) && off.width === 10, 'carried partly off the picture, what is on it is kept');

			// a partly selected pixel is partly carried
			const half = Selection.fromPolygons([[float2(0, 0), float2(5.5, 0), float2(5.5, 10), float2(0, 10)]], float2(10, 10));
			const lifted = R.liftSelection(blank(10, 10, RED), half);
			check(lifted.floating.data[(5 * 4) + 3] === 128 || Math.abs(lifted.floating.data[(5 * 4) + 3] - 128) <= 2, `a pixel half inside is half lifted (${lifted.floating.data[(5 * 4) + 3]})`);
			check(Math.abs(lifted.rest.data[(5 * 4) + 3] + lifted.floating.data[(5 * 4) + 3] - 255) <= 1, 'and the rest of it is what is left');
		}

		log.push(bad ? `${bad} FAILED` : 'ok');
		return log;
	});
	console.log(out.join('\n'));
	await view.close();
	process.exit(out.some(l => l.includes('FAIL')) ? 1 : 0);
})();
