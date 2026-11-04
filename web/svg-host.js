// Stands in for the extension on a plain web page, for the SVG editor (see host.js): the drawing is opened by picker, drop, paste or
// ?src=url, edits are kept as the text the page sends back (which is what undo and redo go back through, as VS Code does for the
// extension), and Ctrl/Cmd+S downloads it.
import {send, download, installHost, openers, shapePoints, takeHandoff} from './common.js';

let current = 'drawing.svg';
let text = '';
// the edits made, each with the text before and after it, and those undone
const done = [], undone = [];
let latest;		// the last edit, while nothing has been done since: a later step of it changes it

const status = document.getElementById('web-status');

const show = () => send({command: 'svg', text, file: current});

async function open(file) {
	current = file.name;
	text = (await file.text()).replace(/^\ufeff/, '');
	done.length = undone.length = 0;
	latest = undefined;
	welcome.remove();
	show();
}
const welcome = openers('Drop an SVG here, paste one, or', 'Open SVG…', '.svg,image/svg+xml', open, file => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name));

// as SvgDocument.edit: the page changed the drawing
function edit(after, continues) {
	if (continues) {
		if (latest) {
			latest.after = text = after;
		}
		return;
	}
	latest = {before: text, after};
	done.push(latest);
	undone.length = 0;
	text = after;
}

function step(from, to, field) {
	const e = from.pop();
	if (!e)
		return;
	to.push(e);
	text = e[field];
	latest = undefined;
	show();
}

async function command(message) {
	switch (message.command) {
		case 'ready': {
			const src = new URLSearchParams(location.search).get('src');
			if (src) {
				const blob = await (await fetch(src)).blob();
				open(Object.assign(blob, {name: src.split('/').pop()}));
			} else if (location.search.includes('handoff')) {
				const file = await takeHandoff();
				if (file)
					open(file);
			}
			break;
		}
		case 'status':
			status.textContent = message.text;
			break;
		case 'edit':
			edit(message.text, message.continues);
			break;
		case 'editImage':
			send({command: 'error', message: 'Editing a picture inside the drawing is not available on the web yet.'});
			break;
		case 'shapePoints':
			return shapePoints(message.name, message.attributes);
		case 'error':
			console.error(message.message);
			break;
	}
}

installHost(command);

addEventListener('keydown', e => {
	if (!(e.metaKey || e.ctrlKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')
		return;
	const key = e.key.toLowerCase();
	if (key === 's') {
		e.preventDefault();
		if (text)
			download(new Blob([text], {type: 'image/svg+xml'}), current);
	} else if (key === 'z' && !e.shiftKey) {
		e.preventDefault();
		step(done, undone, 'before');
	} else if (key === 'y' || key === 'z') {
		e.preventDefault();
		step(undone, done, 'after');
	}
});

await import('../out/webview/svg.js');
