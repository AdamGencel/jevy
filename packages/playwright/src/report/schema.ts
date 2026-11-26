import { JevyError, assertSpecPath } from "@jevyjs/core";
import type { CacheMode, MissReason, Verdict } from "@jevyjs/core";

/**
 * `report.json` v1: the types, and the strict parser for one entry.
 *
 * The matcher attaches one entry per `toSatisfy` call, in a worker; the
 * reporter reads it in the runner process. This file is the contract between
 * them, so the parser accepts exactly the documented shape and nothing more:
 * a typo or a new field on one side fails loudly instead of drifting.
 */

/** The name of the attachment that carries one entry from a worker. */
export const REPORT_ATTACHMENT_NAME = "jevy-assertion";
export const REPORT_ATTACHMENT_CONTENT_TYPE = "application/json";
export const REPORT_VERSION = 1;
export const REPORT_TOOL = "jevy-report";

/**
 * The report, its entries or an attachment are malformed.
 * Kept here rather than in core's `errors.ts`, which another work package
 * owns in this step; it extends core's `JevyError` so a caller that catches
 * any Jevy failure catches this too.
 */
export class ReportError extends JevyError {}

/** Why a verdict is not a pass, beyond core's miss reasons. */
export type NeedsReviewReason =
  | MissReason // a replay miss, or a hit re-gated below the threshold
  | "abstained"
  | "low-confidence"
  | "truncated"
  | "decider-error";

/** `answered-no`: the decider said no. `reviewed`: a person said fail. */
export type FailReason = "answered-no" | "reviewed";

export type Reason = NeedsReviewReason | FailReason;

/**
 * What the verdict did to the test. `none` on a pass; `reported` when it was
 * only reported (advisory, or a warning under the needs-review policy);
 * `failed` when the assertion failed the test. The matcher decides this from
 * policy; the reporter copies it and never recomputes it.
 */
export type Effect = "none" | "reported" | "failed";

export interface ReportAnswer {
  readonly value: string;
  readonly confidence: number;
  readonly abstained: boolean;
}

/** One `toSatisfy` call. The keys are written in this order. */
export interface ReportAssertion {
  /** The test file relative to the Jevy root, as in the decision record. */
  readonly spec: string;
  /** Playwright project name, `""` when unnamed. */
  readonly project: string;
  /** Describe titles, then the test title. */
  readonly test: readonly string[];
  /** As in the decision record. */
  readonly step: string;
  /** The test's line in `spec`, from 1. */
  readonly line: number;
  /** The question as stored: redacted, whitespace collapsed. */
  readonly statement: string;
  readonly target: "page" | "locator";
  readonly verdict: Verdict;
  readonly source: "cache" | "review" | "decider" | "none";
  /** Core's miss reason, also on a pass that followed a miss. */
  readonly missReason: MissReason | null;
  /** Why it is not a pass; null on a pass. */
  readonly reason: Reason | null;
  readonly truncated: boolean;
  /** Null exactly when `source` is `none`: nothing answered. */
  readonly answer: ReportAnswer | null;
  readonly decider: string;
  readonly model: string;
  readonly key: string;
  readonly snapshotHash: string;
  readonly mode: CacheMode;
  readonly effect: Effect;
  /** The attempt this entry is from, 0 for the first. */
  readonly retry: number;
}

/**
 * Counts over `assertions`, which hold only each test's last attempt.
 * `pass + fail + needsReview` is the number of assertions. `failedTest` is the
 * number of assertions whose `effect` is `failed`: those that failed their
 * test. Each is counted once per project it ran in. `incomplete` is the
 * length of the report's `incomplete` list.
 */
export interface ReportSummary {
  readonly pass: number;
  readonly fail: number;
  readonly needsReview: number;
  readonly failedTest: number;
  readonly incomplete: number;
}

/** Playwright's `FullResult.status`: how the whole run ended. */
export type RunStatus = "passed" | "failed" | "timedout" | "interrupted";

/** Playwright's `TestResult.status`: how one attempt of one test ended. */
export type AttemptStatus =
  "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

