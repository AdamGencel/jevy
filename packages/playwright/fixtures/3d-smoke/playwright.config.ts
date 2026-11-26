import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { defineConfig } from "@playwright/test";

// A tiny project for the 3d smoke test (src/matcher.smoke.test.ts).
// Everything a run writes goes under JEVY_SMOKE_DIR, never into the repo.
const dir = process.env["JEVY_SMOKE_DIR"];
if (dir === undefined || dir === "") {
  throw new Error("JEVY_SMOKE_DIR must name the directory a run writes to");
}

const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests",
  outputDir: join(dir, "out"),
  retries: 1,
  workers: 2,
  fullyParallel: true,
  reporter: [
    ["list"],
    ["@jevyjs/playwright/reporter", { outputFile: join(dir, "report.json") }],
  ],
  use: existsSync(FALLBACK_CHROMIUM)
    ? { launchOptions: { executablePath: FALLBACK_CHROMIUM } }
    : {},
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
