import ts from "typescript";
import { literalText, unwrap } from "../source.js";
import type { Fn } from "./model.js";

/**
 * Small readings of the syntax tree that several rules share: what a node
 * binds, the access chain it reads, and whether a name only names.
 */

export function asFn(node: ts.Node): Fn | null {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
    ? node
    : null;
}

export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

/** One read through property and element access: `rows[0].name`. */
interface AccessChain {
  /** The name the chain starts at, or null when it starts at `this`. */
  readonly root: string | null;
  /**
   * The chain written one way whatever its wrappers (`a!.b`, `(a as T).b`
   * and `a?.b` are all `a.b`), or null when an index is not a plain read:
   * reading it twice could then give two values.
   */
  readonly text: string | null;
  /** True for names and dots only. */
  readonly plain: boolean;
}

/** Read `expression` as an access chain, or null when it is anything else. */
export function accessChain(expression: ts.Expression): AccessChain | null {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    return { root: node.text, text: node.text, plain: true };
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return { root: null, text: "this", plain: false };
  }
  if (ts.isPropertyAccessExpression(node)) {
    const owner = accessChain(node.expression);
    return (
      owner && {
        ...owner,
        text: owner.text === null ? null : `${owner.text}.${node.name.text}`,
      }
    );
  }
  if (ts.isElementAccessExpression(node)) {
    const owner = accessChain(node.expression);
    const index =
      literalText(node.argumentExpression) ??
      accessChain(node.argumentExpression)?.text ??
      null;
    return (
      owner && {
        root: owner.root,
        text:
          owner.text === null || index === null
            ? null
            : `${owner.text}[${index}]`,
        plain: false,
      }
    );
  }
  return null;
}

/** Source text on one line, cut short: a name for a message, not for comparing. */
export function brief(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export function isInside(node: ts.Node, roots: readonly ts.Node[]): boolean {
  return roots.some((root) => node.pos >= root.pos && node.end <= root.end);
}

/**
 * True when `node` only names something and reads no variable: the `x` of
 * `a.x`, a key of an object literal, the name a declaration binds, a label,
 * or a JSX tag (making an element runs nothing of the component).
 */
export function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  return (
    ("name" in parent && parent.name === node) ||
    ("propertyName" in parent && parent.propertyName === node) ||
    ("label" in parent && parent.label === node) ||
    ("tagName" in parent && parent.tagName === node)
  );
}
