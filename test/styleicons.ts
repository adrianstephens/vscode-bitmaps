// Makes the style menu's icons (assets/<style>.png): a small landscape put through each style's network in the bitmap viewer's page, in
// headless Chrome on the real GPU, and shrunk. Files that exist are left alone (--force remakes them). Run: npx tsc -b first, then
// npx ts-node -O '{"lib":["es2022","dom"]}' test/styleicons.ts [--force]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {openPage, pause} = require('./pagehost');
import * as items from './menuitems';

const models = path.join(__dirname, '../../../packages/binary_ml/assistant/models');
const assets = path.join(__dirname, '../assets');
const styles = ['mosaic', 'candy', 'rain-princess', 'udnie', 'pointilism'];
const force = process.argv.includes('--force');
const SIZE = 128, ICON = 64;

// a landscape, drawn from shapes: sky, sun, two hills, a house and a tree
function scene() {
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	const hill = (x: number, base: number, amp: number, k: number) => base + amp * Math.sin(x / k);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			let c = [90 + y * 0.9, 150 + y * 0.6, 235 - y * 0.2];						// sky
			if (Math.hypot(x - 96, y - 28) < 14)
				c = [255, 220, 90];														// sun
			if (y > hill(x, 78, 8, 14))
				c = [70, 150 - (y - 70) * 0.5, 70];										// far hill
			if (y > hill(x + 40, 98, 7, 11))
				c = [50, 115 - (y - 90) * 0.6, 55];										// near hill
			if (x >= 28 && x < 60 && y >= 70 && y < 98)
				c = [200, 70, 60];														// house
			if (y >= 56 + (x - 28) * 0 && y < 70 && x >= 24 + (70 - y) * 0 && x < 64 && x - 24 > 14 - (70 - y) * 1.1 && 64 - x > 14 - (70 - y) * 1.1)
				c = [110, 60, 40];														// roof
			if (x >= 40 && x < 48 && y >= 82 && y < 98)
				c = [90, 55, 30];														// door
			if (x >= 88 && x < 92 && y >= 74 && y < 100)
				c = [95, 60, 35];														// trunk
			if (Math.hypot(x - 90, y - 70) < 13)
				c = [30, 100, 40];														// leaves
			data.set([c[0], c[1], c[2], 255], (y * SIZE + x) * 4);
		}
	}
	return data;
}

// each pixel of the icon the average of the block of the picture it covers
function shrink(src: Uint8ClampedArray, from: number, to: number) {
	const out = new Uint8Array(to * to * 4), k = from / to;
	for (let y = 0; y < to; y++)
		for (let x = 0; x < to; x++) {
			const sum = [0, 0, 0];
			for (let j = 0; j < k; j++)
				for (let i = 0; i < k; i++)
					for (let c = 0; c < 3; c++)
						sum[c] += src[((y * k + j) * from + x * k + i) * 4 + c];
			out.set([...sum.map(s => Math.round(s / (k * k))), 255], (y * to + x) * 4);
		}
	return out;
}

const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type: string, body: Buffer) {
	const head = Buffer.alloc(8), tail = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	head.write(type, 4);
	tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])));
	return Buffer.concat([head, body, tail]);
}
function png(rgba: Uint8Array, size: number) {
	const rows = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++)
		Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);		// 8 bits, RGBA
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
	const todo = styles.filter(s => force || !fs.existsSync(path.join(assets, `${s}.png`)));
	if (!todo.length)
		return console.log('every icon exists (--force remakes them)');

	const edits: string[] = [], waiting = new Map<number, (r: any) => void>(), problems: string[] = [];
	let ready: () => void;
	const readyP = new Promise<void>(r => ready = r);
	const view = await openPage({
		script: 'bitmap.js', width: 700, height: 500, bitmap: true,
		problems: (m: string) => { if (!m.includes('HALF_FLOAT') && !m.includes('willReadFrequently') && !m.includes('texImage3D') && !m.includes('Level of detail')) problems.push(m); },
		host: (m: any, reply: (r: any) => void) => {
			if ('resultId' in m) waiting.get(m.resultId)?.(m.result);
			else if (m.command === 'ready') ready();
			else if (m.command === 'edited') edits.push(m.label);
			else if (m.command === 'model') reply(new Uint8Array(fs.readFileSync(path.join(models, `${m.name.slice(6)}-9.onnx`))));
			else if (m.command === 'error') problems.push(m.message);
		},
	});
	await readyP;
	const {page, send} = view;
	let rid = 100;
	const raw = async () => {
		const id = ++rid;
		const got = new Promise<any>(r => waiting.set(id, r));
		await send({command: 'getTexture', type: 'image/x-rgba', requestId: id});
		return new Uint8ClampedArray((await got).data);
	};

	await send({command: 'load2d', image: {data: scene(), width: SIZE, height: SIZE}});
	await pause(500);
	await page.keyboard.press('Escape');

	for (const style of todo) {
		const before = edits.length;
		await items.hover(page, ['filters', 'style', `style:${style}`], true);
		await items.choose(page, ['filters', 'style', `style:${style}`]);
		await items.hover(page, ['filters', 'style', `style:${style}`], false);
		for (let i = 0; i < 600 && edits.length === before; i++)
			await pause(100);
		if (edits.length === before)
			throw new Error(`${style}: the network made nothing${problems.length ? ` (${problems.join('; ')})` : ''}`);
		const out = await raw();
		fs.writeFileSync(path.join(assets, `${style}.png`), png(shrink(out, SIZE, ICON), ICON));
		console.log(`wrote assets/${style}.png`);
		await send({command: 'undo'});
		await pause(300);
	}
	await view.close?.();
	process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
