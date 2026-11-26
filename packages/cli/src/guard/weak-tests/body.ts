import ts from "typescript";
import { unwrap } from "../source.js";
import { constantOf, constantOutcome } from "./constants.js";
import {
  NO_SCOPE,
  fromFramework,
  isQuietImport,
  type AssertionParts,
  type AssertionScope,
  type BodyEvidence,
  type Constant,
  type FileFacts,
  type Fn,
  type FixedResult,
  type Helper,
  type HelperClosure,
  type HelperReading,
  type HelperStep,
  type Known,
  type TestShape,
} from "./model.js";
import { isMockFactory, ownMocks } from "./mocks.js";
import {
  accessChain,
  asFn,
  bindingNames,
  brief,
  isInside,
  isNameOnly,
} from "./syntax.js";
import {
  helpersFor,
  isFrameworkRunner,
  isKnownClass,
  isRow,
  isTestApi,
  isTrusted,
  isTrustedCallee,
  knows,
  learnNames,
  learnParameter,
  learnParameters,
  newReader,
  untrustedArguments,
  type Reader,
} from "./trust.js";

/**
 * One function body: the second pass over a test, hook or helper, after its
 * names are learnt. Owns what the body shows beyond its own `expect` chains:
 * throws, hand-made checks, assertions in same-file functions it calls, and
 * every use of code the guard cannot read.
 *
 * A helper is read once per file, on its own, and what it reaches is
 * followed once per file too (`FileMemo`): reading it again for each test
 * made a file with many helpers take minutes.
 */

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

/** The directive that fails type checking when the line below it has no error. */
const TYPE_DIRECTIVE = "@ts-expect-error";

/** The framework objects whose helpers a hook may call without checking anything. */
const FRAMEWORK_MOCKS = new Set(["vi", "jest", "mock"]);
const FRAMEWORK_MOCK_MODULES = new Set([
  "vitest",
  "@jest/globals",
  "node:test",
]);

/**
 * How a function is read. `own` is a test, whose assertions the parser
 * lists; `hook` is a hook, which may also call the framework's own mock
 * helpers; `helper` is a same-file function, read once for every test.
 */
type Mode = "own" | "hook" | "helper";

interface Scan {
  readonly mode: Mode;
  readonly unseen: string[];
  readonly unseenSet: Set<string>;
  /** Assertions on constants in same-file functions the body calls. */
  readonly helperConstants: Constant[];
  /** What a helper reading found, in order, for the file's memo. */
  readonly steps: HelperStep[];
  /** The subject of each assertion in the body itself, for the mock rule. */
  readonly subjects: Set<ts.Node>;
  /**
   * Assertions in a function the body defines whose outcome is fixed by the
   * literals every caller hands it: the parser cannot see the callers.
   */
  readonly overrides: Map<ts.Node, Constant>;
  /** An assertion that can fail, in the body itself or in a function it calls. */
  ownAsserts: boolean;
  helperAsserts: boolean;
  /** An advisory check (see `isJevyToSatisfy`), in the body or in a function it calls. */
  ownAdvisory: boolean;
  helperAdvisory: boolean;
  /** The body's own advisory assertions, for the parser to mark. */
  readonly advisory: Set<ts.Node>;
  throws: boolean;
  checksByHand: boolean;
  typeLevel: boolean;
  /** The `done`-style first parameter, if the function has one. */
  readonly callback: string | null;
  /** Helpers from outside the body already followed: each is read once per test. */
  readonly read: Set<Fn>;
  /** Functions the body defines and calls, read where they are called. */
  readonly opened: Set<Fn>;
  /** Functions the body defines, passed over where they are written. */
  readonly skipped: Fn[];
}

function newScan(mode: Mode, callback: string | null): Scan {
  return {
    mode,
    unseen: [],
    unseenSet: new Set(),
    helperConstants: [],
    steps: [],
    subjects: new Set(),
    overrides: new Map(),
    ownAsserts: false,
    helperAsserts: false,
    ownAdvisory: false,
    helperAdvisory: false,
    advisory: new Set(),
    throws: false,
    checksByHand: false,
    typeLevel: false,
    callback,
    read: new Set(),
    opened: new Set(),
    skipped: [],
  };
}

