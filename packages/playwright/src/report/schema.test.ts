import {
  DeciderError,
  MemoryDecisionStore,
  createDecisionSession,
  decisionKey,
  hashSnapshot,
  questionText,
} from "@jevyjs/core";
import type {
  AccessibilityNode,
  CacheMode,
  Decider,
  DecisionOutcome,
  DecisionSessionOptions,
  DecisionStore,
  Question,
  RedactRule,
  Thresholds,
} from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import {
  REPORT_ATTACHMENT_CONTENT_TYPE,
  REPORT_ATTACHMENT_NAME,
  ReportError,
  parseReportEntry,
  serialiseReportEntry,
  validateReportEntry,
} from "./schema.js";
import type { ReportAssertion } from "./schema.js";

const HASH = `sha256:${"a".repeat(64)}`;
const KEY = `sha256:${"b".repeat(64)}`;

/** A well-formed passing entry, keys in the documented order. */
function passEntry(overrides: Partial<ReportAssertion> = {}): ReportAssertion {
  return {
    spec: "tests/checkout.spec.ts",
    project: "chromium",
    test: ["checkout", "shows the order"],
    step: "checkout › shows the order#1",
    line: 12,
    statement: "The order is shown as confirmed",
    target: "locator",
    verdict: "pass",
    source: "decider",
    missReason: "no-entry",
    reason: null,
    truncated: false,
    answer: { value: "yes", confidence: 0.93, abstained: false },
    decider: "llm:gpt-test",
    model: "gpt-test",
    key: KEY,
    snapshotHash: HASH,
    mode: "replay-or-query",
    effect: "none",
    retry: 0,
    ...overrides,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function withField(name: string, value: unknown): string {
  return json({ ...passEntry(), [name]: value });
}

function without(name: string): string {
  const copy: Record<string, unknown> = { ...passEntry() };
  return json(
    Object.fromEntries(Object.entries(copy).filter(([key]) => key !== name)),
  );
}

function expectReportError(text: string, fragment: string): void {
  let caught: unknown;
  try {
    parseReportEntry(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportError);
  expect((caught as Error).message).toContain(fragment);
}

describe("report attachment constants", () => {
  it("names the attachment the matcher writes and the reporter reads", () => {
    expect(REPORT_ATTACHMENT_NAME).toBe("jevy-assertion");
    expect(REPORT_ATTACHMENT_CONTENT_TYPE).toBe("application/json");
  });
});

describe("parseReportEntry: well-formed entries", () => {
  it("returns a passing entry unchanged", () => {
    expect(parseReportEntry(json(passEntry()))).toEqual(passEntry());
  });

  it("returns the keys in the documented order whatever order they came in", () => {
    const reversed = Object.fromEntries(Object.entries(passEntry()).reverse());
    expect(Object.keys(parseReportEntry(json(reversed)))).toEqual(
      Object.keys(passEntry()),
    );
    expect(Object.keys(parseReportEntry(json(reversed)).answer ?? {})).toEqual([
      "value",
      "confidence",
      "abstained",
    ]);
  });

  it("accepts a replay miss: needs-review, source none, no answer", () => {
    const entry = passEntry({
      verdict: "needs-review",
      source: "none",
      missReason: "snapshot-changed",
      reason: "snapshot-changed",
      answer: null,
      mode: "replay",
      effect: "reported",
    });
    expect(parseReportEntry(json(entry))).toEqual(entry);
  });

  it("accepts a decider error: needs-review, source none, no miss reason", () => {
    const entry = passEntry({
      verdict: "needs-review",
      source: "none",
      missReason: null,
      reason: "decider-error",
      answer: null,
      mode: "record",
      effect: "failed",
    });
    expect(parseReportEntry(json(entry))).toEqual(entry);
  });

  it("accepts a fail answered no by the decider, and one reviewed by a person", () => {
    const answeredNo = passEntry({
      verdict: "fail",
      reason: "answered-no",
      answer: { value: "no", confidence: 0.9, abstained: false },
      effect: "reported",
    });
    const reviewed = passEntry({
      verdict: "fail",
      source: "review",
      missReason: null,
      reason: "reviewed",
      effect: "failed",
    });
    expect(parseReportEntry(json(answeredNo))).toEqual(answeredNo);
    expect(parseReportEntry(json(reviewed))).toEqual(reviewed);
  });

  it("accepts an unnamed project, a page target and a later retry", () => {
    const entry = passEntry({ project: "", target: "page", retry: 2 });
    expect(parseReportEntry(json(entry))).toEqual(entry);
  });

  it("round-trips through serialiseReportEntry", () => {
    const entry = passEntry({
      verdict: "needs-review",
      reason: "low-confidence",
      answer: { value: "yes", confidence: 0.6, abstained: false },
      effect: "reported",
    });
    expect(parseReportEntry(serialiseReportEntry(entry))).toEqual(entry);
  });
});

describe("parseReportEntry: malformed input", () => {
  it("rejects text that is not JSON", () => {
    expectReportError("{not json", "not valid JSON");
  });

  it("rejects a value that is not an object", () => {
    expectReportError("[]", "must be an object");
    expectReportError("null", "must be an object");
    expectReportError('"entry"', "must be an object");
  });

  it("rejects an unknown key", () => {
    expectReportError(
      withField("snapshot", "page text"),
      "unknown key snapshot",
    );
  });

  it("rejects an unknown key inside answer", () => {
    expectReportError(
      withField("answer", {
        value: "yes",
        confidence: 0.9,
        abstained: false,
        reasoning: "x",
      }),
      "unknown key answer.reasoning",
    );
  });

  it("rejects a missing key", () => {
    expectReportError(without("effect"), "missing key effect");
    expectReportError(without("missReason"), "missing key missReason");
  });

  it("rejects wrong types", () => {
    expectReportError(withField("spec", 3), "spec");
    expectReportError(withField("project", null), "project");
    expectReportError(withField("test", "a › b"), "test");
    expectReportError(withField("test", ["a", 1]), "test");
    expectReportError(withField("line", "12"), "line");
    expectReportError(withField("truncated", "false"), "truncated");
    expectReportError(withField("answer", "yes"), "answer");
  });

  it("rejects empty strings where a value is required", () => {
    for (const name of ["spec", "step", "statement", "decider", "model"]) {
      expectReportError(withField(name, ""), name);
    }
    expectReportError(withField("test", []), "test");
    expectReportError(withField("test", ["describe", ""]), "test");
  });

  it("rejects values outside their enums", () => {
    expectReportError(withField("target", "frame"), "target");
    expectReportError(withField("verdict", "maybe"), "verdict");
    expectReportError(withField("source", "memo"), "source");
    expectReportError(withField("mode", "live"), "mode");
    expectReportError(withField("effect", "blocked"), "effect");
    expectReportError(withField("missReason", "stale"), "missReason");
    expectReportError(
      json(passEntry({ verdict: "needs-review", effect: "reported" })).replace(
        '"reason":null',
        '"reason":"unknown"',
      ),
      "reason",
    );
  });

  it("rejects out-of-range numbers", () => {
    expectReportError(withField("line", 0), "line");
    expectReportError(withField("line", 1.5), "line");
    expectReportError(withField("retry", -1), "retry");
    expectReportError(withField("retry", 0.5), "retry");
    for (const confidence of [-0.01, 1.01]) {
      expectReportError(
        withField("answer", { value: "yes", confidence, abstained: false }),
        "answer.confidence",
      );
    }
  });

  it("rejects a key or hash that is not sha256 and 64 lower-case hex", () => {
    expectReportError(withField("key", "sha256:abc"), "key");
    expectReportError(
      withField("snapshotHash", `sha256:${"A".repeat(64)}`),
      "snapshotHash",
    );
  });

  it("rejects inherited keys: only own properties count", () => {
    const text = json(passEntry());
    // JSON.parse never yields inherited keys, so a __proto__ key is an own key
    // named "__proto__", which is unknown.
    expectReportError(
      text.replace('{"spec"', '{"__proto__":{"x":1},"spec"'),
      "unknown key __proto__",
    );
  });
});

describe("parseReportEntry: fields that must agree", () => {
  it("rejects a pass with a reason, or a non-pass without one", () => {
    expectReportError(
      json(passEntry({ reason: "answered-no" })),
      "reason must be null on a pass",
    );
    expectReportError(
      json(passEntry({ verdict: "fail", effect: "reported" })),
      "reason must be set",
    );
  });

  it("rejects a fail reason on needs-review and the reverse", () => {
    expectReportError(
      json(
        passEntry({
          verdict: "needs-review",
          reason: "answered-no",
          effect: "reported",
        }),
      ),
      "not a needs-review reason",
    );
    expectReportError(
      json(
        passEntry({ verdict: "fail", reason: "abstained", effect: "reported" }),
      ),
      "not a fail reason",
    );
  });

  it("rejects a pass whose effect is not none, and a non-pass whose effect is none", () => {
    expectReportError(json(passEntry({ effect: "reported" })), "effect");
    expectReportError(
      json(
        passEntry({
          verdict: "needs-review",
          reason: "abstained",
          effect: "none",
        }),
      ),
      "effect",
    );
  });

  it("requires an answer exactly when the source is not none", () => {
    expectReportError(json(passEntry({ answer: null })), "answer");
    expectReportError(
      json(
        passEntry({
          verdict: "needs-review",
          source: "none",
          reason: "no-entry",
          effect: "reported",
        }),
      ),
      "answer",
    );
  });

  it("rejects source none on anything but needs-review", () => {
    expectReportError(
      json(passEntry({ source: "none", answer: null })),
      "source none",
    );
  });

  it("ties the reviewed reason to the review source", () => {
    expectReportError(
      json(
        passEntry({ verdict: "fail", reason: "reviewed", effect: "reported" }),
      ),
      "reviewed",
    );
    expectReportError(
      json(
        passEntry({
          verdict: "fail",
          source: "review",
          reason: "answered-no",
          effect: "reported",
        }),
      ),
      "reviewed",
    );
    expectReportError(
      json(
        passEntry({
          verdict: "needs-review",
          source: "review",
          reason: "abstained",
          effect: "reported",
        }),
      ),
      "review",
    );
  });

  it("ties the decider-error reason to source none", () => {
    expectReportError(
      json(
        passEntry({
          verdict: "needs-review",
          reason: "decider-error",
          effect: "reported",
        }),
      ),
      "decider-error",
    );
  });
});

describe("parseReportEntry: rules that mirror core's decide", () => {
  const replayMiss = {
    verdict: "needs-review",
    source: "none",
    answer: null,
    missReason: "no-entry",
    reason: "no-entry",
    mode: "replay",
    effect: "reported",
  } as const;
  const no = { value: "no", confidence: 0.95, abstained: false } as const;
  const abstention = {
    value: "cannot tell",
    confidence: 0.1,
    abstained: true,
  } as const;
  const cacheHit = {
    source: "cache",
    missReason: null,
    mode: "replay",
  } as const;
  const answeredNo = {
    verdict: "fail",
    reason: "answered-no",
    answer: no,
    effect: "reported",
  } as const;
  const unsure = { verdict: "needs-review", effect: "reported" } as const;

  it.each<readonly [string, Partial<ReportAssertion>, string]>([
    [
      "source none with reason abstained",
      { ...replayMiss, reason: "abstained" },
      "source none",
    ],
    [
      "source none with reason low-confidence",
      { ...replayMiss, reason: "low-confidence" },
      "source none",
    ],
    [
      "source none with reason truncated",
      { ...replayMiss, reason: "truncated", truncated: true },
      "source none",
    ],
    [
      "source none with truncated true",
      { ...replayMiss, truncated: true },
      "truncated",
    ],
    [
      "reason truncated with truncated false",
      { ...unsure, reason: "truncated", answer: no },
      "truncated",
    ],
    [
      "reason truncated on a yes",
      {
        ...unsure,
        reason: "truncated",
        truncated: true,
        answer: { value: "yes", confidence: 0.95, abstained: false },
      },
      "truncated",
    ],
    [
      "reason abstained with answer.abstained false",
      {
        ...unsure,
        reason: "abstained",
        answer: { value: "yes", confidence: 0.99, abstained: false },
      },
      "abstained",
    ],
    [
      "reason low-confidence on an abstention",
      { ...unsure, reason: "low-confidence", answer: abstention },
      "abstained",
    ],
    [
      "answered-no with the value yes",
      {
        ...answeredNo,
        answer: { value: "yes", confidence: 0.99, abstained: false },
      },
      "answered-no",
    ],
    ["a pass whose value is no", { answer: no }, "pass"],
    [
      "a pass from the cache on an abstention",
      { ...cacheHit, answer: abstention },
      "abstained",
    ],
    [
      "a fail from the decider on an abstention",
      { ...answeredNo, answer: { ...abstention, value: "no" } },
      "abstained",
    ],
    [
      "a fail from the decider on a truncated snapshot",
      { ...answeredNo, truncated: true },
      "truncated",
    ],
    [
      "a fail from the cache on a truncated snapshot",
      { ...answeredNo, ...cacheHit, truncated: true },
      "truncated",
    ],
    ["mode replay with source decider", { mode: "replay" }, "replay"],
    [
      "mode replay with reason decider-error",
      {
        ...replayMiss,
        reason: "decider-error",
        missReason: null,
      },
      "decider-error",
    ],
    [
      "mode record with source cache",
      { ...cacheHit, mode: "record" },
      "record",
    ],
    [
      "mode record with source review",
      { source: "review", missReason: null, mode: "record" },
      "record",
    ],
    [
      "source cache with missReason no-entry",
      { ...cacheHit, missReason: "no-entry" },
      "missReason",
    ],
    [
      "source review with a missReason",
      { source: "review", missReason: "snapshot-changed" },
      "missReason",
    ],
    [
      "source decider with missReason regated-below-threshold",
      { missReason: "regated-below-threshold" },
      "regated",
    ],
    [
      "reason regated-below-threshold from the decider",
      {
        ...unsure,
        reason: "regated-below-threshold",
        missReason: null,
        answer: { value: "yes", confidence: 0.5, abstained: false },
      },
      "regated",
    ],
    [
      "reason regated-below-threshold from the cache without the miss reason",
      {
        ...unsure,
        ...cacheHit,
        reason: "regated-below-threshold",
        answer: { value: "yes", confidence: 0.5, abstained: false },
      },
      "regated",
    ],
    [
      "a replay miss with no missReason",
      { ...replayMiss, reason: "snapshot-changed", missReason: null },
      "missReason",
    ],
    [
      "a replay miss whose reason is not its missReason",
      { ...replayMiss, reason: "no-entry", missReason: "model-changed" },
      "missReason",
    ],
    [
      "a replay miss re-gated below the threshold",
      {
        ...replayMiss,
        reason: "regated-below-threshold",
        missReason: "regated-below-threshold",
      },
      "regated",
    ],
    [
      "source none in replay-or-query without a decider error",
      { ...replayMiss, mode: "replay-or-query" },
      "source none",
    ],
    [
      "a decider error with missReason regated-below-threshold",
      {
        ...replayMiss,
        mode: "replay-or-query",
        reason: "decider-error",
        missReason: "regated-below-threshold",
      },
      "regated",
    ],
    [
      "an empty answer value",
      { answer: { value: "", confidence: 0.9, abstained: false } },
      "answer.value",
    ],
    ["an absolute spec", { spec: "/Users/someone/tests/a.spec.ts" }, "spec"],
    ["a Windows spec", { spec: "C:\\proj\\tests\\a.spec.ts" }, "spec"],
    ["a drive-letter spec", { spec: "C:/proj/tests/a.spec.ts" }, "spec"],
    ["a climbing spec", { spec: "../tests/a.spec.ts" }, "spec"],
    ["a spec that climbs inside", { spec: "tests/../a.spec.ts" }, "spec"],
    ["a backslash spec", { spec: "tests\\a.spec.ts" }, "spec"],
    ["a spec with a dot segment", { spec: "./tests/a.spec.ts" }, "spec"],
    ["a spec with an empty segment", { spec: "tests//a.spec.ts" }, "spec"],
    [
      "a statement that is not collapsed",
      { statement: "  two\n\tlines  " },
      "statement",
    ],
    ["a statement with two spaces", { statement: "a  b" }, "statement"],
    ["a statement with a tab", { statement: "a\tb" }, "statement"],
    ["a statement with a trailing space", { statement: "a " }, "statement"],
    [
      "a statement with a newline that is not the criteria",
      { statement: "a\nb" },
      "statement",
    ],
    [
      "a statement with two criteria",
      { statement: "a\nCriteria: b\nCriteria: c" },
      "statement",
    ],
    [
      "a statement with empty criteria",
      { statement: "a\nCriteria: " },
      "statement",
    ],
  ])("rejects %s", (_name, overrides, fragment) => {
    expectReportError(json(passEntry(overrides)), fragment);
  });

  it("accepts a statement with criteria, as core's questionText writes it", () => {
    const statement = questionText({
      kind: "yesno",
      prompt: "The order  is shown",
      criteria: " A total\nis visible ",
    });
    expect(statement).toBe("The order is shown\nCriteria: A total is visible");
    expect(parseReportEntry(json(passEntry({ statement })))).toEqual(
      passEntry({ statement }),
    );
  });
});

/**
 * Entries built from real `createDecisionSession` outcomes must all validate.
 * The mapping here is the reference for 3d's `entry.ts`: core's outcome fields
 * copied as they are, and the reason chosen the way the plan describes.
 */
describe("validateReportEntry: accepts every outcome core produces", () => {
  const SPEC = "tests/a.spec.ts";
  const STEP = "a test#1";
  const DECIDER = { id: "llm:m", model: "m" } as const;
  const THRESHOLDS: Thresholds = { pass: 0.8, fail: 0.5 };
  const confirmed: Question = {
    kind: "yesno",
    prompt: "The order is shown as confirmed",
  };
  const withCriteria: Question = {
    kind: "yesno",
    prompt: "The order is shown",
    criteria: "A total is visible",
  };

  function page(heading: string): AccessibilityNode {
    return {
      role: "main",
      children: [
        { role: "heading", name: heading, level: 1 },
        { role: "button", name: "Continue" },
      ],
    };
  }

  function fake(
    value: string,
    confidence: number,
    abstained = false,
    identity: { readonly id: string; readonly model: string } = DECIDER,
  ): Decider {
    return {
      ...identity,
      decide: () =>
        Promise.resolve({ answer: { value, confidence, abstained } }),
    };
  }

  function throwing(): Decider {
    return {
      ...DECIDER,
      decide: () => Promise.reject(new DeciderError("the model timed out")),
    };
  }

  interface Run {
    readonly store: DecisionStore;
    readonly mode: CacheMode;
    readonly decider?: Decider;
    readonly identity?: { readonly id: string; readonly model: string };
    readonly thresholds?: Thresholds;
    readonly snapshot?: DecisionSessionOptions["snapshot"];
    readonly question?: Question;
    readonly heading?: string;
  }

  async function decide(run: Run): Promise<DecisionOutcome> {
    const identity = run.identity ?? DECIDER;
    const session = createDecisionSession({
      store: run.store,
      mode: run.mode,
      deciderId: identity.id,
      model: identity.model,
      ...(run.decider !== undefined ? { decider: run.decider } : {}),
      thresholds: run.thresholds ?? THRESHOLDS,
      ...(run.snapshot !== undefined ? { snapshot: run.snapshot } : {}),
      now: () => new Date("2026-11-26T00:00:00.000Z"),
    });
    const outcome = await session.decide({
      spec: SPEC,
      step: STEP,
      question: run.question ?? confirmed,
      state: { snapshot: page(run.heading ?? "Order confirmed") },
    });
    await session.confirm();
    return outcome;
  }

  /** The reason a non-pass carries, chosen as the plan's `Reason` describes. */
  function reasonOf(outcome: DecisionOutcome): ReportAssertion["reason"] {
    if (outcome.verdict === "pass") return null;
    if (outcome.verdict === "fail") {
      return outcome.source === "review" ? "reviewed" : "answered-no";
    }
    if (outcome.source === "none") return outcome.reason ?? null;
    if (outcome.answer?.abstained === true) return "abstained";
    if (outcome.truncated && outcome.answer?.value === "no") {
      return "truncated";
    }
    if (outcome.reason === "regated-below-threshold") return outcome.reason;
    return "low-confidence";
  }

  function entryFrom(
    outcome: DecisionOutcome,
    mode: CacheMode,
    question: Question = confirmed,
    identity: { readonly id: string; readonly model: string } = DECIDER,
  ): ReportAssertion {
    return {
      spec: SPEC,
      project: "chromium",
      test: ["a test"],
      step: STEP,
      line: 3,
      statement: questionText(question),
      target: "locator",
      verdict: outcome.verdict,
      source: outcome.source,
      missReason: outcome.reason ?? null,
      reason: reasonOf(outcome),
      truncated: outcome.truncated,
      answer: outcome.answer ?? null,
      decider: identity.id,
      model: identity.model,
      key: outcome.key,
      snapshotHash: outcome.snapshotHash,
      mode,
      effect: outcome.verdict === "pass" ? "none" : "reported",
      retry: 0,
    };
  }

  function expectValid(entry: ReportAssertion): void {
    expect(validateReportEntry(entry)).toEqual(entry);
  }

  async function recorded(
    answer: Decider = fake("yes", 0.95),
    thresholds = THRESHOLDS,
  ): Promise<MemoryDecisionStore> {
    const store = new MemoryDecisionStore();
    await decide({ store, mode: "record", decider: answer, thresholds });
    return store;
  }

  it("a fresh pass, fail, abstention and low confidence in each querying mode", async () => {
    const answers: readonly (readonly [Decider, string])[] = [
      [fake("yes", 0.95), "pass"],
      [fake("no", 0.95), "fail"],
      [fake("cannot tell", 0.2, true), "needs-review"],
      [fake("yes", 0.5), "needs-review"],
      [fake("no", 0.5), "needs-review"],
    ];
    for (const mode of ["record", "replay-or-query"] as const) {
      for (const [decider, verdict] of answers) {
        const outcome = await decide({
          store: new MemoryDecisionStore(),
          mode,
          decider,
        });
        expect(outcome).toMatchObject({ verdict, source: "decider" });
        expect(outcome.reason).toBe("no-entry");
        expectValid(entryFrom(outcome, mode));
      }
    }
  });

  it("a question with criteria", async () => {
    const outcome = await decide({
      store: new MemoryDecisionStore(),
      mode: "record",
      decider: fake("yes", 0.95),
      question: withCriteria,
    });
    expectValid(entryFrom(outcome, "record", withCriteria));
  });

  it("record mode over a stored record: the decider, no miss reason", async () => {
    const store = await recorded();
    const outcome = await decide({
      store,
      mode: "record",
      decider: fake("no", 0.95),
    });
    expect(outcome).toMatchObject({ verdict: "fail", source: "decider" });
    expect(outcome.reason).toBeUndefined();
    expectValid(entryFrom(outcome, "record"));
  });

  it("a hit in replay and in replay-or-query", async () => {
    for (const mode of ["replay", "replay-or-query"] as const) {
      const store = await recorded();
      const outcome = await decide({ store, mode, decider: fake("no", 0.95) });
      expect(outcome).toMatchObject({ verdict: "pass", source: "cache" });
      expectValid(entryFrom(outcome, mode));
    }
  });

  it("a replay miss for each miss reason", async () => {
    const cases: readonly (readonly [string, Partial<Run>])[] = [
      ["no-entry", { question: withCriteria }],
      ["snapshot-changed", { heading: "Order failed" }],
      ["model-changed", { identity: { id: "llm:n", model: "n" } }],
      [
        "redaction-changed",
        { snapshot: { redact: [/Continue/g] as readonly RedactRule[] } },
      ],
    ];
    for (const [reason, run] of cases) {
      const store = await recorded();
      const outcome = await decide({ store, mode: "replay", ...run });
      expect(outcome).toMatchObject({
        verdict: "needs-review",
        source: "none",
        reason,
      });
      expectValid(
        entryFrom(outcome, "replay", run.question, run.identity ?? DECIDER),
      );
    }
  });

  it("a miss in replay-or-query that asks the decider", async () => {
    const store = await recorded();
    const outcome = await decide({
      store,
      mode: "replay-or-query",
      decider: fake("yes", 0.95),
      heading: "Order failed",
    });
    expect(outcome).toMatchObject({
      verdict: "pass",
      source: "decider",
      reason: "snapshot-changed",
    });
    expectValid(entryFrom(outcome, "replay-or-query"));
  });

  it("truncated answers, fresh and replayed", async () => {
    const snapshot = { maxNodes: 1 };
    for (const value of ["yes", "no"]) {
      const store = new MemoryDecisionStore();
      const fresh = await decide({
        store,
        mode: "record",
        decider: fake(value, 0.95),
        snapshot,
      });
      expect(fresh.truncated).toBe(true);
      expectValid(entryFrom(fresh, "record"));
      const replayed = await decide({ store, mode: "replay", snapshot });
      expect(replayed).toMatchObject({ source: "cache", truncated: true });
      expectValid(entryFrom(replayed, "replay"));
    }
  });

  it("a replayed abstention", async () => {
    const store = await recorded(fake("cannot tell", 0.2, true));
    const outcome = await decide({ store, mode: "replay" });
    expect(outcome).toMatchObject({
      verdict: "needs-review",
      source: "cache",
    });
    expectValid(entryFrom(outcome, "replay"));
  });

  it("a reviewed pass and a reviewed fail, abstained and truncated or not", async () => {
    for (const reviewVerdict of ["pass", "fail"] as const) {
      for (const answer of [
        fake("cannot tell", 0.2, true),
        fake("yes", 0.95),
        fake("no", 0.95),
      ]) {
        for (const snapshot of [{}, { maxNodes: 1 }]) {
          const store = new MemoryDecisionStore();
          await decide({ store, mode: "record", decider: answer, snapshot });
          const [stored] = await store.list();
          if (stored === undefined) throw new Error("nothing was recorded");
          await store.append([
            { ...stored, reviewedBy: "adam", reviewVerdict },
          ]);
          for (const mode of ["replay", "replay-or-query"] as const) {
            const outcome = await decide({
              store,
              mode,
              snapshot,
              decider: fake("yes", 0.95),
            });
            expect(outcome).toMatchObject({
              verdict: reviewVerdict,
              source: "review",
            });
            expectValid(entryFrom(outcome, mode));
          }
        }
      }
    }
  });

  it("a hit re-gated to each verdict", async () => {
    const strict: Thresholds = { pass: 0.9, fail: 0.5 };
    const cases: readonly (readonly [Decider, Thresholds, string])[] = [
      [fake("yes", 0.85), strict, "needs-review"],
      [fake("no", 0.85), strict, "needs-review"],
      [fake("yes", 0.85), THRESHOLDS, "pass"],
      [fake("no", 0.85), THRESHOLDS, "fail"],
    ];
    for (const [answer, replayThresholds, verdict] of cases) {
      const recordThresholds =
        replayThresholds === strict ? THRESHOLDS : strict;
      const store = await recorded(answer, recordThresholds);
      const outcome = await decide({
        store,
        mode: "replay",
        thresholds: replayThresholds,
      });
      expect(outcome).toMatchObject({
        verdict,
        source: "cache",
        reason: "regated-below-threshold",
      });
      expectValid(entryFrom(outcome, "replay"));
    }
  });

  it("a decider error, built by the matcher from the key it computed", async () => {
    for (const mode of ["record", "replay-or-query"] as const) {
      const error = await decide({
        store: new MemoryDecisionStore(),
        mode,
        decider: throwing(),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DeciderError);
      const snapshotHash = hashSnapshot(page("Order confirmed"));
      expectValid({
        ...entryFrom(
          {
            verdict: "needs-review",
            source: "none",
            truncated: false,
            snapshotHash,
            key: decisionKey({
              spec: SPEC,
              question: confirmed,
              snapshotHash,
              deciderId: DECIDER.id,
              model: DECIDER.model,
            }),
          },
          mode,
        ),
        reason: "decider-error",
        effect: "failed",
      });
    }
  });
});

describe("serialiseReportEntry", () => {
  it("refuses an entry the parser would refuse", () => {
    expect(() => serialiseReportEntry(passEntry({ line: 0 }))).toThrow(
      ReportError,
    );
  });

  it("writes compact JSON in the documented key order", () => {
    const text = serialiseReportEntry(passEntry());
    expect(text).not.toContain("\n");
    expect(Object.keys(JSON.parse(text) as object)).toEqual(
      Object.keys(passEntry()),
    );
  });
});
