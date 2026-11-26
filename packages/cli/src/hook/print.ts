import type { CliResult } from "../cli.js";
import { UsageError } from "../guard/errors.js";
import { parseFlags } from "./args.js";
import { messageOf } from "./text.js";

/** `jevy hook print`: the settings that wire the hooks into a coding agent. */

export const PRINT_USAGE = `Usage: jevy hook print --agent claude

Prints the settings that wire \`jevy hook session-start\`, \`jevy hook stop\`
and \`jevy hook pre-edit\` into a coding agent, as JSON on stdout. Merge it
into the agent's settings file (for Claude Code: .claude/settings.json).
Nothing is written for you. The commands run ./node_modules/.bin/jevy in the
project directory, so @jevyjs/cli has to be installed there.

  --agent <name>  The coding agent. Supported: claude. Required.

Exit codes: 0 printed, 2 usage error.
`;

const AGENTS = ["claude"] as const;

/** Tools that write a file in Claude Code; the pre-edit hook runs before each. */
const EDIT_TOOLS = "Edit|Write|MultiEdit|NotebookEdit";

type HookName = "session-start" | "stop" | "pre-edit";

/**
 * The command Claude Code runs for one hook. It hands the string to
 * `sh -c`.
 *
 * `(: "\${CLAUDE_PROJECT_DIR:?}")`: fails, with the shell's own "parameter
 * null or not set" on stderr, when the variable is unset or empty. Without
 * it `cd ""` succeeds and the hook runs in whatever directory the session
 * is in. The test sits in a subshell because `:?` ends the shell it fails
 * in, with 127 from sh and bash and 1 from zsh, before `|| exit 2` is
 * reached; ending only the subshell lets the rest of the line turn the
 * failure into exit 2.
 *
 * `cd "$CLAUDE_PROJECT_DIR"`: a hook starts in the session's current
 * directory, which the agent may have changed; the config and
 * `node_modules/.bin` are at the project root.
 *
 * `./node_modules/.bin/jevy`: the project's own install and nothing else.
 * `npx --no-install jevy` still asked the npm registry about a package
 * named `jevy` when none was installed, which sends the name to a server
 * and waits on the network; a path either runs the installed binary or
 * fails at once.
 *
 * `|| exit 2`, for the hooks that block: Claude Code blocks on exit code 2
 * only; any other failure is a notice and the action goes ahead. `jevy hook`
 * itself exits 0 or 2, so this is for the case where it never starts (no
 * install, a bad directory, no variable): the hook then blocks loudly and
 * does not silently protect nothing. `&&` and `||` have the same precedence
 * in the shell, so a failure anywhere before it is caught too.
 * `session-start` has nothing to block and goes without: a failure to start
 * is then a notice, which is all it should be.
 */
function hookCommand(hook: HookName): string {
  const run = `(: "\${CLAUDE_PROJECT_DIR:?}") && cd "$CLAUDE_PROJECT_DIR" && ./node_modules/.bin/jevy hook ${hook}`;
  return hook === "session-start" ? run : `${run} || exit 2`;
}

interface HookCommand {
  readonly type: "command";
  readonly command: string;
  /** Seconds before Claude Code cancels the hook and goes ahead. */
  readonly timeout: number;
  readonly onFailure?: "block";
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly [HookCommand];
}

export interface ClaudeSettings {
  readonly hooks: {
    readonly SessionStart: readonly [HookGroup];
    readonly Stop: readonly [HookGroup];
    readonly PreToolUse: readonly [HookGroup];
  };
}

/**
 * The Claude Code settings for the three hooks.
 *
 * Timeouts are in seconds, and each is above the deadline the hook gives
 * itself (`--deadline`): Claude Code cancels a hook at its timeout and then
 * goes ahead, so the hook must have answered by then. The stop hook runs
 * the project's whole check suite and gets half an hour, against its own
 * 1500 seconds. The other two read a file or ask git one question and get
 * 30 seconds, against their own 20.
 *
 * `SessionStart` has no matcher: it must run however the session starts
 * (startup, resume, clear, compact, fork), and the hook itself keeps the
 * first record.
 *
 * `onFailure: "block"` on the pre-edit hook makes Claude Code refuse the
 * edit when the hook fails in a way `|| exit 2` cannot catch: it could not
 * be started, or it ran past its timeout. Claude Code reads the field from
 * version 2.1.295 on. It is left off the stop hook because the Claude Code
 * documentation says it has no effect on `Stop`; there the hook's own
 * deadline is what keeps a hang from letting the agent stop.
 */
export function claudeSettings(): ClaudeSettings {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: hookCommand("session-start"),
              timeout: 30,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: hookCommand("stop"), timeout: 1800 },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: EDIT_TOOLS,
          hooks: [
            {
              type: "command",
              command: hookCommand("pre-edit"),
              timeout: 30,
              onFailure: "block",
            },
          ],
        },
      ],
    },
  };
}

function parseAgent(argv: readonly string[]): (typeof AGENTS)[number] | "help" {
  const flags = parseFlags(argv, new Set(["--agent"]));
  if (flags === "help") {
    return "help";
  }
  const agent = flags.get("--agent");
  if (agent === undefined) {
    throw new UsageError("--agent is required");
  }
  const known = AGENTS.find((name) => name === agent);
  if (known === undefined) {
    throw new UsageError(
      `unsupported agent '${agent}'; supported agents: ${AGENTS.join(", ")}`,
    );
  }
  return known;
}

/**
 * Run `jevy hook print`. Stdout is the JSON and nothing else, so it can be
 * piped into a file or a merge tool. Never throws.
 */
export function runPrint(argv: readonly string[]): CliResult {
  try {
    if (parseAgent(argv) === "help") {
      return { code: 0, stdout: PRINT_USAGE, stderr: "" };
    }
    return {
      code: 0,
      stdout: `${JSON.stringify(claudeSettings(), null, 2)}\n`,
      stderr: "",
    };
  } catch (error) {
    return {
      code: 2,
      stdout: "",
      stderr: `jevy hook print: ${messageOf(error)}\n\n${PRINT_USAGE}`,
    };
  }
}
