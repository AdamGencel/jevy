import type { CliResult } from "../cli.js";
import { defaultHookDeps, type HookDeps } from "./deps.js";
import { runPreEdit } from "./pre-edit.js";
import { runPrint } from "./print.js";
import { runSessionStart } from "./session-start.js";
import { runStop } from "./stop.js";
import { messageOf } from "./text.js";

/** Routing and exit codes for `jevy hook`. */

export type { HookDeps } from "./deps.js";

export const HOOK_USAGE = `Usage: jevy hook <stop|pre-edit|session-start|print> [options]

Hooks that put the guard inside a coding agent's loop. Claude Code is
supported. The agent runs \`stop\`, \`pre-edit\` and \`session-start\` itself,
with its hook input as JSON on stdin; \`print\` gives the settings that make
it do so.

  stop           Before the agent finishes: run the project's checks and
                 \`jevy guard\`, and block the agent while any of them fails.
  pre-edit       Before the agent edits a file: block the edit when the file
                 is a protected path.
  session-start  When the agent's session starts: record the commit it starts
                 from, so that \`stop\` also checks what the session commits.
  print          Print the agent settings that wire the hooks up.

Run \`jevy hook <name> --help\` for the options of each.

Exit codes: 0 allowed, 2 blocked or a usage error. Never 1: Claude Code
blocks on exit code 2 only, and treats any other failure as a notice.
`;

const NAMES = "stop, pre-edit, session-start or print";

function usageError(message: string): CliResult {
  return {
    code: 2,
    stdout: "",
    stderr: `jevy hook: ${message}\n\n${HOOK_USAGE}`,
  };
}

/**
 * The result when `jevy hook` threw somewhere no subcommand caught it:
 * before the hook started (the working directory is gone, so nothing can be
 * resolved against it) or by an accident nobody planned for. `argv` is what
 * follows `hook`.
 *
 * Exit 2, never 1: to Claude Code exit 1 means "carry on", so a crash would
 * switch the hook off. `session-start` is the exception and exits 0: it has
 * nothing to block, and its exit 2 would only show the person an error.
 */
export function hookCrash(argv: readonly string[], error: unknown): CliResult {
  return {
    code: argv[0] === "session-start" ? 0 : 2,
    stdout: "",
    stderr: `jevy hook: ${messageOf(error)}\n`,
  };
}

/**
 * Run `jevy hook`. Never throws, and exits 0 or 2 only. The subcommands
 * catch their own errors; the catch here is the last line of that promise,
 * because an exception that reached \`bin.ts\` would end the process with
 * exit code 1.
 */
export async function runHook(
  argv: readonly string[],
  deps: HookDeps = defaultHookDeps(),
): Promise<CliResult> {
  const [name, ...rest] = argv;
  try {
    switch (name) {
      case undefined:
        return usageError(`expected ${NAMES}`);
      case "--help":
      case "-h":
        return { code: 0, stdout: HOOK_USAGE, stderr: "" };
      case "stop":
        return await runStop(rest, deps);
      case "pre-edit":
        return await runPreEdit(rest, deps);
      case "session-start":
        return await runSessionStart(rest, deps);
      case "print":
        return runPrint(rest);
      default:
        return usageError(`unknown hook '${name}'; expected ${NAMES}`);
    }
  } catch (error) {
    return hookCrash(argv, error);
  }
}
