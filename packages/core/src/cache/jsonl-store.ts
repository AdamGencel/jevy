import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CacheError } from "../errors.js";
import { parseRecord, readRecordLine, serialiseRecord } from "./record.js";
import type { DecisionRecord } from "./record.js";
import type { DecisionStore } from "./store.js";

export interface JsonlDecisionStoreOptions {
  /** Root of the cache, for example `.jevy/decisions`. */
  readonly dir: string;
}

/**
 * The file operations the store needs. Node's file system is the only one the
 * package uses; the seam exists so tests can stand in a case-insensitive file
 * system on any machine. Paths are absolute.
 */
export interface CacheFileSystem {
  /**
   * Every file under `dir`, at any depth, relative to `dir` with `/` between
   * segments. A missing `dir` lists nothing.
   */
  list(dir: string): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  /** Append `text`, creating the file and its parent directories. */
  append(path: string, text: string): Promise<void>;
}

const NODE_FILE_SYSTEM: CacheFileSystem = {
  list: async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"),
      );
  },
  read: (path) => readFile(path, "utf8"),
  append: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, "utf8");
  },
};

const EXTENSION = ".jsonl";

interface SpecFile {
  readonly records: DecisionRecord[];
  /** False when the file's last line has no newline (edited by hand). */
  endsWithNewline: boolean;
}

interface Index {
  readonly specs: Map<string, SpecFile>;
  readonly latest: Map<string, DecisionRecord>;
}

/**
 * `JsonlDecisionStore` over any `CacheFileSystem`. Not exported from the
 * package: callers use `JsonlDecisionStore`, and tests use this to stand in
 * another file system.
 */
export class FileSystemJsonlStore implements DecisionStore {
  readonly #dir: string;
  readonly #files: CacheFileSystem;
  #index: Promise<Index> | undefined;
  #queue: Promise<void> = Promise.resolve();

  public constructor(
    options: JsonlDecisionStoreOptions,
    files: CacheFileSystem,
  ) {
    if (typeof options.dir !== "string" || options.dir.length === 0) {
      throw new CacheError("JsonlDecisionStore dir must be a non-empty path");
    }
    this.#dir = resolve(options.dir);
    this.#files = files;
  }

  public async latest(key: string): Promise<DecisionRecord | undefined> {
    const index = await this.#load();
    return index.latest.get(key);
  }

  public async forStep(
    spec: string,
    step: string,
  ): Promise<readonly DecisionRecord[]> {
    assertSpecPath(spec);
    const index = await this.#load();
    const records = index.specs.get(spec)?.records ?? [];
    return records.filter((record) => record.step === step);
  }

  public async list(spec?: string): Promise<readonly DecisionRecord[]> {
    const index = await this.#load();
    if (spec !== undefined) {
      assertSpecPath(spec);
      return [...(index.specs.get(spec)?.records ?? [])];
    }
    return sortedSpecs(index).flatMap((name) => [
      ...(index.specs.get(name)?.records ?? []),
    ]);
  }

  /**
   * Every record is validated and every spec path checked before anything is
   * written. Each spec's lines then go out in one write call. A batch that
   * spans several specs is one write per file, so a crash between files can
   * leave the earlier files written; each line is still whole.
   */
  public async append(records: readonly DecisionRecord[]): Promise<void> {
    const groups = new Map<string, string[]>();
    for (const record of records) {
      const line = serialiseRecord(record);
      assertSpecPath(record.spec);
      const lines = groups.get(record.spec) ?? [];
      lines.push(line);
      groups.set(record.spec, lines);
    }
    const run = this.#queue.then(() => this.#write(groups));
    this.#queue = run.catch(() => undefined);
    await run;
  }

  async #write(groups: ReadonlyMap<string, readonly string[]>): Promise<void> {
    const index = await this.#load();
    assertNoCaseClash([...groups.keys()], [...index.specs.keys()]);
    for (const [spec, lines] of groups) {
      const path = this.#pathFor(spec);
      const existing = index.specs.get(spec);
      const prefix =
        existing !== undefined && !existing.endsWithNewline ? "\n" : "";
      await this.#files.append(
        path,
        prefix + lines.map((line) => `${line}\n`).join(""),
      );
      const file = existing ?? { records: [], endsWithNewline: true };
      file.endsWithNewline = true;
      for (const line of lines) {
        const record = parseRecord(line);
        file.records.push(record);
        index.latest.set(record.key, record);
      }
      index.specs.set(spec, file);
    }
  }

  #load(): Promise<Index> {
    if (this.#index === undefined) {
      const loading = readIndex(this.#files, this.#dir);
      this.#index = loading;
      // A failed read is not cached, so fixing the file and asking again works.
      loading.catch(() => {
        if (this.#index === loading) this.#index = undefined;
      });
    }
    return this.#index;
  }

  /** Belt and braces: the spec was checked, and the result must stay in dir. */
  #pathFor(spec: string): string {
    const path = join(this.#dir, ...spec.split("/")) + EXTENSION;
    if (!path.startsWith(this.#dir + sep)) {
      throw new CacheError(`Spec path "${spec}" leaves the cache directory`);
    }
    return path;
  }
}

/**
 * One JSON Lines file per spec at `<dir>/<spec>.jsonl`, so a cache diff in a
 * pull request is grouped by the test file it belongs to.
 *
 * `latest(key)` is asked without a spec, and the key does not name one, so
 * the store reads every `.jsonl` file under `dir` once, on first use, and
 * keeps an in-memory index. The trade-off: memory and a first-call read that
 * grow with the whole cache, and a store that does not see files another
 * process writes after that first read. That fits one test run, which is a
 * single writer per directory; a long-lived or multi-process writer should
 * open a new store. Appends from one store are queued so they land in call
 * order.
 *
 * Within one file the last line for a key wins. Across files (the same key
 * recorded by two specs) the record with the later `createdAt` wins, because
 * the index cannot know which file was appended to last.
 */
export class JsonlDecisionStore extends FileSystemJsonlStore {
  public constructor(options: JsonlDecisionStoreOptions) {
    super(options, NODE_FILE_SYSTEM);
  }
}

/**
 * A spec names a file under the cache directory, so it must be a relative,
 * forward-slash path that cannot climb out: not empty or absolute, no `..`,
 * `.` or empty segment, no backslash and no NUL. Backslashes are refused
 * rather than converted, so one spec cannot be spelled two ways.
 */
export function assertSpecPath(spec: unknown): asserts spec is string {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new CacheError("Spec path must be a non-empty string");
  }
  if (spec.includes("\u0000")) {
    throw new CacheError("Spec path must not contain a NUL character");
  }
  if (spec.includes("\\")) {
    throw new CacheError(
      `Spec path "${spec}" must use forward slashes, not backslashes`,
    );
  }
  if (spec.startsWith("/") || /^[A-Za-z]:/.test(spec)) {
    throw new CacheError(`Spec path "${spec}" must be relative`);
  }
  for (const segment of spec.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new CacheError(
        `Spec path "${spec}" must not contain an empty, "." or ".." segment`,
      );
    }
  }
}

