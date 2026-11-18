/**
 * Golden snapshot hashes.
 *
 * If this test fails because a built-in redaction or normalisation rule was
 * changed on purpose, bump SNAPSHOT_RULES_VERSION in project.ts and then
 * regenerate the literals below. Never regenerate them without the bump:
 * every user's committed decision cache is keyed on these hashes, and a
 * silent change would turn their cached verdicts into misses (or, worse,
 * hits for a tree that now means something else) with no stated reason.
 *
 * If it fails and you did not mean to change a rule, the change is a bug.
 */
import { describe, expect, it } from "vitest";
import { hashSnapshot } from "./hash.js";
import { SNAPSHOT_HASH_VERSION, SNAPSHOT_RULES_VERSION } from "./project.js";
import type { SnapshotProcessOptions } from "./project.js";
import type { AccessibilityNode } from "./snapshot.js";

interface Golden {
  readonly name: string;
  readonly snapshot: AccessibilityNode;
  readonly options?: SnapshotProcessOptions;
  readonly hash: string;
}

const SEED_WORDS = [
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
] as const;

const seedPage = (words: readonly string[]): AccessibilityNode => ({
  role: "WebArea",
  name: "Back up your wallet",
  children: [
    { role: "heading", name: "Your recovery phrase", level: 1 },
    {
      role: "list",
      children: words.map((word) => ({ role: "listitem", name: word })),
    },
    { role: "button", name: "I have written it down" },
  ],
});

const GOLDEN: readonly Golden[] = [
  {
    name: "a plain page",
    snapshot: {
      role: "WebArea",
      name: "Checkout",
      children: [
        { role: "heading", name: "Checkout", level: 1 },
        { role: "checkbox", name: "Agree to terms", checked: false },
        { role: "button", name: "Pay", disabled: true },
      ],
    },
    hash: "sha256:2c51bb2f79c17430171704575df119f188f826b3683634b3a981e3fe72be112c",
  },
  {
    name: "a page with an email address",
    snapshot: {
      role: "WebArea",
      name: "Account",
      children: [{ role: "paragraph", name: "Signed in as ada@example.com" }],
    },
    hash: "sha256:dac5ad2deab714a1a1db4a8cbe212e93ae0db0679d1699b323f16e98f84a91c8",
  },
  {
    name: "a password textbox",
    snapshot: {
      role: "form",
      name: "Sign in",
      children: [
        { role: "textbox", name: "Username", value: "ada" },
        { role: "textbox", name: "Password", value: "hunter2" },
      ],
    },
    hash: "sha256:44c55bf2e0c61f1f21972d36f91fc61ec2e5da28e5f116df2212abfa230c02e9",
  },
  {
    name: "a seed phrase shown one word per node",
    snapshot: seedPage(SEED_WORDS),
    hash: "sha256:5988c3cce094993fea5898beb8227df5346988145efe127a0e7e63ce24a39559",
  },
  {
    name: "a 0x private key",
    snapshot: {
      role: "dialog",
      name: "Export key",
      children: [
        {
          role: "paragraph",
          name: "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
        },
      ],
    },
    hash: "sha256:e343b04de765605594439b7ba58115cdc3e24d13db2a960639d593b2343fdf8a",
  },
  {
    name: "text with a timestamp, a UUID and a long digit run",
    snapshot: {
      role: "status",
      name: "Order 123456789 (550e8400-e29b-41d4-a716-446655440000) placed 2026-11-18T09:30:00Z",
    },
    hash: "sha256:5b7782bcd1164f9174b0b40a4566913f447f0de057cc240b0d11d6ec1cdf61db",
  },
  {
    name: "an unnamed generic wrapper that gets unwrapped",
    snapshot: {
      role: "main",
      children: [
        {
          role: "generic",
          children: [
            { role: "link", name: "Home" },
            { role: "link", name: "Orders" },
          ],
        },
      ],
    },
    hash: "sha256:2f4889a8a0c7f5703fc113e61f59e76b7f7296f51111a5c1271bc6312c1e6a46",
  },
  {
    name: "a region slice",
    snapshot: {
      role: "WebArea",
      name: "Store",
      children: [
        { role: "navigation", name: "Main", children: [] },
        {
          role: "region",
          name: "Basket",
          children: [
            { role: "listitem", name: "Tea" },
            { role: "button", name: "Check out" },
          ],
        },
      ],
    },
    options: { region: { role: "region", name: "Basket" } },
    hash: "sha256:1de6456c85d64bd771ae3fa41135745ed89f33c6533030eb87633b81e3bd9ecb",
  },
];

describe("golden snapshot hashes", () => {
  it("is pinned to the current hash and rules versions", () => {
    // Change these together with the literals, never alone.
    expect(SNAPSHOT_HASH_VERSION).toBe(2);
    expect(SNAPSHOT_RULES_VERSION).toBe(2);
  });

  for (const golden of GOLDEN) {
    it(`hashes ${golden.name} to its golden value`, () => {
      expect(hashSnapshot(golden.snapshot, golden.options)).toBe(golden.hash);
    });
  }

  // The fixtures above only pin something if the rule they name really ran.
  it("exercises the rule each fixture names", () => {
    const byName = new Map(GOLDEN.map((golden) => [golden.name, golden]));
    const hashOf = (name: string, change: AccessibilityNode): void => {
      const golden = byName.get(name);
      expect(golden).toBeDefined();
      expect(hashSnapshot(change, golden?.options)).toBe(golden?.hash);
    };
    hashOf("a page with an email address", {
      role: "WebArea",
      name: "Account",
      children: [{ role: "paragraph", name: "Signed in as bob@example.org" }],
    });
    hashOf("a password textbox", {
      role: "form",
      name: "Sign in",
      children: [
        { role: "textbox", name: "Username", value: "ada" },
        { role: "textbox", name: "Password", value: "correct horse" },
      ],
    });
    hashOf(
      "a seed phrase shown one word per node",
      seedPage([...SEED_WORDS].reverse()),
    );
    hashOf("a 0x private key", {
      role: "dialog",
      name: "Export key",
      children: [{ role: "paragraph", name: `0x${"ab".repeat(32)}` }],
    });
    hashOf("text with a timestamp, a UUID and a long digit run", {
      role: "status",
      name: "Order 987654321 (6ba7b810-9dad-11d1-80b4-00c04fd430c8) placed 2025-01-02T03:04:05Z",
    });
    hashOf("an unnamed generic wrapper that gets unwrapped", {
      role: "main",
      children: [
        { role: "link", name: "Home" },
        { role: "link", name: "Orders" },
      ],
    });
    hashOf("a region slice", {
      role: "region",
      name: "Basket",
      children: [
        { role: "listitem", name: "Tea" },
        { role: "button", name: "Check out" },
      ],
    });
  });
});
