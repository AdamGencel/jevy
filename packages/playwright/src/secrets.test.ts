import { REDACTED, RedactionError, redactSnapshot } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import {
  SECRET_AUTOCOMPLETE_TOKENS,
  isSecretAutocomplete,
  isSecretField,
  parsePageReading,
  scrubSecrets,
  secretForms,
  secretValues,
} from "./secrets.js";
import type { FieldReading } from "./secrets.js";

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

describe("isSecretField", () => {
  const plain: FieldReading = {
    tag: "input",
    type: "text",
    value: "v",
    autocomplete: "",
    name: "",
    id: "",
    wasPassword: false,
  };

  it("is false for an ordinary text field", () => {
    expect(isSecretField(plain)).toBe(false);
    expect(isSecretField({ ...plain, name: "email", id: "user" })).toBe(false);
  });

  it("is true for a password field and a secret autocomplete token", () => {
    expect(isSecretField({ ...plain, type: "password" })).toBe(true);
    expect(isSecretField({ ...plain, autocomplete: "cc-csc" })).toBe(true);
  });

  it("is true for a text field whose name or id names a secret", () => {
    expect(isSecretField({ ...plain, name: "user_password" })).toBe(true);
    expect(isSecretField({ ...plain, id: "apiKey" })).toBe(true);
    expect(isSecretField({ ...plain, type: "search", id: "passcode" })).toBe(
      true,
    );
    expect(
      isSecretField({
        ...plain,
        tag: "textarea",
        type: "textarea",
        id: "seed-phrase",
      }),
    ).toBe(true);
  });

  it("ignores the name and id of a field whose value is not typed text", () => {
    // A "remember password" checkbox has the value "on", which would blank
    // every "on" on the page.
    for (const type of ["checkbox", "radio", "submit", "button", "hidden"]) {
      expect(isSecretField({ ...plain, type, name: "remember_password" })).toBe(
        false,
      );
    }
  });

  it("treats a field with no type attribute as text", () => {
    // The browser reports `type` as "text" for <input> without the attribute.
    expect(isSecretField({ ...plain, type: "text", name: "password" })).toBe(
      true,
    );
  });

  it("ignores the name and id of a field whose value is not free text", () => {
    // `<input type=number name=password_min_length value=8>` is a setting,
    // not a secret; treating it as one blanks every "8" on the page.
    for (const type of ["number", "email", "tel", "url", "range", "date"]) {
      expect(
        isSecretField({ ...plain, type, name: "password_min_length" }),
      ).toBe(false);
      expect(isSecretField({ ...plain, type, id: "password" })).toBe(false);
    }
  });

  it("keeps password type and secret autocomplete whatever the type", () => {
    expect(isSecretField({ ...plain, type: "number", wasPassword: true })).toBe(
      true,
    );
    expect(
      isSecretField({
        ...plain,
        type: "number",
        autocomplete: "one-time-code",
      }),
    ).toBe(true);
  });

  it("is true for a field that has had type password, whatever it is now", () => {
    expect(isSecretField({ ...plain, wasPassword: true })).toBe(true);
  });
});

