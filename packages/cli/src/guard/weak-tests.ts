/**
 * Finds a test that checks nothing: one with no assertion, one whose
 * assertions cannot fail, or one that only checks a mock it made itself.
 * Also a test that only an advisory `toSatisfy` can fail, for review.
 *
 * The first two block an agent's session, so every rule here leans one way:
 * when the guard cannot prove a test is empty, it asks a person to look
 * (`assertion-not-visible`) or says nothing. Nothing is imported or run, so
 * "prove" means reading the one file: a call into any other file, or a value
 * that came from one, may hold the assertion.
 *
 * This is the public entry point; the rules live in `./weak-tests/`:
 * `file-facts` reads the file once, `trust` and `body` read one test,
 * `constants` and `mocks` judge its assertions, `verdict` turns the evidence
 * into at most one finding, and `fingerprint` tells a reformatted body from a
 * changed one.
 */

export { readTestBody, type BodyReading } from "./weak-tests/body.js";
export { constantOutcome } from "./weak-tests/constants.js";
export { readFileFacts } from "./weak-tests/file-facts.js";
export { formatFingerprint } from "./weak-tests/fingerprint.js";
export { subjectRoot } from "./weak-tests/mocks.js";
export {
  NO_SCOPE,
  type AssertionParts,
  type AssertionScope,
  type BodyEvidence,
  type Constant,
  type ConstantOutcome,
  type FileFacts,
  type FixedResult,
  type Known,
  type TestShape,
} from "./weak-tests/model.js";
export {
  weakTestFinding,
  type VerdictOptions,
  type WeakCandidate,
} from "./weak-tests/verdict.js";
