import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChoiceQuestion, Question } from "../decider.js";
import { CacheError, QuestionError } from "../errors.js";
import { DECISION_KEY_VERSION, decisionKey, questionText } from "./key.js";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;

const yesno: Question = {
  kind: "yesno",
  prompt: "  The order is\n confirmed ",
};

const choice: ChoiceQuestion = {
  kind: "choice",
  prompt: "Which control continues checkout?",
  options: [
    { id: "pay", label: "Pay" },
    { id: "back", label: "Back" },
  ],
};

const score: Question = {
  kind: "score",
  prompt: "How complete is the order?",
  levels: ["broken", "partial", "good"],
};

function key(question: Question, overrides?: Partial<KeyParts>): string {
  return decisionKey({
    question,
    snapshotHash: overrides?.snapshotHash ?? HASH,
    deciderId: overrides?.deciderId ?? "jev",
    model: overrides?.model ?? "jev-1.14.0",
  });
}

interface KeyParts {
  readonly snapshotHash: string;
  readonly deciderId: string;
  readonly model: string;
}

describe("questionText", () => {
  it("collapses whitespace in the prompt", () => {
    expect(questionText(yesno, [])).toBe("The order is confirmed");
  });

  it("redacts the prompt with built-in and project rules", () => {
    const text = questionText(
      {
        kind: "yesno",
        prompt: "The page greets alice@example.com as ACCT-991",
      },
      [/ACCT-\d+/],
    );
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("ACCT-991");
    expect(text).toContain("[REDACTED]");
  });

  it("includes yes/no criteria on its own line, so it cannot collide with a prompt", () => {
    const withCriteria = questionText(
      {
        kind: "yesno",
        prompt: "Order confirmed",
        criteria: " shows  a number ",
      },
      [],
    );
    expect(withCriteria).toBe("Order confirmed\nCriteria: shows a number");
    const inPrompt = questionText(
      { kind: "yesno", prompt: "Order confirmed Criteria: shows a number" },
      [],
    );
    expect(inPrompt).not.toBe(withCriteria);
  });
});

describe("decisionKey", () => {
  it("is sha256 over canonical JSON with a fixed key order", () => {
    const payload = JSON.stringify({
      v: 1,
      kind: "choice",
      question: "Which control continues checkout?",
      options: [
        { id: "back", label: "Back" },
        { id: "pay", label: "Pay" },
      ],
      snapshotHash: HASH,
      decider: "jev",
      model: "jev-1.14.0",
    });
    const expected = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    expect(key(choice)).toBe(expected);
    expect(DECISION_KEY_VERSION).toBe(1);
  });

  it("uses the levels in order for a score and no options for yes/no", () => {
    const scorePayload = JSON.stringify({
      v: 1,
      kind: "score",
      question: "How complete is the order?",
      options: ["broken", "partial", "good"],
      snapshotHash: HASH,
      decider: "jev",
      model: "jev-1.14.0",
    });
    expect(key(score)).toBe(
      `sha256:${createHash("sha256").update(scorePayload).digest("hex")}`,
    );
    const yesnoPayload = JSON.stringify({
      v: 1,
      kind: "yesno",
      question: "The order is confirmed",
      options: [],
      snapshotHash: HASH,
      decider: "jev",
      model: "jev-1.14.0",
    });
    expect(key(yesno)).toBe(
      `sha256:${createHash("sha256").update(yesnoPayload).digest("hex")}`,
    );
  });

  it("does not depend on option order but does depend on level order", () => {
    const reordered: ChoiceQuestion = {
      ...choice,
      options: [...choice.options].reverse(),
    };
    expect(key(reordered)).toBe(key(choice));
    expect(key({ ...score, levels: ["good", "partial", "broken"] })).not.toBe(
      key(score),
    );
  });

  it("changes when a choice label changes", () => {
    const relabelled: ChoiceQuestion = {
      ...choice,
      options: [
        { id: "pay", label: "Pay now" },
        { id: "back", label: "Back" },
      ],
    };
    expect(key(relabelled)).not.toBe(key(choice));
  });

  it("changes with the snapshot, decider, model, kind and criteria", () => {
    const base = key(yesno);
    expect(key(yesno, { snapshotHash: OTHER_HASH })).not.toBe(base);
    expect(key(yesno, { deciderId: "kev" })).not.toBe(base);
    expect(key(yesno, { model: "jev-1.15.0" })).not.toBe(base);
    expect(key({ ...yesno, criteria: "a number is shown" })).not.toBe(base);
    expect(
      key({
        kind: "choice",
        prompt: yesno.prompt,
        options: [{ id: "yes", label: "yes" }],
      }),
    ).not.toBe(base);
  });

  it("is the same for whitespace-only differences in the prompt", () => {
    expect(key({ kind: "yesno", prompt: "The order is confirmed" })).toBe(
      key(yesno),
    );
  });

  it("redacts the prompt with the given rules before hashing", () => {
    const a = decisionKey({
      question: { kind: "yesno", prompt: "Account ACCT-1 is open" },
      snapshotHash: HASH,
      deciderId: "jev",
      model: "jev-1.14.0",
      redact: [/ACCT-\d+/],
    });
    const b = decisionKey({
      question: { kind: "yesno", prompt: "Account ACCT-2 is open" },
      snapshotHash: HASH,
      deciderId: "jev",
      model: "jev-1.14.0",
      redact: [/ACCT-\d+/],
    });
    expect(a).toBe(b);
  });

  it("rejects a malformed snapshot hash, decider or model", () => {
    expect(() => key(yesno, { snapshotHash: "sha256:abc" })).toThrow(
      CacheError,
    );
    expect(() => key(yesno, { deciderId: " " })).toThrow(CacheError);
    expect(() => key(yesno, { model: "" })).toThrow(CacheError);
  });

  it("rejects an invalid question", () => {
    expect(() => key({ kind: "yesno", prompt: " " })).toThrow(QuestionError);
  });
});
