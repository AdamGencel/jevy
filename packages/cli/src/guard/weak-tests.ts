import ts from "typescript";
import { finding, titleText } from "./findings.js";
import { literalText, unwrap } from "./source.js";
import type { Finding } from "./types.js";

/**
 * Finds a test that checks nothing: one with no assertion, one whose
 * assertions cannot fail, or one that only checks a mock it made itself.
 *
 * The first two block an agent's session, so every rule here leans one way:
 * when the guard cannot prove a test is empty, it asks a person to look
 * (`assertion-not-visible`) or says nothing. Nothing is imported or run, so
 * "prove" means reading the one file: a call into any other file, or a value
 * that came from one, may hold the assertion.
 */

/** Why an assertion's outcome is fixed before the code under test runs. */
export type ConstantOutcome = "literals" | "self" | "fixture";

/**
 * Whether an assertion on constants passes. Only `passes` makes it one that
 * cannot fail: one that fails when reached is how a test marks a line that
 * must not run, and `unknown` may be either.
 */
export type FixedResult = "passes" | "fails" | "unknown";

/** An assertion whose outcome the code under test cannot change. */
export interface Constant {
  readonly outcome: ConstantOutcome;
  readonly result: FixedResult;
}

/** What a test body shows beyond its own `expect` chains. */
export interface BodyEvidence {
  /** A function in this file, which the body calls, has an assertion that can fail. */
  readonly helperAsserts: boolean;
  /** The assertions on constants in the same-file functions the body calls. */
  readonly helperConstants: readonly Constant[];
  /** Code used by the body that the guard cannot read, in source order, each once. */
  readonly unseen: readonly string[];
  /** The body, or a same-file function it calls, has a `throw` statement. */
  readonly throws: boolean;
  /**
   * The body checks in a way no matcher shows: it calls `fail()` or
   * `unreachable()`, counts assertions with `expect.assertions()` or
   * `expect.hasAssertions()`, or uses a `done`-style callback.
   */
  readonly checksByHand: boolean;
  /**
   * A hook (`afterEach`) around the test, or a fixture definition
   * (`test.extend`) in the file, may check: it has an assertion that can
   * fail, throws, or uses code the guard cannot read.
   */
  readonly hookChecks: boolean;
  /**
   * The test is defined with a `test` or `it` that the file imports from its
   * own code or builds itself, so fixtures the guard cannot see may run
   * around it and the built-in ones may have been replaced.
   */
  readonly customRunner: boolean;
  /** The body tests types: nothing in it is meant to fail when it runs. */
  readonly typeLevel: boolean;
  /** Mocks the body creates and only calls itself, by name. */
  readonly ownMocks: readonly string[];
}

/** The parts of `expect(subject).not.matcher(args)`, as the parser read them. */
export interface AssertionParts {
  readonly matcher: string;
  /** True when the chain has an odd number of `.not`. */
  readonly negated: boolean;
  /** `poll`, `resolves` and `rejects`; `.not` is not one. */
  readonly modifiers: readonly string[];
  readonly subject: ts.Expression | undefined;
  readonly args: readonly ts.Expression[];
}

type Primitive = string | number | boolean | null | undefined;

/**
 * A value the guard can work out from the source alone. `opaque` is a
 * constant it does not evaluate (a regular expression, a bigint, an operator
 * it does not model): fixed, but with a result it cannot tell.
 */
export type Known =
  | { readonly kind: "primitive"; readonly value: Primitive }
  | {
      readonly kind: "list";
      readonly text: string | null;
      readonly length: number;
    }
  | { readonly kind: "record"; readonly text: string | null }
  | { readonly kind: "fixture" }
  | { readonly kind: "opaque" };

/** The names of one function that an assertion on constants can be made of. */
export interface AssertionScope {
  /** `const` names bound once to a constant, with its value. */
  readonly literals: ReadonlyMap<string, Known>;
  /** Parameters that hold a built-in fixture object, which is always there. */
  readonly fixtures: ReadonlySet<string>;
}

/** The scope of an assertion outside any test: no names are known. */
export const NO_SCOPE: AssertionScope = {
  literals: new Map(),
  fixtures: new Set(),
};

/** How a test is defined, as far as it decides what its parameters are. */
export interface TestShape {
  /** The name the chain starts with: `test`, `it`, `xit`. */
  readonly root: string;
  /** True for `.each`: the parameters are rows of the table, not fixtures. */
  readonly rows: boolean;
}

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** A named function, and the function or file it is declared in. */
interface Helper {
  readonly fn: Fn;
  readonly scope: ts.Node;
}

/** A hook or fixture definition, and the function or file it applies to. */
interface Hook {
  readonly scope: ts.Node;
  readonly mayCheck: boolean;
}

/** What the rules need to know about the whole file, read once. */
export interface FileFacts {
  /** Reads an `expect(…).matcher(…)` call; the parser owns that grammar. */
  readonly readAssertion: (call: ts.CallExpression) => AssertionParts | null;
  /** Functions defined in the file, by name. A name can have more than one. */
  readonly helpers: ReadonlyMap<string, readonly Helper[]>;
  /**
   * Names the file imports or declares at module level. Such a name is not
   * the global of the same name, and a local that reuses it is not trusted,
   * because the two sets of names a body is read with are not scoped.
   */
  readonly moduleNames: ReadonlySet<string>;
  /** The module each imported or required name comes from. */
  readonly imports: ReadonlyMap<string, string>;
  /** Module-level `const`s built only from literals and other such constants. */
  readonly constants: ReadonlySet<string>;
  readonly hooks: readonly Hook[];
  /** Names each function declares in its own scope, kept so each is read once. */
  readonly scopeNames: WeakMap<ts.Node, readonly string[]>;
}

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
 * Modules whose `test`, `it`, `expect` and hooks are the framework's own. A
 * `test` from anywhere else (`./fixtures`, `base.extend(…)`) can bring
 * fixtures that check around every test, and can replace the built-in ones.
 */
