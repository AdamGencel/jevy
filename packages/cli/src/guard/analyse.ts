import { findConfig } from "./config-source.js";
import {
  diffJevyConfig,
  diffLoadedBlocking,
  diffPlaywrightConfig,
  type LoadedConfigFile,
} from "./diff-config.js";
import { diffDecisionFile } from "./diff-decisions.js";
import { diffTestFile } from "./diff-tests.js";
import { compareFindings, finding, sortFindings } from "./findings.js";
import type { FileChange, RepoReader, Watched } from "./git.js";
import { firstMatch, reachesInto } from "./glob.js";
import {
  protectedPathFindings,
  protectionOf,
  type ProtectRules,
} from "./protect.js";
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
  /**
   * True when the config core's loader reads sets `toSatisfy.blocking:
   * true` in base and still does in head. Absent or false, a new or changed
   * test that only `toSatisfy` can fail is `only-advisory-assertions`. A
   * config the change under review wrote must not set it: it would silence
   * that finding. A change that switches it off must not keep it either:
   * the tests that change adds would then go unreported.
   */
  readonly toSatisfyBlocking?: boolean;
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

function categoryOf(
  path: string,
  options: AnalyseOptions,
): FileCategory | null {
  return classifyPath(
    path,
    options.cacheDir,
    options.tests,
    options.testsDir,
    options.alsoTests,
  );
}

/**
 * Whether a change at `path` is one the rules report. A path they cannot
 * place counts: answering "no" would be a guess.
 */
function isProtected(path: string, rules: ProtectRules | undefined): boolean {
  if (rules === undefined) {
    return false;
  }
  try {
    return protectionOf(path, rules) !== null;
  } catch {
    return true;
  }
}

/**
 * The paths the guard compares or protects, for a reader that checks
 * those itself rather than trust git's change detection (see
 * `GitRepo.watch`).
 */
export function watchedBy(options: AnalyseOptions): Watched {
  return {
    matters: (path) =>
      categoryOf(path, options) !== null || isProtected(path, options.protect),
    isTest: (path) => categoryOf(path, options) === "test",
  };
}

/**
 * Whether a test the guard would compare could sit inside the directory
 * `path`. The built-in pattern finds tests in any directory; a list of
 * globs only in those it reaches into.
 */
function mayHoldTests(path: string, options: AnalyseOptions): boolean {
  if (path.split("/").some((segment) => IGNORED_DIRS.has(segment))) {
    return false;
  }
  const tests = options.tests ?? [];
  if (tests.length === 0) {
    return true;
  }
  const rest = below(trimSlashes(options.testsDir ?? ""), path);
  return (
    rest !== null &&
    [...tests, ...(options.alsoTests ?? [])].some((glob) =>
      reachesInto(rest, glob),
    )
  );
}

/** Whether a protected path could sit inside the directory `path`. */
function mayHoldProtected(
  path: string,
  rules: ProtectRules | undefined,
): boolean {
  if (rules === undefined) {
    return false;
  }
  if (isProtected(path, rules)) {
    return true;
  }
  const inside = (file: string | null): boolean =>
    file !== null && file.startsWith(`${path}/`);
  const rest = below(rules.globDir, path);
  return (
    inside(rules.cacheDir) ||
    inside(rules.policyFile) ||
    (rules.imports ?? []).some(inside) ||
    (rest !== null && rules.globs.some((glob) => reachesInto(rest, glob)))
  );
}

/**
 * The finding for a submodule (or a repository nested in this one) that
 * changed where tests or protected paths may be. The guard does not look
 * inside it, so a person has to.
 */
function submoduleFinding(
  change: FileChange,
  options: AnalyseOptions,
): readonly Finding[] {
  const paths = [change.path, change.oldPath];
  const watched = paths.some(
    (path) =>
      mayHoldTests(path, options) || mayHoldProtected(path, options.protect),
  );
  if (change.gitlink === undefined || !watched) {
    return [];
  }
  return [
    finding({
      kind: "submodule-changed",
      file: change.path,
      message: `a submodule changed (${change.status}); its tests were not compared, so review it by hand`,
    }),
  ];
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
  options: AnalyseOptions,
  loaded = false,
): readonly Finding[] {
  const change = { file, before, after };
  switch (category) {
    case "test":
      return diffTestFile(
        options.toSatisfyBlocking === undefined
          ? change
          : { ...change, toSatisfyBlocking: options.toSatisfyBlocking },
      );
    case "jevy-config":
      return diffJevyConfig({ ...change, loaded });
    case "playwright-config":
      return diffPlaywrightConfig(change);
    case "decisions":
      return diffDecisionFile(change);
  }
}

