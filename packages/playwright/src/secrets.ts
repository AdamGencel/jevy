import { REDACTED } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";

/**
 * Autocomplete tokens that mark a field as secret. This is the same list as
 * core's private `SECRET_AUTOCOMPLETE` in redact.ts; a test checks that core
 * treats every one of them as secret. It is copied because core does not
 * export it.
 */
export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
];

/**
 * True when an `autocomplete` attribute holds a secret token. The attribute is
 * a space-separated list (`section-pay billing cc-number`), so each token is
 * checked, case-insensitively.
 */
export function isSecretAutocomplete(attribute: string): boolean {
  return attribute
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE_TOKENS.includes(token));
}

/**
 * The spellings a typed value can take in an aria snapshot: as typed, with
 * whitespace collapsed, and as Playwright 1.63 normalises text (zero-width
 * space and soft hyphen removed, trimmed, whitespace collapsed).
 */
export function secretForms(value: string): readonly string[] {
  const collapsed = value.trim().replace(/\s+/g, " ");
  const playwright = value
    .replace(/[\u200b\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const forms: string[] = [];
  for (const form of [value, collapsed, playwright]) {
    if (form !== "" && !forms.includes(form)) forms.push(form);
  }
  return forms;
}

type TextField =
  | "name"
  | "description"
  | "keyshortcuts"
  | "roledescription"
  | "valuetext"
  | "autocomplete"
  | "haspopup"
  | "invalid"
  | "orientation";

const TEXT_FIELDS: readonly TextField[] = [
  "name",
  "description",
  "keyshortcuts",
  "roledescription",
  "valuetext",
  "autocomplete",
  "haspopup",
  "invalid",
  "orientation",
];

/**
 * Copy a tree with every occurrence of every secret replaced by `[REDACTED]`
 * in every text field and in `value`. The role is left alone: it comes from
 * Playwright's fixed role list, not from the page.
 *
 * Matching is by substring, so a short secret also blanks unrelated text that
 * contains it. That is the safe direction to be wrong in. Longer secrets are
 * removed first, and a secret is never matched across or inside a marker that
 * was already inserted, so the result cannot contain any secret.
 */
export function scrubSecrets(
  tree: AccessibilityNode,
  values: readonly string[],
): AccessibilityNode {
  const forms = [...new Set(values.flatMap(secretForms))].sort(
    (left, right) => right.length - left.length,
  );
  if (forms.length === 0) return tree;
  return scrubNode(tree, forms);
}

function scrubNode(
  node: AccessibilityNode,
  forms: readonly string[],
): AccessibilityNode {
  const next: {
    -readonly [K in keyof AccessibilityNode]: AccessibilityNode[K];
  } = { ...node };
  for (const field of TEXT_FIELDS) {
    const text = node[field];
    if (text !== undefined) next[field] = scrubText(text, forms);
  }
  if (node.value !== undefined) {
    const text = String(node.value);
    const scrubbed = scrubText(text, forms);
    if (scrubbed !== text) next.value = scrubbed;
  }
  if (node.children !== undefined) {
    next.children = node.children.map((child) => scrubNode(child, forms));
  }
  return next;
}

/**
 * Split on each secret in turn and join the pieces with the marker. Every
 * boundary between pieces is a marker, so later secrets only ever see text
 * from the page, never the marker itself.
 */
function scrubText(text: string, forms: readonly string[]): string {
  let pieces = [text];
  for (const form of forms) {
    pieces = pieces.flatMap((piece) => piece.split(form));
  }
  return pieces.join(REDACTED);
}
