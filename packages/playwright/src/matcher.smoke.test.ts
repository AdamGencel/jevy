import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JevyReport, ReportAssertion } from "./report/schema.js";

/**
 * A small end-to-end run of the matcher and fixtures: the real Playwright
 * runner, as a child process, on `fixtures/3d-smoke`, with real Chromium,
 * the real `llmDecider` over a scripted adapter, the file run memo and the
 * reporter. No network and no model. It imports the built package, so build
 * before testing. Step 3h's integration test covers the rest.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const PROJECT = join(PACKAGE, "fixtures", "3d-smoke");
const PLAYWRIGHT = join(PACKAGE, "node_modules", ".bin", "playwright");
const SPEC = "tests/smoke.spec.ts";

interface Run {
  readonly code: number;
  readonly output: string;
}

let dir: string;

/** The child's environment: no CI or branch variable from this machine. */
function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CI|CI_.*|GITHUB_.*|JEVY_.*)$/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, FORCE_COLOR: "0", JEVY_SMOKE_DIR: dir, ...extra };
}

function run(
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      PLAYWRIGHT,
      ["test", ...args],
      { cwd: PROJECT, env: childEnv(extra), timeout: 120_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

async function calls(): Promise<readonly string[]> {
  const text = await readFile(join(dir, "calls.log"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string)
    .sort();
}

async function report(): Promise<JevyReport> {
  return JSON.parse(
    await readFile(join(dir, "report.json"), "utf8"),
  ) as JevyReport;
}

async function records(): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(join(dir, "decisions", `${SPEC}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(
  all: readonly ReportAssertion[],
  step: string,
): ReportAssertion | undefined {
  return all.find((one) => one.step === step);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevy-3d-smoke-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("toSatisfy in a real Playwright run", () => {
  it("record: verdicts, a record per passing test, a remembered retry and no record for a failed test", async () => {
    const first = await run([], { CI: "" });
    // The soft-failure test fails on both attempts; everything else passes.
    expect(first.code, first.output).toBe(1);

    expect(await calls()).toEqual([
      "Shows Order confirmed",
      "Shows Order pending",
      "Shows Payment taken",
      "Shows Retry page", // once: the retry used the first attempt's answer
      "Shows Soft page", // once: the soft test's retry used it too
      "Unreachable model", // two attempts, then a DeciderError
      "Unreachable model",
      "Unsure about the order",
    ]);

    const written = await records();
    expect(written.map((one) => [one["step"], one["verdict"]]).sort()).toEqual([
      ["a retry passes on the remembered answer#1", "pass"],
      ["checkout › abstains, twice in one test#1", "needs-review"],
      ["checkout › abstains, twice in one test#2", "pass"],
      ["checkout › fails but is advisory#1", "fail"],
      ["checkout › passes#1", "pass"],
      ["own decider › uses the decider object#1", "pass"],
    ]);
    expect(written.find((one) => one["decider"] === "own")?.["model"]).toBe(
      "own-1",
    );
    expect(JSON.stringify(written)).not.toContain("Continue");
    // The refused spec wrote nothing.
    expect(await readdir(join(dir, "decisions", "tests"))).toEqual([
      "smoke.spec.ts.jsonl",
    ]);

    const { assertions } = await report();
    expect(entry(assertions, "checkout › passes#1")).toMatchObject({
      spec: SPEC,
      project: "chromium",
      test: ["checkout", "passes"],
      verdict: "pass",
      source: "decider",
      missReason: "no-entry",
      mode: "record",
      effect: "none",
      decider: "llm:scripted/smoke-1",
      model: "scripted/smoke-1",
      target: "locator",
    });
    expect(
      entry(assertions, "checkout › fails but is advisory#1"),
    ).toMatchObject({
      verdict: "fail",
      reason: "answered-no",
      effect: "reported",
    });
    expect(
      entry(assertions, "checkout › abstains, twice in one test#1"),
    ).toMatchObject({ verdict: "needs-review", reason: "abstained" });
    expect(
      entry(assertions, "checkout › abstains, twice in one test#2"),
    ).toMatchObject({
      verdict: "pass",
      target: "page",
      statement:
        "Shows Order pending\nCriteria: The heading names the order state",
    });
    expect(
      entry(assertions, "checkout › a decider error is needs-review#1"),
    ).toMatchObject({
      verdict: "needs-review",
      source: "none",
      reason: "decider-error",
      missReason: null,
      answer: null,
      effect: "reported",
    });
    expect(
      entry(assertions, "a retry passes on the remembered answer#1"),
    ).toMatchObject({ verdict: "pass", source: "decider", retry: 1 });
    expect(
      entry(assertions, "a soft failure discards the answer @discard#1"),
    ).toMatchObject({ verdict: "pass", retry: 1 });
    expect(
      entry(assertions, "own decider › uses the decider object#1"),
    ).toMatchObject({ decider: "own", model: "own-1" });
  }, 180_000);

  it("replay: no decider call, answers from the cache, and an advisory fail leaves the exit code at 0", async () => {
    const before = await calls();
    const second = await run(["--grep-invert", "@discard"], { CI: "1" });
    expect(second.code, second.output).toBe(0);
    expect(await calls()).toEqual(before);

    const { assertions } = await report();
    expect(assertions).toHaveLength(7);
    for (const one of assertions) {
      expect(one.mode).toBe("replay");
      if (one.step === "checkout › a decider error is needs-review#1") {
        expect(one).toMatchObject({
          source: "none",
          reason: "no-entry",
          missReason: "no-entry",
        });
      } else {
        expect(one.source, one.step).toBe("cache");
      }
    }
    expect(
      entry(assertions, "checkout › fails but is advisory#1"),
    ).toMatchObject({ verdict: "fail", effect: "reported" });
  }, 180_000);

  it("blocking: a fail fails the test, and in CI on main a needs-review does too", async () => {
    const blocked = await run(["--grep", "checkout"], {
      CI: "1",
      JEVY_SMOKE_BLOCKING: "1",
      JEVY_BRANCH: "main",
    });
    expect(blocked.code, blocked.output).toBe(1);
    const { assertions } = await report();
    expect(
      entry(assertions, "checkout › fails but is advisory#1"),
    ).toMatchObject({ verdict: "fail", effect: "failed" });
    expect(
      entry(assertions, "checkout › a decider error is needs-review#1"),
    ).toMatchObject({ verdict: "needs-review", effect: "failed" });
    expect(entry(assertions, "checkout › passes#1")).toMatchObject({
      effect: "none",
    });
    expect(blocked.output).toContain("toSatisfy: fail (answered-no)");
  }, 180_000);

  it("warns once per worker when Jevy's reporter is not in the run", async () => {
    const plain = await run(
      ["--reporter=list", "--workers=1", "--grep", "checkout"],
      { CI: "1" },
    );
    expect(plain.code, plain.output).toBe(0);
    const warnings = plain.output.match(/no report\.json will be written/g);
    expect(warnings).toHaveLength(1);
  }, 180_000);
});
