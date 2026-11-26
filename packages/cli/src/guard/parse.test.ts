import { describe, expect, it } from "vitest";
import { parseTestFile, type ParsedTestFile } from "./parse.js";

function parsed(text: string, fileName = "a.spec.ts"): ParsedTestFile {
  const result = parseTestFile(text, fileName);
  if (!result.ok) {
    throw new Error(`unexpected parse error: ${result.error}`);
  }
  return result.value;
}

function titles(text: string): string[][] {
  return parsed(text).tests.map((test) => [...test.titlePath]);
}

describe("parseTestFile", () => {
  it("builds title paths through nested describes", () => {
    const text = `
      describe("cart", () => {
        describe("empty", () => {
          it("shows a hint", () => {});
        });
        it("adds an item", () => {});
      });
      test("top level", () => {});
    `;
    expect(titles(text)).toEqual([
      ["cart", "empty", "shows a hint"],
      ["cart", "adds an item"],
      ["top level"],
    ]);
  });

  it("understands test.describe and its modifiers", () => {
    const text = `
      import { test } from "@playwright/test";
      test.describe("checkout", () => {
        test.describe.serial("card", () => {
          test("pays", async () => {});
        });
        test.describe.configure({ mode: "parallel" });
        test.beforeEach(async () => {});
      });
      test.describe(() => {
        test("anonymous group", async () => {});
      });
    `;
    expect(titles(text)).toEqual([
      ["checkout", "card", "pays"],
      ["anonymous group"],
    ]);
  });

  it("reads template-literal titles and marks substituted ones dynamic", () => {
    const file = parsed(
      "test(`plain`, () => {});\nconst n = 2;\ntest(`case ${n}`, () => {});",
    );
    expect(file.tests.map((t) => [t.titlePath, t.dynamic, t.line])).toEqual([
      [["plain"], false, 1],
      [["`case ${n}`"], true, 3],
    ]);
  });

  it("reads .each forms and keeps their table", () => {
    const text = `
      test.each([1, 2])("adds %i", (n) => { expect(n).toBeGreaterThan(0); });
      it.each\`
        a | b
        \${1} | \${2}
      \`("sums $a and $b", () => {});
      describe.each([["x"]])("group %s", () => {
        it("inner", () => {});
      });
    `;
    const file = parsed(text);
    expect(file.tests.map((t) => t.titlePath)).toEqual([
      ["adds %i"],
      ["sums $a and $b"],
      ["group %s", "inner"],
    ]);
    expect(file.tests[0]?.cases).toBe("[1,2]");
    expect(file.tests[1]?.cases).not.toBeNull();
    expect(file.tests[2]?.cases).toBe('[["x"]]');
  });

  it("collects expect chains with .not, .soft, .resolves and toSatisfy", () => {
    const text = `
      test("t", async ({ page }) => {
        expect(page).not.toHaveTitle("Error");
        expect.soft(1).toBe(1);
        await expect(promise).resolves.toEqual({ a: 1 });
        await expect(page).toSatisfy("The order is confirmed", { decider: "kev" });
        await expect.poll(() => count()).toBe(3);
        expect.assertions(1);
        expect(value).toEqual(expect.any(String));
      });
    `;
    const assertions = parsed(text).tests[0]?.assertions ?? [];
    expect(
      assertions.map((a) => ({
        matcher: a.matcher,
        soft: a.soft,
        negated: a.negated,
        modifiers: a.modifiers,
        subject: a.subject,
        args: a.args,
        statement: a.statement,
      })),
    ).toEqual([
      {
        matcher: "toHaveTitle",
        soft: false,
        negated: true,
        modifiers: [],
        subject: null,
        args: ['"Error"'],
        statement: undefined,
      },
      {
        matcher: "toBe",
        soft: true,
        negated: false,
        modifiers: [],
        subject: "1",
        args: ["1"],
        statement: undefined,
      },
      {
        matcher: "toEqual",
        soft: false,
        negated: false,
        modifiers: ["resolves"],
        subject: null,
        args: ["{a:1}"],
        statement: undefined,
      },
      {
        matcher: "toSatisfy",
        soft: false,
        negated: false,
        modifiers: [],
        subject: null,
        args: ['"The order is confirmed"', '{decider:"kev"}'],
        statement: "The order is confirmed",
      },
      {
        matcher: "toBe",
        soft: false,
        negated: false,
        modifiers: ["poll"],
        subject: null,
        args: ["3"],
        statement: undefined,
      },
      {
        matcher: "toEqual",
        soft: false,
        negated: false,
        modifiers: [],
        subject: null,
        args: [null],
        statement: undefined,
      },
    ]);
  });

  it("counts assertions inside test.step and nested callbacks for the test", () => {
    const text = `
      test("t", async () => {
        await test.step("open", async () => {
          expect(1).toBe(1);
        });
        await expect(async () => {
          expect(2).toBe(2);
        }).toPass();
      });
    `;
    expect(parsed(text).tests[0]?.assertions.map((a) => a.matcher)).toEqual([
      "toBe",
      "toPass",
      "toBe",
    ]);
  });

  it("keeps assertions outside tests separately", () => {
    const text = `
      test.beforeEach(() => { expect(1).toBe(1); });
      test("t", () => {});
    `;
    const file = parsed(text);
    expect(file.looseAssertions.map((a) => a.matcher)).toEqual(["toBe"]);
    expect(file.tests[0]?.assertions).toEqual([]);
  });

  it("separates skip, fixme, todo, only and fail definitions from annotations", () => {
    const text = `
      test.skip("a", () => {});
      test.fixme("b", () => {});
      it.todo("c");
      xit("d", () => {});
      xtest("e", () => {});
      test.only("f", () => {});
      test.fail("g", () => {});
      test("h", ({ browserName }) => {
        test.skip(browserName === "firefox", "flaky");
        test.fail();
      });
      xdescribe("i", () => { it("j", () => {}); });
      describe.skip("k", () => { test.fixme(); it("l", () => {}); });
      test.describe.only("m", () => { test("n", () => {}); });
    `;
    const file = parsed(text);
    expect(file.tests.map((t) => [t.titlePath.join(" > "), t.markers])).toEqual(
      [
        ["a", { skip: 1, only: 0, fail: 0 }],
        ["b", { skip: 1, only: 0, fail: 0 }],
        ["c", { skip: 1, only: 0, fail: 0 }],
        ["d", { skip: 1, only: 0, fail: 0 }],
        ["e", { skip: 1, only: 0, fail: 0 }],
        ["f", { skip: 0, only: 1, fail: 0 }],
        ["g", { skip: 0, only: 0, fail: 1 }],
        ["h", { skip: 1, only: 0, fail: 1 }],
        ["i > j", { skip: 1, only: 0, fail: 0 }],
        ["k > l", { skip: 2, only: 0, fail: 0 }],
        ["m > n", { skip: 0, only: 1, fail: 0 }],
      ],
    );
  });

  it("normalises the body so formatting and comments do not matter", () => {
    const a = parsed(`test("t", () => { expect(a).toBe(1) })`);
    const b = parsed(`test("t", () => {
      // a comment
      expect( a ).toBe( 1 )
    })`);
    expect(a.tests[0]?.body).toBe(b.tests[0]?.body);
  });

  it("parses JavaScript and JSX test files", () => {
    const file = parseTestFile(
      "it('renders', () => { render(<App />); });",
      "a.test.jsx",
    );
    expect(file.ok && file.value.tests.length).toBe(1);
  });

  it("reports a syntax error instead of guessing", () => {
    const result = parseTestFile('test("t", () => {', "a.spec.ts");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/line 1/);
  });
});

