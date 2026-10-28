import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertSafeToStore,
  compareRecords,
  parseDecisionRecord,
  serialiseDecisionRecord,
  winningRecord,
} from "./decision-record.js";
import type { DecisionRecord } from "./decision-record.js";
import { CacheError } from "./errors.js";
import { isRecord } from "./guards.js";

const LOCK_WAIT_MS = 15_000;
const LOCK_FRESH_MS = 1_000;

const queues = new Map<string, Promise<unknown>>();

/**
 * Pluggable decision cache. `get` returns the record replay should use.
 * `put` appends, or replaces every record with that key when `replace` is set.
 * `list` returns every stored line, not only winners.
 * `touch` updates `lastUsedAt` on the winning record.
 * `replaceAll` is how prune rewrites the store.
 * `noteReferenced` / `referencedKeys` record which keys the last run asked for.
 * There is no cloud backend.
 */
export interface DecisionStore {
  get(key: string): Promise<DecisionRecord | null>;
  put(
    record: DecisionRecord,
    options?: { readonly replace?: boolean },
  ): Promise<void>;
  list(spec?: string): Promise<readonly DecisionRecord[]>;
  touch(key: string, lastUsedAt: string): Promise<void>;
  replaceAll(records: readonly DecisionRecord[]): Promise<void>;
  noteReferenced(key: string, at: string): Promise<void>;
  referencedKeys(): Promise<ReadonlySet<string>>;
}

export const DECISION_STORE_METHODS = [
  "get",
  "put",
  "list",
  "touch",
  "replaceAll",
  "noteReferenced",
  "referencedKeys",
] as const;

/** In-memory store for tests and for callers that do not want a directory. */
export class MemoryDecisionStore implements DecisionStore {
  #records: DecisionRecord[] = [];
  readonly #referenced = new Set<string>();

  public get(key: string): Promise<DecisionRecord | null> {
    return Promise.resolve(
      winningRecord(this.#records.filter((record) => record.key === key)),
    );
  }

  public put(
    record: DecisionRecord,
    options?: { readonly replace?: boolean },
  ): Promise<void> {
    try {
      const safe = assertSafeToStore(record);
      const next =
        options?.replace === true
          ? this.#records.filter((item) => item.key !== safe.key)
          : this.#records.slice();
      next.push(safe);
      next.sort(compareRecords);
      this.#records = next;
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new CacheError("Could not store the decision"),
      );
    }
    return Promise.resolve();
  }

  public list(spec?: string): Promise<readonly DecisionRecord[]> {
    const records =
      spec === undefined
        ? this.#records.slice()
        : this.#records.filter((record) => record.spec === spec);
    return Promise.resolve(records);
  }

  public touch(key: string, lastUsedAt: string): Promise<void> {
    const winner = winningRecord(
      this.#records.filter((record) => record.key === key),
    );
    if (winner === null) return Promise.resolve();
    const stamped = parseDecisionRecord({ ...winner, lastUsedAt });
    this.#records = this.#records.map((record) =>
      record === winner ? stamped : record,
    );
    return Promise.resolve();
  }

  public replaceAll(records: readonly DecisionRecord[]): Promise<void> {
    const next = records.map((record) => assertSafeToStore(record));
    next.sort(compareRecords);
    this.#records = next;
    return Promise.resolve();
  }

  public noteReferenced(key: string, at: string): Promise<void> {
    assertKey(key);
    if (at.length === 0) {
      throw new CacheError("A cache reference needs a timestamp");
    }
    this.#referenced.add(key);
    return Promise.resolve();
  }

  public referencedKeys(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.#referenced));
  }
}

/**
 * One sorted JSONL file per spec under `dir` (default `.jevy/decisions`).
 * Writes take a directory lock and replace the file via rename, so two
 * Playwright workers cannot tear a line. The committed files are the
 * sorted JSONL. Lock files and `.last-run.json` are bookkeeping.
 */
export class JsonlDecisionStore implements DecisionStore {
  public readonly dir: string;

  public constructor(dir: string) {
    this.dir = resolve(dir);
  }

  public get(key: string): Promise<DecisionRecord | null> {
    return this.exclusive(async () => {
      const records = await this.readAll();
      return winningRecord(records.filter((record) => record.key === key));
    }, false);
  }

  public put(
    record: DecisionRecord,
    options?: { readonly replace?: boolean },
  ): Promise<void> {
    return this.exclusive(async () => {
      const safe = assertSafeToStore(record);
      const records =
        options?.replace === true
          ? (await this.readAll()).filter((item) => item.key !== safe.key)
          : await this.readAll();
      records.push(safe);
      await this.writeAll(records);
    }, true);
  }

  public list(spec?: string): Promise<readonly DecisionRecord[]> {
    return this.exclusive(async () => {
      const records = await this.readAll();
      const filtered =
        spec === undefined
          ? records
          : records.filter((record) => record.spec === spec);
      filtered.sort(compareRecords);
      return filtered;
    }, false);
  }

