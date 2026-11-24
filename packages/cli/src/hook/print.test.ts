import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_PRE_EDIT_DEADLINE_SECONDS } from "./pre-edit.js";
import { claudeSettings, runPrint } from "./print.js";
import { DEFAULT_SESSION_START_DEADLINE_SECONDS } from "./session-start.js";
import { DEFAULT_STOP_DEADLINE_SECONDS } from "./stop.js";

describe("jevy hook print", () => {
  const PREFIX =
    '(: "${CLAUDE_PROJECT_DIR:?}") && cd "$CLAUDE_PROJECT_DIR" && ./node_modules/.bin/jevy hook';

  it("prints the Claude Code settings that wire the three hooks", () => {
    const result = runPrint(["--agent", "claude"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("}\n")).toBe(true);
    expect(result.stdout).toContain('\n  "hooks": {\n    "SessionStart": [');
    const settings: unknown = JSON.parse(result.stdout);
    expect(settings).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                // No `|| exit 2`: this hook has nothing to block.
                command: `${PREFIX} session-start`,
                timeout: 30,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `${PREFIX} stop || exit 2`,
                timeout: 1800,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [
              {
                type: "command",
                command: `${PREFIX} pre-edit || exit 2`,
                timeout: 30,
                onFailure: "block",
              },
            ],
          },
        ],
      },
    });
    expect(result.stdout).toBe(`${JSON.stringify(settings, null, 2)}\n`);
  });

  it("asks no package registry: the commands run the installed binary or nothing", () => {
    const { stdout } = runPrint(["--agent", "claude"]);
    expect(stdout).not.toContain("npx");
    expect(stdout.match(/\.\/node_modules\/\.bin\/jevy hook /g)).toHaveLength(
      3,
    );
  });

  it("gives each hook more time than the hook gives itself", () => {
    // Claude Code cancels a hook at its timeout and then goes ahead, so
    // the hook's own deadline has to pass first.
    const { hooks } = claudeSettings();
    expect(hooks.Stop[0].hooks[0].timeout).toBeGreaterThan(
      DEFAULT_STOP_DEADLINE_SECONDS + 60,
    );
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThan(
      DEFAULT_PRE_EDIT_DEADLINE_SECONDS,
    );
    expect(hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThan(
      DEFAULT_SESSION_START_DEADLINE_SECONDS,
    );
  });

  describe.runIf(process.platform !== "win32")(
    "the printed commands, run by a real shell",
    () => {
      const base = realpathSync(
        mkdtempSync(join(tmpdir(), "jevy-hook-print-")),
      );
      const project = join(base, "project");
      const empty = join(base, "empty");
      afterAll(() => {
        rmSync(base, { recursive: true, force: true });
      });

      const { hooks } = claudeSettings();
      const STOP = hooks.Stop[0].hooks[0].command;
      const PRE_EDIT = hooks.PreToolUse[0].hooks[0].command;
      const SESSION_START = hooks.SessionStart[0].hooks[0].command;

      /** A stand-in for the installed binary: says where it ran, exits as told. */
      function install(exitCode: number): void {
        mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
        mkdirSync(empty, { recursive: true });
        const bin = join(project, "node_modules", ".bin", "jevy");
        writeFileSync(
          bin,
          `#!/bin/sh\necho "ran $* in $(pwd)"\nexit ${String(exitCode)}\n`,
        );
        chmodSync(bin, 0o755);
      }

      /** Run as Claude Code does (`sh -c`), from a directory that is not the project. */
      function sh(
        shell: string,
        command: string,
        projectDir: string | undefined,
      ): { status: number | null; stdout: string } {
        const env = { ...process.env };
        delete env["CLAUDE_PROJECT_DIR"];
        if (projectDir !== undefined) {
          env["CLAUDE_PROJECT_DIR"] = projectDir;
        }
        const result = spawnSync(shell, ["-c", command], {
          cwd: base,
          env,
          encoding: "utf8",
        });
        return { status: result.status, stdout: result.stdout };
      }

      const shells = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh"].filter(
        (shell) => existsSync(shell),
      );

      it.each(shells)(
        "%s: run the project's own binary in the project directory",
        (shell) => {
          install(0);
          for (const [command, name] of [
            [STOP, "stop"],
            [PRE_EDIT, "pre-edit"],
            [SESSION_START, "session-start"],
          ] as const) {
            expect(sh(shell, command, project)).toEqual({
              status: 0,
              stdout: `ran hook ${name} in ${project}\n`,
            });
          }
        },
      );

      it.each(shells)(
        "%s: block with exit 2 when CLAUDE_PROJECT_DIR is unset or empty, and run nothing",
        (shell) => {
          install(0);
          // `cd ""` succeeds and stays put: the hook would run in whatever
          // directory the session happens to be in.
          writeFileSync(join(base, "ran-here"), "");
          for (const command of [STOP, PRE_EDIT]) {
            for (const projectDir of [undefined, ""]) {
              expect(sh(shell, command, projectDir)).toEqual({
                status: 2,
                stdout: "",
              });
            }
          }
        },
      );

      it.each(shells)(
        "%s: block with exit 2 when the directory or the binary is missing",
        (shell) => {
          install(0);
          for (const command of [STOP, PRE_EDIT]) {
            expect(sh(shell, command, join(base, "missing")).status).toBe(2);
            // Nothing is installed here, and nothing is fetched to make up for it.
            expect(sh(shell, command, empty)).toEqual({
              status: 2,
              stdout: "",
            });
          }
        },
      );

      it.each(shells)(
        "%s: turn any failure of the binary into exit 2, and keep its exit 2",
        (shell) => {
          for (const code of [1, 2, 127]) {
            install(code);
            expect(sh(shell, STOP, project).status).toBe(2);
            expect(sh(shell, PRE_EDIT, project).status).toBe(2);
          }
        },
      );

      it.each(shells)(
        "%s: never exit 2 from session-start for a missing directory, and never 0 either",
        (shell) => {
          install(0);
          for (const projectDir of [
            undefined,
            "",
            join(base, "missing"),
            empty,
          ]) {
            const { status, stdout } = sh(shell, SESSION_START, projectDir);
            // A failure the person can see in the debug log; nothing printed
            // for the model to read.
            expect(status).not.toBe(0);
            expect(stdout).toBe("");
          }
        },
      );
    },
  );

  it("accepts --agent=claude", () => {
    expect(runPrint(["--agent=claude"])).toEqual(
      runPrint(["--agent", "claude"]),
    );
  });

  it.each([
    [[], "--agent is required"],
    [["--agent"], "--agent needs a value"],
    [
      ["--agent", "cursor"],
      "unsupported agent 'cursor'; supported agents: claude",
    ],
    [["--agent", "claude", "--nope"], "unknown option '--nope'"],
    [["--agent", "claude", "extra"], "unexpected argument 'extra'"],
    [["--agent", "claude", "--agent", "claude"], "--agent given twice"],
  ])("exits 2 for %j", (argv, message) => {
    const result = runPrint(argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`jevy hook print: ${message}\n`);
    expect(result.stderr).toContain("Usage: jevy hook print --agent claude");
  });

  it("prints usage for --help", () => {
    const result = runPrint(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: jevy hook print --agent claude");
    expect(result.stderr).toBe("");
  });
});
