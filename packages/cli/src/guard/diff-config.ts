import ts from "typescript";
import { readConfigSettings } from "./config-source.js";
import { finding, sortFindings } from "./findings.js";
import {
  lineOf,
  literalText,
  normaliseCode,
  parseSource,
  propertyName,
  stringValue,
  unwrap,
} from "./source.js";
import type { Finding, FindingKind } from "./types.js";

/**
 * Compares two versions of `jevy.config.*` and `playwright.config.*` as
 * source text. Configs are TypeScript, so loading them would mean running
 * the repository's code; the guard reads the object literal instead and
 * treats anything it cannot read as literal as a change for review.
 */

export interface ConfigFileChange {
  readonly file: string;
  readonly before: string | null;
  readonly after: string | null;
  /**
   * False when this file is not the one core's loader reads in its
   * directory in both versions. Its `toSatisfy.blocking` then decides
   * nothing on its own: `diffLoadedBlocking` compares the files the loader
   * does read. Absent is true.
   */
  readonly loaded?: boolean;
}

interface Entry {
  /** Normalised code of the value: what is compared. */
  readonly code: string;
  /** Canonical literal text, or null when the value is not a literal. */
  readonly literal: string | null;
  /** Source text with whitespace collapsed: what is shown. */
  readonly display: string;
  readonly line: number;
}

/** Top-level keys compared as a whole rather than property by property. */
const WHOLE_KEYS = new Set([
  "redact",
  "normalise",
  "decider",
  "deciders",
  "protect",
]);

/**
 * A Map, not an object: the key looked up is a property name from the
 * repository's config. In an object, `__proto__` or `constructor` would find
 * what every object inherits and come back as a "kind" that is no kind.
 */
const WHOLE_KEY_KINDS: ReadonlyMap<string, FindingKind> = new Map([
  ["redact", "redaction-rules-changed"],
  ["normalise", "normalise-rules-changed"],
  ["decider", "decider-changed"],
  ["deciders", "decider-changed"],
]);

/** Playwright settings that decide which tests run at all. */
const SELECTION_KEYS = [
  "testDir",
  "testMatch",
  "testIgnore",
  "grep",
  "grepInvert",
  "forbidOnly",
] as const;

function display(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ");
}

function entryOf(value: ts.Expression, sourceFile: ts.SourceFile): Entry {
  return {
    code: normaliseCode(value, sourceFile),
    literal: literalText(value),
    display: display(value, sourceFile),
    line: lineOf(value, sourceFile),
  };
}

function isDefineConfig(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "defineConfig") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "defineConfig")
  );
}

function topLevelConsts(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined
      ) {
        out.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return out;
}

/** Follow `defineConfig(x)` and `const x = {...}` to the object literal. */
function resolveObject(
  expression: ts.Expression | undefined,
  consts: ReadonlyMap<string, ts.Expression>,
  depth = 0,
): ts.ObjectLiteralExpression | null {
  if (expression === undefined || depth > 8) {
    return null;
  }
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) {
    return node;
  }
  if (ts.isIdentifier(node)) {
    return resolveObject(consts.get(node.text), consts, depth + 1);
  }
  if (ts.isCallExpression(node) && isDefineConfig(node)) {
    return resolveObject(node.arguments[0], consts, depth + 1);
  }
  return null;
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

/**
 * The default-exported object, else the argument of the first `defineConfig`.
 *
 * This finder is generous on purpose: the diff wants an object to compare
 * whenever there is one, and reports everything outside it as changed code.
 * `config-source.ts` reads settings that decide what is protected, so it has
 * a stricter finder of its own and does not use this one.
 */
