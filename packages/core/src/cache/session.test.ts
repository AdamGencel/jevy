import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CacheMode } from "../config.js";
import type { Answer, Decider, DecisionState, Question } from "../decider.js";
import { CacheError, RedactionError } from "../errors.js";
import { hashSnapshot } from "../hash.js";
import { rulesFingerprint } from "../project.js";
import type { RedactRule } from "../redact.js";
import type { AccessibilityNode } from "../snapshot.js";
import type { Thresholds } from "../verdict.js";
import { decisionKey, questionText } from "./key.js";
import { JsonlDecisionStore } from "./jsonl-store.js";
import { MemoryDecisionStore } from "./memory-store.js";
import type { DecisionRecord } from "./record.js";
import { createDecisionSession, createRunMemo } from "./session.js";
import type { DecisionSessionOptions, RunMemo } from "./session.js";
import type { DecisionStore } from "./store.js";

const SPEC = "tests/checkout.spec.ts";
const NOW = new Date("2026-11-18T10:00:00.000Z");
const THRESHOLDS: Thresholds = { pass: 0.8, fail: 0.5 };

function page(heading: string): AccessibilityNode {
  return {
    role: "main",
    children: [
      { role: "heading", name: heading, level: 1 },
      { role: "button", name: "Continue" },
    ],
  };
}

function state(heading = "Order confirmed"): DecisionState {
  return { snapshot: page(heading) };
}

const confirmed: Question = {
  kind: "yesno",
  prompt: "The page shows the order as confirmed",
};

const nextControl: Question = {
  kind: "choice",
  prompt: "Which control continues checkout?",
  options: [
    { id: "continue", label: "Continue" },
    { id: "back", label: "Back" },
  ],
};

const completeness: Question = {
  kind: "score",
  prompt: "How complete is the order page?",
  levels: ["broken", "partial", "good"],
};

interface CountingDecider extends Decider {
  calls: number;
}

function decider(
  answer: Answer | ((question: Question) => Answer),
  identity: { readonly id?: string; readonly model?: string } = {},
): CountingDecider {
  const counting: CountingDecider = {
    id: identity.id ?? "jev",
    model: identity.model ?? "jev-1.14.0",
    calls: 0,
    decide(_state, questions) {
      counting.calls += 1;
      const question = questions["answer"];
      if (question === undefined) throw new Error("expected one question");
      const value = typeof answer === "function" ? answer(question) : answer;
      return Promise.resolve({ answer: value });
    },
  };
  return counting;
}

function throwingDecider(): CountingDecider {
  const counting: CountingDecider = {
    id: "jev",
    model: "jev-1.14.0",
    calls: 0,
    decide() {
      counting.calls += 1;
      throw new Error("replay must not call the decider");
    },
  };
  return counting;
}

function answerFor(question: Question): Answer {
  switch (question.kind) {
    case "yesno":
      return { value: "yes", confidence: 0.93 };
    case "choice":
      return { value: "continue", confidence: 0.9 };
    case "score":
      return { value: "good", confidence: 0.95 };
  }
}

function session(
  store: DecisionStore,
  mode: CacheMode,
  extra: Partial<DecisionSessionOptions> = {},
): ReturnType<typeof createDecisionSession> {
  const used = extra.decider;
  return createDecisionSession({
    store,
    mode,
    deciderId: used?.id ?? "jev",
    model: used?.model ?? "jev-1.14.0",
    thresholds: THRESHOLDS,
    now: () => NOW,
    ...extra,
  });
}

