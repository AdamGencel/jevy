import { describe, expect, it } from "vitest";
import {
  ABSTAIN_ID,
  DECIDER_CONTRACT_CASES,
  DeciderTransportError,
  KEV_SNAPSHOT_TOKEN_BUDGET,
  callDecider,
  gateAnswer,
} from "@jevyjs/core";
import { KEV_REQUEST_MODEL, kevDecider } from "./kev.js";

const LOCAL_KEY = "kev-local-secret";

describe("kev decider", () => {
  it("uses the laptop pin on the cache identity and kev-latest on the wire", async () => {
    const bodies: unknown[] = [];
    const authorizations: Array<string | null> = [];
    const decider = kevDecider({
      model: "kev-4b@v1.0",
      baseUrl: "http://127.0.0.1:8009",
      fetch: (_input, init) => {
        bodies.push(parseBody(init?.body));
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          choiceResponse("yes", { yes: 1, no: 0, [ABSTAIN_ID]: 0 }, 0.9),
        );
      },
    });
    expect(decider.id).toBe("kev");
    expect(decider.model).toBe("kev-4b@v1.0");
    await decider.decide(page(), { q: { kind: "yesno", prompt: "Shown?" } });
    const body = bodies[0] as { model?: string };
    expect(body.model).toBe(KEV_REQUEST_MODEL);
    expect(authorizations).toEqual([null]);
  });

  it("matches the contract, including abstain and the no-flip rule", async () => {
    for (const item of DECIDER_CONTRACT_CASES) {
      const decider = kevDecider({
        model: "kev-4b@v1.0",
        baseUrl: "http://127.0.0.1:8009",
        fetch: () =>
          Promise.resolve(
            choiceResponse(item.picked, item.probabilities, item.confidence),
          ),
      });
      const answers = await decider.decide(page(), { q: item.question });
      const answer = answers["q"];
      expect(answer).toBeDefined();
      if (answer === undefined) return;
      expect(gateAnswer(item.question, answer)).toBe(item.verdict);
      expect(answer.confidence).toBe(item.confidence ?? 0);
      expect(answer.probability).toBe(item.probabilities[item.picked] ?? 0);
    }
  });

  it("says clearly when the local server is not running", async () => {
    let calls = 0;
    const decider = kevDecider({
      model: "kev-4b@v1.0",
      baseUrl: "http://127.0.0.1:8009",
      attempts: 2,
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls += 1;
        return Promise.reject(
          new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
        );
      },
    });
    try {
      await decider.decide(page(), { q: { kind: "yesno", prompt: "Shown?" } });
      throw new Error("expected a transport error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DeciderTransportError);
      const transport = error as DeciderTransportError;
      expect(transport.message).toContain("not running");
      expect(transport.message).toContain(
        "uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b@v1.0 --port 8009",
      );
      expect(transport.retryable).toBe(true);
    }
    expect(calls).toBe(2);
  });

  it("sends a local key only when KEV_API_KEY is set, and redacts it", async () => {
    const headers: Array<string | null> = [];
    const decider = kevDecider({
      model: "kev-0.8b@v1.0",
      baseUrl: "http://127.0.0.1:8009",
      env: { KEV_API_KEY: LOCAL_KEY },
      attempts: 1,
      fetch: (_input, init) => {
        headers.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          Response.json({ message: `leaked ${LOCAL_KEY}` }, { status: 500 }),
        );
      },
    });
    await expect(
      decider.decide(page(), { q: { kind: "yesno", prompt: "Shown?" } }),
    ).rejects.toThrow(DeciderTransportError);
    expect(headers).toEqual([`Bearer ${LOCAL_KEY}`]);
    try {
      await decider.decide(page(), { q: { kind: "yesno", prompt: "Shown?" } });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error)
        expect(error.message).not.toContain(LOCAL_KEY);
    }
  });

  it("refuses a snapshot over the 6000-token budget unless callDecider pruned it", async () => {
    const huge = "x".repeat((KEV_SNAPSHOT_TOKEN_BUDGET + 50) * 4);
    const decider = kevDecider({
      model: "kev-4b@v1.0",
      baseUrl: "http://127.0.0.1:8009",
      fetch: () =>
        Promise.resolve(
          choiceResponse("yes", { yes: 1, no: 0, [ABSTAIN_ID]: 0 }, 1),
        ),
    });
    await expect(
      decider.decide(
        { snapshot: { role: "document", name: huge } },
        { q: { kind: "yesno", prompt: "Shown?" } },
      ),
    ).rejects.toThrow(/6000/);
    const answers = await callDecider(
      decider,
      { snapshot: { role: "document", name: huge } },
      { q: { kind: "yesno", prompt: "Shown?" } },
      { deciderId: "kev" },
    );
    expect(answers["q"]?.value).toBe("yes");
  });
});

function page(): { snapshot: { role: string; name: string } } {
  return { snapshot: { role: "document", name: "Order" } };
}

function choiceResponse(
  picked: string,
  probabilities: Readonly<Record<string, number>>,
  confidence: number | null,
): Response {
  return Response.json({
    model: KEV_REQUEST_MODEL,
    answers: {
      q: {
        type: "choice",
        choice: picked,
        probabilities,
        ...(confidence === null ? {} : { confidence }),
      },
    },
  });
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  return JSON.parse(body) as unknown;
}
