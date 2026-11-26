import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@jevyjs/core";
import type {
  FullConfig,
  FullResult,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReport, serialiseReport } from "./report/build.js";
import { serialiseReportEntry } from "./report/schema.js";
import type { JevyReport, ReportAssertion } from "./report/schema.js";
import JevyReporter, { resolveReportPath, summaryLine } from "./reporter.js";

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

function config(root: string, configFile?: string): FullConfig {
  return {
    rootDir: root,
    ...(configFile !== undefined ? { configFile } : {}),
  } as unknown as FullConfig;
}

/**
 * A test as Playwright passes it: its parent suites run from the innermost
 * describe up through the file and the project to the root.
 */
function testCase(
  id: string,
  project = "chromium",
  file = "/x/tests/a.spec.ts",
  describes: readonly string[] = [],
): TestCase {
  const suite = (type: string, title: string, parent?: object): object => ({
    type,
    title,
    parent,
    project: () => ({ name: project }),
  });
  const root = suite("root", "");
  const projectSuite = suite("project", project, root);
  let parent = suite("file", "tests/a.spec.ts", projectSuite);
  for (const title of describes) parent = suite("describe", title, parent);
  return {
    id,
    title: "a test",
    location: { file, line: 3, column: 1 },
    titlePath: () => ["", project, "tests/a.spec.ts", ...describes, "a test"],
    parent,
  } as unknown as TestCase;
}

type Attachment = TestResult["attachments"][number];

function attachment(body: string, extra: Partial<Attachment> = {}): Attachment {
  return {
    name: "jevy-assertion",
    contentType: "application/json",
    body: Buffer.from(body, "utf8"),
    ...extra,
  };
}

function result(
  retry: number,
  attachments: readonly Attachment[],
  status: TestResult["status"] = "passed",
): TestResult {
  return {
    retry,
    status,
    attachments: [...attachments],
  } as unknown as TestResult;
}

function fullResult(status: FullResult["status"]): FullResult {
  return { status, startTime: new Date(0), duration: 0 };
}

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevy-reporter-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function run(
  reporter: JevyReporter,
  root: string,
  tests: readonly (readonly [TestCase, TestResult])[],
  configFile?: string,
  status: FullResult["status"] = "passed",
): Promise<unknown> {
  reporter.onBegin(config(root, configFile));
  for (const [test, one] of tests) reporter.onTestEnd(test, one);
  return reporter.onEnd(fullResult(status));
}

async function readReport(path: string): Promise<JevyReport> {
  return JSON.parse(await readFile(path, "utf8")) as JevyReport;
}

