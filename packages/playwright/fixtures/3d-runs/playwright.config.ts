import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { defineConfig } from "@playwright/test";

// The project src/matcher.runs.test.ts runs to check the matcher and fixtures
// in real Playwright runs: secrets in contexts a test opens itself, the time
// budget, duplicate calls across workers, which records a test keeps, hooks
// and runs repeated by one runner. The test names the spec files each run
// takes. Everything a run writes goes under JEVY_RUNS_DIR, never into the repo.
const dir = process.env["JEVY_RUNS_DIR"];
if (dir === undefined || dir === "") {
  throw new Error("JEVY_RUNS_DIR must name the directory a run writes to");
}

const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests",
  outputDir: join(dir, "out"),
  retries: 0,
  workers: 4,
  fullyParallel: true,
  reporter: [
    ["list"],
    // Read by the test for each test's status only.
    ["json", { outputFile: join(dir, "results.json") }],
    ["@jevyjs/playwright/reporter", { outputFile: join(dir, "report.json") }],
  ],
  use: existsSync(FALLBACK_CHROMIUM)
    ? { launchOptions: { executablePath: FALLBACK_CHROMIUM } }
    : {},
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
