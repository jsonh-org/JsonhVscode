import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	DocumentDiagnosticReport,
	ClientCapabilities,
	TextDocumentChangeEvent,
	DocumentDiagnosticParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import JsonhReader = require('jsonh-ts/build/jsonh-reader');
import JsonhReaderOptions = require('jsonh-ts/build/jsonh-reader-options');
import JsonhVersion = require('jsonh-ts/build/jsonh-version');
import JsonhToken = require('jsonh-ts/build/jsonh-token');
import JsonTokenType = require('jsonh-ts/build/json-token-type');
import JsonhNumberParser = require('jsonh-ts/build/jsonh-number-parser');
import Result = require('jsonh-ts/build/result');

import { Ajv } from 'ajv';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities: ClientCapabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
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
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
});

// The example settings
interface JsonhLspSettings {
	enable: boolean;
	enableSchemaValidation: boolean;
	jsonhVersion: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client
const defaultSettings: JsonhLspSettings = {
	enable: true,
	enableSchemaValidation: false,
	jsonhVersion: "Latest",
};
let globalSettings: JsonhLspSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<JsonhLspSettings>>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = (
			(change.settings.jsonhLanguageServer || defaultSettings)
		);
	}
	// Refresh the diagnostics since the settings could have changed
	connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<JsonhLspSettings> {
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
documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
	documentSettings.delete(event.document.uri);
});

