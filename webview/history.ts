// The webview's half of an undo history, for an editor whose edits are too big to send to the extension (the bitmap editor's
// pixels): VS Code keeps the edits by their labels, and sends undo and redo back; what each one does is kept here. An edit is
// told to VS Code as soon as it is recorded, so the two stay in step: nothing is held back to be recorded later.
//
// Besides edits made all at once (record), there are values turned or dragged a step at a time (adjust), which are one edit while
// they go on, and previews (preview), shown but not edits at all, which are taken back as soon as anything else is done.
// Steps, which says when a step continues an adjustment, is also for an editor whose history is the extension's (the SVG editor's
// session, which sends the steps after the first as changes to the edit the first made).

export interface HistoryEntry {
	undo(): void;
	redo(): void;
}

const MAX_HISTORY	= 200;
const ADJUSTING		= 500;		// ms: a step of an adjustment this soon after the last one is part of the same edit

/** Whether a step of an adjustment continues the one before it: of the same thing (key and label), soon after it, and nothing else
 *  done in between (end). */
export class Steps {
	private last: {key: unknown, label: string, time: number} | undefined;

	step(key: unknown, label: string) {
		const now = performance.now(), l = this.last;
		this.last = {key, label, time: now};
		return !!l && l.key === key && l.label === label && now - l.time < ADJUSTING;
	}

	end() {
		this.last = undefined;
	}
}

export class History {
	private entries:	HistoryEntry[] = [];
	private position	= 0;
	private steps		= new Steps;
	private adjusting:	(HistoryEntry & {after: unknown}) | undefined;		// the edit the steps of an adjustment change
	private previewing:	{key: unknown, revert: () => void} | undefined;

	constructor(private readonly edited: (label: string) => void) {}

	/** Nothing to undo: a new document. */
	clear() {
		this.previewing	= undefined;
		this.settle();
		this.entries	= [];
		this.position	= 0;
	}

	/** An edit, already done. */
	push(entry: HistoryEntry, label: string) {
		this.endPreview();
		this.settle();
		this.entries.length = this.position;
		this.entries.push(entry);
		if (this.entries.length > MAX_HISTORY)
			this.entries.shift();
		this.position = this.entries.length;
		this.edited(label);
	}

	record(label: string, undo: () => void, redo: () => void) {
		this.push({undo, redo}, label);
	}

	undo() {
		this.endPreview();
		this.settle();
		if (this.position > 0)
			this.entries[--this.position].undo();
	}

	redo() {
		this.endPreview();
		this.settle();
		if (this.position < this.entries.length)
			this.entries[this.position++].redo();
	}

	/** A value of something (`key`, which with the label says which value it is) set a step at a time, as by the wheel or a drag: each
	 *  step is set at once, and the steps are one edit, from what it was before the first to what it is after the last, until something
	 *  else is done, or it is left alone for a moment, or `settle` says it is finished. */
	adjust<T>(key: unknown, label: string, get: () => T, set: (v: T) => void, value: T) {
		this.endPreview();
		const a = this.adjusting;
		if (this.steps.step(key, label) && a && this.entries[this.position - 1] === a) {
			a.after = value;
			set(value);
			return;
		}
		const before = get();
		if (before === value)
			return;
		const entry = {after: value as unknown, undo: () => set(before), redo: () => set(entry.after as T)};
		set(value);
		this.push(entry, label);			// (which ends any adjustment before this one)
		this.steps.step(key, label);
		this.adjusting = entry;
	}

	/** The adjustment going on is finished: another step is another edit. */
	settle() {
		this.steps.end();
		this.adjusting = undefined;
	}

	/** Something shown for a while, which is not an edit (what a blend mode would look like, while the pointer is on it): `revert` takes
	 *  it back, which is done when another preview starts, when anything is edited, undone or redone, or when endPreview is called. */
	preview(key: unknown, revert: () => void) {
		if (this.previewing?.key !== key)
			this.endPreview();
		this.previewing ??= {key, revert};
	}

	/** The preview there is, of this key or of any, taken back. */
	endPreview(key?: unknown) {
		const p = this.previewing;
		if (!p || (key !== undefined && p.key !== key))
			return;
		this.previewing = undefined;
		p.revert();
	}
}
