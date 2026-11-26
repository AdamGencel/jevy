// Jevy for Playwright: `test` and `expect` with `toSatisfy`, the snapshot
// bridge, and the report types. The reporter is `@jevyjs/playwright/reporter`.
export { test } from "./fixtures.js";
export type { JevyTestOptions } from "./fixtures.js";
export { expect } from "./matcher.js";
export type { ToSatisfyOptions } from "./matcher.js";
export type { DeciderOption } from "./runtime.js";

export { parseAriaSnapshot } from "./parse.js";
export { rememberPasswordFields, snapshotAccessibility } from "./snapshot.js";

export {
  REPORT_ATTACHMENT_CONTENT_TYPE,
  REPORT_ATTACHMENT_NAME,
  REPORT_TOOL,
  REPORT_VERSION,
  ReportError,
  parseReportEntry,
  serialiseReportEntry,
  validateReportEntry,
} from "./report/schema.js";
export type {
  AttemptStatus,
  Effect,
  FailReason,
  JevyReport,
  NeedsReviewReason,
  Reason,
  ReportAnswer,
  ReportAssertion,
  ReportIncomplete,
  ReportRun,
  ReportSummary,
  RunStatus,
} from "./report/schema.js";
