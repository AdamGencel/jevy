import { ConfigError } from "@jevyjs/core";
import type { Answer, Decider, DecisionState, Question } from "@jevyjs/core";

/**
 * What a scripted answer function is given for each question. Through
 * `callDecider` these are what a real decider sees: `state` is the prepared
 * state and `question` the redacted question, so a prompt that quoted an
 * email holds `[REDACTED]` here. Match on `name`, which is never rewritten.
 */
export interface FakeAsk {
  readonly name: string;
  /** The question as the decider receives it: redacted by `callDecider`. */
  readonly question: Question;
  /** The prepared state: redacted, normalised and pruned by `callDecider`. */
  readonly state: DecisionState;
}

/**
 * The script: answers by question name, or a function of the question.
 * A function that returns `undefined` leaves the question unscripted.
 */
export type FakeAnswers =
  Readonly<Record<string, Answer>> | ((ask: FakeAsk) => Answer | undefined);

export interface FakeDeciderOptions {
  /**
   * Defaults to `"fake"`. A real decider's id (`llm:<model>`) makes the fake
   * stand in for it, and then the cache records the scripted answers under
   * that id. Replay later serves them as if the model had given them, so do
   * this only with a cache that tests own and throw away, never with the
   * project's cache.
   */
  readonly id?: string;
  /** Defaults to `"fake-1"`. */
  readonly model?: string;
  readonly answers?: FakeAnswers;
  /** Called with what the decider was asked, before it answers. */
  readonly onDecide?: (
    state: DecisionState,
    questions: Readonly<Record<string, Question>>,
  ) => void;
}

/** The value of an unscripted answer; `abstained: true` marks it. */
export const UNSCRIPTED = "unscripted";

/**
 * An in-memory decider for tests: no network and no model. It answers from
 * a script and abstains on any question the script does not answer, so a
 * forgotten script is `needs-review`, never a pass.
 *
 * Scripted answers are returned as they are; `callDecider` checks them
 * against the questions, as it checks any decider's. A record is read by own
 * property, so a question named `toString` is not answered by
 * `Object.prototype`.
 *
 * `decide` always returns a promise, as the `Decider` contract says: an
 * `onDecide` or a script function that throws makes it reject, never throw,
 * so the fake fails the way a real decider would.
 *
 * For tests only. See `id` before giving it a real decider's id.
 */
export function fakeDecider(options: FakeDeciderOptions = {}): Decider {
  // Only a missing option takes the default; a null is a caller's mistake.
  const id: unknown = options.id === undefined ? "fake" : options.id;
  const model: unknown = options.model === undefined ? "fake-1" : options.model;
  if (
    typeof id !== "string" ||
    typeof model !== "string" ||
    id.trim().length === 0 ||
    model.trim().length === 0
  ) {
    throw new ConfigError("fakeDecider id and model must be non-empty strings");
  }
  const script = options.answers;
  return {
    id,
    model,
    decide(state, questions) {
      return new Promise((resolve) => {
        options.onDecide?.(state, questions);
        const answers = Object.keys(questions).map((name): [string, Answer] => {
          const question = questions[name] as Question;
          const scripted = lookUp(script, { name, question, state });
          return [name, scripted ?? unscripted()];
        });
        // `Object.fromEntries` keeps a question named `__proto__` an own key.
        resolve(Object.fromEntries(answers));
      });
    },
  };
}

function lookUp(
  script: FakeAnswers | undefined,
  ask: FakeAsk,
): Answer | undefined {
  if (script === undefined) return undefined;
  if (typeof script === "function") return script(ask);
  return Object.hasOwn(script, ask.name) ? script[ask.name] : undefined;
}

function unscripted(): Answer {
  return { value: UNSCRIPTED, confidence: 0, abstained: true };
}
