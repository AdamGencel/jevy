import { createHash } from "node:crypto";
import {
  canonicalSnapshot,
  normaliseSnapshot,
  normaliseText,
} from "./normalise.js";
import { ConfigError, RedactionError, SnapshotError } from "./errors.js";
import { collapseWhitespace, isRecord } from "./guards.js";
import { resolveNormalise } from "./snapshot.js";
import {
  containsSplitSeedPhrase,
  redactSnapshot,
  redactText,
  redactUrl,
} from "./redact.js";
import type { RedactRule } from "./redact.js";
import type {
  AccessibilityNode,
  NormaliseOverrides,
  SnapshotRegion,
} from "./snapshot.js";

export interface SnapshotProcessOptions {
  readonly redact?: readonly RedactRule[];
  readonly normalise?: NormaliseOverrides;
  readonly region?: SnapshotRegion;
}

/**
 * Redact, normalise, and optionally slice to a region.
 * The hash and the pruned payload both start here, so a secret cannot be
 * hashed or sent by skipping one of the two.
 */
export function projectSnapshot(
  snapshot: AccessibilityNode,
  options?: SnapshotProcessOptions,
): AccessibilityNode {
  const rules = options?.redact ?? [];
  const redacted = redactSnapshot(snapshot, rules);
  const normalised = normaliseSnapshot(redacted, options?.normalise);
  assertSnapshotClean(normalised, rules);
  if (options?.region === undefined) return normalised;
  return sliceRegion(normalised, options.region, options.normalise);
}

/**
 * Throw `RedactionError` unless redaction would leave `tree` as it is: every
 * text field and URL is clean under the built-in patterns and `rules`, and
 * no seed phrase is spread over its nodes. `projectSnapshot` checks the
 * normalised tree with it, and pruning checks its result again, because
 * removing a node can bring two halves of a phrase together and cutting a
 * field to a prefix can leave text that a pattern matches.
 *
 * With `cut: true`, a field may be a prefix of a clean one, so it can end
 * in a space or a bare `https:/` that redaction would tidy. Only what the
 * text patterns, `rules` and the seed-phrase check find counts then.
 */
export function assertSnapshotClean(
  tree: AccessibilityNode,
  rules: readonly RedactRule[],
  options?: { readonly cut?: boolean },
): void {
  assertTreeRedacted(tree, rules, options?.cut ?? false);
  if (containsSplitSeedPhrase(tree)) {
    throw new RedactionError(
      "Redaction failed closed: a seed phrase spread over several nodes was still present on the snapshot. It was not hashed or returned.",
    );
  }
}

/**
 * Version of the digest format. Version 2 added the `rules` field.
 */
export const SNAPSHOT_HASH_VERSION = 2;

/**
 * Version of the built-in redaction and normalisation rules. A built-in
 * change can change the tree that is hashed without changing the code that
 * hashes it, so the rules carry their own version. Version 1 was the rule set
 * before the seed-phrase and key-pattern changes of November 2026. Version 2
 * was the rule set before a link's `url` joined the tree (step 3).
 *
 * Bump this whenever a built-in rule change alters any snapshot's hash; the
 * golden-hash test fails until you do.
 */
export const SNAPSHOT_RULES_VERSION = 3;

/**
 * The string that is hashed. Key order is fixed by construction, and
 * `canonicalSnapshot` fixes it inside the tree, so this is canonical JSON.
 */
export function snapshotDigest(snapshot: AccessibilityNode): string {
  return JSON.stringify({
    v: SNAPSHOT_HASH_VERSION,
    rules: SNAPSHOT_RULES_VERSION,
    tree: canonicalSnapshot(snapshot),
  });
}

/**
 * `sha256:` plus 64 hex characters over the project's own rules: the hash
 * version, the built-in rules version, the redact rules in order, and the
 * resolved normalise options. The decision cache stores it, so a miss can
 * say "your redaction rules changed" instead of only "the page changed".
 *
 * Equal rules give an equal fingerprint. Any change that could change a
 * snapshot's hash gives a different one. A change that cannot (the order of
 * `disable` or `dropRoles`, a `g`, `y` or `d` flag, which matching ignores)
 * does not. `region` is not part of it: it selects what to hash, it does not
 * change how text is rewritten.
 */
