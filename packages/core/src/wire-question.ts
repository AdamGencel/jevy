import type { DecisionState, Question } from "./decider.js";
import {
  ABSTAIN_ID,
  MAX_CHOICE_OPTIONS,
  validateQuestion,
  validateQuestions,
} from "./decider.js";
import type { Answer } from "./decider.js";
import { QuestionError } from "./errors.js";

/**
 * One option the model is allowed to return. `abstain` is the inconclusive
 * option added by the decider, not an option the caller supplied.
 */
export interface WireOption {
  readonly id: string;
  readonly label: string;
  readonly abstain: boolean;
}

export interface PreparedWireQuestion {
  readonly question: Question;
  readonly instructions: string;
  readonly options: readonly WireOption[];
}

const ABSTAIN_LABEL =
  "Inconclusive. The state does not contain enough evidence to choose.";

/**
 * Add an explicit inconclusive option and describe the question for a model.
 * Choice keeps the caller's ids. Yes/no and score are asked as a choice so
 * the model can abstain and so probability and confidence stay separate.
 * A caller choice may have at most 254 options; the 255th slot is abstain.
 */
export function prepareWireQuestion(question: Question): PreparedWireQuestion {
  validateQuestion(question);
  switch (question.kind) {
    case "yesno":
      return {
        question,
        instructions:
          question.criteria === undefined
            ? question.prompt
            : `${question.prompt}\nCriterion: ${question.criteria}`,
        options: [
          { id: "yes", label: "Yes. The statement holds.", abstain: false },
          {
            id: "no",
            label: "No. The statement does not hold.",
            abstain: false,
          },
          { id: ABSTAIN_ID, label: ABSTAIN_LABEL, abstain: true },
        ],
      };
    case "choice": {
      if (question.options.length >= MAX_CHOICE_OPTIONS) {
        throw new QuestionError(
          `A choice sent to a decider can have at most ${String(MAX_CHOICE_OPTIONS - 1)} options. One slot is reserved for inconclusive.`,
        );
      }
      return {
        question,
        instructions: question.prompt,
        options: [
          ...question.options.map((option) => ({
            id: option.id,
            label: option.label,
            abstain: false,
          })),
          {
            id: ABSTAIN_ID,
            label: "Inconclusive. None of the other options fit the state.",
            abstain: true,
          },
        ],
      };
    }
    case "score":
      return {
        question,
        instructions: `${question.prompt}\nOptions except the inconclusive one are ordered from worst to best.`,
        options: [
          ...question.levels.map((level) => ({
            id: level,
            label: level,
            abstain: false,
          })),
          {
            id: ABSTAIN_ID,
            label: "Inconclusive. The state does not support a score.",
            abstain: true,
          },
        ],
      };
    default:
      throw new QuestionError("Unknown question kind");
  }
}

export function prepareWireQuestions(
  questions: Readonly<Record<string, Question>>,
): Readonly<Record<string, PreparedWireQuestion>> {
  validateQuestions(questions);
  const prepared: Record<string, PreparedWireQuestion> = {};
  for (const name of Object.keys(questions)) {
    const question = questions[name];
    if (question === undefined) {
      throw new QuestionError(`Missing question "${name}"`);
    }
    prepared[name] = prepareWireQuestion(question);
  }
  return prepared;
}

/** JSON state sent to a model. Undefined fields are omitted. */
export function decisionStatePayload(
  state: DecisionState,
): Readonly<Record<string, unknown>> {
  return {
    snapshot: state.snapshot,
    ...(state.url !== undefined ? { url: state.url } : {}),
    ...(state.goal !== undefined ? { goal: state.goal } : {}),
    ...(state.wallet !== undefined ? { wallet: state.wallet } : {}),
  };
}

/** System One choice body. Criteria values are the option labels. */
export function systemOneQuestions(
  prepared: Readonly<Record<string, PreparedWireQuestion>>,
): Readonly<
  Record<
    string,
    {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  >
> {
  const body: Record<
    string,
    {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  > = {};
  for (const name of Object.keys(prepared)) {
    const wire = prepared[name];
    if (wire === undefined) continue;
    const criteria: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const option of wire.options) criteria[option.id] = option.label;
    body[name] = {
      type: "choice",
      instructions: wire.instructions,
      criteria,
    };
  }
  return body;
}

/**
 * Map a choice distribution onto an Answer.
 * `probability` is the probability of the picked id.
 * `confidence` is the provider's separate peakedness score, or 0 when missing.
 * Picking the inconclusive option yields `ABSTAIN_ID`.
 */
export function answerFromSignals(
  wire: PreparedWireQuestion,
  picked: string,
  probabilities: Readonly<Record<string, number>> | undefined,
  confidence: number | null | undefined,
): Answer {
  const option = wire.options.find((entry) => entry.id === picked);
  if (option === undefined) {
    throw new QuestionError(
      `Decider returned "${picked}", which is not one of the options`,
    );
  }
  const probability = unitOrZero(
    probabilities === undefined ? undefined : probabilities[picked],
  );
  return {
    value: option.abstain ? ABSTAIN_ID : option.id,
    confidence: unitOrZero(confidence),
    probability,
  };
}

function unitOrZero(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return 0;
  }
  return value;
}
