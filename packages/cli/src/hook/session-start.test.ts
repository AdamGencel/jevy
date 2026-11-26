import { describe, expect, it } from "vitest";
import type { CliResult } from "../cli.js";
import type { HookDeps } from "./deps.js";
import { runSessionStart } from "./session-start.js";
import { serialiseStart, startPath } from "./state.js";

const REPO = "/repo";
const STATE_DIR = "/state";
const COMMIT = "a".repeat(40);
const LATER = "b".repeat(40);
const SILENT: CliResult = { code: 0, stdout: "", stderr: "" };

interface World {
  head: string | null;
  /** The repository's top level, by directory; a directory not listed is its own. */
  readonly tops: Map<string, string | null>;
  readonly files: Map<string, string>;
  readonly deps: HookDeps;
}

function input(source: string, session: unknown = "s1"): string {
  return JSON.stringify({
    session_id: session,
    cwd: REPO,
    hook_event_name: "SessionStart",
    source,
  });
}

function world(stdin: string): World {
  const files = new Map<string, string>();
  const unused = (): Promise<never> =>
    Promise.reject(new Error("session-start must not use this"));
  const out: World = {
    head: COMMIT,
    tops: new Map(),
    files,
    deps: {
      cwd: REPO,
      readStdin: () => Promise.resolve(stdin),
      readFile: unused,
      realpath: unused,
      readlink: unused,
      runCommand: unused,
      guard: unused,
      refExists: unused,
      git: {
        head: () => Promise.resolve(out.head),
        topLevel: (cwd) =>
          Promise.resolve(
            out.tops.has(cwd) ? (out.tops.get(cwd) ?? null) : cwd,
          ),
        originHead: unused,
        readAt: unused,
        trackedConfigs: unused,
      },
      state: {
        dir: STATE_DIR,
        read: (path) => Promise.resolve(files.get(path) ?? null),
        write: unused,
        create: (path, text) => {
          if (files.has(path)) {
            return Promise.resolve(false);
          }
          files.set(path, text);
          return Promise.resolve(true);
        },
        remove: unused,
      },
    },
  };
  return out;
}

const PATH = startPath(STATE_DIR, REPO, "s1");

describe("jevy hook session-start", () => {
  it("records the commit HEAD points at, and prints nothing", async () => {
    const w = world(input("startup"));
    // Stdout of a SessionStart hook is added to the model's context.
    expect(await runSessionStart([], w.deps)).toEqual(SILENT);
    expect([...w.files]).toEqual([[PATH, serialiseStart(COMMIT)]]);
  });

  it.each(["resume", "compact", "clear", "fork"])(
    "does not move the baseline when the session starts again (%s)",
    async (source) => {
      const w = world(input("startup"));
      await runSessionStart([], w.deps);
      w.head = LATER;
      const again: HookDeps = {
        ...w.deps,
        readStdin: () => Promise.resolve(input(source)),
      };
      expect(await runSessionStart([], again)).toEqual(SILENT);
      expect(w.files.get(PATH)).toBe(serialiseStart(COMMIT));
    },
  );

  it("records a start it has not seen before, whatever the source", async () => {
    // The hook was wired in, or the state was lost, after the session began.
    const w = world(input("resume"));
    expect(await runSessionStart([], w.deps)).toEqual(SILENT);
    expect(w.files.get(PATH)).toBe(serialiseStart(COMMIT));
  });

  it("keeps one record per session and per project", async () => {
    const w = world(input("startup", "s2"));
    await runSessionStart([], w.deps);
    await runSessionStart(["--cwd", "/other"], w.deps);
    expect([...w.files.keys()].sort()).toEqual(
      [
        startPath(STATE_DIR, REPO, "s2"),
        startPath(STATE_DIR, "/other", "s2"),
      ].sort(),
    );
  });

  it("keys the record by the repository's top level, so every --cwd in it shares one", async () => {
    // The printed snippet runs this hook at the project root; the stop hook
    // may be told to run in the directory of a config below it.
    const w = world(input("startup"));
    w.tops.set(`${REPO}/packages/app`, REPO);
    expect(await runSessionStart(["--cwd", "packages/app"], w.deps)).toEqual(
      SILENT,
    );
    expect([...w.files]).toEqual([[PATH, serialiseStart(COMMIT)]]);
  });

  it("records nothing when git cannot name the repository's top level", async () => {
    const w = world(input("startup"));
    w.tops.set(REPO, null);
    expect(await runSessionStart([], w.deps)).toEqual(SILENT);
    expect(w.files.size).toBe(0);
  });

  it("records nothing on an unborn HEAD or outside a repository", async () => {
    const w = world(input("startup"));
    w.head = null;
    expect(await runSessionStart([], w.deps)).toEqual(SILENT);
    expect(w.files.size).toBe(0);
  });

  it.each(["", "not json", "[]", "{}", input("startup", 7)])(
    "records nothing when the input names no session (%j)",
    async (stdin) => {
      const w = world(stdin);
      expect(await runSessionStart([], w.deps)).toEqual(SILENT);
      expect(w.files.size).toBe(0);
    },
  );

  it("exits 0 with nothing on stdout when anything fails", async () => {
    const w = world(input("startup"));
    const cases: readonly HookDeps[] = [
      {
        ...w.deps,
        readStdin: () => Promise.reject(new Error("EAGAIN")),
      },
      {
        ...w.deps,
        git: { ...w.deps.git, head: () => Promise.reject(new Error("no git")) },
      },
      {
        ...w.deps,
        state: {
          ...w.deps.state,
          create: () => Promise.reject(new Error("EROFS: read-only")),
        },
      },
    ];
    for (const deps of cases) {
      const result = await runSessionStart([], deps);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "jevy hook session-start: the start of the session was not recorded: ",
      );
    }
    expect(w.files.size).toBe(0);
  });

  it("exits 0 when its time is up, although git never answers", async () => {
    const w = world(input("startup"));
    const hung: HookDeps = {
      ...w.deps,
      git: { ...w.deps.git, head: () => new Promise(() => undefined) },
    };
    const started = Date.now();
    const result = await runSessionStart(["--deadline", "0.05"], hung);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ran out of time (0.05 s)");
  });

  it.each([
    [["--nope"], "unknown option '--nope'"],
    [["extra"], "unexpected argument 'extra'"],
    [["--cwd"], "--cwd needs a value"],
    [["--deadline", "0"], "--deadline must be a number of seconds above 0: 0"],
  ])("exits 2 for the usage error %j", async (argv, message) => {
    const w = world(input("startup"));
    const result = await runSessionStart(argv, w.deps);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`jevy hook session-start: ${message}\n`);
    expect(result.stderr).toContain("Usage: jevy hook session-start");
    expect(w.files.size).toBe(0);
  });

  it("prints usage for --help and records nothing", async () => {
    const w = world(input("startup"));
    const result = await runSessionStart(["--help"], w.deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: jevy hook session-start");
    expect(w.files.size).toBe(0);
  });
});
