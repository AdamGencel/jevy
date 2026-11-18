import { findLast } from "./last.js";
import { parseRecord, serialiseRecord } from "./record.js";
import type { DecisionRecord } from "./record.js";
import type { DecisionStore } from "./store.js";

/**
 * An in-memory store for tests and for callers that persist elsewhere.
 * Records go through the same serialise-and-parse round trip as the JSONL
 * store, so a record this store accepts is one the file store would accept,
 * and a caller cannot mutate a record after appending it.
 */
export class MemoryDecisionStore implements DecisionStore {
  readonly #records: DecisionRecord[] = [];

  public latest(key: string): Promise<DecisionRecord | undefined> {
    return Promise.resolve(findLast(this.#records, (r) => r.key === key));
  }

  public forStep(
    spec: string,
    step: string,
  ): Promise<readonly DecisionRecord[]> {
    return Promise.resolve(
      this.#records.filter((r) => r.spec === spec && r.step === step),
    );
  }

  public append(records: readonly DecisionRecord[]): Promise<void> {
    // A throw inside the executor rejects the promise, and nothing is kept
    // unless every record of the batch is valid.
    return new Promise((resolve) => {
      const checked = records.map((r) => parseRecord(serialiseRecord(r)));
      this.#records.push(...checked);
      resolve();
    });
  }

  public list(spec?: string): Promise<readonly DecisionRecord[]> {
    return Promise.resolve(
      spec === undefined
        ? [...this.#records]
        : this.#records.filter((r) => r.spec === spec),
    );
  }
}
