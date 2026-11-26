import ts from "typescript";
import { parseSource, propertyName, stringValue, unwrap } from "./source.js";

/**
 * Reads a few settings out of `jevy.config.*` as source text.
 *
 * The guard and the hooks need the cache directory, the test globs, the
 * protected paths and the check commands. Loading the config would run the
 * repository's code, which the guard never does, so only values written as
 * literals are read. Everything else is reported in `unreadable` so that a
 * caller deciding what an agent may touch can refuse instead of assuming the
 * setting is absent.
 *
 * The real loader runs the file, so the text and the loader can disagree:
 * code after the object can change it, a second export can replace it, a
 * local `defineConfig` can rewrite it. A value is therefore read only from a
 * shape in which nothing else in the file can reach the object (see
 * `provenConfigObject`). Any other shape is `unreadable: ["*"]`. This is
 * stricter than the config diff, which looks for the object wherever it can
 * and reports the rest of the file as changed code.
 */

/** In the order @jevyjs/core's loader tries them. */
export const CONFIG_FILENAMES = [
  "jevy.config.ts",
  "jevy.config.mts",
  "jevy.config.js",
  "jevy.config.mjs",
] as const;

export interface ConfigSettings {
  /** `cache.dir`, when it is a string literal. */
  readonly cacheDir: string | null;
  /** `guard.tests`, when it is an array of string literals. */
  readonly guardTests: readonly string[] | null;
  /** `protect`, when it is an array of string literals. */
  readonly protect: readonly string[] | null;
  /** `checks`, when it is an array of string literals. */
  readonly checks: readonly string[] | null;
  /** `web3.policy`, when it is a string literal. */
  readonly web3Policy: string | null;
  /** `ci.mainBranch`, when it is a string literal. */
  readonly mainBranch: string | null;
  /**
   * Dotted paths of the keys above that are present but could not be read as
   * literals (a variable, a spread, a call). ["*"] when the file does not
   * parse, or its shape does not prove which object the loader receives and
   * that it arrives as written. A caller that must fail closed checks this.
   */
  readonly unreadable: readonly string[];
}

/** What is known when the file cannot be read at all. */
const LOST: ConfigSettings = {
  cacheDir: null,
  guardTests: null,
  protect: null,
  checks: null,
  web3Policy: null,
  mainBranch: null,
  unreadable: ["*"],
};

/** What looking a key up in an object literal can tell us. */
type Found =
  | { readonly kind: "absent" }
  /** Present, or possibly present, but not readable from the text. */
  | { readonly kind: "unknown" }
  | { readonly kind: "value"; readonly value: ts.Expression };

const ABSENT: Found = { kind: "absent" };
const UNKNOWN: Found = { kind: "unknown" };

/** Enough for `const a = b; const b = [...]`, and it ends a cycle. */
const MAX_HOPS = 8;

/** How a top-level `import` binds one local name. */
interface Imported {
  /** `import { x }` binds an export; `import x` and `import * as x` an object. */
  readonly kind: "export" | "object";
  /** The export's own name, for `kind: "export"`. */
  readonly name: string;
  /** Whether it comes from an installed package, not a file of the repository. */
  readonly fromPackage: boolean;
}

/** What one walk over the file learns about the names in it. */
interface Names {
  /**
   * How often each name is written, counting its declaration. A property
   * key (`{ dir: 1 }`) and a member name (`x.dir`) do not count: they name
   * no variable.
   */
  readonly written: ReadonlyMap<string, number>;
  /** Names bound by a declaration other than an import, at any depth. */
  readonly declared: ReadonlySet<string>;
  readonly imports: ReadonlyMap<string, Imported>;
  /**
   * `eval` or a dynamic `import()` appears. Either can reach a variable or
   * the exported object without writing its name.
   */
  readonly reachesUnnamed: boolean;
  /** Initialisers of the top-level `const`s. */
  readonly consts: ReadonlyMap<string, ts.Expression>;
}

function isPropertyKey(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyAccessExpression(parent)) &&
    parent.name === node
  );
}

/** Whether `node` is the name a declaration (not an import) binds. */
function isDeclaredName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  );
}

/**
 * A package name with an optional path inside it: `@jevyjs/core`, `vite`.
 * A relative path, a `#subpath`, an alias such as `@/x` and a URL are files
 * someone in the repository can rewrite, so they are not this.
 */
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w./-]+)?$/i;

