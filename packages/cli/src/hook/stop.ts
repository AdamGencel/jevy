import { join, resolve } from "node:path";
import type { CliResult } from "../cli.js";
import {
  CONFIG_FILENAMES,
  findConfig,
  readConfigSettings,
  type ConfigSettings,
} from "../guard/config-source.js";
import { GuardError, UsageError } from "../guard/errors.js";
import { parseFlags, secondsFlag } from "./args.js";
import { configElsewhere, elsewhereText } from "./config.js";
import { within } from "./deadline.js";
import type { HookDeps } from "./deps.js";
import { parseHookInput, type HookInput } from "./input.js";
import type { CommandResult } from "./shell.js";
import {
  CHAIN_LIMIT,
  clearState,
  decide,
  loadStart,
  loadState,
  SAME_FAILURE_LIMIT,
  saveState,
  signatureOf,
  startPath,
  statePath,
} from "./state.js";
import { clip, indent, messageOf, printable, tail } from "./text.js";

/**
 * `jevy hook stop`: what a coding agent runs before it may say it is done.
 *
 * It runs the project's own checks and `jevy guard`. When anything fails it
 * exits 2, which Claude Code reads as "do not stop; here is why" and hands
 * stderr to the agent. It never exits 1, and it always answers within its
 * deadline: Claude Code treats any other exit code, and a hook it had to
 * cancel, as a hook error and lets the agent stop, so an accident here would
 * switch the hook off without anyone noticing.
 */

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * The time the whole hook may take. Claude Code cancels a hook at its
 * `timeout` and then lets the agent stop, so the hook has to block before
 * that: this must stay below the 1800 seconds `jevy hook print` gives the
 * stop hook, with room to spare for the hook to start and to write its
 * answer.
 */
export const DEFAULT_STOP_DEADLINE_SECONDS = 1500;

export const STOP_USAGE = `Usage: jevy hook stop [--base <ref>] [--timeout <seconds>] [--deadline <seconds>]
                      [--cwd <dir>]

A stop hook for a coding agent. Runs the commands listed under \`checks\` in
jevy.config.*, then \`jevy guard\`, and blocks the agent from finishing while
any of them fails. Reads the agent's hook input (JSON) on stdin; with none,
it runs the same checks once.

The guard compares the working tree with the main branch (--merge-base) and,
when \`jevy hook session-start\` recorded where the session began, with that
commit too, so that a change the agent has committed is still checked. A
jevy.config.* that differs from that commit (from HEAD when none was
recorded) blocks as well: a person must approve a change to the config.

  --base <ref>          Ref the branch is compared with. Default: ci.mainBranch
                        in the config; else the branch origin/HEAD points at;
                        else main; else master. origin/<branch> is used when
                        it exists, else <branch>.
  --timeout <seconds>   Time limit for each check command. Default: ${String(DEFAULT_TIMEOUT_SECONDS)}.
  --deadline <seconds>  Time limit for the whole hook. When it passes, what is
                        running is killed and the agent is blocked. Default:
                        ${String(DEFAULT_STOP_DEADLINE_SECONDS)}. Keep it below the timeout the agent gives the hook.
  --cwd <dir>           The project directory: the one with jevy.config.*.
                        Default: the current directory.

After two blocks in a row for the same failure, or six blocks in one turn,
the agent is allowed to stop and the person is told that the checks fail.

Exit codes: 0 the agent may stop, 2 blocked (the reason is on stderr) or a
usage error. Never 1.
`;

/** Tried in this order when neither the config nor origin/HEAD names a branch. */
const FALLBACK_BRANCHES = ["main", "master"] as const;

/** Findings listed in a reason; the rest are counted. */
const MAX_FINDINGS = 20;
/** Fewer findings than this are never listed while there is any room at all. */
const MIN_FINDINGS = 3;

/*
 * Widths, in characters. A file name, a test title and a command come from
 * the repository and can be thousands of characters long. One such line
 * would push every other line out of a message that has a size limit, so
 * each part is cut to a width that still tells a person which one it is.
 */
const MAX_FILE = 200;
const MAX_KIND = 60;
const MAX_TITLE = 120;
/** A guard message is one line of the reason, not a paragraph. */
const MAX_MESSAGE = 300;
const MAX_COMMAND = 200;
const MAX_HEADLINE = 700;
/** One line of the message to the person. */
const MAX_BRIEF = 240;
const BRIEF_FILE = 120;
const BRIEF_TITLE = 60;
const BRIEF_COMMAND = 160;

/**
 * Claude Code cuts `systemMessage` at 10,000 characters. Staying under it
 * keeps the cut ours, with a count of what was left out.
 */
const MAX_SYSTEM_MESSAGE = 9000;
/**
 * The reason on stderr goes into the agent's context every time the hook
 * blocks. The same bound keeps it readable there.
 */
