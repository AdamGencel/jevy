import { describe, expect, it } from "vitest";
import { runGuard, type GuardDeps } from "./command.js";
import { GitError } from "./errors.js";
import { memoryReader, type GitReaderOptions } from "./git.js";
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
  });
});