function importsOf(sourceFile: ts.SourceFile): ReadonlyMap<string, Imported> {
  const out = new Map<string, Imported>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const fromPackage = PACKAGE.test(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      out.set(clause.name.text, {
        kind: "object",
        name: "default",
        fromPackage,
      });
    }
    const bindings = clause?.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      out.set(bindings.name.text, { kind: "object", name: "*", fromPackage });
      continue;
    }
    for (const element of bindings.elements) {
      out.set(element.name.text, {
        kind: "export",
        name: (element.propertyName ?? element.name).text,
        fromPackage,
      });
    }
  }
  return out;
}

/**
 * Initialisers of the top-level `const`s. `let` and `var` are left out on
 * purpose: they can be reassigned before the config object is built, so the
 * initialiser is not proof of the value. `using` is left out too.
 */
function constInitialisers(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    // `await using` sets the `const` bit as well as its own.
    const { flags } = statement.declarationList;
    if (
      (flags & ts.NodeFlags.Const) === 0 ||
      (flags & ts.NodeFlags.Using) !== 0
    ) {
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

function namesOf(sourceFile: ts.SourceFile): Names {
  const written = new Map<string, number>();
  const declared = new Set<string>();
  const dynamicImports: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (!isPropertyKey(node)) {
        written.set(node.text, (written.get(node.text) ?? 0) + 1);
        if (isDeclaredName(node)) {
          declared.add(node.text);
        }
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      dynamicImports.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    written,
    declared,
    imports: importsOf(sourceFile),
    reachesUnnamed: dynamicImports.length > 0 || written.has("eval"),
    consts: constInitialisers(sourceFile),
  };
}

/**
 * Follow an identifier through top-level `const`s to what it names, or null
 * when a `const` on the way may no longer hold what it was declared with.
 *
 * A `const` cannot be reassigned, but the object or array it holds can be
 * changed through it (`c.cache.dir = x`, `list.push(x)`, `tune(c)`). So a
 * `const` is followed only when its name is written exactly twice in the
 * file: where it is declared and where it is followed from. A third mention
 * anywhere, even a harmless one, makes it unknown: telling a read from a
 * write would mean understanding the code.
 */
function follow(expression: ts.Expression, names: Names): ts.Expression | null {
  let node = unwrap(expression);
  for (let hops = 0; hops < MAX_HOPS && ts.isIdentifier(node); hops += 1) {
    const target = names.consts.get(node.text);
    if (target === undefined) {
      return node;
    }
    if (names.written.get(node.text) !== 2) {
      return null;
    }
    node = unwrap(target);
  }
  return node;
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

/** What the top-level statements export as the default. */
interface DefaultExports {
  /**
   * The expression of each `export default`, top-level `module.exports =`
   * and `export { x as default }`.
   */
  readonly expressions: readonly ts.Expression[];
  /** How many of them are `module.exports =`. */
  readonly commonJs: number;
  /** A default export whose value is not an expression of this file. */
  readonly other: boolean;
}

function hasDefaultModifier(statement: ts.Statement): boolean {
  return (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    (statement.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    )
  );
}

/**
 * `x` of each `export { x as default }` in `statement`. Null stands for a
 * default that is not a name in this file: a re-export from another one.
 */
function namedDefaults(
  statement: ts.ExportDeclaration,
): readonly (ts.Identifier | null)[] {
  const clause = statement.exportClause;
  if (clause === undefined) {
    // `export * from` does not re-export a default.
    return [];
  }
  if (ts.isNamespaceExport(clause)) {
    return clause.name.text === "default" ? [null] : [];
  }
  return clause.elements
    .filter((element) => element.name.text === "default")
    .map((element) =>
      statement.moduleSpecifier === undefined &&
      element.propertyName !== undefined &&
      ts.isIdentifier(element.propertyName)
        ? element.propertyName
        : null,
    );
}

function defaultExportsOf(sourceFile: ts.SourceFile): DefaultExports {
  const expressions: ts.Expression[] = [];
  let commonJs = 0;
  let other = false;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      // `export = x` is TypeScript's CommonJS form; Node's loader strips
      // types and does not run it.
      other ||= statement.isExportEquals === true;
      expressions.push(statement.expression);
    } else if (ts.isExportDeclaration(statement)) {
      for (const name of namedDefaults(statement)) {
        other ||= name === null;
        if (name !== null) {
          expressions.push(name);
        }
      }
    } else if (hasDefaultModifier(statement)) {
      other = true;
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left)
    ) {
      expressions.push(statement.expression.right);
      commonJs += 1;
    }
  }
  return { expressions, commonJs, other };
}

/**
 * Whether `call` is `defineConfig(x)` with a `defineConfig` that can be
 * taken to return `x` unchanged: the one imported by that name from a
 * package, a member of an object imported from a package, or a global.
 * One declared in the file, or imported from a file of the repository, can
 * return anything, and an agent can rewrite the latter without touching the
 * config.
 */