const MAX_REASON = 9000;
/** The end of a check's output shown to the agent, when there is room. */
const OUTPUT_TAIL = { lines: 40, chars: 4000 } as const;
/** Less output than this says nothing; the room goes to something else. */
const MIN_OUTPUT = 120;
const OUTPUT_LEFT_OUT = "  (output left out to keep this short)";
/**
 * The part of the room for bodies that the few failures that are not checks
 * may take before the checks' output gets any.
 */
const LIST_SHARE = 0.6;

/**
 * How long the hook waits for its own state files once it knows the answer.
 * They are small files in the temp directory; if they hang, the hook blocks
 * without counting.
 */
const SETTLE_LIMIT_MS = 10_000;

const CLOSING =
  "Fix the cause. Do not weaken, skip or delete a test, and do not edit a protected path, to get past this check.";

interface StopOptions {
  readonly base: string | undefined;
  readonly timeoutSeconds: number;
  readonly deadlineSeconds: number;
  readonly cwd: string | undefined;
}

/** Parse `jevy hook stop` arguments, or return "help". Throws `UsageError`. */
export function parseStopArgs(argv: readonly string[]): StopOptions | "help" {
  const flags = parseFlags(
    argv,
    new Set(["--base", "--timeout", "--deadline", "--cwd"]),
  );
  if (flags === "help") {
    return "help";
  }
  const base = flags.get("--base");
  if (base?.startsWith("-") === true) {
    throw new UsageError(`--base must not start with '-': ${base}`);
  }
  return {
    base,
    timeoutSeconds: secondsFlag(flags, "--timeout", DEFAULT_TIMEOUT_SECONDS),
    deadlineSeconds: secondsFlag(
      flags,
      "--deadline",
      DEFAULT_STOP_DEADLINE_SECONDS,
    ),
    cwd: flags.get("--cwd"),
  };
}

/** One thing that stands between the agent and "done". */
interface Failure {
  /**
   * What failed, without the output: the same failure has the same keys on
   * the next attempt, which is how the hook knows the agent is stuck.
   */
  readonly keys: readonly string[];
  /** For the agent: what failed, in a line or a short paragraph. */
  readonly headline: string;
  /**
   * For the agent: the output or the list that says why, written to fit in
   * `room` characters. Null when the headline says it all.
   */
  readonly body: ((room: number) => string) | null;
  /** For the person: one line per thing that failed. */
  readonly brief: readonly string[];
  /**
   * True for a failed check. A project can list any number of checks, so
   * when room is short the other failures, which are few, are shown first.
   */
  readonly bulk?: true;
}

function plain(
  key: string,
  headline: string,
  brief: string = headline,
): Failure {
  return { keys: [key], headline, body: null, brief: [brief] };
}

/**
 * A failure for something thrown. A `GuardError` is a message written for
 * the reader and is shown as it is; anything else is an accident in the
 * hook, and says so.
 */
function thrownFailure(error: unknown): Failure {
  const message = printable(messageOf(error));
  return error instanceof GuardError
    ? plain(`error:${message}`, message)
    : plain(
        `error:${message}`,
        `The hook itself failed: ${message}`,
        `the hook itself failed: ${message}`,
      );
}

interface Config {
  /** The config's file name, for messages. */
  readonly path: string;
  readonly settings: ConfigSettings;
}

async function readConfig(
  projectDir: string,
  deps: HookDeps,
): Promise<Config | null> {
  const found = await findConfig(
    (path) => deps.readFile(join(projectDir, path)),
    "",
  );
  return found === null
    ? null
    : {
        path: found.path,
        settings: readConfigSettings(found.text, found.path),
      };
}

/** True when `key` is written in the config but cannot be read as a literal. */
function unreadable(config: Config, key: string): boolean {
  const lost = config.settings.unreadable;
  return lost.includes("*") || lost.includes(key);
}

/** The commit a session is compared with, as far as the hook knows it. */
type Baseline =
  /** Nothing was recorded: the hook compares as it did before it kept a record. */
  | { readonly kind: "none" }
  | { readonly kind: "commit"; readonly commit: string }
  /** A record exists and cannot be used, which is a failure in itself. */
  | { readonly kind: "lost"; readonly failure: Failure };

/** What the hook reads of one guard finding. */
interface GuardFinding {
  readonly kind: string;
  readonly file: string;
  readonly test: string | null;
  readonly line: number | null;
  readonly message: string;
}

/** A finding and the comparisons that reported it. */
interface Reported {
  readonly finding: GuardFinding;
  readonly since: Set<string>;
}

/**
 * What the hook has learnt so far. The stages write what they find here as
 * they find it, and nothing is handed back at the end: when the deadline
 * passes the work is abandoned mid-way, and this is all there is to report.
 */
interface Progress {
  input: HookInput | null;
  /** What the hook is doing now, as the rest of "while it was ...". */
  doing: string;
  readonly failures: Failure[];
  /** Check commands that have not finished: the one running, then the rest. */
  unfinished: readonly string[];
  /** True once every guard comparison has answered. */
  guardDone: boolean;
  /**
   * The guard's weakening findings so far, by finding. They become one
   * failure when the last comparison has answered, or when time runs out.
   */
  readonly reported: Map<string, Reported>;
}

