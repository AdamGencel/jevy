import { describe, expect, it } from "vitest";
import { diffDecisionFile } from "./diff-decisions.js";
import type { Finding } from "./types.js";

const FILE = ".jevy/decisions/checkout.spec.ts.jsonl";

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    key: "sha256:aa",
    spec: "tests/checkout.spec.ts",
    step: "toSatisfy#1",
    verdict: "pass",
    reviewedBy: null,
    ...fields,
  });
}

const A = record({ key: "sha256:aa" });
const B = record({ key: "sha256:bb", step: "toSatisfy#2" });

function diff(before: string | null, after: string | null): Finding[] {
  return [...diffDecisionFile({ file: FILE, before, after })];
}

describe("diffDecisionFile", () => {
  it("flags an added line with a reviewer as weakening", () => {
    const approved = record({
      key: "sha256:cc",
      verdict: "pass",
      reviewedBy: "alice",
    });
    expect(diff(`${A}\n`, `${A}\n${approved}\n`)).toEqual([
      {
        kind: "approval-added",
        severity: "weakening",
        file: FILE,
        line: 2,
        message:
          'approval added by "alice" for tests/checkout.spec.ts toSatisfy#1 (verdict pass); a human approval must be made by a human',
        after: approved,
      },
    ]);
  });

  it("reports other added lines for review", () => {
    expect(diff(`${A}\n`, `${A}\n${B}\n`)).toEqual([
      {
        kind: "decision-added",
        severity: "review",
        file: FILE,
        line: 2,
        message:
          "decision added for tests/checkout.spec.ts toSatisfy#2 (verdict pass)",
        after: B,
      },
    ]);
  });

  it("reads records defensively", () => {
    const partial = JSON.stringify({ verdict: 3 });
    expect(diff(null, `${partial}\n`)).toMatchObject([
      {
        kind: "decision-added",
        message:
          "decision added for ? ? (verdict ?); missing or invalid: key, spec, step, verdict, reviewedBy",
      },
    ]);
  });

  it("reports removed lines with their base line number", () => {
    expect(diff(`${A}\n${B}\n`, `${B}\n`)).toEqual([
      {
        kind: "decision-removed",
        severity: "review",
        file: FILE,
        line: 1,
        message:
          "decision removed for tests/checkout.spec.ts toSatisfy#1 (verdict pass)",
        before: A,
      },
    ]);
  });

  it("reports every line of a deleted file as removed", () => {
    expect(diff(`${A}\n${B}\n`, null).map((f) => f.kind)).toEqual([
      "decision-removed",
      "decision-removed",
    ]);
  });

  it("reports an added line that is not a JSON object", () => {
    expect(diff(`${A}\n`, `${A}\n{"key":\n[1]\n`)).toMatchObject([
      { kind: "decision-unreadable", severity: "review", line: 2 },
      { kind: "decision-unreadable", severity: "review", line: 3 },
    ]);
  });

  it("treats a changed line as one removal and one addition", () => {
    const flipped = record({ key: "sha256:aa", verdict: "fail" });
    expect(diff(`${A}\n`, `${flipped}\n`).map((f) => f.kind)).toEqual([
      "decision-added",
      "decision-removed",
    ]);
  });

  it("finds nothing for reordered lines, blank lines or a missing final newline", () => {
    expect(diff(`${A}\n${B}\n`, `${B}\n\n${A}`)).toEqual([]);
  });
});
