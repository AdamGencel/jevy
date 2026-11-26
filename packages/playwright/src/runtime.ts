import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  DeciderError,
  JsonlDecisionStore,
  createDecisionSession,
  loadConfig,
  selectDecider,
  snapshotOptionsFromConfig,
} from "@jevyjs/core";
import type {
  Decider,
  DecisionRecord,
  DecisionSession,
  DecisionStore,
  ResolvedJevyConfig,
  RunMemo,
} from "@jevyjs/core";
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  llmDecider,
  llmDeciderId,
} from "@jevyjs/deciders-llm";
import type { TestInfo } from "@playwright/test";
import { jevyRoot } from "./entry.js";
import {
  createFileRunMemo,
  createKeyClaims,
  createRecordMarks,
  joinRun,
} from "./memo.js";
import type { KeyClaims, RecordMarks } from "./memo.js";

/**
 * What `toSatisfy` needs beyond one call: the worker's config, store and run
 * memo, loaded on first use, and one decision session per test.
 *
 * Nothing is loaded until the first `toSatisfy` in a worker, so a suite that
 * imports Jevy's `test` and never calls the matcher needs no
 * `jevy.config.*`.
 */

/** The decider a test asks: an id for `selectDecider`, or a decider itself. */
export type DeciderOption = "llm" | "kev" | "jev" | Decider;

/** The reporter's package subpath, as `playwright.config.ts` names it. */
export const JEVY_REPORTER = "@jevyjs/playwright/reporter";

/**
 * The shortest wait given to one decider attempt. Below this a real model
 * cannot answer. When three quarters of the test's time left cannot give
 * every attempt this much, the decider is not called at all
 * ({@link hasTimeForDecider}).
 */
export const MIN_DECIDER_TIMEOUT_MS = 1_000;

/** The share of a test's remaining time the decider may use, of 1. */
const DECIDER_SHARE = 0.75;

/** Where this module's reporter is, to recognise it named by path. */
const OWN_REPORTER = fileURLToPath(new URL("./reporter.js", import.meta.url));

/**
 * The bound on one decider attempt, from the test's remaining time.
 *
 * The decider's time counts against the test's timeout, and `llmDecider`'s
 * own default (two attempts of 60 s) is four times Playwright's default test
 * timeout of 30 s. A slow model must end as a `DeciderError`, which is
 * reported as `needs-review`, rather than as a Playwright timeout, which
 * reports nothing and loses the test's other entries. So three quarters of
 * what is left is split across the attempts, leaving the rest for the
 * snapshot, the report entry and the teardown that writes the record. It is
 * capped at the decider's default, and never below `MIN_DECIDER_TIMEOUT_MS`.
 * A test without a timeout (`0`) gets the default.
 */
export function deciderTimeoutMs(input: {
  readonly testTimeoutMs: number;
  readonly elapsedMs: number;
  readonly attempts: number;
}): number {
  if (input.testTimeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  const remaining = input.testTimeoutMs - input.elapsedMs;
  const share = Math.floor((remaining * DECIDER_SHARE) / input.attempts);
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(MIN_DECIDER_TIMEOUT_MS, share));
}

/**
 * Whether three quarters of the test's time left can give every attempt at
 * least `MIN_DECIDER_TIMEOUT_MS`. When it cannot, the decider is not
 * called: the floor would let the attempts run past the test's timeout,
 * and a Playwright timeout reports nothing. A test without a timeout always
 * has time.
 */
export function hasTimeForDecider(input: {
  readonly testTimeoutMs: number;
  readonly elapsedMs: number;
  readonly attempts: number;
}): boolean {
  if (input.testTimeoutMs <= 0) return true;
  const remaining = input.testTimeoutMs - input.elapsedMs;
  return remaining * DECIDER_SHARE >= input.attempts * MIN_DECIDER_TIMEOUT_MS;
}

/**
 * How long a worker may wait for another worker that is asking the decider
 * the same question: what this test's own attempts could have used.
 */
