import ts from "typescript";
import { literalText, propertyName, unwrap } from "../source.js";
import { readFunction } from "./body.js";
import {
  isQuietImport,
  type AssertionParts,
  type FileFacts,
  type Fn,
  type Helper,
  type Hook,
} from "./model.js";
import { accessChain, asFn, bindingNames, isNameOnly } from "./syntax.js";
import { defaultsTrusted, isTrustedVariable, type Reader } from "./trust.js";

/**
 * The file, read once before any test: the names it imports or declares at
 * module level, its module-level constants, its named functions, the names
 * it assigns to, and the hooks and fixture definitions that run around its
 * tests.
 */

/** Calls whose callbacks run around every test. */
const HOOKS = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);

/**
 * The names a test function is known by before the file renames it, and
 * `base`, the name Playwright's documentation gives it before `.extend`.
 */
const TEST_FUNCTIONS = new Set(["test", "it", "base"]);

/** Vitest's type-test files, which its type checker reads and nothing runs. */
const TYPE_TEST_FILE = /\.(test|spec)-d\.[cm]?[jt]sx?$/;

/** The module a `require("x")` call loads, or null. */
function requiredModule(expression: ts.Expression | undefined): string | null {
  const node = expression && unwrap(expression);
  if (
    !node ||
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "require"
  ) {
    return null;
  }
  const arg = node.arguments[0];
  return arg !== undefined && ts.isStringLiteral(arg) ? arg.text : null;
}

/**
 * Names one top-level statement binds, each with the module it comes from
 * when the statement is an import or a `require`.
 */
function moduleLevelNames(
  statement: ts.Statement,
): (readonly [string, string | null])[] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const source = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const named =
      bindings === undefined
        ? []
        : ts.isNamespaceImport(bindings)
          ? [bindings.name.text]
          : bindings.elements.map((element) => element.name.text);
    return [
      ...(clause?.name === undefined ? [] : [clause.name.text]),
      ...named,
    ].map((name) => [name, source] as const);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name).map(
        (name) => [name, requiredModule(declaration.initializer)] as const,
      ),
    );
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement);
  return named && statement.name !== undefined
    ? [[statement.name.text, null]]
    : [];
}

/** The names an assignment target writes: `x`, `[x, y]`, `{ a: x }`, `x!`. */
function targetNames(target: ts.Expression, out: Set<string>): void {
  const node = unwrap(target);
  if (ts.isIdentifier(node)) {
    out.add(node.text);
  } else if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((element) => {
      targetNames(
        ts.isSpreadElement(element) ? element.expression : element,
        out,
      );
    });
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        targetNames(property.initializer, out);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        out.add(property.name.text);
      } else if (ts.isSpreadAssignment(property)) {
        targetNames(property.expression, out);
      }
    }
  } else if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // `[x = 1] = …`: the default sits on the target.
    targetNames(node.left, out);
  }
}

