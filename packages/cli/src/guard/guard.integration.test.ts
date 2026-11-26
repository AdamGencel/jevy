import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type CliResult } from "../cli.js";
import type { GuardReport } from "./types.js";

/**
 * End to end against a real git repository in a temporary directory: the
 * command, git, the working tree and the JSON output together.
 */

/**
 * These tests start git many times each. On a busy machine that takes far
 * longer than the default five seconds without anything being wrong.
 */
const REAL_GIT = { timeout: 60_000 };

const SPEC = `import { test, expect } from "@playwright/test";

test.describe("checkout", () => {
  test("pays by card", async ({ page }) => {
    await expect(page.getByRole("status")).toHaveText("Paid");
    await expect(page).toSatisfy("The order is shown as confirmed");
  });
});
`;

const CONFIG = `import { defineConfig } from "@jevyjs/core";
export default defineConfig({ thresholds: { pass: 0.8, fail: 0.5 } });
`;

const RECORD = JSON.stringify({
  v: 1,
  key: "sha256:aa",
  spec: "tests/checkout.spec.ts",
  step: "toSatisfy#1",
  verdict: "pass",
  reviewedBy: null,
});

let repo = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

/** Put the working tree back to the last commit, untracked files included. */
function reset(): void {
  git("reset", "-q", "--hard");
  git("clean", "-q", "-fd");
}

async function guard(...args: string[]) {
  const result = await run(["guard", "--cwd", repo, ...args], "0.0.1");
  return result;
}

