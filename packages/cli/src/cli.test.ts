import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";
import { readPackageVersion } from "./version.js";

describe("jevy", () => {
  it("reads the version from package.json", () => {
    const version = readPackageVersion(
      new URL("../package.json", import.meta.url),
    );
    expect(version).toBe("0.0.1");
  });

  it("prints that version", async () => {
    expect(await run(["--version"], "0.0.1")).toEqual({
      code: 0,
      stdout: "0.0.1\n",
      stderr: "",
    });
  });

  it("prints help listing guard when given no arguments", async () => {
    const result = await run([], "0.0.1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("jevy 0.0.1");
    expect(result.stdout).toContain("guard");
    expect(result.stdout).toContain("  hook ");
    expect(result.stdout).toContain("jevy hook --help");
    expect(result.stdout).toContain("not implemented yet");
    expect(result.stderr).toBe("");
    expect(await run(["--help"], "0.0.1")).toEqual(result);
  });

  it("rejects product commands until they exist", async () => {
    const result = await run(["record", "sign up"], "0.0.1");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("jevy: unknown command 'record'\n");
  });

  it("routes guard to its command", async () => {
    const result = await run(["guard"], "0.0.1");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jevy guard: --base is required");
  });

  it("routes hook to its command", async () => {
    const help = await run(["hook", "--help"], "0.0.1");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(
      "Usage: jevy hook <stop|pre-edit|session-start|print>",
    );
    const bare = await run(["hook"], "0.0.1");
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain(
      "jevy hook: expected stop, pre-edit, session-start or print",
    );
    const print = await run(["hook", "print", "--agent", "claude"], "0.0.1");
    expect(print.code).toBe(0);
    expect(JSON.parse(print.stdout)).toHaveProperty("hooks.Stop");
  });

  it("gives the hook the input and the directory it is handed", async () => {
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "jevy.config.ts" },
    });
    const result = await run(["hook", "pre-edit"], "0.0.1", {
      hook: {
        cwd: "/nowhere/project",
        readStdin: () => Promise.resolve(stdin),
      },
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("jevy.config.ts is protected");
  });

  describe("when the working directory is gone", () => {
    // What Node does in a directory that has been deleted.
    function withoutCwd(): void {
      vi.spyOn(process, "cwd").mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory, uv_cwd");
      });
    }
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(["stop", "pre-edit"])("hook %s exits 2, never 1", async (name) => {
      withoutCwd();
      // Exit 1 is "carry on" to Claude Code: the hook would be off.
      expect(await run(["hook", name], "0.0.1")).toEqual({
        code: 2,
        stdout: "",
        stderr: "jevy hook: ENOENT: no such file or directory, uv_cwd\n",
      });
    });

    it("hook session-start exits 0, having nothing to block", async () => {
      withoutCwd();
      const result = await run(["hook", "session-start"], "0.0.1");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("jevy hook: ENOENT");
    });

    it("leaves the other commands as they were", async () => {
      withoutCwd();
      await expect(run(["guard", "--base", "main"], "0.0.1")).rejects.toThrow(
        "uv_cwd",
      );
      expect((await run(["--version"], "0.0.1")).code).toBe(0);
    });
  });

  it("reads no stdin unless it is handed one", async () => {
    // With no input the pre-edit hook cannot check the edit, so it blocks;
    // what matters here is that it answers and does not wait on stdin.
    const result = await run(["hook", "pre-edit"], "0.0.1");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the hook input is not a JSON object");
  });
});
