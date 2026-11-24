import { describe, expect, it } from "vitest";
import { parseTestFile } from "./parse.js";
import type { Finding } from "./types.js";
import { weakTestFinding } from "./weak-tests.js";

/** The verdict on the first test of `text`. */
function verdict(text: string, fileName = "a.spec.ts"): Finding | null {
  const result = parseTestFile(text, fileName);
  if (!result.ok) {
    throw new Error(`unexpected parse error: ${result.error}`);
  }
  const test = result.value.tests[0];
  if (test === undefined) {
    throw new Error("the fixture has no test");
  }
  return weakTestFinding(fileName, test);
}

function kind(text: string, fileName?: string): string | null {
  return verdict(text, fileName)?.kind ?? null;
}

/** One Playwright test with `body` as its statements. */
function playwright(body: string): string {
  return `test("pays", async ({ page, request }) => {\n${body}\n});`;
}

describe("weakTestFinding: a test with no assertion", () => {
  it("reports an empty body", () => {
    expect(verdict(`test("x", () => {});`)).toEqual({
      kind: "test-without-assertion",
      severity: "weakening",
      file: "a.spec.ts",
      test: ["x"],
      line: 1,
      message:
        "x has no assertion (no expect, no toSatisfy), so it fails only if a step throws",
    });
  });

  it("reports a body that only drives fixtures", () => {
    const text = playwright(
      `await page.goto("/");\nawait page.getByRole("button").click();`,
    );
    expect(kind(text)).toBe("test-without-assertion");
  });

  it("reports a test whose same-file helper has no expect either", () => {
    const text = `
      async function open(page) {
        await page.goto("/");
      }
      test("opens", async ({ page }) => {
        await open(page);
      });
    `;
    expect(verdict(text)).toMatchObject({
      kind: "test-without-assertion",
      test: ["opens"],
      line: 5,
    });
  });

  it("is silent when a same-file helper has the expect", () => {
    const text = `
      async function expectPaid(page) {
        await expect(page.getByRole("status")).toHaveText("Paid");
      }
      test("pays", async ({ page }) => {
        await expectPaid(page);
      });
    `;
    expect(verdict(text)).toBeNull();
  });

  it("asks for a look when an imported helper may assert", () => {
    const text = `import { checkCheckout } from "./helpers";\n${playwright("await checkCheckout(page);")}`;
    expect(verdict(text)).toEqual({
      kind: "assertion-not-visible",
      severity: "review",
      file: "a.spec.ts",
      test: ["pays"],
      line: 2,
      message:
        "pays has no expect of its own: the assertion may be in code the guard cannot read (checkCheckout())",
    });
  });

  it.each([
    ["a page-object method", `await new CheckoutPage(page).expectPaid();`],
    ["node:assert", `assert.equal(await page.title(), "Shop");`],
    ["supertest", `await supertest(app).get("/").expect(200);`],
    ["a chai-style chain", `chai.expect(1).to.equal(1);`],
    ["a wait", `await page.waitForURL("**/done");`],
    ["an unknown value handed on", `await page.route("**", handler);`],
  ])("asks for a look at %s", (_name, body) => {
    expect(kind(playwright(body))).toBe("assertion-not-visible");
  });

  // Changed on purpose: an expect() with no matcher asserts nothing, and
  // expect is not code the guard cannot read. This was assertion-not-visible.
  it("reports a bare expect with no matcher on a value it can read", () => {
    expect(kind(playwright(`expect(await page.title());`))).toBe(
      "test-without-assertion",
    );
    expect(kind(`it("t", () => { expect(1); });`)).toBe(
      "test-without-assertion",
    );
  });

  it("names what a bare expect is given, not expect itself", () => {
    const text = `import { f } from "./lib";\nit("t", () => { expect(f()); });`;
    expect(verdict(text)).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "t has no expect of its own: the assertion may be in code the guard cannot read (f())",
    });
  });

  it("asks for a look at a fixture the project defined", () => {
    const text = `test("pays", async ({ checkoutPage }) => {\n  await checkoutPage.expectPaid();\n});`;
    expect(kind(text)).toBe("assertion-not-visible");
  });

  it("asks for a look, never more, when the body throws by hand", () => {
    const text = playwright(
      `if ((await page.title()) !== "Shop") {\n  throw new Error("wrong title");\n}`,
    );
    expect(verdict(text)).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "pays has no expect of its own: the assertion may be in its throw statement",
    });
  });

  it("asks for a look when a hook in the file asserts", () => {
    const text = `
      test.afterEach(async ({ page }) => {
        await expect(page.locator(".error")).toHaveCount(0);
      });
      ${playwright(`await page.goto("/");`)}
    `;
    expect(verdict(text)).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "pays has no expect of its own: the assertion may be in a hook or fixture in this file",
    });
  });

  it("gives every reason, and at most three names", () => {
    const text = `
      afterEach(() => { expect(errors).toEqual([]); });
      it("runs", () => {
        one(); two(); three(); four(); five();
        if (failed) throw new Error("failed");
      });
    `;
    expect(verdict(text)?.message).toBe(
      "runs has no expect of its own: the assertion may be in code the guard cannot read (one(), two(), three() and 3 more), its throw statement or a hook or fixture in this file",
    );
  });
});

