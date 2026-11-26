import { execFile, execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { CacheMode } from "@jevyjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReportEntry } from "./report/schema.js";
import type { JevyReport, Reason, ReportAssertion } from "./report/schema.js";

/**
 * Roadmap step 3's "Done when", end to end: the real Playwright runner, as a
 * child process, on `fixtures/step-3`, with real Chromium, the matcher and
 * fixtures, the real `llmDecider` over a scripted adapter (see the fixture's
 * `jevy.config.ts`), the file run memo, the decision store and the
 * reporter; and the built `jevy guard` on the same files. Pages are served
 * from `127.0.0.1`. No other network and no model. Build before testing.
 *
 * The runs share one directory and build on each other, so the cases run
 * in order.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const PROJECT = join(PACKAGE, "fixtures", "step-3");
/** The same project with `toSatisfy.blocking: true`. */
const BLOCKING_PROJECT = join(PROJECT, "blocking");
const PLAYWRIGHT = join(PACKAGE, "node_modules", ".bin", "playwright");
const GUARD = join(PACKAGE, "..", "cli", "dist", "bin.js");

/** A page string no statement uses: it must never reach a record or the report. */
const PAGE_ONLY_TEXT = "QX-7731-PELICAN";

const CONFIRMED = "orders › a confirmed order#1";
const PENDING = "orders › a pending order#1";
const BRAND = "orders › the brand colour#1";
const RETRIED = "a retried test asks once#1";

const RUN_TIMEOUT = { timeout: 120_000 };

let dir = "";
let server: Server | undefined;
let baseUrl = "";
/** Serve the confirmed page with its link moved, for the changed-page run. */
let linkMoved = false;

interface Run {
  readonly code: number;
  readonly stdout: string;
  /** Standard output and standard error, for failure messages. */
  readonly output: string;
}

/** The child's environment: no CI, branch or Jevy variable from this machine. */
function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CI|CI_.*|GITHUB_.*|JEVY_.*)$/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    FORCE_COLOR: "0",
    JEVY_STEP3_DIR: dir,
    JEVY_STEP3_URL: baseUrl,
    ...extra,
  };
}

