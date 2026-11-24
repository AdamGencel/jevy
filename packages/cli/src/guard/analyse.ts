import { diffJevyConfig, diffPlaywrightConfig } from "./diff-config.js";
import { diffDecisionFile } from "./diff-decisions.js";
import { diffTestFile } from "./diff-tests.js";
import { compareFindings, sortFindings } from "./findings.js";
import type { FileChange, RepoReader } from "./git.js";
import { firstMatch } from "./glob.js";
import { protectedPathFindings, type ProtectRules } from "./protect.js";
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
  /**
   * Globs, relative to `testsDir`, for the files compared as tests. Absent
   * or empty means the built-in pattern, `**\/*.{spec,test}.{ts,tsx,...}`,
   * which applies to the whole repository.
   */
  readonly tests?: readonly string[];
  /**
   * Globs, relative to `testsDir`, for files compared as tests as well as
   * those `tests` or the built-in pattern picks. These only ever add: they
   * are how settings the change under review wrote itself may widen what is
   * checked without narrowing it.
   */
  readonly alsoTests?: readonly string[];
  /**
   * The directory `tests` and `alsoTests` are written relative to,
   * repository-relative; absent or "" for the root. It is literal text and
   * is taken off the path before a glob sees it, so a directory named
   * `web{a,b}` or `pkg*` is never read as a pattern.
   */
  readonly testsDir?: string;
  /** When given, a change to a path these rules protect is a finding. */
  readonly protect?: ProtectRules;
}

/** `**\/*.{spec,test}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`. */
const TEST_FILE = /\.(spec|test)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// In any case: a disk that ignores case loads `Jevy.Config.ts` as the
// config, and `protect.ts` protects it under that name too.
const JEVY_CONFIG = /^jevy\.config\.(ts|mts|js|mjs)$/i;
const PLAYWRIGHT_CONFIG = /^playwright\.config\.(ts|mts|cts|js|mjs|cjs)$/i;
const IGNORED_DIRS = new Set(["node_modules", "dist"]);

function trimSlashes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** `path` with the leading directory `dir` taken off, or null when it is not below it. */
function below(dir: string, path: string): string | null {
  if (dir === "") {
    return path;
  }
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** Which files are compared as tests; see the fields of `AnalyseOptions`. */
interface TestRules {
  readonly tests: readonly string[];
  readonly alsoTests: readonly string[];
  readonly testsDir: string;
}

/**
 * An empty `tests` counts as no list: read as "no file is a test" it would
 * switch the comparison off with no sign of it.
 */
function isTest(path: string, name: string, rules: TestRules): boolean {
  const rest = below(rules.testsDir, path);
  const matches = (globs: readonly string[]): boolean =>
    rest !== null && firstMatch(rest, globs) !== null;
  const chosen =
    rules.tests.length === 0 ? TEST_FILE.test(name) : matches(rules.tests);
  return chosen || matches(rules.alsoTests);
}

/**
 * Which comparison a repository-relative path gets, or null for none.
 *
 * `tests` replaces the built-in test pattern and `alsoTests` adds to either,
 * both relative to `testsDir`, and neither changes anything else: a decision
 * file, a file under `node_modules` or `dist`, and a Jevy or Playwright
 * config are what they are even when a test glob matches them.
 */
export function classifyPath(
  path: string,
  cacheDir: string,
  tests: readonly string[] = [],
  testsDir = "",
  alsoTests: readonly string[] = [],
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
  const rules = { tests, alsoTests, testsDir: trimSlashes(testsDir) };
  return isTest(path, name, rules) ? "test" : null;
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
  options: AnalyseOptions,
): Promise<readonly Finding[]> {
  const side = (path: string): Side => ({
    path,
    category: classifyPath(
      path,
      options.cacheDir,
      options.tests,
      options.testsDir,
      options.alsoTests,
    ),
  });
  const old = change.status === "added" ? null : side(change.oldPath);
  const now = change.status === "deleted" ? null : side(change.path);

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

/**
 * All findings for the changes `reader` reports, sorted. A protected path
 * that is also a test or a config gets both: what changed inside it, and
 * that it should not have been changed without a person.
 */
export async function analyse(
  reader: RepoReader,
  options: AnalyseOptions,
): Promise<Finding[]> {
  const changes = await reader.changes();
  const findings: Finding[] = [];
  for (const change of changes) {
    findings.push(...(await analyseChange(reader, change, options)));
  }
  if (options.protect !== undefined) {
    findings.push(...protectedPathFindings(changes, options.protect));
  }
  return sortFindings(findings);
}

/**
 * The findings for several readers over one base, each finding once, sorted.
 * The working tree and the index are two such readers: a change that is in
 * both is reported once, and one that is in either is reported.
 */
export async function analyseAll(
  readers: readonly RepoReader[],
  options: AnalyseOptions,
): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const reader of readers) {
    all.push(...(await analyse(reader, options)));
  }
  return sortFindings(all).filter(
    (found, index, sorted) =>
      index === 0 || compareFindings(sorted[index - 1] ?? found, found) !== 0,
  );
}