function findConfigObject(
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  const consts = topLevelConsts(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return resolveObject(statement.expression, consts);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left)
    ) {
      return resolveObject(statement.expression.right, consts);
    }
  }
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }
    if (ts.isCallExpression(node) && isDefineConfig(node)) {
      found = resolveObject(node.arguments[0], consts);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Flatten an object literal to `a.b.c` paths. */
function flatten(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  prefix: string,
  out: Map<string, Entry>,
): void {
  object.properties.forEach((property, index) => {
    if (ts.isPropertyAssignment(property)) {
      const name =
        propertyName(property.name) ??
        `[${display(property.name, sourceFile)}]`;
      const path = prefix === "" ? name : `${prefix}.${name}`;
      const value = unwrap(property.initializer);
      if (
        ts.isObjectLiteralExpression(value) &&
        !(prefix === "" && WHOLE_KEYS.has(name))
      ) {
        flatten(value, sourceFile, path, out);
      } else {
        out.set(path, entryOf(property.initializer, sourceFile));
      }
      return;
    }
    // Shorthand, spread, methods and accessors cannot be read as literals:
    // keep their code so any change to them is still seen.
    const label = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : `<${String(index)}>`;
    const path = prefix === "" ? label : `${prefix}.${label}`;
    out.set(path, {
      code: normaliseCode(property, sourceFile),
      literal: null,
      display: display(property, sourceFile),
      line: lineOf(property, sourceFile),
    });
  });
}

type ConfigRead =
  | {
      readonly ok: true;
      readonly entries: ReadonlyMap<string, Entry>;
      /** Normalised code of the file with the config object cut out. */
      readonly outside: string;
    }
  | { readonly ok: false; readonly reason: string };

function readJevyConfig(text: string, file: string): ConfigRead {
  const parsed = parseSource(text, file);
  if (!parsed.ok) {
    return { ok: false, reason: `could not be parsed (${parsed.error})` };
  }
  const object = findConfigObject(parsed.sourceFile);
  if (object === null) {
    return {
      ok: false,
      reason:
        "has no object literal passed to defineConfig or default-exported; review it by hand",
    };
  }
  const entries = new Map<string, Entry>();
  flatten(object, parsed.sourceFile, "", entries);
  return {
    ok: true,
    entries,
    outside: normaliseCode(parsed.sourceFile, parsed.sourceFile, object),
  };
}

/**
 * Core's default for `ci.needsReview.pr` (see `readCi` in @jevyjs/core's
 * config.ts). Removing `pr: "fail"` therefore relaxes it to "warn". The
 * default for `main` is "fail", so removing that relaxes nothing.
 */
const NEEDS_REVIEW_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ["ci.needsReview.pr", '"warn"'],
]);

function needsReviewAfter(
  path: string,
  after: Entry | undefined,
): string | null {
  return after === undefined
    ? (NEEDS_REVIEW_DEFAULTS.get(path) ?? null)
    : after.literal;
}

function numberOf(entry: Entry | undefined): number | null {
  if (entry?.literal === null || entry === undefined) {
    return null;
  }
  const value = Number(entry.literal);
  return Number.isFinite(value) ? value : null;
}

function classifyEntry(
  file: string,
  path: string,
  before: Entry | undefined,
  after: Entry | undefined,
): Finding {
  const line = (after ?? before)?.line;
  const shown = {
    file,
    line,
    before: before?.display,
    after: after?.display,
  };
  const top = path.split(".")[0] ?? path;
  const wholeKind = WHOLE_KEY_KINDS.get(top);
  if (wholeKind !== undefined) {
    return finding({ ...shown, kind: wholeKind, message: `${top} changed` });
  }
  const verb =
    before === undefined
      ? "added"
      : after === undefined
        ? "removed"
        : "changed";
  if (top === "protect") {
    // The list of paths an agent must not touch is itself one of them: a
    // shorter list unprotects files without changing any of them.
    return finding({
      ...shown,
      kind: "protected-path-changed",
      message: `protect ${verb}`,
    });
  }
  if (path === "thresholds.pass") {
    const was = numberOf(before);
    const now = numberOf(after);
    if (was !== null && now !== null && now < was) {
      return finding({
        ...shown,
        kind: "threshold-lowered",
        message: `thresholds.pass lowered from ${String(was)} to ${String(now)}`,
        before: String(was),
        after: String(now),
      });
    }
  }
  if (
    (path === "ci.needsReview.pr" || path === "ci.needsReview.main") &&
    before?.literal === '"fail"' &&
    needsReviewAfter(path, after) === '"warn"'
  ) {
    const removed =
      after === undefined ? ' (removed; the default is "warn")' : "";
    return finding({
      ...shown,
      kind: "needs-review-relaxed",
      message: `${path} relaxed from "fail" to "warn"${removed}`,
    });
  }
  return finding({
    ...shown,
    kind: "config-changed",
    message: `${path} ${verb}`,
  });
}