/** Everything one run of the hook works with. */
interface Run {
  readonly projectDir: string;
  readonly options: StopOptions;
  readonly deps: HookDeps;
  /** Aborts when the deadline passes; nothing new is started after that. */
  readonly signal: AbortSignal;
  readonly progress: Progress;
  readonly config: Config | null;
  readonly baseline: Baseline;
}

/**
 * Whether the deadline has passed. Asked again after every wait, through a
 * function: the answer changes while the hook waits, which a property read
 * twice in a row does not tell the type checker.
 */
function timeIsUp(run: Run): boolean {
  return run.signal.aborted;
}

function shortHash(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Where this session started, from the record `jevy hook session-start`
 * left. A record that cannot be read, or that names a commit the repository
 * no longer has, is a failure: reading either as "no record" would let an
 * agent hide its commits by damaging the file or rewriting history.
 */
async function sessionBaseline(
  projectDir: string,
  sessionId: string | null,
  deps: HookDeps,
): Promise<Baseline> {
  if (sessionId === null) {
    return { kind: "none" };
  }
  const record = await loadStart(
    deps.state,
    startPath(deps.state.dir, projectDir, sessionId),
  );
  if (record.kind === "none") {
    return record;
  }
  if (record.kind === "unusable") {
    return {
      kind: "lost",
      failure: plain(
        "session-start:unusable",
        `The hook cannot read its record of where this session started (${printable(record.why)}), so it cannot check what the session committed. A person has to look at what changed.`,
        `the hook's record of where the session started cannot be read (${printable(record.why)}), so what the session committed was not checked`,
      ),
    };
  }
  if (!(await deps.refExists(record.commit, projectDir))) {
    const hash = shortHash(record.commit);
    return {
      kind: "lost",
      failure: plain(
        "session-start:missing",
        `The commit this session started from (${hash}) no longer exists in the repository, so jevy guard cannot check what the session committed. History was rewritten or the repository was replaced: a person has to look at what changed.`,
        `the commit the session started from (${hash}) no longer exists, so what the session committed was not checked`,
      ),
    };
  }
  return record;
}

function checkStatus(result: CommandResult, timeoutSeconds: number): string {
  if (result.timedOut) {
    return `timed out after ${String(timeoutSeconds)} s`;
  }
  return result.code === null ? "no exit code" : `exit ${String(result.code)}`;
}

/** The end of a check's output, in as much room as there is. */
function outputBody(output: string): (room: number) => string {
  return (room) => {
    // The indent and the cut marker come on top of the output itself.
    const chars = Math.min(OUTPUT_TAIL.chars, room - 110);
    if (chars < MIN_OUTPUT) {
      return room < OUTPUT_LEFT_OUT.length ? "" : OUTPUT_LEFT_OUT;
    }
    const shown = tail(output, { lines: OUTPUT_TAIL.lines, chars });
    return indent(shown === "" ? "(no output)" : shown);
  };
}

function checkFailure(
  command: string,
  status: string,
  output: string,
): Failure {
  return {
    keys: [`check:${command}`],
    headline: `Check failed (${status}): ${printable(clip(command, MAX_COMMAND))}`,
    body: outputBody(output),
    brief: [`check: ${printable(clip(command, BRIEF_COMMAND))} (${status})`],
    bulk: true,
  };
}

async function runCheck(command: string, run: Run): Promise<Failure | null> {
  const { timeoutSeconds } = run.options;
  let result: CommandResult;
  try {
    result = await run.deps.runCommand(command, {
      cwd: run.projectDir,
      timeoutMs: timeoutSeconds * 1000,
      signal: run.signal,
    });
  } catch (error) {
    return checkFailure(command, "could not be run", messageOf(error));
  }
  return result.code === 0 && !result.timedOut
    ? null
    : checkFailure(command, checkStatus(result, timeoutSeconds), result.output);
}

/**
 * Run every check, in the order the config lists them, and keep going after
 * one fails: the agent then sees every failure at once, where stopping at
 * the first would cost it one blocked attempt for each. Once the deadline
 * has passed no further check is started.
 */
async function checksStage(run: Run): Promise<void> {
  const { config, progress } = run;
  if (config === null) {
    return;
  }
  if (unreadable(config, "checks")) {
    progress.failures.push(
      plain(
        "checks:unreadable",
        `The hook cannot read \`checks\` in ${config.path}. It must be a list of string literals, so that the hook can read it without running the config. The config is a protected path: ask the maintainer to fix it.`,
        `\`checks\` in ${config.path} is not a list of string literals, so no check was run`,
      ),
    );
    return;
  }
  const commands = config.settings.checks ?? [];
  for (const [index, command] of commands.entries()) {
    if (timeIsUp(run)) {
      return;
    }
    progress.unfinished = commands.slice(index);
    progress.doing = `running the check ${printable(clip(command, MAX_COMMAND))}`;
    const failure = await runCheck(command, run);
    if (timeIsUp(run)) {
      // Killed by the deadline: it is reported as unfinished, not failed.
      return;
    }
    if (failure !== null) {
      progress.failures.push(failure);
    }
  }
  progress.unfinished = [];
}

/**
 * Say so when the config is in another directory. The hook reads the config
 * of the directory it runs in; with none there it would run no check and
 * report nothing, which reads as "all checks pass".
 */
async function elsewhereStage(run: Run): Promise<void> {
  if (run.config !== null) {
    return;
  }
  const found = await configElsewhere(run.projectDir, run.deps);
  if (found === null) {
    return;
  }
  const where = elsewhereText(run.projectDir, found);
  const cwd = printable(found.cwd);
  run.progress.failures.push(
    plain(
      "config:elsewhere",
      `${where}. The hook reads the config of the directory it runs in, so it ran no check. A person has to run the hook in the directory of the config: --cwd ${cwd}`,
      `${where}, so no check was run; the hook needs --cwd ${cwd}`,
    ),
  );
}

/** The branches that may be the default one, most likely first. */
async function defaultBranches(run: Run): Promise<readonly string[]> {
  const named = run.config?.settings.mainBranch ?? null;
  if (named !== null) {
    return [named];
  }
  const remote = await run.deps.git.originHead(run.projectDir);
  return remote === null || FALLBACK_BRANCHES.some((name) => name === remote)
    ? FALLBACK_BRANCHES
    : [remote, ...FALLBACK_BRANCHES];
}

/**
 * The ref the branch is compared with, or the reason there is none.
 *
 * `ci.mainBranch` when the config sets it; else what the remote calls its
 * default branch; else `main`, then `master`. For each, the remote branch
 * first: the local one is often behind it, and tests merged since would
 * then look like tests this change removed. A ref that does not exist is
 * never handed to the guard, so the reason can name every ref that was
 * tried and the two ways to settle it.
 */
async function baseRef(run: Run): Promise<string | Failure> {
  const { config, options, deps, projectDir } = run;
  if (options.base !== undefined) {
    return options.base;
  }
  if (config !== null && unreadable(config, "ci.mainBranch")) {
    // Guessing `main` here could compare with the wrong branch and pass.
    return plain(
      "main-branch:unreadable",
      `The hook cannot read \`ci.mainBranch\` in ${config.path}, so it cannot tell which branch to compare with. It must be a string literal, or the hook must be given --base <ref>. The config is a protected path: ask the maintainer to fix it.`,
      `\`ci.mainBranch\` in ${config.path} is not a string literal, so the branch was not compared with the main branch`,
    );
  }
  const branches = await defaultBranches(run);
  const tried: string[] = [];
  for (const branch of branches) {
    for (const ref of [`origin/${branch}`, branch]) {
      if (await deps.refExists(ref, projectDir)) {
        return ref;
      }
      tried.push(printable(clip(ref, MAX_TITLE)));
    }
  }
  const fix =
    "give the hook --base <ref>, or set ci.mainBranch in jevy.config.*";
  return plain(
    "main-branch:missing",
    `The hook cannot tell which branch to compare with: none of ${tried.join(", ")} exists in this repository. A person has to ${fix}.`,
    `no branch to compare with: none of ${tried.join(", ")} exists; ${fix}`,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function weakeningFinding(value: unknown): GuardFinding | null {
  if (!isRecord(value) || value["severity"] !== "weakening") {
    return null;
  }
  const { kind, file, test, line, message } = value;
  if (typeof kind !== "string" || typeof file !== "string") {
    return null;
  }
  const titles = Array.isArray(test)
    ? test.filter((title): title is string => typeof title === "string")
    : [];
  return {
    kind,
    file,
    test: titles.length === 0 ? null : titles.join(" > "),
    line: typeof line === "number" ? line : null,
    message: typeof message === "string" ? message : "",
  };
}

/**
 * The weakening findings in the guard's `--json` report, or null when the
 * text is not such a report. The hook reads the JSON as data and checks every
 * field: it does not trust the shape, so a change to the report cannot make
 * the hook throw.
 */
function weakeningFindings(stdout: string): GuardFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["findings"])) {
    return null;
  }
  const out: GuardFinding[] = [];
  for (const entry of parsed["findings"] as readonly unknown[]) {
    const finding = weakeningFinding(entry);
    if (finding !== null) {
      out.push(finding);
    }
  }
  return out;
}

