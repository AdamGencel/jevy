import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import {
  checkGlob,
  firstMatch,
  GLOB_CACHE_LIMIT,
  globCacheSize,
  matchesGlob,
  reachesInto,
} from "./glob.js";

// glob-table:start
// The same table, character for character, is in
// packages/core/src/config.test.ts and packages/cli/src/guard/glob.test.ts.
// Core's loader (`assertGlob`) and the CLI's matcher (`checkGlob`) cannot
// import one another, so each restates the rule and each is tested against
// this table. Change both copies together: a glob the loader accepts and the
// matcher refuses makes the guard and the hooks fail on a valid config.
const GLOB_TABLE = {
  accepted: [
    "tests/**",
    "**/*.spec.ts",
    "docs/plan.md",
    "./tests/critical/",
    "**/*.{spec,test}.{ts,tsx}",
    "a?c",
    "**",
    "x/{a,}/y",
    "a/./b",
    "a//b",
    ".jevy/**",
    "app/(marketing)/**",
    "tests/my dir/*.ts",
    "my docs/plan.md",
    "{my docs,a b}/**",
    "a+b$^.ts",
    "{a,b}".repeat(8),
  ],
  rejected: [
    "",
    " ",
    " tests/**",
    "tests/** ",
    "\ttests/**",
    "{plans, tests/critical}/**",
    "{plans,tests/critical }/**",
    "tests/critical /**",
    "tests/ critical/**",
    "{a,b }/x",
    "a{ b,c}",
    "tests/\t/**",
    "!tests/**",
    "./!x",
    "{!a,b}",
    "/abs/path",
    "{/etc,a}",
    "C:/x",
    "C:x",
    "./C:x",
    "C:\\tests",
    "a\\b",
    "../outside",
    "a/../b",
    "{..,a}/x",
    "tests/[ab]/**",
    "src/[id]/**",
    "a]",
    "a/{b,{c,d}}",
    "{a",
    "a/{b,c",
    "a/b}",
    "a**b",
    "a/**.ts",
    ".",
    "./",
    "{tests,}",
    "tests/*.@(spec|test).ts",
    "tests/+(a|b)",
    "a/?(b)",
    "a/*(b)",
    "a/!(b)",
    "a|b",
    "{a,b}".repeat(9),
  ],
} as const;
// glob-table:end

