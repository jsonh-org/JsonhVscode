"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const JsonhReader = require("jsonh-ts/build/jsonh-reader");
const JsonhReaderOptions = require("jsonh-ts/build/jsonh-reader-options");
const JsonhVersion = require("jsonh-ts/build/jsonh-version");
const JsonTokenType = require("jsonh-ts/build/json-token-type");
const JsonhNumberParser = require("jsonh-ts/build/jsonh-number-parser");
const Result = require("jsonh-ts/build/result");
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
    jsonhVersion: "Latest",
    enableSchemaValidation: false,
    checkDuplicateProperties: true,
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
    // Get start index of first token after skipping whitespace
    jsonhReader.hasToken();
    let startTokenCharCounter = jsonhReader.charCounter;
    // Parse methods
    let currentElements = [];
    let currentPropertyName = null;
    let submitElement = function (element) {
        // Root value
        if (currentElements.length === 0) {
            return true;
        }
        // Array item
        if (currentPropertyName === null) {
            let array = currentElements.at(-1);
            array.push(element);
            return false;
        }
        // Object property
        else {
            let object = currentElements.at(-1);
            object[currentPropertyName] = element;
            currentPropertyName = null;
            return false;
        }
    };
    let startElement = function (element) {
        submitElement(element);
        currentElements.push(element);
    };
    let parseElement = function () {
        // Track schema
        let schemaIsCurrentProperty = false;
        let schemaPropertyNameRange = undefined;
        let schemaPropertyValue = undefined;
        // Read each JsonhToken
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
                return { result: Result.fromError(new Error()) };
            }
            switch (tokenResult.value.jsonType) {
                // Null
                case JsonTokenType.Null: {
                    let element = null;
                    if (submitElement(element)) {
                        return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // True
                case JsonTokenType.True: {
                    let element = true;
                    if (submitElement(element)) {
                        return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // False
                case JsonTokenType.False: {
                    let element = false;
                    if (submitElement(element)) {
                        return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // String
                case JsonTokenType.String: {
                    let element = tokenResult.value.value;
                    if (submitElement(element)) {
                        return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // Number
                case JsonTokenType.Number: {
                    let result = JsonhNumberParser.parse(tokenResult.value.value);
                    if (result.isError) {
                        // Report number parse error
                        const numberParseErrorDiagnostic = {
                            severity: node_1.DiagnosticSeverity.Error,
                            range: {
                                start: textDocument.positionAt(startTokenCharCounter),
                                end: textDocument.positionAt(jsonhReader.charCounter),
                            },
                            message: `Error: ${tokenResult.error.message}`,
                            source: 'JSONH',
                        };
                        diagnostics.push(numberParseErrorDiagnostic);
                        return { result: Result.fromError(new Error()) };
                    }
                    let element = result.value;
                    if (submitElement(element)) {
                        return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // Start Object
                case JsonTokenType.StartObject: {
                    let element = {};
                    startElement(element);
                    break;
                }
                // Start Array
                case JsonTokenType.StartArray: {
                    let element = [];
                    startElement(element);
                    break;
                }
                // End Object/Array
                case JsonTokenType.EndObject:
                case JsonTokenType.EndArray: {
                    // Nested element
                    if (currentElements.length > 1) {
                        currentElements.pop();
                    }
                    // Root element
                    else {
                        return { result: Result.fromValue(currentElements.at(-1)), schemaPropertyValue, schemaPropertyNameRange };
                    }
                    break;
                }
                // Property Name
                case JsonTokenType.PropertyName: {
                    currentPropertyName = tokenResult.value.value;
                    break;
                }
                // Comment
                case JsonTokenType.Comment: {
                    break;
                }
                // Not Implemented
                default: {
                    throw new Error("Token type not implemented");
                }
            }
            // Schema validation
            if (settings.enableSchemaValidation) {
                switch (tokenResult.value.jsonType) {
                    // Property Name
                    case JsonTokenType.PropertyName: {
                        if (currentElements.length === 1 && tokenResult.value.value === "$schema") {
                            schemaIsCurrentProperty = true;
                            schemaPropertyNameRange = { start: startTokenCharCounter, end: jsonhReader.charCounter };
                        }
                        break;
                    }
                    // Primitive value
                    case JsonTokenType.Null:
                    case JsonTokenType.True:
                    case JsonTokenType.False:
                    case JsonTokenType.String:
                    case JsonTokenType.Number: {
                        if (schemaIsCurrentProperty) {
                            schemaPropertyValue = tokenResult.value;
                        }
                        schemaIsCurrentProperty = false;
                        break;
                    }
                }
            }
            // Check duplicate property name
            if (settings.checkDuplicateProperties) {
                switch (tokenResult.value.jsonType) {
                    case JsonTokenType.PropertyName: {
                        let object = currentElements.at(-1);
                        if (Object.hasOwn(object, tokenResult.value.value)) {
                            const duplicatePropertyDiagnostic = {
                                severity: node_1.DiagnosticSeverity.Warning,
                                range: {
                                    start: textDocument.positionAt(startTokenCharCounter),
                                    end: textDocument.positionAt(jsonhReader.charCounter),
                                },
                                message: `Duplicate property - original will be replaced`,
                                source: 'JSONH',
                            };
                            diagnostics.push(duplicatePropertyDiagnostic);
                        }
                    }
                }
            }
            // Get start index of token after skipping whitespace
            jsonhReader.hasToken();
            startTokenCharCounter = jsonhReader.charCounter;
        }
        // Report end of input
        const endOfInputErrorDiagnostic = {
            severity: node_1.DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(startTokenCharCounter),
                end: textDocument.positionAt(jsonhReader.charCounter),
            },
            message: "Expected token, got end of input",
            source: 'JSONH',
        };
        diagnostics.push(endOfInputErrorDiagnostic);
        return { result: Result.fromError(new Error()) };
    };
    // Parse element
    let parseResult = parseElement();
    // Ensure exactly one element
    if (jsonhReader.options.parseSingleElement) {
        for (let token of jsonhReader.readEndOfElements()) {
            if (token.isError) {
                const endOfElementsErrorDiagnostic = {
                    severity: node_1.DiagnosticSeverity.Error,
                    range: {
                        start: textDocument.positionAt(jsonhReader.charCounter),
                        end: textDocument.positionAt(jsonhReader.charCounter),
                    },
                    message: `Error: ${token.error.message}`,
                    source: 'JSONH',
                };
                diagnostics.push(endOfElementsErrorDiagnostic);
                parseResult.result = Result.fromError(new Error());
            }
        }
    }
    // Validate schema
    if (settings.enableSchemaValidation) {
        if (parseResult.result.isValue && parseResult.schemaPropertyValue !== undefined && parseResult.schemaPropertyNameRange !== undefined) {
            try {
                // Ensure schema is string
                if (parseResult.schemaPropertyValue.jsonType !== JsonTokenType.String) {
                    throw new Error("Schema URI must be string");
                }
                // Fetch schema and parse as object
                let schemaObject;
                try {
                    let schemaResponse = await fetch(parseResult.schemaPropertyValue.value);
                    let schemaText = await schemaResponse.text();
                    schemaObject = JSON.parse(schemaText);
                }
                catch (error) {
                    throw new Error(`Failed to fetch schema: ${error}`);
                }
                // Validate element against schena
                let avj = new ajv_1.Ajv();
                let isValid = avj.validate(schemaObject, parseResult.result.value);
                if (!isValid) {
                    throw new Error(`Failed schema validation: ${avj.errorsText()}`);
                }
            }
            catch (error) {
                // Report schema error
                const schemaErrorDiagnostic = {
                    severity: node_1.DiagnosticSeverity.Warning,
                    range: {
                        start: textDocument.positionAt(parseResult.schemaPropertyNameRange.start),
                        end: textDocument.positionAt(parseResult.schemaPropertyNameRange.end),
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
    return item;
});
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map