/** Evidence of a body that gives the weak-test rules nothing to doubt. */
const PLAIN = {
  helperAsserts: false,
  helperConstants: [],
  unseen: [],
  throws: false,
  checksByHand: false,
  hookChecks: false,
  customRunner: false,
  typeLevel: false,
  ownMocks: [],
};

function evidence(text: string, fileName = "a.spec.ts") {
  return parsed(text, fileName).tests[0]?.evidence;
}

/** The evidence of one Playwright test with `body` as its statements. */
function bodyEvidence(body: string, head = "") {
  return evidence(
    `${head}\ntest("t", async ({ page, request }) => {\n${body}\n});`,
  );
}

describe("parseTestFile: evidence for the weak-test rules", () => {
  it("has none for a test with no function body", () => {
    expect(evidence(`it.todo("later");`)).toBeNull();
  });

  it.each([
    ["an empty body", ""],
    [
      "calls on fixtures",
      `await page.goto("/");
       await page.getByRole("button", { name: "Pay" }).click();
       await request.get("/api/orders");`,
    ],
    [
      "calls on values derived from fixtures",
      `const button = page.getByRole("button");
       await button.click();
       const response = await request.get("/api");
       const { items } = await response.json();
       items.forEach((item) => item.toString());
       for (const row of await page.getByRole("row").all()) {
         await row.click();
       }
       page.on("dialog", (dialog) => dialog.accept());`,
    ],
    [
      "well-known globals",
      `await new Promise((resolve) => setTimeout(resolve, 100));
       console.log(JSON.stringify({ a: 1 }), String(1), Number("2"));
       await Promise.all([page.goto("/"), page.reload()]);`,
    ],
    [
      "the test API",
      `test.setTimeout(1000);
       await test.step("open", async () => {
         await page.goto("/");
       });
       await page.waitForTimeout(10);`,
    ],
    [
      "a function declared in the body",
      `const open = async (path) => {
         await page.goto(path);
       };
       await open("/");`,
    ],
  ])("doubts nothing in %s", (_name, body) => {
    expect(bodyEvidence(body)).toEqual(PLAIN);
  });

  // Changed on purpose: a CONSTANT_CASE import used to be taken for data. A
  // name says nothing about what reading the value runs, so it is named now.
  it("trusts module-level constants built from literals, but no import, whatever its name", () => {
    const head = `import { BASE_URL, SELECTORS } from "./config";\nconst paths = ["/a", "/b"];`;
    const body = `await page.goto(BASE_URL);
      await page.fill(SELECTORS.user, "bob");
      for (const path of paths) {
        await page.goto(path);
      }`;
    expect(bodyEvidence(body, head)).toEqual({
      ...PLAIN,
      unseen: ["BASE_URL", "SELECTORS.user"],
    });
  });

  it.each([
    [
      "an imported function",
      `import { checkCheckout } from "./helpers";`,
      `await checkCheckout(page);`,
      ["checkCheckout()"],
    ],
    [
      "a function that is not defined in the file",
      "",
      `await checkCheckout(page);`,
      ["checkCheckout()"],
    ],
    [
      "a page object",
      `import { CheckoutPage } from "./pages";`,
      `await new CheckoutPage(page).expectPaid();`,
      ["new CheckoutPage()", ".expectPaid()"],
    ],
    [
      "a page object held in a variable",
      `import { CheckoutPage } from "./pages";`,
      `const checkout = new CheckoutPage(page);\nawait checkout.pay();`,
      ["new CheckoutPage()", "checkout.pay()"],
    ],
    [
      "node:assert",
      `import assert from "node:assert";`,
      `assert.equal(await page.title(), "Shop");`,
      ["assert.equal()"],
    ],
    [
      "a chai-style chain",
      `import { expect } from "chai";`,
      `expect(await page.title()).to.equal("Shop");`,
      ["expect()", ".equal()"],
    ],
    [
      "a value that is not a literal, handed to a fixture",
      `import { baseUrl, user } from "./config";`,
      `await page.goto(baseUrl);\nawait page.fill("#user", user.name);`,
      ["baseUrl", "user.name"],
    ],
    [
      "a wait, which fails the test when it times out",
      "",
      `await page.waitForURL("**/done");\nawait page.getByText("Paid").waitFor();`,
      ["page.waitForURL()", ".waitFor()"],
    ],
    [
      "a variable declared with let",
      "",
      `let target = page.getByRole("button");\nawait target.click();`,
      ["target.click()"],
    ],
    [
      "a global the file redefines",
      `import { console } from "./quiet";`,
      `console.log("x");`,
      ["console.log()"],
    ],
    [
      "a tagged template",
      `import { sql } from "./db";`,
      "await sql`select 1`;",
      ["sql"],
    ],
    [
      "an awaited value from elsewhere",
      `import { ready } from "./server";`,
      `await ready;`,
      ["ready"],
    ],
    [
      "a method of a module-level object",
      `const checkout = { async expectPaid(page) { await expect(page).toHaveTitle("Paid"); } };`,
      `await checkout.expectPaid(page);`,
      ["checkout.expectPaid()"],
    ],
    [
      "a module-level object that holds a helper",
      `function expectPaid() { expect(1).toBe(1); }\nconst checks = { expectPaid };`,
      `checks.expectPaid();`,
      ["checks.expectPaid()"],
    ],
    [
      "a module-level list of functions",
      `const checks = [() => { expect(1).toBe(1); }];`,
      `checks.forEach((check) => check());`,
      ["checks.forEach()"],
    ],
    [
      "an import whose name a callback parameter reuses",
      `import { api } from "./api";`,
      `[1, 2].forEach((api) => api.toFixed());\nawait api.verify();`,
      ["api.toFixed()", "api.verify()"],
    ],
  ])("names %s as code it cannot read", (_name, head, body, unseen) => {
    expect(bodyEvidence(body, head)).toEqual({ ...PLAIN, unseen });
  });

  it("names every link of a supertest chain", () => {
    const text = `
      import request from "supertest";
      it("answers", async () => {
        await request(app).get("/").expect(200);
      });
    `;
    expect(evidence(text)).toEqual({
      ...PLAIN,
      unseen: ["request()", ".get()", ".expect()"],
    });
  });

  it("does not trust a fixture the project defined itself", () => {
    const text = `
      test("pays", async ({ checkoutPage, page: tab }, testInfo) => {
        await tab.goto("/");
        await checkoutPage.expectPaid();
        testInfo.setTimeout(10);
      });
    `;
    expect(evidence(text)).toEqual({
      ...PLAIN,
      unseen: ["checkoutPage.expectPaid()", "testInfo.setTimeout()"],
    });
  });

  it("names each piece of unreadable code once", () => {
    const text = `
      it("runs", () => {
        run(1);
        run(2);
      });
    `;
    expect(evidence(text)?.unseen).toEqual(["run()"]);
  });

  it("looks into a helper defined in the same file", () => {
    const withExpect = `
      async function expectPaid(page) {
        await expect(page.getByRole("status")).toHaveText("Paid");
      }
      test("pays", async ({ page }) => {
        await expectPaid(page);
      });
    `;
    expect(evidence(withExpect)).toEqual({ ...PLAIN, helperAsserts: true });

    const without = `
      const open = async (page) => {
        await page.goto("/");
      };
      test("opens", async ({ page }) => {
        await open(page);
      });
    `;
    expect(evidence(without)).toEqual(PLAIN);
  });

  it("follows helpers into helpers, and ends on recursion", () => {
    const text = `
      import { submit } from "./api";
      function pay(page, tries) {
        if (tries > 0) pay(page, tries - 1);
        return finish(page);
      }
      const finish = (page) => submit(page);
      test("pays", async ({ page }) => {
        await pay(page, 2);
      });
    `;
    expect(evidence(text)).toEqual({ ...PLAIN, unseen: ["submit()"] });
  });

  it("looks into a helper that is passed as a callback", () => {
    const text = `
      function checkItem(n) {
        expect(n).toBeGreaterThan(0);
      }
      it("checks", () => {
        [1, 2].forEach(checkItem);
      });
    `;
    expect(evidence(text)).toEqual({ ...PLAIN, helperAsserts: true });
  });

  it("does not trust what a same-file helper returns", () => {
    const text = `
      import { checkout } from "./pages";
      function pageObject() {
        return checkout;
      }
      test("pays", async () => {
        await pageObject().expectPaid();
        const held = pageObject();
        await held.expectPaid();
      });
    `;
    expect(evidence(text)?.unseen).toEqual([
      "checkout",
      ".expectPaid()",
      "held.expectPaid()",
    ]);
  });

  it("does not trust a name whose default comes from elsewhere", () => {
    const helper = `
      import { verify } from "./checks";
      function go(page, check = verify) {
        check(page);
      }
      test("pays", async ({ page }) => {
        go(page);
      });
    `;
    // `verify` joined each list on purpose: every name from elsewhere that
    // the body reads is recorded now, not only the ones it calls.
    expect(evidence(helper)?.unseen).toEqual(["verify", "check()"]);
    expect(
      bodyEvidence(
        `const { run = verify } = {};\nrun();\n[1].forEach((n, done = verify) => done(n));`,
      )?.unseen,
    ).toEqual(["verify", "run()", "done()"]);
  });

  it("does not read a function that another test declared", () => {
    const text = `
      test("opens", async ({ page }) => {
        const go = async () => {
          await page.goto("/");
        };
        await go();
      });
      test("pays", async ({ page }) => {
        const go = async () => {
          await expect(page).toHaveTitle("Paid");
        };
        await go();
      });
    `;
    expect(evidence(text)).toEqual(PLAIN);
  });

  it("reads a helper declared in the describe block around the test", () => {
    const text = `
      describe("checkout", () => {
        const expectPaid = async (page) => {
          await expect(page).toHaveTitle("Paid");
        };
        test("pays", async ({ page }) => {
          await expectPaid(page);
        });
      });
    `;
    expect(evidence(text)).toEqual({ ...PLAIN, helperAsserts: true });
  });

  it("names a value from elsewhere that the test returns", () => {
    expect(evidence(`it("x", () => ready);`)?.unseen).toEqual(["ready"]);
    expect(
      evidence(`it("x", async ({ page }) => {\n  return pending;\n});`)?.unseen,
    ).toEqual(["pending"]);
    expect(
      evidence(`it("x", async ({ page }) => page.goto("/"));`)?.unseen,
    ).toEqual([]);
  });

  it("does not count an expect in a helper the test never uses", () => {
    const text = `
      function unused() {
        expect(1).toBe(1);
      }
      test("opens", async ({ page }) => {
        await page.goto("/");
      });
    `;
    expect(evidence(text)).toEqual(PLAIN);
  });

  it("notes a throw statement, in the body or in a helper it calls", () => {
    const body = `if (!(await page.title()).includes("Shop")) {
      throw new Error("wrong title");
    }`;
    expect(bodyEvidence(body)).toEqual({ ...PLAIN, throws: true });

    const helper = `
      function mustBe(ok) {
        if (!ok) throw new Error("no");
      }
      it("holds", () => {
        mustBe(true);
      });
    `;
    expect(evidence(helper)).toEqual({ ...PLAIN, throws: true });
  });

  it.each([
    [
      "a fail() call",
      `it("x", () => { try { run(); fail("no throw"); } catch {} });`,
    ],
    ["expect.unreachable()", `it("x", () => { expect.unreachable(); });`],
    ["expect.assertions()", `it("x", () => { expect.assertions(1); });`],
    ["expect.hasAssertions()", `it("x", () => { expect.hasAssertions(); });`],
    ["a done callback", `it("x", (done) => { done(); });`],
  ])("notes a check made by hand: %s", (_name, text) => {
    expect(evidence(text)?.checksByHand).toBe(true);
  });

  it("does not take test.fail() or a second parameter for a check by hand", () => {
    const text = `
      test("x", async ({ page }, testInfo) => {
        test.fail();
        await page.goto("/");
      });
    `;
    expect(evidence(text)).toEqual(PLAIN);
  });

  it("notes a hook or fixture in the file that asserts", () => {
    const text = `
      test.afterEach(async ({ page }) => {
        await expect(page.locator(".error")).toHaveCount(0);
      });
      test("opens", async ({ page }) => {
        await page.goto("/");
      });
    `;
    expect(evidence(text)).toEqual({ ...PLAIN, hookChecks: true });
    // Changed on purpose: a hook that calls code the guard cannot read may
    // check for every test, so this was PLAIN and is not any more.
    expect(
      evidence(`beforeEach(() => { setUp(); });\nit("x", () => {});`),
    ).toEqual({ ...PLAIN, hookChecks: true });
    expect(
      evidence(
        `test.beforeEach(async ({ page }) => { await page.goto("/"); });\ntest("x", () => {});`,
      ),
    ).toEqual(PLAIN);
    const fixture = `
      const test = base.extend({
        page: async ({ page }, use) => {
          await use(page);
          expect(errors).toEqual([]);
        },
      });
      test("opens", async ({ page }) => {
        await page.goto("/");
      });
    `;
    // `test` is built in this file, so its fixtures are not the built-in ones.
    expect(evidence(fixture)).toEqual({
      ...PLAIN,
      hookChecks: true,
      customRunner: true,
      unseen: ["page.goto()"],
    });
  });

  it("leaves an expect chain itself out of the unreadable code", () => {
    const text = `
      test("t", async ({ page }) => {
        await expect(page.getByRole("status")).toHaveText("Paid");
        await expect.poll(() => count()).toBe(3);
      });
    `;
    expect(evidence(text)).toEqual({ ...PLAIN, unseen: ["count()"] });
  });

  it.each([
    ["vi.fn()", "vi.fn()"],
    ["jest.fn()", "jest.fn()"],
    ["mock.fn()", "mock.fn()"],
    ["sinon.stub()", "sinon.stub()"],
    ["sinon.spy()", "sinon.spy()"],
    ["a mock with a canned return", "vi.fn().mockReturnValue(1)"],
  ])("lists %s the test only calls itself as its own mock", (_name, make) => {
    const text = `
      it("calls", () => {
        const fn = ${make};
        fn(1);
        fn.mockClear();
        expect(fn).toHaveBeenCalledWith(1);
        expect(fn.mock.calls.length).toBe(1);
      });
    `;
    expect(evidence(text)?.ownMocks).toEqual(["fn"]);
  });

  it.each([
    ["passed to other code", `const fn = vi.fn();\nsubscribe(fn);`],
    ["put into an object", `const fn = vi.fn();\nconst api = { send: fn };`],
    ["shorthand in an object", `const fn = vi.fn();\nconst api = { fn };`],
    ["called from a callback", `const fn = vi.fn();\nrun(() => { fn(); });`],
    ["bound and passed on", `const fn = vi.fn();\nrun(fn.bind(null));`],
    ["its result kept", `const fn = vi.fn();\nconst out = fn();`],
    ["wrapping real code", `const fn = vi.fn(realAdd);\nfn(1);`],
    ["a stub on a real object", `const fn = sinon.stub(api, "get");\nfn();`],
    ["declared with let", `let fn = vi.fn();\nfn();`],
    ["made inside a callback", `run(() => { const fn = vi.fn(); fn(); });`],
  ])("does not list a mock that is %s", (_name, body) => {
    const text = `it("calls", () => {\n${body}\nexpect(fn).toHaveBeenCalled();\n});`;
    expect(evidence(text)?.ownMocks).toEqual([]);
  });

  it("does not list a mock handed to a component in a TSX file", () => {
    const text = `
      it("clicks", () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick} />);
        expect(onClick).toHaveBeenCalled();
      });
    `;
    expect(evidence(text, "a.test.tsx")?.ownMocks).toEqual([]);
  });

  it("reads a JavaScript file the same way", () => {
    const text = `
      const { check } = require("./helpers");
      it('checks', async () => {
        await check();
      });
    `;
    expect(evidence(text, "a.test.js")).toEqual({
      ...PLAIN,
      unseen: ["check()"],
    });
  });
});

