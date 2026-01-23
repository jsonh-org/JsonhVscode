"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const JsonhReader = require("jsonh-ts/build/jsonh-reader");
const JsonhReaderOptions = require("jsonh-ts/build/jsonh-reader-options");
const JsonhVersion = require("jsonh-ts/build/jsonh-version");
const ajv_1 = require("ajv");
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager.
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            }
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});
connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined);
    }
});
// The global settings, used when the `workspace/configuration` request is not supported by the client
const defaultSettings = {
    jsonhVersion: "Latest",
};
let globalSettings = defaultSettings;
// Cache the settings of all open documents
const documentSettings = new Map();
connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    }
    else {
        globalSettings = ((change.settings.jsonhLanguageServer || defaultSettings));
    }
    // Refresh the diagnostics since the settings could have changed
    connection.languages.diagnostics.refresh();
});
function getDocumentSettings(resource) {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'jsonhLanguageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}
// Only keep settings for open documents
documents.onDidClose((event) => {
    documentSettings.delete(event.document.uri);
});
connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        };
    }
    else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: []
        };
    }
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    validateTextDocument(change.document);
});
async function validateTextDocument(textDocument) {
    const settings = await getDocumentSettings(textDocument.uri);
    const diagonistics = [];
    let jsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
        version: JsonhVersion[settings.jsonhVersion],
        parseSingleElement: true,
    }));
    let element = jsonhReader.parseElement();
    if (element.isError) {
        const parseErrorDiagnostic = {
            severity: node_1.DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(jsonhReader.charCounter),
                end: textDocument.positionAt(jsonhReader.charCounter),
            },
            message: `Error: ${element.error.message}`,
            source: 'JSONH',
        };
        diagonistics.push(parseErrorDiagnostic);
    }
    else {
        // Schema
        if (element.value !== null && typeof element.value === "object" && "$schema" in element.value) {
            let schemaUri = element.value["$schema"];
            try {
                if (typeof schemaUri !== "string") {
                    throw new Error("Schema URI must be string");
                }
                let schemaResponse = await fetch(schemaUri);
                let schemaText = await schemaResponse.text();
                let schemaObject = JSON.parse(schemaText);
                let avj = new ajv_1.Ajv();
                let isSchemaValid = await avj.validateSchema(schemaObject, false);
                if (!isSchemaValid) {
                    throw new Error(`Schema is not valid: ${avj.errorsText()}`);
                }
                let isValid = avj.validate(schemaObject, element.value);
                if (!isValid) {
                    throw new Error(`Failed schema validation: ${avj.errorsText()}`);
                }
            }
            catch (error) {
                const schemaErrorDiagnostic = {
                    severity: node_1.DiagnosticSeverity.Error,
                    range: {
                        start: textDocument.positionAt(0),
                        end: textDocument.positionAt(0),
                    },
                    message: error instanceof Error ? error.message : `${error}`,
                    source: 'JSONH',
                };
                diagonistics.push(schemaErrorDiagnostic);
            }
        }
    }
    return diagonistics;
}
// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition) => {
    return [];
});
// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    if (item.data === 1) {
        item.detail = 'TypeScript details';
        item.documentation = 'TypeScript documentation';
    }
    else if (item.data === 2) {
        item.detail = 'JavaScript details';
        item.documentation = 'JavaScript documentation';
    }
    return item;
});
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map