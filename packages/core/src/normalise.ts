import { SnapshotError } from "./errors.js";
import { collapseWhitespace } from "./guards.js";
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
 * Fields that are not part of the hash allow-list are dropped, so the tree
 * that is hashed and the tree that would be sent stay the same.
 */
export function normaliseSnapshot(
  snapshot: AccessibilityNode,
  overrides?: NormaliseOverrides,
): AccessibilityNode {
  const options = resolveNormalise(overrides);
  const seen = new WeakSet();
  const nodes = flatten(snapshot, options, seen, true);
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only !== undefined) return only;
  }
  return { role: "document", children: nodes };
}

export function normaliseText(
  input: string,
  overrides?: NormaliseOverrides,
): string {
  return applyTextRules(collapseWhitespace(input), resolveNormalise(overrides));
}

/**
 * JSON value used as the hash input. Key order is fixed. Empty children are
 * omitted, so `children: []` and a missing `children` hash the same.
 */
export function canonicalSnapshot(snapshot: AccessibilityNode): unknown {
  const value: Record<string, unknown> = { role: snapshot.role };
  assignString(value, "name", snapshot.name);
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

function flatten(
  node: AccessibilityNode,
  options: NormaliseOptions,
  seen: WeakSet<object>,
  isRoot: boolean,
): AccessibilityNode[] {
  assertNode(node, seen);
  const children = (node.children ?? []).flatMap((child) =>
    flatten(child, options, seen, false),
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

function assertNode(node: AccessibilityNode, seen: WeakSet<object>): void {
  if (typeof node !== "object") {
    throw new SnapshotError("Accessibility snapshot node must be an object");
  }
  if (seen.has(node)) {
    throw new SnapshotError("Accessibility snapshot contains a cycle");
  }
  seen.add(node);
  if (typeof node.role !== "string" || node.role.trim().length === 0) {
    throw new SnapshotError("Accessibility snapshot node is missing a role");
  }
  if (node.value !== undefined && !isValue(node.value)) {
    throw new SnapshotError(
      "Accessibility snapshot value must be a string or a finite number",
    );
  }
  if (node.children !== undefined && !Array.isArray(node.children)) {
    throw new SnapshotError("Accessibility snapshot children must be an array");
  }
}

function isValue(value: string | number): boolean {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
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
