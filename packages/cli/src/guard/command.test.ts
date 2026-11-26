import { describe, expect, it } from "vitest";
import { parseGuardArgs, runGuard, type GuardDeps } from "./command.js";
import { GitError } from "./errors.js";
import { memoryReader, type GitReaderOptions, type GitRepo } from "./git.js";
import type { GuardReport } from "./types.js";

const BEFORE = { "a.spec.ts": `test("a", () => { expect(1).toBe(1); });\n` };
const WEAKER = {
  "a.spec.ts": `test.skip("a", () => { expect(1).toBe(1); });\n`,
};

function deps(
  after: Readonly<Record<string, string>>,
  seen: GitReaderOptions[] = [],
): GuardDeps {
  return {
    cwd: "/repo",
    realpath: (path) => Promise.resolve(path),
    openRepo: (options) => {
      seen.push(options);
      return Promise.resolve({
        root: "/repo",
        reader: memoryReader(BEFORE, after),
      });
    },
  };
}

function json(stdout: string): GuardReport {
  return JSON.parse(stdout) as GuardReport;
}

type Files = Readonly<Record<string, string>>;

/** A repository at /repo holding `before` in base and `after` in head. */
function repo(
  before: Files,
  after: Files,
  seen: GitReaderOptions[] = [],
): GuardDeps {
  return {
    cwd: "/repo",
    realpath: (path) => Promise.resolve(path),
    openRepo: (options) => {
      seen.push(options);
      return Promise.resolve({
        root: "/repo",
        reader: memoryReader(before, after),
      });
    },
  };
}

// A real assertion, and a weakening that is one finding whatever else the
// guard learns to say about tests that check nothing.
const TEST = `test("a", () => { expect(total).toBe(1); });\n`;
const SKIPPED = `test.skip("a", () => { expect(total).toBe(1); });\n`;
const APPROVED = '{"reviewedBy":"me"}\n';
const SHA = "0123456789abcdef0123456789abcdef01234567";

function config(body: string): string {
  return `export default { ${body} };\n`;
}

async function found(
  argv: readonly string[],
  deps: GuardDeps,
): Promise<(readonly [string, string])[]> {
  const result = await runGuard([...argv, "--json"], deps);
  expect(result.stderr).toBe("");
  return json(result.stdout).findings.map((f) => [f.file, f.kind] as const);
}

