import { join } from "node:path";
import process from "node:process";
import type { JevyConfig } from "@jevyjs/core";
import { scriptedAdapter } from "./scripted-adapter.js";

// The step 3 fixture (src/step-3.integration.test.ts). Everything a run
// writes goes under JEVY_STEP3_DIR, never into the repo. toSatisfy.blocking
// is not set, so every verdict is advisory; blocking/ is the same project
// with it on. JEVY_STEP3_CACHE points a run at another cache directory, such
// as an empty one, as a fresh clone has.
export default {
  decider: "llm",
  deciders: { llm: { adapter: scriptedAdapter, model: "scripted/step-3" } },
  cache: {
    dir:
      process.env["JEVY_STEP3_CACHE"] ??
      join(process.env["JEVY_STEP3_DIR"] ?? "", "decisions"),
  },
} satisfies JevyConfig;
