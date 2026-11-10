import { BIP39_ENGLISH_WORDS } from "./bip39-english.js";
import { RedactionError } from "./errors.js";
import { collapseWhitespace, isRecord } from "./guards.js";
import type { AccessibilityNode } from "./snapshot.js";
import type { WalletContext } from "./decider.js";

/** Stable replacement. Two different secrets in the same place hash the same. */
export const REDACTED = "[REDACTED]";

const BIP39 = new Set(BIP39_ENGLISH_WORDS);

const SECRET_FIELD_NAME =
  /password|passcode|passphrase|secret|api[-_ ]?key|mnemonic|seed[-_ ]?phrase|recovery[-_ ]?(?:phrase|words?)|private[-_ ]?key/i;

const SECRET_FIELD_ROLES = new Set(["textbox", "searchbox"]);

const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
]);

/**
 * Wallet field names are split into words (`privateKey` → private, key).
 * A field is secret when one word, or two adjacent words, name a secret.
 * Plain `token`, `key` or `publicKey` are not secret: on an approve prompt the
 * token address is the thing under test. Their values still pass through the
 * text patterns, so a raw key in any field is caught there.
 */
const WALLET_SECRET_WORDS = new Set([
  "secret",
  "seed",
  "mnemonic",
  "password",
  "passphrase",
  "passcode",
  "privkey",
  "apikey",
]);

const WALLET_SECRET_PAIRS = new Set([
  "private key",
  "api key",
  "access token",
  "auth token",
  "refresh token",
  "session token",
  "bearer token",
  "recovery phrase",
]);

