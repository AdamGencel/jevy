import { describe, expect, it } from "vitest";
import type { Question } from "@jevyjs/core";
import { readReply } from "./reply.js";
import { askedQuestions } from "./schema.js";

const QUESTIONS: Record<string, Question> = {
  confirmed: { kind: "yesno", prompt: "Is the order confirmed?" },
  button: {
    kind: "choice",
    prompt: "Which button pays?",
    options: [
      { id: "pay", label: "Pay now" },
      { id: "none", label: "No button" },
    ],
  },
};
const ASKED = askedQuestions(QUESTIONS);

function read(reply: unknown): ReturnType<typeof readReply> {
  return readReply(reply, ASKED);
}

const GOOD = {
  confirmed: { value: "yes", confidence: 0.9 },
  button: { value: "pay", confidence: 1 },
};

describe("readReply", () => {
  it("maps a valid reply to answers", () => {
    expect(read(GOOD)).toEqual({
      ok: true,
      answers: {
        button: { value: "pay", confidence: 1 },
        confirmed: { value: "yes", confidence: 0.9 },
      },
    });
  });

  it("maps the abstain id to an abstention, apart from a real option of the same name", () => {
    const result = read({
      confirmed: { value: "inconclusive", confidence: 0.4 },
      button: { value: "none-1", confidence: 0.7 },
    });
    expect(result).toEqual({
      ok: true,
      answers: {
        button: { value: "none", confidence: 0.7, abstained: true },
        confirmed: { value: "inconclusive", confidence: 0.4, abstained: true },
      },
    });
    const real = read({ ...GOOD, button: { value: "none", confidence: 1 } });
    expect(real).toEqual({
      ok: true,
      answers: {
        button: { value: "none", confidence: 1 },
        confirmed: { value: "yes", confidence: 0.9 },
      },
    });
  });

  const invalid: readonly [string, unknown, RegExp][] = [
    ["null", null, /not a JSON object/],
    ["an array", [GOOD], /not a JSON object/],
    ["a JSON string", JSON.stringify(GOOD), /not a JSON object/],
    ["a class instance", new Map(), /not a JSON object/],
    [
      "a missing answer",
      { confirmed: GOOD.confirmed },
      /no answer to "button"/,
    ],
    [
      "an object whose prototype holds an answer",
      Object.assign(Object.create({ button: GOOD.button }) as object, {
        confirmed: GOOD.confirmed,
      }),
      /not a JSON object/,
    ],
    [
      "an extra answer",
      { ...GOOD, other: { value: "yes", confidence: 1 } },
      /answer to a question that was not asked/,
    ],
    [
      "an answer that is not an object",
      { ...GOOD, confirmed: "yes" },
      /answer to "confirmed" is not a JSON object/,
    ],
    [
      "an extra field",
      { ...GOOD, confirmed: { value: "yes", confidence: 1, why: "shown" } },
      /answer to "confirmed" has fields other than value and confidence/,
    ],
    [
      "a value outside the enum",
      { ...GOOD, confirmed: { value: "maybe", confidence: 1 } },
      /value of "confirmed" is not one of the allowed values/,
    ],
    [
      "a value of the wrong case",
      { ...GOOD, confirmed: { value: "Yes", confidence: 1 } },
      /value of "confirmed" is not one of the allowed values/,
    ],
    [
      "a missing confidence",
      { ...GOOD, confirmed: { value: "yes" } },
      /confidence of "confirmed" is not a finite number from 0 to 1/,
    ],
    [
      "a confidence as a string",
      { ...GOOD, confirmed: { value: "yes", confidence: "0.9" } },
      /confidence of "confirmed"/,
    ],
    [
      "a confidence above 1",
      { ...GOOD, confirmed: { value: "yes", confidence: 1.01 } },
      /confidence of "confirmed"/,
    ],
    [
      "a negative confidence",
      { ...GOOD, confirmed: { value: "yes", confidence: -0.1 } },
      /confidence of "confirmed"/,
    ],
    [
      "a NaN confidence",
      { ...GOOD, confirmed: { value: "yes", confidence: Number.NaN } },
      /confidence of "confirmed"/,
    ],
  ];

  for (const [label, reply, problem] of invalid) {
    it(`refuses ${label}`, () => {
      const result = read(reply);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toMatch(problem);
    });
  }

  it("does not find an answer on Object.prototype", () => {
    const shown: Question = { kind: "yesno", prompt: "Shown?" };
    const questions: Record<string, Question> = { toString: shown };
    const asked = askedQuestions(questions);
    const result = readReply({}, asked);
    expect(result).toEqual({
      ok: false,
      problem: 'the reply has no answer to "toString"',
    });
  });

  it("never repeats the reply in the problem", () => {
    const secret = "sk_live_abc123XYZ";
    const replies: unknown[] = [
      { ...GOOD, [secret]: { value: "yes", confidence: 1 } },
      { ...GOOD, confirmed: { value: secret, confidence: 1 } },
      { ...GOOD, confirmed: { value: "yes", confidence: secret } },
      { ...GOOD, confirmed: { value: "yes", confidence: 1, [secret]: 1 } },
      secret,
    ];
    for (const reply of replies) {
      const result = read(reply);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).not.toContain(secret);
    }
  });

  it("treats a getter that throws as an invalid reply, not a crash", () => {
    const reply = {
      button: GOOD.button,
      get confirmed(): unknown {
        throw new Error("boom sk_live_abc123XYZ");
      },
    };
    const result = read(reply);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).not.toContain("sk_live");
  });
});
