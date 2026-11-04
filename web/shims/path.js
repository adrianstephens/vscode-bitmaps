// Node's `path`, the POSIX part of it, for the bundles of the web pages (web/build.js): what src/scad and the packages it uses ask of it.
export const sep = '/', delimiter = ':';

export function normalize(p) {
	const abs = p.startsWith('/'), out = [];
	for (const part of p.split('/')) {
		if (!part || part === '.')
			continue;
		if (part === '..' && out.length && out[out.length - 1] !== '..')
			out.pop();
		else if (part !== '..' || !abs)
			out.push(part);
	}
	return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
export const join = (...parts) => normalize(parts.filter(Boolean).join('/'));
export const isAbsolute = p => p.startsWith('/');
export const resolve = (...parts) => {
	let r = '';
	for (let i = parts.length; i-- && !isAbsolute(r);)
		r = parts[i] + (r ? '/' + r : '');
	return normalize(isAbsolute(r) ? r : '/' + r);
};
export const basename = (p, ext) => {
	const b = p.replace(/\/+$/, '').split('/').pop() ?? '';
	return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
};
export const dirname = p => {
	const i = p.replace(/\/+$/, '').lastIndexOf('/');
	return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i);
};
export const extname = p => {
	const b = basename(p), i = b.lastIndexOf('.');
	return i <= 0 ? '' : b.slice(i);
};
export const relative = (from, to) => {
	const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i])
		i++;
	return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
};
export const parse = p => ({root: isAbsolute(p) ? '/' : '', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p))});
export const posix = {sep, delimiter, normalize, join, isAbsolute, resolve, basename, dirname, extname, relative, parse};
export default posix;
