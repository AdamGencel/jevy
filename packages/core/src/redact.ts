import { BIP39_ENGLISH_WORDS } from "./bip39-english.js";
import { RedactionError } from "./errors.js";
import { collapseWhitespace, isRecord } from "./guards.js";
import type { AccessibilityNode } from "./snapshot.js";
import type { WalletContext } from "./decider.js";

/** Stable replacement. Two different secrets in the same place hash the same. */
export const REDACTED = "[REDACTED]";

const BIP39 = new Set(BIP39_ENGLISH_WORDS);

const SECRET_FIELD_NAME =
  /password|passcode|secret|api[-_ ]?key|mnemonic|seed phrase|private key/i;

const SECRET_FIELD_ROLES = new Set(["textbox", "searchbox"]);

const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
]);

const WALLET_SECRET_KEY = /key|secret|seed|mnemonic|password|token/i;

const SEED_LENGTHS = [24, 21, 18, 15, 12] as const;

interface TextPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Built-in patterns. They always run; a project can add rules, not remove
 * these. A 64-hex Ethereum secret is redacted. A 40-hex address is not:
 * addresses are public and are often the thing under test. The tradeoff is
 * that a transaction hash has the same shape as a secret key and is redacted
 * too. See DESIGN.md.
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
  { name: "eth-private-key", pattern: /\b0x[a-fA-F0-9]{64}\b/g },
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
  return redactNode(snapshot, rules, seen);
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
    redacted[key] = WALLET_SECRET_KEY.test(key)
      ? REDACTED
      : redactText(value, rules);
  }
  return redacted;
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

function redactSeedPhrases(input: string): string {
  const tokens: { word: string; start: number; end: number }[] = [];
  for (const match of input.matchAll(/[A-Za-z]+/g)) {
    const start = match.index;
    tokens.push({
      word: match[0],
      start,
      end: start + match[0].length,
    });
  }

  const spans: { start: number; end: number }[] = [];
  let index = 0;
  while (index < tokens.length) {
    const length = seedLengthAt(input, tokens, index);
    const first = tokens[index];
    if (length === 0 || first === undefined) {
      index += 1;
      continue;
    }
    const last = tokens[index + length - 1];
    if (last === undefined) {
      index += 1;
      continue;
    }
    spans.push({ start: first.start, end: last.end });
    index += length;
  }
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

function seedLengthAt(
  input: string,
  tokens: readonly { word: string; start: number; end: number }[],
  index: number,
): number {
  for (const length of SEED_LENGTHS) {
    if (index + length > tokens.length) continue;
    const first = tokens[index];
    const last = tokens[index + length - 1];
    if (first === undefined || last === undefined) continue;
    let words = true;
    for (let offset = 0; offset < length; offset += 1) {
      const token = tokens[index + offset];
      if (token === undefined || !BIP39.has(token.word.toLowerCase())) {
        words = false;
        break;
      }
    }
    if (!words) continue;
    const slice = input.slice(first.start, last.end);
    if (/^[A-Za-z]+(?:\s+[A-Za-z]+)*$/.test(slice)) return length;
  }
  return 0;
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