const BLOCKING = "toSatisfy.blocking";

/**
 * `toSatisfy.blocking` as the loader would receive it: `true`, `false`, or
 * "absent", which is core's default, false. Null when the text does not
 * show it. The strict reader decides, not the entries this diff compares:
 * a weakening finding must rest on a value the loader is shown to receive.
 */
function blockingOf(text: string, file: string): boolean | "absent" | null {
  const settings = readConfigSettings(text, file);
  if (
    settings.unreadable.includes("*") ||
    settings.unreadable.includes(BLOCKING)
  ) {
    return null;
  }
  return settings.toSatisfyBlocking ?? "absent";
}

/**
 * `blocking-switched-off` when base shows `toSatisfy.blocking: true` and
 * head shows it `false` or not written, or null. A head value the text does
 * not show may still be true, so it stays `config-changed`.
 */
function blockingFinding(
  file: string,
  texts: { readonly before: string; readonly after: string },
  lines: {
    readonly before: number | undefined;
    readonly after: number | undefined;
  },
): Finding | null {
  const now = blockingOf(texts.after, file);
  if (blockingOf(texts.before, file) !== true || now === true || now === null) {
    return null;
  }
  const removed = now === "absent";
  return finding({
    kind: "blocking-switched-off",
    file,
    line: lines.after ?? lines.before,
    message: `${BLOCKING} switched off${removed ? " (removed; the default is false)" : ""}: toSatisfy now only reports and cannot fail a test`,
    before: "true",
    after: removed ? undefined : "false",
  });
}

/** A config file as core's loader would find it: its path and text. */
export interface LoadedConfigFile {
  readonly path: string;
  readonly text: string;
}

/** The line `toSatisfy.blocking` is written on in `text`, if it is. */
function blockingLine(text: string, path: string): number | undefined {
  const read = readJevyConfig(text, path);
  return read.ok ? read.entries.get(BLOCKING)?.line : undefined;
}

/**
 * `blocking-switched-off` for one directory, from the config core's loader
 * reads there in each version (the first of `jevy.config.ts`, `.mts`,
 * `.js`, `.mjs`), or null.
 *
 * Comparing file by file misses the ways a change can make the loader read
 * a different file: delete the config, add one it reads first, or rename it
 * where git does not pair the two names. Each leaves base's `true` behind
 * with no file showing it switched off. A directory with no config in head
 * gets the default, `false`. A head value the text does not show may still
 * be true, so it is left to the file's own `config-changed`.
 */
export function diffLoadedBlocking(
  base: LoadedConfigFile | null,
  head: LoadedConfigFile | null,
): Finding | null {
  if (base === null || blockingOf(base.text, base.path) !== true) {
    return null;
  }
  const now = head === null ? "absent" : blockingOf(head.text, head.path);
  if (now === true || now === null) {
    return null;
  }
  const outcome =
    now === "absent"
      ? "does not set it; the default is false"
      : "sets it to false";
  const why =
    head === null
      ? `${base.path} removed; the default is false`
      : head.path === base.path
        ? now === "absent"
          ? "removed; the default is false"
          : null
        : `the loader now reads ${head.path} instead of ${base.path}, and it ${outcome}`;
  return finding({
    kind: "blocking-switched-off",
    file: head?.path ?? base.path,
    line: head === null ? undefined : blockingLine(head.text, head.path),
    message: `${BLOCKING} switched off${why === null ? "" : ` (${why})`}: toSatisfy now only reports and cannot fail a test`,
    before: "true",
    after: now === false ? "false" : undefined,
  });
}

