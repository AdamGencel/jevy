import { UsageError } from "./errors.js";

/**
 * A small glob matcher for repository-relative paths with forward slashes.
 *
 * The globs name files an agent must not touch (`protect`) or files that hold
 * tests (`guard.tests`), so the matcher errs towards matching: a glob that
 * matches a directory also matches everything inside it. What it cannot
 * honour it rejects in `checkGlob` instead of guessing, because a glob that
 * silently matches nothing would silently unprotect.
 *
 * Supported: literal segments, `*` and `?` within a segment, `**` as a whole
 * segment, and `{a,b}` alternation (which may span segments: `{a/b,c}/x`).
 * Parentheses are literal text (`app/(marketing)/**`). Not supported, and
 * rejected: negation (`!x`), nested braces, character classes (`[abc]`),
 * extended glob groups (`@(a|b)`, `+(a)`, `?(a)`, `*(a)`, `!(a)`), `|`,
 * backslashes, absolute paths, `..` segments and whitespace at either end.
 *
 * `@jevyjs/core`'s loader restates this rule as `assertGlob` in its
 * `config.ts`. The CLI must not depend on core and core cannot import the
 * CLI, so the rule is written twice on purpose; the table of globs in
 * `glob.test.ts` and in core's `config.test.ts` holds the two together.
 * Change one and you change the other.
 *
 * It is written without regular expressions over the path: matching is a
 * state set over segments and a two-pointer scan within a segment, so the
 * cost is bounded by pattern length times path length whatever the glob.
 */

/** One path segment of a pattern. */
type Segment =
  | { readonly kind: "globstar" }
  | { readonly kind: "name"; readonly chars: readonly string[] };

