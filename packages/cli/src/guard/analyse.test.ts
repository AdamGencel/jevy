import { describe, expect, it } from "vitest";
import { analyse, analyseAll, classifyPath } from "./analyse.js";
import { memoryReader } from "./git.js";
import { buildProtectRules } from "./protect.js";

const TEST = `test("a", () => { expect(1).toBe(1); });\n`;
const CACHE = ".jevy/decisions";
// A real assertion, and a weakening that is one finding whatever else the
// guard learns to say about tests that check nothing.
const REAL = `test("a", () => { expect(total).toBe(1); });\n`;
const SKIPPED = `test.skip("a", () => { expect(total).toBe(1); });\n`;

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

  it.each([
    ["checks/a.ts", "test"],
    ["checks/deep/b.mjs", "test"],
    ["e2e/c.flow.ts", "test"],
    // The built-in pattern no longer applies once globs are given.
    ["tests/a.spec.ts", null],
    ["e2e/c.ts", null],
    // Never tests, whatever the globs say.
    ["node_modules/pkg/checks/a.ts", null],
    ["checks/node_modules/a.ts", null],
    ["checks/dist/a.js", null],
    // These keep their own comparison.
    ["checks/jevy.config.ts", "jevy-config"],
    ["checks/playwright.config.ts", "playwright-config"],
    [".jevy/decisions/checks/a.jsonl", "decisions"],
  ])("with test globs classifies %s as %s", (path, expected) => {
    const globs = ["checks/**", "e2e/*.flow.ts", ".jevy/**"];
    expect(classifyPath(path, CACHE, globs)).toBe(expected);
  });

  it.each([
    ["Jevy.Config.ts", "jevy-config"],
    ["apps/web/JEVY.CONFIG.MJS", "jevy-config"],
    ["Playwright.Config.ts", "playwright-config"],
    ["e2e/PLAYWRIGHT.config.CJS", "playwright-config"],
    ["Jevy.Config.json", null],
  ])("classifies %s as %s, whatever the case of its name", (path, expected) => {
    // A disk that ignores case loads `Jevy.Config.ts` as the config, and the
    // protected-path rule already matches it in any case.
    expect(classifyPath(path, CACHE)).toBe(expected);
  });

  it.each([
    ["web{a,b}/checks/a.ts", "test"],
    ["web{a,b}/checks/deep/b.ts", "test"],
    // The directory is literal text: it is never read as a glob.
    ["weba/checks/a.ts", null],
    ["checks/a.ts", null],
    ["web{a,b}/other/a.ts", null],
    ["web{a,b}", null],
    // Outside the directory nothing is a test once globs replace the pattern.
    ["tests/a.spec.ts", null],
  ])(
    "with globs relative to a directory classifies %s as %s",
    (path, expected) => {
      expect(classifyPath(path, CACHE, ["checks/**"], "web{a,b}")).toBe(
        expected,
      );
      expect(classifyPath(path, CACHE, ["./checks/**"], "./web{a,b}/")).toBe(
        expected,
      );
    },
  );

  it.each([
    ["tests/a.spec.ts", "test"],
    ["web/flows/a.ts", "test"],
    ["flows/a.ts", null],
    ["web/src/a.ts", null],
    ["web/node_modules/flows/a.ts", null],
  ])("with added globs classifies %s as %s", (path, expected) => {
    // Added globs widen the built-in pattern; they never replace it.
    expect(classifyPath(path, CACHE, undefined, "web", ["flows/**"])).toBe(
      expected,
    );
  });

  it("adds the added globs to the replacing ones as well", () => {
    const classify = (path: string) =>
      classifyPath(path, CACHE, ["checks/**"], "", ["flows/**"]);
    expect(classify("checks/a.ts")).toBe("test");
    expect(classify("flows/a.ts")).toBe("test");
    expect(classify("tests/a.spec.ts")).toBeNull();
  });

  it("keeps the built-in pattern for an empty glob list", () => {
    // No globs must not mean "no file is a test": that would switch the
    // comparison off without a sign of it.
    expect(classifyPath("tests/a.spec.ts", CACHE, [])).toBe("test");
    expect(classifyPath("src/a.ts", CACHE, [])).toBeNull();
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
      // The changed test is left with an empty body.
      ["a.spec.ts", "test-without-assertion"],
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
      ["new.spec.ts", "test-without-assertion"],
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

  it("uses the test globs it is given", async () => {
    const reader = memoryReader(
      { "checks/a.ts": REAL, "b.spec.ts": REAL },
      { "checks/a.ts": SKIPPED },
    );
    const findings = await analyse(reader, {
      cacheDir: CACHE,
      tests: ["checks/**"],
    });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      ["checks/a.ts", "skip-added"],
    ]);
  });

  it("takes test globs relative to testsDir, and alsoTests on top of the built-in pattern", async () => {
    const reader = memoryReader(
      { "web/flows/a.ts": REAL, "flows/a.ts": REAL, "b.spec.ts": REAL },
      { "web/flows/a.ts": SKIPPED, "flows/a.ts": SKIPPED },
    );
    const findings = await analyse(reader, {
      cacheDir: CACHE,
      testsDir: "web",
      alsoTests: ["flows/**"],
    });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      ["b.spec.ts", "test-file-removed"],
      ["web/flows/a.ts", "skip-added"],
    ]);
  });

  it("adds a finding for each protected path that changed, in sorted order", async () => {
    const reader = memoryReader(
      {
        "a.spec.ts": REAL,
        "jevy.config.ts": "export default { thresholds: { pass: 0.8 } };",
        "tests/critical/pay.spec.ts": REAL,
        "wallet.policy.json": "{}",
        [`${CACHE}/README.md`]: "old",
      },
      {
        "a.spec.ts": SKIPPED,
        "jevy.config.ts": "export default { thresholds: { pass: 0.5 } };",
        "tests/critical/pay.spec.ts": SKIPPED,
        "wallet.policy.json": '{"allow":"*"}',
        [`${CACHE}/README.md`]: "new",
        [`${CACHE}/a.jsonl`]: '{"reviewedBy":"me"}\n',
      },
    );
    const protect = buildProtectRules({
      settings: {
        cacheDir: null,
        guardTests: null,
        protect: ["tests/critical/**"],
        checks: null,
        web3Policy: "wallet.policy.json",
        mainBranch: null,
        unreadable: [],
      },
      configDir: "",
      cacheDir: CACHE,
    });
    const findings = await analyse(reader, { cacheDir: CACHE, protect });
    expect(findings.map((f) => [f.file, f.kind, f.severity])).toEqual([
      [`${CACHE}/README.md`, "protected-path-changed", "weakening"],
      // A decision record is compared record by record, not reported as a path.
      [`${CACHE}/a.jsonl`, "approval-added", "weakening"],
      ["a.spec.ts", "skip-added", "weakening"],
      ["jevy.config.ts", "protected-path-changed", "weakening"],
      ["jevy.config.ts", "threshold-lowered", "weakening"],
      ["tests/critical/pay.spec.ts", "protected-path-changed", "weakening"],
      ["tests/critical/pay.spec.ts", "skip-added", "weakening"],
      ["wallet.policy.json", "protected-path-changed", "weakening"],
    ]);
  });

  it("applies the built-in protections with no config", async () => {
    const reader = memoryReader(
      {},
      {
        "apps/web/jevy.config.mjs": "export default {};",
        [`${CACHE}/notes.txt`]: "x",
        "src/app.ts": "y",
      },
    );
    const protect = buildProtectRules({
      settings: null,
      configDir: "",
      cacheDir: CACHE,
    });
    const findings = await analyse(reader, { cacheDir: CACHE, protect });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      [`${CACHE}/notes.txt`, "protected-path-changed"],
      // An added config is already reported by the config comparison.
      ["apps/web/jevy.config.mjs", "config-changed"],
      ["apps/web/jevy.config.mjs", "protected-path-changed"],
    ]);
  });
});

describe("analyseAll", () => {
  it("merges the findings of several readers, each one once, sorted", async () => {
    const base = { "a.spec.ts": REAL, "b.spec.ts": REAL, "c.spec.ts": REAL };
    const tree = memoryReader(base, { ...base, "b.spec.ts": SKIPPED });
    const index = memoryReader(base, {
      ...base,
      "a.spec.ts": SKIPPED,
      "b.spec.ts": SKIPPED,
    });
    const findings = await analyseAll([tree, index], { cacheDir: CACHE });
    expect(findings.map((f) => [f.file, f.kind])).toEqual([
      ["a.spec.ts", "skip-added"],
      ["b.spec.ts", "skip-added"],
    ]);
    expect(await analyseAll([tree], { cacheDir: CACHE })).toEqual(
      await analyse(tree, { cacheDir: CACHE }),
    );
  });
});