export const RUN_STATUSES = [
  "passed",
  "failed",
  "timedout",
  "interrupted",
] as const satisfies readonly RunStatus[];

export const ATTEMPT_STATUSES = [
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
] as const satisfies readonly AttemptStatus[];

/**
 * The run's outcome. A report whose assertions all pass can still come from a
 * run that failed, timed out or was interrupted; an agent reading only the
 * assertions would otherwise take it as clean.
 */
export interface ReportRun {
  readonly status: RunStatus;
}

/**
 * A test whose assertions in this report may be partial. It is listed when
 * its last attempt timed out or was interrupted, so later `toSatisfy` calls
 * may never have run, or when that attempt has fewer entries than an earlier
 * attempt had, so the dropped attempt's extra assertions are not reported.
 * Its entries, if any, are still in `assertions`. The keys are written in
 * this order.
 */
export interface ReportIncomplete {
  /** The test file relative to the Jevy root, as in `ReportAssertion`. */
  readonly spec: string;
  readonly project: string;
  /** Describe titles, then the test title; anonymous describes are left out. */
  readonly test: readonly string[];
  readonly line: number;
  /** The last attempt, whose entries are the ones reported. */
  readonly retry: number;
  /**
   * How the last attempt ended. `interrupted` also when Playwright stopped
   * the run before the attempt ended and never reported its end, as it does
   * on a global timeout.
   */
  readonly status: AttemptStatus;
  /** How many entries the last attempt has. */
  readonly entries: number;
  /** The most entries any earlier attempt had; 0 when there was none. */
  readonly entriesInEarlierAttempt: number;
}

/**
 * Still `v: 1`: nothing has been released, so `run` and `incomplete` join the
 * first version rather than starting a second.
 */
export interface JevyReport {
  readonly v: 1;
  readonly tool: "jevy-report";
  readonly run: ReportRun;
  readonly summary: ReportSummary;
  readonly assertions: readonly ReportAssertion[];
  readonly incomplete: readonly ReportIncomplete[];
}

const ENTRY_KEYS = [
  "spec",
  "project",
  "test",
  "step",
  "line",
  "statement",
  "target",
  "verdict",
  "source",
  "missReason",
  "reason",
  "truncated",
  "answer",
  "decider",
  "model",
  "key",
  "snapshotHash",
  "mode",
  "effect",
  "retry",
] as const;

const ANSWER_KEYS = ["value", "confidence", "abstained"] as const;

const TARGETS = ["page", "locator"] as const;
const VERDICTS = ["pass", "fail", "needs-review"] as const;
const SOURCES = ["cache", "review", "decider", "none"] as const;
const MODES = ["replay", "replay-or-query", "record"] as const;
const EFFECTS = ["none", "reported", "failed"] as const;
const MISS_REASONS = [
  "no-entry",
  "snapshot-changed",
  "model-changed",
  "redaction-changed",
  "regated-below-threshold",
] as const satisfies readonly MissReason[];
const NEEDS_REVIEW_REASONS = [
  ...MISS_REASONS,
  "abstained",
  "low-confidence",
  "truncated",
  "decider-error",
] as const satisfies readonly NeedsReviewReason[];
const FAIL_REASONS = [
  "answered-no",
  "reviewed",
] as const satisfies readonly FailReason[];
const REASONS: readonly Reason[] = [...NEEDS_REVIEW_REASONS, ...FAIL_REASONS];
/** The miss reasons `missReason()` returns for a miss: never re-gated. */
const NEEDS_REVIEW_MISS_REASONS = [
  "no-entry",
  "snapshot-changed",
  "model-changed",
  "redaction-changed",
] as const satisfies readonly MissReason[];

const HASH = /^sha256:[0-9a-f]{64}$/;

type Fields = Readonly<Record<string, unknown>>;

/**
 * Parse one attached entry. Throws `ReportError` on text that is not JSON,
 * an unknown or missing key, a wrong type, a value out of range, or fields
 * that contradict each other. Returns a fresh object with keys in the
 * documented order, so the report's bytes never depend on the writer's order.
 */
