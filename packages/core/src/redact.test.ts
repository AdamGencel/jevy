import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactSnapshot,
  redactText,
  redactWallet,
} from "./redact.js";
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

  it("redacts numbered and comma-separated seed phrases", () => {
    const words = SEED.split(" ");
    const numbered = words
      .map((word, index) => `${String(index + 1)}. ${word}`)
      .join(" ");
    const commas = words.join(", ");
    const lines = words
      .map((word, index) => `${String(index + 1)}) ${word}`)
      .join("\n");
    for (const sample of [numbered, commas, lines]) {
      const redacted = redactText(sample);
      expect(redacted).toContain(REDACTED);
      for (const word of words)
        expect(redacted).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it("redacts a seed phrase shown one word per node", () => {
    const grid: AccessibilityNode = {
      role: "WebArea",
      children: [
        { role: "heading", name: "Secret Recovery Phrase" },
        {
          role: "list",
          children: SEED.split(" ").map((word, index) => ({
            role: "listitem",
            children: [
              { role: "text", name: `${String(index + 1)}.` },
              { role: "text", name: word },
            ],
          })),
        },
        { role: "button", name: "Continue" },
      ],
    };
    const encoded = JSON.stringify(redactSnapshot(grid));
    for (const word of SEED.split(" ")) {
      expect(encoded).not.toContain(`"${word}"`);
    }
    expect(encoded).toContain('"1."');
    expect(encoded).toContain("Continue");
    // "Phrase" is itself a BIP-39 word, so it goes with the run.
    expect(encoded).toContain("Secret Recovery");

    const other = structuredClone(grid);
    const list = other.children?.[1]?.children ?? [];
    expect(hashSnapshot(grid)).toBe(
      hashSnapshot({
        ...other,
        children: [
          other.children?.[0] ?? { role: "heading" },
          {
            role: "list",
            children: list.map((item, index) => ({
              role: "listitem",
              children: [
                { role: "text", name: `${String(index + 1)}.` },
                { role: "text", name: "zoo" },
              ],
            })),
          },
          other.children?.[2] ?? { role: "button" },
        ],
      }),
    );
  });

  it("leaves eleven seed words in separate nodes alone", () => {
    const words = SEED.split(" ").slice(0, 11);
    const tree: AccessibilityNode = {
      role: "list",
      children: words.map((word) => ({ role: "listitem", name: word })),
    };
    expect(JSON.stringify(redactSnapshot(tree))).not.toContain(REDACTED);
  });

  it("redacts raw hex keys, JWTs and Google API keys", () => {
    const rawKey =
      "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const google = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";
    for (const secret of [rawKey, jwt, google]) {
      const redacted = redactText(`value: ${secret} end`);
      expect(redacted).toBe(`value: ${REDACTED} end`);
    }
  });

  it("treats recovery-phrase and private-key textboxes as secret fields", () => {
    for (const name of [
      "Recovery phrase",
      "Secret Recovery Phrase",
      "seed-phrase",
      "privateKey",
      "Passphrase",
    ]) {
      const node = redactSnapshot({ role: "textbox", name, value: "zoo zoo" });
      expect(node.value).toBe(REDACTED);
      expect(node.name).toBe(name);
    }
  });

  it("keeps the token on a wallet approve prompt but drops real secrets", () => {
    const wallet = redactWallet({
      kind: "approve",
      fields: {
        token: ADDRESS,
        tokenAddress: ADDRESS,
        publicKey: "0x04ab",
        spender: ADDRESS,
        amount: "100",
        privateKey: "secret-value",
        private_key: "secret-value",
        mnemonic: "secret-value",
        accessToken: "secret-value",
        apiKey: "secret-value",
        pk: PRIVATE_KEY,
      },
    });
    const fields = wallet.fields ?? {};
    expect(fields["token"]).toBe(ADDRESS);
    expect(fields["tokenAddress"]).toBe(ADDRESS);
    expect(fields["publicKey"]).toBe("0x04ab");
    expect(fields["amount"]).toBe("100");
    for (const key of [
      "privateKey",
      "private_key",
      "mnemonic",
      "accessToken",
      "apiKey",
      "pk",
    ]) {
      expect(fields[key]).toBe(REDACTED);
    }
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
