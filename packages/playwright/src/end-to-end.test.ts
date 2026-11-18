import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THRESHOLDS,
  JsonlDecisionStore,
  createDecisionSession,
} from "@jevyjs/core";
import type { Decider, DecisionSession, Question } from "@jevyjs/core";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotAccessibility } from "./snapshot.js";

/**
 * The first run through every Step 1 piece together: a real page, the
 * snapshot bridge, the decision session and the JSONL store. No model is
 * involved; the decider is a stand-in that reads the snapshot it is given.
 */
const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";
const SPEC = "tests/checkout.spec.ts";
const QUESTION: Question = {
  kind: "yesno",
  prompt: "The page shows the order as confirmed",
};
const CONFIRMED = `
<main>
  <h1>Order confirmed</h1>
  <p>Placed 2026-11-18T10:15:00Z</p>
  <label>PIN <input type="password" id="pin"></label>
  <button>Continue</button>
</main>`;

let browser: Browser;
let page: Page;
let dir: string;
let calls = 0;

const decider: Decider = {
  id: "fake",
  model: "fake-1",
  decide(state) {
    calls += 1;
    const text = JSON.stringify(state.snapshot);
    const confirmed = text.includes("Order confirmed");
    return Promise.resolve({
      answer: { value: confirmed ? "yes" : "no", confidence: 0.95 },
    });
  },
};

const neverCalled: Decider = {
  id: "fake",
  model: "fake-1",
  decide() {
    throw new Error("replay must not call the decider");
  },
};

function session(
  mode: "record" | "replay",
  using: Decider = decider,
): DecisionSession {
  return createDecisionSession({
    store: new JsonlDecisionStore({ dir }),
    mode,
    deciderId: "fake",
    model: "fake-1",
    decider: using,
    thresholds: DEFAULT_THRESHOLDS,
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  });
}

async function ask(using: DecisionSession, step = "toSatisfy#1") {
  const snapshot = await snapshotAccessibility(page);
  return using.decide({
    spec: SPEC,
    step,
    question: QUESTION,
    state: { snapshot },
  });
}

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw error;
    browser = await chromium.launch({ executablePath: FALLBACK_CHROMIUM });
  }
  page = await browser.newPage();
  dir = await mkdtemp(join(tmpdir(), "jevy-e2e-"));
});

afterAll(async () => {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
});

describe("page to cached verdict", () => {
  it("records a verdict from a real page and writes it only on confirm", async () => {
    await page.setContent(CONFIRMED);
    await page.locator("#pin").fill("4471");
    const recording = session("record");
    const outcome = await ask(recording);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.source).toBe("decider");
    expect(existsSync(join(dir, `${SPEC}.jsonl`))).toBe(false);

    await recording.confirm();
    const written = await readFile(join(dir, `${SPEC}.jsonl`), "utf8");
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(written).not.toContain("4471");
    expect(written).not.toContain("Order confirmed");
    expect(calls).toBe(1);
  });

  it("replays it with no decider call, across a cosmetic change", async () => {
    await page.setContent(
      CONFIRMED.replace("2026-11-18T10:15:00Z", "2026-11-19T08:00:00Z"),
    );
    await page.locator("#pin").fill("9020");
    const outcome = await ask(session("replay", neverCalled));
    expect(outcome.verdict).toBe("pass");
    expect(outcome.source).toBe("cache");
    expect(calls).toBe(1);
  });

  it("misses with a reason when the page really changes", async () => {
    await page.setContent(CONFIRMED.replace("Order confirmed", "Order failed"));
    const outcome = await ask(session("replay", neverCalled));
    expect(outcome.verdict).toBe("needs-review");
    expect(outcome.source).toBe("none");
    expect(outcome.reason).toBe("snapshot-changed");
  });

  it("reports no-entry for a step that was never recorded", async () => {
    await page.setContent(CONFIRMED);
    const outcome = await ask(session("replay", neverCalled), "toSatisfy#2");
    expect(outcome.verdict).toBe("needs-review");
    expect(outcome.reason).toBe("no-entry");
  });
});
