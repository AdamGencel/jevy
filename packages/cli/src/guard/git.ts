import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILENAMES } from "./config-source.js";
import { GitError, GuardError } from "./errors.js";

/**
 * Access to the two versions of the repository. The analysis only sees this
 * interface, so it stays pure and is tested against an in-memory reader;
 * only the git implementation touches processes and the file system.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  readonly status: ChangeStatus;
  /** Repository-relative path in the head version (the old path when deleted). */
  readonly path: string;
  /** Path in the base version; equal to `path` unless renamed. */
  readonly oldPath: string;
  /**
   * Which side holds a submodule (a gitlink, mode 160000) at the path
   * rather than a file: there is no text to read on that side. Absent when
   * neither does.
   */
  readonly gitlink?: "base" | "head" | "both";
}

export interface RepoReader {
  changes(): Promise<readonly FileChange[]>;
  /**
   * Text of `path` in the base version. Only for a path the reader has said
   * is there: one `changes()` named on that side, or one `existsInBase`
   * answered true for. For any other path a reader may answer null or may
   * fail (the git reader fails, the in-memory one answers null), so a
   * caller that does not know asks `existsInBase` first.
   */
  readBase(path: string): Promise<string | null>;
  /**
   * Text of `path` in the head version, under the same contract as
   * `readBase`. Null is also the answer for a path `changes()` named that
   * has gone from the working tree since. A path that is there but is not
   * a file (a FIFO, a device) fails: reading it could wait for ever.
   */
  readHead(path: string): Promise<string | null>;
  /**
   * Whether `path` is a file in the base version. The read methods are for
   * paths the diff named; this is for a path that may not be there at all,
   * such as the Jevy config, where "absent" is an answer and not a failure.
   */
  existsInBase(path: string): Promise<boolean>;
  /**
   * Whether `path` is a file in the head version. Fails for a path that is
   * there but is neither a file, a symlink nor a directory.
   */
  existsInHead(path: string): Promise<boolean>;
}

/**
 * Parse `git diff --name-status -z` output. With `-z` paths are never quoted,
 * so names with tabs, quotes or non-ASCII characters come through unchanged.
 * A copy is reported as an added file: its source is still there.
 */
export function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split("\u0000");
  const changes: FileChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index] ?? "";
    if (status === "") {
      index += 1;
      continue;
    }
    const letter = status.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index + 1] ?? "";
      const path = tokens[index + 2] ?? "";
      changes.push(
        letter === "R"
          ? { status: "renamed", path, oldPath }
          : { status: "added", path, oldPath: path },
      );
      index += 3;
      continue;
    }
    const path = tokens[index + 1] ?? "";
    const kind: ChangeStatus =
      letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    changes.push({ status: kind, path, oldPath: path });
    index += 2;
  }
  return changes;
}

const GITLINK_MODE = "160000";

function gitlinkSide(
  oldMode: string | undefined,
  newMode: string | undefined,
): FileChange["gitlink"] {
  const base = oldMode === GITLINK_MODE;
  const head = newMode === GITLINK_MODE;
  if (base && head) {
    return "both";
  }
  if (base || head) {
    return base ? "base" : "head";
  }
  return undefined;
}

/**
 * Parse `git diff --raw -z` output: what `parseNameStatus` reads, plus the
 * modes, which say when a side is a submodule. Each entry is
 * `:<old mode> <new mode> <old id> <new id> <status>` and then one path, or
 * two for a rename or copy.
 */
export function parseRawDiff(output: string): FileChange[] {
  const tokens = output.split("\u0000");
  const changes: FileChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const meta = tokens[index] ?? "";
    if (!meta.startsWith(":")) {
      index += 1;
      continue;
    }
    const [oldMode, newMode, , , status = ""] = meta.slice(1).split(" ");
    const gitlink = gitlinkSide(oldMode, newMode);
    const link = gitlink === undefined ? {} : { gitlink };
    const letter = status.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index + 1] ?? "";
      const path = tokens[index + 2] ?? "";
      changes.push(
        letter === "R"
          ? { status: "renamed", path, oldPath, ...link }
          : { status: "added", path, oldPath: path, ...link },
      );
      index += 3;
      continue;
    }
    const path = tokens[index + 1] ?? "";
    const kind: ChangeStatus =
      letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    changes.push({ status: kind, path, oldPath: path, ...link });
    index += 2;
  }
  return changes;
}

/**
 * A reader over two in-memory snapshots, for tests. `renames` maps a new
 * path to its old path, as `git diff -M` would report it.
 */
