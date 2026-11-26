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
import { redactText, redactUrl, redactWallet } from "./redact.js";
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
 * decider. Goal and wallet fields go through the same text redaction as the
 * snapshot. Screenshots are rejected, and so is a `url` or `goal` that is not
 * a string.
 *
 * A wallet field's key is shown to the decider as it is, so a key that
 * redaction would change is refused with `RedactionError` rather than sent;
 * rewriting it could make two keys collide.
 *
 * The page's own `url` is redacted as a link's is (`redactUrl`): reduced to
 * scheme, host and path, then through the text rules. Dropping the query
 * string and the fragment removes every token kept there, recognised or
 * not. A token in the path (`/reset-password/<code>`, an invite id, a
 * `;jsessionid=`) is kept, and is removed only if a text rule recognises it:
 * pass a `redact` rule for any path segment your app uses as a secret.
 */
export function prepareDecisionState(
  state: DecisionState,
  options?: PruneOptions,
): PreparedDecisionState {
  rejectScreenshot(state);
  assertOptionalString(state.url, "url");
  assertOptionalString(state.goal, "goal");
  const rules = options?.redact ?? [];
  const pruned = pruneSnapshot(state.snapshot, options);
  const url = state.url === undefined ? undefined : redactUrl(state.url, rules);
  const goal =
    state.goal === undefined ? undefined : redactText(state.goal, rules);
  const wallet =
    state.wallet === undefined ? undefined : redactWallet(state.wallet, rules);
  for (const key of Object.keys(wallet?.fields ?? {})) {
    unchangedByRedaction(key, rules, WALLET_KEY_REFUSAL);
  }
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
 * are still checked against the questions as the caller wrote them. A
 * question's name is the key its answer comes back under, so it cannot be
 * rewritten; one that redaction would change is refused with
 * `RedactionError` before the decider is called, as option ids are.
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
    unchangedByRedaction(name, rules, QUESTION_NAME_REFUSAL);
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
          id: unchangedByRedaction(
            option.id,
            rules,
            answerValueRefusal("A choice option id"),
          ),
          label: redactText(option.label, rules),
        })),
      };
    case "score":
      return {
        kind: "score",
        prompt,
        levels: question.levels.map((level) =>
          unchangedByRedaction(
            level,
            rules,
            answerValueRefusal("A score level"),
          ),
        ),
      };
  }
}

const QUESTION_NAME_REFUSAL =
  "A question name looks like a secret or personal data. It is the key the answer comes back under, so it cannot be redacted; use a neutral name and put the detail in the prompt.";

const WALLET_KEY_REFUSAL =
  "A wallet field name looks like a secret or personal data. Field names are shown to the decider as they are; use a neutral name and put the detail in the value, which is redacted.";

function answerValueRefusal(what: string): string {
  return `${what} looks like a secret or personal data. It is a value the decider answers with, so it cannot be redacted; use a neutral id or level and put the detail in a label or the prompt.`;
}

/**
 * Text that is passed on as it is, so it is refused if redaction would
 * change it. The message never quotes the text: it is the suspected secret.
 */
function unchangedByRedaction(
  value: string,
  rules: readonly RedactRule[],
  refusal: string,
): string {
  if (redactText(value, rules) !== collapseWhitespace(value)) {
    throw new RedactionError(refusal);
  }
  return value;
}

/** A field a caller typed loosely would otherwise fail as a `TypeError`. */
function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new SnapshotError(
      `Decision state ${field} must be a string when it is given`,
    );
  }
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