export function deciderWindowMs(input: {
  readonly testTimeoutMs: number;
  readonly elapsedMs: number;
  readonly attempts: number;
}): number {
  if (input.testTimeoutMs <= 0) return DEFAULT_TIMEOUT_MS * input.attempts;
  const remaining = input.testTimeoutMs - input.elapsedMs;
  return Math.max(0, Math.floor(remaining * DECIDER_SHARE));
}

/** The session's identity, and the decider when the mode can call one. */
export interface ResolvedDecider {
  readonly deciderId: string;
  readonly model: string;
  readonly decider?: Decider;
}

/**
 * The decider for one test. A `Decider` object is used as it is. An id, or
 * none, goes through core's `selectDecider`. `"llm"` builds `llmDecider`
 * from the config's adapter, only when the mode can call it: replay needs
 * the id and model alone, so it runs with no adapter key in the
 * environment. Kev and Jev have no adapter until step 11, so they work only
 * in replay.
 *
 * `timeoutMs` is asked at each call, not here: a test's remaining time
 * shrinks as it runs, and one session serves every call in the test. When
 * it returns undefined, the test has too little time left, and the call is
 * a `DeciderError` without asking the model, which the matcher reports as
 * `needs-review`.
 */
export function resolveDecider(
  config: ResolvedJevyConfig,
  option: DeciderOption | undefined,
  timeoutMs: () => number | undefined,
): ResolvedDecider {
  if (option !== undefined && typeof option !== "string") {
    return asDecider(option);
  }
  const selection = selectDecider(config, option);
  const replay = config.cache.mode === "replay";
  if (selection.id !== "llm") {
    if (!replay) {
      throw new ConfigError(
        `The ${selection.id} decider has no adapter until roadmap step 11, so it can only replay recorded decisions. Run in cache mode "replay", or use decider "llm".`,
      );
    }
    return { deciderId: selection.id, model: selection.model };
  }
  const { adapter, model } = selection;
  const deciderId = llmDeciderId(model);
  if (replay) return { deciderId, model };
  const decider: Decider = {
    id: deciderId,
    model,
    decide: (state, questions) => {
      const bound = timeoutMs();
      if (bound === undefined) {
        return Promise.reject(
          new DeciderError(
            `Too little of the test's timeout is left to ask the model: each of its ${String(DEFAULT_ATTEMPTS)} attempts needs at least ${String(MIN_DECIDER_TIMEOUT_MS)} ms from three quarters of the time left. Give the test more time with test.setTimeout, or check earlier in the test.`,
          ),
        );
      }
      return llmDecider({ adapter, model, timeoutMs: bound }).decide(
        state,
        questions,
      );
    },
  };
  return { deciderId, model, decider };
}

/**
 * A decider passed to `test.use`, checked: a value from a spec file is not
 * typed at run time, and the session would otherwise fail later with a less
 * useful message.
 */
function asDecider(value: Decider): ResolvedDecider {
  const fields: unknown = value;
  if (
    typeof fields !== "object" ||
    fields === null ||
    !("id" in fields) ||
    !("model" in fields) ||
    !("decide" in fields) ||
    typeof fields.id !== "string" ||
    fields.id.trim() === "" ||
    typeof fields.model !== "string" ||
    fields.model.trim() === "" ||
    typeof fields.decide !== "function"
  ) {
    throw new ConfigError(
      'test.use({ decider }) takes "llm", "kev", "jev" or a Decider: an object with a non-empty id and model and a decide function',
    );
  }
  return { deciderId: value.id, model: value.model, decider: value };
}

/** Playwright's `config.reporter`: `[name, options?]` pairs. */
export type ReporterList = readonly (readonly [string, unknown?])[];

/**
 * Whether Jevy's reporter is in the run: by its package subpath, or by a
 * path (relative to the root) to this package's reporter file.
 */
