import ts from "typescript";
import {
  isFunctionLike,
  lineOf,
  literalText,
  normaliseCode,
  parseSource,
  stringValue,
  unwrap,
} from "./source.js";
import {
  NO_SCOPE,
  constantOutcome,
  formatFingerprint,
  readFileFacts,
  readTestBody,
  subjectRoot,
  type AssertionParts,
  type AssertionScope,
  type BodyEvidence,
  type BodyReading,
  type ConstantOutcome,
  type FileFacts,
  type FixedResult,
} from "./weak-tests.js";

/**
 * Turns the text of a test file into a model of its tests and assertions.
 * The model is what the diff compares, so it keeps only what a weakening
 * changes (titles, markers, matchers, literal arguments) and drops what a
 * harmless edit changes (formatting, comments, variable names).
 */

/** How many skip, only and expected-failure markers apply to a test. */
export interface Markers {
  readonly skip: number;
  readonly only: number;
  readonly fail: number;
}

export interface ParsedAssertion {
  /** The final matcher name, for example `toHaveText`. */
  readonly matcher: string;
  readonly soft: boolean;
  /** True when the chain has an odd number of `.not`. */
  readonly negated: boolean;
  /** `poll`, `resolves` and `rejects`, in chain order. */
  readonly modifiers: readonly string[];
  /** Canonical literal text of the value under test, or null when it is not a literal. */
  readonly subject: string | null;
  /** Canonical literal text of each matcher argument, or null for a non-literal. */
  readonly args: readonly (string | null)[];
  /** The statement of a `toSatisfy` call. */
  readonly statement?: string;
  /**
   * Set when the outcome is fixed whatever the code under test does. Read by
   * the weak-test rules only: comparing two versions never looks at it.
   */
  readonly constant: ConstantOutcome | null;
  /** Whether a constant assertion passes, as far as the guard can tell; null when it is not constant. */
  readonly result: FixedResult | null;
  /** The variable the value under test is read from, for the mock rule. */
  readonly subjectRoot: string | null;
  /**
   * Set when the assertion is in a function the test defines and never
   * calls, so it never runs. Read by the weak-test rules only.
   */
  readonly unreached?: true;
  /**
   * Set when the assertion only reports while `toSatisfy` does not block:
   * `@jevyjs/playwright`'s `toSatisfy`, or a `toPass` block whose only check
   * is one. Read by the weak-test rules only.
   */
  readonly advisory?: true;
  readonly line: number;
}

export interface ParsedTest {
  /** Describe titles, then the test's own title. */
  readonly titlePath: readonly string[];
  /** True when any title on the path is not a string literal. */
  readonly dynamic: boolean;
  readonly line: number;
  /** Normalised source of the test function, or null for `it.todo`. */
  readonly body: string | null;
  /**
   * The body with what a formatter decides taken out, or null for `it.todo`.
   * Read by the weak-test rules only, to tell a changed test from a
   * reformatted one: every other comparison uses `body`.
   */
  readonly fingerprint: string | null;
  /** Normalised `.each` tables of the test and its describes, or null. */
  readonly cases: string | null;
  /** Markers of the test plus those of every enclosing describe and the file. */
  readonly markers: Markers;
  readonly assertions: readonly ParsedAssertion[];
  /**
   * What the body shows beyond its own assertions, or null for `it.todo`.
   * Read by the weak-test rules only: it holds names from the source, so a
   * renamed variable changes it, and comparing two versions must not use it.
   */
  readonly evidence: BodyEvidence | null;
}

export interface ParsedTestFile {
  readonly tests: readonly ParsedTest[];
  /** Assertions outside any test: hooks and helper functions in the file. */
  readonly looseAssertions: readonly ParsedAssertion[];
}

export type TestFileParse =
  | { readonly ok: true; readonly value: ParsedTestFile }
  | { readonly ok: false; readonly error: string };

type MarkerName = keyof Markers;

interface MutableMarkers {
  skip: number;
  only: number;
  fail: number;
}

interface Scope {
  readonly parent: Scope | null;
  readonly titlePath: readonly string[];
  readonly dynamic: boolean;
  readonly cases: string | null;
  readonly markers: MutableMarkers;
}

interface TestBuilder {
  readonly scope: Scope;
  readonly titlePath: readonly string[];
  readonly dynamic: boolean;
  readonly line: number;
  readonly body: string | null;
  readonly fingerprint: string | null;
  readonly cases: string | null;
  readonly markers: MutableMarkers;
  readonly assertions: ParsedAssertion[];
  readonly evidence: BodyEvidence | null;
  /** The names of the test function that an assertion on constants can use. */
  readonly names: AssertionScope;
  /** The weak-test reading of the test function, or null for `it.todo`. */
  readonly reading: BodyReading | null;
}

