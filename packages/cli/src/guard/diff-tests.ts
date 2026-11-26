import {
  finding,
  multisetMinus,
  plural,
  sortFindings,
  titleText,
} from "./findings.js";
import {
  parseTestFile,
  type Markers,
  type ParsedAssertion,
  type ParsedTest,
  type ParsedTestFile,
} from "./parse.js";
import type { Finding } from "./types.js";
import { weakTestFinding, type VerdictOptions } from "./weak-tests.js";

/**
 * Compares two versions of one test file. Tests are matched by title path,
 * so moving a test or reformatting it is not a change, while deleting it,
 * skipping it or dropping one of its assertions is. A test that is new, or
 * whose body changed, is also checked on its own: does it check anything?
 */

export interface TestFileChange {
  /** Path in the head version (or the base path when the file was deleted). */
  readonly file: string;
  /** Base text, or null when the file is new. */
  readonly before: string | null;
  /** Head text, or null when the file was deleted. */
  readonly after: string | null;
  /**
   * Whether `toSatisfy` blocks: the base version of the config sets
   * `toSatisfy.blocking: true` and the change keeps it. Absent is the
   * default, `false`, under which a test that only `toSatisfy` can fail
   * is `only-advisory-assertions`.
   */
  readonly toSatisfyBlocking?: boolean;
}

/** `expect(…).not.toHaveText("Paid")`: the parts a weakening changes. */
function signature(assertion: ParsedAssertion, withStatement: boolean): string {
  const args =
    assertion.matcher === "toSatisfy" && !withStatement
      ? assertion.args.slice(1)
      : assertion.args;
  const chain = [
    ...assertion.modifiers.filter((modifier) => modifier !== "poll"),
    ...(assertion.negated ? ["not"] : []),
    assertion.matcher,
  ].join(".");
  const root = assertion.modifiers.includes("poll") ? "expect.poll" : "expect";
  const argText = args.map((arg) => arg ?? "…").join(", ");
  return `${root}(${assertion.subject ?? "…"}).${chain}(${argText})`;
}

function countSoft(assertions: readonly ParsedAssertion[]): number {
  return assertions.filter((assertion) => assertion.soft).length;
}

interface Where {
  readonly file: string;
  readonly test?: readonly string[];
  readonly line?: number;
  /** "checkout > pays" or "assertions outside tests". */
  readonly label: string;
}

function where(file: string, test: ParsedTest): Where {
  return {
    file,
    test: test.titlePath,
    line: test.line,
    label: titleText(test.titlePath),
  };
}

