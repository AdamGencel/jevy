import { UsageError } from "../guard/errors.js";
import { parseSeconds } from "./deadline.js";

/**
 * Flag parsing shared by the `jevy hook` subcommands. Every flag they take
 * has a value, written `--flag value` or `--flag=value`.
 */

/**
 * The values of the flags in `argv`, or "help". Throws `UsageError` for a
 * flag that is not in `valueFlags`, a stray argument, a missing value or a
 * flag given twice: a hook that guessed at a mistyped option would run with
 * settings nobody chose.
 */
export function parseFlags(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
): ReadonlyMap<string, string> | "help" {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (!valueFlags.has(flag)) {
      throw new UsageError(
        arg.startsWith("-")
          ? `unknown option '${arg}'`
          : `unexpected argument '${arg}'`,
      );
    }
    let value: string | undefined;
    if (flag !== arg) {
      value = arg.slice(eq + 1);
    } else {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") {
      throw new UsageError(`${flag} needs a value`);
    }
    if (values.has(flag)) {
      throw new UsageError(`${flag} given twice`);
    }
    values.set(flag, value);
  }
  return values;
}

/**
 * The value of a flag that takes a number of seconds, or `fallback` when
 * the flag was not given. Fractions are allowed. Throws `UsageError` for
 * anything that is not above 0, or too large for a timer.
 */
export function secondsFlag(
  flags: ReadonlyMap<string, string>,
  flag: string,
  fallback: number,
): number {
  const value = flags.get(flag);
  if (value === undefined) {
    return fallback;
  }
  const seconds = parseSeconds(value);
  if (seconds === null) {
    throw new UsageError(
      `${flag} must be a number of seconds above 0: ${value}`,
    );
  }
  return seconds;
}
