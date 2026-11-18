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
