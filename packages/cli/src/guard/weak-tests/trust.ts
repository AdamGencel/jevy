import ts from "typescript";
import { literalText, unwrap } from "../source.js";
import { constantOf } from "./constants.js";
import {
  fromFramework,
  type AssertionScope,
  type FileFacts,
  type Fn,
  type Helper,
  type Known,
  type TestShape,
} from "./model.js";
import { isMockFactory } from "./mocks.js";
import { accessChain, asFn, bindingNames, isInside } from "./syntax.js";

/**
 * Which values can hide an assertion. Owns the reader of one function's
 * names: which are trusted (built-in fixtures, literals, globals and what is
 * made from them), which are not, and which same-file functions a name can
 * mean.
 */

/**
 * Globals whose calls run no code from the repository, so they cannot hide an
 * assertion. Kept short on purpose: anything missing is treated as unreadable
 * code, which costs a `review` finding where a `weakening` one was possible.
 */
const GLOBALS = new Set([
  "console",
  "JSON",
  "Math",
  "Object",
  "Array",
  "Promise",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Map",
  "Set",
  "Error",
  "URL",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "parseInt",
  "parseFloat",
]);

/**
 * Playwright's built-in fixtures. A fixture the project defines itself
 * (`checkoutPage`) is often a page object with assertions inside, so only
 * these are trusted to assert nothing.
 */
const BUILT_IN_FIXTURES = new Set([
  "page",
  "context",
  "browser",
  "request",
  "baseURL",
  "browserName",
]);

/**
 * The built-in fixtures that are always an object. `baseURL` is not one: it
 * comes from the config, so `expect(baseURL).toBeDefined()` checks something.
 */
const FIXTURE_OBJECTS = new Set(["page", "context", "browser", "request"]);

/** Members of `test` and `it` that run only the callback they are given. */
const TEST_API = new Set([
  "step",
  "info",
  "setTimeout",
  "slow",
  "skip",
  "fixme",
  "fail",
]);

/**
 * Names in one function whose values are known to come from built-in
 * fixtures, literals or globals. The sets are flat, not scoped: a name
 * declared twice is trusted only if every declaration is, which errs towards
 * "cannot read".
 */
export interface Reader extends AssertionScope {
  readonly facts: FileFacts;
  readonly trusted: Set<string>;
  readonly distrusted: Set<string>;
  /**
   * Rows of an `.each` table. A row is trusted as plain data, to read or to
   * hand on, but not to call or await: a table can hold functions and
   * promises from anywhere.
   */
  readonly data: Set<string>;
  /** Every name the function declares, to notice one declared twice. */
  readonly declared: Set<string>;
  readonly literals: Map<string, Known>;
  readonly fixtures: Set<string>;
  /**
   * The function being read, or null for a module-level constant. Inside a
   * function, a function written into a value is read with the body, so the
   * value can be trusted. Nothing reads the functions of a module-level
   * constant: `const po = { check() { … } }` must not make `po.check()` look
   * empty.
   */
  readonly body: Fn | null;
}

/**
 * Names `fn` declares in its own scope, other than functions. Nested
 * functions are left out: their names are not visible outside them.
 */
function scopeNames(fn: ts.Node, facts: FileFacts): readonly string[] {
  const cached = facts.memo.scopeNames.get(fn);
  if (cached !== undefined) {
    return cached;
  }
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const helper = node.initializer && asFn(unwrap(node.initializer));
      if (!helper) {
        out.push(...bindingNames(node.name));
      }
    } else if (ts.isParameter(node)) {
      out.push(...bindingNames(node.name));
    } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
      out.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  facts.memo.scopeNames.set(fn, out);
  return out;
}

/**
 * Names declared by the functions around `body`: a describe block's `const
 * api = createApi()`. Inside `body` such a name hides the module-level
 * constant, global or helper of the same name, so it must not borrow its
 * trust.
 */
function enclosingNames(body: Fn, facts: FileFacts): string[] {
  const out: string[] = [];
  let outer = ts.findAncestor(body.parent, ts.isFunctionLike);
  while (outer !== undefined) {
    out.push(...scopeNames(outer, facts));
    outer = ts.findAncestor(outer.parent, ts.isFunctionLike);
  }
  return out;
}

