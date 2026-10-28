import type { Answer, DecisionState, Decider, Question } from "./decider.js";
import { validateQuestion } from "./decider.js";
import type { CacheMode } from "./config.js";
import {
  decisionKey,
  parseDecisionRecord,
  winningRecord,
} from "./decision-record.js";
import type { DecisionChoice, DecisionRecord } from "./decision-record.js";
import { DECISION_SCHEMA_VERSION } from "./decision-record.js";
import { JsonlDecisionStore } from "./decision-store.js";
import type { DecisionStore } from "./decision-store.js";
import { CacheError, CacheMissError } from "./errors.js";
import { hashSnapshot } from "./hash.js";
import { REDACTED, redactText } from "./redact.js";
import type { RedactRule } from "./redact.js";
import { callDecider } from "./prepare.js";
import type { NormaliseOverrides, SnapshotRegion } from "./snapshot.js";
import type { Thresholds, Verdict } from "./verdict.js";
import { DEFAULT_THRESHOLDS, gateAnswer } from "./verdict.js";

const QUESTION_NAME = "decision";

export interface ResolveDecisionInput {
  readonly spec: string;
  readonly step: string;
  readonly question: Question;
  readonly state: DecisionState;
  readonly decider: Decider;
  readonly mode: CacheMode;
  readonly store: DecisionStore;
  /** Thresholds used to gate the answer. Stored thresholds are not replayed. */
  readonly thresholds?: Thresholds;
  /** Overrides `state.goal` in the cache key when set. */
  readonly goal?: string;
  readonly region?: SnapshotRegion;
  readonly redact?: readonly RedactRule[];
  readonly normalise?: NormaliseOverrides;
  readonly now?: () => Date;
  /**
   * Replay miss behaviour. The default is `needs-review` and no decider call.
   * `error` throws `CacheMissError` instead, still without a decider call.
   */
  readonly onMiss?: "needs-review" | "error";
}

export interface ResolvedDecision {
  /** `cache` was replayed, `decider` was just asked, `miss` is a replay miss. */
  readonly source: "cache" | "decider" | "miss";
  /** Re-gated from the answer and the caller's thresholds. */
  readonly verdict: Verdict;
  readonly key: string;
  readonly snapshotHash: string;
  /** Stored record. Null on a replay miss. Its `verdict` is what was written. */
  readonly record: DecisionRecord | null;
  readonly answer: Answer | null;
}

/**
 * Replay, replay-or-query, or record one decision.
 * Redaction runs before the key is hashed and before any write.
 * Replay never calls the decider and never writes a decision file.
 */
