import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CliResult } from "../cli.js";
import { analyse } from "./analyse.js";
import { GuardError, UsageError } from "./errors.js";
import { openGitRepo, type GitReaderOptions, type GitRepo } from "./git.js";
import { buildReport, exitCodeFor, formatHuman, formatJson } from "./report.js";
import type { FailOn } from "./types.js";

/** Argument parsing and exit codes for `jevy guard`. */

export const GUARD_USAGE = `Usage: jevy guard --base <ref> [--head <ref>] [--json]
                  [--fail-on weakening|review|never] [--cache-dir <dir>] [--cwd <dir>]

Compares tests, Jevy and Playwright config, and cached decisions between two
versions of the repository, and reports changes that weaken them. Nothing from
the repository is run: files are parsed only.

  --base <ref>       Version to compare against. Required.
  --head <ref>       Version to check. Default: the working tree, untracked files included.
  --json             Print one JSON document (schema v1) instead of text.
  --fail-on <level>  weakening (default), review or never.
  --cache-dir <dir>  Decision cache directory. Default: .jevy/decisions
  --cwd <dir>        Run as if started in <dir>.

Exit codes: 0 nothing at or above --fail-on, 1 something is, 2 usage or git error.
`;

const DEFAULT_CACHE_DIR = ".jevy/decisions";
const WORKING_TREE = "working-tree";
const FAIL_ON: readonly FailOn[] = ["weakening", "review", "never"];
const VALUE_FLAGS = new Set([
  "--base",
  "--head",
  "--fail-on",
  "--cache-dir",
  "--cwd",
]);

export interface GuardOptions {
  readonly base: string;
  readonly head: string | undefined;
  readonly json: boolean;
  readonly failOn: FailOn;
  readonly cacheDir: string;
  readonly cwd: string | undefined;
}

export interface GuardDeps {
  /** Directory relative paths are resolved against. */
  readonly cwd: string;
  readonly openRepo: (options: GitReaderOptions) => Promise<GitRepo>;
  readonly realpath: (path: string) => Promise<string>;
}

function defaultDeps(): GuardDeps {
  return {
    cwd: process.cwd(),
    openRepo: openGitRepo,
    realpath: (path) => realpath(path),
  };
}

function isFailOn(value: string): value is FailOn {
  return (FAIL_ON as readonly string[]).includes(value);
}

/** Refs go to git as arguments; one starting with `-` would read as an option. */
function checkRef(flag: string, value: string): string {
  if (value.startsWith("-")) {
    throw new UsageError(`${flag} must not start with '-': ${value}`);
  }
  if (value === "") {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

/** Parse `jevy guard` arguments, or return "help". Throws `UsageError`. */
export function parseGuardArgs(argv: readonly string[]): GuardOptions | "help" {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(
        arg.startsWith("-")
          ? `unknown option '${arg}'`
          : `unexpected argument '${arg}'`,
      );
    }
    let value: string | undefined;
    if (flag !== arg) {
      value = arg.slice(eq + 1);
    } else {
      index += 1;
      value = argv[index];
    }
    if (value === undefined) {
      throw new UsageError(`${flag} needs a value`);
    }
    if (values.has(flag)) {
      throw new UsageError(`${flag} given twice`);
    }
    values.set(flag, value);
  }

  const base = values.get("--base");
  if (base === undefined) {
    throw new UsageError("--base is required");
  }
  const head = values.get("--head");
  const failOn = values.get("--fail-on") ?? "weakening";
  if (!isFailOn(failOn)) {
    throw new UsageError(
      `--fail-on must be weakening, review or never: ${failOn}`,
    );
  }
  const cacheDir = values.get("--cache-dir") ?? DEFAULT_CACHE_DIR;
  if (cacheDir === "") {
    throw new UsageError("--cache-dir needs a value");
  }
  return {
    base: checkRef("--base", base),
    head: head === undefined ? undefined : checkRef("--head", head),
    json,
    failOn,
    cacheDir,
    cwd: values.get("--cwd"),
  };
}

/** The cache directory relative to the repository root, with forward slashes. */
function repoRelative(root: string, cwd: string, dir: string): string {
  const path = relative(root, resolve(cwd, dir));
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    throw new UsageError(`--cache-dir must be inside the repository: ${dir}`);
  }
  return path.split(sep).join("/");
}

function failure(error: unknown): CliResult {
  const message = error instanceof Error ? error.message : String(error);
  const usage = error instanceof UsageError ? `\n${GUARD_USAGE}` : "";
  return { code: 2, stdout: "", stderr: `jevy guard: ${message}\n${usage}` };
}

/** Run `jevy guard`. Never throws: every failure is exit code 2. */
export async function runGuard(
  argv: readonly string[],
  deps: GuardDeps = defaultDeps(),
): Promise<CliResult> {
  try {
    const options = parseGuardArgs(argv);
    if (options === "help") {
      return { code: 0, stdout: GUARD_USAGE, stderr: "" };
    }
    const cwd = resolve(deps.cwd, options.cwd ?? ".");
    const repo = await deps.openRepo({
      cwd,
      base: options.base,
      head: options.head,
    });
    // git reports the root with symlinks resolved; resolve cwd the same way.
    const cacheDir = repoRelative(
      repo.root,
      await deps.realpath(cwd),
      options.cacheDir,
    );
    const findings = await analyse(repo.reader, { cacheDir });
    const report = buildReport(
      options.base,
      options.head ?? WORKING_TREE,
      findings,
    );
    return {
      code: exitCodeFor(report.summary, options.failOn),
      stdout: options.json ? formatJson(report) : formatHuman(report),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof GuardError) {
      return failure(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(new Error(`unexpected error: ${message}`));
  }
}