describe("weakTestFinding: assertions that cannot fail", () => {
  it("reports a literal tested against a literal, at the assertion's line", () => {
    const text = playwright(`await page.goto("/");\nexpect(true).toBe(true);`);
    expect(verdict(text)).toEqual({
      kind: "assertion-cannot-fail",
      severity: "weakening",
      file: "a.spec.ts",
      test: ["pays"],
      line: 3,
      message:
        "pays: its only assertion tests a literal, so its outcome does not depend on the code under test",
    });
  });

  it("reports a value compared with itself", () => {
    const text = playwright(
      `const total = await page.title();\nexpect(total).toEqual(total);`,
    );
    expect(verdict(text)).toMatchObject({
      kind: "assertion-cannot-fail",
      line: 3,
      message:
        "pays: its only assertion compares a value with itself, so its outcome does not depend on the code under test",
    });
  });

  it("reports several, and says so", () => {
    const text = playwright(
      `expect(1).toEqual(1);\nexpect("a").toBeTruthy();\nexpect([]).toHaveLength(0);`,
    );
    expect(verdict(text)?.message).toBe(
      "pays: all 3 assertions test a literal, so their outcome does not depend on the code under test",
    );
    const mixed = playwright(
      `expect(2).toBe(2);\nexpect(user.name).toBe(user.name);`,
    );
    expect(verdict(mixed)).toMatchObject({
      kind: "assertion-cannot-fail",
      line: 2,
      message:
        "pays: all 2 assertions test a literal or compare a value with itself, so their outcome does not depend on the code under test",
    });
    // Changed on purpose: expect(1).toBe(2) fails whenever it is reached, so
    // it may be a marker. This pair was assertion-cannot-fail.
    const failing = playwright(
      `expect(1).toBe(2);\nexpect(user.name).toBe(user.name);`,
    );
    expect(verdict(failing)).toMatchObject({
      kind: "assertion-not-visible",
      severity: "review",
      line: 2,
      message:
        "pays: all 2 assertions test a literal or compare a value with itself, but the real check may be in an assertion on constants that fails, or may fail, when it is reached",
    });
  });

  it.each([
    ["expect.soft", `expect.soft(1).toBe(1);`],
    [".not", `expect(1).not.toBe(2);`],
  ])("reports the %s form", (_name, body) => {
    expect(kind(playwright(body))).toBe("assertion-cannot-fail");
  });

  // Changed on purpose: both were assertion-cannot-fail. `.resolves` on a
  // value that is not a promise fails in Jest and Vitest, and a value is
  // always itself, so `.not` fails too: each is a marker at most.
  it.each([
    [".resolves", `await expect(1).resolves.toBe(1);`],
    [".not on a self-comparison", `expect(page).not.toBe(page);`],
  ])("asks for a look at the %s form", (_name, body) => {
    expect(kind(playwright(body))).toBe("assertion-not-visible");
  });

  it.each([
    ["a value against a literal", `expect(await page.title()).toBe("Shop");`],
    ["a call compared with a call", `expect(next()).toBe(next());`],
    ["toSatisfy", `await expect(page).toSatisfy("The order is confirmed");`],
    ["toSatisfy on a literal", `await expect("x").toSatisfy("x");`],
    ["expect.soft", `expect.soft(page.getByRole("status")).toBeVisible();`],
    ["expect.poll", `await expect.poll(() => page.title()).toBe("Shop");`],
    [".resolves", `await expect(page.title()).resolves.toBe("Shop");`],
    [".not", `await expect(page).not.toHaveTitle("Error");`],
    [
      "one real assertion among weak ones",
      `expect(true).toBe(true);
       expect(1).toBe(1);
       expect(page).toBe(page);
       await expect(page.getByRole("status")).toHaveText("Paid");`,
    ],
  ])("is silent for %s", (_name, body) => {
    expect(verdict(playwright(body))).toBeNull();
  });
});

