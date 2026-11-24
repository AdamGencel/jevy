import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitError, GuardError } from "./errors.js";
import {
  hiddenPaths,
  memoryReader,
  openGitRepo,
  parseNameStatus,
  treeHasBlob,
} from "./git.js";

/**
 * These tests start git many times each. On a busy machine that takes far
 * longer than the default five seconds without anything being wrong.
 */
const REAL_GIT = { timeout: 60_000 };

describe("parseNameStatus", () => {
  it("reads NUL-separated name-status output, renames and copies included", () => {
    const output = [
      "M",
      "src/a.spec.ts",
      "D",
      "src/gone.test.ts",
      "R087",
      "old name.spec.ts",
      "new name.spec.ts",
      "C100",
      "src/a.spec.ts",
      "src/copy.spec.ts",
      "A",
      "tab\there.spec.ts",
      "T",
      "link.spec.ts",
      "",
    ].join("\u0000");
    expect(parseNameStatus(output)).toEqual([
      { status: "modified", path: "src/a.spec.ts", oldPath: "src/a.spec.ts" },
      {
        status: "deleted",
        path: "src/gone.test.ts",
        oldPath: "src/gone.test.ts",
      },
      {
        status: "renamed",
        path: "new name.spec.ts",
        oldPath: "old name.spec.ts",
      },
      {
        status: "added",
        path: "src/copy.spec.ts",
        oldPath: "src/copy.spec.ts",
      },
      {
        status: "added",
        path: "tab\there.spec.ts",
        oldPath: "tab\there.spec.ts",
      },
      { status: "modified", path: "link.spec.ts", oldPath: "link.spec.ts" },
    ]);
  });

  it("reads empty output as no changes", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("memoryReader", () => {
  it("derives changes from two snapshots and reads both sides", async () => {
    const reader = memoryReader(
      { "a.spec.ts": "1", "b.spec.ts": "2", "same.ts": "x" },
      { "a.spec.ts": "1!", "c.spec.ts": "3", "same.ts": "x" },
    );
    expect(await reader.changes()).toEqual([
      { status: "modified", path: "a.spec.ts", oldPath: "a.spec.ts" },
      { status: "deleted", path: "b.spec.ts", oldPath: "b.spec.ts" },
      { status: "added", path: "c.spec.ts", oldPath: "c.spec.ts" },
    ]);
    expect(await reader.readBase("b.spec.ts")).toBe("2");
    expect(await reader.readHead("b.spec.ts")).toBeNull();
    expect(await reader.readHead("c.spec.ts")).toBe("3");
  });

  it("reports declared renames with their old path", async () => {
    const reader = memoryReader(
      { "old.spec.ts": "1" },
      { "new.spec.ts": "1" },
      { "new.spec.ts": "old.spec.ts" },
    );
    expect(await reader.changes()).toEqual([
      { status: "renamed", path: "new.spec.ts", oldPath: "old.spec.ts" },
    ]);
  });
});

describe("memoryReader existence", () => {
  it("says whether a path exists on each side, changed or not", async () => {
    const reader = memoryReader(
      { "jevy.config.ts": "a", "gone.ts": "b" },
      { "jevy.config.ts": "a", "new.ts": "c" },
    );
    expect(await reader.existsInBase("jevy.config.ts")).toBe(true);
    expect(await reader.existsInHead("jevy.config.ts")).toBe(true);
    expect(await reader.existsInBase("new.ts")).toBe(false);
    expect(await reader.existsInHead("new.ts")).toBe(true);
    expect(await reader.existsInBase("gone.ts")).toBe(true);
    expect(await reader.existsInHead("gone.ts")).toBe(false);
  });
});

describe("treeHasBlob", () => {
  const entry = (mode: string, type: string, path: string): string =>
    `${mode} ${type} 587be6b4c3f93f93c489c0111bba5596147a26cb\t${path}\u0000`;

  it("is true for a file or a symlink at exactly that path", () => {
    expect(treeHasBlob(entry("100644", "blob", "a/b.ts"), "a/b.ts")).toBe(true);
    expect(treeHasBlob(entry("120000", "blob", "link"), "link")).toBe(true);
  });

  it("is false for no output, a directory, a submodule or another path", () => {
    expect(treeHasBlob("", "a/b.ts")).toBe(false);
    expect(treeHasBlob(entry("040000", "tree", "a"), "a")).toBe(false);
    expect(treeHasBlob(entry("160000", "commit", "sub"), "sub")).toBe(false);
    expect(treeHasBlob(entry("100644", "blob", "a/b.ts"), "a")).toBe(false);
  });

  it("reads a path that holds a tab", () => {
    expect(treeHasBlob(entry("100644", "blob", "a\tb.ts"), "a\tb.ts")).toBe(
      true,
    );
  });
});

describe("openGitRepo", REAL_GIT, () => {
  let repo = "";
  let branchPoint = "";

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  }

  function write(path: string, text: string): void {
    const full = join(repo, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "jevy-git-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jevy Test");
    git("config", "user.email", "jevy-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    write("web/jevy.config.ts", "export default {};\n");
    write("a*b/f.ts", "1\n");
    write("axb/f.ts", "1\n");
    symlinkSync("web/jevy.config.ts", join(repo, "link.ts"));
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    branchPoint = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "feature");
    write("only-feature.ts", "f\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feature");
    git("checkout", "-q", "main");
    write("only-main.ts", "m\n");
    git("add", "-A");
    git("commit", "-q", "-m", "main moves on");
    git("checkout", "-q", "--orphan", "unrelated");
    git("commit", "-q", "-m", "no shared history");
    git("checkout", "-q", "feature");
    write("untracked.ts", "u\n");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("says whether a path is a file in base, without reading it", async () => {
    const { reader } = await openGitRepo({
      cwd: repo,
      base: "main",
      head: "feature",
    });
    expect(await reader.existsInBase("web/jevy.config.ts")).toBe(true);
    expect(await reader.existsInBase("link.ts")).toBe(true);
    expect(await reader.existsInBase("only-main.ts")).toBe(true);
    expect(await reader.existsInBase("only-feature.ts")).toBe(false);
    expect(await reader.existsInBase("web")).toBe(false);
    expect(await reader.existsInBase("web/nope.ts")).toBe(false);
    expect(await reader.existsInHead("only-feature.ts")).toBe(true);
    expect(await reader.existsInHead("only-main.ts")).toBe(false);
    expect(await reader.existsInHead("untracked.ts")).toBe(false);
  });

  it("takes the path literally, never as a pattern", async () => {
    const { reader } = await openGitRepo({
      cwd: repo,
      base: "main",
      head: "feature",
    });
    expect(await reader.existsInBase("a*b/f.ts")).toBe(true);
    expect(await reader.existsInBase("a?b/f.ts")).toBe(false);
    expect(await reader.existsInBase("*/f.ts")).toBe(false);
  });

  it("checks the working tree when there is no head ref", async () => {
    const { reader } = await openGitRepo({
      cwd: repo,
      base: "main",
      head: undefined,
    });
    expect(await reader.existsInHead("untracked.ts")).toBe(true);
    expect(await reader.existsInHead("link.ts")).toBe(true);
    expect(await reader.existsInHead("web")).toBe(false);
    expect(await reader.existsInHead("web/nope.ts")).toBe(false);
    expect(await reader.existsInHead("untracked.ts/below")).toBe(false);
  });

  it("still fails to read a base path that is absent", async () => {
    const { reader } = await openGitRepo({
      cwd: repo,
      base: "main",
      head: "feature",
    });
    await expect(reader.readBase("only-feature.ts")).rejects.toBeInstanceOf(
      GitError,
    );
  });

  it("compares against the tip of base without mergeBase", async () => {
    const opened = await openGitRepo({
      cwd: repo,
      base: "main",
      head: "feature",
    });
    expect(opened.mergeBase).toBeUndefined();
    expect(await opened.reader.changes()).toEqual([
      { status: "added", path: "only-feature.ts", oldPath: "only-feature.ts" },
      { status: "deleted", path: "only-main.ts", oldPath: "only-main.ts" },
    ]);
  });

  it("compares against the common ancestor with mergeBase", async () => {
    const opened = await openGitRepo({
      cwd: repo,
      base: "main",
      head: "feature",
      mergeBase: true,
    });
    expect(opened.mergeBase).toBe(branchPoint);
    expect(await opened.reader.changes()).toEqual([
      { status: "added", path: "only-feature.ts", oldPath: "only-feature.ts" },
    ]);
    expect(await opened.reader.existsInBase("only-main.ts")).toBe(false);
  });

  it("uses HEAD for the common ancestor when reading the working tree", async () => {
    const opened = await openGitRepo({
      cwd: repo,
      base: "main",
      head: undefined,
      mergeBase: true,
    });
    expect(opened.mergeBase).toBe(branchPoint);
    expect(await opened.reader.changes()).toEqual([
      { status: "added", path: "only-feature.ts", oldPath: "only-feature.ts" },
      { status: "added", path: "untracked.ts", oldPath: "untracked.ts" },
    ]);
  });

  it("fails clearly when the two have no common ancestor", async () => {
    const opening = openGitRepo({
      cwd: repo,
      base: "unrelated",
      head: "feature",
      mergeBase: true,
    });
    await expect(opening).rejects.toBeInstanceOf(GitError);
    await expect(opening).rejects.toThrow(
      /^--merge-base found no common ancestor of 'unrelated' and 'feature'\..*git fetch --unshallow/,
    );
  });

  it("names the shallow clone when history is cut off", async () => {
    const shallow = mkdtempSync(join(tmpdir(), "jevy-git-shallow-"));
    try {
      execFileSync(
        "git",
        [
          "clone",
          "-q",
          "--depth",
          "1",
          "--no-single-branch",
          `file://${repo}`,
          shallow,
        ],
        { encoding: "utf8" },
      );
      await expect(
        openGitRepo({
          cwd: shallow,
          base: "origin/main",
          head: "origin/feature",
          mergeBase: true,
        }),
      ).rejects.toThrow(
        /^--merge-base found no common ancestor of 'origin\/main' and 'origin\/feature'\. This is a shallow clone/,
      );
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe("hiddenPaths", () => {
  it("lists the entries git is told not to look at, in git's order", () => {
    const output = [
      "H seen.ts",
      "h assumed.ts",
      "S skipped.ts",
      "s both.ts",
      "M unmerged.ts",
      "h name with spaces.ts",
      "",
    ].join("\u0000");
    expect(hiddenPaths(output)).toEqual([
      "assumed.ts",
      "skipped.ts",
      "both.ts",
      "name with spaces.ts",
    ]);
  });

  it("reads empty output as nothing hidden", () => {
    expect(hiddenPaths("")).toEqual([]);
  });
});

/** Each test tampers with its own repository. */
describe("openGitRepo on a repository that hides a change", REAL_GIT, () => {
  const made: string[] = [];

  interface Scratch {
    readonly dir: string;
    readonly git: (...args: string[]) => string;
    readonly write: (path: string, text: string) => void;
  }

  function scratch(files: Readonly<Record<string, string>>): Scratch {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-git-")));
    made.push(dir);
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const write = (path: string, text: string): void => {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jevy Test");
    git("config", "user.email", "jevy-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, text] of Object.entries(files)) {
      write(path, text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    return { dir, git, write };
  }

  afterAll(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const tree = (dir: string) =>
    openGitRepo({ cwd: dir, base: "main", head: undefined });

  it("takes a path that starts with a colon literally, not as pathspec magic", async () => {
    const repo = scratch({ ":x/jevy.config.ts": "a\n", ":(top)y.ts": "b\n" });
    const { reader, index } = await tree(repo.dir);
    expect(await reader.existsInBase(":x/jevy.config.ts")).toBe(true);
    expect(await reader.existsInBase(":(top)y.ts")).toBe(true);
    expect(await reader.existsInBase(":x/nope.ts")).toBe(false);
    expect(await reader.readBase(":x/jevy.config.ts")).toBe("a\n");
    expect(await index?.existsInHead(":x/jevy.config.ts")).toBe(true);
    expect(await index?.readHead(":x/jevy.config.ts")).toBe("a\n");
  });

  describe("the index", () => {
    it("is a second reader, base against what is staged", async () => {
      const repo = scratch({
        "a.ts": "1\n",
        "gone.ts": "1\n",
        "1:b.ts": "1\n",
      });
      repo.write("a.ts", "staged\n");
      repo.write("new.ts", "staged new\n");
      repo.write("1:b.ts", "staged colon\n");
      repo.git("rm", "-q", "--cached", "gone.ts");
      repo.git("add", "a.ts", "new.ts", "1:b.ts");
      repo.write("a.ts", "1\n");
      rmSync(join(repo.dir, "new.ts"));
      repo.write("untracked.ts", "u\n");
      const { reader, index } = await tree(repo.dir);
      expect(index).toBeDefined();
      expect(await index?.changes()).toEqual([
        { status: "modified", path: "1:b.ts", oldPath: "1:b.ts" },
        { status: "modified", path: "a.ts", oldPath: "a.ts" },
        { status: "deleted", path: "gone.ts", oldPath: "gone.ts" },
        { status: "added", path: "new.ts", oldPath: "new.ts" },
      ]);
      expect(await index?.readHead("a.ts")).toBe("staged\n");
      expect(await index?.readHead("1:b.ts")).toBe("staged colon\n");
      expect(await index?.readBase("a.ts")).toBe("1\n");
      expect(await index?.existsInHead("new.ts")).toBe(true);
      expect(await index?.existsInHead("gone.ts")).toBe(false);
      expect(await index?.existsInHead("untracked.ts")).toBe(false);
      expect(await index?.existsInBase("gone.ts")).toBe(true);
      // The working tree is still read from disk.
      expect(await reader.readHead("a.ts")).toBe("1\n");
      expect(await reader.existsInHead("new.ts")).toBe(false);
    });

    it("is absent when two commits are compared", async () => {
      const repo = scratch({ "a.ts": "1\n" });
      const opened = await openGitRepo({
        cwd: repo.dir,
        base: "main",
        head: "HEAD",
      });
      expect(opened.index).toBeUndefined();
    });

    it("leaves unmerged paths out: they cannot be committed", async () => {
      const repo = scratch({ "a.ts": "1\n" });
      repo.git("checkout", "-q", "-b", "theirs");
      repo.write("a.ts", "theirs\n");
      repo.git("commit", "-q", "-am", "theirs");
      repo.git("checkout", "-q", "main");
      repo.write("a.ts", "ours\n");
      repo.git("commit", "-q", "-am", "ours");
      expect(() => repo.git("merge", "-q", "theirs")).toThrow();
      const { index } = await tree(repo.dir);
      expect(await index?.changes()).toEqual([]);
    });
  });

  describe("files git is told not to look at", () => {
    it.each([["--assume-unchanged"], ["--skip-worktree"]])(
      "refuses a working tree with a file marked %s",
      async (flag) => {
        const repo = scratch({ "tests/a.spec.ts": "1\n", "b.ts": "1\n" });
        repo.git("update-index", flag, "tests/a.spec.ts");
        const opening = tree(repo.dir);
        await expect(opening).rejects.toBeInstanceOf(GitError);
        await expect(opening).rejects.toThrow(
          /cannot check a working tree with hidden files.*: tests\/a\.spec\.ts\. .*git update-index --no-assume-unchanged --no-skip-worktree.*--head HEAD/,
        );
        // Two commits are compared without the working tree.
        await expect(
          openGitRepo({ cwd: repo.dir, base: "main", head: "HEAD" }),
        ).resolves.toBeDefined();
      },
    );
  });

  describe("something that is not a regular file", () => {
    const noFifo = process.platform === "win32";

    it.skipIf(noFifo)(
      "refuses to read or to vouch for a FIFO (needs mkfifo; Windows has none)",
      async () => {
        const repo = scratch({ "tests/a.spec.ts": "1\n" });
        rmSync(join(repo.dir, "tests/a.spec.ts"));
        execFileSync("mkfifo", [join(repo.dir, "tests/a.spec.ts")]);
        const { reader } = await tree(repo.dir);
        for (const asking of [
          reader.readHead("tests/a.spec.ts"),
          reader.existsInHead("tests/a.spec.ts"),
        ]) {
          await expect(asking).rejects.toBeInstanceOf(GuardError);
          await expect(asking).rejects.toThrow(
            /^tests\/a\.spec\.ts is not a regular file \(it is a FIFO\)/,
          );
        }
      },
      30_000,
    );

    it("still reads a symlink as its target path, and a directory as absent", async () => {
      const repo = scratch({ "a.ts": "1\n", "dir/f.ts": "1\n" });
      symlinkSync("/etc/hosts", join(repo.dir, "link.ts"));
      const { reader } = await tree(repo.dir);
      expect(await reader.readHead("link.ts")).toBe("/etc/hosts");
      expect(await reader.readHead("dir")).toBeNull();
      expect(await reader.readHead("nope.ts")).toBeNull();
      expect(await reader.existsInHead("dir")).toBe(false);
    });
  });

  describe("an ambiguous ref", () => {
    function twoCommits(): Scratch {
      const repo = scratch({ "a.ts": "1\n" });
      repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
      repo.write("a.ts", "2\n");
      repo.git("commit", "-q", "-am", "second");
      return repo;
    }

    const open = (dir: string, base: string, head?: string) =>
      openGitRepo({ cwd: dir, base, head });

    it("refuses a name that is a tag and a remote branch on different commits", async () => {
      const repo = twoCommits();
      repo.git("tag", "origin/main", "HEAD");
      const opening = open(repo.dir, "origin/main");
      await expect(opening).rejects.toBeInstanceOf(GitError);
      await expect(opening).rejects.toThrow(
        "'origin/main' is ambiguous: it names refs/tags/origin/main and refs/remotes/origin/main, which point at different commits. Pass one of them in full.",
      );
      await expect(
        open(repo.dir, "refs/remotes/origin/main", "origin/main~0"),
      ).rejects.toThrow(/'origin\/main' is ambiguous/);
      await expect(
        open(repo.dir, "refs/remotes/origin/main", "refs/tags/origin/main"),
      ).resolves.toBeDefined();
    });

    it("lists every ref of that name, in git's lookup order", async () => {
      const repo = twoCommits();
      repo.git("tag", "main", "refs/remotes/origin/main");
      repo.git("update-ref", "refs/main", "refs/remotes/origin/main");
      await expect(open(repo.dir, "main")).rejects.toThrow(
        "it names refs/main, refs/tags/main and refs/heads/main, which",
      );
    });

    it("refuses a remote whose HEAD and a branch share the name", async () => {
      const repo = twoCommits();
      repo.git("update-ref", "refs/remotes/up/HEAD", "HEAD");
      repo.git("update-ref", "refs/heads/up", "HEAD~1");
      await expect(open(repo.dir, "up")).rejects.toThrow(
        "it names refs/heads/up and refs/remotes/up/HEAD, which",
      );
    });

    it("refuses a name a file in the git directory answers first", async () => {
      const repo = twoCommits();
      repo.write(".git/origin/main", repo.git("rev-parse", "HEAD"));
      await expect(open(repo.dir, "origin/main")).rejects.toThrow(
        /^'origin\/main' is ambiguous: git does not resolve it to refs\/remotes\/origin\/main\b/,
      );
    });

    it("accepts refs of one name on the same commit, a full name and a commit id", async () => {
      const repo = twoCommits();
      repo.git("tag", "origin/main", "refs/remotes/origin/main");
      repo.git("tag", "-a", "-m", "annotated", "main", "HEAD");
      const id = repo.git("rev-parse", "HEAD").trim();
      for (const ref of [
        "origin/main",
        "main",
        "refs/heads/main",
        id,
        "HEAD",
      ]) {
        await expect(open(repo.dir, ref)).resolves.toBeDefined();
      }
    });
  });

  describe("checkDirectory", () => {
    it("refuses a config in the run directory that git ignores", async () => {
      const repo = scratch({ "web/a.ts": "1\n", "jevy.config.mjs": "x\n" });
      repo.write(".git/info/exclude", "jevy.config.ts\nJevy.Config.mts\n");
      repo.write("web/jevy.config.ts", "export default {};\n");
      const { checkDirectory } = await tree(repo.dir);
      const checking = checkDirectory?.("web");
      await expect(checking).rejects.toBeInstanceOf(GitError);
      await expect(checking).rejects.toThrow(
        /^web\/jevy\.config\.ts .*cannot see changes to a config git ignores/,
      );
      // Elsewhere there is nothing to refuse: the root's config is tracked.
      await expect(checkDirectory?.("")).resolves.toBeUndefined();
      repo.write("Jevy.Config.mts", "export default {};\n");
      await expect(checkDirectory?.("")).rejects.toThrow(/^Jevy\.Config\.mts /);
    });

    it("accepts a config that is tracked, staged or untracked but not ignored", async () => {
      const repo = scratch({ "jevy.config.ts": "x\n", "web/a.ts": "1\n" });
      repo.write("web/jevy.config.js", "export default {};\n");
      repo.write("api/jevy.config.mjs", "export default {};\n");
      repo.git("add", "api");
      mkdirSync(join(repo.dir, "odd/jevy.config.ts"), { recursive: true });
      const { checkDirectory } = await tree(repo.dir);
      for (const dir of ["", "web", "api", "odd"]) {
        await expect(checkDirectory?.(dir)).resolves.toBeUndefined();
      }
    });

    it("does not look for ignored configs when two commits are compared", async () => {
      const repo = scratch({ "a.ts": "1\n" });
      repo.write(".git/info/exclude", "jevy.config.ts\n");
      repo.write("jevy.config.ts", "export default {};\n");
      const { checkDirectory } = await openGitRepo({
        cwd: repo.dir,
        base: "main",
        head: "HEAD",
      });
      await expect(checkDirectory?.("")).resolves.toBeUndefined();
    });

    const caseSensitive = ((): boolean => {
      const probe = mkdtempSync(join(tmpdir(), "jevy-case-"));
      try {
        return !existsSync(probe.toUpperCase());
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    })();

    it.skipIf(caseSensitive)(
      "refuses a directory git knows under another spelling (needs a file system that ignores case; this one does not)",
      async () => {
        const repo = scratch({ "pkg/sub/a.ts": "1\n" });
        renameSync(join(repo.dir, "pkg"), join(repo.dir, "pkg_tmp"));
        renameSync(join(repo.dir, "pkg_tmp"), join(repo.dir, "Pkg"));
        for (const head of [undefined, "HEAD"]) {
          const { checkDirectory } = await openGitRepo({
            cwd: repo.dir,
            base: "main",
            head,
          });
          await expect(checkDirectory?.("Pkg/sub")).rejects.toThrow(
            /"Pkg\/sub".*"pkg\/sub"/,
          );
          await expect(checkDirectory?.("pkg/sub")).resolves.toBeUndefined();
        }
      },
    );

    it("accepts a directory git knows only from the index or as untracked, and one it has never seen", async () => {
      const repo = scratch({ "a.ts": "1\n" });
      repo.write("staged/a.ts", "1\n");
      repo.git("add", "staged");
      repo.write("loose/a.ts", "1\n");
      mkdirSync(join(repo.dir, "empty"));
      const { checkDirectory } = await tree(repo.dir);
      for (const dir of ["staged", "loose", "empty"]) {
        await expect(checkDirectory?.(dir)).resolves.toBeUndefined();
      }
    });
  });
});
