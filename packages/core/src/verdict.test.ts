import { describe, expect, it } from "vitest";
import type { Question } from "./decider.js";
import { QuestionError } from "./errors.js";
import { DEFAULT_THRESHOLDS, gateAnswer, probabilityOfYes } from "./verdict.js";
import type { GateContext } from "./verdict.js";

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

describe("truncated snapshots", () => {
  const cut = { truncated: true } as const;

  it("turns a fail into needs-review when the snapshot was cut", () => {
    expect(gateAnswer(yesno, { value: "no", confidence: 0.95 })).toBe("fail");
    expect(
      gateAnswer(yesno, { value: "no", confidence: 0.95 }, undefined, cut),
    ).toBe("needs-review");
    expect(gateAnswer(score, { value: "broken", confidence: 1 })).toBe("fail");
    expect(
      gateAnswer(
        score,
        { value: "broken", confidence: 1 },
        DEFAULT_THRESHOLDS,
        cut,
      ),
    ).toBe("needs-review");
  });

  it("leaves pass and needs-review alone when the snapshot was cut", () => {
    expect(
      gateAnswer(yesno, { value: "yes", confidence: 0.95 }, undefined, cut),
    ).toBe("pass");
    expect(
      gateAnswer(yesno, { value: "no", confidence: 0.5 }, undefined, cut),
    ).toBe("needs-review");
    expect(
      gateAnswer(score, { value: "good", confidence: 1 }, undefined, cut),
    ).toBe("pass");
    expect(
      gateAnswer(score, { value: "partial", confidence: 1 }, undefined, cut),
    ).toBe("needs-review");
    expect(
      gateAnswer(choice, { value: "pay", confidence: 0.9 }, undefined, cut),
    ).toBe("pass");
  });

  it("keeps a fail when the snapshot was not cut", () => {
    const whole = [{}, { truncated: false }] as const;
    for (const context of whole) {
      expect(
        gateAnswer(
          yesno,
          { value: "no", confidence: 0.95 },
          undefined,
          context,
        ),
      ).toBe("fail");
      expect(
        gateAnswer(
          score,
          { value: "broken", confidence: 1 },
          undefined,
          context,
        ),
      ).toBe("fail");
    }
  });
});

describe("gate context", () => {
  it("rejects a truncated flag that is not a boolean", () => {
    const context = { truncated: "true" } as unknown as GateContext;
    expect(() =>
      gateAnswer(yesno, { value: "no", confidence: 1 }, undefined, context),
    ).toThrow(QuestionError);
  });
});

describe("abstained answers", () => {
  it("is needs-review whatever the confidence", () => {
    for (const confidence of [0, 0.5, 0.95, 1]) {
      expect(
        gateAnswer(yesno, { value: "unsure", confidence, abstained: true }),
      ).toBe("needs-review");
      expect(
        gateAnswer(score, { value: "good", confidence, abstained: true }),
      ).toBe("needs-review");
      expect(
        gateAnswer(choice, { value: "pay", confidence, abstained: true }),
      ).toBe("needs-review");
    }
  });

  it("is needs-review on a truncated snapshot too", () => {
    expect(
      gateAnswer(
        yesno,
        { value: "no", confidence: 1, abstained: true },
        undefined,
        { truncated: true },
      ),
    ).toBe("needs-review");
  });

  it("has no probability of yes", () => {
    expect(() =>
      probabilityOfYes(score, {
        value: "good",
        confidence: 1,
        abstained: true,
      }),
    ).toThrow(QuestionError);
    expect(() =>
      probabilityOfYes(score, {
        value: "not-a-level",
        confidence: 1,
        abstained: true,
      }),
    ).toThrow(QuestionError);
  });

  it("still checks confidence and value type on an abstention", () => {
    expect(() =>
      gateAnswer(yesno, {
        value: "unsure",
        confidence: Number.NaN,
        abstained: true,
      }),
    ).toThrow(QuestionError);
    expect(() =>
      gateAnswer(yesno, { value: "unsure", confidence: 2, abstained: true }),
    ).toThrow(QuestionError);
  });

  it("gates abstained: false like an ordinary answer", () => {
    expect(
      gateAnswer(yesno, { value: "yes", confidence: 0.95, abstained: false }),
    ).toBe("pass");
    expect(() =>
      gateAnswer(yesno, { value: "unsure", confidence: 1, abstained: false }),
    ).toThrow(QuestionError);
  });
});