export function newReader(facts: FileFacts, body: Fn): Reader {
  return {
    facts,
    trusted: new Set(facts.constants),
    distrusted: new Set(enclosingNames(body, facts)),
    data: new Set(),
    declared: new Set(),
    literals: new Map(),
    fixtures: new Set(),
    customMatchers: facts.customMatchers,
    body,
  };
}

/**
 * The same-file functions `name` can mean at `site`. A function declared
 * inside another test is out of scope, whatever it is called.
 */
export function helpersFor(
  name: string,
  reader: Reader,
  site: ts.Node,
): Helper[] {
  if (reader.body === null || reader.distrusted.has(name)) {
    return [];
  }
  return (reader.facts.helpers.get(name) ?? []).filter((helper) =>
    isInside(site, [helper.scope]),
  );
}

/**
 * Whether the value of `name` is one no assertion can hide behind. A
 * same-file function is not such a value: it is safe to call, because the
 * call is read, but under another name (`const run = check`) it is not.
 */
export function knows(name: string, reader: Reader): boolean {
  if (reader.distrusted.has(name)) {
    return false;
  }
  return (
    reader.trusted.has(name) ||
    name === "undefined" ||
    (GLOBALS.has(name) && !reader.facts.moduleNames.has(name))
  );
}

/** A same-file function, named directly: a call or a hand-over the guard reads. */
function isHelperName(expression: ts.Expression, reader: Reader): boolean {
  const node = unwrap(expression);
  return (
    ts.isIdentifier(node) && helpersFor(node.text, reader, node).length > 0
  );
}

/** True when `expression` reads from a row of an `.each` table. */
export function isRow(expression: ts.Expression, reader: Reader): boolean {
  const root = accessChain(expression)?.root ?? null;
  return root !== null && reader.data.has(root) && knows(root, reader);
}

/** A wait fails the test when it times out, so it is a check in all but name. */
function isWait(name: string): boolean {
  return name.startsWith("waitFor") && name !== "waitForTimeout";
}

/** `test.step`, `test.info`, `test.step.skip`: the runner's own, on `test` or `it`. */
export function isTestApi(callee: ts.Expression): boolean {
  let node = unwrap(callee);
  if (!ts.isPropertyAccessExpression(node)) {
    return false;
  }
  while (ts.isPropertyAccessExpression(node)) {
    if (!TEST_API.has(node.name.text)) {
      return false;
    }
    node = unwrap(node.expression);
  }
  return ts.isIdentifier(node) && (node.text === "test" || node.text === "it");
}

/** `new Error(…)`, `new Promise(…)`: a global class, named directly. */
export function isKnownClass(node: ts.NewExpression, reader: Reader): boolean {
  const target = unwrap(node.expression);
  return ts.isIdentifier(target) && knows(target.text, reader);
}

/** Whether calling `callee` runs only code the guard can read or vouch for. */
export function isTrustedCallee(
  callee: ts.Expression,
  reader: Reader,
): boolean {
  const node = unwrap(callee);
  if (ts.isPropertyAccessExpression(node) && isWait(node.name.text)) {
    return false;
  }
  return (
    isHelperName(node, reader) || isTestApi(node) || isTrusted(node, reader)
  );
}

function isTrustedProperty(
  property: ts.ObjectLiteralElementLike,
  reader: Reader,
): boolean {
  if (ts.isPropertyAssignment(property)) {
    return isTrusted(property.initializer, reader);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return knows(property.name.text, reader);
  }
  // A method or accessor is a function; a spread could carry anything.
  return reader.body !== null && !ts.isSpreadAssignment(property);
}

/**
 * The arguments that are not safe to hand to trusted code, which can call
 * back a function it is given but can do no more with plain data. A
 * same-file function is safe to hand over: the guard reads it where it is.
 */
export function untrustedArguments(
  args: readonly ts.Expression[],
  reader: Reader,
): ts.Expression[] {
  return args.filter(
    (arg) => !isTrusted(arg, reader) && !isHelperName(arg, reader),
  );
}

/**
 * Whether `expression` is a value no assertion can hide behind: a literal, a
 * built-in fixture, a global, or something made from those. What a function
 * defined in this file returns is not trusted, since it can return an import.
 */
