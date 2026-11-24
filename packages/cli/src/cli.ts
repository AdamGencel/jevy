import { runGuard, type GuardDeps } from "./guard/command.js";
import { hookCrash, runHook } from "./hook/command.js";
import { defaultHookDeps, type HookDeps } from "./hook/deps.js";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Replaces git and the file system for `guard`; tests use it. */
  readonly guard?: GuardDeps;
  /**
   * Replaces parts of what `hook` uses: stdin, the file system, the check
   * runner, the guard, git. What is left out is the real thing, except stdin,
   * which is empty unless given: the executable passes the process's stdin,
   * and a library caller is never made to wait on it.
   */
  readonly hook?: Partial<HookDeps>;
}

function help(version: string): string {
  return `jevy ${version}

Usage: jevy <command> [options]

Commands:
  guard   Report tests, config and cached decisions weakened since a base ref.
          Run \`jevy guard --help\` for its options.
  hook    Hooks for a coding agent: block it from finishing while the checks
          or the guard fail, and from editing a protected path.
          Run \`jevy hook --help\` for its subcommands.

Other Jevy commands are not implemented yet.
`;
}

/**
 * Handle `jevy` arguments. `guard` and `hook` are the product commands so
 * far; anything else other than help or version is an unknown command.
 *
 * `hook` never rejects and never answers exit code 1, whatever goes wrong.
 * The other commands are as they were: an error nobody planned for rejects.
 */
export async function run(
  argv: readonly string[],
  version: string,
  options: RunOptions = {},
): Promise<CliResult> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    return { code: 0, stdout: help(version), stderr: "" };
  }

  if (command === "--version" || command === "-v") {
    return { code: 0, stdout: `${version}\n`, stderr: "" };
  }

  if (command === "guard") {
    return options.guard === undefined
      ? runGuard(argv.slice(1))
      : runGuard(argv.slice(1), options.guard);
  }

  if (command === "hook") {
    const hookArgv = argv.slice(1);
    try {
      // `defaultHookDeps` asks for the working directory, which throws when
      // that directory has been deleted. Left to propagate, it would end the
      // process with exit code 1, and Claude Code would carry on unchecked.
      return await runHook(hookArgv, {
        ...defaultHookDeps(),
        ...options.hook,
      });
    } catch (error) {
      return hookCrash(hookArgv, error);
    }
  }

  return {
    code: 1,
    stdout: "",
    stderr: `jevy: unknown command '${command}'\n`,
  };
}
