import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { LlmAdapter } from "@jevyjs/core";

/** What the scripted model can judge: `The page shows "<text>"`. */
const SHOWS = /^The page shows "(.+)"$/;

/**
 * A scripted model for the step 3 fixture, under the real `llmDecider`. No
 * network and no model.
 *
 * It reads the statement and the rendered snapshot from the prompt, and
 * answers like this:
 *
 * - `The page shows "<text>"`: "yes" when the page state holds that quoted
 *   text, else "no". `The page shows "Order confirmed"` on the confirmed
 *   page is a pass; `The page shows "Payment taken"` on the pending page,
 *   which shows "Payment pending", is a fail.
 * - Anything else, such as "The logo is the brand's shade of blue" (no
 *   colour is in an accessibility tree): the abstain value, so needs-review.
 *
 * Each call appends one JSON line, the statement and the value chosen, to
 * `calls.log` under JEVY_STEP3_DIR, so the test can count calls.
 */
export const scriptedAdapter: LlmAdapter = {
  complete(prompt) {
    const quoted = /^Prompt: (".*")$/m.exec(prompt)?.[1] ?? '""';
    const statement = JSON.parse(quoted) as string;
    // The instructions name the markers too, so match them on their own lines.
    const state = prompt.slice(
      prompt.indexOf("\nBEGIN PAGE STATE\n"),
      prompt.indexOf("\nEND PAGE STATE\n"),
    );
    const wanted = SHOWS.exec(statement)?.[1];
    const value =
      wanted === undefined
        ? "inconclusive"
        : state.includes(JSON.stringify(wanted))
          ? "yes"
          : "no";
    appendFileSync(
      join(process.env["JEVY_STEP3_DIR"] ?? "", "calls.log"),
      `${JSON.stringify({ statement, value })}\n`,
    );
    const confidence = value === "inconclusive" ? 0.3 : 0.95;
    return Promise.resolve({ answer: { value, confidence } });
  },
};