/** One line for the agent. The file and the kind come first and are never cut off. */
function findingLine(finding: GuardFinding): string {
  const where = finding.line === null ? "" : `, line ${String(finding.line)}`;
  const test =
    finding.test === null ? "" : `, in "${clip(finding.test, MAX_TITLE)}"`;
  return printable(
    `${clip(finding.file, MAX_FILE)}: ${clip(finding.kind, MAX_KIND)}${where}${test}: ${clip(finding.message, MAX_MESSAGE)}`,
  );
}

function findingBrief(finding: GuardFinding): string {
  const test =
    finding.test === null ? "" : ` ("${clip(finding.test, BRIEF_TITLE)}")`;
  return printable(
    `jevy guard: ${clip(finding.kind, MAX_KIND)} in ${clip(finding.file, BRIEF_FILE)}${test}`,
  );
}

/**
 * As many of `lines` as fit in `room` characters, indented, then a count of
 * the rest. When even the first few do not fit they are cut shorter, never
 * dropped: a reason that names no finding tells the agent nothing.
 */
function listBody(
  lines: readonly string[],
  limit: number,
): (room: number) => string {
  return (room) => {
    const candidates = lines.slice(0, limit);
    const least = Math.min(MIN_FINDINGS, candidates.length);
    // Two for the indent, one for the line break, and the "and N more" line.
    const space = room - 30;
    const shown: string[] = [];
    let used = 0;
    for (const line of candidates) {
      if (used + line.length + 3 > space) {
        break;
      }
      shown.push(line);
      used += line.length + 3;
    }
    const kept =
      shown.length >= least
        ? shown
        : candidates
            .slice(0, least)
            .map((line) =>
              clip(line, Math.max(1, Math.floor(space / least) - 3)),
            );
    const more = lines.length - kept.length;
    return indent(
      (more > 0 ? [...kept, `and ${String(more)} more`] : kept).join("\n"),
    );
  };
}