export function memoryReader(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  renames: Readonly<Record<string, string>> = {},
): RepoReader {
  const base = new Map(Object.entries(before));
  const head = new Map(Object.entries(after));
  const renamedFrom = new Map(Object.entries(renames));
  const renamedOld = new Set(renamedFrom.values());
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const oldPath = renamedFrom.get(path);
    if (oldPath !== undefined) {
      changes.push({ status: "renamed", path, oldPath });
    } else if (renamedOld.has(path) && !head.has(path)) {
      continue;
    } else if (!head.has(path)) {
      changes.push({ status: "deleted", path, oldPath: path });
    } else if (!base.has(path)) {
      changes.push({ status: "added", path, oldPath: path });
    } else if (base.get(path) !== head.get(path)) {
      changes.push({ status: "modified", path, oldPath: path });
    }
  }
  return {
    changes: () => Promise.resolve(changes),
    readBase: (path) => Promise.resolve(base.get(path) ?? null),
    readHead: (path) => Promise.resolve(head.get(path) ?? null),
    existsInBase: (path) => Promise.resolve(base.has(path)),
    existsInHead: (path) => Promise.resolve(head.has(path)),
  };
}

/** One entry of `git ls-tree` output. */
interface TreeEntry {
  readonly mode: string;
  /** blob, tree or commit. */
  readonly type: string;
  readonly object: string;
  readonly path: string;
}

/** The entries of `git ls-tree -z` output. */
function treeEntries(output: string): readonly TreeEntry[] {
  return output.split("\u0000").flatMap((entry) => {
    // `<mode> <type> <object>\t<path>`: only the path can hold a tab.
    const tab = entry.indexOf("\t");
    if (tab === -1) {
      return [];
    }
    const [mode = "", type = "", object = ""] = entry.slice(0, tab).split(" ");
    return [{ mode, type, object, path: entry.slice(tab + 1) }];
  });
}

/** The entry `git ls-tree -z` output gives `path` itself, or null. */
function treeEntry(output: string, path: string): TreeEntry | null {
  return treeEntries(output).find((entry) => entry.path === path) ?? null;
}

/** The type `git ls-tree -z` output gives `path` itself: blob, tree, commit, or null. */
function treeEntryType(output: string, path: string): string | null {
  return treeEntry(output, path)?.type ?? null;
}

/**
 * Whether `git ls-tree -z` output lists `path` itself as a file. A symlink
 * counts (git stores it as a blob); a directory or a submodule does not.
 */
export function treeHasBlob(output: string, path: string): boolean {
  return treeEntryType(output, path) === "blob";
}

/**
 * Whether `git ls-files -s -z` output lists `path` itself as a file at stage
 * 0. A submodule does not count, and neither does an unmerged entry: its
 * stages are 1 to 3 and `:0:<path>` cannot be read.
 */
function indexHasBlob(output: string, path: string): boolean {
  return output.split("\u0000").some((entry) => {
    // `<mode> <object> <stage>\t<path>`.
    const tab = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, tab).split(" ");
    return (
      tab !== -1 &&
      entry.slice(tab + 1) === path &&
      mode !== "160000" &&
      stage === "0"
    );
  });
}

/**
 * The paths in `git ls-files -v -z` output that carry a flag telling git not
 * to look at the file: a lower-case tag is assume-unchanged, `S` is
 * skip-worktree, `s` is both. `git diff` reports no change for such a file
 * whatever is on disk.
 */
export function hiddenPaths(output: string): string[] {
  return output
    .split("\u0000")
    .filter((entry) => {
      const tag = entry.charAt(0);
      return (
        entry.charAt(1) === " " && (tag === "S" || tag !== tag.toUpperCase())
      );
    })
    .map((entry) => entry.slice(2));
}

const execFileAsync = promisify(execFile);

/** Big enough for any source file a test suite would hold. */
const MAX_BUFFER = 256 * 1024 * 1024;

function stderrOf(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim() !== ""
  ) {
    return error.stderr.trim().split("\n")[0] ?? "";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings given on every git command line, so that git runs no program
 * the repository configures and trusts no cache an agent could forge:
 * - `core.fsmonitor`: a program git asks which files changed. It runs
 *   repository code, and by answering "none" it hides any edit.
 * - `core.hooksPath`: a directory with no hooks in it. No command the guard
 *   runs should start a hook, but `git diff` can rewrite the index, and
 *   writing the index starts `post-index-change`.
 * - `core.untrackedCache`: a record in the index of which directories
 *   hold no untracked files, which an agent could forge.
 * Clean and smudge filters are switched off per repository (see
 * `filterSettings`); `diff.external` by `--no-ext-diff`; textconv only runs
 * for patches, which the guard never asks for.
 */
const SAFE_SETTINGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.untrackedCache=false",
];

