import { describe, expect, it } from "vitest";
import { CacheError } from "../errors.js";
import {
  DECISION_RECORD_VERSION,
  parseRecord,
  readRecordLine,
  serialiseRecord,
} from "./record.js";
import type { DecisionRecord } from "./record.js";

const record: DecisionRecord = {
  v: 2,
  key: `sha256:${"1".repeat(64)}`,
  spec: "tests/checkout.spec.ts",
  step: "toSatisfy#2",
  kind: "yesno",
  question: "The page shows the order as confirmed",
  snapshotHash: `sha256:${"2".repeat(64)}`,
  decider: "jev",
  model: "jev-1.14.0",
  answer: "yes",
  confidence: 0.93,
  abstained: false,
  truncated: false,
  verdict: "pass",
  thresholds: { pass: 0.8, fail: 0.5 },
  rules: `sha256:${"3".repeat(64)}`,
  createdAt: "2026-10-27T22:00:00.000Z",
  reviewedBy: null,
  reviewVerdict: null,
};

const FIELD_ORDER = [
  "v",
  "key",
  "spec",
  "step",
  "kind",
  "question",
  "snapshotHash",
  "decider",
  "model",
  "answer",
  "confidence",
  "abstained",
  "truncated",
  "verdict",
  "thresholds",
  "rules",
  "createdAt",
  "reviewedBy",
  "reviewVerdict",
];

function lineWith(changes: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(serialiseRecord(record)), ...changes });
}

describe("serialiseRecord", () => {
  it("writes one line with the keys in a fixed order", () => {
    const line = serialiseRecord(record);
    expect(line).not.toContain("\n");
    expect(Object.keys(JSON.parse(line) as object)).toEqual(FIELD_ORDER);
  });

  it("is byte-stable whatever order the input object was built in", () => {
    const shuffled = Object.fromEntries(
      Object.entries(record).reverse(),
    ) as unknown as DecisionRecord;
    const reversedThresholds: DecisionRecord = {
      ...shuffled,
      thresholds: { fail: 0.5, pass: 0.8 },
    };
    expect(serialiseRecord(reversedThresholds)).toBe(serialiseRecord(record));
    expect(serialiseRecord(record)).toBe(
      '{"v":2,"key":"sha256:1111111111111111111111111111111111111111111111111111111111111111","spec":"tests/checkout.spec.ts","step":"toSatisfy#2","kind":"yesno","question":"The page shows the order as confirmed","snapshotHash":"sha256:2222222222222222222222222222222222222222222222222222222222222222","decider":"jev","model":"jev-1.14.0","answer":"yes","confidence":0.93,"abstained":false,"truncated":false,"verdict":"pass","thresholds":{"pass":0.8,"fail":0.5},"rules":"sha256:3333333333333333333333333333333333333333333333333333333333333333","createdAt":"2026-10-27T22:00:00.000Z","reviewedBy":null,"reviewVerdict":null}',
    );
  });

  it("refuses a record carrying a property outside the format, such as a snapshot", () => {
    const extra = { ...record, snapshot: { role: "main" } } as DecisionRecord;
    expect(() => serialiseRecord(extra)).toThrow(CacheError);
  });

  it("refuses to serialise an invalid record", () => {
    expect(() => serialiseRecord({ ...record, confidence: 2 })).toThrow(
      CacheError,
    );
  });
});

