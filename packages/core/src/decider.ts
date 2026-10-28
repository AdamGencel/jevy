import { QuestionError } from "./errors.js";
import type { AccessibilityNode } from "./snapshot.js";

/**
 * Upper bound on `choice` options. This is Jev's choice limit; Kev and an LLM
 * adapter must accept the same questions, so the cap is part of the contract.
 */
export const MAX_CHOICE_OPTIONS = 255;

export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly prompt: string;
  readonly options: readonly ChoiceOption[];
}

/** Jev's wire type for this question is `noul`. Adapters map `yesno` to it. */
export interface YesNoQuestion {
  readonly kind: "yesno";
  readonly prompt: string;
  readonly criteria?: string;
}

/**
 * `levels` are ordered from the worst outcome to the best.
 * Two to ten entries, matching Jev's score question.
 */
export interface ScoreQuestion {
  readonly kind: "score";
  readonly prompt: string;
  readonly levels: readonly string[];
}

export type Question = ChoiceQuestion | YesNoQuestion | ScoreQuestion;

export interface Answer {
  readonly value: string;
  readonly confidence: number;
  readonly raw?: unknown;
}

/**
 * Structured context a decider may see, after redaction and pruning.
 * There is no screenshot field. Page content is untrusted.
 */
export interface WalletContext {
  readonly kind?: string;
  readonly fields?: Readonly<Record<string, string>>;
}

export interface DecisionState {
  readonly snapshot: AccessibilityNode;
  readonly url?: string;
  readonly goal?: string;
  readonly wallet?: WalletContext;
}

/**
 * A decider answers named, typed questions about one state.
 * `id` is the cache identity (`"jev"`, `"kev"`, `"llm:<provider>/<model>"`).
 * `model` is a pinned model id, never a moving alias, unless config allows it.
 *
 * Implementations must not be called with a raw page. Use `callDecider`,
 * which redacts and prunes first. Core ships no network adapter.
 */
export interface Decider {
  readonly id: string;
  readonly model: string;
  decide(
    state: DecisionState,
    questions: Readonly<Record<string, Question>>,
  ): Promise<Readonly<Record<string, Answer>>>;
}

/**
 * User-supplied completion function for the generic LLM judge.
 * `llmDecider` itself ships in `@jevyjs/deciders-llm` (M3). Core only names
 * the adapter so `jevy.config.ts` can point at one.
 */
export interface LlmAdapter {
  complete(prompt: string, jsonSchema: object): Promise<unknown>;
}

export function validateQuestion(question: Question): void {
  assertPrompt(question.prompt);
  switch (question.kind) {
    case "choice":
      validateChoice(question);
      return;
    case "yesno":
      if (
        question.criteria !== undefined &&
        question.criteria.trim().length === 0
      ) {
        throw new QuestionError("yesno criteria must not be empty when set");
      }
      return;
    case "score":
      validateScore(question);
      return;
    default:
      throw new QuestionError(
        `Unknown question kind: ${unexpectedKind(question)}`,
      );
  }
}

export function validateQuestions(
  questions: Readonly<Record<string, Question>>,
): void {
  const keys = Object.keys(questions);
  if (keys.length === 0) {
    throw new QuestionError("At least one question is required");
  }
  for (const key of keys) {
    if (key.trim().length === 0) {
      throw new QuestionError("Question names must not be empty");
    }
    const question = questions[key];
    if (question === undefined) {
      throw new QuestionError(`Missing question "${key}"`);
    }
    validateQuestion(question);
  }
}

export function validateAnswer(question: Question, answer: Answer): void {
  validateQuestion(question);
  if (typeof answer.value !== "string" || answer.value.length === 0) {
    throw new QuestionError("Answer value must be a non-empty string");
  }
  if (
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    throw new QuestionError(
      "Answer confidence must be a finite number from 0 to 1",
    );
  }
  switch (question.kind) {
    case "yesno":
      if (answer.value !== "yes" && answer.value !== "no") {
        throw new QuestionError('A yesno answer value must be "yes" or "no"');
      }
      return;
    case "choice": {
      const known = question.options.some(
        (option) => option.id === answer.value,
      );
      if (!known) {
        throw new QuestionError(
          `Choice answer "${answer.value}" is not one of the option ids`,
        );
      }
      return;
    }
    case "score":
      if (!question.levels.includes(answer.value)) {
        throw new QuestionError(
          `Score answer "${answer.value}" is not one of the levels`,
        );
      }
      return;
    default:
      throw new QuestionError(
        `Unknown question kind: ${unexpectedKind(question)}`,
      );
  }
}

export function assertAnswers(
  questions: Readonly<Record<string, Question>>,
  answers: Readonly<Record<string, Answer>>,
): void {
  validateQuestions(questions);
  for (const key of Object.keys(questions)) {
    const question = questions[key];
    const answer = answers[key];
    if (question === undefined || answer === undefined) {
      throw new QuestionError(`Missing answer for question "${key}"`);
    }
    validateAnswer(question, answer);
  }
  for (const key of Object.keys(answers)) {
    if (questions[key] === undefined) {
      throw new QuestionError(`Unexpected answer "${key}"`);
    }
  }
}

function assertPrompt(prompt: string): void {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new QuestionError("Question prompt must be a non-empty string");
  }
}

function validateChoice(question: ChoiceQuestion): void {
  const count = question.options.length;
  if (count < 1 || count > MAX_CHOICE_OPTIONS) {
    throw new QuestionError(
      `A choice question must have 1 to ${String(MAX_CHOICE_OPTIONS)} options, got ${String(count)}`,
    );
  }
  const seen = new Set<string>();
  for (const option of question.options) {
    if (option.id.trim().length === 0 || option.label.trim().length === 0) {
      throw new QuestionError("Choice option ids and labels must be non-empty");
    }
    if (seen.has(option.id)) {
      throw new QuestionError(`Duplicate choice option id "${option.id}"`);
    }
    seen.add(option.id);
  }
}

function validateScore(question: ScoreQuestion): void {
  const count = question.levels.length;
  if (count < MIN_SCORE_LEVELS || count > MAX_SCORE_LEVELS) {
    throw new QuestionError(
      `A score question must have ${String(MIN_SCORE_LEVELS)} to ${String(MAX_SCORE_LEVELS)} levels, got ${String(count)}`,
    );
  }
  const seen = new Set<string>();
  for (const level of question.levels) {
    if (level.trim().length === 0) {
      throw new QuestionError("Score levels must be non-empty");
    }
    if (seen.has(level)) {
      throw new QuestionError(`Duplicate score level "${level}"`);
    }
    seen.add(level);
  }
}

function unexpectedKind(question: never): string {
  return JSON.stringify(question);
}