function report(stdout: string): GuardReport {
  return JSON.parse(stdout) as GuardReport;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "jevy-guard-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jevy Test");
  git("config", "user.email", "jevy-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("tests/checkout.spec.ts", SPEC);
  write("jevy.config.ts", CONFIG);
  write(".jevy/decisions/tests/checkout.spec.ts.jsonl", `${RECORD}\n`);
  write("src/app.ts", "export const app = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("jevy guard against a real repository", REAL_GIT, () => {
  it("exits 0 with no findings when nothing changed", async () => {
    const result = await guard("--base", "main", "--json");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(report(result.stdout)).toEqual({
      v: 1,
      tool: "jevy-guard",
      base: "main",
      head: "working-tree",
      summary: { weakening: 0, review: 0, info: 0 },
      findings: [],
    });
  });

  it("reports weakening in the working tree, untracked files included", async () => {
    write(
      "tests/checkout.spec.ts",
      SPEC.replace('test("pays by card"', 'test.skip("pays by card"').replace(
        '    await expect(page.getByRole("status")).toHaveText("Paid");\n',
        "",
      ),
    );
    write("jevy.config.ts", CONFIG.replace("pass: 0.8", "pass: 0.6"));
    write("src/app.ts", "export const app = 2;\n");
    const approved = JSON.stringify({
      ...JSON.parse(RECORD),
      key: "sha256:bb",
      reviewedBy: "agent",
    });
    write(".jevy/decisions/tests/new.spec.ts.jsonl", `${approved}\n`);
    try {
      const result = await guard("--base", "main", "--json");
      expect(result.code).toBe(1);
      const found = report(result.stdout);
      // The config is a protected path, so changing it is a finding of its
      // own next to what changed inside it.
      expect(found.summary).toEqual({ weakening: 5, review: 0, info: 0 });
      expect(found.findings.map((f) => [f.file, f.kind])).toEqual([
        [".jevy/decisions/tests/new.spec.ts.jsonl", "approval-added"],
        ["jevy.config.ts", "protected-path-changed"],
        ["jevy.config.ts", "threshold-lowered"],
        ["tests/checkout.spec.ts", "assertion-removed"],
        ["tests/checkout.spec.ts", "skip-added"],
      ]);

      const never = await guard(
        "--base",
        "main",
        "--json",
        "--fail-on",
        "never",
      );
      expect(never.code).toBe(0);
      expect(never.stdout).toBe(result.stdout);

      const human = await guard("--base", "main");
      expect(human.code).toBe(1);
      expect(human.stdout).toContain(
        "tests/checkout.spec.ts\n  weakening  assertion-removed",
      );
    } finally {
      reset();
    }
  });

  it("prints byte-identical JSON on two runs", async () => {
    write(
      "tests/checkout.spec.ts",
      SPEC.replace("toHaveText", "toContainText"),
    );
    write("tests/other.test.ts", 'test("x", () => { expect(1).toBe(1); });\n');
    try {
      const first = await guard("--base", "main", "--json");
      const second = await guard("--base", "main", "--json");
      expect(first.stdout).not.toBe("");
      expect(second.stdout).toBe(first.stdout);
    } finally {
      reset();
    }
  });

  it("compares two commits, following a rename to its old path", async () => {
    git("checkout", "-q", "-b", "feature");
    try {
      git("mv", "tests/checkout.spec.ts", "tests/payments.spec.ts");
      write(
        "tests/payments.spec.ts",
        SPEC.replace(
          '    await expect(page).toSatisfy("The order is shown as confirmed");\n',
          "",
        ),
      );
      git("commit", "-q", "-am", "rename and weaken");
      // The working tree is clean again, so only --head sees the change.
      const result = await guard(
        "--base",
        "main",
        "--head",
        "feature",
        "--json",
      );
      expect(result.code).toBe(1);
      const found = report(result.stdout);
      expect(found.head).toBe("feature");
      expect(found.findings).toMatchObject([
        {
          kind: "assertion-removed",
          file: "tests/payments.spec.ts",
          test: ["checkout", "pays by card"],
          message: expect.stringContaining("removed toSatisfy") as string,
        },
      ]);
      expect((await guard("--base", "feature", "--json")).code).toBe(0);
    } finally {
      git("checkout", "-q", "main");
    }
  });

  it("exits 2 for a ref that does not exist", async () => {
    const result = await guard("--base", "no-such-ref", "--json");
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "jevy guard: unknown revision 'no-such-ref'\n",
    });
  });

  it("exits 2 outside a git repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jevy-guard-none-"));
    try {
      const result = await run(
        ["guard", "--cwd", outside, "--base", "main"],
        "0.0.1",
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/^jevy guard: git rev-parse failed: /);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("--merge-base", () => {
    let baseline = "";

    // main gains a test file and a test after `topic` branched; `topic`
    // itself touches no test.
    beforeAll(() => {
      baseline = git("rev-parse", "HEAD").trim();
      git("checkout", "-q", "-b", "topic");
      write("src/app.ts", "export const app = 3;\n");
      git("commit", "-q", "-am", "topic work");
      git("checkout", "-q", "main");
      write(
        "tests/later.spec.ts",
        'test("later", () => { expect(total).toBe(1); });\n',
      );
      write(
        "tests/checkout.spec.ts",
        `${SPEC}\ntest("refunds", async ({ page }) => {\n  await expect(page.getByRole("status")).toHaveText("Refunded");\n});\n`,
      );
      git("add", "-A");
      git("commit", "-q", "-m", "main gains tests");
      git("checkout", "-q", "--orphan", "unrelated");
      git("commit", "-q", "-m", "no shared history");
      git("checkout", "-q", "main");
    });

    afterAll(() => {
      git("checkout", "-q", "main");
      git("reset", "-q", "--hard", baseline);
      git("branch", "-q", "-D", "topic", "unrelated");
    });

    const REMOVED = [
      ["tests/checkout.spec.ts", "test-removed"],
      ["tests/later.spec.ts", "test-file-removed"],
    ];

    it("stops blaming --head for tests the target branch gained later", async () => {
      const tip = await guard("--base", "main", "--head", "topic", "--json");
      expect(tip.code).toBe(1);
      expect(report(tip.stdout).findings.map((f) => [f.file, f.kind])).toEqual(
        REMOVED,
      );
      expect(report(tip.stdout)).not.toHaveProperty("mergeBase");

      const merged = await guard(
        "--base",
        "main",
        "--head",
        "topic",
        "--merge-base",
        "--json",
      );
      expect(merged.stderr).toBe("");
      expect(merged.code).toBe(0);
      expect(report(merged.stdout)).toEqual({
        v: 1,
        tool: "jevy-guard",
        base: "main",
        head: "topic",
        mergeBase: baseline,
        summary: { weakening: 0, review: 0, info: 0 },
        findings: [],
      });
    });

    it("does the same for the working tree, against HEAD's merge base", async () => {
      git("checkout", "-q", "topic");
      try {
        const tip = await guard("--base", "main", "--json");
        expect(tip.code).toBe(1);
        expect(
          report(tip.stdout).findings.map((f) => [f.file, f.kind]),
        ).toEqual(REMOVED);

        const merged = await guard("--base", "main", "--merge-base", "--json");
        expect(merged.code).toBe(0);
        expect(report(merged.stdout)).toMatchObject({
          base: "main",
          head: "working-tree",
          mergeBase: baseline,
          findings: [],
        });

        // It still sees what the working tree itself weakens.
        write(
          "tests/checkout.spec.ts",
          SPEC.replace('test("pays by card"', 'test.skip("pays by card"'),
        );
        const weakened = await guard(
          "--base",
          "main",
          "--merge-base",
          "--json",
        );
        expect(weakened.code).toBe(1);
        expect(
          report(weakened.stdout).findings.map((f) => [f.file, f.kind]),
        ).toEqual([["tests/checkout.spec.ts", "skip-added"]]);

        const human = await guard("--base", "main", "--merge-base");
        expect(human.stdout.split("\n")[0]).toBe(
          `jevy guard: main..working-tree (merge base ${baseline})`,
        );
      } finally {
        reset();
        git("checkout", "-q", "main");
      }
    });

    it("exits 2 when there is no common ancestor, and says to fetch history", async () => {
      const result = await guard("--base", "unrelated", "--merge-base");
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^jevy guard: --merge-base found no common ancestor of 'unrelated' and 'HEAD'\. .*git fetch --unshallow.*\n$/,
      );
      expect(result.stderr).not.toContain("Usage:");
    });
  });

  describe("settings from the config", () => {
    const WEB_CONFIG = `export default {
  cache: { dir: "store" },
  guard: { tests: ["checks/**"] },
  protect: ["docs/**"],
};
`;
    const CHECK = 'test("a", () => { expect(total).toBe(1); });\n';

    async function guardIn(dir: string, ...args: string[]) {
      return run(["guard", "--cwd", join(repo, dir), ...args], "0.0.1");
    }

    // `configured` adds a package with its own config to main's baseline.
    beforeAll(() => {
      git("checkout", "-q", "-b", "configured");
      write("web/jevy.config.ts", WEB_CONFIG);
      write("web/checks/a.ts", CHECK);
      write("web/docs/rules.md", "Never skip a test.\n");
      git("add", "-A");
      git("commit", "-q", "-m", "a package with its own config");
    });

    afterAll(() => {
      reset();
      git("checkout", "-q", "main");
      git("branch", "-q", "-D", "configured");
    });

    it("reads the base config, whatever the working tree changed it to", async () => {
      write(
        "web/jevy.config.ts",
        WEB_CONFIG.replace('"store"', '"elsewhere"')
          .replace('"checks/**"', '"nowhere/**"')
          .replace('"docs/**"', '"nothing/**"'),
      );
      write("web/checks/a.ts", CHECK.replace("test(", "test.skip("));
      write("web/docs/rules.md", "Skip what you like.\n");
      write(
        "web/store/x.jsonl",
        `${JSON.stringify({ reviewedBy: "agent" })}\n`,
      );
      write("web/store/notes.txt", "not a record\n");
      try {
        const result = await guardIn("web", "--base", "configured", "--json");
        expect(result.stderr).toBe("");
        expect(result.code).toBe(1);
        const found = report(result.stdout).findings.map((f) => [
          f.file,
          f.kind,
        ]);
        expect(found.filter(([file]) => file !== "web/jevy.config.ts")).toEqual(
          [
            ["web/checks/a.ts", "skip-added"],
            ["web/docs/rules.md", "protected-path-changed"],
            ["web/store/notes.txt", "protected-path-changed"],
            ["web/store/x.jsonl", "approval-added"],
          ],
        );
        expect(found).toContainEqual([
          "web/jevy.config.ts",
          "protected-path-changed",
        ]);

        // From the root there is no config, so the built-in pattern and the
        // default cache directory apply: only the config itself is reported.
        const root = await guard("--base", "configured", "--json");
        expect(
          report(root.stdout)
            .findings.map((f) => f.file)
            .filter((file) => file !== "web/jevy.config.ts"),
        ).toEqual([]);
      } finally {
        reset();
      }
    });

    it("reads the head config when base has none", async () => {
      const result = await guardIn(
        "web",
        "--base",
        "main",
        "--head",
        "configured",
        "--json",
      );
      expect(result.stderr).toBe("");
      const found = report(result.stdout).findings.map((f) => [f.file, f.kind]);
      // `checks/a.ts` is a test only by the head config's guard.tests.
      expect(found).toContainEqual(["web/checks/a.ts", "test-added"]);
      expect(found).toContainEqual([
        "web/jevy.config.ts",
        "protected-path-changed",
      ]);
      expect(found).toContainEqual([
        "web/docs/rules.md",
        "protected-path-changed",
      ]);
    });

    it("exits 2 when a setting it needs is not a literal", async () => {
      write(
        "web/jevy.config.ts",
        WEB_CONFIG.replace('"store"', "process.env.STORE"),
      );
      git("commit", "-q", "-am", "cache dir from the environment");
      try {
        const result = await guardIn("web", "--base", "configured");
        expect(result).toEqual({
          code: 2,
          stdout: "",
          stderr:
            "jevy guard: cannot read cache.dir in the base version of web/jevy.config.ts: it must be a literal the guard can read without running the config (or pass --cache-dir)\n",
        });
        expect(
          (await guardIn("web", "--base", "configured", "--cache-dir", "store"))
            .code,
        ).toBe(0);
      } finally {
        git("reset", "-q", "--hard", "HEAD~1");
      }
    });

    it("takes --tests and --cache-dir relative to the directory it runs in", async () => {
      write("web/e2e/b.ts", CHECK);
      write("web/other/y.jsonl", `${JSON.stringify({ reviewedBy: "me" })}\n`);
      try {
        const result = await guardIn(
          "web",
          "--base",
          "configured",
          "--tests",
          "e2e/**",
          "--tests=never/**",
          "--cache-dir",
          "other",
          "--json",
        );
        expect(
          report(result.stdout).findings.map((f) => [f.file, f.kind]),
        ).toEqual([
          ["web/e2e/b.ts", "test-added"],
          ["web/other/y.jsonl", "approval-added"],
        ]);
      } finally {
        reset();
      }
    });
  });

  it("exits 2 for --cache-dir at the repository root, and says why", async () => {
    const result = await guard("--base", "main", "--cache-dir", ".");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "jevy guard: --cache-dir must be a directory below the repository root, not the root itself: .\n",
    );
  });
});