export function isJevyReporterListed(
  reporters: ReporterList,
  root: string,
  ownReporter: string = OWN_REPORTER,
): boolean {
  return reporters.some(([name]) => {
    if (name === JEVY_REPORTER) return true;
    const path = isAbsolute(name) ? name : resolve(root, name);
    return path === ownReporter;
  });
}

/** One worker's share of Jevy: loaded once, on the first `toSatisfy`. */
export interface WorkerRuntime {
  readonly root: string;
  readonly config: ResolvedJevyConfig;
  readonly store: DecisionStore;
  readonly storeDir: string;
  /** The directory this worker shares with the other workers of its run. */
  readonly runDir: string;
  readonly memo: RunMemo;
  readonly memoDir: string;
  readonly claims: KeyClaims;
  /** Which keys some worker of this run has written a record for. */
  readonly recorded: RecordMarks;
}

/**
 * Load the config from the root (it is executed, which is right in a worker
 * that runs the project's code anyway), open the store at `cache.dir` under
 * the root, and the run memo, claims and record marks in `runDir` (see
 * `joinRun`). Sessions write through `oncePerRun` over the store. Warn once when Jevy's reporter is not listed, since then no
 * `report.json` is written.
 */
export async function loadRuntime(input: {
  readonly root: string;
  readonly runDir: string;
  readonly reporters: ReporterList;
  readonly warn: (text: string) => void;
}): Promise<WorkerRuntime> {
  const config = await loadConfig({ cwd: input.root });
  if (!isJevyReporterListed(input.reporters, input.root)) {
    input.warn(
      `Jevy: ${JEVY_REPORTER} is not among this run's reporters, so no report.json will be written. ` +
        `Add [["${JEVY_REPORTER}"]] to reporter in the Playwright config. Verdicts are still attached to each test.`,
    );
  }
  const storeDir = resolve(input.root, config.cache.dir);
  const memoDir = join(input.runDir, "memo");
  return {
    root: input.root,
    config,
    store: new JsonlDecisionStore({ dir: storeDir }),
    storeDir,
    runDir: input.runDir,
    memo: createFileRunMemo(memoDir, {
      warn: (text) => {
        input.warn(`Jevy: ${text}`);
      },
    }),
    memoDir,
    claims: createKeyClaims(join(input.runDir, "claims")),
    recorded: createRecordMarks(join(input.runDir, "recorded")),
  };
}

/**
 * A store whose `append` writes each key's record once per run.
 *
 * Each worker reads the JSONL files once, so it does not see a record that
 * another worker wrote in this run: four workers that pass on one answer
 * would each append it. The first to mark the key writes it; the others
 * drop theirs, which carries the same answer, because the run memo gave
 * every worker the first one. A mark whose record could not be written is
 * taken back.
 */
export function oncePerRun(
  store: DecisionStore,
  marks: RecordMarks,
): DecisionStore {
  return {
    latest: (key) => store.latest(key),
    forStep: (spec, step) => store.forStep(spec, step),
    list: (spec) => store.list(spec),
    append: async (records) => {
      const fresh = records.filter((record) => marks.mark(record.key));
      if (fresh.length === 0) return;
      try {
        await store.append(fresh);
      } catch (error: unknown) {
        for (const record of fresh) marks.unmark(record.key);
        throw error;
      }
    },
  };
}

/** A store whose `append` writes only the records `keep` accepts. */
function keeping(
  store: DecisionStore,
  keep: () => (record: DecisionRecord) => boolean,
): DecisionStore {
  return {
    latest: (key) => store.latest(key),
    forStep: (spec, step) => store.forStep(spec, step),
    list: (spec) => store.list(spec),
    append: async (records) => {
      const kept = records.filter(keep());
      if (kept.length > 0) await store.append(kept);
    },
  };
}

const runtimes = new Map<string, Promise<WorkerRuntime>>();

/**
 * The worker's runtime, loaded once per root, output directory and retries
 * (one project per worker, so once per worker). A failed load is kept, so
 * every later `toSatisfy` fails with the same error instead of loading
 * again.
 */