const FRAMEWORKS = new Set(["@playwright/test", "vitest", "@jest/globals"]);

/** Modules whose mock factories make a function that runs no code of the repository. */
const MOCK_MODULES = new Set(["vitest", "@jest/globals", "node:test", "sinon"]);

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

/** Calls whose callbacks run around every test: hooks, and fixture definitions. */
const HOOKS = new Set([
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "extend",
]);

/**
 * Calls that fail a test, or make reaching a line the check, without a
 * matcher. Playwright's `test.fail()` is not one: it marks an expected failure.
 */
const HAND_CHECKS = new Set([
  "fail",
  "unreachable",
  "assertions",
  "hasAssertions",
]);

/** Vitest's type assertions: a test that calls one is checked by the compiler. */
const TYPE_CHECKS = new Set(["expectTypeOf", "assertType"]);

/** `vi.fn()`, `jest.fn()`, node's `mock.fn()`, `sinon.stub()` and `sinon.spy()`. */
const MOCK_FACTORIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["vi", new Set(["fn"])],
  ["jest", new Set(["fn"])],
  ["mock", new Set(["fn"])],
  ["sinon", new Set(["stub", "spy"])],
]);

/** Matchers that pass exactly when both sides are the same value. */
const EQUALITY_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
]);

/**
 * The matchers of Jest, Vitest and Playwright that compare plain values. Only
 * under one of these is a literal tested against literals a constant: any
 * other matcher (`toBeWithinRange`, `toBeValidEmail`) is the project's own
 * code, and calling it on a literal is how that code is tested. Matchers that
 * read something else (a snapshot file, a locator, a thrown error) are left
 * out for the same reason.
 */
const BUILT_IN_MATCHERS = new Set([
  ...EQUALITY_MATCHERS,
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeNaN",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeCloseTo",
  "toContain",
  "toContainEqual",
  "toHaveLength",
  "toHaveProperty",
  "toMatch",
  "toBeTypeOf",
  "toBeOneOf",
]);

const MAX_NAMES = 3;

function asFn(node: ts.Node): Fn | null {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
    ? node
    : null;
}

function bindingNames(name: ts.BindingName): string[] {
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
function accessChain(expression: ts.Expression): AccessChain | null {
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
function brief(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * True when `name` is the framework's own: a global, or imported from one of
 * `modules`. A name the file imports from elsewhere or declares is not.
 */
function fromFramework(
  name: string,
  facts: FileFacts,
  modules: ReadonlySet<string> = FRAMEWORKS,
): boolean {
  if (!facts.moduleNames.has(name)) {
    return true;
  }
  const source = facts.imports.get(name);
  return source !== undefined && modules.has(source);
}

// ---------------------------------------------------------------------------
// Constants: values the source fixes, and what a matcher makes of them.
// ---------------------------------------------------------------------------

const OPAQUE: Known = { kind: "opaque" };
const FIXTURE: Known = { kind: "fixture" };

function primitive(value: Primitive): Known {
  return { kind: "primitive", value };
}

/** Whether a value is truthy, or null when the guard does not know the value. */
function truthiness(value: Known): boolean | null {
  if (value.kind === "primitive") {
    return Boolean(value.value);
  }
  return value.kind === "opaque" ? null : true;
}

function unary(operator: ts.SyntaxKind, operand: Known): Known {
  if (operator === ts.SyntaxKind.ExclamationToken) {
    const truthy = truthiness(operand);
    return truthy === null ? OPAQUE : primitive(!truthy);
  }
  if (operand.kind !== "primitive" || typeof operand.value !== "number") {
    return OPAQUE;
  }
  if (operator === ts.SyntaxKind.MinusToken) {
    return primitive(-operand.value);
  }
  return operator === ts.SyntaxKind.PlusToken ? operand : OPAQUE;
}

function arithmetic(operator: ts.SyntaxKind, a: number, b: number): Known {
  switch (operator) {
    case ts.SyntaxKind.PlusToken:
      return primitive(a + b);
    case ts.SyntaxKind.MinusToken:
      return primitive(a - b);
    case ts.SyntaxKind.AsteriskToken:
      return primitive(a * b);
    case ts.SyntaxKind.SlashToken:
      return primitive(a / b);
    case ts.SyntaxKind.PercentToken:
      return primitive(a % b);
    case ts.SyntaxKind.LessThanToken:
      return primitive(a < b);
    case ts.SyntaxKind.LessThanEqualsToken:
      return primitive(a <= b);
    case ts.SyntaxKind.GreaterThanToken:
      return primitive(a > b);
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return primitive(a >= b);
    default:
      return OPAQUE;
  }
}

/** The value of `left operator right`. Loose equality and the rest are not modelled. */
function binary(operator: ts.SyntaxKind, left: Known, right: Known): Known {
  const truthy = truthiness(left);
  switch (operator) {
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return truthy === null ? OPAQUE : truthy ? right : left;
    case ts.SyntaxKind.BarBarToken:
      return truthy === null ? OPAQUE : truthy ? left : right;
    default:
      break;
  }
  if (left.kind !== "primitive" || right.kind !== "primitive") {
    return OPAQUE;
  }
  const a = left.value;
  const b = right.value;
  if (operator === ts.SyntaxKind.QuestionQuestionToken) {
    return a === null || a === undefined ? right : left;
  }
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return primitive(a === b);
  }
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    return primitive(a !== b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return arithmetic(operator, a, b);
  }
  return typeof a === "string" &&
    typeof b === "string" &&
    operator === ts.SyntaxKind.PlusToken
    ? primitive(a + b)
    : OPAQUE;
}

function typeName(value: Known): Known {
  if (value.kind === "primitive") {
    return primitive(value.value === null ? "object" : typeof value.value);
  }
  return value.kind === "opaque" ? OPAQUE : primitive("object");
}

/** A template is a string when every `${…}` in it is a known primitive. */
function templateValue(parts: readonly (Known | string)[]): Known {
  let text = "";
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
    } else if (part.kind === "primitive") {
      text += String(part.value);
    } else {
      return OPAQUE;
    }
  }
  return primitive(text);
}

