/**
 * Public types of `jevy guard`. The JSON report is a contract with CI scripts
 * and coding agents, so its shape is versioned by `v` and only grows.
 */

export type Severity = "weakening" | "review" | "info";

export type FindingKind =
  // Test files.
  | "test-file-removed"
  | "test-removed"
  | "test-renamed"
  | "test-added"
  | "assertion-removed"
  | "assertion-changed"
  | "assertion-added"
  | "statement-changed"
  | "skip-added"
  | "only-added"
  | "expected-failure-added"
  | "soft-added"
  | "dynamic-title"
  | "cases-changed"
  | "unparseable"
  // New or changed tests that check nothing.
  | "test-without-assertion"
  | "assertion-not-visible"
  | "assertion-cannot-fail"
  | "only-checks-mocks"
  // A new or changed test that only an advisory toSatisfy can fail.
  | "only-advisory-assertions"
  // Paths an agent must not change without a person.
  | "protected-path-changed"
  // A submodule (or nested repository) where tests or protected paths are.
  | "submodule-changed"
  // jevy.config.* and playwright.config.*.
  | "threshold-lowered"
  | "needs-review-relaxed"
  | "blocking-switched-off"
  | "redaction-rules-changed"
  | "normalise-rules-changed"
  | "decider-changed"
  | "config-changed"
  | "retries-raised"
  // The decision cache.
  | "approval-added"
  | "decision-added"
  | "decision-removed"
  | "decision-unreadable";

export interface Finding {
  readonly kind: FindingKind;
  readonly severity: Severity;
  /** Repository-relative path, with forward slashes, in the head version. */
  readonly file: string;
  /** Title path of the test or describe block: describe titles, then its own. */
  readonly test?: readonly string[];
  /** 1-based line in the head version, or in the base version when the thing is gone. */
  readonly line?: number;
  readonly message: string;
  readonly before?: string;
  readonly after?: string;
}

export interface GuardSummary {
  readonly weakening: number;
  readonly review: number;
  readonly info: number;
}

export interface GuardReport {
  readonly v: 1;
  readonly tool: "jevy-guard";
  readonly base: string;
  readonly head: string;
  /** The commit compared against, when `--merge-base` replaced `base` with it. */
  readonly mergeBase?: string;
  readonly summary: GuardSummary;
  readonly findings: readonly Finding[];
}

export type FailOn = "weakening" | "review" | "never";
