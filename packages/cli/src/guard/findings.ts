import type { Finding, FindingKind, Severity } from "./types.js";

/** Severity of every kind, in one place so the report and the docs agree. */
export const SEVERITY: Readonly<Record<FindingKind, Severity>> = {
  "test-file-removed": "weakening",
  "test-removed": "weakening",
  "assertion-removed": "weakening",
  "skip-added": "weakening",
  "only-added": "weakening",
  "expected-failure-added": "weakening",
  "soft-added": "weakening",
  "threshold-lowered": "weakening",
  "needs-review-relaxed": "weakening",
  "approval-added": "weakening",
  "statement-changed": "review",
  "assertion-changed": "review",
  "dynamic-title": "review",
  "cases-changed": "review",
  unparseable: "review",
  "redaction-rules-changed": "review",
  "normalise-rules-changed": "review",
  "decider-changed": "review",
  "config-changed": "review",
  "retries-raised": "review",
  "decision-added": "review",
  "decision-removed": "review",
  "decision-unreadable": "review",
  "test-renamed": "info",
  "test-added": "info",
  "assertion-added": "info",
};

export interface FindingInput {
  readonly kind: FindingKind;
  readonly file: string;
  readonly message: string;
  readonly test?: readonly string[] | undefined;
  readonly line?: number | undefined;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

/**
 * Build a finding with its severity, leaving out absent optional fields so
 * the JSON has no `undefined` holes and key order is always the same.
 */
export function finding(input: FindingInput): Finding {
  return {
    kind: input.kind,
    severity: SEVERITY[input.kind],
    file: input.file,
    ...(input.test === undefined ? {} : { test: input.test }),
    ...(input.line === undefined ? {} : { line: input.line }),
    message: input.message,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
  };
}

/** Code-unit order, never locale order: output must not depend on the machine. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Sort by file, then line, then kind. The remaining keys only break ties, so
 * two runs over the same input always print the same bytes.
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.kind, b.kind) ||
    compareText((a.test ?? []).join("\u0000"), (b.test ?? []).join("\u0000")) ||
    compareText(a.message, b.message) ||
    compareText(a.before ?? "", b.before ?? "") ||
    compareText(a.after ?? "", b.after ?? "")
  );
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/** Display form of a title path. */
export function titleText(path: readonly string[]): string {
  return path.join(" > ");
}

/** Items of `a` not matched in `b`, counting duplicates, in the order of `a`. */
export function multisetMinus(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const remaining = new Map<string, number>();
  for (const item of b) {
    remaining.set(item, (remaining.get(item) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const item of a) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) {
      remaining.set(item, count - 1);
    } else {
      out.push(item);
    }
  }
  return out;
}

export function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}