function namedConstant(name: string, scope: AssertionScope): Known | null {
  switch (name) {
    case "undefined":
      return primitive(undefined);
    case "NaN":
      return primitive(Number.NaN);
    case "Infinity":
      return primitive(Number.POSITIVE_INFINITY);
    default:
      return scope.literals.get(name) ?? null;
  }
}

function isKnown(value: Known | null): value is Known {
  return value !== null;
}

/**
 * The value of an expression built only from literals, operators and `const`
 * names bound to such expressions, or null when anything else is in it: a
 * call, a parameter, an import. The code under test cannot change it.
 */
function constantOf(
  expression: ts.Expression,
  scope: AssertionScope,
): Known | null {
  const node = unwrap(expression);
  const of = (inner: ts.Expression): Known | null => constantOf(inner, scope);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return primitive(node.text);
  }
  if (ts.isNumericLiteral(node)) {
    return primitive(Number(node.text));
  }
  if (ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)) {
    return OPAQUE;
  }
  if (ts.isIdentifier(node)) {
    return namedConstant(node.text, scope);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const fixed = node.elements.every(
      (element) => !ts.isSpreadElement(element) && of(element) !== null,
    );
    return fixed
      ? { kind: "list", text: literalText(node), length: node.elements.length }
      : null;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const fixed = node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        of(property.initializer) !== null,
    );
    return fixed ? { kind: "record", text: literalText(node) } : null;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = of(node.operand);
    return operand && unary(node.operator, operand);
  }
  if (ts.isTypeOfExpression(node)) {
    const operand = of(node.expression);
    return operand && typeName(operand);
  }
  if (ts.isBinaryExpression(node)) {
    const left = of(node.left);
    const right = of(node.right);
    return left && right && binary(node.operatorToken.kind, left, right);
  }
  if (ts.isConditionalExpression(node)) {
    const [condition, yes, no] = [
      of(node.condition),
      of(node.whenTrue),
      of(node.whenFalse),
    ];
    if (condition === null || yes === null || no === null) {
      return null;
    }
    const truthy = truthiness(condition);
    return truthy === null ? OPAQUE : truthy ? yes : no;
  }
  if (ts.isTemplateExpression(node)) {
    const parts: (Known | string)[] = [node.head.text];
    for (const span of node.templateSpans) {
      const value = of(span.expression);
      if (value === null) {
        return null;
      }
      parts.push(value, span.literal.text);
    }
    return templateValue(parts);
  }
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return primitive(true);
    case ts.SyntaxKind.FalseKeyword:
      return primitive(false);
    case ts.SyntaxKind.NullKeyword:
      return primitive(null);
    default:
      return null;
  }
}

/** The canonical text of an array or object literal: a value made where it is written. */
function freshText(value: Known): string | null | undefined {
  return value.kind === "list" || value.kind === "record"
    ? value.text
    : undefined;
}

/**
 * Whether two known values are equal, or null when the guard cannot tell.
 * `identical` is `toBe`: a fresh array or object is identical to nothing.
 * Two literals with different text may still be equal (key order, undefined
 * properties), so only the same text settles it.
 */
function sameValue(a: Known, b: Known, identical: boolean): boolean | null {
  if (a.kind === "opaque" || b.kind === "opaque") {
    return null;
  }
  if (a.kind === "primitive" && b.kind === "primitive") {
    return Object.is(a.value, b.value);
  }
  if (a.kind === "primitive" || b.kind === "primitive") {
    return false;
  }
  const [left, right] = [freshText(a), freshText(b)];
  if (identical) {
    return left !== undefined || right !== undefined ? false : null;
  }
  const same = a.kind === b.kind && typeof left === "string" && left === right;
  return same ? true : null;
}

function isDefined(value: Known): boolean | null {
  if (value.kind === "primitive") {
    return value.value !== undefined;
  }
  return value.kind === "opaque" ? null : true;
}

function lengthOf(value: Known): number | null {
  if (value.kind === "list") {
    return value.length;
  }
  return value.kind === "primitive" && typeof value.value === "string"
    ? value.value.length
    : null;
}

function numberOf(value: Known | undefined): number | null {
  return value?.kind === "primitive" && typeof value.value === "number"
    ? value.value
    : null;
}

function stringOf(value: Known | undefined): string | null {
  return value?.kind === "primitive" && typeof value.value === "string"
    ? value.value
    : null;
}

function compare(matcher: string, a: number, b: number): boolean {
  switch (matcher) {
    case "toBeGreaterThan":
      return a > b;
    case "toBeGreaterThanOrEqual":
      return a >= b;
    case "toBeLessThan":
      return a < b;
    default:
      return a <= b;
  }
}

/**
 * Whether `expect(subject).matcher(...args)` holds, or null when the guard
 * cannot work it out. Null is the safe answer: it turns a `weakening` finding
 * into a `review` one, so a matcher is modelled only where its rule is plain.
 */
