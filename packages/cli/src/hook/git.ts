import { execFile } from "node:child_process";
import { CONFIG_FILENAMES } from "../guard/config-source.js";

/**
 * The questions the hooks ask git, beyond "does this ref exist". All of them
 * only read. They are behind `HookDeps`, so the hook logic is tested without
 * a repository.
 */

interface GitOutput {
  /** The exit code; null when git could not be started or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git and report how it ended. Never rejects. */
function git(args: readonly string[], cwd: string): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          // These queries must not wait for, or take, the index lock.
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function failed(what: string, output: GitOutput): Error {
  const detail = output.stderr.trim().split("\n")[0] ?? "";
  return new Error(
    `git could not ${what}${detail === "" ? "" : `: ${detail}`}`,
  );
}

/**
 * The full hash of the commit `HEAD` points at. Null when there is none to
 * name: outside a repository, on a branch with no commit yet, or with no
 * git. The session-start hook then records nothing.
 */
export async function gitHead(cwd: string): Promise<string | null> {
  const output = await git(
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    cwd,
  );
  const hash = output.stdout.trim();
  return output.code === 0 && /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
}

/**
 * The branch `refs/remotes/origin/HEAD` points at (`main` for
 * `origin/main`): what the remote calls its default branch. Null when the
 * ref is not there, which is common: only `git clone` and
 * `git remote set-head` write it.
 */
export async function gitOriginHead(cwd: string): Promise<string | null> {
  const output = await git(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    cwd,
  );
  const prefix = "refs/remotes/origin/";
  const target = output.stdout.trim();
  return output.code === 0 &&
    target.startsWith(prefix) &&
    target.length > prefix.length
    ? target.slice(prefix.length)
    : null;
}

/**
 * The text of the file `path` (relative to `cwd`) as it was at `commit`, or
 * null when that commit has no file there. A committed symlink reads as its
 * link text, as git stores it.
 *
 * Rejects when git cannot answer. "Absent" is only ever said by `ls-tree`
 * exiting 0 with nothing listed: reading a failure as absent would let a
 * changed config pass for a new one.
 */
export async function gitReadAt(
  commit: string,
  path: string,
  cwd: string,
): Promise<string | null> {
  // Git would read a commit that starts with `-` as an option.
  if (commit.startsWith("-")) {
    throw new Error(`git cannot read a commit named '${commit}'`);
  }
  const listed = await git(["ls-tree", "-z", commit, "--", path], cwd);
  if (listed.code !== 0) {
    throw failed(`list ${path} at ${commit}`, listed);
  }
  // One entry: "<mode> <type> <hash>\t<path>\0".
  if (!/^\d+ blob /.test(listed.stdout)) {
    return null;
  }
  // `cat-file`, not `show`: no textconv or other configured filter runs.
  const blob = await git(["cat-file", "blob", `${commit}:./${path}`], cwd);
  if (blob.code !== 0) {
    throw failed(`read ${path} at ${commit}`, blob);
  }
  return blob.stdout;
}

/**
 * Every `jevy.config.*` git tracks in the repository around `cwd`, as paths
 * relative to `cwd` with forward slashes (`../app/jevy.config.ts`), sorted.
 * Empty outside a repository.
 *
 * The hooks read the config of the directory they run in. This is how they
 * notice that the project's config is in another directory, where their
 * silence would otherwise be read as "nothing to check".
 */
export async function gitTrackedConfigs(
  cwd: string,
): Promise<readonly string[]> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return [];
  }
  // `top`: from the repository root, wherever `cwd` is in it. `glob`: `**/`
  // also matches no directory at all, and `*` stops at a slash.
  const specs = CONFIG_FILENAMES.map((name) => `:(top,glob)**/${name}`);
  const listed = await git(["ls-files", "-z", "--", ...specs], cwd);
  if (listed.code !== 0) {
    throw failed("list the tracked jevy.config.* files", listed);
  }
  return listed.stdout
    .split("\u0000")
    .filter((path) => path !== "")
    .sort();
}
