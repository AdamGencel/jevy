import { createHash } from "node:crypto";
import type { Question } from "../decider.js";
import { validateQuestion } from "../decider.js";
import { CacheError } from "../errors.js";
import { redactText } from "../redact.js";
import type { RedactRule } from "../redact.js";

/**
 * Version of the key payload. Bump it whenever the payload or the way any of
 * its fields is derived changes, so an old record can never be a hit for a
 * question it was not asked.
 */
export const DECISION_KEY_VERSION = 1;

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface DecisionKeyInput {
  readonly question: Question;
  readonly snapshotHash: string;
  readonly deciderId: string;
  readonly model: string;
  /**
   * The project's redact rules. The prompt is redacted before it is hashed,
   * so the key and the stored record carry the same question text.
   */
  readonly redact?: readonly RedactRule[];
}

/**
 * The question as it is keyed and stored: redacted, whitespace collapsed.
 *
 * Yes/no criteria change what the decider is asked, so they are part of it.
 * Prompt and criteria are redacted separately and joined by a newline. A
 * collapsed part never contains a newline, so a prompt that happens to read
 * "… Criteria: …" cannot produce the same text as a real criteria.
 */
export function questionText(
  question: Question,
  redactRules: readonly RedactRule[] = [],
): string {
  const prompt = redactText(question.prompt, redactRules);
  if (question.kind !== "yesno" || question.criteria === undefined) {
    return prompt;
  }
  return `${prompt}\nCriteria: ${redactText(question.criteria, redactRules)}`;
}

/**
 * `sha256:` plus 64 hex over canonical JSON with a fixed key order:
 * `{ v, kind, question, options, snapshotHash, decider, model }`.
 *
 * Choice options are `{ id, label }` sorted by id: their order is not
 * meaningful, but a changed label changes what the option means. Score levels
 * keep their order, because the order is the scale. Yes/no has none.
 *
 * Option labels and levels are not redacted. They only reach the hash, never
 * a record, and redacting them could make two different questions share a key.
 */
export function decisionKey(input: DecisionKeyInput): string {
  const { question, snapshotHash, deciderId, model } = input;
  validateQuestion(question);
  if (typeof snapshotHash !== "string" || !SHA256.test(snapshotHash)) {
    throw new CacheError(
      "decisionKey snapshotHash must be sha256: plus 64 lowercase hex characters",
    );
  }
  assertIdentity(deciderId, "deciderId");
  assertIdentity(model, "model");
  const payload = JSON.stringify({
    v: DECISION_KEY_VERSION,
    kind: question.kind,
    question: questionText(question, input.redact),
    options: keyOptions(question),
    snapshotHash,
    decider: deciderId,
    model,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/** True for `sha256:` plus 64 lowercase hex characters. */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function keyOptions(question: Question): unknown[] {
  switch (question.kind) {
    case "choice":
      return question.options
        .map((option) => ({ id: option.id, label: option.label }))
        .sort((a, b) => compareCodeUnits(a.id, b.id));
    case "score":
      return [...question.levels];
    case "yesno":
      return [];
  }
}

/** Locale-independent order, so the key is the same on every machine. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function assertIdentity(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CacheError(`decisionKey ${field} must be a non-empty string`);
  }
}
