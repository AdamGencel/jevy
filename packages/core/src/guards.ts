export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collapseWhitespace(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}