describe("weakTestFinding: constant assertions beside a check made by hand", () => {
  it.each([
    [
      "a throw",
      `try {\n  parse("{");\n} catch {\n  expect(true).toBe(true);\n  return;\n}\nthrow new Error("did not throw");`,
      "code the guard cannot read (parse()) or its throw statement",
    ],
    [
      "fail()",
      `try {\n  parse("{");\n  fail("did not throw");\n} catch {\n  expect(true).toBe(true);\n}`,
      "code the guard cannot read (parse()) or a check made by hand (fail(), an assertion count or a done callback)",
    ],
    [
      "an assertion count",
      `expect.assertions(1);\ntry {\n  parse("{");\n} catch {\n  expect(true).toBe(true);\n}`,
      "code the guard cannot read (parse()) or a check made by hand (fail(), an assertion count or a done callback)",
    ],
  ])("asks for a look, and does not block, beside %s", (_name, body, where) => {
    // The message changed on purpose: it now names each place the check may
    // be, as the no-assertion finding does.
    expect(verdict(`it("rejects", () => {\n${body}\n});`)).toMatchObject({
      kind: "assertion-not-visible",
      severity: "review",
      test: ["rejects"],
      message: `rejects: its only assertion tests a literal, but the real check may be in ${where}`,
    });
  });

  it("asks for a look at a done-style test", () => {
    const text = `it("emits", (done) => {\n  emitter.on("x", () => {\n    expect(true).toBe(true);\n    expect(1).toBe(1);\n    done();\n  });\n});`;
    expect(verdict(text)).toMatchObject({
      kind: "assertion-not-visible",
      line: 3,
      message:
        "emits: all 2 assertions test a literal, but the real check may be in code the guard cannot read (emitter.on(), done()) or a check made by hand (fail(), an assertion count or a done callback)",
    });
  });

  it("does not take a parameter the body never uses for a done callback", () => {
    expect(kind(`it("t", (_ctx) => { expect(true).toBe(true); });`)).toBe(
      "assertion-cannot-fail",
    );
    expect(kind(`it("t", (_ctx) => {});`)).toBe("test-without-assertion");
  });
});

describe("weakTestFinding: assertions on the test's own mocks", () => {
  it("reports a mock the test made, called and then checked", () => {
    const text = `
      it("calls back", () => {
        const fn = vi.fn();
        fn(1);
        expect(fn).toHaveBeenCalledWith(1);
      });
    `;
    expect(verdict(text, "a.test.ts")).toEqual({
      kind: "only-checks-mocks",
      severity: "review",
      file: "a.test.ts",
      test: ["calls back"],
      line: 5,
      message:
        "calls back: every assertion is on a mock the test made and only called itself (fn), so nothing the code under test did is checked",
    });
  });

  it("reports the mix of constant and own-mock assertions as review, not weakening", () => {
    const text = `
      it("calls back", () => {
        const fn = jest.fn();
        const other = jest.fn();
        fn();
        expect(true).toBe(true);
        expect(fn).toHaveBeenCalled();
      });
    `;
    expect(verdict(text)).toMatchObject({
      kind: "only-checks-mocks",
      severity: "review",
      line: 6,
      message:
        "calls back: every assertion is on a literal, a value compared with itself, or a mock the test made and only called itself (fn), so nothing the code under test did is checked",
    });
  });

  it.each([
    [
      "a mock handed to the code under test",
      `const onPaid = vi.fn();
       pay(order, onPaid);
       expect(onPaid).toHaveBeenCalled();`,
    ],
    [
      "one real assertion beside the mock",
      `const fn = vi.fn();
       fn(1);
       expect(fn).toHaveBeenCalledWith(1);
       expect(total(order)).toBe(42);`,
    ],
    [
      "a mock that wraps real code",
      `const add = vi.fn(realAdd);
       add(1, 1);
       expect(add).toHaveReturnedWith(2);`,
    ],
  ])("is silent for %s", (_name, body) => {
    expect(verdict(`it("t", () => {\n${body}\n});`)).toBeNull();
  });

  it("is silent for a mock handed to a component in a TSX file", () => {
    const text = `
      it("clicks", () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick} />);
        screen.getByRole("button").click();
        expect(onClick).toHaveBeenCalled();
      });
    `;
    expect(verdict(text, "a.test.tsx")).toBeNull();
  });
});

