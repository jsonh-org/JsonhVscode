import * as path from 'path';
import * as vscode from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

let jsonPreviewPanel: vscode.WebviewPanel | undefined;

async function openJsonPreview(): Promise<void> {
	if (jsonPreviewPanel !== undefined) {
		return;
	}

	jsonPreviewPanel = vscode.window.createWebviewPanel(
		'jsonPreview',
		'JSON Preview',
		vscode.ViewColumn.Beside
	);

	jsonPreviewPanel.onDidDispose(() => {
		closeJsonPreview();
	});

	await updateJsonPreview();
}

function closeJsonPreview(): void {
	if (jsonPreviewPanel !== undefined) {
		jsonPreviewPanel.dispose();
		jsonPreviewPanel = undefined;
	}
}

async function updateJsonPreview(): Promise<void> {
	if (jsonPreviewPanel === undefined || client === undefined) {
		return;
	}

	const activeTextEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
	if (activeTextEditor === undefined) {
		return;
	}

	const previewJsonResult: string = await client.sendRequest('jsonh/previewJson', { uri: activeTextEditor.document.uri.toString() });

	jsonPreviewPanel.webview.html = `
<style>
.string { color: #CE9178; }
.number { color: #B5CEA8; }
.boolean { color: #569CD6; }
.null { color: #569CD6; }
.key { color: #9CDCFE; }
</style>
<pre>
${syntaxHighlight(previewJsonResult) }
</pre>
`;
}

/**
 * Source: https://stackoverflow.com/a/7220510
 */
function syntaxHighlight(json: string): string {
	json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
		let cls = 'number';
		if (/^"/.test(match)) {
			if (/:$/.test(match)) {
				cls = 'key';
			} else {
				cls = 'string';
			}
		} else if (/true|false/.test(match)) {
			cls = 'boolean';
		} else if (/null/.test(match)) {
			cls = 'null';
		}
		return '<span class="' + cls + '">' + match + '</span>';
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function activate(context: vscode.ExtensionContext): void {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'jsonh' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'jsonhLanguageServer',
		"JSONH Language Server",
		serverOptions,
		clientOptions
	);

	// Enable/disable language client based on settings
	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('jsonhLanguageServer.enable')) {
			const isEnabled = vscode.workspace.getConfiguration('jsonhLanguageServer').get<boolean>('enable');
			if (isEnabled) {
				client?.start();
			} else {
				client?.stop();
			}
		}
	});

	// Start the client. This will also launch the server
	const isEnabled = vscode.workspace.getConfiguration('jsonhLanguageServer').get<boolean>('enable');
	if (isEnabled) {
		client.start();
	}

	// Register JSON Preview command
	context.subscriptions.push(vscode.commands.registerCommand('jsonh.previewJson', openJsonPreview));
	// Update JSON Preview on document change
	vscode.workspace.onDidChangeTextDocument(async (event: vscode.TextDocumentChangeEvent) => {
		if (event.document === vscode.window.activeTextEditor?.document) {
			await sleep(100);
			await updateJsonPreview();
		}
	});
	vscode.window.onDidChangeActiveTextEditor(async (editor: vscode.TextEditor | undefined) => {
		if (editor !== undefined) {
			await sleep(100);
			await updateJsonPreview();
		}
	});
}

export function deactivate(): Thenable<void> | undefined {
	closeJsonPreview();

	return client?.stop();
}
