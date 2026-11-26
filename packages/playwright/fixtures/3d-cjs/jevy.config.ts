import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DEFAULT_THRESHOLDS } from "@jevyjs/core";
import type { JevyConfig, LlmAdapter } from "@jevyjs/core";
import { llmDeciderId } from "@jevyjs/deciders-llm";

// A .ts config in a CommonJS project: Playwright compiles it to CommonJS,
// and core's loadConfig unwraps the compiled module's default export.
const dir = process.env["JEVY_CJS_DIR"] ?? "";
const MODEL = "scripted/cjs-1";

/**
 * A scripted model: "Shows <text>" is yes when the page state holds the
 * quoted text. Each call logs the statement and the decider id.
 */
const adapter: LlmAdapter = {
  complete(prompt) {
    const statement = /^Prompt: "(.*)"$/m.exec(prompt)?.[1] ?? "";
    appendFileSync(
      join(dir, "calls.log"),
      `${JSON.stringify({ statement, decider: llmDeciderId(MODEL) })}\n`,
    );
    const state = prompt.slice(
      prompt.indexOf("\nBEGIN PAGE STATE\n"),
      prompt.indexOf("\nEND PAGE STATE\n"),
    );
    const wanted = statement.replace(/^Shows /, "");
    const value = state.includes(`"${wanted}"`) ? "yes" : "no";
    return Promise.resolve({ answer: { value, confidence: 0.95 } });
  },
};

const config: JevyConfig = {
  decider: "llm",
  deciders: { llm: { adapter, model: MODEL } },
  thresholds: { ...DEFAULT_THRESHOLDS },
  cache: { dir: join(dir, "decisions") },
};

export default config;
