import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DeciderError,
  JsonlDecisionStore,
  parseConfig,
} from "@jevyjs/core";
import type {
  Decider,
  DecisionRecord,
  DecisionStore,
  LlmAdapter,
  ResolvedJevyConfig,
} from "@jevyjs/core";
import type { TestInfo } from "@playwright/test";
import { DEFAULT_ATTEMPTS, DEFAULT_TIMEOUT_MS } from "@jevyjs/deciders-llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordMarks } from "./memo.js";
import {
  JEVY_REPORTER,
  MIN_DECIDER_TIMEOUT_MS,
  beginWorker,
  deciderTimeoutMs,
  deciderWindowMs,
  hasTimeForDecider,
  isJevyReporterListed,
  keysToKeep,
  loadRuntime,
  oncePerRun,
  resolveDecider,
  testRunFor,
} from "./runtime.js";
import type { FinishedCall, TestEnd } from "./runtime.js";

const NEVER: LlmAdapter = {
  complete: () => new Promise<unknown>(() => undefined),
};
const YES: LlmAdapter = {
  complete: () =>
    Promise.resolve({ answer: { value: "yes", confidence: 0.9 } }),
};

function config(
  mode: "replay" | "record",
  extra: Record<string, unknown> = {},
): ResolvedJevyConfig {
  return parseConfig(
    {
      decider: "llm",
      deciders: { llm: { adapter: YES, model: "provider/m" } },
      cache: { mode },
      ...extra,
    },
    { env: {} },
  );
}

const SNAPSHOT = { role: "main", name: "Order confirmed" };
const QUESTIONS = {
  answer: { kind: "yesno", prompt: "The order is confirmed" },
} as const;

