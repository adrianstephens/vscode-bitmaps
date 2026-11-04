// What a bundle for a web page puts in place of Node's `fs`, `fs/promises`, `os`, `zlib` and `crypto`, which the packages import for the work they do
// on files and fonts of a machine. A page has none of them to read, so the functions that find things find nothing, and the rest say so (zlib's
// deflate and inflate are real, over the streams of the browser).
const unavailable = name => () => { throw new Error(`${name} is not available in a web page`); };

export const readFileSync = unavailable('fs.readFileSync'), writeFileSync = unavailable('fs.writeFileSync'), statSync = unavailable('fs.statSync');
export const existsSync = () => false, readdirSync = () => [];
export const readFile = unavailable('fs.readFile'), writeFile = unavailable('fs.writeFile'), stat = unavailable('fs.stat'), readdir = unavailable('fs.readdir');
export const promises = {readFile, writeFile, stat, readdir};
export const homedir = () => '/', tmpdir = () => '/tmp', platform = () => 'browser', hostname = () => 'web';
// zlib's callback functions, over the streams a browser has (which do deflate, deflate-raw and gzip, but not brotli)
const through = (Stream, format) => (bytes, options, callback = options) =>
	new Response(new Blob([bytes]).stream().pipeThrough(new Stream(format))).arrayBuffer().then(a => callback(null, new Uint8Array(a)), callback);
export const inflate = through(DecompressionStream, 'deflate'), inflateRaw = through(DecompressionStream, 'deflate-raw'), gunzip = through(DecompressionStream, 'gzip');
export const deflate = through(CompressionStream, 'deflate'), deflateRaw = through(CompressionStream, 'deflate-raw'), gzip = through(CompressionStream, 'gzip');
export const brotliDecompress = unavailable('zlib.brotliDecompress'), brotliCompress = unavailable('zlib.brotliCompress');
export const createHash = unavailable('crypto.createHash'), randomBytes = unavailable('crypto.randomBytes');
export const constants = {};
export default {readFileSync, writeFileSync, statSync, existsSync, readdirSync, readFile, writeFile, stat, readdir, promises, homedir, tmpdir, platform, hostname,
	inflate, inflateRaw, gunzip, deflate, deflateRaw, gzip, brotliDecompress, brotliCompress, createHash, randomBytes, constants};