describe("parseRecord", () => {
  it("round-trips a record", () => {
    expect(parseRecord(serialiseRecord(record))).toEqual(record);
    const reviewed: DecisionRecord = {
      ...record,
      verdict: "needs-review",
      confidence: 0.6,
      reviewedBy: "adam",
      reviewVerdict: "pass",
    };
    expect(parseRecord(serialiseRecord(reviewed))).toEqual(reviewed);
  });

  it("returns keys in the canonical order", () => {
    const shuffled = JSON.stringify(
      Object.fromEntries(Object.entries(record).reverse()),
    );
    expect(Object.keys(parseRecord(shuffled))).toEqual(FIELD_ORDER);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a superseded version", { v: 1 }],
    ["a future version", { v: 3 }],
    ["a string version", { v: "2" }],
    ["malformed key", { key: "sha256:xyz" }],
    ["empty spec", { spec: "" }],
    ["non-string step", { step: 3 }],
    ["unknown kind", { kind: "maybe" }],
    ["empty question", { question: " " }],
    ["malformed snapshot hash", { snapshotHash: "abc" }],
    ["empty decider", { decider: "" }],
    ["non-string model", { model: null }],
    ["empty answer", { answer: "" }],
    ["confidence out of range", { confidence: 1.5 }],
    ["string confidence", { confidence: "0.9" }],
    ["non-boolean abstained", { abstained: "false" }],
    ["non-boolean truncated", { truncated: 0 }],
    ["unknown verdict", { verdict: "ok" }],
    ["thresholds with fail >= pass", { thresholds: { pass: 0.5, fail: 0.5 } }],
    [
      "thresholds with an extra key",
      { thresholds: { pass: 0.8, fail: 0.5, x: 1 } },
    ],
    ["thresholds missing", { thresholds: null }],
    ["malformed rules", { rules: "sha1:abc" }],
    ["non-UTC createdAt", { createdAt: "2026-10-27T22:00:00+01:00" }],
    ["impossible createdAt", { createdAt: "2026-02-30T22:00:00Z" }],
    ["reviewer without a verdict", { reviewedBy: "adam" }],
    ["verdict without a reviewer", { reviewVerdict: "pass" }],
    ["empty reviewer", { reviewedBy: "", reviewVerdict: "pass" }],
    [
      "review verdict needs-review",
      { reviewedBy: "adam", reviewVerdict: "needs-review" },
    ],
    ["yes/no answer that is not yes or no", { answer: "maybe" }],
    ["unknown key", { snapshot: { role: "main" } }],
  ])("rejects %s", (_label, changes) => {
    expect(() => parseRecord(lineWith(changes))).toThrow(CacheError);
  });

  it("rejects a missing field", () => {
    const value = JSON.parse(serialiseRecord(record)) as Record<
      string,
      unknown
    >;
    delete value["rules"];
    expect(() => parseRecord(JSON.stringify(value))).toThrow(CacheError);
  });

  it("rejects text that is not a JSON object", () => {
    expect(() => parseRecord("not json")).toThrow(CacheError);
    expect(() => parseRecord("[]")).toThrow(CacheError);
    expect(() => parseRecord("null")).toThrow(CacheError);
  });

  it("accepts an abstained yes/no answer with free text", () => {
    const abstained: DecisionRecord = {
      ...record,
      answer: "unknown",
      abstained: true,
      verdict: "needs-review",
    };
    expect(parseRecord(serialiseRecord(abstained))).toEqual(abstained);
  });
});

describe("readRecordLine", () => {
  it("is version 2, the version that carries version 2 keys", () => {
    expect(DECISION_RECORD_VERSION).toBe(2);
  });

  it("returns a current record as parseRecord does", () => {
    expect(readRecordLine(serialiseRecord(record))).toEqual(record);
  });

  it("skips a version 1 record, whose key no current key can equal", () => {
    expect(readRecordLine(lineWith({ v: 1 }))).toBeUndefined();
    expect(readRecordLine('{"v":1}')).toBeUndefined();
  });

  it("rejects a version 1 line with a field version 1 never had, such as page text", () => {
    expect(() => readRecordLine('{"v":1,"page":"secret text"}')).toThrow(
      /unknown field "page"/,
    );
    expect(() => readRecordLine(lineWith({ v: 1, snapshot: {} }))).toThrow(
      CacheError,
    );
  });

  it("still rejects malformed lines and versions it does not know", () => {
    expect(() => readRecordLine("not json")).toThrow(CacheError);
    expect(() => readRecordLine("[1]")).toThrow(CacheError);
    expect(() => readRecordLine(lineWith({ v: 3 }))).toThrow(CacheError);
    expect(() => readRecordLine(lineWith({ v: "1" }))).toThrow(CacheError);
    expect(() => readRecordLine(lineWith({ confidence: 2 }))).toThrow(
      CacheError,
    );
  });
});