/**
 * What an agent that controls the working tree, the index and the local refs
 * can do to end on "No findings". Each test builds its own repository, so
 * one test's tampering never reaches another.
 */
describe(
  "jevy guard against a repository that hides a change",
  REAL_GIT,
  () => {
    const TEST = `test("a", () => {
  expect(total).toBe(1);
  expect(count).toBe(2);
});
`;
    const WEAK = TEST.replace("  expect(count).toBe(2);\n", "");
    const REMOVED = [["tests/a.spec.ts", "assertion-removed"]];

    interface Scratch {
      readonly dir: string;
      readonly git: (...args: string[]) => string;
      readonly write: (path: string, text: string) => void;
      /** Run the guard in `sub` ("" for the root) of the repository. */
      readonly guardIn: (sub: string, ...args: string[]) => Promise<CliResult>;
      readonly guard: (...args: string[]) => Promise<CliResult>;
    }

    const made: string[] = [];

    function tempDir(): string {
      // Resolved, so paths built from it are the ones git reports.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-guard-")));
      made.push(dir);
      return dir;
    }

    function open(dir: string): Scratch {
      const gitIn = (...args: string[]): string =>
        execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      const guardIn = (sub: string, ...args: string[]): Promise<CliResult> =>
        run(["guard", "--cwd", join(dir, sub), ...args], "0.0.1");
      return {
        dir,
        git: gitIn,
        write: (path, text) => {
          const full = join(dir, path);
          mkdirSync(join(full, ".."), { recursive: true });
          writeFileSync(full, text);
        },
        guardIn,
        guard: (...args) => guardIn("", ...args),
      };
    }

    function identify(scratch: Scratch): void {
      scratch.git("config", "user.name", "Jevy Test");
      scratch.git("config", "user.email", "jevy-test@example.invalid");
      scratch.git("config", "commit.gpgsign", "false");
    }

    /** A repository whose `main` holds `files` in one commit. */
    function scratch(files: Readonly<Record<string, string>>): Scratch {
      const fresh = open(tempDir());
      fresh.git("init", "-q", "-b", "main");
      identify(fresh);
      for (const [path, text] of Object.entries(files)) {
        fresh.write(path, text);
      }
      fresh.git("add", "-A");
      fresh.git("commit", "-q", "-m", "baseline");
      return fresh;
    }

    function kinds(result: CliResult): (readonly [string, string])[] {
      expect(result.stderr).toBe("");
      return report(result.stdout).findings.map(
        (f) => [f.file, f.kind] as const,
      );
    }

    afterAll(() => {
      for (const dir of made) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    describe("a config git ignores", () => {
      const NARROW = 'export default { guard: { tests: ["nowhere/**"] } };\n';

      it("exits 2 rather than take its settings from a file git does not report", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        repo.write(".git/info/exclude", "jevy.config.ts\n");
        repo.write("jevy.config.ts", NARROW);
        repo.write("tests/a.spec.ts", WEAK);
        for (const extra of [[], ["--merge-base"]]) {
          const result = await repo.guard("--base", "main", ...extra);
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toMatch(
            /^jevy guard: jevy\.config\.ts .*cannot see changes to a config git ignores/,
          );
        }
        // Comparing commits never reads the ignored file.
        expect(
          (await repo.guard("--base", "main", "--head", "HEAD")).code,
        ).toBe(0);
      });

      it("exits 2 when the ignored file moves the cache directory", async () => {
        const repo = scratch({ "src/app.ts": "1\n" });
        repo.write(".git/info/exclude", "jevy.config.mjs\n");
        repo.write(
          "jevy.config.mjs",
          'export default { cache: { dir: "elsewhere" } };\n',
        );
        repo.write(".jevy/decisions/a.jsonl", '{"reviewedBy":"agent"}\n');
        const result = await repo.guard("--base", "main");
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("jevy.config.mjs");
      });

      it("exits 2 when it shadows the tracked config in a package", async () => {
        const repo = scratch({
          "web/jevy.config.mjs": 'export default { protect: ["docs/**"] };\n',
          "web/docs/a.md": "1\n",
        });
        repo.write(".gitignore", "jevy.config.ts\n");
        repo.git("add", ".gitignore");
        repo.git("commit", "-q", "-m", "ignore");
        repo.write("web/jevy.config.ts", "export default {};\n");
        const result = await repo.guardIn("web", "--base", "main");
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("web/jevy.config.ts");
        expect(result.stderr).toContain(
          "cannot see changes to a config git ignores",
        );
      });

      it("still runs with a config git does report, tracked or new", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        repo.write("jevy.config.ts", "export default {};\n");
        expect(kinds(await repo.guard("--base", "main", "--json"))).toEqual([
          ["jevy.config.ts", "config-changed"],
          ["jevy.config.ts", "protected-path-changed"],
        ]);
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "config");
        expect(kinds(await repo.guard("--base", "main", "--json"))).toEqual([]);
      });
    });

    describe("a config only the head version has", () => {
      it("adds its test globs to the built-in pattern and never replaces it", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST, "checks/b.ts": TEST });
        repo.git("checkout", "-q", "-b", "work");
        repo.write(
          "jevy.config.ts",
          'export default { guard: { tests: ["none/**"] } };\n',
        );
        repo.git("rm", "-q", "tests/a.spec.ts");
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "narrow and delete");
        const result = await repo.guard(
          "--base",
          "main",
          "--head",
          "work",
          "--json",
        );
        expect(result.code).toBe(1);
        expect(kinds(result)).toEqual([
          ["jevy.config.ts", "config-changed"],
          ["jevy.config.ts", "protected-path-changed"],
          ["tests/a.spec.ts", "test-file-removed"],
        ]);
      });
    });

    // A disk that ignores case: macOS and Windows by default.
    const caseSensitive = ((): boolean => {
      const probe = mkdtempSync(join(tmpdir(), "jevy-case-"));
      try {
        return !existsSync(probe.toUpperCase());
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    })();

    describe("a run directory spelled differently from git's", () => {
      it.skipIf(caseSensitive)(
        "exits 2 naming both spellings (needs a file system that ignores case; this one does not)",
        async () => {
          const repo = scratch({
            "pkg/jevy.config.ts":
              'export default { protect: ["contracts/**"], guard: { tests: ["e2e/**"] } };\n',
            "pkg/e2e/a.ts": TEST,
            "pkg/contracts/c.sol": "1\n",
          });
          repo.write("pkg/e2e/a.ts", WEAK);
          repo.write("pkg/contracts/c.sol", "2\n");
          expect(
            kinds(await repo.guardIn("pkg", "--base", "main", "--json")),
          ).toEqual([
            ["pkg/contracts/c.sol", "protected-path-changed"],
            ["pkg/e2e/a.ts", "assertion-removed"],
          ]);

          renameSync(join(repo.dir, "pkg"), join(repo.dir, "pkg_tmp"));
          renameSync(join(repo.dir, "pkg_tmp"), join(repo.dir, "Pkg"));
          expect(repo.git("status", "--short")).toBe(
            " M pkg/contracts/c.sol\n M pkg/e2e/a.ts\n",
          );
          for (const args of [
            ["--base", "main"],
            ["--base", "main", "--head", "HEAD"],
          ]) {
            const result = await repo.guardIn("Pkg", ...args);
            expect(result.code).toBe(2);
            expect(result.stdout).toBe("");
            expect(result.stderr).toMatch(/^jevy guard: .*"Pkg".*"pkg"/);
          }
        },
      );

      it("runs in a directory git has never heard of", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        mkdirSync(join(repo.dir, "fresh"));
        expect(
          kinds(await repo.guardIn("fresh", "--base", "main", "--json")),
        ).toEqual([]);
      });
    });

    describe("an ambiguous ref", () => {
      function cloned(): Scratch {
        const origin = scratch({ "tests/a.spec.ts": TEST });
        const dir = tempDir();
        execFileSync("git", ["clone", "-q", `file://${origin.dir}`, dir], {
          encoding: "utf8",
        });
        const clone = open(dir);
        identify(clone);
        clone.git("checkout", "-q", "-b", "work");
        clone.git("rm", "-q", "tests/a.spec.ts");
        clone.git("commit", "-q", "-m", "delete the test");
        return clone;
      }

      const COMMITS = ["--base", "origin/main", "--head", "HEAD"];

      it("exits 2 when a tag takes the name of the remote branch", async () => {
        const clone = cloned();
        expect((await clone.guard(...COMMITS)).code).toBe(1);
        clone.git("tag", "origin/main");
        for (const extra of [[], ["--merge-base"]]) {
          const result = await clone.guard(...COMMITS, ...extra);
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toMatch(/^jevy guard: .*ambiguous/);
          expect(result.stderr).toContain("refs/tags/origin/main");
          expect(result.stderr).toContain("refs/remotes/origin/main");
        }
        // The working-tree comparison resolves the name the same way.
        expect((await clone.guard("--base", "origin/main")).code).toBe(2);
        // A full ref name says which one is meant.
        const full = await clone.guard(
          "--base",
          "refs/remotes/origin/main",
          "--head",
          "HEAD",
        );
        expect(full.code).toBe(1);
      });

      it("exits 2 when --head is the ambiguous one", async () => {
        const clone = cloned();
        clone.git("tag", "work", "origin/main");
        const result = await clone.guard(
          "--base",
          "origin/main",
          "--head",
          "work",
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("ambiguous");
        expect(result.stderr).toContain("refs/tags/work");
        expect(result.stderr).toContain("refs/heads/work");
      });

      it("exits 2 when a file in the git directory takes the name", async () => {
        const clone = cloned();
        clone.write(".git/origin/main", clone.git("rev-parse", "HEAD"));
        const result = await clone.guard(...COMMITS);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("ambiguous");
        expect(result.stderr).toContain("refs/remotes/origin/main");
      });

      it("accepts two refs of one name that point at the same commit", async () => {
        const clone = cloned();
        clone.git("tag", "origin/main", "refs/remotes/origin/main");
        expect((await clone.guard(...COMMITS)).code).toBe(1);
        expect(
          (await clone.guard("--base", "origin/main~0", "--head", "HEAD")).code,
        ).toBe(1);
      });
    });

    describe("the index", () => {
      it("reports a weakening that is staged and then undone on disk", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        repo.write("tests/a.spec.ts", WEAK);
        repo.git("add", "tests/a.spec.ts");
        repo.write("tests/a.spec.ts", TEST);
        const result = await repo.guard("--base", "main", "--json");
        expect(result.code).toBe(1);
        expect(kinds(result)).toEqual(REMOVED);
        expect(report(result.stdout).head).toBe("working-tree");
      });

      it("reports a change once when the index and the disk agree", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        repo.write("tests/a.spec.ts", WEAK);
        const unstaged = await repo.guard("--base", "main", "--json");
        repo.git("add", "tests/a.spec.ts");
        const staged = await repo.guard("--base", "main", "--json");
        expect(kinds(staged)).toEqual(REMOVED);
        expect(staged.stdout).toBe(unstaged.stdout);
      });

      it("reports a staged file that was deleted from disk again", async () => {
        const repo = scratch({ "src/app.ts": "1\n" });
        repo.write(".jevy/decisions/a.jsonl", '{"reviewedBy":"agent"}\n');
        repo.git("add", "-A");
        rmSync(join(repo.dir, ".jevy"), { recursive: true });
        expect(kinds(await repo.guard("--base", "main", "--json"))).toEqual([
          [".jevy/decisions/a.jsonl", "approval-added"],
        ]);
      });

      it("leaves an unmerged path to the working-tree comparison", async () => {
        const repo = scratch({ "tests/a.spec.ts": TEST });
        repo.git("checkout", "-q", "-b", "theirs");
        repo.write("tests/a.spec.ts", TEST.replace("toBe(1)", "toBe(3)"));
        repo.git("commit", "-q", "-am", "theirs");
        repo.git("checkout", "-q", "main");
        repo.write("tests/a.spec.ts", TEST.replace("toBe(1)", "toBe(4)"));
        repo.git("commit", "-q", "-am", "ours");
        expect(() => repo.git("merge", "-q", "theirs")).toThrow();
        const result = await repo.guard("--base", "main", "--json");
        expect(result.stderr).toBe("");
        expect([0, 1]).toContain(result.code);
      });

      it.each([["--assume-unchanged"], ["--skip-worktree"]])(
        "exits 2 when a file is marked %s",
        async (flag) => {
          const repo = scratch({
            "tests/a.spec.ts": TEST,
            "src/app.ts": "1\n",
          });
          repo.git("update-index", flag, "tests/a.spec.ts");
          repo.write("tests/a.spec.ts", WEAK);
          const result = await repo.guard("--base", "main");
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toMatch(
            /^jevy guard: .*cannot check a working tree with hidden files/,
          );
          expect(result.stderr).toContain("tests/a.spec.ts");
          expect(result.stderr).not.toContain("src/app.ts");
          expect(result.stderr).toContain(
            "git update-index --no-assume-unchanged --no-skip-worktree",
          );
          expect(result.stderr).toContain("--head HEAD");
          // Comparing commits does not read the working tree, so it still runs.
          expect(
            (await repo.guard("--base", "main", "--head", "HEAD")).code,
          ).toBe(0);
        },
      );

      it("lists at most ten hidden paths and counts the rest", async () => {
        const names = Array.from(
          { length: 12 },
          (_, index) => `src/f${String(index).padStart(2, "0")}.ts`,
        );
        const repo = scratch(Object.fromEntries(names.map((n) => [n, "1\n"])));
        repo.git("update-index", "--assume-unchanged", ...names);
        const result = await repo.guard("--base", "main");
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("src/f09.ts");
        expect(result.stderr).not.toContain("src/f10.ts");
        expect(result.stderr).toContain("and 2 more");
      });
    });

    describe("something that is not a regular file", () => {
      const noFifo = process.platform === "win32";

      function mkfifo(path: string): void {
        execFileSync("mkfifo", [path]);
      }

      it.skipIf(noFifo)(
        "exits 2 for a FIFO where a test file was (needs mkfifo; Windows has none)",
        async () => {
          const repo = scratch({ "tests/a.spec.ts": TEST });
          rmSync(join(repo.dir, "tests/a.spec.ts"));
          mkfifo(join(repo.dir, "tests/a.spec.ts"));
          const result = await repo.guard("--base", "main");
          expect(result.code).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toMatch(
            /^jevy guard: tests\/a\.spec\.ts is not a regular file/,
          );
        },
        30_000,
      );

      it.skipIf(noFifo)(
        "exits 2 for a FIFO where the config would be (needs mkfifo; Windows has none)",
        async () => {
          const repo = scratch({ "tests/a.spec.ts": TEST });
          mkfifo(join(repo.dir, "jevy.config.ts"));
          const result = await repo.guard("--base", "main");
          expect(result.code).toBe(2);
          expect(result.stderr).toContain("jevy.config.ts");
        },
        30_000,
      );
    });

    describe("paths git or the guard could misread", () => {
      it("finds the base config in a directory whose name starts with a colon", async () => {
        const repo = scratch({
          ":x/jevy.config.ts":
            'export default { guard: { tests: ["checks/**"] } };\n',
          ":x/checks/a.ts": TEST,
        });
        repo.write(
          ":x/jevy.config.ts",
          'export default { guard: { tests: ["nowhere/**"] } };\n',
        );
        repo.write(":x/checks/a.ts", WEAK);
        const found = kinds(
          await repo.guardIn(":x", "--base", "main", "--json"),
        );
        expect(found).toContainEqual([":x/checks/a.ts", "assertion-removed"]);
      });

      it("runs in a directory, and with a cache directory, whose name starts with two dots", async () => {
        const repo = scratch({ "..x/tests/a.spec.ts": TEST });
        repo.write("..x/tests/a.spec.ts", WEAK);
        repo.write("..x/..cache/a.jsonl", '{"reviewedBy":"agent"}\n');
        expect(
          kinds(
            await repo.guardIn(
              "..x",
              "--base",
              "main",
              "--cache-dir",
              "..cache",
              "--json",
            ),
          ),
        ).toEqual([
          ["..x/..cache/a.jsonl", "approval-added"],
          ["..x/tests/a.spec.ts", "assertion-removed"],
        ]);
      });

      it("takes an absolute --cache-dir reached through a symlink", async () => {
        const repo = scratch({ "src/app.ts": "1\n" });
        repo.write("store/a.jsonl", '{"reviewedBy":"agent"}\n');
        const link = join(tempDir(), "link");
        symlinkSync(repo.dir, link);
        for (const dir of [join(link, "store"), join(link, "not-there-yet")]) {
          const result = await repo.guard(
            "--base",
            "main",
            "--cache-dir",
            dir,
            "--json",
          );
          expect(result.stderr).toBe("");
        }
        expect(
          kinds(
            await repo.guard(
              "--base",
              "main",
              "--cache-dir",
              join(link, "store"),
              "--json",
            ),
          ),
        ).toEqual([["store/a.jsonl", "approval-added"]]);
      });

      it("matches test globs and protect globs in a directory named like a glob", async () => {
        const repo = scratch({
          "web{a,b}/jevy.config.ts":
            'export default { protect: ["docs/**"], guard: { tests: ["checks/**"] } };\n',
          "web{a,b}/checks/a.ts": TEST,
          "web{a,b}/docs/r.md": "1\n",
          "weba/checks/a.ts": TEST,
          "weba/docs/r.md": "1\n",
        });
        for (const dir of ["web{a,b}", "weba"]) {
          repo.write(`${dir}/checks/a.ts`, WEAK);
          repo.write(`${dir}/docs/r.md`, "2\n");
        }
        expect(
          kinds(await repo.guardIn("web{a,b}", "--base", "main", "--json")),
        ).toEqual([
          ["web{a,b}/checks/a.ts", "assertion-removed"],
          ["web{a,b}/docs/r.md", "protected-path-changed"],
        ]);
      });

      it("compares a config whose name is in another case", async () => {
        const repo = scratch({
          "web/Jevy.Config.ts":
            "export default { thresholds: { pass: 0.8 } };\n",
        });
        repo.write(
          "web/Jevy.Config.ts",
          "export default { thresholds: { pass: 0.5 } };\n",
        );
        expect(kinds(await repo.guard("--base", "main", "--json"))).toEqual([
          ["web/Jevy.Config.ts", "protected-path-changed"],
          ["web/Jevy.Config.ts", "threshold-lowered"],
        ]);
      });
    });
  },
);