/** A stored record for `question` on `snapshot`, as a past run would leave it. */
function storedRecord(
  question: Question,
  snapshot: AccessibilityNode,
  changes: Partial<DecisionRecord>,
  redact: readonly RedactRule[] = [],
): DecisionRecord {
  const snapshotHash = hashSnapshot(snapshot, { redact });
  return {
    v: 1,
    key: decisionKey({
      question,
      snapshotHash,
      deciderId: "jev",
      model: "jev-1.14.0",
      redact,
    }),
    spec: SPEC,
    step: "toSatisfy#1",
    kind: question.kind,
    question: questionText(question, redact),
    snapshotHash,
    decider: "jev",
    model: "jev-1.14.0",
    answer: "yes",
    confidence: 0.93,
    abstained: false,
    truncated: false,
    verdict: "pass",
    thresholds: THRESHOLDS,
    rules: rulesFingerprint({ redact }),
    createdAt: "2026-11-01T00:00:00.000Z",
    reviewedBy: null,
    reviewVerdict: null,
    ...changes,
  };
}

async function recordRun(
  store: DecisionStore,
  steps: readonly {
    readonly step: string;
    readonly question: Question;
    readonly state: DecisionState;
  }[],
  extra: Partial<DecisionSessionOptions> = {},
): Promise<void> {
  const writer = session(store, "replay-or-query", {
    decider: decider(answerFor),
    ...extra,
  });
  for (const step of steps) {
    await writer.decide({ spec: SPEC, ...step });
  }
  await writer.confirm();
}

describe("createDecisionSession: replay", () => {
  it("makes zero decider calls over a fixture run and gives every miss a reason", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
      { step: "s2", question: nextControl, state: state() },
      { step: "s3", question: completeness, state: state() },
    ]);
    const before = (await store.list()).length;

    const throwing = throwingDecider();
    const replay = session(store, "replay", { decider: throwing });
    const outcomes = [
      await replay.decide({
        spec: SPEC,
        step: "s1",
        question: confirmed,
        state: state(),
      }),
      await replay.decide({
        spec: SPEC,
        step: "s2",
        question: nextControl,
        state: state(),
      }),
      await replay.decide({
        spec: SPEC,
        step: "s3",
        question: completeness,
        state: state("Order failed"),
      }),
      await replay.decide({
        spec: SPEC,
        step: "s4",
        question: { kind: "yesno", prompt: "A receipt link is shown" },
        state: state(),
      }),
    ];
    await replay.confirm();

    expect(throwing.calls).toBe(0);
    expect(outcomes.map((o) => o.source)).toEqual([
      "cache",
      "cache",
      "none",
      "none",
    ]);
    expect(outcomes.map((o) => o.verdict)).toEqual([
      "pass",
      "pass",
      "needs-review",
      "needs-review",
    ]);
    for (const outcome of outcomes.filter((o) => o.source === "none")) {
      expect(outcome.reason).toBeDefined();
    }
    expect(outcomes[2]?.reason).toBe("snapshot-changed");
    expect(outcomes[3]?.reason).toBe("no-entry");
    expect(await store.list()).toHaveLength(before);
  });

  it("may be created without a decider", () => {
    expect(() =>
      createDecisionSession({
        store: new MemoryDecisionStore(),
        mode: "replay",
        deciderId: "jev",
        model: "jev-1.14.0",
        thresholds: THRESHOLDS,
      }),
    ).not.toThrow();
  });

  it("reports no-entry for an empty cache", async () => {
    const outcome = await session(new MemoryDecisionStore(), "replay").decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(outcome).toMatchObject({
      verdict: "needs-review",
      source: "none",
      reason: "no-entry",
      truncated: false,
    });
    expect(outcome.answer).toBeUndefined();
    expect(outcome.record).toBeUndefined();
    expect(outcome.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outcome.snapshotHash).toBe(hashSnapshot(page("Order confirmed")));
  });

  it("reports snapshot-changed when only the page changed", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
    ]);
    const outcome = await session(store, "replay").decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state("Order pending"),
    });
    expect(outcome.reason).toBe("snapshot-changed");
  });

  it("reports model-changed when the model or the decider changed", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
    ]);
    const newModel = await session(store, "replay", {
      deciderId: "jev",
      model: "jev-1.15.0",
    }).decide({ spec: SPEC, step: "s1", question: confirmed, state: state() });
    expect(newModel).toMatchObject({ source: "none", reason: "model-changed" });
    const newDecider = await session(store, "replay", {
      deciderId: "kev",
      model: "jev-1.14.0",
    }).decide({ spec: SPEC, step: "s1", question: confirmed, state: state() });
    expect(newDecider).toMatchObject({
      source: "none",
      reason: "model-changed",
    });
  });

  it("reports redaction-changed when the project's rules changed the hash", async () => {
    const store = new MemoryDecisionStore();
    const order = state("Order ORDER-1234 confirmed");
    await recordRun(store, [{ step: "s1", question: confirmed, state: order }]);
    const outcome = await session(store, "replay", {
      snapshot: { redact: [/ORDER-\d+/] },
    }).decide({ spec: SPEC, step: "s1", question: confirmed, state: order });
    expect(outcome).toMatchObject({
      source: "none",
      reason: "redaction-changed",
    });
  });

  it("compares a miss with the most recent record for the step and question", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(
      store,
      [{ step: "s1", question: confirmed, state: state() }],
      {
        deciderId: "jev",
        model: "jev-1.13.0",
        decider: decider(answerFor, { model: "jev-1.13.0" }),
      },
    );
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state("Order pending") },
    ]);
    const outcome = await session(store, "replay").decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(outcome.reason).toBe("snapshot-changed");
  });

  it("does not count a record for a different question as an entry", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
    ]);
    const outcome = await session(store, "replay").decide({
      spec: SPEC,
      step: "s1",
      question: { kind: "yesno", prompt: "The cart is empty" },
      state: state(),
    });
    expect(outcome.reason).toBe("no-entry");
  });
});

