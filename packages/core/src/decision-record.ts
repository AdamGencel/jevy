import { createHash } from "node:crypto";
import type { Question } from "./decider.js";
import { CacheError } from "./errors.js";
import { RedactionError } from "./errors.js";
import { isRecord } from "./guards.js";
import { redactText } from "./redact.js";
import type { RedactRule } from "./redact.js";
import type { Thresholds, Verdict } from "./verdict.js";
import { assertThresholds } from "./verdict.js";

/**
 * Schema version hashed into the cache key and stored on every record.
 * Bumping it misses every old key and rejects records from the previous schema.
 */
export const DECISION_SCHEMA_VERSION = 1;

export const DECISION_RECORD_FIELDS = [
  "v",
  "key",
  "spec",
  "step",
  "kind",
  "question",
  "criteria",
  "goal",
  "choices",
  "snapshotHash",
  "decider",
  "model",
  "answer",
  "confidence",
  "verdict",
  "thresholds",
  "createdAt",
  "lastUsedAt",
  "reviewedBy",
] as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KINDS = ["choice", "yesno", "score"] as const;
const VERDICTS = ["pass", "fail", "needs-review"] as const;

export interface DecisionChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * One JSONL line. Field order is fixed by `serialiseDecisionRecord`.
 * `criteria` and `goal` are null when the question had none.
 * `reviewedBy` is null until a person accepts the cached answer.
 * The snapshot itself is not stored.
 */
export interface DecisionRecord {
  readonly v: typeof DECISION_SCHEMA_VERSION;
  readonly key: string;
  readonly spec: string;
  readonly step: string;
  readonly kind: Question["kind"];
  readonly question: string;
  readonly criteria: string | null;
  readonly goal: string | null;
  readonly choices: readonly DecisionChoice[];
  readonly snapshotHash: string;
  readonly decider: string;
  readonly model: string;
  readonly answer: string;
  readonly confidence: number;
  readonly verdict: Verdict;
  readonly thresholds: Thresholds;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly reviewedBy: string | null;
}

export interface DecisionKeyInput {
  readonly kind: Question["kind"];
  readonly prompt: string;
  readonly criteria?: string;
  readonly goal?: string;
  readonly choices?: readonly DecisionChoice[];
  readonly snapshotHash: string;
  readonly deciderId: string;
  readonly model: string;
  readonly redact?: readonly RedactRule[];
}

/**
 * Canonical JSON hashed into the key. Strings are redacted first.
 * `criteria` and `goal` use "" when absent, so a missing goal and an empty
 * goal share a key. Choice order is the order the question was asked.
 */
export function decisionKeyMaterial(input: DecisionKeyInput): string {
  const rules = input.redact ?? [];
  const choices = (input.choices ?? []).map((choice) => ({
    id: redactText(choice.id, rules),
    label: redactText(choice.label, rules),
  }));
  const snapshotHash = readHash(input.snapshotHash, "snapshotHash");
  return JSON.stringify({
    v: DECISION_SCHEMA_VERSION,
    kind: input.kind,
    prompt: redactText(input.prompt, rules),
    criteria:
      input.criteria === undefined ? "" : redactText(input.criteria, rules),
    goal: input.goal === undefined ? "" : redactText(input.goal, rules),
    choices,
    snapshotHash,
    deciderId: redactText(input.deciderId, rules),
    model: redactText(input.model, rules),
  });
}

/** `sha256:` of the schema, kind, prompt, goal, choices, snapshot hash, decider, and model. */
export function decisionKey(input: DecisionKeyInput): string {
  const hex = createHash("sha256")
    .update(decisionKeyMaterial(input))
    .digest("hex");
  return `sha256:${hex}`;
}

/** One JSON line with keys in `DECISION_RECORD_FIELDS` order. */
export function serialiseDecisionRecord(record: DecisionRecord): string {
  const choices = record.choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
  }));
  const line = JSON.stringify({
    v: record.v,
    key: record.key,
    spec: record.spec,
    step: record.step,
    kind: record.kind,
    question: record.question,
    criteria: record.criteria,
    goal: record.goal,
    choices,
    snapshotHash: record.snapshotHash,
    decider: record.decider,
    model: record.model,
    answer: record.answer,
    confidence: record.confidence,
    verdict: record.verdict,
    thresholds: { pass: record.thresholds.pass, fail: record.thresholds.fail },
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    reviewedBy: record.reviewedBy,
  });
  if (line.includes("\n") || line.includes("\r")) {
    throw new CacheError("Decision record serialised to more than one line");
  }
  return line;
}

