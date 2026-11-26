import { randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { CacheError } from "@jevyjs/core";
import type { Answer, RunMemo, RunMemoEntry } from "@jevyjs/core";

/**
 * The files one Playwright run shares between its worker processes: the run
 * memo, the claims that let one worker call the decider for a key while the
 * others wait, and the marks that let one worker write a key's record. They
 * live in a run directory, `<project.outputDir>/.jevy/runs/<runner>/<run>`,
 * chosen by {@link joinRun}.
 */

/** A decision key: `sha256:` and 64 lower-case hex characters. */
const KEY = /^sha256:([0-9a-f]{64})$/;

/** The file system calls the run memo makes; tests replace `link`. */
export interface MemoFileSystem {
  readonly link: (existing: string, path: string) => void;
}

const NODE_FILE_SYSTEM: MemoFileSystem = { link: linkSync };

export interface FileRunMemoOptions {
  /** Replaces the file system calls, for tests. */
  readonly fs?: MemoFileSystem;
  /**
   * Told once when an entry cannot be written. The answer is kept in this
   * process, so only the other workers miss it. Defaults to standard error.
   */
  readonly warn?: (text: string) => void;
}

/**
 * A run memo shared by every worker process of one run, one file per key
 * under `dir`.
 *
 * A retry runs in a new worker process, so an in-memory memo cannot carry the
 * first attempt's answer to it; this one can. {@link joinRun} gives each run
 * its own directory, so no entry outlives its run, also where Playwright
 * keeps the output directory between runs (UI mode, watch mode, VS Code).
 *
 * The first writer wins. A writer first creates an owner mark for the key,
 * `<dir>.owners/<hex>`, with the exclusive-create flag; only the writer that
 * created it publishes the entry, and every later writer leaves it in place.
 * The owner writes the entry to a temporary file and hard-links it to its
 * name, which never replaces a file; on a file system without hard links it
 * renames the file instead, which is safe because no other writer publishes
 * that key. Either way a reader sees no file or a whole entry, never a
 * half-written one. A writer that dies between the mark and the entry leaves
 * the key without an entry for the rest of the run: each worker then uses
 * its own answer, as with a memo that could not keep what was set.
 *
 * A write that fails is a `CacheError` naming the cause, given to `warn`;
 * it is not thrown, because it comes after a decider call that succeeded,
 * and the answer must not be lost. The entry is kept in this process instead.
 *
 * Only the entry's own fields are written, so nothing else a caller put on
 * the object (raw model output, say) reaches the disk. A file that is not a
 * well-formed entry is a `CacheError`, never a miss: it means another writer
 * or a person put something there, and asking again could record a second
 * answer for one key. So is a file that cannot be read.
 */
export function createFileRunMemo(
  dir: string,
  options: FileRunMemoOptions = {},
): RunMemo {
  const fs = options.fs ?? NODE_FILE_SYSTEM;
  const warn = options.warn ?? warnOnStandardError;
  const owners = join(dirname(dir), `${basename(dir)}.owners`);
  const kept = new Map<string, RunMemoEntry>();
  let warned = false;
  return {
    get: (key) => read(pathOf(dir, key), key) ?? kept.get(key),
    set: (key, entry) => {
      const path = pathOf(dir, key);
      const own = ownFields(entry);
      try {
        write(fs, dir, owners, path, own);
      } catch (error: unknown) {
        if (!kept.has(key)) kept.set(key, own);
        if (!warned) {
          warned = true;
          warn(
            `${cacheError(`Could not write the run memo entry for ${key}`, error).message}. ` +
              "Its answer is kept in this worker; other workers may ask again.",
          );
        }
      }
    },
  };
}

function warnOnStandardError(text: string): void {
  process.stderr.write(`Jevy: ${text}\n`);
}

function hexOf(key: string): string {
  const match = KEY.exec(key);
  if (match === null) {
    throw new CacheError(
      "A run memo key must be sha256: and 64 lower-case hex characters",
    );
  }
  return match[1] ?? "";
}

function pathOf(dir: string, key: string): string {
  return join(dir, `${hexOf(key)}.json`);
}

function read(path: string, key: string): RunMemoEntry | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw cacheError(`Could not read the run memo entry for ${key}`, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed(key, "is not JSON");
  }
  return entryOf(value, key);
}