/**
 * Run git with an argument array: no shell, so refs and paths are never
 * interpreted, and with pathspecs taken literally. `settings` go before
 * the command (see `SAFE_SETTINGS`). Callers reject refs that start with
 * `-` before getting here.
 * Rejects with whatever `execFile` rejects with.
 */
async function execGit(
  args: readonly string[],
  cwd: string,
  settings: readonly string[] = SAFE_SETTINGS,
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...settings, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      // A path given to git is a path. Without this a leading `:` is
      // pathspec magic and `*` a wildcard, so `:x/jevy.config.ts` would name
      // some other file or none.
      GIT_LITERAL_PATHSPECS: "1",
      // `git replace` makes one commit read as another everywhere. An agent
      // could replace the base with a commit that already holds its change.
      GIT_NO_REPLACE_OBJECTS: "1",
      // Nothing the guard runs needs to write the index.
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  return stdout;
}

/** `execGit`, with any failure turned into a `GitError`. */
async function git(
  args: readonly string[],
  cwd: string,
  settings: readonly string[] = SAFE_SETTINGS,
): Promise<string> {
  try {
    return await execGit(args, cwd, settings);
  } catch (error) {
    throw new GitError(`git ${args[0] ?? ""} failed: ${stderrOf(error)}`);
  }
}

/** Git, run in one repository with one set of settings. */
interface Git {
  /** The output, or a `GitError`. */
  readonly run: (args: readonly string[]) => Promise<string>;
  /** The output, or whatever `execFile` rejects with. */
  readonly exec: (args: readonly string[]) => Promise<string>;
}

function gitIn(root: string, settings: readonly string[]): Git {
  return {
    run: (args) => git(args, root, settings),
    exec: (args) => execGit(args, root, settings),
  };
}

/**
 * The names of the filter drivers git's config defines, in `git config -z
 * --get-regexp` output (`filter.<name>.<key>\n<value>` entries).
 */
export function filterNames(output: string): readonly string[] {
  const names = new Set<string>();
  for (const entry of output.split("\u0000")) {
    const key = entry.split("\n")[0] ?? "";
    const last = key.lastIndexOf(".");
    if (key.startsWith("filter.") && last > "filter.".length) {
      names.add(key.slice("filter.".length, last));
    }
  }
  return [...names];
}

/**
 * Settings that switch off every filter driver git's config defines. A
 * clean filter is a program git runs on a working-tree file before it
 * compares it, so it runs repository code and can make an edited file read
 * as the committed one. Off, git compares the bytes on disk; a file stored
 * through a filter (git-lfs) then reads as changed, which is the safe side.
 * A driver that is not configured does nothing, so only configured ones
 * need this. A name `-c` cannot carry (one with `=`) is refused.
 */
async function filterSettings(root: string): Promise<readonly string[]> {
  let output = "";
  try {
    output = await execGit(
      ["config", "-z", "--get-regexp", "^filter\\."],
      root,
    );
  } catch (error) {
    // `git config --get-regexp` exits 1 when nothing matches.
    if (codeOf(error) !== 1) {
      throw new GitError(`git config failed: ${stderrOf(error)}`);
    }
  }
  return filterNames(output).flatMap((name) => {
    if (name.includes("=")) {
      throw new GitError(
        `the filter driver "${name}" has a name with "=" in it, so the guard cannot switch it off for its own run. Rename the driver and run again.`,
      );
    }
    return ["clean=", "smudge=", "process=", "required=false"].flatMap(
      (setting) => ["-c", `filter.${name}.${setting}`],
    );
  });
}

/** The `code` of a failed file-system call or child process, if it has one. */
function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "EISDIR";
}

/**
 * The commit `base` and `head` both descend from. `git merge-base` exits 1,
 * printing nothing, when there is none; that also happens in a shallow clone
 * whose history stops before the two meet, so the message says which it is.
 */
async function findMergeBase(
  repo: Git,
  base: string,
  head: string,
): Promise<string> {
  try {
    return (await repo.exec(["merge-base", base, head])).trim();
  } catch (error) {
    if (codeOf(error) !== 1) {
      throw new GitError(`git merge-base failed: ${stderrOf(error)}`);
    }
  }
  const shallow =
    (await repo.run(["rev-parse", "--is-shallow-repository"])).trim() ===
    "true";
  throw new GitError(
    `--merge-base found no common ancestor of '${base}' and '${head}'. ${
      shallow
        ? "This is a shallow clone, so the history stops before they meet: fetch the full history (git fetch --unshallow) and run again."
        : "If part of the history was never fetched, fetch it in full (git fetch --unshallow) and run again; if the two are unrelated, run without --merge-base."
    }`,
  );
}

