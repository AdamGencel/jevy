import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * The processes a hook starts: the project's check commands, and one git
 * query. Both are behind `HookDeps`, so the hook logic is tested without
 * starting anything.
 */

export interface CommandResult {
  /** The exit code; null when the command was killed or never started. */
  readonly code: number | null;
  /**
   * True when the command was killed because it ran past its time limit or
   * because the caller's signal aborted.
   */
  readonly timedOut: boolean;
  /** Stdout and stderr together, in the order they arrived; the end of it when long. */
  readonly output: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  /**
   * Aborts when the hook's own deadline passes: the command and everything
   * it started are killed at once, so nothing outlives the hook.
   */
  readonly signal?: AbortSignal | undefined;
}

export type RunCommand = (
  command: string,
  options: RunOptions,
) => Promise<CommandResult>;

/**
 * How much output is kept. The hook shows the last 4,000 characters, so this
 * is plenty, and a check that prints without end cannot fill memory.
 */
const KEEP_BYTES = 64 * 1024;

/** The last `KEEP_BYTES` of what has been added. */
class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;

  public add(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= KEEP_BYTES) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
  }

  public text(): string {
    const all = Buffer.concat(this.chunks);
    if (all.length <= KEEP_BYTES) {
      return all.toString("utf8");
    }
    // The cut can land inside a multi-byte character; drop the broken start.
    return all
      .subarray(all.length - KEEP_BYTES)
      .toString("utf8")
      .replace(/^\uFFFD+/, "");
  }
}

/**
 * Kill the command and everything it started. On POSIX the command is the
 * leader of its own process group (see `detached` below), and the negative
 * pid signals the whole group: killing only the shell would leave the test
 * runner it started running. Windows has no process groups, so only the
 * shell is killed there.
 */
function killTree(pid: number | undefined, kill: () => void): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      kill();
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // It ended on its own between the timer firing and the signal.
  }
}

/**
 * How long the output of a shell that has exited is waited for. Its pipes
 * close when the last process holding them ends, and the group has just
 * been killed, so this only runs out for a process that left the group.
 */
const DRAIN_MS = 1000;

function notStarted(error: unknown): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: null,
    timedOut: false,
    output: `the command could not be started: ${message}\n`,
  };
}

/**
 * Run `command` through the shell in `cwd`, as a person would type it, and
 * wait for it. Never rejects: a command that cannot be started is a result
 * with no exit code, because to the stop hook it is one more failed check.
 *
 * The result is the shell's own exit. A command that leaves a job running
 * (`server & exit 0`) has still exited 0; waiting for the job to close the
 * pipes would turn that into a timeout. What the shell leaves behind in its
 * process group is killed when it exits, so a check cannot leave a process
 * running after the hook.
 *
 * The command gets no stdin. The hook's own stdin is the agent's JSON, and a
 * check that waits for input (a watch mode, a prompt) would otherwise hang
 * until the time limit.
 */
export const runShell: RunCommand = (command, options) =>
  new Promise((resolve) => {
    const { signal } = options;
    if (signal?.aborted === true) {
      resolve({ code: null, timedOut: true, output: "" });
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      // Node refuses an empty command before it starts anything.
      resolve(notStarted(error));
      return;
    }
    const output = new OutputTail();
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (result: Omit<CommandResult, "output">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal?.removeEventListener("abort", stop);
      // A process that left the group may still hold the pipes; letting go
      // of them here keeps it from holding the hook as well.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, output: output.text() });
    };
    const stop = (): void => {
      killTree(child.pid, () => child.kill());
      // Resolve now, not on "close": a grandchild that survived would keep
      // the pipes open and the hook waiting.
      finish({ code: null, timedOut: true });
    };
    const timer = setTimeout(stop, options.timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output.add(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output.add(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        output.add(Buffer.from(notStarted(error).output));
      }
      finish({ code: null, timedOut: false });
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      // The shell has answered; the time limit was for it.
      clearTimeout(timer);
      killTree(child.pid, () => undefined);
      drain = setTimeout(() => {
        finish({ code, timedOut: false });
      }, DRAIN_MS);
      // "close" comes once the pipes are read to their end, with this code.
      child.once("close", () => {
        finish({ code, timedOut: false });
      });
    });
  });

/**
 * Whether `ref` names a commit in the repository around `cwd`. False for
 * anything else, a missing repository or a missing git included: the caller
 * is choosing between two candidate refs, and the guard reports the real
 * error when neither exists.
 */
export function gitRefExists(ref: string, cwd: string): Promise<boolean> {
  // Git would read a ref that starts with `-` as an option.
  if (ref.startsWith("-")) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error) => {
        resolve(error === null);
      },
    );
  });
}
