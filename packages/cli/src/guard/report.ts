import { sortFindings } from "./findings.js";
import type {
  FailOn,
  Finding,
  GuardReport,
  GuardSummary,
  Severity,
} from "./types.js";

/**
 * Build the versioned report. Findings are sorted here, whatever their order.
 *
 * `base` is always the ref the user gave. `mergeBase` is the commit that was
 * compared against in its place under `--merge-base`; without it the key is
 * left out, so the JSON is what it was before the flag existed.
 */
export function buildReport(
  base: string,
  head: string,
  findings: readonly Finding[],
  mergeBase?: string,
): GuardReport {
  const count = (severity: Severity): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return {
    v: 1,
    tool: "jevy-guard",
    base,
    head,
    ...(mergeBase === undefined ? {} : { mergeBase }),
    summary: {
      weakening: count("weakening"),
      review: count("review"),
      info: count("info"),
    },
    findings: sortFindings(findings),
  };
}

/**
 * Exactly one JSON document and a newline. Keys are written in the order the
 * report is built in, so the bytes are stable across runs and machines.
 */
export function formatJson(report: GuardReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Whether a terminal acts on `code` instead of drawing it: the C0 and C1
 * controls and DEL (U+0085 is a line break, U+009B starts an escape
 * sequence), the line and paragraph separators, and the bidirectional
 * controls, which reorder the text around them or hide it.
 */
function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * File names, titles and decision lines come from the repository under
 * check. Escaping control characters keeps one finding on one line and in
 * the order it was written, so a crafted name cannot print a fake summary,
 * clear the terminal line, or show its text reversed.
 */
function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += isControl(code)
      ? (ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, "0")}`)
      : char;
  }
  return out;
}

function indentDetail(label: string, text: string | undefined): string[] {
  return text === undefined
    ? []
    : [`             ${label}: ${printable(text)}`];
}

/** Human output: one block per file, one line per finding. */
export function formatHuman(report: GuardReport): string {
  const against =
    report.mergeBase === undefined
      ? ""
      : ` (merge base ${printable(report.mergeBase)})`;
  const lines = [
    `jevy guard: ${printable(report.base)}..${printable(report.head)}${against}`,
    "",
  ];
  if (report.findings.length === 0) {
    return [...lines, "No findings.", ""].join("\n");
  }
  let file: string | null = null;
  for (const finding of report.findings) {
    if (finding.file !== file) {
      if (file !== null) {
        lines.push("");
      }
      file = finding.file;
      lines.push(printable(file));
    }
    const where =
      finding.line === undefined ? "" : `line ${String(finding.line)}  `;
    lines.push(
      `  ${finding.severity.padEnd(9)}  ${finding.kind}  ${where}${printable(finding.message)}`,
      ...indentDetail("before", finding.before),
      ...indentDetail("after", finding.after),
    );
  }
  const { weakening, review, info } = report.summary;
  lines.push(
    "",
    `${String(weakening)} weakening, ${String(review)} review, ${String(info)} info`,
    "",
  );
  return lines.join("\n");
}

/** 1 when anything is at or above `failOn`, else 0. */
export function exitCodeFor(summary: GuardSummary, failOn: FailOn): 0 | 1 {
  switch (failOn) {
    case "never":
      return 0;
    case "review":
      return summary.weakening + summary.review > 0 ? 1 : 0;
    case "weakening":
      return summary.weakening > 0 ? 1 : 0;
  }
}