/** One run of the guard: what it compares with, and how to name it. */
interface Comparison {
  /** The rest of "since ...". */
  readonly since: string;
  readonly argv: readonly string[];
  /** Prefix of this comparison's failure keys. */
  readonly key: string;
  /** Goes after "jevy guard could not run", to say which run it was. */
  readonly what: string;
}

function weakeningFailure(reported: readonly Reported[]): Failure {
  const findings = reported.map((entry) => entry.finding);
  const since = [...new Set(reported.flatMap((entry) => [...entry.since]))]
    .map((name) => `since ${printable(name)}`)
    .join(" and ");
  const count =
    findings.length === 1
      ? "1 weakening change"
      : `${String(findings.length)} weakening changes`;
  const brief = findings.slice(0, MAX_FINDINGS).map(findingBrief);
  const more = findings.length - brief.length;
  return {
    keys: findings.map(
      (finding) =>
        `guard:${JSON.stringify([finding.kind, finding.file, finding.test])}`,
    ),
    headline: `jevy guard found ${count} ${since}:`,
    body: listBody(findings.map(findingLine), MAX_FINDINGS),
    brief:
      more > 0
        ? [...brief, `jevy guard: and ${String(more)} more weakening changes`]
        : brief,
  };
}

/** The guard's own first line of error text, for the message to the person. */
function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  return line.replace(/^jevy guard: /, "");
}

type GuardOutcome =
  | { readonly findings: readonly GuardFinding[] }
  | { readonly failure: Failure };

/**
 * What one run of the guard means: its weakening findings, or the failure
 * to report when its answer is anything but a readable report.
 */
function readGuard(result: CliResult, comparison: Comparison): GuardOutcome {
  if (result.code === 0) {
    return { findings: [] };
  }
  const findings = result.code === 1 ? weakeningFindings(result.stdout) : null;
  if (findings !== null && findings.length > 0) {
    return { findings };
  }
  const output = result.stderr.trim() === "" ? result.stdout : result.stderr;
  const since = printable(comparison.since);
  if (result.code === 1) {
    // Weakening, in a form this hook cannot read. Still weakening.
    return {
      failure: {
        keys: [`${comparison.key}:weakening`],
        headline: `jevy guard found weakening changes since ${since}:`,
        body: outputBody(output),
        brief: [`jevy guard: weakening changes since ${since}`],
      },
    };
  }
  // The guard's own words go to the person too: "could not run" alone does
  // not tell them that, say, the base ref is missing.
  const said = printable(firstLine(output));
  const ran = `jevy guard could not run${comparison.what} (exit ${String(result.code)})`;
  return {
    failure: {
      keys: [`${comparison.key}:could-not-run`],
      headline: `${ran}:`,
      body: outputBody(output),
      brief: [said === "" ? ran : `${ran}: ${said}`],
    },
  };
}

/**
 * Run the guard on the working tree: against the merge base with the main
 * branch, and against the commit the session started from.
 *
 * The first comparison is the pull request's view. It cannot see a commit
 * made in the session when the branch it compares with is the one the agent
 * commits to (work on `main` with no remote), or when that ref has been
 * moved up to `HEAD`. The second comparison starts from a commit the agent
 * cannot move, so it sees them. A finding both report is listed once.
 *
 * `--json` is asked for because the hook needs each finding's kind, file and
 * test to tell one failure from another; the human report would have to be
 * scraped.
 */
