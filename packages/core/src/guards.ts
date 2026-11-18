export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collapseWhitespace(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * A copy of `pattern` without the `g`, `y` and `d` flags. A check must not
 * depend on, or move, the `lastIndex` a caller's global or sticky expression
 * carries; redaction and normalisation build a fresh expression the same way.
 */
export function withoutStateFlags(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gyd]/g, ""));
}

/**
 * Sample text for `canMatchEmpty`: every printable ASCII character, common
 * whitespace, and a non-ASCII letter and emoji, so lookarounds and word
 * boundaries have something to stand next to.
 */
const EMPTY_MATCH_PROBE = `${Array.from({ length: 0x7f - 0x20 }, (_, index) =>
  String.fromCharCode(0x20 + index),
).join("")}\t\n é 😀 [REDACTED] word`;

/**
 * True when `pattern` can match an empty span: it matches `""`, or finds a
 * zero-length match somewhere in a sample text (`\b`, `^`, `(?=x)`). Replacing
 * an empty match inserts text without consuming any, so a rule like that
 * never settles. The sample is a heuristic, not a proof: a lookaround that
 * needs text the sample lacks is not caught.
 */
export function canMatchEmpty(pattern: RegExp): boolean {
  const single = withoutStateFlags(pattern);
  if (single.test("")) return true;
  const global = new RegExp(single.source, `${single.flags}g`);
  for (const match of EMPTY_MATCH_PROBE.matchAll(global)) {
    if (match[0].length === 0) return true;
  }
  return false;
}
