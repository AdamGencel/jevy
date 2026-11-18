import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheError } from "../errors.js";
import { JsonlDecisionStore } from "./jsonl-store.js";
import { MemoryDecisionStore } from "./memory-store.js";
import { serialiseRecord } from "./record.js";
import type { DecisionRecord } from "./record.js";
import type { DecisionStore } from "./store.js";

function makeRecord(changes: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 1,
    key: `sha256:${"1".repeat(64)}`,
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
    ...changes,
  };
}

const KEY_A = `sha256:${"a".repeat(64)}`;
const KEY_B = `sha256:${"b".repeat(64)}`;

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevy-cache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const factories: readonly [string, () => DecisionStore][] = [
  ["MemoryDecisionStore", () => new MemoryDecisionStore()],
  ["JsonlDecisionStore", () => new JsonlDecisionStore({ dir })],
];

describe.each(factories)("%s", (_name, create) => {
  it("is empty to begin with", async () => {
    const store = create();
    expect(await store.latest(KEY_A)).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(
      await store.forStep("tests/checkout.spec.ts", "toSatisfy#1"),
    ).toEqual([]);
  });

  it("returns the last appended record for a key", async () => {
    const store = create();
    const first = makeRecord({ key: KEY_A, answer: "no" });
    const second = makeRecord({ key: KEY_A, answer: "yes" });
    await store.append([first]);
    await store.append([second, makeRecord({ key: KEY_B })]);
    expect(await store.latest(KEY_A)).toEqual(second);
    expect(await store.list()).toHaveLength(3);
  });

  it("lets the later record of one batch win", async () => {
    const store = create();
    const first = makeRecord({ key: KEY_A, answer: "no" });
    const second = makeRecord({ key: KEY_A, answer: "yes" });
    await store.append([first, second]);
    expect(await store.latest(KEY_A)).toEqual(second);
  });

  it("filters by step and by spec in append order", async () => {
    const store = create();
    const a1 = makeRecord({ key: KEY_A, step: "s1" });
    const a2 = makeRecord({ key: KEY_B, step: "s2" });
    const other = makeRecord({
      key: KEY_A,
      spec: "tests/other.spec.ts",
      step: "s1",
    });
    await store.append([a1, a2, other]);
    expect(await store.forStep("tests/checkout.spec.ts", "s1")).toEqual([a1]);
    expect(await store.list("tests/checkout.spec.ts")).toEqual([a1, a2]);
    expect(await store.list("tests/other.spec.ts")).toEqual([other]);
  });

  it("rejects an invalid record without storing any of the batch", async () => {
    const store = create();
    await expect(
      store.append([makeRecord(), makeRecord({ confidence: 7 })]),
    ).rejects.toThrow(CacheError);
    expect(await store.list()).toEqual([]);
  });

  it("does not let a caller mutate what was stored", async () => {
    const store = create();
    const records = [makeRecord({ key: KEY_A })];
    await store.append(records);
    records.length = 0;
    expect(await store.list()).toHaveLength(1);
  });
});

