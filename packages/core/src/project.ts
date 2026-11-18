import { createHash } from "node:crypto";
import {
  canonicalSnapshot,
  normaliseSnapshot,
  normaliseText,
} from "./normalise.js";
import { ConfigError, RedactionError, SnapshotError } from "./errors.js";
import { resolveNormalise } from "./snapshot.js";
import {
  containsSplitSeedPhrase,
  redactSnapshot,
  redactText,
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
  assertTreeRedacted(normalised, rules);
  if (containsSplitSeedPhrase(normalised)) {
    throw new RedactionError(
      "Redaction failed closed: a seed phrase spread over several nodes was still present on the normalised snapshot. It was not hashed or returned.",
    );
  }
  if (options?.region === undefined) return normalised;
  return sliceRegion(normalised, options.region, options.normalise);
}

/**
 * Version of the digest format. Version 2 added the `rules` field.
 */
export const SNAPSHOT_HASH_VERSION = 2;

/**
 * Version of the built-in redaction and normalisation rules. A built-in
 * change can change the tree that is hashed without changing the code that
 * hashes it, so the rules carry their own version. Version 1 was the rule set
 * before the seed-phrase and key-pattern changes of November 2026.
 *
 * Bump this whenever a built-in rule change alters any snapshot's hash; the
 * golden-hash test fails until you do.
 */
export const SNAPSHOT_RULES_VERSION = 2;

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
 * `{ role }` rule cannot serialise to the same value. A rule that is none of
 * them is rejected rather than silently fingerprinted as nothing.
 */
function serialiseRedactRule(rule: RedactRule): unknown {
  if (rule instanceof RegExp) return serialiseRegExp(rule);
  if ("pattern" in rule) {
    return {
      pattern: serialiseRegExp(rule.pattern),
      ...(rule.replacement !== undefined
        ? { replacement: rule.replacement }
        : {}),
    };
  }
  if (typeof rule.role === "string") {
    return {
      role: rule.role,
      ...(rule.name !== undefined
        ? {
            name:
              typeof rule.name === "string"
                ? rule.name
                : serialiseRegExp(rule.name),
          }
        : {}),
      ...(rule.replacement !== undefined
        ? { replacement: rule.replacement }
        : {}),
    };
  }
  throw new ConfigError(
    "A redact rule must be a RegExp, { pattern }, or { role }",
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
): void {
  for (const value of stringFields(node)) {
    if (redactText(value, rules) !== value) {
      throw new RedactionError(
        "Redaction failed closed: secret or personal data was still present on the normalised snapshot. It was not hashed or returned.",
      );
    }
  }
  for (const child of node.children ?? []) {
    assertTreeRedacted(child, rules);
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
