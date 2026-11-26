#!/usr/bin/env node
import { run, type CliResult } from "./cli.js";
import { hookCrash } from "./hook/command.js";
import { readStdin } from "./hook/input.js";
import { readPackageVersion } from "./version.js";

const argv = process.argv.slice(2);
/**
 * A hook has rules of its own here. To Claude Code any exit code but 2, a
 * crash included, means "carry on", and a hook it has to cancel means the
 * same; so `jevy hook` must never end with exit code 1, and must end as soon
 * as it has answered.
 */
const isHook = argv[0] === "hook";

/** Write the answer and, for a hook, leave. */
function finish(result: CliResult): void {
  process.exitCode = result.code;
  if (!isHook) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    // The code is set, and `process.exit` is not called, so output piped to
    // another process (a large --json report in CI) is flushed before Node
    // exits.
    return;
  }
  // A hook that ran out of time has answered while a read or a child it
  // gave up on is still pending, and Node would wait for that. So the hook
  // exits itself, once both streams have taken what was written.
  process.stdout.write(result.stdout, () => {
    process.stderr.write(result.stderr, () => {
      process.exit(result.code);
    });
  });
}

if (isHook) {
  // The last line of "never exit 1": an error thrown outside any promise
  // the hook is waiting on (in work it gave up on, say) would otherwise end
  // the process with Node's own exit code 1.
  const crash = (error: unknown): void => {
    finish(hookCrash(argv.slice(1), error));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
}

try {
  const version = readPackageVersion(
    new URL("../package.json", import.meta.url),
  );
  finish(
    await run(argv, version, {
      // A coding agent hands a hook its input on stdin. This is only called
      // by the hooks that read it, so no other command touches stdin, and a
      // terminal is read as "no input" instead of being waited on.
      hook: { readStdin: () => readStdin(process.stdin) },
    }),
  );
} catch (error) {
  if (!isHook) {
    // As before: Node reports the error and exits with code 1.
    throw error;
  }
  finish(hookCrash(argv.slice(1), error));
}