function holds(
  matcher: string,
  subject: Known,
  args: readonly Known[],
): boolean | null {
  const first = args[0];
  switch (matcher) {
    case "toBe":
      return first === undefined ? null : sameValue(subject, first, true);
    case "toEqual":
    case "toStrictEqual":
      return first === undefined ? null : sameValue(subject, first, false);
    case "toMatchObject":
      return first !== undefined && sameValue(subject, first, false) === true
        ? true
        : null;
    case "toBeTruthy":
      return truthiness(subject);
    case "toBeFalsy": {
      const truthy = truthiness(subject);
      return truthy === null ? null : !truthy;
    }
    case "toBeDefined":
      return isDefined(subject);
    case "toBeUndefined": {
      const defined = isDefined(subject);
      return defined === null ? null : !defined;
    }
    case "toBeNull":
      return sameValue(subject, primitive(null), true);
    case "toBeNaN":
      return subject.kind === "primitive"
        ? typeof subject.value === "number" && Number.isNaN(subject.value)
        : null;
    case "toHaveLength": {
      const length = lengthOf(subject);
      const wanted = numberOf(first);
      return length === null || wanted === null ? null : length === wanted;
    }
    case "toBeGreaterThan":
    case "toBeGreaterThanOrEqual":
    case "toBeLessThan":
    case "toBeLessThanOrEqual": {
      const a = numberOf(subject);
      const b = numberOf(first);
      return a === null || b === null ? null : compare(matcher, a, b);
    }
    case "toContain":
    case "toMatch": {
      const text = stringOf(subject);
      const part = stringOf(first);
      return text === null || part === null ? null : text.includes(part);
    }
    default:
      return null;
  }
}

/**
 * Whether the assertion's outcome is fixed whatever the code under test does:
 * constants tested against constants by a built-in matcher, a built-in
 * fixture checked for being there, or a value compared with itself. The
 * result says whether it passes, as far as the guard can tell. `toSatisfy`
 * is judged by a model reading the page, never by its arguments, so it is
 * never constant.
 */
