import { CacheError, JevyError } from "../errors.js";
import { isRecord } from "../guards.js";
import { assertThresholds } from "../verdict.js";
import type { Thresholds, Verdict } from "../verdict.js";
import { isSha256 } from "./key.js";

export type DecisionKind = "yesno" | "choice" | "score";

/**
 * One stored decision: one line of a spec's JSONL file.
 *
 * It holds the question text and hashes, never the snapshot or other page
 * text, so a committed cache does not leak the pages it was recorded on.
 * `verdict`, `thresholds` and `rules` are what applied at write time; a replay
 * re-gates with the current thresholds and reports the difference.
 * `reviewedBy` and `reviewVerdict` are both null or both set: a person's
 * decision on a `needs-review` answer, which a replay returns as is.
 */
export interface DecisionRecord {
  readonly v: 2;
  readonly key: string;
  readonly spec: string;
  readonly step: string;
  readonly kind: DecisionKind;
  readonly question: string;
  readonly snapshotHash: string;
  readonly decider: string;
  readonly model: string;
  readonly answer: string;
  readonly confidence: number;
  readonly abstained: boolean;
  readonly truncated: boolean;
  readonly verdict: Verdict;
  readonly thresholds: Thresholds;
  readonly rules: string;
  readonly createdAt: string;
  readonly reviewedBy: string | null;
  readonly reviewVerdict: "pass" | "fail" | null;
}

/**
 * Moves with `DECISION_KEY_VERSION`: a record's version says which key
 * version computed its `key`. 2: keys that cover the spec.
 */
export const DECISION_RECORD_VERSION = 2;

/**
 * Versions an older Jevy wrote, with the fields each one allowed. Their keys
 * came from an older key version, so no key computed today can find them; a
 * store skips them, and the step misses with `no-entry` and is asked again.
 *
 * A skipped line is still checked against its version's field list, so a
 * committed cache cannot carry page text in an old-looking line that a
 * current line would refuse. The list is version 1's as released, kept here
 * on its own so a later change to `FIELDS` cannot widen it.
 */
const SUPERSEDED_FIELDS: ReadonlyMap<unknown, readonly string[]> = new Map([
  [
    1,
    [
      "v",
      "key",
      "spec",
      "step",
      "kind",
      "question",
      "snapshotHash",
      "decider",
      "model",
      "answer",
      "confidence",
      "abstained",
      "truncated",
      "verdict",
      "thresholds",
      "rules",
      "createdAt",
      "reviewedBy",
      "reviewVerdict",
    ],
  ],
]);

const FIELDS: readonly (keyof DecisionRecord)[] = [
  "v",
  "key",
  "spec",
  "step",
  "kind",
  "question",
  "snapshotHash",
  "decider",
  "model",
  "answer",
  "confidence",
  "abstained",
  "truncated",
  "verdict",
  "thresholds",
  "rules",
  "createdAt",
  "reviewedBy",
  "reviewVerdict",
];

const KINDS: readonly string[] = ["yesno", "choice", "score"];
const VERDICTS: readonly string[] = ["pass", "fail", "needs-review"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * One line of JSON with the keys always in the declared order, so a git diff
 * of a cache file shows only what changed. The record is validated first and
 * rebuilt field by field. A property that is not part of the format (a
 * snapshot, say) is a CacheError rather than silently dropped, because it
 * points at a caller that is trying to store page content.
 */
export function serialiseRecord(record: DecisionRecord): string {
  return JSON.stringify(checkRecord(record));
}

/**
 * Parse and validate one line. Any problem, including an unknown key or a
 * different `v`, is a CacheError: a record that does not match the format
 * exactly is not trusted for replay.
 */
export function parseRecord(line: string): DecisionRecord {
  return checkRecord(parseJson(line));
}

/**
 * `parseRecord` for a line read from a cache file: a record of a superseded
 * version is undefined rather than an error, so a cache written before a key
 * change still loads and its steps miss cleanly. Its field names are checked
 * against that version's list, and an unknown one throws, as for a current
 * record; its values are not, because it is never replayed. Any other
 * problem still throws.
 */
export function readRecordLine(line: string): DecisionRecord | undefined {
  const value = parseJson(line);
  if (isRecord(value)) {
    const fields = SUPERSEDED_FIELDS.get(value["v"]);
    if (fields !== undefined) {
      assertKnownFields(value, fields);
      return undefined;
    }
  }
  return checkRecord(value);
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new CacheError("Decision record is not valid JSON");
  }
}

