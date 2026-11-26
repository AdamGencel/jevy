import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type CliResult } from "../cli.js";
import { realStateFiles } from "./state.js";

/**
 * The hooks end to end: the `jevy` command, a real git repository in a
 * temporary directory, real check commands and the real guard. Only stdin
 * and the place the state is kept are handed in.
 */

const SPEC = `import { test, expect } from "@playwright/test";

test("pays by card", async ({ page }) => {
  await expect(page.getByRole("status")).toHaveText("Paid");
});
`;

const CONFIG = `import { defineConfig } from "@jevyjs/core";
export default defineConfig({
  checks: ["node check.mjs"],
  protect: ["tests/critical/**"],
});
`;

let repo = "";
let stateDir = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

async function hook(name: string, input: unknown): Promise<CliResult> {
  return run(["hook", name, "--cwd", repo], "0.0.1", {
    hook: {
      readStdin: () => Promise.resolve(JSON.stringify(input)),
      state: realStateFiles(stateDir),
    },
  });
}

function stop(active: boolean): Promise<CliResult> {
  return hook("stop", { session_id: "it", stop_hook_active: active });
}

function edit(path: string): Promise<CliResult> {
  return hook("pre-edit", {
    session_id: "it",
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: join(repo, path) },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "jevy-hook-"));
  stateDir = mkdtempSync(join(tmpdir(), "jevy-hook-state-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jevy Test");
  git("config", "user.email", "jevy-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("tests/checkout.spec.ts", SPEC);
  write("jevy.config.ts", CONFIG);
  // The project's check: it passes unless a file named `broken` exists.
  write(
    "check.mjs",
    `import { existsSync } from "node:fs";\nif (existsSync("broken")) { console.error("the build is broken"); process.exit(1); }\n`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("the hooks against a real repository", () => {
  it("lets a clean session stop", async () => {
    write("src/app.ts", "export const app = 1;\n");
    expect(await stop(false)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("blocks a session that added a skip", async () => {
    write("tests/checkout.spec.ts", SPEC.replace("test(", "test.skip("));
    const result = await stop(false);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("jevy guard found 1 weakening change");
    expect(result.stderr).toContain("tests/checkout.spec.ts: skip-added");
    expect(result.stderr).toContain("Do not weaken, skip or delete a test");
    write("tests/checkout.spec.ts", SPEC);
    expect((await stop(true)).code).toBe(0);
  });

  it("blocks a session that deleted an assertion", async () => {
    write(
      "tests/checkout.spec.ts",
      SPEC.replace(/^.*toHaveText.*\n/m, "  await page.reload();\n"),
    );
    const result = await stop(false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "tests/checkout.spec.ts: assertion-removed",
    );
    write("tests/checkout.spec.ts", SPEC);
  });

  it("blocks while a check fails, then hands back to the person", async () => {
    write("broken", "");
    const first = await stop(false);
    expect(first.code).toBe(2);
    expect(first.stderr).toContain(
      "Check failed (exit 1): node check.mjs\n  the build is broken\n",
    );
    expect(readdirSync(stateDir)).toHaveLength(1);
    expect((await stop(true)).code).toBe(2);
    const third = await stop(true);
    expect(third.code).toBe(0);
    expect(third.stdout).toContain('{"systemMessage":"Jevy let the agent stop');
    expect(third.stdout).toContain("- check: node check.mjs (exit 1)");
    expect(readdirSync(stateDir)).toEqual([]);
    rmSync(join(repo, "broken"));
    expect(await stop(false)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("blocks an edit to the config and to a path in protect", async () => {
    const config = await edit("jevy.config.ts");
    expect(config.code).toBe(2);
    expect(config.stderr).toContain(
      "jevy.config.ts is protected: it is the Jevy config.",
    );
    const listed = await edit("tests/critical/pay.spec.ts");
    expect(listed.code).toBe(2);
    expect(listed.stderr).toContain(
      'it matches "tests/critical/**" in protect',
    );
    expect(await edit("tests/checkout.spec.ts")).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });
});

/**
 * What a session commits. Each case gets a repository of its own, because
 * each one ends with a commit that the next must not inherit.
 */
describe("the hooks and a session that commits its changes", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  interface Session {
    readonly git: (...args: string[]) => string;
    readonly write: (path: string, text: string) => void;
    /** `jevy hook session-start`, as Claude Code runs it for `source`. */
    readonly start: (source: string) => Promise<CliResult>;
    readonly stop: () => Promise<CliResult>;
  }

  /** A repository on `main` with one commit, no remote, and a clean tree. */
  function session(): Session {
    const dir = mkdtempSync(join(tmpdir(), "jevy-hook-session-"));
    const state = mkdtempSync(join(tmpdir(), "jevy-hook-session-state-"));
    made.push(dir, state);
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const write = (path: string, text: string): void => {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
    };
    const hook = (name: string, input: unknown): Promise<CliResult> =>
      run(["hook", name, "--cwd", dir], "0.0.1", {
        hook: {
          readStdin: () => Promise.resolve(JSON.stringify(input)),
          state: realStateFiles(state),
        },
      });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jevy Test");
    git("config", "user.email", "jevy-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    write("tests/checkout.spec.ts", SPEC);
    write("jevy.config.ts", CONFIG);
    write("check.mjs", "process.exit(0);\n");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    return {
      git,
      write,
      start: (source) =>
        hook("session-start", {
          session_id: "it",
          hook_event_name: "SessionStart",
          source,
        }),
      stop: () => hook("stop", { session_id: "it", stop_hook_active: false }),
    };
  }

  const SKIPPED = SPEC.replace("test(", "test.skip(");
  const QUIET: CliResult = { code: 0, stdout: "", stderr: "" };

  it("blocks a skip committed on main with no remote", async () => {
    const s = session();
    expect(await s.start("startup")).toEqual(QUIET);
    s.write("tests/checkout.spec.ts", SKIPPED);
    expect((await s.stop()).code).toBe(2);
    // Committed, the change is gone from `git diff main`: main is HEAD.
    s.git("commit", "-q", "-am", "x");
    const result = await s.stop();
    expect(result.stderr).toMatch(
      /jevy guard found 1 weakening change since the session's start \([0-9a-f]{7}\):\n {2}tests\/checkout\.spec\.ts: skip-added/,
    );
    expect(result.code).toBe(2);
  });

  it("blocks a skip committed on a branch whose origin/main was moved up to it", async () => {
    const s = session();
    s.git("update-ref", "refs/remotes/origin/main", "HEAD");
    s.git("checkout", "-q", "-b", "feature");
    await s.start("startup");
    s.write("tests/checkout.spec.ts", SKIPPED);
    s.git("commit", "-q", "-am", "x");
    // Before the ref moves, the branch comparison sees it too.
    expect((await s.stop()).stderr).toContain(
      "since origin/main and since the session's start",
    );
    s.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const result = await s.stop();
    expect(result.stderr).toContain("tests/checkout.spec.ts: skip-added");
    expect(result.stderr).not.toContain("since origin/main");
    expect(result.code).toBe(2);
  });

  it("blocks when the config was edited to pick the branch that hides the change", async () => {
    const s = session();
    s.git("checkout", "-q", "-b", "feature");
    await s.start("startup");
    // Through a shell, where the pre-edit hook does not see it.
    s.write(
      "jevy.config.ts",
      CONFIG.replace("checks:", 'ci: { mainBranch: "feature" },\n  checks:'),
    );
    s.write("tests/checkout.spec.ts", SKIPPED);
    s.git("commit", "-q", "-am", "x");
    const result = await s.stop();
    expect(result.stderr).toMatch(
      /the Jevy config changed in this session; a person must approve that change: jevy\.config\.ts \(changed\) since [0-9a-f]{7}\./,
    );
    expect(result.stderr).toContain("tests/checkout.spec.ts: skip-added");
    expect(result.code).toBe(2);
  });

  it("blocks a config edit on its own, committed or not", async () => {
    const s = session();
    await s.start("startup");
    s.write("jevy.config.ts", CONFIG.replace('"node check.mjs"', ""));
    const uncommitted = await s.stop();
    expect(uncommitted.code).toBe(2);
    expect(uncommitted.stderr).toContain(
      "the Jevy config changed in this session",
    );
    s.git("commit", "-q", "-am", "x");
    const committed = await s.stop();
    expect(committed.code).toBe(2);
    expect(committed.stderr).toContain(
      "the Jevy config changed in this session",
    );
  });

  it("does not move the baseline when the session is resumed or compacted", async () => {
    const s = session();
    await s.start("startup");
    s.write("tests/checkout.spec.ts", SKIPPED);
    s.git("commit", "-q", "-am", "x");
    // HEAD is now the commit with the skip; a second record would hide it.
    expect(await s.start("resume")).toEqual(QUIET);
    expect(await s.start("compact")).toEqual(QUIET);
    const result = await s.stop();
    expect(result.stderr).toContain("tests/checkout.spec.ts: skip-added");
    expect(result.code).toBe(2);
  });

  it("lets a session stop that committed an ordinary change", async () => {
    const s = session();
    await s.start("startup");
    s.write("src/app.ts", "export const app = 1;\n");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "x");
    s.write("src/more.ts", "export const more = 2;\n");
    expect(await s.stop()).toEqual(QUIET);
  });

  it("blocks when the commit it started from has been thrown away", async () => {
    const s = session();
    s.write("src/app.ts", "export const app = 1;\n");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "second");
    await s.start("startup");
    // History is rewritten so that the recorded commit is unreachable, and
    // then removed.
    s.git("reset", "-q", "--hard", "HEAD~1");
    s.git("reflog", "expire", "--expire=now", "--all");
    s.git("gc", "-q", "--prune=now");
    const result = await s.stop();
    expect(result.stderr).toMatch(
      /The commit this session started from \([0-9a-f]{7}\) no longer exists in the repository/,
    );
    expect(result.code).toBe(2);
  });

  it("behaves as before when no session start was recorded: the commit is not seen", async () => {
    // The limit this hook has without `jevy hook session-start` wired in.
    const s = session();
    s.write("tests/checkout.spec.ts", SKIPPED);
    expect((await s.stop()).code).toBe(2);
    s.git("commit", "-q", "-am", "x");
    expect(await s.stop()).toEqual(QUIET);
  });

  it("names the refs it tried in a repository that only has master", async () => {
    const s = session();
    s.git("branch", "-m", "main", "trunk");
    const none = await s.stop();
    expect(none.code).toBe(2);
    expect(none.stderr).toContain(
      "none of origin/main, main, origin/master, master exists in this repository. A person has to give the hook --base <ref>, or set ci.mainBranch in jevy.config.*.",
    );
    s.git("branch", "-m", "trunk", "master");
    expect(await s.stop()).toEqual(QUIET);
  });
});

describe("the hooks started in a directory that is not the config's", () => {
  let root = "";
  let stateDir2 = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jevy-hook-mono-"));
    stateDir2 = mkdtempSync(join(tmpdir(), "jevy-hook-mono-state-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jevy Test");
    git("config", "user.email", "jevy-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "packages", "app", "tests", "critical"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "packages", "app", "jevy.config.ts"),
      CONFIG.replace("node check.mjs", "exit 1"),
    );
    writeFileSync(join(root, "README.md"), "# mono\n");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir2, { recursive: true, force: true });
  });

  function at(cwd: string, name: string, input: unknown): Promise<CliResult> {
    return run(["hook", name, "--cwd", cwd], "0.0.1", {
      hook: {
        readStdin: () => Promise.resolve(JSON.stringify(input)),
        state: realStateFiles(stateDir2),
      },
    });
  }

  it("stop blocks at the root, naming the config and the --cwd to use", async () => {
    const result = await at(root, "stop", { session_id: "mono" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "has no jevy.config.*, but the repository has packages/app/jevy.config.ts.",
    );
    expect(result.stderr).toContain(`--cwd ${join(root, "packages", "app")}\n`);
  });

  it("pre-edit blocks at the root, where the config's protect list is out of sight", async () => {
    const result = await at(root, "pre-edit", {
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, "packages/app/tests/critical/pay.spec.ts"),
      },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "the repository has packages/app/jevy.config.ts, so the hook cannot tell which paths are protected.",
    );
  });

  it("both work with the --cwd they named", async () => {
    const app = join(root, "packages", "app");
    const stop = await at(app, "stop", { session_id: "mono" });
    expect(stop.code).toBe(2);
    expect(stop.stderr).toContain("Check failed (exit 1): exit 1\n");
    expect(stop.stderr).not.toContain("has no jevy.config.*");
    const edit = await at(app, "pre-edit", {
      tool_name: "Edit",
      tool_input: { file_path: join(app, "tests/critical/pay.spec.ts") },
    });
    expect(edit.stderr).toContain('it matches "tests/critical/**" in protect');
    expect(
      await at(app, "pre-edit", {
        tool_name: "Edit",
        tool_input: { file_path: join(app, "src/a.ts") },
      }),
    ).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("share one record of the session's start, wherever each hook runs", async () => {
    // As the printed settings run them: session-start at the root of the
    // repository, stop in the directory of the config.
    const app = join(root, "packages", "app");
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root });
    };
    writeFileSync(join(app, "tests", "pay.spec.ts"), SPEC);
    git("add", "-A");
    git("commit", "-q", "-m", "a test");
    expect(
      (await at(root, "session-start", { session_id: "shared" })).code,
    ).toBe(0);
    writeFileSync(
      join(app, "tests", "pay.spec.ts"),
      SPEC.replace("test(", "test.skip("),
    );
    git("commit", "-q", "-am", "skip it");
    const result = await at(app, "stop", { session_id: "shared" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("since the session's start");
    expect(result.stderr).toContain("tests/pay.spec.ts: skip-added");
  });

  it("pre-edit started below the config's directory refuses an edit to the config", async () => {
    const app = join(root, "packages", "app");
    const result = await at(join(app, "tests"), "pre-edit", {
      tool_name: "Write",
      tool_input: { file_path: join(app, "jevy.config.ts") },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the repository has ../jevy.config.ts");
  });

  it("pre-edit refuses an edit to what runs the hooks at the root of the repository", async () => {
    const app = join(root, "packages", "app");
    for (const path of [".claude/settings.json", "node_modules/.bin/jevy"]) {
      const result = await at(app, "pre-edit", {
        tool_name: "Write",
        tool_input: { file_path: join(root, path) },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "is protected: it keeps the Jevy hooks themselves working.",
      );
    }
  });
});
