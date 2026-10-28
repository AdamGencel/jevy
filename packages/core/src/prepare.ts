import type {
  Answer,
  DecisionState,
  Question,
  WalletContext,
} from "./decider.js";
import { assertAnswers, validateQuestions } from "./decider.js";
import type { Decider } from "./decider.js";
import { SnapshotError } from "./errors.js";
import { isRecord } from "./guards.js";
import { pruneSnapshot } from "./prune.js";
import type { PruneOptions } from "./prune.js";
import { redactText, redactWallet } from "./redact.js";

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
 * The only supported way to invoke a decider from Jevy code.
 * The decider sees the prepared state, never the raw page.
 */
export async function callDecider(
  decider: Decider,
  state: DecisionState,
  questions: Readonly<Record<string, Question>>,
  options?: PruneOptions,
): Promise<Readonly<Record<string, Answer>>> {
  validateQuestions(questions);
  const prepared = prepareDecisionState(state, options);
  const answers = await decider.decide(toDecisionState(prepared), questions);
  assertAnswers(questions, answers);
  return answers;
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
