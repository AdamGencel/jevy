import {
  ATTEMPT_STATUSES,
  REPORT_TOOL,
  REPORT_VERSION,
  RUN_STATUSES,
  ReportError,
  validateReportEntry,
  validateReportSpec,
} from "./schema.js";
import type {
  AttemptStatus,
  JevyReport,
  ReportAssertion,
  ReportIncomplete,
  ReportRun,
  ReportSummary,
} from "./schema.js";

/**
 * Who a test is, as the reporter derives it from Playwright's `TestCase`. It
 * names a test in `incomplete`, where there may be no entry to name it.
 */
export interface ReportTest {
  /** The test file relative to the Jevy root, with forward slashes. */
  readonly spec: string;
  readonly project: string;
  /** Describe titles, then the test title. */
  readonly test: readonly string[];
  readonly line: number;
}

/**
 * One run of one test, as the reporter saw it. `testId` is Playwright's
 * `TestCase.id`, which differs per project and per `--repeat-each` index, so
 * the same test in two projects is two tests here and both are kept.
 */
export interface ReportAttempt {
  readonly testId: string;
  readonly retry: number;
  readonly status: AttemptStatus;
  readonly test: ReportTest;
  readonly entries: readonly ReportAssertion[];
}

/**
 * Build the report from every attempt of a run. Pure: the same attempts in
 * any order give the same report, so two runs over the same state write the
 * same bytes.
 *
 * Only each test's last attempt is kept. An earlier attempt is a draft the
 * retry replaced; reporting it would count one assertion twice. What the
 * last attempt may have lost is not dropped silently: such a test is listed
 * in `incomplete` (see `ReportIncomplete`), and `run` says how the run ended.
 */
export function buildReport(
  attempts: readonly ReportAttempt[],
  run: ReportRun,
): JevyReport {
  const status = checkedRunStatus(run);
  const byTest = groupByTest(attempts);
  const assertions = byTest
    .flatMap(({ last }) =>
      last.entries.map((entry) => checked(entry, last.retry)),
    )
    .map((entry) => ({ entry, text: JSON.stringify(entry) }))
    .sort(
      (a, b) => compareEntries(a.entry, b.entry) || compareText(a.text, b.text),
    )
    .map(({ entry }) => entry);
  const incomplete = byTest
    .flatMap((group) => incompleteOf(group))
    .map((record) => ({ record, text: JSON.stringify(record) }))
    .sort(
      (a, b) =>
        compareIncomplete(a.record, b.record) || compareText(a.text, b.text),
    )
    .map(({ record }) => record);
  return {
    v: REPORT_VERSION,
    tool: REPORT_TOOL,
    run: { status },
    summary: summarise(assertions, incomplete),
    assertions,
    incomplete,
  };
}

