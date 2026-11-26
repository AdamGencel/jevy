import { describe, expect, it } from "vitest";
import { buildReport, serialiseReport } from "./build.js";
import type { ReportAttempt } from "./build.js";
import { ReportError, parseReportEntry } from "./schema.js";
import type {
  AttemptStatus,
  JevyReport,
  ReportAssertion,
  RunStatus,
} from "./schema.js";

function entry(overrides: Partial<ReportAssertion> = {}): ReportAssertion {
  return {
    spec: "tests/a.spec.ts",
    project: "chromium",
    test: ["a test"],
    step: "a test#1",
    line: 3,
    statement: "The page is fine",
    target: "locator",
    verdict: "pass",
    source: "decider",
    missReason: null,
    reason: null,
    truncated: false,
    answer: { value: "yes", confidence: 0.9, abstained: false },
    decider: "llm:m",
    model: "m",
    key: `sha256:${"1".repeat(64)}`,
    snapshotHash: `sha256:${"2".repeat(64)}`,
    mode: "record",
    effect: "none",
    retry: 0,
    ...overrides,
  };
}

const failing = {
  verdict: "fail",
  reason: "answered-no",
  answer: { value: "no", confidence: 0.9, abstained: false },
  effect: "reported",
} as const;

const unsure = {
  verdict: "needs-review",
  reason: "low-confidence",
  answer: { value: "yes", confidence: 0.5, abstained: false },
  effect: "reported",
} as const;

const IDENTITY = {
  spec: "tests/a.spec.ts",
  project: "chromium",
  test: ["a test"],
  line: 3,
} as const;

function attempt(
  testId: string,
  retry: number,
  entries: readonly ReportAssertion[],
  status: AttemptStatus = "passed",
  test: ReportAttempt["test"] = IDENTITY,
): ReportAttempt {
  return { testId, retry, status, test, entries };
}

function build(
  attempts: readonly ReportAttempt[],
  status: RunStatus = "passed",
): JevyReport {
  return buildReport(attempts, { status });
}

