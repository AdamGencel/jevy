import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DeciderError,
  QuestionError,
  RedactionError,
  SnapshotError,
  callDecider,
  gateAnswer,
} from "@jevyjs/core";
import type { DecisionState, LlmAdapter, Question } from "@jevyjs/core";
import { MAX_ATTEMPTS, llmDecider, llmDeciderId } from "./llm.js";

const STATE: DecisionState = {
  snapshot: { role: "main", name: "Order 12 confirmed" },
};
const YESNO: Question = { kind: "yesno", prompt: "Is the order confirmed?" };
const SECRET = "sk_live_abc123XYZ";

interface Call {
  readonly prompt: string;
  readonly schema: object;
}

/** An adapter that plays back one scripted step per call. */
function scripted(
  steps: readonly (() => Promise<unknown>)[],
): LlmAdapter & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    complete(prompt, schema) {
      calls.push({ prompt, schema });
      const step = steps[calls.length - 1];
      if (step === undefined) throw new Error("no scripted step left");
      return step();
    },
  };
}

const reply = (value: unknown) => () => Promise.resolve(value);
const fails = (message: string) => () => Promise.reject(new Error(message));
const hangs = () => () => new Promise<never>(() => undefined);

describe("llmDeciderId", () => {
  it("is llm: and the model, as §5.1 documents", () => {
    expect(llmDeciderId("provider/model-id")).toBe("llm:provider/model-id");
  });

  it("refuses an empty model", () => {
    expect(() => llmDeciderId(" ")).toThrow(ConfigError);
  });
});