/** Two-space JSON with a final newline: diffable, and stable byte for byte. */
export function serialiseReport(report: JevyReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function checkedRunStatus(run: ReportRun): ReportRun["status"] {
  const { status } = run;
  if (!(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new ReportError(`Unknown run status ${JSON.stringify(status)}`);
  }
  return status;
}

/** One test's last attempt, and the most entries an earlier attempt had. */
interface TestAttempts {
  readonly last: ReportAttempt;
  readonly mostEarlierEntries: number;
}

function groupByTest(
  attempts: readonly ReportAttempt[],
): readonly TestAttempts[] {
  const byId = new Map<string, ReportAttempt[]>();
  for (const one of attempts) {
    if (!(ATTEMPT_STATUSES as readonly string[]).includes(one.status)) {
      throw new ReportError(
        `Unknown attempt status ${JSON.stringify(one.status)}`,
      );
    }
    const same = byId.get(one.testId) ?? [];
    if (same.some((other) => other.retry === one.retry)) {
      throw new ReportError(
        `Two attempts of one test have the same retry ${String(one.retry)}`,
      );
    }
    same.push(one);
    byId.set(one.testId, same);
  }
  return [...byId.values()].map((same) => {
    const last = same.reduce((a, b) => (b.retry > a.retry ? b : a));
    const earlier = same.filter((one) => one !== last);
    return {
      last,
      mostEarlierEntries: Math.max(
        0,
        ...earlier.map((one) => one.entries.length),
      ),
    };
  });
}

/**
 * A test is incomplete when its last attempt was cut short (timed out or
 * interrupted), so later `toSatisfy` calls may never have run, or when it has
 * fewer entries than an earlier attempt, whose extra assertions would
 * otherwise vanish from the report without a trace.
 */
function incompleteOf(group: TestAttempts): readonly ReportIncomplete[] {
  const { last, mostEarlierEntries } = group;
  const cutShort = last.status === "timedOut" || last.status === "interrupted";
  if (!cutShort && last.entries.length >= mostEarlierEntries) return [];
  const { spec, project, test, line } = checkedTest(last.test);
  return [
    {
      spec,
      project,
      test,
      line,
      retry: last.retry,
      status: last.status,
      entries: last.entries.length,
      entriesInEarlierAttempt: mostEarlierEntries,
    },
  ];
}

/** The same field rules as an entry's `spec`, `project`, `test` and `line`. */
function checkedTest(test: ReportTest): ReportTest {
  const titles = test.test;
  if (
    titles.length === 0 ||
    !titles.every((title) => typeof title === "string" && title !== "")
  ) {
    throw new ReportError(
      "An incomplete test's titles must be a non-empty list of non-empty strings",
    );
  }
  if (!Number.isSafeInteger(test.line) || test.line < 1) {
    throw new ReportError("An incomplete test's line must be at least 1");
  }
  if (typeof test.project !== "string") {
    throw new ReportError("An incomplete test's project must be a string");
  }
  return {
    spec: validateReportSpec(test.spec),
    project: test.project,
    test: [...titles],
    line: test.line,
  };
}

/**
 * Validate again here: a caller may build entries by hand, and the rebuilt
 * object has its keys in the documented order whatever order it came in.
 */
function checked(entry: ReportAssertion, retry: number): ReportAssertion {
  const valid = validateReportEntry(entry);
  if (valid.retry !== retry) {
    throw new ReportError(
      `A report entry says retry ${String(valid.retry)} but came from attempt ${String(retry)}`,
    );
  }
  return valid;
}

/**
 * By `spec`, `project`, `test` and `step`, each compared by code unit, except
 * the step's trailing `#n`, which compares as a number (see `compareSteps`).
 */
function compareEntries(a: ReportAssertion, b: ReportAssertion): number {
  return (
    compareText(a.spec, b.spec) ||
    compareText(a.project, b.project) ||
    compareTitles(a.test, b.test) ||
    compareSteps(a.step, b.step)
  );
}

/** By `spec`, `project`, `test` and `line`, as the assertions are. */
function compareIncomplete(a: ReportIncomplete, b: ReportIncomplete): number {
  return (
    compareText(a.spec, b.spec) ||
    compareText(a.project, b.project) ||
    compareTitles(a.test, b.test) ||
    a.line - b.line
  );
}

const ORDINAL = /^(.*)#(\d+)$/s;

/**
 * Call order. A step is the title path, `#`, and the call's ordinal, so code
 * unit order would put `t#10` before `t#2`. The part before the last `#`
 * compares by code unit, then the ordinal by value, then, for ties such as
 * `#01` and `#1`, the whole step by code unit. The ordinal is compared as
 * digits with leading zeros removed, shorter first, so no length of number
 * loses precision. A step without a trailing `#n` compares by code unit.
 */
function compareSteps(a: string, b: string): number {
  const left = ORDINAL.exec(a);
  const right = ORDINAL.exec(b);
  if (left === null || right === null) return compareText(a, b);
  return (
    compareText(left[1] ?? "", right[1] ?? "") ||
    compareDigits(left[2] ?? "", right[2] ?? "") ||
    compareText(a, b)
  );
}

function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+/, "");
  const right = b.replace(/^0+/, "");
  return left.length - right.length || compareText(left, right);
}

function compareTitles(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareText(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Code-unit order, which `<` gives on strings. `localeCompare` is not used:
 * it depends on the machine's locale and ICU version.
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function summarise(
  assertions: readonly ReportAssertion[],
  incomplete: readonly ReportIncomplete[],
): ReportSummary {
  return {
    pass: count(assertions, (one) => one.verdict === "pass"),
    fail: count(assertions, (one) => one.verdict === "fail"),
    needsReview: count(assertions, (one) => one.verdict === "needs-review"),
    failedTest: count(assertions, (one) => one.effect === "failed"),
    incomplete: incomplete.length,
  };
}

function count(
  assertions: readonly ReportAssertion[],
  matches: (one: ReportAssertion) => boolean,
): number {
  return assertions.filter(matches).length;
}
