import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CliResult } from "../cli.js";
import { analyseAll, type AnalyseOptions } from "./analyse.js";
import {
  findConfig,
  readConfigSettings,
  type ConfigSettings,
} from "./config-source.js";
import { GuardError, UsageError } from "./errors.js";
import {
  openGitRepo,
  type GitReaderOptions,
  type GitRepo,
  type RepoReader,
} from "./git.js";
import { checkGlob } from "./glob.js";
import { buildProtectRules } from "./protect.js";
import { buildReport, exitCodeFor, formatHuman, formatJson } from "./report.js";
import type { FailOn } from "./types.js";

/** Argument parsing and exit codes for `jevy guard`. */

export const GUARD_USAGE = `Usage: jevy guard --base <ref> [--head <ref>] [--merge-base] [--json]
                  [--fail-on weakening|review|never] [--tests <glob>]...
                  [--cache-dir <dir>] [--cwd <dir>]

Compares tests, Jevy and Playwright config, and cached decisions between two
versions of the repository, and reports changes that weaken them. Nothing from
the repository is run: files are parsed only.

  --base <ref>       Version to compare against. Required.
  --head <ref>       Version to check. Default: the working tree, untracked files
                     included, and what is staged in the index as well.
  --merge-base       Compare against the commit where --head (or HEAD) branched off
                     --base, not the tip of --base. Use it when the target branch
                     of a pull request has moved on.
  --json             Print one JSON document (schema v1) instead of text.
  --fail-on <level>  weakening (default), review or never.
  --tests <glob>     Files to compare as tests, relative to the directory the guard
                     runs in. May be repeated. Default: guard.tests in the config,
                     else **/*.{spec,test}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}
                     Files under node_modules or dist are never compared, whatever
                     the glob says.
  --cache-dir <dir>  Decision cache directory. Default: cache.dir in the config,
                     else .jevy/decisions
  --cwd <dir>        Run as if started in <dir>.

Settings come from the text of jevy.config.* in the directory the guard runs
in, as it is in the base version, so the change under review cannot redefine
what is checked. When only the head version has a config, its guard.tests
adds to the built-in test pattern and does not replace it. A change to a
protected path is reported: any jevy.config.*, the cache directory, the
web3.policy file, and whatever the config lists under protect.

The guard stops with exit code 2 when it cannot be sure what it is looking at:
a --base or --head that names two refs, a config that git ignores, or a working
tree with files marked assume-unchanged or skip-worktree.

Exit codes: 0 nothing at or above --fail-on, 1 something is, 2 usage, git or
config error.
`;

const DEFAULT_CACHE_DIR = ".jevy/decisions";
const WORKING_TREE = "working-tree";
const FAIL_ON: readonly FailOn[] = ["weakening", "review", "never"];
const TESTS_FLAG = "--tests";
const VALUE_FLAGS = new Set([
  "--base",
  "--head",
  "--fail-on",
  "--cache-dir",
  "--cwd",
  TESTS_FLAG,
]);
const SWITCHES = new Set(["--json", "--merge-base"]);
/** Flags whose value is a path or a glob, and so never starts with `-`. */
const PATH_FLAGS = new Set(["--cache-dir", "--cwd", TESTS_FLAG]);

