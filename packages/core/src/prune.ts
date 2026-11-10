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
 * The removal order is fixed up front, so this runs in O(n log n).
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

  const order = removalOrder(tree);
  const total = order.length + 1;
  const fits = (candidate: AccessibilityNode, count: number): boolean =>
    count <= maxNodes && estimateSnapshotTokens(candidate) <= maxTokens;

  if (!fits(tree, total)) {
    truncated = true;
    // Removing more nodes never grows the tree, so the smallest number of
    // removals that fits can be found by binary search.
    let low = Math.min(Math.max(total - maxNodes, 1), order.length);
    let high = order.length;
    let best: AccessibilityNode | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = removeFirst(tree, order, mid);
      if (fits(candidate, total - mid)) {
        best = candidate;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    tree =
      best ?? shortenRoot(removeFirst(tree, order, order.length), maxTokens);
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

/**
 * Every non-root node in the order the budget removes it: deepest first, and
 * among equal depths the one latest in document order. A node always comes
 * after its descendants, so removing any prefix of this order leaves a tree,
 * and the node removed at each step is a leaf at that point.
 */
function removalOrder(root: AccessibilityNode): AccessibilityNode[] {
  const nodes: { node: AccessibilityNode; depth: number; index: number }[] = [];
  const visit = (node: AccessibilityNode, depth: number): void => {
    for (const child of node.children ?? []) {
      nodes.push({ node: child, depth: depth + 1, index: nodes.length });
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  nodes.sort((left, right) =>
    left.depth !== right.depth
      ? right.depth - left.depth
      : right.index - left.index,
  );
  return nodes.map((entry) => entry.node);
}

function removeFirst(
  root: AccessibilityNode,
  order: readonly AccessibilityNode[],
  count: number,
): AccessibilityNode {
  const removed = new Set(order.slice(0, count));
  const rebuild = (node: AccessibilityNode): AccessibilityNode => {
    const children = (node.children ?? [])
      .filter((child) => !removed.has(child))
      .map(rebuild);
    return withChildren(node, children);
  };
  return rebuild(root);
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
