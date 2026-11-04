import { describe, expect, it } from "vitest";
import { ABSTAIN_ID, MAX_CHOICE_OPTIONS } from "./decider.js";
import { QuestionError } from "./errors.js";
import { gateAnswer } from "./verdict.js";
import {
  answerFromSignals,
  prepareWireQuestion,
  systemOneQuestions,
} from "./wire-question.js";
import { DECIDER_CONTRACT_CASES } from "./contract-cases.js";

describe("wire questions", () => {
  it("adds an inconclusive option and keeps probability apart from confidence", () => {
    for (const item of DECIDER_CONTRACT_CASES) {
      const wire = prepareWireQuestion(item.question);
      expect(wire.options.some((option) => option.abstain)).toBe(true);
      expect(wire.options.at(-1)?.id).toBe(ABSTAIN_ID);
      const answer = answerFromSignals(
        wire,
        item.picked,
        item.probabilities,
        item.confidence,
      );
      expect(answer.probability).toBe(item.probabilities[item.picked]);
      expect(answer.confidence).toBe(item.confidence ?? 0);
      expect(gateAnswer(item.question, answer)).toBe(item.verdict);
    }
  });

  it("asks yes/no and score as choices that include abstain", () => {
    const yesno = prepareWireQuestion({
      kind: "yesno",
      prompt: "Shown?",
      criteria: "A confirmation heading is visible",
    });
    expect(yesno.instructions).toContain("Criterion:");
    const body = systemOneQuestions({ shown: yesno });
    expect(body["shown"]?.type).toBe("choice");
    expect(Object.keys(body["shown"]?.criteria ?? {})).toEqual([
      "yes",
      "no",
      ABSTAIN_ID,
    ]);

    const score = prepareWireQuestion({
      kind: "score",
      prompt: "Rate",
      levels: ["bad", "good"],
    });
    expect(score.options.map((option) => option.id)).toEqual([
      "bad",
      "good",
      ABSTAIN_ID,
    ]);
  });

  it("reserves the last choice slot for inconclusive", () => {
    const options = Array.from(
      { length: MAX_CHOICE_OPTIONS - 1 },
      (_, index) => ({
        id: `id-${String(index)}`,
        label: `Label ${String(index)}`,
      }),
    );
    expect(
      prepareWireQuestion({ kind: "choice", prompt: "Pick", options }).options,
    ).toHaveLength(MAX_CHOICE_OPTIONS);
    expect(() => {
      prepareWireQuestion({
        kind: "choice",
        prompt: "Pick",
        options: [...options, { id: "extra", label: "Extra" }],
      });
    }).toThrow(QuestionError);
    expect(() => {
      prepareWireQuestion({
        kind: "choice",
        prompt: "Pick",
        options: [{ id: ABSTAIN_ID, label: "Taken" }],
      });
    }).toThrow(QuestionError);
  });
});
