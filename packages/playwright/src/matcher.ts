import process from "node:process";
import {
  DeciderError,
  QuestionError,
  snapshotOptionsFromConfig,
  validateQuestion,
} from "@jevyjs/core";
import type { DecisionOutcome, YesNoQuestion } from "@jevyjs/core";
import { expect as baseExpect, test as baseTest } from "@playwright/test";
import type {
  ExpectMatcherState,
  Locator,
  MatcherReturnType,
  Page,
} from "@playwright/test";
import {
  annotationOf,
  buildReportEntry,
  deciderErrorOutcome,
  specInRoot,
  stepOf,
  testTitles,
} from "./entry.js";
import { applyPolicy, readCiContext } from "./policy.js";
import {
  REPORT_ATTACHMENT_CONTENT_TYPE,
  REPORT_ATTACHMENT_NAME,
  serialiseReportEntry,
} from "./report/schema.js";
import type { ReportAssertion } from "./report/schema.js";
import { testRunFor } from "./runtime.js";
import { snapshotAccessibility } from "./snapshot.js";

/** Options for one `toSatisfy` call. */
export interface ToSatisfyOptions {
  /**
   * What the statement means in this app, when the statement alone could be
   * read two ways. Part of the question, so part of the cache key.
   */
  readonly criteria?: string;
}

const NOT_MESSAGE =
  "expect(…).not.toSatisfy is not supported. A judgement has three verdicts, so " +
  '"not pass" is not "fail". Write the statement you expect to hold instead: ' +
  'toSatisfy("The order is not shown as paid").';

/**
 * `await expect(page | locator).toSatisfy(statement, { criteria? })`.
 *
 * The statement becomes a yes/no question about one accessibility snapshot
 * of the target, taken now: there is no polling, because each new snapshot
 * could be a new key and a new model call. Wait for the page with a
 * web-first assertion first.
 *
 * Before the session decides, the call claims its key in the run directory,
 * so when several workers ask one question at once, one asks the decider and
 * the others wait for its answer in the run memo.
 *
 * Every call attaches a report entry, and every non-pass adds a `jevy`
 * annotation. Whether the verdict fails the assertion is `applyPolicy`'s
 * decision: by default it never does. A `DeciderError` is reported as
 * `needs-review`; every other error (config, redaction, snapshot, cache,
 * question) is thrown, because it is a fault to fix, not a verdict.
 */
async function toSatisfy(
  this: ExpectMatcherState,
  received: Page | Locator,
  statement: string,
  options?: ToSatisfyOptions,
): Promise<MatcherReturnType> {
  if (this.isNot) throw new QuestionError(NOT_MESSAGE);
  const target = readTarget(received);
  const question = readQuestion(statement, options);
  const testInfo = baseTest.info();
  const run = testRunFor(testInfo);
  const call = run.nextCall();
  const { runtime, session, deciderId, model } = await run.session();
  const { config } = runtime;
  const spec = specInRoot(runtime.root, testInfo.file);
  const snapshot = await snapshotAccessibility(received);
  const titles = testTitles(testInfo.titlePath);
  const step = stepOf(titles, call);

  // The key, worked out as the session will, so that one worker asks the
  // decider for it while the others wait for its answer in the run memo.
  // It is also the outcome reported if the decider cannot answer.
  validateQuestion(question);
  const unanswered = deciderErrorOutcome({
    spec,
    question,
    snapshot,
    deciderId,
    model,
    options: snapshotOptionsFromConfig(config),
  });
  let outcome: DecisionOutcome;
  let deciderError = false;
  const release = await run.claim(unanswered.key);
  try {
    outcome = await session.decide({
      spec,
      step,
      question,
      state: { snapshot },
    });
  } catch (error: unknown) {
    if (!(error instanceof DeciderError)) throw error;
    deciderError = true;
    outcome = unanswered;
  } finally {
    release();
  }

  const effect = applyPolicy(
    outcome.verdict,
    {
      blocking: config.toSatisfy.blocking,
      needsReview: config.ci.needsReview,
      mainBranch: config.ci.mainBranch,
    },
    readCiContext(process.env),
  );
  const entry = buildReportEntry(outcome, {
    spec,
    project: testInfo.project.name,
    test: titles,
    step,
    line: testInfo.line,
    retry: testInfo.retry,
    target,
    question,
    decider: { id: deciderId, model },
    mode: config.cache.mode,
    effect,
    redact: config.redact,
    deciderError,
  });
  await testInfo.attach(REPORT_ATTACHMENT_NAME, {
    body: serialiseReportEntry(entry),
    contentType: REPORT_ATTACHMENT_CONTENT_TYPE,
  });
  const annotation = annotationOf(entry);
  if (annotation !== null) testInfo.annotations.push(annotation);
  const message = messageOf(entry);
  // A blocking "no" that fails the test keeps its record (see keysToKeep).
  run.finished({
    key: outcome.key,
    ...(effect === "failed" && entry.verdict === "fail"
      ? { blockingFail: message }
      : {}),
  });

  return {
    name: "toSatisfy",
    pass: effect !== "failed",
    message: () => message,
    expected: "pass",
    actual: entry.verdict,
  };
}

