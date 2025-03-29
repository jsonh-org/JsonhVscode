# JsonhVscode

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/i/Joyless.jsonh-vscode)](https://marketplace.visualstudio.com/items?itemName=Joyless.jsonh-vscode)

**JSON for Humans.**

JSON is great. Until you miss that trailing comma... or want to use comments. What about multiline strings?
JSONH provides a much more elegant way to write JSON that's designed for humans rather than machines.

Since JSONH is compatible with JSON, any JSONH syntax can be represented with equivalent JSON.

JsonhVscode is a syntax highlighter for [JSONH v1](https://github.com/jsonh-org/Jsonh).

## Example

<img src="https://github.com/jsonh-org/JsonhVscode/blob/main/Example.png?raw=true"/>

## Known Issues

### Root strings highlighted as property names

In the following example, the string "hello" is incorrectly highlighted as a property name of a braceless root object.
```jsonh
"hello"
```