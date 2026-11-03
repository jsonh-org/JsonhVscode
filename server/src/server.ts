import { promises as fs } from 'fs';
import path from 'path';

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

import { URI } from 'vscode-uri';

import JsonhReader from 'jsonh-ts/build/jsonh-reader';
import JsonhReaderOptions from 'jsonh-ts/build/jsonh-reader-options';
import JsonhVersion from 'jsonh-ts/build/jsonh-version';
import JsonhToken from 'jsonh-ts/build/jsonh-token';
import JsonTokenType from 'jsonh-ts/build/json-token-type';
import JsonhNumberParser from 'jsonh-ts/build/jsonh-number-parser';
import Result from 'jsonh-ts/build/result';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

let isWorkspaceTrusted: boolean = false;

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
	jsonhVersion: string;
	checkDuplicateProperties: boolean;
	checkNestedBracelessObjects: boolean;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client
const defaultSettings: JsonhLspSettings = {
	enable: true,
	jsonhVersion: "Latest",
	checkDuplicateProperties: true,
	checkNestedBracelessObjects: true,
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

	const textDocumentText: string = textDocument.getText();

	// Create JsonhReader
	const jsonhReader: JsonhReader = JsonhReader.fromString(textDocumentText, new JsonhReaderOptions({
		version: JsonhVersion[settings.jsonhVersion as keyof typeof JsonhVersion],
		parseSingleElement: true,
	}));

	// Get start index of first token after skipping whitespace
	jsonhReader.hasToken();
	let startTokenCharCounter: number = jsonhReader.charCounter;

	// Parse methods
	const currentElements: unknown[] = [];
	let currentPropertyName: string | null = null;
	const submitElement = function (element: unknown): boolean {
		// Root value
		if (currentElements.length === 0) {
			return true;
		}
		// Array item
		if (currentPropertyName === null) {
			const array: any[] = currentElements.at(-1) as any[];
			array.push(element);
			return false;
		}
		// Object property
		else {
			const object: any = currentElements.at(-1) as any;
			object[currentPropertyName] = element;
			currentPropertyName = null;
			return false;
		}
	};
	const startElement = function (element: unknown): void {
		submitElement(element);
		currentElements.push(element);
	};
	const parseElement = function (): Result<unknown> {
		// Read each JsonhToken
		for (const tokenResult of jsonhReader.readElement()) {
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
				diagnostics.push(readErrorDiagnostic);
				return Result.fromError(new Error());
			}

			switch (tokenResult.value.jsonType) {
				// Null
				case JsonTokenType.Null: {
					const element: null = null;
					if (submitElement(element)) {
						return Result.fromValue(element);
					}
					break;
				}
				// True
				case JsonTokenType.True: {
					const element: boolean = true;
					if (submitElement(element)) {
						return Result.fromValue(element);
					}
					break;
				}
				// False
				case JsonTokenType.False: {
					const element: boolean = false;
					if (submitElement(element)) {
						return Result.fromValue(element);
					}
					break;
				}
				// String
				case JsonTokenType.String: {
					const element: string = tokenResult.value.value;
					if (submitElement(element)) {
						return Result.fromValue(element);
					}
					break;
				}
				// Number
				case JsonTokenType.Number: {
					const result: Result<number> = JsonhNumberParser.parse(tokenResult.value.value);
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
						diagnostics.push(numberParseErrorDiagnostic);
						return Result.fromError(new Error());
					}
					const element: number = result.value;
					if (submitElement(element)) {
						return Result.fromValue(element);
					}
					break;
				}
				// Start Object
				case JsonTokenType.StartObject: {
					const element: object = {};
					startElement(element);
					break;
				}
				// Start Array
				case JsonTokenType.StartArray: {
					const element: any[] = [];
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
						return Result.fromValue(currentElements.at(-1));
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

			// Check duplicate property name
			if (settings.checkDuplicateProperties) {
				switch (tokenResult.value.jsonType) {
					case JsonTokenType.PropertyName: {
						const object: any = currentElements.at(-1) as any;
						if (Object.hasOwn(object, tokenResult.value.value)) {
							const duplicatePropertyDiagnostic: Diagnostic = {
								severity: DiagnosticSeverity.Warning,
								range: {
									start: textDocument.positionAt(startTokenCharCounter),
									end: textDocument.positionAt(jsonhReader.charCounter),
								},
								message: `Duplicate property - original will be replaced`,
								source: 'JSONH',
							}
							diagnostics.push(duplicatePropertyDiagnostic);
						}
					}
				}
			}

			// Check nested braceless object
			if (settings.checkNestedBracelessObjects) {
				if (tokenResult.value.jsonType === JsonTokenType.StartObject) {
					if (currentElements.length > 1) {
						if (textDocumentText.at(jsonhReader.charCounter - 1) !== '{') {
							const nestedBracelessObjectDiagnostic: Diagnostic = {
								severity: DiagnosticSeverity.Warning,
								range: {
									start: textDocument.positionAt(startTokenCharCounter),
									end: textDocument.positionAt(jsonhReader.charCounter),
								},
								message: `Braceless objects should only be used at the root level`,
								source: 'JSONH',
							}
							diagnostics.push(nestedBracelessObjectDiagnostic);
						}
					}
				}
			}

			// Get start index of token after skipping whitespace
			jsonhReader.hasToken();
			startTokenCharCounter = jsonhReader.charCounter;
		}

		// Report end of input
		const endOfInputErrorDiagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: {
				start: textDocument.positionAt(startTokenCharCounter),
				end: textDocument.positionAt(jsonhReader.charCounter),
			},
			message: "Expected token, got end of input",
			source: 'JSONH',
		}
		diagnostics.push(endOfInputErrorDiagnostic);
		return Result.fromError(new Error());
	}

	// Parse element
	let parseResult: Result<unknown> = parseElement();
	// Ensure exactly one element
	if (parseResult.isValue) {
		if (jsonhReader.options.parseSingleElement) {
			for (const token of jsonhReader.readEndOfElements()) {
				if (token.isError) {
					const endOfElementsErrorDiagnostic: Diagnostic = {
						severity: DiagnosticSeverity.Error,
						range: {
							start: textDocument.positionAt(jsonhReader.charCounter),
							end: textDocument.positionAt(jsonhReader.charCounter),
						},
						message: `Error: ${token.error.message}`,
						source: 'JSONH',
					}
					diagnostics.push(endOfElementsErrorDiagnostic);
					parseResult = Result.fromError(new Error());
				}
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

connection.onNotification('jsonh/workspaceTrustChanged', (params: { isWorkspaceTrusted: boolean }) => {
	isWorkspaceTrusted = params.isWorkspaceTrusted === true;
});

connection.onRequest('jsonh/previewJson', async (params: { uri: string }): Promise<string> => {
	// Get document
	const document: TextDocument | undefined = documents.get(params.uri);
	if (document === undefined) {
		return "Undefined document";
	}
	// Get settings
	const settings: JsonhLspSettings = await getDocumentSettings(params.uri);

	// Parse element as JSON
	const reader: JsonhReader = JsonhReader.fromString(document.getText(), new JsonhReaderOptions({
		version: JsonhVersion[settings.jsonhVersion as keyof typeof JsonhVersion],
		parseSingleElement: true,
	}));
	const result: Result<string> = reader.parseJson(false, "    ");
	if (result.isError) {
		return `Error: ${result.error.message}`;
	}
	return result.value;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
