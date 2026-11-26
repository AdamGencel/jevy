import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { defineConfig } from "@playwright/test";

// A CommonJS project: its package.json has no "type", so Playwright compiles
// these files to CommonJS and loads Jevy's packages with require(). The test
// copies this directory to a temporary one with its own node_modules, and
// everything a run writes goes under JEVY_CJS_DIR.
const dir = process.env["JEVY_CJS_DIR"];
if (dir === undefined || dir === "") {
  throw new Error("JEVY_CJS_DIR must name the directory a run writes to");
}

const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests",
  outputDir: join(dir, "out"),
  workers: 1,
  reporter: [
    ["list"],
    ["@jevyjs/playwright/reporter", { outputFile: join(dir, "report.json") }],
  ],
  use: existsSync(FALLBACK_CHROMIUM)
    ? { launchOptions: { executablePath: FALLBACK_CHROMIUM } }
    : {},
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
