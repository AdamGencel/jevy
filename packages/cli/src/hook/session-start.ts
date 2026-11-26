import { resolve } from "node:path";
import type { CliResult } from "../cli.js";
import { parseFlags, secondsFlag } from "./args.js";
import { within } from "./deadline.js";
import type { HookDeps } from "./deps.js";
import { parseHookInput } from "./input.js";
import { recordStart, startPath } from "./state.js";
import { messageOf, printable } from "./text.js";

/**
 * `jevy hook session-start`: runs when a coding agent's session starts and
 * records the commit `HEAD` points at.
 *
 * The stop hook compares the branch with the default branch. On the default
 * branch itself, or when the ref it compares with has been moved to `HEAD`,
 * that comparison sees uncommitted changes only: an agent that commits a
 * weakened test has hidden it. The commit recorded here cannot be moved by
 * anything the agent does to the repository, so the stop hook also compares
 * the working tree with it.
 *
 * It has nothing to block, so it exits 0 whatever happens, and it prints
 * nothing on stdout: Claude Code adds a SessionStart hook's stdout to the
 * model's context.
 */

/** Below the `timeout` of the SessionStart entry `jevy hook print` writes. */
export const DEFAULT_SESSION_START_DEADLINE_SECONDS = 20;

export const SESSION_START_USAGE = `Usage: jevy hook session-start [--cwd <dir>] [--deadline <seconds>]

A hook that runs when a coding agent's session starts. Reads the agent's hook
input (JSON with session_id) on stdin and records the commit HEAD points at,
so that \`jevy hook stop\` can check what the session itself committed. The
record is kept outside the repository, one per session and repository, and a
later start of the same session (a resume, a compaction) never replaces it. Nothing is
recorded on a branch with no commit yet or outside a git repository.

  --cwd <dir>           The project directory. Default: the current directory.
  --deadline <seconds>  Time limit for the hook. Default: ${String(DEFAULT_SESSION_START_DEADLINE_SECONDS)}.

Prints nothing on stdout. Exit codes: 0 always, whether or not a record was
written; 2 for a usage error only.
`;

interface SessionStartOptions {
  readonly cwd: string | undefined;
  readonly deadlineSeconds: number;
}

function parseArgs(argv: readonly string[]): SessionStartOptions | "help" {
  const flags = parseFlags(argv, new Set(["--cwd", "--deadline"]));
  if (flags === "help") {
    return "help";
  }
  return {
    cwd: flags.get("--cwd"),
    deadlineSeconds: secondsFlag(
      flags,
      "--deadline",
      DEFAULT_SESSION_START_DEADLINE_SECONDS,
    ),
  };
}

/**
 * Record `HEAD` for the session the input names, under the repository's
 * top level, so that the stop hook finds it from any directory of the
 * repository. No session id, no repository or no commit to name records
 * nothing: the stop hook then compares as it does when this hook is not
 * wired at all.
 */
async function record(projectDir: string, deps: HookDeps): Promise<void> {
  const input = parseHookInput(await deps.readStdin());
  const sessionId = input?.sessionId ?? null;
  if (sessionId === null) {
    return;
  }
  const head = await deps.git.head(projectDir);
  if (head === null) {
    return;
  }
  const top = await deps.git.topLevel(projectDir);
  if (top === null) {
    return;
  }
  await recordStart(
    deps.state,
    startPath(deps.state.dir, top, sessionId),
    head,
  );
}

/** Exit 0, with the reason where a person debugging the hook can find it. */
function notRecorded(why: string): CliResult {
  return {
    code: 0,
    stdout: "",
    stderr: `jevy hook session-start: the start of the session was not recorded: ${printable(why)}\n`,
  };
}

/**
 * Run `jevy hook session-start`. Never throws. Exits 0 on every path but a
 * usage error, which exits 2 like the other hooks: Claude Code shows the
 * person a SessionStart hook's exit 2 as a hook error and starts the session
 * all the same, so a mistyped option is seen and nothing is blocked.
 */
export async function runSessionStart(
  argv: readonly string[],
  deps: HookDeps,
): Promise<CliResult> {
  let options: SessionStartOptions | "help";
  try {
    options = parseArgs(argv);
  } catch (error) {
    return {
      code: 2,
      stdout: "",
      stderr: `jevy hook session-start: ${messageOf(error)}\n\n${SESSION_START_USAGE}`,
    };
  }
  if (options === "help") {
    return { code: 0, stdout: SESSION_START_USAGE, stderr: "" };
  }
  const { cwd, deadlineSeconds } = options;
  try {
    const projectDir = resolve(deps.cwd, cwd ?? ".");
    const raced = await within(deadlineSeconds * 1000, () =>
      record(projectDir, deps),
    );
    return raced.inTime
      ? { code: 0, stdout: "", stderr: "" }
      : notRecorded(`the hook ran out of time (${String(deadlineSeconds)} s)`);
  } catch (error) {
    return notRecorded(messageOf(error));
  }
}
