import { describe, expect, it } from "vitest";
import { SnapshotError } from "./errors.js";
import { hashSnapshot } from "./hash.js";
import { normaliseSnapshot } from "./normalise.js";
import { redactSnapshot } from "./redact.js";
import type { AccessibilityNode } from "./snapshot.js";
import {
  MAX_SNAPSHOT_DEPTH,
  MAX_SNAPSHOT_NODES,
  validateSnapshot,
} from "./validate.js";

/** Lets a test build shapes the type system rightly forbids. */
function malformed(value: unknown): AccessibilityNode {
  return value as AccessibilityNode;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    return (error as Error).message;
  }
  throw new Error("expected a SnapshotError");
}

const ENTRY_POINTS: readonly [string, (node: AccessibilityNode) => unknown][] =
  [
    [
      "validateSnapshot",
      (node) => {
        validateSnapshot(node);
      },
    ],
    ["redactSnapshot", (node) => redactSnapshot(node)],
    ["normaliseSnapshot", (node) => normaliseSnapshot(node)],
    ["hashSnapshot", (node) => hashSnapshot(node)],
  ];

describe("snapshot validation", () => {
  it("accepts a well-formed tree", () => {
    expect(() => {
      validateSnapshot({
        role: "main",
        name: "Checkout",
        value: 3,
        children: [{ role: "textbox", value: "x", autocomplete: "email" }],
      });
    }).not.toThrow();
  });

  const cases: readonly [string, unknown, RegExp][] = [
    ["a null root", null, /root.*null/],
    ["an array root", [], /root.*array/],
    ["a string root", "button", /root.*string/],
    ["a missing role", {}, /root.*role/],
    ["an empty role", { role: "" }, /role/],
    ["a numeric role", { role: 4 }, /role/],
    [
      "a null child",
      { role: "main", children: [{ role: "list" }, null] },
      /children\[1\].*null/,
    ],
    [
      "a nested primitive child",
      {
        role: "main",
        children: [
          { role: "list" },
          { role: "list" },
          { role: "list", children: [7] },
        ],
      },
      /children\[2\]\.children\[0\].*number/,
    ],
    [
      "children that are not an array",
      { role: "main", children: { role: "x" } },
      /children.*array/,
    ],
    ["a NaN value", { role: "slider", value: Number.NaN }, /value/],
    ["an infinite value", { role: "slider", value: Infinity }, /value/],
    ["an object value", { role: "textbox", value: {} }, /value/],
    ["a null value", { role: "textbox", value: null }, /value/],
  ];

  for (const [label, input, message] of cases) {
    it(`rejects ${label} with a SnapshotError at every entry point`, () => {
      for (const [, entry] of ENTRY_POINTS) {
        expect(messageOf(() => entry(malformed(input)))).toMatch(message);
      }
    });
  }

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
    "url",
  ] as const;

  for (const field of STRING_FIELDS) {
    it(`rejects a non-string ${field}`, () => {
      const input = {
        role: "main",
        children: [{ role: "button", [field]: 12 }],
      };
      for (const [, entry] of ENTRY_POINTS) {
        const message = messageOf(() => entry(malformed(input)));
        expect(message).toContain(field);
        expect(message).toContain("children[0]");
      }
    });
  }

  it("describes the offending value in plain English", () => {
    expect(
      messageOf(() => {
        validateSnapshot(malformed({ role: "main", children: { role: "x" } }));
      }),
    ).toContain("children that are an object, not an array");
    expect(
      messageOf(() => {
        validateSnapshot(malformed({ role: "main", value: {} }));
      }),
    ).toContain("value that is an object");
    // A hole in a sparse array reads as undefined.
    const holed: unknown[] = [];
    holed[1] = { role: "x" };
    expect(
      messageOf(() => {
        validateSnapshot(malformed({ role: "main", children: holed }));
      }),
    ).toMatch(/children\[0\] is undefined, not an object/);
  });

  it("treats an explicitly undefined field as absent", () => {
    expect(() => {
      validateSnapshot({ role: "button", name: undefined });
    }).not.toThrow();
  });

  it("raises SnapshotError, not TypeError, for the null child that used to crash", () => {
    const input = malformed({ role: "main", children: [null] });
    expect(() => redactSnapshot(input)).toThrow(SnapshotError);
    expect(() => hashSnapshot(input)).toThrow(SnapshotError);
  });
});