function unreadable(file: string, side: string, reason: string): Finding {
  return finding({
    file,
    kind: "config-changed",
    message: `${side} version ${reason}`,
  });
}

/**
 * Run one file's comparison, turning anything it throws into a finding.
 *
 * The TypeScript parser and the walks over its tree recurse, so a config
 * nested twenty thousand deep overflows the stack. That must not end the
 * guard: the other files would go unreported. Nothing is known about such a
 * file, so it is reported for review like any other the guard cannot read.
 */
function analysed(
  file: string,
  compare: () => readonly Finding[],
): readonly Finding[] {
  try {
    return compare();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      finding({
        file,
        kind: "config-changed",
        message: `the change could not be analysed (${reason}); review it by hand`,
      }),
    ];
  }
}

/** `0.8` equals `0.80` and `'fail'` equals `"fail"`; anything else compares as code. */
function sameValue(a: Entry, b: Entry): boolean {
  return a.literal !== null && b.literal !== null
    ? a.literal === b.literal
    : a.code === b.code;
}

function sameText(change: ConfigFileChange): boolean {
  return change.before === change.after;
}

/** Findings for one `jevy.config.*` file. Never throws (see `analysed`). */
export function diffJevyConfig(change: ConfigFileChange): readonly Finding[] {
  return analysed(change.file, () => compareJevyConfig(change));
}

function compareJevyConfig(change: ConfigFileChange): readonly Finding[] {
  const { file, before, after } = change;
  if (sameText(change)) {
    return [];
  }
  if (before === null) {
    return [
      finding({
        file,
        kind: "config-changed",
        message: "jevy config added; review all of it",
      }),
    ];
  }
  if (after === null) {
    return [
      finding({
        file,
        kind: "config-changed",
        message: "jevy config removed; the defaults now apply",
      }),
    ];
  }
  const was = readJevyConfig(before, file);
  const now = readJevyConfig(after, file);
  if (!now.ok) {
    return [unreadable(file, "head", now.reason)];
  }
  if (!was.ok) {
    return [unreadable(file, "base", was.reason)];
  }
  const paths = [...new Set([...was.entries.keys(), ...now.entries.keys()])];
  const switchedOff =
    change.loaded === false
      ? null
      : blockingFinding(
          file,
          { before, after },
          {
            before: was.entries.get(BLOCKING)?.line,
            after: now.entries.get(BLOCKING)?.line,
          },
        );
  const out: Finding[] = switchedOff === null ? [] : [switchedOff];
  const reported = new Set<string>();
  for (const path of paths.sort()) {
    const b = was.entries.get(path);
    const a = now.entries.get(path);
    if (b !== undefined && a !== undefined && sameValue(b, a)) {
      continue;
    }
    // Reported above, as the weakening it is: once, whether the key or the
    // whole `toSatisfy` value (`undefined`, a constant) changed.
    if (switchedOff !== null && (path === BLOCKING || path === "toSatisfy")) {
      continue;
    }
    const result = classifyEntry(file, path, b, a);
    // One finding per whole-compared key, however many paths it spans.
    const top = path.split(".")[0] ?? path;
    if (WHOLE_KEYS.has(top)) {
      if (reported.has(top)) {
        continue;
      }
      reported.add(top);
    }
    out.push(result);
  }
  // `{ thresholds }` or `pass: PASS` reads a value defined elsewhere in the
  // file; the object's own code is unchanged when that value is lowered.
  if (was.outside !== now.outside) {
    out.push(
      finding({
        file,
        kind: "config-changed",
        message:
          "code outside the config object changed (a constant, import or helper it may read); review it by hand",
      }),
    );
  }
  return sortFindings(out);
}

interface Setting {
  readonly name: string;
  readonly value: ts.Expression;
}

