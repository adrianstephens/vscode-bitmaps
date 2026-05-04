import * as vscode from 'vscode';

import { BitmapViewerProvider } from './BitmapViewer';

export function activate(context: vscode.ExtensionContext) {
	new BitmapViewerProvider(context);
}

export function deactivate() {
}