interface Context {
  readonly scope: Scope;
  readonly test: TestBuilder | null;
}

type CallInfo =
  | {
      readonly type: "describe";
      readonly title: ts.Expression | undefined;
      readonly fn: ts.Expression;
      readonly markers: readonly MarkerName[];
      readonly cases: string | null;
    }
  | {
      readonly type: "test";
      /** The name the chain starts with: `test`, `it`, `xit`. */
      readonly root: string;
      readonly title: ts.Expression;
      readonly fn: ts.Expression | undefined;
      readonly markers: readonly MarkerName[];
      readonly cases: string | null;
    }
  | { readonly type: "annotation"; readonly marker: MarkerName };

interface Chain {
  readonly root: string;
  readonly members: readonly string[];
  readonly cases: string | null;
}

/** Roots that define a test, with the marker the root itself implies. */
const TEST_ROOTS: ReadonlyMap<string, MarkerName | null> = new Map([
  ["test", null],
  ["it", null],
  ["xit", "skip"],
  ["xtest", "skip"],
  ["fit", "only"],
]);

const DESCRIBE_ROOTS: ReadonlyMap<string, MarkerName | null> = new Map([
  ["describe", null],
  ["xdescribe", "skip"],
  ["fdescribe", "only"],
]);

/**
 * Members allowed between the root and the call. Any other member (`step`,
 * `beforeEach`, `use`, `extend`, `describe.configure`) means the call does
 * not define a test. `skipIf` and `runIf` count as skips: both can stop the
 * test running.
 */
const MODIFIERS: ReadonlyMap<string, MarkerName | null> = new Map([
  ["skip", "skip"],
  ["fixme", "skip"],
  ["todo", "skip"],
  ["skipIf", "skip"],
  ["runIf", "skip"],
  ["only", "only"],
  ["fail", "fail"],
  ["fails", "fail"],
  ["each", null],
  ["concurrent", null],
  ["sequential", null],
  ["serial", null],
  ["parallel", null],
]);

/** Members that, called with no test function, annotate the enclosing test or block. */
const ANNOTATIONS: ReadonlyMap<string, MarkerName> = new Map([
  ["skip", "skip"],
  ["fixme", "skip"],
  ["fail", "fail"],
]);

const CHAIN_WORDS = new Set(["not", "resolves", "rejects"]);

function tableText(
  args: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
): string {
  return args
    .map((arg) => literalText(arg) ?? normaliseCode(arg, sourceFile))
    .join(", ");
}

/** Read `test.describe.skip`, `it.each(table)`, `test.each\`...\`` and so on. */
function readChain(
  callee: ts.Expression,
  sourceFile: ts.SourceFile,
): Chain | null {
  const members: string[] = [];
  let cases: string | null = null;
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(node)) {
      return { root: node.text, members: members.reverse(), cases };
    }
    if (ts.isPropertyAccessExpression(node)) {
      members.push(node.name.text);
      node = node.expression;
    } else if (ts.isCallExpression(node)) {
      const inner = node.expression;
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === "each") {
        cases = tableText(node.arguments, sourceFile);
      }
      node = inner;
    } else if (ts.isTaggedTemplateExpression(node)) {
      cases = normaliseCode(node.template, sourceFile);
      node = node.tag;
    } else {
      return null;
    }
  }
}

function markersOf(
  rootMarker: MarkerName | null,
  members: readonly string[],
): MarkerName[] | null {
  const markers: MarkerName[] = rootMarker === null ? [] : [rootMarker];
  for (const member of members) {
    if (!MODIFIERS.has(member)) {
      return null;
    }
    const marker = MODIFIERS.get(member);
    if (marker !== undefined && marker !== null) {
      markers.push(marker);
    }
  }
  return markers;
}

function classifyDescribe(
  call: ts.CallExpression,
  rootMarker: MarkerName | null,
  members: readonly string[],
  cases: string | null,
): CallInfo | null {
  const markers = markersOf(rootMarker, members);
  const fnIndex = call.arguments.findIndex((arg) => isFunctionLike(arg));
  const fn = call.arguments[fnIndex];
  if (markers === null || fn === undefined) {
    return null;
  }
  const title = fnIndex === 0 ? undefined : call.arguments[0];
  return { type: "describe", title, fn, markers, cases };
}