/** A deterministic shuffle, so the test itself is repeatable. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

describe("buildReport: empty", () => {
  it("writes a report with no assertions and zero counts", () => {
    expect(build([])).toEqual({
      v: 1,
      tool: "jevy-report",
      run: { status: "passed" },
      summary: {
        pass: 0,
        fail: 0,
        needsReview: 0,
        failedTest: 0,
        incomplete: 0,
      },
      assertions: [],
      incomplete: [],
    });
    expect(serialiseReport(build([]))).toBe(
      '{\n  "v": 1,\n  "tool": "jevy-report",\n  "run": {\n    "status": "passed"\n  },\n  "summary": {\n    "pass": 0,\n    "fail": 0,\n    "needsReview": 0,\n    "failedTest": 0,\n    "incomplete": 0\n  },\n  "assertions": [],\n  "incomplete": []\n}\n',
    );
  });

  it("states the run's outcome, so a failed run never looks clean", () => {
    for (const status of [
      "passed",
      "failed",
      "timedout",
      "interrupted",
    ] as const) {
      expect(build([], status).run).toEqual({ status });
    }
  });

  it("refuses a run status Playwright does not have", () => {
    expect(() => build([], "crashed" as RunStatus)).toThrow(ReportError);
  });
});

describe("buildReport: ordering", () => {
  it("sorts by spec, project, test and step, compared by code unit, the step's ordinal by number", () => {
    const entries = [
      entry({ spec: "tests/b.spec.ts" }),
      entry({ spec: "tests/B.spec.ts" }),
      entry({ project: "webkit" }),
      entry({ project: "" }),
      entry({ test: ["a test", "inner"], step: "x#1" }),
      entry({ test: ["Z"], step: "Z#1" }),
      entry({ step: "a test#2" }),
      entry({ step: "a test#10" }),
    ];
    const report = build(
      entries.map((one, i) => attempt(`t${String(i)}`, 0, [one])),
    );
    expect(
      report.assertions.map((one) => [
        one.spec,
        one.project,
        one.test.join("/"),
        one.step,
      ]),
    ).toEqual([
      ["tests/B.spec.ts", "chromium", "a test", "a test#1"],
      ["tests/a.spec.ts", "", "a test", "a test#1"],
      ["tests/a.spec.ts", "chromium", "Z", "Z#1"],
      ["tests/a.spec.ts", "chromium", "a test", "a test#2"],
      ["tests/a.spec.ts", "chromium", "a test", "a test#10"],
      ["tests/a.spec.ts", "chromium", "a test/inner", "x#1"],
      ["tests/a.spec.ts", "webkit", "a test", "a test#1"],
      ["tests/b.spec.ts", "chromium", "a test", "a test#1"],
    ]);
  });

  it("orders steps in call order: the trailing #n compares as a number", () => {
    const steps = ["t#10", "t#2", "t#1", "t#100", "t#9", "t#01", "s#3"];
    const report = build([
      attempt(
        "t",
        0,
        steps.map((step) => entry({ step })),
      ),
    ]);
    expect(report.assertions.map((one) => one.step)).toEqual([
      "s#3",
      "t#01",
      "t#1",
      "t#2",
      "t#9",
      "t#10",
      "t#100",
    ]);
  });

  it("compares ordinals too long for a number exactly", () => {
    const big = "9".repeat(20);
    const bigger = `1${"0".repeat(20)}`;
    const report = build([
      attempt("t", 0, [
        entry({ step: `t#${bigger}` }),
        entry({ step: `t#${big}` }),
        entry({ step: "t#2" }),
      ]),
    ]);
    expect(report.assertions.map((one) => one.step)).toEqual([
      "t#2",
      `t#${big}`,
      `t#${bigger}`,
    ]);
  });

  it("writes byte-identical output for the same attempts in any order", () => {
    const attempts = [
      attempt("t1", 0, [
        entry({ step: "a test#1" }),
        entry({ step: "a test#2", ...failing }),
      ]),
      attempt("t1", 1, [entry({ step: "a test#1", retry: 1 })]),
      attempt("t2", 0, [entry({ spec: "tests/c.spec.ts", ...unsure })]),
      attempt("t3", 0, [
        entry({ project: "firefox" }),
        entry({ project: "firefox", step: "a test#2" }),
      ]),
      attempt("t4", 0, []),
      attempt("t5", 0, [entry({ spec: "tests/d.spec.ts" })]),
      attempt("t5", 1, [], "failed", { ...IDENTITY, spec: "tests/d.spec.ts" }),
      attempt("t6", 0, [], "timedOut", { ...IDENTITY, test: ["b"] }),
      attempt("t7", 0, [], "interrupted", { ...IDENTITY, test: ["b"] }),
    ];
    const expected = serialiseReport(build(attempts));
    expect(JSON.parse(expected)).toMatchObject({
      summary: { incomplete: 4 },
    });
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const reordered = shuffled(attempts, seed).map((one) =>
        attempt(
          one.testId,
          one.retry,
          shuffled(one.entries, seed + 100),
          one.status,
          one.test,
        ),
      );
      expect(serialiseReport(build(reordered))).toBe(expected);
    }
  });

  it("orders entries that tie on every sort key by their full content", () => {
    // `--repeat-each` gives two test ids with the same spec, project, test and step.
    const a = entry({ ...failing, line: 3 });
    const b = entry({ line: 3 });
    const one = serialiseReport(
      build([attempt("r0", 0, [a]), attempt("r1", 0, [b])]),
    );
    const two = serialiseReport(
      build([attempt("r1", 0, [b]), attempt("r0", 0, [a])]),
    );
    expect(one).toBe(two);
  });

  it("writes keys in the documented order whatever order the entry has", () => {
    const reversed = Object.fromEntries(
      Object.entries(entry()).reverse(),
    ) as unknown as ReportAssertion;
    const report = build([attempt("t", 0, [reversed])]);
    const text = serialiseReport(report);
    const parsed = JSON.parse(text) as {
      assertions: Record<string, unknown>[];
    };
    expect(Object.keys(parsed)).toEqual([
      "v",
      "tool",
      "run",
      "summary",
      "assertions",
      "incomplete",
    ]);
    expect(Object.keys(parsed.assertions[0] ?? {})).toEqual(
      Object.keys(entry()),
    );
  });
});

describe("buildReport: retries", () => {
  it("keeps only the last attempt of each test", () => {
    const report = build([
      attempt("t1", 0, [entry({ ...failing })]),
      attempt("t1", 2, [entry({ retry: 2 })]),
      attempt("t1", 1, [entry({ ...unsure, retry: 1 })]),
    ]);
    expect(report.assertions).toEqual([entry({ retry: 2 })]);
    expect(report.summary).toEqual({
      pass: 1,
      fail: 0,
      needsReview: 0,
      failedTest: 0,
      incomplete: 0,
    });
    expect(report.incomplete).toEqual([]);
  });

  it("keeps an empty last attempt: an earlier attempt's entries are dropped", () => {
    const report = build([
      attempt("t1", 0, [entry({ ...failing })]),
      attempt("t1", 1, []),
    ]);
    expect(report.assertions).toEqual([]);
  });

  it("marks a test whose last attempt has fewer entries than an earlier one as incomplete", () => {
    const report = build(
      [
        attempt("t1", 0, [entry({ ...failing }), entry({ step: "a test#2" })]),
        attempt("t1", 1, [], "failed"),
      ],
      "failed",
    );
    expect(report.incomplete).toEqual([
      {
        spec: "tests/a.spec.ts",
        project: "chromium",
        test: ["a test"],
        line: 3,
        retry: 1,
        status: "failed",
        entries: 0,
        entriesInEarlierAttempt: 2,
      },
    ]);
    expect(report.summary.incomplete).toBe(1);
    expect(report.run.status).toBe("failed");
  });

  it("marks it incomplete when the last attempt kept some entries but fewer", () => {
    const report = build([
      attempt("t1", 0, [entry(), entry({ step: "a test#2" })]),
      attempt("t1", 1, [entry({ retry: 1 })], "passed"),
    ]);
    expect(report.assertions).toEqual([entry({ retry: 1 })]);
    expect(report.incomplete).toMatchObject([
      { retry: 1, status: "passed", entries: 1, entriesInEarlierAttempt: 2 },
    ]);
  });

  it("marks a last attempt that timed out or was interrupted as incomplete, with or without entries", () => {
    const report = build(
      [
        attempt("t1", 0, [], "timedOut"),
        attempt("t2", 0, [], "interrupted", { ...IDENTITY, test: ["b"] }),
        attempt("t3", 0, [entry({ test: ["c"], step: "c#1" })], "interrupted", {
          ...IDENTITY,
          test: ["c"],
        }),
      ],
      "interrupted",
    );
    expect(report.incomplete).toEqual([
      {
        ...IDENTITY,
        retry: 0,
        status: "timedOut",
        entries: 0,
        entriesInEarlierAttempt: 0,
      },
      {
        ...IDENTITY,
        test: ["b"],
        retry: 0,
        status: "interrupted",
        entries: 0,
        entriesInEarlierAttempt: 0,
      },
      {
        ...IDENTITY,
        test: ["c"],
        retry: 0,
        status: "interrupted",
        entries: 1,
        entriesInEarlierAttempt: 0,
      },
    ]);
    expect(report.assertions).toHaveLength(1);
    expect(report.summary.incomplete).toBe(3);
  });

  it("does not mark a finished attempt with no entries, or one that kept them all", () => {
    const report = build([
      attempt("t1", 0, [], "passed"),
      attempt("t2", 0, [], "failed"),
      attempt("t3", 0, [], "skipped"),
      attempt("t4", 0, [entry()], "failed"),
      attempt("t4", 1, [entry({ retry: 1 })], "passed"),
    ]);
    expect(report.incomplete).toEqual([]);
  });

  it("refuses an incomplete test whose identity is malformed", () => {
    for (const test of [
      { ...IDENTITY, spec: "/abs/a.spec.ts" },
      { ...IDENTITY, spec: "../a.spec.ts" },
      { ...IDENTITY, test: [] },
      { ...IDENTITY, test: ["d", ""] },
      { ...IDENTITY, line: 0 },
    ]) {
      expect(() => build([attempt("t1", 0, [], "timedOut", test)])).toThrow(
        ReportError,
      );
    }
  });

  it("refuses an attempt status Playwright does not have", () => {
    expect(() =>
      build([attempt("t1", 0, [], "crashed" as AttemptStatus)]),
    ).toThrow(ReportError);
  });

  it("keeps the same test in two projects: they are two tests", () => {
    const report = build([
      attempt("chromium-t", 0, [entry({ project: "chromium" })]),
      attempt("firefox-t", 0, [entry({ project: "firefox", ...failing })]),
    ]);
    expect(report.assertions.map((one) => one.project)).toEqual([
      "chromium",
      "firefox",
    ]);
    expect(report.summary.pass).toBe(1);
    expect(report.summary.fail).toBe(1);
  });

  it("refuses two attempts of one test with the same retry", () => {
    expect(() =>
      build([attempt("t1", 0, [entry()]), attempt("t1", 0, [entry()])]),
    ).toThrow(ReportError);
  });

  it("refuses an entry whose retry is not its attempt's", () => {
    expect(() => build([attempt("t1", 1, [entry({ retry: 0 })])])).toThrow(
      /retry/,
    );
  });

  it("refuses a malformed entry rather than writing it", () => {
    expect(() => build([attempt("t1", 0, [entry({ line: 0 })])])).toThrow(
      ReportError,
    );
  });
});

describe("buildReport: summary", () => {
  it("counts verdicts, and failedTest as the assertions whose effect is failed", () => {
    const report = build([
      attempt("t1", 0, [
        entry({ step: "s#1" }),
        entry({ step: "s#2", ...failing }),
        entry({ step: "s#3", ...failing, effect: "failed" }),
      ]),
      attempt("t2", 0, [
        entry({ spec: "tests/z.spec.ts", ...unsure }),
        entry({
          spec: "tests/z.spec.ts",
          step: "z#2",
          ...unsure,
          effect: "failed",
        }),
        entry({ spec: "tests/z.spec.ts", step: "z#3" }),
      ]),
    ]);
    expect(report.summary).toEqual({
      pass: 2,
      fail: 2,
      needsReview: 2,
      failedTest: 2,
      incomplete: 0,
    });
  });
});

describe("serialiseReport", () => {
  it("writes two-space JSON with a final newline and no timestamps", () => {
    const text = serialiseReport(build([attempt("t", 0, [entry()])]));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain('\n  "summary": {\n    "pass": 1,');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/duration|createdAt|time/i);
  });

  it("writes entries that parse back to themselves", () => {
    const one = entry({ ...unsure });
    const parsed = JSON.parse(
      serialiseReport(build([attempt("t", 0, [one])])),
    ) as { assertions: unknown[] };
    expect(parseReportEntry(JSON.stringify(parsed.assertions[0]))).toEqual(one);
  });
});
