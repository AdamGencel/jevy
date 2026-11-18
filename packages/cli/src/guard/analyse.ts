import { diffJevyConfig, diffPlaywrightConfig } from "./diff-config.js";
import { diffDecisionFile } from "./diff-decisions.js";
import { diffTestFile } from "./diff-tests.js";
import { sortFindings } from "./findings.js";
import type { FileChange, RepoReader } from "./git.js";
import type { Finding } from "./types.js";

/**
 * Routes each changed file to the comparison for its kind. It reads through
 * a `RepoReader` and never touches git or the disk itself.
 */

export type FileCategory =
  "test" | "jevy-config" | "playwright-config" | "decisions";

export interface AnalyseOptions {
  /** Decision cache directory, repository-relative with forward slashes. */
  readonly cacheDir: string;
}

/** `**\/*.{spec,test}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`. */
const TEST_FILE = /\.(spec|test)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const JEVY_CONFIG = /^jevy\.config\.(ts|mts|js|mjs)$/;
const PLAYWRIGHT_CONFIG = /^playwright\.config\.(ts|mts|cts|js|mjs|cjs)$/;
const IGNORED_DIRS = new Set(["node_modules", "dist"]);

function trimSlashes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** Which comparison a repository-relative path gets, or null for none. */
export function classifyPath(
  path: string,
  cacheDir: string,
): FileCategory | null {
  const dir = trimSlashes(cacheDir);
  if (path.startsWith(`${dir}/`) && path.endsWith(".jsonl")) {
    return "decisions";
  }
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => IGNORED_DIRS.has(segment))) {
    return null;
  }
  const name = segments[segments.length - 1] ?? "";
  if (JEVY_CONFIG.test(name)) {
    return "jevy-config";
  }
  if (PLAYWRIGHT_CONFIG.test(name)) {
    return "playwright-config";
  }
  return TEST_FILE.test(name) ? "test" : null;
}

interface Side {
  readonly path: string;
  readonly category: FileCategory | null;
}

function compare(
  category: FileCategory,
  file: string,
  before: string | null,
  after: string | null,
): readonly Finding[] {
  const change = { file, before, after };
  switch (category) {
    case "test":
      return diffTestFile(change);
    case "jevy-config":
      return diffJevyConfig(change);
    case "playwright-config":
      return diffPlaywrightConfig(change);
    case "decisions":
      return diffDecisionFile(change);
  }
}

async function analyseChange(
  reader: RepoReader,
  change: FileChange,
  cacheDir: string,
): Promise<readonly Finding[]> {
  const old: Side | null =
    change.status === "added"
      ? null
      : {
          path: change.oldPath,
          category: classifyPath(change.oldPath, cacheDir),
        };
  const now: Side | null =
    change.status === "deleted"
      ? null
      : { path: change.path, category: classifyPath(change.path, cacheDir) };

  // Same kind on both sides (the usual case, renames included): compare the
  // old path's base text with the new path's head text.
  if (old?.category != null && old.category === now?.category) {
    return compare(
      old.category,
      now.path,
      await reader.readBase(old.path),
      await reader.readHead(now.path),
    );
  }
  // A rename across kinds, for example `a.spec.ts` to `a.spec.ts.bak`, is a
  // removal of one and an addition of the other.
  const out: Finding[] = [];
  if (old?.category != null) {
    out.push(
      ...compare(old.category, old.path, await reader.readBase(old.path), null),
    );
  }
  if (now?.category != null) {
    out.push(
      ...compare(now.category, now.path, null, await reader.readHead(now.path)),
    );
  }
  return out;
}

/** All findings for the changes `reader` reports, sorted. */
export async function analyse(
  reader: RepoReader,
  options: AnalyseOptions,
): Promise<Finding[]> {
  const changes = await reader.changes();
  const findings: Finding[] = [];
  for (const change of changes) {
    findings.push(...(await analyseChange(reader, change, options.cacheDir)));
  }
  return sortFindings(findings);
}
