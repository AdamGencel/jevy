import {
  canonicalSnapshot,
  normaliseSnapshot,
  normaliseText,
} from "./normalise.js";
import { RedactionError, SnapshotError } from "./errors.js";
import { redactSnapshot, redactText } from "./redact.js";
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
  if (options?.region === undefined) return normalised;
  return sliceRegion(normalised, options.region, options.normalise);
}

export const SNAPSHOT_HASH_VERSION = 1;

export function snapshotDigest(snapshot: AccessibilityNode): string {
  return JSON.stringify({
    v: SNAPSHOT_HASH_VERSION,
    tree: canonicalSnapshot(snapshot),
  });
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
