import type { CacheMode } from "../config.js";
import type { Answer, Decider, DecisionState, Question } from "../decider.js";
import { validateQuestion } from "../decider.js";
import { CacheError } from "../errors.js";
import { hashSnapshot } from "../hash.js";
import { callDecider } from "../prepare.js";
import type { PruneOptions } from "../prune.js";
import { rulesFingerprint } from "../project.js";
import type { SnapshotProcessOptions } from "../project.js";
import { redactText } from "../redact.js";
import type { RedactRule } from "../redact.js";
import type { SnapshotRegion } from "../snapshot.js";
import { assertThresholds, gateAnswer } from "../verdict.js";
import type { Thresholds, Verdict } from "../verdict.js";
import { decisionKey, questionText } from "./key.js";
import { findLast } from "./last.js";
import type { DecisionRecord } from "./record.js";
import { serialiseRecord } from "./record.js";
import type { DecisionStore } from "./store.js";

const MODES: readonly CacheMode[] = ["replay", "replay-or-query", "record"];

/**
 * Why a stored answer was not used. `no-entry`: this step never recorded this
 * question. The others compare with the step's most recent record for the
 * same question: the project's redaction or normalisation rules changed, the
 * decider or model changed, or (otherwise) the page state changed.
 * `regated-below-threshold` is set on a hit whose stored verdict differs from
 * what the current thresholds give.
 */
export type MissReason =
  | "no-entry"
  | "snapshot-changed"
  | "model-changed"
  | "redaction-changed"
  | "regated-below-threshold";

export interface DecisionOutcome {
  readonly verdict: Verdict;
  /**
   * `cache`: a stored answer, re-gated. `review`: a stored human verdict.
   * `decider`: an answer from a decider in this run (fresh, or from the run
   * memo). `none`: no answer, which only happens on a replay miss.
   */
  readonly source: "cache" | "review" | "decider" | "none";
  readonly key: string;
  readonly snapshotHash: string;
  /** Whether the answer was given on a cut-off snapshot. False with no answer. */
  readonly truncated: boolean;
  readonly answer?: {
    readonly value: string;
    readonly confidence: number;
    readonly abstained: boolean;
  };
  readonly reason?: MissReason;
  /** The stored record that was used, or the held record a call produced. */
  readonly record?: DecisionRecord;
}

export interface DecideInput {
  readonly spec: string;
  readonly step: string;
  readonly question: Question;
  readonly state: DecisionState;
  readonly region?: SnapshotRegion;
}

export interface RunMemoEntry {
  readonly answer: Answer;
  readonly truncated: boolean;
}

/**
 * Answers already drawn in this process, by decision key. A retry of a test
 * inside one run reuses the answer instead of asking again, so it cannot draw
 * a different one. Share one memo across the sessions of a run.
 */
export interface RunMemo {
  get(key: string): RunMemoEntry | undefined;
  set(key: string, entry: RunMemoEntry): void;
}

export function createRunMemo(): RunMemo {
  const entries = new Map<string, RunMemoEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.set(key, entry);
    },
  };
}

export interface DecisionSessionOptions {
  readonly store: DecisionStore;
  readonly mode: CacheMode;
  /** The decider id and model pin the key is bound to, even in replay. */
  readonly deciderId: string;
  readonly model: string;
  /** Required unless `mode` is `replay`. Never called in `replay`. */
  readonly decider?: Decider;
  readonly thresholds: Thresholds;
  /** Redact rules, normalise overrides and pruning budgets. */
  readonly snapshot?: PruneOptions;
  /** Clock for `createdAt`. Tests inject it. */
  readonly now?: () => Date;
  /** Defaults to a memo private to this session. */
  readonly memo?: RunMemo;
}

export interface DecisionSession {
  decide(input: DecideInput): Promise<DecisionOutcome>;
  /** Append the records this session's decider calls produced, then forget them. */
  confirm(): Promise<void>;
  /** Forget them without writing. */
  discard(): void;
}

/**
 * One test's view of the decision cache.
 *
 * Records from decider calls are held, not written: the caller confirms when
 * the test passes and discards when it fails, so an answer that a later check
 * contradicted never becomes a replayable entry.
 */
export function createDecisionSession(
  options: DecisionSessionOptions,
): DecisionSession {
  const settings = checkOptions(options);
  const memo = options.memo ?? createRunMemo();
  let pending: DecisionRecord[] = [];

  return {
    decide: async (input) => {
      const outcome = await decide(settings, memo, pending, input);
      if (outcome.held !== undefined) pending.push(outcome.held);
      return outcome.result;
    },
    confirm: async () => {
      if (pending.length === 0) return;
      const batch = [...pending];
      await settings.store.append(batch);
      pending = pending.filter((record) => !batch.includes(record));
    },
    discard: () => {
      pending = [];
    },
  };
}

