import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import {
  SNAPSHOT_HASH_VERSION,
  SNAPSHOT_RULES_VERSION,
  rulesFingerprint,
  snapshotDigest,
} from "./project.js";
import type { SnapshotProcessOptions } from "./project.js";
import type { RedactRule } from "./redact.js";

type Rules = Pick<SnapshotProcessOptions, "redact" | "normalise">;

describe("snapshot digest", () => {
  it("carries the hash version and the rules version", () => {
    const digest = snapshotDigest({ role: "button", name: "Pay" });
    expect(SNAPSHOT_HASH_VERSION).toBe(2);
    expect(SNAPSHOT_RULES_VERSION).toBe(2);
    expect(digest).toBe(
      '{"v":2,"rules":2,"tree":{"role":"button","name":"Pay"}}',
    );
    expect(JSON.parse(digest)).toMatchObject({
      v: SNAPSHOT_HASH_VERSION,
      rules: SNAPSHOT_RULES_VERSION,
    });
  });
});

describe("rules fingerprint", () => {
  const base: Rules = {
    redact: [
      /order-\d+/i,
      { pattern: /acct \d+/, replacement: "[acct]" },
      { role: "textbox", name: "Card", replacement: "[card]" },
      { role: "textbox", name: /^pin$/i },
    ],
    normalise: {
      disable: ["uuid", "timestamp"],
      dropRoles: ["banner", "contentinfo"],
      replace: [
        { pattern: /build \w+/, placeholder: "[build]" },
        { pattern: /v\d+/g, placeholder: "[v]" },
      ],
      unwrapUnnamedGeneric: true,
    },
  };

  it("has the sha256 shape", () => {
    expect(rulesFingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rulesFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("gives the same rules the same fingerprint", () => {
    const fingerprint = rulesFingerprint(base);
    const copy: Rules = {
      redact: [
        /order-\d+/i,
        { pattern: /acct \d+/, replacement: "[acct]" },
        { role: "textbox", name: "Card", replacement: "[card]" },
        { role: "textbox", name: /^pin$/i },
      ],
      normalise: {
        // Order of a set does not matter.
        disable: ["timestamp", "uuid"],
        dropRoles: ["contentinfo", "banner"],
        replace: [
          { pattern: /build \w+/, placeholder: "[build]" },
          { pattern: /v\d+/g, placeholder: "[v]" },
        ],
        unwrapUnnamedGeneric: true,
      },
    };
    expect(rulesFingerprint(copy)).toBe(fingerprint);
  });

  it("treats missing options as the defaults", () => {
    const empty = rulesFingerprint();
    expect(rulesFingerprint({})).toBe(empty);
    expect(rulesFingerprint({ redact: [] })).toBe(empty);
    expect(rulesFingerprint({ normalise: {} })).toBe(empty);
    expect(
      rulesFingerprint({
        normalise: {
          disable: [],
          replace: [],
          dropRoles: ["none", "presentation"],
          unwrapUnnamedGeneric: true,
        },
      }),
    ).toBe(empty);
  });

  it("ignores regex flags that matching ignores", () => {
    expect(rulesFingerprint({ redact: [/secret/gy] })).toBe(
      rulesFingerprint({ redact: [/secret/] }),
    );
    expect(rulesFingerprint({ redact: [/secret/dg] })).toBe(
      rulesFingerprint({ redact: [/secret/] }),
    );
    expect(
      rulesFingerprint({
        normalise: { replace: [{ pattern: /x/g, placeholder: "y" }] },
      }),
    ).toBe(
      rulesFingerprint({
        normalise: { replace: [{ pattern: /x/, placeholder: "y" }] },
      }),
    );
  });

  it("ignores the region", () => {
    const withRegion: SnapshotProcessOptions = {
      ...base,
      region: { role: "main" },
    };
    expect(rulesFingerprint(withRegion)).toBe(rulesFingerprint(base));
  });

  it("changes when any rule that could change a hash changes", () => {
    const fingerprint = rulesFingerprint(base);
    const redact = base.redact ?? [];
    const normalise = base.normalise ?? {};
    const variants: Rules[] = [
      // Redact: added, removed, reordered, source, flags, replacement, role, name.
      { ...base, redact: [...redact, /extra/] },
      { ...base, redact: redact.slice(1) },
      { ...base, redact: [...redact].reverse() },
      { ...base, redact: [/order-\d+/, ...redact.slice(1)] },
      { ...base, redact: [/order-\d+/im, ...redact.slice(1)] },
      { ...base, redact: [/order-\d{2}/i, ...redact.slice(1)] },
      {
        ...base,
        redact: [
          redact[0] ?? /x/,
          { pattern: /acct \d+/, replacement: "[account]" },
          ...redact.slice(2),
        ],
      },
      {
        ...base,
        redact: [redact[0] ?? /x/, { pattern: /acct \d+/ }, ...redact.slice(2)],
      },
      {
        ...base,
        redact: [
          ...redact.slice(0, 2),
          { role: "searchbox", name: "Card", replacement: "[card]" },
          ...redact.slice(3),
        ],
      },
      {
        ...base,
        redact: [
          ...redact.slice(0, 2),
          { role: "textbox", name: "Card number", replacement: "[card]" },
          ...redact.slice(3),
        ],
      },
      {
        ...base,
        redact: [
          ...redact.slice(0, 2),
          { role: "textbox", name: /Card/, replacement: "[card]" },
          ...redact.slice(3),
        ],
      },
      {
        ...base,
        redact: [
          ...redact.slice(0, 2),
          { role: "textbox", replacement: "[card]" },
          ...redact.slice(3),
        ],
      },
      // Normalise: disable, dropRoles, replace (order too), unwrap.
      { ...base, normalise: { ...normalise, disable: ["uuid"] } },
      {
        ...base,
        normalise: { ...normalise, dropRoles: ["banner"] },
      },
      {
        ...base,
        normalise: {
          ...normalise,
          replace: [...(normalise.replace ?? [])].reverse(),
        },
      },
      {
        ...base,
        normalise: {
          ...normalise,
          replace: [{ pattern: /build \w+/, placeholder: "[b]" }],
        },
      },
      {
        ...base,
        normalise: { ...normalise, unwrapUnnamedGeneric: false },
      },
      { redact },
      { normalise },
    ];
    const seen = new Set<string>([fingerprint]);
    for (const variant of variants) {
      const changed = rulesFingerprint(variant);
      expect(changed).not.toBe(fingerprint);
      seen.add(changed);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it("tells a regex rule from a string with the same text", () => {
    expect(
      rulesFingerprint({ redact: [{ role: "textbox", name: "a.b" }] }),
    ).not.toBe(
      rulesFingerprint({ redact: [{ role: "textbox", name: /a.b/ }] }),
    );
  });
});

describe("rules fingerprint format", () => {
  it("hashes the hash version, the rules version, redact and normalise", () => {
    const payload = JSON.stringify({
      v: SNAPSHOT_HASH_VERSION,
      rules: SNAPSHOT_RULES_VERSION,
      redact: [
        { source: "a", flags: "im" },
        { pattern: { source: "b", flags: "" }, replacement: "[b]" },
        { role: "textbox", name: { source: "c", flags: "i" } },
      ],
      normalise: {
        disable: ["uuid"],
        dropRoles: ["banner", "none", "presentation"],
        replace: [{ pattern: { source: "d", flags: "" }, placeholder: "[d]" }],
        unwrapUnnamedGeneric: false,
      },
    });
    const expected = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    expect(
      rulesFingerprint({
        redact: [
          /a/gim,
          { pattern: /b/, replacement: "[b]" },
          { role: "textbox", name: /c/iy },
        ],
        normalise: {
          disable: ["uuid"],
          dropRoles: ["banner"],
          replace: [{ pattern: /d/, placeholder: "[d]" }],
          unwrapUnnamedGeneric: false,
        },
      }),
    ).toBe(expected);
  });
});

describe("rules fingerprint on malformed rules", () => {
  // These shapes bypass parseConfig. The fingerprint must not throw a bare
  // TypeError, and must not leave out part of a rule that redaction uses.
  const malformed: unknown[] = [
    null,
    "order-1",
    { pattern: "order-\\d+" },
    { role: 3 },
    { role: "textbox", name: 5 },
    { pattern: /a/, replacement: 5 },
    {},
  ];
  for (const rule of malformed) {
    it(`rejects ${JSON.stringify(rule)} with ConfigError`, () => {
      expect(() => rulesFingerprint({ redact: [rule as RedactRule] })).toThrow(
        ConfigError,
      );
    });
  }

  it("covers the role half of a rule that sets both pattern and role", () => {
    // redact.ts applies both halves of such a rule, so both reach the hash.
    // The RedactRule union accepts this shape, though parseConfig rejects it.
    const both = (role: string): RedactRule => ({ pattern: /a/, role });
    expect(rulesFingerprint({ redact: [both("textbox")] })).not.toBe(
      rulesFingerprint({ redact: [both("searchbox")] }),
    );
  });
});