function diffAssertions(
  at: Where,
  before: readonly ParsedAssertion[],
  after: readonly ParsedAssertion[],
): Finding[] {
  const out: Finding[] = [];
  const base = { file: at.file, test: at.test, line: at.line };
  const removed = multisetMinus(
    before.map((a) => a.matcher),
    after.map((a) => a.matcher),
  );
  const added = multisetMinus(
    after.map((a) => a.matcher),
    before.map((a) => a.matcher),
  );
  const outside = at.test === undefined;
  const counts = `(${String(before.length)} -> ${String(after.length)})`;
  const subject = outside ? `${at.label}:` : `${at.label} has`;
  // "checkout > pays has 1 fewer assertion (2 -> 1)" for a test,
  // "assertions outside tests: 1 fewer (2 -> 1)" for the rest of the file.
  const delta = (count: number, direction: string): string => {
    const noun = count === 1 ? "assertion" : "assertions";
    return `${subject} ${String(count)} ${direction}${outside ? "" : ` ${noun}`} ${counts}`;
  };

  if (after.length < before.length) {
    const lost = multisetMinus(
      before.map((a) => signature(a, true)),
      after.map((a) => signature(a, true)),
    );
    out.push(
      finding({
        ...base,
        kind: "assertion-removed",
        message: `${delta(before.length - after.length, "fewer")}: removed ${removed.join(", ")}`,
        before: lost.join("; "),
      }),
    );
  } else if (after.length > before.length) {
    out.push(
      finding({
        ...base,
        kind: "assertion-added",
        message: `${delta(after.length - before.length, "more")}: added ${added.join(", ")}`,
      }),
    );
  }

  // Same count, or a matcher swapped while others were added: the literal
  // parts of the assertions changed.
  if (after.length >= before.length) {
    const lost = multisetMinus(
      before.map((a) => signature(a, false)),
      after.map((a) => signature(a, false)),
    );
    const gained = multisetMinus(
      after.map((a) => signature(a, false)),
      before.map((a) => signature(a, false)),
    );
    if (lost.length > 0) {
      out.push(
        finding({
          ...base,
          kind: "assertion-changed",
          message: `${at.label}: ${lost.length === 1 ? "an assertion" : plural(lost.length, "assertion")} changed`,
          before: lost.join("; "),
          after: gained.join("; "),
        }),
      );
    }
  }

  const beforeStatements = before.flatMap((a) =>
    a.statement === undefined ? [] : [a.statement],
  );
  const afterSatisfy = after.filter((a) => a.statement !== undefined);
  const afterStatements = afterSatisfy.flatMap((a) =>
    a.statement === undefined ? [] : [a.statement],
  );
  if (beforeStatements.length === afterStatements.length) {
    const was = multisetMinus(beforeStatements, afterStatements);
    const now = multisetMinus(afterStatements, beforeStatements);
    was.forEach((statement, index) => {
      const replacement = now[index];
      if (replacement === undefined) {
        return;
      }
      const line = afterSatisfy.find((a) => a.statement === replacement)?.line;
      out.push(
        finding({
          file: at.file,
          test: at.test,
          line: line ?? at.line,
          kind: "statement-changed",
          message: `${at.label}: toSatisfy statement changed`,
          before: statement,
          after: replacement,
        }),
      );
    });
  }

  const softBefore = countSoft(before);
  const softAfter = countSoft(after);
  if (softAfter > softBefore) {
    out.push(
      finding({
        ...base,
        kind: "soft-added",
        message: `${subject} ${String(softAfter - softBefore)} more soft ${softAfter - softBefore === 1 ? "assertion" : "assertions"} (${String(softBefore)} -> ${String(softAfter)})`,
      }),
    );
  }
  return out;
}

function diffMarkers(at: Where, before: Markers, after: Markers): Finding[] {
  const out: Finding[] = [];
  const base = { file: at.file, test: at.test, line: at.line };
  if (after.skip > before.skip) {
    out.push(
      finding({
        ...base,
        kind: "skip-added",
        message: `${at.label} gained a skip (skip, fixme, todo or x-prefix; ${String(before.skip)} -> ${String(after.skip)})`,
      }),
    );
  }
  if (after.only > before.only) {
    out.push(
      finding({
        ...base,
        kind: "only-added",
        message: `${at.label} gained .only, which stops every other test running`,
      }),
    );
  }
  if (after.fail > before.fail) {
    out.push(
      finding({
        ...base,
        kind: "expected-failure-added",
        message: `${at.label} is now marked as expected to fail`,
      }),
    );
  }
  return out;
}

/** The weak-test finding for the head version of a test, if it has one. */
function weakFindings(
  file: string,
  test: ParsedTest,
  options: VerdictOptions,
): Finding[] {
  const found = weakTestFinding(file, test, options);
  return found === null ? [] : [found];
}

/**
 * True when a skip or an expected-failure marker came off: the test runs, or
 * counts, again, so what its body checks is judged as if it were new.
 */
function markersCameOff(before: Markers, after: Markers): boolean {
  return after.skip < before.skip || after.fail < before.fail;
}

function diffMatched(
  file: string,
  before: ParsedTest,
  after: ParsedTest,
  untouched: ReadonlySet<ParsedTest>,
  options: VerdictOptions,
): Finding[] {
  const at = where(file, after);
  const out = diffMarkers(at, before.markers, after.markers);
  // The guard reports what a change did: a test nobody touched is left
  // alone however weak it is, and a touched one is judged as it now stands.
  // A formatter's edit (a semicolon, a trailing comma) is not a touch.
  const judged =
    !untouched.has(after) || markersCameOff(before.markers, after.markers);
  const weak = judged ? weakFindings(file, after, options) : [];
  if (before.dynamic || after.dynamic) {
    if (before.body !== after.body || before.cases !== after.cases) {
      out.push(
        finding({
          file,
          test: after.titlePath,
          line: after.line,
          kind: "dynamic-title",
          message: `${at.label} changed, and its title is not a string literal, so it cannot be matched reliably`,
        }),
      );
    }
    return [...out, ...weak];
  }
  if (before.cases !== after.cases) {
    out.push(
      finding({
        file,
        test: after.titlePath,
        line: after.line,
        kind: "cases-changed",
        message: `${at.label}: the .each table changed`,
        ...(before.cases === null ? {} : { before: before.cases }),
        ...(after.cases === null ? {} : { after: after.cases }),
      }),
    );
  }
  return [
    ...out,
    ...diffAssertions(at, before.assertions, after.assertions),
    ...weak,
  ];
}