function write(
  fs: MemoFileSystem,
  dir: string,
  owners: string,
  path: string,
  entry: RunMemoEntry,
): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(owners, { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { flag: "wx" });
  try {
    // Another writer was first; its entry stands.
    if (!createExclusive(join(owners, basename(path)))) return;
    try {
      fs.link(temporary, path);
    } catch (error: unknown) {
      if (isCode(error, "EEXIST")) return;
      // No hard links here (ENOTSUP, EPERM and the like). Only the owner
      // publishes this key, so a rename cannot replace another's entry.
      renameSync(temporary, path);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Create an empty file; false when it exists. */
function createExclusive(path: string, text = ""): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

function ownFields(entry: RunMemoEntry): RunMemoEntry {
  const { value, confidence, abstained } = entry.answer;
  return {
    answer: {
      value,
      confidence,
      ...(abstained !== undefined ? { abstained } : {}),
    },
    truncated: entry.truncated,
  };
}

/**
 * The shape only. Whether the answer fits the question is checked by the
 * session, which knows the question.
 */
function entryOf(value: unknown, key: string): RunMemoEntry {
  if (!isObject(value)) throw malformed(key, "is not an object");
  const answer = value["answer"];
  const truncated = value["truncated"];
  if (!isObject(answer)) throw malformed(key, "has no answer object");
  if (typeof truncated !== "boolean") {
    throw malformed(key, "has no boolean truncated flag");
  }
  const { value: chosen, confidence, abstained } = answer;
  if (typeof chosen !== "string" || typeof confidence !== "number") {
    throw malformed(key, "has no string value and number confidence");
  }
  if (abstained !== undefined && typeof abstained !== "boolean") {
    throw malformed(key, "has an abstained flag that is not a boolean");
  }
  const read: Answer = {
    value: chosen,
    confidence,
    ...(abstained !== undefined ? { abstained } : {}),
  };
  return { answer: read, truncated };
}

// ---------------------------------------------------------------------------
// One run's directory.

/** Whether a process is running; tests replace it. */
export type IsAlive = (pid: number) => boolean;

/**
 * True unless the system says no such process exists. A process this one
 * may not signal (`EPERM`) is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isCode(error, "ESRCH");
  }
}

export interface JoinRunInput {
  /** `<project.outputDir>/.jevy/runs`. */
  readonly runsDir: string;
  /** The project's retries. */
  readonly retries: number;
  /** The Playwright runner: the worker's parent process. */
  readonly runner: number;
  /** This worker. */
  readonly worker: number;
  readonly isAlive?: IsAlive;
}

/**
 * The directory this worker shares with the other workers of its run.
 *
 * Playwright gives a worker nothing that names its run: no run id, no
 * variable set per run, and its config metadata is the user's. Every worker
 * of a run is a child of the runner process, so the run directory sits under
 * the runner's process id. One command-line run is one runner process, and
 * Playwright cleans the output directory at its start, so that is enough
 * there. Playwright's UI mode, watch mode and the VS Code extension run many
 * times in one runner and keep the output directory; but they force
 * `retries` to 0 and stop every worker at the end of each run, so for them:
 *
 * - With retries (`retries > 0`), this is a command-line run: one directory,
 *   `all`, for the runner, so a retry in a new worker finds the first
 *   attempt's answer even when no other worker was alive in between.
 * - Without, a run is a generation, `1`, `2` and so on. A worker joins the
 *   newest generation that has a live worker in `workers/`, else starts the
 *   next one, so the workers of one run share a generation and the next
 *   run, whose workers start after the last one stopped, gets a new one.
 *   A worker that starts after every other worker of its run has stopped
 *   also starts a new generation; without retries that costs no more than a
 *   second call for a question an earlier test asked.
 *
 * A generation is created by renaming a complete directory into place, so
 * two workers that start it at once agree on one.
 */
export function joinRun(input: JoinRunInput): string {
  const base = join(input.runsDir, String(input.runner));
  if (input.retries > 0) {
    const dir = join(base, "all");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const isAlive = input.isAlive ?? isProcessAlive;
  mkdirSync(base, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const newest = newestGeneration(base);
    if (newest !== undefined && hasLiveWorker(base, newest, isAlive)) {
      const dir = join(base, String(newest));
      writeFileSync(join(dir, "workers", String(input.worker)), "");
      return dir;
    }
    const next = (newest ?? 0) + 1;
    const staging = join(base, `.staging-${randomBytes(8).toString("hex")}`);
    mkdirSync(join(staging, "workers"), { recursive: true });
    writeFileSync(join(staging, "workers", String(input.worker)), "");
    try {
      renameSync(staging, join(base, String(next)));
      return join(base, String(next));
    } catch {
      // Another worker started this generation first: join it.
      rmSync(staging, { recursive: true, force: true });
    }
  }
  throw new CacheError(
    `Could not join a run directory under ${base}: other workers kept starting new ones`,
  );
}

function newestGeneration(base: string): number | undefined {
  let newest: number | undefined;
  for (const name of readdirSync(base)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const value = Number(name);
    if (newest === undefined || value > newest) newest = value;
  }
  return newest;
}

function hasLiveWorker(
  base: string,
  generation: number,
  isAlive: IsAlive,
): boolean {
  let names: readonly string[];
  try {
    names = readdirSync(join(base, String(generation), "workers"));
  } catch {
    return false;
  }
  return names.some((name) => /^[0-9]+$/.test(name) && isAlive(Number(name)));
}

// ---------------------------------------------------------------------------
// Claims: one worker calls the decider for a key while the others wait.

export interface KeyClaims {
  /**
   * Try to claim the key for this process. True when this process holds it
   * now (also when it already did); false while another live process does.
   * A claim left by a process that has died is taken over.
   */
  tryClaim(key: string): boolean;
  /** Give up one hold of the key; the last one removes the claim. */
  release(key: string): void;
}

export interface KeyClaimsOptions {
  readonly pid?: number;
  readonly isAlive?: IsAlive;
}

/**
 * Claims under `dir`, one file per key holding the claimant's process id,
 * created with the exclusive-create flag. A claim never makes anyone call:
 * a worker that holds one still asks the memo first, through the session.
 */
export function createKeyClaims(
  dir: string,
  options: KeyClaimsOptions = {},
): KeyClaims {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const holds = new Map<string, number>();
  return {
    tryClaim: (key) => {
      const held = holds.get(key);
      if (held !== undefined) {
        holds.set(key, held + 1);
        return true;
      }
      const path = join(dir, hexOf(key));
      mkdirSync(dir, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (createExclusive(path, String(pid))) {
          holds.set(key, 1);
          return true;
        }
        const owner = claimant(path);
        // Being written, or held by a live worker: wait for it.
        if (owner === undefined || isAlive(owner)) return false;
        rmSync(path, { force: true });
      }
      return false;
    },
    release: (key) => {
      const held = holds.get(key);
      if (held === undefined) return;
      if (held > 1) {
        holds.set(key, held - 1);
        return;
      }
      holds.delete(key);
      rmSync(join(dir, hexOf(key)), { force: true });
    },
  };
}

function claimant(path: string): number | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return /^[0-9]+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Record marks: one worker writes a key's record in a run.

export interface RecordMarks {
  /** Mark the key as recorded in this run; false when a worker already has. */
  mark(key: string): boolean;
  /** Take a mark back, when its record could not be written. */
  unmark(key: string): void;
}

/**
 * Marks under `dir`, one empty file per key, created with the
 * exclusive-create flag. Each worker loads the decision store once, so it
 * does not see a record another worker wrote in this run; the mark is how
 * it knows not to write a second one.
 */
export function createRecordMarks(dir: string): RecordMarks {
  return {
    mark: (key) => {
      mkdirSync(dir, { recursive: true });
      return createExclusive(join(dir, hexOf(key)));
    },
    unmark: (key) => {
      rmSync(join(dir, hexOf(key)), { force: true });
    },
  };
}

// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(key: string, problem: string): CacheError {
  return new CacheError(`The run memo entry for ${key} ${problem}`);
}

/** A `CacheError` that names the system's error code, or its message. */
function cacheError(what: string, error: unknown): CacheError {
  if (error instanceof CacheError) return error;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const detail =
    code ?? (error instanceof Error ? error.message : "unknown error");
  return new CacheError(`${what}: ${detail}`);
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
