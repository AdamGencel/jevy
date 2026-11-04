import type { Answer, DecisionState, Decider, Question } from "./decider.js";
import { validateQuestions } from "./decider.js";
import { QuestionError } from "./errors.js";

export interface FakeDeciderOptions {
  readonly id?: string;
  readonly model?: string;
  readonly answers?:
    | Readonly<Record<string, Answer>>
    | ((
        state: DecisionState,
        questions: Readonly<Record<string, Question>>,
      ) => Readonly<Record<string, Answer>>);
  readonly onDecide?: (
    state: DecisionState,
    questions: Readonly<Record<string, Question>>,
  ) => void;
}

/**
 * In-memory decider for tests. It never uses the network.
 * A missing scripted answer becomes a confident "yes", the first choice, or
 * the best score level, with probability equal to confidence.
 */
export function fakeDecider(options?: FakeDeciderOptions): Decider {
  return {
    id: options?.id ?? "fake",
    model: options?.model ?? "fake-1",
    decide(state, questions) {
      validateQuestions(questions);
      options?.onDecide?.(state, questions);
      const scripted = options?.answers;
      const provided =
        typeof scripted === "function" ? scripted(state, questions) : scripted;
      const answers: Record<string, Answer> = {};
      for (const name of Object.keys(questions)) {
        const question = questions[name];
        if (question === undefined) {
          throw new QuestionError(`Missing question "${name}"`);
        }
        const answer = provided?.[name] ?? defaultAnswer(question);
        answers[name] = {
          value: answer.value,
          confidence: answer.confidence,
          probability: answer.probability ?? answer.confidence,
          ...(answer.raw !== undefined ? { raw: answer.raw } : {}),
        };
      }
      return Promise.resolve(answers);
    },
  };
}

function defaultAnswer(question: Question): Answer {
  switch (question.kind) {
    case "yesno":
      return { value: "yes", confidence: 1, probability: 1 };
    case "choice": {
      const first = question.options[0];
      if (first === undefined) {
        throw new QuestionError("Choice question has no options");
      }
      return { value: first.id, confidence: 1, probability: 1 };
    }
    case "score": {
      const best = question.levels[question.levels.length - 1];
      if (best === undefined) {
        throw new QuestionError("Score question has no levels");
      }
      return { value: best, confidence: 1, probability: 1 };
    }
    default:
      throw new QuestionError("Unknown question kind");
  }
}