describe("weakTestFinding: parameterised tests and titles that are not literals", () => {
  // Changed on purpose: these three were silent, which exempted every test
  // under describe(Thing.name, …). An empty body is empty for every row.
  it.each([
    ["a parameterised test", `test.each([1, 2])("n %i", (n) => {});`],
    ["a one-row table", `it.each([0])("t", () => {});`],
    ["a test whose title is not a literal", "test(`case ${n}`, () => {});"],
    ["a title built from literals", `it("a" + "b", () => {});`],
    [
      "a test under a describe whose title is not a literal",
      `describe(name, () => {\n  it("x", () => {});\n});`,
    ],
    [
      "a test under a describe named after the code under test",
      `import { f } from "./lib";\ndescribe(f.name, () => {\n  it("t", () => {});\n});`,
    ],
    [
      "a test under a parameterised describe",
      `describe.each([1, 2])("group %i", (n) => {\n  it("x", () => {});\n});`,
    ],
    [
      "a row used as plain data",
      `it.each([1, 2])("n %i", (n) => {\n  console.log(n, String(n));\n});`,
    ],
    [
      "a row of an object table used as plain data",
      `test.each([{ path: "/" }])("opens", async ({ path }) => {\n  console.log(path);\n});`,
    ],
  ])("reports %s with an empty body", (_name, text) => {
    expect(kind(text)).toBe("test-without-assertion");
  });

  it.each([
    ["called", `it.each([[check]])("t", (run) => {\n  run();\n});`],
    ["awaited", `it.each([[pending]])("t", async (p) => {\n  await p;\n});`],
    ["asked to act", `it.each([[api]])("t", (row) => {\n  row.verify();\n});`],
  ])("asks for a look when a row is %s", (_name, text) => {
    expect(kind(text)).toBe("assertion-not-visible");
  });

  it.each([
    [
      "a constant assertion in a parameterised test",
      `it.each([1, 2])("n %i", (n) => {\n  expect(1).toBe(1);\n});`,
    ],
    [
      "a self-comparison in a parameterised test",
      `it.each([1, 2])("n %i", (n) => {\n  expect(n).toBe(n);\n});`,
    ],
    [
      "an own mock in a parameterised test",
      `it.each([1, 2])("n %i", (n) => {\n  const fn = vi.fn();\n  fn(n);\n  expect(fn).toHaveBeenCalled();\n});`,
    ],
    [
      "a test under a parameterised describe",
      `describe.each([1, 2])("group %i", (n) => {\n  it("x", () => { expect(1).toBe(1); });\n});`,
    ],
    [
      "a constant assertion under a title that is not a literal",
      "test(`case ${n}`, () => {\n  expect(true).toBe(true);\n});",
    ],
    ["it.todo", `it.todo("later");`],
  ])("is silent for %s", (_name, text) => {
    expect(verdict(text)).toBeNull();
  });
});

describe("weakTestFinding: tests it leaves alone", () => {
  it("names the whole title path of a test inside nested describes", () => {
    const text = `
      describe("shop", () => {
        describe("checkout", () => {
          it("pays", () => {
            expect(1).toBe(1);
          });
        });
      });
    `;
    expect(verdict(text)).toMatchObject({
      kind: "assertion-cannot-fail",
      test: ["shop", "checkout", "pays"],
      line: 5,
      message: expect.stringMatching(/^shop > checkout > pays: /) as string,
    });
  });

  it("reads JavaScript and TSX files", () => {
    expect(
      kind(`it('x', () => { expect(true).toBe(true) })`, "a.test.js"),
    ).toBe("assertion-cannot-fail");
    expect(kind(`it("x", () => { render(<App />); });`, "a.test.tsx")).toBe(
      "assertion-not-visible",
    );
    expect(kind(`it("x", () => { const el = <App />; });`, "a.test.tsx")).toBe(
      "test-without-assertion",
    );
  });
});