export function parseReportEntry(text: string): ReportAssertion {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The text may hold page content, so it is not echoed.
    throw new ReportError("A report entry is not valid JSON");
  }
  return validateReportEntry(value);
}

/**
 * Check an entry and write it as compact JSON in the documented key order.
 * The matcher uses this for the attachment body, so a bad entry fails in the
 * test that made it rather than later in the reporter.
 */
export function serialiseReportEntry(entry: ReportAssertion): string {
  return JSON.stringify(validateReportEntry(entry));
}

/** The same checks as `parseReportEntry`, on a value already parsed. */
export function validateReportEntry(value: unknown): ReportAssertion {
  const fields = exactObject(value, ENTRY_KEYS, "");
  const entry: ReportAssertion = {
    spec: specPath(fields),
    project: string(fields, "project"),
    test: titles(fields),
    step: nonEmptyString(fields, "step"),
    line: integer(fields, "line", 1),
    statement: statement(fields),
    target: oneOf(fields, "target", TARGETS),
    verdict: oneOf(fields, "verdict", VERDICTS),
    source: oneOf(fields, "source", SOURCES),
    missReason: nullable(fields, "missReason", MISS_REASONS),
    reason: nullable(fields, "reason", REASONS),
    truncated: boolean(fields, "truncated"),
    answer: answer(fields),
    decider: nonEmptyString(fields, "decider"),
    model: nonEmptyString(fields, "model"),
    key: hash(fields, "key"),
    snapshotHash: hash(fields, "snapshotHash"),
    mode: oneOf(fields, "mode", MODES),
    effect: oneOf(fields, "effect", EFFECTS),
    retry: integer(fields, "retry", 0),
  };
  assertConsistent(entry);
  return entry;
}

/**
 * Rules that hold for every entry core and the matcher can produce. Each one
 * catches a matcher bug that would otherwise mislead an agent reading the
 * report, such as a pass that claims a reason. Every rule below names the
 * core behaviour it mirrors, in `cache/session.ts` (`decide`) or `verdict.ts`
 * (`gateAnswer`); the matcher only asks yes/no questions.
 */
function assertConsistent(entry: ReportAssertion): void {
  assertVerdictAndReason(entry);
  assertSource(entry);
  assertMode(entry);
  assertMissReason(entry);
  assertAnswer(entry);
}

/** The reason's shape follows the verdict; these are the plan's own rules. */
function assertVerdictAndReason(entry: ReportAssertion): void {
  const { verdict, reason, effect, source } = entry;
  if (verdict === "pass") {
    if (reason !== null) fail("reason must be null on a pass");
    if (effect !== "none") fail("effect must be none on a pass");
  } else {
    if (reason === null) fail(`reason must be set on ${verdict}`);
    if (effect === "none") fail(`effect must not be none on ${verdict}`);
    if (verdict === "fail" && !includes(FAIL_REASONS, reason)) {
      fail(`reason ${reason} is not a fail reason`);
    }
    if (verdict === "needs-review" && !includes(NEEDS_REVIEW_REASONS, reason)) {
      fail(`reason ${reason} is not a needs-review reason`);
    }
  }
  if ((source === "none") !== (entry.answer === null)) {
    fail("answer must be null exactly when source is none");
  }
  if (source === "none" && verdict !== "needs-review") {
    fail("source none is only possible on needs-review");
  }
  // A review returns the stored `reviewVerdict`, which is pass or fail.
  if (source === "review" && verdict === "needs-review") {
    fail("a review is pass or fail, never needs-review");
  }
  if ((reason === "reviewed") !== (source === "review" && verdict === "fail")) {
    fail("reason reviewed is used exactly on a fail from a review");
  }
}

/**
 * Source `none`: `decide` answers nothing only on a replay miss, whose reason
 * is its miss reason, and the matcher adds a decider error, which `decide`
 * throws only when it called the decider. With no answer, `truncated` is
 * false ("False with no answer" on `DecisionOutcome`).
 */
