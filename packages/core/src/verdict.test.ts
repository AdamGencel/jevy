import { describe, expect, it } from "vitest";
import type { Question } from "./decider.js";
import { QuestionError } from "./errors.js";
import { DEFAULT_THRESHOLDS, gateAnswer, probabilityOfYes } from "./verdict.js";

const yesno: Question = {
  kind: "yesno",
  prompt: "The page shows the order as confirmed",
};

const score: Question = {
  kind: "score",
  prompt: "How complete is the order?",
  levels: ["broken", "partial", "good"],
};

const choice: Question = {
  kind: "choice",
  prompt: "Which control continues checkout?",
  options: [
    { id: "pay", label: "Pay" },
    { id: "back", label: "Back" },
  ],
};

describe("verdict thresholds", () => {
  it("passes a confident yes and fails a confident no", () => {
    expect(gateAnswer(yesno, { value: "yes", confidence: 0.93 })).toBe("pass");
    expect(
      gateAnswer(yesno, { value: "yes", confidence: DEFAULT_THRESHOLDS.pass }),
    ).toBe("pass");
    expect(gateAnswer(yesno, { value: "no", confidence: 0.93 })).toBe("fail");
    expect(
      gateAnswer(yesno, { value: "no", confidence: DEFAULT_THRESHOLDS.pass }),
    ).toBe("fail");
  });

  it("sends a weak yes and a weak no to needs-review", () => {
    expect(gateAnswer(yesno, { value: "yes", confidence: 0.79 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(yesno, { value: "yes", confidence: 0.25 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(yesno, { value: "no", confidence: 0.79 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(yesno, { value: "no", confidence: 0.125 })).toBe(
      "needs-review",
    );
    expect(() =>
      probabilityOfYes(yesno, { value: "no", confidence: 0.125 }),
    ).toThrow(QuestionError);
  });

  it("does not apply the fail threshold to a yes/no answer", () => {
    const thresholds = [
      { pass: 0.8, fail: 0.1 },
      { pass: 0.8, fail: 0.7 },
    ] as const;
    for (const gate of thresholds) {
      expect(gateAnswer(yesno, { value: "yes", confidence: 0.3 }, gate)).toBe(
        "needs-review",
      );
      expect(gateAnswer(yesno, { value: "no", confidence: 0.6 }, gate)).toBe(
        "needs-review",
      );
      expect(gateAnswer(yesno, { value: "yes", confidence: 0.8 }, gate)).toBe(
        "pass",
      );
      expect(gateAnswer(yesno, { value: "no", confidence: 0.8 }, gate)).toBe(
        "fail",
      );
    }
  });

  it("shrinks a score toward needs-review as confidence drops", () => {
    expect(gateAnswer(score, { value: "good", confidence: 1 })).toBe("pass");
    expect(gateAnswer(score, { value: "broken", confidence: 1 })).toBe("fail");
    expect(gateAnswer(score, { value: "partial", confidence: 1 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(score, { value: "good", confidence: 0 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(score, { value: "good", confidence: 0.75 })).toBe("pass");
    expect(gateAnswer(score, { value: "good", confidence: 0.5 })).toBe(
      "needs-review",
    );
  });

  it("accepts a choice only above the pass threshold", () => {
    expect(gateAnswer(choice, { value: "pay", confidence: 0.8 })).toBe("pass");
    expect(gateAnswer(choice, { value: "pay", confidence: 0.75 })).toBe(
      "needs-review",
    );
    expect(gateAnswer(choice, { value: "pay", confidence: 0.25 })).toBe(
      "needs-review",
    );
    expect(() =>
      gateAnswer(choice, { value: "missing", confidence: 1 }),
    ).toThrow(QuestionError);
    expect(() =>
      probabilityOfYes(choice, { value: "pay", confidence: 1 }),
    ).toThrow(QuestionError);
  });

  it("rejects inverted or out-of-range thresholds and bad answers", () => {
    expect(() =>
      gateAnswer(
        yesno,
        { value: "yes", confidence: 1 },
        { pass: 0.4, fail: 0.5 },
      ),
    ).toThrow(QuestionError);
    expect(() => gateAnswer(yesno, { value: "YES", confidence: 1 })).toThrow(
      QuestionError,
    );
    expect(() =>
      gateAnswer(yesno, { value: "yes", confidence: Number.NaN }),
    ).toThrow(QuestionError);
    expect(() =>
      gateAnswer(
        yesno,
        { value: "yes", confidence: 1 },
        { pass: 0.9, fail: 0.2 },
      ),
    ).not.toThrow();
  });
});
