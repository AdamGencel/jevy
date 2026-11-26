import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChoiceQuestion, Question } from "../decider.js";
import { CacheError, QuestionError } from "../errors.js";
import { redactText } from "../redact.js";
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

const SPEC = "tests/checkout.spec.ts";

function key(question: Question, overrides?: Partial<KeyParts>): string {
  return decisionKey({
    spec: overrides?.spec ?? SPEC,
    question,
    snapshotHash: overrides?.snapshotHash ?? HASH,
    deciderId: overrides?.deciderId ?? "jev",
    model: overrides?.model ?? "jev-1.14.0",
  });
}

interface KeyParts {
  readonly spec: string;
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
      v: 2,
      spec: SPEC,
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
    expect(DECISION_KEY_VERSION).toBe(2);
  });

  it("uses the levels in order for a score and no options for yes/no", () => {
    const scorePayload = JSON.stringify({
      v: 2,
      spec: SPEC,
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
      v: 2,
      spec: SPEC,
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

  it("changes with the spec, snapshot, decider, model, kind and criteria", () => {
    const base = key(yesno);
    expect(key(yesno, { spec: "tests/refund.spec.ts" })).not.toBe(base);
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
      spec: SPEC,
      question: { kind: "yesno", prompt: "Account ACCT-1 is open" },
      snapshotHash: HASH,
      deciderId: "jev",
      model: "jev-1.14.0",
      redact: [/ACCT-\d+/],
    });
    const b = decisionKey({
      spec: SPEC,
      question: { kind: "yesno", prompt: "Account ACCT-2 is open" },
      snapshotHash: HASH,
      deciderId: "jev",
      model: "jev-1.14.0",
      redact: [/ACCT-\d+/],
    });
    expect(a).toBe(b);
  });

  it("hashes the spec exactly as written, which is also what the record holds", () => {
    const redact = [/ACCT-\d+/];
    const payload = JSON.stringify({
      v: 2,
      spec: SPEC,
      kind: "yesno",
      question: "The order is confirmed",
      options: [],
      snapshotHash: HASH,
      decider: "jev",
      model: "jev-1.14.0",
    });
    expect(redactText(SPEC, redact)).toBe(SPEC);
    expect(
      decisionKey({
        spec: SPEC,
        question: yesno,
        snapshotHash: HASH,
        deciderId: "jev",
        model: "jev-1.14.0",
        redact,
      }),
    ).toBe(`sha256:${createHash("sha256").update(payload).digest("hex")}`);
  });

  // Two specs that redact or normalise to the same text would share a key:
  // one spec's reviewed pass would replay for the other.
  it.each([
    [
      "a built-in rule (email)",
      ["tests/alice@example.com.spec.ts", "tests/bob@example.org.spec.ts"],
      [],
      /built-in "email" redaction pattern/,
      ["alice", "bob"],
    ],
    [
      "a project rule",
      ["tests/ORDER-1.spec.ts", "tests/ORDER-2.spec.ts"],
      [/ORDER-\d+/],
      /project rule redact\[0\]/,
      ["ORDER-1", "ORDER-2"],
    ],
    [
      "whitespace collapsing",
      ["tests/a  b.spec.ts", "tests/a\tb.spec.ts"],
      [],
      /normalisation/,
      [],
    ],
    [
      "NFKC normalisation",
      ["tests/ﬁle.spec.ts", "tests/①.spec.ts"],
      [],
      /normalisation/,
      [],
    ],
  ] as const)(
    "refuses a spec that %s would change, naming the rule and not the secret",
    (_label, specs, redact, rule, secrets) => {
      for (const spec of specs) {
        let caught: unknown;
        try {
          decisionKey({
            spec,
            question: yesno,
            snapshotHash: HASH,
            deciderId: "jev",
            model: "jev-1.14.0",
            redact,
          });
        } catch (error: unknown) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(CacheError);
        const message = (caught as Error).message;
        expect(message).toMatch(rule);
        expect(message).toMatch(/rename the spec file/i);
        for (const secret of secrets) expect(message).not.toContain(secret);
      }
    },
  );

  it("rejects a malformed snapshot hash, decider or model", () => {
    expect(() => key(yesno, { snapshotHash: "sha256:abc" })).toThrow(
      CacheError,
    );
    expect(() => key(yesno, { deciderId: " " })).toThrow(CacheError);
    expect(() => key(yesno, { model: "" })).toThrow(CacheError);
  });

  it("rejects a spec that is not a non-empty string", () => {
    expect(() => key(yesno, { spec: " " })).toThrow(CacheError);
    expect(() => key(yesno, { spec: "" })).toThrow(CacheError);
  });

  it("rejects an invalid question", () => {
    expect(() => key({ kind: "yesno", prompt: " " })).toThrow(QuestionError);
  });
});