function note(scan: Scan, name: string): void {
  if (scan.unseenSet.has(name)) {
    return;
  }
  scan.unseenSet.add(name);
  if (scan.mode === "helper") {
    scan.steps.push({ kind: "unseen", name });
  } else {
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

/**
 * `fail()`, `expect.unreachable()`, `expect.assertions(1)` and the like. A
 * `fail` the file defines or imports is its own function, read as any other.
 */
function isHandCheck(callee: ts.Expression, reader: Reader): boolean {
  const node = unwrap(callee);
  if (ts.isIdentifier(node)) {
    const name = node.text;
    return (
      HAND_CHECKS.has(name) &&
      !reader.facts.moduleNames.has(name) &&
      !reader.declared.has(name) &&
      !reader.distrusted.has(name) &&
      helpersFor(name, reader, node).length === 0
    );
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
 * `vi.restoreAllMocks()`, `jest.resetModules()`: the framework's own mock
 * helpers, which check nothing. A wait is not one: it fails when it times out.
 */
function isFrameworkMock(callee: ts.Expression, facts: FileFacts): boolean {
  const node = unwrap(callee);
  if (!ts.isPropertyAccessExpression(node)) {
    return false;
  }
  const owner = unwrap(node.expression);
  const name = node.name.text;
  return (
    ts.isIdentifier(owner) &&
    FRAMEWORK_MOCKS.has(owner.text) &&
    fromFramework(owner.text, facts, FRAMEWORK_MOCK_MODULES) &&
    !name.startsWith("waitFor") &&
    name !== "waitUntil"
  );
}

/** What a hook may call without checking anything: see `isFrameworkMock`, `isQuietImport`. */
function isQuietInHook(callee: ts.Expression, facts: FileFacts): boolean {
  const node = unwrap(callee);
  return (
    isFrameworkMock(node, facts) ||
    (ts.isIdentifier(node) && isQuietImport(node.text, facts))
  );
}

/** `node` without the parentheses, casts and `!` around it. */
function outermost(node: ts.Node): ts.Node {
  let top = node;
  while (
    ts.isParenthesizedExpression(top.parent) ||
    ts.isAsExpression(top.parent) ||
    ts.isNonNullExpression(top.parent) ||
    ts.isSatisfiesExpression(top.parent)
  ) {
    top = top.parent;
  }
  return top;
}

/** True when `node` is what a call calls, or an argument a call may call back. */
function isHandedOver(node: ts.Identifier): boolean {
  const top = outermost(node);
  const parent = top.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    (parent.expression === top ||
      parent.arguments?.some((arg) => arg === top) === true)
  );
}

/** `void check`, `typeof check`, `check;`: named, and nothing can run it. */
function isOnlyNamed(node: ts.Identifier): boolean {
  const parent = outermost(node).parent;
  return (
    ts.isVoidExpression(parent) ||
    ts.isTypeOfExpression(parent) ||
    ts.isExpressionStatement(parent)
  );
}

/** The names of `fn`'s parameters, or null unless each is a plain name. */
function plainParameters(fn: Fn): string[] | null {
  const names: string[] = [];
  for (const parameter of fn.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    ) {
      return null;
    }
    names.push(parameter.name.text);
  }
  return names;
}

/** True when `id` is the name a declaration binds. */
function declares(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isBindingElement(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === id
  );
}

/**
 * The arguments of every call of `helper` where its name is in scope, or
 * null when the name is used any other way (handed on, stored, declared
 * again): then the guard cannot list what the helper is given.
 */
function callSites(
  helper: Helper,
  facts: FileFacts,
): readonly (readonly ts.Expression[])[] | null {
  const cached = facts.memo.callSites.get(helper.fn);
  if (cached !== undefined) {
    return cached;
  }
  const sites: (readonly ts.Expression[])[] = [];
  // An object, not a `let`: the walk below changes it inside a callback.
  const state = { plain: true };
  const visit = (node: ts.Node): void => {
    if (!state.plain) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === helper.name.text &&
      node !== helper.name
    ) {
      if (declares(node)) {
        state.plain = false;
      } else if (!isNameOnly(node)) {
        const top = outermost(node);
        if (ts.isCallExpression(top.parent) && top.parent.expression === top) {
          sites.push(top.parent.arguments);
        } else {
          state.plain = false;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(helper.scope);
  const out = state.plain ? sites : null;
  facts.memo.callSites.set(helper.fn, out);
  return out;
}

const UNDEFINED: Known = { kind: "primitive", value: undefined };

/** "passes" only when every call passes; "fails" only when every call fails. */
function together(results: readonly FixedResult[]): FixedResult {
  const [first, ...rest] = results;
  return first !== undefined && rest.every((result) => result === first)
    ? first
    : "unknown";
}

/**
 * The outcome of an assertion on a helper's parameters when every call of
 * the helper hands it literals: `eq(1, 1)` with `expect(a).toBe(b)` inside.
 * Null when any call hands it anything else, when a parameter can change, or
 * when the assertion sits in a callback inside the helper.
 */
function parameterConstant(
  call: ts.CallExpression,
  parts: AssertionParts,
  scope: AssertionScope,
  facts: FileFacts,
): Constant | null {
  const around = ts.findAncestor(call.parent, ts.isFunctionLike);
  const fn = around === undefined ? null : asFn(around);
  const helper = fn === null ? undefined : facts.helperOf.get(fn);
  const parameters = helper === undefined ? null : plainParameters(helper.fn);
  if (
    helper === undefined ||
    parameters === null ||
    parameters.length === 0 ||
    parameters.some((name) => facts.assigned.has(name))
  ) {
    return null;
  }
  const sites = callSites(helper, facts) ?? [];
  const constants: Constant[] = [];
  for (const args of sites) {
    const literals = new Map(scope.literals);
    for (const [index, name] of parameters.entries()) {
      const arg = args[index];
      const value =
        arg === undefined
          ? UNDEFINED
          : ts.isSpreadElement(arg)
            ? null
            : constantOf(arg, NO_SCOPE);
      if (value === null) {
        return null;
      }
      literals.set(name, value);
    }
    if (args.some((arg) => ts.isSpreadElement(arg))) {
      return null;
    }
    const constant = constantOutcome(parts, { ...scope, literals });
    if (constant === null) {
      return null;
    }
    constants.push(constant);
  }
  const first = constants[0];
  return first === undefined
    ? null
    : {
        outcome: first.outcome,
        result: together(constants.map((constant) => constant.result)),
      };
}

/** What one helper shows on its own, read once per file. */
function helperReading(fn: Fn, facts: FileFacts): HelperReading {
  const cached = facts.memo.readings.get(fn);
  if (cached !== undefined) {
    return cached;
  }
  const reader = newReader(facts, fn);
  for (const parameter of fn.parameters) {
    learnParameter(parameter, reader);
  }
  learnNames(fn.body ?? fn, reader);
  const scan = newScan("helper", null);
  readBody(fn, reader, scan);
  const reading: HelperReading = {
    steps: scan.steps,
    asserts: scan.helperAsserts,
    advises: scan.helperAdvisory,
    throws: scan.throws,
    checksByHand: scan.checksByHand,
    typeLevel: scan.typeLevel,
  };
  facts.memo.readings.set(fn, reading);
  return reading;
}

/** Everything `root` reaches, read once per file (see `HelperClosure`). */
function helperClosure(root: Fn, facts: FileFacts): HelperClosure {
  const cached = facts.memo.closures.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const helpers: Fn[] = [];
  const steps: HelperClosure["steps"][number][] = [];
  const seen = new Set<Fn>();
  const walk = (fn: Fn): void => {
    seen.add(fn);
    helpers.push(fn);
    for (const step of helperReading(fn, facts).steps) {
      if (step.kind !== "helper") {
        steps.push({ from: fn, step });
      } else if (!seen.has(step.helper.fn)) {
        walk(step.helper.fn);
      }
    }
  };
  walk(root);
  const closure = { helpers, steps };
  facts.memo.closures.set(root, closure);
  return closure;
}

/**
 * Add what a helper reaches to a test's or hook's reading. Helpers it has
 * already followed are skipped with everything they reach, which is what
 * reading them afresh would do.
 */
function follow(fn: Fn, facts: FileFacts, scan: Scan): void {
  const closure = helperClosure(fn, facts);
  const fresh = new Set(closure.helpers.filter((h) => !scan.read.has(h)));
  if (fresh.size === 0) {
    return;
  }
  for (const { from, step } of closure.steps) {
    if (!fresh.has(from)) {
      continue;
    }
    if (step.kind === "unseen") {
      note(scan, step.name);
    } else {
      scan.helperConstants.push(step.constant);
    }
  }
  for (const helper of fresh) {
    const reading = helperReading(helper, facts);
    scan.helperAsserts ||= reading.asserts;
    scan.helperAdvisory ||= reading.advises;
    scan.throws ||= reading.throws;
    scan.checksByHand ||= reading.checksByHand;
    scan.typeLevel ||= reading.typeLevel;
    scan.read.add(helper);
  }
}

/**
 * `@jevyjs/playwright`'s `toSatisfy` without `.not`: while it does not block
 * it reports and never fails the test. `.not.toSatisfy` throws whenever it
 * runs, so it fails the test like any assertion and is not advisory.
 */
function isJevyToSatisfy(parts: AssertionParts, facts: FileFacts): boolean {
  return parts.matcher === "toSatisfy" && !parts.negated && facts.jevyToSatisfy;
}

/** `expect(() => { … }).toPass()` on a function written in place. */
function isRetry(parts: AssertionParts): boolean {
  return (
    parts.matcher === "toPass" &&
    !parts.negated &&
    parts.subject !== undefined &&
    asFn(unwrap(parts.subject)) !== null
  );
}

/** The checks a scan has found so far, which a `toPass` block sets aside. */
interface Checks {
  readonly ownAsserts: boolean;
  readonly helperAsserts: boolean;
  readonly ownAdvisory: boolean;
  readonly helperAdvisory: boolean;
}

const NO_CHECKS: Checks = {
  ownAsserts: false,
  helperAsserts: false,
  ownAdvisory: false,
  helperAdvisory: false,
};

/** Put `next` in place of the scan's checks, and give back what was there. */
function swapChecks(scan: Scan, next: Checks): Checks {
  const previous: Checks = {
    ownAsserts: scan.ownAsserts,
    helperAsserts: scan.helperAsserts,
    ownAdvisory: scan.ownAdvisory,
    helperAdvisory: scan.helperAdvisory,
  };
  scan.ownAsserts = next.ownAsserts;
  scan.helperAsserts = next.helperAsserts;
  scan.ownAdvisory = next.ownAdvisory;
  scan.helperAdvisory = next.helperAdvisory;
  return previous;
}

/**
 * Second pass over a function: record every throw, every assertion in a
 * same-file function it calls, and every use of code the guard cannot read.
 *
 * A function the body defines and names is read where it is called, not
 * where it is written: one that is never called checks nothing.
 *
 * `covered` is true inside something already recorded as unreadable, where
 * naming each identifier again would only lengthen the message.
 */
function readBody(root: Fn, reader: Reader, scan: Scan): void {
  const { facts } = reader;
  const own = scan.mode !== "helper";

  const readHelper = (helper: Helper): void => {
    const { fn } = helper;
    if (fn !== root && isInside(fn, [root])) {
      // Defined in the body: read here, where the names it closes over are
      // known.
      if (!scan.opened.has(fn)) {
        scan.opened.add(fn);
        visit(fn, false, true);
      }
    } else if (scan.mode === "helper") {
      scan.steps.push({ kind: "helper", helper });
    } else {
      follow(fn, facts, scan);
    }
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

  /** Record an assertion that is not on constants, and read what it is made of. */
  const visitParts = (parts: AssertionParts, covered: boolean): void => {
    for (const node of [parts.subject, ...parts.args]) {
      if (node !== undefined) {
        visit(node, covered);
      }
    }
  };

  const markAdvisory = (call: ts.CallExpression): void => {
    if (own) {
      scan.ownAdvisory = true;
      scan.advisory.add(call);
    } else {
      scan.helperAdvisory = true;
    }
  };

  /**
   * `expect(async () => { … }).toPass()` retries its block until nothing in
   * it throws, so it can fail only through what the block holds. The block
   * is read with the checks found so far set aside: when all it adds is
   * advisory, the `toPass` is advisory too. Otherwise, as before, it is an
   * assertion that can fail, even with nothing in the block to show why.
   */
  const visitRetry = (
    call: ts.CallExpression,
    parts: AssertionParts,
    covered: boolean,
  ): void => {
    const saved = swapChecks(scan, NO_CHECKS);
    visitParts(parts, covered);
    const inner = swapChecks(scan, saved);
    scan.ownAsserts ||= inner.ownAsserts;
    scan.helperAsserts ||= inner.helperAsserts;
    scan.ownAdvisory ||= inner.ownAdvisory;
    scan.helperAdvisory ||= inner.helperAdvisory;
    const asserts = inner.ownAsserts || inner.helperAsserts;
    if ((inner.ownAdvisory || inner.helperAdvisory) && !asserts) {
      markAdvisory(call);
    } else if (own) {
      scan.ownAsserts = true;
    } else {
      scan.helperAsserts = true;
    }
  };

  const visitAssertion = (
    call: ts.CallExpression,
    parts: AssertionParts,
    covered: boolean,
  ): void => {
    let constant = constantOutcome(parts, reader);
    if (constant === null) {
      constant = parameterConstant(call, parts, reader, facts);
      if (constant !== null && own) {
        scan.overrides.set(call, constant);
      }
    }
    if (own && parts.subject !== undefined) {
      scan.subjects.add(parts.subject);
    }
    if (constant !== null) {
      // Nothing in a constant runs code: `expect(o.n).toBe(o.n)` is read as
      // the same value twice, getters aside.
      if (!own) {
        scan.steps.push({ kind: "constant", constant });
      }
      return;
    }
    if (isJevyToSatisfy(parts, facts)) {
      markAdvisory(call);
      visitParts(parts, covered);
      return;
    }
    if (isRetry(parts)) {
      visitRetry(call, parts, covered);
      return;
    }
    if (own) {
      scan.ownAsserts = true;
    } else {
      scan.helperAsserts = true;
    }
    visitParts(parts, covered);
  };

  const visitCall = (call: ts.CallExpression, covered: boolean): void => {
    const parts = facts.readAssertion(call);
    if (parts !== null) {
      visitAssertion(call, parts, covered);
      return;
    }
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && TYPE_CHECKS.has(callee.text)) {
      scan.typeLevel = true;
    }
    const byHand = isHandCheck(callee, reader);
    if (byHand) {
      scan.checksByHand = true;
    }
    // Calls the guard vouches for by name, whatever the name's owner is.
    const vouched =
      byHand ||
      isTestApi(callee) ||
      isBareExpect(callee, facts) ||
      isMockFactory(call, facts) ||
      (scan.mode === "hook" && isQuietInHook(callee, facts));
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
    if (own && name === scan.callback) {
      scan.checksByHand = true;
    }
    const helpers = helpersFor(name, reader, node);
    if (helpers.length > 0) {
      // Called, or handed to code that may call it: `items.forEach(check)`.
      // Only named (`void check`), a function runs nothing. Stored or passed
      // on any other way (`{ check }`, `x.cb = check`), it may run where the
      // guard cannot follow.
      if (isHandedOver(node)) {
        helpers.forEach(readHelper);
      } else if (!covered && !isOnlyNamed(node)) {
        note(scan, name);
      }
      return;
    }
    // Reading a value from elsewhere can run code: a getter, an iterator.
    if (!covered && !knows(name, reader)) {
      note(scan, name);
    }
  };

  const visit = (node: ts.Node, covered: boolean, opening = false): void => {
    // Types run nothing.
    if (ts.isTypeNode(node)) {
      return;
    }
    const fn = asFn(node);
    if (fn !== null && fn !== root && !opening && facts.helperOf.has(fn)) {
      scan.skipped.push(fn);
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

  visit(root, false);
}

/** Read one test or hook function: its names, then its body. */
export function readFunction(
  fn: Fn,
  shape: TestShape,
  facts: FileFacts,
  hook = false,
): { readonly reader: Reader; readonly scan: Scan } {
  const reader = newReader(facts, fn);
  const callback = learnParameters(fn, shape, reader);
  learnNames(fn.body ?? fn, reader);
  const scan = newScan(hook ? "hook" : "own", callback);
  readBody(fn, reader, scan);
  return { reader, scan };
}

/**
 * The parameters of the `.each` tables around a test: its own rows, and the
 * rows of each parameterised describe it sits in.
 */
function rowNames(fn: Fn, shape: TestShape): Set<string> {
  const out = new Set<string>();
  const add = (from: ts.SignatureDeclaration): void => {
    for (const parameter of from.parameters) {
      bindingNames(parameter.name).forEach((name) => out.add(name));
    }
  };
  if (shape.rows) {
    add(fn);
  }
  for (
    let outer = ts.findAncestor(fn.parent, ts.isFunctionLike);
    outer !== undefined;
    outer = ts.findAncestor(outer.parent, ts.isFunctionLike)
  ) {
    const call = outer.parent;
    const table = ts.isCallExpression(call) ? unwrap(call.expression) : null;
    const each =
      table !== null &&
      (ts.isCallExpression(table) || ts.isTaggedTemplateExpression(table))
        ? unwrap(ts.isCallExpression(table) ? table.expression : table.tag)
        : null;
    if (
      each !== null &&
      ts.isPropertyAccessExpression(each) &&
      each.name.text === "each"
    ) {
      add(outer);
    }
  }
  return out;
}

/**
 * One walk over a test function: whether it reads any of `rows`, and
 * whether a comment in it is a `@ts-expect-error` directive.
 */
function marks(
  fn: Fn,
  rows: ReadonlySet<string>,
): { readonly readsRows: boolean; readonly directive: boolean } {
  const text = fn.getSourceFile().text;
  let readsRows = false;
  let directive = false;
  const visit = (node: ts.Node): void => {
    if (
      !directive &&
      (ts.getLeadingCommentRanges(text, node.pos) ?? []).some((range) =>
        text.slice(range.pos, range.end).includes(TYPE_DIRECTIVE),
      )
    ) {
      directive = true;
    }
    if (ts.isIdentifier(node) && rows.has(node.text) && !isNameOnly(node)) {
      readsRows = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return { readsRows, directive };
}

/** What reading a test function gives: the evidence, and its names for the parser. */
export interface BodyReading {
  readonly evidence: BodyEvidence;
  readonly scope: AssertionScope;
  /**
   * Functions the test defines and never calls. An assertion in one never
   * runs, so the verdict leaves it out.
   */
  readonly unread: readonly ts.Node[];
  /**
   * Assertions in a function the test defines whose outcome is fixed by the
   * literals every caller hands it (`eq(1, 1)`). The parser, which sees the
   * assertion alone, takes the outcome from here.
   */
  readonly overrides: ReadonlyMap<ts.Node, Constant>;
  /**
   * The test's own advisory assertions: `@jevyjs/playwright`'s `toSatisfy`,
   * and a `toPass` block whose only check is one. The parser marks them.
   */
  readonly advisory: ReadonlySet<ts.Node>;
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
  const { readsRows, directive } = marks(fn, rowNames(fn, shape));
  return {
    scope: reader,
    unread: scan.skipped.filter((skipped) => !scan.opened.has(skipped)),
    overrides: scan.overrides,
    advisory: scan.advisory,
    evidence: {
      helperAsserts: scan.helperAsserts,
      ...(scan.helperAdvisory ? { helperAdvisory: true as const } : {}),
      ...(facts.hooks.some((hook) => hook.advises && isInside(fn, [hook.scope]))
        ? { hookAdvisory: true as const }
        : {}),
      helperConstants: scan.helperConstants,
      unseen: scan.unseen,
      throws: scan.throws,
      checksByHand: scan.checksByHand,
      hookChecks: facts.hooks.some(
        (hook) => hook.mayCheck && isInside(fn, [hook.scope]),
      ),
      customRunner: !isFrameworkRunner(shape, reader),
      typeLevel: scan.typeLevel || directive || facts.typeOnly,
      readsRows,
      ownMocks: ownMocks(fn, facts, scan.subjects),
    },
  };
}
