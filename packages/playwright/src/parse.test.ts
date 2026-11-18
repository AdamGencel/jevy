import { SnapshotError } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import { parseAriaSnapshot } from "./parse.js";

/** Join lines so the YAML in a test reads like Playwright's output. */
function yaml(...lines: readonly string[]): string {
  return lines.join("\n");
}

function only(yamlText: string): AccessibilityNode {
  return parseAriaSnapshot(yamlText);
}

function expectSnapshotError(input: string, line: number): void {
  let caught: unknown;
  try {
    parseAriaSnapshot(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SnapshotError);
  expect((caught as Error).message).toContain(`line ${String(line)}`);
}

describe("parseAriaSnapshot: root", () => {
  it("wraps several top-level nodes in a document", () => {
    expect(only(yaml('- heading "Hi" [level=1]', '- button "Pay"'))).toEqual({
      role: "document",
      children: [
        { role: "heading", name: "Hi", level: 1 },
        { role: "button", name: "Pay" },
      ],
    });
  });

  it("uses the only top-level node as the root", () => {
    expect(only(yaml("- main:", '  - button "Pay"'))).toEqual({
      role: "main",
      children: [{ role: "button", name: "Pay" }],
    });
  });

  it("gives an empty document for an empty snapshot", () => {
    expect(only("")).toEqual({ role: "document" });
    expect(only("\n  \n")).toEqual({ role: "document" });
  });

  it("parses the example from the spec", () => {
    expect(
      only(
        yaml(
          "- main:",
          '  - heading "Order confirmed" [level=1]',
          '  - button "Pay"',
          '  - textbox "Email": a@b.co',
        ),
      ),
    ).toEqual({
      role: "main",
      children: [
        { role: "heading", name: "Order confirmed", level: 1 },
        { role: "button", name: "Pay" },
        { role: "textbox", name: "Email", value: "a@b.co" },
      ],
    });
  });
});

describe("parseAriaSnapshot: nodes", () => {
  it("reads a role without a name", () => {
    expect(only("- separator")).toEqual({ role: "separator" });
  });

  it("turns a text entry into a text node", () => {
    expect(only(yaml("- text: Hello world", "- text: Bye"))).toEqual({
      role: "document",
      children: [
        { role: "text", name: "Hello world" },
        { role: "text", name: "Bye" },
      ],
    });
  });

  it("turns inline text of an ordinary role into a child text node", () => {
    expect(only("- paragraph: Plain paragraph")).toEqual({
      role: "paragraph",
      children: [{ role: "text", name: "Plain paragraph" }],
    });
    expect(only('- button "Submit form": Go')).toEqual({
      role: "button",
      name: "Submit form",
      children: [{ role: "text", name: "Go" }],
    });
  });

  it.each(["textbox", "searchbox", "combobox", "spinbutton", "slider"])(
    "treats inline text of a %s as its value",
    (role) => {
      expect(only(`- ${role} "Field": abc`)).toEqual({
        role,
        name: "Field",
        value: "abc",
      });
    },
  );

  it("keeps a numeric-looking value as the string Playwright printed", () => {
    expect(only('- spinbutton "Qty": "3"')).toEqual({
      role: "spinbutton",
      name: "Qty",
      value: "3",
    });
  });

  it("reads nested children in order", () => {
    expect(
      only(
        yaml(
          "- list:",
          "  - listitem: One",
          "  - listitem:",
          "    - text: Two",
          '    - link "link":',
          "      - /url: https://example.test/t",
        ),
      ),
    ).toEqual({
      role: "list",
      children: [
        { role: "listitem", children: [{ role: "text", name: "One" }] },
        {
          role: "listitem",
          children: [
            { role: "text", name: "Two" },
            { role: "link", name: "link" },
          ],
        },
      ],
    });
  });

  it("drops /url and /placeholder, which core has no field for", () => {
    expect(
      only(yaml('- textbox "Bad" [invalid]:', "  - /placeholder: type here")),
    ).toEqual({ role: "textbox", name: "Bad", invalid: "true" });
    expect(only(yaml('- link "Home":', "  - /url: /"))).toEqual({
      role: "link",
      name: "Home",
    });
  });

  it("reads the value of a textbox that also has a placeholder", () => {
    expect(
      only(
        yaml(
          '- textbox "Email":',
          "  - /placeholder: you@x.test",
          "  - text: a@b.co",
        ),
      ),
    ).toEqual({ role: "textbox", name: "Email", value: "a@b.co" });
  });

  it("keeps element children of a value role as children", () => {
    expect(
      only(yaml('- combobox "Pick":', '  - option "A"', '  - option "B"')),
    ).toEqual({
      role: "combobox",
      name: "Pick",
      children: [
        { role: "option", name: "A" },
        { role: "option", name: "B" },
      ],
    });
  });

  it("treats an empty inline value as no value", () => {
    expect(only('- textbox "v4":')).toEqual({ role: "textbox", name: "v4" });
  });

  it("drops a node marked aria-hidden with its subtree", () => {
    expect(
      only(
        yaml(
          "- generic [aria-hidden] [ref=e5]:",
          "  - text: aria hidden text",
          "  - button [ref=e6]: Hidden btn",
          "- paragraph [ref=e7]: shown",
        ),
      ),
    ).toEqual({
      role: "paragraph",
      children: [{ role: "text", name: "shown" }],
    });
  });
});

describe("parseAriaSnapshot: attributes", () => {
  it("maps checked, mixed and pressed", () => {
    expect(only('- checkbox "Terms" [checked]')).toEqual({
      role: "checkbox",
      name: "Terms",
      checked: true,
    });
    expect(only('- checkbox "Some" [checked=mixed]')).toEqual({
      role: "checkbox",
      name: "Some",
      checked: "mixed",
    });
    expect(only('- button "Bold" [pressed]')).toEqual({
      role: "button",
      name: "Bold",
      pressed: true,
    });
    expect(only('- button "Bold" [pressed=mixed]')).toEqual({
      role: "button",
      name: "Bold",
      pressed: "mixed",
    });
  });

  it("maps disabled, expanded, selected, level and active", () => {
    expect(
      only('- option "UK" [disabled] [expanded] [selected] [active]'),
    ).toEqual({
      role: "option",
      name: "UK",
      disabled: true,
      expanded: true,
      selected: true,
      focused: true,
    });
    expect(only('- treeitem "node" [level=3]')).toEqual({
      role: "treeitem",
      name: "node",
      level: 3,
    });
  });

  it("maps invalid, grammar and spelling to core's string field", () => {
    expect(only('- textbox "a" [invalid]')).toMatchObject({ invalid: "true" });
    expect(only('- textbox "a" [invalid=grammar]')).toMatchObject({
      invalid: "grammar",
    });
    expect(only('- textbox "a" [invalid=spelling]')).toMatchObject({
      invalid: "spelling",
    });
  });

  it("accepts explicit true and false, and omits false like Playwright does", () => {
    expect(only('- checkbox "a" [checked=true]')).toEqual({
      role: "checkbox",
      name: "a",
      checked: true,
    });
    expect(
      only(
        '- checkbox "a" [checked=false] [disabled=false] [expanded=false] [pressed=false] [selected=false] [invalid=false]',
      ),
    ).toEqual({ role: "checkbox", name: "a" });
  });

  it("ignores ref, cursor and box, which are volatile", () => {
    expect(
      only('- button "Go" [ref=e12] [cursor=pointer] [box=8,10,40,21]'),
    ).toEqual({ role: "button", name: "Go" });
    expect(only("- generic [ref=f1e2]")).toEqual({ role: "generic" });
  });

  it("puts attributes on a node with children", () => {
    expect(
      only(yaml('- dialog "Confirm" [active]:', '  - button "OK"')),
    ).toEqual({
      role: "dialog",
      name: "Confirm",
      focused: true,
      children: [{ role: "button", name: "OK" }],
    });
  });
});

describe("parseAriaSnapshot: quoting as Playwright emits it", () => {
  // Every key below is copied from Playwright 1.63 output for the matching
  // HTML (see docs/spikes/snapshot-source.md).
  it.each([
    ['- button "Say \\"hi\\""', 'Say "hi"'],
    [`- button "it's"`, "it's"],
    [`- 'button "a: b"'`, "a: b"],
    ['- button "[x] box"', "[x] box"],
    [`- 'button "tag #1"'`, "tag #1"],
    [`- 'button "a #b"'`, "a #b"],
    ['- button "- dash"', "- dash"],
    ['- button "Zürich 東京 🎉"', "Zürich 東京 🎉"],
    ['- button "back\\\\slash"', "back\\slash"],
    ['- button "123"', "123"],
    ['- button "yes"', "yes"],
    [`- 'button "{brace}"'`, "{brace}"],
    [`- 'button "a\`b"'`, "a`b"],
    ['- button "&amp"', "&amp"],
    [`- 'button "it''s: here"'`, "it's: here"],
    ['- button "tab\\tinside"', "tab\tinside"],
    ['- button "nul\\u0000x"', "nul\u0000x"],
  ])("reads %s", (line, name) => {
    expect(only(line)).toEqual({ role: "button", name });
  });

  it("reads a quoted key that also has attributes", () => {
    expect(only(`- 'heading "Heading: with colon" [level=3]'`)).toEqual({
      role: "heading",
      name: "Heading: with colon",
      level: 3,
    });
  });

  it("reads a name that looks like an attribute", () => {
    expect(only('- button "[disabled]" [pressed]')).toEqual({
      role: "button",
      name: "[disabled]",
      pressed: true,
    });
  });

  it("reads a regular-expression-style name literally", () => {
    expect(only("- button /regex/")).toEqual({
      role: "button",
      name: "/regex/",
    });
    expect(only("- button /a [b] c/ [disabled]")).toEqual({
      role: "button",
      name: "/a [b] c/",
      disabled: true,
    });
    expect(only("- link /x/y/: hi")).toEqual({
      role: "link",
      name: "/x/y/",
      children: [{ role: "text", name: "hi" }],
    });
  });

  it.each([
    ['- paragraph: "value: colon text"', "value: colon text"],
    ['- paragraph: "- leading dash text"', "- leading dash text"],
    ['- paragraph: "\\"quoted text\\""', '"quoted text"'],
    ['- paragraph: "#hash text"', "#hash text"],
    ['- paragraph: "yes"', "yes"],
    ['- paragraph: "42"', "42"],
    ['- paragraph: "line\\nbreak\\x7f"', "line\nbreak\u007f"],
    ["- paragraph: ~", "~"],
    ["- paragraph: .inf", ".inf"],
    ["- paragraph: null", "null"],
    ["- paragraph: 10:30", "10:30"],
  ])("reads the text value %s", (line, text) => {
    expect(only(line)).toEqual({
      role: "paragraph",
      children: [{ role: "text", name: text }],
    });
  });

  it("reads quoted textbox values", () => {
    expect(only('- textbox "v1": "He said \\"x\\": y"')).toEqual({
      role: "textbox",
      name: "v1",
      value: 'He said "x": y',
    });
    expect(only('- textbox "v2": "- dash"')).toMatchObject({ value: "- dash" });
    expect(only('- textbox "v3": "true"')).toMatchObject({ value: "true" });
    expect(only('- textbox "Col": "#ff0000"')).toMatchObject({
      value: "#ff0000",
    });
  });

  it("reads a text entry whose text is quoted", () => {
    expect(only('- text: "a: b"')).toEqual({ role: "text", name: "a: b" });
  });
});

describe("parseAriaSnapshot: malformed input", () => {
  it("rejects YAML that does not parse, with the line number", () => {
    expectSnapshotError(yaml("- main:", "  - a", " - b"), 3);
    expectSnapshotError(yaml("- main:", '  - "quoted" role'), 2);
  });

  it("rejects a document that is not a list", () => {
    expectSnapshotError("button: x", 1);
    expectSnapshotError("just text", 1);
  });

  it("rejects a key that is not a role", () => {
    expectSnapshotError(yaml("- main:", "  - 9lives"), 2);
    expectSnapshotError(yaml("- main:", '  - button"x"'), 2);
  });

  it("rejects an unterminated name", () => {
    expectSnapshotError(yaml("- main", '- button "abc'), 2);
  });

  it("rejects an unknown attribute", () => {
    expectSnapshotError(yaml("- main", '- button "a" [shiny]'), 2);
  });

  it("rejects a repeated attribute", () => {
    expectSnapshotError('- button "a" [disabled] [disabled]', 1);
  });

  it("rejects text after the name that is not an attribute", () => {
    expectSnapshotError('- button "a" extra', 1);
    expectSnapshotError('- button "a" [disabled', 1);
  });

  it("rejects bad attribute values", () => {
    expectSnapshotError('- heading "a" [level=x]', 1);
    expectSnapshotError('- heading "a" [level=0]', 1);
    expectSnapshotError('- checkbox "a" [checked=maybe]', 1);
    expectSnapshotError('- textbox "a" [invalid=bad]', 1);
    expectSnapshotError('- button "a" [disabled=mixed]', 1);
  });

  it("rejects an entry with two keys", () => {
    expectSnapshotError(yaml("- main:", "  - a: x", "    b: y"), 2);
  });

  it("rejects a nested mapping as a value", () => {
    expectSnapshotError(yaml("- main:", "    inner: x"), 2);
  });

  it("rejects a property at the top level or with children", () => {
    expectSnapshotError("- /url: x", 1);
    expectSnapshotError(yaml("- link:", "  - /url:", "    - text: x"), 2);
  });

  it("rejects a text entry with children", () => {
    expectSnapshotError(yaml("- text:", "  - button"), 1);
  });

  it("rejects anchors and aliases, which Playwright never emits", () => {
    expectSnapshotError(yaml("- &a button", "- *a"), 1);
    expectSnapshotError(yaml("- main", "- *a"), 2);
    expectSnapshotError(yaml("- main", "- !!str button"), 2);
    expectSnapshotError(yaml("- main:", "  - list: &l", "    - button"), 2);
  });

  it("does not echo snapshot content in the error message", () => {
    let message = "";
    try {
      parseAriaSnapshot('- textbox "hunter2-secret" [nope]: hunter2-secret');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("hunter2");
  });
});
