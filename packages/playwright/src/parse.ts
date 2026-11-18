import { SnapshotError } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";
import type { Node as YamlNode, Scalar } from "yaml";

/**
 * Roles whose inline text in an aria snapshot is the control's value, not its
 * content. Playwright renders `element.value` as the only child of every
 * `<input>` and `<textarea>` except checkbox, radio and file; these are the
 * roles such an element can have. A `<input type="button">` is a `button`,
 * whose value is its content, so it is not listed.
 */
export const VALUE_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);

/** Mutable working copy of a node. Frozen into `AccessibilityNode` on return. */
interface Draft {
  role: string;
  name?: string;
  value?: string;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
  level?: number;
  invalid?: string;
  children?: AccessibilityNode[];
}

interface ParsedKey {
  readonly node: Draft;
  /** `[aria-hidden]`: the node is hidden from assistive technology. */
  readonly hidden: boolean;
}

interface Context {
  readonly lines: LineCounter;
}

/**
 * Turn the YAML from Playwright's `ariaSnapshot()` into the tree core hashes.
 *
 * The root is `{ role: "document", children }`, unless the snapshot has
 * exactly one top-level node, which then becomes the root.
 *
 * Attributes in brackets map to the matching fields; `[active]` becomes
 * `focused`. Explicit `=false` values are omitted, because Playwright only
 * prints true states and core must hash both spellings the same. `[ref]`,
 * `[cursor]` and `[box]` are dropped: they change between runs and say
 * nothing about the page. A node marked `[aria-hidden]` (only `mode: "ai"`
 * prints it) is dropped with its subtree, as it is not in the accessibility
 * tree. `/url` and `/placeholder` are dropped because core's type has no
 * field for them.
 *
 * Inline text after the colon is the `value` for value-bearing roles (see
 * {@link VALUE_ROLES}) and a child text node otherwise. A `text:` entry is a
 * `{ role: "text", name }` node.
 *
 * Malformed input throws `SnapshotError` with the line number. Messages never
 * repeat snapshot text, because a snapshot can hold a typed secret.
 */
