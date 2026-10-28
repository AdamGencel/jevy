import { describe, expect, it } from "vitest";
import { callDecider } from "./prepare.js";
import {
  MAX_CHOICE_OPTIONS,
  validateQuestion,
  type Decider,
  type Question,
} from "./decider.js";
import { QuestionError, SnapshotError } from "./errors.js";
import { hashSnapshot } from "./hash.js";
import { parseConfig } from "./config.js";
import type { DecisionState } from "./decider.js";

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
      expect(answers["check"]).toEqual({ value: "yes", confidence: 0.95 });
      expect(calls).toEqual([]);
      const encoded = JSON.stringify(seen);
      expect(encoded).not.toContain("ada@example.com");
      expect(encoded).not.toContain("hunter2");
      expect(encoded).toContain("Password");
    } finally {
      globalThis.fetch = original;
    }
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
});
