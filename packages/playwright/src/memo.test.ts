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
import { CacheError } from "@jevyjs/core";
import type { RunMemoEntry } from "@jevyjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileRunMemo,
  createKeyClaims,
  createRecordMarks,
  joinRun,
} from "./memo.js";
import type { MemoFileSystem } from "./memo.js";

const KEY = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const YES: RunMemoEntry = {
  answer: { value: "yes", confidence: 0.9 },
  truncated: false,
};
const NO: RunMemoEntry = {
  answer: { value: "no", confidence: 0.8, abstained: false },
  truncated: true,
};

let dir: string;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "jevy-memo-")), "memo");
});

afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("createFileRunMemo", () => {
  it("a key never set is a miss, and the directory need not exist", () => {
    expect(createFileRunMemo(dir).get(KEY)).toBeUndefined();
  });

  it("returns what was set", () => {
    const memo = createFileRunMemo(dir);
    memo.set(KEY, YES);
    expect(memo.get(KEY)).toEqual(YES);
    expect(memo.get(OTHER)).toBeUndefined();
  });

  it("two memos on one directory: the first writer wins for both", () => {
    const first = createFileRunMemo(dir);
    const second = createFileRunMemo(dir);
    first.set(KEY, YES);
    second.set(KEY, NO);
    expect(first.get(KEY)).toEqual(YES);
    expect(second.get(KEY)).toEqual(YES);
  });

  it("writes one file per key, named by the key's hex, and nothing else", async () => {
    const memo = createFileRunMemo(dir);
    memo.set(KEY, YES);
    memo.set(OTHER, NO);
    memo.set(KEY, NO);
    expect((await readdir(dir)).sort()).toEqual([
      `${"a".repeat(64)}.json`,
      `${"b".repeat(64)}.json`,
    ]);
    expect(
      JSON.parse(await readFile(join(dir, `${"b".repeat(64)}.json`), "utf8")),
    ).toEqual(NO);
  });

  it("keeps only the entry's own fields", () => {
    const memo = createFileRunMemo(dir);
    const extra = {
      answer: { value: "yes", confidence: 0.9, raw: "page text" },
      truncated: false,
      page: "page text",
    } as unknown as RunMemoEntry;
    memo.set(KEY, extra);
    expect(memo.get(KEY)).toEqual(YES);
  });

  it("a malformed file is a CacheError, not a miss", async () => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${"a".repeat(64)}.json`);
    for (const text of [
      "",
      "{",
      "[]",
      "null",
      '{"answer":{"value":"yes","confidence":0.9}}',
      '{"answer":{"value":1,"confidence":0.9},"truncated":false}',
      '{"answer":{"value":"yes","confidence":"high"},"truncated":false}',
      '{"answer":{"value":"yes","confidence":0.9,"abstained":"no"},"truncated":false}',
      '{"answer":"yes","truncated":false}',
    ]) {
      await writeFile(file, text);
      expect(() => createFileRunMemo(dir).get(KEY)).toThrow(CacheError);
    }
  });

  it("refuses a key that is not a decision key, so it cannot name a path", () => {
    const memo = createFileRunMemo(dir);
    for (const key of ["../x", "sha256:../../etc", "sha256:ABC", ""]) {
      expect(() => memo.get(key)).toThrow(CacheError);
      expect(() => {
        memo.set(key, YES);
      }).toThrow(CacheError);
    }
  });

  it("leaves no temporary file behind", async () => {
    const memo = createFileRunMemo(dir);
    memo.set(KEY, YES);
    createFileRunMemo(dir).set(KEY, NO);
    expect(await readdir(dir)).toEqual([`${"a".repeat(64)}.json`]);
  });
});

/** A file system whose hard links fail as `code` says. */
function noLinks(code: string): MemoFileSystem {
  return {
    link: () => {
      throw Object.assign(new Error(`link: ${code}`), { code });
    },
  };
}

describe("createFileRunMemo where hard links fail", () => {
  it("on a file system without hard links (ENOTSUP), entries are still written and read", async () => {
    const memo = createFileRunMemo(dir, { fs: noLinks("ENOTSUP") });
    memo.set(KEY, YES);
    expect(memo.get(KEY)).toEqual(YES);
    expect(createFileRunMemo(dir).get(KEY)).toEqual(YES);
    expect(await readdir(dir)).toEqual([`${"a".repeat(64)}.json`]);
  });

  it("the first writer still wins, and a later writer leaves its entry in place", () => {
    const first = createFileRunMemo(dir, { fs: noLinks("ENOTSUP") });
    const second = createFileRunMemo(dir, { fs: noLinks("EPERM") });
    first.set(KEY, YES);
    second.set(KEY, NO);
    expect(first.get(KEY)).toEqual(YES);
    expect(second.get(KEY)).toEqual(YES);
  });
});

describe("createFileRunMemo when the disk fails", () => {
  it("a write that fails keeps the answer in this process and warns once, with a CacheError naming the cause", async () => {
    await mkdir(join(dir, ".."), { recursive: true });
    // The owner marks cannot be created: their directory's name is a file.
    await writeFile(`${dir}.owners`, "");
    const warnings: string[] = [];
    const memo = createFileRunMemo(dir, {
      warn: (text) => warnings.push(text),
    });
    expect(() => {
      memo.set(KEY, YES);
    }).not.toThrow();
    memo.set(OTHER, NO);
    expect(memo.get(KEY)).toEqual(YES);
    expect(memo.get(OTHER)).toEqual(NO);
    // Another process sees nothing; this one keeps its answer.
    expect(createFileRunMemo(dir).get(KEY)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Could not write the run memo entry for sha256:a{64}: E[A-Z]+\. Its answer is kept in this worker/,
    );
  });

  it("a file that cannot be read is a CacheError naming the cause", async () => {
    await mkdir(join(dir, `${"a".repeat(64)}.json`), { recursive: true });
    expect(() => createFileRunMemo(dir).get(KEY)).toThrow(CacheError);
    expect(() => createFileRunMemo(dir).get(KEY)).toThrow(/EISDIR/);
  });
});

describe("joinRun", () => {
  const runsDir = (): string => join(dir, "..", "runs");

  it("with retries, one directory per runner, whoever is alive", () => {
    const join1 = joinRun({
      runsDir: runsDir(),
      retries: 1,
      runner: 10,
      worker: 11,
      isAlive: () => false,
    });
    const join2 = joinRun({
      runsDir: runsDir(),
      retries: 2,
      runner: 10,
      worker: 12,
      isAlive: () => false,
    });
    expect(join1).toBe(join(runsDir(), "10", "all"));
    expect(join2).toBe(join1);
  });

  it("without retries, the workers of one run share a generation and the next run gets a new one", () => {
    const alive = new Set<number>();
    const enter = (worker: number): string => {
      const joined = joinRun({
        runsDir: runsDir(),
        retries: 0,
        runner: 20,
        worker,
        isAlive: (pid) => alive.has(pid),
      });
      alive.add(worker);
      return joined;
    };
    const first = enter(21);
    expect(first).toBe(join(runsDir(), "20", "1"));
    expect(enter(22)).toBe(first);
    // The run ends: its workers stop. The next run's first worker starts
    // generation 2, and its other workers join it.
    alive.clear();
    const second = enter(23);
    expect(second).toBe(join(runsDir(), "20", "2"));
    expect(enter(24)).toBe(second);
  });

  it("runners are kept apart", () => {
    const a = joinRun({
      runsDir: runsDir(),
      retries: 0,
      runner: 30,
      worker: 31,
      isAlive: () => true,
    });
    const b = joinRun({
      runsDir: runsDir(),
      retries: 0,
      runner: 40,
      worker: 41,
      isAlive: () => true,
    });
    expect(a).not.toBe(b);
  });
});

describe("createKeyClaims", () => {
  const claimsDir = (): string => join(dir, "..", "claims");

  it("one process holds a key at a time, until it releases it", () => {
    const one = createKeyClaims(claimsDir(), { pid: 1, isAlive: () => true });
    const two = createKeyClaims(claimsDir(), { pid: 2, isAlive: () => true });
    expect(one.tryClaim(KEY)).toBe(true);
    expect(two.tryClaim(KEY)).toBe(false);
    expect(two.tryClaim(OTHER)).toBe(true);
    one.release(KEY);
    expect(two.tryClaim(KEY)).toBe(true);
  });

  it("a claim is held per process: two holds need two releases", () => {
    const one = createKeyClaims(claimsDir(), { pid: 1, isAlive: () => true });
    const two = createKeyClaims(claimsDir(), { pid: 2, isAlive: () => true });
    expect(one.tryClaim(KEY)).toBe(true);
    expect(one.tryClaim(KEY)).toBe(true);
    one.release(KEY);
    expect(two.tryClaim(KEY)).toBe(false);
    one.release(KEY);
    expect(two.tryClaim(KEY)).toBe(true);
  });

  it("a claim left by a process that died is taken over", () => {
    const dead = createKeyClaims(claimsDir(), { pid: 7, isAlive: () => true });
    expect(dead.tryClaim(KEY)).toBe(true);
    const next = createKeyClaims(claimsDir(), {
      pid: 8,
      isAlive: (pid) => pid !== 7,
    });
    expect(next.tryClaim(KEY)).toBe(true);
  });
});

describe("createRecordMarks", () => {
  it("the first mark for a key wins until it is taken back", () => {
    const marks = createRecordMarks(join(dir, "..", "recorded"));
    const other = createRecordMarks(join(dir, "..", "recorded"));
    expect(marks.mark(KEY)).toBe(true);
    expect(other.mark(KEY)).toBe(false);
    marks.unmark(KEY);
    expect(other.mark(KEY)).toBe(true);
  });
});