export function constantOutcome(
  parts: AssertionParts,
  scope: AssertionScope,
): Constant | null {
  const { matcher, negated, modifiers, subject, args } = parts;
  if (matcher === "toSatisfy") {
    return null;
  }
  // `.resolves` on a value that is not a promise fails; what it does to one
  // that is, the guard does not model.
  const settle = (value: boolean | null): FixedResult =>
    value === null || modifiers.length > 0
      ? "unknown"
      : value === negated
        ? "fails"
        : "passes";
  const known = args.map((arg) => constantOf(arg, scope));
  if (BUILT_IN_MATCHERS.has(matcher) && known.every(isKnown)) {
    const bare = subject === undefined ? undefined : unwrap(subject);
    if (
      bare !== undefined &&
      ts.isIdentifier(bare) &&
      scope.fixtures.has(bare.text)
    ) {
      const value = holds(matcher, FIXTURE, known);
      if (value !== null) {
        return { outcome: "fixture", result: settle(value) };
      }
    } else {
      // `expect()` tests undefined.
      const value =
        subject === undefined
          ? primitive(undefined)
          : constantOf(subject, scope);
      if (value !== null) {
        return {
          outcome: "literals",
          result: settle(holds(matcher, value, known)),
        };
      }
    }
  }
  const only = args[0];
  // `.resolves` compares what the subject settles to, not the subject.
  if (
    subject === undefined ||
    only === undefined ||
    args.length !== 1 ||
    modifiers.length > 0 ||
    !EQUALITY_MATCHERS.has(matcher)
  ) {
    return null;
  }
  // A call, `await` or `i++` is no access chain: it can differ between two
  // readings, so `expect(next()).toBe(next())` is a real check.
  const text = accessChain(subject)?.text ?? null;
  return text !== null && text === (accessChain(only)?.text ?? null)
    ? { outcome: "self", result: negated ? "fails" : "passes" }
    : null;
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

// ---------------------------------------------------------------------------
// Which values can hide an assertion.
// ---------------------------------------------------------------------------

/**
 * Names in one function whose values are known to come from built-in
 * fixtures, literals or globals. The sets are flat, not scoped: a name
 * declared twice is trusted only if every declaration is, which errs towards
 * "cannot read".
 */
interface Reader extends AssertionScope {
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
  const cached = facts.scopeNames.get(fn);
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
  facts.scopeNames.set(fn, out);
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

function newReader(facts: FileFacts, body: Fn): Reader {
  return {
    facts,
    trusted: new Set(facts.constants),
    distrusted: new Set(enclosingNames(body, facts)),
    data: new Set(),
    declared: new Set(),
    literals: new Map(),
    fixtures: new Set(),
    body,
  };
}

function isInside(node: ts.Node, roots: readonly ts.Node[]): boolean {
  return roots.some((root) => node.pos >= root.pos && node.end <= root.end);
}

/**
 * The same-file functions `name` can mean where the reader is. A function
 * declared inside another test is out of scope, whatever it is called.
 */
function helpersFor(name: string, reader: Reader): Fn[] {
  const { body } = reader;
  if (body === null || reader.distrusted.has(name)) {
    return [];
  }
  return (reader.facts.helpers.get(name) ?? [])
    .filter((helper) => isInside(body, [helper.scope]))
    .map((helper) => helper.fn);
}

/**
 * Whether the value of `name` is one no assertion can hide behind. A
 * same-file function is not such a value: it is safe to call, because the
 * call is read, but under another name (`const run = check`) it is not.
 */
function knows(name: string, reader: Reader): boolean {
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
  return ts.isIdentifier(node) && helpersFor(node.text, reader).length > 0;
}

/** True when `expression` reads from a row of an `.each` table. */
function isRow(expression: ts.Expression, reader: Reader): boolean {
  const root = accessChain(expression)?.root ?? null;
  return root !== null && reader.data.has(root) && knows(root, reader);
}

/** A wait fails the test when it times out, so it is a check in all but name. */
function isWait(name: string): boolean {
  return name.startsWith("waitFor") && name !== "waitForTimeout";
}

/** `test.step`, `test.info`, `test.step.skip`: the runner's own, on `test` or `it`. */
function isTestApi(callee: ts.Expression): boolean {
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

/**
 * `vi.fn()` and the like, with `.mockReturnValue(1)`-style calls after it.
 * Every argument must be a literal: `vi.fn(realAdd)` and `sinon.stub(api,
 * "get")` wrap real code, so calling or asserting on them does run something.
 */
function isMockFactory(expression: ts.Expression, facts: FileFacts): boolean {
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

/** `new Error(…)`, `new Promise(…)`: a global class, named directly. */
function isKnownClass(node: ts.NewExpression, reader: Reader): boolean {
  const target = unwrap(node.expression);
  return ts.isIdentifier(target) && knows(target.text, reader);
}

/** Whether calling `callee` runs only code the guard can read or vouch for. */
function isTrustedCallee(callee: ts.Expression, reader: Reader): boolean {
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
function untrustedArguments(
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
function isTrusted(expression: ts.Expression, reader: Reader): boolean {
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
function defaultsTrusted(name: ts.BindingName, reader: Reader): boolean {
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
function learnParameter(node: ts.ParameterDeclaration, reader: Reader): void {
  const ok =
    node.initializer === undefined || isTrusted(node.initializer, reader);
  learn(node.name, ok, reader);
}

function isConst(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Whether a variable can be trusted. Only a `const` can: a `let` may
 * be given another value later, and following assignments is not worth a
 * wrong `weakening` finding. The variable of a `catch` clause is no `const`.
 */
function isTrustedVariable(
  node: ts.VariableDeclaration,
  reader: Reader,
): boolean {
  const list = node.parent;
  const source =
    node.initializer ??
    (ts.isForOfStatement(list.parent) ? list.parent.expression : undefined);
  return isConst(node) && source !== undefined && isTrusted(source, reader);
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
    single && isConst(node) && initializer !== undefined
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
function learnNames(root: ts.Node, reader: Reader): void {
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (ts.isVariableDeclaration(node)) {
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
function isFrameworkRunner(shape: TestShape, reader: Reader): boolean {
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
function learnParameters(
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

// ---------------------------------------------------------------------------
// One function body.
// ---------------------------------------------------------------------------

interface Scan {
  readonly unseen: string[];
  /** Assertions on constants in same-file functions the body calls. */
  readonly helperConstants: Constant[];
  /** The subject of each assertion in the body itself, for the mock rule. */
  readonly subjects: Set<ts.Node>;
  /** An assertion that can fail, in the body itself or in a function it calls. */
  ownAsserts: boolean;
  helperAsserts: boolean;
  throws: boolean;
  checksByHand: boolean;
  typeLevel: boolean;
  /** The `done`-style first parameter, if the function has one. */
  readonly callback: string | null;
  /** Functions being read or already read: each is read once per test. */
  readonly read: Set<ts.Node>;
  /** The function bodies being read, outermost first. */
  readonly roots: ts.Node[];
}

function note(scan: Scan, name: string): void {
  if (!scan.unseen.includes(name)) {
    scan.unseen.push(name);
  }
}

function calleeName(callee: ts.Expression): string {
  const node = unwrap(callee);
  if (ts.isPropertyAccessExpression(node)) {
    const owner = accessChain(node.expression);
    return `${owner?.plain === true ? (owner.text ?? "") : ""}.${node.name.text}()`;
  }
  return `${brief(node)}()`;
}

/** A call names itself when it is visited; no need to name it twice. */
function isCall(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  );
}

/**
 * A value that code outside the body gets to run or wait for without a call
 * in sight: a template tag, an awaited value (it can reject), and what a
 * function returns (the runner waits for what a test returns).
 */
function usedValue(node: ts.Node): ts.Expression | undefined {
  if (ts.isTaggedTemplateExpression(node)) {
    return node.tag;
  }
  if (ts.isAwaitExpression(node)) {
    return node.expression;
  }
  if (ts.isReturnStatement(node)) {
    return node.expression;
  }
  return ts.isArrowFunction(node) && !ts.isBlock(node.body)
    ? node.body
    : undefined;
}

/** `fail()`, `expect.unreachable()`, `expect.assertions(1)` and the like. */
function isHandCheck(callee: ts.Expression): boolean {
  const node = unwrap(callee);
  if (ts.isIdentifier(node)) {
    return HAND_CHECKS.has(node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    HAND_CHECKS.has(node.name.text) &&
    !isTestApi(node)
  );
}

/** `expect(x)` on its own, with the framework's `expect`: it asserts nothing. */
function isBareExpect(callee: ts.Expression, facts: FileFacts): boolean {
  const node = unwrap(callee);
  return (
    ts.isIdentifier(node) &&
    node.text === "expect" &&
    fromFramework("expect", facts)
  );
}

/**
 * True when `node` only names something and reads no variable: the `x` of
 * `a.x`, a key of an object literal, the name a declaration binds, a label,
 * or a JSX tag (making an element runs nothing of the component).
 */
function isNameOnly(node: ts.Identifier): boolean {
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

/** True when `node` is what a call calls, or an argument a call may call back. */
function isHandedOver(node: ts.Identifier): boolean {
  let top: ts.Node = node;
  while (
    ts.isParenthesizedExpression(top.parent) ||
    ts.isAsExpression(top.parent) ||
    ts.isNonNullExpression(top.parent) ||
    ts.isSatisfiesExpression(top.parent)
  ) {
    top = top.parent;
  }
  const parent = top.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    (parent.expression === top ||
      parent.arguments?.some((arg) => arg === top) === true)
  );
}

/** A declaration or expression that exists for the type checker alone. */
function isTypeLevel(node: ts.Node): boolean {
  return (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/**
 * Second pass over a function: record every throw, every assertion in a
 * same-file function it calls, and every use of code the guard cannot read.
 *
 * `covered` is true inside something already recorded as unreadable, where
 * naming each identifier again would only lengthen the message.
 */
function readBody(fn: Fn, reader: Reader, scan: Scan): void {
  const { facts } = reader;

  const readHelper = (helper: Fn): void => {
    // A function inside a body being read is read with that body, where the
    // names it closes over are known.
    if (scan.read.has(helper) || isInside(helper, scan.roots) || !helper.body) {
      return;
    }
    scan.read.add(helper);
    const inner = newReader(facts, helper);
    for (const parameter of helper.parameters) {
      learnParameter(parameter, inner);
    }
    learnNames(helper.body, inner);
    readBody(helper, inner, scan);
  };

  /** Trusted code can still call back a function it is handed. */
  const visitArguments = (
    args: readonly ts.Expression[],
    covered: boolean,
  ): void => {
    const untrusted = untrustedArguments(args, reader);
    for (const arg of args) {
      if (untrusted.includes(arg)) {
        note(scan, brief(arg));
      }
      visit(arg, covered || untrusted.includes(arg));
    }
  };

  const visitAssertion = (parts: AssertionParts, covered: boolean): void => {
    const own = scan.roots.length === 1;
    const constant = constantOutcome(parts, reader);
    if (own && parts.subject !== undefined) {
      scan.subjects.add(parts.subject);
    }
    if (constant !== null) {
      // Nothing in a constant runs code: `expect(o.n).toBe(o.n)` is read as
      // the same value twice, getters aside.
      if (!own) {
        scan.helperConstants.push(constant);
      }
      return;
    }
    if (own) {
      scan.ownAsserts = true;
    } else {
      scan.helperAsserts = true;
    }
    for (const node of [parts.subject, ...parts.args]) {
      if (node !== undefined) {
        visit(node, covered);
      }
    }
  };

  const visitCall = (call: ts.CallExpression, covered: boolean): void => {
    const parts = facts.readAssertion(call);
    if (parts !== null) {
      visitAssertion(parts, covered);
      return;
    }
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && TYPE_CHECKS.has(callee.text)) {
      scan.typeLevel = true;
    }
    if (isHandCheck(callee)) {
      scan.checksByHand = true;
    }
    // Calls the guard vouches for by name, whatever the name's owner is.
    const vouched =
      isHandCheck(callee) ||
      isTestApi(callee) ||
      isBareExpect(callee, facts) ||
      isMockFactory(call, facts);
    const readable =
      vouched || (isTrustedCallee(callee, reader) && !isRow(callee, reader));
    if (!vouched) {
      visit(call.expression, covered || !readable);
    }
    if (readable) {
      visitArguments(call.arguments, covered);
      return;
    }
    note(scan, calleeName(callee));
    for (const arg of call.arguments) {
      visit(arg, true);
    }
  };

  const visitNew = (node: ts.NewExpression, covered: boolean): void => {
    if (isKnownClass(node, reader)) {
      visitArguments(node.arguments ?? [], covered);
      return;
    }
    note(scan, `new ${brief(node.expression)}()`);
    ts.forEachChild(node, (child) => {
      visit(child, true);
    });
  };

  const visitName = (node: ts.Identifier, covered: boolean): void => {
    if (isNameOnly(node)) {
      return;
    }
    const name = node.text;
    if (scan.roots.length === 1 && name === scan.callback) {
      scan.checksByHand = true;
    }
    const helpers = helpersFor(name, reader);
    if (helpers.length > 0) {
      // Called, or handed to code that may call it: `items.forEach(check)`.
      // Only named (`void check`), a function runs nothing; under another
      // name it is no longer trusted, so its use is recorded there.
      if (isHandedOver(node)) {
        helpers.forEach(readHelper);
      }
      return;
    }
    // Reading a value from elsewhere can run code: a getter, an iterator.
    if (!covered && !knows(name, reader)) {
      note(scan, name);
    }
  };

  const visit = (node: ts.Node, covered: boolean): void => {
    // Types run nothing.
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isIdentifier(node)) {
      visitName(node, covered);
      return;
    }
    if (ts.isCallExpression(node)) {
      visitCall(node, covered);
      return;
    }
    if (ts.isNewExpression(node)) {
      visitNew(node, covered);
      return;
    }
    if (ts.isThrowStatement(node)) {
      scan.throws = true;
    }
    if (isTypeLevel(node)) {
      scan.typeLevel = true;
    }
    const used = usedValue(node);
    const hidden =
      used !== undefined &&
      !isCall(used) &&
      (!isTrusted(used, reader) || isRow(used, reader));
    if (hidden) {
      note(scan, brief(used));
    }
    ts.forEachChild(node, (child) => {
      visit(child, covered || hidden);
    });
  };

  scan.roots.push(fn);
  visit(fn, false);
  scan.roots.pop();
}

/** Read one test or hook function: its names, then its body. */
function readFunction(
  fn: Fn,
  shape: TestShape,
  facts: FileFacts,
): { readonly reader: Reader; readonly scan: Scan } {
  const reader = newReader(facts, fn);
  const callback = learnParameters(fn, shape, reader);
  learnNames(fn.body ?? fn, reader);
  const scan: Scan = {
    unseen: [],
    helperConstants: [],
    subjects: new Set(),
    ownAsserts: false,
    helperAsserts: false,
    throws: false,
    checksByHand: false,
    typeLevel: false,
    callback,
    read: new Set(),
    roots: [],
  };
  readBody(fn, reader, scan);
  return { reader, scan };
}

// ---------------------------------------------------------------------------
// Mocks the test made and only called itself.
// ---------------------------------------------------------------------------

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

function usesOf(name: ts.Identifier, fn: Fn): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name.text &&
      node !== name &&
      !isNameOnly(node)
    ) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return out;
}

/** Best effort: only a `const` declared directly in the test body counts. */
function ownMocks(
  fn: Fn,
  facts: FileFacts,
  subjects: ReadonlySet<ts.Node>,
): string[] {
  if (fn.body === undefined || !ts.isBlock(fn.body)) {
    return [];
  }
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
        isMockFactory(initializer, facts) &&
        usesOf(name, fn).every((use) => staysInTest(use, fn, subjects))
      ) {
        out.push(name.text);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The file and the test, as the parser calls them.
// ---------------------------------------------------------------------------

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

/** Every function in the file that has a name, wherever it is defined. */
function namedFunctions(sourceFile: ts.SourceFile): Map<string, Helper[]> {
  const out = new Map<string, Helper[]>();
  const add = (
    declaration: ts.Node,
    name: ts.Node | undefined,
    fn: Fn | null,
  ) => {
    if (name !== undefined && ts.isIdentifier(name) && fn !== null) {
      const scope =
        ts.findAncestor(declaration.parent, ts.isFunctionLike) ?? sourceFile;
      out.set(name.text, [...(out.get(name.text) ?? []), { fn, scope }]);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      add(node, node.name, node);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      add(node, node.name, asFn(unwrap(node.initializer)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * Whether a hook may check something for the tests it runs around. One that
 * only drives built-in fixtures, or only asserts on constants, does not. A
 * fixture definition (`test.extend`) always may: its functions run around
 * tests in ways the guard does not follow. `expect.extend` defines matchers,
 * not fixtures.
 */
function hookMayCheck(call: ts.CallExpression, facts: FileFacts): boolean {
  const callee = unwrap(call.expression);
  const chain = accessChain(callee);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "extend") {
    return chain?.text !== "expect.extend";
  }
  const shape = { root: chain?.root ?? "", rows: false };
  return call.arguments.some((arg) => {
    if (literalText(arg) !== null) {
      return false;
    }
    const fn = asFn(unwrap(arg));
    if (fn === null) {
      return true;
    }
    const { scan } = readFunction(fn, shape, facts);
    return (
      scan.ownAsserts ||
      scan.helperAsserts ||
      scan.throws ||
      scan.checksByHand ||
      scan.unseen.length > 0
    );
  });
}

function isHookCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  return ts.isIdentifier(name) && HOOKS.has(name.text);
}

/** Every hook and fixture definition in the file, with the block it covers. */
function readHooks(sourceFile: ts.SourceFile, facts: FileFacts): Hook[] {
  const out: Hook[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isHookCall(node)) {
      out.push({
        scope: ts.findAncestor(node.parent, ts.isFunctionLike) ?? sourceFile,
        mayCheck: hookMayCheck(node, facts),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Read what the rules need from the whole file: its names, helpers and hooks. */
export function readFileFacts(
  sourceFile: ts.SourceFile,
  readAssertion: (call: ts.CallExpression) => AssertionParts | null,
): FileFacts {
  const constants = new Set<string>();
  const hooks: Hook[] = [];
  const names = sourceFile.statements.flatMap(moduleLevelNames);
  const facts: FileFacts = {
    readAssertion,
    helpers: namedFunctions(sourceFile),
    moduleNames: new Set(names.map(([name]) => name)),
    imports: new Map(
      names.flatMap(([name, source]) =>
        source === null ? [] : [[name, source] as const],
      ),
    ),
    constants,
    hooks,
    scopeNames: new WeakMap(),
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

/** What reading a test function gives: the evidence, and its names for the parser. */
export interface BodyReading {
  readonly evidence: BodyEvidence;
  readonly scope: AssertionScope;
}

/** Read one test function, or null when `expression` is not a function. */
export function readTestBody(
  expression: ts.Expression,
  shape: TestShape,
  facts: FileFacts,
): BodyReading | null {
  const fn = asFn(unwrap(expression));
  if (fn === null) {
    return null;
  }
  const { reader, scan } = readFunction(fn, shape, facts);
  return {
    scope: reader,
    evidence: {
      helperAsserts: scan.helperAsserts,
      helperConstants: scan.helperConstants,
      unseen: scan.unseen,
      throws: scan.throws,
      checksByHand: scan.checksByHand,
      hookChecks: facts.hooks.some(
        (hook) => hook.mayCheck && isInside(fn, [hook.scope]),
      ),
      customRunner: !isFrameworkRunner(shape, reader),
      typeLevel: scan.typeLevel,
      ownMocks: ownMocks(fn, facts, scan.subjects),
    },
  };
}

// ---------------------------------------------------------------------------
// Whether a body changed in more than its formatting.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The verdict on one test.
// ---------------------------------------------------------------------------

/** The parts of a parsed test the verdict reads. */
export interface WeakCandidate {
  readonly titlePath: readonly string[];
  readonly dynamic: boolean;
  readonly line: number;
  readonly cases: string | null;
  readonly markers: { readonly fail: number };
  readonly assertions: readonly {
    readonly constant: ConstantOutcome | null;
    readonly result: FixedResult | null;
    readonly subjectRoot: string | null;
    readonly line: number;
  }[];
  readonly evidence: BodyEvidence | null;
}

/** "a", "a or b", "a, b or c". */
function either(parts: readonly string[]): string {
  const last = parts[parts.length - 1] ?? "";
  return parts.length < 2
    ? last
    : `${parts.slice(0, -1).join(", ")} or ${last}`;
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length - MAX_NAMES;
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

/**
 * Where a check may be that the guard cannot show to be empty. Every verdict
 * reads this one list: any entry turns a `weakening` finding into
 * `assertion-not-visible`. `marker` adds the test's own assertions on
 * constants, when one of them fails or may fail: reaching it fails the test,
 * as a `throw` would.
 */
function otherChecks(evidence: BodyEvidence, marker: boolean): string[] {
  return [
    ...(evidence.unseen.length > 0
      ? [`code the guard cannot read (${nameList(evidence.unseen)})`]
      : []),
    ...(evidence.throws ? ["its throw statement"] : []),
    ...(evidence.checksByHand
      ? ["a check made by hand (fail(), an assertion count or a done callback)"]
      : []),
    ...(evidence.hookChecks ? ["a hook or fixture in this file"] : []),
    ...(evidence.customRunner
      ? ["a fixture of this file's own test function"]
      : []),
    ...(marker
      ? [
          "an assertion on constants that fails, or may fail, when it is reached",
        ]
      : []),
  ];
}

const SUMMARIES: Readonly<
  Record<ConstantOutcome, readonly [one: string, many: string]>
> = {
  literals: ["tests a literal", "test a literal"],
  self: ["compares a value with itself", "compare a value with itself"],
  fixture: [
    "checks that a built-in fixture exists",
    "check that a built-in fixture exists",
  ],
};

/** "its only assertion tests a literal", "all 3 assertions test a literal". */
function constantSummary(outcomes: readonly ConstantOutcome[]): string {
  const one = outcomes.length === 1;
  const what = either(
    (["literals", "self", "fixture"] as const)
      .filter((outcome) => outcomes.includes(outcome))
      .map((outcome) => SUMMARIES[outcome][one ? 0 : 1]),
  );
  return one
    ? `its only assertion ${what}`
    : `all ${String(outcomes.length)} assertions ${what}`;
}

/**
 * The one finding for a test that checks nothing, or null.
 *
 * A single assertion that can fail on its own clears the test, in the body
 * or in a same-file function it calls. Otherwise the verdict is
 * `test-without-assertion` with no assertion at all, `assertion-cannot-fail`
 * when every assertion is on constants, and `only-checks-mocks` as soon as
 * one is weak only because it is on the test's own mock: that rule is a best
 * guess, and a `weakening` finding must not rest on a guess. Whichever it
 * is, any place a real check may hide (see `otherChecks`) makes it
 * `assertion-not-visible`.
 *
 * Not judged at all: a test that checks types, and one marked as expected to
 * fail. A parameterised test, or one with a computed title, is judged only
 * for having no assertion: with one, the rows or the title can make a
 * constant-looking assertion real.
 */
export function weakTestFinding(
  file: string,
  test: WeakCandidate,
): Finding | null {
  const { evidence, assertions } = test;
  if (
    evidence === null ||
    evidence.typeLevel ||
    evidence.helperAsserts ||
    test.markers.fail > 0
  ) {
    return null;
  }
  const label = titleText(test.titlePath);
  const first = assertions[0];
  const at = { file, test: test.titlePath, line: first?.line ?? test.line };
  const review = (message: string): Finding =>
    finding({ ...at, kind: "assertion-not-visible", message });

  if (first === undefined && evidence.helperConstants.length === 0) {
    const where = otherChecks(evidence, false);
    return where.length > 0
      ? review(
          `${label} has no expect of its own: the assertion may be in ${either(where)}`,
        )
      : finding({
          ...at,
          kind: "test-without-assertion",
          message: `${label} has no assertion (no expect, no toSatisfy), so it fails only if a step throws`,
        });
  }
  const isOwnMock = (root: string | null): boolean =>
    root !== null && evidence.ownMocks.includes(root);
  if (
    test.dynamic ||
    test.cases !== null ||
    !assertions.every((a) => a.constant !== null || isOwnMock(a.subjectRoot))
  ) {
    return null;
  }
  const constants: Constant[] = [
    ...assertions.flatMap((a) =>
      a.constant === null
        ? []
        : [{ outcome: a.constant, result: a.result ?? "unknown" }],
    ),
    ...evidence.helperConstants,
  ];
  const where = otherChecks(
    evidence,
    constants.some((constant) => constant.result !== "passes"),
  );
  const elsewhere = `but the real check may be in ${either(where)}`;
  const asserted = assertions.flatMap((a) =>
    a.constant === null && a.subjectRoot !== null ? [a.subjectRoot] : [],
  );
  if (asserted.length === 0) {
    const summary = `${label}: ${constantSummary(constants.map((c) => c.outcome))}`;
    const whose = constants.length === 1 ? "its" : "their";
    return where.length > 0
      ? review(`${summary}, ${elsewhere}`)
      : finding({
          ...at,
          kind: "assertion-cannot-fail",
          message: `${summary}, so ${whose} outcome does not depend on the code under test`,
        });
  }
  const mocks = evidence.ownMocks.filter((name) => asserted.includes(name));
  const mock = `a mock the test made and only called itself (${nameList(mocks)})`;
  const on =
    constants.length === 0
      ? mock
      : `a literal, a value compared with itself, or ${mock}`;
  const every = `${label}: every assertion is on ${on}`;
  return where.length > 0
    ? review(`${every}, ${elsewhere}`)
    : finding({
        ...at,
        kind: "only-checks-mocks",
        message: `${every}, so nothing the code under test did is checked`,
      });
}