/**
 * Refuse a spec whose cache file name differs only by case (or Unicode
 * normalisation) from another spec's, in this batch or already in the store.
 * macOS and Windows treat the two names as one file by default, so both
 * specs' lines would land in it, and every later load would fail. Refusing
 * on every file system keeps a cache portable: one recorded on Linux still
 * opens on a Mac.
 */
function assertNoCaseClash(
  writing: readonly string[],
  existing: readonly string[],
): void {
  const seen = new Map<string, string>();
  for (const spec of [...existing, ...writing]) {
    const folded = foldCase(spec);
    const other = seen.get(folded);
    if (other !== undefined && other !== spec) {
      throw new CacheError(
        `Cannot record "${spec}": its cache file name and that of "${other}" differ only by case, and a case-insensitive file system (the default on macOS and Windows) would keep both in one file. Rename one of the two spec files.`,
      );
    }
    seen.set(folded, spec);
  }
}

/** How a case-insensitive file system compares two names. */
function foldCase(spec: string): string {
  return spec.normalize("NFC").toLowerCase();
}

async function readIndex(files: CacheFileSystem, dir: string): Promise<Index> {
  const index: Index = { specs: new Map(), latest: new Map() };
  for (const { spec, path } of await listJsonlFiles(files, dir)) {
    index.specs.set(spec, await readSpecFile(files, path, spec));
  }
  const all = sortedSpecs(index).flatMap(
    (spec) => index.specs.get(spec)?.records ?? [],
  );
  for (const record of all) {
    const current = index.latest.get(record.key);
    if (current === undefined || !isOlderFile(record, current)) {
      index.latest.set(record.key, record);
    }
  }
  return index;
}

/**
 * True when `record` comes from a different spec and is older than the
 * current winner. Within one spec, file order decides, so a later line wins.
 */
function isOlderFile(record: DecisionRecord, current: DecisionRecord): boolean {
  return record.spec !== current.spec && record.createdAt < current.createdAt;
}

async function listJsonlFiles(
  files: CacheFileSystem,
  dir: string,
): Promise<readonly { readonly spec: string; readonly path: string }[]> {
  const found: { spec: string; path: string }[] = [];
  for (const name of await files.list(dir)) {
    if (!name.endsWith(EXTENSION)) continue;
    const spec = name.slice(0, -EXTENSION.length);
    assertSpecPath(spec);
    found.push({ spec, path: join(dir, ...spec.split("/")) + EXTENSION });
  }
  return found.sort((a, b) => compareCodeUnits(a.spec, b.spec));
}

async function readSpecFile(
  files: CacheFileSystem,
  path: string,
  spec: string,
): Promise<SpecFile> {
  const text = await files.read(path);
  const lines = text.split("\n");
  const endsWithNewline = lines.at(-1) === "";
  if (endsWithNewline) lines.pop();
  const records: DecisionRecord[] = [];
  lines.forEach((raw, i) => {
    const where = `${path}:${String(i + 1)}`;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) {
      throw new CacheError(`${where}: empty line in a decision cache file`);
    }
    let record: DecisionRecord | undefined;
    try {
      record = readRecordLine(line);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new CacheError(`${where}: ${detail}`);
    }
    // A superseded record stays in the file, which is append-only, but is
    // never indexed: its key cannot match any key computed today.
    if (record === undefined) return;
    if (record.spec !== spec && foldCase(record.spec) === foldCase(spec)) {
      throw new CacheError(
        `${where}: this file holds records for "${spec}" and "${record.spec}", whose names differ only by case. A case-insensitive file system (the default on macOS and Windows) keeps both specs' records in one file. Rename one of the two spec files, and move its lines to a file of its own or delete them.`,
      );
    }
    if (record.spec !== spec) {
      throw new CacheError(
        `${where}: record spec "${record.spec}" does not match its file's spec "${spec}"`,
      );
    }
    records.push(record);
  });
  return { records, endsWithNewline };
}

function sortedSpecs(index: Index): string[] {
  return [...index.specs.keys()].sort(compareCodeUnits);
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