function classifyTest(
  call: ts.CallExpression,
  chain: Chain,
  rootMarker: MarkerName | null,
): CallInfo | null {
  const args = call.arguments;
  const rest = args.slice(1);
  const hasFn = rest.some((arg) => isFunctionLike(arg));
  const only = chain.members.length === 1 ? chain.members[0] : undefined;
  const annotation = only === undefined ? undefined : ANNOTATIONS.get(only);
  if (
    rootMarker === null &&
    annotation !== undefined &&
    !hasFn &&
    call.expression.kind === ts.SyntaxKind.PropertyAccessExpression
  ) {
    // Playwright's `test.skip()`, `test.skip(condition, reason)` and
    // `test.fail()` inside a test or describe body.
    return { type: "annotation", marker: annotation };
  }
  if (
    rootMarker === null &&
    chain.members.length === 2 &&
    chain.members[0] === "step" &&
    chain.members[1] === "skip"
  ) {
    // Playwright's `test.step.skip(title, body)`: the step's assertions stay
    // in the source but never run, so it counts as a skip on the test.
    return { type: "annotation", marker: "skip" };
  }
  const markers = markersOf(rootMarker, chain.members);
  const title = args[0];
  if (markers === null || title === undefined || isFunctionLike(title)) {
    return null;
  }
  const fn = [...rest].reverse().find((arg) => isFunctionLike(arg));
  if (fn === undefined && !chain.members.includes("todo")) {
    return null;
  }
  return {
    type: "test",
    root: chain.root,
    title,
    fn,
    markers,
    cases: chain.cases,
  };
}

function classify(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): CallInfo | null {
  const chain = readChain(call.expression, sourceFile);
  if (chain === null) {
    return null;
  }
  const describeMarker = DESCRIBE_ROOTS.get(chain.root);
  if (describeMarker !== undefined) {
    return classifyDescribe(call, describeMarker, chain.members, chain.cases);
  }
  const testMarker = TEST_ROOTS.get(chain.root);
  if (testMarker === undefined) {
    return null;
  }
  if (chain.members[0] === "describe") {
    return classifyDescribe(
      call,
      testMarker,
      chain.members.slice(1),
      chain.cases,
    );
  }
  return classifyTest(call, chain, testMarker);
}

/** The parts of an assertion as they stand in the source, before any is judged. */
interface AssertionChain extends AssertionParts {
  readonly soft: boolean;
}

/** Read `expect(x)[.not|.resolves|.rejects]*.matcher(args)` and its soft and poll forms. */
function readChainParts(call: ts.CallExpression): AssertionChain | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const matcher = callee.name.text;
  if (CHAIN_WORDS.has(matcher)) {
    return null;
  }
  const modifiers: string[] = [];
  let negated = false;
  let node: ts.Expression = callee.expression;
  while (
    ts.isPropertyAccessExpression(node) &&
    CHAIN_WORDS.has(node.name.text)
  ) {
    if (node.name.text === "not") {
      negated = !negated;
    } else {
      modifiers.unshift(node.name.text);
    }
    node = node.expression;
  }
  if (!ts.isCallExpression(node)) {
    return null;
  }
  const root = node.expression;
  let soft = false;
  if (ts.isIdentifier(root) && root.text === "expect") {
    // Plain expect.
  } else if (
    ts.isPropertyAccessExpression(root) &&
    ts.isIdentifier(root.expression) &&
    root.expression.text === "expect" &&
    (root.name.text === "soft" || root.name.text === "poll")
  ) {
    soft = root.name.text === "soft";
    if (root.name.text === "poll") {
      modifiers.unshift("poll");
    }
  } else {
    return null;
  }
  return {
    matcher,
    soft,
    negated,
    modifiers,
    subject: node.arguments[0],
    args: call.arguments,
  };
}

/** True when `node` sits in one of `functions`. */
function isWithin(node: ts.Node, functions: readonly ts.Node[]): boolean {
  return functions.some((fn) => node.pos >= fn.pos && node.end <= fn.end);
}

/**
 * Read one assertion into the model. `names` are those of the test function
 * it stands in, which decide whether `expect(a).toBe(5)` is on constants;
 * `reading` is that function's weak-test reading, which knows what its
 * callers hand a function the test defines, and which of those never run.
 */
function readAssertion(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  names: AssertionScope,
  reading: BodyReading | null = null,
): ParsedAssertion | null {
  const parts = readChainParts(call);
  if (parts === null) {
    return null;
  }
  const { matcher, soft, negated, modifiers, subject: subjectNode } = parts;
  const first = call.arguments[0];
  const constant =
    reading?.overrides.get(call) ?? constantOutcome(parts, names);
  const unreached =
    reading !== null && isWithin(call, reading.unread)
      ? { unreached: true as const }
      : {};
  const advisory =
    reading?.advisory.has(call) === true ? { advisory: true as const } : {};
  const base = {
    matcher,
    soft,
    negated,
    modifiers,
    subject: subjectNode === undefined ? null : literalText(subjectNode),
    args: call.arguments.map((arg) => literalText(arg)),
    constant: constant?.outcome ?? null,
    result: constant?.result ?? null,
    subjectRoot: subjectRoot(subjectNode),
    ...unreached,
    ...advisory,
    line: lineOf(call, sourceFile),
  };
  if (matcher === "toSatisfy" && first !== undefined) {
    return {
      ...base,
      statement: stringValue(first) ?? unwrap(first).getText(sourceFile),
    };
  }
  return base;
}