/** Playwright's own `expect`, with `toSatisfy`. */
export const expect = baseExpect.extend({ toSatisfy });

/**
 * A page or a locator; the snapshot of anything else would be meaningless.
 * Told apart by shape, as Playwright exports neither class.
 */
function readTarget(received: unknown): "page" | "locator" {
  if (typeof received === "object" && received !== null) {
    if ("mainFrame" in received && typeof received.mainFrame === "function") {
      return "page";
    }
    if (
      "ariaSnapshot" in received &&
      typeof received.ariaSnapshot === "function"
    ) {
      return "locator";
    }
  }
  throw new QuestionError(
    "toSatisfy takes a Playwright page or locator: expect(page.getByRole(…)).toSatisfy(…)",
  );
}

/**
 * The yes/no question. Options are checked by key, so a misspelt or
 * unsupported option (a local `blocking: false`, say) is an error rather
 * than silently ignored. Core validates the text itself.
 */
function readQuestion(statement: unknown, options: unknown): YesNoQuestion {
  if (typeof statement !== "string") {
    throw new QuestionError("toSatisfy takes the statement as a string");
  }
  if (options === undefined) return { kind: "yesno", prompt: statement };
  if (typeof options !== "object" || options === null) {
    throw new QuestionError("toSatisfy options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "criteria") {
      throw new QuestionError(
        `toSatisfy has no option ${JSON.stringify(key)}; the only option is criteria`,
      );
    }
  }
  const criteria: unknown =
    "criteria" in options ? options.criteria : undefined;
  if (criteria === undefined) return { kind: "yesno", prompt: statement };
  if (typeof criteria !== "string") {
    throw new QuestionError("toSatisfy criteria must be a string");
  }
  return { kind: "yesno", prompt: statement, criteria };
}

/** The failure message: only fields of the entry, which are redacted. */
function messageOf(entry: ReportAssertion): string {
  const answer =
    entry.answer === null
      ? "none"
      : `${entry.answer.value} (confidence ${String(entry.answer.confidence)}${entry.answer.abstained ? ", abstained" : ""})`;
  const lines = [
    `toSatisfy: ${entry.verdict}${entry.reason !== null ? ` (${entry.reason})` : ""}`,
    `Statement: ${JSON.stringify(entry.statement)}`,
    `Answer: ${answer}`,
    `Source: ${entry.source}, decider ${entry.decider}, mode ${entry.mode}`,
    `Step: ${entry.step} in ${entry.spec}`,
  ];
  if (entry.effect === "failed") {
    lines.push(
      "toSatisfy.blocking is on in jevy.config, so this verdict fails the test.",
    );
  }
  return lines.join("\n");
}