export interface GuardOptions {
  readonly base: string;
  readonly head: string | undefined;
  readonly json: boolean;
  readonly failOn: FailOn;
  /** `--cache-dir`, or undefined when the config or the default decides. */
  readonly cacheDir: string | undefined;
  readonly cwd: string | undefined;
  /** Compare against the merge base of base and head, not the tip of base. */
  readonly mergeBase: boolean;
  /** `--tests` globs as given, in order; empty when the flag was not used. */
  readonly tests: readonly string[];
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

/**
 * Refs go to git as arguments; one starting with `-` would read as an
 * option. A range or an exclusion (`a..b`, `^a`) is not one version to
 * compare, and git would fail on it later with a message about its own
 * commands.
 */
function checkRef(flag: string, value: string): string {
  if (value.startsWith("-")) {
    throw new UsageError(`${flag} must not start with '-': ${value}`);
  }
  if (value === "") {
    throw new UsageError(`${flag} needs a value`);
  }
  if (value.startsWith("^")) {
    throw new UsageError(
      `${flag} must name one revision, not an exclusion: ${value}`,
    );
  }
  if (value.includes("..")) {
    throw new UsageError(
      `${flag} must name one revision, not a range: ${value}`,
    );
  }
  if (/\s/.test(value)) {
    throw new UsageError(`${flag} must not contain whitespace: '${value}'`);
  }
  return value;
}

/**
 * A path or glob value. One that starts with `-` is almost always the next
 * option, taken as the value because the real one was left out: `--tests
 * --json` would compare the files matching "--json", which is none. A name
 * that does start with `-` can be written `./-name`.
 */
function checkPathValue(flag: string, value: string): string {
  if (value.startsWith("-")) {
    throw new UsageError(`${flag} must not start with '-': ${value}`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `checkGlob`, with the failure rethrown by `fail` so it says where the glob came from. */
function checkGlobFrom(
  glob: string,
  fail: (message: string) => GuardError,
): string {
  try {
    checkGlob(glob);
  } catch (error) {
    throw fail(messageOf(error));
  }
  return glob;
}

/** The flag an argument names (`--base` for `--base=main`) and its inline value. */
function splitArg(arg: string): { flag: string; inline: string | undefined } {
  const eq = arg.indexOf("=");
  return arg.startsWith("--") && eq > 0
    ? { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) }
    : { flag: arg, inline: undefined };
}

interface RawArgs {
  /** Each value flag's one value. */
  readonly values: ReadonlyMap<string, string>;
  readonly tests: readonly string[];
  readonly switches: ReadonlySet<string>;
}

/**
 * Read the flags off `argv` without judging their values, or return "help".
 * `--tests` is the one flag that adds up; any other given twice is more
 * likely a mistake than a wish for the second value.
 */
function readArgs(argv: readonly string[]): RawArgs | "help" {
  const values = new Map<string, string>();
  const tests: string[] = [];
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    const { flag, inline } = splitArg(arg);
    if (SWITCHES.has(arg)) {
      if (switches.has(arg)) {
        throw new UsageError(`${arg} given twice`);
      }
      switches.add(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(
        arg.startsWith("-")
          ? `unknown option '${arg}'`
          : `unexpected argument '${arg}'`,
      );
    }
    if (inline === undefined) {
      index += 1;
    }
    const value = inline ?? argv[index];
    if (value === undefined) {
      throw new UsageError(`${flag} needs a value`);
    }
    if (PATH_FLAGS.has(flag)) {
      checkPathValue(flag, value);
    }
    if (flag === TESTS_FLAG) {
      tests.push(value);
      continue;
    }
    if (values.has(flag)) {
      throw new UsageError(`${flag} given twice`);
    }
    values.set(flag, value);
  }
  return { values, tests, switches };
}

/** A directory flag's value; an empty one would silently mean "here". */
function directoryValue(
  values: ReadonlyMap<string, string>,
  flag: string,
): string | undefined {
  const value = values.get(flag);
  if (value === "") {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

/** Parse `jevy guard` arguments, or return "help". Throws `UsageError`. */
export function parseGuardArgs(argv: readonly string[]): GuardOptions | "help" {
  const args = readArgs(argv);
  if (args === "help") {
    return "help";
  }
  const { values, tests, switches } = args;
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
  const cacheDir = directoryValue(values, "--cache-dir");
  const cwd = directoryValue(values, "--cwd");
  for (const glob of tests) {
    checkGlobFrom(
      glob,
      (message) => new UsageError(`${TESTS_FLAG}: ${message}`),
    );
  }
  return {
    base: checkRef("--base", base),
    head: head === undefined ? undefined : checkRef("--head", head),
    json: switches.has("--json"),
    failOn,
    cacheDir,
    cwd,
    mergeBase: switches.has("--merge-base"),
    tests,
  };
}

type Fail = (message: string) => GuardError;

const usageError: Fail = (message) => new UsageError(message);
/** A fault in the repository's config: exit 2, but not a command-line mistake. */
const configError: Fail = (message) => new GuardError(message);

/**
 * Whether a path relative to the repository root leaves it: it starts with
 * a `..` segment, or (on Windows, across drives) is not relative at all. A
 * name that merely starts with two dots, `..cache`, stays inside.
 */
function climbsOut(path: string): boolean {
  return path.split(sep)[0] === ".." || isAbsolute(path);
}

/**
 * The directory the guard runs in, relative to the repository root with
 * forward slashes; "" for the root. The config is looked for here, and
 * `--cache-dir`, `--tests` and the config's own paths are relative to it.
 */
function directoryInRepo(root: string, cwd: string): string {
  const path = relative(root, cwd);
  if (climbsOut(path)) {
    throw new GuardError(`${cwd} is outside the repository at ${root}`);
  }
  return path.split(sep).join("/");
}

type Realpath = GuardDeps["realpath"];

/**
 * `path` with the symlinks in it resolved, as far as it exists: the nearest
 * ancestor that exists is resolved and the rest is put back. Git reports
 * the repository root resolved, so an absolute path that reaches the
 * repository through a symlink (`/tmp/x` for `/private/tmp/x` on macOS)
 * would otherwise look as if it were outside it. A cache directory need not
 * exist yet, which is why `realpath` alone will not do.
 */
async function resolveExisting(
  path: string,
  realpath: Realpath,
): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return path;
      }
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** Where relative paths start from, and how to resolve the absolute ones. */
interface Place {
  readonly root: string;
  /** The directory the guard runs in, absolute, symlinks resolved. */
  readonly cwd: string;
  readonly realpath: Realpath;
}

/**
 * A cache directory relative to the repository root, with forward slashes.
 * `what` names where `dir` came from, for the message.
 *
 * The root itself is refused: every `.jsonl` in the repository would be a
 * decision file and every path would be protected.
 */
async function cacheDirInRepo(
  place: Place,
  dir: string,
  what: string,
  fail: Fail,
): Promise<string> {
  const target = isAbsolute(dir)
    ? await resolveExisting(resolve(dir), place.realpath)
    : resolve(place.cwd, dir);
  const path = relative(place.root, target);
  if (path === "") {
    throw fail(
      `${what} must be a directory below the repository root, not the root itself: ${dir}`,
    );
  }
  if (climbsOut(path)) {
    throw fail(`${what} must be inside the repository: ${dir}`);
  }
  return path.split(sep).join("/");
}

/** The Jevy config the settings are read from. */
interface LoadedConfig {
  /** Repository-relative path of the file. */
  readonly path: string;
  readonly version: "base" | "head";
  readonly settings: ConfigSettings;
}

/**
 * The config in `dir`, read as text: the base version when base has one,
 * otherwise the head version, otherwise null.
 *
 * Base comes first so that the change under review cannot redefine what is
 * checked. Were head read, an agent could point `cache.dir` or `guard.tests`
 * somewhere harmless in the same change that weakens a test.
 */
async function loadConfig(
  reader: RepoReader,
  dir: string,
): Promise<LoadedConfig | null> {
  // `readBase` fails for a path base does not have, so ask first.
  const base = await findConfig(
    async (path) =>
      (await reader.existsInBase(path)) ? reader.readBase(path) : null,
    dir,
  );
  if (base !== null) {
    return {
      path: base.path,
      version: "base",
      settings: readConfigSettings(base.text, base.path),
    };
  }
  const head = await findConfig(
    async (path) =>
      (await reader.existsInHead(path)) ? reader.readHead(path) : null,
    dir,
  );
  return head === null
    ? null
    : {
        path: head.path,
        version: "head",
        settings: readConfigSettings(head.text, head.path),
      };
}

/** Keys the guard needs, with the flag that makes each one unnecessary. */
function neededKeys(
  options: GuardOptions,
): readonly (readonly [key: string, hint: string])[] {
  return [
    ...(options.cacheDir === undefined
      ? [["cache.dir", " (or pass --cache-dir)"] as const]
      : []),
    ...(options.tests.length === 0
      ? [["guard.tests", ` (or pass ${TESTS_FLAG})`] as const]
      : []),
    ["protect", ""],
    ["web3.policy", ""],
  ];
}

/**
 * Fail closed when a setting the guard needs is written in the config in a
 * way that only running the config could resolve. Treating it as absent
 * would be a guess: the real cache directory or protect list would go
 * unchecked with no sign of it.
 */
function checkReadable(config: LoadedConfig, options: GuardOptions): void {
  const { unreadable } = config.settings;
  const where = `the ${config.version} version of ${config.path}`;
  if (unreadable.includes("*")) {
    throw configError(
      `cannot read the settings in ${where}: the config must be an object literal the guard can read without running it`,
    );
  }
  for (const [key, hint] of neededKeys(options)) {
    if (unreadable.includes(key)) {
      throw configError(
        `cannot read ${key} in ${where}: it must be a literal the guard can read without running the config${hint}`,
      );
    }
  }
}

/** `--cache-dir`, else the config's `cache.dir`, else `.jevy/decisions`. */
async function resolveCacheDir(
  place: Place,
  options: GuardOptions,
  config: LoadedConfig | null,
): Promise<string> {
  if (options.cacheDir !== undefined) {
    return cacheDirInRepo(place, options.cacheDir, "--cache-dir", usageError);
  }
  const configured = config?.settings.cacheDir ?? null;
  if (config === null || configured === null) {
    return cacheDirInRepo(place, DEFAULT_CACHE_DIR, "--cache-dir", usageError);
  }
  const what = `cache.dir in ${config.path}`;
  if (configured === "") {
    throw configError(`${what} is empty`);
  }
  // The config sits in the directory the guard runs in, so "relative to the
  // config" and "relative to cwd" are the same directory.
  return cacheDirInRepo(place, configured, what, configError);
}

/** The config's `guard.tests`, checked, or null when it does not set it. */
function configuredTests(
  config: LoadedConfig | null,
): readonly string[] | null {
  const listed = config?.settings.guardTests ?? null;
  if (config === null || listed === null) {
    return null;
  }
  const fail: Fail = (message) =>
    configError(`guard.tests in ${config.path}: ${message}`);
  if (listed.length === 0) {
    // As core's loader has it. An empty list read as "no tests" would
    // switch the comparison off.
    throw fail("must list at least one glob");
  }
  return listed.map((glob) => checkGlobFrom(glob, fail));
}

/**
 * Which files are compared as tests: `--tests`, else the config's
 * `guard.tests`, else the built-in pattern. The globs stay relative to the
 * directory the guard runs in (`testsDir`); see `AnalyseOptions`.
 *
 * A config that only the head version has was written by the change under
 * review, so its globs are added to the built-in pattern and never replace
 * it. Otherwise a change could add a config whose `guard.tests` matches
 * nothing and delete a test file in the same breath, unseen.
 */
function resolveTests(
  options: GuardOptions,
  config: LoadedConfig | null,
): Pick<AnalyseOptions, "tests" | "alsoTests"> {
  if (options.tests.length > 0) {
    return { tests: options.tests };
  }
  const listed = configuredTests(config);
  if (listed === null) {
    return {};
  }
  return config?.version === "head" ? { alsoTests: listed } : { tests: listed };
}

function failure(error: unknown): CliResult {
  const message = messageOf(error);
  const usage = error instanceof UsageError ? `\n${GUARD_USAGE}` : "";
  return { code: 2, stdout: "", stderr: `jevy guard: ${message}\n${usage}` };
}

/**
 * Run `jevy guard`. Never throws: every failure is exit code 2.
 *
 * Settings are resolved before anything is compared, and from the base
 * version of the config (see `loadConfig`): flag, else config, else default.
 * Before that the repository is asked whether it can vouch for the directory
 * the guard runs in (see `GitRepo.checkDirectory`).
 */
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
      ...(options.mergeBase ? { mergeBase: true } : {}),
    });
    // git reports the root with symlinks resolved; resolve cwd the same way.
    const realCwd = await deps.realpath(cwd);
    const dir = directoryInRepo(repo.root, realCwd);
    await repo.checkDirectory?.(dir);
    const config = await loadConfig(repo.reader, dir);
    if (config !== null) {
      checkReadable(config, options);
    }
    const place = { root: repo.root, cwd: realCwd, realpath: deps.realpath };
    const cacheDir = await resolveCacheDir(place, options, config);
    const protect = buildProtectRules({
      settings: config?.settings ?? null,
      configDir: dir,
      cacheDir,
    });
    // The index goes second: what is staged is what a commit would hold,
    // whatever the working tree looks like now.
    const findings = await analyseAll(
      [repo.reader, ...(repo.index === undefined ? [] : [repo.index])],
      { cacheDir, ...resolveTests(options, config), testsDir: dir, protect },
    );
    const report = buildReport(
      options.base,
      options.head ?? WORKING_TREE,
      findings,
      repo.mergeBase,
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
    return failure(new Error(`unexpected error: ${messageOf(error)}`));
  }
}