function titleOf(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): { readonly text: string; readonly dynamic: boolean } {
  const text = stringValue(expression);
  return text === null
    ? { text: unwrap(expression).getText(sourceFile), dynamic: true }
    : { text, dynamic: false };
}

function addMarkers(
  target: MutableMarkers,
  markers: readonly MarkerName[],
): void {
  for (const marker of markers) {
    target[marker] += 1;
  }
}

function joinCases(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? null : present.join(" | ");
}

function scopeCases(scope: Scope | null): (string | null)[] {
  return scope === null ? [] : [...scopeCases(scope.parent), scope.cases];
}

function effectiveMarkers(test: TestBuilder): Markers {
  const total = { ...test.markers };
  for (
    let scope: Scope | null = test.scope;
    scope !== null;
    scope = scope.parent
  ) {
    total.skip += scope.markers.skip;
    total.only += scope.markers.only;
    total.fail += scope.markers.fail;
  }
  return total;
}

function emptyMarkers(): MutableMarkers {
  return { skip: 0, only: 0, fail: 0 };
}

function walk(
  root: ts.SourceFile,
  sourceFile: ts.SourceFile,
  facts: FileFacts,
): { tests: TestBuilder[]; loose: ParsedAssertion[] } {
  const tests: TestBuilder[] = [];
  const loose: ParsedAssertion[] = [];
  const fileScope: Scope = {
    parent: null,
    titlePath: [],
    dynamic: false,
    cases: null,
    markers: emptyMarkers(),
  };

  const visit = (node: ts.Node, context: Context): void => {
    if (ts.isCallExpression(node)) {
      const info = classify(node, sourceFile);
      if (info?.type === "describe") {
        const title =
          info.title === undefined ? null : titleOf(info.title, sourceFile);
        const markers = emptyMarkers();
        addMarkers(markers, info.markers);
        const scope: Scope = {
          parent: context.scope,
          titlePath:
            title === null
              ? context.scope.titlePath
              : [...context.scope.titlePath, title.text],
          dynamic: context.scope.dynamic || title?.dynamic === true,
          cases: info.cases,
          markers,
        };
        visit(info.fn, { scope, test: null });
        return;
      }
      if (info?.type === "test") {
        const title = titleOf(info.title, sourceFile);
        const markers = emptyMarkers();
        addMarkers(markers, info.markers);
        const shape = { root: info.root, rows: info.cases !== null };
        const reading =
          info.fn === undefined ? null : readTestBody(info.fn, shape, facts);
        const test: TestBuilder = {
          scope: context.scope,
          titlePath: [...context.scope.titlePath, title.text],
          dynamic: context.scope.dynamic || title.dynamic,
          line: lineOf(node, sourceFile),
          body:
            info.fn === undefined ? null : normaliseCode(info.fn, sourceFile),
          fingerprint:
            info.fn === undefined
              ? null
              : formatFingerprint(info.fn, sourceFile),
          cases: joinCases([...scopeCases(context.scope), info.cases]),
          markers,
          assertions: [],
          evidence: reading?.evidence ?? null,
          names: reading?.scope ?? NO_SCOPE,
          reading,
        };
        tests.push(test);
        if (info.fn !== undefined) {
          visit(info.fn, { scope: context.scope, test });
        }
        return;
      }
      if (info?.type === "annotation") {
        const target = context.test?.markers ?? context.scope.markers;
        target[info.marker] += 1;
      }
      const assertion = readAssertion(
        node,
        sourceFile,
        context.test?.names ?? NO_SCOPE,
        context.test?.reading ?? null,
      );
      if (assertion !== null) {
        (context.test?.assertions ?? loose).push(assertion);
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, context);
    });
  };

  visit(root, { scope: fileScope, test: null });
  return { tests, loose };
}

/** Parse a test file. A file with a syntax error is reported, not guessed at. */
export function parseTestFile(text: string, path: string): TestFileParse {
  const parsed = parseSource(text, path);
  if (!parsed.ok) {
    return parsed;
  }
  const { sourceFile } = parsed;
  const facts = readFileFacts(sourceFile, readChainParts, path);
  const { tests, loose } = walk(sourceFile, sourceFile, facts);
  return {
    ok: true,
    value: {
      tests: tests.map((test) => ({
        titlePath: test.titlePath,
        dynamic: test.dynamic,
        line: test.line,
        body: test.body,
        fingerprint: test.fingerprint,
        cases: test.cases,
        markers: effectiveMarkers(test),
        assertions: test.assertions,
        evidence: test.evidence,
      })),
      looseAssertions: loose,
    },
  };
}
