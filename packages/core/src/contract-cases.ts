import { ABSTAIN_ID } from "./decider.js";
import type { Question } from "./decider.js";
import type { Verdict } from "./verdict.js";

export interface DeciderContractCase {
  readonly name: string;
  readonly question: Question;
  /** Option id the model picked, including the abstain id. */
  readonly picked: string;
  readonly probabilities: Readonly<Record<string, number>>;
  /** Null means the provider omitted confidence. */
  readonly confidence: number | null;
  readonly verdict: Verdict;
}

const yesno: Question = {
  kind: "yesno",
  prompt: "The page shows the order as confirmed",
};

const choice: Question = {
  kind: "choice",
  prompt: "Which control matches the goal?",
  options: [
    { id: "pay", label: "Pay" },
    { id: "cancel", label: "Cancel" },
  ],
};

const score: Question = {
  kind: "score",
  prompt: "How complete is the order?",
  levels: ["broken", "partial", "good"],
};

/**
 * Shared cases for the fake decider and the three adapters.
 * The verdicts are the no-flip rule: a yes passes only when confidence is
 * high, a no fails only when confidence is high, and abstain is needs-review.
 */
export const DECIDER_CONTRACT_CASES: readonly DeciderContractCase[] = [
  {
    name: "confident yes",
    question: yesno,
    picked: "yes",
    probabilities: { yes: 0.7, no: 0.2, [ABSTAIN_ID]: 0.1 },
    confidence: 0.93,
    verdict: "pass",
  },
  {
    name: "weak yes stays needs-review",
    question: yesno,
    picked: "yes",
    probabilities: { yes: 0.99, no: 0.01, [ABSTAIN_ID]: 0 },
    confidence: 0.4,
    verdict: "needs-review",
  },
  {
    name: "confident no",
    question: yesno,
    picked: "no",
    probabilities: { yes: 0.05, no: 0.9, [ABSTAIN_ID]: 0.05 },
    confidence: 0.91,
    verdict: "fail",
  },
  {
    name: "weak no is not flipped to pass",
    question: yesno,
    picked: "no",
    probabilities: { yes: 0.1, no: 0.85, [ABSTAIN_ID]: 0.05 },
    confidence: 0.2,
    verdict: "needs-review",
  },
  {
    name: "missing confidence is not a pass",
    question: yesno,
    picked: "yes",
    probabilities: { yes: 1, no: 0, [ABSTAIN_ID]: 0 },
    confidence: null,
    verdict: "needs-review",
  },
  {
    name: "yesno abstain",
    question: yesno,
    picked: ABSTAIN_ID,
    probabilities: { yes: 0.1, no: 0.1, [ABSTAIN_ID]: 0.8 },
    confidence: 1,
    verdict: "needs-review",
  },
  {
    name: "confident choice",
    question: choice,
    picked: "pay",
    probabilities: { pay: 0.8, cancel: 0.1, [ABSTAIN_ID]: 0.1 },
    confidence: 0.9,
    verdict: "pass",
  },
  {
    name: "weak choice",
    question: choice,
    picked: "pay",
    probabilities: { pay: 0.55, cancel: 0.4, [ABSTAIN_ID]: 0.05 },
    confidence: 0.3,
    verdict: "needs-review",
  },
  {
    name: "choice abstain",
    question: choice,
    picked: ABSTAIN_ID,
    probabilities: { pay: 0.2, cancel: 0.2, [ABSTAIN_ID]: 0.6 },
    confidence: 0.95,
    verdict: "needs-review",
  },
  {
    name: "best score",
    question: score,
    picked: "good",
    probabilities: { broken: 0, partial: 0.1, good: 0.8, [ABSTAIN_ID]: 0.1 },
    confidence: 1,
    verdict: "pass",
  },
  {
    name: "worst score",
    question: score,
    picked: "broken",
    probabilities: { broken: 0.9, partial: 0.1, good: 0, [ABSTAIN_ID]: 0 },
    confidence: 1,
    verdict: "fail",
  },
  {
    name: "score abstain",
    question: score,
    picked: ABSTAIN_ID,
    probabilities: { broken: 0.1, partial: 0.1, good: 0.1, [ABSTAIN_ID]: 0.7 },
    confidence: 0.99,
    verdict: "needs-review",
  },
];