export function rulesFingerprint(
  options?: Pick<SnapshotProcessOptions, "redact" | "normalise">,
): string {
  const normalise = resolveNormalise(options?.normalise);
  const payload = JSON.stringify({
    v: SNAPSHOT_HASH_VERSION,
    rules: SNAPSHOT_RULES_VERSION,
    redact: (options?.redact ?? []).map(serialiseRedactRule),
    normalise: {
      disable: sortedUnique(normalise.disable),
      dropRoles: sortedUnique(normalise.dropRoles),
      replace: normalise.replace.map((rule) => ({
        pattern: serialiseRegExp(rule.pattern),
        placeholder: rule.placeholder,
      })),
      unwrapUnnamedGeneric: normalise.unwrapUnnamedGeneric,
    },
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

interface SerialisedRegExp {
  readonly source: string;
  readonly flags: string;
}

/**
 * Matching rebuilds every pattern without `g`, `y` and `d` and adds `g`
 * itself, so those flags cannot change a hash and are left out.
 */
function serialiseRegExp(pattern: RegExp): SerialisedRegExp {
  // Flags are single ASCII letters, so splitting into characters is safe.
  const flags = Array.from(pattern.flags.replace(/[gyd]/g, "")).sort().join("");
  return { source: pattern.source, flags };
}

/**
 * Each kind has its own keys, so a bare RegExp, a `{ pattern }` rule and a
 * `{ role }` rule cannot serialise to the same value. Rules may reach here
 * without passing `parseConfig`, so the shape is checked: a malformed rule is
 * a ConfigError, not a TypeError, and a rule that sets both `pattern` and
 * `role` keeps both halves, because redaction applies both.
 */
function serialiseRedactRule(rule: RedactRule): unknown {
  if (rule instanceof RegExp) return serialiseRegExp(rule);
  const value: unknown = rule;
  if (!isRecord(value)) throw malformedRedactRule();
  const { pattern, role, name, replacement } = value;
  if (pattern === undefined && role === undefined) {
    throw malformedRedactRule();
  }
  if (pattern !== undefined && !(pattern instanceof RegExp)) {
    throw malformedRedactRule();
  }
  if (role !== undefined && typeof role !== "string") {
    throw malformedRedactRule();
  }
  if (
    name !== undefined &&
    typeof name !== "string" &&
    !(name instanceof RegExp)
  ) {
    throw malformedRedactRule();
  }
  if (replacement !== undefined && typeof replacement !== "string") {
    throw malformedRedactRule();
  }
  return {
    ...(pattern !== undefined ? { pattern: serialiseRegExp(pattern) } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(role !== undefined && name !== undefined
      ? { name: typeof name === "string" ? name : serialiseRegExp(name) }
      : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function malformedRedactRule(): ConfigError {
  return new ConfigError(
    "A redact rule must be a RegExp, { pattern: RegExp, replacement?: string }, or { role: string, name?: string | RegExp, replacement?: string }",
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sliceRegion(
  snapshot: AccessibilityNode,
  region: SnapshotRegion,
  normalise: NormaliseOverrides | undefined,
): AccessibilityNode {
  const name =
    region.name === undefined
      ? undefined
      : normaliseText(region.name, normalise);
  const found = findRegion(snapshot, region.role, name);
  if (found === undefined) {
    throw new SnapshotError(
      `No accessibility node matched region role "${region.role}".`,
    );
  }
  return found;
}

function findRegion(
  node: AccessibilityNode,
  role: string,
  name: string | undefined,
): AccessibilityNode | undefined {
  const nameMatches = name === undefined || node.name === name;
  if (node.role === role && nameMatches) return node;
  for (const child of node.children ?? []) {
    const found = findRegion(child, role, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function assertTreeRedacted(
  node: AccessibilityNode,
  rules: readonly RedactRule[],
  cut: boolean,
): void {
  const unchanged = (value: string): boolean =>
    redactText(value, rules) === (cut ? collapseWhitespace(value) : value);
  const clean =
    stringFields(node).every(unchanged) &&
    (node.url === undefined ||
      (cut ? unchanged(node.url) : redactUrl(node.url, rules) === node.url));
  if (!clean) {
    throw new RedactionError(
      "Redaction failed closed: secret or personal data was still present on the snapshot. It was not hashed or returned.",
    );
  }
  for (const child of node.children ?? []) {
    assertTreeRedacted(child, rules, cut);
  }
}

function stringFields(node: AccessibilityNode): string[] {
  const values: string[] = [];
  if (node.name !== undefined) values.push(node.name);
  if (node.description !== undefined) values.push(node.description);
  if (typeof node.value === "string") values.push(node.value);
  if (node.valuetext !== undefined) values.push(node.valuetext);
  if (node.roledescription !== undefined) values.push(node.roledescription);
  if (node.invalid !== undefined) values.push(node.invalid);
  return values;
}
