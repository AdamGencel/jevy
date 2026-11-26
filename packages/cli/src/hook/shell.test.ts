import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitRefExists, runShell } from "./shell.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-shell-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LONG = { cwd: dir, timeoutMs: 20_000 };

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runShell", () => {
  it("reports exit code 0 and the output", async () => {
    expect(await runShell(`node -e "console.log('hello')"`, LONG)).toEqual({
      code: 0,
      timedOut: false,
      output: "hello\n",
    });
  });

  it("reports a failing exit code", async () => {
    const result = await runShell(`node -e "process.exit(3)"`, LONG);
    expect(result).toEqual({ code: 3, timedOut: false, output: "" });
  });

  it("captures stdout and stderr together", async () => {
    const result = await runShell(
      `node -e "console.log('out'); console.error('err')"`,
      LONG,
    );
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("runs through the shell, in the given directory", async () => {
    const result = await runShell(
      `node -e "console.log(process.cwd())" && node -e "process.exit(4)"`,
      LONG,
    );
    expect(result.output.trim()).toBe(dir);
    expect(result.code).toBe(4);
  });

  it("gives the command no input to wait on", async () => {
    const result = await runShell(
      `node -e "process.stdin.on('data', () => {}).on('end', () => console.log('eof'))"`,
      LONG,
    );
    expect(result).toEqual({ code: 0, timedOut: false, output: "eof\n" });
  });

  it("kills a command, and what it started, past the time limit", async () => {
    const started = Date.now();
    // The shell stays as the parent because another command follows, so
    // killing the shell alone would leave node running.
    const result = await runShell(
      `node -e "console.log('pid ' + process.pid); setTimeout(() => {}, 60000)"; echo after`,
      { cwd: dir, timeoutMs: 1500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.output).not.toContain("after");
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(/pid (\d+)/.exec(result.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => isRunning(pid), { timeout: 5000 }).toBe(false);
  });

  it("keeps only the end of very long output", async () => {
    const result = await runShell(
      `node -e "for (let i = 0; i < 20000; i += 1) console.log('line ' + i)"`,
      LONG,
    );
    expect(result.code).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.output.endsWith("line 19999\n")).toBe(true);
  });

  it("reports a command that cannot be started, without throwing", async () => {
    const result = await runShell("echo hi", {
      cwd: join(dir, "missing"),
      timeoutMs: 20_000,
    });
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("could not be started");
  });
  it("decides by the shell's exit, not by what it left running", async () => {
    const started = Date.now();
    // The background job keeps the pipes open after the shell has exited 0.
    const result = await runShell(
      `node -e "console.log('pid ' + process.pid); setTimeout(() => {}, 60000)" & sleep 0.5; exit 0`,
      { cwd: dir, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
    // What it left running is killed with it.
    const pid = Number(/pid (\d+)/.exec(result.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => isRunning(pid), { timeout: 5000 }).toBe(false);
  });

  it("reports an empty command as one that could not be started", async () => {
    const result = await runShell("", LONG);
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("could not be started");
  });

  it("kills the command when its signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runShell(
      `node -e "console.log('pid ' + process.pid); setTimeout(() => {}, 60000)"; echo after`,
      { cwd: dir, timeoutMs: 60_000, signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 1000);
    const result = await running;
    expect(result.code).toBeNull();
    expect(result.output).not.toContain("after");
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(/pid (\d+)/.exec(result.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => isRunning(pid), { timeout: 5000 }).toBe(false);
  });

  it("does not start a command whose signal has already aborted", async () => {
    const result = await runShell(`node -e "console.log('ran')"`, {
      ...LONG,
      signal: AbortSignal.abort(),
    });
    expect(result.code).toBeNull();
    expect(result.output).not.toContain("ran");
  });
});

describe("gitRefExists", () => {
  it("tells an existing ref from a missing one", async () => {
    const repo = join(dir, "repo");
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git("config", "user.name", "Jevy Test");
    git("config", "user.email", "jevy-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "first");
    expect(await gitRefExists("main", repo)).toBe(true);
    expect(await gitRefExists("origin/main", repo)).toBe(false);
    expect(await gitRefExists("--help", repo)).toBe(false);
  });

  it("is false outside a repository", async () => {
    expect(await gitRefExists("main", join(dir, "missing"))).toBe(false);
  });
});
