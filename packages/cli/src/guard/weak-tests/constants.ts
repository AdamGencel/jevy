import ts from "typescript";
import { literalText, unwrap } from "../source.js";
import type {
  AssertionParts,
  AssertionScope,
  Constant,
  FixedResult,
  Known,
  Primitive,
} from "./model.js";
import { accessChain } from "./syntax.js";

/**
 * Constants: values the source fixes, and what a matcher makes of them. Owns
 * the judgement that an assertion's outcome is fixed before the code under
 * test runs (literals, a value compared with itself, a built-in fixture
 * checked for being there) and whether it then passes.
 */

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
export function constantOf(
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
  // A matcher the file defines is the code under test, whatever its name.
  if (matcher === "toSatisfy" || scope.customMatchers.has(matcher)) {
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