describe("secretValues", () => {
  it("returns the non-empty values of secret fields, sorted", () => {
    const field = (value: string, type: string): FieldReading => ({
      tag: "input",
      type,
      value,
      autocomplete: "",
      name: "",
      id: "",
      wasPassword: false,
    });
    expect(
      secretValues([
        field("b", "password"),
        field("plain", "text"),
        field("", "password"),
        field("a", "password"),
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("parsePageReading", () => {
  const field: FieldReading = {
    tag: "input",
    type: "password",
    value: "v",
    autocomplete: "",
    name: "",
    id: "",
    wasPassword: false,
  };

  it("joins the page's own reading and the init script's", () => {
    expect(
      parsePageReading({
        fields: [field],
        remembered: [{ ...field, value: "w", wasPassword: true }],
      }),
    ).toEqual([field, { ...field, value: "w", wasPassword: true }]);
    expect(
      parsePageReading({ fields: [field], remembered: undefined }),
    ).toEqual([field]);
  });

  it("throws RedactionError when either reading is malformed", () => {
    for (const reading of [
      null,
      [field],
      { fields: "x", remembered: undefined },
      { fields: [field], remembered: "unreadable" },
      { fields: [field], remembered: [{ ...field, value: 1 }] },
      { fields: [{ ...field, tag: "div" }], remembered: undefined },
      { fields: [{ ...field, wasPassword: "yes" }], remembered: undefined },
      { fields: [null], remembered: undefined },
    ]) {
      expect(() => parsePageReading(reading)).toThrow(RedactionError);
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

  it("scrubs a link's url", () => {
    const node: AccessibilityNode = {
      role: "link",
      name: "Reset",
      url: "https://example.test/reset/4321",
    };
    expect(scrubSecrets(node, ["4321"]).url).toBe(
      `https://example.test/reset/${REDACTED}`,
    );
  });

  it("scrubs a secret the page percent-encoded into a url", () => {
    const node: AccessibilityNode = {
      role: "link",
      name: "Next",
      url: "/u/a%20b%2Fc/x/a%20b/c",
    };
    expect(scrubSecrets(node, ["a b/c"]).url).toBe(
      `/u/${REDACTED}/x/${REDACTED}`,
    );
  });

  it("does not throw on a secret that cannot be percent-encoded", () => {
    const node: AccessibilityNode = { role: "link", url: "/\ud800x" };
    expect(() => scrubSecrets(node, ["\ud800x"])).not.toThrow();
    expect(scrubSecrets(node, ["\ud800x"]).url).toBe(`/${REDACTED}`);
  });

  it("removes a secret that holds # or ? whole, before the url is reduced", () => {
    for (const secret of ["hunt#er2zz", "secr?etvalue", "a#b?c"]) {
      const node: AccessibilityNode = { role: "link", url: `/u/${secret}` };
      const url = scrubSecrets(node, [secret]).url ?? "";
      expect(url).toBe(`/u/${REDACTED}`);
      expect(url).not.toContain(secret.slice(0, 2));
    }
  });

  it("reduces a raw url, with or without secrets", () => {
    const node: AccessibilityNode = {
      role: "link",
      url: "/orders/42?session=abc#top",
    };
    expect(scrubSecrets(node, []).url).toBe("/orders/42");
    expect(scrubSecrets(node, ["zzz"]).url).toBe("/orders/42");
  });

  it("drops a url that reduces to nothing", () => {
    expect(scrubSecrets({ role: "link", url: "   " }, [])).toEqual({
      role: "link",
    });
  });

  it("matches lower-case and mixed-case percent-encoding", () => {
    for (const url of [
      "/u/p%c3%a4sswort99",
      "/u/p%C3%a4sswort99",
      "/u/p%c3%A4sswort99",
      "/u/%70%C3%A4ssw%6Frt99",
    ]) {
      expect(scrubSecrets({ role: "link", url }, ["pässwort99"]).url).toBe(
        `/u/${REDACTED}`,
      );
    }
  });

  it("matches + for a space, as a form or a query would spell it", () => {
    const node: AccessibilityNode = { role: "link", url: "/s/my+pass+phrase" };
    expect(scrubSecrets(node, ["my pass phrase"]).url).toBe(`/s/${REDACTED}`);
    const mixed: AccessibilityNode = {
      role: "link",
      url: "/s/my+pass%20phrase",
    };
    expect(scrubSecrets(mixed, ["my pass phrase"]).url).toBe(`/s/${REDACTED}`);
  });

  it("still matches a literal + in a secret", () => {
    const node: AccessibilityNode = { role: "link", url: "/s/a+b/a%2Bb" };
    expect(scrubSecrets(node, ["a+b"]).url).toBe(`/s/${REDACTED}/${REDACTED}`);
  });

  it("does not throw on malformed percent-encoding, and scrubs around it", () => {
    const node: AccessibilityNode = {
      role: "link",
      url: "/u/%zz%c3%/abc%e2%82",
    };
    expect(() => scrubSecrets(node, ["abc"])).not.toThrow();
    expect(scrubSecrets(node, ["abc"]).url).toBe(
      `/u/%zz%c3%/${REDACTED}%e2%82`,
    );
  });

  it("never lets a scrub break a scheme apart", () => {
    // Scrubbing "java" first would leave "[REDACTED]script:login('tok')",
    // which core would read as a relative path and keep whole.
    const node: AccessibilityNode = {
      role: "link",
      url: "javascript:login('tok')",
    };
    const url = scrubSecrets(node, ["java"]).url ?? "";
    expect(url).toBe(`${REDACTED}script:`);
    expect(url).not.toContain("tok");
  });

  it("still removes a secret that is part of the marker text", () => {
    const node: AccessibilityNode = { role: "textbox", value: "ACT" };
    expect(scrubSecrets(node, ["ACT"]).value).toBe(REDACTED);
  });
});
