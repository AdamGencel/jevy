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

  it("prints that version", () => {
    expect(run(["--version"], "0.0.1")).toEqual({
      code: 0,
      stdout: "0.0.1\n",
      stderr: "",
    });
  });

  it("prints a short help stub when given no arguments", () => {
    const result = run([], "0.0.1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("jevy 0.0.1");
    expect(result.stdout).toContain("not implemented yet");
    expect(result.stderr).toBe("");
  });

  it("rejects product commands until they exist", () => {
    const result = run(["record", "sign up"], "0.0.1");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("jevy: unknown command 'record'\n");
  });
});
