import { describe, expect, it } from "vitest";
import { diffTestFile } from "./diff-tests.js";
import type { Finding } from "./types.js";

function diff(before: string | null, after: string | null): Finding[] {
  return [...diffTestFile({ file: "a.spec.ts", before, after })];
}

function kinds(before: string | null, after: string | null): string[] {
  return diff(before, after).map((finding) => finding.kind);
}

/** Kinds that are not "info": what a reviewer would be asked to look at. */
function flagged(before: string, after: string): string[] {
  return diff(before, after)
    .filter((finding) => finding.severity !== "info")
    .map((finding) => finding.kind);
}

const BASE = `import { test, expect } from "@playwright/test";

test.describe("checkout", () => {
  test("pays by card", async ({ page }) => {
    const button = page.getByRole("button", { name: "Pay" });
    await button.click();
    await expect(page.getByRole("status")).toHaveText("Paid");
    await expect(page).toSatisfy("The order is shown as confirmed");
  });

  test("shows the total", async ({ page }) => {
    expect(await total(page)).toBe(42);
  });
});
`;

describe("diffTestFile: weakening", () => {
  it("reports a deleted test file", () => {
    expect(diff(BASE, null)).toEqual([
      {
        kind: "test-file-removed",
        severity: "weakening",
        file: "a.spec.ts",
        message: "test file removed (2 tests)",
      },
    ]);
  });

  it("reports a removed test", () => {
    const after = BASE.replace(
      /\n {2}test\("shows the total"[\s\S]*?\n {2}\}\);\n/,
      "\n",
    );
    const found = diff(BASE, after);
    expect(found).toEqual([
      {
        kind: "test-removed",
        severity: "weakening",
        file: "a.spec.ts",
        test: ["checkout", "shows the total"],
        line: 11,
        message: "test removed: checkout > shows the total (was line 11)",
      },
    ]);
  });

  it("reports a renamed test with the same body as info, not removal", () => {
    const after = BASE.replace("shows the total", "shows the order total");
    expect(diff(BASE, after)).toEqual([
      {
        kind: "test-renamed",
        severity: "info",
        file: "a.spec.ts",
        test: ["checkout", "shows the order total"],
        line: 11,
        message:
          "test renamed: checkout > shows the total -> checkout > shows the order total",
        before: "checkout > shows the total",
        after: "checkout > shows the order total",
      },
    ]);
  });

  it("matches a renamed test whose body was only re-quoted", () => {
    const after = BASE.replace("shows the total", "shows the order total")
      .replace('getByRole("status")', "getByRole('status')")
      .replace("toBe(42)", "toBe(42.0)");
    expect(kinds(BASE, after)).toEqual(["test-renamed"]);
  });

  it("still flags a skip on a renamed test", () => {
    const after = BASE.replace(
      'test("shows the total"',
      'test.skip("shows the order total"',
    );
    expect(kinds(BASE, after)).toEqual(["skip-added", "test-renamed"]);
  });

  it("reports which matchers went when an assertion is removed", () => {
    const after = BASE.replace(
      '    await expect(page.getByRole("status")).toHaveText("Paid");\n',
      "",
    );
    const found = diff(BASE, after);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "assertion-removed",
      severity: "weakening",
      test: ["checkout", "pays by card"],
      line: 4,
      message:
        "checkout > pays by card has 1 fewer assertion (2 -> 1): removed toHaveText",
      before: 'expect(…).toHaveText("Paid")',
    });
  });

  it.each([
    ["test.skip on the test", 'test.skip("pays by card"'],
    ["test.fixme on the test", 'test.fixme("pays by card"'],
    ["an x-prefixed form", 'xtest("pays by card"'],
  ])("reports skip-added for %s", (_name, replacement) => {
    const after = BASE.replace('test("pays by card"', replacement);
    expect(flagged(BASE, after)).toEqual(["skip-added"]);
  });

  it("reports skip-added for a test.skip() call inside the body", () => {
    const after = BASE.replace(
      "const button =",
      'test.skip(process.env.CI === "true", "flaky");\n    const button =',
    );
    expect(flagged(BASE, after)).toEqual(["skip-added"]);
  });

  it("reports skip-added for a step changed to test.step.skip", () => {
    const before = `test("t", async () => {\n  await test.step("pay", async () => { expect(1).toBe(1); });\n});`;
    const after = before.replace("test.step(", "test.step.skip(");
    expect(flagged(before, after)).toEqual(["skip-added"]);
  });

  it("reports skip-added for every test under a skipped describe", () => {
    const after = BASE.replace("test.describe(", "test.describe.skip(");
    expect(flagged(BASE, after)).toEqual(["skip-added", "skip-added"]);
  });

  it("reports skip-added for a test.fixme() call in a describe body", () => {
    const after = BASE.replace(
      'test.describe("checkout", () => {',
      'test.describe("checkout", () => {\n  test.fixme();',
    );
    expect(flagged(BASE, after)).toEqual(["skip-added", "skip-added"]);
  });

  it("reports skip-added for it.todo replacing a test, with the lost assertions", () => {
    const before = `it("adds", () => { expect(add(1, 1)).toBe(2); });`;
    const after = `it.todo("adds");`;
    expect(kinds(before, after)).toEqual(["assertion-removed", "skip-added"]);
  });

  it("reports only-added on an existing test", () => {
    const after = BASE.replace(
      'test("shows the total"',
      'test.only("shows the total"',
    );
    expect(flagged(BASE, after)).toEqual(["only-added"]);
  });

  it("reports only-added on a new test, since it stops every other test", () => {
    const after = `${BASE}\ntest.only("new", () => {});\n`;
    expect(kinds(BASE, after)).toEqual(["only-added", "test-added"]);
  });

  it("reports expected-failure-added for test.fail and test.fail()", () => {
    const definition = BASE.replace(
      'test("shows the total"',
      'test.fail("shows the total"',
    );
    expect(flagged(BASE, definition)).toEqual(["expected-failure-added"]);
    const annotation = BASE.replace(
      "expect(await total(page))",
      "test.fail();\n    expect(await total(page))",
    );
    expect(flagged(BASE, annotation)).toEqual(["expected-failure-added"]);
  });

  it("reports soft-added when an expect becomes expect.soft", () => {
    const after = BASE.replace("expect(await total", "expect.soft(await total");
    expect(diff(BASE, after)).toEqual([
      {
        kind: "soft-added",
        severity: "weakening",
        file: "a.spec.ts",
        test: ["checkout", "shows the total"],
        line: 11,
        message:
          "checkout > shows the total has 1 more soft assertion (0 -> 1)",
      },
    ]);
  });

  it("reports removed assertions outside tests", () => {
    const before = `test.beforeEach(() => { expect(env).toBeDefined(); });\ntest("t", () => {});`;
    const after = `test.beforeEach(() => {});\ntest("t", () => {});`;
    expect(diff(before, after)).toMatchObject([
      {
        kind: "assertion-removed",
        severity: "weakening",
        message:
          "assertions outside tests: 1 fewer (1 -> 0): removed toBeDefined",
      },
    ]);
  });
});