describe("createDecisionSession: re-gating a hit", () => {
  it("re-gates a stored yes at 0.85 with the current thresholds", async () => {
    const store = new MemoryDecisionStore();
    await store.append([
      storedRecord(confirmed, page("Order confirmed"), { confidence: 0.85 }),
    ]);
    const lenient = await session(store, "replay", {
      thresholds: { pass: 0.8, fail: 0.5 },
    }).decide({
      spec: SPEC,
      step: "toSatisfy#1",
      question: confirmed,
      state: state(),
    });
    expect(lenient).toMatchObject({ verdict: "pass", source: "cache" });
    expect(lenient.reason).toBeUndefined();
    expect(lenient.answer).toEqual({
      value: "yes",
      confidence: 0.85,
      abstained: false,
    });

    const strict = await session(store, "replay", {
      thresholds: { pass: 0.9, fail: 0.5 },
    }).decide({
      spec: SPEC,
      step: "toSatisfy#1",
      question: confirmed,
      state: state(),
    });
    expect(strict).toMatchObject({
      verdict: "needs-review",
      source: "cache",
      reason: "regated-below-threshold",
    });
  });

  it("replays a stored no on a truncated snapshot as needs-review", async () => {
    const store = new MemoryDecisionStore();
    await store.append([
      storedRecord(confirmed, page("Order confirmed"), {
        answer: "no",
        confidence: 0.95,
        truncated: true,
        verdict: "needs-review",
      }),
    ]);
    const outcome = await session(store, "replay").decide({
      spec: SPEC,
      step: "toSatisfy#1",
      question: confirmed,
      state: state(),
    });
    expect(outcome).toMatchObject({
      verdict: "needs-review",
      source: "cache",
      truncated: true,
    });
    expect(outcome.reason).toBeUndefined();
  });

  it("replays a stored no on a whole snapshot as fail", async () => {
    const store = new MemoryDecisionStore();
    await store.append([
      storedRecord(confirmed, page("Order confirmed"), {
        answer: "no",
        confidence: 0.95,
        verdict: "fail",
      }),
    ]);
    const outcome = await session(store, "replay").decide({
      spec: SPEC,
      step: "toSatisfy#1",
      question: confirmed,
      state: state(),
    });
    expect(outcome).toMatchObject({ verdict: "fail", source: "cache" });
  });

  it("keeps the truncation of a real pruned call through to replay", async () => {
    const store = new MemoryDecisionStore();
    const snapshot = { maxNodes: 1 };
    const writer = session(store, "replay-or-query", {
      decider: decider({ value: "no", confidence: 0.95 }),
      snapshot,
    });
    const first = await writer.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(first).toMatchObject({ verdict: "needs-review", truncated: true });
    await writer.confirm();
    const replayed = await session(store, "replay", { snapshot }).decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(replayed).toMatchObject({
      verdict: "needs-review",
      source: "cache",
      truncated: true,
    });
  });

  it("replays a human review as the reviewer's verdict without gating", async () => {
    const store = new MemoryDecisionStore();
    const base = storedRecord(confirmed, page("Order confirmed"), {
      confidence: 0.6,
      verdict: "needs-review",
    });
    await store.append([
      base,
      { ...base, reviewedBy: "adam", reviewVerdict: "fail" },
    ]);
    const outcome = await session(store, "replay", {
      thresholds: { pass: 0.5, fail: 0.2 },
    }).decide({
      spec: SPEC,
      step: "toSatisfy#1",
      question: confirmed,
      state: state(),
    });
    expect(outcome).toMatchObject({ verdict: "fail", source: "review" });
    expect(outcome.record?.reviewedBy).toBe("adam");
  });

  it("refuses a stored record whose fields do not match its key", async () => {
    const store = new MemoryDecisionStore();
    await store.append([
      storedRecord(confirmed, page("Order confirmed"), {
        question: "Some other question",
      }),
    ]);
    await expect(
      session(store, "replay").decide({
        spec: SPEC,
        step: "toSatisfy#1",
        question: confirmed,
        state: state(),
      }),
    ).rejects.toThrow(CacheError);
  });
});