/** Separators allowed between seed words: whitespace, list numbers, punctuation. */
const SEED_SEPARATOR = /^[\s\d.,;:()#|/-]{1,16}$/;

/** The shortest BIP-39 phrase. Longer runs are redacted whole. */
const MIN_SEED_WORDS = 12;

interface TextPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Built-in patterns. They always run; a project can add rules, not remove
 * these. 64 hex characters, with or without `0x`, are redacted as a private
 * key. A 40-hex address is not: addresses are public and are often the thing
 * under test. The tradeoff is that a transaction hash (or any SHA-256 hex
 * digest) has the same shape as a secret key and is redacted too. See
 * DESIGN.md.
 */
const TEXT_PATTERNS: readonly TextPattern[] = [
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "github-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: "stripe-key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b/g,
  },
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { name: "hex-private-key", pattern: /\b(?:0x)?[a-fA-F0-9]{64}\b/g },
  {
    name: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  {
    name: "assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/g,
  },
  { name: "phone-e164", pattern: /\+\d{1,3}(?:[\s.-]?\d){7,14}\b/g },
  {
    name: "phone-nanp",
    pattern: /\b(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
  },
];

/**
 * A redaction rule from `jevy.config.ts`.
 * A bare regular expression replaces each match with `[REDACTED]`.
 * `{ pattern }` does the same, with an optional replacement.
 * `{ role, name }` clears the value of a matching control. The accessible
 * name stays, so the hash still records that the control exists.
 */
export type RedactRule =
  | RegExp
  | {
      readonly pattern: RegExp;
      readonly replacement?: string;
    }
  | {
      readonly role: string;
      readonly name?: string | RegExp;
      readonly replacement?: string;
    };

export function redactText(
  input: string,
  rules: readonly RedactRule[] = [],
): string {
  const output = replaceSecrets(collapseWhitespace(input), rules);
  assertStable(output, rules);
  return output;
}

/**
 * Copy a snapshot with secrets and direct personal data removed.
 * Structural fields (role, checked, disabled, …) are kept.
 */
export function redactSnapshot(
  snapshot: AccessibilityNode,
  rules: readonly RedactRule[] = [],
): AccessibilityNode {
  const seen = new WeakSet();
  return redactSplitSeedPhrases(redactNode(snapshot, rules, seen));
}

type SeedField = "name" | "description" | "value" | "valuetext";

const SEED_FIELDS: readonly SeedField[] = [
  "name",
  "description",
  "value",
  "valuetext",
];

interface FieldEntry {
  readonly node: AccessibilityNode;
  readonly field: SeedField;
  readonly text: string;
  readonly start: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * True when a seed phrase is spread over several nodes, for example a wallet
 * that shows one word per cell. Text fields are read in document order.
 */
export function containsSplitSeedPhrase(snapshot: AccessibilityNode): boolean {
  return findSeedSpans(treeText(snapshot).text).length > 0;
}

/**
 * Redact a seed phrase whose words sit in separate nodes. Each word is
 * replaced in its own node; list numbers between the words are kept.
 */
function redactSplitSeedPhrases(
  snapshot: AccessibilityNode,
): AccessibilityNode {
  const { text, entries } = treeText(snapshot);
  const spans = findSeedSpans(text);
  if (spans.length === 0) return snapshot;

  const edits = new Map<
    AccessibilityNode,
    Partial<Record<SeedField, string>>
  >();
  for (const entry of entries) {
    const ranges = wordRangesInSpans(entry, spans);
    if (ranges.length === 0) continue;
    let redacted = entry.text;
    for (const range of [...ranges].reverse()) {
      redacted =
        redacted.slice(0, range.start) + REDACTED + redacted.slice(range.end);
    }
    const edit = edits.get(entry.node) ?? {};
    edit[entry.field] = redacted;
    edits.set(entry.node, edit);
  }
  return applyFieldEdits(snapshot, edits);
}

function treeText(snapshot: AccessibilityNode): {
  text: string;
  entries: FieldEntry[];
} {
  const entries: FieldEntry[] = [];
  let text = "";
  const visit = (node: AccessibilityNode): void => {
    for (const field of SEED_FIELDS) {
      const value = node[field];
      if (typeof value !== "string" || value.length === 0) continue;
      if (text.length > 0) text += " ";
      entries.push({ node, field, text: value, start: text.length });
      text += value;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(snapshot);
  return { text, entries };
}

/** Local ranges, one per span, from the first to the last word inside it. */
function wordRangesInSpans(entry: FieldEntry, spans: readonly Span[]): Span[] {
  const entryEnd = entry.start + entry.text.length;
  const ranges: Span[] = [];
  for (const span of spans) {
    const from = Math.max(span.start, entry.start) - entry.start;
    const to = Math.min(span.end, entryEnd) - entry.start;
    if (from >= to) continue;
    let first: number | undefined;
    let last: number | undefined;
    for (const token of wordTokens(entry.text)) {
      if (token.start >= from && token.end <= to) {
        first ??= token.start;
        last = token.end;
      }
    }
    if (first !== undefined && last !== undefined) {
      ranges.push({ start: first, end: last });
    }
  }
  return ranges;
}

function applyFieldEdits(
  node: AccessibilityNode,
  edits: ReadonlyMap<AccessibilityNode, Partial<Record<SeedField, string>>>,
): AccessibilityNode {
  const edit = edits.get(node);
  const children = node.children?.map((child) => applyFieldEdits(child, edits));
  return {
    ...node,
    ...edit,
    ...(children !== undefined ? { children } : {}),
  };
}

export function redactWallet(
  wallet: WalletContext,
  rules: readonly RedactRule[] = [],
): WalletContext {
  const kind =
    wallet.kind === undefined ? undefined : redactText(wallet.kind, rules);
  const fields = redactFields(wallet.fields, rules);
  if (kind === undefined && fields === undefined) return {};
  if (kind === undefined) return { fields: fields ?? {} };
  if (fields === undefined) return { kind };
  return { kind, fields };
}

function redactFields(
  fields: Readonly<Record<string, string>> | undefined,
  rules: readonly RedactRule[],
): Record<string, string> | undefined {
  if (fields === undefined) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      throw new RedactionError(
        "Wallet field values must be strings so they can be redacted",
      );
    }
    redacted[key] = isWalletSecretKey(key)
      ? REDACTED
      : redactText(value, rules);
  }
  return redacted;
}

function isWalletSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) continue;
    if (WALLET_SECRET_WORDS.has(word)) return true;
    const next = words[index + 1];
    if (next !== undefined && WALLET_SECRET_PAIRS.has(`${word} ${next}`)) {
      return true;
    }
  }
  return false;
}