interface Settings {
  readonly store: DecisionStore;
  readonly mode: CacheMode;
  readonly deciderId: string;
  readonly model: string;
  readonly decider: Decider | undefined;
  readonly thresholds: Thresholds;
  readonly snapshot: PruneOptions;
  readonly redact: readonly RedactRule[];
  readonly rules: string;
  readonly now: () => Date;
}

function checkOptions(options: DecisionSessionOptions): Settings {
  if (!MODES.includes(options.mode)) {
    throw new CacheError(
      `Cache mode must be one of ${MODES.join(", ")}, got ${JSON.stringify(options.mode)}`,
    );
  }
  assertIdentity(options.deciderId, "deciderId");
  assertIdentity(options.model, "model");
  assertThresholds(options.thresholds);
  const { decider } = options;
  if (decider === undefined && options.mode !== "replay") {
    throw new CacheError(
      `Cache mode "${options.mode}" calls a decider on a miss, so a decider is required`,
    );
  }
  // The key and record name the session's decider and model. A decider that
  // is someone else would store its answers under the wrong identity.
  if (
    decider !== undefined &&
    (decider.id !== options.deciderId || decider.model !== options.model)
  ) {
    throw new CacheError(
      `Decider ${decider.id}/${decider.model} does not match the session's ${options.deciderId}/${options.model}`,
    );
  }
  const snapshot = options.snapshot ?? {};
  const redact = snapshot.redact ?? [];
  return {
    store: options.store,
    mode: options.mode,
    deciderId: options.deciderId,
    model: options.model,
    decider,
    thresholds: {
      pass: options.thresholds.pass,
      fail: options.thresholds.fail,
    },
    snapshot,
    redact,
    rules: rulesFingerprint({
      redact,
      ...(snapshot.normalise !== undefined
        ? { normalise: snapshot.normalise }
        : {}),
    }),
    now: options.now ?? (() => new Date()),
  };
}

async function decide(
  settings: Settings,
  memo: RunMemo,
  pending: readonly DecisionRecord[],
  input: DecideInput,
): Promise<{
  readonly result: DecisionOutcome;
  readonly held?: DecisionRecord;
}> {
  validateQuestion(input.question);
  // Everything that will be written is redacted before any decider call, so
  // a redaction failure costs no call and leaves nothing behind.
  const spec = redactText(input.spec, settings.redact);
  const step = redactText(input.step, settings.redact);
  const text = questionText(input.question, settings.redact);
  const region = input.region ?? settings.snapshot.region;
  const snapshotHash = hashSnapshot(
    input.state.snapshot,
    hashOptions(settings, region),
  );
  const key = decisionKey({
    question: input.question,
    snapshotHash,
    deciderId: settings.deciderId,
    model: settings.model,
    redact: settings.redact,
  });
  const base = { key, snapshotHash };

  const stored = await settings.store.latest(key);
  if (stored !== undefined && settings.mode !== "record") {
    assertMatches(stored, input.question.kind, text, snapshotHash, settings);
    return { result: replayHit(settings, input.question, stored, base) };
  }

  const reason =
    stored === undefined
      ? await missReason(settings, spec, step, text)
      : undefined;
  const withReason = reason === undefined ? {} : { reason };

  if (settings.mode === "replay") {
    return {
      result: {
        verdict: "needs-review",
        source: "none",
        ...base,
        truncated: false,
        ...withReason,
      },
    };
  }

  const remembered = memo.get(key);
  if (remembered !== undefined) {
    const record = pending.find((held) => held.key === key);
    return {
      result: {
        ...fromAnswer(settings, input.question, remembered, base),
        ...withReason,
        ...(record !== undefined ? { record } : {}),
      },
    };
  }

  const decider = settings.decider;
  if (decider === undefined) {
    throw new CacheError("No decider is configured for this session");
  }
  const { answers, truncated } = await callDecider(
    decider,
    input.state,
    { answer: input.question },
    { ...settings.snapshot, ...(region !== undefined ? { region } : {}) },
  );
  const answer = answers["answer"];
  if (answer === undefined) {
    throw new CacheError("The decider returned no answer");
  }
  const entry: RunMemoEntry = { answer: copyAnswer(answer), truncated };
  const outcome = fromAnswer(settings, input.question, entry, base);
  const record = buildRecord(settings, {
    key,
    spec,
    step,
    kind: input.question.kind,
    question: text,
    snapshotHash,
    answer: entry.answer,
    truncated,
    verdict: outcome.verdict,
  });
  memo.set(key, entry);
  return { result: { ...outcome, ...withReason, record }, held: record };
}

