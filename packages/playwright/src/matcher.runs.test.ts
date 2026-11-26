import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JevyReport, ReportAssertion } from "./report/schema.js";

/**
 * The matcher and fixtures in real Playwright runs, as child processes, on
 * `fixtures/3d-runs` and `fixtures/3d-cjs`: real Chromium, the real
 * `llmDecider` over a scripted adapter, the file run memo, the store and the
 * reporter. Each case is something that only shows in a real run. No
 * network and no model. It imports the built packages, so build first.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const RUNS = join(PACKAGE, "fixtures", "3d-runs");
const CJS = join(PACKAGE, "fixtures", "3d-cjs");
const PLAYWRIGHT = join(PACKAGE, "node_modules", ".bin", "playwright");

const TIMEOUT = { timeout: 150_000 };

interface Run {
  readonly code: number;
  readonly output: string;
}

interface Call {
  readonly statement: string;
  readonly leak?: boolean;
  readonly decider?: string;
}

const dirs: string[] = [];

async function freshDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `jevy-3d-${name}-`));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** The child's environment: no CI, branch or Jevy variable from this machine. */
function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CI|CI_.*|GITHUB_.*|JEVY_.*)$/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, FORCE_COLOR: "0", CI: "", ...extra };
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
      { cwd, env: childEnv(extra), timeout: 140_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** `playwright test` on the runs project, writing under `dir`. */
function runs(
  dir: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<Run> {
  return exec(PLAYWRIGHT, ["test", ...args], RUNS, {
    JEVY_RUNS_DIR: dir,
    ...extra,
  });
}

async function calls(dir: string): Promise<readonly Call[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "calls.log"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
}

async function statements(dir: string): Promise<readonly string[]> {
  return (await calls(dir)).map((one) => one.statement).sort();
}

/** The steps of the records written for one spec, sorted. */
async function recordedSteps(
  dir: string,
  spec: string,
): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "decisions", `${spec}.jsonl`), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { readonly step: string }).step)
    .sort();
}

async function report(dir: string): Promise<JevyReport> {
  return JSON.parse(
    await readFile(join(dir, "report.json"), "utf8"),
  ) as JevyReport;
}

