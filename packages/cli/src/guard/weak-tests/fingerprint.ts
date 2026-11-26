import ts from "typescript";

/**
 * Whether a test body changed in more than its formatting: a fingerprint of
 * its tokens with what a formatter decides taken out.
 */

/** Nodes that end with a semicolon a formatter may add or drop. */
const TERMINATED = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

/** `x => x`: one parameter that is a bare name, which needs no parentheses. */
function hasBareParameter(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) || node.type || node.typeParameters) {
    return false;
  }
  const [only, ...rest] = node.parameters;
  return (
    only !== undefined &&
    rest.length === 0 &&
    ts.isIdentifier(only.name) &&
    !only.type &&
    !only.initializer &&
    !only.dotDotDotToken &&
    !only.questionToken &&
    !only.modifiers
  );
}

function collectFingerprint(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: string[],
): void {
  // A tagged template sees the raw text, so its quoting is not formatting.
  const quoted =
    ts.isStringLiteral(node) ||
    (ts.isNoSubstitutionTemplateLiteral(node) &&
      !ts.isTaggedTemplateExpression(node.parent));
  if (quoted) {
    out.push(JSON.stringify(node.text));
    return;
  }
  if (ts.isNumericLiteral(node)) {
    out.push(String(Number(node.text)));
    return;
  }
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    const text = node.getText(sourceFile);
    if (text.length > 0) {
      out.push(text);
    }
    return;
  }
  const terminated = TERMINATED.has(node.kind);
  const bare = hasBareParameter(node);
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    const dropped =
      (last && terminated && child.kind === ts.SyntaxKind.SemicolonToken) ||
      (last &&
        node.kind === ts.SyntaxKind.SyntaxList &&
        child.kind === ts.SyntaxKind.CommaToken) ||
      (bare &&
        (child.kind === ts.SyntaxKind.OpenParenToken ||
          child.kind === ts.SyntaxKind.CloseParenToken));
    if (!dropped) {
      collectFingerprint(child, sourceFile, out);
    }
  });
  // Written for every such node, with or without its semicolon in the
  // source, so `a\n(b)` (one call) and `a;\n(b)` (two statements) differ.
  if (terminated) {
    out.push(";");
  }
}

/**
 * The tokens of a test function with what a formatter decides taken out:
 * whitespace and comments, the semicolon that ends a statement, a trailing
 * comma, the parentheses around a single bare arrow parameter, and the
 * quotes of a string (`"x"`, `'x'` or a template with no `${}`). Two bodies
 * with the same fingerprint are the same test, so the second is not judged
 * as a changed one.
 */
export function formatFingerprint(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const tokens: string[] = [];
  collectFingerprint(node, sourceFile, tokens);
  return tokens.join(" ");
}
