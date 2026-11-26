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
    // Changed on purpose, twice. Under `@jevyjs/playwright` the test is left
    // with toSatisfy alone, which is advisory by default, so it is also
    // reported for review. BASE imports `@playwright/test`, whose expect has
    // no toSatisfy and throws on it, so there it is one finding, as it was.
    expect(found.map((f) => f.kind)).toEqual(["assertion-removed"]);
    const jevy = (text: string): string =>
      text.replace('"@playwright/test"', '"@jevyjs/playwright"');
    expect(diff(jevy(BASE), jevy(after)).map((f) => f.kind)).toEqual([
      "assertion-removed",
      "only-advisory-assertions",
    ]);
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
    // The body changed, and its one assertion is expect(1).toBe(1).
    expect(flagged(before, after)).toEqual([
      "skip-added",
      "assertion-cannot-fail",
    ]);
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
    expect(kinds(BASE, after)).toEqual([
      "only-added",
      "test-added",
      "test-without-assertion",
    ]);
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

  it("still reports a changed statement when toSatisfy is the only, advisory, check", () => {
    const before = `import { test, expect } from "@jevyjs/playwright";

test("confirms", async ({ page }) => {
  await page.goto("/order");
  await expect(page.getByRole("main")).toSatisfy("The order is confirmed");
});
`;
    const after = before.replace(
      "The order is confirmed",
      "Something is shown",
    );
    const statement = {
      kind: "statement-changed",
      severity: "review",
      file: "a.spec.ts",
      test: ["confirms"],
      line: 5,
      message: "confirms: toSatisfy statement changed",
      before: "The order is confirmed",
      after: "Something is shown",
    };
    // The body changed, so the test is judged as it now stands.
    expect(diff(before, after)).toEqual([
      expect.objectContaining({ kind: "only-advisory-assertions" }) as unknown,
      statement,
    ]);
    expect([
      ...diffTestFile({
        file: "a.spec.ts",
        before,
        after,
        toSatisfyBlocking: true,
      }),
    ]).toEqual([statement]);
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
    expect(flagged(BASE, after)).toEqual([
      "assertion-changed",
      "assertion-cannot-fail",
    ]);
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
  it("reports an added test and an added assertion as info", () => {
    const after = BASE.replace(
      "expect(await total(page)).toBe(42);",
      "expect(await total(page)).toBe(42);\n    expect(await tax(page)).toBe(4);",
    ).concat('\ntest("new", () => {});\n');
    expect(diff(BASE, after).map((f) => [f.kind, f.severity])).toEqual([
      ["assertion-added", "info"],
      ["test-added", "info"],
      // The new test has an empty body.
      ["test-without-assertion", "weakening"],
    ]);
  });

  it("reports an added test with a real assertion as info only", () => {
    const after = `${BASE}\ntest("new", async ({ page }) => {\n  await expect(page).toHaveTitle("Shop");\n});\n`;
    expect(diff(BASE, after).map((f) => [f.kind, f.severity])).toEqual([
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

describe("diffTestFile: new and changed tests that check nothing", () => {
  function diffIn(
    file: string,
    before: string | null,
    after: string | null,
  ): Finding[] {
    return [...diffTestFile({ file, before, after })];
  }

  /** Kinds for `test` added to BASE, the info ones left out. */
  function added(test: string, head = ""): string[] {
    return flagged(BASE, `${head}${BASE}\n${test}\n`);
  }

  /** One new Playwright test with `body` as its statements. */
  function playwright(body: string): string {
    return `test("new", async ({ page, request }) => {\n${body}\n});`;
  }

  it("reports a new test with no assertion, beside test-added", () => {
    const after = `${BASE}\n${playwright(`await page.goto("/");\nawait page.getByRole("button").click();`)}\n`;
    expect(diff(BASE, after)).toEqual([
      {
        kind: "test-added",
        severity: "info",
        file: "a.spec.ts",
        test: ["new"],
        line: 16,
        message: "test added: new",
      },
      {
        kind: "test-without-assertion",
        severity: "weakening",
        file: "a.spec.ts",
        test: ["new"],
        line: 16,
        message:
          "new has no assertion (no expect, no toSatisfy), so it fails only if a step throws",
      },
    ]);
  });

  it("reports a new test whose assertion cannot fail, at the assertion", () => {
    const after = `${BASE}\n${playwright(`await page.goto("/");\nexpect(true).toBe(true);`)}\n`;
    expect(diff(BASE, after)).toMatchObject([
      { kind: "test-added", line: 16 },
      {
        kind: "assertion-cannot-fail",
        severity: "weakening",
        test: ["new"],
        line: 18,
        message:
          "new: its only assertion tests a literal, so its outcome does not depend on the code under test",
      },
    ]);
  });

  it("reports a new test whose assertion may be out of sight as review", () => {
    const after = `${BASE}\n${playwright("await checkCheckout(page);")}\n`;
    expect(diff(BASE, after)).toMatchObject([
      {
        kind: "assertion-not-visible",
        severity: "review",
        test: ["new"],
        line: 16,
        message:
          "new has no expect of its own: the assertion may be in code the guard cannot read (checkCheckout())",
      },
      { kind: "test-added" },
    ]);
  });

  it("reports a new test that only checks its own mock as review", () => {
    const after = `${BASE}\nit("new", () => {\n  const fn = vi.fn();\n  fn(1);\n  expect(fn).toHaveBeenCalledWith(1);\n});\n`;
    expect(diff(BASE, after)).toMatchObject([
      { kind: "test-added" },
      {
        kind: "only-checks-mocks",
        severity: "review",
        test: ["new"],
        line: 19,
        message:
          "new: every assertion is on a mock the test made and only called itself (fn), so nothing the code under test did is checked",
      },
    ]);
  });

  it.each([
    ["an empty body", `test("new", () => {});`, "test-without-assertion"],
    [
      "an empty Jest or Vitest test",
      `it("new", () => {});`,
      "test-without-assertion",
    ],
    [
      "an imported helper",
      playwright("await checkCheckout(page);"),
      "assertion-not-visible",
    ],
    [
      "a page-object method",
      playwright("await new CheckoutPage(page).expectPaid();"),
      "assertion-not-visible",
    ],
    [
      "node:assert",
      `it("new", () => { assert.equal(add(1, 1), 2); });`,
      "assertion-not-visible",
    ],
    [
      "supertest",
      `it("new", async () => { await request(app).get("/").expect(200); });`,
      "assertion-not-visible",
    ],
    [
      "a throw by hand",
      playwright(`if (!(await page.title())) throw new Error("no title");`),
      "assertion-not-visible",
    ],
    [
      "literal against literal",
      playwright("expect(1).toEqual(1);"),
      "assertion-cannot-fail",
    ],
    [
      "a truthy literal",
      playwright(`expect("a").toBeTruthy();`),
      "assertion-cannot-fail",
    ],
    [
      "an empty array's length",
      playwright("expect([]).toHaveLength(0);"),
      "assertion-cannot-fail",
    ],
    [
      // Changed on purpose, from assertion-cannot-fail: it fails whenever it
      // is reached, which is how a test marks a line that must not run.
      "a constant that always fails",
      playwright("expect(1).toBe(2);"),
      "assertion-not-visible",
    ],
    [
      "a value compared with itself",
      playwright(
        "const total = await page.title();\nexpect(total).toEqual(total);",
      ),
      "assertion-cannot-fail",
    ],
    [
      "a property compared with itself",
      `it("new", () => { expect(user.name).toBe(user.name); });`,
      "assertion-cannot-fail",
    ],
    [
      "expect.soft on literals",
      playwright("expect.soft(1).toBe(1);"),
      "assertion-cannot-fail",
    ],
    [
      ".not on literals",
      playwright("expect(1).not.toBe(2);"),
      "assertion-cannot-fail",
    ],
    [
      // Changed on purpose, from assertion-cannot-fail: `.resolves` on a
      // value that is not a promise fails, so the guard cannot call it safe.
      ".resolves on literals",
      playwright("await expect(1).resolves.toBe(1);"),
      "assertion-not-visible",
    ],
    // The next three were silent. Changed on purpose: an empty body is empty
    // for every row and every title.
    [
      "an empty parameterised test",
      `test.each([1, 2])("new %i", () => {});`,
      "test-without-assertion",
    ],
    [
      "an empty test under a parameterised describe",
      `describe.each([1, 2])("group %i", () => {\n  it("new", () => {});\n});`,
      "test-without-assertion",
    ],
    [
      "an empty test whose title is not a literal",
      "test(`new ${n}`, () => {});",
      "test-without-assertion",
    ],
    [
      "a jest mock called by the test",
      `it("new", () => { const fn = jest.fn(); fn(); expect(fn).toHaveBeenCalled(); });`,
      "only-checks-mocks",
    ],
  ])("flags a new test with %s", (_name, test, expected) => {
    expect(added(test)).toEqual([expected]);
  });

  it.each([
    ["a real assertion", playwright(`await expect(page).toHaveTitle("Shop");`)],
    [
      "a value against a literal",
      `it("new", () => { expect(add(1, 1)).toBe(2); });`,
    ],
    [
      "expect.soft",
      playwright(`expect.soft(page.getByRole("status")).toBeVisible();`),
    ],
    [
      "expect.poll",
      playwright(`await expect.poll(() => page.title()).toBe("Shop");`),
    ],
    [
      ".resolves",
      playwright(`await expect(page.title()).resolves.toBe("Shop");`),
    ],
    [".not", playwright(`await expect(page).not.toHaveTitle("Error");`)],
    [
      "one real assertion among weak ones",
      playwright(
        `expect(true).toBe(true);\nexpect(page).toBe(page);\nexpect(await page.title()).toBe("Shop");`,
      ),
    ],
    [
      "calls compared with each other",
      `it("new", () => { expect(next()).toBe(next()); });`,
    ],
    [
      "a mock handed to the code under test",
      `it("new", () => { const onPaid = vi.fn(); pay(order, onPaid); expect(onPaid).toHaveBeenCalled(); });`,
    ],
    [
      "a parameterised test that reads its row in a self-comparison",
      `test.each([1, 2])("new %i", (n) => { expect(n).toBe(n); });`,
    ],
    ["it.todo", `it.todo("new");`],
    // Was test-without-assertion. Changed on purpose: a new skipped test is
    // reported as added and skipped, and judged when the skip comes off.
    ["a skipped test with an empty body", `test.fixme("new", async () => {});`],
    ["it.skip", `it.skip("new", () => {});`],
    ["xit", `xit("new", () => {});`],
    [
      "test.skip() in the body",
      playwright(`test.skip();\nawait page.goto("/");`),
    ],
    [
      "a test under a skipped describe",
      `describe.skip("later", () => {\n  it("new", () => {});\n});`,
    ],
    [
      "a test marked as expected to fail",
      `test.fail("new", async ({ page }) => {\n  await page.goto("/");\n});`,
    ],
    [
      "a test that checks types",
      `it("new", () => {\n  expectTypeOf(add).toBeFunction();\n});`,
    ],
    [
      "a matcher the project defines, on a literal",
      `it("new", () => { expect(5).toBeWithinRange(1, 10); });`,
    ],
  ])("stays silent on a new test with %s", (_name, test) => {
    expect(added(test)).toEqual([]);
  });

  // Moved from the silent list above. Changed on purpose: with toSatisfy
  // advisory, the default, a new test checked by toSatisfy alone is
  // reported for review; with toSatisfy blocking it is silent as before.
  it("reports a new test checked by toSatisfy alone only while toSatisfy is advisory", () => {
    const test = playwright(
      `await expect(page).toSatisfy("The cart is empty");`,
    );
    // Changed on purpose: only `@jevyjs/playwright`'s toSatisfy is advisory,
    // and BASE imports `@playwright/test`, whose expect throws on it.
    expect(added(test)).toEqual([]);
    const jevy = BASE.replace('"@playwright/test"', '"@jevyjs/playwright"');
    expect(flagged(jevy, `${jevy}\n${test}\n`)).toEqual([
      "only-advisory-assertions",
    ]);
    const after = `${jevy}\n${test}\n`;
    expect(
      diffTestFile({
        file: "a.spec.ts",
        before: jevy,
        after,
        toSatisfyBlocking: true,
      })
        .filter((found) => found.severity !== "info")
        .map((found) => found.kind),
    ).toEqual([]);
  });

  // Changed on purpose: these three were silent. A table or a title the
  // body never reads cannot make a constant assertion real.
  it.each([
    [
      "a parameterised test that asserts on constants",
      `test.each([1, 2])("new %i", () => { expect(1).toBe(1); });`,
    ],
    [
      "a test under a parameterised describe that asserts on constants",
      `describe.each([1, 2])("group %i", () => {\n  it("new", () => { expect(1).toBe(1); });\n});`,
    ],
    [
      "a test whose title is not a literal that asserts on constants",
      "test(`new ${n}`, () => { expect(true).toBe(true); });",
    ],
  ])("reports a new test with %s", (_name, test) => {
    expect(added(test)).toEqual(["assertion-cannot-fail"]);
  });

  it("looks into a helper in the same file", () => {
    const helper = `async function expectPaid(page) {\n  await expect(page.getByRole("status")).toHaveText("Paid");\n}\n`;
    expect(added(playwright("await expectPaid(page);"), helper)).toEqual([]);
    const plain = `async function open(page) {\n  await page.goto("/");\n}\n`;
    expect(added(playwright("await open(page);"), plain)).toEqual([
      "test-without-assertion",
    ]);
  });

  it("names the title path of a new test inside nested describes", () => {
    const after = BASE.replace(
      '  test("shows the total"',
      '  test.describe("refund", () => {\n    test("returns the money", async ({ page }) => {\n      await page.goto("/refund");\n    });\n  });\n\n  test("shows the total"',
    );
    expect(diff(BASE, after)).toMatchObject([
      { kind: "test-added", test: ["checkout", "refund", "returns the money"] },
      {
        kind: "test-without-assertion",
        test: ["checkout", "refund", "returns the money"],
        line: 12,
        message: expect.stringMatching(
          /^checkout > refund > returns the money has no assertion /,
        ) as string,
      },
    ]);
  });

  it("flags every weak test of a new file, sorted", () => {
    const after = `test("b", () => { expect(1).toBe(1); });\ntest("a", () => {});\n`;
    expect(diff(null, after).map((f) => [f.line, f.kind])).toEqual([
      [1, "assertion-cannot-fail"],
      [1, "test-added"],
      [2, "test-added"],
      [2, "test-without-assertion"],
    ]);
  });

  it("reads JavaScript and TSX files", () => {
    expect(
      diffIn(
        "a.test.js",
        null,
        `it('x', () => { expect(true).toBe(true) })`,
      ).map((f) => f.kind),
    ).toEqual(["assertion-cannot-fail", "test-added"]);
    const tsx = `it("clicks", () => {\n  const onClick = vi.fn();\n  render(<Button onClick={onClick} />);\n  expect(onClick).toHaveBeenCalled();\n});\nit("renders", () => {\n  render(<App />);\n});\n`;
    expect(
      diffIn("a.test.tsx", null, tsx).map((f) => [f.line, f.kind]),
    ).toEqual([
      [1, "test-added"],
      [6, "assertion-not-visible"],
      [6, "test-added"],
    ]);
  });

  const WEAK = `test("opens", async ({ page }) => {\n  await page.goto("/");\n});\n\ntest("sums", () => {\n  expect(2).toBe(2);\n});\n`;

  it.each([
    ["unchanged", WEAK],
    [
      "reformatted",
      WEAK.replace(
        'await page.goto("/");',
        "// open\n  await page.goto( '/' );",
      ),
    ],
    [
      "moved",
      WEAK.replace(
        /(test\("opens"[\s\S]*?\n\}\);\n)\n(test\("sums"[\s\S]*?\n\}\);\n)/,
        "$2\n$1",
      ),
    ],
    [
      "beside a new, real test",
      `${WEAK}\ntest("adds", () => { expect(add(1, 1)).toBe(2); });\n`,
    ],
  ])("leaves a weak test alone when it is %s", (_name, after) => {
    expect(flagged(WEAK, after)).toEqual([]);
  });

  it("leaves a renamed weak test alone when its body is the same", () => {
    expect(kinds(WEAK, WEAK.replace('"opens"', '"opens the shop"'))).toEqual([
      "test-renamed",
    ]);
  });

  it("flags a weak test that was changed, even if it was as weak before", () => {
    const after = WEAK.replace('goto("/")', 'goto("/shop")').replace(
      "expect(2).toBe(2)",
      "expect(3).toBe(3)",
    );
    expect(diff(WEAK, after).map((f) => [f.line, f.kind, f.test])).toEqual([
      [1, "test-without-assertion", ["opens"]],
      [5, "assertion-changed", ["sums"]],
      [6, "assertion-cannot-fail", ["sums"]],
    ]);
  });

  it("flags a weak test whose only change is a renamed variable", () => {
    const before = `it("x", () => {\n  const a = 1;\n  expect(a).toBe(a);\n});\n`;
    const after = `it("x", () => {\n  const sum = 1;\n  expect(sum).toBe(sum);\n});\n`;
    expect(kinds(before, after)).toEqual(["assertion-cannot-fail"]);
  });

  it("flags a test that lost all its assertions twice: for the loss and for the result", () => {
    const after = BASE.replace(
      "    expect(await total(page)).toBe(42);\n",
      "    await total(page);\n",
    );
    expect(diff(BASE, after).map((f) => [f.kind, f.severity])).toEqual([
      ["assertion-not-visible", "review"],
      ["assertion-removed", "weakening"],
    ]);
    const emptied = BASE.replace(
      "    expect(await total(page)).toBe(42);\n",
      "",
    );
    expect(kinds(BASE, emptied)).toEqual([
      "assertion-removed",
      "test-without-assertion",
    ]);
  });

  it("flags a test that turned from it.todo into an empty body", () => {
    expect(kinds(`it.todo("x");`, `it("x", () => {});`)).toEqual([
      "test-without-assertion",
    ]);
  });

  // Both tests below changed on purpose: an emptied body used to pass
  // unjudged when the title was computed or the test parameterised.
  it("reports a changed test whose title is not a literal as dynamic-title, and judges an emptied body", () => {
    const before = "test(`case ${n}`, () => { expect(n).toBe(1); });";
    const after = "test(`case ${n}`, () => {});";
    expect(kinds(before, after)).toEqual([
      "dynamic-title",
      "test-without-assertion",
    ]);
    expect(kinds(null, after)).toEqual([
      "test-added",
      "test-without-assertion",
    ]);
    // Changed on purpose: this was dynamic-title alone. The body reads
    // nothing from the title or the loop, so its assertion cannot fail.
    const weaker = "test(`case ${n}`, () => { expect(1).toBe(1); });";
    expect(kinds(before, weaker)).toEqual([
      "assertion-cannot-fail",
      "dynamic-title",
    ]);
  });

  it("flags a changed parameterised test only when its body is left empty", () => {
    const before = `test.each([1, 2])("n %i", (n) => { expect(n).toBeGreaterThan(0); });`;
    const after = `test.each([1, 2])("n %i", (n) => {});`;
    expect(kinds(before, after)).toEqual([
      "assertion-removed",
      "test-without-assertion",
    ]);
    const constant = `test.each([1, 2])("n %i", (n) => { expect(n).toBe(n); });`;
    expect(kinds(before, constant)).toEqual(["assertion-changed"]);
  });

  it.each([
    ["a dropped semicolon", `const a = 1;`, `const a = 1`],
    [
      "a trailing comma",
      `const a = [1, 2];`,
      `const a = [\n    1,\n    2,\n  ];`,
    ],
    [
      "a trailing comma in a call",
      `console.log("a", "b");`,
      `console.log(\n    "a",\n    "b",\n  );`,
    ],
    [
      "parentheses around one arrow parameter",
      `[1].forEach(x => x);`,
      `[1].forEach((x) => x);`,
    ],
    ["a string turned into a template", `const a = "x";`, "const a = `x`;"],
    ["single quotes", `const a = "x";`, `const a = 'x';`],
  ])("does not take %s for a change to the test", (_name, was, now) => {
    const before = `it("t", () => {\n  ${was}\n});\n`;
    const after = `it("t", () => {\n  ${now}\n});\n`;
    expect(diff(before, after)).toEqual([]);
    expect(diff(after, before)).toEqual([]);
  });

  it.each([
    ["a changed value", `const a = 1;`, `const a = 2;`],
    [
      "a call made into two statements",
      `const a = f\n  (1)`,
      `const a = f;\n  (1)`,
    ],
    [
      "a second arrow parameter",
      `[1].forEach(x => x);`,
      `[1].forEach((x, i) => x);`,
    ],
    [
      "a template that now reads a value",
      "const a = `x`;",
      "const a = `x${1}`;",
    ],
    ["an empty for header", `for (;;) break;`, `for (; false; ) break;`],
  ])("still judges the test after %s", (_name, was, now) => {
    const before = `it("t", () => {\n  ${was}\n});\n`;
    const after = `it("t", () => {\n  ${now}\n});\n`;
    expect(flagged(before, after)).toHaveLength(1);
    expect(flagged(before, after)[0]).toMatch(
      /^(test-without-assertion|assertion-not-visible)$/,
    );
  });

  it("does not let a formatter's edit hide a skip or a lost assertion", () => {
    const before = `it("t", () => {\n  expect(add(1, 1)).toBe(2);\n});\n`;
    expect(
      kinds(before, before.replace("it(", "it.skip(").replace(";\n}", "\n}")),
    ).toEqual(["skip-added"]);
    expect(kinds(before, `it("t", () => {\n  add(1, 1)\n});\n`)).toEqual([
      "assertion-not-visible",
      "assertion-removed",
    ]);
  });

  it("gives the same findings on every run", () => {
    const after = `${WEAK}\ntest("c", () => {});\ntest("b", () => { expect(1).toBe(1); });\n`;
    expect(diff(WEAK, after)).toEqual(diff(WEAK, after));
    expect(diff(WEAK, after).map((f) => [f.line, f.kind])).toEqual([
      [9, "test-added"],
      [9, "test-without-assertion"],
      [10, "assertion-cannot-fail"],
      [10, "test-added"],
    ]);
  });
});

describe("diffTestFile: weak tests that a change brings back, or leaves alone", () => {
  const HEAD = `import { test, expect, describe } from "vitest";\n`;

  it.each([
    [
      "a skip",
      `${HEAD}test.skip("t", () => { const x = 1; });\n`,
      `${HEAD}test("t", () => { const x = 1; });\n`,
      "test-without-assertion",
    ],
    [
      "a skip on its describe",
      `${HEAD}describe.skip("d", () => {\n  test("t", () => { const x = 1; });\n});\n`,
      `${HEAD}describe("d", () => {\n  test("t", () => { const x = 1; });\n});\n`,
      "test-without-assertion",
    ],
    [
      "an expected-failure marker",
      `${HEAD}test.fails("t", () => { expect(1).toBe(1); });\n`,
      `${HEAD}test("t", () => { expect(1).toBe(1); });\n`,
      "assertion-cannot-fail",
    ],
  ])(
    "judges an untouched body when %s comes off",
    (_name, before, after, weak) => {
      expect(kinds(before, after)).toContain(weak);
    },
  );

  it("leaves a weak test alone when it is renamed and reformatted", () => {
    const before = `${HEAD}test("old", () => { const x = 1 })\n`;
    const after = `${HEAD}test("new", () => { const x = 1; })\n`;
    // Which findings name the rename does not change: only the weak one goes.
    expect(kinds(before, after)).toEqual(["test-added", "test-removed"]);
  });

  it("leaves a weak test alone when a test with the same title is put in front of it", () => {
    const before = `${HEAD}test("t", () => { const x = 1; });\n`;
    const after = `${HEAD}test("t", () => { expect(Date.now()).toBeGreaterThan(0); });\ntest("t", () => { const x = 1; });\n`;
    expect(flagged(before, after)).not.toContain("test-without-assertion");
  });

  it("leaves weak tests alone when two with the same title swap places", () => {
    const before = `${HEAD}test("t", () => { const x = 1; });\ntest("t", () => { expect(Date.now()).toBeGreaterThan(0); });\n`;
    const after = `${HEAD}test("t", () => { expect(Date.now()).toBeGreaterThan(0); });\ntest("t", () => { const x = 1; });\n`;
    expect(flagged(before, after)).not.toContain("test-without-assertion");
  });

  it("still judges a copy of a weak test that is new", () => {
    const before = `${HEAD}test("t", () => { const x = 1; });\n`;
    const after = `${before}test("t", () => { const x = 1; });\n`;
    expect(kinds(before, after)).toEqual([
      "test-added",
      "test-without-assertion",
    ]);
  });
});
