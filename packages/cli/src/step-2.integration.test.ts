import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run, type CliResult } from "./cli.js";
import type { GuardReport } from "./guard/types.js";
import { realStateFiles } from "./hook/state.js";

/**
 * Roadmap step 2, with its pieces run together: the weak-test check, the
 * guard's config-driven settings, protected paths, the three hooks and the
 * skill file, against one real git repository. Each piece has its own tests;
 * these cover the seams between them, which no single piece owns.
 */

const SPEC = `import { test, expect } from "@playwright/test";

test("pays by card", async ({ page }) => {
  await page.goto("/checkout");
  await expect(page.getByRole("status")).toHaveText("Paid");
});
`;

const CONFIG = `import { defineConfig } from "@jevyjs/core";
export default defineConfig({
  checks: ["node check.mjs"],
  protect: ["docs/test-plan.md"],
  guard: { tests: ["**/*.spec.ts", "e2e/**/*.check.ts"] },
});
`;

const NO_ASSERTION = `import { test } from "@playwright/test";

test("opens the basket", async ({ page }) => {
  await page.goto("/basket");
  await page.getByRole("button", { name: "Open" }).click();
});
`;

const CANNOT_FAIL = `import { test, expect } from "@playwright/test";

test("shows the total", async ({ page }) => {
  await page.goto("/basket");
  expect(true).toBe(true);
});
`;

const REAL = `import { test, expect } from "@playwright/test";

test("shows the total", async ({ page }) => {
  await page.goto("/basket");
  await expect(page.getByTestId("total")).toHaveText("$42.00");
});
`;

let repo = "";
let stateDir = "";
let session = 0;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

function hook(name: string, input: object): Promise<CliResult> {
  return run(["hook", name, "--cwd", repo], "0.0.1", {
    hook: {
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({ session_id: `s${String(session)}`, ...input }),
        ),
      state: realStateFiles(stateDir),
    },
  });
}

async function guard(...args: string[]): Promise<{
  readonly code: number;
  readonly report: GuardReport;
}> {
  const result = await run(
    ["guard", "--cwd", repo, "--json", ...args],
    "0.0.1",
  );
  expect(result.stderr).toBe("");
  return {
    code: result.code,
    report: JSON.parse(result.stdout) as GuardReport,
  };
}

