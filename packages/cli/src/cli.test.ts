import { describe, expect, it } from "vitest";
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
});
