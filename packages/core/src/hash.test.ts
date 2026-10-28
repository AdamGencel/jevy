import { describe, expect, it } from "vitest";
import { SnapshotError } from "./errors.js";
import { hashSnapshot } from "./hash.js";
import type { AccessibilityNode } from "./snapshot.js";

const checkout: AccessibilityNode = {
  role: "WebArea",
  name: "Checkout",
  children: [
    { role: "heading", name: "Checkout", level: 1 },
    { role: "button", name: "Pay" },
  ],
};

describe("snapshot hash", () => {
  it("gives the same page the same hash", () => {
    const reordered: AccessibilityNode = {
      name: "Checkout",
      children: [
        { level: 1, name: "Checkout", role: "heading" },
        { name: "Pay", role: "button", children: [] },
      ],
      role: "WebArea",
    };
    const spaced: AccessibilityNode = {
      role: "WebArea",
      name: "  Checkout \n",
      children: [
        { role: "heading", name: "Checkout", level: 1 },
        { role: "button", name: "Pay" },
      ],
    };

    const hash = hashSnapshot(checkout);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashSnapshot(structuredClone(checkout))).toBe(hash);
    expect(hashSnapshot(reordered)).toBe(hash);
    expect(hashSnapshot(spaced)).toBe(hash);
    expect(hashSnapshot({ ...checkout, focused: true })).toBe(hash);
  });

  it("ignores a cosmetic change", () => {
    const stamped = (when: string): AccessibilityNode => ({
      ...checkout,
      children: [
        ...(checkout.children ?? []),
        { role: "status", name: `Updated ${when}` },
      ],
    });
    const identified = (id: string): AccessibilityNode => ({
      ...checkout,
      children: [
        ...(checkout.children ?? []),
        { role: "status", name: `Ref ${id}` },
      ],
    });
    const wrapped: AccessibilityNode = {
      role: "WebArea",
      name: "Checkout",
      children: [
        { role: "heading", name: "Checkout", level: 1 },
        {
          role: "generic",
          children: [
            {
              role: "presentation",
              children: [{ role: "button", name: "Pay", focused: true }],
            },
          ],
        },
      ],
    };

    expect(hashSnapshot(stamped("2026-10-28T01:02:03Z"))).toBe(
      hashSnapshot(stamped("2026-10-28T09:30:00.123Z")),
    );
    expect(hashSnapshot(stamped("3 seconds ago"))).toBe(
      hashSnapshot(stamped("12 minutes ago")),
    );
    expect(
      hashSnapshot(identified("550e8400-e29b-41d4-a716-446655440000")),
    ).toBe(hashSnapshot(identified("6ba7b810-9dad-11d1-80b4-00c04fd430c8")));
    expect(hashSnapshot(wrapped)).toBe(hashSnapshot(checkout));
    expect(hashSnapshot({ role: "status", name: "Order 12345678" })).toBe(
      hashSnapshot({ role: "status", name: "Order 87654321" }),
    );
  });

  it("gives a relevant change a new hash", () => {
    const renamed: AccessibilityNode = {
      ...checkout,
      children: [
        { role: "heading", name: "Checkout", level: 1 },
        { role: "button", name: "Pay now" },
      ],
    };
    const added: AccessibilityNode = {
      ...checkout,
      children: [
        ...(checkout.children ?? []),
        { role: "link", name: "Receipt" },
      ],
    };
    const unchecked: AccessibilityNode = {
      role: "checkbox",
      name: "Agree",
      checked: false,
    };
    const checked: AccessibilityNode = {
      role: "checkbox",
      name: "Agree",
      checked: true,
    };

    const original = hashSnapshot(checkout);
    expect(hashSnapshot(renamed)).not.toBe(original);
    expect(hashSnapshot(added)).not.toBe(original);
    expect(hashSnapshot(checked)).not.toBe(hashSnapshot(unchecked));
    expect(
      hashSnapshot({ role: "slider", name: "Volume", value: 10 }),
    ).not.toBe(hashSnapshot({ role: "slider", name: "Volume", value: 11 }));
    expect(hashSnapshot({ role: "status", name: "Due 2026-10-28" })).not.toBe(
      hashSnapshot({ role: "status", name: "Due 2026-11-01" }),
    );
    expect(hashSnapshot({ role: "status", name: "Order 42" })).not.toBe(
      hashSnapshot({ role: "status", name: "Order 43" }),
    );
  });

  it("hashes only the requested region", () => {
    const page: AccessibilityNode = {
      role: "WebArea",
      name: "Checkout",
      children: [
        { role: "button", name: "Pay" },
        { role: "link", name: "Help" },
      ],
    };
    const support: AccessibilityNode = {
      ...page,
      children: [
        { role: "button", name: "Pay" },
        { role: "link", name: "Support" },
      ],
    };
    const region = { role: "button", name: " Pay " } as const;

    expect(hashSnapshot(page, { region })).toBe(
      hashSnapshot({ role: "button", name: "Pay" }),
    );
    expect(hashSnapshot(page, { region })).toBe(
      hashSnapshot(support, { region }),
    );
    expect(hashSnapshot(page)).not.toBe(hashSnapshot(support));
    expect(() =>
      hashSnapshot(page, { region: { role: "button", name: "Missing" } }),
    ).toThrow(SnapshotError);
  });

  it("keeps a timestamp change when that builtin is disabled", () => {
    const left = { role: "status", name: "Updated 2026-10-28T01:02:03Z" };
    const right = { role: "status", name: "Updated 2026-10-28T09:30:00Z" };
    expect(hashSnapshot(left)).toBe(hashSnapshot(right));
    expect(
      hashSnapshot(left, { normalise: { disable: ["timestamp"] } }),
    ).not.toBe(hashSnapshot(right, { normalise: { disable: ["timestamp"] } }));
  });
});
