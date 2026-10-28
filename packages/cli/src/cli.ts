import {
  DEFAULT_CACHE_DIR,
  JsonlDecisionStore,
  cacheStats,
  formatCacheStats,
  formatPruneResult,
  pruneCache,
} from "@jevyjs/core";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Handle `jevy` arguments. `cache stats` and `cache prune` read the JSONL
 * decision cache. `record` and `eval` are later milestones.
 */
export async function run(
  argv: readonly string[],
  version: string,
): Promise<CliResult> {
  try {
    return await dispatch(argv, version);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { code: 1, stdout: "", stderr: `jevy: ${message}\n` };
  }
}

async function dispatch(
  argv: readonly string[],
  version: string,
): Promise<CliResult> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    return { code: 0, stdout: help(version), stderr: "" };
  }
  if (command === "--version" || command === "-v") {
    return { code: 0, stdout: `${version}\n`, stderr: "" };
  }
  if (command === "cache") return cacheCommand(argv.slice(1), version);
  return {
    code: 1,
    stdout: "",
    stderr: `jevy: unknown command '${command}'\n`,
  };
}

async function cacheCommand(
  argv: readonly string[],
  version: string,
): Promise<CliResult> {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") {
    return { code: 0, stdout: help(version), stderr: "" };
  }
  if (sub === undefined) {
    return { code: 1, stdout: "", stderr: help(version) };
  }
  const flags = parseFlags(argv.slice(1));
  const store = new JsonlDecisionStore(flags.dir);
  if (sub === "stats") {
    if (flags.days !== undefined || flags.notReferenced) {
      throw new Error("cache stats does not take prune options");
    }
    const stats = await cacheStats(store);
    return { code: 0, stdout: formatCacheStats(stats), stderr: "" };
  }
  if (sub === "prune") {
    const result = await pruneCache(store, {
      ...(flags.days !== undefined ? { days: flags.days } : {}),
      ...(flags.notReferenced ? { notReferenced: true } : {}),
    });
    return { code: 0, stdout: formatPruneResult(result), stderr: "" };
  }
  return {
    code: 1,
    stdout: "",
    stderr: `jevy: unknown command 'cache ${sub}'\n`,
  };
}

interface CacheFlags {
  readonly dir: string;
  readonly days?: number;
  readonly notReferenced: boolean;
}

function parseFlags(argv: readonly string[]): CacheFlags {
  let dir = DEFAULT_CACHE_DIR;
  let days: number | undefined;
  let notReferenced = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--dir") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("cache --dir needs a path");
      }
      dir = next;
      index += 1;
      continue;
    }
    if (arg === "--days") {
      const next = argv[index + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        throw new Error("cache prune --days needs an integer >= 0");
      }
      days = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--not-referenced") {
      notReferenced = true;
      continue;
    }
    throw new Error(`unknown cache option '${arg}'`);
  }
  if (days === undefined) return { dir, notReferenced };
  return { dir, days, notReferenced };
}

function help(version: string): string {
  return [
    `jevy ${version}`,
    "",
    "Usage:",
    "  jevy cache stats [--dir <path>]",
    "  jevy cache prune --days <n> [--dir <path>]",
    "  jevy cache prune --not-referenced [--dir <path>]",
    "",
    "cache stats  Count decisions in the JSONL cache.",
    "cache prune  Drop superseded records and either records unused for <n> days",
    "             (lastUsedAt at or before now minus <n> days) or records whose",
    "             key was not referenced by the last record / replay-or-query run.",
    "",
    "record and eval are not implemented yet.",
    "",
  ].join("\n");
}