describe("JsonlDecisionStore", () => {
  it("round-trips records through a new store on the same directory", async () => {
    const records = [
      makeRecord({ key: KEY_A }),
      makeRecord({
        key: KEY_B,
        step: "toSatisfy#2",
        verdict: "needs-review",
        confidence: 0.6,
        reviewedBy: "adam",
        reviewVerdict: "fail",
      }),
    ];
    await new JsonlDecisionStore({ dir }).append(records);
    const reopened = new JsonlDecisionStore({ dir });
    expect(await reopened.list()).toEqual(records);
    expect(await reopened.latest(KEY_B)).toEqual(records[1]);
  });

  it("writes one newline-terminated line per record at <dir>/<spec>.jsonl", async () => {
    const records = [makeRecord({ key: KEY_A }), makeRecord({ key: KEY_B })];
    await new JsonlDecisionStore({ dir }).append(records);
    const text = await readFile(
      join(dir, "tests", "checkout.spec.ts.jsonl"),
      "utf8",
    );
    expect(text).toBe(records.map((r) => `${serialiseRecord(r)}\n`).join(""));
  });

  it("is byte-stable: the same records give the same file", async () => {
    const records = [makeRecord({ key: KEY_A }), makeRecord({ key: KEY_B })];
    const other = await mkdtemp(join(tmpdir(), "jevy-cache-"));
    try {
      await new JsonlDecisionStore({ dir }).append(records);
      await new JsonlDecisionStore({ dir: other }).append(records);
      const path = join("tests", "checkout.spec.ts.jsonl");
      expect(await readFile(join(dir, path))).toEqual(
        await readFile(join(other, path)),
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("keeps the last record for a key across reopening", async () => {
    await new JsonlDecisionStore({ dir }).append([
      makeRecord({ key: KEY_A, answer: "no" }),
    ]);
    await new JsonlDecisionStore({ dir }).append([
      makeRecord({ key: KEY_A, answer: "yes" }),
    ]);
    const latest = await new JsonlDecisionStore({ dir }).latest(KEY_A);
    expect(latest?.answer).toBe("yes");
  });

  it("gives each spec its own file", async () => {
    const store = new JsonlDecisionStore({ dir });
    await store.append([
      makeRecord({ key: KEY_A, spec: "a.spec.ts" }),
      makeRecord({ key: KEY_B, spec: "nested/b.spec.ts" }),
    ]);
    const a = await readFile(join(dir, "a.spec.ts.jsonl"), "utf8");
    const b = await readFile(join(dir, "nested", "b.spec.ts.jsonl"), "utf8");
    expect(a.trim().split("\n")).toHaveLength(1);
    expect(b.trim().split("\n")).toHaveLength(1);
    expect(a).toContain(KEY_A);
    expect(b).toContain(KEY_B);
    expect(await store.list("a.spec.ts")).toHaveLength(1);
  });

  it("reports a malformed line with the file path and 1-based line number", async () => {
    const file = join(dir, "broken.spec.ts.jsonl");
    await writeFile(
      file,
      `${serialiseRecord(makeRecord({ spec: "broken.spec.ts" }))}\n{"v":1,\n`,
    );
    const store = new JsonlDecisionStore({ dir });
    const error = await store.list().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CacheError);
    expect((error as Error).message).toContain(file);
    expect((error as Error).message).toContain(":2");
  });

  it("rejects a record filed under another spec's file", async () => {
    await writeFile(
      join(dir, "a.spec.ts.jsonl"),
      `${serialiseRecord(makeRecord({ spec: "b.spec.ts" }))}\n`,
    );
    await expect(new JsonlDecisionStore({ dir }).list()).rejects.toThrow(
      CacheError,
    );
  });

  it("reports a blank line in the middle of a file", async () => {
    const line = serialiseRecord(makeRecord({ spec: "a.spec.ts" }));
    await writeFile(join(dir, "a.spec.ts.jsonl"), `${line}\n\n${line}\n`);
    await expect(new JsonlDecisionStore({ dir }).list()).rejects.toThrow(
      /a\.spec\.ts\.jsonl:2/,
    );
  });

  it("accepts CRLF line endings and a missing final newline", async () => {
    const line = serialiseRecord(makeRecord({ spec: "a.spec.ts", key: KEY_A }));
    await writeFile(join(dir, "a.spec.ts.jsonl"), `${line}\r\n${line}`);
    const store = new JsonlDecisionStore({ dir });
    expect(await store.list()).toHaveLength(2);
    await store.append([makeRecord({ spec: "a.spec.ts", key: KEY_B })]);
    expect(await new JsonlDecisionStore({ dir }).list()).toHaveLength(3);
  });

  it("ignores files that are not .jsonl", async () => {
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "README.md"), "# not a cache\n");
    expect(await new JsonlDecisionStore({ dir }).list()).toEqual([]);
  });

  it("treats a missing directory as empty and creates it on append", async () => {
    const missing = join(dir, "does", "not", "exist");
    const store = new JsonlDecisionStore({ dir: missing });
    expect(await store.list()).toEqual([]);
    await store.append([makeRecord({ spec: "x.spec.ts" })]);
    expect(await readdir(missing)).toEqual(["x.spec.ts.jsonl"]);
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a Windows absolute path", "C:/tests/a.spec.ts"],
    ["a UNC-style path", "\\\\server\\share\\a.spec.ts"],
    ["a parent segment", "../outside.spec.ts"],
    ["a nested parent segment", "tests/../../outside.spec.ts"],
    ["a backslash parent segment", "tests\\..\\..\\outside.spec.ts"],
    ["a NUL byte", "tests/a\u0000.spec.ts"],
    ["an empty spec", ""],
    ["an empty segment", "tests//a.spec.ts"],
    ["a dot segment", "./a.spec.ts"],
  ])("rejects %s as a spec path", async (_label, spec) => {
    const store = new JsonlDecisionStore({ dir });
    await expect(store.append([makeRecord({ spec })])).rejects.toThrow(
      CacheError,
    );
    await expect(store.forStep(spec, "s")).rejects.toThrow(CacheError);
    expect(await readdir(dir)).toEqual([]);
  });
});