function redactNode(
  node: AccessibilityNode,
  rules: readonly RedactRule[],
  seen: WeakSet<object>,
): AccessibilityNode {
  if (typeof node !== "object") {
    throw new RedactionError(
      "Cannot redact a snapshot node that is not an object",
    );
  }
  if (seen.has(node)) {
    throw new RedactionError("Cannot redact a cyclic accessibility snapshot");
  }
  seen.add(node);

  const roleRule = matchingRoleRule(node, rules);
  const secret = isSecretField(node) || roleRule !== undefined;
  const replacement = roleRule?.replacement ?? REDACTED;
  const next: {
    role: string;
    name?: string;
    value?: string | number;
    description?: string;
    keyshortcuts?: string;
    roledescription?: string;
    valuetext?: string;
    disabled?: boolean;
    expanded?: boolean;
    focused?: boolean;
    modal?: boolean;
    multiline?: boolean;
    multiselectable?: boolean;
    readonly?: boolean;
    required?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    pressed?: boolean | "mixed";
    level?: number;
    valuemin?: number;
    valuemax?: number;
    autocomplete?: string;
    haspopup?: string;
    invalid?: string;
    orientation?: string;
    children?: AccessibilityNode[];
  } = { role: node.role };

  copyBoolean(next, node);
  if (node.level !== undefined) next.level = node.level;
  if (node.valuemin !== undefined) next.valuemin = node.valuemin;
  if (node.valuemax !== undefined) next.valuemax = node.valuemax;
  if (node.checked !== undefined) next.checked = node.checked;
  if (node.pressed !== undefined) next.pressed = node.pressed;
  if (node.autocomplete !== undefined) next.autocomplete = node.autocomplete;
  if (node.haspopup !== undefined) next.haspopup = node.haspopup;
  if (node.invalid !== undefined)
    next.invalid = redactText(node.invalid, rules);
  if (node.orientation !== undefined) next.orientation = node.orientation;

  const name = redactOptional(node.name, rules);
  const description = redactOptional(node.description, rules);
  const keyshortcuts = redactOptional(node.keyshortcuts, rules);
  const roledescription = redactOptional(node.roledescription, rules);
  if (name !== undefined) next.name = name;
  if (description !== undefined) next.description = description;
  if (keyshortcuts !== undefined) next.keyshortcuts = keyshortcuts;
  if (roledescription !== undefined) next.roledescription = roledescription;

  if (node.value !== undefined) {
    next.value = secret
      ? replacement
      : typeof node.value === "string"
        ? redactText(node.value, rules)
        : node.value;
  }
  if (node.valuetext !== undefined) {
    next.valuetext = secret ? replacement : redactText(node.valuetext, rules);
  }
  if (node.children !== undefined) {
    next.children = node.children.map((child) =>
      redactNode(child, rules, seen),
    );
  }
  return next;
}

function copyBoolean(
  next: {
    disabled?: boolean;
    expanded?: boolean;
    focused?: boolean;
    modal?: boolean;
    multiline?: boolean;
    multiselectable?: boolean;
    readonly?: boolean;
    required?: boolean;
    selected?: boolean;
  },
  node: AccessibilityNode,
): void {
  if (node.disabled !== undefined) next.disabled = node.disabled;
  if (node.expanded !== undefined) next.expanded = node.expanded;
  if (node.focused !== undefined) next.focused = node.focused;
  if (node.modal !== undefined) next.modal = node.modal;
  if (node.multiline !== undefined) next.multiline = node.multiline;
  if (node.multiselectable !== undefined) {
    next.multiselectable = node.multiselectable;
  }
  if (node.readonly !== undefined) next.readonly = node.readonly;
  if (node.required !== undefined) next.required = node.required;
  if (node.selected !== undefined) next.selected = node.selected;
}

function redactOptional(
  value: string | undefined,
  rules: readonly RedactRule[],
): string | undefined {
  if (value === undefined) return undefined;
  return redactText(value, rules);
}

function isSecretField(node: AccessibilityNode): boolean {
  if (!SECRET_FIELD_ROLES.has(node.role)) return false;
  if (
    node.autocomplete !== undefined &&
    SECRET_AUTOCOMPLETE.has(node.autocomplete)
  ) {
    return true;
  }
  const name = node.name ?? "";
  const description = node.description ?? "";
  return SECRET_FIELD_NAME.test(name) || SECRET_FIELD_NAME.test(description);
}