function collectSettings(
  sourceFile: ts.SourceFile,
  names: ReadonlySet<string>,
): Setting[] {
  const out: Setting[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null && names.has(name)) {
        out.push({ name, value: node.initializer });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** A retries value: a number, the larger branch of `CI ? 2 : 0`, or null. */
function retriesValue(expression: ts.Expression): number | null {
  const node = unwrap(expression);
  if (ts.isConditionalExpression(node)) {
    const a = retriesValue(node.whenTrue);
    const b = retriesValue(node.whenFalse);
    return a === null || b === null ? null : Math.max(a, b);
  }
  const literal = literalText(node);
  const value = literal === null ? Number.NaN : Number(literal);
  return Number.isFinite(value) ? value : null;
}

/** One side of a Playwright config, as far as retries go. */
interface RetriesModel {
  readonly source: ts.SourceFile;
  /** `retries` settings outside any `projects` entry, in source order. */
  readonly top: readonly Setting[];
  readonly projects: readonly Project[];
}

/** One entry of a `projects` array. */
interface Project {
  /** The `name` when it is a string literal; null otherwise. */
  readonly name: string | null;
  /**
   * What tells this entry apart for a reorder check: its literal name, the
   * code of a name that is not a literal, or the code of the whole entry.
   */
  readonly key: string;
  /** The entry's own `retries`, if it sets one. */
  readonly retries: Setting | undefined;
  /** False for an entry that is not an object literal: nothing is known. */
  readonly readable: boolean;
  readonly node: ts.Node;
}

/**
 * The array literals that hold Playwright projects: the value of a
 * `projects` property, or of a variable named `projects`.
 */
function projectArrays(
  sourceFile: ts.SourceFile,
): readonly ts.ArrayLiteralExpression[] {
  const out: ts.ArrayLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    const value =
      ts.isPropertyAssignment(node) && propertyName(node.name) === "projects"
        ? node.initializer
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "projects"
          ? node.initializer
          : undefined;
    const array = value === undefined ? undefined : unwrap(value);
    if (array !== undefined && ts.isArrayLiteralExpression(array)) {
      out.push(array);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** The value of the last property `name` written in `object`, if any. */
function ownProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === name
    ) {
      found = property.initializer;
    }
  }
  return found;
}

function projectOf(element: ts.Expression, source: ts.SourceFile): Project {
  const node = unwrap(element);
  if (!ts.isObjectLiteralExpression(node)) {
    return {
      name: null,
      key: normaliseCode(node, source),
      retries: undefined,
      readable: false,
      node,
    };
  }
  const nameValue = ownProperty(node, "name");
  const retries = ownProperty(node, "retries");
  const name = nameValue === undefined ? null : stringValue(nameValue);
  return {
    name,
    key:
      name ?? normaliseCode(nameValue === undefined ? node : nameValue, source),
    retries:
      retries === undefined ? undefined : { name: "retries", value: retries },
    readable: true,
    node,
  };
}

function retriesModel(source: ts.SourceFile): RetriesModel {
  const arrays = projectArrays(source);
  const projects = arrays.flatMap((array) =>
    array.elements.map((element) => projectOf(element, source)),
  );
  const owned = new Set(
    projects.flatMap((project) =>
      project.retries === undefined ? [] : [project.retries.value],
    ),
  );
  const top = collectSettings(source, new Set(["retries"])).filter(
    (setting) => !owned.has(setting.value),
  );
  return { source, top, projects };
}

/**
 * The top-level retries a project falls back to: Playwright's 0 when none
 * is set, null when one cannot be read. With several (two exported objects,
 * a helper) the base side takes the smallest and the head side the
 * largest, so a raise is never hidden by the choice.
 */
function topRetries(model: RetriesModel, side: "base" | "head"): number | null {
  const values = model.top.map((setting) => retriesValue(setting.value));
  if (values.length === 0) {
    return 0;
  }
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length !== values.length) {
    return null;
  }
  return side === "base" ? Math.min(...numbers) : Math.max(...numbers);
}

/**
 * The top-level settings, paired by position among themselves only: a
 * project's own `retries` never pairs with them. A setting new in head is
 * raised from Playwright's default of 0.
 */
