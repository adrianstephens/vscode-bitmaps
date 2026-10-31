import * as fs from 'fs';
import * as path from 'path';

// `use`/`include`/surface()/import() read files from inside the synchronous parser and evaluator, and a blocking
// readFileSync/existsSync there stalls the extension host (keystrokes are dropped). So they read from a cache that
// is filled asynchronously instead: a path not in the cache is recorded as a miss and answered with a placeholder,
// the run's result is thrown away, and with() loads what was missed (concurrently, off the main thread) and runs
// again. Only the files a document actually touches are loaded, and a run that misses nothing is the real one.
//
// Resolution order: a path that is not there relative to the including file falls back to each directory of the
// library path, the way OpenSCAD's own OPENSCADPATH lets a library like MCAD resolve without every project
// vendoring its own copy. A path found in none resolves to nothing, which is what OpenSCAD does with a missing
// library. The library path is asked for afresh on every call, so a change takes effect on the next edit.
//
// What a reader makes of a file's bytes is kept with it, under a key naming the reader (a file can be import()ed and
// dxf_dim()ed, each making something different). A reader should make only what the bytes say: anything that depends
// on the call that asked belongs to the caller, since the result is shared by every call and every run.
//
// Between runs an entry is kept only while its mtime and size still match (one async stat each, at the start of
// with()), a missing file is looked for again, and an entry no run has used for a while is dropped.

type Reader<T = any> = (bytes: Uint8Array) => T | Promise<T>;

interface FileEntry {
	mtimeMs:	number;
	size:		number;
	used:		number;										// the last run that asked for it
	values:		Map<string, {value?: any, error?: string}>;
}

export interface ScadFiles {
	resolve(written: string, fromDir: string): string | undefined;
	read<T>(full: string, key?: string, reader?: Reader<T>): T | undefined;
}

export interface AsyncFiles {
//	resolve(written: string, fromDir: string): string | undefined;
	read<T>(full: string, key?: string, reader?: Reader<T>): Promise<T | undefined>;
}


export const asyncFileReader: AsyncFiles = {
	async read<T>(full: string, _key?: string, reader?: (bytes: Uint8Array) => T | Promise<T>): Promise<T | undefined> {
		const bytes = await fs.promises.readFile(full);
		return reader ? reader(bytes) : bytes as T;
	}
};

const KEEP_RUNS = 32;

export class FileReader implements ScadFiles {
	private entries			= new Map<string, FileEntry | null>();	// null: looked for and not there (or not a file)
//	private missingStats	= new Set<string>();
	private missingValues	= new Map<string, Map<string, Reader>>();
	private queue: Promise<unknown> = Promise.resolve();
	private run				= 0;

	constructor(private libraryPath: () => string[] = () => []) {}

	private lookup(full: string) {
		const entry = this.entries.get(full);
		if (entry)
			entry.used = this.run;
		return entry;
	}

	private exists(full: string): boolean | undefined {
		const entry = this.lookup(full);
		if (entry === undefined)
			this.missingValues.set(full, new Map());
		else
			return !!entry;
	}

	resolve(written: string, fromDir: string) {
		const candidates = path.isAbsolute(written) ? [written] : [
			path.join(fromDir, written),
			...this.libraryPath().map(dir => path.join(dir, written)),
		];
		let found: string | undefined, complete = true;
		for (const full of candidates) {
			const x = this.exists(full);
			if (x === undefined)
				complete = false;
			else if (x && complete && !found)
				found = full;
		}
		return found;
	}

	read<T>(full: string, key: string, reader: Reader<T>): T | undefined {
		const entry = this.lookup(full);
		if (entry === null)
			throw new Error(`ENOENT: ${full}`);
		const made = entry?.values.get(key);
		if (made) {
			if (made.error !== undefined)
				throw new Error(made.error);
			return made.value;
		}
		let wanted = this.missingValues.get(full);
		if (!wanted)
			this.missingValues.set(full, wanted = new Map());
		wanted.set(key, reader);
	}

	/** Run `run` -- which reads through this -- and give its result, loading whatever it asked for that was not
	 *  cached yet and running it again until nothing is missing. Runs are queued, since they share the cache. */
	with<T>(run: () => T | Promise<T>): Promise<T> {
		const result = this.queue.then(async () => {
			++this.run;
			// drop what changed on disk since the last run, what nothing has used lately, and retry what was missing
			await Promise.all([...this.entries].map(async ([full, entry]) => {
				if (entry && this.run - entry.used <= KEEP_RUNS) {
					try {
						const stat = await fs.promises.stat(full);
						if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size)
							return;
					} catch {}
				}
				this.entries.delete(full);
			}));

			for (;;) {
				let value: T | undefined, error: unknown, failed = false;
				try {
					value = await run();
				} catch (e) {
					error = e;
					failed = true;
				}
				if (!this.missingValues.size) {
					if (failed)
						throw error;
					return value as T;
				}
				// a miss means this run saw placeholders, so whatever it made or threw is not to be believed
				const values = this.missingValues;
				this.missingValues	= new Map;

				await Promise.all([...values.entries()].map(async ([full, readers]) => {
					try {
						const stat = await fs.promises.stat(full);
						if (stat.isFile()) {
							const entry = {mtimeMs: stat.mtimeMs, size: stat.size, used: this.run, values: new Map()};
							this.entries.set(full, entry);
							if (readers.size) {
								const bytes = new Uint8Array(await fs.promises.readFile(full));
								for (const [key, reader] of readers ?? []) {
									try {
										entry.values.set(key, {value: await reader(bytes)});
									} catch (e: any) {
										entry.values.set(key, {error: e?.message ?? String(e)});
									}
								}
							}
							return;
						}
					} catch {}
					this.entries.set(full, null);
				}));
			}
		});
		this.queue = result.catch(() => {});
		return result;
	}
}
