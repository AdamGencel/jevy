import type { AccessibilityNode } from "./snapshot.js";
import { validateSnapshot } from "./validate.js";

/**
 * Render a snapshot in the compact, indented form a model reads in a prompt:
 * the style of Playwright's aria snapshot, one node per line.
 *
 * ```
 * - form "Sign in":
 *   - textbox "PIN" [required]: "[REDACTED]"
 *   - button "Pay" [disabled]
 *   - link "Terms":
 *     - /url: "/terms"
 * ```
 *
 * It is a pure function of the tree it is given. It does not redact,
 * normalise or prune: the caller passes the prepared tree (`callDecider`
 * hands a decider one), and rendering a raw page would print its secrets.
 *
 * Only the fields core hashes are rendered, in a fixed order, so two trees
 * that hash the same render the same, whatever their key order. States
 * follow the canonical order (`checked`, `pressed`, `expanded`, `selected`,
 * `disabled`, `readonly`, `required`, `modal`, `level`, `valuemin`,
 * `valuemax`, `invalid`); a true state prints bare and any other value prints
 * after `=`. The value follows a colon. `url`, `description`, `valuetext` and
 * `roledescription` are child lines that start with `/`, before the children.
 *
 * Every string is quoted and escaped (`quoteForPrompt`), so text on the page
 * cannot fake a line or a nested node: a name holding a newline, a quote or a
 * leading `- ` stays inside its quotes. Line and paragraph separators, C1
 * controls, format characters and default-ignorable code points are escaped
 * too, because a model or a terminal may honour them where JSON does not
 * escape them, and a person reading the prompt would not see them. A
 * string value is quoted, so `"2"` and `2` stay distinct, as they are in the
 * hash. A role that is not a plain word is quoted as well.
 *
 * A malformed tree throws `SnapshotError`, as everywhere else in core.
 */
export function renderSnapshot(tree: AccessibilityNode): string {
  validateSnapshot(tree);
  const lines: string[] = [];
  renderNode(tree, 0, lines);
  return lines.join("\n");
}

function renderNode(
  node: AccessibilityNode,
  depth: number,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  const properties = propertyLines(node);
  const children = node.children ?? [];
  let head = `${indent}- ${renderRole(node.role)}`;
  if (hasText(node.name)) head += ` ${quoteForPrompt(node.name)}`;
  head += states(node).join("");
  if (node.value !== undefined) head += `: ${scalar(node.value)}`;
  else if (properties.length > 0 || children.length > 0) head += ":";
  lines.push(head);
  for (const property of properties) lines.push(`${indent}  - ${property}`);
  for (const child of children) renderNode(child, depth + 1, lines);
}

/** Text fields that are hashed but have no place on the node's own line. */
function propertyLines(node: AccessibilityNode): string[] {
  const lines: string[] = [];
  const add = (key: string, text: string | undefined): void => {
    if (hasText(text)) lines.push(`/${key}: ${quoteForPrompt(text)}`);
  };
  add("url", node.url);
  add("description", node.description);
  add("valuetext", node.valuetext);
  add("roledescription", node.roledescription);
  return lines;
}

function states(node: AccessibilityNode): string[] {
  const entries: [string, string | number | boolean | undefined][] = [
    ["checked", node.checked],
    ["pressed", node.pressed],
    ["expanded", node.expanded],
    ["selected", node.selected],
    ["disabled", node.disabled],
    ["readonly", node.readonly],
    ["required", node.required],
    ["modal", node.modal],
    ["level", node.level],
    ["valuemin", node.valuemin],
    ["valuemax", node.valuemax],
    ["invalid", node.invalid],
  ];
  const rendered: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (value === true) rendered.push(` [${key}]`);
    else if (value === "mixed") rendered.push(` [${key}=mixed]`);
    else rendered.push(` [${key}=${scalar(value)}]`);
  }
  return rendered;
}

/** A plain role word, as Playwright prints it; anything else is quoted. */
const PLAIN_ROLE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function renderRole(role: string): string {
  return PLAIN_ROLE.test(role) ? role : quoteForPrompt(role);
}

/**
 * A string is quoted. A number or a boolean prints as itself; `String` of
 * either cannot hold a line break, whatever a caller's types claim.
 */
function scalar(value: string | number | boolean): string {
  return typeof value === "string" ? quoteForPrompt(value) : String(value);
}

/**
 * Characters JSON leaves as they are but a reader may treat as a line break
 * or use to hide or reorder text: C1 controls (with DEL and NEL), line and
 * paragraph separators, and every format character (`Cf`: the soft hyphen,
 * zero-width and direction marks, bidirectional embeddings, overrides and
 * isolates, invisible operators, the byte-order mark, interlinear
 * annotation marks, tag characters) and every default-ignorable code point
 * (variation selectors, the combining grapheme joiner, Hangul fillers). A
 * renderer draws the last two groups as nothing, so text hidden in them
 * reaches a model but not the person reviewing the prompt. The `u` flag
 * matches by code point, so an astral tag character is one match, not two
 * halves of a surrogate pair.
 */
const UNSAFE_IN_QUOTES =
  /[\u007f-\u009f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Quote text for a prompt or a report: a JSON string literal with the
 * characters above escaped as well, as `\uXXXX` in the Basic Multilingual
 * Plane and `\u{X}` above it. The result is one line, every character a
 * reader cannot see is spelled out, and page text cannot end the quotes.
 *
 * It is the one quoting rule for everything a model is shown, so the
 * snapshot, the state's header lines and the questions cannot drift apart.
 */
export function quoteForPrompt(text: string): string {
  return JSON.stringify(text).replace(UNSAFE_IN_QUOTES, escapeCodePoint);
}

function escapeCodePoint(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  const hex = point.toString(16);
  return point > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
