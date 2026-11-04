// Stands in for the extension on a plain web page, for the font viewer (see host.js): a font opened by picker, drop, paste or ?src=url
// is held by a FontModel (src/fontmodel.ts, the model the extension's FontDocument is built on), and the page is given what it asks of it
// by src/fontmodel.ts, as it is by the extension. Edits are kept as steps for undo and redo (Ctrl+Z, Ctrl+Shift+Z), and Ctrl+S downloads the
// font in the format of its name. Opening a glyph's bitmap in the bitmap editor is not available on the web yet.
import {send, download, installHost, openers, shapePoints, takeHandoff} from './common.js';

const {FontModel, fontInfo, clean, glyphMarkup, glyphDetail, children} = await import('../out/web/fontmodel.js');
const status = document.getElementById('web-status');

// the edits made, and those undone
const done = [], undone = [];

class WebFont extends FontModel {
	onEdit(step) {
		done.push(step);
		undone.length = 0;
	}
	onChange(change) {
		if (change.kind === 'reload')
			show();
		else
			send({command: 'glyphChanged', id: change.id, own: change.own});
	}
}

let model, face = 0;

async function show() {
	face = Math.min(face, model.fonts.length - 1);
	const faces = model.fonts.map((f, i) => [clean(f.family()), clean(f.subfamily())].filter(Boolean).join(' ') || `Face ${i + 1}`);
	send({command: 'font', info: {...fontInfo(model.fonts[face], model.name, face, faces), editable: model.editable, convertible: model.convertible}});
}

async function open(file) {
	try {
		const next = new WebFont(file.name);
		await next.open(new Uint8Array(await file.arrayBuffer()));
		model = next;
		face = 0;
		done.length = undone.length = 0;
		welcome.remove();
		await show();
	} catch (error) {
		console.error(error);
		welcome.message(`${file.name}: ${error.message ?? error}`);
	}
}
const welcome = openers('Drop a font here, paste one, or', 'Open font…', '.ttf,.otf,.woff,.woff2,.ttc,.otc', open, file => /\.(ttf|otf|woff2?|ttc|otc)$/i.test(file.name));

// what the page is told when an edit is refused
const refused = error => { status.textContent = `Font editor: ${error?.message ?? error}`; };

async function command(message) {
	switch (message.command) {
		case 'ready': {
			const src = new URLSearchParams(location.search).get('src');
			if (src)
				open(Object.assign(await (await fetch(src)).blob(), {name: src.split('/').pop()}));
			else if (location.search.includes('handoff')) {
				const file = await takeHandoff();
				if (file)
					open(file);
			}
			break;
		}
		case 'status':
			status.textContent = message.text;
			break;
		case 'face':
			face = Math.max(0, Math.min(message.face, model.fonts.length - 1));
			await show();
			break;
		case 'getGlyphs': {
			return Object.fromEntries(message.ids.map(id => [id, glyphMarkup(model.fonts[face], id)]));
		}
		case 'getGlyphDetail':
			return glyphDetail(model.fonts[face], message.id, model.svgEditable && face === 0, false);
		case 'getTable':
			return children(model.fonts[face], message.path);
		case 'editGlyph':
			try { model.edit(message.id, message.points, message.label, message.continues); } catch (error) { refused(error); }
			break;
		case 'editGlyphSvg':
			try { model.editSvg(message.id, message.text, message.label, message.continues); } catch (error) { refused(error); }
			break;
		case 'convertFont':
			if (confirm('Edit this font?\n\nIts CFF outlines are converted to TrueType (quadratic) outlines, and hinting is lost. Saving writes the TrueType font. The conversion can be undone until then.'))
				await model.convert().catch(refused);
			break;
		case 'editGlyphBitmap':
			refused('opening a glyph\'s bitmap in the bitmap editor is not available on the web yet');
			break;
		case 'shapePoints':
			return shapePoints(message.name, message.attributes);
		case 'error':
			console.error(message.message);
			break;
		default:
			throw new Error(`'${message.command}' is not available on the web yet`);
	}
}

installHost(command);

addEventListener('keydown', async e => {
	if (!model || !(e.metaKey || e.ctrlKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')
		return;
	const key = e.key.toLowerCase();
	if (key === 's') {
		e.preventDefault();
		try {
			download(new Blob([await model.encode(model.name)]), model.name);
		} catch (error) {
			refused(error);
		}
	} else if (key === 'z' && !e.shiftKey) {
		e.preventDefault();
		const step = done.pop();
		if (step) {
			undone.push(step);
			step.undo();
		}
	} else if (key === 'y' || key === 'z') {
		e.preventDefault();
		const step = undone.pop();
		if (step) {
			done.push(step);
			step.redo();
		}
	}
});

await import('../out/webview/font.js');
