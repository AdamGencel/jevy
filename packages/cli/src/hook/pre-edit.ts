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
import {
  CONFIG_FILENAMES,
  findConfig,
  readConfigSettings,
  type ConfigSettings,
} from "../guard/config-source.js";
import { GuardError, UsageError } from "../guard/errors.js";
import {
  buildProtectRules,
  protectionOf,
  type Protection,
  type ProtectRules,
} from "../guard/protect.js";
import { parseFlags, secondsFlag } from "./args.js";
import { configElsewhere, elsewhereText } from "./config.js";
import { within } from "./deadline.js";
import type { HookDeps } from "./deps.js";
import { parseHookInput, type HookInput } from "./input.js";
import { messageOf, printable } from "./text.js";

/**
 * `jevy hook pre-edit`: runs before a coding agent's file edit and refuses
 * it when the file is a protected path.
 *
 * The guard reports a changed protected path afterwards; this stops the
 * change being made. It exits 2 to refuse, which Claude Code reads as "deny
 * this tool call" and shows stderr to the agent, and 0 to allow. It never
 * exits 1, which Claude Code would report as a hook error while letting the
 * edit through, so every doubt and every error is a refusal.
 */

/**
 * Claude Code cancels a hook at its `timeout` and then lets the edit
 * through, so the hook answers before that: this is below the 30 seconds
 * `jevy hook print` gives the pre-edit hook.
 */
export const DEFAULT_PRE_EDIT_DEADLINE_SECONDS = 20;

export const PRE_EDIT_USAGE = `Usage: jevy hook pre-edit [--cwd <dir>] [--deadline <seconds>]

A hook that runs before a coding agent edits a file. Reads the agent's hook
input (JSON with tool_name and tool_input) on stdin and blocks the edit when
the file is a protected path: a jevy.config.*, a file in the decision cache,
the wallet policy file, or a path matched by \`protect\` in the config. The
files that run the hooks are always protected, with no config needed:
node_modules/.bin/jevy, node_modules/@jevyjs/**, .claude/settings.json and
.claude/settings.local.json, in the project directory and at the root of the
repository.

  --cwd <dir>           The project directory: the one with jevy.config.*.
                        Default: the current directory.
  --deadline <seconds>  Time limit for the hook; the edit is blocked when it
                        passes. Default: ${String(DEFAULT_PRE_EDIT_DEADLINE_SECONDS)}. Keep it below the timeout
                        the agent gives the hook.

Exit codes: 0 the edit may go ahead, 2 blocked (the reason is on stderr) or a
usage error. Never 1.
`;

const DEFAULT_CACHE_DIR = ".jevy/decisions";

/** Claude Code's tools that write a file. Each must name the file it writes. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Where a tool's input names its file. `file_path` is documented for Edit
 * and Write; `notebook_path` is what NotebookEdit has used.
 */
const PATH_FIELDS = ["file_path", "notebook_path"] as const;

/**
 * Every path the tool input names. Both fields are read when both are
 * there: the hook cannot know which one the tool writes to, and checking
 * only the first would let the other through.
 */
function namedPaths(input: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value !== "") {
      out.push(value);
    }
  }
  return out;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** The file-system lookups that placing a path needs. */
type Lookups = Pick<HookDeps, "realpath" | "readlink">;

/**
 * Symlinks followed by their text before the hook gives up. The operating
 * system allows about this many, and a chain that loops ends here.
 */
const MAX_LINK_HOPS = 40;

/** Where a path that may not exist yet lands. */
interface Landing {
  /** The path with its symlinks resolved, as far as that can be done. */
  readonly resolved: string;
  /** The deepest part of the path that exists, or is a symlink. */
  readonly at: string;
  /** The names below `at`, none of which exists yet. */
  readonly rest: readonly string[];
}

/**
 * Resolve the symlinks of `path`, which may not exist yet: the nearest part
 * that does exist is resolved and the rest is kept as written. A Write
 * creates its file, and the directories above it, so "does not exist"
 * cannot mean "not protected".
 *
 * A symlink whose target does not exist is followed by its text. Writing
 * through such a link creates the target, so the target is the file being
 * edited, and `realpath` alone reports the link as missing.
 *
 * One walk up the path, so a path with hundreds of names that do not exist
 * costs hundreds of lookups, not hundreds for each name.
 */
