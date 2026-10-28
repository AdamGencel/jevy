import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "./guards.js";
import {
  CacheError,
  CacheMissError,
  DECISION_RECORD_FIELDS,
  DECISION_SCHEMA_VERSION,
  JsonlDecisionStore,
  MemoryDecisionStore,
  RedactionError,
  cacheStats,
  decisionKey,
  decisionKeyMaterial,
  formatCacheStats,
  openDecisionStore,
  parseConfig,
  pruneCache,
  resolveDecision,
  reviewDecision,
  specFile,
} from "./index.js";
import type {
  AccessibilityNode,
  Answer,
  Decider,
  DecisionRecord,
  Question,
  Verdict,
} from "./index.js";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz012345";
const TX = `0x${"ab".repeat(32)}`;
const EMAIL = "ada@example.com";
const PASSWORD = "hunter2-cache-secret";
const SEED =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";
const DAY_MS = 24 * 60 * 60 * 1000;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("decision key", () => {
  it("mixes schema, kind, prompt, goal, choices, snapshot, decider and model", () => {
    const snapshotHash = "sha256:" + "ab".repeat(32);
    const base = {
      kind: "yesno" as const,
      prompt: "The page shows the order as confirmed",
      snapshotHash,
      deciderId: "jev",
      model: "jev-1.14.0",
    };
    const key = decisionKey(base);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decisionKeyMaterial(base)).toContain(
      `"v":${String(DECISION_SCHEMA_VERSION)}`,
    );
    expect(
      decisionKey({
        ...base,
        prompt: "The page shows the order as   confirmed",
      }),
    ).toBe(key);
    expect(
      decisionKey({ ...base, prompt: "The page shows the order as failed" }),
    ).not.toBe(key);
    expect(decisionKey({ ...base, goal: "ship the order" })).not.toBe(key);
    expect(
      decisionKey({ ...base, criteria: "confirmed, not pending" }),
    ).not.toBe(key);
    expect(
      decisionKey({
        ...base,
        choices: [{ id: "pay", label: "Pay" }],
      }),
    ).not.toBe(key);
    expect(
      decisionKey({
        ...base,
        kind: "choice",
        choices: [
          { id: "pay", label: "Pay" },
          { id: "cancel", label: "Cancel" },
        ],
      }),
    ).not.toBe(
      decisionKey({
        ...base,
        kind: "choice",
        choices: [
          { id: "pay", label: "Submit" },
          { id: "cancel", label: "Cancel" },
        ],
      }),
    );
    expect(
      decisionKey({ ...base, snapshotHash: "sha256:" + "cd".repeat(32) }),
    ).not.toBe(key);
    expect(decisionKey({ ...base, deciderId: "kev" })).not.toBe(key);
    expect(decisionKey({ ...base, model: "jev-1.15.0" })).not.toBe(key);
    expect(
      decisionKeyMaterial({ ...base, prompt: `pay ${SECRET}` }),
    ).not.toContain(SECRET);
  });
});

