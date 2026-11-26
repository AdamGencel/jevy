import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { CliResult } from "../cli.js";
import { GIT_ENV } from "./git.js";

/**
 * `jevy guard` in a process of its own, for the stop hook.
 *
 * The guard parses test files with TypeScript, synchronously. Run inside
 * the hook, a large enough file held the hook's only thread for seconds
 * past its deadline, and a larger one ran it out of memory: Node then ends
 * with a code that is not 2, which Claude Code reads as "carry on". In a
 * child the hook's own timer keeps running, the child is killed when the
 * deadline passes, and a child that dies is a guard that could not run,
 * which blocks.
 */

export type RunGuard = (
  argv: readonly string[],
  signal?: AbortSignal,
) => Promise<CliResult>;

/**
 * The child's heap, in megabytes. Enough for any test file a person writes,
 * and a bound on what a crafted one can take from the machine: past it the
 * child dies, and the hook blocks.
 */
export const GUARD_HEAP_MB = 2048;

/**
 * The most of the guard's report that is kept. Its `--json` report lists
 * findings, and the hook reads only a few of them; a report past this is
 * refused rather than held in memory.
 */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/** The guard's error text is short, and its first line is what is shown. */
const MAX_ERROR_BYTES = 64 * 1024;

/**
 * This package's own built executable, beside the running module's
 * directory, or null when it is not there. It is not there when the hooks
 * run from source, under the unit tests, and the guard then runs in the same
 * process.
 */
export function builtBin(
  url: URL = new URL("../bin.js", import.meta.url),
): string | null {
  const path = fileURLToPath(url);
  return existsSync(path) ? path : null;
}

function failed(message: string): CliResult {
  return { code: 2, stdout: "", stderr: `jevy guard: ${message}\n` };
}

/**
 * Kill the guard and the git commands it started. On POSIX the child leads
 * its own process group, and the negative pid signals all of it.
 */
function killGroup(child: ChildProcessByStdio<null, Readable, Readable>): void {
  try {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // It ended on its own in the meantime.
  }
}

/** Why a child that was ended by `signal` did not answer. */
function diedOf(signal: string): string {
  const memory =
    signal === "SIGABRT"
      ? ", which is how Node stops when it runs out of memory"
      : "";
  return `the guard process was ended by ${signal}${memory}`;
}

/**
 * Run `node <bin> guard <argv>` and answer as `runGuard` does. Never
 * rejects. Exit codes 0 and 1 come back with the report; any other code
 * comes back as it is, which the stop hook reads as "could not run". A
 * child ended by a signal, one that cannot be started, one whose report is
 * too large, and one killed because `signal` aborted all answer exit 2.
 */
export function guardInChild(bin: string): RunGuard {
  return (argv, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(failed("not started: the hook's deadline had passed"));
        return;
      }
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(
          process.execPath,
          [
            `--max-old-space-size=${String(GUARD_HEAP_MB)}`,
            bin,
            "guard",
            ...argv,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...GIT_ENV },
            detached: process.platform !== "win32",
            windowsHide: true,
          },
        );
      } catch (error) {
        resolve(failed(`could not be started: ${String(error)}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      const finish = (result: CliResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", stop);
        resolve(result);
      };
      const stop = (): void => {
        killGroup(child);
        finish(failed("stopped: the hook's deadline passed"));
      };
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_REPORT_BYTES) {
          killGroup(child);
          finish(
            failed(
              `its report was larger than ${String(MAX_REPORT_BYTES / 1024 / 1024)} MB, so the hook did not read it`,
            ),
          );
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errBytes < MAX_ERROR_BYTES) {
          err.push(chunk);
          errBytes += chunk.length;
        }
      });
      child.on("error", (error) => {
        finish(failed(`could not be started: ${error.message}`));
      });
      child.on("close", (code, ended) => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        if (ended !== null || code === null) {
          // What a dying Node prints is a stack dump: the reason alone is
          // what the agent and the person can use.
          finish(failed(diedOf(ended ?? "an unknown signal")));
          return;
        }
        finish({ code, stdout, stderr });
      });
    });
}