describe("matchesGlob", () => {
  it("is anchored at the repository root", () => {
    expect(matchesGlob("tests/a.spec.ts", "tests/**")).toBe(true);
    expect(matchesGlob("src/tests/a.spec.ts", "tests/**")).toBe(false);
    expect(matchesGlob("docs/plan.md", "docs/plan.md")).toBe(true);
    expect(matchesGlob("x/docs/plan.md", "docs/plan.md")).toBe(false);
    expect(matchesGlob("docs/plan.mdx", "docs/plan.md")).toBe(false);
    expect(matchesGlob("docs/plan.m", "docs/plan.md")).toBe(false);
  });

  it("ignores a leading ./ on the glob and on the path", () => {
    expect(matchesGlob("tests/a.spec.ts", "./tests/**")).toBe(true);
    expect(matchesGlob("./tests/a.spec.ts", "tests/**")).toBe(true);
    expect(matchesGlob("docs/plan.md", "./docs/plan.md")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(matchesGlob("tests/a.spec.ts", "Tests/**")).toBe(false);
    expect(matchesGlob("docs/Plan.md", "docs/plan.md")).toBe(false);
  });

  it("matches * within one segment, including a leading dot", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/.hidden.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("a/b.ts", "*.ts")).toBe(false);
    expect(matchesGlob("src/axbxc.ts", "src/a*b*c.ts")).toBe(true);
    expect(matchesGlob("src/axbx.ts", "src/a*b*c.ts")).toBe(false);
    expect(matchesGlob("src/.ts", "src/*.ts")).toBe(true);
  });

  it("matches ** as zero or more whole segments", () => {
    expect(matchesGlob("a/b", "a/**/b")).toBe(true);
    expect(matchesGlob("a/x/y/b", "a/**/b")).toBe(true);
    expect(matchesGlob("a/x/y/c", "a/**/b")).toBe(false);
    expect(matchesGlob("x", "**/x")).toBe(true);
    expect(matchesGlob("a/x", "**/x")).toBe(true);
    expect(matchesGlob("a/b/x", "**/x")).toBe(true);
    expect(matchesGlob("a/b/xy", "**/x")).toBe(false);
    expect(matchesGlob("a.spec.ts", "**/*.spec.ts")).toBe(true);
    expect(matchesGlob("e2e/pay/a.spec.ts", "**/*.spec.ts")).toBe(true);
    expect(matchesGlob("e2e/pay/a.spec.tsx", "**/*.spec.ts")).toBe(false);
    expect(matchesGlob("anything/at/all.txt", "**")).toBe(true);
    expect(matchesGlob("a/b/c/d", "a/**/**/d")).toBe(true);
  });

  it("matches ? as one character that is not a slash", () => {
    expect(matchesGlob("abc", "a?c")).toBe(true);
    expect(matchesGlob("ac", "a?c")).toBe(false);
    expect(matchesGlob("a/c", "a?c")).toBe(false);
    expect(matchesGlob("abbc", "a?c")).toBe(false);
    expect(matchesGlob("a\u{1F600}c", "a?c")).toBe(true);
  });

  it("matches {a,b} alternation", () => {
    expect(matchesGlob("x/a.spec.ts", "**/*.{spec,test}.ts")).toBe(true);
    expect(matchesGlob("x/a.test.ts", "**/*.{spec,test}.ts")).toBe(true);
    expect(matchesGlob("x/a.unit.ts", "**/*.{spec,test}.ts")).toBe(false);
    expect(matchesGlob("e2e/a.ts", "{tests,e2e}/**")).toBe(true);
    expect(matchesGlob("src/a.ts", "{tests,e2e}/**")).toBe(false);
    expect(matchesGlob("a/b/x", "{a/b,c}/x")).toBe(true);
    expect(matchesGlob("c/x", "{a/b,c}/x")).toBe(true);
    expect(matchesGlob("a/x", "{a/b,c}/x")).toBe(false);
    expect(matchesGlob("a.ts", "{a,b}.{ts,js}")).toBe(true);
    expect(matchesGlob("b.js", "{a,b}.{ts,js}")).toBe(true);
    expect(matchesGlob("c.js", "{a,b}.{ts,js}")).toBe(false);
  });

  it("matches everything beneath a directory the glob matches", () => {
    expect(matchesGlob("tests/critical/a/b.spec.ts", "tests/critical")).toBe(
      true,
    );
    expect(matchesGlob("tests/critical/a/b.spec.ts", "tests/critical/")).toBe(
      true,
    );
    expect(matchesGlob("tests/critical", "tests/critical/")).toBe(true);
    expect(matchesGlob("tests/critical/x.ts", "tests/crit")).toBe(false);
    expect(matchesGlob("tests/critical/x.ts", "tests/crit*")).toBe(true);
    // A wildcard that matches a directory covers what is inside it too.
    expect(matchesGlob("src/a/b.ts", "src/*")).toBe(true);
    expect(matchesGlob("pkg/app/tests/deep/a.ts", "pkg/*/tests")).toBe(true);
    expect(matchesGlob("pkg/app/src/a.ts", "pkg/*/tests")).toBe(false);
  });

  it("does not treat dotfiles as special", () => {
    expect(matchesGlob(".jevy/decisions/a.jsonl", "**")).toBe(true);
    expect(matchesGlob(".jevy/decisions/a.jsonl", "**/*.jsonl")).toBe(true);
    expect(matchesGlob(".jevy/decisions/a.jsonl", "*/decisions")).toBe(true);
    expect(matchesGlob("a/.env", "a/*")).toBe(true);
  });

  it("reads regular-expression metacharacters literally", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("axb", "a.b")).toBe(false);
    expect(matchesGlob("a(b)+$^", "a(b)+$^")).toBe(true);
    expect(matchesGlob("ab+$^", "a(b)+$^")).toBe(false);
    expect(matchesGlob("aab", "a+b")).toBe(false);
    expect(matchesGlob("src/a,b.ts", "src/a,b.ts")).toBe(true);
  });

  it("returns false, and never throws, for a glob it cannot honour", () => {
    for (const glob of [
      "",
      "!tests/**",
      "/etc/passwd",
      "C:/x",
      "../x",
      "a/../b",
      "a\\b",
      "src/[ab].ts",
      "a/{b,{c,d}}",
      "a/{b,c",
      "a/b}",
      "a/**.ts",
      ".",
      "./",
      "{a,b}".repeat(12),
      ...GLOB_TABLE.rejected,
    ]) {
      expect(matchesGlob("a", glob)).toBe(false);
      expect(matchesGlob("tests/x.ts", glob)).toBe(false);
    }
  });

  it("matches nothing with a group or bar it would have read as literal text", () => {
    // Before these were refused, each compiled to a literal that no path has.
    expect(matchesGlob("tests/a.spec.ts", "tests/*.@(spec|test).ts")).toBe(
      false,
    );
    expect(matchesGlob("tests/+(a|b)", "tests/+(a|b)")).toBe(false);
    expect(matchesGlob("a+(b)$^|", "a+(b)$^|")).toBe(false);
    expect(matchesGlob("a|b", "a|b")).toBe(false);
    expect(matchesGlob(" tests/x.ts", " tests/**")).toBe(false);
  });

  it("gives the same answer from its cache as from a fresh compile", () => {
    for (let round = 0; round < 3; round += 1) {
      expect(matchesGlob("tests/a.spec.ts", "tests/**")).toBe(true);
      expect(matchesGlob("src/a.spec.ts", "tests/**")).toBe(false);
      expect(matchesGlob("a", "!a")).toBe(false);
    }
  });

  it("compiles a glob once, and keeps no more than a bounded number", () => {
    const before = globCacheSize();
    matchesGlob("a", "cache-probe/one/**");
    matchesGlob("b", "cache-probe/one/**");
    matchesGlob("a", "!cache-probe-refused");
    expect(globCacheSize()).toBe(Math.min(before + 2, GLOB_CACHE_LIMIT));
    for (let index = 0; index < GLOB_CACHE_LIMIT + 50; index += 1) {
      matchesGlob("a", `cache-probe/${String(index)}/**`);
    }
    expect(globCacheSize()).toBe(GLOB_CACHE_LIMIT);
    // Evicted globs are compiled again and still answer correctly.
    expect(matchesGlob("cache-probe/one/x.ts", "cache-probe/one/**")).toBe(
      true,
    );
    expect(matchesGlob("cache-probe/0/x.ts", "cache-probe/0/**")).toBe(true);
  });

  it("never matches an empty path", () => {
    expect(matchesGlob("", "**")).toBe(false);
    expect(matchesGlob("./", "**")).toBe(false);
  });

  it("does not backtrack catastrophically", () => {
    const stars = `${"*a".repeat(30)}b`;
    expect(matchesGlob("a".repeat(5000), stars)).toBe(false);
    expect(matchesGlob(`${"a".repeat(5000)}b`, stars)).toBe(true);
    const deep = `${Array.from({ length: 30 }, () => "**/a").join("/")}/b`;
    const path = Array.from({ length: 400 }, () => "a").join("/");
    expect(matchesGlob(path, deep)).toBe(false);
    expect(matchesGlob(`${path}/b`, deep)).toBe(true);
  });
});

