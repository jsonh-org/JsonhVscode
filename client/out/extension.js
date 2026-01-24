"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
function activate(context) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: node_1.TransportKind.ipc,
        }
    };
    // Options to control the language client
    const clientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'jsonh' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: vscode_1.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };
    // Enable/disable language client based on settings
    vscode_1.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonhLanguageServer.enable')) {
            const isEnabled = vscode_1.workspace.getConfiguration('jsonhLanguageServer').get('enable');
            if (isEnabled) {
                client.start();
            }
            else {
                client.stop();
            }
        }
    });
    // Create the language client and start the client.
    client = new node_1.LanguageClient('jsonhLanguageServer', "JSONH Language Server", serverOptions, clientOptions);
    // Start the client. This will also launch the server
    const isEnabled = vscode_1.workspace.getConfiguration('jsonhLanguageServer').get('enable');
    if (isEnabled) {
        client.start();
    }
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
//# sourceMappingURL=extension.js.map