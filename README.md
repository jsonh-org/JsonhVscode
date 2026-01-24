<img src="https://github.com/jsonh-org/Jsonh/blob/main/IconUpscaled.png?raw=true" width=180>

[![Visual Studio Marketplace](https://img.shields.io/github/release/jsonh-org/JsonhVscode.svg?label=vs%20marketplace)](https://marketplace.visualstudio.com/items?itemName=Joyless.jsonh-vscode)

**JSON for Humans.**

JSON is great. Until you miss that trailing comma... or want to use comments. What about multiline strings?
JSONH provides a much more elegant way to write JSON that's designed for humans rather than machines.

Since JSONH is compatible with JSON, any JSONH syntax can be represented with equivalent JSON.

## JsonhVscode

JsonhVscode is a syntax highlighter for [JSONH V2](https://github.com/jsonh-org/Jsonh) using TextMate Grammars and [JsonhTs](https://github.com/jsonh-org/JsonhTs).

## Example

<img src="https://github.com/jsonh-org/JsonhVscode/blob/main/Example.png?raw=true"/>

## Features

- JSONH syntax highlighter
- JSONH language server:
  - Displays errors with error messages
  - Displays warnings for duplicate properties
  - Displays warnings for invalid schema according to `$schema` property

## Dependencies

- [jsonh-org/JsonhTs](https://github.com/jsonh-org/JsonhTs) (v2.7)
- [ajv-validator/ajv](https://github.com/ajv-validator/ajv) (v8.17.1)

## Known Issues

### Root strings highlighted as property names

In the following example, the string "hello" is incorrectly highlighted as a property name of a braceless root object.
```jsonh
"hello"
```

### Keys with newlines highlighted as invalid after omitted comma

In the following example, the property `"\nc": "d"` is incorrectly rendered as invalid.
```jsonh
"a": "b"
"
c": "d"
```

This can be worked around by adding a comma after the first property.

The reason is that property names end at the RegEx `,|(?=^[^:]*:)` meaning a comma or the first line containing a colon.