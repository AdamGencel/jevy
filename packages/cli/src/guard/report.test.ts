import { describe, expect, it } from "vitest";
import { buildReport, exitCodeFor, formatHuman, formatJson } from "./report.js";
import { finding } from "./findings.js";

const FINDINGS = [
  finding({
    kind: "test-added",
    file: "b.spec.ts",
    test: ["new"],
    line: 3,
    message: "test added: new",
  }),
  finding({
    kind: "assertion-removed",
    file: "a.spec.ts",
    test: ["suite", "pays"],
    line: 9,
    message: "suite > pays has 1 fewer assertion (2 -> 1): removed toBe",
    before: "expect(…).toBe(1)",
  }),
  finding({
    kind: "test-removed",
    file: "a.spec.ts",
    test: ["suite", "old"],
    line: 2,
    message: "test removed: suite > old (was line 2)",
  }),
  finding({
    kind: "config-changed",
    file: "a.spec.ts",
    message: "no line",
  }),
];

describe("buildReport", () => {
  it("sorts by file, then line, then kind, and counts each severity", () => {
    const report = buildReport("main", "working-tree", FINDINGS);
    expect(report.summary).toEqual({ weakening: 2, review: 1, info: 1 });
    expect(report.findings.map((f) => [f.file, f.line, f.kind])).toEqual([
      ["a.spec.ts", undefined, "config-changed"],
      ["a.spec.ts", 2, "test-removed"],
      ["a.spec.ts", 9, "assertion-removed"],
      ["b.spec.ts", 3, "test-added"],
    ]);
  });
});

describe("formatJson", () => {
  it("prints one versioned document with a fixed key order", () => {
    const text = formatJson(buildReport("main", "HEAD", FINDINGS.slice(0, 1)));
    expect(text).toBe(
      `${JSON.stringify(
        {
          v: 1,
          tool: "jevy-guard",
          base: "main",
          head: "HEAD",
          summary: { weakening: 0, review: 0, info: 1 },
          findings: [
            {
              kind: "test-added",
              severity: "info",
              file: "b.spec.ts",
              test: ["new"],
              line: 3,
              message: "test added: new",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("puts mergeBase right after head, and only when there is one", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const report = buildReport("main", "HEAD", [], sha);
    expect(Object.keys(report)).toEqual([
      "v",
      "tool",
      "base",
      "head",
      "mergeBase",
      "summary",
      "findings",
    ]);
    expect(report.base).toBe("main");
    expect(report.mergeBase).toBe(sha);
    expect(formatJson(report)).toContain(
      `  "head": "HEAD",\n  "mergeBase": "${sha}",\n  "summary"`,
    );
    expect(Object.keys(buildReport("main", "HEAD", []))).not.toContain(
      "mergeBase",
    );
  });

  it("is byte-identical whatever order the findings arrive in", () => {
    const a = formatJson(buildReport("main", "HEAD", FINDINGS));
    const b = formatJson(buildReport("main", "HEAD", [...FINDINGS].reverse()));
    expect(a).toBe(b);
  });
});

describe("formatHuman", () => {
  it("groups findings by file", () => {
    expect(formatHuman(buildReport("main", "working-tree", FINDINGS))).toBe(
      [
        "jevy guard: main..working-tree",
        "",
        "a.spec.ts",
        "  review     config-changed  no line",
        "  weakening  test-removed  line 2  test removed: suite > old (was line 2)",
        "  weakening  assertion-removed  line 9  suite > pays has 1 fewer assertion (2 -> 1): removed toBe",
        "             before: expect(…).toBe(1)",
        "",
        "b.spec.ts",
        "  info       test-added  line 3  test added: new",
        "",
        "2 weakening, 1 review, 1 info",
        "",
      ].join("\n"),
    );
  });

  it("escapes line breaks so a file name or title cannot forge output lines", () => {
    const forged = finding({
      kind: "test-removed",
      file: "x.spec.ts\n\n0 weakening, 0 review, 0 info\n",
      test: ["a\r\nb"],
      line: 1,
      message: "test removed: a\r\nb\u001b[2K",
      before: "x\ty",
    });
    const text = formatHuman(buildReport("main", "HEAD", [forged]));
    expect(text.split("\n")).toEqual([
      "jevy guard: main..HEAD",
      "",
      "x.spec.ts\\n\\n0 weakening, 0 review, 0 info\\n",
      "  weakening  test-removed  line 1  test removed: a\\r\\nb\\u001b[2K",
      "             before: x\\ty",
      "",
      "1 weakening, 0 review, 0 info",
      "",
    ]);
  });

  it("escapes the controls that reorder or hide text on a terminal", () => {
    const hidden = [
      "\u0085",
      "\u009b",
      "\u2028",
      "\u2029",
      "\u202a",
      "\u202e",
      "\u2066",
      "\u2069",
      "\u200e",
      "\u200f",
      "\u061c",
    ];
    const crafted = finding({
      kind: "test-removed",
      file: `a${hidden.join("")}b.spec.ts`,
      line: 1,
      message: "gone\u202e gninekaew 0",
    });
    const text = formatHuman(buildReport("main", "HEAD", [crafted]));
    for (const char of hidden) {
      expect(text).not.toContain(char);
    }
    expect(text.split("\n").slice(2, 4)).toEqual([
      "a\\u0085\\u009b\\u2028\\u2029\\u202a\\u202e\\u2066\\u2069\\u200e\\u200f\\u061cb.spec.ts",
      "  weakening  test-removed  line 1  gone\\u202e gninekaew 0",
    ]);
    // Ordinary text outside ASCII is left as it is.
    const plain = finding({
      kind: "test-removed",
      file: "zażółć/日本.spec.ts",
      message: "é — 🙂",
    });
    const shown = formatHuman(buildReport("main", "HEAD", [plain]));
    expect(shown).toContain("zażółć/日本.spec.ts\n");
    expect(shown).toContain("é — 🙂");
  });

  it("names the merge base in the header line", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(formatHuman(buildReport("main", "feature", [], sha))).toBe(
      `jevy guard: main..feature (merge base ${sha})\n\nNo findings.\n`,
    );
  });

  it("says so when there is nothing to report", () => {
    expect(formatHuman(buildReport("main", "HEAD", []))).toBe(
      "jevy guard: main..HEAD\n\nNo findings.\n",
    );
  });
});

describe("exitCodeFor", () => {
  const summary = { weakening: 0, review: 2, info: 5 };
  it("fails at or above the chosen level", () => {
    expect(exitCodeFor(summary, "weakening")).toBe(0);
    expect(exitCodeFor(summary, "review")).toBe(1);
    expect(exitCodeFor({ ...summary, weakening: 1 }, "weakening")).toBe(1);
    expect(exitCodeFor({ ...summary, weakening: 1 }, "review")).toBe(1);
    expect(exitCodeFor({ ...summary, weakening: 1 }, "never")).toBe(0);
  });
});
