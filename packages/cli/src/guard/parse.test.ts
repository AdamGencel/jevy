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
