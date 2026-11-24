import { describe, expect, it } from "vitest";
import { within } from "./deadline.js";

function never(): Promise<never> {
  return new Promise(() => undefined);
}

describe("within", () => {
  it("gives the value of work that finishes in time", async () => {
    expect(await within(5000, () => Promise.resolve(7))).toEqual({
      inTime: true,
      value: 7,
    });
  });

  it("answers when the time is up, although the work never settles", async () => {
    const started = Date.now();
    expect(await within(30, never)).toEqual({ inTime: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("aborts the signal it gave the work when the time is up", async () => {
    let seen: AbortSignal | undefined;
    const raced = await within(30, (signal) => {
      seen = signal;
      return never();
    });
    expect(raced.inTime).toBe(false);
    expect(seen?.aborted).toBe(true);
  });

  it("does not abort work that finished in time", async () => {
    let seen: AbortSignal | undefined;
    await within(5000, (signal) => {
      seen = signal;
      return Promise.resolve();
    });
    expect(seen?.aborted).toBe(false);
  });

  it("rejects when the work fails in time", async () => {
    await expect(
      within(5000, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(
      within(5000, () => {
        throw new Error("at once");
      }),
    ).rejects.toThrow("at once");
  });

  it("swallows a failure that comes after the time is up", async () => {
    const raced = await within(
      20,
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("late"));
          }, 60);
        }),
    );
    expect(raced).toEqual({ inTime: false });
    // Long enough for the late rejection; an unhandled one fails the run.
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
});