function assertSource(entry: ReportAssertion): void {
  const { source, reason, mode, truncated, missReason } = entry;
  if (source !== "none") {
    if (reason === "decider-error") {
      fail("reason decider-error requires source none");
    }
    return;
  }
  if (truncated) fail("truncated must be false on source none");
  if (reason === "decider-error") {
    // `decide` never calls a decider in replay, so it cannot have failed.
    if (mode === "replay") fail("reason decider-error is impossible in replay");
    return;
  }
  // Outside replay a miss calls the decider, so it has an answer.
  if (mode !== "replay") {
    fail("source none without a decider error is only possible in replay");
  }
  if (!includes(NEEDS_REVIEW_MISS_REASONS, reason)) {
    fail(`reason ${String(reason)} is not possible with source none`);
  }
  // `decide` sets a miss reason on every replay miss, and the reason is it.
  if (missReason === null || reason !== missReason) {
    fail("a replay miss's reason must be its missReason");
  }
}

/**
 * `decide` never calls the decider in replay, and in record it never reads a
 * stored record, so neither the cache nor a review can answer there.
 */
function assertMode(entry: ReportAssertion): void {
  const { mode, source } = entry;
  if (mode === "replay" && source === "decider") {
    fail("mode replay never asks the decider");
  }
  if (mode === "record" && (source === "cache" || source === "review")) {
    fail(`mode record never answers from the ${source}`);
  }
}

/**
 * `missReason` and the reason `regated-below-threshold`. A hit (`cache` or
 * `review`) has no miss reason, except that `replayHit` sets
 * `regated-below-threshold` on a cache hit whose stored verdict differs from
 * today's gate; `missReason()` for a miss never returns that one.
 */
function assertMissReason(entry: ReportAssertion): void {
  const { source, missReason, reason } = entry;
  if (source === "review" && missReason !== null) {
    fail("missReason must be null on a review");
  }
  if (
    source === "cache" &&
    missReason !== null &&
    missReason !== "regated-below-threshold"
  ) {
    fail("missReason on a cache hit can only be regated-below-threshold");
  }
  if (source !== "cache" && missReason === "regated-below-threshold") {
    fail("missReason regated-below-threshold only comes from a cache hit");
  }
  if (
    reason === "regated-below-threshold" &&
    (source !== "cache" || missReason !== "regated-below-threshold")
  ) {
    fail(
      "reason regated-below-threshold requires a cache hit whose missReason says so",
    );
  }
}

/**
 * The answer against the verdict, for answers `gateAnswer` gated (source
 * `cache` or `decider`; a review's verdict is a person's and is not gated).
 * For yes/no: an abstention is always needs-review; a pass is a "yes"; a fail
 * is a "no", and never on a truncated snapshot, where it becomes
 * needs-review. `validateAnswer` requires a non-empty value.
 */
function assertAnswer(entry: ReportAssertion): void {
  const { answer: given, verdict, reason, truncated, source } = entry;
  if (given === null) return;
  if (given.value === "") fail("answer.value must not be empty");
  if (reason === "abstained" && !given.abstained) {
    fail("reason abstained requires answer.abstained");
  }
  if (reason === "low-confidence" && given.abstained) {
    fail("an abstained answer's reason is abstained, not low-confidence");
  }
  // `gateAnswer` turns only a fail into needs-review on a truncated snapshot.
  if (
    reason === "truncated" &&
    (!truncated || given.abstained || given.value !== YESNO_NO)
  ) {
    fail("reason truncated requires truncated and a non-abstained no");
  }
  if (reason === "answered-no" && given.value !== YESNO_NO) {
    fail(`reason answered-no requires the answer ${YESNO_NO}`);
  }
  if (source === "review") return;
  if (given.abstained) {
    if (verdict !== "needs-review") {
      fail("an abstained answer from the cache or decider is needs-review");
    }
    if (reason !== "abstained" && reason !== "regated-below-threshold") {
      fail("an abstained answer's reason is abstained");
    }
  }
  if (verdict === "pass" && (given.abstained || given.value !== YESNO_YES)) {
    fail(`a pass from the ${source} requires the answer ${YESNO_YES}`);
  }
  if (verdict === "fail" && truncated) {
    fail(`a fail from the ${source} is never on a truncated snapshot`);
  }
}

