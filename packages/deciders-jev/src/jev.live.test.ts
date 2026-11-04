import { describe, expect, it } from "vitest";
import { ABSTAIN_ID } from "@jevyjs/core";
import { jevDecider } from "./jev.js";

const apiKey = process.env["TYPESAFE_API_KEY"];
const live = typeof apiKey === "string" && apiKey.trim().length > 0;

/**
 * Optional smoke test. `pnpm test` does not run this file.
 * `pnpm test:live` runs it, and skips when TYPESAFE_API_KEY is unset.
 * The key is read by the decider at call time and is not printed here.
 */
describe.skipIf(!live)("jev live smoke", () => {
  it("asks TypeSafe directly and returns probability and confidence", async () => {
    const decider = jevDecider({
      model: "jev-1.14.0",
      baseUrl: "https://api.typesafe.ai",
      attempts: 2,
      timeoutMs: 30_000,
    });
    const answers = await decider.decide(
      { snapshot: { role: "document", name: "Order confirmed" } },
      {
        shown: {
          kind: "yesno",
          prompt: "Does the page say the order is confirmed?",
        },
      },
    );
    const answer = answers["shown"];
    expect(answer).toBeDefined();
    if (answer === undefined) return;
    expect(["yes", "no", ABSTAIN_ID]).toContain(answer.value);
    expect(answer.probability).toBeGreaterThanOrEqual(0);
    expect(answer.probability).toBeLessThanOrEqual(1);
    expect(answer.confidence).toBeGreaterThanOrEqual(0);
    expect(answer.confidence).toBeLessThanOrEqual(1);
    if (apiKey !== undefined) {
      expect(JSON.stringify(answer)).not.toContain(apiKey);
    }
  }, 70_000);
});
