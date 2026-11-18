import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlDecisionStore } from "./jsonl-store.js";
import type { DecisionRecord } from "./record.js";

// Count write calls while still writing for real. Kept in its own file so
// the module mock does not reach the other store tests.
const writes = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>) => {
      writes.count += 1;
      return actual.appendFile(...args);
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      writes.count += 1;
      return actual.writeFile(...args);
    },
  };
});

function makeRecord(key: string): DecisionRecord {
  return {
    v: 1,
    key,
    spec: "tests/checkout.spec.ts",
    step: "toSatisfy#1",
    kind: "yesno",
    question: "The order is confirmed",
    snapshotHash: `sha256:${"2".repeat(64)}`,
    decider: "jev",
    model: "jev-1.14.0",
    answer: "yes",
    confidence: 0.93,
    abstained: false,
    truncated: false,
    verdict: "pass",
    thresholds: { pass: 0.8, fail: 0.5 },
    rules: `sha256:${"3".repeat(64)}`,
    createdAt: "2026-10-27T22:00:00.000Z",
    reviewedBy: null,
    reviewVerdict: null,
  };
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevy-cache-write-"));
  writes.count = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonlDecisionStore writes", () => {
  it("writes one batch for one spec in a single call", async () => {
    const store = new JsonlDecisionStore({ dir });
    await store.append([
      makeRecord(`sha256:${"a".repeat(64)}`),
      makeRecord(`sha256:${"b".repeat(64)}`),
      makeRecord(`sha256:${"c".repeat(64)}`),
    ]);
    expect(writes.count).toBe(1);
    const text = await readFile(
      join(dir, "tests", "checkout.spec.ts.jsonl"),
      "utf8",
    );
    expect(text.split("\n")).toHaveLength(4);
    expect(text.endsWith("\n")).toBe(true);
  });
});
