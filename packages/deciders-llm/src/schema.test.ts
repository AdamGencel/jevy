import { describe, expect, it } from "vitest";
import type { Question } from "@jevyjs/core";
import { abstainId, answerSchema, askedQuestions } from "./schema.js";

const YESNO: Question = { kind: "yesno", prompt: "Is the order confirmed?" };
const SCORE: Question = {
  kind: "score",
  prompt: "How clear is the error?",
  levels: ["unclear", "partly", "clear"],
};
const CHOICE: Question = {
  kind: "choice",
  prompt: "Which button pays?",
  options: [
    { id: "pay", label: "Pay now" },
    { id: "cancel", label: "Cancel" },
  ],
};

describe("abstainId", () => {
  it("is inconclusive for yes/no and score, and none for a choice", () => {
    expect(abstainId(YESNO)).toBe("inconclusive");
    expect(abstainId(SCORE)).toBe("inconclusive");
    expect(abstainId(CHOICE)).toBe("none");
  });

  it("takes a numbered suffix when an option id already uses it", () => {
    const question: Question = {
      kind: "choice",
      prompt: "Which plan?",
      options: [
        { id: "none", label: "No plan" },
        { id: "none-1", label: "Still no plan" },
        { id: "basic", label: "Basic" },
      ],
    };
    expect(abstainId(question)).toBe("none-2");
  });

  it("takes a numbered suffix when a score level already uses it", () => {
    const question: Question = {
      kind: "score",
      prompt: "How sure is the page?",
      levels: ["inconclusive", "certain"],
    };
    expect(abstainId(question)).toBe("inconclusive-1");
  });
});

describe("answerSchema", () => {
  it("has one required object per question with a closed enum and a confidence", () => {
    const schema = answerSchema({ confirmed: YESNO, clarity: SCORE });
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["clarity", "confirmed"],
      properties: {
        clarity: {
          type: "object",
          additionalProperties: false,
          required: ["value", "confidence"],
          properties: {
            value: {
              type: "string",
              enum: ["unclear", "partly", "clear", "inconclusive"],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        confirmed: {
          type: "object",
          additionalProperties: false,
          required: ["value", "confidence"],
          properties: {
            value: { type: "string", enum: ["yes", "no", "inconclusive"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    });
  });

  it("offers abstain on every kind of question", () => {
    const schema = answerSchema({ a: YESNO, b: SCORE, c: CHOICE });
    const json = JSON.stringify(schema);
    expect(json).toContain('["yes","no","inconclusive"]');
    expect(json).toContain('["unclear","partly","clear","inconclusive"]');
    expect(json).toContain('["pay","cancel","none"]');
  });

  it("keeps a question named like a prototype member as an own property", () => {
    const questions: Record<string, Question> = {};
    Object.defineProperty(questions, "__proto__", {
      value: YESNO,
      enumerable: true,
    });
    const schema = answerSchema(questions);
    expect(JSON.parse(JSON.stringify(schema))).toMatchObject({
      required: ["__proto__"],
    });
    expect(Object.keys(Reflect.get(schema, "properties") as object)).toEqual([
      "__proto__",
    ]);
  });

  it("refuses an invalid question before building anything", () => {
    expect(() =>
      answerSchema({ q: { kind: "choice", prompt: "Which?", options: [] } }),
    ).toThrow(/1 to 255 options/);
  });
});

describe("askedQuestions", () => {
  it("orders the questions by name, by code unit", () => {
    const asked = askedQuestions({ b: YESNO, B: YESNO, a: CHOICE });
    expect(asked.map((item) => item.name)).toEqual(["B", "a", "b"]);
    expect(asked[1]?.values).toEqual(["pay", "cancel"]);
    expect(asked[1]?.abstain).toBe("none");
  });
});
