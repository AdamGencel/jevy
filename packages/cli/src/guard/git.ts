import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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

/** The type `git ls-tree -z` output gives `path` itself: blob, tree, commit, or null. */
function treeEntryType(output: string, path: string): string | null {
  for (const entry of output.split("\u0000")) {
    // `<mode> <type> <object>\t<path>`: only the path can hold a tab.
    const tab = entry.indexOf("\t");
    if (tab !== -1 && entry.slice(tab + 1) === path) {
      return entry.slice(0, tab).split(" ")[1] ?? null;
    }
  }
  return null;
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
 * Run git with an argument array: no shell, so refs and paths are never
 * interpreted, and with pathspecs taken literally. Callers reject refs that
 * start with `-` before getting here.
 * Rejects with whatever `execFile` rejects with.
 */
async function execGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
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
    },
  });
  return stdout;
}

/** `execGit`, with any failure turned into a `GitError`. */
async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await execGit(args, cwd);
  } catch (error) {
    throw new GitError(`git ${args[0] ?? ""} failed: ${stderrOf(error)}`);
  }
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
  root: string,
  base: string,
  head: string,
): Promise<string> {
  try {
    return (await execGit(["merge-base", base, head], root)).trim();
  } catch (error) {
    if (codeOf(error) !== 1) {
      throw new GitError(`git merge-base failed: ${stderrOf(error)}`);
    }
  }
  const shallow =
    (await git(["rev-parse", "--is-shallow-repository"], root)).trim() ===
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
   * spelling, or, when the working tree is read, it holds a Jevy config
   * that git ignores. Either way the guard would take its settings from
   * something no diff shows. Absent for a repository not read through git.
   */
  readonly checkDirectory?: (dir: string) => Promise<void>;
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
  root: string,
  revisions: readonly string[],
): Promise<readonly string[] | null> {
  try {
    const output = await execGit(
      ["rev-parse", ...revisions.map((revision) => `${revision}^{commit}`)],
      root,
    );
    return output.trim().split("\n");
  } catch {
    return null;
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
 * origin/main` is the tag. A full ref name (`refs/...`) and a full commit
 * id are never ambiguous.
 */
async function checkUnambiguous(root: string, revision: string): Promise<void> {
  const name = refNameOf(revision);
  if (name === "" || name.startsWith("refs/") || OBJECT_ID.test(name)) {
    return;
  }
  const candidates = candidateRefs(name);
  // The names are patterns to `for-each-ref`, and one also matches what is
  // below it, so keep the exact names only.
  const existing = new Set(
    (
      await git(["for-each-ref", "--format=%(refname)", ...candidates], root)
    ).split("\n"),
  );
  const found = candidates.filter((candidate) => existing.has(candidate));
  if (found.length === 0) {
    return;
  }
  const why = ambiguity(name, found, await commitsOf(root, [name, ...found]));
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
async function checkNothingHidden(root: string): Promise<void> {
  const hidden = hiddenPaths(await git(["ls-files", "-v", "-z"], root));
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

const DIFF = [
  "diff",
  "--name-status",
  "-M",
  "-z",
  "--no-color",
  "--no-ext-diff",
];
const UNTRACKED = ["ls-files", "--others", "--exclude-standard", "-z"];

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
  const refs =
    options.head === undefined ? [options.base] : [options.base, options.head];
  for (const ref of refs) {
    try {
      await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
    } catch {
      throw new GitError(`unknown revision '${ref}'`);
    }
    await checkUnambiguous(root, ref);
  }
  const { head } = options;
  if (head === undefined) {
    await checkNothingHidden(root);
  }
  const mergeBase =
    options.mergeBase === true
      ? await findMergeBase(root, options.base, head ?? "HEAD")
      : undefined;
  const base = mergeBase ?? options.base;

  const untracked = async (): Promise<string[]> =>
    nulSeparated(await git(UNTRACKED, root));

  const changes = once(async (): Promise<readonly FileChange[]> => {
    const tracked = parseNameStatus(
      await git(
        [...DIFF, base, ...(head === undefined ? [] : [head]), "--"],
        root,
      ),
    );
    if (head !== undefined) {
      return tracked;
    }
    // `git diff <base>` does not list untracked files. An agent's new test
    // file or new decision record is exactly what must not be missed.
    const added = (await untracked()).map((path): FileChange => ({
      status: "added",
      path,
      oldPath: path,
    }));
    return [...tracked, ...added];
  });

  // `cat-file` rather than `show`: plumbing applies no textconv driver or
  // other repository-configured filter, so the bytes are the committed ones.
  // A failure is an error, never "file absent": the diff already said the
  // file exists, and treating a failed read as absent would hide weakening.
  const readRef = (ref: string, path: string): Promise<string> =>
    git(["cat-file", "blob", `${ref}:${path}`], root);

  // `ls-tree` rather than trying to read: it exits 0 with no output when
  // the path is absent, so absence and a git failure stay apart. The path
  // is taken literally, never as a pattern (see `execGit`).
  const lsTree = (ref: string, path: string): Promise<string> =>
    git(["ls-tree", "-z", "--full-tree", ref, "--", path], root);
  const existsAt = async (ref: string, path: string): Promise<boolean> =>
    treeHasBlob(await lsTree(ref, path), path);

  const existsInBase = (path: string): Promise<boolean> => existsAt(base, path);
  const readBase = (path: string): Promise<string> => readRef(base, path);

  const index: RepoReader = {
    // Unmerged paths are left out (`--diff-filter=u`): they have no staged
    // version to read, and nothing can be committed while they are there.
    changes: once(async () =>
      parseNameStatus(
        await git([...DIFF, "--cached", "--diff-filter=u", base, "--"], root),
      ),
    ),
    existsInBase,
    readBase,
    existsInHead: async (path) =>
      indexHasBlob(await git(["ls-files", "-s", "-z", "--", path], root), path),
    // `:0:` and not `:`: a path that starts `1:` would read as stage 1.
    readHead: (path) => git(["cat-file", "blob", `:0:${path}`], root),
  };

  /** Fail when git knows `dir` (not the root) under another spelling. */
  const checkSpelling = async (dir: string): Promise<void> => {
    if (treeEntryType(await lsTree(base, dir), dir) === "tree") {
      return;
    }
    const allFiles = ["ls-tree", "-r", "-z", "--name-only", "--full-tree"];
    const known = [
      ...nulSeparated(await git([...allFiles, base], root)),
      ...(head === undefined
        ? []
        : nulSeparated(await git([...allFiles, head], root))),
      ...nulSeparated(await git(["ls-files", "-z"], root)),
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
   * in the changes: git ignores it. The loader would run it, and it shadows
   * a tracked config with a later name, yet no diff will ever show it.
   */
  const checkConfigsSeen = async (dir: string): Promise<void> => {
    for (const name of await configsOnDisk(join(root, dir))) {
      const path = dir === "" ? name : `${dir}/${name}`;
      const seen =
        (await existsInBase(path)) ||
        (await changes()).some((change) => change.path === path);
      if (!seen) {
        throw new GitError(
          `${path} is on disk but git does not report it: git ignores it, or knows it under another spelling. The guard cannot see changes to a config git ignores. Stop ignoring the file (or remove it) and run again.`,
        );
      }
    }
  };

  return {
    root,
    ...(mergeBase === undefined ? {} : { mergeBase }),
    ...(head === undefined ? { index } : {}),
    checkDirectory: async (dir) => {
      if (dir !== "") {
        await checkSpelling(dir);
      }
      if (head === undefined) {
        await checkConfigsSeen(dir);
      }
    },
    reader: {
      changes,
      existsInBase,
      existsInHead: async (path) =>
        head === undefined
          ? (await onDisk(root, path)) !== "absent"
          : existsAt(head, path),
      readBase,
      readHead: (path) =>
        head === undefined ? readWorkingTree(root, path) : readRef(head, path),
    },
  };
}
