import type {
  Answer,
  DecisionState,
  Question,
  WalletContext,
} from "./decider.js";
import { assertAnswers, validateQuestions } from "./decider.js";
import type { Decider } from "./decider.js";
import { RedactionError, SnapshotError } from "./errors.js";
import { collapseWhitespace, isRecord } from "./guards.js";
import { pruneSnapshot } from "./prune.js";
import type { PruneOptions } from "./prune.js";
import { redactText, redactWallet } from "./redact.js";
import type { RedactRule } from "./redact.js";

export interface PreparedDecisionState {
  readonly snapshot: DecisionState["snapshot"];
  readonly truncated: boolean;
  readonly url?: string;
  readonly goal?: string;
  readonly wallet?: WalletContext;
}

/**
 * Redact, normalise, and prune a state before it is hashed or handed to a
 * decider. URL, goal, and wallet fields go through the same text redaction
 * as the snapshot. Screenshots are rejected.
 */
export function prepareDecisionState(
  state: DecisionState,
  options?: PruneOptions,
): PreparedDecisionState {
  rejectScreenshot(state);
  const rules = options?.redact ?? [];
  const pruned = pruneSnapshot(state.snapshot, options);
  const url =
    state.url === undefined ? undefined : redactText(state.url, rules);
  const goal =
    state.goal === undefined ? undefined : redactText(state.goal, rules);
  const wallet =
    state.wallet === undefined ? undefined : redactWallet(state.wallet, rules);
  return {
    snapshot: pruned.snapshot,
    truncated: pruned.truncated,
    ...(url !== undefined ? { url } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(wallet !== undefined ? { wallet } : {}),
  };
}

/**
 * What `callDecider` returns. `truncated` is what pruning reported for the
 * snapshot the decider actually saw. Pass it to `gateAnswer` as
 * `{ truncated }`, so a "no" about a page that was cut cannot become `fail`.
 */
export interface DecisionResult {
  readonly answers: Readonly<Record<string, Answer>>;
  readonly truncated: boolean;
}

/**
 * The only supported way to invoke a decider from Jevy code.
 * The decider sees the prepared state, never the raw page.
 *
 * The token budget follows `decider.id`, so a Kev decider gets Kev's budget
 * without the caller passing `deciderId`. A `deciderId` in `options` is
 * ignored here; an explicit `maxTokens` still wins.
 *
 * The questions are redacted too: a prompt is written by a person or an
 * agent and can quote an email or a key as easily as the page can. Answers
 * are still checked against the questions as the caller wrote them.
 */
export async function callDecider(
  decider: Decider,
  state: DecisionState,
  questions: Readonly<Record<string, Question>>,
  options?: PruneOptions,
): Promise<DecisionResult> {
  validateQuestions(questions);
  const prepared = prepareDecisionState(state, {
    ...options,
    deciderId: decider.id,
  });
  const answers = await decider.decide(
    toDecisionState(prepared),
    redactQuestions(questions, options?.redact ?? []),
  );
  assertAnswers(questions, answers);
  return { answers, truncated: prepared.truncated };
}

function redactQuestions(
  questions: Readonly<Record<string, Question>>,
  rules: readonly RedactRule[],
): Readonly<Record<string, Question>> {
  const redacted: Record<string, Question> = {};
  for (const name of Object.keys(questions)) {
    const question = questions[name];
    if (question === undefined) continue;
    // A null-prototype copy would lose nothing, but `defineProperty` keeps a
    // question named `__proto__` an own key on a plain object.
    Object.defineProperty(redacted, name, {
      value: redactQuestion(question, rules),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return redacted;
}

/**
 * Prompts, criteria and option labels are redacted. Option ids and score
 * levels are the values the decider answers with, so they cannot be rewritten
 * without breaking the answer check; one that redaction would change is
 * refused instead, before any call is made.
 */
function redactQuestion(
  question: Question,
  rules: readonly RedactRule[],
): Question {
  const prompt = redactText(question.prompt, rules);
  switch (question.kind) {
    case "yesno":
      return question.criteria === undefined
        ? { kind: "yesno", prompt }
        : {
            kind: "yesno",
            prompt,
            criteria: redactText(question.criteria, rules),
          };
    case "choice":
      return {
        kind: "choice",
        prompt,
        options: question.options.map((option) => ({
          id: unchangedByRedaction(option.id, rules, "A choice option id"),
          label: redactText(option.label, rules),
        })),
      };
    case "score":
      return {
        kind: "score",
        prompt,
        levels: question.levels.map((level) =>
          unchangedByRedaction(level, rules, "A score level"),
        ),
      };
  }
}

function unchangedByRedaction(
  value: string,
  rules: readonly RedactRule[],
  what: string,
): string {
  if (redactText(value, rules) !== collapseWhitespace(value)) {
    throw new RedactionError(
      `${what} looks like a secret or personal data. It is a value the decider answers with, so it cannot be redacted; use a neutral id or level and put the detail in a label or the prompt.`,
    );
  }
  return value;
}

function toDecisionState(prepared: PreparedDecisionState): DecisionState {
  return {
    snapshot: prepared.snapshot,
    ...(prepared.url !== undefined ? { url: prepared.url } : {}),
    ...(prepared.goal !== undefined ? { goal: prepared.goal } : {}),
    ...(prepared.wallet !== undefined ? { wallet: prepared.wallet } : {}),
  };
}

function rejectScreenshot(state: DecisionState): void {
  if (!isRecord(state)) {
    throw new SnapshotError("Decision state must be an object");
  }
  if (Object.hasOwn(state, "screenshot") && state["screenshot"] !== undefined) {
    throw new SnapshotError(
      "Screenshots are not part of DecisionState. Leave them off; the accessibility snapshot is the state the decider sees.",
    );
  }
}
