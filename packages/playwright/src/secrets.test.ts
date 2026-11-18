import { REDACTED, redactSnapshot } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import {
  SECRET_AUTOCOMPLETE_TOKENS,
  isSecretAutocomplete,
  scrubSecrets,
  secretForms,
} from "./secrets.js";

describe("isSecretAutocomplete", () => {
  it("matches core's secret tokens", () => {
    for (const token of SECRET_AUTOCOMPLETE_TOKENS) {
      expect(isSecretAutocomplete(token)).toBe(true);
    }
  });

  it("matches a token inside a full autocomplete value, in any case", () => {
    expect(isSecretAutocomplete("section-pay billing CC-Number")).toBe(true);
    expect(isSecretAutocomplete("  one-time-code ")).toBe(true);
  });

  it("does not match ordinary tokens", () => {
    expect(isSecretAutocomplete("email")).toBe(false);
    expect(isSecretAutocomplete("cc-name")).toBe(false);
    expect(isSecretAutocomplete("")).toBe(false);
  });

  it("agrees with core: every token makes core treat a textbox as secret", () => {
    for (const token of SECRET_AUTOCOMPLETE_TOKENS) {
      const tree: AccessibilityNode = {
        role: "textbox",
        name: "Field",
        value: "visible-value",
        autocomplete: token,
      };
      expect(redactSnapshot(tree).value).toBe(REDACTED);
    }
  });
});

describe("secretForms", () => {
  it("adds the whitespace forms Playwright prints", () => {
    expect(secretForms("  a \u200b b\t\tc  ")).toEqual([
      "  a \u200b b\t\tc  ",
      "a \u200b b c",
      "a b c",
    ]);
  });

  it("skips empty and duplicate forms", () => {
    expect(secretForms("abc")).toEqual(["abc"]);
    expect(secretForms("   ")).toEqual(["   "]);
    expect(secretForms("")).toEqual([]);
  });
});

describe("scrubSecrets", () => {
  const tree: AccessibilityNode = {
    role: "document",
    children: [
      { role: "text", name: "PIN" },
      { role: "textbox", name: "PIN", value: "4321" },
      { role: "button", name: "Use 4321 again" },
      { role: "textbox", name: "Email", value: "a@b.co" },
    ],
  };

  it("replaces every occurrence in every text field", () => {
    expect(scrubSecrets(tree, ["4321"])).toEqual({
      role: "document",
      children: [
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
        { role: "button", name: `Use ${REDACTED} again` },
        { role: "textbox", name: "Email", value: "a@b.co" },
      ],
    });
  });

  it("returns an equal tree when there are no secrets", () => {
    expect(scrubSecrets(tree, [])).toEqual(tree);
  });

  it("scrubs description, valuetext and the other text fields", () => {
    const node: AccessibilityNode = {
      role: "slider",
      name: "s",
      description: "is s3",
      valuetext: "s3 left",
      roledescription: "s3",
      keyshortcuts: "s3",
      value: 1234,
    };
    expect(scrubSecrets(node, ["s3", "23"])).toEqual({
      role: "slider",
      name: "s",
      description: `is ${REDACTED}`,
      valuetext: `${REDACTED} left`,
      roledescription: REDACTED,
      keyshortcuts: REDACTED,
      value: `1${REDACTED}4`,
    });
  });

  it("finds the secret after Playwright collapsed its whitespace", () => {
    const node: AccessibilityNode = {
      role: "textbox",
      name: "New",
      value: "s3cret pass",
    };
    expect(scrubSecrets(node, ["s3cret  pass"]).value).toBe(REDACTED);
  });

  it("prefers the longest secret so a longer one is removed whole", () => {
    const node: AccessibilityNode = { role: "text", name: "abcdef" };
    expect(scrubSecrets(node, ["cd", "abcdef"]).name).toBe(REDACTED);
  });

  it("does not let a later secret match inside the replacement marker", () => {
    const node: AccessibilityNode = { role: "text", name: "xx RED yy" };
    const scrubbed = scrubSecrets(node, ["xx", "RED", "D"]);
    expect(scrubbed.name).toBe(`${REDACTED} ${REDACTED} yy`);
  });

  it("still removes a secret that is part of the marker text", () => {
    const node: AccessibilityNode = { role: "textbox", value: "ACT" };
    expect(scrubSecrets(node, ["ACT"]).value).toBe(REDACTED);
  });
});