function isAssignment(node: ts.BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isStep(node: ts.Node): node is ts.PrefixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/**
 * Every name the file assigns to, wherever it is. The set is flat: a name
 * assigned in one function is taken as assigned everywhere, which can only
 * make the guard trust less.
 */
function assignedNames(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignment(node)) {
      targetNames(node.left, out);
    } else if (isStep(node)) {
      targetNames(node.operand, out);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      targetNames(node.initializer, out);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function isConstList(node: ts.Node): boolean {
  return (
    ts.isVariableDeclarationList(node) &&
    (node.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Every function in the file that is a helper (see `Helper`), wherever it is
 * defined. A function declared without a body (`declare function`, an
 * overload signature) is not one: its code is somewhere the guard cannot
 * read.
 */
function namedFunctions(
  sourceFile: ts.SourceFile,
  assigned: ReadonlySet<string>,
): Map<string, Helper[]> {
  const out = new Map<string, Helper[]>();
  const add = (declaration: ts.Node, name: ts.Node | undefined, fn: Fn) => {
    if (
      name === undefined ||
      !ts.isIdentifier(name) ||
      assigned.has(name.text)
    ) {
      return;
    }
    const scope =
      ts.findAncestor(declaration.parent, ts.isFunctionLike) ?? sourceFile;
    out.set(name.text, [...(out.get(name.text) ?? []), { fn, scope, name }]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
      add(node, node.name, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isConstList(node.parent)
    ) {
      const fn = asFn(unwrap(node.initializer));
      if (fn !== null) {
        add(node, node.name, fn);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** The name an expression is built on: `base` for `base.extend({}).extend({})`. */
function rootName(expression: ts.Expression): string | null {
  let node = unwrap(expression);
  for (;;) {
    if (ts.isIdentifier(node)) {
      return node.text;
    }
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
      node = unwrap(node.expression);
    } else {
      return null;
    }
  }
}

/**
 * Names that hold a test function: `test` and `it`, what the file imports or
 * requires under those names (`test as base`), and what it builds from one
 * (`const test = base.extend({})`). Only on these is `.extend` a fixture
 * definition and `.use` a fixture override: `z.object({}).extend()` is not.
 */
function testFunctionNames(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set(TEST_FUNCTIONS);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      TEST_FUNCTIONS.has(
        node.propertyName !== undefined && ts.isIdentifier(node.propertyName)
          ? node.propertyName.text
          : node.name.text,
      )
    ) {
      out.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const root = rootName(node.initializer);
      if (root !== null && out.has(root)) {
        out.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * True when anything in `node` could be a fixture: a function written into
 * it, or a value the guard cannot see, such as a call's result or a name
 * that is not a module-level constant. Option keys and literals are data.
 */
function mayHoldFixture(node: ts.Node, facts: FileFacts): boolean {
  if (ts.isTypeNode(node)) {
    return false;
  }
  if (
    ts.isFunctionLike(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  ) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return (
      !isNameOnly(node) &&
      node.text !== "undefined" &&
      !facts.constants.has(node.text)
    );
  }
  return (
    ts.forEachChild(
      node,
      (child) => mayHoldFixture(child, facts) || undefined,
    ) === true
  );
}

type HookKind = "hook" | "extend" | "use";

/**
 * What a call does around tests: a hook (`afterEach`), a fixture definition
 * (`test.extend`) or a fixture override (`test.use`), or null for anything
 * else. `.extend` and `.use` count only on a test function.
 */
function hookKind(
  call: ts.CallExpression,
  testNames: ReadonlySet<string>,
): HookKind | null {
  const callee = unwrap(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(name)) {
    return null;
  }
  if (HOOKS.has(name.text)) {
    return "hook";
  }
  if (
    !ts.isPropertyAccessExpression(callee) ||
    (name.text !== "extend" && name.text !== "use")
  ) {
    return null;
  }
  const root = rootName(callee.expression);
  return root !== null && testNames.has(root) ? name.text : null;
}

/** What a hook may do for the tests it runs around. */
interface HookReading {
  readonly mayCheck: boolean;
  readonly advises: boolean;
}

/**
 * Whether a hook may check something for the tests it runs around. One that
 * only drives built-in fixtures, only asserts on constants, or only calls
 * the framework's own mock helpers does not. A fixture definition
 * (`test.extend`) always may: its functions run around tests in ways the
 * guard does not follow. A fixture override (`test.use`) may when it holds a
 * function or a value from elsewhere; one that only sets options does not.
 *
 * An advisory check in a hook (see `BodyEvidence.hookAdvisory`) is kept
 * apart: it checks only while `toSatisfy` blocks, which the verdict knows.
 */
function readHook(
  call: ts.CallExpression,
  kind: HookKind,
  facts: FileFacts,
): HookReading {
  if (kind === "extend") {
    return { mayCheck: true, advises: false };
  }
  if (kind === "use") {
    return {
      mayCheck: call.arguments.some((arg) => mayHoldFixture(arg, facts)),
      advises: false,
    };
  }
  const chain = accessChain(unwrap(call.expression));
  const shape = { root: chain?.root ?? "", rows: false };
  let mayCheck = false;
  let advises = false;
  for (const arg of call.arguments) {
    const node = unwrap(arg);
    if (
      literalText(node) !== null ||
      (ts.isIdentifier(node) && isQuietImport(node.text, facts))
    ) {
      continue;
    }
    const fn = asFn(node);
    if (fn === null) {
      mayCheck = true;
      continue;
    }
    const { scan } = readFunction(fn, shape, facts, true);
    mayCheck ||=
      scan.ownAsserts ||
      scan.helperAsserts ||
      scan.throws ||
      scan.checksByHand ||
      scan.unseen.length > 0;
    advises ||= scan.ownAdvisory || scan.helperAdvisory;
  }
  return { mayCheck, advises };
}

/** Every hook and fixture definition in the file, with the block it covers. */
function readHooks(sourceFile: ts.SourceFile, facts: FileFacts): Hook[] {
  const out: Hook[] = [];
  const testNames = testFunctionNames(sourceFile);
  const visit = (node: ts.Node): void => {
    const kind = ts.isCallExpression(node) ? hookKind(node, testNames) : null;
    if (kind !== null && ts.isCallExpression(node)) {
      out.push({
        scope: ts.findAncestor(node.parent, ts.isFunctionLike) ?? sourceFile,
        ...readHook(node, kind, facts),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * Matcher names the file passes to `expect.extend` in an object literal. A
 * matcher object from elsewhere (`expect.extend(matchers)`) is not read:
 * such sets add matchers, and treating every built-in as replaced would
 * silence every constant test in the file.
 */
function customMatchers(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      accessChain(node.expression)?.text === "expect.extend"
    ) {
      const arg = node.arguments[0] && unwrap(node.arguments[0]);
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          const name =
            property.name === undefined ? null : propertyName(property.name);
          if (name !== null) {
            out.add(name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** The package whose `toSatisfy` is advisory. */
const JEVY = "@jevyjs/playwright";

/** The text of an import or binding name: `expect`, or `"expect"`. */
function nameText(name: ts.Node | undefined): string | null {
  return name !== undefined &&
    (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : null;
}

/**
 * Whether the file binds `expect` to `@jevyjs/playwright`'s `expect`, by
 * `import { expect }` or `const { expect } = require(…)`. A different export
 * imported under the name (`other as expect`) is not it, nor is a type-only
 * import, which binds nothing at run time.
 */
function importsJevyExpect(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      return (
        nameText(statement.moduleSpecifier) === JEVY &&
        clause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (element) =>
            !element.isTypeOnly &&
            element.name.text === "expect" &&
            nameText(element.propertyName ?? element.name) === "expect",
        )
      );
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          requiredModule(declaration.initializer) === JEVY &&
          ts.isObjectBindingPattern(declaration.name) &&
          declaration.name.elements.some(
            (element) =>
              element.dotDotDotToken === undefined &&
              nameText(element.name) === "expect" &&
              nameText(element.propertyName ?? element.name) === "expect",
          ),
      )
    );
  });
}

/** Read what the rules need from the whole file: its names, helpers and hooks. */
export function readFileFacts(
  sourceFile: ts.SourceFile,
  readAssertion: (call: ts.CallExpression) => AssertionParts | null,
  path: string,
): FileFacts {
  const constants = new Set<string>();
  const hooks: Hook[] = [];
  const names = sourceFile.statements.flatMap(moduleLevelNames);
  const assigned = assignedNames(sourceFile);
  const helpers = namedFunctions(sourceFile, assigned);
  const matchers = customMatchers(sourceFile);
  const facts: FileFacts = {
    readAssertion,
    helpers,
    helperOf: new Map(
      [...helpers.values()].flat().map((helper) => [helper.fn, helper]),
    ),
    assigned,
    customMatchers: matchers,
    jevyToSatisfy:
      importsJevyExpect(sourceFile) &&
      !matchers.has("toSatisfy") &&
      !assigned.has("expect"),
    typeOnly: TYPE_TEST_FILE.test(path),
    moduleNames: new Set(names.map(([name]) => name)),
    imports: new Map(
      names.flatMap(([name, source]) =>
        source === null ? [] : [[name, source] as const],
      ),
    ),
    constants,
    hooks,
    memo: {
      scopeNames: new WeakMap(),
      readings: new WeakMap(),
      closures: new WeakMap(),
      callSites: new WeakMap(),
    },
  };
  // Module-level constants are judged with the rules for locals, in source
  // order, so one built from an earlier one is trusted too.
  const reader: Reader = {
    facts,
    trusted: constants,
    distrusted: new Set(),
    data: new Set(),
    declared: new Set(),
    literals: new Map(),
    fixtures: new Set(),
    customMatchers: facts.customMatchers,
    body: null,
  };
  for (const statement of sourceFile.statements) {
    const declarations = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : [];
    for (const declaration of declarations) {
      const { name } = declaration;
      if (
        isTrustedVariable(declaration, reader) &&
        defaultsTrusted(name, reader)
      ) {
        bindingNames(name).forEach((text) => constants.add(text));
      }
    }
  }
  // Hooks are read last: reading one uses the constants and helpers above.
  hooks.push(...readHooks(sourceFile, facts));
  return facts;
}