describe("runGuard", () => {
  it("exits 0 with nothing to report", async () => {
    const result = await runGuard(["--base", "main"], deps(BEFORE));
    expect(result).toEqual({
      code: 0,
      stdout: "jevy guard: main..working-tree\n\nNo findings.\n",
      stderr: "",
    });
  });

  it("exits 1 on weakening and prints JSON with --json", async () => {
    const seen: GitReaderOptions[] = [];
    const result = await runGuard(
      ["--base=main", "--head", "feature", "--json"],
      deps(WEAKER, seen),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(json(result.stdout)).toMatchObject({
      v: 1,
      tool: "jevy-guard",
      base: "main",
      head: "feature",
      summary: { weakening: 1, review: 0, info: 0 },
      findings: [{ kind: "skip-added", file: "a.spec.ts" }],
    });
    expect(seen).toEqual([{ cwd: "/repo", base: "main", head: "feature" }]);
  });

  it("honours --fail-on", async () => {
    expect(
      (await runGuard(["--base", "main", "--fail-on", "never"], deps(WEAKER)))
        .code,
    ).toBe(0);
    const renamed = {
      "a.spec.ts": `test("b", () => { expect(1).toBe(1); });\n`,
    };
    expect((await runGuard(["--base", "main"], deps(renamed))).code).toBe(0);
    const changed = {
      "a.spec.ts": `test("a", () => { expect(1).toBe(2); });\n`,
    };
    expect(
      (await runGuard(["--base", "main", "--fail-on", "review"], deps(changed)))
        .code,
    ).toBe(1);
  });

  it("resolves --cwd and --cache-dir against the repository root", async () => {
    const seen: GitReaderOptions[] = [];
    const after = {
      ...BEFORE,
      "web/.cache/d/x.jsonl": '{"reviewedBy":"me"}\n',
    };
    const result = await runGuard(
      ["--base", "main", "--cwd", "web", "--cache-dir", ".cache/d", "--json"],
      {
        ...deps(after, seen),
        openRepo: (options) => {
          seen.push(options);
          return Promise.resolve({
            root: "/repo",
            reader: memoryReader(BEFORE, after),
          });
        },
      },
    );
    expect(seen[0]?.cwd).toBe("/repo/web");
    expect(json(result.stdout).findings).toMatchObject([
      { kind: "approval-added", file: "web/.cache/d/x.jsonl" },
    ]);
  });

  it.each([
    [[], "--base is required"],
    [["--base"], "--base needs a value"],
    [["--base", "-x"], "--base must not start with '-': -x"],
    [
      ["--base", "main", "--head", "--json"],
      "--head must not start with '-': --json",
    ],
    [
      ["--base", "main", "--fail-on", "sometimes"],
      "--fail-on must be weakening, review or never: sometimes",
    ],
    [["--base", "main", "--nope"], "unknown option '--nope'"],
    [["--base", "main", "extra"], "unexpected argument 'extra'"],
    [["--base", "a", "--base", "b"], "--base given twice"],
    [
      ["--base", "main", "--cache-dir", "../outside"],
      "--cache-dir must be inside the repository: ../outside",
    ],
    [
      ["--base", "main", "--cache-dir", "."],
      "--cache-dir must be a directory below the repository root, not the root itself: .",
    ],
    [
      ["--base", "main", "--cwd", "web", "--cache-dir", ".."],
      "--cache-dir must be a directory below the repository root, not the root itself: ..",
    ],
    [
      ["--base", "main", "--cache-dir", "a", "--cache-dir", "b"],
      "--cache-dir given twice",
    ],
    [["--base", "main", "--merge-base=1"], "unknown option '--merge-base=1'"],
    [["--base", "main", "--tests"], "--tests needs a value"],
    [
      ["--base", "main", "--tests", "!x"],
      '--tests: invalid glob "!x": negation (!) is not supported',
    ],
    [
      ["--base", "main", "--tests=a/**", "--tests", "../x/**"],
      '--tests: invalid glob "../x/**": a ".." segment is not allowed',
    ],
    [["--base", "main", "--tests="], '--tests: invalid glob "": it is empty'],
    [["--base", "main", "--json", "--json"], "--json given twice"],
    [
      ["--merge-base", "--base", "main", "--merge-base"],
      "--merge-base given twice",
    ],
    // A value that starts with '-' is the next option, swallowed.
    [
      ["--base", "main", "--tests", "--json"],
      "--tests must not start with '-': --json",
    ],
    [
      ["--base", "main", "--cache-dir", "--json"],
      "--cache-dir must not start with '-': --json",
    ],
    [
      ["--base", "main", "--cwd", "--merge-base"],
      "--cwd must not start with '-': --merge-base",
    ],
    [["--base", "main", "--cwd=-x"], "--cwd must not start with '-': -x"],
    [["--base", "main", "--cwd="], "--cwd needs a value"],
    [["--base", "main", "--cwd", ""], "--cwd needs a value"],
    [["--base="], "--base needs a value"],
    [
      ["--base", "^main"],
      "--base must name one revision, not an exclusion: ^main",
    ],
    [
      ["--base", "main..feature"],
      "--base must name one revision, not a range: main..feature",
    ],
    [
      ["--base", "main", "--head", "a...b"],
      "--head must name one revision, not a range: a...b",
    ],
    [
      ["--base", "main", "--head", "HEAD\t--all"],
      "--head must not contain whitespace: 'HEAD\t--all'",
    ],
    [
      ["--base", "main next"],
      "--base must not contain whitespace: 'main next'",
    ],
  ])("exits 2 for %j", async (argv, message) => {
    const result = await runGuard(argv, deps(BEFORE));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`jevy guard: ${message}\n`);
    expect(result.stderr).toContain("Usage: jevy guard --base <ref>");
  });

  it("exits 2 for a git error, without the usage text", async () => {
    const result = await runGuard(["--base", "nope"], {
      ...deps(BEFORE),
      openRepo: () => Promise.reject(new GitError("unknown revision 'nope'")),
    });
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "jevy guard: unknown revision 'nope'\n",
    });
  });

  it("prints usage for --help", async () => {
    const result = await runGuard(["--help"], deps(BEFORE));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: jevy guard --base <ref>");
    expect(result.stdout).toContain("Exit codes");
    for (const flag of [
      "--merge-base",
      "--tests <glob>",
      "--cache-dir <dir>",
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  it("says in the usage text that node_modules and dist are never compared", async () => {
    const result = await runGuard(["--help"], deps(BEFORE));
    expect(result.stdout).toMatch(
      /node_modules or dist are never\s+compared,\s+whatever\s+the\s+glob/,
    );
  });

  it("takes --cache-dir and --cwd names that only start with two dots", async () => {
    const after = { "..x/..cache/a.jsonl": APPROVED, "..x/a.spec.ts": SKIPPED };
    expect(
      await found(
        ["--base", "main", "--cwd", "..x", "--cache-dir", "..cache"],
        repo({ "..x/a.spec.ts": TEST }, after),
      ),
    ).toEqual([
      ["..x/..cache/a.jsonl", "approval-added"],
      ["..x/a.spec.ts", "skip-added"],
    ]);
    // A real ".." segment still climbs out.
    const outside = await runGuard(
      ["--base", "main", "--cwd", "..x", "--cache-dir", "../../out"],
      repo({}, {}),
    );
    expect(outside.stderr).toContain(
      "jevy guard: --cache-dir must be inside the repository: ../../out\n",
    );
    const away = await runGuard(["--base", "main", "--cwd", "../other"], {
      ...repo({}, {}),
    });
    expect(away.code).toBe(2);
    expect(away.stderr).toBe(
      "jevy guard: /other is outside the repository at /repo\n",
    );
  });

  it("resolves symlinks in an absolute --cache-dir, on its nearest existing ancestor", async () => {
    // /link is a symlink to /repo; /repo/store does not exist yet.
    const missing = (): Error =>
      Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const linked: GuardDeps = {
      ...repo({}, { "store/new/a.jsonl": APPROVED }),
      realpath: (path) =>
        path === "/link"
          ? Promise.resolve("/repo")
          : path === "/repo"
            ? Promise.resolve(path)
            : Promise.reject(missing()),
    };
    expect(
      await found(["--base", "main", "--cache-dir", "/link/store/new"], linked),
    ).toEqual([["store/new/a.jsonl", "approval-added"]]);
    const result = await runGuard(
      ["--base", "main", "--cache-dir", "/elsewhere/store"],
      linked,
    );
    expect(result.stderr).toContain(
      "jevy guard: --cache-dir must be inside the repository: /elsewhere/store\n",
    );
  });
});

describe("runGuard with what the repository adds for a working tree", () => {
  const base = { "a.spec.ts": TEST, "b.spec.ts": TEST };

  function opened(extra: Partial<GitRepo>): GuardDeps {
    return {
      ...repo(base, base),
      openRepo: () =>
        Promise.resolve({
          root: "/repo",
          reader: memoryReader(base, { ...base, "b.spec.ts": SKIPPED }),
          ...extra,
        }),
    };
  }

  it("adds the findings of the index to those of the working tree, each once", async () => {
    const index = memoryReader(base, {
      "a.spec.ts": SKIPPED,
      "b.spec.ts": SKIPPED,
    });
    const result = await runGuard(
      ["--base", "main", "--json"],
      opened({ index }),
    );
    expect(result.code).toBe(1);
    const report = json(result.stdout);
    expect(report.head).toBe("working-tree");
    expect(report.summary).toEqual({ weakening: 2, review: 0, info: 0 });
    expect(report.findings.map((f) => [f.file, f.kind])).toEqual([
      ["a.spec.ts", "skip-added"],
      ["b.spec.ts", "skip-added"],
    ]);
  });

  it("prints the same bytes with an index that holds nothing new", async () => {
    const index = memoryReader(base, { ...base, "b.spec.ts": SKIPPED });
    const withIndex = await runGuard(
      ["--base", "main", "--json"],
      opened({ index }),
    );
    const without = await runGuard(["--base", "main", "--json"], opened({}));
    expect(withIndex.stdout).toBe(without.stdout);
  });

  it("asks the repository to vouch for the directory it runs in, and exits 2 when it will not", async () => {
    const asked: string[] = [];
    const ok = await runGuard(
      ["--base", "main", "--cwd", "web/app"],
      opened({
        checkDirectory: (dir) => {
          asked.push(dir);
          return Promise.resolve();
        },
      }),
    );
    expect(ok.code).toBe(1);
    expect(asked).toEqual(["web/app"]);
    const refused = await runGuard(
      ["--base", "main"],
      opened({
        checkDirectory: () =>
          Promise.reject(new GitError("git cannot see jevy.config.ts")),
      }),
    );
    expect(refused).toEqual({
      code: 2,
      stdout: "",
      stderr: "jevy guard: git cannot see jevy.config.ts\n",
    });
  });
});

describe("parseGuardArgs", () => {
  it("leaves what was not given for the config or the defaults to decide", () => {
    expect(parseGuardArgs(["--base", "main"])).toEqual({
      base: "main",
      head: undefined,
      json: false,
      failOn: "weakening",
      cacheDir: undefined,
      cwd: undefined,
      mergeBase: false,
      tests: [],
    });
  });

  it("collects every --tests in order and reads the boolean flags", () => {
    expect(
      parseGuardArgs([
        "--tests=b/**",
        "--base",
        "main",
        "--merge-base",
        "--tests",
        "a/*.ts",
        "--cache-dir=.cache",
        "--json",
      ]),
    ).toMatchObject({
      base: "main",
      json: true,
      cacheDir: ".cache",
      mergeBase: true,
      tests: ["b/**", "a/*.ts"],
    });
  });
});

describe("runGuard --merge-base", () => {
  function merged(seen: GitReaderOptions[]): GuardDeps {
    return {
      ...repo(BEFORE, WEAKER),
      openRepo: (options) => {
        seen.push(options);
        return Promise.resolve({
          root: "/repo",
          reader: memoryReader(BEFORE, WEAKER),
          ...(options.mergeBase === true ? { mergeBase: SHA } : {}),
        });
      },
    };
  }

  it("asks git for the merge base and reports it after head", async () => {
    const seen: GitReaderOptions[] = [];
    const result = await runGuard(
      ["--base", "main", "--merge-base", "--json"],
      merged(seen),
    );
    expect(seen).toEqual([
      { cwd: "/repo", base: "main", head: undefined, mergeBase: true },
    ]);
    expect(result.code).toBe(1);
    const report = json(result.stdout);
    expect(report).toMatchObject({ base: "main", mergeBase: SHA });
    expect(Object.keys(report).slice(0, 5)).toEqual([
      "v",
      "tool",
      "base",
      "head",
      "mergeBase",
    ]);
  });

  it("names the merge base in the human header", async () => {
    const result = await runGuard(
      ["--base", "main", "--head", "feature", "--merge-base"],
      merged([]),
    );
    expect(result.stdout.split("\n")[0]).toBe(
      `jevy guard: main..feature (merge base ${SHA})`,
    );
  });

  it("neither asks for it nor reports it without the flag", async () => {
    const seen: GitReaderOptions[] = [];
    const result = await runGuard(["--base", "main", "--json"], merged(seen));
    expect(seen[0]).not.toHaveProperty("mergeBase");
    expect(json(result.stdout)).not.toHaveProperty("mergeBase");
  });
});

describe("runGuard test globs", () => {
  const before = {
    "checks/a.ts": TEST,
    "e2e/b.flow.ts": TEST,
    "c.spec.ts": TEST,
  };
  const after = {
    "checks/a.ts": SKIPPED,
    "e2e/b.flow.ts": SKIPPED,
    "c.spec.ts": SKIPPED,
  };

  it("keeps the built-in pattern with no --tests and no config", async () => {
    expect(await found(["--base", "main"], repo(before, after))).toEqual([
      ["c.spec.ts", "skip-added"],
    ]);
  });

  it("takes --tests several times, in either form, in place of the built-in pattern", async () => {
    expect(
      await found(
        ["--base", "main", "--tests", "checks/**", "--tests=e2e/*.flow.ts"],
        repo(before, after),
      ),
    ).toEqual([
      ["checks/a.ts", "skip-added"],
      ["e2e/b.flow.ts", "skip-added"],
    ]);
  });

  it("reads --tests relative to the directory it runs in", async () => {
    expect(
      await found(
        ["--base", "main", "--cwd", "web", "--tests", "./checks/**"],
        repo(
          { "web/checks/a.ts": TEST, "checks/a.ts": TEST },
          { "web/checks/a.ts": SKIPPED, "checks/a.ts": SKIPPED },
        ),
      ),
    ).toEqual([["web/checks/a.ts", "skip-added"]]);
  });

  it("takes the globs from guard.tests in the config", async () => {
    const cfg = { "jevy.config.ts": config('guard: { tests: ["checks/**"] }') };
    expect(
      await found(
        ["--base", "main"],
        repo({ ...before, ...cfg }, { ...after, ...cfg }),
      ),
    ).toEqual([["checks/a.ts", "skip-added"]]);
  });

  it("prefers --tests to guard.tests", async () => {
    const cfg = { "jevy.config.ts": config('guard: { tests: ["checks/**"] }') };
    expect(
      await found(
        ["--base", "main", "--tests", "e2e/**"],
        repo({ ...before, ...cfg }, { ...after, ...cfg }),
      ),
    ).toEqual([["e2e/b.flow.ts", "skip-added"]]);
  });

  it("reads guard.tests relative to the config's directory", async () => {
    const cfg = {
      "web/jevy.config.ts": config('guard: { tests: ["checks/**"] }'),
    };
    expect(
      await found(
        ["--base", "main", "--cwd", "web"],
        repo(
          { "web/checks/a.ts": TEST, "checks/a.ts": TEST, ...cfg },
          { "web/checks/a.ts": SKIPPED, "checks/a.ts": SKIPPED, ...cfg },
        ),
      ),
    ).toEqual([["web/checks/a.ts", "skip-added"]]);
  });

  it.each([
    ["guard: { tests: [] }", "must list at least one glob"],
    [
      'guard: { tests: ["a/**", "!b"] }',
      'invalid glob "!b": negation (!) is not supported',
    ],
  ])("exits 2 for %s in the config", async (body, message) => {
    const cfg = { "jevy.config.ts": config(body) };
    const result = await runGuard(["--base", "main"], repo(cfg, cfg));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `jevy guard: guard.tests in jevy.config.ts: ${message}\n`,
    );
  });
});

describe("runGuard in a directory named like a glob", () => {
  // The directory is literal text. Read as a pattern, "web{a,b}" would mean
  // the directories "weba" and "webb" and match nothing in this one.
  const before = {
    "web{a,b}/checks/a.ts": TEST,
    "weba/checks/a.ts": TEST,
    "web{a,b}/x/doc.md": "1",
    "weba/x/doc.md": "1",
  };
  const after = {
    "web{a,b}/checks/a.ts": SKIPPED,
    "weba/checks/a.ts": SKIPPED,
    "web{a,b}/x/doc.md": "2",
    "weba/x/doc.md": "2",
  };

  it("reads --tests in that directory and never matches some other one", async () => {
    expect(
      await found(
        ["--base", "main", "--cwd", "web{a,b}", "--tests", "checks/**"],
        repo(before, after),
      ),
    ).toEqual([["web{a,b}/checks/a.ts", "skip-added"]]);
  });

  it("reads guard.tests and protect in its config the same way", async () => {
    const cfg = {
      "web{a,b}/jevy.config.ts": config(
        'guard: { tests: ["checks/**"] }, protect: ["x/**"]',
      ),
    };
    expect(
      await found(
        ["--base", "main", "--cwd", "web{a,b}"],
        repo({ ...before, ...cfg }, { ...after, ...cfg }),
      ),
    ).toEqual([
      ["web{a,b}/checks/a.ts", "skip-added"],
      ["web{a,b}/x/doc.md", "protected-path-changed"],
    ]);
  });

  it("runs there when no glob is in play", async () => {
    const cfg = { "web{a,b}/jevy.config.ts": config('cache: { dir: "c" }') };
    expect(
      await found(
        ["--base", "main", "--cwd", "web{a,b}"],
        repo(cfg, { ...cfg, "web{a,b}/c/x.jsonl": APPROVED }),
      ),
    ).toEqual([["web{a,b}/c/x.jsonl", "approval-added"]]);
  });
});

describe("runGuard settings from the config", () => {
  it("takes the cache directory from cache.dir", async () => {
    const cfg = { "jevy.config.ts": config('cache: { dir: ".cache/d" }') };
    expect(
      await found(
        ["--base", "main"],
        repo(cfg, {
          ...cfg,
          ".cache/d/x.jsonl": APPROVED,
          ".jevy/decisions/y.jsonl": APPROVED,
        }),
      ),
    ).toEqual([[".cache/d/x.jsonl", "approval-added"]]);
  });

  it("finds the config in the directory it runs in, and reads cache.dir from there", async () => {
    const cfg = {
      "jevy.config.ts": config('cache: { dir: "root-cache" }'),
      "web/jevy.config.mjs": config('cache: { dir: "./.cache/d/" }'),
    };
    expect(
      await found(
        ["--base", "main", "--cwd", "web"],
        repo(cfg, {
          ...cfg,
          "web/.cache/d/x.jsonl": APPROVED,
          "root-cache/y.jsonl": APPROVED,
        }),
      ),
    ).toEqual([["web/.cache/d/x.jsonl", "approval-added"]]);
  });

  it("prefers --cache-dir to cache.dir", async () => {
    const cfg = { "jevy.config.ts": config('cache: { dir: ".cache/d" }') };
    expect(
      await found(
        ["--base", "main", "--cache-dir", "other"],
        repo(cfg, {
          ...cfg,
          ".cache/d/x.jsonl": APPROVED,
          "other/y.jsonl": APPROVED,
        }),
      ),
    ).toEqual([["other/y.jsonl", "approval-added"]]);
  });

  it("reads the base config, so a change cannot redefine what is checked", async () => {
    const before = {
      "jevy.config.ts": config(
        'cache: { dir: ".cache/d" }, guard: { tests: ["checks/**"] }, protect: ["docs/**"]',
      ),
      "checks/a.ts": TEST,
      "docs/rules.md": "old",
    };
    const after = {
      "jevy.config.ts": config(
        'cache: { dir: "elsewhere" }, guard: { tests: ["nowhere/**"] }, protect: []',
      ),
      "checks/a.ts": SKIPPED,
      "docs/rules.md": "new",
      ".cache/d/x.jsonl": APPROVED,
    };
    const all = await found(["--base", "main"], repo(before, after));
    expect(all.filter(([file]) => file !== "jevy.config.ts")).toEqual([
      [".cache/d/x.jsonl", "approval-added"],
      ["checks/a.ts", "skip-added"],
      ["docs/rules.md", "protected-path-changed"],
    ]);
    expect(all).toContainEqual(["jevy.config.ts", "protected-path-changed"]);
  });

  it("reads the base config even when the change deletes it", async () => {
    const before = {
      "jevy.config.ts": config('guard: { tests: ["checks/**"] }'),
      "checks/a.ts": TEST,
    };
    const all = await found(
      ["--base", "main"],
      repo(before, { "checks/a.ts": SKIPPED }),
    );
    expect(all).toContainEqual(["checks/a.ts", "skip-added"]);
    expect(all).toContainEqual(["jevy.config.ts", "protected-path-changed"]);
  });

  it("reads the head config when base has none", async () => {
    const all = await found(
      ["--base", "main"],
      repo(
        {},
        {
          "jevy.config.ts": config('cache: { dir: ".cache/d" }'),
          ".cache/d/x.jsonl": APPROVED,
        },
      ),
    );
    expect(all).toContainEqual([".cache/d/x.jsonl", "approval-added"]);
    expect(all).toContainEqual(["jevy.config.ts", "protected-path-changed"]);
  });

  it("lets a config only head has add test globs, never replace the built-in pattern", async () => {
    const cfg = { "jevy.config.ts": config('guard: { tests: ["checks/**"] }') };
    const all = await found(
      ["--base", "main"],
      repo(
        { "tests/a.spec.ts": TEST, "checks/b.ts": TEST, "src/c.ts": TEST },
        { ...cfg, "checks/b.ts": SKIPPED, "src/c.ts": SKIPPED },
      ),
    );
    expect(all).toEqual([
      ["checks/b.ts", "skip-added"],
      ["jevy.config.ts", "config-changed"],
      ["jevy.config.ts", "protected-path-changed"],
      ["tests/a.spec.ts", "test-file-removed"],
    ]);
  });

  it("still lets --tests replace the pattern when only head has a config", async () => {
    const cfg = { "jevy.config.ts": config('guard: { tests: ["checks/**"] }') };
    const all = await found(
      ["--base", "main", "--tests", "src/**"],
      repo(
        { "tests/a.spec.ts": TEST, "checks/b.ts": TEST, "src/c.ts": TEST },
        { ...cfg, "checks/b.ts": SKIPPED, "src/c.ts": SKIPPED },
      ),
    );
    expect(all.filter(([file]) => file !== "jevy.config.ts")).toEqual([
      ["src/c.ts", "skip-added"],
    ]);
  });

  it("still refuses an empty or invalid guard.tests in a config only head has", async () => {
    const result = await runGuard(
      ["--base", "main"],
      repo({}, { "jevy.config.ts": config("guard: { tests: [] }") }),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      "jevy guard: guard.tests in jevy.config.ts: must list at least one glob\n",
    );
  });

  const LITERAL =
    "it must be a literal the guard can read without running the config";

  it.each([
    [
      "cache: { dir: process.env.DIR }",
      `cannot read cache.dir in the base version of jevy.config.ts: ${LITERAL} (or pass --cache-dir)`,
    ],
    [
      "guard: { tests: globs() }",
      `cannot read guard.tests in the base version of jevy.config.ts: ${LITERAL} (or pass --tests)`,
    ],
    [
      "protect: list",
      `cannot read protect in the base version of jevy.config.ts: ${LITERAL}`,
    ],
    [
      "web3: { policy: path }",
      `cannot read web3.policy in the base version of jevy.config.ts: ${LITERAL}`,
    ],
    [
      "...shared",
      `cannot read cache.dir in the base version of jevy.config.ts: ${LITERAL} (or pass --cache-dir)`,
    ],
  ])("exits 2 when the config has { %s }", async (body, message) => {
    const cfg = { "jevy.config.ts": config(body) };
    const result = await runGuard(["--base", "main"], repo(cfg, cfg));
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `jevy guard: ${message}\n`,
    });
  });

  describe("toSatisfy.blocking, read from the base config", () => {
    // Changed on purpose: only `@jevyjs/playwright`'s toSatisfy is advisory,
    // so the test imports Jevy's expect instead of using a global one.
    const ADVISORY = `import { test, expect } from "@jevyjs/playwright";\ntest("a", async ({ page }) => {\n  await expect(page).toSatisfy("The cart is empty");\n});\n`;
    const files = (cfg: string | null): Files => ({
      ...(cfg === null ? {} : { "jevy.config.ts": config(cfg) }),
    });
    const kinds = async (deps: GuardDeps): Promise<string[]> =>
      (await found(["--base", "main"], deps)).map(([, kind]) => kind);

    it("reports a new test checked by toSatisfy alone when nothing makes it blocking", async () => {
      expect(await kinds(repo({}, { "a.spec.ts": ADVISORY }))).toEqual([
        "test-added",
        "only-advisory-assertions",
      ]);
      const off = files("toSatisfy: { blocking: false }");
      expect(await kinds(repo(off, { ...off, "a.spec.ts": ADVISORY }))).toEqual(
        ["test-added", "only-advisory-assertions"],
      );
    });

    it("says nothing more when the base config makes toSatisfy blocking", async () => {
      const on = files("toSatisfy: { blocking: true }");
      expect(await kinds(repo(on, { ...on, "a.spec.ts": ADVISORY }))).toEqual([
        "test-added",
      ]);
    });

    it("does not let the change switch blocking on to silence the finding", async () => {
      const on = files("toSatisfy: { blocking: true }");
      const off = files("toSatisfy: { blocking: false }");
      // Only head has a config: what the change wrote widens, never narrows.
      expect(await kinds(repo({}, { ...on, "a.spec.ts": ADVISORY }))).toContain(
        "only-advisory-assertions",
      );
      // Base says false and head says true: base wins.
      expect(
        await kinds(repo(off, { ...on, "a.spec.ts": ADVISORY })),
      ).toContain("only-advisory-assertions");
    });

    it("reports the new tests of a change that also switches blocking off", async () => {
      const on = files("toSatisfy: { blocking: true }");
      const off = files("toSatisfy: { blocking: false }");
      const both = ["blocking-switched-off", "only-advisory-assertions"];
      // Switched off, removed, or shadowed by a config the loader reads first.
      for (const head of [off, {}]) {
        expect(
          await kinds(repo(on, { ...head, "a.spec.ts": ADVISORY })),
        ).toEqual(expect.arrayContaining(both));
      }
      const mts = {
        "jevy.config.mts": config("toSatisfy: { blocking: true }"),
      };
      expect(
        await kinds(
          repo(mts, {
            ...mts,
            "jevy.config.ts": config(""),
            "a.spec.ts": ADVISORY,
          }),
        ),
      ).toEqual(expect.arrayContaining(both));
    });

    it("reads blocking: void 0 in the base config as absent, as core does", async () => {
      const cfg = files("toSatisfy: { blocking: void 0 }");
      expect(await kinds(repo(cfg, { ...cfg, "a.spec.ts": ADVISORY }))).toEqual(
        ["test-added", "only-advisory-assertions"],
      );
    });

    it("exits 2 when the base config sets it in a way it cannot read", async () => {
      const cfg = files("toSatisfy: { blocking: process.env.CI }");
      const result = await runGuard(["--base", "main"], repo(cfg, cfg));
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: `jevy guard: cannot read toSatisfy.blocking in the base version of jevy.config.ts: ${LITERAL}\n`,
      });
    });

    it("does not need it from a config only head has, which it does not use", async () => {
      const cfg = files("toSatisfy: { blocking: process.env.CI }");
      expect(
        await kinds(repo({}, { ...cfg, "a.spec.ts": ADVISORY })),
      ).toContain("only-advisory-assertions");
    });
  });

  it("exits 2 when it cannot find the config object at all", async () => {
    const cfg = { "jevy.config.ts": "export default makeConfig();\n" };
    const result = await runGuard(
      ["--base", "main", "--cache-dir", "c", "--tests", "t/**"],
      repo(cfg, cfg),
    );
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "jevy guard: cannot read the settings in the base version of jevy.config.ts: the config must be an object literal the guard can read without running it\n",
    });
  });

  it("says so when the unreadable config is the head version", async () => {
    const result = await runGuard(
      ["--base", "main"],
      repo({}, { "web/x.ts": "1", "jevy.config.js": config("protect: list") }),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `jevy guard: cannot read protect in the head version of jevy.config.js: ${LITERAL}\n`,
    );
  });

  it("does not need cache.dir or guard.tests as literals when a flag replaces them", async () => {
    const cfg = {
      "jevy.config.ts": config(
        "cache: { dir: process.env.DIR }, guard: { tests: globs() }",
      ),
    };
    const files = { ...cfg, "t/a.ts": TEST };
    const args = ["--base", "main", "--cache-dir", "c", "--tests", "t/**"];
    expect(
      await found(args, repo(files, { ...files, "t/a.ts": SKIPPED })),
    ).toEqual([["t/a.ts", "skip-added"]]);
    // Each flag excuses only its own key.
    const half = await runGuard(args.slice(0, 4), repo(files, files));
    expect(half.code).toBe(2);
    expect(half.stderr).toContain("cannot read guard.tests in");
  });

  it("still needs protect as a literal whatever the flags", async () => {
    const cfg = { "jevy.config.ts": config("protect: list") };
    const result = await runGuard(
      ["--base", "main", "--cache-dir", "c", "--tests", "t/**"],
      repo(cfg, cfg),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read protect in");
  });

  it.each([
    [
      'cache: { dir: "." }',
      "cache.dir in jevy.config.ts must be a directory below the repository root, not the root itself: .",
    ],
    [
      'cache: { dir: "../out" }',
      "cache.dir in jevy.config.ts must be inside the repository: ../out",
    ],
    ['cache: { dir: "" }', "cache.dir in jevy.config.ts is empty"],
    [
      'protect: ["/etc/passwd"]',
      'protect entry "/etc/passwd" in the Jevy config is an absolute path; write it relative to the config\'s directory',
    ],
  ])("exits 2, without the usage text, for { %s }", async (body, message) => {
    const cfg = { "jevy.config.ts": config(body) };
    const result = await runGuard(["--base", "main"], repo(cfg, cfg));
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `jevy guard: ${message}\n`,
    });
  });
});

