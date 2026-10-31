// A colour as its red, green and blue (0 to 255), and the strings it is shown and typed as; and the numbers between 0 and 1 that mix and shade them.

export interface RGB {
	r: number;
	g: number;
	b: number;
}
export function RGB(r: number, g: number, b: number) { return {r, g, b}; }

export const toHex = ({r, g, b}: RGB) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** From #rrggbb. */
export const fromHex = (text: string): RGB => ({r: parseInt(text.slice(1, 3), 16), g: parseInt(text.slice(3, 5), 16), b: parseInt(text.slice(5, 7), 16)});

/** As CSS has it, with an opacity. */
export const toCss = ({r, g, b}: RGB, opacity = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${opacity})`;

export const sameColour = (a: RGB, b: RGB) => Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b);

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A number part of the way (0 to 1) from one to another. */
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** A colour part of the way (0 to 1) from one to another, to whole channels if `round`. */
export const mixColour = (a: RGB, b: RGB, u: number, round = false): RGB => {
	const mix = round ? (x: number, y: number) => Math.round(lerp(x, y, u)) : (x: number, y: number) => lerp(x, y, u);
	return {r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b)};
};