export function isTrusted(expression: ts.Expression, reader: Reader): boolean {
  const node = unwrap(expression);
  if (ts.isAwaitExpression(node)) {
    return isTrusted(node.expression, reader);
  }
  if (ts.isIdentifier(node)) {
    return knows(node.text, reader);
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return isTrusted(node.expression, reader);
  }
  if (ts.isCallExpression(node)) {
    return (
      isMockFactory(node, reader.facts) ||
      (!isHelperName(node.expression, reader) &&
        isTrustedCallee(node.expression, reader) &&
        untrustedArguments(node.arguments, reader).length === 0)
    );
  }
  if (ts.isNewExpression(node)) {
    return (
      isKnownClass(node, reader) &&
      untrustedArguments(node.arguments ?? [], reader).length === 0
    );
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return reader.body !== null;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => isTrusted(element, reader));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) =>
      isTrustedProperty(property, reader),
    );
  }
  if (ts.isBinaryExpression(node)) {
    return isTrusted(node.left, reader) && isTrusted(node.right, reader);
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isTrusted(node.whenTrue, reader) && isTrusted(node.whenFalse, reader)
    );
  }
  // These always give a string, number or boolean.
  if (
    ts.isTemplateExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isTypeOfExpression(node)
  ) {
    return true;
  }
  return literalText(node) !== null;
}

/** True unless a default in the pattern, `{ run = verify }`, is not trusted. */
export function defaultsTrusted(name: ts.BindingName, reader: Reader): boolean {
  return (
    ts.isIdentifier(name) ||
    name.elements.every(
      (element) =>
        ts.isOmittedExpression(element) ||
        ((element.initializer === undefined ||
          isTrusted(element.initializer, reader)) &&
          defaultsTrusted(element.name, reader)),
    )
  );
}

/** Record the names `name` binds as trusted, or not, for the whole function. */
function learn(name: ts.BindingName, ok: boolean, reader: Reader): void {
  const { moduleNames, constants } = reader.facts;
  const trust = ok && defaultsTrusted(name, reader);
  for (const text of bindingNames(name)) {
    // Declared twice: which one a use means, the flat sets cannot say.
    if (reader.declared.has(text)) {
      reader.literals.delete(text);
      reader.fixtures.delete(text);
    }
    reader.declared.add(text);
    // A local that reuses the name of an import would lend it its trust.
    const shadows = moduleNames.has(text) && !constants.has(text);
    (trust && !shadows ? reader.trusted : reader.distrusted).add(text);
  }
}

/**
 * A parameter is trusted unless its default is not. What is passed in is
 * checked where the function is called or handed on.
 */
export function learnParameter(
  node: ts.ParameterDeclaration,
  reader: Reader,
): void {
  const ok =
    node.initializer === undefined || isTrusted(node.initializer, reader);
  learn(node.name, ok, reader);
}

/**
 * True for a `const`, and for a `let` the file never assigns to: neither can
 * hold another value later. The variable of a `catch` clause is neither.
 */
function isConst(node: ts.VariableDeclaration, reader: Reader): boolean {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return false;
  }
  if ((list.flags & ts.NodeFlags.Const) !== 0) {
    return true;
  }
  return (
    (list.flags & ts.NodeFlags.Let) !== 0 &&
    bindingNames(node.name).every((name) => !reader.facts.assigned.has(name))
  );
}

/**
 * Whether a variable can be trusted. Only one that cannot change can (see
 * `isConst`): following assignments is not worth a wrong `weakening`
 * finding.
 */
export function isTrustedVariable(
  node: ts.VariableDeclaration,
  reader: Reader,
): boolean {
  const list = node.parent;
  const source =
    node.initializer ??
    (ts.isForOfStatement(list.parent) ? list.parent.expression : undefined);
  return (
    isConst(node, reader) && source !== undefined && isTrusted(source, reader)
  );
}

/**
 * The constant a `const` is bound to, when the name can mean nothing else in
 * the function: it is declared once, and no import or outer variable shares
 * the name. Only a primitive counts: a `const` array or object can be filled
 * after it is made, so `expect(seen).toEqual([])` is a real check.
 */