export interface GitReaderOptions {
  /** Any directory inside the repository. */
  readonly cwd: string;
  readonly base: string;
  /** A ref, or undefined to read the working tree. */
  readonly head: string | undefined;
  /**
   * Compare against the common ancestor of `base` and `head` (of `base` and
   * HEAD when reading the working tree), not the tip of `base`. Otherwise a
   * test added to the target branch after a pull request branched looks
   * like a test the pull request removed.
   */
  readonly mergeBase?: boolean;
}

export interface GitRepo {
  readonly root: string;
  readonly reader: RepoReader;
  /** Full hash of the commit compared against, when `mergeBase` was asked for. */
  readonly mergeBase?: string;
  /**
   * Base against the index, when `reader` reads the working tree; absent
   * when two commits are compared. What is staged is what the next commit
   * holds, whatever is on disk: a weakening that is added and then undone
   * on disk is in no working-tree diff and would be committed unseen.
   */
  readonly index?: RepoReader;
  /**
   * Fails when git cannot vouch for `dir`, the directory the guard runs in
   * (repository-relative, "" for the root): git knows it under another
   * spelling; the config the guard would read there is a symbolic link; or,
   * when the working tree is read, it holds a Jevy config that git ignores
   * and that the loader would read before the one git reports. Each way the
   * guard would take its settings from something no diff shows. Absent for
   * a repository not read through git.
   */
  readonly checkDirectory?: (dir: string) => Promise<void>;
  /**
   * `reader`, made not to rely on git's own change detection for the files
   * the guard cares about; only when the working tree is read. Git decides
   * a file is unchanged from its timestamps and size, or from a monitor
   * program, and an agent can forge either. This compares the bytes on disk
   * of every base file `watched.matters` names with the base blob itself,
   * and reports a difference as a change whether or not git listed it. It
   * also lists, as added, the files git ignores that `watched.isTest`
   * names: Playwright and Vitest run an ignored test file all the same.
   */
  readonly watch?: (watched: Watched) => RepoReader;
}

/** What the guard compares or protects, for `GitRepo.watch`. */
export interface Watched {
  /** Whether a change at this repository-relative path is one the guard reports. */
  readonly matters: (path: string) => boolean;
  /** Whether a file at this path would be compared as a test. */
  readonly isTest: (path: string) => boolean;
}

