import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitError } from "./errors.js";

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
  /** Text of `path` in the base version, or null when it does not exist there. */
  readBase(path: string): Promise<string | null>;
  /** Text of `path` in the head version, or null when it does not exist there. */
  readHead(path: string): Promise<string | null>;
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
  };
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
 * interpreted. Callers reject refs that start with `-` before getting here.
 */
async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    });
    return stdout;
  } catch (error) {
    throw new GitError(`git ${args[0] ?? ""} failed: ${stderrOf(error)}`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR")
  );
}

export interface GitReaderOptions {
  /** Any directory inside the repository. */
  readonly cwd: string;
  readonly base: string;
  /** A ref, or undefined to read the working tree. */
  readonly head: string | undefined;
}

export interface GitRepo {
  readonly root: string;
  readonly reader: RepoReader;
}

/**
 * Open the repository around `cwd`. Every ref is checked to name a commit
 * first, so a typo is a clear error rather than an empty diff.
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
  }
  const { base, head } = options;

  const changes = async (): Promise<readonly FileChange[]> => {
    const diffArgs = [
      "diff",
      "--name-status",
      "-M",
      "-z",
      "--no-color",
      "--no-ext-diff",
      base,
      ...(head === undefined ? [] : [head]),
      "--",
    ];
    const tracked = parseNameStatus(await git(diffArgs, root));
    if (head !== undefined) {
      return tracked;
    }
    // `git diff <base>` does not list untracked files. An agent's new test
    // file or new decision record is exactly what must not be missed.
    const untracked = (
      await git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    )
      .split("\u0000")
      .filter((path) => path !== "")
      .map((path): FileChange => ({ status: "added", path, oldPath: path }));
    return [...tracked, ...untracked];
  };

  // `cat-file` rather than `show`: plumbing applies no textconv driver or
  // other repository-configured filter, so the bytes are the committed ones.
  // A failure is an error, never "file absent": the diff already said the
  // file exists, and treating a failed read as absent would hide weakening.
  const readRef = (ref: string, path: string): Promise<string> =>
    git(["cat-file", "blob", `${ref}:${path}`], root);

  return {
    root,
    reader: {
      changes,
      readBase: (path) => readRef(base, path),
      readHead: async (path) => {
        if (head !== undefined) {
          return readRef(head, path);
        }
        const file = join(root, path);
        try {
          // Git stores a symlink as its target path; read it the same way so
          // the working tree compares like a commit and nothing outside the
          // repository is read.
          const stats = await lstat(file);
          return stats.isSymbolicLink()
            ? await readlink(file, "utf8")
            : await readFile(file, "utf8");
        } catch (error) {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        }
      },
    },
  };
}