async function land(
  path: string,
  fs: Lookups,
  hops = MAX_LINK_HOPS,
): Promise<Landing> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return {
        resolved: join(await fs.realpath(current), ...rest),
        at: current,
        rest,
      };
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    const parent = dirname(current);
    const link = await fs.readlink(current);
    if (link !== null) {
      if (hops === 0) {
        throw new GuardError(
          `${printable(path)} goes through too many symlinks, so the edit cannot be checked.`,
        );
      }
      // The link's own directory exists, and a relative target starts
      // from where that directory really is.
      const target = resolve(await fs.realpath(parent), link);
      const landed = await land(target, fs, hops - 1);
      return { resolved: join(landed.resolved, ...rest), at: current, rest };
    }
    if (parent === current) {
      return { resolved: path, at: current, rest };
    }
    rest.unshift(basename(current));
    current = parent;
  }
}

async function resolveExisting(path: string, fs: Lookups): Promise<string> {
  return (await land(path, fs)).resolved;
}

/**
 * `target` relative to `root` with forward slashes, or null when it is the
 * root itself or outside it. A name that only starts with two dots
 * (`..cache`) is inside.
 */
function inside(root: string, target: string): string | null {
  const path = relative(root, target);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    return null;
  }
  return path.split(sep).join("/");
}

/**
 * Every way of reading `written`: as written, and with each leading part of
 * it resolved through its symlinks while the rest stays as written.
 *
 * One file has several names when a directory on the way to it, or the file
 * itself, is a symlink. `src/alias.ts` may be a link to the config; a file
 * named `jevy.config.ts` may be a link to somewhere else and is still the
 * file the loader reads. Resolving all of the path would see the first and
 * miss the second, and resolving none of it the reverse, so each step
 * between the two is listed.
 */
async function readings(written: string, fs: Lookups): Promise<string[]> {
  // Every part of the path below the deepest one that exists reads the
  // same way, so one lookup covers them all.
  const whole = await land(written, fs);
  const out = [written, whole.resolved];
  const rest = [...whole.rest];
  let current = whole.at;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return out;
    }
    rest.unshift(basename(current));
    current = parent;
    out.push(join(await resolveExisting(current, fs), ...rest));
  }
}

/**
 * The project-relative paths that `readings` could be, most literal first.
 *
 * The project directory may itself be reached through a symlink (on macOS
 * the temp directory always is), so every reading of the path is placed
 * against the project directory as written and as resolved. The edit is
 * refused when any of the results is protected. A path with no result is
 * outside the project.
 */
function candidates(
  readings: readonly string[],
  roots: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const reading of readings) {
    for (const root of roots) {
      const path = inside(root, reading);
      if (path !== null) {
        out.add(path);
      }
    }
  }
  return [...out];
}

/*
 * The files that run the hooks. The settings snippet runs
 * ./node_modules/.bin/jevy, which runs @jevyjs/cli, and Claude Code reads
 * which hooks to run from its settings files. One Write to any of them
 * (`exit 0` in place of the executable, a settings file with no hooks)
 * switches every hook off, and git shows nothing: node_modules is ignored,
 * and so usually is .claude/settings.local.json. So they are protected
 * whatever the config says, in the project directory and at the root of
 * the repository, where Claude Code also looks.
 */

/** Files, relative to a root. */
const HOOK_FILES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  "node_modules/.bin/jevy",
] as const;

/** Directories, relative to a root, protected with all they hold. */
const HOOK_TREES = ["node_modules/@jevyjs"] as const;

/**
 * The installed package, whose real directory is protected too: pnpm keeps
 * it in its store under node_modules/.pnpm and links it in, and a Write to
 * the store's path changes the same file.
 */
const HOOK_PACKAGE = "node_modules/@jevyjs/cli";

/** Absolute paths, case folded, of what runs the hooks. */
interface HookLocations {
  readonly files: readonly string[];
  readonly trees: readonly string[];
}

/**
 * Case folded: on a disk that ignores case, as macOS and Windows do by
 * default, `.Claude/Settings.json` is the settings file. On one that does
 * not, this protects a second file too, which is the safe direction.
 */
function fold(path: string): string {
  return path.toLowerCase();
}

/**
 * Where the files that run the hooks are under each of `roots`, as written
 * and with symlinks resolved: a settings file may be a link to another
 * file, which Claude Code then reads.
 */
async function hookLocations(
  roots: readonly string[],
  fs: Lookups,
): Promise<HookLocations> {
  const files: string[] = [];
  const trees: string[] = [];
  for (const root of new Set(roots)) {
    for (const file of HOOK_FILES) {
      files.push(join(root, file));
    }
    for (const file of HOOK_FILES.filter((name) =>
      name.startsWith(".claude"),
    )) {
      files.push(await resolveExisting(join(root, file), fs));
    }
    for (const tree of HOOK_TREES) {
      trees.push(join(root, tree));
    }
    trees.push(await resolveExisting(join(root, HOOK_PACKAGE), fs));
  }
  return { files: files.map(fold), trees: trees.map(fold) };
}

