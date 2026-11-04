import { describe, expect, it, vi } from "vitest";
import {
  ABSTAIN_ID,
  DECIDER_CONTRACT_CASES,
  DeciderTransportError,
  gateAnswer,
  type LlmAdapter,
} from "@jevyjs/core";
import type { LanguageModel } from "ai";
import { answerSchema, llmDecider } from "./llm.js";

const generateText = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<{ output: unknown }>>(
    () => Promise.resolve({ output: {} }),
  ),
);

vi.mock("ai", () => ({
  generateText,
  Output: {
    object: (options: unknown) => ({ mode: "object", options }),
  },
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
}));

describe("llm decider", () => {
  it("bounds every question, including inconclusive, and keeps the two signals", async () => {
    for (const item of DECIDER_CONTRACT_CASES) {
      const schemas: object[] = [];
      const adapter: LlmAdapter = {
        complete(_prompt, schema) {
          schemas.push(schema);
          return Promise.resolve({
            q: {
              value: item.picked,
              probability: item.probabilities[item.picked] ?? 0,
              confidence: item.confidence ?? 0,
            },
          });
        },
      };
      const decider = llmDecider({
        adapter,
        model: "example/mock-1",
        id: "llm:example/mock-1",
      });
      expect(decider.id).toBe("llm:example/mock-1");
      expect(decider.model).toBe("example/mock-1");
      const answers = await decider.decide(
        { snapshot: { role: "document", name: "Order confirmed" } },
        { q: item.question },
      );
      const answer = answers["q"];
      expect(answer).toBeDefined();
      if (answer === undefined) return;
      expect(gateAnswer(item.question, answer)).toBe(item.verdict);
      expect(answer.probability).not.toBeUndefined();
      const schema = schemas[0];
      expect(JSON.stringify(schema)).toContain(ABSTAIN_ID);
      expect(JSON.stringify(schema)).toContain('"enum"');
    }
  });

  it("retries a thrown transport error and redacts secrets", async () => {
    const secret = "llm-secret-value";
    let calls = 0;
    const delays: number[] = [];
    const adapter: LlmAdapter = {
      complete() {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(new Error(`socket ${secret}`));
        }
        return Promise.resolve({
          q: { value: "yes", probability: 0.4, confidence: 0.92 },
        });
      },
    };
    const decider = llmDecider({
      adapter,
      model: "example/mock-1",
      attempts: 3,
      secrets: [secret],
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const answers = await decider.decide(
      { snapshot: { role: "document", name: "Hi" } },
      { q: { kind: "yesno", prompt: "Greeting?" } },
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([200, 400]);
    expect(answers["q"]?.confidence).toBe(0.92);
    expect(answers["q"]?.probability).toBe(0.4);
    expect(
      gateAnswer(
        { kind: "yesno", prompt: "Greeting?" },
        answers["q"] ?? { value: "yes", confidence: 0 },
      ),
    ).toBe("pass");
  });

  it("does not turn a bad payload into pass or fail", async () => {
    const decider = llmDecider({
      adapter: {
        complete: () =>
          Promise.resolve({
            q: { value: "maybe", probability: 1, confidence: 1 },
          }),
      },
      model: "example/mock-1",
      attempts: 2,
      sleep: () => Promise.resolve(),
    });
    await expect(
      decider.decide(
        { snapshot: { role: "document", name: "Hi" } },
        { q: { kind: "yesno", prompt: "Greeting?" } },
      ),
    ).rejects.toBeInstanceOf(DeciderTransportError);
  });

  it("accepts an AI SDK language model and uses structured output", async () => {
    generateText.mockReset();
    generateText.mockResolvedValue({
      output: {
        q: { value: "pay", probability: 0.66, confidence: 0.9 },
      },
    });
    const decider = llmDecider({
      languageModel: fakeLanguageModel(),
      model: "mock/mock-1",
      id: "llm:mock/mock-1",
    });
    const answers = await decider.decide(
      { snapshot: { role: "document", name: "Pay now" } },
      {
        q: {
          kind: "choice",
          prompt: "Which control?",
          options: [
            { id: "pay", label: "Pay" },
            { id: "cancel", label: "Cancel" },
          ],
        },
      },
    );
    expect(answers["q"]?.value).toBe("pay");
    expect(answers["q"]?.probability).toBe(0.66);
    expect(answers["q"]?.confidence).toBe(0.9);
    expect(generateText).toHaveBeenCalledOnce();
    const call = generateText.mock.calls[0]?.[0];
    expect(readPath(call, ["maxRetries"])).toBe(0);
    expect(readPath(call, ["output", "mode"])).toBe("object");
    expect(
      readPath(call, [
        "output",
        "options",
        "schema",
        "jsonSchema",
        "properties",
        "q",
        "properties",
        "value",
        "enum",
      ]),
    ).toEqual(["pay", "cancel", ABSTAIN_ID]);
    const built = answerSchema({
      q: {
        question: {
          kind: "choice",
          prompt: "Which control?",
          options: [
            { id: "pay", label: "Pay" },
            { id: "cancel", label: "Cancel" },
          ],
        },
        instructions: "Which control?",
        options: [
          { id: "pay", label: "Pay", abstain: false },
          { id: "cancel", label: "Cancel", abstain: false },
          { id: ABSTAIN_ID, label: "Inconclusive", abstain: true },
        ],
      },
    });
    expect(JSON.stringify(built)).toContain(ABSTAIN_ID);
  });
});

function fakeLanguageModel(): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-1",
  } as LanguageModel;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
