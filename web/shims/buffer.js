// The part of Node's Buffer that the packages use (base64 to and from bytes, and text), put in a bundle for a web page (web/build.js) where the
// page has no Buffer. A Uint8Array that can say what it is in base64, hex or text.
const toBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

class ByteBuffer extends Uint8Array {
	toString(encoding = 'utf8') {
		switch (encoding) {
			case 'base64':	return toBase64(this);
			case 'hex':		return Array.from(this, b => b.toString(16).padStart(2, '0')).join('');
			case 'latin1':
			case 'binary':	return String.fromCharCode(...this);
			default:		return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(this);
		}
	}
	static from(source, encoding) {
		if (typeof source === 'string') {
			switch (encoding) {
				case 'base64':	return new ByteBuffer(Uint8Array.from(atob(source.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
				case 'hex':		return new ByteBuffer(Uint8Array.from(source.match(/../g) ?? [], h => parseInt(h, 16)));
				default:		return new ByteBuffer(new TextEncoder().encode(source));
			}
		}
		return new ByteBuffer(source instanceof ArrayBuffer ? source : Uint8Array.from(source));
	}
	static alloc(size) { return new ByteBuffer(size); }
	static isBuffer(x) { return x instanceof ByteBuffer; }
	static byteLength(s) { return new TextEncoder().encode(s).length; }
	static concat(list) {
		const out = new ByteBuffer(list.reduce((n, b) => n + b.length, 0));
		let at = 0;
		for (const b of list) { out.set(b, at); at += b.length; }
		return out;
	}
}
export const Buffer = ByteBuffer;
