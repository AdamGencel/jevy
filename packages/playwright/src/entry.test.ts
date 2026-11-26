import {
  ConfigError,
  DeciderError,
  MemoryDecisionStore,
  createDecisionSession,
  decisionKey,
  hashSnapshot,
} from "@jevyjs/core";
import type {
  AccessibilityNode,
  CacheMode,
  Decider,
  DecisionOutcome,
  Question,
  RedactRule,
} from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import {
  annotationOf,
  buildReportEntry,
  deciderErrorOutcome,
  jevyRoot,
  reasonOf,
  specInRoot,
  specOf,
  stepOf,
  testTitles,
} from "./entry.js";
import type { EntryContext } from "./entry.js";
import { ReportError, validateReportEntry } from "./report/schema.js";

const SPEC = "tests/checkout.spec.ts";
const DECIDER = { id: "llm:m", model: "m" } as const;
const THRESHOLDS = { pass: 0.8, fail: 0.5 } as const;
const QUESTION: Question = {
  kind: "yesno",
  prompt: "The order   is shown\nas confirmed",
};
const SNAPSHOT: AccessibilityNode = {
  role: "main",
  children: [{ role: "heading", name: "Order confirmed", level: 1 }],
};

function answering(
  value: string,
  confidence: number,
  abstained = false,
): Decider {
  return {
    ...DECIDER,
    decide: () => Promise.resolve({ answer: { value, confidence, abstained } }),
  };
}

async function outcomeOf(
  mode: CacheMode,
  decider?: Decider,
  store = new MemoryDecisionStore(),
): Promise<DecisionOutcome> {
  const session = createDecisionSession({
    store,
    mode,
    deciderId: DECIDER.id,
    model: DECIDER.model,
    ...(decider !== undefined ? { decider } : {}),
    thresholds: THRESHOLDS,
  });
  const outcome = await session.decide({
    spec: SPEC,
    step: "checkout › pays#1",
    question: QUESTION,
    state: { snapshot: SNAPSHOT },
  });
  await session.confirm();
  return outcome;
}

function context(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    spec: SPEC,
    project: "chromium",
    test: ["checkout", "pays"],
    step: "checkout › pays#1",
    line: 7,
    retry: 0,
    target: "locator",
    question: QUESTION,
    decider: DECIDER,
    mode: "record",
    effect: "reported",
    redact: [],
    ...overrides,
  };
}

describe("identity", () => {
  it("the Jevy root is the config file's directory, else rootDir", () => {
    expect(
      jevyRoot({ configFile: "/repo/e2e/playwright.config.ts", rootDir: "/x" }),
    ).toBe("/repo/e2e");
    expect(jevyRoot({ configFile: undefined, rootDir: "/repo/tests" })).toBe(
      "/repo/tests",
    );
  });

  it("the spec is the file relative to the root, with forward slashes", () => {
    expect(specOf("/repo", "/repo/tests/checkout.spec.ts")).toBe(
      "tests/checkout.spec.ts",
    );
    expect(specOf("/repo", "/elsewhere/a.spec.ts")).toBe(
      "../elsewhere/a.spec.ts",
    );
  });

  it("a spec outside the root is a ConfigError that names the root", () => {
    expect(specInRoot("/repo", "/repo/tests/checkout.spec.ts")).toBe(
      "tests/checkout.spec.ts",
    );
    for (const file of ["/elsewhere/a.spec.ts", "/a.spec.ts"]) {
      expect(() => specInRoot("/repo/e2e", file)).toThrow(ConfigError);
      expect(() => specInRoot("/repo/e2e", file)).toThrow(
        /inside the Jevy root, \/repo\/e2e,/,
      );
    }
    // A name that merely starts with two dots is inside.
    expect(specInRoot("/repo", "/repo/..spec.ts")).toBe("..spec.ts");
  });

  it("the test titles drop the file name and anonymous describes", () => {
    expect(testTitles(["tests/a.spec.ts", "checkout", "", "pays"])).toEqual([
      "checkout",
      "pays",
    ]);
    expect(testTitles(["a.spec.ts", "pays"])).toEqual(["pays"]);
  });

  it("the step joins the titles with › and counts calls from 1", () => {
    expect(stepOf(["checkout", "pays"], 1)).toBe("checkout › pays#1");
    expect(stepOf(["pays"], 12)).toBe("pays#12");
    expect(() => stepOf(["pays"], 0)).toThrow();
  });
});

describe("reasonOf", () => {
  it("follows the verdict, the source and the answer", async () => {
    expect(reasonOf(await outcomeOf("record", answering("yes", 0.95)))).toBe(
      null,
    );
    expect(reasonOf(await outcomeOf("record", answering("no", 0.95)))).toBe(
      "answered-no",
    );
    expect(
      reasonOf(await outcomeOf("record", answering("unsure", 0.2, true))),
    ).toBe("abstained");
    expect(reasonOf(await outcomeOf("record", answering("yes", 0.6)))).toBe(
      "low-confidence",
    );
    expect(reasonOf(await outcomeOf("replay"))).toBe("no-entry");
  });
});

