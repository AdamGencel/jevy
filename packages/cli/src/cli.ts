import { runGuard, type GuardDeps } from "./guard/command.js";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Replaces git and the file system for `guard`; tests use it. */
  readonly guard?: GuardDeps;
}

function help(version: string): string {
  return `jevy ${version}

Usage: jevy <command> [options]

Commands:
  guard   Report tests, config and cached decisions weakened since a base ref.
          Run \`jevy guard --help\` for its options.

Other Jevy commands are not implemented yet.
`;
}

/**
 * Handle `jevy` arguments. `guard` is the only product command so far;
 * anything else other than help or version is an unknown command.
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

  return {
    code: 1,
    stdout: "",
    stderr: `jevy: unknown command '${command}'\n`,
  };
}