function matchingRoleRule(
  node: AccessibilityNode,
  rules: readonly RedactRule[],
): { readonly replacement?: string } | undefined {
  for (const rule of rules) {
    if (!isRoleRule(rule)) continue;
    if (rule.role !== node.role) continue;
    if (rule.name === undefined) return rule;
    const name = node.name ?? "";
    if (nameMatches(name, rule.name)) return rule;
  }
  return undefined;
}

function replaceSecrets(input: string, rules: readonly RedactRule[]): string {
  let output = redactSeedPhrases(input);
  for (const pattern of TEXT_PATTERNS) {
    output = replaceGlobal(output, pattern.pattern, REDACTED);
  }
  for (const rule of rules) {
    if (rule instanceof RegExp) {
      output = replaceGlobal(output, rule, REDACTED);
      continue;
    }
    if (isPatternRule(rule)) {
      output = replaceGlobal(
        output,
        rule.pattern,
        rule.replacement ?? REDACTED,
      );
    }
  }
  return output;
}

function assertStable(output: string, rules: readonly RedactRule[]): void {
  const again = replaceSecrets(output, rules);
  if (again !== output) {
    throw new RedactionError(
      "Redaction failed closed: a secret or personal-data pattern still matched after replacement. The text was not hashed or returned.",
    );
  }
}

interface WordToken {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

function wordTokens(input: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of input.matchAll(/[A-Za-z]+/g)) {
    const start = match.index;
    tokens.push({ word: match[0], start, end: start + match[0].length });
  }
  return tokens;
}

function redactSeedPhrases(input: string): string {
  const spans = findSeedSpans(input);
  if (spans.length === 0) return input;

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    output += input.slice(cursor, span.start);
    output += REDACTED;
    cursor = span.end;
  }
  output += input.slice(cursor);
  return output;
}

/**
 * Runs of 12 or more BIP-39 words (12–24 word phrases, plus any BIP-39
 * words that happen to sit next to them). Words may be
 * separated by whitespace, list numbers (`1.`, `2)`) or punctuation such as
 * commas. Each span runs from the first word to the last.
 */
function findSeedSpans(input: string): Span[] {
  const tokens = wordTokens(input);
  const spans: Span[] = [];
  let index = 0;
  while (index < tokens.length) {
    const length = seedLengthAt(input, tokens, index);
    const first = tokens[index];
    const last = tokens[index + length - 1];
    if (length === 0 || first === undefined || last === undefined) {
      index += 1;
      continue;
    }
    spans.push({ start: first.start, end: last.end });
    index += length;
  }
  return spans;
}

/**
 * Length of the run of BIP-39 words starting at `index`, or 0 when it is
 * shorter than a seed phrase. The whole run is returned, not just 12 or 24
 * words of it: a heading word such as "Phrase" is a BIP-39 word too, and
 * stopping at a phrase length would leave the last seed word exposed.
 */
function seedLengthAt(
  input: string,
  tokens: readonly WordToken[],
  index: number,
): number {
  let run = 0;
  for (;;) {
    const token = tokens[index + run];
    if (token === undefined || !BIP39.has(token.word.toLowerCase())) break;
    if (run > 0) {
      const previous = tokens[index + run - 1];
      if (previous === undefined) break;
      if (!SEED_SEPARATOR.test(input.slice(previous.end, token.start))) break;
    }
    run += 1;
  }
  return run >= MIN_SEED_WORDS ? run : 0;
}

function replaceGlobal(
  input: string,
  pattern: RegExp,
  replacement: string,
): string {
  const flags = `${pattern.flags.replace(/[gyd]/g, "")}g`;
  return input.replace(new RegExp(pattern.source, flags), () => replacement);
}

function isPatternRule(
  rule: RedactRule,
): rule is { readonly pattern: RegExp; readonly replacement?: string } {
  return isRecord(rule) && "pattern" in rule && rule.pattern instanceof RegExp;
}

function nameMatches(name: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return name === expected;
  const flags = expected.flags.replace(/[gyd]/g, "");
  return new RegExp(expected.source, flags).test(name);
}

function isRoleRule(rule: RedactRule): rule is {
  readonly role: string;
  readonly name?: string | RegExp;
  readonly replacement?: string;
} {
  return isRecord(rule) && "role" in rule && typeof rule.role === "string";
}