/** The first of `readings` that is a file that runs the hooks, or null. */
function hookFile(
  readings: readonly string[],
  where: HookLocations,
): string | null {
  return (
    readings.find((reading) => {
      const folded = fold(reading);
      return (
        where.files.includes(folded) ||
        where.trees.some(
          (tree) => tree === folded || inside(tree, folded) !== null,
        )
      );
    }) ?? null
  );
}

/** Whether `path`, repository-relative, names a Jevy config. */
function isConfigName(path: string): boolean {
  const name = fold(path.split("/").at(-1) ?? "");
  return CONFIG_FILENAMES.some((config) => config === name);
}

/** The settings whose value decides which paths are protected. */
const NEEDED = ["protect", "cache.dir", "web3.policy"] as const;

/**
 * Refuse when the config exists but the hook cannot read what it needs from
 * it. An unreadable `protect` would otherwise arrive as "no list" and every
 * path on it would be open; the same goes for the cache directory and the
 * policy file. The agent cannot fix this, because the config is itself
 * protected, so the message says a person has to.
 */
function checkReadable(settings: ConfigSettings, path: string): void {
  const fix =
    "A person has to fix the config so that the hook can read it without running it";
  if (settings.unreadable.includes("*")) {
    throw new GuardError(
      `the hook cannot read ${path}, so it cannot tell which paths are protected. ${fix}.`,
    );
  }
  const lost = NEEDED.filter((key) => settings.unreadable.includes(key)).map(
    (key) => `\`${key}\``,
  );
  if (lost.length > 0) {
    const keys = [lost.slice(0, -1).join(", "), lost.at(-1)]
      .filter((part) => part !== "")
      .join(" and ");
    throw new GuardError(
      `the hook cannot read ${keys} in ${path}, so it cannot tell which paths are protected. ${fix}: write ${keys} as ${lost.length === 1 ? "a literal" : "literals"}.`,
    );
  }
}

/**
 * Refuse when the project directory has no config but the repository has
 * one in another directory. That config may protect the very file being
 * edited, and the built-in rules alone would let the edit through.
 */
async function checkNotElsewhere(
  projectDir: string,
  deps: HookDeps,
): Promise<void> {
  const found = await configElsewhere(projectDir, deps);
  if (found !== null) {
    throw new GuardError(
      `${elsewhereText(projectDir, found)}, so the hook cannot tell which paths are protected. A person has to run the hook in the directory of the config: --cwd ${printable(found.cwd)}`,
    );
  }
}

/**
 * The rules of the project's config; the built-in ones when neither the
 * project directory nor the rest of the repository has a config.
 */
async function readRules(
  projectDir: string,
  deps: HookDeps,
): Promise<ProtectRules> {
  const found = await findConfig(
    (path) => deps.readFile(join(projectDir, path)),
    "",
  );
  let settings: ConfigSettings | null = null;
  if (found === null) {
    await checkNotElsewhere(projectDir, deps);
  } else {
    settings = readConfigSettings(found.text, found.path);
    checkReadable(settings, found.path);
  }
  try {
    return buildProtectRules({
      settings,
      configDir: "",
      cacheDir: settings?.cacheDir ?? DEFAULT_CACHE_DIR,
    });
  } catch (error) {
    throw new GuardError(
      `${messageOf(error)}. A person has to fix the config so that the hook can use it.`,
    );
  }
}

function why(protection: Protection): string {
  switch (protection.reason) {
    case "config":
      // A file the config imports can change a setting as surely as the
      // config itself; say which, so the agent does not hunt for a config.
      return protection.importedBy === undefined
        ? "it is the Jevy config"
        : `it is imported by ${protection.importedBy}`;
    case "cache":
      return "it is in the decision cache";
    case "policy":
      return "it is the wallet policy";
    case "listed":
      return `it matches "${protection.glob}" in protect`;
  }
}

function refuse(message: string): CliResult {
  return { code: 2, stdout: "", stderr: `jevy hook pre-edit: ${message}\n` };
}

const ALLOW: CliResult = { code: 0, stdout: "", stderr: "" };

/**
 * The advice names the ways round on purpose. An agent told only "blocked"
 * tends to try `sed` or a script next, which this hook does not see.
 */
function protectedPath(path: string, reason: string): CliResult {
  return refuse(
    `${printable(path)} is protected: ${reason}.\nDo not change it, and do not change it another way (a shell command, a script). Ask the maintainer to make or approve this change.`,
  );
}

