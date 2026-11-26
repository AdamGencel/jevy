import { describe, expect, it } from "vitest";
import type { Answer, Decider, DecisionState, Question } from "./decider.js";
import { callDecider, prepareDecisionState } from "./prepare.js";
import { RedactionError, SnapshotError } from "./errors.js";
import { REDACTED } from "./redact.js";

const SNAPSHOT = { role: "main", name: "Reset your password" } as const;

describe("the page's own url", () => {
  it("drops the query string, the fragment and credentials before it is sent", () => {
    const prepared = prepareDecisionState({
      snapshot: SNAPSHOT,
      url: "https://ada:hunter2@shop.example/reset?token=abc123&step=2#done",
    });
    expect(prepared.url).toBe("https://shop.example/reset");
  });

  it("still redacts what is left with the text rules", () => {
    const prepared = prepareDecisionState(
      { snapshot: SNAPSHOT, url: "/orders/ORDER-4242/receipt?print=1" },
      { redact: [/ORDER-\d+/] },
    );
    expect(prepared.url).toBe(`/orders/${REDACTED}/receipt`);
  });

  it("keeps a script url to its scheme", () => {
    const prepared = prepareDecisionState({
      snapshot: SNAPSHOT,
      url: "javascript:alert('sk_live_abc123XYZ')",
    });
    expect(prepared.url).toBe("javascript:");
  });

  it("reaches the decider reduced", async () => {
    const seen: DecisionState[] = [];
    const decider: Decider = {
      id: "test",
      model: "test-1",
      decide(state, questions) {
        seen.push(state);
        const answers: Record<string, Answer> = {};
        for (const name of Object.keys(questions)) {
          answers[name] = { value: "yes", confidence: 1 };
        }
        return Promise.resolve(answers);
      },
    };
    const questions: Record<string, Question> = {
      shown: { kind: "yesno", prompt: "Is the reset form shown?" },
    };
    await callDecider(
      decider,
      {
        snapshot: SNAPSHOT,
        url: "https://shop.example/reset?email=ada@example.com#top",
      },
      questions,
    );
    expect(seen[0]?.url).toBe("https://shop.example/reset");
  });
});

describe("text that cannot be redacted", () => {
  const counting = (): Decider & { calls: number } => {
    const decider = {
      id: "test",
      model: "test-1",
      calls: 0,
      decide(
        _state: DecisionState,
        questions: Readonly<Record<string, Question>>,
      ) {
        decider.calls += 1;
        const answers: Record<string, Answer> = {};
        for (const name of Object.keys(questions)) {
          answers[name] = { value: "yes", confidence: 1 };
        }
        return Promise.resolve(answers);
      },
    };
    return decider;
  };

  it("refuses a question name redaction would change, before any call", async () => {
    const decider = counting();
    const error = await callDecider(
      decider,
      { snapshot: SNAPSHOT },
      {
        "does alice@example.com see the card": {
          kind: "yesno",
          prompt: "Is it shown?",
        },
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedactionError);
    expect(String(error)).not.toContain("alice@example.com");
    expect(decider.calls).toBe(0);
  });

  it("refuses a question name a custom rule matches", async () => {
    const decider = counting();
    await expect(
      callDecider(
        decider,
        { snapshot: SNAPSHOT },
        { "order ORDER-4242 shown": { kind: "yesno", prompt: "Shown?" } },
        { redact: [/ORDER-\d+/] },
      ),
    ).rejects.toBeInstanceOf(RedactionError);
    expect(decider.calls).toBe(0);
  });

  it("accepts a plain question name, extra spaces included", async () => {
    const decider = counting();
    const { answers } = await callDecider(
      decider,
      { snapshot: SNAPSHOT },
      { "reset  form shown": { kind: "yesno", prompt: "Shown?" } },
    );
    expect(Object.keys(answers)).toEqual(["reset  form shown"]);
  });

  it("refuses a wallet field key redaction would change, before any call", async () => {
    const decider = counting();
    const error = await callDecider(
      decider,
      {
        snapshot: SNAPSHOT,
        wallet: { fields: { "alice@example.com": "x", to: "0xabc" } },
      },
      { shown: { kind: "yesno", prompt: "Shown?" } },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedactionError);
    expect(String(error)).not.toContain("alice@example.com");
    expect(decider.calls).toBe(0);
    expect(() =>
      prepareDecisionState({
        snapshot: SNAPSHOT,
        wallet: { fields: { "bob@example.org": "y" } },
      }),
    ).toThrow(RedactionError);
  });

  it("keeps a wallet field key that is plain", () => {
    const prepared = prepareDecisionState({
      snapshot: SNAPSHOT,
      wallet: { fields: { privateKey: "0xdeadbeef", to: "0xabc" } },
    });
    expect(Object.keys(prepared.wallet?.fields ?? {})).toEqual([
      "privateKey",
      "to",
    ]);
  });
});

describe("a malformed state", () => {
  it("refuses a url or a goal that is not a string with SnapshotError", () => {
    for (const bad of [5, null, {}, ["/a"]]) {
      expect(() =>
        prepareDecisionState({
          snapshot: SNAPSHOT,
          url: bad as unknown as string,
        }),
      ).toThrow(SnapshotError);
      expect(() =>
        prepareDecisionState({
          snapshot: SNAPSHOT,
          goal: bad as unknown as string,
        }),
      ).toThrow(SnapshotError);
    }
  });
});