/** Core's yes/no answer values (`validateAnswer` in `decider.ts`). */
const YESNO_YES = "yes";
const YESNO_NO = "no";

function specPath(fields: Fields): string {
  return validateReportSpec(string(fields, "spec"));
}

/**
 * The spec names a file under the cache directory, so core's own
 * `assertSpecPath` decides: relative, forward slashes, no `..`, `.` or empty
 * segment. An absolute path would also leak the machine's layout. Shared with
 * the report's `incomplete` list, whose spec must read the same way.
 */
export function validateReportSpec(value: string): string {
  try {
    assertSpecPath(value);
  } catch {
    fail(
      "spec must be a relative path with forward slashes and no ., .. or empty segment",
    );
  }
  return value;
}

/**
 * The statement as core's `questionText` stores it: a prompt whose
 * whitespace `redactText` collapsed to single spaces and trimmed, optionally
 * followed by a newline, `Criteria: ` and criteria collapsed the same way.
 * A redaction rule whose replacement holds other whitespace would also be
 * refused here; no built-in rule's does.
 */
function statement(fields: Fields): string {
  const value = nonEmptyString(fields, "statement");
  const [prompt = "", criteria, ...rest] = value.split("\n");
  const valid =
    rest.length === 0 &&
    isCollapsed(prompt) &&
    (criteria === undefined ||
      (criteria.startsWith(CRITERIA) &&
        isCollapsed(criteria.slice(CRITERIA.length))));
  if (!valid) {
    fail(
      "statement must be whitespace-collapsed, as core's questionText writes it",
    );
  }
  return value;
}

const CRITERIA = "Criteria: ";

/** Non-empty, no edge whitespace, and no whitespace but single spaces. */
function isCollapsed(text: string): boolean {
  return text !== "" && text === text.replace(/\s+/g, " ").trim();
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Fields {
  const where = path === "" ? "A report entry" : path;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  const own = Object.keys(value);
  for (const key of own) {
    if (!keys.includes(key)) fail(`unknown key ${path}${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`missing key ${path}${key}`);
  }
  return value as Fields;
}

function string(fields: Fields, name: string): string {
  const value = fields[name];
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function nonEmptyString(fields: Fields, name: string): string {
  const value = string(fields, name);
  if (value === "") fail(`${name} must not be empty`);
  return value;
}

function titles(fields: Fields): readonly string[] {
  const value = fields["test"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((title) => typeof title === "string" && title !== "")
  ) {
    fail("test must be a non-empty array of non-empty strings");
  }
  return [...(value as readonly string[])];
}

function integer(fields: Fields, name: string, min: number): number {
  const value = fields[name];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    fail(`${name} must be an integer of at least ${String(min)}`);
  }
  return value;
}

function boolean(fields: Fields, name: string): boolean {
  const value = fields[name];
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  return value;
}

function hash(fields: Fields, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || !HASH.test(value)) {
    fail(`${name} must be sha256: and 64 lower-case hex characters`);
  }
  return value;
}

function oneOf<T extends string>(
  fields: Fields,
  name: string,
  allowed: readonly T[],
): T {
  const value = fields[name];
  if (!includes(allowed, value)) {
    fail(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function nullable<T extends string>(
  fields: Fields,
  name: string,
  allowed: readonly T[],
): T | null {
  const value = fields[name];
  if (value === null) return null;
  if (!includes(allowed, value)) {
    fail(`${name} must be null or one of ${allowed.join(", ")}`);
  }
  return value;
}

function answer(fields: Fields): ReportAnswer | null {
  const value = fields["answer"];
  if (value === null) return null;
  const inner = exactObject(value, ANSWER_KEYS, "answer.");
  if (typeof inner["value"] !== "string") {
    fail("answer.value must be a string");
  }
  const confidence = inner["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    fail("answer.confidence must be a finite number from 0 to 1");
  }
  if (typeof inner["abstained"] !== "boolean") {
    fail("answer.abstained must be a boolean");
  }
  return {
    value: inner["value"],
    confidence,
    abstained: inner["abstained"],
  };
}

function includes<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function fail(message: string): never {
  throw new ReportError(`Invalid report entry: ${message}`);
}