function isTrustedDefineConfig(call: ts.CallExpression, names: Names): boolean {
  const [argument] = call.arguments;
  if (
    call.questionDotToken !== undefined ||
    call.arguments.length !== 1 ||
    argument === undefined ||
    ts.isSpreadElement(argument) ||
    names.declared.has("defineConfig")
  ) {
    return false;
  }
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const imported = names.imports.get("defineConfig");
    return (
      callee.text === "defineConfig" &&
      (imported === undefined ||
        (imported.kind === "export" &&
          imported.name === "defineConfig" &&
          imported.fromPackage))
    );
  }
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken !== undefined ||
    callee.name.text !== "defineConfig" ||
    !ts.isIdentifier(callee.expression) ||
    names.declared.has(callee.expression.text)
  ) {
    return false;
  }
  const imported = names.imports.get(callee.expression.text);
  return imported?.kind === "object" && imported.fromPackage;
}

/** The object literal `expression` is proven to evaluate to, or null. */
function provenObject(
  expression: ts.Expression,
  names: Names,
): ts.ObjectLiteralExpression | null {
  const node = follow(expression, names);
  if (node === null) {
    return null;
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node;
  }
  const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (
    argument === undefined ||
    !ts.isCallExpression(node) ||
    !isTrustedDefineConfig(node, names)
  ) {
    return null;
  }
  const inner = follow(argument, names);
  return inner !== null && ts.isObjectLiteralExpression(inner) ? inner : null;
}

function count(names: Names, name: string): number {
  return names.written.get(name) ?? 0;
}

/**
 * The object literal the loader will receive as the config, or null when
 * the text does not prove which object that is or that it arrives unchanged.
 *
 * Proven means all of:
 * - The file has exactly one default export: one `export default x`, one
 *   top-level `module.exports = x`, or one `export { x as default }`. With
 *   two the last wins or the file does not load; a re-export from another
 *   file cannot be read here.
 * - `module` and `exports` are written nowhere else, so nothing assigns a
 *   second export or a property of the first from inside a block.
 * - The exported expression is an object literal, a trusted
 *   `defineConfig(...)` of one (see `isTrustedDefineConfig`), or a top-level
 *   `const` holding either, followed as `follow` allows.
 * - Nothing declares `undefined`: `{ dir: undefined }` is read as absent.
 * - Neither `eval` nor a dynamic `import()` appears.
 *
 * An object written inline has no name, so no other code in the file can
 * reach it once those hold.
 */
function provenConfigObject(
  sourceFile: ts.SourceFile,
  names: Names,
): ts.ObjectLiteralExpression | null {
  const exported = defaultExportsOf(sourceFile);
  const [expression] = exported.expressions;
  if (
    expression === undefined ||
    exported.expressions.length !== 1 ||
    exported.other ||
    count(names, "module") !== exported.commonJs ||
    count(names, "exports") !== 0 ||
    names.reachesUnnamed ||
    names.declared.has("undefined") ||
    names.imports.has("undefined")
  ) {
    return null;
  }
  return provenObject(expression, names);
}

/** A property name as text; `["protect"]` counts, `[key]` is null. */
function keyName(name: ts.PropertyName): string | null {
  return ts.isComputedPropertyName(name)
    ? stringValue(name.expression)
    : propertyName(name);
}

function hasProtoKey(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) =>
      !ts.isSpreadAssignment(property) &&
      keyName(property.name) === "__proto__",
  );
}

/**
 * Look `name` up in one object literal, reading its properties in order as
 * JavaScript evaluates them: a later property replaces an earlier one.
 *
 * A spread (`...base`) or a computed key (`[key]: x`) could set any key, so
 * it turns whatever came before into "unknown". Only a key written out after
 * the last spread is certain, because it replaces whatever the spread held.
 * This is the fail-closed rule: `{ protect: [...], ...base }` is unknown,
 * `{ ...base, protect: [...] }` is read, and with any spread a key that is
 * not written after it is unknown, never absent.
 *
 * A `__proto__` key makes every key unknown: it sets the object's prototype,
 * and core's loader reads inherited keys like its own.
 */
function lookup(object: ts.ObjectLiteralExpression, name: string): Found {
  if (hasProtoKey(object)) {
    return UNKNOWN;
  }
  let found: Found = ABSENT;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      found = UNKNOWN;
      continue;
    }
    const key = keyName(property.name);
    if (key === null) {
      found = UNKNOWN;
    } else if (key === name) {
      // A method or accessor is present but has no value to read.
      found = ts.isPropertyAssignment(property)
        ? { kind: "value", value: property.initializer }
        : ts.isShorthandPropertyAssignment(property)
          ? { kind: "value", value: property.name }
          : UNKNOWN;
    }
  }
  return found;
}

