import type { CacheMode } from "../config.js";
import type { Answer, Decider, DecisionState, Question } from "../decider.js";
import { validateAnswer, validateQuestion } from "../decider.js";
import { CacheError, JevyError } from "../errors.js";
import { isRecord } from "../guards.js";
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
import { assertSpecKeyable, decisionKey, questionText } from "./key.js";
import { findLast } from "./last.js";
import type { DecisionRecord } from "./record.js";
import { DECISION_RECORD_VERSION, serialiseRecord } from "./record.js";
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
  /**
   * The stored record that was used, or the record for an answer drawn in
   * this run: from a call, or remembered by the run memo.
   *
   * A record is per key, not per step. When a session asks one key at several
   * steps, every one of them gets the same record, and its `step` names the
   * first step that asked; the step is informational and not part of the key.
   * Likewise, when the store's last record for the key already says the same
   * thing, that record is returned and nothing new is held.
   */
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
 * Answers already drawn in this run, by decision key. A retry of a test
 * inside one run reuses the answer instead of asking again, so it cannot draw
 * a different one, and holds a record of it. Share one memo across the
 * sessions of a run.
 *
 * A memo may be shared between processes. Then the first answer set for a
 * key must win: a later `set` leaves it in place, and `get` returns it. The
 * session reads the key back after every `set` and uses what it gets.
 *
 * `get` may return undefined (or null) for a key it was given, for example
 * when a shared memo could not keep the entry; that is a miss. Anything else
 * that is not a well-formed entry for the question is a `CacheError`, because
 * a shared memo returns what another process wrote.
 */
export interface RunMemo {
  get(key: string): RunMemoEntry | undefined;
  set(key: string, entry: RunMemoEntry): void;
}

/** An in-memory memo for one process. The first entry set for a key stays. */
export function createRunMemo(): RunMemo {
  const entries = new Map<string, RunMemoEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      if (!entries.has(key)) entries.set(key, entry);
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
  const state: SessionState = { pending: [], written: new Map() };
  // Calls on one key run one after another, so a second call sees the record
  // the first one held instead of asking the decider again.
  const queues = new Map<string, Promise<unknown>>();

  return {
    decide: async (input) => {
      const asked = prepare(settings, input);
      const previous = queues.get(asked.key) ?? Promise.resolve();
      const run = previous.then(async () => {
        const outcome = await decide(settings, memo, state, input, asked);
        if (outcome.held !== undefined) state.pending.push(outcome.held);
        return outcome.result;
      });
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      queues.set(asked.key, settled);
      void settled.then(() => {
        if (queues.get(asked.key) === settled) queues.delete(asked.key);
      });
      return run;
    },
    confirm: async () => {
      if (state.pending.length === 0) return;
      const batch = [...state.pending];
      await settings.store.append(batch);
      for (const record of batch) state.written.set(record.key, record);
      state.pending = state.pending.filter((record) => !batch.includes(record));
    },
    discard: () => {
      state.pending = [];
    },
  };
}

/**
 * What a session remembers between calls. `pending` is held and not yet
 * written; `written` is what `confirm` appended, by key. Together they are
 * this session's answer for a key, which it reuses rather than ask again: a
 * session never holds two records for one key.
 */
interface SessionState {
  pending: DecisionRecord[];
  readonly written: Map<string, DecisionRecord>;
}