  public touch(key: string, lastUsedAt: string): Promise<void> {
    return this.exclusive(async () => {
      const records = await this.readAll();
      const winner = winningRecord(
        records.filter((record) => record.key === key),
      );
      if (winner === null) return;
      const stamped = parseDecisionRecord({ ...winner, lastUsedAt });
      const next = records.map((record) =>
        sameLine(record, winner) ? stamped : record,
      );
      await this.writeAll(next);
    }, true);
  }

  public replaceAll(records: readonly DecisionRecord[]): Promise<void> {
    return this.exclusive(async () => {
      const next = records.map((record) => assertSafeToStore(record));
      await this.writeAll(next);
    }, true);
  }

  public noteReferenced(key: string, at: string): Promise<void> {
    assertKey(key);
    return this.exclusive(async () => {
      const keys = await this.readReferenced();
      keys.add(key);
      await this.writeReferenced(keys, at);
    }, true);
  }

  public referencedKeys(): Promise<ReadonlySet<string>> {
    return this.exclusive(async () => this.readReferenced(), false);
  }

  /**
   * Reads do not create the directory, so a replay miss leaves the disk alone.
   * Writers create it, then take the lock.
   */
  private exclusive<T>(task: () => Promise<T>, write: boolean): Promise<T> {
    return enqueue(this.dir, async () => {
      const exists = await directoryExists(this.dir);
      if (!exists && !write) return task();
      await mkdir(this.dir, { recursive: true });
      return withLock(join(this.dir, ".locks"), task);
    });
  }

  private async readAll(): Promise<DecisionRecord[]> {
    const files = await walkJsonl(this.dir);
    const records: DecisionRecord[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new CacheError(
            `Invalid JSON in the decision cache at ${file}:${String(index + 1)}`,
          );
        }
        records.push(parseDecisionRecord(parsed));
      }
    }
    return records;
  }

  private async writeAll(records: readonly DecisionRecord[]): Promise<void> {
    const groups = new Map<string, DecisionRecord[]>();
    for (const record of records) {
      const group = groups.get(record.spec) ?? [];
      group.push(record);
      groups.set(record.spec, group);
    }
    const existing = await walkJsonl(this.dir);
    const written = new Set<string>();
    for (const [spec, group] of groups) {
      const file = specFile(this.dir, spec);
      written.add(file);
      await mkdir(dirname(file), { recursive: true });
      const body = `${group
        .slice()
        .sort(compareRecords)
        .map((record) => serialiseDecisionRecord(record))
        .join("\n")}\n`;
      await atomicWrite(file, body);
    }
    for (const file of existing) {
      if (!written.has(file)) await rm(file, { force: true });
    }
  }

  private async readReferenced(): Promise<Set<string>> {
    const file = join(this.dir, ".last-run.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return new Set();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CacheError("The decision cache last-run file is invalid JSON");
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["keys"])) {
      throw new CacheError("The decision cache last-run file is invalid");
    }
    const keys = new Set<string>();
    for (const key of parsed["keys"]) {
      if (typeof key !== "string") {
        throw new CacheError("The decision cache last-run file is invalid");
      }
      assertKey(key);
      keys.add(key);
    }
    return keys;
  }

  private async writeReferenced(
    keys: ReadonlySet<string>,
    at: string,
  ): Promise<void> {
    const body = `${JSON.stringify({
      v: 1,
      updatedAt: at,
      keys: [...keys].sort(),
    })}\n`;
    await atomicWrite(join(this.dir, ".last-run.json"), body);
  }
}

/** Relative spec path, safe to join under the cache directory. */
export function specFile(dir: string, spec: string): string {
  const normalised = spec.replaceAll("\\", "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) {
    throw new CacheError("Decision spec must be a relative path");
  }
  const parts = normalised.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new CacheError("Decision spec path is not safe to store");
  }
  const relative = `${parts.map((part) => encodeURIComponent(part)).join("/")}.jsonl`;
  const file = resolve(dir, relative);
  const root = resolve(dir);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new CacheError("Decision spec path escapes the cache directory");
  }
  return file;
}

function sameLine(a: DecisionRecord, b: DecisionRecord): boolean {
  return serialiseDecisionRecord(a) === serialiseDecisionRecord(b);
}

function assertKey(key: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(key)) {
    throw new CacheError("A cache key must be sha256: and 64 hex characters");
  }
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function withLock<T>(
  lockDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (await lockBusy(lockDir)) {
        if (Date.now() > deadline) {
          throw new CacheError("Timed out waiting for the decision cache lock");
        }
        await delay(20);
        continue;
      }
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(join(lockDir, "pid"), String(process.pid));
    return await task();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function lockBusy(lockDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(lockDir, "pid"), "utf8");
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
    const stat = await lstat(lockDir);
    return Date.now() - stat.mtimeMs < LOCK_FRESH_MS;
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrno(error, "EPERM");
  }
}

async function walkJsonl(dir: string): Promise<string[]> {
  if (!(await directoryExists(dir))) return [];
  const found: string[] = [];
  await walk(dir, found);
  found.sort();
  return found;
}

async function walk(current: string, found: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(full, found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await lstat(dir);
    return stat.isDirectory();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, body);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
