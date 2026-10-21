// Images that live inside another document (an SVG's data: URI) opened in the bitmap editor through a file system of their
// own: the editor reads and writes them as it would a file, and the owner is handed whatever is saved.
import * as vscode from 'vscode';

export const SCHEME = 'embedded-image';

interface Entry {
	data:	Uint8Array;
	ctime:	number;
	mtime:	number;
	gone?:	string;							// why the image can no longer be saved, once its owner has lost it
	write(data: Uint8Array): void;			// the owner takes what was saved
}

export interface EmbeddedImage extends vscode.Disposable {
	readonly uri: vscode.Uri;
	update(data: Uint8Array): void;			// the owner's image is now this, which the editor shows
	lose(reason: string): void;				// the owner no longer has the image
}

const MIME_EXTENSIONS: Record<string, string> = {'image/png': '.png', 'image/jpeg': '.jpg'};

/** The bytes and type of a base64 data: URI of a kind the bitmap editor can write back, or undefined. */
export function parseDataUri(href: string) {
	const m = /^data:(image\/(?:png|jpeg));base64,([^"']*)$/i.exec(href.trim());
	return m && {mime: m[1].toLowerCase(), extension: MIME_EXTENSIONS[m[1].toLowerCase()], data: new Uint8Array(Buffer.from(m[2], 'base64'))};
}

export const dataUri = (mime: string, data: Uint8Array) => `data:${mime};base64,${Buffer.from(data).toString('base64')}`;

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

class EmbeddedImages implements vscode.FileSystemProvider {
	private readonly entries = new Map<string, Entry>();
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;
	private count = 0;

	/** Makes an image available to open at the returned uri; `write` is given the bytes each time the editor saves it. */
	add(name: string, data: Uint8Array, write: (data: Uint8Array) => void): EmbeddedImage {
		const uri	= vscode.Uri.from({scheme: SCHEME, path: `/${++this.count}/${name}`});
		const key	= uri.toString();
		const now	= Date.now();
		const entry: Entry = {data, ctime: now, mtime: now, write};
		this.entries.set(key, entry);
		return {
			uri,
			update: data => {
				entry.gone = undefined;
				if (!sameBytes(entry.data, data)) {
					entry.data = data;
					entry.mtime = Date.now();
					this.changed.fire([{type: vscode.FileChangeType.Changed, uri}]);
				}
			},
			lose: reason => { entry.gone = reason; },
			dispose: () => { this.entries.delete(key); },
		};
	}

	/** Calls back when an image's bytes are changed by its owner (not by the editor saving it). */
	onChange(uri: vscode.Uri, callback: () => void) {
		return this.onDidChangeFile(events => {
			if (events.some(e => e.uri.toString() === uri.toString()))
				callback();
		});
	}

	private entry(uri: vscode.Uri) {
		const entry = this.entries.get(uri.toString());
		if (!entry)
			throw vscode.FileSystemError.FileNotFound(uri);
		return entry;
	}

	watch() { return new vscode.Disposable(() => {}); }
	stat(uri: vscode.Uri): vscode.FileStat {
		const {data, ctime, mtime} = this.entry(uri);
		return {type: vscode.FileType.File, ctime, mtime, size: data.length};
	}
	readDirectory(): [string, vscode.FileType][] { return []; }
	createDirectory(uri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(uri); }
	readFile(uri: vscode.Uri) { return this.entry(uri).data; }
	writeFile(uri: vscode.Uri, content: Uint8Array) {
		const entry = this.entry(uri);
		if (entry.gone)
			throw vscode.FileSystemError.Unavailable(entry.gone);
		entry.write(content);
		entry.data	= content;
		entry.mtime	= Date.now();
	}
	delete(uri: vscode.Uri) { this.entries.delete(uri.toString()); }
	rename(oldUri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(oldUri); }
}

export const embedded = new EmbeddedImages();