describe("decision store", () => {
  it("writes sorted JSONL with stable key order and refuses a secret", async () => {
    const dir = await tempDir();
    const store = new JsonlDecisionStore(dir);
    const later = makeRecord({ key: sha("b"), step: "later" });
    const earlier = makeRecord({ key: sha("a"), step: "earlier" });
    await store.put(later);
    await store.put(earlier);
    const file = specFile(dir, "tests/checkout.spec.ts");
    const text = await readFile(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = jsonLine(lines[0]);
    const second = jsonLine(lines[1]);
    expect(Object.keys(first)).toEqual([...DECISION_RECORD_FIELDS]);
    expect(first["key"]).toBe(sha("a"));
    expect(second["key"]).toBe(sha("b"));

    const forward = new JsonlDecisionStore(await tempDir());
    await forward.put(earlier);
    await forward.put(later);
    expect(
      await readFile(specFile(forward.dir, "tests/checkout.spec.ts"), "utf8"),
    ).toBe(text);

    await expect(
      store.put(makeRecord({ key: sha("c"), question: `token ${SECRET}` })),
    ).rejects.toBeInstanceOf(RedactionError);
    expect(await readDisk(dir)).not.toContain(SECRET);
  });

  it("keeps one file intact when two stores write at once", async () => {
    const dir = await tempDir();
    const stores = [new JsonlDecisionStore(dir), new JsonlDecisionStore(dir)];
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => {
        const store = stores[index % 2];
        if (store === undefined) throw new Error("missing store");
        return store.put(
          makeRecord({
            key: sha(index.toString(16)),
            step: `step-${String(index)}`,
          }),
        );
      }),
    );
    const first = stores[0];
    if (first === undefined) throw new Error("missing store");
    const listed = await first.list();
    expect(listed).toHaveLength(24);
    const text = await readFile(
      specFile(dir, "tests/checkout.spec.ts"),
      "utf8",
    );
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(24);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it("rejects a spec path that escapes the cache directory", async () => {
    const dir = await tempDir();
    const store = new JsonlDecisionStore(dir);
    await expect(
      store.put(makeRecord({ key: sha("a"), spec: "../secrets" })),
    ).rejects.toBeInstanceOf(CacheError);
    await expect(
      store.put(makeRecord({ key: sha("b"), spec: "/tmp/checkout.spec.ts" })),
    ).rejects.toBeInstanceOf(CacheError);
    await expect(lstat(join(dir, "..", "secrets.jsonl"))).rejects.toThrow();
  });
});

describe("resolveDecision", () => {
  it("hits on a cosmetic change and misses on a relevant one", async () => {
    const store = new MemoryDecisionStore();
    const calls = { n: 0 };
    const decider = fakeDecider({ value: "yes", confidence: 0.93 }, calls);
    const recorded = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo("The page shows the order as confirmed"),
      state: { snapshot: stamped("2026-10-28T01:02:03Z", "Pay") },
      decider,
      mode: "record",
      store,
      now: at("2026-10-28T00:00:00.000Z"),
    });
    expect(recorded.source).toBe("decider");
    expect(recorded.verdict).toBe("pass");
    expect(calls.n).toBe(1);

    const cosmetic = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo("The page shows the order as   confirmed"),
      state: {
        snapshot: stamped(
          "2026-10-28T09:30:00.123Z",
          "Pay",
          "550e8400-e29b-41d4-a716-446655440000",
          "12345678",
        ),
      },
      decider: throwingDecider(),
      mode: "replay",
      store,
    });
    expect(cosmetic.source).toBe("cache");
    expect(cosmetic.verdict).toBe("pass");
    expect(calls.n).toBe(1);

    const digits = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo("The page shows the order as confirmed"),
      state: {
        snapshot: stamped(
          "3 seconds ago",
          "Pay",
          "11111111-1111-4111-8111-111111111111",
          "87654321",
        ),
      },
      decider: throwingDecider(),
      mode: "replay-or-query",
      store,
    });
    expect(digits.source).toBe("cache");

    const renamed = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo("The page shows the order as confirmed"),
      state: { snapshot: stamped("2026-10-28T01:02:03Z", "Submit") },
      decider: throwingDecider(),
      mode: "replay",
      store,
    });
    expect(renamed.source).toBe("miss");
    expect(renamed.verdict).toBe("needs-review");
    expect(renamed.record).toBeNull();

    const checked = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo("The page shows the order as confirmed"),
      state: {
        snapshot: stamped(
          "2026-10-28T01:02:03Z",
          "Pay",
          undefined,
          undefined,
          true,
        ),
      },
      decider: throwingDecider(),
      mode: "replay",
      store,
    });
    expect(checked.source).toBe("miss");
    await expect(
      resolveDecision({
        spec: "tests/checkout.spec.ts",
        step: "toSatisfy#1",
        question: yesNo("The page shows the order as confirmed"),
        state: { snapshot: stamped("2026-10-28T01:02:03Z", "Submit") },
        decider: throwingDecider(),
        mode: "replay",
        store,
        onMiss: "error",
      }),
    ).rejects.toBeInstanceOf(CacheMissError);
  });

  it("does not flip a cached low-confidence yes or no", async () => {
    const store = new MemoryDecisionStore();
    const weak = await resolveDecision({
      ...ask(store, "record"),
      decider: fakeDecider({ value: "yes", confidence: 0.25 }, { n: 0 }),
    });
    expect(weak.verdict).toBe("needs-review");
    const replayedWeak = await resolveDecision({
      ...ask(store, "replay"),
      decider: throwingDecider(),
    });
    expect(replayedWeak.source).toBe("cache");
    expect(replayedWeak.verdict).toBe("needs-review");

    const no = await resolveDecision({
      ...ask(store, "record"),
      step: "toSatisfy#no",
      question: yesNo("The page shows the order as failed"),
      decider: fakeDecider({ value: "no", confidence: 0.93 }, { n: 0 }),
    });
    expect(no.verdict).toBe("fail");
    const replayedNo = await resolveDecision({
      ...ask(store, "replay"),
      step: "toSatisfy#no",
      question: yesNo("The page shows the order as failed"),
      decider: throwingDecider(),
    });
    expect(replayedNo.verdict).toBe("fail");

    const strong = await resolveDecision({
      ...ask(store, "record"),
      step: "toSatisfy#yes",
      question: yesNo("The page shows a receipt"),
      decider: fakeDecider({ value: "yes", confidence: 0.91 }, { n: 0 }),
    });
    expect(strong.verdict).toBe("pass");
    expect(strong.record).not.toBeNull();
    if (strong.record === null) return;
    await store.put(
      { ...strong.record, confidence: 0.25, verdict: "pass" },
      { replace: true },
    );
    const poisoned = await resolveDecision({
      ...ask(store, "replay"),
      step: "toSatisfy#yes",
      question: yesNo("The page shows a receipt"),
      decider: throwingDecider(),
    });
    expect(poisoned.record?.verdict).toBe("pass");
    expect(poisoned.verdict).toBe("needs-review");

    const raised = await resolveDecision({
      ...ask(store, "replay"),
      step: "toSatisfy#yes",
      question: yesNo("The page shows a receipt"),
      decider: throwingDecider(),
      thresholds: { pass: 0.95, fail: 0.2 },
    });
    expect(raised.verdict).toBe("needs-review");

    await reviewDecision(store, weak.key, "Ada");
    const reviewed = await resolveDecision({
      ...ask(store, "replay"),
      decider: throwingDecider(),
    });
    expect(reviewed.record?.reviewedBy).toBe("Ada");
    expect(reviewed.verdict).toBe("needs-review");
    await expect(reviewDecision(store, weak.key, EMAIL)).rejects.toBeInstanceOf(
      CacheError,
    );
  });

  it("overwrites in record mode and appends a review without a second query", async () => {
    const store = new MemoryDecisionStore();
    const calls = { n: 0 };
    await resolveDecision({
      ...ask(store, "record"),
      decider: fakeDecider({ value: "yes", confidence: 0.95 }, calls),
    });
    await resolveDecision({
      ...ask(store, "record"),
      decider: fakeDecider({ value: "no", confidence: 0.95 }, calls),
    });
    expect(calls.n).toBe(2);
    const overwritten = await store.list();
    expect(overwritten).toHaveLength(1);
    expect(overwritten[0]?.answer).toBe("no");

    const refresh = { n: 0 };
    await resolveDecision({
      ...ask(store, "replay-or-query"),
      step: "other",
      question: yesNo("The receipt is visible"),
      decider: fakeDecider({ value: "yes", confidence: 0.99 }, refresh),
      now: at("2026-10-28T00:00:00.000Z"),
    });
    const again = await resolveDecision({
      ...ask(store, "replay-or-query"),
      step: "other",
      question: yesNo("The receipt is visible"),
      decider: fakeDecider({ value: "yes", confidence: 0.99 }, refresh),
      now: at("2026-10-29T00:00:00.000Z"),
    });
    expect(refresh.n).toBe(1);
    expect(again.source).toBe("cache");
    expect(again.record?.lastUsedAt).toBe("2026-10-29T00:00:00.000Z");
    const choice = await resolveDecision({
      ...ask(store, "record"),
      step: "choose",
      question: {
        kind: "choice",
        prompt: "Which control submits the order?",
        options: [
          { id: "pay", label: "Pay" },
          { id: "cancel", label: "Cancel" },
        ],
      },
      decider: fakeDecider({ value: "pay", confidence: 0.9 }, { n: 0 }),
    });
    expect(choice.verdict).toBe("pass");
    const relabelled = await resolveDecision({
      ...ask(store, "replay"),
      step: "choose",
      question: {
        kind: "choice",
        prompt: "Which control submits the order?",
        options: [
          { id: "pay", label: "Submit" },
          { id: "cancel", label: "Cancel" },
        ],
      },
      decider: throwingDecider(),
    });
    expect(relabelled.source).toBe("miss");
  });

  it("never writes a secret to disk", async () => {
    const dir = await tempDir();
    const store = new JsonlDecisionStore(dir);
    await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#1",
      question: yesNo(`Confirm ${SECRET} ${EMAIL} ${TX} ${SEED}`),
      state: {
        snapshot: {
          role: "WebArea",
          name: "Checkout",
          children: [
            {
              role: "textbox",
              name: "Password",
              value: PASSWORD,
            },
            { role: "status", name: `ref ${TX}` },
          ],
        },
        url: `https://example.test/reset?token=${SECRET}`,
        goal: `send ${TX} to ${EMAIL}`,
      },
      goal: `send ${TX} to ${EMAIL}`,
      decider: fakeDecider({ value: "yes", confidence: 0.99 }, { n: 0 }),
      mode: "record",
      store,
    });
    const disk = await readDisk(dir);
    expect(disk).not.toContain(SECRET);
    expect(disk).not.toContain(TX);
    expect(disk).not.toContain(EMAIL);
    expect(disk).not.toContain(PASSWORD);
    expect(disk).not.toContain("abandon ability");
    expect(disk).toContain("[REDACTED]");
    const listed = await store.list();
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("does not rewrite the cache during replay", async () => {
    const dir = await tempDir();
    const store = new JsonlDecisionStore(dir);
    await resolveDecision({
      ...ask(store, "record"),
      decider: fakeDecider({ value: "yes", confidence: 0.99 }, { n: 0 }),
    });
    const file = specFile(dir, "tests/checkout.spec.ts");
    const before = await readFile(file, "utf8");
    const lastRun = await readFile(join(dir, ".last-run.json"), "utf8");
    await resolveDecision({
      ...ask(store, "replay"),
      decider: throwingDecider(),
    });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readFile(join(dir, ".last-run.json"), "utf8")).toBe(lastRun);
    const entriesBefore = (await readdir(dir)).sort();
    await resolveDecision({
      ...ask(store, "replay"),
      step: "missing",
      question: yesNo("This question was never recorded"),
      decider: throwingDecider(),
    });
    expect((await readdir(dir)).sort()).toEqual(entriesBefore);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("CI replay fixture", () => {
  it("makes zero network calls", async () => {
    const dir = await tempDir();
    const config = parseConfig(
      { cache: { dir }, decider: "kev" },
      { env: { CI: "true" } },
    );
    expect(config.cache.mode).toBe("replay");
    const store = openDecisionStore(config.cache);
    expect(store).toBeInstanceOf(JsonlDecisionStore);
    const recorded = await resolveDecision({
      spec: "tests/checkout.spec.ts",
      step: "toSatisfy#2",
      question: yesNo("The page shows the order as confirmed"),
      state: { snapshot: checkout("Pay") },
      decider: {
        id: "jev",
        model: "jev-1.14.0",
        decide(_state, questions) {
          return Promise.resolve(
            answered(questions, { value: "yes", confidence: 0.93 }),
          );
        },
      },
      mode: "record",
      store,
    });
    expect(recorded.verdict).toBe("pass");

    const calls: string[] = [];
    // Node's global fetch is the undici fetch. This runtime has no
    // separate `node:undici` module, so the ban covers that fetch plus
    // the http and https request entry points.
    const originalFetch = globalThis.fetch;
    const originalHttp = http.request;
    const originalHttps = https.request;
    const fail = (kind: string): never => {
      calls.push(kind);
      throw new Error(`network disabled (${kind})`);
    };
    globalThis.fetch = () => fail("fetch");
    http.request = () => fail("http.request");
    https.request = () => fail("https.request");
    try {
      const network: Decider = {
        id: "jev",
        model: "jev-1.14.0",
        decide() {
          return globalThis
            .fetch("https://api.typesafe.ai/v1/systemone")
            .then(() => {
              throw new Error("fetch resolved");
            });
        },
      };
      const replayed = await resolveDecision({
        spec: "tests/checkout.spec.ts",
        step: "toSatisfy#2",
        question: yesNo("The page shows the order as confirmed"),
        state: { snapshot: checkout("Pay") },
        decider: network,
        mode: config.cache.mode,
        store,
      });
      expect(replayed.source).toBe("cache");
      expect(replayed.verdict).toBe("pass");
      const missed = await resolveDecision({
        spec: "tests/checkout.spec.ts",
        step: "toSatisfy#3",
        question: yesNo("The page shows a refund"),
        state: { snapshot: checkout("Pay") },
        decider: network,
        mode: config.cache.mode,
        store,
      });
      expect(missed.source).toBe("miss");
      expect(missed.verdict).toBe("needs-review");
    } finally {
      globalThis.fetch = originalFetch;
      http.request = originalHttp;
      https.request = originalHttps;
    }
    expect(calls).toEqual([]);
  });
});

describe("cache stats and prune", () => {
  it("counts records and drops unused or unreferenced ones", async () => {
    const store = new MemoryDecisionStore();
    const now = new Date("2026-10-28T00:00:00.000Z");
    const old = new Date(now.getTime() - 40 * DAY_MS).toISOString();
    const fresh = now.toISOString();
    await store.put(
      makeRecord({
        key: sha("a"),
        step: "older-line",
        lastUsedAt: old,
        createdAt: old,
      }),
    );
    await store.put(
      makeRecord({
        key: sha("a"),
        lastUsedAt: fresh,
        createdAt: fresh,
        reviewedBy: "Ada",
      }),
    );
    const preferReview = new MemoryDecisionStore();
    await preferReview.put(
      makeRecord({ key: sha("c"), createdAt: fresh, lastUsedAt: fresh }),
    );
    await preferReview.put(
      makeRecord({
        key: sha("c"),
        step: "reviewed",
        createdAt: old,
        lastUsedAt: old,
        reviewedBy: "Ada",
      }),
    );
    expect((await preferReview.get(sha("c")))?.reviewedBy).toBe("Ada");
    await store.put(
      makeRecord({
        key: sha("b"),
        step: "stale",
        question: "A stale question",
        lastUsedAt: old,
        createdAt: old,
        verdict: "needs-review",
        confidence: 0.2,
      }),
    );
    const stats = await cacheStats(store);
    expect(stats.records).toBe(3);
    expect(stats.keys).toBe(2);
    expect(stats.superseded).toBe(1);
    expect(formatCacheStats(stats)).toContain("records: 3");
    expect(formatCacheStats(stats)).toContain("decider fake: 3");

    const pruned = await pruneCache(store, { days: 30, now: () => now });
    expect(pruned.droppedSuperseded).toBe(1);
    expect(pruned.droppedUnused).toBe(1);
    expect(pruned.kept).toBe(1);
    const left = await store.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.reviewedBy).toBe("Ada");

    const referenced = new MemoryDecisionStore();
    await referenced.put(makeRecord({ key: sha("a") }));
    await referenced.put(
      makeRecord({ key: sha("b"), step: "other", question: "Other" }),
    );
    await referenced.noteReferenced(sha("a"), fresh);
    const dropped = await pruneCache(referenced, { notReferenced: true });
    expect(dropped.kept).toBe(1);
    expect((await referenced.list())[0]?.key).toBe(sha("a"));
    await expect(pruneCache(referenced, {})).rejects.toBeInstanceOf(CacheError);
    await expect(
      pruneCache(referenced, { days: 1, notReferenced: true }),
    ).rejects.toBeInstanceOf(CacheError);
  });
});

