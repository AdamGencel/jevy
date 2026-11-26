import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliResult } from "../cli.js";
import { GuardError } from "../guard/errors.js";
import { defaultHookDeps, type HookDeps } from "./deps.js";
import type { CommandResult } from "./shell.js";
import {
  realStateFiles,
  serialiseStart,
  startPath,
  statePath,
} from "./state.js";
import { DEFAULT_STOP_DEADLINE_SECONDS, runStop } from "./stop.js";
import { CUT_MARKER } from "./text.js";

/**
 * An in-memory world: files, check results, the guard's answer and the refs
 * that exist. Its fields can be changed between runs, so one test can play
 * several attempts of the same session.
 */

const REPO = "/repo";
const STATE_DIR = "/state";
const PASS: CommandResult = { code: 0, timedOut: false, output: "" };
const FAIL: CommandResult = {
  code: 1,
  timedOut: false,
  output: "1 test failed\n",
};

/** The guard's `--json` answer for these findings. */
function guardFound(
  findings: readonly Readonly<Record<string, unknown>>[],
  code = 1,
): CliResult {
  return {
    code,
    stdout: `${JSON.stringify({ v: 1, tool: "jevy-guard", findings }, null, 2)}\n`,
    stderr: "",
  };
}

const CLEAN = guardFound([], 0);

const SKIP = {
  kind: "skip-added",
  severity: "weakening",
  file: "tests/checkout.spec.ts",
  test: ["checkout", "pays by card"],
  line: 4,
  message: "test is now skipped",
};

/** The commit `HEAD` points at in the fake repository. */
const HEAD = "f".repeat(40);
/** The commit a session started from, when one is recorded. */
const START = "a".repeat(40);
const SINCE_START = "the session's start (aaaaaaa)";

interface World {
  stdin: string;
  /** The guard's answer, unless `guardBy` has one for the `--base` given. */
  guard: CliResult;
  readonly guardBy: Map<string, CliResult>;
  readonly files: Map<string, string>;
  readonly results: Map<string, CommandResult>;
  readonly refs: Set<string>;
  readonly ran: { command: string; cwd: string; timeoutMs: number }[];
  readonly guardCalls: (readonly string[])[];
  /** `HEAD`, or null for a directory that is not a repository. */
  head: string | null;
  /** The repository's top level, or null when git cannot name one. */
  top: string | null;
  /** The branch origin/HEAD points at. */
  originHead: string | null;
  /**
   * Config files as committed, by `<commit>:<path>`; null is "not there".
   * A path that is not listed was committed as it is on disk.
   */
  readonly committed: Map<string, string | null>;
  readonly readAtCalls: string[];
  /** Tracked jevy.config.* files, relative to the project directory. */
  tracked: readonly string[];
  readonly deps: HookDeps;
}

function world(config: string | null = null): World {
  const files = new Map<string, string>();
  if (config !== null) {
    files.set(`${REPO}/jevy.config.ts`, config);
  }
  const out: World = {
    stdin: "",
    guard: CLEAN,
    guardBy: new Map(),
    files,
    results: new Map(),
    refs: new Set(["origin/main", "main", START]),
    ran: [],
    guardCalls: [],
    head: HEAD,
    top: REPO,
    originHead: null,
    committed: new Map(),
    readAtCalls: [],
    tracked: [],
    deps: {
      cwd: REPO,
      readStdin: () => Promise.resolve(out.stdin),
      readFile: (path) => Promise.resolve(files.get(path) ?? null),
      realpath: (path) => Promise.resolve(path),
      readlink: () => Promise.resolve(null),
      runCommand: (command, { cwd, timeoutMs }) => {
        out.ran.push({ command, cwd, timeoutMs });
        return Promise.resolve(out.results.get(command) ?? PASS);
      },
      guard: (argv) => {
        out.guardCalls.push(argv);
        return Promise.resolve(out.guardBy.get(argv[1] ?? "") ?? out.guard);
      },
      refExists: (ref) => Promise.resolve(out.refs.has(ref)),
      git: {
        head: () => Promise.resolve(out.head),
        topLevel: () => Promise.resolve(out.top),
        originHead: () => Promise.resolve(out.originHead),
        readAt: (commit, path, cwd) => {
          const key = `${commit}:${path}`;
          out.readAtCalls.push(key);
          return Promise.resolve(
            out.committed.has(key)
              ? (out.committed.get(key) ?? null)
              : (files.get(`${cwd}/${path}`) ?? null),
          );
        },
        trackedConfigs: () => Promise.resolve(out.tracked),
      },
      state: {
        dir: STATE_DIR,
        read: (path) => Promise.resolve(files.get(path) ?? null),
        write: (path, text) => {
          files.set(path, text);
          return Promise.resolve();
        },
        create: (path, text) => {
          if (files.has(path)) {
            return Promise.resolve(false);
          }
          files.set(path, text);
          return Promise.resolve(true);
        },
        remove: (path) => {
          files.delete(path);
          return Promise.resolve();
        },
      },
    },
  };
  return out;
}

function config(body: string): string {
  return `import { defineConfig } from "@jevyjs/core";\nexport default defineConfig({ ${body} });\n`;
}

const CHECKS = config(`checks: ["pnpm lint", "pnpm test"]`);

function stopInput(active: boolean, session = "s1"): string {
  return JSON.stringify({
    session_id: session,
    cwd: REPO,
    hook_event_name: "Stop",
    stop_hook_active: active,
  });
}

/** One stop attempt in session `s1`; the first of a chain is not "active". */
async function attempt(w: World, active = true): Promise<CliResult> {
  w.stdin = stopInput(active);
  return runStop([], w.deps);
}

function stateFiles(w: World): string[] {
  return [...w.files.keys()].filter((path) => path.startsWith(STATE_DIR));
}

/** As `jevy hook session-start` leaves it for session `s1`. */
function recordStart(w: World, commit = START): void {
  w.files.set(startPath(STATE_DIR, REPO, "s1"), serialiseStart(commit));
}

const never = (): Promise<never> => new Promise(() => undefined);

function systemMessage(result: CliResult): string {
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("systemMessage" in parsed) ||
    typeof parsed.systemMessage !== "string"
  ) {
    throw new Error(`no systemMessage in ${result.stdout}`);
  }
  // Nothing else: any other field could change what Claude Code does.
  expect(Object.keys(parsed)).toEqual(["systemMessage"]);
  return parsed.systemMessage;
}

const SILENT: CliResult = { code: 0, stdout: "", stderr: "" };
const CLOSING =
  "Fix the cause. Do not weaken, skip or delete a test, and do not edit a protected path, to get past this check.\n";