export function parseAriaSnapshot(yaml: string): AccessibilityNode {
  const lines = new LineCounter();
  const document = parseDocument(yaml, {
    schema: "failsafe",
    lineCounter: lines,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  const context: Context = { lines };
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) {
    fail(context, problem.pos[0], `YAML does not parse (${problem.code})`);
  }
  const contents = document.contents;
  if (contents === null) return { role: "document" };
  if (!isSeq(contents)) {
    fail(context, startOf(contents), "expected a list of nodes");
  }
  const children = parseItems(contents.items, context, true);
  const [first] = children;
  if (children.length === 1 && first !== undefined) return first;
  return children.length === 0
    ? { role: "document" }
    : { role: "document", children };
}

function parseItems(
  items: readonly unknown[],
  context: Context,
  topLevel: boolean,
): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  for (const item of items) {
    const node = parseItem(item, context, topLevel);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

/** One list entry: `- key`, `- key: text` or `- key:` with a nested list. */
function parseItem(
  item: unknown,
  context: Context,
  topLevel: boolean,
): AccessibilityNode | undefined {
  if (isScalar(item)) {
    const key = scalarText(item, context);
    if (key.startsWith("/")) {
      fail(context, startOf(item), "a property needs a value");
    }
    const parsed = parseKey(key, context, startOf(item));
    return parsed.hidden ? undefined : parsed.node;
  }
  if (!isMap(item)) fail(context, startOf(item), "expected a node");
  if (item.anchor !== undefined || item.tag !== undefined) {
    fail(context, startOf(item), "anchors and tags are not allowed");
  }
  if (item.items.length !== 1) {
    fail(context, startOf(item), "a node has exactly one key");
  }
  const pair = item.items[0];
  if (pair === undefined || !isScalar(pair.key)) {
    fail(context, startOf(item), "a node key must be plain text");
  }
  const keyNode = pair.key;
  const key = scalarText(keyNode, context);
  const at = startOf(keyNode);
  const value: unknown = pair.value;

  if (key.startsWith("/")) {
    if (topLevel) fail(context, at, "a property cannot be at the top level");
    if (value !== null && !isScalar(value)) {
      fail(context, at, "a property value must be text");
    }
    if (isScalar(value)) scalarText(value, context);
    return undefined;
  }

  if (key === "text") {
    if (value === null) return { role: "text" };
    if (!isScalar(value)) fail(context, at, "a text entry must be text");
    const text = scalarText(value, context);
    return text === "" ? { role: "text" } : { role: "text", name: text };
  }

  const parsed = parseKey(key, context, at);
  const node = parsed.node;
  if (value === null) {
    // `- key:` with nothing after it.
  } else if (isScalar(value)) {
    const text = scalarText(value, context);
    if (text !== "") {
      if (VALUE_ROLES.has(node.role)) node.value = text;
      else node.children = [{ role: "text", name: text }];
    }
  } else if (isSeq(value)) {
    if (value.anchor !== undefined || value.tag !== undefined) {
      fail(context, at, "anchors and tags are not allowed");
    }
    const children = parseItems(value.items, context, false);
    const [only] = children;
    if (
      VALUE_ROLES.has(node.role) &&
      children.length === 1 &&
      only?.role === "text" &&
      only.name !== undefined
    ) {
      // A textbox with a placeholder prints its value as `- text:` under
      // `- /placeholder:` instead of inline.
      node.value = only.name;
    } else if (children.length > 0) {
      node.children = children;
    }
  } else {
    fail(context, startOf(value), "a node value must be text or a list");
  }
  return parsed.hidden ? undefined : node;
}

const ROLE = /^[A-Za-z][A-Za-z0-9_-]*/;
const ATTRIBUTE = /^ \[([a-z-]+)(?:=([^\]\s]*))?\]/;

/**
 * Read `role "name" [attr] [attr=value]`. The name is a JSON string, or a
 * literal `/…/` when the name itself starts and ends with a slash, which
 * Playwright prints unquoted. Attributes never contain a slash, so the last
 * slash in the key ends such a name.
 */
function parseKey(key: string, context: Context, at: number): ParsedKey {
  const roleMatch = ROLE.exec(key);
  if (roleMatch === null) fail(context, at, "expected a role");
  const node: Draft = { role: roleMatch[0] };
  let rest = key.slice(roleMatch[0].length);

  if (rest.startsWith(' "')) {
    const end = endOfJsonString(rest, 1);
    if (end === -1) fail(context, at, "unterminated name");
    node.name = parseJsonString(rest.slice(1, end + 1), context, at);
    rest = rest.slice(end + 1);
  } else if (rest.startsWith(" /")) {
    const end = rest.lastIndexOf("/");
    if (end <= 1) fail(context, at, "unterminated name");
    node.name = rest.slice(1, end + 1);
    rest = rest.slice(end + 1);
  }

  const seen = new Set<string>();
  let hidden = false;
  while (rest !== "") {
    const match = ATTRIBUTE.exec(rest);
    if (match === null) fail(context, at, "expected an attribute");
    const attribute = match[1] ?? "";
    if (seen.has(attribute)) fail(context, at, "repeated attribute");
    seen.add(attribute);
    if (applyAttribute(node, attribute, match[2], context, at)) hidden = true;
    rest = rest.slice(match[0].length);
  }
  return { node, hidden };
}

/** Returns true for `[aria-hidden]`, which hides the node. */
function applyAttribute(
  node: Draft,
  attribute: string,
  raw: string | undefined,
  context: Context,
  at: number,
): boolean {
  switch (attribute) {
    case "checked":
    case "pressed": {
      const state = mixedState(raw, context, at);
      if (state !== false) node[attribute] = state;
      return false;
    }
    case "disabled":
    case "expanded":
    case "selected": {
      if (booleanState(raw, context, at)) node[attribute] = true;
      return false;
    }
    case "active": {
      if (booleanState(raw, context, at)) node.focused = true;
      return false;
    }
    case "aria-hidden":
      return booleanState(raw, context, at);
    case "level": {
      if (raw === undefined || !/^[1-9]\d{0,2}$/.test(raw)) {
        fail(context, at, "level must be a positive integer");
      }
      node.level = Number(raw);
      return false;
    }
    case "invalid": {
      const value = raw ?? "true";
      if (!["true", "false", "grammar", "spelling"].includes(value)) {
        fail(context, at, "invalid must be true, false, grammar or spelling");
      }
      if (value !== "false") node.invalid = value;
      return false;
    }
    case "ref":
    case "cursor":
    case "box":
      if (raw === undefined || raw === "") {
        fail(context, at, "attribute needs a value");
      }
      return false;
    default:
      fail(context, at, "unknown attribute");
  }
}

function booleanState(
  raw: string | undefined,
  context: Context,
  at: number,
): boolean {
  if (raw === undefined || raw === "true") return true;
  if (raw === "false") return false;
  return fail(context, at, "expected true or false");
}

function mixedState(
  raw: string | undefined,
  context: Context,
  at: number,
): boolean | "mixed" {
  if (raw === "mixed") return "mixed";
  return booleanState(raw, context, at);
}

/** Index of the closing quote of the JSON string that opens at `start`. */
function endOfJsonString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === '"') return index;
  }
  return -1;
}

function parseJsonString(text: string, context: Context, at: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(context, at, "name is not a valid quoted string");
  }
  if (typeof parsed !== "string") {
    return fail(context, at, "name is not a valid quoted string");
  }
  return parsed;
}

function scalarText(node: Scalar, context: Context): string {
  if (node.anchor !== undefined || node.tag !== undefined) {
    fail(context, startOf(node), "anchors and tags are not allowed");
  }
  const value: unknown = node.value;
  if (typeof value !== "string") {
    return fail(context, startOf(node), "expected text");
  }
  return value;
}

function startOf(node: unknown): number {
  if (isAlias(node) || isScalar(node) || isMap(node) || isSeq(node)) {
    const yamlNode: YamlNode = node;
    return yamlNode.range?.[0] ?? 0;
  }
  return 0;
}

function fail(context: Context, offset: number, reason: string): never {
  const { line } = context.lines.linePos(offset);
  throw new SnapshotError(`Aria snapshot line ${String(line)}: ${reason}.`);
}
