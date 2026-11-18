import { describe, expect, it } from "vitest";
import { analyse, classifyPath } from "./analyse.js";
import { memoryReader } from "./git.js";

const TEST = `test("a", () => { expect(1).toBe(1); });\n`;
const CACHE = ".jevy/decisions";

describe("classifyPath", () => {
  it.each([
    ["tests/a.spec.ts", "test"],
    ["src/b.test.mjs", "test"],
    ["c.spec.tsx", "test"],
    ["d.test.cjs", "test"],
    ["node_modules/x/a.spec.ts", null],
    ["packages/x/dist/a.spec.js", null],
    ["a.spec.json", null],
    ["jevy.config.ts", "jevy-config"],
    ["apps/web/jevy.config.mjs", "jevy-config"],
    ["jevy.config.json", null],
    ["playwright.config.ts", "playwright-config"],
    ["e2e/playwright.config.cjs", "playwright-config"],
    [".jevy/decisions/checkout.spec.ts.jsonl", "decisions"],
    [".jevy/decisions/nested/x.jsonl", "decisions"],
    [".jevy/decisions/notes.txt", null],
    [".jevy/decisions-old/x.jsonl", null],
  ])("classifies %s as %s", (path, expected) => {
    expect(classifyPath(path, CACHE)).toBe(expected);
  });
});

describe("analyse", () => {
  it("routes each changed file to its comparison and sorts the result", async () => {
    const reader = memoryReader(
      {
        "b.spec.ts": TEST,
        "a.spec.ts": TEST,
        "jevy.config.ts": "export default { thresholds: { pass: 0.8 } };",
        "src/app.ts": "x",
      },
      {
        "a.spec.ts": `test("a", () => {});\n`,
        "jevy.config.ts": "export default { thresholds: { pass: 0.5 } };",
        "src/app.ts": "y",
        [`${CACHE}/a.jsonl`]: '{"reviewedBy":"me"}\n',
      },
    );
    const findings = await analyse(reader, { cacheDir: CACHE });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      [`${CACHE}/a.jsonl`, "approval-added"],
      ["a.spec.ts", "assertion-removed"],
      ["b.spec.ts", "test-file-removed"],
      ["jevy.config.ts", "threshold-lowered"],
    ]);
  });

  it("compares a renamed file with its old path", async () => {
    const reader = memoryReader(
      { "old.spec.ts": TEST },
      { "new.spec.ts": `test("a", () => {});\n` },
      { "new.spec.ts": "old.spec.ts" },
    );
    const findings = await analyse(reader, { cacheDir: CACHE });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      ["new.spec.ts", "assertion-removed"],
    ]);
  });

  it("treats a test file renamed out of the test globs as removed", async () => {
    const reader = memoryReader(
      { "a.spec.ts": TEST },
      { "a.spec.ts.bak": TEST },
      { "a.spec.ts.bak": "a.spec.ts" },
    );
    const findings = await analyse(reader, { cacheDir: CACHE });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      ["a.spec.ts", "test-file-removed"],
    ]);
  });

  it("finds nothing when only other files changed", async () => {
    const reader = memoryReader({ "src/a.ts": "1" }, { "src/a.ts": "2" });
    expect(await analyse(reader, { cacheDir: CACHE })).toEqual([]);
  });
});
