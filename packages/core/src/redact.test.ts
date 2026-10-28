import { describe, expect, it } from "vitest";
import { REDACTED, redactSnapshot, redactText } from "./redact.js";
import { hashSnapshot } from "./hash.js";
import { normaliseSnapshot } from "./normalise.js";
import { prepareDecisionState } from "./prepare.js";
import type { AccessibilityNode } from "./snapshot.js";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const PRIVATE_KEY = `0x${"ab".repeat(32)}`;
const SEED =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";
const OTHER_SEED = "zoo ".repeat(12).trim();

describe("redaction", () => {
  it("removes secrets and personal data before the hash", () => {
    const withAda = page("Signed in as ada@example.com");
    const withBob = page("Signed in as bob@example.com");
    expect(hashSnapshot(withAda)).toBe(hashSnapshot(withBob));

    const visible = JSON.stringify(normaliseSnapshot(redactSnapshot(withAda)));
    expect(visible).not.toContain("ada@example.com");
    expect(visible).toContain(REDACTED);
  });

  it("clears password fields but keeps the accessible name", () => {
    const first = password("hunter2");
    const second = password("correct-horse");
    expect(hashSnapshot(first)).toBe(hashSnapshot(second));
    const redacted = redactSnapshot(first);
    expect(redacted.name).toBe("Password");
    expect(redacted.value).toBe(REDACTED);
  });

  it("redacts keys, bearers, seed phrases and phone numbers", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "c2VjcmV0",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const samples = [
      "sk_live_abc123XYZ",
      "Bearer abcdefghijklmnop",
      pem,
      PRIVATE_KEY,
      SEED,
      "call +1 415 555 0100",
      "api_key=abcd1234ef",
    ];
    for (const sample of samples) {
      const redacted = redactText(sample);
      expect(redacted).not.toContain(sample.split("\n")[0] ?? sample);
      expect(redacted).toContain(REDACTED);
    }
    expect(redactText(`pay ${ADDRESS}`)).toContain(ADDRESS);
    expect(redactText(PRIVATE_KEY)).not.toContain(PRIVATE_KEY);
  });

  it("treats two seed phrases as the same redacted text", () => {
    expect(redactText(SEED)).toBe(REDACTED);
    expect(redactText(OTHER_SEED)).toBe(REDACTED);
    expect(hashSnapshot(page(SEED))).toBe(hashSnapshot(page(OTHER_SEED)));
    const eleven =
      "abandon ability able about above absent absorb abstract absurd abuse access";
    expect(redactText(eleven)).toBe(eleven);
  });

  it("is idempotent", () => {
    const once = redactText(`ada@example.com ${PRIVATE_KEY}`);
    expect(redactText(once)).toBe(once);
  });

  it("applies a project rule and redacts state before a decider would see it", () => {
    const options = { redact: [/ORDER-\d+/] };
    expect(hashSnapshot({ role: "status", name: "ORDER-12" }, options)).toBe(
      hashSnapshot({ role: "status", name: "ORDER-99" }, options),
    );

    const prepared = prepareDecisionState({
      snapshot: password("hunter2"),
      url: "https://example.test/reset?email=ada@example.com",
      goal: `wallet ${SEED}`,
      wallet: {
        kind: "send",
        fields: { recipient: ADDRESS, privateKey: PRIVATE_KEY },
      },
    });
    const encoded = JSON.stringify(prepared);
    expect(encoded).not.toContain("hunter2");
    expect(encoded).not.toContain("ada@example.com");
    expect(encoded).not.toContain("abandon");
    expect(encoded).not.toContain(PRIVATE_KEY);
    expect(encoded).toContain(ADDRESS);
    expect(prepared.wallet?.fields?.["privateKey"]).toBe(REDACTED);
  });

  it("redacts a control matched by a role rule", () => {
    const node: AccessibilityNode = {
      role: "textbox",
      name: "Backup code",
      value: "998877",
    };
    const redacted = redactSnapshot(node, [
      { role: "textbox", name: /backup code/i },
    ]);
    expect(redacted.name).toBe("Backup code");
    expect(redacted.value).toBe(REDACTED);
  });
});

function page(name: string): AccessibilityNode {
  return { role: "status", name };
}

function password(value: string): AccessibilityNode {
  return { role: "textbox", name: "Password", value };
}