/** What one call asks, worked out before the store, the memo or a decider. */
interface Asked {
  readonly spec: string;
  readonly step: string;
  readonly text: string;
  readonly region: SnapshotRegion | undefined;
  readonly snapshotHash: string;
  readonly key: string;
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

/**
 * Everything that will be written is redacted, and the spec checked, before
 * the store, the memo or a decider is touched, so a refusal or a redaction
 * failure costs no call and leaves nothing behind.
 */
function prepare(settings: Settings, input: DecideInput): Asked {
  validateQuestion(input.question);
  assertSpecKeyable(input.spec, settings.redact);
  const step = redactText(input.step, settings.redact);
  const text = questionText(input.question, settings.redact);
  const region = input.region ?? settings.snapshot.region;
  const snapshotHash = hashSnapshot(
    input.state.snapshot,
    hashOptions(settings, region),
  );
  const key = decisionKey({
    spec: input.spec,
    question: input.question,
    snapshotHash,
    deciderId: settings.deciderId,
    model: settings.model,
    redact: settings.redact,
  });
  return { spec: input.spec, step, text, region, snapshotHash, key };
}

async function decide(
  settings: Settings,
  memo: RunMemo,
  state: SessionState,
  input: DecideInput,
  asked: Asked,
): Promise<{
  readonly result: DecisionOutcome;
  readonly held?: DecisionRecord;
}> {
  const { spec, step, text, region, snapshotHash, key } = asked;
  const base = { key, snapshotHash };

  const stored = await settings.store.latest(key);
  if (stored !== undefined && settings.mode !== "record") {
    assertMatches(
      stored,
      { spec, kind: input.question.kind, text, snapshotHash },
      settings,
    );
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

  const fields = {
    key,
    spec,
    step,
    kind: input.question.kind,
    question: text,
    snapshotHash,
  };

  // This session's own answer for the key comes first: a record it holds or
  // wrote. The memo may not have kept it, and asking again could draw a
  // different answer and hold a second record for the key.
  const own =
    state.pending.find((record) => record.key === key) ??
    state.written.get(key);
  if (own !== undefined) {
    const outcome = fromAnswer(settings, input.question, entryOf(own), base);
    return { result: { ...outcome, ...withReason, record: own } };
  }

  const remembered = readMemo(memo, key, input.question);
  if (remembered !== undefined) {
    // A retry that passes on the first attempt's answer must leave a record,
    // or the next run asks again and may draw a different answer.
    const answered = answer(
      settings,
      input.question,
      fields,
      fromMemo(settings, remembered),
    );
    return hold(answered, withReason, stored);
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
  const drawn = answers["answer"];
  if (drawn === undefined) {
    throw new CacheError("The decider returned no answer");
  }
  const entry: RunMemoEntry = {
    answer: storableAnswer(settings, drawn),
    truncated,
  };
  // The first answer for a key wins across processes. A memo shared between
  // workers may already hold another worker's answer, which then stands for
  // this attempt too, so two workers cannot record different answers.
  memo.set(key, entry);
  const kept = readMemo(memo, key, input.question);
  const winner = kept === undefined ? entry : fromMemo(settings, kept);
  const answered = answer(settings, input.question, fields, winner);
  return hold(answered, withReason, stored);
}

/**
 * Hold the record for an answer, unless the store's last record for the key
 * already says the same thing (record mode, or a later test that shares the
 * memo): then that record stands, and a second identical line is not written.
 */
function hold(
  answered: {
    readonly outcome: DecisionOutcome;
    readonly record: DecisionRecord;
  },
  withReason: { readonly reason?: MissReason },
  stored: DecisionRecord | undefined,
): { readonly result: DecisionOutcome; readonly held?: DecisionRecord } {
  if (stored !== undefined && sameDecision(stored, answered.record)) {
    return { result: { ...answered.outcome, ...withReason, record: stored } };
  }
  return {
    result: { ...answered.outcome, ...withReason, record: answered.record },
    held: answered.record,
  };
}

/**
 * True when two records for one key carry the same decision. `createdAt` and
 * `step` are left out: a record is per key, and when it was written and at
 * which step it was first asked do not change what a replay returns.
 */
function sameDecision(a: DecisionRecord, b: DecisionRecord): boolean {
  return (
    a.key === b.key &&
    a.spec === b.spec &&
    a.kind === b.kind &&
    a.question === b.question &&
    a.snapshotHash === b.snapshotHash &&
    a.decider === b.decider &&
    a.model === b.model &&
    a.answer === b.answer &&
    a.confidence === b.confidence &&
    a.abstained === b.abstained &&
    a.truncated === b.truncated &&
    a.verdict === b.verdict &&
    a.thresholds.pass === b.thresholds.pass &&
    a.thresholds.fail === b.thresholds.fail &&
    a.rules === b.rules &&
    a.reviewedBy === b.reviewedBy &&
    a.reviewVerdict === b.reviewVerdict
  );
}

/** The answer a record holds, as a memo entry. */
function entryOf(record: DecisionRecord): RunMemoEntry {
  return {
    answer: {
      value: record.answer,
      confidence: record.confidence,
      abstained: record.abstained,
    },
    truncated: record.truncated,
  };
}

/**
 * The memo's entry for `key`, checked. Undefined or null is a miss. Any
 * other value must be `{ answer, truncated }` with an answer valid for the
 * question, or it is a `CacheError`: a shared memo returns what another
 * process wrote, and a malformed entry must not become a verdict or crash
 * with a `TypeError`.
 */
function readMemo(
  memo: RunMemo,
  key: string,
  question: Question,
): RunMemoEntry | undefined {
  const value: unknown = memo.get(key);
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !isRecord(value["answer"])) {
    throw new CacheError(
      `The run memo entry for ${key} must be an object with an answer object`,
    );
  }
  const truncated = value["truncated"];
  if (typeof truncated !== "boolean") {
    throw new CacheError(
      `The run memo entry for ${key} must have a boolean truncated flag`,
    );
  }
  const raw = value["answer"];
  const answer: Answer = {
    value: raw["value"] as string,
    confidence: raw["confidence"] as number,
    ...(raw["abstained"] !== undefined
      ? { abstained: raw["abstained"] as boolean }
      : {}),
  };
  try {
    validateAnswer(question, answer);
  } catch (error: unknown) {
    if (error instanceof JevyError) {
      throw new CacheError(
        `The run memo entry for ${key} is not a valid answer: ${error.message}`,
      );
    }
    throw error;
  }
  return { answer, truncated };
}

/** The outcome of an answer drawn in this run, and the record to hold for it. */
function answer(
  settings: Settings,
  question: Question,
  fields: Omit<RecordFields, "answer" | "truncated" | "verdict">,
  entry: RunMemoEntry,
): { readonly outcome: DecisionOutcome; readonly record: DecisionRecord } {
  const outcome = fromAnswer(settings, question, entry, {
    key: fields.key,
    snapshotHash: fields.snapshotHash,
  });
  const record = buildRecord(settings, {
    ...fields,
    answer: entry.answer,
    truncated: entry.truncated,
    verdict: outcome.verdict,
  });
  return { outcome, record };
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
 * The decider's answer as the session keeps it: redacted once, before it
 * reaches the memo, the returned outcome or a record, so an abstention's free
 * text cannot carry a secret out of the session. An abstention's text may
 * change; a real answer may not, because a redacted option id or level could
 * never be replayed. `raw` is dropped.
 */
function storableAnswer(settings: Settings, answer: Answer): Answer {
  const value = redactText(answer.value, settings.redact);
  if (answer.abstained !== true && value !== answer.value) {
    throw new CacheError(
      "The decider's answer matches a redaction rule, so it cannot be stored and replayed. Rename the option or level, or narrow the rule.",
    );
  }
  return {
    value,
    confidence: answer.confidence,
    ...(answer.abstained !== undefined ? { abstained: answer.abstained } : {}),
  };
}

/**
 * An entry read back from the memo. A shared memo returns what another
 * process wrote, so it is redacted again before it reaches an outcome or a
 * record; for an entry this process wrote, that changes nothing.
 */
function fromMemo(settings: Settings, entry: RunMemoEntry): RunMemoEntry {
  return {
    answer: storableAnswer(settings, entry.answer),
    truncated: entry.truncated,
  };
}

/** The spec, step, question and answer were redacted by the caller. */
function buildRecord(settings: Settings, fields: RecordFields): DecisionRecord {
  const createdAt = settings.now();
  if (Number.isNaN(createdAt.getTime())) {
    throw new CacheError("The session clock returned an invalid date");
  }
  const record: DecisionRecord = {
    v: DECISION_RECORD_VERSION,
    key: fields.key,
    spec: fields.spec,
    step: fields.step,
    kind: fields.kind,
    question: fields.question,
    snapshotHash: fields.snapshotHash,
    decider: settings.deciderId,
    model: settings.model,
    answer: fields.answer.value,
    confidence: fields.answer.confidence,
    abstained: fields.answer.abstained === true,
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
  asked: {
    readonly spec: string;
    readonly kind: Question["kind"];
    readonly text: string;
    readonly snapshotHash: string;
  },
  settings: Settings,
): void {
  if (
    stored.spec !== asked.spec ||
    stored.kind !== asked.kind ||
    stored.question !== asked.text ||
    stored.snapshotHash !== asked.snapshotHash ||
    stored.decider !== settings.deciderId ||
    stored.model !== settings.model
  ) {
    throw new CacheError(
      `Stored decision ${stored.key} in ${stored.spec} does not match the spec, question, snapshot, decider or model its key stands for`,
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

function assertIdentity(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CacheError(
      `Decision session ${field} must be a non-empty string`,
    );
  }
}
