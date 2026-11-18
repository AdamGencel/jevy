import ts from "typescript";
import { finding, sortFindings } from "./findings.js";
import {
  lineOf,
  literalText,
  normaliseCode,
  parseSource,
  propertyName,
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
const WHOLE_KEYS = new Set(["redact", "normalise", "decider", "deciders"]);

const WHOLE_KEY_KINDS: Readonly<Record<string, FindingKind>> = {
  redact: "redaction-rules-changed",
  normalise: "normalise-rules-changed",
  decider: "decider-changed",
  deciders: "decider-changed",
};

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

/** The default-exported object, else the argument of the first `defineConfig`. */
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
  | { readonly ok: true; readonly entries: ReadonlyMap<string, Entry> }
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
  return { ok: true, entries };
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
  const wholeKind = WHOLE_KEY_KINDS[top];
  if (wholeKind !== undefined) {
    return finding({ ...shown, kind: wholeKind, message: `${top} changed` });
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
    after?.literal === '"warn"'
  ) {
    return finding({
      ...shown,
      kind: "needs-review-relaxed",
      message: `${path} relaxed from "fail" to "warn"`,
    });
  }
  const verb =
    before === undefined
      ? "added"
      : after === undefined
        ? "removed"
        : "changed";
  return finding({
    ...shown,
    kind: "config-changed",
    message: `${path} ${verb}`,
  });
}

function unreadable(file: string, side: string, reason: string): Finding {
  return finding({
    file,
    kind: "config-changed",
    message: `${side} version ${reason}`,
  });
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

/** Findings for one `jevy.config.*` file. */
export function diffJevyConfig(change: ConfigFileChange): readonly Finding[] {
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
  const out: Finding[] = [];
  const reported = new Set<string>();
  for (const path of paths.sort()) {
    const b = was.entries.get(path);
    const a = now.entries.get(path);
    if (b !== undefined && a !== undefined && sameValue(b, a)) {
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

function diffRetries(
  file: string,
  before: ts.SourceFile,
  after: ts.SourceFile,
): Finding[] {
  const was = collectSettings(before, new Set(["retries"]));
  const now = collectSettings(after, new Set(["retries"]));
  const out: Finding[] = [];
  now.forEach((setting, index) => {
    const previous = was[index];
    if (
      previous !== undefined &&
      normaliseCode(previous.value, before) ===
        normaliseCode(setting.value, after)
    ) {
      return;
    }
    // Playwright retries nothing unless told to.
    const old = previous === undefined ? 0 : retriesValue(previous.value);
    const current = retriesValue(setting.value);
    const line = lineOf(setting.value, after);
    if (old === null || current === null) {
      out.push(
        finding({
          file,
          line,
          kind: "config-changed",
          message: "retries changed and is not a literal number",
          ...(previous === undefined
            ? {}
            : { before: display(previous.value, before) }),
          after: display(setting.value, after),
        }),
      );
    } else if (current > old) {
      out.push(
        finding({
          file,
          line,
          kind: "retries-raised",
          message: `retries raised from ${String(old)} to ${String(current)}`,
          before: String(old),
          after: String(current),
        }),
      );
    }
  });
  return out;
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
 */
export function diffPlaywrightConfig(
  change: ConfigFileChange,
): readonly Finding[] {
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
