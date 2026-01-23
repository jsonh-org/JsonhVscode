import * as path from 'path';
import { workspace, ExtensionContext, ConfigurationChangeEvent } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
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
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Enable/disable language client based on settings
	workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('jsonhLanguageServer.enable')) {
			const isEnabled = workspace.getConfiguration('jsonhLanguageServer').get<boolean>('enable');
			if (isEnabled) {
				client.start();
			} else {
				client.stop();
			}
		}
	});

	// Create the language client and start the client.
	client = new LanguageClient(
		'jsonhLanguageServer',
		"JSONH Language Server",
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
