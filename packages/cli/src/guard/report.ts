import { sortFindings } from "./findings.js";
import type {
  FailOn,
  Finding,
  GuardReport,
  GuardSummary,
  Severity,
} from "./types.js";

/** Build the versioned report. Findings are sorted here, whatever their order. */
export function buildReport(
  base: string,
  head: string,
  findings: readonly Finding[],
): GuardReport {
  const count = (severity: Severity): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return {
    v: 1,
    tool: "jevy-guard",
    base,
    head,
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
 * File names, titles and decision lines come from the repository under
 * check. Escaping control characters keeps one finding on one line, so a
 * crafted name cannot print a fake summary or clear the terminal line.
 */
function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out +=
      code < 0x20 || code === 0x7f
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
  const lines = [
    `jevy guard: ${printable(report.base)}..${printable(report.head)}`,
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
