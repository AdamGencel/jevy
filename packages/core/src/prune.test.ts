import { describe, expect, it } from "vitest";
import { RedactionError, SnapshotError } from "./errors.js";
import { estimateSnapshotTokens, hashSnapshot } from "./hash.js";
import { projectSnapshot } from "./project.js";
import {
  pruneSnapshot,
  snapshotTokenBudget,
  DEFAULT_KEEP_ROLES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  KEV_SNAPSHOT_TOKEN_BUDGET,
  DEFAULT_SNAPSHOT_TOKEN_BUDGET,
} from "./prune.js";
import type { PruneOptions } from "./prune.js";
import type { AccessibilityNode } from "./snapshot.js";

describe("snapshot pruning", () => {
  it("leaves a small tree unchanged", () => {
    const pruned = pruneSnapshot({ role: "button", name: "Pay" });
    expect(pruned.truncated).toBe(false);
    expect(pruned.snapshot).toEqual({ role: "button", name: "Pay" });
    expect(pruned.nodeCount).toBe(1);
  });

  it("drops the deepest rightmost leaves first, and does so again the same way", () => {
    const tree = page();
    const pruned = pruneSnapshot(tree, { maxNodes: 4 });
    expect(pruned.truncated).toBe(true);
    expect(pruned.nodeCount).toBe(4);
    const encoded = JSON.stringify(pruned.snapshot);
    expect(encoded).toContain("a1");
    expect(encoded).not.toContain("a2");
    expect(encoded).not.toContain("b1");
    expect(pruneSnapshot(tree, { maxNodes: 4 })).toEqual(pruned);
  });

  it("does not let the token budget change the hash of the full page", () => {
    const tree = page();
    const pruned = pruneSnapshot(tree, { maxNodes: 4 });
    expect(hashSnapshot(tree)).toBe(hashSnapshot(structuredClone(tree)));
    expect(hashSnapshot(tree)).not.toBe(hashSnapshot(pruned.snapshot));
  });

  it("cuts nodes past the depth limit", () => {
    const pruned = pruneSnapshot(page(), { maxDepth: 1, maxNodes: 100 });
    expect(pruned.truncated).toBe(true);
    const children = pruned.snapshot.children ?? [];
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => child.children === undefined)).toBe(true);
  });

  it("uses a smaller budget for Kev than for a hosted decider", () => {
    expect(snapshotTokenBudget("kev")).toBe(KEV_SNAPSHOT_TOKEN_BUDGET);
    expect(snapshotTokenBudget("jev")).toBe(DEFAULT_SNAPSHOT_TOKEN_BUDGET);
    const huge: AccessibilityNode = {
      role: "status",
      name: "x".repeat(30_000),
    };
    expect(pruneSnapshot(huge, { deciderId: "kev" }).truncated).toBe(true);
    expect(pruneSnapshot(huge, { deciderId: "jev" }).truncated).toBe(false);
    expect(
      pruneSnapshot(huge, { deciderId: "kev" }).approxTokens,
    ).toBeLessThanOrEqual(KEV_SNAPSHOT_TOKEN_BUDGET);
  });

  it("prunes a large page in well under a second", () => {
    const tree: AccessibilityNode = {
      role: "main",
      children: Array.from({ length: 1000 }, (_, outer) => ({
        role: "list",
        children: Array.from({ length: 9 }, (_, inner) => ({
          role: "listitem",
          name: `item ${String(outer)}-${String(inner)}`,
        })),
      })),
    };
    const started = performance.now();
    const pruned = pruneSnapshot(tree);
    const elapsed = performance.now() - started;
    expect(pruned.nodeCount).toBeLessThanOrEqual(400);
    expect(pruned.truncated).toBe(true);
    // The previous leaf-by-leaf loop took several seconds on 10,000 nodes.
    expect(elapsed).toBeLessThan(2000);
  });

  it("keeps the earliest content when it removes nodes", () => {
    const tree: AccessibilityNode = {
      role: "main",
      children: Array.from({ length: 10 }, (_, index) => ({
        role: "button",
        name: `b${String(index)}`,
      })),
    };
    const pruned = pruneSnapshot(tree, { maxNodes: 4 });
    expect(pruned.snapshot.children?.map((child) => child.name)).toEqual([
      "b0",
      "b1",
      "b2",
    ]);
  });
});

