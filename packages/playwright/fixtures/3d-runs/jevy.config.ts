import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { JevyConfig, LlmAdapter } from "@jevyjs/core";

const dir = process.env["JEVY_RUNS_DIR"] ?? "";

/** A value no snapshot may carry to the model: tests/contexts.spec.ts types it. */
export const SECRET = "hunter2-secret-value";

/** `[Slow <ms> ]Shows <text>` */
const STATEMENT = /^(?:Slow (\d+) )?Shows (.+)$/;

/**
 * A scripted model, under the real `llmDecider`. No network.
 *
 * "Shows <text>" is yes when the rendered page state holds the quoted text,
 * else no. "Slow <ms> Shows <text>" answers the same after <ms>. Anything
 * else abstains. Each call appends one JSON line to calls.log: the
 * statement, and whether the prompt held the secret.
 */
const adapter: LlmAdapter = {
  complete(prompt) {
    const quoted = /^Prompt: (".*")$/m.exec(prompt)?.[1] ?? '""';
    const statement = JSON.parse(quoted) as string;
    appendFileSync(
      join(dir, "calls.log"),
      `${JSON.stringify({ statement, leak: prompt.includes(SECRET) })}\n`,
    );
    const state = prompt.slice(
      prompt.indexOf("\nBEGIN PAGE STATE\n"),
      prompt.indexOf("\nEND PAGE STATE\n"),
    );
    const match = STATEMENT.exec(statement);
    const wanted = match?.[2];
    const value =
      wanted === undefined
        ? "inconclusive"
        : state.includes(JSON.stringify(wanted))
          ? "yes"
          : "no";
    const reply = { answer: { value, confidence: 0.95 } };
    const delay = Number(match?.[1] ?? "0");
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(reply);
      }, delay);
    });
  },
};

export default {
  decider: "llm",
  deciders: { llm: { adapter, model: "scripted/runs-1" } },
  cache: { dir: join(dir, "decisions") },
  toSatisfy: { blocking: process.env["JEVY_RUNS_BLOCKING"] === "1" },
} satisfies JevyConfig;
