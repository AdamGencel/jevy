import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startPath, statePath } from "./state.js";

/**
 * The built `jevy` executable as Claude Code runs it: a process with an
 * exit code. What is tested here cannot be seen from inside `run`: that the
 * process ends with exit code 2 and not Node's 1 when it crashes, and that
 * it ends at all when something it was waiting for never comes back.
 *
 * `pnpm --filter @jevyjs/cli run build` writes the executable; these tests
 * are skipped, and say so, when it is not there.
 */

const BIN = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const built = existsSync(BIN);
const usable = built && process.platform !== "win32";
const title = usable
  ? "the built jevy executable"
  : `the built jevy executable (SKIPPED: ${built ? "these tests need a POSIX shell" : `${BIN} is absent; run \`pnpm --filter @jevyjs/cli run build\` first`})`;

const base = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-bin-")));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Ended {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function fresh(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `jevy hook <args>` with `input` on stdin, ended. */
function jevy(
  args: readonly string[],
  input = "",
  env: Readonly<Record<string, string>> = {},
): Ended {
  const result = spawnSync(process.execPath, [BIN, "hook", ...args], {
    cwd: base,
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * As `jevy`, without blocking the test's own thread, and killed after 30 s
 * so that a hook that hangs fails the test instead of holding it.
 */
function jevyAsync(
  args: readonly string[],
  input: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Ended> {
  const child = spawn(process.execPath, [BIN, "hook", ...args], {
    cwd: base,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(input);
  const kill = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  return new Promise((resolve) => {
    child.on("close", (status) => {
      clearTimeout(kill);
      resolve({ status, stdout, stderr });
    });
  });
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

const TWO_TESTS = `import { test, expect } from "vitest";
test("one", () => { expect(1).toBe(1); });
test("two", () => { expect(2).toBe(2); });
`;

const ONE_TEST = `import { test, expect } from "vitest";
test("one", () => { expect(1).toBe(1); });
`;

/** A git repository in `dir` with this config and these files, committed. */
function repoAt(
  dir: string,
  config: string,
  files: Readonly<Record<string, string>> = {},
): void {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.name", "Jevy Test");
  gitIn(dir, "config", "user.email", "jevy-test@example.invalid");
  gitIn(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "jevy.config.ts"), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "init");
}

describe.skipIf(!usable)(title, () => {
  describe("started in a directory that has been deleted", () => {
    /** The shell removes its own working directory, then becomes jevy. */
    function fromDeleted(hook: string): Ended {
      const dir = fresh(`gone-${hook}`);
      const result = spawnSync(
        "/bin/sh",
        [
          "-c",
          'rmdir "$1" && exec "$2" "$3" hook "$4"',
          "sh",
          dir,
          process.execPath,
          BIN,
          hook,
        ],
        { cwd: dir, input: "", encoding: "utf8", timeout: 60_000 },
      );
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    it.each(["stop", "pre-edit"])("hook %s exits 2, not 1", (hook) => {
      const result = fromDeleted(hook);
      expect(result.stderr).toContain("jevy hook: ");
      expect(result.stderr).toContain("uv_cwd");
      expect(result.stdout).toBe("");
      expect(result.status).toBe(2);
    });

    it("hook session-start exits 0 and prints nothing", () => {
      const result = fromDeleted("session-start");
      expect(result.stdout).toBe("");
      expect(result.status).toBe(0);
    });
  });

  describe("with a FIFO in the place of the config", () => {
    const dir = fresh("fifo");
    execFileSync("mkfifo", [join(dir, "jevy.config.ts")]);

    it("hook stop exits 2 at once and does not wait for a writer", () => {
      const started = Date.now();
      const result = jevy(["stop", "--cwd", dir]);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.stderr).toContain(
        "jevy.config.ts is a FIFO, not a regular file.",
      );
      expect(result.status).toBe(2);
    });

    it("hook pre-edit exits 2 at once", () => {
      const started = Date.now();
      const result = jevy(
        ["pre-edit", "--cwd", dir],
        JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: join(dir, "src", "app.ts") },
        }),
      );
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.stderr).toContain(
        "jevy.config.ts is a FIFO, not a regular file.",
      );
      expect(result.status).toBe(2);
    });
  });

  describe("with a FIFO where the hook keeps what it remembers", () => {
    /**
     * A plain read or write of a FIFO holds one of Node's worker threads
     * until the other end is opened, and `process.exit` waits for that
     * thread: the hook would write its answer and then run until Claude
     * Code cancels it, which lets the agent stop.
     */
    it.each([
      ["the stop count", "count"],
      ["the record of the session's start", "start"],
    ] as const)(
      "hook stop exits 2 within its deadline: FIFO at %s",
      async (_name, which) => {
        const dir = fresh(`fifo-state-${which}`);
        const stateDir = fresh(`fifo-state-${which}-tmp`);
        repoAt(dir, `export default { checks: ["false"] };\n`);
        const path =
          which === "count"
            ? statePath(stateDir, dir, "s1")
            : startPath(stateDir, dir, "s1");
        execFileSync("mkfifo", [path]);
        const started = Date.now();
        const result = await jevyAsync(
          ["stop", "--cwd", dir, "--deadline", "3"],
          JSON.stringify({ session_id: "s1", stop_hook_active: false }),
          { TMPDIR: stateDir },
        );
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          "jevy hook stop: the work is not done.",
        );
      },
      30_000,
    );
  });

  describe("git replace", () => {
    it("does not hide what the session committed", () => {
      const dir = fresh("replace");
      const stateDir = fresh("replace-tmp");
      repoAt(dir, `export default { checks: ["true"] };\n`, {
        "src/a.test.ts": TWO_TESTS,
      });
      const env = { TMPDIR: stateDir };
      const input = JSON.stringify({ session_id: "s1" });
      expect(jevy(["session-start", "--cwd", dir], input, env).status).toBe(0);
      const start = gitIn(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "src", "a.test.ts"), ONE_TEST);
      gitIn(dir, "commit", "-q", "-am", "weaken");
      gitIn(dir, "replace", start, "HEAD");
      const result = jevy(["stop", "--cwd", dir], input, env);
      expect(result.stderr).toContain("since the session's start");
      expect(result.status).toBe(2);
    });
  });

  describe("a guard that takes too long", () => {
    it("is killed at the deadline, and the hook blocks in time", async () => {
      const dir = fresh("slow-guard");
      const lines = ['import { test, expect } from "vitest";'];
      for (let index = 0; index < 200_000; index += 1) {
        const n = String(index);
        lines.push(`test("t${n}", () => { expect(${n}).toBe(${n}); });`);
      }
      repoAt(dir, `export default { checks: ["true"] };\n`, {
        "src/a.test.ts": `${lines.join("\n")}\n`,
      });
      writeFileSync(
        join(dir, "src", "a.test.ts"),
        `${lines.join("\n").replaceAll("toBe(", "toEqual(")}\n`,
      );
      const started = Date.now();
      const result = await jevyAsync(
        ["stop", "--cwd", dir, "--deadline", "1"],
        "",
      );
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.stderr).toContain("not finished: jevy guard");
      expect(result.status).toBe(2);
    }, 60_000);
  });

  describe("when the deadline passes", () => {
    it("hook stop kills the check that hangs, exits 2 and names it", () => {
      const dir = fresh("hang");
      writeFileSync(
        join(dir, "jevy.config.ts"),
        `export default { checks: ["sleep 300", "echo never"] };\n`,
      );
      const started = Date.now();
      const result = jevy(["stop", "--cwd", dir, "--deadline", "1"]);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.stderr).toContain(
        "The hook ran out of time: its limit of 1 s passed while it was running the check sleep 300.",
      );
      expect(result.stderr).toContain(
        "  killed while it was running: sleep 300\n  not started: echo never\n",
      );
      expect(result.stdout).toBe("");
      expect(result.status).toBe(2);
    });

    it("the process ends although its stdin is never closed", async () => {
      const dir = fresh("stdin");
      const child = spawn(
        process.execPath,
        [BIN, "hook", "pre-edit", "--cwd", dir, "--deadline", "1"],
        { cwd: base, stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 30_000);
      // Nothing is written to stdin and it is left open.
      const status = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => {
          resolve(code);
        });
      });
      clearTimeout(kill);
      expect(stderr).toContain(
        "jevy hook pre-edit: the edit could not be checked within 1 s",
      );
      expect(status).toBe(2);
    }, 40_000);
  });
});