describe("createDecisionSession: querying", () => {
  it("queries on a miss in replay-or-query and holds the record until confirm", async () => {
    const store = new MemoryDecisionStore();
    const used = decider(answerFor);
    const query = session(store, "replay-or-query", { decider: used });
    const outcome = await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(used.calls).toBe(1);
    expect(outcome).toMatchObject({
      verdict: "pass",
      source: "decider",
      reason: "no-entry",
      answer: { value: "yes", confidence: 0.93, abstained: false },
    });
    expect(outcome.record).toEqual({
      v: 1,
      key: outcome.key,
      spec: SPEC,
      step: "s1",
      kind: "yesno",
      question: "The page shows the order as confirmed",
      snapshotHash: outcome.snapshotHash,
      decider: "jev",
      model: "jev-1.14.0",
      answer: "yes",
      confidence: 0.93,
      abstained: false,
      truncated: false,
      verdict: "pass",
      thresholds: THRESHOLDS,
      rules: rulesFingerprint({}),
      createdAt: "2026-11-18T10:00:00.000Z",
      reviewedBy: null,
      reviewVerdict: null,
    });
    expect(await store.list()).toEqual([]);
    expect(await store.latest(outcome.key)).toBeUndefined();

    await query.confirm();
    expect(await store.latest(outcome.key)).toEqual(outcome.record);
    await query.confirm();
    expect(await store.list()).toHaveLength(1);
  });

  it("drops held records on discard", async () => {
    const store = new MemoryDecisionStore();
    const query = session(store, "replay-or-query", {
      decider: decider(answerFor),
    });
    await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    query.discard();
    await query.confirm();
    expect(await store.list()).toEqual([]);
  });

  it("uses a hit in replay-or-query without calling the decider", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
    ]);
    const used = decider(answerFor);
    const outcome = await session(store, "replay-or-query", {
      decider: used,
    }).decide({ spec: SPEC, step: "s1", question: confirmed, state: state() });
    expect(used.calls).toBe(0);
    expect(outcome.source).toBe("cache");
  });

  it("always queries in record mode and holds a new record", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: confirmed, state: state() },
    ]);
    const used = decider({ value: "no", confidence: 0.9 });
    const recorder = session(store, "record", { decider: used });
    const outcome = await recorder.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(used.calls).toBe(1);
    expect(outcome).toMatchObject({ verdict: "fail", source: "decider" });
    expect(outcome.reason).toBeUndefined();
    await recorder.confirm();
    expect((await store.latest(outcome.key))?.answer).toBe("no");
    expect(await store.list()).toHaveLength(2);
  });

  it("records an abstention as needs-review", async () => {
    const outcome = await session(new MemoryDecisionStore(), "record", {
      decider: decider({
        value: "cannot tell",
        confidence: 0.99,
        abstained: true,
      }),
    }).decide({ spec: SPEC, step: "s1", question: confirmed, state: state() });
    expect(outcome.verdict).toBe("needs-review");
    expect(outcome.record).toMatchObject({
      abstained: true,
      answer: "cannot tell",
      verdict: "needs-review",
    });
  });

  it("asks the decider about the region only, and keys on the region", async () => {
    const seen: AccessibilityNode[] = [];
    const regionDecider: Decider = {
      id: "jev",
      model: "jev-1.14.0",
      decide(decisionState) {
        seen.push(decisionState.snapshot);
        return Promise.resolve({ answer: { value: "yes", confidence: 0.9 } });
      },
    };
    const region = { role: "heading" };
    const outcome = await session(new MemoryDecisionStore(), "record", {
      decider: regionDecider,
    }).decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
      region,
    });
    expect(seen[0]?.role).toBe("heading");
    expect(outcome.snapshotHash).toBe(
      hashSnapshot(page("Order confirmed"), { region }),
    );
  });

  it("requires a decider outside replay", () => {
    for (const mode of ["replay-or-query", "record"] as const) {
      expect(() =>
        createDecisionSession({
          store: new MemoryDecisionStore(),
          mode,
          deciderId: "jev",
          model: "jev-1.14.0",
          thresholds: THRESHOLDS,
        }),
      ).toThrow(CacheError);
    }
  });

  it("refuses a decider whose id or model differs from the session's", () => {
    expect(() =>
      session(new MemoryDecisionStore(), "record", {
        decider: decider(answerFor, { model: "jev-1.15.0" }),
        model: "jev-1.14.0",
      }),
    ).toThrow(CacheError);
  });

  it("rejects an unknown mode, empty identity and bad thresholds", () => {
    const store = new MemoryDecisionStore();
    expect(() => session(store, "refresh" as CacheMode)).toThrow(CacheError);
    expect(() => session(store, "replay", { deciderId: "" })).toThrow(
      CacheError,
    );
    expect(() => session(store, "replay", { model: " " })).toThrow(CacheError);
    expect(() =>
      session(store, "replay", { thresholds: { pass: 0.5, fail: 0.6 } }),
    ).toThrow();
  });

  it("keeps held records if the store rejects them, so confirm can be retried", async () => {
    const inner = new MemoryDecisionStore();
    let failNext = true;
    const flaky: DecisionStore = {
      latest: (key) => inner.latest(key),
      forStep: (spec, step) => inner.forStep(spec, step),
      list: (spec) => inner.list(spec),
      append: (records) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("disk full"));
        }
        return inner.append(records);
      },
    };
    const query = session(flaky, "record", { decider: decider(answerFor) });
    await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    await expect(query.confirm()).rejects.toThrow("disk full");
    await query.confirm();
    expect(await inner.list()).toHaveLength(1);
  });
});