function page(): AccessibilityNode {
  return {
    role: "WebArea",
    name: "Page",
    children: [
      {
        role: "group",
        name: "A",
        children: [
          { role: "button", name: "a1" },
          { role: "button", name: "a2" },
        ],
      },
      {
        role: "group",
        name: "B",
        children: [{ role: "button", name: "b1" }],
      },
    ],
  };
}

describe("pruning keeps what a question is most likely about", () => {
  it("protects alerts, dialogs, status messages and headings by default", () => {
    expect(DEFAULT_KEEP_ROLES).toEqual([
      "alert",
      "alertdialog",
      "dialog",
      "status",
      "heading",
    ]);
  });

  it("keeps a deep alert and removes its unprotected siblings first", () => {
    const tree: AccessibilityNode = {
      role: "main",
      name: "Checkout",
      children: [
        { role: "button", name: "Back" },
        {
          role: "region",
          name: "Payment",
          children: [
            {
              role: "group",
              name: "Card",
              children: [
                { role: "textbox", name: "Card number" },
                { role: "alert", name: "Card declined" },
              ],
            },
          ],
        },
        { role: "button", name: "Pay" },
      ],
    };
    const pruned = pruneSnapshot(tree, { maxNodes: 4 });
    expect(pruned.nodeCount).toBe(4);
    expect(namesOf(pruned.snapshot)).toEqual([
      "Checkout",
      "Payment",
      "Card",
      "Card declined",
    ]);
    // Today's order would have removed the alert before either button.
    const plain = pruneSnapshot(tree, { maxNodes: 4, keepRoles: [] });
    expect(namesOf(plain.snapshot)).not.toContain("Card declined");
  });

  it("keeps a heading over a paragraph that is deeper than it", () => {
    const tree: AccessibilityNode = {
      role: "main",
      name: "Order",
      children: [
        { role: "heading", name: "Order confirmed", level: 1 },
        {
          role: "region",
          name: "Details",
          children: [{ role: "paragraph", name: "Ships Monday" }],
        },
      ],
    };
    const pruned = pruneSnapshot(tree, { maxNodes: 3 });
    expect(namesOf(pruned.snapshot)).toEqual([
      "Order",
      "Order confirmed",
      "Details",
    ]);
  });

  it("keeps a heading nested below a shallower paragraph", () => {
    const tree: AccessibilityNode = {
      role: "main",
      name: "Order",
      children: [
        { role: "paragraph", name: "Ships Monday" },
        {
          role: "region",
          name: "Summary",
          children: [{ role: "heading", name: "Order confirmed", level: 2 }],
        },
      ],
    };
    const pruned = pruneSnapshot(tree, { maxNodes: 3 });
    expect(namesOf(pruned.snapshot)).toEqual([
      "Order",
      "Summary",
      "Order confirmed",
    ]);
    const plain = pruneSnapshot(tree, { maxNodes: 3, keepRoles: [] });
    expect(namesOf(plain.snapshot)).toEqual([
      "Order",
      "Ships Monday",
      "Summary",
    ]);
  });

  it("lets keepRoles replace the default list", () => {
    const tree: AccessibilityNode = {
      role: "main",
      name: "Shop",
      children: [
        { role: "heading", name: "Basket" },
        {
          role: "list",
          name: "Items",
          children: [{ role: "link", name: "Tea" }],
        },
      ],
    };
    const pruned = pruneSnapshot(tree, { maxNodes: 3, keepRoles: ["link"] });
    expect(namesOf(pruned.snapshot)).toEqual(["Shop", "Items", "Tea"]);
  });

  it("still cuts protected nodes past maxDepth", () => {
    const tree: AccessibilityNode = {
      role: "main",
      name: "m",
      children: [
        { role: "group", name: "g", children: [{ role: "alert", name: "a" }] },
      ],
    };
    const pruned = pruneSnapshot(tree, { maxDepth: 1 });
    expect(namesOf(pruned.snapshot)).toEqual(["m", "g"]);
    expect(pruned.truncated).toBe(true);
  });

  it("gives byte-identical results to the previous pruner when keepRoles is []", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = seededRandom(seed);
      const tree = randomTree(random, { rootText: false });
      const options: PruneOptions = {
        maxNodes: 1 + Math.floor(random() * 40),
        maxDepth: Math.floor(random() * 8),
        maxTokens: 12 + Math.floor(random() * 300),
      };
      const before = previousPruneSnapshot(tree, options);
      const after = pruneSnapshot(tree, { ...options, keepRoles: [] });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    }
  });

  it("meets the budgets, is deterministic, and removes protected nodes last", () => {
    let returned = 0;
    let thrown = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = seededRandom(seed * 7919);
      const tree = randomTree(random, { rootText: true });
      const deepEnough = seed % 2 === 0;
      const maxNodes = 1 + Math.floor(random() * 40);
      const maxTokens = 2 + Math.floor(random() * 300);
      const options: PruneOptions = {
        maxNodes,
        maxDepth: deepEnough ? 64 : Math.floor(random() * 8),
        maxTokens,
      };
      let pruned;
      try {
        pruned = pruneSnapshot(tree, options);
      } catch (error) {
        thrown += 1;
        expect(error).toBeInstanceOf(SnapshotError);
        // Only a root that does not fit even bare may fail.
        expect(estimateSnapshotTokens({ role: tree.role })).toBeGreaterThan(
          maxTokens,
        );
        continue;
      }
      returned += 1;
      expect(pruned.approxTokens).toBeLessThanOrEqual(maxTokens);
      expect(pruned.nodeCount).toBeLessThanOrEqual(maxNodes);
      expect(pruned.approxTokens).toBe(estimateSnapshotTokens(pruned.snapshot));
      expect(pruned.nodeCount).toBe(namesOf(pruned.snapshot).length);
      expect(pruneSnapshot(tree, options)).toEqual(pruned);

      if (deepEnough) {
        // Every generated node survives projection unchanged, so names
        // identify nodes. No protected node may be gone while an
        // unprotected one is still there.
        const kept = new Set(namesOf(pruned.snapshot));
        const { protectedNames, unprotectedNames } = classify(tree);
        const lostProtected = protectedNames.some((name) => !kept.has(name));
        const keptUnprotected = unprotectedNames.some((name) => kept.has(name));
        expect(lostProtected && keptUnprotected).toBe(false);
      }
    }
    expect(returned).toBeGreaterThan(300);
    expect(thrown).toBeGreaterThan(0);
  });
});

