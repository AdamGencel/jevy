import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { JevyConfig, LlmAdapter } from "@jevyjs/core";

const dir = process.env["JEVY_SMOKE_DIR"] ?? "";

/**
 * A scripted model, under the real `llmDecider`. It reads the statement and
 * the rendered snapshot from the prompt and logs one line per call, so the
 * test can count calls. No network.
 *
 * - "Shows <text>": yes when the snapshot holds the quoted text, else no.
 * - "Unsure …": the abstain value.
 * - "Unreachable …": the call throws, as a model that is down would.
 */
const adapter: LlmAdapter = {
  complete(prompt) {
    const statement = /^Prompt: "(.*)"$/m.exec(prompt)?.[1] ?? "";
    appendFileSync(join(dir, "calls.log"), `${JSON.stringify(statement)}\n`);
    if (statement.startsWith("Unreachable")) {
      return Promise.reject(new Error("the model is down"));
    }
    if (statement.startsWith("Unsure")) {
      return Promise.resolve({
        answer: { value: "inconclusive", confidence: 0.3 },
      });
    }
    // The instructions name the markers too, so match them on their own lines.
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
  deciders: { llm: { adapter, model: "scripted/smoke-1" } },
  cache: { dir: join(dir, "decisions") },
  toSatisfy: { blocking: process.env["JEVY_SMOKE_BLOCKING"] === "1" },
};

export default config;
