import { describe, expect, it } from "vitest";
import { DeciderTransportError } from "./errors.js";
import { redactSecrets, retryWithBackoff } from "./transport.js";

describe("retry", () => {
  it("backs off and then returns", async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await retryWithBackoff(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(
            new DeciderTransportError("down", { retryable: true }),
          );
        }
        return Promise.resolve("ok");
      },
      {
        attempts: 3,
        baseDelayMs: 200,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([200, 400]);
  });

  it("does not retry a final answer failure", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          return Promise.reject(
            new DeciderTransportError("refused", { retryable: false }),
          );
        },
        {
          attempts: 3,
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow(/refused/);
    expect(calls).toBe(1);
  });

  it("turns an aborted attempt into a timeout", async () => {
    await expect(
      retryWithBackoff(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
        { attempts: 1, timeoutMs: 5, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/Timed out/);
  });

  it("redacts secrets from text", () => {
    expect(
      redactSecrets("Bearer sk-live-secret failed", ["sk-live-secret"]),
    ).toBe("Bearer [REDACTED] failed");
  });
});
