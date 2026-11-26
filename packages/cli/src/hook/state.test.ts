import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clearState,
  decide,
  loadStart,
  loadState,
  parseStart,
  parseState,
  realStateFiles,
  recordStart,
  saveState,
  serialiseStart,
  serialiseState,
  signatureOf,
  startPath,
  statePath,
  type StateFiles,
  type StopState,
} from "./state.js";

describe("statePath", () => {
  it("is a file in the state directory named by a hash", () => {
    const path = statePath("/tmp/x", "/repo", "session-1");
    expect(dirname(path)).toBe("/tmp/x");
    expect(basename(path)).toMatch(/^jevy-hook-[0-9a-f]{32}\.json$/);
    expect(path).not.toContain("session-1");
  });

  it("differs by project and by session, and is stable", () => {
    const a = statePath("/tmp/x", "/repo", "s1");
    expect(statePath("/tmp/x", "/repo", "s1")).toBe(a);
    expect(statePath("/tmp/x", "/repo", "s2")).not.toBe(a);
    expect(statePath("/tmp/x", "/other", "s1")).not.toBe(a);
    // The separator keeps ("/a", "b/c") apart from ("/a/b", "c").
    expect(statePath("/tmp/x", "/a", "b/c")).not.toBe(
      statePath("/tmp/x", "/a/b", "c"),
    );
  });
});