/** `text` in a file that imports what the snippets below use. */
function withLib(text: string): string {
  return `import { f, checkAll, screen, stream, cfg, xs, MOCK_ROUTES } from "./lib";\n${text}`;
}

describe("weakTestFinding: every verdict weighs the same evidence", () => {
  it("is silent when a helper the test calls can fail, whatever else it asserts", () => {
    const text = withLib(`
      function check(v) { expect(v).toBe(1); }
      it("t", () => { check(f()); expect(true).toBe(true); });
    `);
    expect(verdict(text)).toBeNull();
  });

  it.each([
    [
      "a call into another file",
      `it("t", async () => { await checkAll(); expect(true).toBe(true); });`,
      "code the guard cannot read (checkAll())",
    ],
    [
      "a query that throws when it finds nothing",
      `it("t", () => { screen.getByText("Paid"); expect(true).toBe(true); });`,
      "code the guard cannot read (screen.getByText())",
    ],
    [
      "a hook that asserts",
      `afterEach(() => { expect(f()).toEqual([]); });\nit("t", () => { expect(true).toBe(true); });`,
      "a hook or fixture in this file",
    ],
  ])(
    "asks for a look at a constant assertion beside %s",
    (_name, body, where) => {
      expect(verdict(withLib(body))).toMatchObject({
        kind: "assertion-not-visible",
        severity: "review",
        message: `t: its only assertion tests a literal, but the real check may be in ${where}`,
      });
    },
  );

  it("weighs it for a test that asserts only on its own mock", () => {
    const body = `const fn = vi.fn();\n  fn(1);\n  expect(fn).toHaveBeenCalledWith(1);`;
    expect(kind(`it("t", () => {\n  ${body}\n});`)).toBe("only-checks-mocks");
    expect(
      verdict(
        withLib(`it("t", async () => {\n  await checkAll();\n  ${body}\n});`),
      ),
    ).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "t: every assertion is on a mock the test made and only called itself (fn), but the real check may be in code the guard cannot read (checkAll())",
    });
    const helper = `function check(v) { expect(v).toBe(1); }\n`;
    expect(
      verdict(
        withLib(`${helper}it("t", () => {\n  check(f());\n  ${body}\n});`),
      ),
    ).toBeNull();
  });

  it("does not trust a mock factory the file imports from elsewhere", () => {
    const text = `import { vi } from "./fakes";\nit("t", () => {\n  const fn = vi.fn();\n  fn();\n});`;
    expect(kind(text)).toBe("assertion-not-visible");
    const real = `import { vi } from "vitest";\nit("t", () => {\n  const fn = vi.fn();\n  fn();\n});`;
    expect(kind(real)).toBe("test-without-assertion");
  });
});

describe("weakTestFinding: an assertion on constants that fails when reached", () => {
  it.each([
    [
      "after a catch that returns",
      `it("t", async () => { try { await f(); } catch { return; } expect(true).toBe(false); });`,
    ],
    [
      "in a then callback",
      `it("t", () => { f().then(() => { expect(true).toBe(false); }, () => {}); });`,
    ],
    [
      "in the default of a switch",
      `it("t", () => { switch (f()) { case 1: break; default: expect(true).toBe(false); } });`,
    ],
  ])("is not a weakening %s", (_name, text) => {
    expect(verdict(withLib(text))).toMatchObject({
      kind: "assertion-not-visible",
      severity: "review",
    });
  });

  it.each([
    ["unequal literals", `expect(true).toBe(false);`],
    ["equal literals under .not", `expect(1).not.toBe(1);`],
    ["a truthy check of false", `expect(false).toBeTruthy();`],
    ["two fresh objects under toBe", `expect({}).toBe({});`],
    ["a result it cannot work out", `expect("abc").toMatch(/b/);`],
    [
      "an unequal object it cannot compare",
      `expect({ a: 1, b: 2 }).toEqual({ b: 2, a: 1 });`,
    ],
  ])("asks for a look at %s with nothing else in the body", (_name, body) => {
    const text = playwright(
      `if ((await page.title()) === "x") {\n  ${body}\n}`,
    );
    expect(verdict(text)).toMatchObject({
      kind: "assertion-not-visible",
      severity: "review",
      message:
        "pays: its only assertion tests a literal, but the real check may be in an assertion on constants that fails, or may fail, when it is reached",
    });
  });

  it.each([
    [`expect(false).toBe(false);`],
    [`expect(1).not.toBe(2);`],
    [`expect("a").not.toBeFalsy();`],
    [`expect(null).toBeNull();`],
    [`expect("abc").toHaveLength(3);`],
    [`expect([1, 2]).toHaveLength(2);`],
    [`expect(2).toBeGreaterThan(1);`],
    [`expect("abc").toContain("b");`],
    [`expect({ a: [1] }).toStrictEqual({ a: [1] });`],
  ])("still reports %s, which it can show to pass", (body) => {
    expect(kind(playwright(body))).toBe("assertion-cannot-fail");
  });
});

