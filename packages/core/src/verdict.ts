import type { Question } from "./decider.js";
import { validateAnswer } from "./decider.js";
import { QuestionError } from "./errors.js";

export type Verdict = "pass" | "fail" | "needs-review";

/**
 * Defaults are placeholders until `eval` calibrates a project.
 * `pass` is the confidence bar for yes/no and choice, and the high cut for score.
 * `fail` is the low cut for a score. It does not apply to yes/no or choice.
 * `fail` must be strictly below `pass`, so a score can land on `needs-review`.
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
      "Thresholds require fail < pass so a score can be needs-review",
    );
  }
}

/**
 * Map one answer onto a verdict.
 *
 * Yes/no: confidence is how sure the decider is of the value it returned.
 * `yes` passes only when confidence >= pass. `no` fails only when confidence
 * >= pass. Anything below pass is `needs-review`. A weak answer is never
 * treated as evidence for the opposite value, and `fail` is not consulted.
 *
 * Score: levels run from worst to best. The chosen level is a position in
 * [0, 1], then shrunk toward 0.5 by (1 - confidence). That position is `pass`
 * at or above `pass`, `fail` below `fail`, and `needs-review` between them.
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
      if (answer.confidence >= thresholds.pass) {
        return answer.value === "yes" ? "pass" : "fail";
      }
      return "needs-review";
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
 * Confidence-adjusted score position in [0, 1].
 * Yes/no is not converted into P(the statement holds): that conversion flipped
 * a weak answer. Choice has no probability of "yes" either. Use `gateAnswer`.
 */
export function probabilityOfYes(
  question: Question,
  answer: { readonly value: string; readonly confidence: number },
): number {
  validateAnswer(question, answer);
  switch (question.kind) {
    case "yesno":
      throw new QuestionError(
        "A yes/no answer is not converted to P(yes). Use gateAnswer.",
      );
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

/**
 * Gate a score's adjusted position. `pass` at or above `pass`, `fail` below
 * `fail`, otherwise `needs-review`. This is not the yes/no rule.
 */
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
