import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { builtBin, guardInChild } from "./guard-process.js";

/**
 * The guard run in a child process, against a stand-in for `dist/bin.js`
 * that behaves as it is told by its first argument after `guard`.
 */

const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-guard-process-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FAKE = join(dir, "bin.mjs");
writeFileSync(
  FAKE,
  `const [command, mode] = process.argv.slice(2);
if (command !== "guard") process.exit(9);
switch (mode) {
  case "env":
    process.stdout.write(JSON.stringify({
      replace: process.env.GIT_NO_REPLACE_OBJECTS ?? null,
      execArgv: process.execArgv,
      args: process.argv.slice(3),
    }));
    break;
  case "weak":
    process.stdout.write('{"findings":[]}');
    process.exitCode = 1;
    break;
  case "odd":
    process.stderr.write("jevy guard: something odd\\n");
    process.exitCode = 7;
    break;
  case "abort":
    process.abort();
    break;
  case "hang":
    setInterval(() => undefined, 1000);
    break;
  case "big":
    process.stdout.write("x".repeat(40 * 1024 * 1024));
    break;
}
`,
);

describe("guardInChild", () => {
  const guard = guardInChild(FAKE);

  it("runs the guard with git replacements off and a bounded heap", async () => {
    const result = await guard(["env", "--base", "main"]);
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout) as {
      readonly replace: string | null;
      readonly execArgv: readonly string[];
      readonly args: readonly string[];
    };
    expect(seen.replace).toBe("1");
    expect(
      seen.execArgv.some((arg) => arg.startsWith("--max-old-space-size=")),
    ).toBe(true);
    expect(seen.args).toEqual(["env", "--base", "main"]);
  });

  it("passes on exit 1 with its report, and any other exit code as it is", async () => {
    expect(await guard(["weak"])).toEqual({
      code: 1,
      stdout: '{"findings":[]}',
      stderr: "",
    });
    expect(await guard(["odd"])).toEqual({
      code: 7,
      stdout: "",
      stderr: "jevy guard: something odd\n",
    });
  });

  it("reports a guard that died (out of memory ends the same way) as one that could not run", async () => {
    const result = await guard(["abort"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "jevy guard: the guard process was ended by SIGABRT, which is how Node stops when it runs out of memory\n",
    );
  });

  it("refuses a report larger than it keeps", async () => {
    const result = await guard(["big"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^jevy guard: its report was larger than/);
  }, 20_000);

  it("kills the guard when the signal aborts, and answers at once", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = guard(["hang"], controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 200);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("stopped");
  });

  it("does not start when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await guard(["env"], controller.signal)).code).toBe(2);
  });

  it("never answers clean when the guard cannot be loaded", async () => {
    const result = await guardInChild(join(dir, "missing.mjs"))(["env"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });
});

describe("builtBin", () => {
  it("is the file when it exists, and null when it does not", () => {
    expect(builtBin(pathToFileURL(FAKE))).toBe(FAKE);
    expect(builtBin(pathToFileURL(join(dir, "missing.js")))).toBeNull();
  });
});