describe("weakTestFinding: matchers the project defines", () => {
  it.each([
    [`expect(5).toBeWithinRange(1, 10);`],
    [`expect("a@b.co").toBeValidEmail();`],
    [`expect("<p>x</p>").toMatchInlineSnapshot();`],
  ])("is silent for %s: the matcher is the code under test", (body) => {
    expect(verdict(`it("t", () => {\n  ${body}\n});`)).toBeNull();
  });
});

describe("weakTestFinding: checks that live elsewhere in the file's setup", () => {
  it("trusts built-in fixtures only under a test function from the framework", () => {
    const body = `test("t", async ({ page }) => {\n  await page.goto("/");\n});`;
    expect(kind(body)).toBe("test-without-assertion");
    expect(kind(`import { test } from "@playwright/test";\n${body}`)).toBe(
      "test-without-assertion",
    );
    expect(
      kind(
        `const { test } = require("@playwright/test");\n${body}`,
        "a.spec.js",
      ),
    ).toBe("test-without-assertion");
    expect(
      verdict(`import { test } from "./fixtures";\n${body}`),
    ).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "t has no expect of its own: the assertion may be in code the guard cannot read (page.goto()) or a fixture of this file's own test function",
    });
    expect(
      kind(
        `import { test as base } from "@playwright/test";\nconst test = base.extend({});\n${body}`,
      ),
    ).toBe("assertion-not-visible");
  });

  it("asks for a look at any test under a test function the file brings itself", () => {
    const head = `import { test, expect } from "./fixtures";\n`;
    expect(kind(`${head}test("t", async () => {});`)).toBe(
      "assertion-not-visible",
    );
    expect(
      kind(`${head}test("t", async () => {\n  expect(true).toBe(true);\n});`),
    ).toBe("assertion-not-visible");
    // Not a constant under a custom test function: the fixture may be anything.
    expect(
      verdict(
        `${head}test("t", async ({ page }) => {\n  expect(page).toBeTruthy();\n});`,
      ),
    ).toBeNull();
  });

  it.each([
    [
      "calls code the guard cannot read",
      `test.afterEach(async ({ page }) => {\n  await expectNoA11yViolations(page);\n});`,
    ],
    [
      "throws",
      `test.beforeEach(async ({ page }) => {\n  if ((await page.title()) === "") throw new Error("blank");\n});`,
    ],
    ["is defined in another file", `afterEach(checkConsole);`],
  ])("asks for a look when a hook %s", (_name, hook) => {
    const body = `test("t", async ({ page }) => {\n  await page.goto("/");\n});`;
    expect(verdict(`${hook}\n${body}`)).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "t has no expect of its own: the assertion may be in a hook or fixture in this file",
    });
    expect(
      kind(
        `${hook}\ntest("t", async ({ page }) => {\n  expect(1).toBe(1);\n});`,
      ),
    ).toBe("assertion-not-visible");
  });

  it("does not count a hook that only drives fixtures, or only asserts on constants", () => {
    const body = `test("t", async ({ page }) => {\n  await page.goto("/");\n});`;
    const drives = `test.beforeEach(async ({ page }) => {\n  await page.goto("/login");\n});`;
    expect(kind(`${drives}\n${body}`)).toBe("test-without-assertion");
    const constant = `afterEach(() => { expect(1).toBe(1); });`;
    expect(kind(`${constant}\nit("t", () => {});`)).toBe(
      "test-without-assertion",
    );
    expect(kind(`${constant}\nit("t", () => { expect(2).toBe(2); });`)).toBe(
      "assertion-cannot-fail",
    );
  });

  it("counts a hook only for the tests in its describe block", () => {
    const text = `
      describe("other", () => {
        afterEach(() => { expect(errors()).toEqual([]); });
        it("covered", () => {});
      });
      describe("here", () => {
        it("t", () => {});
      });
    `;
    const result = parseTestFile(text, "a.test.ts");
    const kinds = result.ok
      ? result.value.tests.map((t) => weakTestFinding("a.test.ts", t)?.kind)
      : [];
    expect(kinds).toEqual(["assertion-not-visible", "test-without-assertion"]);
  });
});

