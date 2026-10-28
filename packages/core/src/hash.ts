import { createHash } from "node:crypto";
import {
  SNAPSHOT_HASH_VERSION,
  projectSnapshot,
  snapshotDigest,
} from "./project.js";
import type { SnapshotProcessOptions } from "./project.js";
import { canonicalSnapshotJson } from "./normalise.js";
import type { AccessibilityNode } from "./snapshot.js";

/**
 * `sha256:` plus 64 hex characters.
 * The input is the redacted, normalised tree (or one region of it). Pruning
 * does not change this hash: a node that is only dropped to fit a token
 * budget still counts as a relevant change.
 */
export function hashSnapshot(
  snapshot: AccessibilityNode,
  options?: SnapshotProcessOptions,
): string {
  const tree = projectSnapshot(snapshot, options);
  const hex = createHash("sha256").update(snapshotDigest(tree)).digest("hex");
  return `sha256:${hex}`;
}

export { SNAPSHOT_HASH_VERSION };

/**
 * Rough token count for a snapshot that has already been normalised.
 * Four characters of canonical JSON per token. This is not a model tokenizer.
 */
export function estimateSnapshotTokens(snapshot: AccessibilityNode): number {
  return Math.ceil(canonicalSnapshotJson(snapshot).length / 4);
}
