import { SnapshotError } from "./errors.js";
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

/**
 * Roles kept for as long as the budget allows. An error banner, a dialog, a
 * status message or a heading is what a question about a page is most often
 * about, and removing one silently changes the answer.
 */
export const DEFAULT_KEEP_ROLES: readonly string[] = [
  "alert",
  "alertdialog",
  "dialog",
  "status",
  "heading",
];

export interface PruneOptions extends SnapshotProcessOptions {
  /** At least 1: the root always stays. */
  readonly maxNodes?: number;
  /** At least 0. The root is depth 0. */
  readonly maxDepth?: number;
  /** A finite number above 0. */
  readonly maxTokens?: number;
  readonly deciderId?: string;
  /**
   * Replaces `DEFAULT_KEEP_ROLES`. `[]` protects nothing, which gives the
   * plain deepest-first, latest-first order.
   */
  readonly keepRoles?: readonly string[];
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
 * Depth is cut first (root is depth 0), for every node. Then, while the tree
 * is over the node or token budget, nodes are removed in a fixed order. A
 * node is protected when it has one of `keepRoles`, sits inside such a node,
 * or contains one. Every unprotected node goes before any protected one;
 * within each group the deepest goes first, and ties go to the one latest in
 * document order, so earlier content survives. The root is never removed.
 * The order is fixed up front, so this runs in O(n log n).
 *
 * If the root alone is still over the token budget, its text is shortened:
 * name, then description, valuetext, a string value and roledescription,
 * each dropped entirely before the next is touched. If even the bare root
 * does not fit, `SnapshotError` is thrown: a result over budget is never
 * returned. `truncated` is not part of the snapshot hash.
 */
export function pruneSnapshot(
  snapshot: AccessibilityNode,
  options?: PruneOptions,
): PrunedSnapshot {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxTokens =
    options?.maxTokens ?? snapshotTokenBudget(options?.deciderId);
  const keepRoles = options?.keepRoles ?? DEFAULT_KEEP_ROLES;
  assertBudgets(maxNodes, maxDepth, maxTokens, keepRoles);

  let tree = projectSnapshot(snapshot, options);
  const cut = cutDepth(tree, 0, maxDepth);
  tree = cut.node;
  let truncated = cut.truncated;

  const order = removalOrder(tree, new Set(keepRoles));
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

function assertBudgets(
  maxNodes: number,
  maxDepth: number,
  maxTokens: number,
  keepRoles: readonly string[],
): void {
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new SnapshotError(
      `maxNodes must be an integer of at least 1, got ${String(maxNodes)}`,
    );
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new SnapshotError(
      `maxDepth must be an integer of at least 0, got ${String(maxDepth)}`,
    );
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new SnapshotError(
      `maxTokens must be a finite number above 0, got ${String(maxTokens)}`,
    );
  }
  if (
    !Array.isArray(keepRoles) ||
    !keepRoles.every((role) => typeof role === "string")
  ) {
    throw new SnapshotError("keepRoles must be an array of role strings");
  }
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
 * Every non-root node in the order the budget removes it: unprotected nodes
 * before protected ones, then deepest first, then the one latest in document
 * order.
 *
 * A node always comes after its descendants, so removing any prefix of this
 * order leaves a tree, and the node removed at each step is a leaf at that
 * point. Within one group a descendant is deeper, so it sorts first. Across
 * groups, an unprotected node has no protected descendant: such a descendant
 * would have a keep role, sit inside a keep-role node, or contain one, and
 * each of those would make the unprotected node an ancestor of a keep-role
 * node, or a node inside one, and so protected too.
 */
function removalOrder(
  root: AccessibilityNode,
  keepRoles: ReadonlySet<string>,
): AccessibilityNode[] {
  const nodes: {
    node: AccessibilityNode;
    depth: number;
    index: number;
    protected: boolean;
  }[] = [];
  /** Returns whether the subtree at `node` contains a keep-role node. */
  const visit = (
    node: AccessibilityNode,
    depth: number,
    insideKeep: boolean,
  ): boolean => {
    const keep = keepRoles.has(node.role);
    let containsKeep = keep;
    for (const child of node.children ?? []) {
      const entry = {
        node: child,
        depth: depth + 1,
        index: nodes.length,
        protected: false,
      };
      nodes.push(entry);
      const childContainsKeep = visit(child, depth + 1, insideKeep || keep);
      entry.protected = insideKeep || keep || childContainsKeep;
      containsKeep = containsKeep || childContainsKeep;
    }
    return containsKeep;
  };
  visit(root, 0, false);
  nodes.sort((left, right) => {
    if (left.protected !== right.protected) return left.protected ? 1 : -1;
    return left.depth !== right.depth
      ? right.depth - left.depth
      : right.index - left.index;
  });
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

/** Root text fields, in the order they give way to the budget. */
type RootTextField =
  "name" | "description" | "valuetext" | "value" | "roledescription";

const ROOT_TEXT_FIELDS: readonly RootTextField[] = [
  "name",
  "description",
  "valuetext",
  "value",
  "roledescription",
];

/**
 * Fit a childless root into `maxTokens` by shortening its text, one field at
 * a time. A field is cut to the longest prefix that fits; if no prefix fits,
 * it is dropped and the next field is tried. A numeric value is left alone.
 */
function shortenRoot(
  node: AccessibilityNode,
  maxTokens: number,
): AccessibilityNode {
  const fits = (candidate: AccessibilityNode): boolean =>
    estimateSnapshotTokens(candidate) <= maxTokens;
  let current = node;
  for (const field of ROOT_TEXT_FIELDS) {
    if (fits(current)) return current;
    const text = current[field];
    if (typeof text !== "string") continue;
    current = shortenField(current, field, text, fits);
  }
  if (fits(current)) return current;
  throw new SnapshotError(
    `The snapshot root does not fit the budget of ${String(maxTokens)} tokens, even with every other node removed and its name, description, valuetext, string value and roledescription dropped (it needs ${String(estimateSnapshotTokens(current))})`,
  );
}

/**
 * The longest prefix of `text` that fits, or the node without the field.
 * Token cost grows with prefix length, so a binary search finds it.
 */
function shortenField(
  node: AccessibilityNode,
  field: RootTextField,
  text: string,
  fits: (candidate: AccessibilityNode) => boolean,
): AccessibilityNode {
  const without = omitKey(node, field);
  let best = without;
  let low = 1;
  let high = text.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = prefixOf(text, mid);
    const candidate =
      prefix.length === 0 ? without : { ...without, [field]: prefix };
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * The first `length` UTF-16 units of `text`, one shorter if that would end
 * on half a surrogate pair. A lone surrogate is escaped as six characters in
 * JSON, which would break the monotone cost the binary search relies on, and
 * would put a broken character in front of the decider.
 */
function prefixOf(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? length - 1 : length);
}

function withoutChildren(node: AccessibilityNode): AccessibilityNode {
  return omitKey(node, "children");
}

function omitKey(
  node: AccessibilityNode,
  key: keyof AccessibilityNode,
): AccessibilityNode {
  const copy: AccessibilityNode = { ...node };
  Reflect.deleteProperty(copy, key);
  return copy;
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