/** Key a test by title path; repeated titles get an occurrence number. */
function keyed(tests: readonly ParsedTest[]): Map<string, ParsedTest> {
  const seen = new Map<string, number>();
  const out = new Map<string, ParsedTest>();
  for (const test of tests) {
    const path = test.titlePath.join("\u0000");
    const count = seen.get(path) ?? 0;
    seen.set(path, count + 1);
    out.set(count === 0 ? path : `${path}\u0000#${String(count + 1)}`, test);
  }
  return out;
}

function addedFindings(
  file: string,
  test: ParsedTest,
  untouched: ReadonlySet<ParsedTest>,
  options: VerdictOptions,
): Finding[] {
  const at = where(file, test);
  const skipped = test.markers.skip > 0 ? " (skipped)" : "";
  const out = [
    finding({
      file,
      test: test.titlePath,
      line: test.line,
      kind: "test-added",
      message: `test added: ${at.label}${skipped}`,
    }),
  ];
  if (test.markers.only > 0) {
    out.push(
      finding({
        file,
        test: test.titlePath,
        line: test.line,
        kind: "only-added",
        message: `new test ${at.label} has .only, which stops every other test running`,
      }),
    );
  }
  // A new test that is skipped is reported as such above; what its body
  // checks is judged when the skip comes off (see `diffMatched`). One whose
  // body a base test already had, under its title or under the title it was
  // renamed from, is not new work, so it is not judged either.
  return test.markers.skip > 0 || untouched.has(test)
    ? out
    : [...out, ...weakFindings(file, test, options)];
}

function removedFinding(file: string, test: ParsedTest): Finding {
  const label = titleText(test.titlePath);
  if (test.dynamic) {
    return finding({
      file,
      test: test.titlePath,
      line: test.line,
      kind: "dynamic-title",
      message: `${label} is gone or changed (was line ${String(test.line)}), and its title is not a string literal, so it cannot be matched reliably`,
    });
  }
  return finding({
    file,
    test: test.titlePath,
    line: test.line,
    kind: "test-removed",
    message: `test removed: ${label} (was line ${String(test.line)})`,
  });
}

/** A multiset of fingerprints, with each base test counted once. */
class Fingerprints {
  private readonly counts = new Map<string, number>();

  add(fingerprint: string | null): void {
    if (fingerprint !== null) {
      this.counts.set(fingerprint, (this.counts.get(fingerprint) ?? 0) + 1);
    }
  }

  /** Take one copy of `fingerprint`, if one is left. */
  take(fingerprint: string | null): boolean {
    const count =
      fingerprint === null ? 0 : (this.counts.get(fingerprint) ?? 0);
    if (fingerprint === null || count === 0) {
      return false;
    }
    this.counts.set(fingerprint, count - 1);
    return true;
  }
}

function titleKey(test: ParsedTest): string {
  return test.titlePath.join("\u0000");
}

/**
 * Head tests whose body a base test with the same title path already had.
 * Tests with one title are paired in order first, so an untouched test stays
 * untouched; then any head test may take a base body still unclaimed, so
 * one put in front of it, or a swap of two, leaves both alone. Each base
 * body excuses one head test: a copy of an old test is new.
 */
