import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { GuardError } from "../guard/errors.js";

/**
 * What the hooks remember about one session: how many times the stop hook
 * has blocked the agent in a row, and the commit the session started from.
 *
 * A stop hook that blocks for ever makes an agent that cannot fix the failure
 * spin, and an agent that is spinning is the one most likely to weaken a
 * test to get out. So the hook counts, per session, and after a few blocks it
 * lets the agent stop and tells the person instead.
 *
 * The start commit is what the stop hook compares the session's own commits
 * with. Without it, a weakening change that the agent has committed is
 * invisible whenever the branch being compared with is the one the agent
 * committed to.
 *
 * Both live in small files in the OS temp directory: never in the
 * repository, where they would show up as changes and where the agent works.
 * They are two files, so that clearing the count cannot drop the start
 * commit, and so that the start commit can be written with "create, never
 * replace".
 */

/** Blocks in a row for the same failure before the agent may stop. */
export const SAME_FAILURE_LIMIT = 2;

/**
 * Blocks in one chain, whatever the failures, before the agent may stop.
 * Claude Code has its own cap of eight, but that count starts again every
 * time the agent calls a tool, so it does not bound an agent that keeps
 * trying. This one does, and the hook's plain message to the person is what
 * ends the chain.
 */
export const CHAIN_LIMIT = 6;

export interface StopState {
  /** Blocks in this chain so far. */
  readonly blocks: number;
  /** How many of the latest blocks in a row had `signature`. */
  readonly same: number;
  /** Signature of the failure that caused the latest block. */
  readonly signature: string;
}

export type Decision =
  | { readonly action: "block"; readonly next: StopState }
  /** "same": the same failure again. "cap": the chain is too long. */
  | { readonly action: "allow"; readonly why: "same" | "cap" };

/**
 * Whether to block a failed stop attempt. `prior` is the state the last
 * block left, or null at the start of a chain.
 */