type Compiled =
  | { readonly ok: true; readonly patterns: readonly (readonly Segment[])[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Upper bound on the patterns one glob may expand to. `{a,b}{c,d}{e,f}...`
 * doubles with every group; past this the glob is a mistake or an attack.
 */
const MAX_ALTERNATIVES = 256;

type Expanded =
  | { readonly ok: true; readonly alternatives: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Expand `{a,b}` groups into every plain pattern they stand for. */
function expandBraces(glob: string): Expanded {
  let alternatives: readonly string[] = [""];
  let rest = glob;
  for (;;) {
    const open = rest.indexOf("{");
    const close = rest.indexOf("}");
    if (open === -1 && close === -1) {
      return { ok: true, alternatives: alternatives.map((a) => a + rest) };
    }
    if (open === -1 || close < open) {
      return { ok: false, reason: "unbalanced braces" };
    }
    const body = rest.slice(open + 1, close);
    if (body.includes("{")) {
      return { ok: false, reason: "nested braces are not supported" };
    }
    const head = rest.slice(0, open);
    const options = body.split(",");
    if (alternatives.length * options.length > MAX_ALTERNATIVES) {
      return {
        ok: false,
        reason: `too many alternatives (more than ${String(MAX_ALTERNATIVES)})`,
      };
    }
    alternatives = alternatives.flatMap((a) =>
      options.map((option) => a + head + option),
    );
    rest = rest.slice(close + 1);
  }
}

/** Split on `/`, dropping empty and `.` segments: `./a//b/` is `a/b`. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

type Pattern =
  | { readonly ok: true; readonly segments: readonly Segment[] }
  | { readonly ok: false; readonly reason: string };

/** A drive letter is refused with or without a slash after it. */
const DRIVE = /^[A-Za-z]:/;

/**
 * One alternative of an expanded glob as segments. Where the glob starts is
 * judged here, on the first segment after expansion, because `{!a,b}`,
 * `./!a` and `./C:x` each put a `!` or a drive letter first without the glob
 * itself starting with one.
 */
function compilePattern(text: string): Pattern {
  const parts = segmentsOf(text);
  const first = parts[0] ?? "";
  if (text.startsWith("/") || DRIVE.test(first)) {
    return {
      ok: false,
      reason:
        "an absolute path is not allowed; write it relative to the repository root",
    };
  }
  if (first.startsWith("!")) {
    return { ok: false, reason: "negation (!) is not supported" };
  }
  const segments: Segment[] = [];
  for (const part of parts) {
    if (part === "..") {
      return { ok: false, reason: 'a ".." segment is not allowed' };
    }
    if (part === "**") {
      segments.push({ kind: "globstar" });
    } else if (part.includes("**")) {
      // `**.ts` reads as "any depth" but could only ever mean `*.ts`.
      return { ok: false, reason: "** must be a whole segment" };
    } else {
      segments.push({ kind: "name", chars: Array.from(part) });
    }
  }
  return segments.length === 0
    ? { ok: false, reason: "it names no path" }
    : { ok: true, segments };
}

/**
 * Why `glob` cannot be honoured before it is expanded, or null. Everything
 * here is syntax another glob library gives a meaning to and this matcher
 * would read as literal text, so the glob would match nothing.
 */
function refusal(glob: string): string | null {
  if (glob === "") {
    return "it is empty";
  }
  if (glob !== glob.trim()) {
    return "whitespace at the start or end is not allowed";
  }
  if (glob.includes("\\")) {
    return "a backslash is not supported; use forward slashes";
  }
  if (glob.includes("[") || glob.includes("]")) {
    return "a character class ([...]) is not supported; use ? for one character";
  }
  if (/[@+?*!]\(/.test(glob)) {
    return "an extended glob group such as @(a|b) is not supported; use {a,b}";
  }
  if (glob.includes("|")) {
    return 'a "|" is not supported; use {a,b} for alternatives';
  }
  return null;
}

function compileFresh(glob: string): Compiled {
  const refused = refusal(glob);
  if (refused !== null) {
    return { ok: false, reason: refused };
  }
  const expanded = expandBraces(glob);
  if (!expanded.ok) {
    return expanded;
  }
  const patterns: (readonly Segment[])[] = [];
  for (const alternative of expanded.alternatives) {
    const pattern = compilePattern(alternative);
    if (!pattern.ok) {
      return pattern;
    }
    patterns.push(pattern.segments);
  }
  return { ok: true, patterns };
}

/**
 * How many compiled globs are kept. A run uses a few dozen; the bound only
 * stops a long-lived process that sees endless distinct globs from growing.
 */
export const GLOB_CACHE_LIMIT = 1024;

/** Compiled globs by their text, oldest first. */
const compiledGlobs = new Map<string, Compiled>();

/** How many compiled globs are held now. Exported for the test of the bound. */
export function globCacheSize(): number {
  return compiledGlobs.size;
}

/**
 * `compileFresh`, remembered. The guard matches every changed path against
 * every glob, and expanding braces on each call made that the slowest part
 * of a run. A refused glob is remembered too: it is asked about as often.
 */
function compile(glob: string): Compiled {
  const known = compiledGlobs.get(glob);
  if (known !== undefined) {
    return known;
  }
  const compiled = compileFresh(glob);
  if (compiledGlobs.size >= GLOB_CACHE_LIMIT) {
    for (const oldest of compiledGlobs.keys()) {
      compiledGlobs.delete(oldest);
      break;
    }
  }
  compiledGlobs.set(glob, compiled);
  return compiled;
}

/**
 * Whether `pattern` (literals, `*`, `?`) matches the whole of `text`, both as
 * code points. On a mismatch it returns to the last `*` and lets it take one
 * more character; it never retries an earlier `*`, which is what keeps this
 * linear in each direction where a naive matcher is exponential.
 */
function nameMatches(
  pattern: readonly string[],
  text: readonly string[],
): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const want = pattern[p];
    if (want === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (want !== undefined && (want === "?" || want === text[t])) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") {
    p += 1;
  }
  return p === pattern.length;
}

/** Add the positions reachable by letting a `**` match no segment. */
function skipGlobstars(
  states: Set<number>,
  pattern: readonly Segment[],
): Set<number> {
  // A Set visits members added during iteration, so chains of `**` resolve.
  for (const index of states) {
    if (pattern[index]?.kind === "globstar") {
      states.add(index + 1);
    }
  }
  return states;
}

/**
 * Whether `pattern` matches `path` or a leading part of it. The set holds
 * every pattern position that the segments read so far could have reached;
 * reaching the end with segments still unread means a directory matched.
 */
function patternMatches(
  pattern: readonly Segment[],
  path: readonly (readonly string[])[],
): boolean {
  const end = pattern.length;
  let states = skipGlobstars(new Set([0]), pattern);
  for (const name of path) {
    if (states.has(end)) {
      return true;
    }
    const next = new Set<number>();
    for (const index of states) {
      const segment = pattern[index];
      if (segment === undefined) {
        continue;
      }
      if (segment.kind === "globstar") {
        next.add(index);
      } else if (nameMatches(segment.chars, name)) {
        next.add(index + 1);
      }
    }
    if (next.size === 0) {
      return false;
    }
    states = skipGlobstars(next, pattern);
  }
  return states.has(end);
}

/**
 * True when `glob` matches `path`, or matches a directory that contains it.
 *
 * Globs are anchored at the repository root and case-sensitive. `*` and `?`
 * stay within one segment and match a leading dot; `**` as a whole segment
 * matches zero or more segments; `{a,b}` is alternation, not nested. Because
 * a matched directory covers its contents, `tests/critical`, `tests/critical/`
 * and `tests/crit*` all match `tests/critical/a/b.ts`, and a trailing `*` is
 * as wide as `**`. `tests/crit` does not: a segment matches whole or not at
 * all.
 *
 * `path` must already be normalised (no `..`). A leading `./` is ignored on
 * both sides. Returns false, and never throws, for a glob `checkGlob` rejects
 * and for an empty path.
 */
export function matchesGlob(path: string, glob: string): boolean {
  return matchesNames(namesOf(path), glob);
}

/** The segments of a path, each as code points. Empty for a path that names nothing. */
function namesOf(path: string): readonly (readonly string[])[] {
  return segmentsOf(path).map((name) => Array.from(name));
}

function matchesNames(
  names: readonly (readonly string[])[],
  glob: string,
): boolean {
  if (names.length === 0) {
    return false;
  }
  const compiled = compile(glob);
  return (
    compiled.ok &&
    compiled.patterns.some((pattern) => patternMatches(pattern, names))
  );
}

/**
 * The first glob in `globs` that matches `path`, or null. The path is split
 * once for the whole list, not once for each glob.
 */
export function firstMatch(
  path: string,
  globs: readonly string[],
): string | null {
  const names = namesOf(path);
  return globs.find((glob) => matchesNames(names, glob)) ?? null;
}

/**
 * Throws UsageError for a glob this matcher cannot honour: an empty glob,
 * whitespace at either end, negation, an absolute path or drive letter, a
 * `..` segment, a backslash, a character class, an extended glob group, a
 * `|`, nested or unbalanced braces, more than 256 alternatives, `**` that is
 * not a whole segment, or a glob that names no path (`.`). Call it where
 * globs enter, so a mistake is an error a person sees and not a rule that
 * quietly matches nothing.
 *
 * Core's `assertGlob` must refuse exactly the same globs; see the note at
 * the top of this file.
 */
export function checkGlob(glob: string): void {
  const compiled = compile(glob);
  if (!compiled.ok) {
    throw new UsageError(`invalid glob "${glob}": ${compiled.reason}`);
  }
}
