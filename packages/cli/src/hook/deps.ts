import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import type { CliResult } from "../cli.js";
import { runGuard } from "../guard/command.js";
import { GuardError } from "../guard/errors.js";
import { gitHead, gitOriginHead, gitReadAt, gitTrackedConfigs } from "./git.js";
import { gitRefExists, runShell, type RunCommand } from "./shell.js";
import { realStateFiles, type StateFiles } from "./state.js";

/** The read-only questions the hooks ask git; see `git.ts` for each. */
export interface HookGit {
  /** Full hash of the commit `HEAD` points at; null when there is none. */
  readonly head: (cwd: string) => Promise<string | null>;
  /** The branch `refs/remotes/origin/HEAD` points at, or null. */
  readonly originHead: (cwd: string) => Promise<string | null>;
  /**
   * Text of `path` (relative to `cwd`) at `commit`; null when the commit has
   * no file there. Rejects when git cannot answer.
   */
  readonly readAt: (
    commit: string,
    path: string,
    cwd: string,
  ) => Promise<string | null>;
  /** Every tracked `jevy.config.*`, relative to `cwd`; empty outside a repository. */
  readonly trackedConfigs: (cwd: string) => Promise<readonly string[]>;
}

/**
 * Everything a hook does to the world outside it, in one object. The hooks
 * take it as an argument, so their tests replace all of it with fakes: no
 * process is started and no file is read unless a test asks for the real
 * thing.
 */
export interface HookDeps {
  /** Directory `--cwd` is resolved against; the project directory without it. */
  readonly cwd: string;
  /** All of the hook's stdin as text; "" when there is none. */
  readonly readStdin: () => Promise<string>;
  /**
   * Text of the regular file at an absolute path, or null when nothing is
   * there. Rejects for anything else in its place (a directory, a symlink, a
   * FIFO) and never waits on it.
   */
  readonly readFile: (path: string) => Promise<string | null>;
  /** The path with symlinks resolved; rejects with ENOENT when it does not exist. */
  readonly realpath: (path: string) => Promise<string>;
  /** The text of the symlink at `path`; null when it is not one or is not there. */
  readonly readlink: (path: string) => Promise<string | null>;
  /** Runs one check command through the shell. */
  readonly runCommand: RunCommand;
  /** `jevy guard` with these arguments; the signature of `runGuard`. */
  readonly guard: (argv: readonly string[]) => Promise<CliResult>;
  /** Whether `ref` names a commit in the repository around `cwd`. */
  readonly refExists: (ref: string, cwd: string) => Promise<boolean>;
  readonly git: HookGit;
  /** Where the hooks keep what they remember about a session. */
  readonly state: StateFiles;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/** Nothing is at the path: no such name, or a parent of it is a file. */
function isAbsent(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function kindOf(stats: Stats): string {
  if (stats.isDirectory()) {
    return "a directory";
  }
  if (stats.isSymbolicLink()) {
    return "a symlink";
  }
  if (stats.isFIFO()) {
    return "a FIFO";
  }
  if (stats.isSocket()) {
    return "a socket";
  }
  return "a device";
}

function notRegular(path: string, stats: Stats): GuardError {
  return new GuardError(
    `${path} is ${kindOf(stats)}, not a regular file. The hook reads the config only from a regular file, so a person has to put one back.`,
  );
}

/**
 * The text of the regular file at `path`; null only when nothing is there.
 *
 * Anything else in the file's place is refused, and the hooks then block. A
 * FIFO would make a plain read wait for a writer that never comes, past the
 * time Claude Code gives a hook, after which the action goes ahead
 * unchecked. A symlink or a directory is not what the loader reads either,
 * and "no config" is the wrong answer for both. Any other failure (no
 * permission, an I/O error) rejects too: a config that exists but cannot be
 * read must not be taken for a project without one.
 *
 * `lstat` first for the clear message. The open that follows cannot be made
 * to wait or to follow a link by a swap between the two calls: O_NONBLOCK
 * returns from a FIFO at once, O_NOFOLLOW fails on a symlink, and the opened
 * file is checked again before it is read. Both flags are absent on Windows,
 * where the bitwise OR reads them as 0.
 */
async function readRegularFile(path: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isAbsent(error)) {
      return null;
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw notRegular(path, stats);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw notRegular(path, opened);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Null for "not a symlink" (EINVAL) as for "not there". */
async function readLinkText(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch (error) {
    if (isAbsent(error) || codeOf(error) === "EINVAL") {
      return null;
    }
    throw error;
  }
}

/**
 * The real thing, except stdin: `readStdin` answers "" here, so code that
 * calls `run` as a library never waits on the process's stdin. The `jevy`
 * executable passes the real one.
 */
export function defaultHookDeps(): HookDeps {
  return {
    cwd: process.cwd(),
    readStdin: () => Promise.resolve(""),
    readFile: readRegularFile,
    realpath: (path) => realpath(path),
    readlink: readLinkText,
    runCommand: runShell,
    guard: (argv) => runGuard(argv),
    refExists: gitRefExists,
    git: {
      head: gitHead,
      originHead: gitOriginHead,
      readAt: gitReadAt,
      trackedConfigs: gitTrackedConfigs,
    },
    state: realStateFiles(tmpdir()),
  };
}
