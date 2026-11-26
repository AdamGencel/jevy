import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gitHead,
  gitOriginHead,
  gitReadAt,
  gitTopLevel,
  gitTrackedConfigs,
} from "./git.js";

/** The hook's git queries against a real repository in a temporary directory. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-git-")));
const repo = join(base, "repo");
const outside = join(base, "outside");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

let first = "";

beforeAll(() => {
  mkdirSync(repo);
  mkdirSync(outside);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jevy Test");
  git("config", "user.email", "jevy-test@example.invalid");
  git("config", "commit.gpgsign", "false");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("the hook's git queries", () => {
  it("answer nothing on an unborn HEAD", async () => {
    expect(await gitHead(repo)).toBeNull();
    expect(await gitOriginHead(repo)).toBeNull();
    expect(await gitTrackedConfigs(repo)).toEqual([]);
  });

  it("answer nothing outside a repository", async () => {
    expect(await gitHead(outside)).toBeNull();
    expect(await gitOriginHead(outside)).toBeNull();
    expect(await gitTrackedConfigs(outside)).toEqual([]);
    expect(await gitHead(join(base, "missing"))).toBeNull();
    expect(await gitTrackedConfigs(join(base, "missing"))).toEqual([]);
  });

  it("gitHead is the full hash of the commit HEAD points at", async () => {
    write("packages/app/jevy.config.ts", "export default { a: 1 };\n");
    write("packages/web/deep/jevy.config.mjs", "export default {};\n");
    write("packages/web/xjevy.config.ts", "not a config\n");
    write("packages/web/jevy.config.json", "{}\n");
    write("packages/app/dir.config/file.ts", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    first = git("rev-parse", "HEAD");
    expect(await gitHead(repo)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await gitHead(join(repo, "packages", "app"))).toBe(first);
  });

  it("gitTrackedConfigs lists every tracked jevy.config.*, relative to the directory asked from", async () => {
    expect(await gitTrackedConfigs(repo)).toEqual([
      "packages/app/jevy.config.ts",
      "packages/web/deep/jevy.config.mjs",
    ]);
    expect(await gitTrackedConfigs(join(repo, "packages", "web"))).toEqual([
      "../app/jevy.config.ts",
      "deep/jevy.config.mjs",
    ]);
    // An untracked config is not the repository's yet.
    write("jevy.config.ts", "export default {};\n");
    expect(await gitTrackedConfigs(repo)).toHaveLength(2);
    rmSync(join(repo, "jevy.config.ts"));
  });

  it("gitReadAt reads a file as it was at a commit, relative to the directory asked from", async () => {
    write("packages/app/jevy.config.ts", "export default { a: 2 };\n");
    git("commit", "-q", "-am", "second");
    const app = join(repo, "packages", "app");
    expect(await gitReadAt(first, "jevy.config.ts", app)).toBe(
      "export default { a: 1 };\n",
    );
    expect(await gitReadAt("HEAD", "jevy.config.ts", app)).toBe(
      "export default { a: 2 };\n",
    );
    expect(await gitReadAt(first, "packages/app/jevy.config.ts", repo)).toBe(
      "export default { a: 1 };\n",
    );
  });

  it("gitReadAt is null for a path the commit does not have as a file", async () => {
    const app = join(repo, "packages", "app");
    expect(await gitReadAt(first, "jevy.config.mts", app)).toBeNull();
    expect(await gitReadAt(first, "jevy.config.ts", repo)).toBeNull();
    // A directory of that name is not a config file.
    expect(await gitReadAt(first, "dir.config", app)).toBeNull();
  });

  it("gitReadAt reads a committed symlink as its link text", async () => {
    symlinkSync("packages/app/jevy.config.ts", join(repo, "jevy.config.ts"));
    git("add", "jevy.config.ts");
    git("commit", "-q", "-m", "link");
    expect(await gitReadAt("HEAD", "jevy.config.ts", repo)).toBe(
      "packages/app/jevy.config.ts",
    );
  });

  it("gitReadAt rejects when git cannot answer, and never says absent", async () => {
    await expect(
      gitReadAt("0".repeat(40), "jevy.config.ts", repo),
    ).rejects.toThrow();
    await expect(gitReadAt("--help", "jevy.config.ts", repo)).rejects.toThrow();
    await expect(gitReadAt(first, "jevy.config.ts", outside)).rejects.toThrow();
  });

  it("gitOriginHead is the branch origin/HEAD points at", async () => {
    expect(await gitOriginHead(repo)).toBeNull();
    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    expect(await gitOriginHead(repo)).toBe("trunk");
  });

  it("gitTopLevel is the repository's root with symlinks resolved, from any directory in it", async () => {
    expect(await gitTopLevel(repo)).toBe(repo);
    expect(await gitTopLevel(join(repo, "packages", "app"))).toBe(repo);
    symlinkSync(repo, join(base, "repo-link"), "dir");
    expect(await gitTopLevel(join(base, "repo-link", "packages"))).toBe(repo);
    expect(await gitTopLevel(outside)).toBeNull();
    expect(await gitTopLevel(join(base, "missing"))).toBeNull();
  });

  it("does not see through git replace", async () => {
    // `git replace <old> <new>` makes git show <new> wherever <old> is
    // asked for. An agent could point the session's start at HEAD and hide
    // what it committed; the hooks ask git to ignore replacements.
    write("packages/app/jevy.config.ts", "export default { a: 3 };\n");
    git("commit", "-q", "-am", "third");
    const third = git("rev-parse", "HEAD");
    git("replace", first, third);
    try {
      expect(await gitReadAt(first, "packages/app/jevy.config.ts", repo)).toBe(
        "export default { a: 1 };\n",
      );
    } finally {
      git("replace", "-d", first);
    }
  });
});