export function workerRuntime(testInfo: TestInfo): Promise<WorkerRuntime> {
  const root = jevyRoot(testInfo.config);
  const outputDir = testInfo.project.outputDir;
  const retries = testInfo.project.retries;
  const id = `${root}\u0000${outputDir}\u0000${String(retries)}`;
  let runtime = runtimes.get(id);
  if (runtime === undefined) {
    runtime = (async () =>
      loadRuntime({
        root,
        runDir: joinRun({
          runsDir: join(outputDir, ".jevy", "runs"),
          retries,
          runner: process.ppid,
          worker: process.pid,
        }),
        reporters: testInfo.config.reporter,
        warn: (text) => process.stderr.write(`${text}\n`),
      }))();
    runtimes.set(id, runtime);
  }
  return runtime;
}

/** A test's session and what the matcher reports about it. */
export interface TestSession {
  readonly runtime: WorkerRuntime;
  readonly session: DecisionSession;
  readonly deciderId: string;
  readonly model: string;
}

/** How a test ended, as its fixture teardown sees it. */
export interface TestEnd {
  readonly status: TestInfo["status"];
  readonly expectedStatus: TestInfo["expectedStatus"];
  readonly errors: readonly { readonly message?: string }[];
}

/** One `toSatisfy` call that got an outcome, in the order they finished. */
export interface FinishedCall {
  readonly key: string;
  /**
   * The failure message, when the call failed the test on a blocking
   * `fail`; undefined otherwise.
   */
  readonly blockingFail?: string;
}

/**
 * Which of a test's held records to write, by key.
 *
 * - The test passed: all of them.
 * - It failed, was expected to pass, and every error it raised is one of
 *   its own blocking `fail`s: the record of each of those calls, and the
 *   records of the calls that finished before the first of them. The "no"
 *   is kept, so a replay fails the same way until a person reviews it; an
 *   answer drawn after the test had failed is not.
 * - Anything else (another failure, a timeout, a skip, an interruption, an
 *   expected failure): none, so an answer a later check contradicted never
 *   becomes a replayable record.
 */
export function keysToKeep(
  end: TestEnd,
  calls: readonly FinishedCall[],
): (key: string) => boolean {
  if (end.status === "passed") return () => true;
  if (end.status !== "failed" || end.expectedStatus !== "passed") {
    return () => false;
  }
  const messages = calls.flatMap((call) =>
    call.blockingFail === undefined ? [] : [call.blockingFail],
  );
  const onlyBlockingFails =
    messages.length > 0 &&
    end.errors.length > 0 &&
    end.errors.every((error) => {
      const text = error.message;
      return (
        text !== undefined && messages.some((message) => text.includes(message))
      );
    });
  if (!onlyBlockingFails) return () => false;
  const first = calls.findIndex((call) => call.blockingFail !== undefined);
  const kept = new Set(
    calls
      .filter(
        (call, index) => index <= first || call.blockingFail !== undefined,
      )
      .map((call) => call.key),
  );
  return (key) => kept.has(key);
}

/** One test: its `toSatisfy` calls and its decision session. */
export interface TestRun {
  /** The next call's ordinal, from 1. */
  nextCall(): number;
  /** The test's session, created on the first call. */
  session(): Promise<TestSession>;
  /**
   * Hold the key against other workers while this one may ask the decider:
   * wait while another worker holds it, up to the time this test's own
   * attempts could use. Returns the release. Nothing is held in replay, or
   * once the run memo has the answer.
   */
  claim(key: string): Promise<() => void>;
  /** Note a call that got an outcome, and whether it failed the test. */
  finished(call: FinishedCall): void;
  /** Confirm the records `keysToKeep` keeps, discard the rest. */
  finish(end: TestEnd): Promise<void>;
}

const runs = new WeakMap<TestInfo, TestRun>();

/** How often a worker looks again while another holds a key. */
const CLAIM_POLL_MS = 25;