describe("deciderTimeoutMs", () => {
  it("splits three quarters of the test's remaining time across the attempts", () => {
    expect(
      deciderTimeoutMs({
        testTimeoutMs: 30_000,
        elapsedMs: 2_000,
        attempts: 2,
      }),
    ).toBe(10_500);
    expect(
      deciderTimeoutMs({ testTimeoutMs: 90_000, elapsedMs: 0, attempts: 3 }),
    ).toBe(22_500);
  });

  it("never exceeds the decider's own default, nor goes below the floor", () => {
    expect(
      deciderTimeoutMs({ testTimeoutMs: 600_000, elapsedMs: 0, attempts: 2 }),
    ).toBe(DEFAULT_TIMEOUT_MS);
    expect(
      deciderTimeoutMs({
        testTimeoutMs: 30_000,
        elapsedMs: 29_900,
        attempts: 2,
      }),
    ).toBe(MIN_DECIDER_TIMEOUT_MS);
    expect(
      deciderTimeoutMs({
        testTimeoutMs: 30_000,
        elapsedMs: 45_000,
        attempts: 2,
      }),
    ).toBe(MIN_DECIDER_TIMEOUT_MS);
  });

  it("a test without a timeout gets the decider's default", () => {
    expect(
      deciderTimeoutMs({ testTimeoutMs: 0, elapsedMs: 1_000, attempts: 2 }),
    ).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("the default attempts with Playwright's default timeout end inside the test", () => {
    const perAttempt = deciderTimeoutMs({
      testTimeoutMs: 30_000,
      elapsedMs: 0,
      attempts: DEFAULT_ATTEMPTS,
    });
    expect(perAttempt * DEFAULT_ATTEMPTS).toBeLessThan(30_000);
  });
});

describe("hasTimeForDecider", () => {
  it("is false when three quarters of the time left cannot give each attempt the minimum", () => {
    // A late call: 10 s timeout, 8.7 s gone. The floor would have given two
    // attempts of 1 s each, 2 s, past the test's end.
    expect(
      hasTimeForDecider({
        testTimeoutMs: 10_000,
        elapsedMs: 8_700,
        attempts: 2,
      }),
    ).toBe(false);
    expect(
      hasTimeForDecider({ testTimeoutMs: 2_000, elapsedMs: 200, attempts: 2 }),
    ).toBe(false);
    expect(
      hasTimeForDecider({
        testTimeoutMs: 30_000,
        elapsedMs: 45_000,
        attempts: 2,
      }),
    ).toBe(false);
  });

  it("is true when they fit, and always without a timeout", () => {
    const fits = (4 * MIN_DECIDER_TIMEOUT_MS * 2) / 3;
    expect(
      hasTimeForDecider({ testTimeoutMs: fits, elapsedMs: 0, attempts: 2 }),
    ).toBe(true);
    expect(
      hasTimeForDecider({ testTimeoutMs: fits - 1, elapsedMs: 0, attempts: 2 }),
    ).toBe(false);
    expect(
      hasTimeForDecider({ testTimeoutMs: 30_000, elapsedMs: 0, attempts: 2 }),
    ).toBe(true);
    expect(
      hasTimeForDecider({ testTimeoutMs: 0, elapsedMs: 99_000, attempts: 2 }),
    ).toBe(true);
  });

  it("when it is true, the bound on each attempt is above the floor and the attempts end inside the test", () => {
    for (const elapsedMs of [0, 10_000, 25_000, 27_000]) {
      const time = { testTimeoutMs: 30_000, elapsedMs, attempts: 2 };
      if (!hasTimeForDecider(time)) continue;
      const each = deciderTimeoutMs(time);
      expect(each).toBeGreaterThanOrEqual(MIN_DECIDER_TIMEOUT_MS);
      expect(elapsedMs + each * 2).toBeLessThan(30_000);
    }
  });
});

describe("deciderWindowMs", () => {
  it("is three quarters of the time left, never negative, and the default without a timeout", () => {
    expect(
      deciderWindowMs({ testTimeoutMs: 30_000, elapsedMs: 2_000, attempts: 2 }),
    ).toBe(21_000);
    expect(
      deciderWindowMs({ testTimeoutMs: 1_000, elapsedMs: 5_000, attempts: 2 }),
    ).toBe(0);
    expect(
      deciderWindowMs({ testTimeoutMs: 0, elapsedMs: 0, attempts: 2 }),
    ).toBe(DEFAULT_TIMEOUT_MS * 2);
  });
});

describe("resolveDecider", () => {
  const timeout = (): number => 50;

  it("with too little time left, a call is a DeciderError and the model is not asked", async () => {
    let asked = 0;
    const counting = parseConfig(
      {
        decider: "llm",
        deciders: {
          llm: {
            adapter: {
              complete: () => {
                asked += 1;
                return Promise.resolve({
                  answer: { value: "yes", confidence: 0.9 },
                });
              },
            },
            model: "provider/m",
          },
        },
        cache: { mode: "record" },
      },
      { env: {} },
    );
    const resolved = resolveDecider(counting, undefined, () => undefined);
    await expect(
      resolved.decider?.decide({ snapshot: SNAPSHOT }, QUESTIONS),
    ).rejects.toThrow(DeciderError);
    await expect(
      resolved.decider?.decide({ snapshot: SNAPSHOT }, QUESTIONS),
    ).rejects.toThrow(/test\.setTimeout/);
    expect(asked).toBe(0);
  });

  it("llm outside replay: an llmDecider with the llm id, built from the config's adapter", async () => {
    const resolved = resolveDecider(config("record"), undefined, timeout);
    expect(resolved.deciderId).toBe("llm:provider/m");
    expect(resolved.model).toBe("provider/m");
    expect(resolved.decider?.id).toBe("llm:provider/m");
    expect(resolved.decider?.model).toBe("provider/m");
    const answers = await resolved.decider?.decide(
      { snapshot: SNAPSHOT },
      QUESTIONS,
    );
    expect(answers?.["answer"]).toMatchObject({ value: "yes" });
  });

  it("llm in replay: the id and model only; no decider is built", () => {
    const resolved = resolveDecider(config("replay"), "llm", timeout);
    expect(resolved).toEqual({
      deciderId: "llm:provider/m",
      model: "provider/m",
    });
  });

  it("each call is bounded by the timeout at the time of the call, so a hanging model is a DeciderError", async () => {
    const hanging = parseConfig(
      {
        decider: "llm",
        deciders: { llm: { adapter: NEVER, model: "provider/m" } },
        cache: { mode: "record" },
      },
      { env: {} },
    );
    let asked = 0;
    const resolved = resolveDecider(hanging, undefined, () => {
      asked += 1;
      return 20;
    });
    expect(asked).toBe(0);
    const started = Date.now();
    await expect(
      resolved.decider?.decide({ snapshot: SNAPSHOT }, QUESTIONS),
    ).rejects.toBeInstanceOf(DeciderError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(asked).toBe(1);
  });

  it("kev and jev work in replay with their ids and configured models", () => {
    expect(resolveDecider(config("replay"), "kev", timeout)).toEqual({
      deciderId: "kev",
      model: "kev-4b@v1.0",
    });
    expect(resolveDecider(config("replay"), "jev", timeout)).toEqual({
      deciderId: "jev",
      model: "jev-1.14.0",
    });
  });

  it("kev and jev outside replay are a ConfigError naming step 11", () => {
    for (const id of ["kev", "jev"] as const) {
      expect(() => resolveDecider(config("record"), id, timeout)).toThrow(
        ConfigError,
      );
      expect(() => resolveDecider(config("record"), id, timeout)).toThrow(
        /step 11/,
      );
    }
    const projectKev = config("record", { decider: "kev" });
    expect(() => resolveDecider(projectKev, undefined, timeout)).toThrow(
      /step 11/,
    );
  });

  it("an unknown id is core's ConfigError", () => {
    expect(() =>
      resolveDecider(config("record"), "gpt" as "llm", timeout),
    ).toThrow(ConfigError);
  });

  it("a Decider object is used as it is, in every mode", () => {
    const own: Decider = {
      id: "mine",
      model: "mine-1",
      decide: () => Promise.resolve({}),
    };
    for (const mode of ["record", "replay"] as const) {
      const resolved = resolveDecider(config(mode), own, timeout);
      expect(resolved.decider).toBe(own);
      expect(resolved.deciderId).toBe("mine");
      expect(resolved.model).toBe("mine-1");
    }
  });

  it("an object that is not a Decider is a ConfigError", () => {
    for (const bad of [
      {},
      { id: "x", model: "m" },
      { id: "", model: "m", decide: () => Promise.resolve({}) },
      { id: "x", model: 1, decide: () => Promise.resolve({}) },
    ]) {
      expect(() =>
        resolveDecider(config("record"), bad as unknown as Decider, timeout),
      ).toThrow(ConfigError);
    }
  });
});

describe("isJevyReporterListed", () => {
  const own = "/repo/node_modules/@jevyjs/playwright/dist/reporter.js";

  it("finds the package subpath, or a path to this reporter", () => {
    expect(
      isJevyReporterListed([["list"], [JEVY_REPORTER]], "/repo", own),
    ).toBe(true);
    expect(
      isJevyReporterListed(
        [["./node_modules/@jevyjs/playwright/dist/reporter.js", {}]],
        "/repo",
        own,
      ),
    ).toBe(true);
    expect(isJevyReporterListed([[own]], "/elsewhere", own)).toBe(true);
  });

  it("is false without it", () => {
    expect(isJevyReporterListed([["list"], ["html"]], "/repo", own)).toBe(
      false,
    );
    expect(isJevyReporterListed([], "/repo", own)).toBe(false);
  });
});

describe("loadRuntime", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jevy-runtime-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads jevy.config from the root, and puts the store under it and the memo in the run directory", async () => {
    await writeFile(
      join(root, "jevy.config.mjs"),
      'export default { decider: "kev", cache: { dir: "decisions", mode: "replay" } };\n',
    );
    const warnings: string[] = [];
    const runtime = await loadRuntime({
      root,
      runDir: join(root, "run"),
      reporters: [["list"]],
      warn: (text) => warnings.push(text),
    });
    expect(runtime.config.cache.mode).toBe("replay");
    expect(runtime.store).toBeInstanceOf(JsonlDecisionStore);
    expect(runtime.storeDir).toBe(join(root, "decisions"));
    expect(runtime.runDir).toBe(join(root, "run"));
    expect(runtime.memoDir).toBe(join(root, "run", "memo"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("report.json");
  });

  it("does not warn when the reporter is listed", async () => {
    await writeFile(
      join(root, "jevy.config.mjs"),
      'export default { decider: "kev" };\n',
    );
    const warnings: string[] = [];
    await loadRuntime({
      root,
      runDir: join(root, "run"),
      reporters: [[JEVY_REPORTER]],
      warn: (text) => warnings.push(text),
    });
    expect(warnings).toEqual([]);
  });

  it("a missing config is core's ConfigError", async () => {
    await expect(
      loadRuntime({
        root,
        runDir: join(root, "run"),
        reporters: [],
        warn: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("keysToKeep", () => {
  const passed: TestEnd = {
    status: "passed",
    expectedStatus: "passed",
    errors: [],
  };
  const NO = 'toSatisfy: fail (answered-no)\nStatement: "Shows Payment taken"';
  const calls: readonly FinishedCall[] = [
    { key: "before" },
    { key: "failing", blockingFail: NO },
    { key: "after" },
  ];
  const kept = (end: TestEnd, made = calls): readonly string[] => {
    const keep = keysToKeep(end, made);
    return ["before", "failing", "after", "other"].filter(keep);
  };

  it("a test that passed keeps every record", () => {
    expect(kept(passed)).toEqual(["before", "failing", "after", "other"]);
  });

  it("every other status discards them all, an expected failure and a skip included", () => {
    for (const status of ["timedOut", "skipped", "interrupted"] as const) {
      expect(kept({ ...passed, status }), status).toEqual([]);
    }
    expect(
      kept({
        status: "failed",
        expectedStatus: "failed",
        errors: [{ message: `Error: ${NO}` }],
      }),
    ).toEqual([]);
  });

  it("a failure that is only a blocking no keeps it and what came before it", () => {
    expect(
      kept({
        status: "failed",
        expectedStatus: "passed",
        errors: [{ message: `Error: ${NO}\n\nCall log: …` }],
      }),
    ).toEqual(["before", "failing"]);
  });

  it("any other error discards them all", () => {
    for (const errors of [
      [{ message: NO }, { message: "expect(received).toBe(expected)" }],
      [{ message: "Test timeout of 30000ms exceeded." }],
      [{}],
      [],
    ]) {
      expect(
        kept({ status: "failed", expectedStatus: "passed", errors }),
      ).toEqual([]);
    }
    // A failure with no blocking no among the calls.
    expect(
      kept(
        {
          status: "failed",
          expectedStatus: "passed",
          errors: [{ message: NO }],
        },
        [{ key: "before" }],
      ),
    ).toEqual([]);
  });
});

/** A store that keeps what is appended to it, for one worker. */
function appendLog(): {
  readonly store: DecisionStore;
  readonly appended: DecisionRecord[];
  fail: boolean;
} {
  const appended: DecisionRecord[] = [];
  const log = {
    appended,
    fail: false,
    store: {
      latest: () => Promise.resolve(undefined),
      forStep: () => Promise.resolve([]),
      list: () => Promise.resolve([]),
      append: (records: readonly DecisionRecord[]) => {
        if (log.fail) return Promise.reject(new Error("disk full"));
        appended.push(...records);
        return Promise.resolve();
      },
    },
  };
  return log;
}

describe("oncePerRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevy-once-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = (key: string): DecisionRecord =>
    ({ key }) as unknown as DecisionRecord;
  const KEY_A = `sha256:${"a".repeat(64)}`;
  const KEY_B = `sha256:${"b".repeat(64)}`;

  it("two workers, each with its own store: a key's record is written once in a run", async () => {
    const first = appendLog();
    const second = appendLog();
    const marks = join(dir, "recorded");
    await oncePerRun(first.store, createRecordMarks(marks)).append([
      record(KEY_A),
    ]);
    await oncePerRun(second.store, createRecordMarks(marks)).append([
      record(KEY_A),
      record(KEY_B),
    ]);
    expect(first.appended.map((one) => one.key)).toEqual([KEY_A]);
    expect(second.appended.map((one) => one.key)).toEqual([KEY_B]);
  });

  it("a record that could not be written gives its key back", async () => {
    const failing = appendLog();
    failing.fail = true;
    const marks = join(dir, "recorded");
    await expect(
      oncePerRun(failing.store, createRecordMarks(marks)).append([
        record(KEY_A),
      ]),
    ).rejects.toThrow("disk full");
    const next = appendLog();
    await oncePerRun(next.store, createRecordMarks(marks)).append([
      record(KEY_A),
    ]);
    expect(next.appended.map((one) => one.key)).toEqual([KEY_A]);
  });
});

describe("testRunFor", () => {
  it("outside a test, names the hook once Jevy's worker fixture has run", () => {
    const hook = {} as unknown as TestInfo;
    expect(() => testRunFor(hook)).toThrow(/declared with Jevy's test/);
    beginWorker("chromium");
    expect(() => testRunFor(hook)).toThrow(ConfigError);
    expect(() => testRunFor(hook)).toThrow(
      /not supported in beforeAll or afterAll hooks/,
    );
  });
});
