import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  ConfigError,
  QuestionError,
  decisionKey,
  hashSnapshot,
  questionText,
  redactText,
} from "@jevyjs/core";
import type {
  AccessibilityNode,
  CacheMode,
  DecisionOutcome,
  NormaliseOverrides,
  Question,
  RedactRule,
  SnapshotRegion,
} from "@jevyjs/core";
import { validateReportEntry } from "./report/schema.js";
import type { Effect, Reason, ReportAssertion } from "./report/schema.js";

/**
 * Who a `toSatisfy` call is, and the report entry it leaves. Pure functions,
 * so the mapping from a core outcome to an entry is tested without a browser.
 */

/**
 * The Jevy root: the directory of the Playwright config file, or `rootDir`
 * when there is none. `jevy.config.*`, the cache directory and every `spec`
 * resolve against it, and the reporter uses the same rule, so an entry's
 * spec and the reporter's agree.
 */
export function jevyRoot(config: {
  readonly configFile?: string | undefined;
  readonly rootDir: string;
}): string {
  return config.configFile !== undefined
    ? dirname(config.configFile)
    : config.rootDir;
}

/**
 * The test file relative to the root, with forward slashes on every system,
 * so a record written on Windows replays on Linux. A file outside the root
 * gives a `..` path; {@link specInRoot} refuses it.
 */
export function specOf(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/**
 * {@link specOf}, for a file that must be inside the root: the spec names
 * the file's records under the cache directory, which a `..` path would
 * climb out of. Outside the root, a `ConfigError` that names the root and
 * how it is chosen, rather than core's rule about path segments.
 */
export function specInRoot(root: string, file: string): string {
  const spec = specOf(root, file);
  if (spec === ".." || spec.startsWith("../") || isAbsolute(spec)) {
    throw new ConfigError(
      `toSatisfy needs the spec file to be inside the Jevy root, ${root}, which is the directory of the Playwright config file (or its rootDir when there is none) and holds jevy.config.*. ${file} is not. Move the spec under the root, or the Playwright config up to a directory that holds the specs.`,
    );
  }
  return spec;
}

/**
 * Describe titles, then the test title: Playwright's title path without its
 * first element, the file name, and without anonymous describes, whose
 * title is empty and would add an empty segment to the step.
 */
export function testTitles(titlePath: readonly string[]): readonly string[] {
  return titlePath.slice(1).filter((title) => title !== "");
}

/**
 * The step: the titles joined by ` › `, then `#n`, counting the test's
 * `toSatisfy` calls from 1. It names the call in the record and the report;
 * it is not part of the key.
 */
export function stepOf(titles: readonly string[], call: number): string {
  if (!Number.isSafeInteger(call) || call < 1) {
    throw new QuestionError("A toSatisfy call is counted from 1");
  }
  return `${titles.join(" › ")}#${String(call)}`;
}

/**
 * Why an outcome is not a pass, as `report.json` names it. A decider error
 * is the matcher's own outcome, so the caller says when it is one.
 */
export function reasonOf(
  outcome: DecisionOutcome,
  deciderError = false,
): Reason | null {
  if (outcome.verdict === "pass") return null;
  if (deciderError) return "decider-error";
  if (outcome.verdict === "fail") {
    return outcome.source === "review" ? "reviewed" : "answered-no";
  }
  if (outcome.source === "none") return outcome.reason ?? null;
  if (outcome.answer?.abstained === true) return "abstained";
  // `gateAnswer` turns a confident "no" into needs-review on a cut snapshot.
  if (outcome.truncated && outcome.answer?.value === "no") return "truncated";
  if (outcome.reason === "regated-below-threshold") return outcome.reason;
  return "low-confidence";
}

/**
 * The outcome reported when the decider could not answer. `decide` rejects
 * without a key, so the key and hash are computed here with the session's
 * own options; core guarantees the same result for the same input, and the
 * entry then names the decision a later run will look up.
 */
export function deciderErrorOutcome(input: {
  readonly spec: string;
  readonly question: Question;
  readonly snapshot: AccessibilityNode;
  readonly deciderId: string;
  readonly model: string;
  readonly options: {
    readonly redact?: readonly RedactRule[];
    readonly normalise?: NormaliseOverrides;
    readonly region?: SnapshotRegion;
  };
}): DecisionOutcome {
  const snapshotHash = hashSnapshot(input.snapshot, input.options);
  const key = decisionKey({
    spec: input.spec,
    question: input.question,
    snapshotHash,
    deciderId: input.deciderId,
    model: input.model,
    ...(input.options.redact !== undefined
      ? { redact: input.options.redact }
      : {}),
  });
  return {
    verdict: "needs-review",
    source: "none",
    truncated: false,
    snapshotHash,
    key,
  };
}

/** Everything about the call that the outcome does not hold. */
export interface EntryContext {
  readonly spec: string;
  readonly project: string;
  readonly test: readonly string[];
  readonly step: string;
  /** The test's line in its file. */
  readonly line: number;
  readonly retry: number;
  readonly target: "page" | "locator";
  readonly question: Question;
  readonly decider: { readonly id: string; readonly model: string };
  readonly mode: CacheMode;
  /** From `applyPolicy`. */
  readonly effect: Effect;
  /** The project's rules; the built-in ones always apply as well. */
  readonly redact: readonly RedactRule[];
  /** True when the outcome came from `deciderErrorOutcome`. */
  readonly deciderError?: boolean;
}

/**
 * The report entry for one call, checked by the reporter's own validator,
 * so an entry the reporter would refuse fails the test that made it.
 *
 * Every text field passes through `redactText`, built-in rules and the
 * project's: the report is read by agents and pasted into tickets, and test
 * titles and project names are free text a secret can reach. The statement
 * is the question exactly as the record stores it (`questionText`).
 */
export function buildReportEntry(
  outcome: DecisionOutcome,
  context: EntryContext,
): ReportAssertion {
  const clean = (text: string): string => redactText(text, context.redact);
  const answer = outcome.answer;
  return validateReportEntry({
    spec: clean(context.spec),
    project: clean(context.project),
    test: context.test.map(clean),
    step: clean(context.step),
    line: context.line,
    statement: questionText(context.question, context.redact),
    target: context.target,
    verdict: outcome.verdict,
    source: outcome.source,
    missReason: outcome.reason ?? null,
    reason: reasonOf(outcome, context.deciderError === true),
    truncated: outcome.truncated,
    answer:
      answer === undefined
        ? null
        : {
            value: clean(answer.value),
            confidence: answer.confidence,
            abstained: answer.abstained,
          },
    decider: clean(context.decider.id),
    model: clean(context.decider.model),
    key: outcome.key,
    snapshotHash: outcome.snapshotHash,
    mode: context.mode,
    effect: context.effect,
    retry: context.retry,
  });
}

/**
 * The annotation for a non-pass, which Playwright's own reporters show
 * beside the test. It holds only fields of the entry, which are redacted.
 */
export function annotationOf(
  entry: ReportAssertion,
): { readonly type: "jevy"; readonly description: string } | null {
  if (entry.verdict === "pass") return null;
  return {
    type: "jevy",
    description: `${entry.verdict} (${entry.reason ?? "unknown"}) at ${entry.step}: ${JSON.stringify(entry.statement)}`,
  };
}