describe("parseTestFile: the fingerprint that ignores a formatter's edits", () => {
  function fingerprint(body: string, fileName = "a.spec.ts") {
    return parsed(`test("t", () => {\n${body}\n});`, fileName).tests[0]
      ?.fingerprint;
  }

  it("has none for a test with no function body", () => {
    expect(parsed(`it.todo("later");`).tests[0]?.fingerprint).toBeNull();
  });

  it.each([
    ["a semicolon", `const a = 1;\nreturn a;`, `const a = 1\nreturn a`],
    ["a trailing comma", `f(a, { b: 1 });`, `f(a, { b: 1, },);`],
    ["arrow parentheses", `xs.map(async x => x);`, `xs.map(async (x) => x);`],
    ["quotes", "f('a', \"b\", `c`);", `f("a", "b", "c");`],
    ["comments and layout", `f( 1 ) // one`, `f(1);`],
    ["a class property's semicolon", `class A { x = 1; }`, `class A { x = 1 }`],
  ])("is the same across %s", (_name, a, b) => {
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it.each([
    ["a statement split in two", `a\n(b)`, `a;\n(b)`],
    ["an empty slot in an array", `f([1, , 2]);`, `f([1, 2]);`],
    ["a hole at the end of an array", `f([1, ,]);`, `f([1,]);`],
    [
      "a typed arrow parameter",
      `xs.map((x: number) => x);`,
      `xs.map((x) => x);`,
    ],
    ["a rest parameter", `xs.map((...x) => x);`, `xs.map((x) => x);`],
    ["a tagged template", "sql`a`;", `sql("a");`],
    ["a template with a value", "f(`a${b}`);", 'f("a${b}");'],
    ["the semicolons of a for header", `for (;;) f();`, `for (;f();) f();`],
    [
      "an empty statement that is a loop body",
      `while (a);\nb();`,
      `while (a) b();`,
    ],
    ["a different number", `f(1);`, `f(2);`],
  ])("differs across %s", (_name, a, b) => {
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("leaves the body the other comparisons use as it was", () => {
    const a = parsed(`test("t", () => { f(1); });`).tests[0];
    const b = parsed(`test("t", () => { f(1) });`).tests[0];
    expect(a?.body).not.toBe(b?.body);
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });
});

describe("parseTestFile: assertions whose outcome is fixed", () => {
  function facts(body: string) {
    const text = `test("t", async ({ page }) => {\n${body}\n});`;
    return (parsed(text).tests[0]?.assertions ?? []).map((a) => [
      a.constant,
      a.subjectRoot,
    ]);
  }

  it.each([
    [`expect(true).toBe(true);`],
    [`expect(1).toEqual(1);`],
    [`expect("a").toBeTruthy();`],
    [`expect([]).toHaveLength(0);`],
    [`expect(1).toBe(2);`],
    [`expect.soft(1).not.toBe(2);`],
    [`await expect(1).resolves.toBe(1);`],
    [`expect({ a: 1 }).toEqual({ a: 1 });`],
    [`expect(undefined).toBeUndefined();`],
  ])("marks %s as a literal against literals", (body) => {
    expect(facts(body)).toEqual([["literals", null]]);
  });

  it.each([
    [`expect(total).toEqual(total);`, "total"],
    [`expect(user.name).toBe(user.name);`, "user"],
    [`expect( user . name ).not.toStrictEqual((user.name));`, "user"],
    [`expect(rows[0]).toMatchObject(rows[0]);`, "rows"],
  ])("marks %s as a value compared with itself", (body, root) => {
    expect(facts(body)).toEqual([["self", root]]);
  });

  it.each([
    [`expect(total).toBe(42);`, "total"],
    [`expect(next()).toBe(next());`, null],
    [`expect(await next()).toBe(await next());`, null],
    [`expect(i++).toBe(i++);`, null],
    [`expect(total).toBeGreaterThan(total);`, "total"],
    [`expect(total).toBe(total, "message");`, "total"],
    [`await expect(pending).resolves.toBe(pending);`, "pending"],
    [`await expect.poll(() => 1).toBe(1);`, null],
    [`expect(1).toBe(one);`, null],
    [`expect(1).toEqual(expect.any(Number));`, null],
    [`await expect(page).toSatisfy("The order is confirmed");`, "page"],
    [`await expect("x").toSatisfy("x");`, null],
    [`expect(fn.mock.calls[0]).toEqual([1]);`, "fn"],
    [`expect(fn()).toBe(1);`, null],
  ])("leaves %s as an assertion that can fail", (body, root) => {
    expect(facts(body)).toEqual([[null, root]]);
  });

  function results(body: string) {
    const text = `test("t", async ({ page }) => {\n${body}\n});`;
    return (parsed(text).tests[0]?.assertions ?? []).map((a) => [
      a.constant,
      a.result,
    ]);
  }

  it.each([
    [`expect(1).toBe(1);`, "literals", "passes"],
    [`expect(1).toBe(2);`, "literals", "fails"],
    [`expect(1).not.toBe(1);`, "literals", "fails"],
    [`expect(0).toBe(-0);`, "literals", "fails"],
    [`expect(NaN).toBeNaN();`, "literals", "passes"],
    [`expect([]).toBe([]);`, "literals", "fails"],
    [`expect([1]).toEqual([1]);`, "literals", "passes"],
    [
      `expect({ a: 1 }).toEqual({ a: 1, b: undefined });`,
      "literals",
      "unknown",
    ],
    [`expect({ a: 1 }).toMatchObject({});`, "literals", "unknown"],
    [`expect("abc").toMatch(/b/);`, "literals", "unknown"],
    [`expect(1n).toBe(1n);`, "literals", "unknown"],
    [`expect(1 == 1).toBe(true);`, "literals", "unknown"],
    [`await expect(1).resolves.toBe(1);`, "literals", "unknown"],
    [`expect(null ?? "a").toBe("a");`, "literals", "passes"],
    [`expect(1 > 2 ? "a" : "b").toBe("b");`, "literals", "passes"],
    [`expect(typeof "a").toBe("string");`, "literals", "passes"],
    [`expect().toBeDefined();`, "literals", "fails"],
    [`expect(page).toBeDefined();`, "fixture", "passes"],
    [`expect(page).toBeNull();`, "fixture", "fails"],
    [`expect(page).toBe(page);`, "self", "passes"],
    [`expect(page).not.toBe(page);`, "self", "fails"],
  ])("works out %s as %s that %s", (body, constant, result) => {
    expect(results(body)).toEqual([[constant, result]]);
  });

  it.each([
    [`expect(5).toBeWithinRange(1, 10);`],
    [`expect("a").toMatchSnapshot();`],
    [`expect(page).toHaveLength(1);`],
    [`expect(page).toEqual({});`],
    [`expect(rows[i + 1]).toBe(rows[i + 1]);`],
    [`expect([...rows]).toEqual([]);`],
  ])("gives no result for %s, which is not on constants", (body) => {
    expect(results(body)).toEqual([[null, null]]);
  });

  it("does not take an assertion outside any test for one on a test's constants", () => {
    const text = `const a = 5;\nafterEach(() => { expect(a).toBe(5); });\ntest("t", () => {});`;
    expect(parsed(text).looseAssertions.map((a) => a.constant)).toEqual([null]);
  });

  it("gives a reformatted test the same model, line numbers aside", () => {
    const a = parsed(`test("t", () => { expect(total).toBe(total) })`).tests[0];
    const b = parsed(
      `test("t", () => {\n  // same\n  expect( total ).toBe( total )\n})`,
    ).tests[0];
    const unlined = (test: typeof a) =>
      test?.assertions.map((assertion) => ({ ...assertion, line: 0 }));
    expect(unlined(a)).toEqual(unlined(b));
    expect({ ...a, assertions: [] }).toEqual({ ...b, assertions: [] });
  });
});
