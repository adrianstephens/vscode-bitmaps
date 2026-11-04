// Stands in for the extension on a plain web page, for the OpenSCAD viewer, and makes it shadertoy-like: the text is edited beside the
// render, and every pause in typing evaluates it again, with the evaluator (src/scad/render.ts, bundled for the browser by web/build.js)
// running here in the page. The text is edited in CodeMirror (loaded from esm.sh; a plain text box when that is not to be had), is kept in
// the page's storage, can be given as ?src=url or in the link Share makes, and is saved with Ctrl/Cmd+S. The numbers at the top of the
// text have sliders, an example can be opened from the bar, and the files the text reads (use, include, surface(), import()) are the ones
// dropped on the page.
import {send, download, installHost, digitAtlas, takeHandoff} from './common.js';

const DEBOUNCE = 250;		// ms of quiet before a keystroke is evaluated
const STORE = 'scad-source';

const example = `// Edit this: the render beside it follows.
$fn = 48;

difference() {
	union() {
		cube([30, 30, 12], center = true);
		translate([0, 0, 6]) sphere(r = 11);
	}
	for (a = [0 : 90 : 270])
		rotate([0, 0, a]) translate([13, 0, 0]) rotate([0, 90, 0]) cylinder(h = 12, r = 4, center = true);
	translate([0, 0, -8]) cube([14, 40, 8], center = true);
}
`;

// the examples of the bar, which are files of web/examples
const examples = [
	['Rounded box', 'rounded-box.scad'], ['Gear', 'gear.scad'], ['Spiral staircase', 'spiral-stair.scad'], ['Bolt', 'bolt.scad'],
	['Functional surfaces', 'functional-surfaces.scad'], ['Mandelbulb', 'mandelbulb.scad'],
	['Displacement', 'displace.scad'],
	['Mandelbrot', 'mandelbrot.scad'],
];

const $ = id => document.getElementById(id);
const modules = $('scad-modules');
let name = 'model.scad', run;

// ---- the editor: CodeMirror, or the page's text box when that cannot be loaded (offline); either gives the text, takes it, and says when it changes

async function makeEditor() {
	const box = $('scad-source'), listeners = [];
	const changed = () => listeners.forEach(f => f());
	const plain = {
		get: () => box.value,
		set: text => { box.value = text; },
		replace: (from, to, text) => { box.setRangeText(text, from, to, 'preserve'); changed(); },
		onChange: f => listeners.push(f),
	};
	box.addEventListener('input', changed);
	box.addEventListener('keydown', e => {		// Tab is for the text
		if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			box.setRangeText('\t', box.selectionStart, box.selectionEnd, 'end');
			changed();
		}
	});
	try {
		const load = Promise.all([
			import('https://esm.sh/codemirror@6.0.1'),
			import('https://esm.sh/@codemirror/lang-cpp@6.0.2'),
			import('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
		]);
		const [{EditorView, basicSetup}, {cpp}, {oneDark}] = await Promise.race([load, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 6000))]);
		const host = Object.assign(document.createElement('div'), {id: 'scad-cm'});
		box.after(host);
		box.classList.add('hidden');
		let quiet = false;
		const view = new EditorView({
			parent: host,
			doc: box.value,
			extensions: [
				basicSetup, cpp(), oneDark,
				EditorView.domEventHandlers({keydown(e, v) {
					if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
						e.preventDefault();
						v.dispatch(v.state.replaceSelection('\t'), {scrollIntoView: true, userEvent: 'input'});
						return true;
					}
				}}),
				EditorView.updateListener.of(update => { if (update.docChanged && !quiet) changed(); }),
			],
		});
		return {
			get: () => view.state.doc.toString(),
			set: text => { quiet = true; view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}}); quiet = false; },
			replace: (from, to, text) => view.dispatch({changes: {from, to, insert: text}}),
			onChange: f => listeners.push(f),
		};
	} catch (error) {
		console.warn('the code editor could not be loaded, so the text is in a plain box:', error.message ?? error);
		return plain;
	}
}
const editor = await makeEditor();

// The files the text reads, as src/filereader.ts's FileReader gives them, over what was dropped: a read of one not yet made is answered
// with a placeholder and noted, and with() makes it and runs again.
class MemoryFiles {
	bytes = new Map();
	made = new Map();
	missing = new Map();