function kinds(report: GuardReport): string[] {
  return report.findings.map(
    (finding) => `${finding.file}: ${finding.kind} (${finding.severity})`,
  );
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "jevy-step2-"));
  stateDir = mkdtempSync(join(tmpdir(), "jevy-step2-state-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jevy Test");
  git("config", "user.email", "jevy-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("tests/checkout.spec.ts", SPEC);
  write("jevy.config.ts", CONFIG);
  write("docs/test-plan.md", "# Plan\n\n- checkout: pays by card\n");
  write("check.mjs", "process.exit(0);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** Every test is its own agent session, starting from a clean `main`. */
beforeEach(async () => {
  git("checkout", "-q", "-f", "main");
  git("reset", "-q", "--hard");
  git("clean", "-q", "-fd");
  session += 1;
  const started = await hook("session-start", { source: "startup" });
  expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
});

describe(
  "step 2: the guard inside the agent's loop",
  { timeout: 60_000 },
  () => {
    it("lets a session finish that made a clean change and added a real test", async () => {
      write("src/basket.ts", "export const total = 42;\n");
      write("tests/basket.spec.ts", REAL);

      const { code, report } = await guard("--base", "main", "--merge-base");
      expect(code).toBe(0);
      expect(kinds(report)).toEqual([
        "tests/basket.spec.ts: test-added (info)",
      ]);
      expect(await hook("stop", { stop_hook_active: false })).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    });

    it("stops a session that added a test with no assertion", async () => {
      write("tests/basket.spec.ts", NO_ASSERTION);

      const { code, report } = await guard("--base", "main", "--merge-base");
      expect(code).toBe(1);
      expect(kinds(report)).toContain(
        "tests/basket.spec.ts: test-without-assertion (weakening)",
      );
      const stopped = await hook("stop", { stop_hook_active: false });
      expect(stopped.code).toBe(2);
      expect(stopped.stderr).toContain(
        "tests/basket.spec.ts: test-without-assertion",
      );
    });

    it("reads guard.tests from the config, and flags a test there that cannot fail", async () => {
      // `*.check.ts` is a test file only because the config says so.
      write("e2e/basket.check.ts", CANNOT_FAIL);

      const { code, report } = await guard("--base", "main");
      expect(code).toBe(1);
      expect(kinds(report)).toContain(
        "e2e/basket.check.ts: assertion-cannot-fail (weakening)",
      );
      expect((await hook("stop", { stop_hook_active: false })).code).toBe(2);
    });

    it("blocks an edit to a protected path, and reports one made round the hook", async () => {
      const blocked = await hook("pre-edit", {
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "docs/test-plan.md") },
      });
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain('"docs/test-plan.md" in protect');

      // What a shell command would do: the pre-edit hook never sees it.
      write("docs/test-plan.md", "# Plan\n");
      const { code, report } = await guard("--base", "main");
      expect(code).toBe(1);
      expect(kinds(report)).toEqual([
        "docs/test-plan.md: protected-path-changed (weakening)",
      ]);
      const stopped = await hook("stop", { stop_hook_active: false });
      expect(stopped.code).toBe(2);
      expect(stopped.stderr).toContain(
        "docs/test-plan.md: protected-path-changed",
      );
    });

    it("does not let a change shrink the protect list and use the gap in the same run", async () => {
      write("jevy.config.ts", CONFIG.replace('"docs/test-plan.md"', ""));
      write("docs/test-plan.md", "# Plan\n");

      const { report } = await guard("--base", "main");
      // The base version of the config still lists the plan.
      expect(kinds(report)).toContain(
        "docs/test-plan.md: protected-path-changed (weakening)",
      );
      expect(kinds(report)).toContain(
        "jevy.config.ts: protected-path-changed (weakening)",
      );
    });

    it("stops a session that committed a skip on the default branch", async () => {
      write("tests/checkout.spec.ts", SPEC.replace("test(", "test.skip("));
      git("commit", "-q", "-am", "skip it");
      try {
        // Nothing lies between `main` and HEAD now; the session's start does.
        const stopped = await hook("stop", { stop_hook_active: false });
        expect(stopped.code).toBe(2);
        expect(stopped.stderr).toContain("tests/checkout.spec.ts: skip-added");
      } finally {
        git("reset", "-q", "--hard", "HEAD~1");
      }
    });

    it("compares a branch with where it started, not with tests the target gained since", async () => {
      git("checkout", "-q", "-b", "feature");
      write("tests/basket.spec.ts", NO_ASSERTION);
      git("add", "-A");
      git("commit", "-q", "-m", "feature");
      git("checkout", "-q", "main");
      write("tests/later.spec.ts", REAL);
      git("add", "-A");
      git("commit", "-q", "-m", "a test added on main afterwards");
      git("checkout", "-q", "feature");
      try {
        const tip = await guard("--base", "main", "--head", "HEAD");
        expect(kinds(tip.report)).toContain(
          "tests/later.spec.ts: test-file-removed (weakening)",
        );
        const branched = await guard(
          "--base",
          "main",
          "--merge-base",
          "--head",
          "HEAD",
        );
        expect(branched.report.mergeBase).toMatch(/^[0-9a-f]{40}$/);
        expect(kinds(branched.report)).toEqual([
          "tests/basket.spec.ts: test-added (info)",
          "tests/basket.spec.ts: test-without-assertion (weakening)",
        ]);
      } finally {
        git("checkout", "-q", "-f", "main");
        git("reset", "-q", "--hard", "HEAD~1");
        git("branch", "-q", "-D", "feature");
      }
    });

    it("ships a skill file whose commands the CLI accepts", async () => {
      const skill = readFileSync(
        new URL("../skill/SKILL.md", import.meta.url),
        "utf8",
      );
      const commands = [...skill.matchAll(/^ {4}npx jevy ([^#\n]+)/gm)].map(
        (match) => (match[1] ?? "").trim().split(/\s+/),
      );
      expect(commands.length).toBeGreaterThanOrEqual(4);
      for (const argv of commands) {
        const name = argv[0] === "hook" ? argv.slice(0, 2) : argv.slice(0, 1);
        const help = await run([...name, "--help"], "0.0.1");
        expect(help.code).toBe(0);
        // Each flag the skill file shows is one the command documents.
        for (const flag of argv.filter((arg) => arg.startsWith("--"))) {
          expect(help.stdout).toContain(flag);
        }
      }
    });
  },
);
