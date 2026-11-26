import { finding, titleText } from "../findings.js";
import type { Finding } from "../types.js";
import type {
  BodyEvidence,
  Constant,
  ConstantOutcome,
  FixedResult,
} from "./model.js";

/**
 * The verdict on one test: combines what the parser and the body reading
 * found into at most one finding, and words it.
 */

const MAX_NAMES = 3;

/** The parts of a parsed test the verdict reads. */
export interface WeakCandidate {
  readonly titlePath: readonly string[];
  readonly line: number;
  readonly markers: { readonly fail: number };
  readonly assertions: readonly {
    readonly matcher: string;
    /** True when the chain has an odd number of `.not`. */
    readonly negated: boolean;
    readonly constant: ConstantOutcome | null;
    readonly result: FixedResult | null;
    readonly subjectRoot: string | null;
    /** In a function the test defines and never calls. */
    readonly unreached?: true;
    /**
     * `@jevyjs/playwright`'s `toSatisfy` without `.not`, or a `toPass` block
     * whose only check is one: it reports and, while `toSatisfy` does not
     * block, never fails the test.
     */
    readonly advisory?: true;
    readonly line: number;
  }[];
  readonly evidence: BodyEvidence | null;
}

/** What the verdict needs to know of the project's settings. */
export interface VerdictOptions {
  /**
   * Whether `toSatisfy` blocks: true only when the base version of the
   * config sets `toSatisfy.blocking: true` and the change keeps it. Absent
   * is core's default, `false`: a `toSatisfy` that fails is reported and the
   * test still passes.
   */
  readonly toSatisfyBlocking?: boolean;
}

/**
 * The evidence with advisory checks outside the test counted as checks
 * when `toSatisfy` blocks: a function's as an assertion that can fail, a
 * hook's as a hook that may check.
 */
function blockingAware(
  evidence: BodyEvidence,
  blocking: boolean,
): BodyEvidence {
  return blocking
    ? {
        ...evidence,
        helperAsserts:
          evidence.helperAsserts || evidence.helperAdvisory === true,
        hookChecks: evidence.hookChecks || evidence.hookAdvisory === true,
      }
    : evidence;
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

type Assertion = WeakCandidate["assertions"][number];

/** See `WeakCandidate`'s `advisory`. */
function isAdvisory(assertion: Assertion): boolean {
  return assertion.advisory === true;
}

/**
 * `only-advisory-assertions` for a test that only `toSatisfy` can fail,
 * while `toSatisfy` is advisory, or null.
 *
 * It is a review finding, not a weakening one: a judgement-only test is
 * what a generator legitimately writes, and a person should know that it
 * cannot fail the build. The claim is made only when it is shown: beside
 * `toSatisfy` there may be assertions on constants that pass, and nothing
 * else. Any assertion that can fail, a constant one that fails when
 * reached, a row of a table that may make a constant real, or a place a
 * check may hide (see `otherChecks`) keeps it silent.
 *
 * The advisory check may be the test's own, or in a same-file function it
 * calls or a hook around it: there it is no more able to fail the build.
 */
function advisoryFinding(
  file: string,
  test: WeakCandidate,
  assertions: readonly Assertion[],
  evidence: BodyEvidence,
): Finding | null {
  const first = assertions.find(isAdvisory);
  const elsewhere =
    evidence.helperAdvisory === true || evidence.hookAdvisory === true;
  if (first === undefined && !elsewhere) {
    return null;
  }
  const others = assertions.filter((a) => !isAdvisory(a));
  const passes = others.every(
    (a) => a.constant !== null && a.result === "passes",
  );
  const helpersPass = evidence.helperConstants.every(
    (constant) => constant.result === "passes",
  );
  const rows =
    evidence.readsRows &&
    (others.length > 0 || evidence.helperConstants.length > 0);
  if (
    !passes ||
    !helpersPass ||
    rows ||
    otherChecks(evidence, false).length > 0
  ) {
    return null;
  }
  return finding({
    kind: "only-advisory-assertions",
    file,
    test: test.titlePath,
    line: first?.line ?? test.line,
    message: `${titleText(test.titlePath)}: every assertion that can fail is toSatisfy, which only reports while toSatisfy.blocking is not true, so this test cannot fail the build`,
  });
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
 * fail. A test that reads a row of an `.each` table, its own or a
 * describe's, is judged only for having no assertion: the rows can make a
 * constant-looking assertion real. An assertion in a function the test
 * defines and never calls does not count: it never runs.
 *
 * A test that only an advisory `toSatisfy` can fail, which these rules
 * would leave alone, is `only-advisory-assertions` (see `advisoryFinding`)
 * unless `options.toSatisfyBlocking` is true. So is one whose only check
 * beyond assertions on constants is an advisory one in a same-file function
 * it calls or a hook around it: counted as an assertion there, it would
 * have silenced the test, and as a hook's check it would have hidden one
 * that cannot fail. When `toSatisfy` blocks, those checks are assertions
 * like any other.
 */
export function weakTestFinding(
  file: string,
  test: WeakCandidate,
  options: VerdictOptions = {},
): Finding | null {
  const blocking = options.toSatisfyBlocking === true;
  const evidence =
    test.evidence === null ? null : blockingAware(test.evidence, blocking);
  const assertions = test.assertions.filter((a) => a.unreached !== true);
  if (
    evidence === null ||
    evidence.typeLevel ||
    evidence.helperAsserts ||
    test.markers.fail > 0
  ) {
    return null;
  }
  if (
    !blocking &&
    (evidence.helperAdvisory === true || evidence.hookAdvisory === true)
  ) {
    return advisoryFinding(file, test, assertions, evidence);
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
    evidence.readsRows ||
    !assertions.every((a) => a.constant !== null || isOwnMock(a.subjectRoot))
  ) {
    return blocking ? null : advisoryFinding(file, test, assertions, evidence);
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
