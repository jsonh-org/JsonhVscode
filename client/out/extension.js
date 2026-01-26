"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const node_1 = require("vscode-languageclient/node");
let client;
let jsonPreviewPanel;
async function openJsonPreview() {
    if (jsonPreviewPanel !== undefined) {
        return;
    }
    jsonPreviewPanel = vscode.window.createWebviewPanel('jsonPreview', 'JSON Preview', vscode.ViewColumn.Beside);
    jsonPreviewPanel.onDidDispose(() => {
        closeJsonPreview();
    });
    await updateJsonPreview();
}
function closeJsonPreview() {
    if (jsonPreviewPanel !== undefined) {
        jsonPreviewPanel.dispose();
        jsonPreviewPanel = undefined;
    }
}
async function updateJsonPreview() {
    if (jsonPreviewPanel === undefined || client === undefined) {
        return;
    }
    const activeTextEditor = vscode.window.activeTextEditor;
    if (activeTextEditor === undefined) {
        return;
    }
    const previewJsonResult = await client.sendRequest('jsonh/previewJson', { uri: activeTextEditor.document.uri.toString() });
    jsonPreviewPanel.webview.html = `
<style>
.string { color: #CE9178; }
.number { color: #B5CEA8; }
.boolean { color: #569CD6; }
.null { color: #569CD6; }
.key { color: #9CDCFE; }
</style>
<pre>
${syntaxHighlight(previewJsonResult)}
</pre>
`;
}
/**
 * Source: https://stackoverflow.com/a/7220510
 */
function syntaxHighlight(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            }
            else {
                cls = 'string';
            }
        }
        else if (/true|false/.test(match)) {
            cls = 'boolean';
        }
        else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
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
            fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };
    // Create the language client and start the client.
    client = new node_1.LanguageClient('jsonhLanguageServer', "JSONH Language Server", serverOptions, clientOptions);
    // Enable/disable language client based on settings
    vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonhLanguageServer.enable')) {
            const isEnabled = vscode.workspace.getConfiguration('jsonhLanguageServer').get('enable');
            if (isEnabled) {
                client?.start();
            }
            else {
                client?.stop();
            }
        }
    });
    // Start the client. This will also launch the server
    const isEnabled = vscode.workspace.getConfiguration('jsonhLanguageServer').get('enable');
    if (isEnabled) {
        client.start();
    }
    // Register JSON Preview command
    context.subscriptions.push(vscode.commands.registerCommand('jsonh.previewJson', openJsonPreview));
    // Update JSON Preview on document change
    vscode.workspace.onDidChangeTextDocument(async (event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
            await sleep(100);
            await updateJsonPreview();
        }
    });
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor !== undefined) {
            await sleep(100);
            await updateJsonPreview();
        }
    });
}
function deactivate() {
    closeJsonPreview();
    return client?.stop();
}
//# sourceMappingURL=extension.js.map