import { createHash } from "node:crypto";
import type { Question } from "../decider.js";
import { validateQuestion } from "../decider.js";
import { CacheError } from "../errors.js";
import { collapseWhitespace } from "../guards.js";
import { redactText, redactionCulprit } from "../redact.js";
import type { RedactRule } from "../redact.js";

/**
 * Version of the key payload. Bump it whenever the payload or the way any of
 * its fields is derived changes, so an old record can never be a hit for a
 * question it was not asked. Bump `DECISION_RECORD_VERSION` with it, so a
 * store can tell an old record from a current one and skip it.
 *
 * 2: the spec joined the key.
 */
export const DECISION_KEY_VERSION = 2;

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface DecisionKeyInput {
  /**
   * The spec the question is asked in, hashed exactly as written. A spec that
   * redaction or normalisation would change is refused (`assertSpecKeyable`).
   */
  readonly spec: string;
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
 * `{ v, spec, kind, question, options, snapshotHash, decider, model }`.
 *
 * The spec is in the key so that one spec's record, and a person's review of
 * it, can never answer the same question asked in another spec, and so that
 * deleting one spec's file cannot remove another's answer. It is hashed as
 * written, and only a spec that redaction leaves as it is gets a key. The
 * step is not in the key: it is an ordinal, and inserting an assertion would
 * move every later one.
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
  assertSpecKeyable(input.spec, input.redact);
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
    spec: input.spec,
    kind: question.kind,
    question: questionText(question, input.redact),
    options: keyOptions(question),
    snapshotHash,
    decider: deciderId,
    model,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * Throw `CacheError` unless `spec` is a non-empty string that redaction and
 * normalisation leave exactly as it is.
 *
 * The record must hold the spec redacted, and the key must cover the spec the
 * record names. If redaction changed the spec, two specs that redact alike
 * (`tests/alice@example.com.spec.ts` and `tests/bob@example.org.spec.ts`)
 * would share every key and one cache file, and a person's review of one
 * would replay as the other's verdict. Refusing is the only safe choice: the
 * secret cannot go into the record, and a redacted spec cannot tell the two
 * apart. The message names the rule, never the secret, and says to rename the
 * file. A rule set that cannot redact stably throws `RedactionError` first.
 */
export function assertSpecKeyable(
  spec: unknown,
  redact: readonly RedactRule[] = [],
): asserts spec is string {
  assertIdentity(spec, "spec");
  if (redactText(spec, redact) === spec) return;
  throw new CacheError(
    `A spec path is changed by ${specChange(spec, redact)}, so it cannot key a decision: two spec files could share one record and one cache file. Rename the spec file so that its path contains nothing that looks like a secret or personal data, and no unusual spaces or compatibility characters.`,
  );
}

/** What changes a spec: normalisation, or the first rule that matches. */
function specChange(spec: string, redact: readonly RedactRule[]): string {
  if (collapseWhitespace(spec) !== spec) {
    return "normalisation (Unicode NFKC or collapsed whitespace)";
  }
  const culprit = redactionCulprit(spec, redact);
  return typeof culprit === "number"
    ? `the project rule redact[${String(culprit)}]`
    : `the built-in "${String(culprit)}" redaction pattern`;
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

function assertIdentity(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CacheError(`decisionKey ${field} must be a non-empty string`);
  }
}