function checkRecord(value: unknown): DecisionRecord {
  if (!isRecord(value)) {
    throw new CacheError("Decision record must be a JSON object");
  }
  assertKnownFields(value, FIELDS);
  if (value["v"] !== DECISION_RECORD_VERSION) {
    throw new CacheError(
      `Decision record v must be ${String(DECISION_RECORD_VERSION)}`,
    );
  }
  const kind = readEnum(value, "kind", KINDS) as DecisionKind;
  const answer = readText(value, "answer");
  const abstained = readBoolean(value, "abstained");
  if (kind === "yesno" && !abstained && answer !== "yes" && answer !== "no") {
    throw new CacheError(
      'Decision record answer for a yesno question must be "yes" or "no"',
    );
  }
  const { reviewedBy, reviewVerdict } = readReview(value);
  return {
    v: DECISION_RECORD_VERSION,
    key: readHash(value, "key"),
    spec: readText(value, "spec"),
    step: readText(value, "step"),
    kind,
    question: readText(value, "question"),
    snapshotHash: readHash(value, "snapshotHash"),
    decider: readText(value, "decider"),
    model: readText(value, "model"),
    answer,
    confidence: readConfidence(value),
    abstained,
    truncated: readBoolean(value, "truncated"),
    verdict: readEnum(value, "verdict", VERDICTS) as Verdict,
    thresholds: readThresholds(value),
    rules: readHash(value, "rules"),
    createdAt: readCreatedAt(value),
    reviewedBy,
    reviewVerdict,
  };
}

function assertKnownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const name of Object.keys(value)) {
    if (!fields.includes(name)) {
      throw new CacheError(`Decision record has an unknown field "${name}"`);
    }
  }
}

function readText(value: Record<string, unknown>, field: string): string {
  const text = value[field];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new CacheError(`Decision record ${field} must be a non-empty string`);
  }
  return text;
}

function readHash(value: Record<string, unknown>, field: string): string {
  const hash = value[field];
  if (!isSha256(hash)) {
    throw new CacheError(
      `Decision record ${field} must be sha256: plus 64 lowercase hex characters`,
    );
  }
  return hash;
}

function readBoolean(value: Record<string, unknown>, field: string): boolean {
  const flag = value[field];
  if (typeof flag !== "boolean") {
    throw new CacheError(`Decision record ${field} must be a boolean`);
  }
  return flag;
}

function readEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): string {
  const text = value[field];
  if (typeof text !== "string" || !allowed.includes(text)) {
    throw new CacheError(
      `Decision record ${field} must be one of ${allowed.join(", ")}`,
    );
  }
  return text;
}

function readConfidence(value: Record<string, unknown>): number {
  const confidence = value["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new CacheError(
      "Decision record confidence must be a finite number from 0 to 1",
    );
  }
  return confidence;
}

function readThresholds(value: Record<string, unknown>): Thresholds {
  const thresholds = value["thresholds"];
  if (!isRecord(thresholds)) {
    throw new CacheError("Decision record thresholds must be an object");
  }
  const names = Object.keys(thresholds).sort();
  if (names.length !== 2 || names[0] !== "fail" || names[1] !== "pass") {
    throw new CacheError(
      "Decision record thresholds must have exactly pass and fail",
    );
  }
  const pass = thresholds["pass"];
  const fail = thresholds["fail"];
  if (typeof pass !== "number" || typeof fail !== "number") {
    throw new CacheError("Decision record thresholds must be numbers");
  }
  try {
    assertThresholds({ pass, fail });
  } catch (error: unknown) {
    if (error instanceof JevyError) {
      throw new CacheError(`Decision record thresholds: ${error.message}`);
    }
    throw error;
  }
  return { pass, fail };
}

/**
 * ISO 8601 in UTC (`Z`), and a real instant: a day that does not exist in
 * its month is rejected rather than rolled over.
 */
function readCreatedAt(value: Record<string, unknown>): string {
  const createdAt = value["createdAt"];
  if (typeof createdAt !== "string" || !ISO_UTC.test(createdAt)) {
    throw new CacheError(
      "Decision record createdAt must be an ISO 8601 UTC timestamp",
    );
  }
  const time = Date.parse(createdAt);
  if (
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 19) !== createdAt.slice(0, 19)
  ) {
    throw new CacheError(
      "Decision record createdAt must be an ISO 8601 UTC timestamp",
    );
  }
  return createdAt;
}

function readReview(value: Record<string, unknown>): {
  readonly reviewedBy: string | null;
  readonly reviewVerdict: "pass" | "fail" | null;
} {
  const reviewedBy = value["reviewedBy"];
  const reviewVerdict = value["reviewVerdict"];
  if (reviewedBy === null && reviewVerdict === null) {
    return { reviewedBy: null, reviewVerdict: null };
  }
  if (
    typeof reviewedBy !== "string" ||
    reviewedBy.trim().length === 0 ||
    (reviewVerdict !== "pass" && reviewVerdict !== "fail")
  ) {
    throw new CacheError(
      'Decision record reviewedBy and reviewVerdict must both be null, or a non-empty reviewer and "pass" or "fail"',
    );
  }
  return { reviewedBy, reviewVerdict };
}