describe("buildReportEntry", () => {
  it("maps each kind of outcome to an entry the reporter accepts", async () => {
    const cases: readonly (readonly [
      CacheMode,
      Decider | undefined,
      DecisionOutcome["verdict"],
    ])[] = [
      ["record", answering("yes", 0.95), "pass"],
      ["record", answering("no", 0.95), "fail"],
      ["replay-or-query", answering("unsure", 0.2, true), "needs-review"],
      ["replay-or-query", answering("no", 0.6), "needs-review"],
      ["replay", undefined, "needs-review"],
    ];
    for (const [mode, decider, verdict] of cases) {
      const outcome = await outcomeOf(mode, decider);
      expect(outcome.verdict).toBe(verdict);
      const effect = verdict === "pass" ? "none" : "reported";
      const entry = buildReportEntry(outcome, context({ mode, effect }));
      expect(validateReportEntry(entry)).toEqual(entry);
      expect(entry).toMatchObject({
        verdict,
        source: outcome.source,
        key: outcome.key,
        snapshotHash: outcome.snapshotHash,
        mode,
        effect,
      });
    }
  });

  it("a replayed hit carries source cache and no miss reason", async () => {
    const store = new MemoryDecisionStore();
    await outcomeOf("record", answering("yes", 0.95), store);
    const hit = await outcomeOf("replay", undefined, store);
    const entry = buildReportEntry(
      hit,
      context({ mode: "replay", effect: "none" }),
    );
    expect(entry).toMatchObject({
      source: "cache",
      missReason: null,
      reason: null,
      answer: { value: "yes", confidence: 0.95, abstained: false },
    });
  });

  it("the statement is the question as stored: collapsed, criteria on a second line", async () => {
    const outcome = await outcomeOf("record", answering("yes", 0.95));
    expect(
      buildReportEntry(outcome, context({ effect: "none" })).statement,
    ).toBe("The order is shown as confirmed");
    const withCriteria = buildReportEntry(
      outcome,
      context({
        effect: "none",
        question: { ...QUESTION, criteria: "A  total is shown" },
      }),
    );
    expect(withCriteria.statement).toBe(
      "The order is shown as confirmed\nCriteria: A total is shown",
    );
  });

  it("runs every text field through redaction", async () => {
    const outcome = await outcomeOf("record", answering("yes", 0.95));
    const redact: readonly RedactRule[] = [/ORDER-\d+/g];
    const entry = buildReportEntry(
      outcome,
      context({
        effect: "none",
        redact,
        project: "ORDER-1 project",
        test: ["pays ORDER-2", "ann@example.com"],
        step: "pays ORDER-2 › ann@example.com#1",
        question: { kind: "yesno", prompt: "Shows ORDER-3 to ann@example.com" },
      }),
    );
    const text = JSON.stringify(entry);
    expect(text).not.toMatch(/ORDER-\d/);
    expect(text).not.toContain("ann@example.com");
    expect(entry.test).toEqual(["pays [REDACTED]", "[REDACTED]"]);
  });

  it("refuses an entry the report would refuse, in the test that made it", async () => {
    const outcome = await outcomeOf("record", answering("no", 0.95));
    expect(() =>
      buildReportEntry(outcome, context({ effect: "none" })),
    ).toThrow(ReportError);
    expect(() =>
      buildReportEntry(outcome, context({ line: 0, effect: "reported" })),
    ).toThrow(ReportError);
  });
});

describe("deciderErrorOutcome", () => {
  it("needs-review with source none, and the key and hash the session would have used", async () => {
    const session = createDecisionSession({
      store: new MemoryDecisionStore(),
      mode: "record",
      deciderId: DECIDER.id,
      model: DECIDER.model,
      decider: {
        ...DECIDER,
        decide: () => Promise.reject(new DeciderError("timed out")),
      },
      thresholds: THRESHOLDS,
    });
    await expect(
      session.decide({
        spec: SPEC,
        step: "pays#1",
        question: QUESTION,
        state: { snapshot: SNAPSHOT },
      }),
    ).rejects.toBeInstanceOf(DeciderError);

    const outcome = deciderErrorOutcome({
      spec: SPEC,
      question: QUESTION,
      snapshot: SNAPSHOT,
      deciderId: DECIDER.id,
      model: DECIDER.model,
      options: {},
    });
    const snapshotHash = hashSnapshot(SNAPSHOT);
    expect(outcome).toEqual({
      verdict: "needs-review",
      source: "none",
      truncated: false,
      snapshotHash,
      key: decisionKey({
        spec: SPEC,
        question: QUESTION,
        snapshotHash,
        deciderId: DECIDER.id,
        model: DECIDER.model,
      }),
    });
    expect(reasonOf(outcome, true)).toBe("decider-error");
    const entry = buildReportEntry(outcome, context({ deciderError: true }));
    expect(entry).toMatchObject({
      reason: "decider-error",
      missReason: null,
      answer: null,
    });
  });

  it("hashes with the project's redaction and normalisation, as the session does", () => {
    const redact: readonly RedactRule[] = [/confirmed/g];
    const outcome = deciderErrorOutcome({
      spec: SPEC,
      question: QUESTION,
      snapshot: SNAPSHOT,
      deciderId: DECIDER.id,
      model: DECIDER.model,
      options: { redact },
    });
    expect(outcome.snapshotHash).toBe(hashSnapshot(SNAPSHOT, { redact }));
    expect(outcome.snapshotHash).not.toBe(hashSnapshot(SNAPSHOT));
  });
});

describe("annotationOf", () => {
  it("is null on a pass, and names the verdict, reason, step and statement otherwise", async () => {
    const pass = buildReportEntry(
      await outcomeOf("record", answering("yes", 0.95)),
      context({ effect: "none" }),
    );
    expect(annotationOf(pass)).toBeNull();
    const fail = buildReportEntry(
      await outcomeOf("record", answering("no", 0.95)),
      context(),
    );
    expect(annotationOf(fail)).toEqual({
      type: "jevy",
      description:
        'fail (answered-no) at checkout › pays#1: "The order is shown as confirmed"',
    });
  });
});
