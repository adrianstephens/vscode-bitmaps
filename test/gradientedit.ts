
// Dragging an end of a gradient, with its handles as points: the same as the arithmetic on a flat list of numbers it was written as.
// It runs in Chrome, as the editor does (the page's modules are the compiled ones in out/webview).
const {openPage} = require('./pagehost');

(async () => {
	const view = await openPage({modules: {}}), {page} = view;

	const result: {n: number, bad: number, shown: string[]} = await page.evaluate(async () => {
		const {float2, float2x3} = await import('/node_modules/@isopodlabs/maths/esm/vector.js' as string);
		const {GradientEditor} = await import('/out/webview/gradientedit.js' as string);
		class Probe extends GradientEditor {
			constructor(points: any[]) { super('fill', points, float2x3.identity(), () => {}); }
			options() { return undefined; }
			commit() {}
			updateContent() {}
			drag(index: number, q: any, start: any, was: any[], o0: number, o1: number) { this.moveEnd(index, q, start, was, o0, o1); return this.points; }
		}

		// (the numbers version, as it was)
		function before(p: number[], index: number, qx: number, qy: number, start: number[], was: number[], o0: number, o1: number) {
			const radial = p.length > 6, span = o1 - o0;
			if (radial) {
				if (index === 0) {
					p[0] = was[0] + qx - start[0];
					p[1] = was[1] + qy - start[1];
				} else if (o1 > 1e-6) {
					p[3] = was[0] + (qx - was[0]) / o1;
					p[4] = was[1] + (qy - was[1]) / o1;
				}
			} else if (span > 1e-6) {
				const vx = was[3] - was[0], vy = was[4] - was[1];
				const [fx, fy] = index === 0 ? [was[0] + o1 * vx, was[1] + o1 * vy] : [was[0] + o0 * vx, was[1] + o0 * vy];
				const nx = (index === 0 ? fx - qx : qx - fx) / span, ny = (index === 0 ? fy - qy : qy - fy) / span;
				p[0] = (index === 0 ? qx : fx) - o0 * nx;
				p[1] = (index === 0 ? qy : fy) - o0 * ny;
				p[3] = p[0] + nx;
				p[4] = p[1] + ny;
			} else {
				p[index === 0 ? 0 : 3] = was[index === 0 ? 0 : 3] + qx - start[0];
				p[index === 0 ? 1 : 4] = was[index === 0 ? 1 : 4] + qy - start[1];
			}
			return p;
		}

		let seed = 7;
		const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		let bad = 0, n = 0;
		const shown: string[] = [];
		for (let k = 0; k < 400; k++) {
			const radial = k % 2 === 1;
			const a = float2(rnd() * 100, rnd() * 100), b = float2(rnd() * 100, rnd() * 100), f = float2(rnd() * 100, rnd() * 100);
			const q = float2(rnd() * 100, rnd() * 100), start = float2(rnd() * 100, rnd() * 100);
			const index = rnd() < 0.5 ? 0 : 1;
			const o0 = rnd() < 0.2 ? 0 : rnd() * 0.4, o1 = rnd() < 0.2 ? o0 : 0.6 + rnd() * 0.4;
			const points = radial ? [a, b, f] : [a, b];
			const flat = radial ? [a.x, a.y, 1, b.x, b.y, 1, f.x, f.y, 1] : [a.x, a.y, 1, b.x, b.y, 1];
			const got = new Probe(points.slice()).drag(index, q, start, points.slice(), o0, o1);
			const want = before(flat.slice(), index, q.x, q.y, [start.x, start.y], flat, o0, o1);
			const same = got.every((g: any, i: number) => Math.abs(g.x - want[i * 3]) < 1e-9 && Math.abs(g.y - want[i * 3 + 1]) < 1e-9);
			n++;
			if (!same) { bad++; if (shown.length < 4) shown.push(`${radial ? 'radial' : 'linear'} end ${index} offsets ${o0.toFixed(2)} ${o1.toFixed(2)}`); }
		}
		return {n, bad, shown};
	});
	for (const s of result.shown) console.log('differs:', s);
	console.log(result.bad ? `${result.bad} of ${result.n} drags differ` : `${result.n} drags the same as before`);
	await view.close();
	if (result.bad) process.exitCode = 1;
})();