	add(file, bytes) {
		this.bytes.set(file, bytes);
		this.made.clear();
	}
	resolve(written, fromDir) {
		const dir = fromDir === '.' || fromDir === '/' ? '' : fromDir.replace(/\/+$/, '') + '/';
		return [dir + written, written, written.split('/').pop()].find(c => this.bytes.has(c));
	}
	read(full, key = '', reader) {
		const k = `${full}\0${key}`, made = this.made.get(k);
		if (made) {
			if (made.error !== undefined)
				throw new Error(made.error);
			return made.value;
		}
		this.missing.set(k, {full, k, reader});
	}
	async with(runIt) {
		for (;;) {
			let value, error, failed = false;
			try { value = await runIt(); } catch (e) { error = e; failed = true; }
			if (!this.missing.size) {
				if (failed)
					throw error;
				return value;
			}
			// a miss means this run saw placeholders, so whatever it made or threw is not to be believed
			const misses = [...this.missing.values()];
			this.missing.clear();
			await Promise.all(misses.map(async ({full, k, reader}) => {
				const bytes = this.bytes.get(full);
				if (!bytes)
					return void this.made.set(k, {error: `ENOENT: ${full}`});
				try { this.made.set(k, {value: reader ? await reader(bytes) : bytes}); } catch (e) { this.made.set(k, {error: e?.message ?? String(e)}); }
			}));
		}
	}
}
const files = new MemoryFiles();

// ---- evaluating

let renders = 0, bundle;
async function render() {
	const which = ++renders, stale = () => which !== renders;
	try {
		bundle ??= await import('../out/web/scad.js');
		const {run: running, names, drawn, warnings, model} = await bundle.renderScad(editor.get(), name, files, run, stale);
		run = running;
		const offered = {command: 'modules', names: !drawn || run ? names : [], running: run};
		showModules(offered);
		send(offered);
		if (model)
			send({command: 'sdf', ...model});
		else if (!stale())
			send({command: 'error', message: `nothing is drawn${warnings.length ? `:\n  ${warnings.join('\n  ')}` : ''}`});
	} catch (error) {
		if (which === renders)
			send({command: 'error', message: `${error?.message ?? error}`});
	}
}

let pending;
const later = () => { clearTimeout(pending); pending = setTimeout(render, DEBOUNCE); };
editor.onChange(() => {
	try { localStorage.setItem(STORE, editor.get()); } catch { /* storage is not there to keep it */ }
	later();
	laterParameters();
});

// the modules there are to run, which the page also offers in its own menu; here they are in the bar
function showModules({names, running}) {
	modules.classList.toggle('hidden', !names.length && !running);
	modules.replaceChildren(new Option('(the file itself)', ''), ...names.map(n => new Option(n, n)));
	modules.value = running ?? '';
}
modules.addEventListener('change', () => { run = modules.value || undefined; render(); });

// ---- sharing: the text, compressed, in the part of the address the server never sees