describe("weakTestFinding: code that runs without a call in sight", () => {
  it.each([
    ["an async iterator", `for await (const c of stream) {}`],
    ["a property read", `cfg.value;`],
    ["a spread", `[...xs];`],
    ["a value handed to a fixture", `await page.route("**", MOCK_ROUTES);`],
    ["a template that formats a value", "`${cfg}`;"],
  ])("asks for a look at %s from another file", (_name, body) => {
    expect(kind(withLib(playwright(body)))).toBe("assertion-not-visible");
  });

  it("asks for a look at a name the file does not define", () => {
    expect(verdict(`it("t", () => {\n  state.count;\n});`)).toMatchObject({
      kind: "assertion-not-visible",
      message:
        "t has no expect of its own: the assertion may be in code the guard cannot read (state)",
    });
  });

  it("still reports a body that reads only what it made itself", () => {
    const body = `const rows = [1, 2];\nconst [first] = rows;\nconst label = \`row \${first}\`;\nconsole.log(label, rows.length, typeof first);`;
    expect(kind(playwright(body))).toBe("test-without-assertion");
  });

  it("does not take a module-level constant for a variable of the same name in a describe block", () => {
    const text = `
      const api = "/api";
      describe("orders", () => {
        const api = createApi();
        it("t", async () => {
          await api.verify();
        });
      });
    `;
    expect(kind(text)).toBe("assertion-not-visible");
  });
});

describe("weakTestFinding: tests that check types, and tests marked to fail", () => {
  it.each([
    ["a type alias", `type Out = ReturnType<typeof f>;\nconst out: Out = 1;`],
    [
      "an interface",
      `interface Row { id: number }\nconst row: Row = { id: 1 };`,
    ],
    ["a satisfies expression", `const row = { id: 1 } satisfies Row;`],
    ["expectTypeOf", `expectTypeOf(f).toBeFunction();`],
    ["assertType", `assertType<string>(f());`],
  ])("is silent for a body with %s", (_name, body) => {
    expect(verdict(withLib(`it("t", () => {\n${body}\n});`))).toBeNull();
  });

  it("does not judge a test that is marked as expected to fail", () => {
    expect(
      verdict(
        `test.fail("t", async ({ page }) => {\n  await page.goto("/");\n});`,
      ),
    ).toBeNull();
    expect(
      verdict(
        `test("t", async ({ page }) => {\n  test.fail();\n  expect(1).toBe(1);\n});`,
      ),
    ).toBeNull();
  });
});