export function decide(prior: StopState | null, signature: string): Decision {
  const repeated = prior !== null && prior.signature === signature;
  if (repeated && prior.same >= SAME_FAILURE_LIMIT) {
    return { action: "allow", why: "same" };
  }
  if (prior !== null && prior.blocks >= CHAIN_LIMIT) {
    return { action: "allow", why: "cap" };
  }
  return {
    action: "block",
    next: {
      blocks: (prior?.blocks ?? 0) + 1,
      same: repeated ? prior.same + 1 : 1,
      signature,
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * One value for a set of failures, whatever their order. The parts name what
 * failed (a command, a finding's kind, file and test) and never the output
 * text, which changes from run to run with timings and counts.
 */
export function signatureOf(parts: readonly string[]): string {
  return sha256(JSON.stringify([...parts].sort()));
}

/**
 * The state file for one session of one project. The name is a hash, so the
 * session id, which comes from the agent, never becomes part of a path.
 */
export function statePath(
  dir: string,
  projectDir: string,
  sessionId: string,
): string {
  const name = sha256(JSON.stringify([projectDir, sessionId])).slice(0, 32);
  return join(dir, `jevy-hook-${name}.json`);
}

/**
 * The file that holds the commit one session started from in one
 * repository. Named like the count's file and for the same reason.
 *
 * `repoRoot` is the repository's top level with its symlinks resolved, not
 * the project directory: `session-start` runs where the settings put it
 * (the project root), and the stop hook may be told to run in the
 * directory of a config below it. Keyed by the directory, the stop hook
 * found no record there and skipped the comparison it is for.
 */
export function startPath(
  dir: string,
  repoRoot: string,
  sessionId: string,
): string {
  const name = sha256(JSON.stringify([repoRoot, sessionId])).slice(0, 32);
  return join(dir, `jevy-hook-${name}-start.json`);
}

export function serialiseStart(commit: string): string {
  return `${JSON.stringify({ v: 1, head: commit })}\n`;
}

/**
 * The commit in `text`, or null when it is not a record this version wrote.
 * Only a full hash is taken: the value goes to git as an argument, and a
 * branch name would move while a hash cannot.
 */
export function parseStart(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const fields: Readonly<Record<string, unknown>> = { ...parsed };
  const head = fields["head"];
  return fields["v"] === 1 &&
    typeof head === "string" &&
    /^[0-9a-f]{40,64}$/.test(head)
    ? head
    : null;
}

export function serialiseState(state: StopState): string {
  return `${JSON.stringify({ v: 1, ...state })}\n`;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * The state in `text`, or null when it is not one this version wrote. A
 * damaged file is read as "no state": the chain starts again and the next
 * block overwrites it, so the worst a bad file can do is add a few blocks.
 */
export function parseState(text: string): StopState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const fields: Readonly<Record<string, unknown>> = { ...parsed };
  const blocks = count(fields["blocks"]);
  const same = count(fields["same"]);
  const signature = fields["signature"];
  if (
    fields["v"] !== 1 ||
    blocks === null ||
    same === null ||
    same > blocks ||
    typeof signature !== "string"
  ) {
    return null;
  }
  return { blocks, same, signature };
}

/** The file operations the state needs; tests replace them. */
export interface StateFiles {
  /** Directory the state files are kept in. */
  readonly dir: string;
  /** The text of the file, or null when it does not exist. */
  readonly read: (path: string) => Promise<string | null>;
  readonly write: (path: string, text: string) => Promise<void>;
  /**
   * Write the file only when there is none: true when it was written, false
   * when one was already there, which is left as it is.
   */
  readonly create: (path: string, text: string) => Promise<boolean>;
  /** Removing a file that does not exist is not an error. */
  readonly remove: (path: string) => Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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
  return stats.isSocket() ? "a socket" : "a device";
}

/**
 * The text of the regular file at `path`, or null when nothing is there.
 *
 * The agent can put anything in the temp directory where these files live.
 * A plain read of a FIFO waits for a writer in one of Node's worker threads,
 * and `process.exit` waits for that thread: the hook would write its answer
 * and then not end until Claude Code cancels it, which lets the agent stop.
 * So the file is opened so that nothing can make the open wait (O_NONBLOCK)
 * or follow a link (O_NOFOLLOW), and the opened file must be a regular one
 * before a byte is read. Both flags are 0 on Windows.
 */
async function readRegular(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    if (hasCode(error, "ELOOP") || hasCode(error, "EMLINK")) {
      throw new GuardError(`${path} is a symlink, not a regular file`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new GuardError(`${path} is ${kindOf(stats)}, not a regular file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Write `text` to a new file beside `path`, then rename it over `path`.
 *
 * The new file is created with O_EXCL under a random name, so it is a
 * regular file this call made: nothing the agent left there can make the
 * write wait or go elsewhere. The rename replaces whatever is at `path` (a
 * FIFO, a symlink) without opening it, and readers see the old text or the
 * new, never half of it.
 */
async function writeReplacing(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * State files on disk in `dir`, readable and writable by their owner only.
 * No operation opens what it finds at a path in a way that can wait.
 */
export function realStateFiles(dir: string): StateFiles {
  return {
    dir,
    read: readRegular,
    write: writeReplacing,
    create: async (path, text) => {
      try {
        // "wx" (O_CREAT | O_EXCL) fails when the path exists, whatever is
        // there, in one step and without opening it: two hooks started
        // together cannot both think they were first, and a FIFO cannot
        // make it wait.
        await writeFile(path, text, { mode: 0o600, flag: "wx" });
        return true;
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          return false;
        }
        throw error;
      }
    },
    remove: (path) => rm(path, { force: true }),
  };
}

/*
 * The three below never throw. Losing the count must not turn into a crash,
 * which Claude Code would report as a hook error and then let the agent
 * stop. They do say when the files could not be used, because the stop hook
 * must not go on blocking with a count it cannot keep: Claude Code's own cap
 * does not end that loop (see `CHAIN_LIMIT`).
 */

/**
 * The saved state, null when there is none, or "unusable" when the file
 * could not be read. A file that reads but is damaged is "none": the next
 * block overwrites it.
 */
export async function loadState(
  files: StateFiles,
  path: string,
): Promise<StopState | null | "unusable"> {
  try {
    const text = await files.read(path);
    return text === null ? null : parseState(text);
  } catch {
    return "unusable";
  }
}

/** Save the state; false when it could not be written. */
export async function saveState(
  files: StateFiles,
  path: string,
  state: StopState,
): Promise<boolean> {
  try {
    await files.write(path, serialiseState(state));
    return true;
  } catch {
    return false;
  }
}

export async function clearState(
  files: StateFiles,
  path: string,
): Promise<void> {
  try {
    await files.remove(path);
  } catch {
    // A file left behind is ignored at the start of the next chain.
  }
}

export type StartRecord =
  /**
   * No file: the session-start hook did not run for this session, or the
   * file has been deleted. The two cannot be told apart.
   */
  | { readonly kind: "none" }
  | { readonly kind: "commit"; readonly commit: string }
  /** A record is there and cannot be used; `why` is for the person. */
  | { readonly kind: "unusable"; readonly why: string };

/**
 * The commit this session started from. Never throws. A record that cannot
 * be read, is not a regular file, or reads as something else, is
 * "unusable" and never "none": the stop hook treats "none" as "compare as if
 * the hook were not wired", and a damaged file must not be a way to get
 * there.
 *
 * Only a missing file is "none", and that includes a file the agent has
 * deleted. Nothing outside the temp directory knows the record was ever
 * written, so a deletion reads like a session that started before the hook
 * was wired. That is a known limit: the guard in CI still compares commits.
 */
export async function loadStart(
  files: StateFiles,
  path: string,
): Promise<StartRecord> {
  let text: string | null;
  try {
    text = await files.read(path);
  } catch (error) {
    return {
      kind: "unusable",
      why: error instanceof Error ? error.message : String(error),
    };
  }
  if (text === null) {
    return { kind: "none" };
  }
  const commit = parseStart(text);
  return commit === null
    ? { kind: "unusable", why: "it is damaged" }
    : { kind: "commit", commit };
}

/**
 * Record `commit` as where the session started, unless a record is already
 * there: true when this call wrote it. A session starts more than once (a
 * resume, a compaction), and each later start must leave the first
 * baseline alone, or work committed before it would drop out of sight.
 * Rejects when the file cannot be written.
 */
export function recordStart(
  files: StateFiles,
  path: string,
  commit: string,
): Promise<boolean> {
  return files.create(path, serialiseStart(commit));
}
