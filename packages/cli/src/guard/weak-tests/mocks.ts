import ts from "typescript";
import { literalText, unwrap } from "../source.js";
import { fromFramework, type FileFacts, type Fn } from "./model.js";
import { accessChain, isNameOnly } from "./syntax.js";

/**
 * Mocks: which calls make a mock that runs no code of the repository, which
 * of the mocks a test makes it only calls and asserts on itself, and which
 * name an assertion's subject reads from, so the verdict can tell an
 * assertion on such a mock.
 */

/** Modules whose mock factories make a function that runs no code of the repository. */
const MOCK_MODULES = new Set(["vitest", "@jest/globals", "node:test", "sinon"]);

/** `vi.fn()`, `jest.fn()`, node's `mock.fn()`, `sinon.stub()` and `sinon.spy()`. */
const MOCK_FACTORIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["vi", new Set(["fn"])],
  ["jest", new Set(["fn"])],
  ["mock", new Set(["fn"])],
  ["sinon", new Set(["stub", "spy"])],
]);

/**
 * `vi.fn()` and the like, with `.mockReturnValue(1)`-style calls after it.
 * Every argument must be a literal: `vi.fn(realAdd)` and `sinon.stub(api,
 * "get")` wrap real code, so calling or asserting on them does run something.
 */
export function isMockFactory(
  expression: ts.Expression,
  facts: FileFacts,
): boolean {
  let node = unwrap(expression);
  for (;;) {
    if (
      !ts.isCallExpression(node) ||
      !node.arguments.every((arg) => literalText(arg) !== null)
    ) {
      return false;
    }
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      return false;
    }
    const owner = unwrap(callee.expression);
    if (ts.isIdentifier(owner)) {
      return (
        MOCK_FACTORIES.get(owner.text)?.has(callee.name.text) === true &&
        fromFramework(owner.text, facts, MOCK_MODULES)
      );
    }
    if (!callee.name.text.startsWith("mock")) {
      return false;
    }
    node = owner;
  }
}

/**
 * True when this use of a mock keeps it inside the test: the test calls it
 * or one of its own methods as a statement, or asserts on it. Any other use
 * (an argument, a property, a returned value, a use inside a callback) could
 * pass the mock to the code under test.
 */
function staysInTest(
  use: ts.Identifier,
  fn: Fn,
  subjects: ReadonlySet<ts.Node>,
): boolean {
  if (ts.findAncestor(use.parent, ts.isFunctionLike) !== fn) {
    return false;
  }
  let top: ts.Node = use;
  for (;;) {
    if (subjects.has(top)) {
      return true;
    }
    const parent = top.parent;
    const chained =
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isAwaitExpression(parent)) &&
      parent.expression === top;
    if (!chained) {
      return ts.isExpressionStatement(parent);
    }
    top = parent;
  }
}

/**
 * Every use of every name in `fn`, read in one walk: looking each mock up in
 * its own walk made a test with many mocks quadratic.
 */
function usesByName(fn: Fn): Map<string, ts.Identifier[]> {
  const out = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isNameOnly(node)) {
      const uses = out.get(node.text);
      if (uses === undefined) {
        out.set(node.text, [node]);
      } else {
        uses.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return out;
}

/** Best effort: only a `const` declared directly in the test body counts. */
export function ownMocks(
  fn: Fn,
  facts: FileFacts,
  subjects: ReadonlySet<ts.Node>,
): string[] {
  if (fn.body === undefined || !ts.isBlock(fn.body)) {
    return [];
  }
  let uses: Map<string, ts.Identifier[]> | null = null;
  const out: string[] = [];
  for (const statement of fn.body.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const { name, initializer } of statement.declarationList
      .declarations) {
      if (
        ts.isIdentifier(name) &&
        initializer !== undefined &&
        isMockFactory(initializer, facts)
      ) {
        uses ??= usesByName(fn);
        const all = uses.get(name.text) ?? [];
        if (all.every((use) => staysInTest(use, fn, subjects))) {
          out.push(name.text);
        }
      }
    }
  }
  return out;
}

/**
 * The name the subject reads from through property access alone: `fn` for
 * `expect(fn)` and `expect(fn.mock.calls[0])`, null for `expect(fn())`.
 */
export function subjectRoot(subject: ts.Expression | undefined): string | null {
  if (subject === undefined || literalText(subject) !== null) {
    return null;
  }
  return accessChain(subject)?.root ?? null;
}
