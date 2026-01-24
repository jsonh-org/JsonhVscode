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
	jsonhVersion: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client
const defaultSettings: JsonhLspSettings = {
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

	const diagonistics: Diagnostic[] = [];

	// Validate parse
	let parsedElement: Result<unknown>;
	{
		// Create JsonhReader
		let jsonhReader: JsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
			version: JsonhVersion[settings.jsonhVersion as keyof typeof JsonhVersion],
			parseSingleElement: true,
		}));
		// Try parse element
		parsedElement = jsonhReader.parseElement();
		// Parse error
		if (parsedElement.isError) {
			// Report parse error
			const parseErrorDiagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: textDocument.positionAt(jsonhReader.charCounter),
					end: textDocument.positionAt(jsonhReader.charCounter),
				},
				message: `Error: ${parsedElement.error.message}`,
				source: 'JSONH',
			}
			diagonistics.push(parseErrorDiagnostic);
		}
	}

	// Validate read
	if (parsedElement.isValue) {
		// Create JsonhReader
		let jsonhReader: JsonhReader = JsonhReader.fromString(textDocument.getText(), new JsonhReaderOptions({
			version: JsonhVersion[settings.jsonhVersion as keyof typeof JsonhVersion],
			parseSingleElement: true,
		}));

		// Track schema
		let schemaIsCurrentProperty: boolean = false;
		let schemaPropertyNameStartIndex: number = -1;
		let schemaPropertyNameEndIndex: number = -1;
		let schemaPropertyValue: JsonhToken | null = null;

		// Track depth
		let currentDepth: number = 0;

		// Get start index of first token after skipping whitespace
		jsonhReader.hasToken();
		let startTokenCharCounter: number = jsonhReader.charCounter;

		// Read each JsonhToken
		for (let tokenResult of jsonhReader.readElement()) {
			// Check read error
			if (tokenResult.isError) {
				const parseErrorDiagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: textDocument.positionAt(startTokenCharCounter),
						end: textDocument.positionAt(jsonhReader.charCounter),
					},
					message: `Error: ${tokenResult.error.message}`,
					source: 'JSONH',
				}
				diagonistics.push(parseErrorDiagnostic);
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
					if (currentDepth === 1 && tokenResult.value.value === "$schema") {
						schemaIsCurrentProperty = true;
						schemaPropertyNameStartIndex = startTokenCharCounter;
						schemaPropertyNameEndIndex = jsonhReader.charCounter;
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
					if (schemaIsCurrentProperty) {
						schemaPropertyValue = tokenResult.value;
					}
					schemaIsCurrentProperty = false;
					break;
				}
			}

			// Get start index of token after skipping whitespace
			jsonhReader.hasToken();
			startTokenCharCounter = jsonhReader.charCounter;
		}

		// Validate schema
		if (schemaPropertyValue !== null) {
			try {
				if (schemaPropertyValue.jsonType !== JsonTokenType.String) {
					throw new Error("Schema URI must be string");
				}

				let schemaResponse: Response = await fetch(schemaPropertyValue.value);
				let schemaText: string = await schemaResponse.text();
				let schemaObject: any = JSON.parse(schemaText);

				let avj = new Ajv();
				let isValid = avj.validate(schemaObject, parsedElement.value);
				if (!isValid) {
					throw new Error(`Failed schema validation: ${avj.errorsText()}`);
				}
			}
			catch (error) {
				const schemaErrorDiagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Warning,
					range: {
						start: textDocument.positionAt(schemaPropertyNameStartIndex),
						end: textDocument.positionAt(schemaPropertyNameEndIndex),
					},
					message: error instanceof Error ? error.message : `${error}`,
					source: 'JSONH',
				}
				diagonistics.push(schemaErrorDiagnostic);
			}
		}
	}

	return diagonistics;
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
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
