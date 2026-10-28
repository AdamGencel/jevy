import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlDecisionStore, resolveDecision } from "@jevyjs/core";
import type { DecisionRecord } from "@jevyjs/core";
import { run } from "./cli.js";
import { readPackageVersion } from "./version.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("jevy", () => {
  it("reads the version from package.json", () => {
    const version = readPackageVersion(
      new URL("../package.json", import.meta.url),
    );
    expect(version).toBe("0.0.1");
  });

  it("prints that version", async () => {
    expect(await run(["--version"], "0.0.1")).toEqual({
      code: 0,
      stdout: "0.0.1\n",
      stderr: "",
    });
  });

  it("prints cache usage when given no arguments", async () => {
    const result = await run([], "0.0.1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("jevy 0.0.1");
    expect(result.stdout).toContain("jevy cache stats");
    expect(result.stdout).toContain("jevy cache prune --days");
    expect(result.stdout).toContain("--not-referenced");
    expect(result.stdout).toContain("not implemented yet");
    expect(result.stderr).toBe("");
  });

  it("rejects product commands until they exist", async () => {
    const result = await run(["record", "sign up"], "0.0.1");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("jevy: unknown command 'record'\n");
  });

  it("reports cache stats and prunes unused decisions", async () => {
    const dir = await tempDir();
    const empty = await run(["cache", "stats", "--dir", dir], "0.0.1");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("records: 0");
    expect(empty.stdout).toContain("acceptance overall: n/a");

    const store = new JsonlDecisionStore(dir);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: {
        kind: "yesno",
        prompt: "The page shows the order as confirmed",
      },
      state: { snapshot: { role: "WebArea", name: "Checkout" } },
      decider: {
        id: "fake",
        model: "fake-1",
        decide(_state, questions) {
          const answers: Record<string, { value: string; confidence: number }> =
            {};
          for (const name of Object.keys(questions)) {
            answers[name] = { value: "yes", confidence: 0.2 };
          }
          return Promise.resolve(answers);
        },
      },
      mode: "record",
      store,
      now: () => old,
    });
    await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#2",
      question: { kind: "yesno", prompt: "The receipt is visible" },
      state: { snapshot: { role: "WebArea", name: "Checkout" } },
      decider: {
        id: "fake",
        model: "fake-1",
        decide(_state, questions) {
          const answers: Record<string, { value: string; confidence: number }> =
            {};
          for (const name of Object.keys(questions)) {
            answers[name] = { value: "yes", confidence: 0.95 };
          }
          return Promise.resolve(answers);
        },
      },
      mode: "record",
      store,
    });

    const stats = await run(["cache", "stats", "--dir", dir], "0.0.1");
    expect(stats.code).toBe(0);
    expect(stats.stdout).toContain("records: 2");
    expect(stats.stdout).toContain("verdict needs-review: 1");
    expect(stats.stdout).toContain("decider fake: 2");
    expect(stats.stdout).toContain(
      "acceptance tests/checkout.spec.ts toSatisfy#1: 0/1",
    );

    const pruned = await run(
      ["cache", "prune", "--days", "30", "--dir", dir],
      "0.0.1",
    );
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain("kept: 1");
    expect(pruned.stdout).toContain("dropped unused: 1");
    const after = await run(["cache", "stats", "--dir", dir], "0.0.1");
    expect(after.stdout).toContain("records: 1");

    const listed = await store.list();
    const kept = listed[0];
    if (kept === undefined) throw new Error("expected one record");
    const extra = otherKey(kept);
    await store.put(extra);
    const unreferenced = await run(
      ["cache", "prune", "--not-referenced", "--dir", dir],
      "0.0.1",
    );
    expect(unreferenced.code).toBe(0);
    expect(unreferenced.stdout).toContain("kept: 1");
    const remaining = await store.list();
    expect(remaining.map((record) => record.key)).toEqual([kept.key]);

    const usage = await run(
      ["cache", "prune", "--days", "1", "--not-referenced", "--dir", dir],
      "0.0.1",
    );
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain("exactly one");
    const missing = await run(["cache"], "0.0.1");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("jevy cache stats");
  });
});

function otherKey(record: DecisionRecord): DecisionRecord {
  return {
    ...record,
    key: "sha256:" + "cd".repeat(32),
    step: "toSatisfy#extra",
    question: "An extra cached question",
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jevy-cli-"));
  directories.push(dir);
  return dir;
}