function ask(
  store: MemoryDecisionStore | JsonlDecisionStore,
  mode: "replay" | "replay-or-query" | "record",
): {
  spec: string;
  step: string;
  question: Question;
  state: { snapshot: AccessibilityNode };
  mode: "replay" | "replay-or-query" | "record";
  store: MemoryDecisionStore | JsonlDecisionStore;
} {
  return {
    spec: "tests/checkout.spec.ts",
    step: "toSatisfy#1",
    question: yesNo("The page shows the order as confirmed"),
    state: { snapshot: checkout("Pay") },
    mode,
    store,
  };
}

function yesNo(prompt: string): Question {
  return { kind: "yesno", prompt };
}

function checkout(name: string, checked?: boolean): AccessibilityNode {
  return {
    role: "WebArea",
    name: "Checkout",
    children: [
      checked === undefined
        ? { role: "button", name }
        : { role: "button", name, checked },
    ],
  };
}

function stamped(
  when: string,
  name: string,
  id = "550e8400-e29b-41d4-a716-446655440000",
  digits = "12345678",
  checked?: boolean,
): AccessibilityNode {
  return {
    role: "WebArea",
    name: "Checkout",
    children: [
      checked === undefined
        ? { role: "button", name }
        : { role: "button", name, checked },
      { role: "status", name: `Updated ${when} ref ${id} order ${digits}` },
    ],
  };
}