describe("diffTestFile: review", () => {
  it("reports a changed toSatisfy statement with before and after", () => {
    const after = BASE.replace(
      "The order is shown as confirmed",
      "The page shows something",
    );
    expect(diff(BASE, after)).toEqual([
      {
        kind: "statement-changed",
        severity: "review",
        file: "a.spec.ts",
        test: ["checkout", "pays by card"],
        line: 8,
        message: "checkout > pays by card: toSatisfy statement changed",
        before: "The order is shown as confirmed",
        after: "The page shows something",
      },
    ]);
  });

  it("reports a changed matcher name", () => {
    const after = BASE.replace(".toBe(42)", ".toBeTruthy()");
    expect(diff(BASE, after)).toMatchObject([
      {
        kind: "assertion-changed",
        severity: "review",
        before: "expect(…).toBe(42)",
        after: "expect(…).toBeTruthy()",
      },
    ]);
  });

  it("reports a changed literal argument", () => {
    const after = BASE.replace('toHaveText("Paid")', "toHaveText(/Pa/)");
    expect(flagged(BASE, after)).toEqual(["assertion-changed"]);
  });

  it("reports an added .not", () => {
    const after = BASE.replace(".toBe(42)", ".not.toBe(42)");
    expect(flagged(BASE, after)).toEqual(["assertion-changed"]);
  });

  it("reports a subject replaced by the expected literal", () => {
    const after = BASE.replace("expect(await total(page))", "expect(42)");
    expect(flagged(BASE, after)).toEqual(["assertion-changed"]);
  });

  it("reports a changed test whose title is not a literal", () => {
    const before =
      "for (const n of [1, 2]) {\n  test(`case ${n}`, () => { expect(n).toBe(1); });\n}";
    const after =
      "for (const n of [1, 2]) {\n  test(`case ${n}`, () => { expect(n).toBeTruthy(); });\n}";
    expect(diff(before, after)).toMatchObject([
      {
        kind: "dynamic-title",
        severity: "review",
        test: ["`case ${n}`"],
        line: 2,
      },
    ]);
  });

  it("reports a removed test whose title is not a literal as review", () => {
    expect(
      kinds(
        "test(name, () => {});\ntest('x', () => {});",
        "test('x', () => {});",
      ),
    ).toEqual(["dynamic-title"]);
  });

  it("reports a changed .each table", () => {
    const before = `test.each([1, 2, 3])("n %i", (n) => { expect(n).toBeGreaterThan(0); });`;
    const after = `test.each([1])("n %i", (n) => { expect(n).toBeGreaterThan(0); });`;
    expect(diff(before, after)).toMatchObject([
      {
        kind: "cases-changed",
        severity: "review",
        before: "[1,2,3]",
        after: "[1]",
      },
    ]);
  });

  it("reports a file that does not parse, without comparing it", () => {
    expect(diff(BASE, `${BASE}\ntest("broken", () => {`)).toMatchObject([
      {
        kind: "unparseable",
        severity: "review",
        file: "a.spec.ts",
        message: expect.stringMatching(
          /^head version could not be parsed \(line \d+: .+\); its tests were not compared$/,
        ) as string,
      },
    ]);
  });
});

