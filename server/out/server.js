"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const JsonhReader = require("jsonh-ts/build/jsonh-reader");
const JsonhReaderOptions = require("jsonh-ts/build/jsonh-reader-options");
const JsonhVersion = require("jsonh-ts/build/jsonh-version");
const JsonTokenType = require("jsonh-ts/build/json-token-type");
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
    enable: true,
    enableSchemaValidation: false,
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
    const diagnostics = [];
    // Create JsonhReader
    let jsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
        version: JsonhVersion[settings.jsonhVersion],
        parseSingleElement: true,
    }));
    // Track schema
    let schemaIsCurrentProperty = false;
    let schemaPropertyNameStartIndex = -1;
    let schemaPropertyNameEndIndex = -1;
    let schemaPropertyValue = null;
    // Track depth
    let currentDepth = 0;
    // Get start index of first token after skipping whitespace
    jsonhReader.hasToken();
    let startTokenCharCounter = jsonhReader.charCounter;
    // Read each JsonhToken
    let readSuccess = true;
    for (let tokenResult of jsonhReader.readElement()) {
        // Check read error
        if (tokenResult.isError) {
            // Report read error
            const readErrorDiagnostic = {
                severity: node_1.DiagnosticSeverity.Error,
                range: {
                    start: textDocument.positionAt(startTokenCharCounter),
                    end: textDocument.positionAt(jsonhReader.charCounter),
                },
                message: `Error: ${tokenResult.error.message}`,
                source: 'JSONH',
            };
            diagnostics.push(readErrorDiagnostic);
            readSuccess = false;
            break;
        }
        switch (tokenResult.value.jsonType) {
            // Start structure
            case JsonTokenType.StartObject:
            case JsonTokenType.StartArray: {
                currentDepth++;
                break;
            }
            // End structure
            case JsonTokenType.EndObject:
            case JsonTokenType.EndArray: {
                currentDepth--;
                break;
            }
            // Property name
            case JsonTokenType.PropertyName: {
                if (settings.enableSchemaValidation) {
                    if (currentDepth === 1 && tokenResult.value.value === "$schema") {
                        schemaIsCurrentProperty = true;
                        schemaPropertyNameStartIndex = startTokenCharCounter;
                        schemaPropertyNameEndIndex = jsonhReader.charCounter;
                    }
                }
                break;
            }
            // Comment
            case JsonTokenType.Comment: {
                break;
            }
            // Primitive value
            case JsonTokenType.Null:
            case JsonTokenType.True:
            case JsonTokenType.False:
            case JsonTokenType.String:
            case JsonTokenType.Number: {
                if (settings.enableSchemaValidation) {
                    if (schemaIsCurrentProperty) {
                        schemaPropertyValue = tokenResult.value;
                    }
                    schemaIsCurrentProperty = false;
                }
                break;
            }
        }
        // Get start index of token after skipping whitespace
        jsonhReader.hasToken();
        startTokenCharCounter = jsonhReader.charCounter;
    }
    // Validate schema
    if (settings.enableSchemaValidation) {
        if (readSuccess && schemaPropertyValue !== null) {
            try {
                // Ensure schema is string
                if (schemaPropertyValue.jsonType !== JsonTokenType.String) {
                    throw new Error("Schema URI must be string");
                }
                // Fetch schema and parse as object
                let schemaObject;
                try {
                    let schemaResponse = await fetch(schemaPropertyValue.value);
                    let schemaText = await schemaResponse.text();
                    schemaObject = JSON.parse(schemaText);
                }
                catch (error) {
                    throw new Error(`Failed to fetch schema: ${error}`);
                }
                // Create JsonhReader
                let jsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
                    version: JsonhVersion[settings.jsonhVersion],
                    parseSingleElement: true,
                }));
                // Try parse element from document
                let parsedElement = jsonhReader.parseElement().value;
                // Validate element against schena
                let avj = new ajv_1.Ajv();
                let isValid = avj.validate(schemaObject, parsedElement);
                if (!isValid) {
                    throw new Error(`Failed schema validation: ${avj.errorsText()}`);
                }
            }
            catch (error) {
                // Report schema error
                const schemaErrorDiagnostic = {
                    severity: node_1.DiagnosticSeverity.Warning,
                    range: {
                        start: textDocument.positionAt(schemaPropertyNameStartIndex),
                        end: textDocument.positionAt(schemaPropertyNameEndIndex),
                    },
                    message: error instanceof Error ? error.message : `${error}`,
                    source: 'JSONH',
                };
                diagnostics.push(schemaErrorDiagnostic);
            }
        }
    }
    return diagnostics;
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