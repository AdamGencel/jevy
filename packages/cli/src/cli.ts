export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Handle `jevy` arguments. Product commands are intentionally absent at this
 * milestone: anything other than help or version is an unknown command.
 */
export function run(argv: readonly string[], version: string): CliResult {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    return {
      code: 0,
      stdout: `jevy ${version}\n\nJevy commands are not implemented yet.\n`,
      stderr: "",
    };
  }

  if (command === "--version" || command === "-v") {
    return { code: 0, stdout: `${version}\n`, stderr: "" };
  }

  return {
    code: 1,
    stdout: "",
    stderr: `jevy: unknown command '${command}'\n`,
  };
}
