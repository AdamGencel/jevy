import type { Answer } from "@jevyjs/core";
import { ABSTAIN_BASE_IDS } from "./schema.js";
import type { AskedQuestion } from "./schema.js";

/**
 * The outcome of reading one reply. An invalid reply is a value, not a
 * thrown error, because it is asked again. Each attempt's problem is kept,
 * and the `DeciderError` names them in order (the first few, then a count).
 *
 * `problem` names what is wrong and which question it is about. It never
 * quotes the reply: a model's output can repeat page text or a secret, and
 * the message ends up in test output and reports. A key the model invented
 * is not named either, for the same reason.
 */
export type ReplyResult =
  | { readonly ok: true; readonly answers: Readonly<Record<string, Answer>> }
  | { readonly ok: false; readonly problem: string };

/**
 * Check a reply against the questions and map it to answers. Nothing is
 * coerced: a JSON string is not parsed, `"0.9"` is not a number, `"Yes"` is
 * not `"yes"`. The reply must be a plain object whose own keys are exactly
 * the asked names, each holding exactly `value` and `confidence`, as the
 * schema says. Own properties only, as `assertAnswers` checks: an answer
 * inherited from a prototype is missing, not present.
 *
 * The abstain id maps to `{ value: "inconclusive" | "none", confidence,
 * abstained: true }`, with the plain word even when the schema used a
 * suffixed id, so the stored value reads the same for every question.
 */
export function readReply(
  reply: unknown,
  asked: readonly AskedQuestion[],
): ReplyResult {
  try {
    return readObject(reply, asked);
  } catch {
    // A getter or a proxy in the reply threw. Its message may hold anything.
    return { ok: false, problem: "reading the reply threw an error" };
  }
}

function readObject(
  reply: unknown,
  asked: readonly AskedQuestion[],
): ReplyResult {
  if (!isPlainObject(reply)) {
    return { ok: false, problem: "the reply is not a JSON object" };
  }
  const names = new Set(asked.map((item) => item.name));
  if (Object.keys(reply).some((key) => !names.has(key))) {
    return {
      ok: false,
      problem: "the reply has an answer to a question that was not asked",
    };
  }
  const answers: [string, Answer][] = [];
  for (const item of asked) {
    if (!Object.hasOwn(reply, item.name)) {
      return { ok: false, problem: `the reply has no answer to ${q(item)}` };
    }
    const read = readAnswer(reply[item.name], item);
    if (typeof read === "string") return { ok: false, problem: read };
    answers.push([item.name, read]);
  }
  // `Object.fromEntries` keeps a question named `__proto__` an own property.
  return { ok: true, answers: Object.fromEntries(answers) };
}

/** The answer, or the problem with it. */
function readAnswer(entry: unknown, item: AskedQuestion): Answer | string {
  if (!isPlainObject(entry)) {
    return `the answer to ${q(item)} is not a JSON object`;
  }
  const keys = Object.keys(entry);
  if (keys.some((key) => key !== "value" && key !== "confidence")) {
    return `the answer to ${q(item)} has fields other than value and confidence`;
  }
  const value = Object.hasOwn(entry, "value") ? entry["value"] : undefined;
  const confidence = Object.hasOwn(entry, "confidence")
    ? entry["confidence"]
    : undefined;
  const isAbstain = value === item.abstain;
  if (
    typeof value !== "string" ||
    (!isAbstain && !item.values.includes(value))
  ) {
    return `the value of ${q(item)} is not one of the allowed values`;
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return `the confidence of ${q(item)} is not a finite number from 0 to 1`;
  }
  return isAbstain
    ? {
        value: ABSTAIN_BASE_IDS[item.question.kind],
        confidence,
        abstained: true,
      }
    : { value, confidence };
}

/**
 * An object made by `JSON.parse` or a literal: its prototype is
 * `Object.prototype` or null. A `Map`, a `Date` or a class instance is not
 * what the schema describes.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The question's name, quoted. Names come from the test, not the model. */
function q(item: AskedQuestion): string {
  return JSON.stringify(item.name);
}
