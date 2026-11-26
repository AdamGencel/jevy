import { describe, expect, it } from "vitest";
import { ConfigError, callDecider, gateAnswer } from "@jevyjs/core";
import type { DecisionState, Question } from "@jevyjs/core";
import { fakeDecider } from "./fake.js";

const STATE: DecisionState = { snapshot: { role: "main", name: "Paid" } };
const YESNO: Question = { kind: "yesno", prompt: "Is it paid?" };

describe("fakeDecider", () => {
  it("has a fake id and model by default, and takes others", () => {
    expect(fakeDecider()).toMatchObject({ id: "fake", model: "fake-1" });
    expect(fakeDecider({ id: "llm:x/y", model: "x/y" })).toMatchObject({
      id: "llm:x/y",
      model: "x/y",
    });
  });

  it("answers from a record keyed by question name", async () => {
    const decider = fakeDecider({
      answers: { paid: { value: "yes", confidence: 0.9 } },
    });
    const { answers } = await callDecider(decider, STATE, { paid: YESNO });
    expect(answers).toEqual({ paid: { value: "yes", confidence: 0.9 } });
  });

  it("answers from a function given the name, the question and the state", async () => {
    const decider = fakeDecider({
      answers: ({ name, question, state }) =>
        name === "paid" &&
        question.prompt === "Is it paid?" &&
        state.snapshot.name === "Paid"
          ? { value: "no", confidence: 0.8 }
          : undefined,
    });
    const { answers } = await callDecider(decider, STATE, { paid: YESNO });
    expect(answers["paid"]).toEqual({ value: "no", confidence: 0.8 });
  });

  it("abstains on a question with no scripted answer, which is needs-review", async () => {
    for (const decider of [
      fakeDecider(),
      fakeDecider({ answers: { other: { value: "yes", confidence: 1 } } }),
      fakeDecider({ answers: () => undefined }),
    ]) {
      const { answers } = await callDecider(decider, STATE, { paid: YESNO });
      const answer = answers["paid"];
      expect(answer?.abstained).toBe(true);
      if (answer === undefined) return;
      expect(gateAnswer(YESNO, answer)).toBe("needs-review");
    }
  });

  it("does not find a scripted answer on Object.prototype", async () => {
    const decider = fakeDecider({ answers: {} });
    const { answers } = await callDecider(decider, STATE, {
      toString: YESNO,
    });
    expect(answers["toString"]?.abstained).toBe(true);
  });

  it("tells onDecide what it was asked", async () => {
    const seen: [DecisionState, Readonly<Record<string, Question>>][] = [];
    const decider = fakeDecider({
      onDecide: (state, questions) => {
        seen.push([state, questions]);
      },
    });
    await callDecider(
      decider,
      { ...STATE, url: "https://a.example/x?token=1" },
      { paid: YESNO },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0].url).toBe("https://a.example/x");
    expect(seen[0]?.[1]).toEqual({ paid: YESNO });
  });

  it("rejects, never throws, when onDecide or a script function throws", async () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    for (const decider of [
      fakeDecider({ onDecide: boom }),
      fakeDecider({ answers: boom }),
    ]) {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = decider.decide(STATE, { paid: YESNO });
      }).not.toThrow();
      await expect(promise).rejects.toThrow("boom");
    }
  });

  it("refuses an id or a model that is not a string with ConfigError", () => {
    for (const bad of [5, null, {}]) {
      expect(() => fakeDecider({ id: bad as unknown as string })).toThrow(
        ConfigError,
      );
      expect(() => fakeDecider({ model: bad as unknown as string })).toThrow(
        ConfigError,
      );
    }
  });
});