function replayHit(
  settings: Settings,
  question: Question,
  stored: DecisionRecord,
  base: { readonly key: string; readonly snapshotHash: string },
): DecisionOutcome {
  const answer = {
    value: stored.answer,
    confidence: stored.confidence,
    abstained: stored.abstained,
  };
  if (stored.reviewedBy !== null && stored.reviewVerdict !== null) {
    return {
      verdict: stored.reviewVerdict,
      source: "review",
      ...base,
      truncated: stored.truncated,
      answer,
      record: stored,
    };
  }
  const verdict = gateAnswer(question, answer, settings.thresholds, {
    truncated: stored.truncated,
  });
  return {
    verdict,
    source: "cache",
    ...base,
    truncated: stored.truncated,
    answer,
    ...(verdict !== stored.verdict
      ? { reason: "regated-below-threshold" as const }
      : {}),
    record: stored,
  };
}

function fromAnswer(
  settings: Settings,
  question: Question,
  entry: RunMemoEntry,
  base: { readonly key: string; readonly snapshotHash: string },
): DecisionOutcome {
  const verdict = gateAnswer(question, entry.answer, settings.thresholds, {
    truncated: entry.truncated,
  });
  return {
    verdict,
    source: "decider",
    ...base,
    truncated: entry.truncated,
    answer: {
      value: entry.answer.value,
      confidence: entry.answer.confidence,
      abstained: entry.answer.abstained === true,
    },
  };
}

/**
 * Compare with the step's most recent record for the same question text.
 * Rules are checked first because a rule change also changes the snapshot
 * hash, and "your rules changed" is the more useful thing to say.
 */
async function missReason(
  settings: Settings,
  spec: string,
  step: string,
  text: string,
): Promise<MissReason> {
  const records = await settings.store.forStep(spec, step);
  const previous = findLast(records, (record) => record.question === text);
  if (previous === undefined) return "no-entry";
  if (previous.rules !== settings.rules) return "redaction-changed";
  if (
    previous.decider !== settings.deciderId ||
    previous.model !== settings.model
  ) {
    return "model-changed";
  }
  return "snapshot-changed";
}

interface RecordFields {
  readonly key: string;
  readonly spec: string;
  readonly step: string;
  readonly kind: Question["kind"];
  readonly question: string;
  readonly snapshotHash: string;
  readonly answer: Answer;
  readonly truncated: boolean;
  readonly verdict: Verdict;
}

/**
 * The spec, step and question were redacted by the caller. The answer is
 * redacted here. An abstention's free text may change; a real answer may
 * not, because a redacted option id or level could never be replayed.
 */
function buildRecord(settings: Settings, fields: RecordFields): DecisionRecord {
  const abstained = fields.answer.abstained === true;
  const answer = redactText(fields.answer.value, settings.redact);
  if (!abstained && answer !== fields.answer.value) {
    throw new CacheError(
      "The decider's answer matches a redaction rule, so it cannot be stored and replayed. Rename the option or level, or narrow the rule.",
    );
  }
  const createdAt = settings.now();
  if (Number.isNaN(createdAt.getTime())) {
    throw new CacheError("The session clock returned an invalid date");
  }
  const record: DecisionRecord = {
    v: 1,
    key: fields.key,
    spec: fields.spec,
    step: fields.step,
    kind: fields.kind,
    question: fields.question,
    snapshotHash: fields.snapshotHash,
    decider: settings.deciderId,
    model: settings.model,
    answer,
    confidence: fields.answer.confidence,
    abstained,
    truncated: fields.truncated,
    verdict: fields.verdict,
    thresholds: settings.thresholds,
    rules: settings.rules,
    createdAt: createdAt.toISOString(),
    reviewedBy: null,
    reviewVerdict: null,
  };
  // Validate now, so a bad record fails the step rather than a later confirm.
  serialiseRecord(record);
  return record;
}

/**
 * A record found under a key must describe what the key was computed from.
 * A mismatch means the file was edited or corrupted, and replaying it would
 * return an answer to a different question.
 */
function assertMatches(
  stored: DecisionRecord,
  kind: Question["kind"],
  text: string,
  snapshotHash: string,
  settings: Settings,
): void {
  if (
    stored.kind !== kind ||
    stored.question !== text ||
    stored.snapshotHash !== snapshotHash ||
    stored.decider !== settings.deciderId ||
    stored.model !== settings.model
  ) {
    throw new CacheError(
      `Stored decision ${stored.key} in ${stored.spec} does not match the question, snapshot, decider or model its key stands for`,
    );
  }
}

function hashOptions(
  settings: Settings,
  region: SnapshotRegion | undefined,
): SnapshotProcessOptions {
  const { normalise } = settings.snapshot;
  return {
    redact: settings.redact,
    ...(normalise !== undefined ? { normalise } : {}),
    ...(region !== undefined ? { region } : {}),
  };
}

function copyAnswer(answer: Answer): Answer {
  return {
    value: answer.value,
    confidence: answer.confidence,
    ...(answer.abstained !== undefined ? { abstained: answer.abstained } : {}),
  };
}

function assertIdentity(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CacheError(
      `Decision session ${field} must be a non-empty string`,
    );
  }
}