/** Run a program to its end; never rejects. */
function exec(
  file: string,
  args: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>>,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env: childEnv(extra), timeout: 110_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/**
 * Run `playwright test` in `project`, then keep the report under `name` so
 * later cases can read it.
 */
async function runAndKeep(
  name: string,
  extra: Readonly<Record<string, string>>,
  project: string = PROJECT,
): Promise<Run> {
  const result = await exec(PLAYWRIGHT, ["test"], project, extra);
  await copyFile(join(dir, "report.json"), join(dir, `${name}.json`));
  return result;
}

/** Every decider call so far, sorted, as the scripted adapter logged them. */
async function calls(): Promise<readonly string[]> {
  const text = await readFile(join(dir, "calls.log"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .sort();
}

function call(statement: string, value: string): string {
  return JSON.stringify({ statement, value });
}

/** The raw text of every decision file, by path under the cache directory. */
async function decisionFiles(): Promise<ReadonlyMap<string, string>> {
  const root = join(dir, "decisions");
  const names = await readdir(root, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path.slice(root.length + 1), await readFile(path, "utf8"));
  }
  return files;
}

function recordsOf(
  files: ReadonlyMap<string, string>,
): readonly Readonly<Record<string, unknown>>[] {
  return [...files.values()].flatMap((text) =>
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>),
  );
}

/**
 * Read a kept report and check it against the v1 contract: the top-level
 * keys in order, every entry accepted by the reporter's own validator with
 * its keys in order, a summary that agrees with the entries, and two-space
 * JSON with a final newline.
 */
async function report(name: string): Promise<JevyReport> {
  const text = await readFile(join(dir, `${name}.json`), "utf8");
  const parsed = JSON.parse(text) as JevyReport;
  expect(Object.keys(parsed)).toEqual([
    "v",
    "tool",
    "run",
    "summary",
    "assertions",
    "incomplete",
  ]);
  expect(parsed.v).toBe(1);
  expect(parsed.tool).toBe("jevy-report");
  for (const entry of parsed.assertions) {
    expect(JSON.stringify(validateReportEntry(entry))).toBe(
      JSON.stringify(entry),
    );
  }
  const count = (verdict: ReportAssertion["verdict"]): number =>
    parsed.assertions.filter((one) => one.verdict === verdict).length;
  expect(parsed.summary).toEqual({
    pass: count("pass"),
    fail: count("fail"),
    needsReview: count("needs-review"),
    failedTest: parsed.assertions.filter((one) => one.effect === "failed")
      .length,
    incomplete: parsed.incomplete.length,
  });
  expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

function entry(all: JevyReport, step: string): ReportAssertion | undefined {
  return all.assertions.find((one) => one.step === step);
}

/** What a replay of a recorded run may change in an entry. */
const REPLAY_FIELDS: readonly string[] = ["source", "mode", "missReason"];

/** The report with the fields a replay may change taken out. */
function withoutReplayFields(all: JevyReport): unknown {
  return {
    ...all,
    assertions: all.assertions.map((one) =>
      Object.fromEntries(
        Object.entries(one).filter(([key]) => !REPLAY_FIELDS.includes(key)),
      ),
    ),
  };
}

/** Playwright's own JSON reporter output, as far as it is read here. */
interface JsonSuite {
  readonly suites?: readonly JsonSuite[];
  readonly specs?: readonly {
    readonly title: string;
    readonly tests: readonly {
      readonly status: string;
      readonly results: readonly { readonly status: string }[];
    }[];
  }[];
}

/** How each test ended, by title: its outcome, then each attempt's status. */
async function testStatuses(): Promise<
  Readonly<Record<string, readonly string[]>>
> {
  const results = JSON.parse(
    await readFile(join(dir, "results.json"), "utf8"),
  ) as JsonSuite;
  const statuses: Record<string, readonly string[]> = {};
  const walk = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      statuses[spec.title] = spec.tests.flatMap((one) => [
        one.status,
        ...one.results.map((attempt) => attempt.status),
      ]);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  walk(results);
  return statuses;
}

// ---------------------------------------------------------------------------
// An agent acting on report.json alone.

type NextAction =
  | "record locally"
  | "review a changed page"
  | "fix the app or the statement"
  | "hand to a person";

interface AgentTask {
  readonly action: NextAction;
  readonly spec: string;
  readonly line: number;
  /** Null for an incomplete test, which has no single statement. */
  readonly statement: string | null;
}

/**
 * The next action for one non-pass entry, from its reason and mode only.
 *
 * - A replay miss because nothing matching was recorded, or because the
 *   rules or the model changed since: run the spec locally, outside CI, so
 *   it is recorded, and commit the records.
 * - A replay miss on a changed page: someone must look at the new page and
 *   approve or re-record it.
 * - A decider that answered no, or a person who said fail: the app is wrong,
 *   or the statement is.
 * - Everything the decider could not settle (abstained, low confidence, a
 *   cut snapshot, a hit re-gated below the threshold): a person decides.
 * - A decider that could not be reached: try again locally.
 *
 * A miss reason outside `replay` contradicts core (only a replay misses), so
 * it goes to a person rather than being guessed at.
 */
function actionFor(reason: Reason, mode: CacheMode): NextAction {
  switch (reason) {
    case "no-entry":
    case "model-changed":
    case "redaction-changed":
      return mode === "replay" ? "record locally" : "hand to a person";
    case "snapshot-changed":
      return mode === "replay" ? "review a changed page" : "hand to a person";
    case "answered-no":
    case "reviewed":
      return "fix the app or the statement";
    case "abstained":
    case "low-confidence":
    case "truncated":
    case "regated-below-threshold":
      return "hand to a person";
    case "decider-error":
      return "record locally";
    default: {
      const unknown: never = reason;
      throw new Error(`No action for reason ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * What an agent does after a run, reading `report.json` and nothing else:
 * one task per non-pass entry and per incomplete test. A test cut short may
 * have lost assertions the report cannot name, so a person looks at it.
 */
async function agentTasks(reportPath: string): Promise<readonly AgentTask[]> {
  const parsed = JSON.parse(await readFile(reportPath, "utf8")) as JevyReport;
  const tasks: AgentTask[] = [];
  for (const one of parsed.assertions) {
    if (one.verdict === "pass") continue;
    if (one.reason === null) {
      throw new Error(`A ${one.verdict} at ${one.step} has no reason`);
    }
    tasks.push({
      action: actionFor(one.reason, one.mode),
      spec: one.spec,
      line: one.line,
      statement: one.statement,
    });
  }
  for (const one of parsed.incomplete) {
    tasks.push({
      action: "hand to a person",
      spec: one.spec,
      line: one.line,
      statement: null,
    });
  }
  return tasks;
}

/** Every reason report.json v1 can give; the type check keeps it complete. */
const ALL_REASONS = [
  "no-entry",
  "snapshot-changed",
  "model-changed",
  "redaction-changed",
  "regated-below-threshold",
  "abstained",
  "low-confidence",
  "truncated",
  "decider-error",
  "answered-no",
  "reviewed",
] as const satisfies readonly Reason[];
const reasonsComplete: [Exclude<Reason, (typeof ALL_REASONS)[number]>] extends [
  never,
]
  ? true
  : false = true;

// ---------------------------------------------------------------------------

async function page(name: string): Promise<string> {
  return readFile(join(PROJECT, "pages", `${name}.html`), "utf8");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevy-step-3-"));
  const pages: Readonly<Record<string, string>> = {
    confirmed: await page("confirmed"),
    "confirmed-moved": await page("confirmed-moved"),
    pending: await page("pending"),
    receipt: await page("receipt"),
  };
  const listening = createServer((request, response) => {
    const path = (request.url ?? "/").slice(1);
    const name = path === "confirmed" && linkMoved ? "confirmed-moved" : path;
    const body = Object.hasOwn(pages, name) ? pages[name] : undefined;
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    listening.listen(0, "127.0.0.1", resolve);
  });
  server = listening;
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

describe("step 3: toSatisfy end to end", () => {
  it(
    "run 1, record: a pass, a fail and a needs-review, exit code 0, one record each and no page text",
    RUN_TIMEOUT,
    async () => {
      const first = await runAndKeep("record", { CI: "" });
      expect(first.code, first.output).toBe(0);

      // The retried test asked once across its two attempts.
      expect(await calls()).toEqual(
        [
          call('The page shows "Order confirmed"', "yes"),
          call('The page shows "Payment taken"', "no"),
          call("The logo is the brand's shade of blue", "inconclusive"),
          call('The page shows "Receipt sent"', "yes"),
        ].sort(),
      );

      const recorded = await report("record");
      expect(recorded.run.status).toBe("passed");
      expect(recorded.summary).toEqual({
        pass: 2,
        fail: 1,
        needsReview: 1,
        failedTest: 0,
        incomplete: 0,
      });
      const common = {
        project: "chromium",
        source: "decider",
        missReason: "no-entry",
        mode: "record",
        decider: "llm:scripted/step-3",
        model: "scripted/step-3",
        target: "locator",
      };
      expect(entry(recorded, CONFIRMED)).toMatchObject({
        ...common,
        spec: "tests/orders.spec.ts",
        test: ["orders", "a confirmed order"],
        statement: 'The page shows "Order confirmed"',
        verdict: "pass",
        reason: null,
        answer: { value: "yes", confidence: 0.95, abstained: false },
        effect: "none",
        retry: 0,
      });
      expect(entry(recorded, PENDING)).toMatchObject({
        ...common,
        verdict: "fail",
        reason: "answered-no",
        answer: { value: "no", confidence: 0.95, abstained: false },
        effect: "reported",
      });
      expect(entry(recorded, BRAND)).toMatchObject({
        ...common,
        verdict: "needs-review",
        reason: "abstained",
        answer: { abstained: true },
        effect: "reported",
      });
      expect(entry(recorded, RETRIED)).toMatchObject({
        ...common,
        spec: "tests/retry.spec.ts",
        verdict: "pass",
        effect: "none",
        retry: 1,
      });

      // One record per assertion, the same keys as the report, and no page
      // text: only statements, hashes and answers.
      const files = await decisionFiles();
      expect([...files.keys()].sort()).toEqual([
        "tests/orders.spec.ts.jsonl",
        "tests/retry.spec.ts.jsonl",
      ]);
      const records = recordsOf(files);
      expect(
        records.map((one) => [one["step"], one["verdict"]]).sort(),
      ).toEqual(
        [
          [RETRIED, "pass"],
          [CONFIRMED, "pass"],
          [PENDING, "fail"],
          [BRAND, "needs-review"],
        ].sort(),
      );
      expect(records.map((one) => one["key"]).sort()).toEqual(
        recorded.assertions.map((one) => one.key).sort(),
      );
      for (const text of [...files.values(), JSON.stringify(recorded)]) {
        expect(text).not.toContain(PAGE_ONLY_TEXT);
        expect(text).not.toContain("View your order");
        expect(text).not.toContain("/orders/pelican");
      }
    },
  );

  it(
    "run 2, replay: no decider call, every source cache, and only source, mode and missReason differ",
    RUN_TIMEOUT,
    async () => {
      const before = await calls();
      const second = await runAndKeep("replay", { CI: "1" });
      expect(second.code, second.output).toBe(0);
      expect(await calls()).toEqual(before);

      const recorded = await report("record");
      const replayed = await report("replay");
      for (const one of replayed.assertions) {
        expect(one, one.step).toMatchObject({
          source: "cache",
          mode: "replay",
          missReason: null,
        });
      }
      expect(withoutReplayFields(replayed)).toEqual(
        withoutReplayFields(recorded),
      );
    },
  );

  it("replay twice: byte-identical report.json", RUN_TIMEOUT, async () => {
    const again = await runAndKeep("replay-again", { CI: "1" });
    expect(again.code, again.output).toBe(0);
    expect(await readFile(join(dir, "replay-again.json"), "utf8")).toBe(
      await readFile(join(dir, "replay.json"), "utf8"),
    );
  });

  it(
    "a changed page in replay: a moved link is needs-review, snapshot-changed, and no call",
    RUN_TIMEOUT,
    async () => {
      const before = await calls();
      linkMoved = true;
      let changed: Run;
      try {
        changed = await runAndKeep("changed", { CI: "1" });
      } finally {
        linkMoved = false;
      }
      expect(changed.code, changed.output).toBe(0);
      expect(await calls()).toEqual(before);

      const replayed = await report("replay");
      const moved = await report("changed");
      expect(entry(moved, CONFIRMED)).toMatchObject({
        verdict: "needs-review",
        source: "none",
        missReason: "snapshot-changed",
        reason: "snapshot-changed",
        answer: null,
        effect: "reported",
      });
      // Only the link's URL changed, and it changed the hash.
      expect(entry(moved, CONFIRMED)?.snapshotHash).not.toBe(
        entry(replayed, CONFIRMED)?.snapshotHash,
      );
      for (const step of [PENDING, BRAND, RETRIED]) {
        expect(entry(moved, step), step).toEqual(entry(replayed, step));
      }
    },
  );

  it("a retry: one decider call across both attempts and one record, written by the retry", async () => {
    // From run 1's call log, records and report, checked on their own here.
    const retried = (await calls()).filter((line) =>
      line.includes("Receipt sent"),
    );
    expect(retried).toHaveLength(1);
    const records = recordsOf(await decisionFiles()).filter(
      (one) => one["spec"] === "tests/retry.spec.ts",
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ step: RETRIED, verdict: "pass" });
    // The first attempt failed after asking; the retry passed and wrote it.
    expect(entry(await report("record"), RETRIED)).toMatchObject({
      retry: 1,
      source: "decider",
    });
  });

  it(
    "blocking on: the fail fails the run, keeps its record, and fails a CI replay the same way",
    RUN_TIMEOUT,
    async () => {
      // blocking/ runs the orders pass and fail under a config that turns
      // blocking on, in record mode with its own cache directory.
      const cache = join(dir, "blocking-decisions");
      const blocked = await runAndKeep(
        "blocking",
        { CI: "", JEVY_STEP3_CACHE: cache },
        BLOCKING_PROJECT,
      );
      expect(blocked.code, blocked.output).toBe(1);
      expect(blocked.output).toContain("toSatisfy: fail (answered-no)");
      expect(await testStatuses()).toEqual({
        "a confirmed order": ["expected", "passed"],
        "a pending order": ["unexpected", "failed", "failed"],
      });

      const blocking = await report("blocking");
      expect(blocking.run.status).toBe("failed");
      expect(entry(blocking, "blocking › a confirmed order#1")).toMatchObject({
        spec: "tests/blocking.spec.ts",
        verdict: "pass",
        effect: "none",
      });
      expect(entry(blocking, "blocking › a pending order#1")).toMatchObject({
        verdict: "fail",
        reason: "answered-no",
        effect: "failed",
        retry: 1,
      });
      expect(blocking.summary.failedTest).toBe(1);
      // Both answers are kept: the pass, and the "no" that failed its test
      // on a blocking check and nothing else, so a replay fails the same way
      // until a person reviews it. The retry drew no second record.
      const kept = await readFile(
        join(cache, "tests", "blocking.spec.ts.jsonl"),
        "utf8",
      );
      expect(
        kept
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => (JSON.parse(line) as { step: string }).step)
          .sort(),
      ).toEqual([
        "blocking › a confirmed order#1",
        "blocking › a pending order#1",
      ]);

      // A replay of that run in CI fails the run the same way, with no call.
      const before = await calls();
      const replayed = await runAndKeep(
        "blocking-replay",
        { CI: "1", JEVY_STEP3_CACHE: cache },
        BLOCKING_PROJECT,
      );
      expect(replayed.code, replayed.output).toBe(1);
      expect(await calls()).toEqual(before);
      expect(await testStatuses()).toEqual({
        "a confirmed order": ["expected", "passed"],
        "a pending order": ["unexpected", "failed", "failed"],
      });
      const replay = await report("blocking-replay");
      expect(entry(replay, "blocking › a pending order#1")).toMatchObject({
        verdict: "fail",
        source: "cache",
        reason: "answered-no",
        effect: "failed",
      });
      expect(entry(replay, "blocking › a confirmed order#1")).toMatchObject({
        verdict: "pass",
        source: "cache",
      });
    },
  );

  it(
    "an agent acts on report.json alone: one next action for every non-pass entry",
    RUN_TIMEOUT,
    async () => {
      // A fresh clone in CI: nothing recorded yet, so every step misses.
      const empty = join(dir, "empty-cache");
      await mkdir(empty);
      const fresh = await runAndKeep("fresh", {
        CI: "1",
        JEVY_STEP3_CACHE: empty,
      });
      expect(fresh.code, fresh.output).toBe(0);

      const orders = "tests/orders.spec.ts";
      const brand = {
        action: "hand to a person",
        spec: orders,
        line: 22,
        statement: "The logo is the brand's shade of blue",
      };
      const pending = {
        action: "fix the app or the statement",
        spec: orders,
        line: 14,
        statement: 'The page shows "Payment taken"',
      };
      const confirmed = {
        spec: orders,
        line: 7,
        statement: 'The page shows "Order confirmed"',
      };
      const retried = {
        spec: "tests/retry.spec.ts",
        line: 6,
        statement: 'The page shows "Receipt sent"',
      };
      expect(await agentTasks(join(dir, "record.json"))).toEqual([
        pending,
        brand,
      ]);
      expect(await agentTasks(join(dir, "changed.json"))).toEqual([
        { ...confirmed, action: "review a changed page" },
        pending,
        brand,
      ]);
      expect(await agentTasks(join(dir, "fresh.json"))).toEqual(
        [confirmed, pending, brand, retried].map((one) => ({
          action: "record locally",
          spec: one.spec,
          line: one.line,
          statement: one.statement,
        })),
      );

      // Every reason the report can give, and an incomplete test, gets exactly
      // one action: one task per non-pass entry and per incomplete test.
      expect(reasonsComplete).toBe(true);
      const base = entry(await report("record"), PENDING);
      if (base === undefined) throw new Error("run 1 has no pending entry");
      const every: JevyReport = {
        v: 1,
        tool: "jevy-report",
        run: { status: "timedout" },
        summary: {
          pass: 0,
          fail: 0,
          needsReview: ALL_REASONS.length,
          failedTest: 0,
          incomplete: 1,
        },
        assertions: ALL_REASONS.map((reason, index) => ({
          ...base,
          step: `every reason#${String(index + 1)}`,
          verdict: "needs-review",
          reason,
          mode: "replay",
        })),
        incomplete: [
          {
            spec: orders,
            project: "chromium",
            test: ["orders", "a confirmed order"],
            line: 7,
            retry: 1,
            status: "timedOut",
            entries: 0,
            entriesInEarlierAttempt: 1,
          },
        ],
      };
      await writeFile(join(dir, "every.json"), JSON.stringify(every));
      const tasks = await agentTasks(join(dir, "every.json"));
      expect(tasks).toHaveLength(ALL_REASONS.length + 1);
      expect(tasks.at(-1)).toEqual({
        action: "hand to a person",
        spec: orders,
        line: 7,
        statement: null,
      });
    },
  );

  it(
    "the guard reports the judgement-only spec as only-advisory-assertions",
    RUN_TIMEOUT,
    async () => {
      const repo = await mkdtemp(join(tmpdir(), "jevy-step-3-guard-"));
      try {
        const git = (...args: string[]): string =>
          execFileSync(
            "git",
            [
              "-c",
              "user.name=Jevy Test",
              "-c",
              "user.email=jevy-test@example.invalid",
              "-c",
              "commit.gpgsign=false",
              ...args,
            ],
            { cwd: repo, encoding: "utf8" },
          );
        git("init", "-q", "-b", "main");
        await mkdir(join(repo, "pages"));
        await mkdir(join(repo, "tests"));
        for (const file of [
          "playwright.config.ts",
          "jevy.config.ts",
          "scripted-adapter.ts",
          "pages/confirmed.html",
        ]) {
          await copyFile(join(PROJECT, file), join(repo, file));
        }
        git("add", "-A");
        git("commit", "-q", "-m", "base: the project without its specs");
        const base = git("rev-parse", "HEAD").trim();
        // Head, in the working tree: both specs added.
        for (const file of ["tests/orders.spec.ts", "tests/retry.spec.ts"]) {
          await copyFile(join(PROJECT, file), join(repo, file));
        }

        // cache.dir is read from the environment, which the guard does not
        // run, so it is named here as the guard asks.
        const guard = await exec(
          process.execPath,
          [
            GUARD,
            "guard",
            "--base",
            base,
            "--json",
            "--cache-dir",
            "decisions",
          ],
          repo,
          {},
        );
        // A review finding, so the default --fail-on weakening exits 0.
        expect(guard.code, guard.output).toBe(0);
        const found = JSON.parse(guard.stdout) as {
          readonly findings: readonly {
            readonly kind: string;
            readonly file: string;
            readonly test?: readonly string[];
          }[];
        };
        const kinds = (kind: string): readonly (readonly string[])[] =>
          found.findings
            .filter((one) => one.kind === kind)
            .map((one) => [one.file, ...(one.test ?? [])]);
        // Every test in the judgement-only spec; none in retry.spec.ts, whose
        // exact assertion can fail the build.
        expect(kinds("only-advisory-assertions"), guard.output).toEqual([
          ["tests/orders.spec.ts", "orders", "a confirmed order"],
          ["tests/orders.spec.ts", "orders", "a pending order"],
          ["tests/orders.spec.ts", "orders", "the brand colour"],
        ]);
        expect(kinds("test-added"), guard.output).toContainEqual([
          "tests/retry.spec.ts",
          "a retried test asks once",
        ]);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    },
  );
});