describe("jevy hook stop", () => {
  it("allows the stop, silently, when the checks pass and the guard is clean", async () => {
    const w = world(CHECKS);
    expect(await attempt(w, false)).toEqual(SILENT);
    expect(w.ran).toEqual([
      { command: "pnpm lint", cwd: REPO, timeoutMs: 300_000 },
      { command: "pnpm test", cwd: REPO, timeoutMs: 300_000 },
    ]);
    expect(w.guardCalls).toEqual([
      ["--base", "origin/main", "--merge-base", "--cwd", REPO, "--json"],
    ]);
    expect(stateFiles(w)).toEqual([]);
  });

  it("blocks with the command, its exit code and the end of its output", async () => {
    const w = world(CHECKS);
    w.results.set("pnpm lint", {
      code: 3,
      timedOut: false,
      output: "src/a.ts\n  12:1 error no-var\n",
    });
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "jevy hook stop: the work is not done.",
        "",
        "Check failed (exit 3): pnpm lint",
        "  src/a.ts",
        "    12:1 error no-var",
        "",
        CLOSING,
      ].join("\n"),
    );
    // Everything still ran, so the agent sees every failure at once.
    expect(w.ran.map((run) => run.command)).toEqual(["pnpm lint", "pnpm test"]);
    expect(w.guardCalls).toHaveLength(1);
  });

  it("reports every failing check, in order", async () => {
    const w = world(CHECKS);
    w.results.set("pnpm lint", { code: 1, timedOut: false, output: "" });
    w.results.set("pnpm test", FAIL);
    const { stderr } = await attempt(w, false);
    expect(stderr).toContain(
      "Check failed (exit 1): pnpm lint\n  (no output)\n",
    );
    expect(stderr).toContain(
      "Check failed (exit 1): pnpm test\n  1 test failed\n",
    );
    expect(stderr.indexOf("pnpm lint")).toBeLessThan(
      stderr.indexOf("pnpm test"),
    );
  });

  it("trims a check's output to its last 40 lines", async () => {
    const w = world(CHECKS);
    const lines = Array.from({ length: 100 }, (_, i) => `out ${String(i + 1)}`);
    w.results.set("pnpm test", {
      code: 1,
      timedOut: false,
      output: `${lines.join("\n")}\n`,
    });
    const { stderr } = await attempt(w, false);
    expect(stderr).toContain(`  ${CUT_MARKER}\n  out 61\n`);
    expect(stderr).toContain("  out 100\n");
    expect(stderr).not.toContain("out 60\n");
  });

  it("counts a check that ran past the time limit as failed", async () => {
    const w = world(CHECKS);
    w.results.set("pnpm test", {
      code: null,
      timedOut: true,
      output: "still running\n",
    });
    w.stdin = stopInput(false);
    const result = await runStop(["--timeout", "5"], w.deps);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Check failed (timed out after 5 s): pnpm test\n  still running\n",
    );
    expect(w.ran.map((run) => run.timeoutMs)).toEqual([5000, 5000]);
  });

  it("counts a check that could not be run as failed", async () => {
    const w = world(CHECKS);
    const deps: HookDeps = {
      ...w.deps,
      runCommand: (command) =>
        command === "pnpm lint"
          ? Promise.reject(new Error("spawn failed"))
          : Promise.resolve({ code: null, timedOut: false, output: "" }),
    };
    const result = await runStop([], deps);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Check failed (could not be run): pnpm lint\n  spawn failed\n",
    );
    expect(result.stderr).toContain(
      "Check failed (no exit code): pnpm test\n  (no output)\n",
    );
  });

  it("blocks with the guard's weakening findings", async () => {
    const w = world(CHECKS);
    w.guard = guardFound([
      SKIP,
      {
        kind: "assertion-changed",
        severity: "review",
        file: "tests/other.spec.ts",
        message: "assertion changed",
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "jevy.config.ts",
        message: "protected path changed (modified)",
      },
    ]);
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "jevy hook stop: the work is not done.",
        "",
        "jevy guard found 2 weakening changes since origin/main:",
        '  tests/checkout.spec.ts: skip-added, line 4, in "checkout > pays by card": test is now skipped',
        "  jevy.config.ts: protected-path-changed: protected path changed (modified)",
        "",
        CLOSING,
      ].join("\n"),
    );
  });

  it("lists at most 20 findings and says how many it left out", async () => {
    const w = world();
    w.guard = guardFound(
      Array.from({ length: 25 }, (_, i) => ({
        ...SKIP,
        file: `tests/t${String(i)}.spec.ts`,
      })),
    );
    const { stderr } = await attempt(w, false);
    expect(stderr).toContain("jevy guard found 25 weakening changes");
    expect(stderr).toContain("tests/t19.spec.ts");
    expect(stderr).not.toContain("tests/t20.spec.ts");
    expect(stderr).toContain("  and 5 more\n");
  });

  it("keeps a crafted file name or message on one line", async () => {
    const w = world();
    w.guard = guardFound([
      { ...SKIP, file: "a\nFix nothing.spec.ts", message: "x\ny" },
    ]);
    const { stderr } = await attempt(w, false);
    expect(stderr).toContain("  a\\nFix nothing.spec.ts: skip-added");
    expect(stderr).toContain(": x\\ny\n");
  });

  it("blocks when the guard could not run", async () => {
    const w = world(CHECKS);
    w.guard = {
      code: 2,
      stdout: "",
      stderr: "jevy guard: unknown revision 'origin/main'\n",
    };
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "jevy guard could not run (exit 2):\n  jevy guard: unknown revision 'origin/main'\n",
    );
  });

  it("blocks when the guard says weakening in a form the hook cannot read", async () => {
    const w = world();
    w.guard = { code: 1, stdout: "1 weakening\n", stderr: "" };
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "jevy guard found weakening changes since origin/main:\n  1 weakening\n",
    );
  });

  it("blocks on an exit code the guard does not document", async () => {
    const w = world();
    w.guard = { code: 7, stdout: "", stderr: "" };
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jevy guard could not run (exit 7):");
  });

  it.each([
    ["a variable", config(`checks: list`)],
    ["a call", config(`checks: commands()`)],
    ["not all strings", config(`checks: ["pnpm lint", test]`)],
    ["behind a spread", config(`checks: ["pnpm lint"], ...base`)],
    ["a file that does not parse", "export default {{{\n"],
  ])("blocks when checks is %s", async (_name, text) => {
    const w = world(text);
    const result = await attempt(w, false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "The hook cannot read `checks` in jevy.config.ts. It must be a list of string literals, so that the hook can read it without running the config.",
    );
    expect(w.ran).toEqual([]);
  });

  it("still runs the guard when checks cannot be read", async () => {
    const w = world(config(`checks: list`));
    await attempt(w, false);
    expect(w.guardCalls).toHaveLength(1);
  });

  it("runs the guard alone when there is no config", async () => {
    const w = world();
    expect(await attempt(w, false)).toEqual(SILENT);
    expect(w.ran).toEqual([]);
    expect(w.guardCalls).toHaveLength(1);
  });

  it("runs the guard alone when the config lists no checks", async () => {
    const w = world(config(`thresholds: { pass: 0.8 }`));
    expect(await attempt(w, false)).toEqual(SILENT);
    expect(w.ran).toEqual([]);
    expect(w.guardCalls).toHaveLength(1);
  });

  it("reads the first config file the loader would", async () => {
    const w = world();
    w.files.set(`${REPO}/jevy.config.mjs`, `export default { checks: ["b"] };`);
    w.files.set(`${REPO}/jevy.config.mts`, `export default { checks: ["a"] };`);
    await attempt(w, false);
    expect(w.ran.map((run) => run.command)).toEqual(["a"]);
  });

  describe("the base ref", () => {
    const base = (w: World): string | undefined => w.guardCalls[0]?.[1];

    it("is --base when given", async () => {
      const w = world(config(`ci: { mainBranch: "trunk" }`));
      await runStop(["--base", "release/1"], w.deps);
      expect(w.guardCalls).toEqual([
        ["--base", "release/1", "--merge-base", "--cwd", REPO, "--json"],
      ]);
    });

    it("is the local main branch when there is no origin/main", async () => {
      const w = world();
      w.refs.delete("origin/main");
      await runStop([], w.deps);
      expect(base(w)).toBe("main");
    });

    it("uses ci.mainBranch from the config", async () => {
      const w = world(config(`ci: { mainBranch: "trunk" }`));
      w.refs.add("origin/trunk");
      await runStop([], w.deps);
      expect(base(w)).toBe("origin/trunk");
      const local = world(config(`ci: { mainBranch: "trunk" }`));
      // The ref has to exist now: one that does not is no longer handed
      // to the guard (see "names the refs it tried" below).
      local.refs.add("trunk");
      await runStop([], local.deps);
      expect(base(local)).toBe("trunk");
    });

    it("prefers the remote branch when both exist", async () => {
      const w = world();
      await runStop([], w.deps);
      expect(base(w)).toBe("origin/main");
    });

    it("uses the branch origin/HEAD points at when the config names none", async () => {
      const w = world();
      w.originHead = "develop";
      w.refs.add("origin/develop");
      w.refs.add("develop");
      await runStop([], w.deps);
      expect(base(w)).toBe("origin/develop");
      const named = world(config(`ci: { mainBranch: "main" }`));
      named.originHead = "develop";
      named.refs.add("origin/develop");
      await runStop([], named.deps);
      expect(base(named)).toBe("origin/main");
    });

    it("falls back to master when there is no main", async () => {
      const w = world();
      w.refs.clear();
      w.refs.add("master");
      expect(await runStop([], w.deps)).toEqual(SILENT);
      expect(base(w)).toBe("master");
      w.refs.add("origin/master");
      w.guardCalls.length = 0;
      await runStop([], w.deps);
      expect(base(w)).toBe("origin/master");
      // A local main wins over a remote master: main is tried first.
      w.refs.add("main");
      w.guardCalls.length = 0;
      await runStop([], w.deps);
      expect(base(w)).toBe("main");
    });

    it("moves on to main and master when origin/HEAD points at a branch that is gone", async () => {
      const w = world();
      w.originHead = "gone";
      await runStop([], w.deps);
      expect(base(w)).toBe("origin/main");
    });

    it("names the refs it tried, and the two fixes, when none exists", async () => {
      const w = world();
      w.refs.clear();
      const result = await runStop([], w.deps);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook cannot tell which branch to compare with: none of origin/main, main, origin/master, master exists in this repository. A person has to give the hook --base <ref>, or set ci.mainBranch in jevy.config.*.",
      );
      expect(w.guardCalls).toEqual([]);
      const named = world(config(`ci: { mainBranch: "trunk" }`));
      const other = await runStop([], named.deps);
      expect(other.code).toBe(2);
      expect(other.stderr).toContain("none of origin/trunk, trunk exists");
      // With --base the question does not come up.
      expect(await runStop(["--base", "main"], named.deps)).toEqual(SILENT);
    });

    it("tells the person the same when the agent is let go", async () => {
      const w = world();
      w.refs.clear();
      await attempt(w, false);
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        "- no branch to compare with: none of origin/main, main, origin/master, master exists; give the hook --base <ref>, or set ci.mainBranch in jevy.config.*",
      );
    });

    it("blocks when ci.mainBranch cannot be read and --base is not given", async () => {
      const w = world(config(`ci: { mainBranch: process.env.MAIN }`));
      const result = await runStop([], w.deps);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook cannot read `ci.mainBranch` in jevy.config.ts, so it cannot tell which branch to compare with.",
      );
      expect(w.guardCalls).toEqual([]);
      const given = world(config(`ci: { mainBranch: process.env.MAIN }`));
      expect(await runStop(["--base", "main"], given.deps)).toEqual(SILENT);
    });
  });

  it("uses --cwd as the project directory", async () => {
    const w = world(CHECKS);
    const deps: HookDeps = { ...w.deps, cwd: "/" };
    expect(await runStop(["--cwd", "repo"], deps)).toEqual(SILENT);
    expect(w.ran.map((run) => run.cwd)).toEqual([REPO, REPO]);
    expect(w.guardCalls[0]).toContain(REPO);
  });

  it.each(["", "not json", "[]"])(
    "carries on when stdin is %j",
    async (stdin) => {
      const w = world(CHECKS);
      w.stdin = stdin;
      expect(await runStop([], w.deps)).toEqual(SILENT);
      w.results.set("pnpm test", FAIL);
      expect((await runStop([], w.deps)).code).toBe(2);
    },
  );

  describe("the cap on the loop", () => {
    function failing(): World {
      const w = world(CHECKS);
      w.results.set("pnpm test", FAIL);
      return w;
    }

    it("blocks the same failure twice, then lets the agent stop and tells the person", async () => {
      const w = failing();
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      const third = await attempt(w);
      expect(third.code).toBe(0);
      expect(third.stderr).toBe("");
      expect(third.stdout.endsWith("\n")).toBe(true);
      expect(systemMessage(third)).toBe(
        [
          "Jevy let the agent stop, but the checks still fail. The stop hook blocked it 2 times in a row for the same failure and the failure is still there.",
          "What failed:",
          "- check: pnpm test (exit 1)",
        ].join("\n"),
      );
      // The chain is over: nothing is left behind.
      expect(stateFiles(w)).toEqual([]);
    });

    it("names the guard's findings in the message to the person", async () => {
      const w = world();
      w.guard = guardFound([SKIP]);
      await attempt(w, false);
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        '- jevy guard: skip-added in tests/checkout.spec.ts ("checkout > pays by card")',
      );
    });

    it("ignores the output text when it compares failures", async () => {
      const w = failing();
      await attempt(w, false);
      w.results.set("pnpm test", { ...FAIL, output: "2 tests failed\n" });
      await attempt(w);
      w.results.set("pnpm test", { ...FAIL, code: 2, output: "boom\n" });
      expect((await attempt(w)).code).toBe(0);
    });

    it("starts counting again when the failure changes", async () => {
      const w = failing();
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      // The test passes now but lint fails: a different failure.
      w.results.set("pnpm test", PASS);
      w.results.set("pnpm lint", FAIL);
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(0);
    });

    it("tells failures apart by the guard's kinds, files and tests", async () => {
      const w = world();
      w.guard = guardFound([SKIP]);
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      w.guard = guardFound([{ ...SKIP, test: ["checkout", "pays by cash"] }]);
      expect((await attempt(w)).code).toBe(2);
      w.guard = guardFound([{ ...SKIP, file: "tests/other.spec.ts" }]);
      expect((await attempt(w)).code).toBe(2);
      w.guard = guardFound([{ ...SKIP, kind: "only-added" }]);
      expect((await attempt(w)).code).toBe(2);
    });

    it("reads the same finding with another message or line as the same failure", async () => {
      const w = world();
      w.guard = guardFound([SKIP]);
      expect((await attempt(w, false)).code).toBe(2);
      w.guard = guardFound([{ ...SKIP, message: "worded differently" }]);
      expect((await attempt(w)).code).toBe(2);
      w.guard = guardFound([{ ...SKIP, line: 90 }]);
      expect((await attempt(w)).code).toBe(0);
    });

    it("starts from zero when stop_hook_active is false", async () => {
      const w = failing();
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      // A new turn: the person answered and the agent tries to stop again.
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(0);
    });

    it("starts from zero after an attempt that passed", async () => {
      const w = failing();
      expect((await attempt(w, false)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      w.results.set("pnpm test", PASS);
      expect(await attempt(w)).toEqual(SILENT);
      expect(stateFiles(w)).toEqual([]);
      w.results.set("pnpm test", FAIL);
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(0);
    });

    it("lets the agent stop after six blocks in one chain, whatever the failures", async () => {
      const w = world(CHECKS);
      const codes: number[] = [];
      for (let turn = 0; turn < 7; turn += 1) {
        // A different check fails every time, so no failure repeats.
        w.results.clear();
        w.results.set(turn % 2 === 0 ? "pnpm lint" : "pnpm test", FAIL);
        const result = await attempt(w, turn > 0);
        codes.push(result.code);
        if (turn === 6) {
          expect(systemMessage(result)).toContain(
            "The stop hook blocked it 6 times in this turn and the checks never passed.",
          );
        }
      }
      expect(codes).toEqual([2, 2, 2, 2, 2, 2, 0]);
    });

    it("keeps the state out of the repository, one file per session", async () => {
      const w = failing();
      await attempt(w, false);
      expect(stateFiles(w)).toEqual([statePath(STATE_DIR, REPO, "s1")]);
      w.stdin = stopInput(false, "s2");
      await runStop([], w.deps);
      expect(stateFiles(w)).toHaveLength(2);
      // Session s2 has been blocked once, so s1's two blocks do not end it.
      w.stdin = stopInput(true, "s1");
      expect((await runStop([], w.deps)).code).toBe(2);
      w.stdin = stopInput(true, "s2");
      expect((await runStop([], w.deps)).code).toBe(2);
    });

    it("still blocks when the state file is damaged", async () => {
      const w = failing();
      w.files.set(statePath(STATE_DIR, REPO, "s1"), "{damaged");
      expect((await attempt(w)).code).toBe(2);
      // It was rewritten, so the count works from here.
      expect((await attempt(w)).code).toBe(2);
      expect((await attempt(w)).code).toBe(0);
    });

    it("blocks once, then lets the agent stop and says why, when the state cannot be read or written", async () => {
      const w = failing();
      const deps: HookDeps = {
        ...w.deps,
        state: {
          dir: STATE_DIR,
          // No session start was recorded; the count cannot be read.
          read: (path) =>
            path === startPath(STATE_DIR, REPO, "s1")
              ? Promise.resolve(null)
              : Promise.reject(new Error("EACCES")),
          write: () => Promise.reject(new Error("EROFS")),
          create: () => Promise.reject(new Error("EROFS")),
          remove: () => Promise.reject(new Error("EROFS")),
        },
      };
      // The first attempt of a chain blocks, whatever the state.
      w.stdin = stopInput(false);
      const first = await runStop([], deps);
      expect(first.code).toBe(2);
      expect(first.stderr).toContain("Check failed (exit 1): pnpm test");
      // Blocking again and again would never end: Claude Code's own count
      // of blocks starts again whenever the agent calls a tool.
      w.stdin = stopInput(true);
      for (let turn = 0; turn < 3; turn += 1) {
        const result = await runStop([], deps);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const message = systemMessage(result);
        expect(message).toContain(
          "Jevy let the agent stop, but the checks still fail. The stop hook could not keep its state",
        );
        expect(message).toContain("- check: pnpm test (exit 1)");
      }
      // And a pass is still a pass.
      w.results.clear();
      expect(await runStop([], deps)).toEqual(SILENT);
    });

    it("lets the agent stop when the state can be read but not written", async () => {
      const w = failing();
      const deps: HookDeps = {
        ...w.deps,
        state: {
          ...w.deps.state,
          write: () => Promise.reject(new Error("ENOSPC")),
        },
      };
      w.stdin = stopInput(false);
      expect((await runStop([], deps)).code).toBe(2);
      w.stdin = stopInput(true);
      const second = await runStop([], deps);
      expect(second.code).toBe(0);
      expect(systemMessage(second)).toContain("could not keep its state");
    });

    it("keeps the message to the person short", async () => {
      const commands = Array.from(
        { length: 200 },
        (_, i) => `${"x".repeat(80)} ${String(i)}`,
      );
      const w = world(
        config(`checks: [${commands.map((c) => `"${c}"`).join(", ")}]`),
      );
      w.guard = guardFound([
        SKIP,
        { ...SKIP, kind: "assertion-removed", file: "tests/other.spec.ts" },
      ]);
      const deps: HookDeps = {
        ...w.deps,
        runCommand: () => Promise.resolve(FAIL),
      };
      w.stdin = stopInput(false);
      await runStop([], deps);
      w.stdin = stopInput(true);
      await runStop([], deps);
      const message = systemMessage(await runStop([], deps));
      expect(message.length).toBeLessThanOrEqual(9000);
      expect(message).toContain("What failed:");
      // Short, and still naming what failed: every finding by kind and
      // file, then as many checks as fit, then a count of the rest.
      expect(message).toContain(
        "- jevy guard: skip-added in tests/checkout.spec.ts",
      );
      expect(message).toContain(
        "- jevy guard: assertion-removed in tests/other.spec.ts",
      );
      const listed = commands.filter((command) =>
        message.includes(`- check: ${command} (exit 1)\n`),
      );
      expect(listed.length).toBeGreaterThanOrEqual(50);
      expect(listed).toEqual(commands.slice(0, listed.length));
      expect(
        message.endsWith(`- and ${String(200 - listed.length)} more`),
      ).toBe(true);
    });

    it("names every failure in the message to the person, however long a test title is", async () => {
      const w = world(config(`checks: ["node check.js"]`));
      w.results.set("node check.js", FAIL);
      w.guard = guardFound([
        { ...SKIP, test: ["x".repeat(9500)] },
        { ...SKIP, kind: "assertion-removed", file: "tests/a.spec.ts" },
        { ...SKIP, kind: "test-removed", file: "tests/b.spec.ts", test: null },
      ]);
      await attempt(w, false);
      await attempt(w);
      const message = systemMessage(await attempt(w));
      expect(message.length).toBeLessThanOrEqual(9000);
      expect(message).toContain("- check: node check.js (exit 1)");
      expect(message).toContain(
        `- jevy guard: skip-added in tests/checkout.spec.ts ("${"x".repeat(59)}…")`,
      );
      expect(message).toContain(
        "- jevy guard: assertion-removed in tests/a.spec.ts",
      );
      expect(message).toContain(
        "- jevy guard: test-removed in tests/b.spec.ts",
      );
      expect(message).not.toContain("more");
    });

    it("counts the findings it leaves out of the message to the person", async () => {
      const w = world();
      w.guard = guardFound(
        Array.from({ length: 25 }, (_, i) => ({
          ...SKIP,
          file: `tests/t${String(i)}.spec.ts`,
        })),
      );
      await attempt(w, false);
      await attempt(w);
      const message = systemMessage(await attempt(w));
      expect(message).toContain("in tests/t19.spec.ts");
      expect(message).not.toContain("in tests/t20.spec.ts");
      expect(message).toContain("- jevy guard: and 5 more weakening changes");
    });
  });

  describe("the reason given to the agent", () => {
    it("cuts a long test title, file name and command, and stays bounded", async () => {
      const long = `node ${"y".repeat(5000)}.js`;
      const w = world(config(`checks: ["${long}"]`));
      w.results.set(long, { code: 1, timedOut: false, output: "boom\n" });
      w.guard = guardFound([
        { ...SKIP, test: ["x".repeat(9500)] },
        { ...SKIP, kind: "assertion-removed", file: `${"d/".repeat(900)}a.ts` },
        { ...SKIP, kind: "test-removed", file: "tests/b.spec.ts" },
      ]);
      const { stderr } = await attempt(w, false);
      // It was 10 KB for the one long title alone.
      expect(stderr.length).toBeLessThanOrEqual(9000);
      expect(stderr).toContain("jevy guard found 3 weakening changes");
      expect(stderr).toContain(
        `  tests/checkout.spec.ts: skip-added, line 4, in "${"x".repeat(119)}…": test is now skipped\n`,
      );
      // A long path keeps its end, where the file's own name is.
      expect(stderr).toContain(`  …/${"d/".repeat(97)}a.ts: assertion-removed`);
      expect(stderr).toContain("  tests/b.spec.ts: test-removed");
      expect(stderr).toContain(
        `Check failed (exit 1): node ${"y".repeat(194)}…\n  boom\n`,
      );
      expect(stderr.endsWith(CLOSING)).toBe(true);
    });

    it("stays bounded, and still lists the findings, when two hundred checks fail loudly", async () => {
      const commands = Array.from(
        { length: 200 },
        (_, i) => `check ${String(i)}`,
      );
      const w = world(
        config(`checks: [${commands.map((c) => `"${c}"`).join(", ")}]`),
      );
      w.guard = guardFound(
        Array.from({ length: 25 }, (_, i) => ({
          ...SKIP,
          file: `tests/t${String(i)}.spec.ts`,
          test: ["y".repeat(9500)],
        })),
      );
      const deps: HookDeps = {
        ...w.deps,
        runCommand: () =>
          Promise.resolve({
            code: 1,
            timedOut: false,
            output: `${"noise ".repeat(2000)}\n`,
          }),
      };
      w.stdin = stopInput(false);
      const { code, stderr } = await runStop([], deps);
      expect(code).toBe(2);
      expect(stderr.length).toBeLessThanOrEqual(9000);
      expect(stderr.startsWith("jevy hook stop: the work is not done.\n")).toBe(
        true,
      );
      expect(stderr.endsWith(CLOSING)).toBe(true);
      expect(stderr).toContain("jevy guard found 25 weakening changes");
      for (const index of [0, 1, 2]) {
        expect(stderr).toContain(
          `  tests/t${String(index)}.spec.ts: skip-added, line 4`,
        );
      }
      expect(stderr).toContain("Check failed (exit 1): check 0");
      const shown = stderr.match(/Check failed/g)?.length ?? 0;
      expect(shown).toBeGreaterThanOrEqual(20);
      expect(stderr).toContain(`and ${String(200 - shown)} more failures\n`);
    });

    it("keeps the file's name when a long directory has to be cut", async () => {
      const file = `${"packages/".repeat(40)}checkout/pays-by-card.spec.ts`;
      const w = world();
      w.guard = guardFound([{ ...SKIP, file }]);
      const { stderr } = await attempt(w, false);
      expect(stderr).toMatch(
        /\n {2}…\/[a-z/]*\/checkout\/pays-by-card\.spec\.ts: skip-added/,
      );
      await attempt(w);
      expect(systemMessage(await attempt(w))).toMatch(
        /- jevy guard: skip-added in …\/[a-z/]*\/checkout\/pays-by-card\.spec\.ts/,
      );
    });

    it("escapes control characters in the output of a check and of the guard", async () => {
      const w = world(CHECKS);
      w.results.set("pnpm lint", {
        code: 1,
        timedOut: false,
        output: "\u001b[31mred\u001b[0m\n\u202eevil\tcol\n",
      });
      w.guard = {
        code: 2,
        stdout: "",
        stderr: "jevy guard: \u001b]0;x\u0007 broke\n",
      };
      const { stderr } = await attempt(w, false);
      expect(stderr).toContain(
        "  \\u001b[31mred\\u001b[0m\n  \\u202eevil\tcol\n",
      );
      expect(stderr).toContain("\\u001b]0;x\\u0007 broke");
      for (const raw of ["\u001b", "\u0007", "\u202e"]) {
        expect(stderr).not.toContain(raw);
      }
    });

    it("gives the guard's own error text to the person as well", async () => {
      const w = world();
      w.guard = {
        code: 2,
        stdout: "",
        stderr:
          "jevy guard: unknown revision 'origin/main'\n\nUsage: jevy guard\n",
      };
      await attempt(w, false);
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        "- jevy guard could not run (exit 2): unknown revision 'origin/main'",
      );
    });
  });

  describe("the session's own commits", () => {
    const SESSION_CALL = ["--base", START, "--cwd", REPO, "--json"];
    const BRANCH_CALL = [
      "--base",
      "origin/main",
      "--merge-base",
      "--cwd",
      REPO,
      "--json",
    ];

    it("finds the record from a --cwd below the repository's root", async () => {
      // session-start ran at the root, as the printed snippet runs it; the
      // stop hook was told to run in the directory of the config.
      const w = world();
      const app = `${REPO}/packages/app`;
      w.files.set(`${app}/jevy.config.ts`, CHECKS);
      recordStart(w);
      w.guardBy.set(START, guardFound([SKIP]));
      w.stdin = stopInput(false);
      const result = await runStop(["--cwd", app], w.deps);
      expect(w.guardCalls).toContainEqual([
        "--base",
        START,
        "--cwd",
        app,
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(SINCE_START);
    });

    it("blocks when git cannot name the repository's top level in a repository", async () => {
      const w = world(CHECKS);
      recordStart(w);
      w.top = null;
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook cannot find the root of the repository, so it cannot find its record of where this session started.",
      );
    });

    it("runs the guard a second time, against the commit the session started from", async () => {
      const w = world(CHECKS);
      recordStart(w);
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.guardCalls).toEqual([BRANCH_CALL, SESSION_CALL]);
    });

    it("blocks on what the session committed, which the branch comparison cannot see", async () => {
      const w = world();
      recordStart(w);
      // On main with no remote the branch comparison is HEAD against the
      // working tree: clean once the change is committed.
      w.guardBy.set(START, guardFound([SKIP]));
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        [
          "jevy hook stop: the work is not done.",
          "",
          `jevy guard found 1 weakening change since ${SINCE_START}:`,
          '  tests/checkout.spec.ts: skip-added, line 4, in "checkout > pays by card": test is now skipped',
          "",
          CLOSING,
        ].join("\n"),
      );
    });

    it("lists a finding both comparisons report once", async () => {
      const w = world();
      recordStart(w);
      w.guard = guardFound([SKIP]);
      const { stderr } = await attempt(w, false);
      expect(stderr).toContain(
        `jevy guard found 1 weakening change since origin/main and since ${SINCE_START}:\n`,
      );
      expect(stderr.match(/skip-added/g)).toHaveLength(1);
    });

    it("merges what the two comparisons find", async () => {
      const w = world();
      recordStart(w);
      const other = { ...SKIP, kind: "assertion-removed", file: "tests/a.ts" };
      w.guardBy.set("origin/main", guardFound([SKIP]));
      w.guardBy.set(START, guardFound([SKIP, other]));
      const { stderr } = await attempt(w, false);
      expect(stderr).toContain("jevy guard found 2 weakening changes since");
      expect(stderr.match(/skip-added/g)).toHaveLength(1);
      expect(stderr).toContain("  tests/a.ts: assertion-removed");
    });

    it("blocks, and says so, when the commit it recorded no longer exists", async () => {
      const w = world();
      recordStart(w);
      w.refs.delete(START);
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The commit this session started from (aaaaaaa) no longer exists in the repository, so jevy guard cannot check what the session committed.",
      );
      // The branch comparison still ran.
      expect(w.guardCalls).toEqual([BRANCH_CALL]);
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        "- the commit the session started from (aaaaaaa) no longer exists, so what the session committed was not checked",
      );
    });

    it("blocks when the record cannot be read, even though the checks pass", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const result = await runStop([], {
        ...w.deps,
        state: {
          ...w.deps.state,
          read: () => Promise.reject(new Error("EACCES: permission denied")),
        },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook cannot read its record of where this session started (EACCES: permission denied)",
      );
    });

    it("blocks when the record is damaged, and does not read it as no record", async () => {
      const w = world();
      w.files.set(startPath(STATE_DIR, REPO, "s1"), "{damaged");
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook cannot read its record of where this session started (it is damaged)",
      );
    });

    it("says which comparison could not run", async () => {
      const w = world();
      recordStart(w);
      w.guardBy.set(START, {
        code: 2,
        stdout: "",
        stderr: "jevy guard: bad object\n",
      });
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "jevy guard could not run on what this session committed (exit 2):\n  jevy guard: bad object\n",
      );
    });

    it("compares the session even when there is no branch to compare with", async () => {
      const w = world();
      recordStart(w);
      w.refs.clear();
      w.refs.add(START);
      w.guardBy.set(START, guardFound([SKIP]));
      const { stderr } = await attempt(w, false);
      expect(w.guardCalls).toEqual([SESSION_CALL]);
      expect(stderr).toContain("skip-added");
      expect(stderr).toContain("The hook cannot tell which branch");
    });

    it("keeps the record when the count is cleared, and for the next turn", async () => {
      const w = world(CHECKS);
      recordStart(w);
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(stateFiles(w)).toEqual([startPath(STATE_DIR, REPO, "s1")]);
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.guardCalls).toHaveLength(4);
    });

    it("behaves as before with no record: one comparison", async () => {
      const w = world(CHECKS);
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.guardCalls).toEqual([BRANCH_CALL]);
      // Another session's record is not this session's.
      w.files.set(startPath(STATE_DIR, REPO, "s2"), serialiseStart(START));
      w.guardCalls.length = 0;
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.guardCalls).toEqual([BRANCH_CALL]);
    });
  });

  describe("a change to the config", () => {
    const REASON =
      "the Jevy config changed in this session; a person must approve that change";
    const BEFORE = config(
      `checks: ["pnpm lint", "pnpm test"], ci: { mainBranch: "main" }`,
    );

    it("blocks when the config differs from the session's start, whatever the guard says", async () => {
      // The agent pointed ci.mainBranch at its own branch and committed.
      const w = world(
        config(`checks: ["pnpm lint"], ci: { mainBranch: "feature" }`),
      );
      w.refs.add("feature");
      recordStart(w);
      w.committed.set(`${START}:jevy.config.ts`, BEFORE);
      const result = await attempt(w, false);
      expect(w.guardBy.size).toBe(0);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        [
          "jevy hook stop: the work is not done.",
          "",
          `The work is blocked because ${REASON}: jevy.config.ts (changed) since aaaaaaa. Put the config back as it was and ask the maintainer to make the change.`,
          "",
          CLOSING,
        ].join("\n"),
      );
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        `- ${REASON}: jevy.config.ts (changed) since aaaaaaa`,
      );
    });

    it("reads the config as it was through git, at the recorded commit, and never imports it", async () => {
      const w = world(CHECKS);
      recordStart(w);
      await attempt(w, false);
      expect(w.readAtCalls).toEqual([
        `${START}:jevy.config.ts`,
        `${START}:jevy.config.mts`,
        `${START}:jevy.config.js`,
        `${START}:jevy.config.mjs`,
      ]);
    });

    it("blocks for a config that was added or removed", async () => {
      const added = world(CHECKS);
      recordStart(added);
      added.committed.set(`${START}:jevy.config.ts`, null);
      expect((await attempt(added, false)).stderr).toContain(
        `${REASON}: jevy.config.ts (added) since aaaaaaa`,
      );
      const removed = world();
      recordStart(removed);
      removed.committed.set(`${START}:jevy.config.mjs`, "export default {};\n");
      removed.tracked = ["jevy.config.mjs"];
      const result = await attempt(removed, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        `${REASON}: jevy.config.mjs (removed) since aaaaaaa`,
      );
      // Its own config, deleted, is not "a config somewhere else".
      expect(result.stderr).not.toContain("--cwd");
    });

    it("names every config file that changed", async () => {
      const w = world(CHECKS);
      recordStart(w);
      w.committed.set(`${START}:jevy.config.ts`, BEFORE);
      w.committed.set(`${START}:jevy.config.js`, "module.exports = {};\n");
      expect((await attempt(w, false)).stderr).toContain(
        `${REASON}: jevy.config.ts (changed), jevy.config.js (removed) since aaaaaaa`,
      );
    });

    it("compares with HEAD when no session start was recorded", async () => {
      const w = world(CHECKS);
      w.committed.set(`${HEAD}:jevy.config.ts`, BEFORE);
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        `${REASON}: jevy.config.ts (changed) since fffffff`,
      );
      expect(w.readAtCalls[0]).toBe(`${HEAD}:jevy.config.ts`);
    });

    it("does not take a change of line endings for a change", async () => {
      const w = world(CHECKS);
      recordStart(w);
      w.committed.set(
        `${START}:jevy.config.ts`,
        CHECKS.replaceAll("\n", "\r\n"),
      );
      expect(await attempt(w, false)).toEqual(SILENT);
    });

    it("leaves it to the guard when there is no commit to compare with", async () => {
      const w = world(CHECKS);
      w.head = null;
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.readAtCalls).toEqual([]);
    });

    it("blocks when git cannot say what the config was", async () => {
      const w = world(CHECKS);
      const deps: HookDeps = {
        ...w.deps,
        git: {
          ...w.deps.git,
          readAt: () => Promise.reject(new Error("git could not read")),
        },
      };
      const result = await runStop([], deps);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "The hook itself failed: git could not read",
      );
    });
  });

  describe("a config in another directory", () => {
    it("blocks, naming the config found and the --cwd to use", async () => {
      const w = world();
      w.tracked = [
        "packages/app/jevy.config.ts",
        "packages/web/jevy.config.ts",
      ];
      const result = await attempt(w, false);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "/repo has no jevy.config.*, but the repository has packages/app/jevy.config.ts (and 1 more). The hook reads the config of the directory it runs in, so it ran no check. A person has to run the hook in the directory of the config: --cwd /repo/packages/app\n",
      );
      // The guard still ran, in the directory the hook was given.
      expect(w.guardCalls).toHaveLength(1);
      await attempt(w);
      expect(systemMessage(await attempt(w))).toContain(
        "- /repo has no jevy.config.*, but the repository has packages/app/jevy.config.ts (and 1 more), so no check was run; the hook needs --cwd /repo/packages/app",
      );
    });

    it("does not ask git when the directory has a config", async () => {
      const w = world(CHECKS);
      w.tracked = ["packages/app/jevy.config.ts"];
      expect(await attempt(w, false)).toEqual(SILENT);
    });

    it("runs the guard alone when no config is tracked anywhere", async () => {
      const w = world();
      expect(await attempt(w, false)).toEqual(SILENT);
      expect(w.guardCalls).toHaveLength(1);
    });
  });

  describe("a config that is not a regular file", () => {
    it("blocks with the reader's own message", async () => {
      const w = world(CHECKS);
      const deps: HookDeps = {
        ...w.deps,
        readFile: () =>
          Promise.reject(
            new GuardError(
              "/repo/jevy.config.ts is a FIFO, not a regular file. The hook reads the config only from a regular file, so a person has to put one back.",
            ),
          ),
      };
      const result = await runStop([], deps);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        [
          "jevy hook stop: the work is not done.",
          "",
          "/repo/jevy.config.ts is a FIFO, not a regular file. The hook reads the config only from a regular file, so a person has to put one back.",
          "",
          CLOSING,
        ].join("\n"),
      );
      expect(w.ran).toEqual([]);
    });
  });

  describe("the deadline", () => {
    it("is 1500 seconds unless --deadline says otherwise", () => {
      expect(DEFAULT_STOP_DEADLINE_SECONDS).toBe(1500);
    });

    it("blocks when a check never comes back, and says which checks did not finish", async () => {
      const w = world(
        config(`checks: ["pnpm lint", "pnpm hang", "pnpm test"]`),
      );
      w.results.set("pnpm lint", FAIL);
      const started: string[] = [];
      let signal: AbortSignal | undefined;
      const deps: HookDeps = {
        ...w.deps,
        runCommand: (command, options) => {
          started.push(command);
          if (command === "pnpm hang") {
            ({ signal } = options);
            return never();
          }
          return Promise.resolve(w.results.get(command) ?? PASS);
        },
      };
      w.stdin = stopInput(false);
      const began = Date.now();
      const result = await runStop(["--deadline", "0.1"], deps);
      expect(Date.now() - began).toBeLessThan(3000);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        [
          "jevy hook stop: the work is not done.",
          "",
          "Check failed (exit 1): pnpm lint",
          "  1 test failed",
          "",
          "The hook ran out of time: its limit of 0.1 s passed while it was running the check pnpm hang. What did not finish has not passed:",
          "  killed while it was running: pnpm hang",
          "  not started: pnpm test",
          "  not finished: jevy guard",
          "  not finished: the comparison of the config with the start of the session",
          "",
          CLOSING,
        ].join("\n"),
      );
      // What was running was told to stop, and nothing was started after.
      expect(signal?.aborted).toBe(true);
      expect(started).toEqual(["pnpm lint", "pnpm hang"]);
      expect(w.guardCalls).toEqual([]);
    });

    it("starts nothing more when the running check ends after the deadline", async () => {
      const w = world(config(`checks: ["pnpm slow", "pnpm test"]`));
      const started: string[] = [];
      const deps: HookDeps = {
        ...w.deps,
        runCommand: (command, { signal }) => {
          started.push(command);
          return new Promise((done) => {
            // As the real runner does: killed on abort, then it answers.
            signal?.addEventListener("abort", () => {
              done({ code: null, timedOut: true, output: "" });
            });
          });
        },
      };
      const result = await runStop(["--deadline", "0.05"], deps);
      expect(result.code).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(started).toEqual(["pnpm slow"]);
      expect(w.guardCalls).toEqual([]);
    });

    it.each([
      ["the config read", { readFile: never }, "reading the config"],
      ["stdin", { readStdin: never }, "reading the hook input"],
      ["the guard", { guard: never }, "running jevy guard against origin/main"],
      ["a git query", { refExists: never }, "running the check pnpm test"],
    ])("blocks when %s never comes back", async (_name, hung, doing) => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const began = Date.now();
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        ...hung,
      });
      expect(Date.now() - began).toBeLessThan(3000);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        `The hook ran out of time: its limit of 0.05 s passed while it was ${doing}.`,
      );
      expect(result.stderr).toContain("  not finished: jevy guard\n");
    });

    it("blocks when its own state files never come back", async () => {
      const w = world(CHECKS);
      w.results.set("pnpm test", FAIL);
      w.stdin = stopInput(true);
      const began = Date.now();
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        state: {
          ...w.deps.state,
          // The count's file hangs; no session start was recorded.
          read: (path) =>
            path === startPath(STATE_DIR, REPO, "s1")
              ? Promise.resolve(null)
              : never(),
          write: never,
          remove: never,
        },
      });
      expect(Date.now() - began).toBeLessThan(3000);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Check failed (exit 1): pnpm test");
      expect(result.stderr).not.toContain("ran out of time");
    });

    it("reports what one guard comparison found when the other never comes back", async () => {
      const w = world();
      recordStart(w);
      w.stdin = stopInput(false);
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        guard: (argv) =>
          argv[1] === START ? never() : Promise.resolve(guardFound([SKIP])),
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "jevy guard found 1 weakening change since origin/main:",
      );
      expect(result.stderr).toContain(
        `passed while it was running jevy guard against ${SINCE_START}.`,
      );
    });

    it("is under the same cap as any other failure, and tells the person what did not finish", async () => {
      const w = world(config(`checks: ["pnpm hang"]`));
      const deps: HookDeps = { ...w.deps, runCommand: never };
      w.stdin = stopInput(false);
      expect((await runStop(["--deadline", "0.05"], deps)).code).toBe(2);
      w.stdin = stopInput(true);
      expect((await runStop(["--deadline", "0.05"], deps)).code).toBe(2);
      const third = await runStop(["--deadline", "0.05"], deps);
      expect(third.code).toBe(0);
      const message = systemMessage(third);
      expect(message).toContain(
        "- the hook ran out of time (0.05 s) while it was running the check pnpm hang",
      );
      expect(message).toContain("- killed while it was running: pnpm hang");
      expect(message).toContain("- not finished: jevy guard");
    });

    it("names the comparison of the config when that is what did not finish", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        git: { ...w.deps.git, readAt: never },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "passed while it was comparing the config with the start of the session. What did not finish has not passed:\n  not finished: the comparison of the config with the start of the session\n",
      );
    });

    it("names the checks when the config was never read", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        readFile: never,
      });
      expect(result.stderr).toContain(
        "  not started: the checks (the config was not read)\n",
      );
    });

    it("names the checks that never started while it read the session's record", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        state: { ...w.deps.state, read: never },
      });
      expect(result.stderr).toContain(
        "  not started: pnpm lint\n  not started: pnpm test\n",
      );
    });

    it("hands the guard its signal, which aborts when the deadline passes", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      let signal: AbortSignal | undefined;
      const result = await runStop(["--deadline", "0.05"], {
        ...w.deps,
        guard: (_argv, given) => {
          signal = given;
          return never();
        },
      });
      expect(result.code).toBe(2);
      expect(signal?.aborted).toBe(true);
    });

    it("does not report a deadline when everything finished in time", async () => {
      const w = world(CHECKS);
      expect(await runStop(["--deadline", "30"], w.deps)).toEqual(SILENT);
    });
  });

  describe("an internal error", () => {
    function broken(w: World): HookDeps {
      return {
        ...w.deps,
        readFile: () => Promise.reject(new Error("EACCES: jevy.config.ts")),
      };
    }

    it("blocks, and never exits 1", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      const result = await runStop([], broken(w));
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("jevy hook stop: ");
      expect(result.stderr).toContain(
        "The hook itself failed: EACCES: jevy.config.ts",
      );
    });

    it("is under the same cap", async () => {
      const w = world(CHECKS);
      w.stdin = stopInput(false);
      expect((await runStop([], broken(w))).code).toBe(2);
      w.stdin = stopInput(true);
      expect((await runStop([], broken(w))).code).toBe(2);
      const third = await runStop([], broken(w));
      expect(third.code).toBe(0);
      expect(systemMessage(third)).toContain(
        "- the hook itself failed: EACCES: jevy.config.ts",
      );
    });

    it("keeps what it had already found when the guard throws", async () => {
      const w = world(CHECKS);
      w.results.set("pnpm test", FAIL);
      const deps: HookDeps = {
        ...w.deps,
        guard: () => Promise.reject(new Error("guard blew up")),
      };
      const result = await runStop([], deps);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Check failed (exit 1): pnpm test");
      expect(result.stderr).toContain("The hook itself failed: guard blew up");
    });

    it("blocks when stdin cannot be read", async () => {
      const w = world(CHECKS);
      w.results.set("pnpm test", FAIL);
      const deps: HookDeps = {
        ...w.deps,
        readStdin: () => Promise.reject(new Error("EAGAIN")),
      };
      expect((await runStop([], deps)).code).toBe(2);
      w.results.clear();
      expect(await runStop([], deps)).toEqual(SILENT);
    });
  });

  describe("the command line", () => {
    it.each([
      [["--nope"], "unknown option '--nope'"],
      [["extra"], "unexpected argument 'extra'"],
      [["--base"], "--base needs a value"],
      [["--base", "-x"], "--base must not start with '-': -x"],
      [["--base", ""], "--base needs a value"],
      [["--timeout", "0"], "--timeout must be a number of seconds above 0: 0"],
      [
        ["--timeout", "soon"],
        "--timeout must be a number of seconds above 0: soon",
      ],
      [["--cwd", "a", "--cwd", "b"], "--cwd given twice"],
      [["--deadline"], "--deadline needs a value"],
      [
        ["--deadline", "0"],
        "--deadline must be a number of seconds above 0: 0",
      ],
      [
        ["--deadline", "1e12"],
        "--deadline must be a number of seconds above 0: 1e12",
      ],
    ])("exits 2 for %j", async (argv, message) => {
      const w = world(CHECKS);
      const result = await runStop(argv, w.deps);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`jevy hook stop: ${message}\n`);
      expect(result.stderr).toContain("Usage: jevy hook stop");
      expect(w.ran).toEqual([]);
      expect(w.guardCalls).toEqual([]);
    });

    it("prints usage for --help and runs nothing", async () => {
      const w = world(CHECKS);
      const result = await runStop(["--help"], w.deps);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: jevy hook stop");
      expect(result.stderr).toBe("");
      expect(w.ran).toEqual([]);
    });
  });
});