function fakeDecider(answer: Answer, calls: { n: number }): Decider {
  return {
    id: "fake",
    model: "fake-1",
    decide(_state, questions) {
      calls.n += 1;
      return Promise.resolve(answered(questions, answer));
    },
  };
}

function throwingDecider(): Decider {
  return {
    id: "fake",
    model: "fake-1",
    decide() {
      return Promise.reject(new Error("decider must not be called"));
    },
  };
}

function answered(
  questions: Readonly<Record<string, Question>>,
  answer: Answer,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const name of Object.keys(questions)) answers[name] = answer;
  return answers;
}

function makeRecord(overrides: {
  readonly key: string;
  readonly spec?: string;
  readonly step?: string;
  readonly question?: string;
  readonly createdAt?: string;
  readonly lastUsedAt?: string;
  readonly reviewedBy?: string | null;
  readonly answer?: string;
  readonly confidence?: number;
  readonly verdict?: Verdict;
}): DecisionRecord {
  const createdAt = overrides.createdAt ?? "2026-10-28T00:00:00.000Z";
  return {
    v: DECISION_SCHEMA_VERSION,
    key: overrides.key,
    spec: overrides.spec ?? "tests/checkout.spec.ts",
    step: overrides.step ?? "toSatisfy#1",
    kind: "yesno",
    question: overrides.question ?? "The page shows the order as confirmed",
    criteria: null,
    goal: null,
    choices: [],
    snapshotHash: sha("snapshot"),
    decider: "fake",
    model: "fake-1",
    answer: overrides.answer ?? "yes",
    confidence: overrides.confidence ?? 0.93,
    verdict: overrides.verdict ?? "pass",
    thresholds: { pass: 0.8, fail: 0.5 },
    createdAt,
    lastUsedAt: overrides.lastUsedAt ?? createdAt,
    reviewedBy: overrides.reviewedBy ?? null,
  };
}

function sha(label: string): string {
  const hex = Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64);
  return `sha256:${hex}`;
}

function jsonLine(line: string | undefined): Record<string, unknown> {
  if (line === undefined) throw new Error("missing line");
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("line is not an object");
  return parsed;
}

function at(iso: string): () => Date {
  return () => new Date(iso);
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jevy-cache-"));
  directories.push(dir);
  return dir;
}

async function readDisk(dir: string): Promise<string> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(dir);
  } catch {
    return "";
  }
  if (stat.isFile()) return readFile(dir, "utf8");
  if (!stat.isDirectory()) return "";
  const names = await readdir(dir);
  const chunks: string[] = [];
  for (const name of names) chunks.push(await readDisk(join(dir, name)));
  return chunks.join("\n");
}
