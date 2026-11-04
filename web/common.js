// What the web pages of the editors share: the stand-in for the extension's messaging, downloads, opening files and reading shapes.

// a path or basic shape as the points the SVG editor takes, left open where a contour's last point is ON_END (the pages have no SVG parser)
export async function shapePoints(name, attributes) {
	const {parseSVGshape, makeCurve, bezier3Curve} = await import('@isopodlabs/binary_fonts');
	return bezier3Curve(makeCurve(parseSVGshape({name, attributes}, true) ?? {run() {}}), 1e-6);
}

// The digits the floor's axes are numbered with, baked into an atlas (src/glyphatlas.ts) from the font the pages carry; undefined if that
// cannot be had, and the floor goes without numbers. Made once.
let atlas;
export const digitAtlas = () => atlas ??= (async () => {
	try {
		const {digitAtlasOf} = await import('../out/web/glyphatlas.js');
		const response = await fetch('../assets/inter-digits.woff');
		return response.ok ? await digitAtlasOf(new Uint8Array(await response.arrayBuffer())) : undefined;
	} catch (error) {
		console.warn('the floor has no numbers:', error.message ?? error);
	}
})();

export const send = message => window.postMessage(message, '*');

export function download(blob, name) {
	const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: name});
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// requests this side has made of the page, by id, waiting for its {resultId, result}
const pending = new Map();
let nextId = 1 << 20;	// apart from the page's own request ids
export const request = message => new Promise(resolve => { const requestId = nextId++; pending.set(requestId, resolve); send({...message, requestId}); });

// A file handed from the start page to an editor page, which a navigation cannot carry, through IndexedDB
const handoffStore = () => new Promise((resolve, reject) => {
	const open = indexedDB.open('web-editors', 1);
	open.onupgradeneeded = () => open.result.createObjectStore('handoff');
	open.onsuccess = () => resolve(open.result);
	open.onerror = () => reject(open.error);
});
const handoffDo = async (mode, f) => {
	const db = await handoffStore();
	return new Promise((resolve, reject) => {
		const t = db.transaction('handoff', mode), result = f(t.objectStore('handoff'));
		t.oncomplete = () => { db.close(); resolve(result.result); };
		t.onerror = () => reject(t.error);
	});
};
export const handOff = file => handoffDo('readwrite', store => store.put({file, name: file.name}, 'file'));
/** The file the start page handed over, once (it is taken); a File of its name. */
export async function takeHandoff() {
	const entry = await handoffDo('readwrite', store => { const r = store.get('file'); store.delete('file'); return r; });
	return entry && new File([entry.file], entry.name, {type: entry.file.type});
}

// What is shown until a file is open: a prompt and a button to choose one, and the page takes files dropped or pasted too.
// `open` is given the file; `accepts` says which of the pasted files are for it. The result's `message` shows an error in place of the prompt.
export function openers(prompt, button, accept, open, accepts = () => true) {
	const welcome = Object.assign(document.createElement('div'), {innerHTML: `<p>${prompt}</p><button>${button}</button>`});
	welcome.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;z-index:10;font:14px sans-serif;color:#888;pointer-events:none';
	const line = welcome.firstChild, choose = welcome.querySelector('button');
	choose.style.cssText = 'pointer-events:auto;padding:6px 14px;border:1px solid #888;border-radius:4px;background:none;color:inherit;font:inherit;cursor:pointer';
	choose.onclick = () => Object.assign(document.createElement('input'), {type: 'file', accept, onchange(e) { const f = e.target.files[0]; if (f) open(f); }}).click();
	document.body.append(welcome);

	addEventListener('paste', e => { const f = [...e.clipboardData.files].find(accepts); if (f) open(f); });
	addEventListener('dragover', e => e.preventDefault());
	addEventListener('drop', e => {
		e.preventDefault();
		const file = e.dataTransfer?.files[0];
		if (file)
			open(file);
	});
	return {remove: () => welcome.remove(), message: text => { line.textContent = text; welcome.style.display = ''; }};
}

// What acquireVsCodeApi gives the page, with `command` for the extension's side of the conversation: it is given each message the
// page posts, and what it returns (or throws) answers a request. The page's `RPC` expects the answer as {resultId, result}.
export function installHost(command) {
	window.acquireVsCodeApi = () => ({
		postMessage: async message => {
			if ('resultId' in message) {				// the page answering a request of ours
				pending.get(message.resultId)?.(message.result);
				pending.delete(message.resultId);
				return;
			}
			try {
				const result = await command(message);
				if ('requestId' in message)
					send({resultId: message.requestId, result});
			} catch (error) {
				console.error(error);
				if ('requestId' in message)
					send({resultId: message.requestId, result: undefined});
			}
		},
		getState: () => undefined,
		setState: () => {},
	});
}
