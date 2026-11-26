import { validateQuestions } from "@jevyjs/core";
import type { Question } from "@jevyjs/core";

/**
 * The id a model answers with to abstain, before any suffix: `inconclusive`
 * for yes/no and score, `none` for a choice. It exists only inside the
 * schema and the prompt. The answer Jevy returns carries `abstained: true`
 * instead (§5.1), so no sentinel value reaches the cache or the gate.
 */
export const ABSTAIN_BASE_IDS = {
  yesno: "inconclusive",
  score: "inconclusive",
  choice: "none",
} as const satisfies Readonly<Record<Question["kind"], string>>;

/** One question as it is put to the model, with everything worked out once. */
export interface AskedQuestion {
  readonly name: string;
  readonly question: Question;
  /** The values that answer the question, in the caller's order. */
  readonly values: readonly string[];
  /** The extra enum value that means "the state does not show enough". */
  readonly abstain: string;
}

/**
 * The values that answer `question`: yes and no, the option ids, or the
 * levels from worst to best.
 */
export function allowedValues(question: Question): readonly string[] {
  switch (question.kind) {
    case "yesno":
      return ["yes", "no"];
    case "choice":
      return question.options.map((option) => option.id);
    case "score":
      return question.levels;
  }
}

/**
 * The abstain id for `question`. When an option id or a level already uses
 * the plain id, `-1`, `-2` and so on are tried in turn and the first free
 * one is used. An option a caller named `none` stays a real option: choosing
 * it is a choice, not an abstention.
 */
export function abstainId(question: Question): string {
  const base = ABSTAIN_BASE_IDS[question.kind];
  const taken = new Set(allowedValues(question));
  let candidate: string = base;
  for (let suffix = 1; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/**
 * Validate the questions and put them in a fixed order: by name, compared by
 * code unit. The prompt and the schema both follow it, so the same questions
 * give the same request whatever order the caller's object lists them in.
 */
export function askedQuestions(
  questions: Readonly<Record<string, Question>>,
): readonly AskedQuestion[] {
  validateQuestions(questions);
  return Object.keys(questions)
    .sort(compareCodeUnits)
    .map((name) => {
      const question = questions[name] as Question;
      return {
        name,
        question,
        values: allowedValues(question),
        abstain: abstainId(question),
      };
    });
}

/**
 * The JSON schema handed to `LlmAdapter.complete`: one required property per
 * question, each `{ value, confidence }` with `additionalProperties: false`.
 * `value` is an `enum` of the allowed values plus the abstain id, so a model
 * held to the schema cannot express an answer outside the options, and can
 * always say it cannot tell. The reply is still checked (`readReply`):
 * a provider may ignore the schema.
 */
export function answerSchema(
  questions: Readonly<Record<string, Question>>,
): object {
  return schemaFor(askedQuestions(questions));
}

/** `answerSchema` for questions already through `askedQuestions`. */
export function schemaFor(asked: readonly AskedQuestion[]): object {
  // `Object.fromEntries` defines own properties, so a question named
  // `__proto__` stays a property instead of setting the prototype.
  const properties = Object.fromEntries(
    asked.map((item) => [item.name, answerProperty(item)]),
  );
  return {
    type: "object",
    additionalProperties: false,
    required: asked.map((item) => item.name),
    properties,
  };
}

function answerProperty(item: AskedQuestion): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence"],
    properties: {
      value: { type: "string", enum: [...item.values, item.abstain] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

/** Code-unit order, so the result does not depend on the locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
