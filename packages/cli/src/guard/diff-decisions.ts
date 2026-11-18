import { finding, sortFindings } from "./findings.js";
import type { Finding } from "./types.js";

/**
 * Compares two versions of one decision-cache file (JSON Lines). Records are
 * append-only, so the diff is a multiset difference of lines: reordering is
 * not a change, and an edited line is one removal plus one addition.
 *
 * The record type lives in `@jevyjs/core`, but the guard reads it
 * defensively instead: a forged or half-written record is exactly what it
 * has to describe, and it must not depend on the record being valid.
 */

export interface DecisionFileChange {
  readonly file: string;
  readonly before: string | null;
  readonly after: string | null;
}

interface Line {
  readonly text: string;
  readonly line: number;
}

const FIELDS = ["key", "spec", "step", "verdict", "reviewedBy"] as const;

function linesOf(text: string | null): Line[] {
  if (text === null) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ text: raw.trim(), line: index + 1 }))
    .filter((entry) => entry.text !== "");
}

/** Lines of `a` not matched in `b`, counting duplicates. */
function minus(a: readonly Line[], b: readonly Line[]): Line[] {
  const remaining = new Map<string, number>();
  for (const entry of b) {
    remaining.set(entry.text, (remaining.get(entry.text) ?? 0) + 1);
  }
  return a.filter((entry) => {
    const count = remaining.get(entry.text) ?? 0;
    if (count > 0) {
      remaining.set(entry.text, count - 1);
      return false;
    }
    return true;
  });
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  return typeof value === "string" ? value : "?";
}

function describeRecord(record: Record<string, unknown>): string {
  return `${textField(record, "spec")} ${textField(record, "step")} (verdict ${textField(record, "verdict")})`;
}

function missingFields(record: Record<string, unknown>): string[] {
  return FIELDS.filter((name) => {
    const value = record[name];
    if (name === "reviewedBy") {
      return !(name in record) || (value !== null && typeof value !== "string");
    }
    return typeof value !== "string";
  });
}

function addedFinding(file: string, entry: Line): Finding {
  const record = parseRecord(entry.text);
  if (record === null) {
    return finding({
      file,
      line: entry.line,
      kind: "decision-unreadable",
      message: "added line is not a JSON object",
      after: entry.text,
    });
  }
  const reviewer = record["reviewedBy"];
  if (reviewer !== null && reviewer !== undefined) {
    return finding({
      file,
      line: entry.line,
      kind: "approval-added",
      message: `approval added by ${JSON.stringify(reviewer)} for ${describeRecord(record)}; a human approval must be made by a human`,
      after: entry.text,
    });
  }
  const missing = missingFields(record);
  const note =
    missing.length === 0 ? "" : `; missing or invalid: ${missing.join(", ")}`;
  return finding({
    file,
    line: entry.line,
    kind: "decision-added",
    message: `decision added for ${describeRecord(record)}${note}`,
    after: entry.text,
  });
}

function removedFinding(file: string, entry: Line): Finding {
  const record = parseRecord(entry.text);
  return finding({
    file,
    line: entry.line,
    kind: "decision-removed",
    message:
      record === null
        ? "removed a line that is not a JSON object"
        : `decision removed for ${describeRecord(record)}`,
    before: entry.text,
  });
}

/** Findings for one `.jsonl` file in the decision cache, sorted. */
export function diffDecisionFile(
  change: DecisionFileChange,
): readonly Finding[] {
  const before = linesOf(change.before);
  const after = linesOf(change.after);
  return sortFindings([
    ...minus(after, before).map((entry) => addedFinding(change.file, entry)),
    ...minus(before, after).map((entry) => removedFinding(change.file, entry)),
  ]);
}