connection.languages.diagnostics.on(async (params: DocumentDiagnosticParams) => {
	const document: TextDocument | undefined = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document)
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	const settings: JsonhLspSettings = await getDocumentSettings(textDocument.uri);

	const diagnostics: Diagnostic[] = [];

	// Create JsonhReader
	let jsonhReader: JsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
		version: JsonhVersion[settings.jsonhVersion as keyof typeof JsonhVersion],
		parseSingleElement: true,
	}));

	let currentElements: unknown[] = [];
	let currentPropertyName: string | null = null;
	let submitElement = function (element: unknown): boolean {
		// Root value
		if (currentElements.length === 0) {
			return true;
		}
		// Array item
		if (currentPropertyName === null) {
			(currentElements.at(-1) as any[]).push(element);
			return false;
		}
		// Object property
		else {
			(currentElements.at(-1) as any)[currentPropertyName] = element;
			currentPropertyName = null;
			return false;
		}
	};
	let startElement = function (element: unknown): void {
		submitElement(element);
		currentElements.push(element);
	};
	let parseElement = function (): {
		result?: Result<unknown> | undefined;
		diagnostic?: Diagnostic | undefined;
		schemaPropertyValue?: JsonhToken | undefined;
		schemaPropertyNameRange?: { start: number, end: number } | undefined;
	} {
		// Track schema
		let schemaIsCurrentProperty: boolean = false;
		let schemaPropertyNameRange: { start: number, end: number } | undefined = undefined;
		let schemaPropertyValue: JsonhToken | undefined = undefined;

		// Get start index of first token after skipping whitespace
		jsonhReader.hasToken();
		let startTokenCharCounter: number = jsonhReader.charCounter;

		// Read each JsonhToken
		for (let tokenResult of jsonhReader.readElement()) {
			// Check read error
			if (tokenResult.isError) {
				// Report read error
				const readErrorDiagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: textDocument.positionAt(startTokenCharCounter),
						end: textDocument.positionAt(jsonhReader.charCounter),
					},
					message: `Error: ${tokenResult.error.message}`,
					source: 'JSONH',
				}
				return { diagnostic: readErrorDiagnostic };
			}

			switch (tokenResult.value.jsonType) {
				// Null
				case JsonTokenType.Null: {
					let element: null = null;
					if (submitElement(element)) {
						return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
					}
					break;
				}
				// True
				case JsonTokenType.True: {
					let element: boolean = true;
					if (submitElement(element)) {
						return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
					}
					break;
				}
				// False
				case JsonTokenType.False: {
					let element: boolean = false;
					if (submitElement(element)) {
						return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
					}
					break;
				}
				// String
				case JsonTokenType.String: {
					let element: string = tokenResult.value.value;
					if (submitElement(element)) {
						return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
					}
					break;
				}
				// Number
				case JsonTokenType.Number: {
					let result: Result<number> = JsonhNumberParser.parse(tokenResult.value.value);
					if (result.isError) {
						// Report number parse error
						const numberParseErrorDiagnostic: Diagnostic = {
							severity: DiagnosticSeverity.Error,
							range: {
								start: textDocument.positionAt(startTokenCharCounter),
								end: textDocument.positionAt(jsonhReader.charCounter),
							},
							message: `Error: ${tokenResult.error.message}`,
							source: 'JSONH',
						}
						return { diagnostic: numberParseErrorDiagnostic };
					}
					let element: number = result.value;
					if (submitElement(element)) {
						return { result: Result.fromValue(element), schemaPropertyValue, schemaPropertyNameRange };
					}
					break;
				}
				// Start Object
				case JsonTokenType.StartObject: {
					let element: object = {};
					startElement(element);
					break;
				}
				// Start Array
				case JsonTokenType.StartArray: {
					let element: any[] = [];
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

			// Get start index of token after skipping whitespace
			jsonhReader.hasToken();
			startTokenCharCounter = jsonhReader.charCounter;
		}

		// Report end of input
		const endOfInputDiagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: {
				start: textDocument.positionAt(startTokenCharCounter),
				end: textDocument.positionAt(jsonhReader.charCounter),
			},
			message: "Expected token, got end of input",
			source: 'JSONH',
		}
		return { diagnostic: endOfInputDiagnostic };
	}

	// Parse element
	let parseResult = parseElement();
	// Ensure exactly one element
	if (jsonhReader.options.parseSingleElement) {
		for (let token of jsonhReader.readEndOfElements()) {
			if (token.isError) {
				parseResult.diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: textDocument.positionAt(jsonhReader.charCounter),
						end: textDocument.positionAt(jsonhReader.charCounter),
					},
					message: `Error: ${token.error.message}`,
					source: 'JSONH',
				} as Diagnostic;
			}
		}
	}
	// Check error
	if (parseResult.diagnostic !== undefined) {
		diagnostics.push(parseResult.diagnostic);
	}

	// Validate schema
	if (settings.enableSchemaValidation) {
		if (parseResult.result !== undefined && parseResult.schemaPropertyValue !== undefined && parseResult.schemaPropertyNameRange !== undefined) {
			try {
				// Ensure schema is string
				if (parseResult.schemaPropertyValue.jsonType !== JsonTokenType.String) {
					throw new Error("Schema URI must be string");
				}

				// Fetch schema and parse as object
				let schemaObject: any;
				try {
					let schemaResponse: Response = await fetch(parseResult.schemaPropertyValue.value);
					let schemaText: string = await schemaResponse.text();
					schemaObject = JSON.parse(schemaText);
				}
				catch (error: unknown) {
					throw new Error(`Failed to fetch schema: ${error}`);
				}

				// Validate element against schena
				let avj = new Ajv();
				let isValid = avj.validate(schemaObject, parseResult.result.value);
				if (!isValid) {
					throw new Error(`Failed schema validation: ${avj.errorsText()}`);
				}
			}
			catch (error: unknown) {
				// Report schema error
				const schemaErrorDiagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Warning,
					range: {
						start: textDocument.positionAt(parseResult.schemaPropertyNameRange.start),
						end: textDocument.positionAt(parseResult.schemaPropertyNameRange.end),
					},
					message: error instanceof Error ? error.message : `${error}`,
					source: 'JSONH',
				}
				diagnostics.push(schemaErrorDiagnostic);
			}
		}
	}

	return diagnostics;
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		return [];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