async function guardStage(run: Run): Promise<void> {
  const { baseline, deps, progress, projectDir } = run;
  const comparisons: Comparison[] = [];
  const base = await baseRef(run);
  if (typeof base === "string") {
    comparisons.push({
      since: base,
      argv: ["--base", base, "--merge-base", "--cwd", projectDir, "--json"],
      key: "guard",
      what: "",
    });
  } else {
    progress.failures.push(base);
  }
  if (baseline.kind === "commit") {
    comparisons.push({
      since: `the session's start (${shortHash(baseline.commit)})`,
      argv: ["--base", baseline.commit, "--cwd", projectDir, "--json"],
      key: "guard:session",
      what: " on what this session committed",
    });
  } else if (baseline.kind === "lost") {
    progress.failures.push(baseline.failure);
  }
  for (const comparison of comparisons) {
    if (timeIsUp(run)) {
      return;
    }
    progress.doing = `running jevy guard against ${printable(comparison.since)}`;
    const outcome = readGuard(await deps.guard(comparison.argv), comparison);
    if ("failure" in outcome) {
      progress.failures.push(outcome.failure);
      continue;
    }
    for (const finding of outcome.findings) {
      const id = JSON.stringify(finding);
      const entry = progress.reported.get(id) ?? {
        finding,
        since: new Set<string>(),
      };
      entry.since.add(comparison.since);
      progress.reported.set(id, entry);
    }
  }
  if (timeIsUp(run)) {
    return;
  }
  progress.guardDone = true;
  progress.failures.push(...weakeningFailures(progress));
  progress.reported.clear();
}

/** The findings gathered so far as one failure; nothing when there are none. */
function weakeningFailures(progress: Progress): Failure[] {
  return progress.reported.size === 0
    ? []
    : [weakeningFailure([...progress.reported.values()])];
}

/** Line endings are git's business (`core.autocrlf`), not a change to the config. */
function sameText(a: string, b: string): boolean {
  return a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
}

function changeOf(then: string | null, now: string | null): string | null {
  if (then === null) {
    return now === null ? null : "added";
  }
  if (now === null) {
    return "removed";
  }
  return sameText(then, now) ? null : "changed";
}

/**
 * Block when a `jevy.config.*` in the project directory is not what it was
 * when the session started, whatever the guard says.
 *
 * The config decides what this hook runs and what it compares with: an
 * agent that edits `checks` or `ci.mainBranch` through a shell command, and
 * commits the edit, would otherwise pick the rules it is judged by. The
 * config is compared as text, read from git and from the disk; it is never
 * imported. With no record of the session's start the comparison is with
 * `HEAD`, which still catches an edit that is not committed.
 */
async function configStage(run: Run): Promise<void> {
  const { baseline, deps, progress, projectDir } = run;
  progress.doing = "comparing the config with the start of the session";
  const commit =
    baseline.kind === "commit"
      ? baseline.commit
      : await deps.git.head(projectDir);
  if (commit === null) {
    // No commit to compare with: not a repository, or nothing committed
    // yet. The guard has already said so.
    return;
  }
  const changed: string[] = [];
  for (const name of CONFIG_FILENAMES) {
    const then = await deps.git.readAt(commit, name, projectDir);
    const now = await deps.readFile(join(projectDir, name));
    const change = changeOf(then, now);
    if (change !== null) {
      changed.push(`${name} (${change})`);
    }
  }
  if (changed.length === 0) {
    return;
  }
  const reason =
    "the Jevy config changed in this session; a person must approve that change";
  const what = `${changed.join(", ")} since ${shortHash(commit)}`;
  progress.failures.push({
    keys: changed.map((entry) => `config-changed:${entry}`),
    headline: `The work is blocked because ${reason}: ${what}. Put the config back as it was and ask the maintainer to make the change.`,
    body: null,
    brief: [`${reason}: ${what}`],
  });
}

const STAGES = [elsewhereStage, checksStage, guardStage, configStage] as const;

/**
 * Find everything that failed, into `progress`. A stage that throws becomes
 * a failure of its own and does not hide what an earlier stage found. Once
 * the deadline has passed no further stage is started.
 */
async function findFailures(
  projectDir: string,
  options: StopOptions,
  deps: HookDeps,
  signal: AbortSignal,
  progress: Progress,
): Promise<void> {
  progress.doing = "reading the hook input";
  progress.input = parseHookInput(await stdinOf(deps));
  progress.doing = "reading the config";
  let config: Config | null;
  let baseline: Baseline;
  try {
    config = await readConfig(projectDir, deps);
    progress.doing = "reading the record of where the session started";
    baseline = await sessionBaseline(
      projectDir,
      progress.input?.sessionId ?? null,
      deps,
    );
  } catch (error) {
    // Without the config neither the checks nor the main branch are known.
    progress.failures.push(thrownFailure(error));
    return;
  }
  const run: Run = {
    projectDir,
    options,
    deps,
    signal,
    progress,
    config,
    baseline,
  };
  for (const stage of STAGES) {
    if (signal.aborted) {
      return;
    }
    try {
      await stage(run);
    } catch (error) {
      progress.failures.push(thrownFailure(error));
    }
  }
}