describe("createDecisionSession: run memo", () => {
  it("does not call the decider twice for one key in a session", async () => {
    const store = new MemoryDecisionStore();
    const used = decider(answerFor);
    const query = session(store, "record", { decider: used });
    const first = await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    const again = await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    expect(used.calls).toBe(1);
    expect(again.verdict).toBe(first.verdict);
    expect(again.answer).toEqual(first.answer);
    await query.confirm();
    expect(await store.list()).toHaveLength(1);
  });

  it("lets a retry in a new session reuse the answer instead of drawing a new one", async () => {
    const store = new MemoryDecisionStore();
    const memo: RunMemo = createRunMemo();
    let draw = 0;
    const flipping = decider(() => {
      draw += 1;
      return draw === 1
        ? { value: "no", confidence: 0.95 }
        : { value: "yes", confidence: 0.95 };
    });
    const attempt1 = session(store, "record", { decider: flipping, memo });
    const failed = await attempt1.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    attempt1.discard();
    expect(failed.verdict).toBe("fail");

    for (const mode of ["replay-or-query", "record"] as const) {
      const retry = session(store, mode, { decider: flipping, memo });
      const outcome = await retry.decide({
        spec: SPEC,
        step: "s1",
        question: confirmed,
        state: state(),
      });
      expect(outcome).toMatchObject({ verdict: "fail", source: "decider" });
      await retry.confirm();
    }
    expect(flipping.calls).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it("does not share answers across different keys", async () => {
    const memo = createRunMemo();
    const used = decider(answerFor);
    const query = session(new MemoryDecisionStore(), "record", {
      decider: used,
      memo,
    });
    await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state("Other"),
    });
    expect(used.calls).toBe(2);
  });
});

