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
import { afterAll, describe, expect, it } from "vitest";
import { defaultHookDeps } from "./deps.js";

/** The real file reads behind the hooks, on a real file system. */

const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-deps-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const posix = process.platform !== "win32";

describe("the default readFile", () => {
  const { readFile } = defaultHookDeps();

  it("reads a regular file", async () => {
    const path = join(dir, "jevy.config.ts");
    writeFileSync(path, "export default {};\n");
    expect(await readFile(path)).toBe("export default {};\n");
  });

  it("reads a missing file, or one below a file, as null", async () => {
    expect(await readFile(join(dir, "missing.ts"))).toBeNull();
    expect(await readFile(join(dir, "jevy.config.ts", "below"))).toBeNull();
  });

  it("refuses a directory in the place of the file", async () => {
    const path = join(dir, "jevy.config.mts");
    mkdirSync(path);
    await expect(readFile(path)).rejects.toThrow(
      `${path} is a directory, not a regular file`,
    );
  });

  it("refuses a symlink, even one to a regular file", async () => {
    const path = join(dir, "jevy.config.js");
    symlinkSync(join(dir, "jevy.config.ts"), path);
    await expect(readFile(path)).rejects.toThrow(
      `${path} is a symlink, not a regular file`,
    );
  });

  it.runIf(posix)(
    "refuses a FIFO at once, and does not wait for a writer",
    async () => {
      const path = join(dir, "jevy.config.mjs");
      execFileSync("mkfifo", [path]);
      const started = Date.now();
      await expect(readFile(path)).rejects.toThrow(
        `${path} is a FIFO, not a regular file`,
      );
      expect(Date.now() - started).toBeLessThan(2000);
    },
  );

  it("says what a person has to do", async () => {
    await expect(readFile(join(dir, "jevy.config.mts"))).rejects.toThrow(
      "The hook reads the config only from a regular file, so a person has to put one back.",
    );
  });
});

describe("the default readlink", () => {
  const { readlink } = defaultHookDeps();

  it("gives the text of a symlink, dangling or not", async () => {
    symlinkSync("../nowhere/new.ts", join(dir, "dangling"));
    expect(await readlink(join(dir, "dangling"))).toBe("../nowhere/new.ts");
    expect(await readlink(join(dir, "jevy.config.js"))).toBe(
      join(dir, "jevy.config.ts"),
    );
  });

  it("is null for what is not a symlink or is not there", async () => {
    expect(await readlink(join(dir, "jevy.config.ts"))).toBeNull();
    expect(await readlink(join(dir, "missing"))).toBeNull();
    expect(await readlink(join(dir, "jevy.config.ts", "below"))).toBeNull();
  });
});
