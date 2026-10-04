// rands(min, max, count, seed), reproducing OpenSCAD's own numbers for a given seed so a file that seeds it -- to get
// the same tree, or the same scatter, every time -- draws the same thing here. OpenSCAD (core/builtin_functions.cc)
// seeds a std::mt19937 with a hash of the seed number, and draws through std::uniform_real_distribution<double>;
// each of those has an exact definition, followed here.

// Python's numeric hash of a float, taken modulo 2^31 - 1, as OpenSCAD's hash_floating_point does (geometry/linalg.cc),
// then cast to the 32-bit seed. Two seeds that are close as numbers (1 and 1.0000001) land far apart.
export function seedOf(v: number): number {
	const BITS = 31, MODULUS = 0x7fffffff;
	if (!Number.isFinite(v))
		return Number.isNaN(v) ? 0 : (v > 0 ? 314159 : -314159) >>> 0;
	let sign = 1, e = 0, m = Math.abs(v);
	if (v < 0)
		sign = -1;
	if (m !== 0) {			// frexp: m in [0.5, 1), v = m * 2^e
		e = Math.floor(Math.log2(m)) + 1;
		m = m / 2 ** e;
		if (m >= 1) { m /= 2; e++; }
		if (m < 0.5) { m *= 2; e--; }
	}
	let x = 0;
	while (m) {
		x = (((x << 28) & MODULUS) | (x >>> (BITS - 28))) >>> 0;
		m *= 268435456;				// 2^28
		e -= 28;
		const y = Math.floor(m);
		m -= y;
		x += y;
		if (x >= MODULUS)
			x -= MODULUS;
	}
	e = e >= 0 ? e % BITS : BITS - 1 - ((-1 - e) % BITS);
	x = (((x << e) & MODULUS) | (x >>> (BITS - e))) >>> 0;
	return (x * sign) >>> 0;
}

// The 32-bit Mersenne Twister, std::mt19937.
export class MT19937 {
	private mt = new Uint32Array(624);
	private index = 624;

	constructor(seed: number) {
		this.seed(seed);
	}

	seed(seed: number) {
		this.mt[0] = seed >>> 0;
		for (let i = 1; i < 624; i++) {
			const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
			this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
		}
		this.index = 624;
	}

	next(): number {
		const mt = this.mt;
		if (this.index >= 624) {
			for (let i = 0; i < 624; i++) {
				const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
				mt[i] = mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
			}
			this.index = 0;
		}
		let y = mt[this.index++];
		y ^= y >>> 11;
		y ^= (y << 7) & 0x9d2c5680;
		y ^= (y << 15) & 0xefc60000;
		y ^= y >>> 18;
		return y >>> 0;
	}

	// std::uniform_real_distribution<double>(min, max)(engine): generate_canonical<double, 53> over a 32-bit engine
	// takes two draws, the first the low-order part, and divides by 2^64. This is libstdc++'s and libc++'s definition
	// (the Linux and macOS builds of OpenSCAD); MSVC's differs.
	uniform(min: number, max: number): number {
		const low = this.next(), high = this.next();
		let canonical = (low + high * 4294967296) / 18446744073709551616;
		if (canonical >= 1)
			canonical = 1 - Number.EPSILON / 2;
		return canonical * (max - min) + min;
	}
}
