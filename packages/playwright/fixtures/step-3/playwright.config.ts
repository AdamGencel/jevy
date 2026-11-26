import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { defineConfig } from "@playwright/test";

// The step 3 fixture project, run by src/step-3.integration.test.ts. The
// test serves pages/ on 127.0.0.1 and names the server in JEVY_STEP3_URL.
// Everything a run writes goes under JEVY_STEP3_DIR, never into the repo.
const dir = process.env["JEVY_STEP3_DIR"];
const baseURL = process.env["JEVY_STEP3_URL"];
if (dir === undefined || dir === "" || baseURL === undefined) {
  throw new Error("JEVY_STEP3_DIR and JEVY_STEP3_URL must be set");
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
    // Read by the test for each test's status only; the agent reads report.json.
    ["json", { outputFile: join(dir, "results.json") }],
    ["@jevyjs/playwright/reporter", { outputFile: join(dir, "report.json") }],
  ],
  use: {
    baseURL,
    ...(existsSync(FALLBACK_CHROMIUM)
      ? { launchOptions: { executablePath: FALLBACK_CHROMIUM } }
      : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