function diffTopRetries(
  file: string,
  was: RetriesModel,
  now: RetriesModel,
): Finding[] {
  const out: Finding[] = [];
  now.top.forEach((setting, index) => {
    const previous = was.top[index];
    const found = compareRetries(file, was.source, now.source, {
      previous,
      current: setting,
      old: previous === undefined ? 0 : retriesValue(previous.value),
      label: "",
      at: setting.value,
    });
    if (found !== null) {
      out.push(found);
    }
  });
  return out;
}

interface RetriesPair {
  readonly previous: Setting | undefined;
  readonly current: Setting | undefined;
  readonly old: number | null;
  /** Appended to the message: ` for project "x"`, or empty. */
  readonly label: string;
  /** Where the finding points in the head version. */
  readonly at: ts.Node;
}

/** The finding for one pair of retries, or null when they did not rise. */
function compareRetries(
  file: string,
  before: ts.SourceFile,
  after: ts.SourceFile,
  pair: RetriesPair,
): Finding | null {
  const { previous, current } = pair;
  if (current === undefined) {
    return null;
  }
  if (
    previous !== undefined &&
    normaliseCode(previous.value, before) ===
      normaliseCode(current.value, after)
  ) {
    return null;
  }
  const value = retriesValue(current.value);
  const line = lineOf(pair.at, after);
  if (pair.old === null || value === null) {
    return finding({
      file,
      line,
      kind: "config-changed",
      message: `retries changed and is not a literal number${pair.label}`,
      ...(previous === undefined
        ? {}
        : { before: display(previous.value, before) }),
      after: display(current.value, after),
    });
  }
  return value > pair.old
    ? finding({
        file,
        line,
        kind: "retries-raised",
        message: `retries raised from ${String(pair.old)} to ${String(value)}${pair.label}`,
        before: String(pair.old),
        after: String(value),
      })
    : null;
}

/** Whether every project has a literal name, and no name is used twice. */
function namedUniquely(projects: readonly Project[]): boolean {
  const names = projects.map((project) => project.name);
  return (
    names.every((name) => name !== null) && new Set(names).size === names.length
  );
}

/**
 * The effective retries of one project before and after: its own when it
 * sets them, else the top-level ones. Only a project that sets its own on
 * either side is compared here; one that never does follows the top-level
 * setting, which `diffTopRetries` already compares.
 */
function diffProject(
  file: string,
  sides: { readonly was: RetriesModel; readonly now: RetriesModel },
  before: Project | undefined,
  after: Project,
  label: string,
): Finding | null {
  const { was, now } = sides;
  if (
    !after.readable ||
    before?.readable === false ||
    (before?.retries === undefined && after.retries === undefined)
  ) {
    return null;
  }
  const old =
    before?.retries === undefined
      ? topRetries(was, "base")
      : retriesValue(before.retries.value);
  // A project that drops its own retries falls back to the top-level ones,
  // or to Playwright's default of 0, which is never a raise.
  const effective =
    after.retries === undefined
      ? topRetries(now, "head")
      : retriesValue(after.retries.value);
  if (old === null || effective === null) {
    return after.retries === undefined
      ? null
      : compareRetries(file, was.source, now.source, {
          previous: before?.retries,
          current: after.retries,
          old,
          label,
          at: after.retries.value,
        });
  }
  if (effective <= old) {
    return null;
  }
  return finding({
    file,
    line: lineOf(after.retries?.value ?? after.node, now.source),
    kind: "retries-raised",
    message: `retries raised from ${String(old)} to ${String(effective)}${label}`,
    before: String(old),
    after: String(effective),
  });
}

/**
 * Projects paired by literal `name`, so that reordering them is not a
 * change and swapping their retries is. When a name is not a literal or is
 * used twice, the projects are paired by position instead, and a change in
 * their order is reported for review: by position, a swap cannot be told
 * from two unrelated edits.
 */