function entry(all: JevyReport, step: string): ReportAssertion | undefined {
  return all.assertions.find((one) => one.step === step);
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

/** Each test's attempt statuses, by title. */
async function testStatuses(
  dir: string,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const results = JSON.parse(
    await readFile(join(dir, "results.json"), "utf8"),
  ) as JsonSuite;
  const statuses: Record<string, readonly string[]> = {};
  const walk = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      statuses[spec.title] = spec.tests.flatMap((one) =>
        one.results.map((attempt) => attempt.status),
      );
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  walk(results);
  return statuses;
}

describe("one record run of contexts, statuses, hooks and timeouts", () => {
  let dir = "";
  let run: Run = { code: -1, output: "" };

  beforeAll(async () => {
    dir = await freshDir("record");
    run = await runs(dir, [
      "tests/contexts.spec.ts",
      "tests/status.spec.ts",
      "tests/hooks.spec.ts",
      "tests/timeout.spec.ts",
    ]);
  }, 150_000);

  it("ends with exit code 0", () => {
    expect(run.code, run.output).toBe(0);
  });

  it("no prompt holds a secret, whichever way the test opened its page", async () => {
    const asked = (await calls(dir)).filter((one) =>
      /^Shows (fixture page|own context|own page)$/.test(one.statement),
    );
    expect(asked.map((one) => one.statement).sort()).toEqual([
      "Shows fixture page",
      "Shows own context",
      "Shows own page",
    ]);
    for (const one of asked)
      expect(one, one.statement).toMatchObject({ leak: false });
  });

  it("only a test that passed saves its answer", async () => {
    expect(await recordedSteps(dir, "tests/status.spec.ts")).toEqual([
      "a passing test keeps its answer#1",
    ]);
    expect(await testStatuses(dir)).toMatchObject({
      "a passing test keeps its answer": ["passed"],
      "an expected failure discards its answer": ["failed"],
      "a skip after the check discards its answer": ["skipped"],
      "a fixme after the check discards its answer": ["skipped"],
    });
  });

  it("toSatisfy in a beforeAll hook says hooks are not supported", async () => {
    expect(await testStatuses(dir)).toMatchObject({
      "toSatisfy in beforeAll names the hook": ["passed"],
    });
  });

  it("with too little time left, no call: needs-review at once, not a Playwright timeout", async () => {
    expect(await testStatuses(dir)).toMatchObject({
      "a late call to a slow model": ["passed"],
      "a short timeout and a slow model": ["passed"],
    });
    const all = await report(dir);
    for (const step of [
      "a late call to a slow model#1",
      "a short timeout and a slow model#1",
    ]) {
      expect(entry(all, step), step).toMatchObject({
        verdict: "needs-review",
        source: "none",
        reason: "decider-error",
      });
    }
    const slow = (await statements(dir)).filter((one) =>
      one.startsWith("Slow 8000"),
    );
    expect(slow).toEqual([]);
  });
});

describe("runs that need one each", () => {
  it(
    "four workers asking one question at once: one call and one record",
    TIMEOUT,
    async () => {
      const dir = await freshDir("duplicate");
      const run = await runs(dir, ["tests/duplicate.spec.ts"]);
      expect(run.code, run.output).toBe(0);
      expect(await statements(dir)).toEqual(["Slow 300 Shows Nu"]);
      expect(await recordedSteps(dir, "tests/duplicate.spec.ts")).toHaveLength(
        1,
      );
    },
  );

  it(
    "two runs by one runner, as UI and watch mode do: each run asks again",
    TIMEOUT,
    async () => {
      const dir = await freshDir("twice");
      const run = await exec(
        process.execPath,
        [join(RUNS, "ui-twice.ts"), join(RUNS, "playwright.config.ts")],
        RUNS,
        { JEVY_RUNS_DIR: dir },
      );
      expect(run.code, run.output).toBe(0);
      expect(run.output).toContain('{"statuses":["passed","passed"]}');
      expect(await statements(dir)).toEqual(["Shows Mu", "Shows Mu"]);
    },
  );

  it(
    "blocking: only a failure that is a blocking no keeps answers, and only those drawn up to it",
    TIMEOUT,
    async () => {
      const dir = await freshDir("blocking");
      const run = await runs(dir, ["tests/blocking.spec.ts"], {
        JEVY_RUNS_BLOCKING: "1",
      });
      expect(run.code, run.output).toBe(1);
      expect(await testStatuses(dir)).toEqual({
        "a blocking fail keeps its answer": ["failed"],
        "a blocking fail and an exact failure": ["failed"],
        "a pass and an exact failure": ["failed"],
        "a soft blocking fail between two passes": ["failed"],
      });
      expect(await recordedSteps(dir, "tests/blocking.spec.ts")).toEqual([
        "a blocking fail keeps its answer#1",
        "a soft blocking fail between two passes#1",
        "a soft blocking fail between two passes#2",
      ]);

      // A replay in CI fails the same tests the same way, with no call.
      const before = await statements(dir);
      const replay = await runs(dir, ["tests/blocking.spec.ts"], {
        JEVY_RUNS_BLOCKING: "1",
        CI: "1",
      });
      expect(replay.code, replay.output).toBe(1);
      expect(await statements(dir)).toEqual(before);
      const replayed = await report(dir);
      expect(
        entry(replayed, "a blocking fail keeps its answer#1"),
      ).toMatchObject({ source: "cache", verdict: "fail", effect: "failed" });
    },
  );

  it(
    "a spec outside the Jevy root is refused with a message naming the root",
    TIMEOUT,
    async () => {
      const dir = await freshDir("outside");
      const run = await exec(
        PLAYWRIGHT,
        ["test", "--config", "outside/playwright.config.ts", "root.spec.ts"],
        RUNS,
        { JEVY_RUNS_DIR: dir },
      );
      expect(run.code, run.output).toBe(0);
    },
  );

  it(
    "a CommonJS project imports the packages and its jevy.config.ts loads",
    TIMEOUT,
    async () => {
      const dir = await freshDir("cjs");
      const project = join(dir, "project");
      await cp(CJS, project, { recursive: true });
      // Jevy's packages as an install puts them: copies under node_modules.
      // A link to the workspace would not do, because Playwright compiles
      // every file outside node_modules as the project's own code.
      const modules = join(project, "node_modules");
      for (const name of ["playwright", "core", "deciders-llm"]) {
        const from = join(PACKAGE, "..", name);
        const to = join(modules, "@jevyjs", name);
        await mkdir(to, { recursive: true });
        await cp(join(from, "package.json"), join(to, "package.json"));
        await cp(join(from, "dist"), join(to, "dist"), { recursive: true });
      }
      await mkdir(join(modules, "@playwright"), { recursive: true });
      const link = async (from: string, to: string): Promise<void> => {
        await symlink(await realpath(from), to, "junction");
      };
      await link(
        join(PACKAGE, "node_modules", "@playwright", "test"),
        join(modules, "@playwright", "test"),
      );
      await link(join(PACKAGE, "node_modules", "yaml"), join(modules, "yaml"));

      const run = await exec(PLAYWRIGHT, ["test"], project, {
        JEVY_CJS_DIR: dir,
      });
      expect(run.code, run.output).toBe(0);
      expect(await calls(dir)).toEqual([
        {
          statement: "Shows Order confirmed",
          decider: "llm:scripted/cjs-1",
        },
      ]);
      const all = await report(dir);
      expect(entry(all, "toSatisfy in a CommonJS project#1")).toMatchObject({
        verdict: "pass",
        source: "decider",
      });
      expect(
        entry(
          all,
          "a decider from @jevyjs/deciders-llm › the fake decider answers#1",
        ),
      ).toMatchObject({
        verdict: "pass",
        decider: "fake",
        model: "fake-cjs-1",
      });
    },
  );
});
