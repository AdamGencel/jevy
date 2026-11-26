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
    hash: "sha256:301fd5299f34811243a666eaffa4f000a5b239909d2ca90efc2bb4502827ea3d",
  },
  {
    name: "a page with an email address",
    snapshot: {
      role: "WebArea",
      name: "Account",
      children: [{ role: "paragraph", name: "Signed in as ada@example.com" }],
    },
    hash: "sha256:530d920e317d6083f8944b2b84bcde08d88208f3e60fb83f079af4e6276dcc9c",
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
    hash: "sha256:e8db12d93e75506a6da181b7d5d377e41ca5506d37a219ec5bfb96692c42c6a7",
  },
  {
    name: "a seed phrase shown one word per node",
    snapshot: seedPage(SEED_WORDS),
    hash: "sha256:22255645b4cf1ae42f8e6fb19079d7cf9c5b06fc0e0d6be035fa0ca5a6c23d2f",
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
    hash: "sha256:deea4be5e40ff385da9a265ffd49b05d506cfeaaaea01561c2f9769b7e807df4",
  },
  {
    name: "text with a timestamp, a UUID and a long digit run",
    snapshot: {
      role: "status",
      name: "Order 123456789 (550e8400-e29b-41d4-a716-446655440000) placed 2026-11-18T09:30:00Z",
    },
    hash: "sha256:a14ffcd3a732eaf5ba512d8d56643128863a4f2b84f4abee6162c38a4ef5cebf",
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
    hash: "sha256:135a0f3e61bc1844c7985fb8a9b6bdb295d8f654c9194974a08a93f1d0e28e64",
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
    hash: "sha256:753c7ec36a783c8a40c21c73b657af2b43f8175dd63014160d05e785b19a4926",
  },
  {
    name: "a link with a query string and a fragment",
    snapshot: {
      role: "navigation",
      name: "Account",
      children: [
        {
          role: "link",
          name: "Orders",
          url: "https://shop.example/orders?session=abc123#recent",
        },
        { role: "link", name: "Sign out", url: "/logout" },
      ],
    },
    hash: "sha256:95b4e87371ea20ae6fdda928d78f8fb5df3efc3a869068c2234e86e9ba98a83d",
  },
];

describe("golden snapshot hashes", () => {
  it("is pinned to the current hash and rules versions", () => {
    // Change these together with the literals, never alone.
    expect(SNAPSHOT_HASH_VERSION).toBe(2);
    expect(SNAPSHOT_RULES_VERSION).toBe(3);
  });

  for (const golden of GOLDEN) {
    it(`hashes ${golden.name} to its golden value`, () => {
      expect(hashSnapshot(golden.snapshot, golden.options)).toBe(golden.hash);
    });
  }

  it("lets the link's address change the hash", () => {
    const link = GOLDEN.find((golden) => golden.name.startsWith("a link"));
    expect(link).toBeDefined();
    expect(
      hashSnapshot({
        role: "navigation",
        name: "Account",
        children: [
          { role: "link", name: "Orders", url: "https://shop.example/refunds" },
          { role: "link", name: "Sign out", url: "/logout" },
        ],
      }),
    ).not.toBe(link?.hash);
  });

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
    hashOf("a link with a query string and a fragment", {
      role: "navigation",
      name: "Account",
      children: [
        {
          role: "link",
          name: "Orders",
          url: "https://ada:pw@shop.example/orders?session=zzz",
        },
        { role: "link", name: "Sign out", url: "/logout#top" },
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
