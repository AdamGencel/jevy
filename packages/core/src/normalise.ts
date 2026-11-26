import { collapseWhitespace } from "./guards.js";
import { validateSnapshot } from "./validate.js";
import {
  resolveNormalise,
  type AccessibilityNode,
  type NormaliseBuiltin,
  type NormaliseOptions,
  type NormaliseOverrides,
} from "./snapshot.js";

const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/** A date with a time component. A bare calendar date is left alone. */
const TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

const RELATIVE_TIME =
  /\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi;

/** Long digit runs: counters, database ids. Short numbers stay meaningful. */
const LONG_DIGITS = /\b\d{8,}\b/g;

const BUILTIN_PATTERNS: readonly {
  readonly id: NormaliseBuiltin;
  readonly pattern: RegExp;
  readonly placeholder: string;
}[] = [
  { id: "timestamp", pattern: TIMESTAMP, placeholder: "[time]" },
  { id: "relative-time", pattern: RELATIVE_TIME, placeholder: "[time]" },
  { id: "uuid", pattern: UUID, placeholder: "[id]" },
  { id: "long-digits", pattern: LONG_DIGITS, placeholder: "[num]" },
];

/**
 * Rebuild a snapshot so cosmetic differences share one shape.
 *
 * Structural rules: drop `focused`; unwrap `none`, `presentation`, and (by
 * default) unnamed `generic` nodes, promoting their children; omit empty
 * children. Text rules: collapse whitespace, then replace volatile spans.
 * A link's `url` is reduced to scheme, host and path (`reduceUrl`) before
 * and after the text rules, and dropped when nothing is left. Fields that
 * are not part of the hash allow-list are dropped, so the tree that is
 * hashed and the tree that would be sent stay the same.
 * A malformed, cyclic or too-deep snapshot throws `SnapshotError`.
 */
export function normaliseSnapshot(
  snapshot: AccessibilityNode,
  overrides?: NormaliseOverrides,
): AccessibilityNode {
  validateSnapshot(snapshot);
  const options = resolveNormalise(overrides);
  const nodes = flatten(snapshot, options, true);
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only !== undefined) return only;
  }
  return { role: "document", children: nodes };
}

/**
 * Schemes whose URLs have a host and a path: the WHATWG "special" schemes.
 * Every other scheme is reduced to `scheme:` alone.
 */
const HIERARCHICAL_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
]);

/**
 * Reduce a link's URL to scheme, host and path.
 *
 * The query string and the fragment are dropped: that is where session
 * tokens, signed links and reset codes live, and where volatile ids (a cache
 * buster, a tracking id) would give the same page a new hash on every run.
 * For the same reason each path segment loses a matrix parameter (`;` up to
 * the next `/`) and the value of a `name=value` segment (`/key=abc` becomes
 * `/key=`). Credentials in the authority (`user:pass@`) are dropped. The
 * scheme and the host are lowercased; the path keeps its case.
 *
 * Only `http`, `https`, `ws`, `wss`, `ftp` and `file` keep a host and a path.
 * Every other scheme (`javascript:`, `data:`, `mailto:`, `blob:` and the
 * rest) is reduced to the scheme alone, with or without `//` after it: what
 * follows is content, not an address, and can carry page text or a secret.
 *
 * The URL is read the way a browser reads it, so that what is dropped is
 * what a browser would treat as credentials, query or fragment. Leading
 * spaces and control characters are ignored. Tabs and newlines are ignored
 * in the scheme and the authority. For the six schemes above, and for a
 * relative URL (whose page is assumed to be one of them), `\` counts as
 * `/`, and any run of slashes after the scheme, including none, starts the
 * authority, which ends at the next `/`, `\`, `?` or `#`. The scheme is read
 * ignoring case, whitespace and control characters, so `Java\tScript:` and
 * `ht tps:` count; a browser would not accept the second, and reading it
 * as a scheme drops more.
 *
 * A URL that a browser could not read safely is reduced to its scheme: an
 * empty host, a port that is not a number (`https://user:pa/ss@host` reads
 * `pa` as the port), or an `@` after a `?` or `#` in the authority
 * (`https://user:pa?ss@host`), where the text could be a password or a
 * query and keeping any of it could keep a secret.
 *
 * Nothing here decodes, resolves or validates the URL further, so the
 * result is idempotent and does not depend on a URL parser's version. A
 * trailing slash, an explicit default port (`:443`) and the case of a
 * percent-escape are kept as written, so they give a different hash.
 */