describe("llmDecider", () => {
  it("has the llm id and the pinned model", () => {
    const decider = llmDecider({ adapter: scripted([]), model: "acme/m-1" });
    expect(decider.id).toBe("llm:acme/m-1");
    expect(decider.model).toBe("acme/m-1");
  });

  it("passes the prompt and the schema to the adapter and maps the reply", async () => {
    const adapter = scripted([
      reply({ confirmed: { value: "yes", confidence: 0.9 } }),
    ]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    const answers = await decider.decide(STATE, { confirmed: YESNO });
    expect(answers).toEqual({ confirmed: { value: "yes", confidence: 0.9 } });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.prompt).toContain('- main "Order 12 confirmed"');
    expect(JSON.stringify(adapter.calls[0]?.schema)).toContain(
      '"enum":["yes","no","inconclusive"]',
    );
  });

  it("maps abstain on every kind to abstained, which gates to needs-review", async () => {
    const questions: Record<string, Question> = {
      a: YESNO,
      b: { kind: "score", prompt: "How clear?", levels: ["low", "high"] },
      c: {
        kind: "choice",
        prompt: "Which?",
        options: [{ id: "pay", label: "Pay" }],
      },
    };
    const adapter = scripted([
      reply({
        a: { value: "inconclusive", confidence: 0.95 },
        b: { value: "inconclusive", confidence: 0.95 },
        c: { value: "none", confidence: 0.95 },
      }),
    ]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    const { answers } = await callDecider(decider, STATE, questions);
    for (const name of ["a", "b", "c"]) {
      const answer = answers[name];
      const question = questions[name];
      expect(answer?.abstained).toBe(true);
      if (answer === undefined || question === undefined) return;
      expect(gateAnswer(question, answer)).toBe("needs-review");
    }
  });

  it("asks again after a thrown call and uses the second reply", async () => {
    const adapter = scripted([
      fails("socket reset"),
      reply({ confirmed: { value: "no", confidence: 0.85 } }),
    ]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    const { answers } = await callDecider(decider, STATE, {
      confirmed: YESNO,
    });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.prompt).toBe(adapter.calls[0]?.prompt);
    expect(answers["confirmed"]).toEqual({ value: "no", confidence: 0.85 });
  });

  it("asks again after a synchronous throw", async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      complete() {
        calls += 1;
        if (calls === 1) throw new TypeError("not a promise");
        return Promise.resolve({ confirmed: { value: "yes", confidence: 1 } });
      },
    };
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    await expect(decider.decide(STATE, { confirmed: YESNO })).resolves.toEqual({
      confirmed: { value: "yes", confidence: 1 },
    });
    expect(calls).toBe(2);
  });

  it("rejects with DeciderError after the attempts run out on invalid replies", async () => {
    const bad = { confirmed: { value: "maybe", confidence: 1 } };
    const adapter = scripted([reply(bad), reply(bad), reply(bad)]);
    const decider = llmDecider({ adapter, model: "acme/m-1", attempts: 3 });
    const error = await decider
      .decide(STATE, { confirmed: YESNO })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeciderError);
    expect(adapter.calls).toHaveLength(3);
    expect(String(error)).toMatch(/llm:acme\/m-1/);
    expect(String(error)).toMatch(/3 attempts/);
    expect(String(error)).toMatch(/not one of the allowed values/);
  });

  it("accepts up to MAX_ATTEMPTS, and lists only the first few in the message", async () => {
    expect(MAX_ATTEMPTS).toBe(10);
    const bad = { confirmed: { value: "maybe", confidence: 1 } };
    const adapter = scripted(
      Array.from({ length: MAX_ATTEMPTS }, () => reply(bad)),
    );
    const decider = llmDecider({
      adapter,
      model: "acme/m-1",
      attempts: MAX_ATTEMPTS,
    });
    const error = await decider
      .decide(STATE, { confirmed: YESNO })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeciderError);
    expect(adapter.calls).toHaveLength(MAX_ATTEMPTS);
    const message = String(error);
    expect(message).toMatch(/after 10 attempts/);
    expect(message).toMatch(/attempt 3: /);
    expect(message).not.toMatch(/attempt 4: /);
    expect(message).toMatch(/and 7 more/);
  });

  it("defaults to two attempts", async () => {
    const adapter = scripted([fails("a"), fails("b"), fails("c")]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    await expect(
      decider.decide(STATE, { confirmed: YESNO }),
    ).rejects.toBeInstanceOf(DeciderError);
    expect(adapter.calls).toHaveLength(2);
  });

  it("keeps the prompt, the reply and the adapter's error text out of the message", async () => {
    const page: DecisionState = {
      snapshot: { role: "main", name: "Welcome back, Ada Lovelace" },
    };
    const adapter = scripted([
      fails(`401 for key ${SECRET}`),
      reply({ confirmed: { value: `yes ${SECRET}`, confidence: 1 } }),
    ]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    const error = await decider
      .decide(page, { confirmed: YESNO })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeciderError);
    const text =
      error instanceof Error ? `${error.message}${error.stack ?? ""}` : "";
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Ada Lovelace");
    expect(text).not.toContain("Is the order confirmed?");
    expect(Object.keys(error as object)).not.toContain("cause");
    expect(text).toMatch(/the adapter threw an Error/);
  });

  it("still rejects with DeciderError when the thrown value is hostile", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "constructor", {
      get() {
        throw new Error("boom");
      },
    });
    const rejectHostile = () => Promise.reject(hostile);
    const adapter = scripted([rejectHostile, rejectHostile]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    await expect(
      decider.decide(STATE, { confirmed: YESNO }),
    ).rejects.toBeInstanceOf(DeciderError);
  });

  it("bounds each attempt by timeoutMs, so a hung adapter cannot hang the test", async () => {
    const adapter = scripted([hangs(), hangs()]);
    const decider = llmDecider({ adapter, model: "acme/m-1", timeoutMs: 20 });
    const started = Date.now();
    const error = await decider
      .decide(STATE, { confirmed: YESNO })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeciderError);
    expect(String(error)).toMatch(/did not answer within 20 ms/);
    expect(adapter.calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not leave an unhandled rejection when a timed-out call fails later", async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    const adapter = scripted([
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLate = reject;
        }),
      reply({ confirmed: { value: "yes", confidence: 1 } }),
    ]);
    const decider = llmDecider({ adapter, model: "acme/m-1", timeoutMs: 10 });
    await expect(decider.decide(STATE, { confirmed: YESNO })).resolves.toEqual({
      confirmed: { value: "yes", confidence: 1 },
    });
    rejectLate(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("refuses invalid questions and snapshots before any call", async () => {
    const adapter = scripted([]);
    const decider = llmDecider({ adapter, model: "acme/m-1" });
    await expect(decider.decide(STATE, {})).rejects.toBeInstanceOf(
      QuestionError,
    );
    await expect(
      decider.decide({ snapshot: { role: "" } }, { confirmed: YESNO }),
    ).rejects.toBeInstanceOf(SnapshotError);
    expect(adapter.calls).toHaveLength(0);
  });

  it("never shows the model a question name or wallet key that holds personal data", async () => {
    for (const [state, questions] of [
      [STATE, { "does alice@example.com see it": YESNO }],
      [
        { ...STATE, wallet: { fields: { "alice@example.com": "x" } } },
        { confirmed: YESNO },
      ],
    ] as const) {
      const adapter = scripted([]);
      const decider = llmDecider({ adapter, model: "acme/m-1" });
      const error = await callDecider(decider, state, questions).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RedactionError);
      expect(String(error)).not.toContain("alice@example.com");
      expect(adapter.calls).toHaveLength(0);
    }
  });

  it("refuses options it cannot honour", () => {
    const adapter = scripted([]);
    const model = "acme/m-1";
    const bad: readonly Record<string, unknown>[] = [
      { attempts: 0 },
      { attempts: 1.5 },
      { attempts: Number.POSITIVE_INFINITY },
      { attempts: MAX_ATTEMPTS + 1 },
      { attempts: 1e15 },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { timeoutMs: 2 ** 31 },
      { model: "" },
      { adapter: {} },
    ];
    for (const extra of bad) {
      expect(() => llmDecider({ adapter, model, ...extra })).toThrow(
        ConfigError,
      );
    }
  });
});
