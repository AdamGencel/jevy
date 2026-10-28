import type { Question } from "./decider.js";
import { validateAnswer } from "./decider.js";
import { QuestionError } from "./errors.js";

export type Verdict = "pass" | "fail" | "needs-review";

/**
 * `pass` and `fail` are thresholds on P(the check holds), not on raw confidence.
 * Defaults are placeholders until `eval` calibrates a project.
 * `fail` must be strictly below `pass`, so a middle band can be `needs-review`.
 */
export interface Thresholds {
  readonly pass: number;
  readonly fail: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { pass: 0.8, fail: 0.5 };

export function assertThresholds(thresholds: Thresholds): void {
  const { pass, fail } = thresholds;
  if (!isUnit(pass) || !isUnit(fail)) {
    throw new QuestionError(
      "Thresholds pass and fail must be finite numbers from 0 to 1",
    );
  }
  if (fail >= pass) {
    throw new QuestionError(
      "Thresholds require fail < pass so an answer can be needs-review",
    );
  }
}

/**
 * Map one answer onto a verdict.
 *
 * Yes/no: confidence is P(the returned value is correct). It is converted to
 * P(yes) = confidence for "yes", and 1 - confidence for "no". Then
 * P(yes) >= pass → pass, P(yes) < fail → fail, otherwise needs-review.
 * A low-confidence "no" can therefore pass. See DESIGN.md.
 *
 * Score: levels run from worst to best. The chosen level is a position in
 * [0, 1], then shrunk toward 0.5 by (1 - confidence), then gated like yes/no.
 *
 * Choice: confidence >= pass accepts the choice (`pass`). Anything lower is
 * `needs-review`. A choice is never `fail`; the fail threshold does not apply.
 */
export function gateAnswer(
  question: Question,
  answer: { readonly value: string; readonly confidence: number },
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Verdict {
  assertThresholds(thresholds);
  validateAnswer(question, answer);
  switch (question.kind) {
    case "yesno":
      return verdictFromProbability(
        probabilityOfYes(question, answer),
        thresholds,
      );
    case "score":
      return verdictFromProbability(
        probabilityOfYes(question, answer),
        thresholds,
      );
    case "choice":
      return answer.confidence >= thresholds.pass ? "pass" : "needs-review";
    default:
      throw new QuestionError("Unknown question kind");
  }
}

/**
 * P(the yes/no statement holds), or the confidence-adjusted score position.
 * Throws for a choice question, which has no probability of "yes".
 */
export function probabilityOfYes(
  question: Question,
  answer: { readonly value: string; readonly confidence: number },
): number {
  validateAnswer(question, answer);
  switch (question.kind) {
    case "yesno":
      return answer.value === "yes" ? answer.confidence : 1 - answer.confidence;
    case "score": {
      const index = question.levels.indexOf(answer.value);
      const span = question.levels.length - 1;
      const position = index / span;
      return 0.5 + (position - 0.5) * answer.confidence;
    }
    case "choice":
      throw new QuestionError(
        "A choice question has no probability of yes. Use gateAnswer.",
      );
    default:
      throw new QuestionError("Unknown question kind");
  }
}

export function verdictFromProbability(
  probability: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Verdict {
  assertThresholds(thresholds);
  if (!isUnit(probability)) {
    throw new QuestionError(
      "Verdict probability must be a finite number from 0 to 1",
    );
  }
  if (probability >= thresholds.pass) return "pass";
  if (probability < thresholds.fail) return "fail";
  return "needs-review";
}

function isUnit(value: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