export function reduceUrl(input: string): string {
  const text = trimIgnored(input.normalize("NFKC"));
  const scheme = schemeOf(text);
  if (scheme === undefined) return reduceRelative(text);
  if (!HIERARCHICAL_SCHEMES.has(scheme)) return `${scheme}:`;
  const rest = text.slice(text.indexOf(":") + 1);
  if (scheme === "file") return `file:${reduceFileRest(rest)}`;
  const authority = reduceAuthority(rest);
  return authority === undefined ? `${scheme}:` : `${scheme}:${authority}`;
}

/** A URL scheme as RFC 3986 spells it, up to and including its colon. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * The scheme in lower case, or undefined for a relative URL. Spaces and
 * control characters are removed before the scheme is read.
 */
function schemeOf(text: string): string | undefined {
  const match = SCHEME.exec(withoutIgnored(text));
  return match?.[1]?.toLowerCase();
}

/** True for a space or a C0 control character. */
function isIgnored(character: string): boolean {
  return character.charCodeAt(0) <= 0x20;
}

function withoutIgnored(text: string): string {
  return Array.from(text)
    .filter((character) => !isIgnored(character))
    .join("");
}

/** A browser drops leading and trailing spaces and C0 controls. */
function trimIgnored(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isIgnored(text.charAt(start))) start += 1;
  while (end > start && isIgnored(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** A browser removes tabs and newlines anywhere in a URL. */
function withoutTabsAndNewlines(text: string): string {
  return text.replace(/[\t\n\r]/g, "");
}

function isSlash(character: string): boolean {
  return character === "/" || character === "\\";
}

/**
 * Where the run of slashes at `start` ends, and how many slashes it holds.
 * Tabs and newlines inside the run are skipped, as a browser skips them.
 */
function slashRun(
  text: string,
  start: number,
): { readonly end: number; readonly count: number } {
  let end = start;
  let count = 0;
  while (end < text.length) {
    const character = text.charAt(end);
    if (isSlash(character)) count += 1;
    else if (!/[\t\n\r]/.test(character)) break;
    end += 1;
  }
  return { end, count };
}

/** Index of the next `/` or `\` at or after `start`, or the text's length. */
function nextSlash(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (isSlash(text.charAt(index))) return index;
  }
  return text.length;
}

/**
 * A relative URL. Two or more leading slashes make it protocol-relative,
 * with an authority; otherwise it is a path and stays relative.
 */
function reduceRelative(text: string): string {
  if (slashRun(text, 0).count >= 2) return reduceAuthority(text) ?? "";
  return reducePath(text);
}

/**
 * `//host/path` from text that starts with the slashes (any number) before
 * an authority, or undefined when the authority cannot be read safely.
 *
 * The authority runs to the next `/` or `\`. Everything up to its last `@`
 * is credentials and is dropped. If that `@` comes after a `?` or `#`, a
 * browser would read the `@` as part of a query or fragment, but a person
 * may have meant it to end a password holding `?` or `#`; neither reading
 * is safe to keep, so the URL is not reduced to a host at all.
 */
function reduceAuthority(text: string): string | undefined {
  const start = slashRun(text, 0).end;
  const end = nextSlash(text, start);
  const authority = withoutTabsAndNewlines(text.slice(start, end));
  const query = authority.search(/[?#]/);
  const at = authority.lastIndexOf("@");
  if (at !== -1 && query !== -1 && at > query) return undefined;
  const afterCredentials = authority.slice(at + 1);
  const host = collapseWhitespace(
    query === -1 ? afterCredentials : afterCredentials.slice(0, query - at - 1),
  );
  if (!isReadableHost(host)) return undefined;
  const path = query === -1 ? reducePath(text.slice(end)) : "";
  return `//${lowercaseHost(host)}${path}`;
}

/**
 * A non-empty host whose port, if any, is digits. A host in `[…]` is an IPv6
 * address (or a placeholder such as `[REDACTED]`), and its colons are not a
 * port. An unclosed `[` holds no port either, and is kept as text.
 */
function isReadableHost(host: string): boolean {
  if (host.length === 0) return false;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 || /^(?::\d*)?$/.test(host.slice(close + 1));
  }
  const colon = host.indexOf(":");
  return colon === -1 || (colon > 0 && /^\d*$/.test(host.slice(colon + 1)));
}

/**
 * Lowercase the host outside square brackets, so a placeholder such as
 * `[REDACTED]` keeps its spelling and a second pass changes nothing.
 */
function lowercaseHost(host: string): string {
  return host.replace(/\[[^\]]*\]|[^[]+/g, (part) =>
    part.startsWith("[") ? part : part.toLowerCase(),
  );
}

/**
 * What follows `file:`. Two or more slashes introduce a host, which may be
 * empty (`file:///srv`); fewer start the path, as a browser reads them. A
 * file host cannot hold credentials, so an `@` in it means the URL is not
 * one a browser would open, and only the scheme is kept.
 */
function reduceFileRest(rest: string): string {
  const run = slashRun(rest, 0);
  if (run.count < 2) return `//${reducePath(`/${rest.slice(run.end)}`)}`;
  let start = 0;
  for (let seen = 0; seen < 2; start += 1) {
    if (isSlash(rest.charAt(start))) seen += 1;
  }
  const end = nextSlash(rest, start);
  const authority = withoutTabsAndNewlines(rest.slice(start, end));
  const query = authority.search(/[?#]/);
  const host = collapseWhitespace(
    query === -1 ? authority : authority.slice(0, query),
  );
  if (host.includes("@")) return "";
  const path = query === -1 ? reducePath(rest.slice(end)) : "";
  return `//${lowercaseHost(host)}${path}`;
}

/**
 * A path, relative or after an authority: cut at the first `?` or `#`,
 * with `\` read as `/`, each segment cut at `;` and after its first `=`,
 * and whitespace collapsed. Tabs and newlines become spaces here rather than
 * vanishing as a browser would make them, so the words they separate stay
 * words for the seed-phrase check.
 */
function reducePath(text: string): string {
  const end = text.search(/[?#]/);
  const path = (end === -1 ? text : text.slice(0, end)).replace(/\\/g, "/");
  return collapseWhitespace(path.split("/").map(reduceSegment).join("/"));
}

function reduceSegment(segment: string): string {
  const semicolon = segment.indexOf(";");
  const bare = semicolon === -1 ? segment : segment.slice(0, semicolon);
  const equals = bare.indexOf("=");
  return equals === -1 ? bare : bare.slice(0, equals + 1);
}

export function normaliseText(
  input: string,
  overrides?: NormaliseOverrides,
): string {
  return applyTextRules(collapseWhitespace(input), resolveNormalise(overrides));
}

/**
 * Every placeholder normalisation can write under `options`, with what
 * writes it: a built-in id, or the index into `options.replace`. Normalised
 * text is checked for secrets again, so config loading uses this to reject a
 * redact rule that would match one.
 */
export function normalisePlaceholders(options: NormaliseOptions): readonly {
  readonly placeholder: string;
  readonly source: NormaliseBuiltin | number;
}[] {
  const disabled = new Set(options.disable);
  return [
    ...BUILTIN_PATTERNS.filter((builtin) => !disabled.has(builtin.id)).map(
      (builtin) => ({ placeholder: builtin.placeholder, source: builtin.id }),
    ),
    ...options.replace.map((rule, index) => ({
      placeholder: rule.placeholder,
      source: index,
    })),
  ];
}

/**
 * JSON value used as the hash input. Key order is fixed. Empty children are
 * omitted, so `children: []` and a missing `children` hash the same.
 */
export function canonicalSnapshot(snapshot: AccessibilityNode): unknown {
  const value: Record<string, unknown> = { role: snapshot.role };
  assignString(value, "name", snapshot.name);
  assignString(value, "url", snapshot.url);
  assignString(value, "description", snapshot.description);
  if (snapshot.value !== undefined) value["value"] = snapshot.value;
  assignString(value, "valuetext", snapshot.valuetext);
  assignString(value, "roledescription", snapshot.roledescription);
  assignChecked(value, "checked", snapshot.checked);
  assignChecked(value, "pressed", snapshot.pressed);
  assignBoolean(value, "expanded", snapshot.expanded);
  assignBoolean(value, "selected", snapshot.selected);
  assignBoolean(value, "disabled", snapshot.disabled);
  assignBoolean(value, "readonly", snapshot.readonly);
  assignBoolean(value, "required", snapshot.required);
  assignBoolean(value, "modal", snapshot.modal);
  assignNumber(value, "level", snapshot.level);
  assignNumber(value, "valuemin", snapshot.valuemin);
  assignNumber(value, "valuemax", snapshot.valuemax);
  assignString(value, "invalid", snapshot.invalid);
  if (snapshot.children !== undefined && snapshot.children.length > 0) {
    value["children"] = snapshot.children.map((child) =>
      canonicalSnapshot(child),
    );
  }
  return value;
}

export function canonicalSnapshotJson(snapshot: AccessibilityNode): string {
  return JSON.stringify(canonicalSnapshot(snapshot));
}

/** Assumes `node` has passed `validateSnapshot`. */
function flatten(
  node: AccessibilityNode,
  options: NormaliseOptions,
  isRoot: boolean,
): AccessibilityNode[] {
  const children = (node.children ?? []).flatMap((child) =>
    flatten(child, options, false),
  );
  if (!isRoot && shouldUnwrap(node, options)) return children;
  return [buildNode(node, children, options)];
}

function shouldUnwrap(
  node: AccessibilityNode,
  options: NormaliseOptions,
): boolean {
  if (options.dropRoles.includes(node.role)) return true;
  if (!options.unwrapUnnamedGeneric || node.role !== "generic") return false;
  return !hasSemanticPayload(node);
}

function hasSemanticPayload(node: AccessibilityNode): boolean {
  return (
    hasText(node.name) ||
    hasText(node.url) ||
    hasText(node.description) ||
    hasText(node.valuetext) ||
    hasText(node.roledescription) ||
    node.value !== undefined ||
    node.checked !== undefined ||
    node.pressed !== undefined ||
    node.expanded !== undefined ||
    node.selected !== undefined ||
    node.disabled !== undefined ||
    node.readonly !== undefined ||
    node.required !== undefined ||
    node.modal !== undefined ||
    node.level !== undefined ||
    node.invalid !== undefined
  );
}

function buildNode(
  node: AccessibilityNode,
  children: readonly AccessibilityNode[],
  options: NormaliseOptions,
): AccessibilityNode {
  const built: {
    role: string;
    name?: string;
    url?: string;
    description?: string;
    value?: string | number;
    valuetext?: string;
    roledescription?: string;
    checked?: boolean | "mixed";
    pressed?: boolean | "mixed";
    expanded?: boolean;
    selected?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    modal?: boolean;
    level?: number;
    valuemin?: number;
    valuemax?: number;
    invalid?: string;
    children?: AccessibilityNode[];
  } = { role: node.role };

  const name = optionalText(node.name, options);
  const description = optionalText(node.description, options);
  const valuetext = optionalText(node.valuetext, options);
  const roledescription = optionalText(node.roledescription, options);
  if (name !== undefined) built.name = name;
  const url = optionalUrl(node.url, options);
  if (url !== undefined) built.url = url;
  if (description !== undefined) built.description = description;
  if (node.value !== undefined) {
    built.value =
      typeof node.value === "string"
        ? applyTextRules(node.value, options)
        : node.value;
  }
  if (valuetext !== undefined) built.valuetext = valuetext;
  if (roledescription !== undefined) built.roledescription = roledescription;
  if (node.checked !== undefined) built.checked = node.checked;
  if (node.pressed !== undefined) built.pressed = node.pressed;
  if (node.expanded !== undefined) built.expanded = node.expanded;
  if (node.selected !== undefined) built.selected = node.selected;
  if (node.disabled !== undefined) built.disabled = node.disabled;
  if (node.readonly !== undefined) built.readonly = node.readonly;
  if (node.required !== undefined) built.required = node.required;
  if (node.modal !== undefined) built.modal = node.modal;
  if (node.level !== undefined) built.level = node.level;
  if (node.valuemin !== undefined) built.valuemin = node.valuemin;
  if (node.valuemax !== undefined) built.valuemax = node.valuemax;
  if (node.invalid !== undefined) built.invalid = node.invalid;
  if (children.length > 0) built.children = [...children];
  return built;
}

function optionalText(
  value: string | undefined,
  options: NormaliseOptions,
): string | undefined {
  if (value === undefined) return undefined;
  const text = applyTextRules(value, options);
  return text.length === 0 ? undefined : text;
}

/**
 * The text rules run on the reduced URL, so a volatile id in the path
 * becomes a placeholder. The URL is reduced again afterwards, so a project
 * placeholder cannot bring a query string or a script scheme back.
 */
function optionalUrl(
  value: string | undefined,
  options: NormaliseOptions,
): string | undefined {
  if (value === undefined) return undefined;
  const url = reduceUrl(applyTextRules(reduceUrl(value), options));
  return url.length === 0 ? undefined : url;
}

function applyTextRules(input: string, options: NormaliseOptions): string {
  let text = collapseWhitespace(input);
  const disabled = new Set(options.disable);
  for (const builtin of BUILTIN_PATTERNS) {
    if (disabled.has(builtin.id)) continue;
    text = replaceGlobal(text, builtin.pattern, builtin.placeholder);
  }
  for (const rule of options.replace) {
    text = replaceGlobal(text, rule.pattern, rule.placeholder);
  }
  return collapseWhitespace(text);
}

function replaceGlobal(
  input: string,
  pattern: RegExp,
  replacement: string,
): string {
  const flags = `${pattern.flags.replace(/[gyd]/g, "")}g`;
  return input.replace(new RegExp(pattern.source, flags), replacement);
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function assignString(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) target[key] = value;
}

function assignBoolean(
  target: Record<string, unknown>,
  key: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function assignChecked(
  target: Record<string, unknown>,
  key: string,
  value: boolean | "mixed" | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function assignNumber(
  target: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
