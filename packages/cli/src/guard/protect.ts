import type { ConfigSettings } from "./config-source.js";
import { GuardError } from "./errors.js";
import { finding } from "./findings.js";
import type { FileChange } from "./git.js";
import { checkGlob, firstMatch } from "./glob.js";
import type { Finding } from "./types.js";

/**
 * Protected paths: files an agent must not change without a person.
 *
 * Three are protected with no config at all, because each one decides what
 * the tests mean: every `jevy.config.*`, the decision cache directory, and
 * the wallet policy file named by `web3.policy`. The config's `protect` list
 * adds more. The guard reports a change to any of them as weakening, and the
 * pre-edit hook refuses the edit before it is made.
 *
 * Every comparison here is made twice: on the text as written, and on the
 * text with case folded and Unicode composed (see `fold`). macOS and Windows
 * disks ignore case, and APFS reads `é` written as one code point or as two
 * as the same name, so `Tests/Critical/a.ts` is the file `tests/critical/**`
 * protects. On a case-sensitive disk this protects a second, different file
 * as well. That is the safe direction: a rule that protects too much stops
 * an edit a person can allow, and one that protects too little lets an agent
 * through unseen.
 */

export interface ProtectRules {
  /**
   * The directory the globs are written relative to: the config's own,
   * repository-relative, "" for the root. It is literal text and never glob
   * syntax, which is why it is kept apart from the globs. Joined in front of
   * one, a directory named `{a}` or `pkg*` would be read as a pattern and
   * the rule would protect some other directory.
   */
  readonly globDir: string;
  /** Globs from `protect`, relative to `globDir`. */
  readonly globs: readonly string[];
  /** Decision cache directory, repository-relative, no trailing slash. */
  readonly cacheDir: string;
  /** The `web3.policy` file, repository-relative, or null. */
  readonly policyFile: string | null;
  /**
   * Files the config imports, repository-relative, with every name the
   * loader could open for each import (see `importCandidates`). A value the
   * config reads from one of them changes when the file does, so they are
   * protected as the config is. Absent when the config imports none.
   */
  readonly imports?: readonly string[];
}

export type Protection =
  /**
   * `importedBy` is set when the path is not a config itself but a file a
   * config imports. It is an addition to the shape, so code that knows only
   * `reason` still reads such a file as the config, which it is in effect.
   */
  | { readonly reason: "config"; readonly importedBy?: "the Jevy config" }
  | { readonly reason: "cache" }
  | { readonly reason: "policy" }
  /** `glob` is repository-relative: the directory, then the entry. */
  | { readonly reason: "listed"; readonly glob: string };

/** The names core's loader tries. Case is folded before this is asked. */
const CONFIG_NAME = /^jevy\.config\.(ts|mts|js|mjs)$/i;

/** `/x`, `C:/x` or `C:\x`. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Resolve `path` against the directory `base` by text alone: `.` and empty
 * segments drop out and `..` removes the segment before it. Null when it
 * climbs above the repository root. Nothing on disk is consulted, so a
 * symlink is not followed; the paths compared here come from git, which
 * does not follow them either.
 */
function resolveSegments(
  base: readonly string[],
  path: string,
): string[] | null {
  const out = [...base];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part !== "..") {
      out.push(part);
    } else if (out.pop() === undefined) {
      return null;
    }
  }
  return out;
}