function untouchedByTitle(
  before: readonly ParsedTest[],
  after: readonly ParsedTest[],
): Set<ParsedTest> {
  const groups = new Map<string, { base: ParsedTest[]; head: ParsedTest[] }>();
  const group = (key: string) => {
    const found = groups.get(key) ?? { base: [], head: [] };
    groups.set(key, found);
    return found;
  };
  before.forEach((test) => group(titleKey(test)).base.push(test));
  after.forEach((test) => group(titleKey(test)).head.push(test));
  const out = new Set<ParsedTest>();
  for (const { base, head } of groups.values()) {
    const left = new Fingerprints();
    const rest: ParsedTest[] = [];
    head.forEach((test, index) => {
      const pair = base[index];
      if (
        pair !== undefined &&
        test.fingerprint !== null &&
        pair.fingerprint === test.fingerprint
      ) {
        out.add(test);
      } else {
        left.add(pair?.fingerprint ?? null);
        rest.push(test);
      }
    });
    base.slice(head.length).forEach((test) => {
      left.add(test.fingerprint);
    });
    rest
      .filter((test) => left.take(test.fingerprint))
      .forEach((test) => {
        out.add(test);
      });
  }
  return out;
}

function diffParsed(
  file: string,
  before: ParsedTestFile,
  after: ParsedTestFile,
  options: VerdictOptions,
): Finding[] {
  const out: Finding[] = [];
  const beforeTests = keyed(before.tests);
  const afterTests = keyed(after.tests);
  const untouched = untouchedByTitle(before.tests, after.tests);
  const removed: ParsedTest[] = [];
  for (const [key, test] of beforeTests) {
    const match = afterTests.get(key);
    if (match === undefined) {
      removed.push(test);
    } else {
      out.push(...diffMatched(file, test, match, untouched, options));
    }
  }
  const added = [...afterTests].filter(([key]) => !beforeTests.has(key));
  const unclaimed = new Set(added.map(([, test]) => test));

  // A removed test whose body is back under another title, with only a
  // formatter's edit, is a rename for the weak-test rules too: its copy is
  // not judged. Which findings name the rename still rests on `body`.
  const renamedFrom = new Fingerprints();
  for (const test of removed) {
    const twin =
      test.body === null
        ? undefined
        : [...unclaimed].find((candidate) => candidate.body === test.body);
    if (twin === undefined) {
      renamedFrom.add(test.fingerprint);
      out.push(removedFinding(file, test));
      continue;
    }
    unclaimed.delete(twin);
    if (twin.fingerprint === test.fingerprint) {
      untouched.add(twin);
    }
    out.push(
      finding({
        file,
        test: twin.titlePath,
        line: twin.line,
        kind: "test-renamed",
        message: `test renamed: ${titleText(test.titlePath)} -> ${titleText(twin.titlePath)}`,
        before: titleText(test.titlePath),
        after: titleText(twin.titlePath),
      }),
      ...diffMatched(file, test, twin, untouched, options),
    );
  }
  for (const test of unclaimed) {
    if (!untouched.has(test) && renamedFrom.take(test.fingerprint)) {
      untouched.add(test);
    }
    out.push(...addedFindings(file, test, untouched, options));
  }
  out.push(
    ...diffAssertions(
      { file, label: "assertions outside tests" },
      before.looseAssertions,
      after.looseAssertions,
    ),
  );
  return out;
}

/** Findings for one test file, sorted. */
export function diffTestFile(change: TestFileChange): readonly Finding[] {
  const { file } = change;
  const before =
    change.before === null ? null : parseTestFile(change.before, file);
  const after =
    change.after === null ? null : parseTestFile(change.after, file);

  if (after === null) {
    const count =
      before?.ok === true
        ? ` (${plural(before.value.tests.length, "test")})`
        : "";
    return [
      finding({
        file,
        kind: "test-file-removed",
        message: `test file removed${count}`,
      }),
    ];
  }
  const broken = [
    ...(before !== null && !before.ok
      ? [`base version could not be parsed (${before.error})`]
      : []),
    ...(!after.ok ? [`head version could not be parsed (${after.error})`] : []),
  ];
  if (broken.length > 0) {
    return [
      finding({
        file,
        kind: "unparseable",
        message: `${broken.join("; ")}; its tests were not compared`,
      }),
    ];
  }
  if (!after.ok) {
    return [];
  }
  const empty: ParsedTestFile = { tests: [], looseAssertions: [] };
  const base = before?.ok === true ? before.value : empty;
  const options =
    change.toSatisfyBlocking === undefined
      ? {}
      : { toSatisfyBlocking: change.toSatisfyBlocking };
  return sortFindings(diffParsed(file, base, after.value, options));
}
