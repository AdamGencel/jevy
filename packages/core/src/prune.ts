import { estimateSnapshotTokens } from "./hash.js";
import { projectSnapshot } from "./project.js";
import type { SnapshotProcessOptions } from "./project.js";
import type { AccessibilityNode } from "./snapshot.js";

/** Kev's validated context window, in tokens. */
export const KEV_CONTEXT_TOKENS = 8192;

/**
 * Snapshot budget when the selected decider is Kev. Leaves room in the
 * 8,192-token window for the question prompt and the answer.
 */
export const KEV_SNAPSHOT_TOKEN_BUDGET = 6000;

/** Budget for hosted deciders, which are not held to Kev's window. */
export const DEFAULT_SNAPSHOT_TOKEN_BUDGET = 12_000;

export const DEFAULT_MAX_NODES = 400;
export const DEFAULT_MAX_DEPTH = 16;

export function snapshotTokenBudget(deciderId: string | undefined): number {
  return deciderId === "kev"
    ? KEV_SNAPSHOT_TOKEN_BUDGET
    : DEFAULT_SNAPSHOT_TOKEN_BUDGET;
}

export interface PruneOptions extends SnapshotProcessOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxTokens?: number;
  readonly deciderId?: string;
}

export interface PrunedSnapshot {
  readonly snapshot: AccessibilityNode;
  readonly truncated: boolean;
  readonly nodeCount: number;
  readonly approxTokens: number;
}

/**
 * Shrink a snapshot deterministically.
 *
 * Depth is cut first (root is depth 0). Then, while the tree is over the
 * node or token budget, the deepest leaf is removed. Ties go to the
 * rightmost path, so earlier content survives. The root is never removed.
 * If the root alone is over the token budget, its name is shortened.
 * `truncated` is not part of the snapshot hash.
 */
export function pruneSnapshot(
  snapshot: AccessibilityNode,
  options?: PruneOptions,
): PrunedSnapshot {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxTokens =
    options?.maxTokens ?? snapshotTokenBudget(options?.deciderId);
  let tree = projectSnapshot(snapshot, options);
  const cut = cutDepth(tree, 0, maxDepth);
  tree = cut.node;
  let truncated = cut.truncated;

  const removalLimit = countNodes(tree);
  let guard = 0;
  while (
    (countNodes(tree) > maxNodes || estimateSnapshotTokens(tree) > maxTokens) &&
    guard < removalLimit
  ) {
    const leaves = collectLeaves(tree, []);
    const victim = pickLeaf(leaves);
    if (victim === undefined) {
      tree = shortenRoot(tree, maxTokens);
      truncated = true;
      break;
    }
    tree = removeAt(tree, victim);
    truncated = true;
    guard += 1;
  }

  return {
    snapshot: tree,
    truncated,
    nodeCount: countNodes(tree),
    approxTokens: estimateSnapshotTokens(tree),
  };
}

function cutDepth(
  node: AccessibilityNode,
  depth: number,
  maxDepth: number,
): { node: AccessibilityNode; truncated: boolean } {
  if (depth >= maxDepth) {
    const hadChildren = (node.children?.length ?? 0) > 0;
    return { node: withoutChildren(node), truncated: hadChildren };
  }
  let truncated = false;
  const children: AccessibilityNode[] = [];
  for (const child of node.children ?? []) {
    const cut = cutDepth(child, depth + 1, maxDepth);
    children.push(cut.node);
    truncated = truncated || cut.truncated;
  }
  return { node: withChildren(node, children), truncated };
}

function collectLeaves(
  node: AccessibilityNode,
  path: readonly number[],
): number[][] {
  const children = node.children ?? [];
  if (children.length === 0) {
    return path.length === 0 ? [] : [[...path]];
  }
  const leaves: number[][] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    leaves.push(...collectLeaves(child, [...path, index]));
  }
  return leaves;
}

/** Deepest first, then the lexicographically greatest path. */
function pickLeaf(leaves: readonly number[][]): readonly number[] | undefined {
  return [...leaves].sort(preferDrop).at(0);
}

function preferDrop(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return right.length - left.length;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (right[index] ?? -1) - (left[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function removeAt(
  node: AccessibilityNode,
  path: readonly number[],
): AccessibilityNode {
  const [head, ...tail] = path;
  if (head === undefined) return node;
  const children = [...(node.children ?? [])];
  const child = children[head];
  if (child === undefined) return node;
  if (tail.length === 0) {
    children.splice(head, 1);
  } else {
    const replacement = removeAt(child, tail);
    children.splice(head, 1, replacement);
  }
  return withChildren(node, children);
}

function shortenRoot(
  node: AccessibilityNode,
  maxTokens: number,
): AccessibilityNode {
  const name = node.name;
  if (name === undefined || name.length === 0) return node;
  let low = 0;
  let high = name.length;
  let best = withoutName(node);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate =
      mid === 0 ? withoutName(node) : withName(node, name.slice(0, mid));
    if (estimateSnapshotTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function withoutChildren(node: AccessibilityNode): AccessibilityNode {
  return omitKey(node, "children");
}

function withoutName(node: AccessibilityNode): AccessibilityNode {
  return omitKey(node, "name");
}

function omitKey(
  node: AccessibilityNode,
  key: keyof AccessibilityNode,
): AccessibilityNode {
  const copy: AccessibilityNode = { ...node };
  Reflect.deleteProperty(copy, key);
  return copy;
}

function withName(node: AccessibilityNode, name: string): AccessibilityNode {
  return { ...withoutName(node), name };
}

function withChildren(
  node: AccessibilityNode,
  children: readonly AccessibilityNode[],
): AccessibilityNode {
  const base = withoutChildren(node);
  if (children.length === 0) return base;
  return { ...base, children: [...children] };
}

function countNodes(node: AccessibilityNode): number {
  return (
    1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
  );
}