/** Drop empty and `.` segments. For text already known to hold no `..`. */
function tidy(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * `text` as a disk that ignores case and Unicode form compares it.
 *
 * JavaScript has no case-fold function. Upper-casing and then lower-casing
 * comes close and errs towards calling two names the same (`ß` and `ss`),
 * which here means protecting more. Composing first and last makes `é` one
 * code point however it was typed. No letter folds to `/`, `*`, `?`, `{`,
 * `}` or `,`, so a folded glob keeps its meaning.
 */
function fold(text: string): string {
  return text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** One way of spelling the rules, as written or folded, ready to compare. */
interface Form {
  readonly globDir: readonly string[];
  readonly globs: readonly string[];
  readonly cacheDir: readonly string[];
  readonly policyFile: readonly string[] | null;
  readonly imports: readonly (readonly string[])[];
}

interface Prepared {
  readonly written: Form;
  readonly folded: Form;
  /** Folding changed nothing in the rules, so one spelling says it all. */
  readonly alike: boolean;
}

/** A path in one spelling beside the rules in the same spelling. */
type Spelling = readonly [form: Form, path: readonly string[]];

function formOf(rules: ProtectRules, spell: (text: string) => string): Form {
  const segments = (path: string): string[] =>
    tidy(path)
      .split("/")
      .filter((part) => part !== "")
      .map(spell);
  return {
    globDir: segments(rules.globDir),
    globs: rules.globs.map(spell),
    cacheDir: segments(rules.cacheDir),
    policyFile: rules.policyFile === null ? null : segments(rules.policyFile),
    imports: (rules.imports ?? []).map(segments),
  };
}

/** Folding every rule for every path made the hot loop; do it once a rule set. */
const preparedRules = new WeakMap<ProtectRules, Prepared>();

function prepare(rules: ProtectRules): Prepared {
  const known = preparedRules.get(rules);
  if (known !== undefined) {
    return known;
  }
  const written = formOf(rules, (text) => text);
  const folded = formOf(rules, fold);
  const prepared: Prepared = {
    written,
    folded,
    alike: JSON.stringify(written) === JSON.stringify(folded),
  };
  preparedRules.set(rules, prepared);
  return prepared;
}

/** `path` with the leading `dir` removed, or null when it is not under it. */
function below(
  dir: readonly string[],
  path: readonly string[],
): readonly string[] | null {
  return dir.length <= path.length &&
    dir.every((part, index) => part === path[index])
    ? path.slice(dir.length)
    : null;
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && below(a, b) !== null;
}

/** An empty cache directory holds nothing; it is not the whole repository. */
function inCache(form: Form, path: readonly string[]): boolean {
  return form.cacheDir.length > 0 && below(form.cacheDir, path) !== null;
}

/**
 * The index of the first glob that matches `path`, or -1. The directory is
 * compared as text and taken off the path first; only the rest of the path
 * is given to the glob matcher, so no character of the directory can ever
 * be read as glob syntax.
 */
function listedIndex(form: Form, path: readonly string[]): number {
  const rest = below(form.globDir, path);
  if (rest === null || rest.length === 0) {
    return -1;
  }
  const glob = firstMatch(rest.join("/"), form.globs);
  return glob === null ? -1 : form.globs.indexOf(glob);
}

/**
 * `path` as written and folded, each beside the rules in the same spelling.
 * One spelling when folding changes neither the path nor the rules, which is
 * the usual case and halves the work.
 */
function spellings(
  path: readonly string[],
  rules: ProtectRules,
): readonly Spelling[] {
  const prepared = prepare(rules);
  const folded = path.map(fold);
  return prepared.alike && folded.every((part, index) => part === path[index])
    ? [[prepared.written, path]]
    : [
        [prepared.written, path],
        [prepared.folded, folded],
      ];
}

/** The listed glob as a person would find it: directory, then entry. */
function shownGlob(rules: ProtectRules, index: number): string {
  const glob = rules.globs[index] ?? "";
  const dir = tidy(rules.globDir);
  return dir === "" ? glob : `${dir}/${glob}`;
}

/** The rules that come from the config's own settings: policy, then list. */
function configuredProtection(
  both: readonly Spelling[],
  rules: ProtectRules,
): Protection | null {
  if (
    both.some(
      ([form, spelt]) =>
        form.policyFile !== null && sameSegments(form.policyFile, spelt),
    )
  ) {
    return { reason: "policy" };
  }
  // The earliest entry in the list wins, whichever spelling it matched in.
  const hits = both
    .map(([form, spelt]) => listedIndex(form, spelt))
    .filter((index) => index !== -1);
  return hits.length === 0
    ? null
    : { reason: "listed", glob: shownGlob(rules, Math.min(...hits)) };
}

function protectionOfSegments(
  path: readonly string[],
  rules: ProtectRules,
): Protection | null {
  if (path.length === 0) {
    return null;
  }
  const both = spellings(path, rules);
  if (both.some(([, spelt]) => CONFIG_NAME.test(spelt.at(-1) ?? ""))) {
    return { reason: "config" };
  }
  if (
    both.some(([form, spelt]) =>
      form.imports.some((file) => sameSegments(file, spelt)),
    )
  ) {
    return { reason: "config", importedBy: "the Jevy config" };
  }
  if (both.some(([form, spelt]) => inCache(form, spelt))) {
    return { reason: "cache" };
  }
  return configuredProtection(both, rules);
}

/**
 * The segments of a path inside the repository. A backslash is read as a
 * separator: on Windows it is one, and on other systems calling the odd file
 * `a\jevy.config.ts` a config protects too much, never too little. Throws
 * GuardError for a path that climbs out with `..`: from a repository in
 * `jevy/`, `../jevy/jevy.config.ts` is its own config, and this cannot know
 * the repository's name.
 */
function segmentsInside(path: string): string[] {
  const segments = resolveSegments([], path.replaceAll("\\", "/"));
  if (segments === null) {
    throw new GuardError(
      `"${path}" climbs out of the repository, so it cannot be compared with the protected paths`,
    );
  }
  return segments;
}

/**
 * Why `path` (repository-relative) is protected, or null.
 *
 * When several rules apply the first of these wins: the Jevy config, the
 * decision cache, the wallet policy, then the first matching `protect` glob
 * in list order. The path is normalised first, so `a/../jevy.config.ts` and
 * `a\jevy.config.ts` are the config, and it is matched whatever its case or
 * Unicode form (see the note at the top of this file).
 *
 * A path this cannot place throws GuardError, because "not protected" would
 * be a guess: an absolute path (`/x`, `\x`), a drive letter (`C:/x`, `C:x`)
 * and a path that climbs out of the repository (`../x`). A path that names
 * nothing (`""`, `.`) is null.
 *
 * Decision records under the cache directory are protected here: the
 * pre-edit hook must stop an agent editing one by hand.
 */
export function protectionOf(
  path: string,
  rules: ProtectRules,
): Protection | null {
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    // Answering "not protected" for a path this cannot place would wave an
    // edit through. The caller has a bug; it should hear about it.
    throw new GuardError(
      `a protected-path check needs a repository-relative path, not "${path}"`,
    );
  }
  return protectionOfSegments(segmentsInside(path), rules);
}

function directoryOf(path: string, what: string): string[] {
  const segments = isAbsolute(path) ? null : resolveSegments([], path);
  if (segments === null) {
    throw new GuardError(
      `${what} "${path}" must be a path inside the repository, relative to its root`,
    );
  }
  return segments;
}

/**
 * A `protect` entry as a glob relative to the config's directory, tidied.
 *
 * The entry must be a glob the matcher honours and must stay inside the
 * config's directory: a `..` segment is refused wherever it stands, as
 * core's loader refuses it, so that a config which loads is a config the
 * guard and the hooks can use.
 */
function protectEntry(entry: string, atRoot: boolean): string {
  const refuse = (why: string): GuardError =>
    new GuardError(`protect entry "${entry}" in the Jevy config ${why}`);
  if (entry === "") {
    throw refuse("is empty");
  }
  if (isAbsolute(entry)) {
    throw refuse(
      "is an absolute path; write it relative to the config's directory",
    );
  }
  const glob = tidy(entry);
  if (glob === "") {
    throw refuse(
      atRoot
        ? 'names the repository root; write "**" to protect everything'
        : 'names the config\'s own directory; write "**" to protect everything in it',
    );
  }
  try {
    checkGlob(entry);
    // Tidying must not turn a glob the matcher honours into one it refuses:
    // that one would match nothing and unprotect what the entry names.
    checkGlob(glob);
  } catch (error) {
    throw refuse(
      `cannot be used: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return glob;
}

/** The `web3.policy` path as a repository-relative file. It is not a glob. */
function resolvePolicy(entry: string, configDir: readonly string[]): string {
  const refuse = (why: string): GuardError =>
    new GuardError(`web3.policy "${entry}" in the Jevy config ${why}`);
  if (entry === "") {
    throw refuse("is empty");
  }
  if (isAbsolute(entry)) {
    throw refuse(
      "is an absolute path; write it relative to the config's directory so the guard can protect it",
    );
  }
  if (entry.includes("\\")) {
    throw refuse("contains a backslash; use forward slashes");
  }
  // `./`, `.` and `a/..` end on a directory, never on a file.
  const last = entry.slice(entry.lastIndexOf("/") + 1);
  if (last === "" || last === "." || last === "..") {
    throw refuse("names no file");
  }
  const segments = resolveSegments(configDir, entry);
  if (segments === null) {
    throw refuse("points outside the repository");
  }
  return segments.join("/");
}

/** What a loader may add to an import written without an extension. */
const LOADABLE = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/** A JavaScript extension that TypeScript-aware loaders map to TypeScript. */
const JS_EXTENSION = /\.(js|jsx|mjs|cjs)$/i;

/**
 * Every file an import of `file` can load: the name as written; for a `.js`
 * name, the TypeScript file beside it that a TypeScript-aware loader opens
 * instead; for a name without an extension, each extension a loader tries
 * and the `index` file of a directory by that name. Protecting a name that
 * is not there costs nothing, and missing the one that is loads unseen.
 */
function importCandidates(file: string): readonly string[] {
  const js = JS_EXTENSION.exec(file);
  if (js !== null) {
    const stem = file.slice(0, js.index);
    return [file, ...[".ts", ".tsx", ".mts", ".cts"].map((ext) => stem + ext)];
  }
  const last = file.slice(file.lastIndexOf("/") + 1);
  if (last.includes(".") && !last.startsWith(".")) {
    return [file];
  }
  return [
    file,
    ...LOADABLE.map((ext) => file + ext),
    ...LOADABLE.map((ext) => `${file}/index${ext}`),
  ];
}

/**
 * The imports as repository-relative files with every candidate name. They
 * arrive resolved against the config's path, which is in the same frame as
 * the paths later checked against the rules, so they are only tidied here.
 * One outside the repository cannot be protected: refuse it, as dropping it
 * would let the value it holds change unseen.
 */
function resolveImports(imports: readonly string[]): readonly string[] {
  return imports.flatMap((entry) => {
    const segments = isAbsolute(entry) ? null : resolveSegments([], entry);
    if (segments === null || segments.length === 0) {
      throw new GuardError(
        `the Jevy config imports "${entry}", which is outside the repository, so the guard cannot protect it`,
      );
    }
    return importCandidates(segments.join("/"));
  });
}

/**
 * Build the rules for one config.
 *
 * `settings` is what readConfigSettings returned for the config (null when
 * there is no config). `configDir` is the config's directory relative to the
 * repository root ("" for the root). `cacheDir` is the already-resolved,
 * repository-relative cache directory.
 *
 * `protect` globs and `web3.policy` are written relative to the config file.
 * The policy path is joined to `configDir` here; the globs are kept beside
 * it (see `ProtectRules.globDir`). An entry that is absolute, has a `..`
 * segment, or is a glob the matcher cannot honour throws GuardError naming
 * the entry: dropping it would unprotect what it names. The policy path may
 * climb with `..` as long as it stays in the repository.
 * The cache directory must be a directory below the root for the same
 * reason; at the root itself it would protect every file.
 *
 * `settings.imports`, the files the config imports, are protected as the
 * config is. They are already in the frame the paths checked against the
 * rules are in (see `ConfigSettings.imports`), so they are not joined to
 * `configDir`; one that climbs out of that frame throws GuardError.
 *
 * This reads `settings.protect`, `settings.web3Policy` and
 * `settings.imports` only. It does not look at `settings.unreadable`: a
 * caller that must fail closed checks that first, since an unreadable
 * `protect` arrives here as "no list".
 */
export function buildProtectRules(input: {
  readonly settings: ConfigSettings | null;
  readonly configDir: string;
  readonly cacheDir: string;
}): ProtectRules {
  const configDir = directoryOf(input.configDir, "the config directory");
  const cacheDir = directoryOf(input.cacheDir, "the decision cache directory");
  if (cacheDir.length === 0) {
    throw new GuardError(
      `the decision cache directory "${input.cacheDir}" is the repository root; it must be a directory below it, or every file would be protected`,
    );
  }
  const policy = input.settings?.web3Policy ?? null;
  const imports = resolveImports(input.settings?.imports ?? []);
  return {
    globDir: configDir.join("/"),
    globs: (input.settings?.protect ?? []).map((entry) =>
      protectEntry(entry, configDir.length === 0),
    ),
    cacheDir: cacheDir.join("/"),
    policyFile: policy === null ? null : resolvePolicy(policy, configDir),
    ...(imports.length > 0 ? { imports } : {}),
  };
}

function why(protection: Protection): string {
  switch (protection.reason) {
    case "config":
      return protection.importedBy === undefined
        ? "the Jevy config"
        : "a file imported by the Jevy config";
    case "cache":
      return "the decision cache";
    case "policy":
      return "the wallet policy";
    case "listed":
      return `"${protection.glob}" in protect`;
  }
}

/**
 * Whether the guard compares `path` as a decision record. This must say what
 * `classifyPath` in `analyse.ts` says, on the path exactly as git wrote it: a
 * record under another spelling of the cache directory is compared by
 * nothing, so it must not be exempted here.
 */
function isRecord(path: string, rules: ProtectRules): boolean {
  return path.startsWith(`${rules.cacheDir}/`) && path.endsWith(".jsonl");
}

/**
 * What the guard reports for `path`: `protectionOf`, except that a decision
 * record is not reported for being in the cache. It can still be reported
 * for a `protect` glob that names it, which is how a team freezes records.
 *
 * Git's paths are always repository-relative, so a leading `/` or `C:` is
 * read as the odd directory name it is. A path that climbs out throws.
 */
function reportable(path: string, rules: ProtectRules): Protection | null {
  const segments = segmentsInside(path);
  const protection = protectionOfSegments(segments, rules);
  return protection?.reason === "cache" && isRecord(path, rules)
    ? configuredProtection(spellings(segments, rules), rules)
    : protection;
}

function renameReason(
  before: Protection | null,
  after: Protection | null,
): string | null {
  const old = before === null ? null : why(before);
  const now = after === null ? null : why(after);
  if (old !== null && now !== null) {
    return old === now
      ? `${old} (old and new path)`
      : `${old} (old path) and ${now} (new path)`;
  }
  if (old !== null) {
    return `${old} (old path)`;
  }
  return now === null ? null : `${now} (new path)`;
}

function statusOf(change: FileChange): string {
  return change.status === "renamed"
    ? `renamed from ${change.oldPath} to ${change.path}`
    : change.status;
}

function findingFor(change: FileChange, rules: ProtectRules): Finding | null {
  const after = reportable(change.path, rules);
  const reason =
    change.status === "renamed"
      ? renameReason(reportable(change.oldPath, rules), after)
      : after === null
        ? null
        : why(after);
  if (reason === null) {
    return null;
  }
  return finding({
    kind: "protected-path-changed",
    file: change.path,
    message: `protected path changed (${statusOf(change)}): matches ${reason}; a person must approve this change`,
  });
}

/** The finding for a change whose path could not be judged. */
function unchecked(change: FileChange, error: unknown): Finding {
  const reason = error instanceof Error ? error.message : String(error);
  return finding({
    kind: "protected-path-changed",
    file: change.path,
    message: `protected path could not be checked (${statusOf(change)}): ${reason}; a person must approve this change`,
  });
}

/**
 * One `protected-path-changed` finding per changed path that is protected,
 * in the order of `changes`. Added, modified and deleted files are checked
 * by their path; a rename is protected when its old or its new path is, and
 * gives one finding on the new path that names both.
 *
 * Exception, for the guard only: decision record files (`*.jsonl` under the
 * cache directory) are not reported for being in the cache. A test run
 * writes them, and the guard already compares them record by record
 * (`diff-decisions.ts`), so reporting every new record as weakening would
 * fail every change that adds a model-judged check. Any other file under
 * the cache directory is reported, and so is a record that a `protect` glob
 * names. `protectionOf` makes no such exception.
 *
 * This never throws. The paths are git's, which are always
 * repository-relative, so a directory really named `C:` is read as the
 * relative path it is. A change whose path still cannot be judged (it climbs
 * out with `..`) is reported as a finding that says so: passing it over
 * would be calling it unprotected.
 */
export function protectedPathFindings(
  changes: readonly FileChange[],
  rules: ProtectRules,
): Finding[] {
  const out: Finding[] = [];
  for (const change of changes) {
    try {
      const found = findingFor(change, rules);
      if (found !== null) {
        out.push(found);
      }
    } catch (error) {
      out.push(unchecked(change, error));
    }
  }
  return out;
}