export async function resolveDecision(
  input: ResolveDecisionInput,
): Promise<ResolvedDecision> {
  validateQuestion(input.question);
  const rules = input.redact ?? [];
  const redacted = redactQuestion(input.question, rules);
  const goalSource = input.goal ?? input.state.goal;
  const goal =
    goalSource === undefined
      ? null
      : emptyToNull(redactText(goalSource, rules));
  const snapshotHash = hashSnapshot(input.state.snapshot, {
    redact: rules,
    ...(input.normalise !== undefined ? { normalise: input.normalise } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
  });
  const deciderId = redactText(input.decider.id, rules);
  const model = redactText(input.decider.model, rules);
  const spec = redactText(input.spec, rules);
  const step = redactText(input.step, rules);
  const key = decisionKey({
    kind: redacted.kind,
    prompt: redacted.prompt,
    ...(redacted.criteria !== null ? { criteria: redacted.criteria } : {}),
    ...(goal !== null ? { goal } : {}),
    choices: redacted.choices,
    snapshotHash,
    deciderId,
    model,
    redact: rules,
  });
  const at = (input.now ?? defaultNow)().toISOString();
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const identity = {
    key,
    snapshotHash,
  };

  if (input.mode !== "record") {
    const hit = await input.store.get(key);
    if (hit !== null) {
      const stored = parseDecisionRecord(hit);
      if (input.mode === "replay-or-query") {
        await input.store.touch(key, at);
        await input.store.noteReferenced(key, at);
      }
      return {
        source: "cache",
        verdict: gateAnswer(
          redacted.question,
          { value: stored.answer, confidence: stored.confidence },
          thresholds,
        ),
        ...identity,
        record:
          input.mode === "replay-or-query"
            ? { ...stored, lastUsedAt: at }
            : stored,
        answer: { value: stored.answer, confidence: stored.confidence },
      };
    }
  }

  if (input.mode === "replay") {
    if (input.onMiss === "error") {
      throw new CacheMissError(
        `No cached decision for ${spec} step ${step}. Replay mode does not call the decider.`,
      );
    }
    return {
      source: "miss",
      verdict: "needs-review",
      ...identity,
      record: null,
      answer: null,
    };
  }

  const state: DecisionState = {
    snapshot: input.state.snapshot,
    ...(input.state.url !== undefined ? { url: input.state.url } : {}),
    ...(goalSource !== undefined ? { goal: goalSource } : {}),
    ...(input.state.wallet !== undefined ? { wallet: input.state.wallet } : {}),
  };
  const answers = await callDecider(
    input.decider,
    state,
    { [QUESTION_NAME]: redacted.question },
    {
      redact: rules,
      deciderId: input.decider.id,
      ...(input.normalise !== undefined ? { normalise: input.normalise } : {}),
    },
  );
  const answer = answers[QUESTION_NAME];
  if (answer === undefined) {
    throw new CacheError("Decider returned no answer for the decision");
  }
  const verdict = gateAnswer(redacted.question, answer, thresholds);
  const record: DecisionRecord = {
    v: DECISION_SCHEMA_VERSION,
    key,
    spec,
    step,
    kind: redacted.kind,
    question: redacted.prompt,
    criteria: redacted.criteria,
    goal,
    choices: redacted.choices,
    snapshotHash,
    decider: deciderId,
    model,
    answer: answer.value,
    confidence: answer.confidence,
    verdict,
    thresholds,
    createdAt: at,
    lastUsedAt: at,
    reviewedBy: null,
  };
  if (input.mode === "record") await input.store.put(record, { replace: true });
  else await input.store.put(record);
  await input.store.noteReferenced(key, at);
  return {
    source: "decider",
    verdict,
    ...identity,
    record,
    answer: { value: answer.value, confidence: answer.confidence },
  };
}

/**
 * Append a reviewed copy of the winning record.
 * Review does not change confidence, so a low-confidence yes/no still
 * replays as `needs-review`.
 */
export async function reviewDecision(
  store: DecisionStore,
  key: string,
  reviewedBy: string,
  now: () => Date = defaultNow,
): Promise<DecisionRecord> {
  const reviewer = redactText(reviewedBy);
  if (reviewer.length === 0 || reviewer === REDACTED) {
    throw new CacheError(
      "reviewedBy must be a name that is safe to store. An email address is not.",
    );
  }
  const current = await store.get(key);
  if (current === null) throw new CacheError("No cached decision to review");
  const at = now().toISOString();
  const next = parseDecisionRecord({
    ...current,
    createdAt: at,
    lastUsedAt: at,
    reviewedBy: reviewer,
  });
  await store.put(next);
  return next;
}

export interface CacheAcceptance {
  readonly spec: string;
  readonly step: string;
  readonly reviewed: number;
  readonly total: number;
}

export interface CacheStats {
  readonly records: number;
  readonly keys: number;
  readonly specs: number;
  readonly superseded: number;
  readonly reviewed: number;
  readonly byVerdict: Readonly<Record<Verdict, number>>;
  readonly byKind: Readonly<Record<Question["kind"], number>>;
  readonly byDecider: Readonly<Record<string, number>>;
  readonly acceptance: {
    readonly reviewed: number;
    readonly total: number;
    readonly steps: readonly CacheAcceptance[];
  };
}

/** Counts stored lines. Acceptance uses winning records whose stored verdict is needs-review. */
export async function cacheStats(store: DecisionStore): Promise<CacheStats> {
  const records = await store.list();
  const winners = winnersOf(records);
  const byVerdict: Record<Verdict, number> = {
    pass: 0,
    fail: 0,
    "needs-review": 0,
  };
  const byKind: Record<Question["kind"], number> = {
    yesno: 0,
    choice: 0,
    score: 0,
  };
  const byDecider: Record<string, number> = {};
  const specs = new Set<string>();
  const keys = new Set<string>();
  let reviewed = 0;
  for (const record of records) {
    byVerdict[record.verdict] += 1;
    byKind[record.kind] += 1;
    byDecider[record.decider] = (byDecider[record.decider] ?? 0) + 1;
    specs.add(record.spec);
    keys.add(record.key);
    if (record.reviewedBy !== null) reviewed += 1;
  }
  const steps = new Map<string, CacheAcceptance>();
  for (const winner of winners) {
    if (winner.verdict !== "needs-review") continue;
    const id = `${winner.spec}\0${winner.step}`;
    const current = steps.get(id) ?? {
      spec: winner.spec,
      step: winner.step,
      reviewed: 0,
      total: 0,
    };
    steps.set(id, {
      spec: current.spec,
      step: current.step,
      reviewed: current.reviewed + (winner.reviewedBy !== null ? 1 : 0),
      total: current.total + 1,
    });
  }
  const acceptanceSteps = [...steps.values()].sort((a, b) => {
    if (a.spec !== b.spec) return a.spec < b.spec ? -1 : 1;
    if (a.step !== b.step) return a.step < b.step ? -1 : 1;
    return 0;
  });
  let accepted = 0;
  let needsReview = 0;
  for (const step of acceptanceSteps) {
    accepted += step.reviewed;
    needsReview += step.total;
  }
  return {
    records: records.length,
    keys: keys.size,
    specs: specs.size,
    superseded: records.length - winners.length,
    reviewed,
    byVerdict,
    byKind,
    byDecider,
    acceptance: {
      reviewed: accepted,
      total: needsReview,
      steps: acceptanceSteps,
    },
  };
}

export function formatCacheStats(stats: CacheStats): string {
  const lines = [
    `records: ${String(stats.records)}`,
    `keys: ${String(stats.keys)}`,
    `specs: ${String(stats.specs)}`,
    `superseded: ${String(stats.superseded)}`,
    `reviewed: ${String(stats.reviewed)}`,
    `verdict pass: ${String(stats.byVerdict.pass)}`,
    `verdict fail: ${String(stats.byVerdict.fail)}`,
    `verdict needs-review: ${String(stats.byVerdict["needs-review"])}`,
    `kind yesno: ${String(stats.byKind.yesno)}`,
    `kind choice: ${String(stats.byKind.choice)}`,
    `kind score: ${String(stats.byKind.score)}`,
  ];
  for (const id of Object.keys(stats.byDecider).sort()) {
    lines.push(`decider ${id}: ${String(stats.byDecider[id] ?? 0)}`);
  }
  lines.push(
    stats.acceptance.total === 0
      ? "acceptance overall: n/a"
      : `acceptance overall: ${String(stats.acceptance.reviewed)}/${String(stats.acceptance.total)}`,
  );
  for (const step of stats.acceptance.steps) {
    lines.push(
      `acceptance ${step.spec} ${step.step}: ${String(step.reviewed)}/${String(step.total)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface PruneCacheOptions {
  /** Drop winning records whose lastUsedAt is at or before now minus this many days. */
  readonly days?: number;
  /** Drop records whose key was not noted by the last record or replay-or-query run. */
  readonly notReferenced?: boolean;
  readonly now?: () => Date;
}

export interface PruneResult {
  readonly kept: number;
  readonly dropped: number;
  readonly droppedSuperseded: number;
  readonly droppedUnused: number;
}

/**
 * Keep one winning record per key, and drop that winner when it is unused.
 * Pass `days` or `notReferenced`, not both. Superseded lines are always dropped.
 */
export async function pruneCache(
  store: DecisionStore,
  options: PruneCacheOptions,
): Promise<PruneResult> {
  const hasDays = options.days !== undefined;
  const notReferenced = options.notReferenced === true;
  if (hasDays === notReferenced) {
    throw new CacheError(
      "Prune needs exactly one of --days or --not-referenced",
    );
  }
  const days = options.days;
  if (days !== undefined && (!Number.isSafeInteger(days) || days < 0)) {
    throw new CacheError("Prune days must be an integer >= 0");
  }
  const now = (options.now ?? defaultNow)().getTime();
  const cutoff = days === undefined ? 0 : now - days * 24 * 60 * 60 * 1000;
  const records = await store.list();
  const referenced = notReferenced ? await store.referencedKeys() : null;
  const groups = new Map<string, DecisionRecord[]>();
  for (const record of records) {
    const group = groups.get(record.key) ?? [];
    group.push(record);
    groups.set(record.key, group);
  }
  const kept: DecisionRecord[] = [];
  let droppedSuperseded = 0;
  let droppedUnused = 0;
  for (const group of groups.values()) {
    const winner = winningRecord(group);
    if (winner === null) continue;
    const superseded = group.length - 1;
    const unused =
      referenced !== null
        ? !referenced.has(winner.key)
        : Date.parse(winner.lastUsedAt) <= cutoff;
    droppedSuperseded += superseded;
    if (unused) {
      droppedUnused += 1;
      continue;
    }
    kept.push(winner);
  }
  await store.replaceAll(kept);
  return {
    kept: kept.length,
    dropped: records.length - kept.length,
    droppedSuperseded,
    droppedUnused,
  };
}

export function formatPruneResult(result: PruneResult): string {
  return [
    `kept: ${String(result.kept)}`,
    `dropped: ${String(result.dropped)}`,
    `dropped superseded: ${String(result.droppedSuperseded)}`,
    `dropped unused: ${String(result.droppedUnused)}`,
    "",
  ].join("\n");
}

/** The configured store, or a JSONL store in `cache.dir`. */
export function openDecisionStore(cache: {
  readonly dir: string;
  readonly store: DecisionStore | null;
}): DecisionStore {
  if (cache.store !== null) return cache.store;
  return new JsonlDecisionStore(cache.dir);
}

interface RedactedQuestion {
  readonly kind: Question["kind"];
  readonly prompt: string;
  readonly criteria: string | null;
  readonly choices: readonly DecisionChoice[];
  readonly question: Question;
}

function redactQuestion(
  question: Question,
  rules: readonly RedactRule[],
): RedactedQuestion {
  const prompt = requireText(redactText(question.prompt, rules), "prompt");
  if (question.kind === "yesno") {
    const criteria =
      question.criteria === undefined
        ? null
        : emptyToNull(redactText(question.criteria, rules));
    const redacted: Question =
      criteria === null
        ? { kind: "yesno", prompt }
        : { kind: "yesno", prompt, criteria };
    return { kind: "yesno", prompt, criteria, choices: [], question: redacted };
  }
  if (question.kind === "choice") {
    const choices = question.options.map((option) => ({
      id: requireText(redactText(option.id, rules), "choice id"),
      label: requireText(redactText(option.label, rules), "choice label"),
    }));
    return {
      kind: "choice",
      prompt,
      criteria: null,
      choices,
      question: { kind: "choice", prompt, options: choices },
    };
  }
  const choices = question.levels.map((level) => {
    const text = requireText(redactText(level, rules), "score level");
    return { id: text, label: text };
  });
  return {
    kind: "score",
    prompt,
    criteria: null,
    choices,
    question: {
      kind: "score",
      prompt,
      levels: choices.map((choice) => choice.label),
    },
  };
}

function winnersOf(records: readonly DecisionRecord[]): DecisionRecord[] {
  const groups = new Map<string, DecisionRecord[]>();
  for (const record of records) {
    const group = groups.get(record.key) ?? [];
    group.push(record);
    groups.set(record.key, group);
  }
  const winners: DecisionRecord[] = [];
  for (const group of groups.values()) {
    const winner = winningRecord(group);
    if (winner !== null) winners.push(winner);
  }
  return winners;
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

function requireText(value: string, path: string): string {
  if (value.length === 0) {
    throw new CacheError(`Cannot cache an empty ${path}`);
  }
  return value;
}

function defaultNow(): Date {
  return new Date();
}
