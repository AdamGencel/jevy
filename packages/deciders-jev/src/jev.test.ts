import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABSTAIN_ID,
  DECIDER_CONTRACT_CASES,
  DeciderTransportError,
  MemoryDecisionStore,
  gateAnswer,
  openDecider,
  parseConfig,
  resolveDecision,
  type Question,
} from "@jevyjs/core";
import {
  TYPESAFE_PROVIDER_VERSION,
  jevDecider,
  providerBaseUrl,
} from "./jev.js";

const KEY = "ts-test-key-do-not-log";

describe("jev decider", () => {
  it("pins the TypeSafe AI SDK provider and stays private", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@ai-sdk/typesafe-ai"]).toBe(
      TYPESAFE_PROVIDER_VERSION,
    );
    expect(pkg.dependencies["ai"]).toBe("7.0.162");
  });

  it("maps allow-listed bases onto the provider /v1 prefix", () => {
    expect(providerBaseUrl("https://api.typesafe.ai")).toBe(
      "https://api.typesafe.ai/v1",
    );
    expect(providerBaseUrl("https://openrouter.ai/api")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(providerBaseUrl("https://ai-gateway.vercel.sh/typesafe")).toBe(
      "https://ai-gateway.vercel.sh/typesafe/v1",
    );
    expect(() => providerBaseUrl("https://jev.example/api")).toThrow(
      /allow-list/,
    );
    expect(() =>
      jevDecider({ model: "jev-latest", baseUrl: "https://api.typesafe.ai" }),
    ).toThrow(/moving alias/);
  });

  it("does not read the key or open a client until decide", async () => {
    let calls = 0;
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: {},
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("fetch should not run"));
      },
    });
    expect(calls).toBe(0);
    await expect(
      decider.decide(page(), {
        q: { kind: "yesno", prompt: "Shown?" },
      }),
    ).rejects.toThrow(/TYPESAFE_API_KEY is not set/);
    expect(calls).toBe(0);
  });

  it("ignores TYPESAFE_AI_API_KEY and TYPESAFE_AI_BASE_URL", async () => {
    let calls = 0;
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: {
        TYPESAFE_AI_API_KEY: KEY,
        TYPESAFE_AI_BASE_URL: "https://evil.example/v1",
      },
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("no"));
      },
    });
    await expect(decider.decide(page(), one())).rejects.toThrow(
      /TYPESAFE_API_KEY is not set/,
    );
    expect(calls).toBe(0);
  });

  it("posts directly to TypeSafe and keeps both signals", async () => {
    for (const item of DECIDER_CONTRACT_CASES) {
      const seen: {
        url: string;
        authorization: string | null;
        body: unknown;
      }[] = [];
      const decider = jevDecider({
        model: "jev-1.14.0",
        baseUrl: "https://api.typesafe.ai",
        env: { TYPESAFE_API_KEY: KEY },
        fetch: (input, init) => {
          seen.push({
            url: requestUrl(input),
            authorization: new Headers(init?.headers).get("authorization"),
            body: parseBody(init?.body),
          });
          return Promise.resolve(
            choiceResponse(item.picked, item.probabilities, item.confidence),
          );
        },
      });
      const answers = await decider.decide(page(), { q: item.question });
      const answer = answers["q"];
      expect(answer).toBeDefined();
      if (answer === undefined) return;
      expect(gateAnswer(item.question, answer)).toBe(item.verdict);
      expect(answer.probability).toBe(item.probabilities[item.picked] ?? 0);
      expect(answer.confidence).toBe(item.confidence ?? 0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(seen[0]?.body)).not.toContain(
        "TYPESAFE_AI_API_KEY",
      );
    }
  });

  it("uses the other allow-listed hosts without a proxy of our own", async () => {
    const urls: string[] = [];
    for (const baseUrl of [
      "https://openrouter.ai/api",
      "https://ai-gateway.vercel.sh/typesafe",
    ]) {
      const decider = jevDecider({
        model: "jev-1.14.0",
        baseUrl,
        env: { TYPESAFE_API_KEY: KEY },
        fetch: (input) => {
          urls.push(requestUrl(input));
          return Promise.resolve(
            choiceResponse("yes", { yes: 1, no: 0, [ABSTAIN_ID]: 0 }, 0.9),
          );
        },
      });
      await decider.decide(page(), one());
    }
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/systemone",
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    ]);
  });

  it("retries a server error, redacts the key, and does not pass", async () => {
    let calls = 0;
    const delays: number[] = [];
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: { TYPESAFE_API_KEY: KEY },
      attempts: 2,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            Response.json({ message: `refused ${KEY}` }, { status: 500 }),
          );
        }
        return Promise.resolve(
          choiceResponse("yes", { yes: 0.8, no: 0.1, [ABSTAIN_ID]: 0.1 }, 0.95),
        );
      },
    });
    const answers = await decider.decide(page(), one());
    expect(calls).toBe(2);
    expect(delays).toEqual([200]);
    expect(gateAnswer(one().q, answers["q"] ?? failAnswer())).toBe("pass");
    expect(JSON.stringify(answers)).not.toContain(KEY);
  });

  it("does not retry a refusal and never returns pass or fail", async () => {
    let calls = 0;
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: { TYPESAFE_API_KEY: KEY },
      attempts: 3,
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          Response.json({ message: `bad ${KEY}` }, { status: 401 }),
        );
      },
    });
    try {
      await decider.decide(page(), one());
      throw new Error("expected a transport error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DeciderTransportError);
      const transport = error as DeciderTransportError;
      expect(transport.retryable).toBe(false);
      expect(transport.message).not.toContain(KEY);
      expect(transport.message).not.toContain("bad");
    }
    expect(calls).toBe(1);
  });

  it("rejects an answer from a different model pin", async () => {
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: { TYPESAFE_API_KEY: KEY },
      attempts: 1,
      fetch: () =>
        Promise.resolve(
          choiceResponse(
            "yes",
            { yes: 1, no: 0, [ABSTAIN_ID]: 0 },
            1,
            "jev-1.13.0",
          ),
        ),
    });
    await expect(decider.decide(page(), one())).rejects.toThrow(/jev-1\.13\.0/);
  });

  it("replay does not construct a client or call fetch again", async () => {
    let fetches = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      fetches += 1;
      expect(requestUrl(input)).toBe("https://api.typesafe.ai/v1/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${KEY}`,
      );
      return Promise.resolve(
        choiceResponse(
          "yes",
          { yes: 0.8, no: 0.1, [ABSTAIN_ID]: 0.1 },
          0.93,
          "jev-1.14.0",
          questionNames(init?.body),
        ),
      );
    };
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      env: { TYPESAFE_API_KEY: KEY },
      fetch: fetchImpl,
    });
    const store = new MemoryDecisionStore();
    const question: Question = {
      kind: "yesno",
      prompt: "The page shows the order as confirmed",
    };
    const recorded = await resolveDecision({
      spec: "tests/page.spec.ts",
      step: "check",
      question,
      state: page(),
      decider,
      mode: "record",
      store,
    });
    expect(recorded.verdict).toBe("pass");
    expect(recorded.record?.decider).toBe("jev");
    expect(recorded.record?.model).toBe("jev-1.14.0");
    expect(recorded.record?.probability).not.toBe(recorded.record?.confidence);
    expect(fetches).toBe(1);

    let constructed = 0;
    const replay = await openDecider(
      parseConfig({ decider: "jev" }, { env: { CI: "true" } }),
      {
        mode: "replay",
        factories: {
          jev: () => {
            constructed += 1;
            return jevDecider({
              model: "jev-1.14.0",
              baseUrl: "https://api.typesafe.ai",
              env: { TYPESAFE_API_KEY: KEY },
              fetch: fetchImpl,
            });
          },
        },
      },
    );
    const again = await resolveDecision({
      spec: "tests/page.spec.ts",
      step: "check",
      question,
      state: page(),
      decider: replay,
      mode: "replay",
      store,
    });
    expect(again.source).toBe("cache");
    expect(again.verdict).toBe("pass");
    expect(fetches).toBe(1);
    expect(constructed).toBe(0);
  });
});

function page(): { snapshot: { role: string; name: string } } {
  return { snapshot: { role: "document", name: "Order confirmed" } };
}

function one(): { q: Question } {
  return { q: { kind: "yesno", prompt: "Shown?" } };
}

function failAnswer(): {
  value: string;
  confidence: number;
  probability: number;
} {
  return { value: "yes", confidence: 0, probability: 0 };
}

function choiceResponse(
  picked: string,
  probabilities: Readonly<Record<string, number>>,
  confidence: number | null,
  model = "jev-1.14.0",
  names: readonly string[] = ["q"],
): Response {
  const answers: Record<string, unknown> = {};
  for (const name of names) {
    answers[name] = {
      type: "choice",
      choice: picked,
      probabilities,
      ...(confidence === null ? {} : { confidence }),
    };
  }
  return Response.json({
    model,
    answers,
    usage: { input_tokens: 12, output_tokens: 2 },
  });
}

function questionNames(body: unknown): string[] {
  const questions = field(parseBody(body), "questions");
  if (
    typeof questions !== "object" ||
    questions === null ||
    Array.isArray(questions)
  ) {
    return ["q"];
  }
  return Object.keys(questions);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  return JSON.parse(body) as unknown;
}