/**
 * `loaded` is true for a config whose old path is the file core's loader
 * reads in base and whose path is the one it reads in head: only then does
 * its own `toSatisfy.blocking` decide anything (see `loadedConfigs`).
 */
async function analyseChange(
  reader: RepoReader,
  change: FileChange,
  options: AnalyseOptions,
  loaded: boolean,
): Promise<readonly Finding[]> {
  const side = (path: string): Side => ({
    path,
    category: categoryOf(path, options),
  });
  // A submodule has no text to compare. On the side that holds one, the
  // path is treated as absent: a test file replaced by a submodule is a
  // removed test file.
  const { gitlink } = change;
  const old =
    change.status === "added" || gitlink === "base" || gitlink === "both"
      ? null
      : side(change.oldPath);
  const now =
    change.status === "deleted" || gitlink === "head" || gitlink === "both"
      ? null
      : side(change.path);
  const submodule = submoduleFinding(change, options);

  // Same kind on both sides (the usual case, renames included): compare the
  // old path's base text with the new path's head text.
  if (old?.category != null && old.category === now?.category) {
    return [
      ...submodule,
      ...compare(
        old.category,
        now.path,
        await reader.readBase(old.path),
        await reader.readHead(now.path),
        options,
        loaded,
      ),
    ];
  }
  // A rename across kinds, for example `a.spec.ts` to `a.spec.ts.bak`, is a
  // removal of one and an addition of the other.
  const out: Finding[] = [...submodule];
  if (old?.category != null) {
    out.push(
      ...compare(
        old.category,
        old.path,
        await reader.readBase(old.path),
        null,
        options,
      ),
    );
  }
  if (now?.category != null) {
    out.push(
      ...compare(
        now.category,
        now.path,
        null,
        await reader.readHead(now.path),
        options,
      ),
    );
  }
  return out;
}

/** The directory of a repository-relative path; "" for the root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The config core's loader reads in one directory, in each version. */
interface LoadedPair {
  readonly base: LoadedConfigFile | null;
  readonly head: LoadedConfigFile | null;
}

/**
 * For each directory where a Jevy config changed, the config the loader
 * reads there in base and in head: the first of `jevy.config.ts`, `.mts`,
 * `.js`, `.mjs` that exists. Comparing these, not each changed file on its
 * own, is what finds `toSatisfy.blocking` switched off by deleting the
 * config, adding one the loader reads first, or renaming it.
 */
async function loadedConfigs(
  reader: RepoReader,
  changes: readonly FileChange[],
  options: AnalyseOptions,
): Promise<ReadonlyMap<string, LoadedPair>> {
  const dirs = new Set<string>();
  for (const change of changes) {
    for (const path of [change.path, change.oldPath]) {
      if (categoryOf(path, options) === "jevy-config") {
        dirs.add(directoryOf(path));
      }
    }
  }
  const out = new Map<string, LoadedPair>();
  for (const dir of [...dirs].sort()) {
    out.set(dir, {
      // `readBase` fails for a path base does not have, so ask first.
      base: await findConfig(
        async (path) =>
          (await reader.existsInBase(path)) ? reader.readBase(path) : null,
        dir,
      ),
      head: await findConfig(
        async (path) =>
          (await reader.existsInHead(path)) ? reader.readHead(path) : null,
        dir,
      ),
    });
  }
  return out;
}

/** Whether `change` turns the config the loader reads in base into the one it reads in head. */
function isLoaded(
  change: FileChange,
  loaded: ReadonlyMap<string, LoadedPair>,
): boolean {
  const pair = loaded.get(directoryOf(change.path));
  return pair?.base?.path === change.oldPath && pair.head?.path === change.path;
}

/**
 * All findings for the changes `reader` reports, sorted. A protected path
 * that is also a test or a config gets both: what changed inside it, and
 * that it should not have been changed without a person.
 *
 * `toSatisfy.blocking` is compared between the configs the loader reads
 * (see `loadedConfigs`): by the file's own comparison when one change turns
 * one into the other, else once for the directory.
 */
export async function analyse(
  reader: RepoReader,
  options: AnalyseOptions,
): Promise<Finding[]> {
  const changes = await reader.changes();
  const loaded = await loadedConfigs(reader, changes, options);
  const compared = new Set<string>();
  const findings: Finding[] = [];
  for (const change of changes) {
    const judged = isLoaded(change, loaded);
    if (judged) {
      compared.add(directoryOf(change.path));
    }
    findings.push(...(await analyseChange(reader, change, options, judged)));
  }
  for (const [dir, pair] of loaded) {
    const switchedOff = compared.has(dir)
      ? null
      : diffLoadedBlocking(pair.base, pair.head);
    if (switchedOff !== null) {
      findings.push(switchedOff);
    }
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
