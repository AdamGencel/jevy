import { describe, expect, it } from "vitest";
import { memoryReader, parseNameStatus } from "./git.js";

describe("parseNameStatus", () => {
  it("reads NUL-separated name-status output, renames and copies included", () => {
    const output = [
      "M",
      "src/a.spec.ts",
      "D",
      "src/gone.test.ts",
      "R087",
      "old name.spec.ts",
      "new name.spec.ts",
      "C100",
      "src/a.spec.ts",
      "src/copy.spec.ts",
      "A",
      "tab\there.spec.ts",
      "T",
      "link.spec.ts",
      "",
    ].join("\u0000");
    expect(parseNameStatus(output)).toEqual([
      { status: "modified", path: "src/a.spec.ts", oldPath: "src/a.spec.ts" },
      {
        status: "deleted",
        path: "src/gone.test.ts",
        oldPath: "src/gone.test.ts",
      },
      {
        status: "renamed",
        path: "new name.spec.ts",
        oldPath: "old name.spec.ts",
      },
      {
        status: "added",
        path: "src/copy.spec.ts",
        oldPath: "src/copy.spec.ts",
      },
      {
        status: "added",
        path: "tab\there.spec.ts",
        oldPath: "tab\there.spec.ts",
      },
      { status: "modified", path: "link.spec.ts", oldPath: "link.spec.ts" },
    ]);
  });

  it("reads empty output as no changes", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("memoryReader", () => {
  it("derives changes from two snapshots and reads both sides", async () => {
    const reader = memoryReader(
      { "a.spec.ts": "1", "b.spec.ts": "2", "same.ts": "x" },
      { "a.spec.ts": "1!", "c.spec.ts": "3", "same.ts": "x" },
    );
    expect(await reader.changes()).toEqual([
      { status: "modified", path: "a.spec.ts", oldPath: "a.spec.ts" },
      { status: "deleted", path: "b.spec.ts", oldPath: "b.spec.ts" },
      { status: "added", path: "c.spec.ts", oldPath: "c.spec.ts" },
    ]);
    expect(await reader.readBase("b.spec.ts")).toBe("2");
    expect(await reader.readHead("b.spec.ts")).toBeNull();
    expect(await reader.readHead("c.spec.ts")).toBe("3");
  });

  it("reports declared renames with their old path", async () => {
    const reader = memoryReader(
      { "old.spec.ts": "1" },
      { "new.spec.ts": "1" },
      { "new.spec.ts": "old.spec.ts" },
    );
    expect(await reader.changes()).toEqual([
      { status: "renamed", path: "new.spec.ts", oldPath: "old.spec.ts" },
    ]);
  });
});
