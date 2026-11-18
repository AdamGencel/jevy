import { SnapshotError } from "./errors.js";
import { isRecord } from "./guards.js";
import type { AccessibilityNode } from "./snapshot.js";

/**
 * Deepest tree accepted, in edges below the root (a lone root is depth 0).
 * Real accessibility trees are a few dozen levels deep. The limit exists so a
 * runaway or hostile tree fails here with a clear error, instead of
 * overflowing the stack later in redaction, normalisation or hashing.
 */
export const MAX_SNAPSHOT_DEPTH = 512;

/**
 * Most nodes accepted, counting a reused node once for each place it
 * appears. Validation is linear in distinct objects, but redaction and
 * normalisation walk the expanded tree, so a few dozen objects that each
 * hold the next one twice would otherwise run for ever.
 */
export const MAX_SNAPSHOT_NODES = 250_000;

/** Optional fields that must be strings when present. */
const STRING_FIELDS = [
  "name",
  "description",
  "valuetext",
  "roledescription",
  "keyshortcuts",
  "invalid",
  "autocomplete",
  "haspopup",
  "orientation",
] as const;

/**
 * Check that `snapshot` is a tree the rest of the pipeline can trust, and
 * throw `SnapshotError` naming the problem and the node's path (for example
 * `children[2].children[0]`) when it is not.
 *
 * Only ancestors count as a cycle: the same object in two places is two
 * nodes, which is how a caller that reuses a node object expects it to be
 * read. A subtree already checked is not walked again, so a tree that shares
 * nodes heavily is still checked in time linear in its distinct objects.
 */
export function validateSnapshot(
  snapshot: unknown,
): asserts snapshot is AccessibilityNode {
  const walk: Walk = {
    ancestors: new Set(),
    heights: new Map(),
    sizes: new Map(),
    path: [],
  };
  visit(snapshot, 0, walk);
}

interface Walk {
  /** Nodes on the path from the root to the current node. */
  readonly ancestors: Set<object>;
  /** Height of each subtree already checked, in edges. */
  readonly heights: Map<object, number>;
  /** Node count of each subtree already checked, reused nodes counted again. */
  readonly sizes: Map<object, number>;
  /** Path segments from the root, such as `children[2]`. */
  readonly path: string[];
}

/** Check one node and its subtree; return the subtree's height. */
function visit(value: unknown, depth: number, walk: Walk): number {
  if (!isRecord(value)) {
    throw problem(walk, `is ${describe(value)}, not an object`);
  }
  if (walk.ancestors.has(value)) {
    throw new SnapshotError(
      `Accessibility snapshot contains a cycle: the node at ${where(walk)} is its own ancestor`,
    );
  }
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw new SnapshotError(
      `Accessibility snapshot is deeper than ${String(MAX_SNAPSHOT_DEPTH)} levels: a node at depth ${String(depth)} is ${abbreviatedWhere(walk)}`,
    );
  }
  const known = walk.heights.get(value);
  // A subtree that fits at this depth needs no second walk. One that does
  // not is walked again so the error can name the node that is too deep.
  if (known !== undefined && depth + known <= MAX_SNAPSHOT_DEPTH) return known;

  checkFields(value, walk);
  const children = value["children"];
  let height = 0;
  let size = 1;
  if (Array.isArray(children)) {
    walk.ancestors.add(value);
    for (let index = 0; index < children.length; index += 1) {
      walk.path.push(`children[${String(index)}]`);
      const child: unknown = children[index];
      height = Math.max(height, 1 + visit(child, depth + 1, walk));
      // `visit` returned, so the child is an object it has sized.
      size += walk.sizes.get(child as object) ?? 1;
      walk.path.pop();
    }
    walk.ancestors.delete(value);
  }
  if (size > MAX_SNAPSHOT_NODES) {
    throw new SnapshotError(
      `Accessibility snapshot has more than ${String(MAX_SNAPSHOT_NODES)} nodes once reused nodes are counted in every place they appear: the subtree at ${abbreviatedWhere(walk)}`,
    );
  }
  walk.heights.set(value, height);
  walk.sizes.set(value, size);
  return height;
}

function checkFields(
  node: Readonly<Record<string, unknown>>,
  walk: Walk,
): void {
  const role = node["role"];
  if (typeof role !== "string" || role.trim().length === 0) {
    throw problem(walk, "has no role: role must be a non-empty string");
  }
  const children = node["children"];
  if (children !== undefined && !Array.isArray(children)) {
    throw problem(
      walk,
      `has children that are ${describe(children)}, not an array`,
    );
  }
  const value = node["value"];
  if (
    value !== undefined &&
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    throw problem(
      walk,
      `has a value that is ${describe(value)}: value must be a string or a finite number`,
    );
  }
  for (const field of STRING_FIELDS) {
    const text = node[field];
    if (text !== undefined && typeof text !== "string") {
      throw problem(
        walk,
        `has a ${field} that is ${describe(text)}, not a string`,
      );
    }
  }
}

function problem(walk: Walk, detail: string): SnapshotError {
  return new SnapshotError(
    `Accessibility snapshot node at ${where(walk)} ${detail}`,
  );
}

function where(walk: Walk): string {
  return walk.path.length === 0 ? "the root" : walk.path.join(".");
}

/**
 * The path of a node too deep to spell out: hundreds of `children[0]`
 * segments would bury the problem, so only both ends are kept.
 */
function abbreviatedWhere(walk: Walk): string {
  const { path } = walk;
  if (path.length <= 6) return `at ${where(walk)}`;
  const skipped = path.length - 6;
  return `at ${path.slice(0, 3).join(".")}…(${String(skipped)} more levels)…${path.slice(-3).join(".")}`;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