function diffProjectRetries(
  file: string,
  was: RetriesModel,
  now: RetriesModel,
): Finding[] {
  const sides = { was, now };
  const out: Finding[] = [];
  const push = (found: Finding | null): void => {
    if (found !== null) {
      out.push(found);
    }
  };
  if (namedUniquely(was.projects) && namedUniquely(now.projects)) {
    for (const project of now.projects) {
      const before = was.projects.find((p) => p.name === project.name);
      push(
        diffProject(
          file,
          sides,
          before,
          project,
          ` for project "${project.name ?? ""}"`,
        ),
      );
    }
    return out;
  }
  now.projects.forEach((project, index) => {
    push(
      diffProject(
        file,
        sides,
        was.projects[index],
        project,
        ` for project ${String(index + 1)}`,
      ),
    );
  });
  const order = (model: RetriesModel): readonly string[] =>
    model.projects.map((project) => project.key);
  const [b, a] = [order(was), order(now)];
  if (
    b.join("\u0000") !== a.join("\u0000") &&
    [...b].sort().join("\u0000") === [...a].sort().join("\u0000")
  ) {
    const first = now.projects[0];
    out.push(
      finding({
        file,
        line: first === undefined ? undefined : lineOf(first.node, now.source),
        kind: "config-changed",
        message:
          "projects reordered; their names are not all distinct literals, so retries were compared by position. Review which project has which retries",
      }),
    );
  }
  return out;
}

/**
 * Raised retries: the top-level setting, and each project's effective
 * retries (its own, else the top-level ones). The two are kept apart so
 * that moving the top-level setting past the `projects` array never pairs
 * it with a project's.
 */
function diffRetries(
  file: string,
  before: ts.SourceFile,
  after: ts.SourceFile,
): Finding[] {
  const was = retriesModel(before);
  const now = retriesModel(after);
  return [
    ...diffTopRetries(file, was, now),
    ...diffProjectRetries(file, was, now),
  ];
}

function diffSelection(
  file: string,
  before: ts.SourceFile,
  after: ts.SourceFile,
): Finding[] {
  const names = new Set<string>(SELECTION_KEYS);
  const was = collectSettings(before, names);
  const now = collectSettings(after, names);
  const out: Finding[] = [];
  for (const name of SELECTION_KEYS) {
    const b = was.filter((s) => s.name === name);
    const a = now.filter((s) => s.name === name);
    const bCode = b.map((s) => normaliseCode(s.value, before)).join("\n");
    const aCode = a.map((s) => normaliseCode(s.value, after)).join("\n");
    if (bCode === aCode) {
      continue;
    }
    const first = a[0];
    const bText = b.map((s) => display(s.value, before)).join("; ");
    const aText = a.map((s) => display(s.value, after)).join("; ");
    out.push(
      finding({
        file,
        line: first === undefined ? undefined : lineOf(first.value, after),
        kind: "config-changed",
        message: `${name} changed`,
        before: bText === "" ? undefined : bText,
        after: aText === "" ? undefined : aText,
      }),
    );
  }
  return out;
}

/**
 * Findings for one `playwright.config.*` file: raised retries (a flaky
 * test then passes on a later attempt) and changes to which tests run.
 * Never throws (see `analysed`).
 */
export function diffPlaywrightConfig(
  change: ConfigFileChange,
): readonly Finding[] {
  return analysed(change.file, () => comparePlaywrightConfig(change));
}

function comparePlaywrightConfig(change: ConfigFileChange): readonly Finding[] {
  const { file } = change;
  if (sameText(change)) {
    return [];
  }
  if (change.after === null) {
    return [
      finding({
        file,
        kind: "config-changed",
        message: "playwright config removed",
      }),
    ];
  }
  const before = parseSource(change.before ?? "", file);
  const after = parseSource(change.after, file);
  if (!after.ok) {
    return [unreadable(file, "head", `could not be parsed (${after.error})`)];
  }
  if (!before.ok) {
    return [unreadable(file, "base", `could not be parsed (${before.error})`)];
  }
  return sortFindings([
    ...diffRetries(file, before.sourceFile, after.sourceFile),
    ...diffSelection(file, before.sourceFile, after.sourceFile),
  ]);
}
