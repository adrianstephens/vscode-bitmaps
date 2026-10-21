// The SVG editor's page: the drawing, its elements and properties, held by a session (svgsession.ts) that the font viewer's
// colour glyphs use too. The text goes to the extension after every edit, which is what VS Code undoes and redoes; the
// extension reads a shape into the points the editor takes.
import { vscode, RPC, handleResult, Splitter } from '@isopodlabs/vscode_utils/webview/shared.js';
import { createSession } from './svgsession.js';
import type { curveVertex } from '@isopodlabs/binary_fonts';

export type MessageOut =
	| {command: 'ready'}
	| {command: 'error', message: string}
	| {command: 'status', text: string}
	| {command: 'edit', text: string, label: string}
	| {command: 'shapePoints', name: string, attributes: Record<string, string>}
	| {command: 'simplifyPoints', points: curveVertex[], tol: number, cubic: boolean}
	| {command: 'fitStroke', stroke: number[], tol: number}
	| {command: 'editImage', id: string, href: string};

export type MessageIn =
	| {command: 'svg', text: string, file: string}
	| {command: 'setImage', id: string, href: string}
	| {command: 'error', message: string}
	| {command: 'fitToWindow'};

const $		= <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const post	= (message: MessageOut) => vscode.postMessage(message);

const errorBox	= $('scad-error');

const session = createSession({view: $('insp-view'), tree: $('svg-tree'), props: $('svg-props')}, {
	save:		(text, label) => post({command: 'edit', text, label}),
	shapePoints: (name, attributes) => RPC<curveVertex[]>({command: 'shapePoints', name, attributes}),
	simplifyPoints: (points, tol) => RPC<curveVertex[]>({command: 'simplifyPoints', points, tol, cubic: true}),
	fitStroke:	(stroke, tol) => RPC<curveVertex[]>({command: 'fitStroke', stroke, tol}),
	editImage:	(id, href) => post({command: 'editImage', id, href}),
	status:		text => post({command: 'status', text}),
	error:		message => {
		errorBox.textContent = message ?? '';
		errorBox.classList.toggle('hidden', !message);
	},
});
const editor = session.editor;

document.addEventListener('keydown', e => {
	const target = e.target as HTMLElement;
	if (target.tagName === 'INPUT' || target.tagName === 'SELECT')
		return;
	if (session.key(e))
		e.preventDefault();
});

const splitter = new Splitter($('svg-splitter'), () => {});
splitter.set(300);

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;
	const message = event.data as MessageIn;
	switch (message.command) {
		case 'svg':
			session.load(message.text, message.file);
			break;
		case 'setImage':
			session.setImage(message.id, message.href);
			break;
		case 'error':
			errorBox.textContent = message.message;
			errorBox.classList.remove('hidden');
			break;
		case 'fitToWindow':
			editor.fit();
			break;
	}
});

post({command: 'ready'});