describe("runGuard protected paths", () => {
  it("reports a changed config as a protected path, next to what changed in it", async () => {
    const result = await runGuard(
      ["--base", "main", "--json"],
      repo(
        { "jevy.config.ts": config("thresholds: { pass: 0.8 }") },
        { "jevy.config.ts": config("thresholds: { pass: 0.5 }") },
      ),
    );
    expect(result.code).toBe(1);
    const report = json(result.stdout);
    expect(report.summary).toEqual({ weakening: 2, review: 0, info: 0 });
    expect(report.findings.map((f) => [f.file, f.kind])).toEqual([
      ["jevy.config.ts", "protected-path-changed"],
      ["jevy.config.ts", "threshold-lowered"],
    ]);
  });

  it("reports other files under the cache directory, but not decision records", async () => {
    expect(
      await found(
        ["--base", "main"],
        repo(
          { ".jevy/decisions/a.jsonl": "", ".jevy/decisions/.gitignore": "" },
          {
            ".jevy/decisions/a.jsonl": '{"reviewedBy":null}\n',
            ".jevy/decisions/.gitignore": "*\n",
          },
        ),
      ),
    ).toEqual([
      [".jevy/decisions/.gitignore", "protected-path-changed"],
      [".jevy/decisions/a.jsonl", "decision-added"],
    ]);
  });

  it("reports files matched by protect and web3.policy, relative to the config", async () => {
    const cfg = {
      "web/jevy.config.ts": config(
        'protect: ["critical/**"], web3: { policy: "./wallet.json" }',
      ),
    };
    expect(
      await found(
        ["--base", "main", "--cwd", "web"],
        repo(
          { ...cfg, "critical/a.ts": "1" },
          {
            ...cfg,
            "web/critical/a.ts": "1",
            "critical/a.ts": "2",
            "shared/notes.md": "1",
            "web/wallet.json": "{}",
            "wallet.json": "{}",
          },
        ),
      ),
    ).toEqual([
      ["web/critical/a.ts", "protected-path-changed"],
      ["web/wallet.json", "protected-path-changed"],
    ]);
    // A protect entry may not climb out of the config's directory: core's
    // loader refuses a ".." segment, so the guard refuses it too.
    const climbing = {
      "web/jevy.config.ts": config(
        'protect: ["critical/**", "../shared/*.md"]',
      ),
    };
    const result = await runGuard(
      ["--base", "main", "--cwd", "web"],
      repo(climbing, { ...climbing, "shared/notes.md": "1" }),
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'protect entry "../shared/*.md" in the Jevy config cannot be used',
    );
  });

  it("protects every Jevy config and the cache directory with no config where it runs", async () => {
    expect(
      await found(
        ["--base", "main"],
        repo(
          {},
          {
            "apps/web/jevy.config.mjs": config(""),
            ".jevy/decisions/notes.txt": "x",
            "src/app.ts": "y",
          },
        ),
      ),
    ).toEqual([
      [".jevy/decisions/notes.txt", "protected-path-changed"],
      ["apps/web/jevy.config.mjs", "config-changed"],
      ["apps/web/jevy.config.mjs", "protected-path-changed"],
    ]);
  });
});
