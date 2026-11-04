import { describe, expect, it } from "vitest";
import { DECIDER_CONTRACT_CASES } from "./contract-cases.js";
import { parseConfig } from "./config.js";
import { MemoryDecisionStore } from "./decision-store.js";
import { ABSTAIN_ID } from "./decider.js";
import { fakeDecider } from "./fake-decider.js";
import { DeciderTransportError } from "./errors.js";
import { openDecider } from "./open-decider.js";
import { resolveDecision } from "./cache.js";
import { gateAnswer } from "./verdict.js";
import { answerFromSignals, prepareWireQuestion } from "./wire-question.js";
import type { Decider } from "./decider.js";

describe("openDecider", () => {
  it("does not pick Jev unless config asks for it", async () => {
    await expect(
      openDecider(parseConfig({}), { factories: {} }),
    ).rejects.toThrow(/No decider selected/);
  });

  it("calls only the selected factory", async () => {
    const seen: string[] = [];
    const config = parseConfig({ decider: "kev" });
    const decider = await openDecider(config, {
      mode: "record",
      factories: {
        jev: () => {
          seen.push("jev");
          return fakeDecider({ id: "jev", model: "jev-1.14.0" });
        },
        kev: () => {
          seen.push("kev");
          return fakeDecider({ id: "kev", model: "kev-4b@v1.0" });
        },
      },
    });
    expect(seen).toEqual(["kev"]);
    expect(decider.id).toBe("kev");
    expect(decider.model).toBe("kev-4b@v1.0");
  });

  it("does not construct a client in replay mode", async () => {
    let constructed = 0;
    const config = parseConfig(
      { decider: "jev", cache: { mode: "replay" } },
      { env: { CI: "true" } },
    );
    const decider = await openDecider(config, {
      mode: config.cache.mode,
      factories: {
        jev: () => {
          constructed += 1;
          return fakeDecider({ id: "jev", model: "jev-1.14.0" });
        },
      },
    });
    expect(constructed).toBe(0);
    expect(decider.id).toBe("jev");
    expect(decider.model).toBe("jev-1.14.0");
    await expect(
      decider.decide(
        { snapshot: { role: "document", name: "Page" } },
        { q: { kind: "yesno", prompt: "Shown?" } },
      ),
    ).rejects.toBeInstanceOf(DeciderTransportError);

    const store = new MemoryDecisionStore();
    const missed = await resolveDecision({
      spec: "tests/page.spec.ts",
      step: "check",
      question: { kind: "yesno", prompt: "Shown?" },
      state: { snapshot: { role: "document", name: "Page" } },
      decider,
      mode: "replay",
      store,
    });
    expect(missed.source).toBe("miss");
    expect(missed.verdict).toBe("needs-review");
    expect(constructed).toBe(0);
    expect(missed.key).toContain("sha256:");
  });

  it("stores the decider id and model, and both signals", async () => {
    const config = parseConfig({ decider: "jev", cache: { mode: "record" } });
    const decider = await openDecider(config, {
      mode: "record",
      factories: {
        jev: (selection) =>
          fakeDecider({
            id: selection.id,
            model: selection.model,
            answers: {
              decision: {
                value: "yes",
                confidence: 0.93,
                probability: 0.61,
              },
            },
          }),
      },
    });
    const store = new MemoryDecisionStore();
    const resolved = await resolveDecision({
      spec: "tests/page.spec.ts",
      step: "check",
      question: { kind: "yesno", prompt: "Shown?" },
      state: { snapshot: { role: "document", name: "Page" } },
      decider,
      mode: "record",
      store,
    });
    expect(resolved.record?.decider).toBe("jev");
    expect(resolved.record?.model).toBe("jev-1.14.0");
    expect(resolved.record?.confidence).toBe(0.93);
    expect(resolved.record?.probability).toBe(0.61);
    expect(resolved.verdict).toBe("pass");
  });

  it("throws when the selected package is not wired", async () => {
    const adapter = { complete: () => Promise.resolve(null) };
    await expect(
      openDecider(
        parseConfig({
          decider: "llm",
          deciders: { llm: { adapter, model: "example/mock" } },
        }),
        { factories: {} },
      ),
    ).rejects.toThrow(/No factory for decider "llm"/);
  });
});

describe("fake decider contract", () => {
  it("returns scripted answers for every contract case", async () => {
    const state = { snapshot: { role: "document", name: "Page" } };
    for (const item of DECIDER_CONTRACT_CASES) {
      const answer = answerFromSignals(
        prepareWireQuestion(item.question),
        item.picked,
        item.probabilities,
        item.confidence,
      );
      const decider: Decider = fakeDecider({
        answers: { q: answer },
      });
      const answers = await decider.decide(state, { q: item.question });
      const got = answers["q"];
      expect(got?.value).toBe(
        item.picked === ABSTAIN_ID ? ABSTAIN_ID : item.picked,
      );
      expect(gateAnswer(item.question, got ?? answer)).toBe(item.verdict);
    }
  });
});