/** Called by the automatic fixture before the test body. */
export function beginTest(
  testInfo: TestInfo,
  option: DeciderOption | undefined,
): TestRun {
  const startedAt = Date.now();
  const time = (): {
    readonly testTimeoutMs: number;
    readonly elapsedMs: number;
    readonly attempts: number;
  } => ({
    testTimeoutMs: testInfo.timeout,
    elapsedMs: Date.now() - startedAt,
    attempts: DEFAULT_ATTEMPTS,
  });
  let calls = 0;
  const done: FinishedCall[] = [];
  let keep: (key: string) => boolean = () => true;
  let opened: Promise<TestSession> | undefined;
  const open = async (): Promise<TestSession> => {
    const runtime = await workerRuntime(testInfo);
    const resolved = resolveDecider(runtime.config, option, () =>
      hasTimeForDecider(time()) ? deciderTimeoutMs(time()) : undefined,
    );
    const session = createDecisionSession({
      store: keeping(
        oncePerRun(runtime.store, runtime.recorded),
        () => (record) => keep(record.key),
      ),
      mode: runtime.config.cache.mode,
      deciderId: resolved.deciderId,
      model: resolved.model,
      ...(resolved.decider !== undefined ? { decider: resolved.decider } : {}),
      thresholds: runtime.config.thresholds,
      snapshot: snapshotOptionsFromConfig(runtime.config),
      memo: runtime.memo,
    });
    return {
      runtime,
      session,
      deciderId: resolved.deciderId,
      model: resolved.model,
    };
  };
  const session = (): Promise<TestSession> => {
    opened ??= open();
    return opened;
  };
  const run: TestRun = {
    nextCall: () => {
      calls += 1;
      return calls;
    },
    session,
    claim: async (key) => {
      const { runtime } = await session();
      const none = (): void => undefined;
      if (runtime.config.cache.mode === "replay") return none;
      const deadline = Date.now() + deciderWindowMs(time());
      for (;;) {
        if (runtime.memo.get(key) !== undefined) return none;
        if (runtime.claims.tryClaim(key)) {
          return () => {
            runtime.claims.release(key);
          };
        }
        if (Date.now() >= deadline) return none;
        await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
      }
    },
    finished: (call) => {
      done.push(call);
    },
    finish: async (end) => {
      if (opened === undefined) return;
      // A session that failed to open failed its assertion already.
      const settled = await opened.then(
        (value) => value,
        () => undefined,
      );
      if (settled === undefined) return;
      keep = keysToKeep(end, done);
      await settled.session.confirm();
    },
  };
  runs.set(testInfo, run);
  return run;
}

/** Called by the automatic fixture after the test body. */
export function endTest(testInfo: TestInfo): void {
  runs.delete(testInfo);
}

/**
 * The browser this worker runs, set by Jevy's worker fixture, which runs
 * before any hook; undefined in a worker that has not run it.
 */
let workerBrowser: string | undefined;

/** Called by the automatic worker fixture when a worker starts. */
export function beginWorker(browserName: string): void {
  workerBrowser = browserName;
}

/**
 * The running test's state. Missing in a `beforeAll` or `afterAll` hook,
 * which belongs to no single test, and when the test was declared with
 * Playwright's own `test`; in both there is no session to hold the records.
 * Jevy's worker fixture tells them apart: it runs before any hook, and only
 * for tests declared with Jevy's `test`.
 */
export function testRunFor(testInfo: TestInfo): TestRun {
  const run = runs.get(testInfo);
  if (run === undefined) {
    if (workerBrowser !== undefined) {
      throw new ConfigError(
        "toSatisfy is not supported in beforeAll or afterAll hooks: a hook belongs to no single test, so no test holds the decision's record or fails on it. Call it in a test, or in beforeEach or afterEach.",
      );
    }
    throw new ConfigError(
      'toSatisfy needs the test to be declared with Jevy\'s test: import { test, expect } from "@jevyjs/playwright".',
    );
  }
  return run;
}