describe("JevyReporter: writing the report", () => {
  it("writes jevy-report/report.json under the config file's directory", async () => {
    const reporter = new JevyReporter();
    const configDir = join(dir, "app");
    const outcome = await run(
      reporter,
      join(dir, "app", "tests"),
      [
        [
          testCase("t1"),
          result(0, [attachment(serialiseReportEntry(entry()))]),
        ],
      ],
      join(configDir, "playwright.config.ts"),
    );
    expect(outcome).toBeUndefined();
    const text = await readFile(
      join(configDir, "jevy-report", "report.json"),
      "utf8",
    );
    expect(text).toBe(
      serialiseReport(
        buildReport(
          [
            {
              testId: "t1",
              retry: 0,
              status: "passed",
              test: {
                spec: "tests/a.spec.ts",
                project: "chromium",
                test: ["a test"],
                line: 3,
              },
              entries: [entry()],
            },
          ],
          { status: "passed" },
        ),
      ),
    );
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^Jevy: 1 assertion: /);
  });

  it("falls back to rootDir when there is no config file", async () => {
    await run(new JevyReporter(), dir, []);
    expect(existsSync(join(dir, "jevy-report", "report.json"))).toBe(true);
  });

  it("writes an empty report when no test made an assertion", async () => {
    await run(new JevyReporter(), dir, [[testCase("t1"), result(0, [])]]);
    const report = JSON.parse(
      await readFile(join(dir, "jevy-report", "report.json"), "utf8"),
    ) as { assertions: unknown[]; summary: unknown };
    expect(report.assertions).toEqual([]);
    expect(report.summary).toEqual({
      pass: 0,
      fail: 0,
      needsReview: 0,
      failedTest: 0,
      incomplete: 0,
    });
  });

  it("honours outputFile, relative to the Jevy root", async () => {
    await run(new JevyReporter({ outputFile: "out/jevy.json" }), dir, []);
    expect(existsSync(join(dir, "out", "jevy.json"))).toBe(true);
    expect(existsSync(join(dir, "jevy-report"))).toBe(false);
  });

  it("honours a root option over the config file's directory", async () => {
    const root = join(dir, "elsewhere");
    await run(
      new JevyReporter({ root }),
      dir,
      [],
      join(dir, "playwright.config.ts"),
    );
    expect(existsSync(join(root, "jevy-report", "report.json"))).toBe(true);
  });

  it("ignores the options Playwright adds itself", async () => {
    const reporter = new JevyReporter({
      configDir: "/somewhere",
      _mode: "test",
      _commandHash: "abc",
    });
    await run(reporter, dir, []);
    expect(existsSync(join(dir, "jevy-report", "report.json"))).toBe(true);
  });

  it("keeps the last attempt of a retried test", async () => {
    const first = entry({
      verdict: "fail",
      reason: "answered-no",
      answer: { value: "no", confidence: 0.9, abstained: false },
      effect: "failed",
    });
    const second = entry({ retry: 1 });
    await run(new JevyReporter(), dir, [
      [testCase("t1"), result(0, [attachment(serialiseReportEntry(first))])],
      [testCase("t1"), result(1, [attachment(serialiseReportEntry(second))])],
    ]);
    const report = JSON.parse(
      await readFile(join(dir, "jevy-report", "report.json"), "utf8"),
    ) as { assertions: ReportAssertion[] };
    expect(report.assertions).toEqual([second]);
  });

  it("ignores attachments with other names", async () => {
    await run(new JevyReporter(), dir, [
      [
        testCase("t1"),
        result(0, [attachment("not json", { name: "screenshot" })]),
      ],
    ]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain("not written");
  });

  it("prints one summary line with the report's path, on stderr", async () => {
    await run(new JevyReporter(), dir, [
      [testCase("t1"), result(0, [attachment(serialiseReportEntry(entry()))])],
    ]);
    // stdout belongs to reporters such as `--reporter=json`, which print
    // their output there; a line from Jevy would corrupt it.
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("1 pass");
    expect(stderr[0]).toContain(join("jevy-report", "report.json"));
    expect(stderr[0]?.endsWith("\n")).toBe(true);
  });

  it("records the run's outcome from Playwright's result", async () => {
    for (const status of [
      "passed",
      "failed",
      "timedout",
      "interrupted",
    ] as const) {
      await run(new JevyReporter(), dir, [], undefined, status);
      const report = await readReport(join(dir, "jevy-report", "report.json"));
      expect(report.run).toEqual({ status });
    }
  });

  it("keeps a test whose last attempt lost an earlier attempt's entries, as incomplete", async () => {
    const file = join(dir, "tests", "a.spec.ts");
    const first = entry({
      verdict: "needs-review",
      source: "none",
      answer: null,
      missReason: "no-entry",
      reason: "no-entry",
      mode: "replay",
      effect: "reported",
    });
    await run(
      new JevyReporter(),
      dir,
      [
        [
          testCase("t1", "chromium", file, ["checkout"]),
          result(0, [attachment(serialiseReportEntry(first))], "failed"),
        ],
        [
          testCase("t1", "chromium", file, ["checkout"]),
          result(1, [], "failed"),
        ],
      ],
      undefined,
      "failed",
    );
    const report = await readReport(join(dir, "jevy-report", "report.json"));
    expect(report.run.status).toBe("failed");
    expect(report.assertions).toEqual([]);
    expect(report.incomplete).toEqual([
      {
        spec: "tests/a.spec.ts",
        project: "chromium",
        test: ["checkout", "a test"],
        line: 3,
        retry: 1,
        status: "failed",
        entries: 0,
        entriesInEarlierAttempt: 1,
      },
    ]);
    expect(report.summary.incomplete).toBe(1);
    expect(stderr.join("")).toContain("1 incomplete");
  });

  it("keeps a test cut short by a timeout or an interrupt, as incomplete", async () => {
    const file = join(dir, "tests", "a.spec.ts");
    await run(
      new JevyReporter(),
      dir,
      [
        [testCase("t1", "", file), result(0, [], "timedOut")],
        [testCase("t2", "", file, ["b"]), result(0, [], "interrupted")],
      ],
      undefined,
      "interrupted",
    );
    const report = await readReport(join(dir, "jevy-report", "report.json"));
    expect(report.run.status).toBe("interrupted");
    expect(
      report.incomplete.map((one) => [one.project, one.test, one.status]),
    ).toEqual([
      ["", ["a test"], "timedOut"],
      ["", ["b", "a test"], "interrupted"],
    ]);
  });

  it("keeps a test whose end Playwright never reported, as interrupted", async () => {
    // Under a global timeout Playwright 1.63 stops the run without calling
    // onTestEnd for the test that was running; its result still holds the
    // attachments made so far.
    const file = join(dir, "tests", "a.spec.ts");
    const reporter = new JevyReporter();
    reporter.onBegin(config(dir));
    const finished = result(0, [], "passed");
    reporter.onTestBegin(testCase("t1", "chromium", file), finished);
    reporter.onTestEnd(testCase("t1", "chromium", file), finished);
    const running = result(0, [attachment(serialiseReportEntry(entry()))]);
    reporter.onTestBegin(testCase("t2", "chromium", file, ["b"]), running);
    await reporter.onEnd(fullResult("timedout"));
    const report = await readReport(join(dir, "jevy-report", "report.json"));
    expect(report.run.status).toBe("timedout");
    expect(report.assertions).toEqual([entry()]);
    expect(report.incomplete).toEqual([
      {
        spec: "tests/a.spec.ts",
        project: "chromium",
        test: ["b", "a test"],
        line: 3,
        retry: 0,
        status: "interrupted",
        entries: 1,
        entriesInEarlierAttempt: 0,
      },
    ]);
  });

  it("drops anonymous describe titles from an incomplete test", async () => {
    const file = join(dir, "tests", "a.spec.ts");
    await run(new JevyReporter(), dir, [
      [
        testCase("t1", "chromium", file, ["", "inner"]),
        result(0, [], "timedOut"),
      ],
    ]);
    const report = await readReport(join(dir, "jevy-report", "report.json"));
    expect(report.incomplete[0]?.test).toEqual(["inner", "a test"]);
  });

  it("writes nothing and prints nothing under --list", async () => {
    const stale = join(dir, "jevy-report", "report.json");
    await mkdir(join(dir, "jevy-report"), { recursive: true });
    await writeFile(stale, "last run's report");
    await run(new JevyReporter({ _mode: "list" }), dir, [
      [testCase("t1"), result(0, [])],
    ]);
    expect(await readFile(stale, "utf8")).toBe("last run's report");
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("writes through a temporary file, leaving nothing else behind", async () => {
    await run(new JevyReporter(), dir, []);
    expect(await readdir(join(dir, "jevy-report"))).toEqual(["report.json"]);
  });

  it("refuses to write through a symlink at the output path", async () => {
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "precious\n");
    await mkdir(join(dir, "jevy-report"));
    const link = join(dir, "jevy-report", "report.json");
    await symlink(outside, link);
    const outcome = await run(new JevyReporter(), dir, []);
    expect(outcome).toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("precious\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(dir, "jevy-report"))).toEqual(["report.json"]);
    expect(stderr.join("")).toContain("report.json was not written");
    expect(stderr.join("")).toContain("symbolic link");
  });

  it("refuses to write over a directory at the output path", async () => {
    await mkdir(join(dir, "d"));
    await writeFile(join(dir, "d", "keep.txt"), "kept");
    const outcome = await run(new JevyReporter({ outputFile: "d" }), dir, []);
    expect(outcome).toBeUndefined();
    expect(await readFile(join(dir, "d", "keep.txt"), "utf8")).toBe("kept");
    expect(stderr.join("")).toContain("not a regular file");
  });

  it("does not print to stdio as a full reporter, so Playwright keeps its own", () => {
    expect(new JevyReporter().printsToStdio()).toBe(false);
  });
});

describe("JevyReporter: malformed entries fail the report loudly", () => {
  async function expectNoReport(
    tests: readonly (readonly [TestCase, TestResult])[],
    fragment: string,
  ): Promise<void> {
    const stale = join(dir, "jevy-report", "report.json");
    await mkdir(join(dir, "jevy-report"), { recursive: true });
    await writeFile(stale, "stale");
    const outcome = await run(new JevyReporter(), dir, tests);
    expect(outcome).toBeUndefined();
    expect(existsSync(stale)).toBe(false);
    expect(stderr.join("")).toContain("report.json was not written");
    expect(stderr.join("")).toContain(fragment);
  }

  it("refuses an entry that does not parse", async () => {
    await expectNoReport(
      [[testCase("t1"), result(0, [attachment('{"spec":1}')])]],
      "Invalid report entry",
    );
  });

  it("refuses an attachment with no body", async () => {
    await expectNoReport(
      [
        [
          testCase("t1"),
          result(0, [
            {
              name: "jevy-assertion",
              contentType: "application/json",
              path: "/tmp/x",
            },
          ]),
        ],
      ],
      "no body",
    );
  });

  it("refuses an attachment with the wrong content type", async () => {
    await expectNoReport(
      [
        [
          testCase("t1"),
          result(0, [
            attachment(serialiseReportEntry(entry()), {
              contentType: "text/plain",
            }),
          ]),
        ],
      ],
      "application/json",
    );
  });

  it("refuses a body that is not UTF-8", async () => {
    await expectNoReport(
      [
        [
          testCase("t1"),
          result(0, [
            { ...attachment(""), body: Buffer.from([0xff, 0xfe, 0x7b]) },
          ]),
        ],
      ],
      "UTF-8",
    );
  });

  it("refuses an entry whose project is not its test's", async () => {
    await expectNoReport(
      [
        [
          testCase("t1", "firefox"),
          result(0, [attachment(serialiseReportEntry(entry()))]),
        ],
      ],
      "project",
    );
  });

  it("refuses an entry whose retry is not its attempt's", async () => {
    await expectNoReport(
      [
        [
          testCase("t1"),
          result(1, [attachment(serialiseReportEntry(entry()))]),
        ],
      ],
      "retry",
    );
  });

  it("does not delete through a symlink when the report fails", async () => {
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "precious\n");
    await mkdir(join(dir, "jevy-report"));
    const link = join(dir, "jevy-report", "report.json");
    await symlink(outside, link);
    await run(new JevyReporter(), dir, [
      [testCase("t1"), result(0, [attachment('{"spec":1}')])],
    ]);
    expect(await readFile(outside, "utf8")).toBe("precious\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(stderr.join("")).toContain("report.json was not written");
  });

  it("does not echo the attachment's text, which may hold page content", async () => {
    await expectNoReport(
      [[testCase("t1"), result(0, [attachment("secret page text {")])]],
      "not valid JSON",
    );
    expect(stderr.join("")).not.toContain("secret page text");
  });
});

describe("JevyReporter: options", () => {
  it("rejects an outputFile that is not a non-empty string", () => {
    expect(() => new JevyReporter({ outputFile: 3 })).toThrow(ConfigError);
    expect(() => new JevyReporter({ outputFile: "" })).toThrow(ConfigError);
    expect(() => new JevyReporter({ root: false })).toThrow(ConfigError);
  });

  it("rejects options that are not an object", () => {
    expect(() => new JevyReporter("report.json")).toThrow(ConfigError);
  });
});

describe("resolveReportPath", () => {
  it("uses the config file's directory, else rootDir", () => {
    expect(
      resolveReportPath({}, config("/r/tests", "/r/playwright.config.ts")),
    ).toBe(join("/r", "jevy-report", "report.json"));
    expect(resolveReportPath({}, config("/r/tests"))).toBe(
      join("/r/tests", "jevy-report", "report.json"),
    );
  });

  it("keeps an absolute outputFile as it is", () => {
    expect(resolveReportPath({ outputFile: "/abs/r.json" }, config("/r"))).toBe(
      "/abs/r.json",
    );
  });
});

describe("summaryLine", () => {
  it("states the counts and the path relative to the working directory", () => {
    expect(
      summaryLine(
        {
          run: { status: "failed" },
          summary: {
            pass: 2,
            fail: 1,
            needsReview: 3,
            failedTest: 1,
            incomplete: 2,
          },
        },
        "/w/jevy-report/report.json",
        "/w",
      ),
    ).toBe(
      "Jevy: 6 assertions: 2 pass, 1 fail, 3 needs-review; 1 failed its test; 2 incomplete. Run failed. Report: jevy-report/report.json\n",
    );
  });

  it("keeps an absolute path outside the working directory", () => {
    expect(
      summaryLine(
        {
          run: { status: "passed" },
          summary: {
            pass: 1,
            fail: 0,
            needsReview: 0,
            failedTest: 0,
            incomplete: 0,
          },
        },
        "/elsewhere/report.json",
        "/w",
      ),
    ).toBe(
      "Jevy: 1 assertion: 1 pass, 0 fail, 0 needs-review; 0 failed its test; 0 incomplete. Run passed. Report: /elsewhere/report.json\n",
    );
  });
});