/**
 * The failure for a hook that ran out of time, naming what did not finish.
 * A check that was still running has not passed, and one that never started
 * has not either.
 */
function deadlineFailure(progress: Progress, seconds: number): Failure {
  const [running, ...waiting] = progress.unfinished.map((command) =>
    printable(clip(command, MAX_COMMAND)),
  );
  const lines = [
    ...(running === undefined
      ? []
      : [`killed while it was running: ${running}`]),
    ...waiting.map((command) => `not started: ${command}`),
    ...(progress.guardDone ? [] : ["not finished: jevy guard"]),
  ];
  const limit = `${String(seconds)} s`;
  return {
    keys: [`deadline:${progress.doing}`],
    headline: `The hook ran out of time: its limit of ${limit} passed while it was ${progress.doing}. What did not finish has not passed:`,
    body: listBody(lines, MAX_FINDINGS),
    brief: [
      `the hook ran out of time (${limit}) while it was ${progress.doing}`,
      ...lines.slice(0, MAX_FINDINGS).map((line) => clip(line, MAX_BRIEF)),
    ],
  };
}

/** Bulk failures after the others, each group in its own order. */
function byPriority(failures: readonly Failure[]): Failure[] {
  return [
    ...failures.filter((failure) => failure.bulk !== true),
    ...failures.filter((failure) => failure.bulk === true),
  ];
}

/**
 * The failures written out for the agent in at most `room` characters.
 *
 * Headlines first, and they may take half the room: every failure that fits
 * is named, the few that are not checks before the checks, and the rest are
 * counted. What is left goes to the bodies. Lists and other non-check
 * bodies take what they need from it, up to an equal share; the output of
 * the failed checks shares the remainder. So one check that prints a great
 * deal, or two hundred that fail, cannot push the guard's findings out.
 */
function sections(failures: readonly Failure[], room: number): string[] {
  const ordered = byPriority(failures);
  const shown = new Set<Failure>();
  const headlines = new Map<Failure, string>();
  let used = 0;
  for (const failure of ordered) {
    const headline = clip(failure.headline, MAX_HEADLINE);
    if (used + headline.length + 2 > room / 2 && shown.size > 0) {
      break;
    }
    shown.add(failure);
    headlines.set(failure, headline);
    used += headline.length + 2;
  }
  const left = failures.length - shown.size;
  let free = room - used - (left > 0 ? 40 : 0);
  const bodies = new Map<Failure, string>();
  const withBody = ordered.filter(
    (failure) => shown.has(failure) && failure.body !== null,
  );
  const bulk = withBody.filter((failure) => failure.bulk === true);
  const others = withBody.filter((failure) => failure.bulk !== true);
  // `others` come first in `ordered`, so `free` is still whole for them.
  let forOthers = bulk.length === 0 ? free : Math.floor(free * LIST_SHARE);
  for (const [index, failure] of withBody.entries()) {
    const isBulk = failure.bulk === true;
    const waiting = isBulk ? withBody.length - index : others.length - index;
    const share = Math.max(
      0,
      Math.floor((isBulk ? free : forOthers) / waiting),
    );
    const text = (failure.body?.(share) ?? "").slice(0, share);
    bodies.set(failure, text);
    free -= text.length + 1;
    forOthers -= text.length + 1;
  }
  const out = failures
    .filter((failure) => shown.has(failure))
    .map((failure) => {
      const body = bodies.get(failure) ?? "";
      const headline = headlines.get(failure) ?? "";
      return body === "" ? headline : `${headline}\n${body}`;
    });
  return left > 0 ? [...out, `and ${String(left)} more failures`] : out;
}

function block(failures: readonly Failure[]): CliResult {
  const intro = "jevy hook stop: the work is not done.";
  // Two line breaks between the parts, one at the end.
  const room = MAX_REASON - intro.length - CLOSING.length - 5;
  const parts = [intro, ...sections(failures, room), CLOSING];
  return { code: 2, stdout: "", stderr: `${parts.join("\n\n")}\n` };
}

/** As many of `lines` as fit in `room` characters, then a count of the rest. */
function fitted(lines: readonly string[], room: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    used += line.length + 1;
    if (used > room) {
      return [...out, `- and ${String(lines.length - index)} more`];
    }
    out.push(line);
  }
  return out;
}

/** Why the agent is let go although something still fails. */
type Release =
  /** The same failure again. */
  | "same"
  /** The chain is too long. */
  | "cap"
  /** The hook cannot keep its count, so it cannot tell either of the above. */
  | "state";

function releaseText(why: Release): string {
  switch (why) {
    case "same":
      return `The stop hook blocked it ${String(SAME_FAILURE_LIMIT)} times in a row for the same failure and the failure is still there.`;
    case "cap":
      return `The stop hook blocked it ${String(CHAIN_LIMIT)} times in this turn and the checks never passed.`;
    case "state":
      return "The stop hook could not keep its state (the files it counts its blocks in cannot be read or written), so it did not block the agent again: without a count it would block for ever.";
  }
}