describe("diffTestFile: info and harmless edits", () => {
  it("reports an added test and an added assertion as info only", () => {
    const after = BASE.replace(
      "expect(await total(page)).toBe(42);",
      "expect(await total(page)).toBe(42);\n    expect(await tax(page)).toBe(4);",
    ).concat('\ntest("new", () => {});\n');
    expect(diff(BASE, after).map((f) => [f.kind, f.severity])).toEqual([
      ["assertion-added", "info"],
      ["test-added", "info"],
    ]);
  });

  it("reports an added file's tests as info", () => {
    expect(kinds(null, BASE)).toEqual(["test-added", "test-added"]);
  });

  it.each([
    [
      "reformatting",
      BASE.replace(
        'await expect(page.getByRole("status")).toHaveText("Paid");',
        "await expect(\n      page.getByRole('status'),\n    ).toHaveText('Paid')",
      ),
    ],
    [
      "reordering imports",
      `import { expect } from "@playwright/test";\nimport { test } from "@playwright/test";\n${BASE.split("\n").slice(1).join("\n")}`,
    ],
    [
      "renaming a variable",
      BASE.replace("const button", "const payButton").replace(
        "await button.click",
        "await payButton.click",
      ),
    ],
    [
      "adding a comment",
      BASE.replace(
        "await button.click();",
        "// pay\n    await button.click(); /* now */",
      ),
    ],
    [
      "reordering assertions",
      BASE.replace(
        '    await expect(page.getByRole("status")).toHaveText("Paid");\n    await expect(page).toSatisfy("The order is shown as confirmed");',
        '    await expect(page).toSatisfy("The order is shown as confirmed");\n    await expect(page.getByRole("status")).toHaveText("Paid");',
      ),
    ],
    [
      "reordering tests",
      BASE.replace(
        /( {2}test\("pays[\s\S]*?\n {2}\}\);\n)\n( {2}test\("shows[\s\S]*?\n {2}\}\);\n)/,
        "$2\n$1",
      ),
    ],
  ])("finds nothing for %s", (_name, after) => {
    expect(after).not.toBe(BASE);
    expect(diff(BASE, after)).toEqual([]);
  });

  it("finds nothing when nothing changed", () => {
    expect(diff(BASE, BASE)).toEqual([]);
  });
});