async function transform(Stream, bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const encode = async text => toBase64Url(await transform(CompressionStream, new TextEncoder().encode(text)));
const decode = async link => new TextDecoder().decode(await transform(DecompressionStream, fromBase64Url(link)));

$('scad-share').onclick = async event => {
	const button = event.currentTarget, label = button.textContent;
	const url = `${location.origin}${location.pathname}#code=${await encode(editor.get())}`;
	history.replaceState(null, '', url);
	try {
		await navigator.clipboard.writeText(url);
		button.textContent = 'Link copied';
	} catch {
		button.textContent = 'Link is in the address bar';
	}
	setTimeout(() => { button.textContent = label; }, 1800);
};

// ---- the examples

const picker = $('scad-examples');
picker.replaceChildren(new Option('Examples…', ''), ...examples.map(([title, file]) => new Option(title, file)));
picker.onchange = async () => {
	const file = picker.value;
	picker.value = '';
	if (file)
		setText(await (await fetch(`./examples/${file}`)).text(), file);
};

// ---- the parameters: the numbers and switches at the top of the text, which have sliders (the Customizer of OpenSCAD itself, which this
// does by the text and not apart from it: moving a slider changes the number in the text, and the render follows as it does for any edit).
// A hint in the comment after the line gives the range: // [min:max], // [min:step:max], or // [a, b, c] to choose from.

function parameters(text) {
	const found = [];
	let depth = 0, offset = 0;
	for (const line of text.split('\n')) {
		if (depth === 0) {
			const m = /^([$\w]+)\s*=\s*(true|false|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*;[ \t]*(?:\/\/\s*(.*))?$/id.exec(line);
			if (m) {
				const [from, to] = m.indices[2], value = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
				const parameter = {name: m[1], value, from: offset + from, to: offset + to};
				const hint = /^\[(.*)\]/.exec(m[3] ?? '')?.[1];
				if (typeof value === 'number') {
					const numbers = hint?.split(/[:,]/).map(Number);
					if (hint?.includes(':') && numbers.length >= 2 && numbers.every(Number.isFinite))
						Object.assign(parameter, numbers.length === 2 ? {min: numbers[0], max: numbers[1]} : {min: numbers[0], step: numbers[1], max: numbers[2]});
					else if (hint?.includes(',') && numbers.every(Number.isFinite))
						parameter.choices = numbers;
					else
						Object.assign(parameter, {min: Math.min(0, value * 4), max: value === 0 ? 10 : Math.max(0, value * 4)});
					parameter.step ??= Number.isInteger(value) && Number.isInteger(parameter.min) && Number.isInteger(parameter.max ?? 1) ? 1 : (parameter.max - parameter.min) / 100;
				}
				found.push(parameter);
			}
		}
		// what a block is is for the braces outside comments and strings
		for (const c of line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""'))
			depth += c === '{' ? 1 : c === '}' ? -1 : 0;
		offset += line.length + 1;
	}
	return found;
}

const panel = $('scad-params'), rows = $('scad-param-rows');
let shown = '';			// which parameters (and their ranges) the panel has controls for

// moves the number a control stands for into the text
function setParameter(name, value) {
	const p = parameters(editor.get()).find(q => q.name === name);
	if (p)
		editor.replace(p.from, p.to, String(value));
}

function showParameters() {
	const list = parameters(editor.get());
	panel.classList.toggle('hidden', !list.length);
	const signature = JSON.stringify(list.map(({name, min, max, step, choices}) => [name, min, max, step, choices]));
	if (signature === shown) {			// the same controls, to show the values the text has now, but not under a hand that is moving one
		for (const p of list)
			for (const input of rows.querySelectorAll(`[data-name="${CSS.escape(p.name)}"]`))
				if (input !== document.activeElement)
					typeof p.value === 'boolean' ? (input.checked = p.value) : (input.value = p.value);
		return;
	}
	shown = signature;
	rows.replaceChildren(...list.map(p => {
		const row = Object.assign(document.createElement('div'), {className: 'row'});
		const label = Object.assign(document.createElement('label'), {textContent: p.name, title: p.name});
		const make = (type, props) => Object.assign(document.createElement('input'), {type, ...props});
		if (typeof p.value === 'boolean') {
			const box = make('checkbox', {checked: p.value});
			box.dataset.name = p.name;
			box.oninput = () => setParameter(p.name, box.checked);
			row.append(label, box);
		} else if (p.choices) {
			const select = document.createElement('select');
			select.append(...p.choices.map(c => new Option(String(c), String(c))));
			select.value = String(p.value);
			select.dataset.name = p.name;
			select.oninput = () => setParameter(p.name, select.value);
			row.append(label, select);
		} else {
			const slider = make('range', {min: p.min, max: p.max, step: p.step, value: p.value}), number = make('number', {step: p.step, value: p.value});
			slider.dataset.name = number.dataset.name = p.name;
			slider.oninput = () => { number.value = slider.value; setParameter(p.name, slider.value); };
			number.oninput = () => { if (number.value !== '' && Number.isFinite(+number.value)) { slider.value = number.value; setParameter(p.name, number.value); } };
			row.append(label, slider, number);
		}
		return row;
	}));
}
let parameterTimer;
const laterParameters = () => { clearTimeout(parameterTimer); parameterTimer = setTimeout(showParameters, 120); };

// ---- the page's side of the conversation

const shaders = async () => {
	const text = async file => { const r = await fetch(`../assets/${file}`); if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.text(); };
	const [vert, lib, frag, floor, pick] = await Promise.all(['sdf.vert', 'sdflib.frag', 'sdf.frag', 'floor.frag', 'sdfpick.frag'].map(text));
	return {vert, lib, frag: frag.replace('//@floor', floor), pick};
};

async function command(message) {
	switch (message.command) {
		case 'ready':
			await load();
			break;
		case 'getShaders':
			return shaders();
		case 'getGlyphs':
			return digitAtlas();
		case 'run':
			run = message.name;
			render();
			break;
		case 'error':
			console.error(message.message);
			break;
	}
}

installHost(command);

// ---- the text

function setText(text, as = name) {
	editor.set(text);
	showParameters();
	name = as;
	try { localStorage.setItem(STORE, text); } catch { /* as above */ }
	run = undefined;
	render();
}

async function load() {
	const src = new URLSearchParams(location.search).get('src'), linked = /^#code=(.+)$/.exec(location.hash);
	if (linked) {
		try {
			setText(await decode(linked[1]), 'shared.scad');
			return;
		} catch (error) {
			console.warn('the link does not hold a text:', error.message ?? error);
		}
	}
	if (src) {
		setText(await (await fetch(src)).text(), src.split('/').pop());
	} else if (location.search.includes('handoff')) {
		const file = await takeHandoff();
		if (file)
			setText(await file.text(), file.name);
	} else {
		let stored;
		try { stored = localStorage.getItem(STORE); } catch { /* none */ }
		setText(stored ?? example);
	}
}

// the text of a file is the model; any other file is one that the text can read
async function take(file) {
	if (/\.scad$/i.test(file.name))
		return setText(await file.text(), file.name);
	files.add(file.name, new Uint8Array(await file.arrayBuffer()));
	render();
}
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); for (const file of e.dataTransfer?.files ?? []) take(file); });
$('scad-open').onclick = () => Object.assign(document.createElement('input'), {type: 'file', multiple: true, onchange: e => { for (const f of e.target.files) take(f); }}).click();

const save = () => download(new Blob([editor.get()], {type: 'text/plain'}), name);
$('scad-save').onclick = save;
addEventListener('keydown', e => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
		e.preventDefault();
		save();
	}
});

await import('../out/webview/sdf.js');
