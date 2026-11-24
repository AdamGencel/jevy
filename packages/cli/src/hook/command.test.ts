import { describe, expect, it } from "vitest";
import { hookCrash, runHook } from "./command.js";
import { defaultHookDeps, type HookDeps } from "./deps.js";
import { serialiseStart, startPath } from "./state.js";

/** What the fake state was asked to create, across the tests of this file. */
const created: [string, string][] = [];

function deps(stdin: string): HookDeps {
  return {
    ...defaultHookDeps(),
    cwd: "/repo",
    readStdin: () => Promise.resolve(stdin),
    readFile: () => Promise.resolve(null),
    realpath: (path) => Promise.resolve(path),
    readlink: () => Promise.resolve(null),
    runCommand: () => Promise.reject(new Error("no checks expected")),
    guard: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    refExists: () => Promise.resolve(true),
    git: {
      head: () => Promise.resolve("a".repeat(40)),
      originHead: () => Promise.resolve(null),
      readAt: () => Promise.resolve(null),
      trackedConfigs: () => Promise.resolve([]),
    },
    state: {
      dir: "/state",
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      create: (path, text) => {
        created.push([path, text]);
        return Promise.resolve(true);
      },
      remove: () => Promise.resolve(),
    },
  };
}

describe("jevy hook", () => {
  it("routes stop", async () => {
    expect(await runHook(["stop"], deps(""))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const result = await runHook(["stop", "--nope"], deps(""));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jevy hook stop: unknown option '--nope'");
  });

  it("routes pre-edit", async () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/jevy.config.ts" },
    });
    const result = await runHook(["pre-edit"], deps(stdin));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jevy.config.ts is protected");
    expect(
      await runHook(
        ["pre-edit"],
        deps(JSON.stringify({ tool_input: { file_path: "/repo/a.ts" } })),
      ),
    ).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("routes session-start", async () => {
    created.length = 0;
    const stdin = JSON.stringify({ session_id: "s1", source: "startup" });
    expect(await runHook(["session-start"], deps(stdin))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(created).toEqual([
      [startPath("/state", "/repo", "s1"), serialiseStart("a".repeat(40))],
    ]);
    const bad = await runHook(["session-start", "--nope"], deps(stdin));
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain(
      "jevy hook session-start: unknown option '--nope'",
    );
  });

  it("routes print, which reads no input", async () => {
    const result = await runHook(["print", "--agent", "claude"], {
      ...deps(""),
      readStdin: () => Promise.reject(new Error("stdin must not be read")),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("jevy hook pre-edit");
  });

  it.each([["--help"], ["-h"]])("prints usage for %s", async (flag) => {
    const result = await runHook([flag], deps(""));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: jevy hook <stop|pre-edit|session-start|print>",
    );
    for (const name of ["stop", "pre-edit", "session-start", "print"]) {
      expect(result.stdout).toContain(`  ${name}`);
    }
    expect(result.stdout).toContain("Exit codes");
  });

  it.each(["stop", "pre-edit", "session-start", "print"])(
    "prints the usage of %s for its --help",
    async (name) => {
      const result = await runHook([name, "--help"], deps(""));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Usage: jevy hook ${name}`);
      expect(result.stderr).toBe("");
    },
  );

  it("exits 2 with no subcommand", async () => {
    const result = await runHook([], deps(""));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "jevy hook: expected stop, pre-edit, session-start or print\n",
    );
    expect(result.stderr).toContain(
      "Usage: jevy hook <stop|pre-edit|session-start|print>",
    );
  });

  it("exits 2 for an unknown subcommand", async () => {
    const result = await runHook(["start"], deps(""));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "jevy hook: unknown hook 'start'; expected stop, pre-edit, session-start or print\n",
    );
  });

  describe("when something throws that no subcommand caught", () => {
    function crashing(stdin: string): HookDeps {
      const out = deps(stdin);
      // A getter, so the throw comes from inside the subcommand's own code.
      Object.defineProperty(out, "state", {
        get: () => {
          throw new Error("ENOENT: uv_cwd");
        },
      });
      return out;
    }

    it("exits 2 for the hooks that block", async () => {
      expect(await runHook(["stop"], crashing(""))).toEqual({
        code: 2,
        stdout: "",
        stderr: "jevy hook stop: ENOENT: uv_cwd\n",
      });
    });

    it("says what a crash before the hook started means, by hook", () => {
      const error = new Error("ENOENT: no such file or directory, uv_cwd");
      for (const name of ["stop", "pre-edit", "print", "nonsense", undefined]) {
        expect(hookCrash(name === undefined ? [] : [name], error)).toEqual({
          code: 2,
          stdout: "",
          stderr: "jevy hook: ENOENT: no such file or directory, uv_cwd\n",
        });
      }
      // It has nothing to block, and exit 2 would only show an error.
      expect(hookCrash(["session-start"], error)).toEqual({
        code: 0,
        stdout: "",
        stderr: "jevy hook: ENOENT: no such file or directory, uv_cwd\n",
      });
      expect(hookCrash(["stop"], "a string").stderr).toBe(
        "jevy hook: a string\n",
      );
    });
  });
});

describe("the default deps", () => {
  it("read no input, so a caller that passes none cannot hang", async () => {
    expect(await defaultHookDeps().readStdin()).toBe("");
  });

  it("read a missing file as null", async () => {
    const { readFile } = defaultHookDeps();
    expect(await readFile("/definitely/not/here/jevy.config.ts")).toBeNull();
    // A directory in the place of the file is not a config either, and it
    // is not "no config": the hooks fail closed on it.
    await expect(readFile(process.cwd())).rejects.toThrow(
      "is a directory, not a regular file",
    );
  });
});