describe("pruning never joins a secret together", () => {
  const words = [
    "abandon",
    "ability",
    "able",
    "about",
    "above",
    "absent",
    "absorb",
    "abstract",
    "absurd",
    "abuse",
    "access",
    "accident",
  ];

  it("throws RedactionError when removing a node joins a seed phrase", () => {
    const tree: AccessibilityNode = {
      role: "main",
      children: [
        { role: "paragraph", name: words.slice(0, 6).join(" ") },
        {
          role: "list",
          children: [
            { role: "listitem", name: "zebra-crossing xylophone quixotic" },
          ],
        },
        { role: "paragraph", name: words.slice(6).join(" ") },
      ],
    };
    expect(() => pruneSnapshot(tree, { maxNodes: 4, keepRoles: [] })).toThrow(
      RedactionError,
    );
  });

  it("throws RedactionError rather than return a root cut down to a secret", () => {
    // 100 hex characters are not a 64-character key, but a 64-character
    // prefix of them is. The token estimate is a quarter of the JSON length,
    // so with "ID " in front some budget cuts the name to exactly that.
    const root: AccessibilityNode = {
      role: "main",
      name: `ID ${"a".repeat(100)}`,
    };
    const key = /\b[a-f0-9]{64}\b/;
    let refused = 0;
    for (let maxTokens = 10; maxTokens <= 40; maxTokens += 1) {
      try {
        const pruned = pruneSnapshot(root, { maxTokens });
        expect(pruned.snapshot.name ?? "").not.toMatch(key);
      } catch (error) {
        expect(error).toBeInstanceOf(RedactionError);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe("the token budget is always met, or pruning fails", () => {
  it("shortens a huge root description", () => {
    const pruned = pruneSnapshot(
      { role: "main", name: "Docs", description: "lorem ".repeat(20_000) },
      { maxTokens: 100 },
    );
    expect(pruned.approxTokens).toBeLessThanOrEqual(100);
    expect(pruned.truncated).toBe(true);
    expect(pruned.snapshot.description?.length).toBeGreaterThan(0);
  });

  it("drops the root name before it touches the description", () => {
    const pruned = pruneSnapshot(
      {
        role: "main",
        name: "n".repeat(400),
        description: "d".repeat(400),
      },
      { maxTokens: 50 },
    );
    expect(pruned.snapshot.name).toBeUndefined();
    expect(pruned.snapshot.description).toMatch(/^d+$/);
    expect(pruned.approxTokens).toBeLessThanOrEqual(50);
  });

  it("shortens a huge string value and removes children first", () => {
    const pruned = pruneSnapshot(
      {
        role: "textbox",
        value: "v".repeat(100_000),
        children: [{ role: "button", name: "Clear" }],
      },
      { maxTokens: 40 },
    );
    expect(pruned.approxTokens).toBeLessThanOrEqual(40);
    expect(pruned.nodeCount).toBe(1);
    expect(pruned.snapshot.value).toMatch(/^v+$/);
  });

  it("shortens valuetext before roledescription", () => {
    const slider: AccessibilityNode = {
      role: "slider",
      value: 3,
      valuetext: "t".repeat(200),
      roledescription: "r".repeat(200),
    };
    const pruned = pruneSnapshot(slider, { maxTokens: 70 });
    expect(pruned.snapshot.valuetext).toMatch(/^t+$/);
    expect(pruned.snapshot.roledescription).toBe("r".repeat(200));
    expect(pruned.approxTokens).toBeLessThanOrEqual(70);

    const tighter = pruneSnapshot(slider, { maxTokens: 15 });
    expect(tighter.snapshot.valuetext).toBeUndefined();
    expect(tighter.snapshot.roledescription).toMatch(/^r+$/);
    expect(tighter.approxTokens).toBeLessThanOrEqual(15);
  });

  it("shortens the root URL before it touches the name", () => {
    const link: AccessibilityNode = {
      role: "link",
      name: "n".repeat(200),
      url: `/${"u".repeat(200)}`,
    };
    const pruned = pruneSnapshot(link, { maxTokens: 70 });
    expect(pruned.snapshot.url).toMatch(/^\/u+$/);
    expect(pruned.snapshot.name).toBe("n".repeat(200));
    expect(pruned.truncated).toBe(true);
    expect(pruned.approxTokens).toBeLessThanOrEqual(70);

    const tighter = pruneSnapshot(link, { maxTokens: 20 });
    expect(tighter.snapshot.url).toBeUndefined();
    expect(tighter.snapshot.name).toMatch(/^n+$/);
    expect(tighter.approxTokens).toBeLessThanOrEqual(20);
  });

  it("does not split a surrogate pair when it shortens", () => {
    const pruned = pruneSnapshot(
      { role: "main", name: "😀".repeat(200) },
      { maxTokens: 30 },
    );
    const name = pruned.snapshot.name ?? "";
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(/^(?:😀)+$/u);
    expect(pruned.approxTokens).toBeLessThanOrEqual(30);
  });

  it("throws SnapshotError naming the budget when even the bare root is too big", () => {
    expect(() =>
      pruneSnapshot({ role: "r".repeat(400), name: "x" }, { maxTokens: 20 }),
    ).toThrow(/20 tokens/);
    expect(() =>
      pruneSnapshot({ role: "r".repeat(400) }, { maxTokens: 20 }),
    ).toThrow(SnapshotError);
    // A field that is not shortened must not be described as removed.
    expect(() =>
      pruneSnapshot(
        { role: "textbox", invalid: "x".repeat(400) },
        { maxTokens: 20 },
      ),
    ).toThrow(/name, description, valuetext, string value and roledescription/);
  });

  it("validates the budgets", () => {
    const tree: AccessibilityNode = { role: "main" };
    const bad: readonly [PruneOptions, RegExp][] = [
      [{ maxNodes: 0 }, /maxNodes/],
      [{ maxNodes: 1.5 }, /maxNodes/],
      [{ maxNodes: Number.NaN }, /maxNodes/],
      [{ maxDepth: -1 }, /maxDepth/],
      [{ maxDepth: 0.5 }, /maxDepth/],
      [{ maxDepth: Infinity }, /maxDepth/],
      [{ maxTokens: 0 }, /maxTokens/],
      [{ maxTokens: -3 }, /maxTokens/],
      [{ maxTokens: Infinity }, /maxTokens/],
      [{ maxTokens: Number.NaN }, /maxTokens/],
    ];
    for (const [options, message] of bad) {
      expect(() => pruneSnapshot(tree, options)).toThrow(SnapshotError);
      expect(() => pruneSnapshot(tree, options)).toThrow(message);
    }
    for (const keepRoles of ["alert", [3], { 0: "alert" }]) {
      const options = { keepRoles } as unknown as PruneOptions;
      expect(() => pruneSnapshot(tree, options)).toThrow(SnapshotError);
      expect(() => pruneSnapshot(tree, options)).toThrow(/keepRoles/);
    }
    expect(
      pruneSnapshot(tree, { maxNodes: 1, maxDepth: 0, maxTokens: 4 }),
    ).toEqual({
      snapshot: { role: "main" },
      truncated: false,
      nodeCount: 1,
      approxTokens: 4,
    });
  });
});

function namesOf(node: AccessibilityNode): string[] {
  return [
    node.name ?? "",
    ...(node.children ?? []).flatMap((child) => namesOf(child)),
  ];
}

/** mulberry32: small, seeded, and the same on every platform. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roles that normalisation keeps as they are, so names identify nodes. */
const RANDOM_ROLES = [
  "button",
  "link",
  "list",
  "listitem",
  "group",
  "paragraph",
  "region",
  "textbox",
  "alert",
  "heading",
  "status",
  "dialog",
  "alertdialog",
] as const;

function randomTree(
  random: () => number,
  settings: { readonly rootText: boolean },
): AccessibilityNode {
  let next = 0;
  const build = (depth: number): AccessibilityNode => {
    const id = next;
    next += 1;
    const role =
      RANDOM_ROLES[Math.floor(random() * RANDOM_ROLES.length)] ?? "group";
    const count = depth >= 6 ? 0 : Math.floor(random() * (depth === 0 ? 6 : 4));
    const children = Array.from({ length: count }, () => build(depth + 1));
    const words = Math.floor(random() * 6);
    const name = `n${String(id)}${" lorem".repeat(words)}`;
    return children.length === 0 ? { role, name } : { role, name, children };
  };
  const tree = build(0);
  if (!settings.rootText) return tree;
  const filler = (length: number): string => "abc def ".repeat(length);
  const longRole = random() < 0.1;
  return {
    ...tree,
    role: longRole ? `${"r".repeat(Math.floor(random() * 40))}x` : tree.role,
    ...(random() < 0.4
      ? { description: filler(Math.floor(random() * 200)) }
      : {}),
    ...(random() < 0.3 ? { value: filler(Math.floor(random() * 200)) } : {}),
    ...(random() < 0.2 ? { valuetext: filler(Math.floor(random() * 50)) } : {}),
    ...(random() < 0.2
      ? { roledescription: filler(Math.floor(random() * 50)) }
      : {}),
  };
}

function classify(tree: AccessibilityNode): {
  protectedNames: string[];
  unprotectedNames: string[];
} {
  const keep = new Set(DEFAULT_KEEP_ROLES);
  const protectedNames: string[] = [];
  const unprotectedNames: string[] = [];
  const visit = (node: AccessibilityNode, underKeep: boolean): boolean => {
    const self = keep.has(node.role);
    let containsKeep = self;
    for (const child of node.children ?? []) {
      containsKeep = visit(child, underKeep || self) || containsKeep;
    }
    if (node !== tree) {
      const isProtected = underKeep || containsKeep;
      (isProtected ? protectedNames : unprotectedNames).push(node.name ?? "");
    }
    return containsKeep;
  };
  visit(tree, false);
  return { protectedNames, unprotectedNames };
}

/**
 * The pruner as it was before keep roles, kept verbatim as the reference for
 * the differential test.
 */
function previousPruneSnapshot(
  snapshot: AccessibilityNode,
  options: PruneOptions,
): {
  snapshot: AccessibilityNode;
  truncated: boolean;
  nodeCount: number;
  approxTokens: number;
} {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxTokens = options.maxTokens ?? snapshotTokenBudget(options.deciderId);
  let tree = projectSnapshot(snapshot, options);
  const cut = oldCutDepth(tree, 0, maxDepth);
  tree = cut.node;
  let truncated = cut.truncated;

  const order = oldRemovalOrder(tree);
  const total = order.length + 1;
  const fits = (candidate: AccessibilityNode, count: number): boolean =>
    count <= maxNodes && estimateSnapshotTokens(candidate) <= maxTokens;

  if (!fits(tree, total)) {
    truncated = true;
    let low = Math.min(Math.max(total - maxNodes, 1), order.length);
    let high = order.length;
    let best: AccessibilityNode | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = oldRemoveFirst(tree, order, mid);
      if (fits(candidate, total - mid)) {
        best = candidate;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    tree =
      best ??
      oldShortenRoot(oldRemoveFirst(tree, order, order.length), maxTokens);
  }

  return {
    snapshot: tree,
    truncated,
    nodeCount: oldCountNodes(tree),
    approxTokens: estimateSnapshotTokens(tree),
  };
}

function oldCutDepth(
  node: AccessibilityNode,
  depth: number,
  maxDepth: number,
): { node: AccessibilityNode; truncated: boolean } {
  if (depth >= maxDepth) {
    const hadChildren = (node.children?.length ?? 0) > 0;
    return { node: oldOmitKey(node, "children"), truncated: hadChildren };
  }
  let truncated = false;
  const children: AccessibilityNode[] = [];
  for (const child of node.children ?? []) {
    const cut = oldCutDepth(child, depth + 1, maxDepth);
    children.push(cut.node);
    truncated = truncated || cut.truncated;
  }
  return { node: oldWithChildren(node, children), truncated };
}

function oldRemovalOrder(root: AccessibilityNode): AccessibilityNode[] {
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

function oldRemoveFirst(
  root: AccessibilityNode,
  order: readonly AccessibilityNode[],
  count: number,
): AccessibilityNode {
  const removed = new Set(order.slice(0, count));
  const rebuild = (node: AccessibilityNode): AccessibilityNode => {
    const children = (node.children ?? [])
      .filter((child) => !removed.has(child))
      .map(rebuild);
    return oldWithChildren(node, children);
  };
  return rebuild(root);
}

function oldShortenRoot(
  node: AccessibilityNode,
  maxTokens: number,
): AccessibilityNode {
  const name = node.name;
  if (name === undefined || name.length === 0) return node;
  let low = 0;
  let high = name.length;
  let best = oldOmitKey(node, "name");
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate =
      mid === 0
        ? oldOmitKey(node, "name")
        : { ...oldOmitKey(node, "name"), name: name.slice(0, mid) };
    if (estimateSnapshotTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function oldOmitKey(
  node: AccessibilityNode,
  key: keyof AccessibilityNode,
): AccessibilityNode {
  const copy: AccessibilityNode = { ...node };
  Reflect.deleteProperty(copy, key);
  return copy;
}

function oldWithChildren(
  node: AccessibilityNode,
  children: readonly AccessibilityNode[],
): AccessibilityNode {
  const base = oldOmitKey(node, "children");
  if (children.length === 0) return base;
  return { ...base, children: [...children] };
}

function oldCountNodes(node: AccessibilityNode): number {
  return (
    1 +
    (node.children ?? []).reduce((sum, child) => sum + oldCountNodes(child), 0)
  );
}
