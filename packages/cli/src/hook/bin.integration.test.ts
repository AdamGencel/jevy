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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

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
function jevy(args: readonly string[], input = ""): Ended {
  const result = spawnSync(process.execPath, [BIN, "hook", ...args], {
    cwd: base,
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
