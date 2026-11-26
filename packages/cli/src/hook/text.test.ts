import { describe, expect, it } from "vitest";
import {
  clip,
  clipPath,
  CUT_MARKER,
  indent,
  printable,
  printableLines,
  tail,
} from "./text.js";

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`).join(
    "\n",
  );
}

describe("tail", () => {
  it("returns short output unchanged, without trailing blank lines", () => {
    expect(tail("one\ntwo\n\n")).toBe("one\ntwo");
    expect(tail("")).toBe("");
  });

  it("keeps the last 40 lines and says that it cut", () => {
    const out = tail(numbered(100));
    const lines = out.split("\n");
    expect(lines[0]).toBe(CUT_MARKER);
    expect(lines).toHaveLength(41);
    expect(lines[1]).toBe("line 61");
    expect(lines[40]).toBe("line 100");
  });

  it("keeps the last 4,000 characters of long lines", () => {
    const out = tail(`start${"x".repeat(5000)}end`);
    expect(out.startsWith(`${CUT_MARKER}\n`)).toBe(true);
    const body = out.slice(CUT_MARKER.length + 1);
    expect(body).toHaveLength(4000);
    expect(body.endsWith("end")).toBe(true);
    expect(out).not.toContain("start");
  });

  it("reads Windows line endings as one line break", () => {
    expect(tail("a\r\nb\r\n")).toBe("a\nb");
  });

  it("does not start in the middle of a surrogate pair", () => {
    const out = tail("😀".repeat(3000), { lines: 40, chars: 5 });
    const body = out.slice(CUT_MARKER.length + 1);
    expect(body).toBe("😀😀");
  });
});

describe("indent", () => {
  it("indents every line", () => {
    expect(indent("a\nb")).toBe("  a\n  b");
    expect(indent("a", "> ")).toBe("> a");
  });
});

describe("printable", () => {
  it("escapes control characters so a name stays on one line", () => {
    expect(printable("a\nb\u001b[2K\tc")).toBe("a\\nb\\u001b[2K\\tc");
    expect(printable("plain ż.ts")).toBe("plain ż.ts");
  });

  it.each([
    ["line separator", "\u2028", "\\u2028"],
    ["paragraph separator", "\u2029", "\\u2029"],
    ["next line", "\u0085", "\\u0085"],
    ["the one-character escape introducer", "\u009b", "\\u009b"],
    ["left-to-right embedding", "\u202a", "\\u202a"],
    ["right-to-left override", "\u202e", "\\u202e"],
    ["left-to-right isolate", "\u2066", "\\u2066"],
    ["pop directional isolate", "\u2069", "\\u2069"],
  ])(
    "escapes a %s, which a terminal or a reader would act on",
    (_name, char, escaped) => {
      expect(printable(`a${char}b`)).toBe(`a${escaped}b`);
    },
  );

  it("leaves characters outside the basic plane alone", () => {
    expect(printable("ok 😀 ż")).toBe("ok 😀 ż");
  });
});

describe("clip", () => {
  it("returns text that fits unchanged", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("", 3)).toBe("");
  });

  it("cuts longer text to the width, the ellipsis included", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("x".repeat(9500), 120)).toHaveLength(120);
  });

  it("does not cut a surrogate pair in half", () => {
    expect(clip("ab😀cd", 4)).toBe("ab…");
  });
});

describe("clipPath", () => {
  it("keeps a short path as it is", () => {
    expect(clipPath("src/a.spec.ts", 20)).toBe("src/a.spec.ts");
  });

  it("keeps the end, from a slash, so the file's own name is never cut", () => {
    const path = `${"long-directory/".repeat(20)}checkout/pays.spec.ts`;
    const clipped = clipPath(path, 40);
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(clipped).toBe("…/long-directory/checkout/pays.spec.ts");
  });

  it("keeps the end of a name longer than the room", () => {
    expect(clipPath(`dir/${"x".repeat(50)}.ts`, 10)).toBe(
      `…${"x".repeat(6)}.ts`,
    );
  });

  it("does not start with half of a surrogate pair", () => {
    expect(clipPath("😀".repeat(10), 4)).toBe("…😀");
  });
});

describe("printableLines", () => {
  it("keeps line breaks and tabs and escapes every other control character", () => {
    expect(printableLines("\u001b[31mred\tx\n\u202eevil\r\n")).toBe(
      "\\u001b[31mred\tx\n\\u202eevil\\r\n",
    );
  });
});