describe("weakTestFinding: helpers in the same file", () => {
  const REAL = `function check() { expect(f()).toBe(1); }\n`;

  it.each([
    ["only defined", `it("t", () => {});`],
    ["only named", `it("t", () => { void check; });`],
  ])("does not count a helper that is %s", (_name, test) => {
    expect(kind(withLib(`${REAL}${test}`))).toBe("test-without-assertion");
  });

  it.each([
    ["called", `it("t", () => { check(); });`],
    [
      "handed to code that calls it back",
      `it("t", () => { [1].forEach(check); });`,
    ],
    [
      "called by a helper the test calls",
      `function all() { check(); }\nit("t", () => { all(); });`,
    ],
  ])("is silent when the helper is %s", (_name, test) => {
    expect(verdict(withLib(`${REAL}${test}`))).toBeNull();
  });

  it("asks for a look when the helper is reached under another name", () => {
    expect(
      kind(withLib(`${REAL}it("t", () => { const run = check; run(); });`)),
    ).toBe("assertion-not-visible");
    expect(kind(withLib(`${REAL}it("t", () => { check.call(null); });`))).toBe(
      "assertion-not-visible",
    );
  });

  it("reports a helper whose assertions are all constant, at the test", () => {
    const text = `function check() { expect(1).toBe(1); }\nit("t", () => {\n  check();\n});`;
    expect(verdict(text)).toEqual({
      kind: "assertion-cannot-fail",
      severity: "weakening",
      file: "a.spec.ts",
      test: ["t"],
      line: 2,
      message:
        "t: its only assertion tests a literal, so its outcome does not depend on the code under test",
    });
    const both = `function check(v) { expect(v).toBe(v); }\nit("t", () => {\n  check(1);\n  expect(true).toBe(true);\n});`;
    expect(verdict(both)).toMatchObject({
      kind: "assertion-cannot-fail",
      line: 4,
      message:
        "t: all 2 assertions test a literal or compare a value with itself, so their outcome does not depend on the code under test",
    });
  });
});

describe("weakTestFinding: constant assertions in other shapes", () => {
  it.each([
    ["no subject", `expect().toBeUndefined();`],
    ["a const bound to a literal", `const a = 5;\nexpect(a).toBe(5);`],
    [
      "a const built from another",
      `const a = 5;\nconst b = a + 1;\nexpect(b).toBe(6);`,
    ],
    ["a comparison of literals", `expect(1 === 1).toBe(true);`],
    ["arithmetic on literals", `expect(1 + 1).toBe(2);`],
    ["a negated literal", `expect(!false).toBeTruthy();`],
    ["a template of literals", 'expect(`a${1}`).toBe("a1");'],
    ["a fixture that is always there", `expect(page).toBeTruthy();`],
    ["a fixture that is always defined", `expect(request).toBeDefined();`],
    ["a fixture that is never null", `expect(page).not.toBeNull();`],
    [
      "a non-null assertion on one side",
      `expect(order!.total).toEqual(order.total);`,
    ],
    [
      "a cast on one side",
      `expect((order as Order).total).toEqual(order.total);`,
    ],
    [
      "optional chaining on one side",
      `expect(order?.total).toBe(order.total);`,
    ],
  ])("reports %s", (_name, body) => {
    expect(kind(playwright(body))).toBe("assertion-cannot-fail");
  });

  it("says what a fixture check is", () => {
    expect(verdict(playwright(`expect(page).toBeTruthy();`))?.message).toBe(
      "pays: its only assertion checks that a built-in fixture exists, so its outcome does not depend on the code under test",
    );
  });

  it.each([
    [
      "a let, which may be given another value",
      `let a = 5;\na = f();\nexpect(a).toBe(5);`,
    ],
    ["a const from a call", `const a = f();\nexpect(a).toBe(5);`],
    [
      "a const array, which the body can fill",
      `const seen = [];\nrequest.on("x", (m) => seen.push(m));\nexpect(seen).toEqual([]);`,
    ],
    [
      "a const object, which the body can change",
      `const state = { n: 0 };\nstate.n += 1;\nexpect(state).toEqual({ n: 0 });`,
    ],
    [
      "a name declared twice",
      `const a = 5;\n[f()].forEach((a) => { expect(a).toBe(5); });`,
    ],
    ["a fixture the config sets", `expect(baseURL).toBeDefined();`],
    [
      "a fixture against a matcher that reads it",
      `await expect(page).toHaveTitle("Shop");`,
    ],
    [
      "a fixture the body renamed",
      `const page = f();\nexpect(page).toBeTruthy();`,
    ],
  ])("is silent for %s", (_name, body) => {
    const text = `test("pays", async ({ baseURL, request }) => {\n${body}\n});`;
    expect(verdict(withLib(text))).toBeNull();
  });
});

describe("weakTestFinding: a test function that is not the file's own to vouch for", () => {
  it("asks for a look when test is a parameter of the function around it", () => {
    const text = `
      export function suite(test) {
        test("t", async ({ page }) => {
          await page.goto("/");
        });
      }
    `;
    expect(kind(text)).toBe("assertion-not-visible");
  });
});
