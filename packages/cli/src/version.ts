import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPackageVersion(packageJsonUrl: URL): string {
  const packageJsonPath = fileURLToPath(packageJsonUrl);
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw) as unknown;
  const version = isRecord(parsed) ? parsed["version"] : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Package version missing in ${packageJsonPath}`);
  }
  return version;
}
