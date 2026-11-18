import type { DecisionRecord } from "./record.js";

/**
 * Where decision records live. Records are immutable and append-only: a new
 * answer for a key is a new record, and for one key the last appended record
 * wins. A store validates every record of a batch before it keeps any of them.
 */
export interface DecisionStore {
  /** The last appended record for `key`, or undefined. */
  latest(key: string): Promise<DecisionRecord | undefined>;
  /** Every record for one step of one spec, oldest first. */
  forStep(spec: string, step: string): Promise<readonly DecisionRecord[]>;
  append(records: readonly DecisionRecord[]): Promise<void>;
  /** Every record, or every record of one spec, oldest first within a spec. */
  list(spec?: string): Promise<readonly DecisionRecord[]>;
}