describe("shared nodes, cycles and depth", () => {
  it("treats the same object in two places as two nodes", () => {
    const shared: AccessibilityNode = { role: "button", name: "Pay" };
    const tree: AccessibilityNode = {
      role: "main",
      children: [shared, { role: "group", name: "g", children: [shared] }],
    };
    const copy = structuredClone(tree);
    expect(() => {
      validateSnapshot(tree);
    }).not.toThrow();
    expect(redactSnapshot(tree)).toEqual(redactSnapshot(copy));
    expect(normaliseSnapshot(tree)).toEqual(normaliseSnapshot(copy));
    expect(hashSnapshot(tree)).toBe(hashSnapshot(copy));
  });

  it("rejects a node that is its own ancestor", () => {
    const loop: { role: string; children: unknown[] } = {
      role: "group",
      children: [],
    };
    const tree = {
      role: "main",
      children: [{ role: "list", children: [loop] }],
    };
    loop.children.push(tree);
    for (const [, entry] of ENTRY_POINTS) {
      expect(messageOf(() => entry(malformed(tree)))).toMatch(
        /cycle.*children\[0\]\.children\[0\]\.children\[0\]/,
      );
    }
  });

  it("rejects a node that is its own child", () => {
    const self: { role: string; children: unknown[] } = {
      role: "group",
      children: [],
    };
    self.children.push(self);
    expect(messageOf(() => redactSnapshot(malformed(self)))).toMatch(/cycle/);
  });

  it("accepts a tree exactly MAX_SNAPSHOT_DEPTH deep and rejects one deeper", () => {
    expect(MAX_SNAPSHOT_DEPTH).toBe(512);
    expect(() => {
      validateSnapshot(chain(MAX_SNAPSHOT_DEPTH));
    }).not.toThrow();
    expect(() => hashSnapshot(chain(MAX_SNAPSHOT_DEPTH))).not.toThrow();
    expect(
      messageOf(() => {
        validateSnapshot(chain(MAX_SNAPSHOT_DEPTH + 1));
      }),
    ).toMatch(/deeper than 512/);
  });

  it("rejects a 100,000-deep chain quickly with SnapshotError, not RangeError", () => {
    const deep = chain(100_000);
    for (const [, entry] of ENTRY_POINTS) {
      const started = performance.now();
      expect(() => entry(deep)).toThrow(SnapshotError);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("keeps the too-deep message short enough to read", () => {
    // Spelling out 513 path segments would bury the problem in ~7 KB.
    const message = messageOf(() => {
      validateSnapshot(chain(100_000));
    });
    expect(message).toMatch(/deeper than 512 levels/);
    expect(message).toMatch(/depth 513/);
    expect(message.length).toBeLessThan(300);
  });

  it("validates heavily shared subtrees without walking every path", () => {
    // 16 levels where each level references the next twice: 131,071 nodes
    // once expanded (under MAX_SNAPSHOT_NODES), but only 17 distinct objects.
    // Validation must not walk every path.
    let node: AccessibilityNode = { role: "button", name: "leaf" };
    for (let level = 0; level < 16; level += 1) {
      node = { role: "group", children: [node, node] };
    }
    const started = performance.now();
    expect(() => {
      validateSnapshot(node);
    }).not.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("rejects a tree that reuses nodes into more than MAX_SNAPSHOT_NODES", () => {
    // 40 objects, each holding the next one twice: 2^40 nodes once expanded.
    // Redaction and normalisation would walk every one of them.
    let node: AccessibilityNode = { role: "text", name: "leaf" };
    for (let level = 0; level < 40; level += 1) {
      node = { role: "group", children: [node, node] };
    }
    const started = performance.now();
    expect(() => hashSnapshot(node)).toThrow(SnapshotError);
    expect(() => hashSnapshot(node)).toThrow(/more than .* nodes/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("counts a reused node once for each place it appears", () => {
    const leaf: AccessibilityNode = { role: "text", name: "x" };
    const atLimit: AccessibilityNode = {
      role: "list",
      children: Array.from({ length: MAX_SNAPSHOT_NODES - 1 }, () => leaf),
    };
    expect(() => {
      validateSnapshot(atLimit);
    }).not.toThrow();
    const overLimit: AccessibilityNode = {
      role: "list",
      children: Array.from({ length: MAX_SNAPSHOT_NODES }, () => leaf),
    };
    expect(() => {
      validateSnapshot(overLimit);
    }).toThrow(SnapshotError);
  });

  it("finds a too-deep path through a subtree it has already seen", () => {
    // The shared tail is first met near the root, where it fits, then again
    // under a long chain, where it does not.
    const tail = chain(300);
    const tree: AccessibilityNode = {
      role: "main",
      children: [tail, wrap(tail, 300)],
    };
    expect(
      messageOf(() => {
        validateSnapshot(tree);
      }),
    ).toMatch(/deeper than 512/);
  });
});

/** `depth` edges below the root: depth 0 is a single node. */
function chain(depth: number): AccessibilityNode {
  let node: AccessibilityNode = { role: "button", name: "leaf" };
  for (let level = 0; level < depth; level += 1) {
    node = { role: "group", children: [node] };
  }
  return node;
}

function wrap(node: AccessibilityNode, times: number): AccessibilityNode {
  let wrapped = node;
  for (let level = 0; level < times; level += 1) {
    wrapped = { role: "group", children: [wrapped] };
  }
  return wrapped;
}