describe("createDecisionSession: redaction before write", () => {
  it("redacts secrets in the spec, step, question and answer", async () => {
    const store = new MemoryDecisionStore();
    const query = session(store, "record", {
      decider: decider({
        value: "page shows alice@example.com only",
        confidence: 0.4,
        abstained: true,
      }),
      snapshot: { redact: [/ACCT-\d+/] },
    });
    await query.decide({
      spec: "tests/ACCT-77.spec.ts",
      step: "check bob@example.com",
      question: {
        kind: "yesno",
        prompt: "Account ACCT-991 belongs to carol@example.com",
      },
      state: state(),
    });
    await query.confirm();
    const [record] = await store.list();
    const written = JSON.stringify(record);
    for (const secret of ["ACCT-77", "ACCT-991", "bob@", "carol@", "alice@"]) {
      expect(written).not.toContain(secret);
    }
    expect(record?.spec).toBe("tests/[REDACTED].spec.ts");
    expect(record?.step).toContain("[REDACTED]");
    expect(record?.question).toContain("[REDACTED]");
  });

  it("finds a miss reason with the redacted spec and step", async () => {
    const store = new MemoryDecisionStore();
    const redact = [/ACCT-\d+/];
    await recordRun(
      store,
      [{ step: "pay ACCT-1", question: confirmed, state: state() }],
      { snapshot: { redact } },
    );
    const outcome = await session(store, "replay", {
      snapshot: { redact },
    }).decide({
      spec: SPEC,
      step: "pay ACCT-1",
      question: confirmed,
      state: state("Order pending"),
    });
    expect(outcome.reason).toBe("snapshot-changed");
  });

  it("writes nothing and calls nothing when redaction throws", async () => {
    const store = new MemoryDecisionStore();
    const used = decider(answerFor);
    const query = session(store, "record", {
      decider: used,
      snapshot: { redact: [{ pattern: /z/, replacement: "zz" }] },
    });
    await expect(
      query.decide({
        spec: SPEC,
        step: "step z",
        question: confirmed,
        state: state(),
      }),
    ).rejects.toThrow(RedactionError);
    await query.confirm();
    expect(used.calls).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it("refuses to store an answer that redaction would change", async () => {
    const store = new MemoryDecisionStore();
    const query = session(store, "record", {
      decider: decider({ value: "ACCT-1", confidence: 0.9 }),
      snapshot: { redact: [/ACCT-\d+/] },
    });
    await expect(
      query.decide({
        spec: SPEC,
        step: "s1",
        question: {
          kind: "choice",
          prompt: "Which account is selected?",
          options: [
            { id: "ACCT-1", label: "First" },
            { id: "other", label: "Other" },
          ],
        },
        state: state(),
      }),
    ).rejects.toThrow(CacheError);
    await query.confirm();
    expect(await store.list()).toEqual([]);
  });

  it("returns an abstention's free text redacted, fresh and from the memo", async () => {
    const memo = createRunMemo();
    const used = decider({
      value: "page shows alice@example.com only",
      confidence: 0.4,
      abstained: true,
    });
    const input = {
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    };
    const first = await session(new MemoryDecisionStore(), "record", {
      decider: used,
      memo,
    }).decide(input);
    const again = await session(new MemoryDecisionStore(), "record", {
      decider: used,
      memo,
    }).decide(input);
    expect(used.calls).toBe(1);
    for (const outcome of [first, again]) {
      expect(JSON.stringify(outcome)).not.toContain("alice@");
      expect(outcome.answer?.value).toBe(first.record?.answer);
    }
  });
});

describe("createDecisionSession: keys", () => {
  it("misses when a choice label changes", async () => {
    const store = new MemoryDecisionStore();
    await recordRun(store, [
      { step: "s1", question: nextControl, state: state() },
    ]);
    const relabelled: Question = {
      ...nextControl,
      options: [
        { id: "continue", label: "Continue to payment" },
        { id: "back", label: "Back" },
      ],
    };
    const replay = session(store, "replay");
    const same = await replay.decide({
      spec: SPEC,
      step: "s1",
      question: nextControl,
      state: state(),
    });
    const changed = await replay.decide({
      spec: SPEC,
      step: "s1",
      question: relabelled,
      state: state(),
    });
    expect(same.source).toBe("cache");
    expect(changed.source).toBe("none");
    expect(changed.key).not.toBe(same.key);
  });
});

describe("createDecisionSession: on the JSONL store", () => {
  it("replays a committed fixture run with zero decider calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevy-session-"));
    try {
      await recordRun(new JsonlDecisionStore({ dir }), [
        { step: "s1", question: confirmed, state: state() },
        { step: "s2", question: completeness, state: state() },
      ]);
      const throwing = throwingDecider();
      const replay = session(new JsonlDecisionStore({ dir }), "replay", {
        decider: throwing,
      });
      const hit = await replay.decide({
        spec: SPEC,
        step: "s1",
        question: confirmed,
        state: state(),
      });
      const miss = await replay.decide({
        spec: SPEC,
        step: "s2",
        question: completeness,
        state: state("Order failed"),
      });
      expect(throwing.calls).toBe(0);
      expect(hit).toMatchObject({ source: "cache", verdict: "pass" });
      expect(miss).toMatchObject({
        source: "none",
        verdict: "needs-review",
        reason: "snapshot-changed",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createDecisionSession: confirm while deciding", () => {
  it("keeps a record held during an in-flight confirm for the next confirm", async () => {
    const inner = new MemoryDecisionStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: DecisionStore = {
      latest: (key) => inner.latest(key),
      forStep: (spec, step) => inner.forStep(spec, step),
      list: (spec) => inner.list(spec),
      append: async (records) => {
        await gate;
        await inner.append(records);
      },
    };
    const query = session(slow, "record", { decider: decider(answerFor) });
    await query.decide({
      spec: SPEC,
      step: "s1",
      question: confirmed,
      state: state(),
    });
    const confirming = query.confirm();
    await query.decide({
      spec: SPEC,
      step: "s2",
      question: nextControl,
      state: state(),
    });
    release();
    await confirming;
    expect((await inner.list()).map((r) => r.step)).toEqual(["s1"]);
    await query.confirm();
    expect((await inner.list()).map((r) => r.step)).toEqual(["s1", "s2"]);
  });
});