/** A full object id: git reads it as one before it looks for a ref. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** The ref name a revision starts with: `main` for `main~2` and `main^{tree}`. */
function refNameOf(revision: string): string {
  return revision.split(/[~^:]|@\{/)[0] ?? "";
}

/** The refs a short name can mean, in the order git tries them (gitrevisions(7)). */
function candidateRefs(name: string): readonly string[] {
  return [
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
}

/** "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** The commit each revision names, or null when one of them names none. */
async function commitsOf(
  repo: Git,
  revisions: readonly string[],
): Promise<readonly string[] | null> {
  try {
    const output = await repo.exec([
      "rev-parse",
      ...revisions.map((revision) => `${revision}^{commit}`),
    ]);
    return output.trim().split("\n");
  } catch {
    return null;
  }
}

/** A name git may read as the start of an object id. */
const SHORT_ID = /^[0-9a-f]{4,}$/i;

/**
 * The commits the objects whose id starts with `prefix` stand for: a
 * commit itself, or what a tag points at. Blobs and trees name no commit.
 */
async function commitsByPrefix(
  repo: Git,
  prefix: string,
): Promise<readonly string[]> {
  let objects: readonly string[];
  try {
    objects = (await repo.exec(["rev-parse", `--disambiguate=${prefix}`]))
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
  const commits: string[] = [];
  for (const object of objects) {
    const commit = (await commitsOf(repo, [object]))?.[0];
    if (commit !== undefined && !commits.includes(commit)) {
      commits.push(commit);
    }
  }
  return commits;
}

/**
 * Fail when `name` is both the start of a commit id and a ref on another
 * commit. Git takes the ref and says nothing, so whoever can create a
 * branch can make `--base <short id>` mean their own commit.
 */
async function checkShortId(
  repo: Git,
  name: string,
  found: readonly string[],
): Promise<void> {
  if (!SHORT_ID.test(name)) {
    return;
  }
  const refCommits = (await commitsOf(repo, found)) ?? [];
  const others = (await commitsByPrefix(repo, name)).filter(
    (commit) => !refCommits.includes(commit),
  );
  if (others.length > 0) {
    throw new GitError(
      `'${name}' is ambiguous: it is the start of the commit id ${listed(others)}, and it also names ${listed(found)}, which points at another commit. Pass the full commit id or the full ref name.`,
    );
  }
}

/** Why `name` is ambiguous, given the refs of that name and their commits. */
function ambiguity(
  name: string,
  found: readonly string[],
  commits: readonly string[] | null,
): string | null {
  const [resolved, ...targets] = commits ?? [];
  const names = `it names ${listed(found)}`;
  if (commits === null) {
    return `${names}, which do not all point at a commit. Pass one of them in full.`;
  }
  if (targets.some((commit) => commit !== targets[0])) {
    return `${names}, which point at different commits. Pass one of them in full.`;
  }
  // Git also tries the name as a file in its own directory, before any ref.
  return targets[0] === resolved
    ? null
    : `git does not resolve it to ${listed(found)} but to another commit, which a file of that name in the git directory can cause. Pass the full ref name.`;
}

/**
 * Fail when `revision` starts with a short name that more than one ref
 * answers to, on different commits. Git picks the first in its lookup order
 * and only warns on stderr, so whoever can create a ref can swap the
 * commit a name stands for: with a tag called `origin/main`, `--base
 * origin/main` is the tag. The same goes for a short commit id that a
 * branch takes as its name (see `checkShortId`). A full ref name
 * (`refs/...`) and a full commit id are never ambiguous.
 */
async function checkUnambiguous(repo: Git, revision: string): Promise<void> {
  const name = refNameOf(revision);
  if (name === "" || name.startsWith("refs/") || OBJECT_ID.test(name)) {
    return;
  }
  const candidates = candidateRefs(name);
  // The names are patterns to `for-each-ref`, and one also matches what is
  // below it, so keep the exact names only.
  const existing = new Set(
    (
      await repo.run(["for-each-ref", "--format=%(refname)", ...candidates])
    ).split("\n"),
  );
  const found = candidates.filter((candidate) => existing.has(candidate));
  if (found.length === 0) {
    return;
  }
  await checkShortId(repo, name, found);
  const why = ambiguity(name, found, await commitsOf(repo, [name, ...found]));
  if (why !== null) {
    throw new GitError(`'${name}' is ambiguous: ${why}`);
  }
}

/** How many hidden paths the message names before it counts the rest. */
const MAX_HIDDEN_LISTED = 10;

/**
 * Fail when the index tells git not to look at a file. `git diff` trusts
 * the flag, so a weakened test marked assume-unchanged or skip-worktree is
 * in no diff. A sparse checkout sets skip-worktree for good reasons, but
 * the guard cannot tell those from a file hidden on purpose.
 */
async function checkNothingHidden(repo: Git): Promise<void> {
  const hidden = hiddenPaths(await repo.run(["ls-files", "-v", "-z"]));
  if (hidden.length === 0) {
    return;
  }
  const more = hidden.length - MAX_HIDDEN_LISTED;
  throw new GitError(
    `the guard cannot check a working tree with hidden files. Git is told not to look at these (assume-unchanged or skip-worktree, which a sparse checkout also sets): ${hidden
      .slice(0, MAX_HIDDEN_LISTED)
      .join(
        ", ",
      )}${more > 0 ? ` and ${String(more)} more` : ""}. Clear the flags (git update-index --no-assume-unchanged --no-skip-worktree <path>), or compare commits with --head HEAD.`,
  );
}

function kindOf(stats: Stats): string {
  if (stats.isFIFO()) {
    return "a FIFO";
  }
  if (stats.isSocket()) {
    return "a socket";
  }
  return stats.isCharacterDevice() || stats.isBlockDevice()
    ? "a device"
    : "of an unknown kind";
}

/**
 * What is at a working-tree path, as far as reading goes. A directory is
 * "absent": no file is there. Anything else that is not a file or a symlink
 * fails, and is never opened: reading a FIFO waits until someone writes to
 * it, which nobody may ever do.
 */
async function onDisk(
  root: string,
  path: string,
): Promise<"file" | "symlink" | "absent"> {
  let stats: Stats;
  try {
    stats = await lstat(join(root, path));
  } catch (error) {
    // ENOTDIR: a parent of the path is a file.
    if (isMissing(error) || codeOf(error) === "ENOTDIR") {
      return "absent";
    }
    throw error;
  }
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "absent";
  }
  throw new GuardError(
    `${path} is not a regular file (it is ${kindOf(stats)}), so the guard cannot read it`,
  );
}

async function readWorkingTree(
  root: string,
  path: string,
): Promise<string | null> {
  const kind = await onDisk(root, path);
  if (kind === "absent") {
    return null;
  }
  const file = join(root, path);
  try {
    // Git stores a symlink as its target path; read it the same way so the
    // working tree compares like a commit and nothing outside the
    // repository is read.
    return kind === "symlink"
      ? await readlink(file, "utf8")
      : await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

/** The names core's loader tries, in any case: some disks ignore it. */
const CONFIG_NAME = /^jevy\.config\.(ts|mts|js|mjs)$/i;

/**
 * Where a config name comes in the loader's order (`CONFIG_FILENAMES`),
 * whatever its case; a name that is not a config comes last.
 */
function loadRank(name: string): number {
  const rank = CONFIG_FILENAMES.findIndex(
    (known) => known === name.toLowerCase(),
  );
  return rank === -1 ? CONFIG_FILENAMES.length : rank;
}

/** The Jevy config files in a directory on disk, by name; none if it is gone. */
async function configsOnDisk(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => CONFIG_NAME.test(entry.name) && !entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error) || codeOf(error) === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

/**
 * `text` as a disk that ignores case and Unicode form compares it; the same
 * folding `protect.ts` uses. It errs towards calling two names the same.
 */
function fold(text: string): string {
  return text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * The directory at the start of `path` that is `folded` in some spelling,
 * or null. `folded` is a directory's segments, each one folded.
 */
function spelledAs(folded: readonly string[], path: string): string | null {
  const lead = path.split("/").slice(0, folded.length);
  return path.split("/").length > folded.length &&
    lead.every((part, index) => fold(part) === folded[index])
    ? lead.join("/")
    : null;
}

function nulSeparated(output: string): string[] {
  return output.split("\u0000").filter((path) => path !== "");
}

/** Run `make` once, however often the result is asked for. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

/**
 * `--raw` for the modes, which say when a path is a submodule.
 * `--ignore-submodules=dirty` compares the commit a submodule is at and
 * never looks inside it: that would run git in the submodule, under a
 * config of its own. It also overrides any `ignore` setting that would hide
 * a submodule whose commit changed.
 */
const DIFF = [
  "diff",
  "--raw",
  "-M",
  "-z",
  "--no-color",
  "--no-ext-diff",
  "--ignore-submodules=dirty",
];
const UNTRACKED = ["ls-files", "--others", "--exclude-standard", "-z"];
const IGNORED = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "-z",
];

/**
 * An untracked path from `git ls-files --others` as a change. A path that
 * ends in `/` is a repository nested inside this one, which git does not
 * look into: a submodule in all but name.
 */
function untrackedChange(path: string): FileChange {
  return path.endsWith("/")
    ? {
        status: "added",
        path: path.slice(0, -1),
        oldPath: path.slice(0, -1),
        gitlink: "head",
      }
    : { status: "added", path, oldPath: path };
}

/** Bytes with every CRLF made LF, as git stores text with `core.autocrlf`. */
function withoutCarriageReturns(bytes: Buffer): Buffer {
  return Buffer.from(
    bytes.toString("latin1").replaceAll("\r\n", "\n"),
    "latin1",
  );
}

/** The id git gives a blob holding `bytes`, in the repository's hash. */
function blobId(format: string, bytes: Buffer): string {
  return createHash(format === "sha256" ? "sha256" : "sha1")
    .update(`blob ${String(bytes.length)}\u0000`)
    .update(bytes)
    .digest("hex");
}

const SYMLINK_MODE = "120000";

/**
 * How the working tree holds a base file, judged by its bytes alone: the
 * same, modified, or deleted. A text file checked out with CRLF line ends
 * is the same. A FIFO or device where the file was fails (see `onDisk`).
 */
async function stateOnDisk(
  root: string,
  entry: TreeEntry,
  format: string,
): Promise<"same" | "modified" | "deleted"> {
  const kind = await onDisk(root, entry.path);
  if (kind === "absent") {
    return "deleted";
  }
  if ((kind === "symlink") !== (entry.mode === SYMLINK_MODE)) {
    return "modified";
  }
  const file = join(root, entry.path);
  let bytes: Buffer;
  try {
    bytes =
      kind === "symlink"
        ? await readlink(file, { encoding: "buffer" })
        : await readFile(file);
  } catch (error) {
    if (isMissing(error)) {
      return "deleted";
    }
    throw error;
  }
  return blobId(format, bytes) === entry.object ||
    (kind === "file" &&
      blobId(format, withoutCarriageReturns(bytes)) === entry.object)
    ? "same"
    : "modified";
}

/**
 * Open the repository around `cwd`. Every ref is checked to name a commit
 * first, so a typo is a clear error rather than an empty diff, and to name
 * only one (see `checkUnambiguous`). When the working tree is read, the
 * index must hide no file from git (see `checkNothingHidden`).
 */
export async function openGitRepo(options: GitReaderOptions): Promise<GitRepo> {
  const root = (
    await git(["rev-parse", "--show-toplevel"], options.cwd)
  ).trim();
  const repo = gitIn(root, [...SAFE_SETTINGS, ...(await filterSettings(root))]);
  const run = repo.run;
  const refs =
    options.head === undefined ? [options.base] : [options.base, options.head];
  for (const ref of refs) {
    try {
      await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      throw new GitError(`unknown revision '${ref}'`);
    }
    await checkUnambiguous(repo, ref);
  }
  const { head } = options;
  if (head === undefined) {
    await checkNothingHidden(repo);
  }
  const mergeBase =
    options.mergeBase === true
      ? await findMergeBase(repo, options.base, head ?? "HEAD")
      : undefined;
  const base = mergeBase ?? options.base;

  const untracked = async (): Promise<string[]> =>
    nulSeparated(await run(UNTRACKED));

  const changes = once(async (): Promise<readonly FileChange[]> => {
    const tracked = parseRawDiff(
      await run([...DIFF, base, ...(head === undefined ? [] : [head]), "--"]),
    );
    if (head !== undefined) {
      return tracked;
    }
    // `git diff <base>` does not list untracked files. An agent's new test
    // file or new decision record is exactly what must not be missed.
    return [...tracked, ...(await untracked()).map(untrackedChange)];
  });

  // `cat-file` rather than `show`: plumbing applies no textconv driver or
  // other repository-configured filter, so the bytes are the committed ones.
  // A failure is an error, never "file absent": the diff already said the
  // file exists, and treating a failed read as absent would hide weakening.
  const readRef = (ref: string, path: string): Promise<string> =>
    run(["cat-file", "blob", `${ref}:${path}`]);

  // `ls-tree` rather than trying to read: it exits 0 with no output when
  // the path is absent, so absence and a git failure stay apart. The path
  // is taken literally, never as a pattern (see `execGit`).
  const lsTree = (ref: string, path: string): Promise<string> =>
    run(["ls-tree", "-z", "--full-tree", ref, "--", path]);
  const existsAt = async (ref: string, path: string): Promise<boolean> =>
    treeHasBlob(await lsTree(ref, path), path);

  const existsInBase = (path: string): Promise<boolean> => existsAt(base, path);
  const readBase = (path: string): Promise<string> => readRef(base, path);

  const index: RepoReader = {
    // Unmerged paths are left out (`--diff-filter=u`): they have no staged
    // version to read, and nothing can be committed while they are there.
    changes: once(async () =>
      parseRawDiff(
        await run([...DIFF, "--cached", "--diff-filter=u", base, "--"]),
      ),
    ),
    existsInBase,
    readBase,
    existsInHead: async (path) =>
      indexHasBlob(await run(["ls-files", "-s", "-z", "--", path]), path),
    // `:0:` and not `:`: a path that starts `1:` would read as stage 1.
    readHead: (path) => run(["cat-file", "blob", `:0:${path}`]),
  };

  /** Fail when git knows `dir` (not the root) under another spelling. */
  const checkSpelling = async (dir: string): Promise<void> => {
    if (treeEntryType(await lsTree(base, dir), dir) === "tree") {
      return;
    }
    const allFiles = ["ls-tree", "-r", "-z", "--name-only", "--full-tree"];
    const known = [
      ...nulSeparated(await run([...allFiles, base])),
      ...(head === undefined
        ? []
        : nulSeparated(await run([...allFiles, head]))),
      ...nulSeparated(await run(["ls-files", "-z"])),
      ...(await untracked()),
    ];
    if (known.some((path) => path.startsWith(`${dir}/`))) {
      return;
    }
    const folded = dir.split("/").map(fold);
    for (const path of known) {
      const other = spelledAs(folded, path);
      if (other !== null) {
        // On a disk that ignores case the directory opens under either
        // name, but git's paths carry only one: under the other, no config
        // is found and no glob matches.
        throw new GitError(
          `the directory the guard runs in is "${dir}" on disk, but git knows it as "${other}", so the guard cannot tell which files are in it. Give the two the same spelling (rename the directory back, or rename it in git with git mv) and run again.`,
        );
      }
    }
  };

  /**
   * Fail when `dir` holds a Jevy config on disk that is neither in base nor
   * in the changes (git ignores it) and that the loader tries no later than
   * the first config git does report. The loader would run it, yet no diff
   * will ever show it. One the loader never reaches, such as a compiled
   * `jevy.config.js` beside a tracked `jevy.config.ts`, is left alone.
   */
  const checkConfigsSeen = async (dir: string): Promise<void> => {
    const onDiskNames = await configsOnDisk(join(root, dir));
    const unseen: string[] = [];
    let firstSeen: number = CONFIG_FILENAMES.length;
    for (const name of onDiskNames) {
      const path = dir === "" ? name : `${dir}/${name}`;
      const seen =
        (await existsInBase(path)) ||
        (await changes()).some((change) => change.path === path);
      if (seen) {
        firstSeen = Math.min(firstSeen, loadRank(name));
      } else {
        unseen.push(path);
      }
    }
    const shadowing = unseen.find(
      (path) => loadRank(path.slice(path.lastIndexOf("/") + 1)) <= firstSeen,
    );
    if (shadowing !== undefined) {
      throw new GitError(
        `${shadowing} is on disk but git does not report it: git ignores it, or knows it under another spelling. The guard cannot see changes to a config git ignores. Stop ignoring the file (or remove it) and run again.`,
      );
    }
  };

  /** The mode of `path` at `ref`, or null when it holds no file there. */
  const modeAt = async (ref: string, path: string): Promise<string | null> => {
    const entry = treeEntry(await lsTree(ref, path), path);
    return entry?.type === "blob" ? entry.mode : null;
  };

  /**
   * Whether the config at `path` on the side the guard reads is a symbolic
   * link, or null when that side has no config there.
   */
  const linkAt = async (
    side: "base" | "head",
    path: string,
  ): Promise<boolean | null> => {
    if (side === "head" && head === undefined) {
      const kind = await onDisk(root, path);
      return kind === "absent" ? null : kind === "symlink";
    }
    const mode = await modeAt(side === "base" ? base : (head ?? base), path);
    return mode === null ? null : mode === SYMLINK_MODE;
  };

  /**
   * Fail when the config the guard would read in `dir` is a symbolic link.
   * Git stores a link as its target's path, so its text is not the
   * config's, and the file it points to can change while the link does not.
   */
  const checkConfigNotLink = async (dir: string): Promise<void> => {
    for (const side of ["base", "head"] as const) {
      for (const name of CONFIG_FILENAMES) {
        const path = dir === "" ? name : `${dir}/${name}`;
        const link = await linkAt(side, path);
        if (link === true) {
          throw new GitError(
            `${path} is a symbolic link. The guard reads the config as a file, not through a link, because the file a link points to can change while the link does not. Commit the config itself in this directory and run again.`,
          );
        }
        if (link === false) {
          return;
        }
      }
    }
  };

  /**
   * Base files that `watched.matters` names and whose bytes on disk differ
   * from the base blob though git listed no change; then ignored files that
   * `watched.isTest` names, as added.
   */
  const unseenChanges = async (
    watched: Watched,
    listed: readonly FileChange[],
  ): Promise<readonly FileChange[]> => {
    const known = new Set(
      listed.flatMap((change) => [change.path, change.oldPath]),
    );
    const format = (await run(["rev-parse", "--show-object-format"])).trim();
    const out: FileChange[] = [];
    const entries = treeEntries(
      await run(["ls-tree", "-r", "-z", "--full-tree", base]),
    );
    for (const entry of entries) {
      if (
        entry.type !== "blob" ||
        known.has(entry.path) ||
        !watched.matters(entry.path)
      ) {
        continue;
      }
      const state = await stateOnDisk(root, entry, format);
      if (state !== "same") {
        out.push({ status: state, path: entry.path, oldPath: entry.path });
      }
    }
    for (const path of nulSeparated(await run(IGNORED))) {
      if (!path.endsWith("/") && !known.has(path) && watched.isTest(path)) {
        out.push({ status: "added", path, oldPath: path });
      }
    }
    return out;
  };

  const reader: RepoReader = {
    changes,
    existsInBase,
    existsInHead: async (path) =>
      head === undefined
        ? (await onDisk(root, path)) !== "absent"
        : existsAt(head, path),
    readBase,
    readHead: (path) =>
      head === undefined ? readWorkingTree(root, path) : readRef(head, path),
  };

  return {
    root,
    ...(mergeBase === undefined ? {} : { mergeBase }),
    ...(head === undefined
      ? {
          index,
          watch: (watched: Watched): RepoReader => ({
            ...reader,
            changes: once(async () => {
              const listed = await changes();
              return [...listed, ...(await unseenChanges(watched, listed))];
            }),
          }),
        }
      : {}),
    checkDirectory: async (dir) => {
      if (dir !== "") {
        await checkSpelling(dir);
      }
      await checkConfigNotLink(dir);
      if (head === undefined) {
        await checkConfigsSeen(dir);
      }
    },
    reader,
  };
}
