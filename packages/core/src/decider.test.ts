import { describe, expect, it } from "vitest";
import { callDecider } from "./prepare.js";
import {
  MAX_CHOICE_OPTIONS,
  assertAnswers,
  validateAnswer,
  validateQuestion,
  type Answer,
  type Decider,
  type Question,
} from "./decider.js";
import { QuestionError, SnapshotError } from "./errors.js";
import { hashSnapshot } from "./hash.js";
import { parseConfig } from "./config.js";
import type { DecisionState } from "./decider.js";
import { estimateSnapshotTokens } from "./hash.js";
import {
  DEFAULT_SNAPSHOT_TOKEN_BUDGET,
  KEV_SNAPSHOT_TOKEN_BUDGET,
} from "./prune.js";

describe("decider contract", () => {
  it("caps choice options at 255 and checks score levels", () => {
    const options = Array.from({ length: MAX_CHOICE_OPTIONS }, (_, index) => ({
      id: `id-${String(index)}`,
      label: `Label ${String(index)}`,
    }));
    const full: Question = {
      kind: "choice",
      prompt: "Pick a control",
      options,
    };
    expect(() => {
      validateQuestion(full);
    }).not.toThrow();
    expect(() => {
      validateQuestion({
        ...full,
        options: [...options, { id: "one-more", label: "One more" }],
      });
    }).toThrow(QuestionError);
    expect(() => {
      validateQuestion({
        kind: "choice",
        prompt: "Pick",
        options: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      });
    }).toThrow(/Duplicate/);
    expect(() => {
      validateQuestion({ kind: "score", prompt: "Rate", levels: ["only"] });
    }).toThrow(QuestionError);
    expect(() => {
      validateQuestion({
        kind: "score",
        prompt: "Rate",
        levels: ["no", "yes"],
      });
    }).not.toThrow();
  });

  it("sends a fake decider the redacted state and does not call fetch", async () => {
    const seen: DecisionState[] = [];
    const decider: Decider = {
      id: "fake",
      model: "fake-1",
      decide(state, questions) {
        seen.push(state);
        expect(questions["check"]?.kind).toBe("yesno");
        return Promise.resolve({
          check: { value: "yes", confidence: 0.95 },
        });
      },
    };
    const calls: unknown[][] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      throw new Error("network");
    };

    try {
      hashSnapshot({ role: "button", name: "Pay" });
      parseConfig({ decider: "kev" }, { env: {} });
      const answers = await callDecider(
        decider,
        {
          snapshot: {
            role: "WebArea",
            name: "Hello ada@example.com",
            children: [{ role: "textbox", name: "Password", value: "hunter2" }],
          },
          goal: "reach ada@example.com",
        },
        {
          check: {
            kind: "yesno",
            prompt: "Is the dashboard shown?",
          },
        },
      );
      expect(answers).toEqual({
        answers: { check: { value: "yes", confidence: 0.95 } },
        truncated: false,
      });
      expect(calls).toEqual([]);
      const encoded = JSON.stringify(seen);
      expect(encoded).not.toContain("ada@example.com");
      expect(encoded).not.toContain("hunter2");
      expect(encoded).toContain("Password");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("prunes to the budget of the decider it calls", async () => {
    const sentTokens = new Map<string, number>();
    const fake = (id: string): Decider => ({
      id,
      model: `${id}-1`,
      decide(state) {
        sentTokens.set(id, estimateSnapshotTokens(state.snapshot));
        return Promise.resolve({ check: { value: "yes", confidence: 1 } });
      },
    });
    const snapshot = {
      role: "main",
      children: Array.from({ length: 390 }, (_, index) => ({
        role: "paragraph",
        name: `para${String(index)} `.repeat(25),
      })),
    };
    const questions = { check: { kind: "yesno", prompt: "Shown?" } } as const;

    const kevResult = await callDecider(fake("kev"), { snapshot }, questions);
    const jevResult = await callDecider(fake("jev"), { snapshot }, questions);
    // A stray deciderId does not override the decider being called.
    const strayResult = await callDecider(
      fake("kev"),
      { snapshot },
      questions,
      { deciderId: "jev" },
    );

    // This page is over both budgets, so both deciders see a cut snapshot.
    expect(kevResult.truncated).toBe(true);
    expect(jevResult.truncated).toBe(true);
    expect(strayResult.truncated).toBe(true);

    const kev = sentTokens.get("kev") ?? Infinity;
    const jev = sentTokens.get("jev") ?? 0;
    expect(kev).toBeLessThanOrEqual(KEV_SNAPSHOT_TOKEN_BUDGET);
    expect(jev).toBeGreaterThan(KEV_SNAPSHOT_TOKEN_BUDGET);
    expect(jev).toBeLessThanOrEqual(DEFAULT_SNAPSHOT_TOKEN_BUDGET);
  });

  it("rejects a screenshot on the decision state", async () => {
    const decider: Decider = {
      id: "fake",
      model: "fake-1",
      decide() {
        return Promise.resolve({
          check: { value: "yes", confidence: 1 },
        });
      },
    };
    const state = {
      snapshot: { role: "button", name: "Pay" },
      screenshot: "not-allowed",
    };
    await expect(
      callDecider(decider, state, {
        check: { kind: "yesno", prompt: "Shown?" },
      }),
    ).rejects.toBeInstanceOf(SnapshotError);
  });

  it("reports whether the snapshot the decider saw was truncated", async () => {
    const nodesSeen: number[] = [];
    const decider: Decider = {
      id: "fake",
      model: "fake-1",
      decide(state) {
        nodesSeen.push(state.snapshot.children?.length ?? 0);
        return Promise.resolve({ check: { value: "no", confidence: 1 } });
      },
    };
    const snapshot = {
      role: "main",
      children: Array.from({ length: 10 }, (_, index) => ({
        role: "button",
        name: `Button ${String(index)}`,
      })),
    };
    const questions = { check: { kind: "yesno", prompt: "Shown?" } } as const;

    const whole = await callDecider(decider, { snapshot }, questions);
    const cut = await callDecider(decider, { snapshot }, questions, {
      maxNodes: 4,
    });

    expect(whole.truncated).toBe(false);
    expect(cut.truncated).toBe(true);
    expect(cut.answers).toEqual({ check: { value: "no", confidence: 1 } });
    expect(nodesSeen).toEqual([10, 3]);
  });
});

describe("abstained answers", () => {
  const yesno: Question = { kind: "yesno", prompt: "Shown?" };
  const choice: Question = {
    kind: "choice",
    prompt: "Pick",
    options: [{ id: "a", label: "A" }],
  };
  const score: Question = {
    kind: "score",
    prompt: "Rate",
    levels: ["bad", "good"],
  };

  it("accepts any non-empty value when abstained", () => {
    for (const question of [yesno, choice, score]) {
      expect(() => {
        validateAnswer(question, {
          value: "cannot tell",
          confidence: 0.3,
          abstained: true,
        });
      }).not.toThrow();
    }
  });

  it("still checks value type and confidence when abstained", () => {
    const bad: unknown[] = [
      { value: 42, confidence: 0.5, abstained: true },
      { value: "", confidence: 0.5, abstained: true },
      { value: "unsure", confidence: -0.1, abstained: true },
      { value: "unsure", confidence: 1.1, abstained: true },
      {
        value: "unsure",
        confidence: Number.POSITIVE_INFINITY,
        abstained: true,
      },
      { value: "unsure", confidence: "0.5", abstained: true },
    ];
    for (const answer of bad) {
      expect(() => {
        validateAnswer(yesno, answer as Answer);
      }).toThrow(QuestionError);
    }
  });

  it("rejects an abstained flag that is not a boolean", () => {
    const flags: unknown[] = ["true", 1, null, {}];
    for (const abstained of flags) {
      const answer = { value: "yes", confidence: 1, abstained } as Answer;
      expect(() => {
        validateAnswer(yesno, answer);
      }).toThrow(QuestionError);
    }
  });

  it("checks the value as usual when abstained is false", () => {
    expect(() => {
      validateAnswer(yesno, {
        value: "maybe",
        confidence: 1,
        abstained: false,
      });
    }).toThrow(QuestionError);
    expect(() => {
      validateAnswer(yesno, { value: "yes", confidence: 1, abstained: false });
    }).not.toThrow();
  });
});

describe("assertAnswers own properties", () => {
  const questions: Readonly<Record<string, Question>> = {
    check: { kind: "yesno", prompt: "Shown?" },
  };
  const check: Answer = { value: "yes", confidence: 1 };

  it("rejects an extra answer named after an Object.prototype member", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const answers = { check, [key]: { value: "yes", confidence: 1 } };
      expect(() => {
        assertAnswers(questions, answers);
      }).toThrow(new QuestionError(`Unexpected answer "${key}"`));
    }
  });

  it("rejects an extra own __proto__ answer", () => {
    const answers = JSON.parse(
      '{"check":{"value":"yes","confidence":1},"__proto__":{"value":"yes","confidence":1}}',
    ) as Record<string, Answer>;
    expect(Object.hasOwn(answers, "__proto__")).toBe(true);
    expect(() => {
      assertAnswers(questions, answers);
    }).toThrow(new QuestionError('Unexpected answer "__proto__"'));
  });

  it("does not find a missing answer on Object.prototype", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const named: Readonly<Record<string, Question>> = {
        [key]: { kind: "yesno", prompt: "Shown?" },
      };
      expect(() => {
        assertAnswers(named, {});
      }).toThrow(new QuestionError(`Missing answer for question "${key}"`));
    }
  });

  it("does not find a missing __proto__ answer on the prototype", () => {
    const named = JSON.parse(
      '{"__proto__":{"kind":"yesno","prompt":"Shown?"}}',
    ) as Record<string, Question>;
    const inherited = Object.create({
      __proto__: { value: "yes", confidence: 1 },
    }) as Record<string, Answer>;
    expect(() => {
      assertAnswers(named, inherited);
    }).toThrow(new QuestionError('Missing answer for question "__proto__"'));
    expect(() => {
      assertAnswers(named, {});
    }).toThrow(new QuestionError('Missing answer for question "__proto__"'));
  });

  it("accepts own answers for every question", () => {
    expect(() => {
      assertAnswers(questions, { check });
    }).not.toThrow();
  });
});