function literalBinding(
  node: ts.VariableDeclaration,
  reader: Reader,
): Known | null {
  const { name, initializer } = node;
  const single =
    ts.isIdentifier(name) &&
    !reader.declared.has(name.text) &&
    !reader.distrusted.has(name.text) &&
    !reader.facts.moduleNames.has(name.text);
  const value =
    single && isConst(node, reader) && initializer !== undefined
      ? constantOf(initializer, reader)
      : null;
  return value?.kind === "primitive" ? value : null;
}

/**
 * First pass over a function body: which names can be trusted. Children come
 * first so an initialiser is judged with the names declared before it.
 *
 * Parameters of nested functions are trusted. A nested function is either an
 * argument of a call, which is unreadable already or passes on trusted
 * values, or a local function, whose callers must pass trusted values too.
 */
export function learnNames(root: ts.Node, reader: Reader): void {
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (isHelperBinding(node, reader.facts)) {
      // A function the body names is read where it is called, like any
      // helper; as a value it is not trusted (`const run = check`). One
      // that reuses a module-level name is not read at all: the flat sets
      // cannot tell which of the two a call means.
      const { text } = node.name;
      reader.declared.add(text);
      if (reader.facts.moduleNames.has(text)) {
        reader.distrusted.add(text);
      }
    } else if (ts.isVariableDeclaration(node)) {
      const value = literalBinding(node, reader);
      learn(node.name, isTrustedVariable(node, reader), reader);
      if (value !== null && ts.isIdentifier(node.name)) {
        reader.literals.set(node.name.text, value);
      }
    } else if (ts.isParameter(node)) {
      learnParameter(node, reader);
    }
  };
  visit(root);
}

/** `const check = () => …`: a declaration that binds a helper. */
function isHelperBinding(
  node: ts.Node,
  facts: FileFacts,
): node is ts.VariableDeclaration & { readonly name: ts.Identifier } {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return false;
  }
  const fn = node.initializer && asFn(unwrap(node.initializer));
  return fn !== undefined && fn !== null && facts.helperOf.has(fn);
}

/** Learn one destructured fixture: trusted only when it is a built-in one. */
function learnFixture(
  element: ts.BindingElement,
  builtIn: boolean,
  reader: Reader,
): void {
  const key = element.propertyName ?? element.name;
  const fixture = ts.isIdentifier(key) ? key.text : "";
  const ok =
    builtIn &&
    element.dotDotDotToken === undefined &&
    element.initializer === undefined &&
    BUILT_IN_FIXTURES.has(fixture);
  learn(element.name, ok, reader);
  if (
    ok &&
    ts.isIdentifier(element.name) &&
    FIXTURE_OBJECTS.has(fixture) &&
    knows(element.name.text, reader)
  ) {
    reader.fixtures.add(element.name.text);
  }
}

/**
 * True when the `test` or `it` a test is defined with is the framework's
 * own, not one the file imports from its own code, builds, or is handed as
 * a parameter of a function around the test.
 */
export function isFrameworkRunner(shape: TestShape, reader: Reader): boolean {
  return (
    fromFramework(shape.root, reader.facts) &&
    !reader.distrusted.has(shape.root)
  );
}

/**
 * Give the parameters of a test or hook function their trust. Rows of an
 * `.each` table are data. Otherwise built-in fixtures are trusted, when the
 * test function is the framework's own, and nothing else is: Jest's `done`,
 * Playwright's `testInfo`, Vitest's whole context. Returns the name of a
 * `done`-style first parameter, which Playwright's first parameter never is.
 */
export function learnParameters(
  fn: Fn,
  shape: TestShape,
  reader: Reader,
): string | null {
  const builtIn = isFrameworkRunner(shape, reader);
  for (const parameter of fn.parameters) {
    if (shape.rows) {
      learnParameter(parameter, reader);
      bindingNames(parameter.name).forEach((name) => reader.data.add(name));
    } else if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        learnFixture(element, builtIn, reader);
      }
    } else {
      learn(parameter.name, false, reader);
    }
  }
  const first = fn.parameters[0]?.name;
  return !shape.rows && first !== undefined && ts.isIdentifier(first)
    ? first.text
    : null;
}