describe("signatureOf", () => {
  it("does not depend on the order of the parts", () => {
    expect(signatureOf(["b", "a"])).toBe(signatureOf(["a", "b"]));
    expect(signatureOf(["a"])).not.toBe(signatureOf(["a", "b"]));
    expect(signatureOf(["a"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("decide", () => {
  it("blocks the first failure", () => {
    expect(decide(null, "A")).toEqual({
      action: "block",
      next: { blocks: 1, same: 1, signature: "A" },
    });
  });

  it("blocks the same failure twice, then lets go", () => {
    const first: StopState = { blocks: 1, same: 1, signature: "A" };
    expect(decide(first, "A")).toEqual({
      action: "block",
      next: { blocks: 2, same: 2, signature: "A" },
    });
    expect(decide({ blocks: 2, same: 2, signature: "A" }, "A")).toEqual({
      action: "allow",
      why: "same",
    });
  });

  it("starts the run again when the failure changes", () => {
    expect(decide({ blocks: 2, same: 2, signature: "A" }, "B")).toEqual({
      action: "block",
      next: { blocks: 3, same: 1, signature: "B" },
    });
  });

  it("lets go after six blocks whatever the failures were", () => {
    expect(decide({ blocks: 5, same: 1, signature: "A" }, "B")).toEqual({
      action: "block",
      next: { blocks: 6, same: 1, signature: "B" },
    });
    expect(decide({ blocks: 6, same: 1, signature: "B" }, "A")).toEqual({
      action: "allow",
      why: "cap",
    });
  });
});

describe("parseState and serialiseState", () => {
  it("round-trips", () => {
    const state: StopState = { blocks: 3, same: 2, signature: "abc" };
    expect(parseState(serialiseState(state))).toEqual(state);
  });

  it.each([
    "",
    "nope",
    "[]",
    "null",
    '{"v":2,"blocks":1,"same":1,"signature":"a"}',
    '{"v":1,"blocks":-1,"same":1,"signature":"a"}',
    '{"v":1,"blocks":1.5,"same":1,"signature":"a"}',
    '{"v":1,"blocks":1,"same":"1","signature":"a"}',
    '{"v":1,"blocks":1,"same":2,"signature":"a"}',
    '{"v":1,"blocks":1,"same":1,"signature":7}',
    '{"v":1,"blocks":1,"same":1}',
  ])("is null for %j", (text) => {
    expect(parseState(text)).toBeNull();
  });
});

describe("loadState, saveState and clearState", () => {
  const failing: StateFiles = {
    dir: "/tmp/x",
    read: () => Promise.reject(new Error("EACCES")),
    write: () => Promise.reject(new Error("EROFS")),
    create: () => Promise.reject(new Error("EROFS")),
    remove: () => Promise.reject(new Error("EROFS")),
  };

  it("never throw when the files cannot be used, and say that they could not", async () => {
    // Not null: null is "no block yet", and the hook would count from zero
    // for ever.
    expect(await loadState(failing, "/tmp/x/a.json")).toBe("unusable");
    await expect(
      saveState(failing, "/tmp/x/a.json", {
        blocks: 1,
        same: 1,
        signature: "A",
      }),
    ).resolves.toBe(false);
    await expect(clearState(failing, "/tmp/x/a.json")).resolves.toBeUndefined();
  });

  const dir = mkdtempSync(join(tmpdir(), "jevy-hook-state-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keep a real file, readable only by its owner", async () => {
    const files = realStateFiles(dir);
    const path = statePath(files.dir, "/repo", "s1");
    expect(await loadState(files, path)).toBeNull();
    const state: StopState = { blocks: 1, same: 1, signature: "A" };
    expect(await saveState(files, path, state)).toBe(true);
    expect(readdirSync(dir)).toEqual([basename(path)]);
    expect(await loadState(files, path)).toEqual(state);
    await saveState(files, path, { ...state, blocks: 2, same: 2 });
    expect(await loadState(files, path)).toEqual({
      blocks: 2,
      same: 2,
      signature: "A",
    });
    await clearState(files, path);
    expect(readdirSync(dir)).toEqual([]);
    // Clearing what is not there is not an error.
    await clearState(files, path);
  });

  it("read a damaged file as no state", async () => {
    const files = realStateFiles(dir);
    const path = statePath(files.dir, "/repo", "damaged");
    writeFileSync(path, "{not json");
    expect(await loadState(files, path)).toBeNull();
    rmSync(path);
  });
});

describe("the record of where a session started", () => {
  const COMMIT = "a".repeat(40);
  const OTHER = "b".repeat(40);

  it("is kept in its own file, beside the count and apart from it", () => {
    const path = startPath("/state", "/repo", "s1");
    expect(dirname(path)).toBe("/state");
    expect(basename(path)).toMatch(/^jevy-hook-[0-9a-f]{32}-start\.json$/);
    expect(path).not.toBe(statePath("/state", "/repo", "s1"));
    expect(path).toBe(startPath("/state", "/repo", "s1"));
    expect(path).not.toBe(startPath("/state", "/repo", "s2"));
    expect(path).not.toBe(startPath("/state", "/other", "s1"));
  });

  it("round-trips a commit hash", () => {
    expect(parseStart(serialiseStart(COMMIT))).toBe(COMMIT);
    expect(parseStart(serialiseStart("c".repeat(64)))).toBe("c".repeat(64));
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an object", '"text"'],
    ["another version", JSON.stringify({ v: 2, head: "a".repeat(40) })],
    ["a short hash", JSON.stringify({ v: 1, head: "abc123" })],
    ["a ref name", JSON.stringify({ v: 1, head: "main" })],
    ["an option", JSON.stringify({ v: 1, head: "--all" })],
    ["no hash", JSON.stringify({ v: 1 })],
  ])("reads %s as no commit", (_name, text) => {
    expect(parseStart(text)).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), "jevy-hook-start-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is written once and never overwritten", async () => {
    const files = realStateFiles(dir);
    const path = startPath(files.dir, "/repo", "s1");
    expect(await loadStart(files, path)).toEqual({ kind: "none" });
    expect(await recordStart(files, path, COMMIT)).toBe(true);
    expect(await loadStart(files, path)).toEqual({
      kind: "commit",
      commit: COMMIT,
    });
    // A resume or a compact runs the hook again; the baseline stays.
    expect(await recordStart(files, path, OTHER)).toBe(false);
    expect(await loadStart(files, path)).toEqual({
      kind: "commit",
      commit: COMMIT,
    });
  });

  it("survives the stop count being cleared", async () => {
    const files = realStateFiles(dir);
    const start = startPath(files.dir, "/repo", "s3");
    const count = statePath(files.dir, "/repo", "s3");
    await recordStart(files, start, COMMIT);
    await saveState(files, count, { blocks: 1, same: 1, signature: "A" });
    await clearState(files, count);
    expect(await loadStart(files, start)).toEqual({
      kind: "commit",
      commit: COMMIT,
    });
  });

  it("says so when the record is damaged or cannot be read, and never reads that as no record", async () => {
    const files = realStateFiles(dir);
    const path = startPath(files.dir, "/repo", "damaged");
    writeFileSync(path, "{not json");
    expect(await loadStart(files, path)).toEqual({
      kind: "unusable",
      why: "it is damaged",
    });
    const failing: StateFiles = {
      ...files,
      read: () => Promise.reject(new Error("EACCES: permission denied")),
    };
    expect(await loadStart(failing, path)).toEqual({
      kind: "unusable",
      why: "EACCES: permission denied",
    });
  });
});

describe.runIf(process.platform !== "win32")(
  "the state files on disk, with something else in their place",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-odd-")));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /*
     * A plain read or write of a FIFO waits for the other end in one of
     * Node's worker threads, and `process.exit` waits for that thread. The
     * hook would answer and then not end, and Claude Code lets the agent
     * stop when it cancels a hook. So each of these must answer at once.
     */

    it("refuses to read a FIFO, at once", async () => {
      const files = realStateFiles(dir);
      const path = join(dir, "fifo-read.json");
      execFileSync("mkfifo", [path]);
      const started = Date.now();
      await expect(files.read(path)).rejects.toThrow(
        `${path} is a FIFO, not a regular file`,
      );
      expect(await loadState(files, path)).toBe("unusable");
      expect(await loadStart(files, path)).toMatchObject({ kind: "unusable" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("replaces a FIFO with the file it writes, at once", async () => {
      const files = realStateFiles(dir);
      const path = join(dir, "fifo-write.json");
      execFileSync("mkfifo", [path]);
      const started = Date.now();
      const state: StopState = { blocks: 1, same: 1, signature: "A" };
      expect(await saveState(files, path, state)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(await loadState(files, path)).toEqual(state);
      // No temporary file is left beside it.
      expect(
        readdirSync(dir).filter((name) => name.includes("fifo-write")),
      ).toEqual(["fifo-write.json"]);
    });

    it("does not create over a FIFO, and does not wait on it", async () => {
      const files = realStateFiles(dir);
      const path = join(dir, "fifo-create.json");
      execFileSync("mkfifo", [path]);
      const started = Date.now();
      expect(await files.create(path, "x")).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("refuses to read through a symlink, and writes over the link, not its target", async () => {
      const files = realStateFiles(dir);
      const target = join(dir, "target.txt");
      const path = join(dir, "link.json");
      writeFileSync(target, "keep\n");
      symlinkSync(target, path);
      await expect(files.read(path)).rejects.toThrow();
      await files.write(path, "new\n");
      expect(readFileSync(target, "utf8")).toBe("keep\n");
      expect(lstatSync(path).isFile()).toBe(true);
      expect(await files.read(path)).toBe("new\n");
    });

    it("refuses a directory in the place of the file", async () => {
      const files = realStateFiles(dir);
      const path = join(dir, "dir.json");
      mkdirSync(path);
      await expect(files.read(path)).rejects.toThrow(
        `${path} is a directory, not a regular file`,
      );
    });
  },
);
