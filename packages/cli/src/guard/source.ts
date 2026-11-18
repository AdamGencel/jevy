import { extname } from "node:path";
import ts from "typescript";

/**
 * Shared helpers over the TypeScript compiler API. The guard only ever parses
 * source text: nothing from the repository being checked is executed or
 * imported, so a hostile repository cannot run code by being checked.
 */

export type Parsed =
  | { readonly ok: true; readonly sourceFile: ts.SourceFile }
  | { readonly ok: false; readonly error: string };

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

function scriptKindFor(path: string): ts.ScriptKind {
  return SCRIPT_KINDS[extname(path).toLowerCase()] ?? ts.ScriptKind.TS;
}

/**
 * The first syntax error, as "line N: message", or null.
 *
 * `ts.createSourceFile` never throws: it recovers and builds a tree around the
 * error. A recovered tree can invent or drop calls, so comparing it would
 * report weakening that is not there or miss weakening that is. A one-file
 * program with no lib and no resolution is the public way to read the parse
 * diagnostics without type checking anything.
 */
function firstSyntaxError(sourceFile: ts.SourceFile): string | null {
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      name === sourceFile.fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === sourceFile.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: {
      noLib: true,
      noResolve: true,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      types: [],
    },
    host,
  });
  const diagnostic = program.getSyntacticDiagnostics(sourceFile)[0];
  if (diagnostic === undefined) {
    return null;
  }
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const start = diagnostic.start;
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  return `line ${String(line)}: ${message}`;
}

/** Parse `text` as the file at `path`; the extension picks TS, TSX, JS or JSX. */
export function parseSource(text: string, path: string): Parsed {
  const kind = scriptKindFor(path);
  const fileName = `/input${extname(path).toLowerCase() || ".ts"}`;
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const error = firstSyntaxError(sourceFile);
  return error === null ? { ok: true, sourceFile } : { ok: false, error };
}

/** 1-based line of the first token of `node`. */
export function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function collectTokens(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: string[],
): void {
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    const text = node.getText(sourceFile);
    if (text.length > 0) {
      out.push(text);
    }
    return;
  }
  for (const child of children) {
    collectTokens(child, sourceFile, out);
  }
}

/**
 * The tokens of `node` joined by single spaces. Whitespace, line breaks and
 * comments drop out, so reformatting or commenting code compares equal while
 * any change to the code itself does not.
 */
export function normaliseCode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const tokens: string[] = [];
  collectTokens(node, sourceFile, tokens);
  return tokens.join(" ");
}

/** Strip parentheses, `as`, `satisfies` and non-null assertions. */
export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** A property name as plain text, or null when it is computed. */
export function propertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function literalProperty(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property)) {
    return null;
  }
  const name = propertyName(property.name);
  const value = literalText(property.initializer);
  if (name === null || value === null) {
    return null;
  }
  const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
  return `${key}:${value}`;
}

/**
 * A canonical text for a literal value, or null when `expression` is not
 * built only from literals. `0.80` and `0.8` compare equal, quotes are
 * normalised, and objects and arrays of literals count as literals so an
 * options object such as `{ threshold: 0.5 }` is compared too. Anything that
 * reads a variable is null: renaming a variable must not look like a change.
 */
export function literalText(expression: ts.Expression): string | null {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.text);
  }
  if (ts.isNumericLiteral(node)) {
    return String(Number(node.text));
  }
  if (ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)) {
    return node.text;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = literalText(node.operand);
    if (operand === null || !ts.isNumericLiteral(unwrap(node.operand))) {
      return null;
    }
    return node.operator === ts.SyntaxKind.MinusToken
      ? String(-Number(operand))
      : operand;
  }
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return "true";
    case ts.SyntaxKind.FalseKeyword:
      return "false";
    case ts.SyntaxKind.NullKeyword:
      return "null";
    default:
      break;
  }
  if (ts.isIdentifier(node) && node.text === "undefined") {
    return "undefined";
  }
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((element) => literalText(element));
    return parts.every((part) => part !== null) ? `[${parts.join(",")}]` : null;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const parts = node.properties.map((property) => literalProperty(property));
    return parts.every((part) => part !== null) ? `{${parts.join(",")}}` : null;
  }
  return null;
}

/** The text of a string-like literal, or null. */
export function stringValue(expression: ts.Expression): string | null {
  const node = unwrap(expression);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

export function isFunctionLike(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}