export function parseDecisionRecord(value: unknown): DecisionRecord {
  if (!isRecord(value))
    throw new CacheError("Decision record must be an object");
  const unknown = Object.keys(value).filter(
    (key) => !(DECISION_RECORD_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new CacheError(
      `Decision record has unknown keys: ${unknown.join(", ")}`,
    );
  }
  for (const field of DECISION_RECORD_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new CacheError(`Decision record is missing ${field}`);
    }
  }
  if (value["v"] !== DECISION_SCHEMA_VERSION) {
    throw new CacheError(
      `Decision record schema v must be ${String(DECISION_SCHEMA_VERSION)}`,
    );
  }
  const record: DecisionRecord = {
    v: DECISION_SCHEMA_VERSION,
    key: readHash(value["key"], "key"),
    spec: readLine(value["spec"], "spec"),
    step: readLine(value["step"], "step"),
    kind: readEnum(value["kind"], KINDS, "kind"),
    question: readLine(value["question"], "question"),
    criteria: readNullableLine(value["criteria"], "criteria"),
    goal: readNullableLine(value["goal"], "goal"),
    choices: readChoices(value["choices"]),
    snapshotHash: readHash(value["snapshotHash"], "snapshotHash"),
    decider: readLine(value["decider"], "decider"),
    model: readLine(value["model"], "model"),
    answer: readLine(value["answer"], "answer"),
    confidence: readUnit(value["confidence"], "confidence"),
    verdict: readEnum(value["verdict"], VERDICTS, "verdict"),
    thresholds: readThresholds(value["thresholds"]),
    createdAt: readTime(value["createdAt"], "createdAt"),
    lastUsedAt: readTime(value["lastUsedAt"], "lastUsedAt"),
    reviewedBy: readNullableLine(value["reviewedBy"], "reviewedBy"),
  };
  return record;
}

/**
 * Refuse a record whose JSON still matches a secret or personal-data pattern.
 * Callers must redact first. This is the last check before a write.
 */
export function assertSafeToStore(record: DecisionRecord): DecisionRecord {
  const parsed = parseDecisionRecord(record);
  const line = serialiseDecisionRecord(parsed);
  let redacted: string;
  try {
    redacted = redactText(line);
  } catch (error: unknown) {
    if (error instanceof RedactionError) throw error;
    throw error;
  }
  if (redacted !== line) {
    throw new RedactionError(
      "Refusing to write a decision record that still contains a secret or personal data.",
    );
  }
  return parsed;
}

/** Newest createdAt wins. A reviewed record beats any unreviewed one. */
export function winningRecord(
  records: readonly DecisionRecord[],
): DecisionRecord | null {
  const reviewed = records.filter((record) => record.reviewedBy !== null);
  const pool = reviewed.length > 0 ? reviewed : records;
  let winner: DecisionRecord | null = null;
  for (const record of pool) {
    if (winner === null || compareRecency(record, winner) > 0) winner = record;
  }
  return winner;
}

/** File order: key, then createdAt, then spec, then step. */
export function compareRecords(a: DecisionRecord, b: DecisionRecord): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  const time = compareIso(a.createdAt, b.createdAt);
  if (time !== 0) return time;
  if (a.spec !== b.spec) return a.spec < b.spec ? -1 : 1;
  if (a.step !== b.step) return a.step < b.step ? -1 : 1;
  if (a.answer !== b.answer) return a.answer < b.answer ? -1 : 1;
  return 0;
}

function compareRecency(a: DecisionRecord, b: DecisionRecord): number {
  const time = compareIso(a.createdAt, b.createdAt);
  if (time !== 0) return time;
  return compareRecords(a, b);
}

function compareIso(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function readChoices(value: unknown): readonly DecisionChoice[] {
  if (!Array.isArray(value)) {
    throw new CacheError("Decision record choices must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CacheError(
        `Decision record choices[${String(index)}] is invalid`,
      );
    }
    const extra = Object.keys(entry).filter(
      (key) => key !== "id" && key !== "label",
    );
    if (extra.length > 0) {
      throw new CacheError(
        `Decision record choices[${String(index)}] has unknown keys: ${extra.join(", ")}`,
      );
    }
    return {
      id: readLine(entry["id"], `choices[${String(index)}].id`),
      label: readLine(entry["label"], `choices[${String(index)}].label`),
    };
  });
}

function readThresholds(value: unknown): Thresholds {
  if (!isRecord(value))
    throw new CacheError("Decision record thresholds must be an object");
  const extra = Object.keys(value).filter(
    (key) => key !== "pass" && key !== "fail",
  );
  if (extra.length > 0) {
    throw new CacheError(
      `Decision record thresholds has unknown keys: ${extra.join(", ")}`,
    );
  }
  const thresholds = {
    pass: readUnit(value["pass"], "thresholds.pass"),
    fail: readUnit(value["fail"], "thresholds.fail"),
  };
  try {
    assertThresholds(thresholds);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "invalid thresholds";
    throw new CacheError(message);
  }
  return thresholds;
}

function readHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CacheError(`${path} must be sha256: and 64 hex characters`);
  }
  return value;
}

function readLine(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new CacheError(`${path} must be a non-empty single line`);
  }
  return value;
}

function readNullableLine(value: unknown, path: string): string | null {
  if (value === null) return null;
  return readLine(value, path);
}

function readUnit(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new CacheError(`${path} must be a finite number from 0 to 1`);
  }
  return value;
}

function readTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_TIME.test(value)) {
    throw new CacheError(`${path} must be a UTC ISO-8601 timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new CacheError(`${path} is not a real timestamp`);
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !includes(allowed, value)) {
    throw new CacheError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function includes<T extends string>(
  allowed: readonly T[],
  value: string,
): value is T {
  for (const entry of allowed) {
    if (entry === value) return true;
  }
  return false;
}