async function check(
  input: HookInput | null,
  projectDir: string,
  deps: HookDeps,
): Promise<CliResult> {
  if (input === null || input.toolInput === null) {
    return refuse(
      "the hook input is not a JSON object with a tool_input, so the edit cannot be checked.",
    );
  }
  const named = namedPaths(input.toolInput);
  if (named.length === 0) {
    // Another tool with no file is not an edit this hook judges. An edit
    // tool with no file is a change in the tool's input the hook does not
    // understand, and letting it through would switch the hook off.
    return input.toolName !== null && EDIT_TOOLS.has(input.toolName)
      ? refuse(
          `the ${input.toolName} input names no file (no file_path or notebook_path), so the edit cannot be checked.`,
        )
      : ALLOW;
  }
  // A relative path is relative to where the agent is, which the input says.
  const from = resolve(projectDir, input.cwd ?? ".");
  const all: string[] = [];
  for (const path of named) {
    all.push(...(await readings(resolve(from, path), deps)));
  }
  const roots = [projectDir, await resolveExisting(projectDir, deps)];
  const shown = (reading: string): string =>
    roots.map((root) => inside(root, reading)).find((path) => path !== null) ??
    reading;
  const top = await deps.git.topLevel(projectDir);
  // First, and with no config needed: these keep the hooks themselves
  // working, and a config that cannot be read must not open them.
  const hook = hookFile(
    all,
    await hookLocations(top === null ? roots : [...roots, top], deps),
  );
  if (hook !== null) {
    return protectedPath(
      shown(hook),
      "it keeps the Jevy hooks themselves working",
    );
  }
  const paths = candidates(all, roots);
  if (paths.length === 0) {
    return checkOutside(all, top, projectDir, deps);
  }
  const rules = await readRules(projectDir, deps);
  for (const path of paths) {
    const protection = protectionOf(path, rules);
    if (protection !== null) {
      return protectedPath(path, why(protection));
    }
  }
  return ALLOW;
}

/**
 * A path outside the project directory. Outside the repository too, it is
 * not this project's to protect. Inside it, the config is read as for any
 * edit, so that a config in another directory, or one that cannot be read,
 * refuses the edit: the hook started below the config's directory would
 * otherwise wave an edit to the config itself through. A Jevy config
 * anywhere in the repository is protected, as the guard protects it; the
 * project's `protect` list is relative to its own directory and does not
 * reach here.
 */
async function checkOutside(
  readings: readonly string[],
  top: string | null,
  projectDir: string,
  deps: HookDeps,
): Promise<CliResult> {
  const inRepo =
    top === null
      ? undefined
      : readings.find((reading) => inside(top, reading) !== null);
  if (top === null || inRepo === undefined) {
    return ALLOW;
  }
  await readRules(projectDir, deps);
  const config = readings.find((reading) => {
    const path = inside(top, reading);
    return path !== null && isConfigName(path);
  });
  return config === undefined
    ? ALLOW
    : protectedPath(config, "it is the Jevy config");
}

/**
 * Run `jevy hook pre-edit`. Never throws and never exits 1: anything that
 * goes wrong refuses the edit, and so does running out of time. The whole
 * check is raced against the deadline, stdin included, because a read that
 * never comes back would otherwise hold the hook until Claude Code cancels
 * it and lets the edit through.
 */
export async function runPreEdit(
  argv: readonly string[],
  deps: HookDeps,
): Promise<CliResult> {
  try {
    const flags = parseFlags(argv, new Set(["--cwd", "--deadline"]));
    if (flags === "help") {
      return { code: 0, stdout: PRE_EDIT_USAGE, stderr: "" };
    }
    const deadlineSeconds = secondsFlag(
      flags,
      "--deadline",
      DEFAULT_PRE_EDIT_DEADLINE_SECONDS,
    );
    const projectDir = resolve(deps.cwd, flags.get("--cwd") ?? ".");
    const raced = await within(deadlineSeconds * 1000, async () =>
      check(parseHookInput(await deps.readStdin()), projectDir, deps),
    );
    return raced.inTime
      ? raced.value
      : refuse(
          `the edit could not be checked within ${String(deadlineSeconds)} s, so it is refused. If this keeps happening, a person has to look at why the hook is slow.`,
        );
  } catch (error) {
    const usage = error instanceof UsageError ? `\n${PRE_EDIT_USAGE}` : "";
    return {
      code: 2,
      stdout: "",
      stderr: `jevy hook pre-edit: ${messageOf(error)}\n${usage}`,
    };
  }
}