describe("jevy hook stop with real commands and a real state file", () => {
  const repo = mkdtempSync(join(tmpdir(), "jevy-hook-stop-"));
  const stateDir = mkdtempSync(join(tmpdir(), "jevy-hook-stop-state-"));
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function deps(stdin: string): HookDeps {
    return {
      ...defaultHookDeps(),
      cwd: repo,
      readStdin: () => Promise.resolve(stdin),
      // The guard has its own tests; here it finds nothing.
      guard: () => Promise.resolve(CLEAN),
      // Only a local main: a ref that does not exist is no longer handed
      // to the guard, so "no ref at all" would now block.
      refExists: (ref) => Promise.resolve(ref === "main"),
      // The temporary directory is not a repository.
      git: {
        head: () => Promise.resolve(null),
        topLevel: () => Promise.resolve(null),
        originHead: () => Promise.resolve(null),
        readAt: () => Promise.reject(new Error("not a repository")),
        trackedConfigs: () => Promise.resolve([]),
      },
      state: realStateFiles(stateDir),
    };
  }

  function writeConfig(checks: readonly string[]): void {
    writeFileSync(
      join(repo, "jevy.config.ts"),
      `export default { checks: ${JSON.stringify(checks)} };\n`,
    );
  }

  it("blocks twice on a failing check, then lets go, and cleans up", async () => {
    writeConfig([
      `node -e "console.log(process.cwd())"`,
      `node -e "console.error('boom'); process.exit(1)"`,
    ]);
    const before = readdirSync(repo);
    const first = await runStop([], deps(stopInput(false, "real")));
    expect(first.code).toBe(2);
    expect(first.stderr).toContain(
      `Check failed (exit 1): node -e "console.error('boom'); process.exit(1)"\n  boom\n`,
    );
    expect(readdirSync(stateDir)).toHaveLength(1);
    expect((await runStop([], deps(stopInput(true, "real")))).code).toBe(2);
    const third = await runStop([], deps(stopInput(true, "real")));
    expect(third.code).toBe(0);
    expect(systemMessage(third)).toContain("the checks still fail");
    expect(readdirSync(stateDir)).toEqual([]);
    // Nothing was written into the repository.
    expect(readdirSync(repo)).toEqual(before);
  });

  it("allows the stop when the checks pass", async () => {
    writeConfig([`node -e "process.exit(0)"`]);
    expect(await runStop([], deps(stopInput(false, "real")))).toEqual(SILENT);
  });

  it("kills a check that runs past --timeout", async () => {
    writeConfig([`node -e "setTimeout(() => {}, 60000)"`]);
    const started = Date.now();
    const result = await runStop(
      ["--timeout", "1.5"],
      deps(stopInput(false, "slow")),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Check failed (timed out after 1.5 s): node",
    );
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("reads a config that is not there as no checks", async () => {
    rmSync(join(repo, "jevy.config.ts"));
    expect(await runStop([], deps(stopInput(false, "real")))).toEqual(SILENT);
  });
});
