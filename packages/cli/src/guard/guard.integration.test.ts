import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../cli.js";
import type { GuardReport } from "./types.js";

/**
 * End to end against a real git repository in a temporary directory: the
 * command, git, the working tree and the JSON output together.
 */

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

describe("jevy guard against a real repository", () => {
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
      expect(found.summary).toEqual({ weakening: 4, review: 0, info: 0 });
      expect(found.findings.map((f) => [f.file, f.kind])).toEqual([
        [".jevy/decisions/tests/new.spec.ts.jsonl", "approval-added"],
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
});
