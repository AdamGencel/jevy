import { describe, expect, it } from "vitest";
import { hashSnapshot } from "./hash.js";
import {
  pruneSnapshot,
  snapshotTokenBudget,
  KEV_SNAPSHOT_TOKEN_BUDGET,
  DEFAULT_SNAPSHOT_TOKEN_BUDGET,
} from "./prune.js";
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