function isUndefined(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/**
 * Walk `keys` down from the config object. A key set to `undefined` is
 * absent, as it is to core's loader. A parent that is present but is not an
 * object literal (a call, an import) makes the key under it unknown, and so
 * does a `const` on the way that `follow` cannot vouch for.
 */
function find(
  root: ts.ObjectLiteralExpression,
  keys: readonly string[],
  names: Names,
): Found {
  let object = root;
  for (const [index, key] of keys.entries()) {
    const found = lookup(object, key);
    if (found.kind !== "value") {
      return found;
    }
    const node = follow(found.value, names);
    if (node === null) {
      return UNKNOWN;
    }
    if (isUndefined(node)) {
      return ABSENT;
    }
    if (index === keys.length - 1) {
      return { kind: "value", value: node };
    }
    if (!ts.isObjectLiteralExpression(node)) {
      return UNKNOWN;
    }
    object = node;
  }
  return ABSENT;
}

/**
 * All the strings of an array literal, or null. One element that is not a
 * string literal makes the whole list unreadable: a partial `protect` list
 * would silently leave the rest unprotected.
 */
function stringList(node: ts.Expression): readonly string[] | null {
  if (!ts.isArrayLiteralExpression(node)) {
    return null;
  }
  const out: string[] = [];
  for (const element of node.elements) {
    const text = stringValue(element);
    if (text === null) {
      return null;
    }
    out.push(text);
  }
  return out;
}

function readSettings(text: string, path: string): ConfigSettings {
  const parsed = parseSource(text, path);
  if (!parsed.ok) {
    return LOST;
  }
  const names = namesOf(parsed.sourceFile);
  const root = provenConfigObject(parsed.sourceFile, names);
  if (root === null || hasProtoKey(root)) {
    return LOST;
  }
  const unreadable: string[] = [];
  const take = <T>(
    keys: readonly string[],
    convert: (node: ts.Expression) => T | null,
  ): T | null => {
    const found = find(root, keys, names);
    if (found.kind === "absent") {
      return null;
    }
    const value = found.kind === "value" ? convert(found.value) : null;
    if (value === null) {
      unreadable.push(keys.join("."));
    }
    return value;
  };
  // Property order here is the order of `unreadable`.
  return {
    cacheDir: take(["cache", "dir"], stringValue),
    guardTests: take(["guard", "tests"], stringList),
    protect: take(["protect"], stringList),
    checks: take(["checks"], stringList),
    web3Policy: take(["web3", "policy"], stringValue),
    mainBranch: take(["ci", "mainBranch"], stringValue),
    unreadable,
  };
}

/**
 * The settings of the config whose source is `text`; `path` only picks the
 * parser (TypeScript or JavaScript) by its extension.
 *
 * The config object is the file's one default export, in a shape that
 * proves the loader receives it as written (see `provenConfigObject`): an
 * object literal, `defineConfig(...)` of one, or a top-level `const` holding
 * either. `as const`, `satisfies` and parentheses are transparent, and a
 * value may be a top-level `const` that nothing else in the file mentions.
 * Array elements are not followed.
 *
 * Absent is not unreadable: a key that is not written is null and is not
 * listed. A key that is written but is not a literal, or that a spread or
 * computed key may have set (see `lookup`), is null and is listed.
 *
 * Never throws: a file that does not parse, whose config object is not
 * proven, or that makes the parser fail answers `unreadable: ["*"]`.
 */
export function readConfigSettings(text: string, path: string): ConfigSettings {
  try {
    return readSettings(text, path);
  } catch {
    // The TypeScript parser recurses and can overflow its stack on hostile
    // input. Not knowing is the answer then, never an exception.
    return LOST;
  }
}

function trimDir(dir: string): string {
  return dir.replace(/^(\.\/+)+/, "").replace(/\/+$/, "");
}

/**
 * The first config file that exists in `dir`, via `read` (null = absent).
 * `dir` is "" for the root. Names are tried one at a time in loader order,
 * so the file found is the one core would load.
 */
export async function findConfig(
  read: (path: string) => Promise<string | null>,
  dir: string,
): Promise<{ readonly path: string; readonly text: string } | null> {
  const base = trimDir(dir);
  for (const name of CONFIG_FILENAMES) {
    const path = base === "" || base === "." ? name : `${base}/${name}`;
    const text = await read(path);
    if (text !== null) {
      return { path, text };
    }
  }
  return null;
}