/**
 * Let the agent stop and tell the person why that is not good news.
 *
 * Exit 0 with a `systemMessage` in the JSON on stdout is the documented way
 * for a Claude Code hook to show the user a warning. The agent does not see
 * it, which is the point: it has had its chances, and the next move is a
 * person's.
 *
 * Every line is cut to a width, so each failure is named whatever the
 * length of a test title or a command, and the lines that do not fit are
 * counted.
 */
function allow(failures: readonly Failure[], why: Release): CliResult {
  const head = [
    `Jevy let the agent stop, but the checks still fail. ${releaseText(why)}`,
    "What failed:",
  ];
  const brief = byPriority(failures).flatMap((failure) =>
    failure.brief.map((line) => `- ${clip(line, MAX_BRIEF)}`),
  );
  const room = MAX_SYSTEM_MESSAGE - head.join("\n").length - 40;
  const systemMessage = [...head, ...fitted(brief, room)].join("\n");
  return {
    code: 0,
    stdout: `${JSON.stringify({ systemMessage })}\n`,
    stderr: "",
  };
}

/**
 * Block, or let go when the agent is stuck. The count is per session and per
 * chain: `stop_hook_active` is false on the first attempt after a person's
 * message, and whatever an older chain left behind is ignored then.
 *
 * When the count cannot be read or saved, the hook blocks the first attempt
 * of a chain and lets the next one go, telling the person. Blocking every
 * time would never end: Claude Code's own cap on consecutive blocks starts
 * again whenever the agent calls a tool.
 */
async function settle(
  failures: readonly Failure[],
  path: string,
  stopHookActive: boolean,
  deps: HookDeps,
): Promise<CliResult> {
  if (failures.length === 0) {
    await clearState(deps.state, path);
    return { code: 0, stdout: "", stderr: "" };
  }
  const prior = stopHookActive ? await loadState(deps.state, path) : null;
  if (prior === "unusable") {
    return allow(failures, "state");
  }
  const signature = signatureOf(failures.flatMap((failure) => failure.keys));
  const decision = decide(prior, signature);
  if (decision.action === "allow") {
    await clearState(deps.state, path);
    return allow(failures, decision.why);
  }
  const saved = await saveState(deps.state, path, decision.next);
  return !saved && stopHookActive ? allow(failures, "state") : block(failures);
}

async function stdinOf(deps: HookDeps): Promise<string> {
  try {
    return await deps.readStdin();
  } catch {
    // No input is how a person runs it; the checks decide either way.
    return "";
  }
}

function usageFailure(error: unknown): CliResult {
  const usage = error instanceof UsageError ? `\n${STOP_USAGE}` : "";
  return {
    code: 2,
    stdout: "",
    stderr: `jevy hook stop: ${messageOf(error)}\n${usage}`,
  };
}

/**
 * Run `jevy hook stop`. Never throws and never exits 1. An error nobody
 * planned for blocks (exit 2): a hook that fails open would let the agent
 * finish with nothing checked.
 *
 * The work is raced against the deadline and is not waited for once the
 * deadline has passed, so a check, a git command or a file read that never
 * comes back cannot hold the hook until Claude Code cancels it. What had
 * failed by then is reported together with what did not finish. The state
 * files get a short limit of their own for the same reason.
 */
export async function runStop(
  argv: readonly string[],
  deps: HookDeps,
): Promise<CliResult> {
  try {
    const options = parseStopArgs(argv);
    if (options === "help") {
      return { code: 0, stdout: STOP_USAGE, stderr: "" };
    }
    const projectDir = resolve(deps.cwd, options.cwd ?? ".");
    const progress: Progress = {
      input: null,
      doing: "starting",
      failures: [],
      unfinished: [],
      guardDone: false,
      reported: new Map(),
    };
    const deadlineMs = options.deadlineSeconds * 1000;
    const raced = await within(deadlineMs, (signal) =>
      findFailures(projectDir, options, deps, signal, progress),
    );
    // Copied: the abandoned work may still add to `progress`.
    const failures = raced.inTime
      ? [...progress.failures]
      : [
          ...progress.failures,
          ...weakeningFailures(progress),
          deadlineFailure(progress, options.deadlineSeconds),
        ];
    const { input } = progress;
    const settled = await within(Math.min(SETTLE_LIMIT_MS, deadlineMs), () =>
      settle(
        failures,
        statePath(deps.state.dir, projectDir, input?.sessionId ?? ""),
        input?.stopHookActive ?? false,
        deps,
      ),
    );
    if (settled.inTime) {
      return settled.value;
    }
    return failures.length === 0
      ? { code: 0, stdout: "", stderr: "" }
      : block(failures);
  } catch (error) {
    return usageFailure(error);
  }
}