describe("firstMatch", () => {
  it("returns the first matching glob in list order, or null", () => {
    const globs = ["docs/**", "tests/critical/**", "tests/**"];
    expect(firstMatch("tests/critical/a.spec.ts", globs)).toBe(
      "tests/critical/**",
    );
    expect(firstMatch("tests/a.spec.ts", globs)).toBe("tests/**");
    expect(firstMatch("src/a.ts", globs)).toBeNull();
    expect(firstMatch("src/a.ts", [])).toBeNull();
  });

  it("skips globs it cannot honour", () => {
    expect(firstMatch("tests/a.ts", ["!tests/**", "tests/**"])).toBe(
      "tests/**",
    );
  });
});

describe("checkGlob", () => {
  it("accepts the globs the matcher honours", () => {
    for (const glob of [
      "tests/**",
      "**/*.spec.ts",
      "docs/plan.md",
      "./tests/critical/",
      "**/*.{spec,test}.{ts,tsx}",
      "a?c",
      "**",
      "x/{a,}/y",
    ]) {
      expect(() => {
        checkGlob(glob);
      }).not.toThrow();
    }
  });

  it.each([
    ["", /empty/],
    ["!tests/**", /negation/],
    ["/abs/path", /absolute/],
    ["C:/abs", /absolute/],
    ["../outside", /"\.\."/],
    ["a/../b", /"\.\."/],
    ["a\\b", /backslash/],
    ["src/[ab].ts", /character class/],
    ["a/{b,{c,d}}", /nested/],
    ["a/{b,c", /unbalanced/],
    ["a/b}", /unbalanced/],
    ["a/**.ts", /whole segment/],
    [".", /names no path/],
    ["{tests,}", /names no path/],
    ["{a,b}".repeat(12), /too many/],
  ])("rejects %j with a usage error", (glob, reason) => {
    expect(() => {
      checkGlob(glob);
    }).toThrow(UsageError);
    expect(() => {
      checkGlob(glob);
    }).toThrow(reason);
  });

  it.each([
    [" tests/**", /whitespace/],
    ["tests/** ", /whitespace/],
    ["{plans, tests/critical}/**", /whitespace at the start or end of a/],
    ["tests/critical /**", /whitespace at the start or end of a path segment/],
    ["a{ b,c}", /whitespace at the start or end of a brace alternative/],
    ["./!x", /negation/],
    ["{!a,b}", /negation/],
    ["{/etc,a}", /absolute/],
    ["C:x", /absolute/],
    ["{..,a}/x", /"\.\."/],
    ["tests/*.@(spec|test).ts", /extended glob group/],
    ["tests/+(a|b)", /extended glob group/],
    ["a/?(b)", /extended glob group/],
    ["a/*(b)", /extended glob group/],
    ["a/!(b)", /extended glob group/],
    ["a|b", /"\|"/],
  ])(
    "rejects %j, which it would otherwise match nothing with",
    (glob, reason) => {
      expect(() => {
        checkGlob(glob);
      }).toThrow(UsageError);
      expect(() => {
        checkGlob(glob);
      }).toThrow(reason);
    },
  );

  it("agrees with the table of globs it shares with core's loader", () => {
    for (const glob of GLOB_TABLE.accepted) {
      expect(() => {
        checkGlob(glob);
      }, glob).not.toThrow();
    }
    for (const glob of GLOB_TABLE.rejected) {
      expect(() => {
        checkGlob(glob);
      }, glob).toThrow(UsageError);
    }
  });

  it("has the same table as core's test, character for character", () => {
    const table = (url: URL): string => {
      const text = readFileSync(url, "utf8");
      return text.slice(
        text.indexOf("// glob-table:start"),
        text.indexOf("// glob-table:end"),
      );
    };
    const mine = table(new URL(import.meta.url));
    expect(mine).toContain("rejected:");
    expect(
      table(new URL("../../../core/src/config.test.ts", import.meta.url)),
    ).toBe(mine);
  });

  it("names the glob in the message", () => {
    expect(() => {
      checkGlob("!tests/**");
    }).toThrow('invalid glob "!tests/**": negation (!) is not supported');
  });
});

describe("reachesInto", () => {
  it("is true when the glob matches the directory, one above it, or a path inside it", () => {
    expect(reachesInto("e2e/fixtures/app", "e2e/**")).toBe(true);
    expect(reachesInto("e2e/fixtures/app", "e2e")).toBe(true);
    expect(reachesInto("e2e/fixtures/app", "**/*.spec.ts")).toBe(true);
    expect(reachesInto("e2e/fixtures/app", "e2e/fixtures/app/tests/**")).toBe(
      true,
    );
    expect(reachesInto("e2e/fixtures/app", "e2e/*/app/a.ts")).toBe(true);
  });

  it("is false when nothing inside the directory can match", () => {
    expect(reachesInto("vendor/app", "e2e/**")).toBe(false);
    expect(reachesInto("e2e/fixtures/app", "e2e/fixtures/other/**")).toBe(
      false,
    );
    expect(reachesInto("", "**")).toBe(false);
    expect(reachesInto("a", "[a]")).toBe(false);
  });
});
