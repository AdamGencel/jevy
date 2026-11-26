/**
 * Base class for errors raised by `@jevyjs/core`.
 * Callers can catch this when they want any Jevy failure.
 */
export class JevyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `jevy.config.ts` is missing, invalid, or asks for something M1 does not do. */
export class ConfigError extends JevyError {}

/** A question or answer does not match the Decider contract. */
export class QuestionError extends JevyError {}

/** An accessibility snapshot is malformed, cyclic, or has no matching region. */
export class SnapshotError extends JevyError {}

/**
 * Redaction could not prove the text was safe to hash or send.
 * Callers must treat this as fatal: do not hash, store, or send the input.
 */
export class RedactionError extends JevyError {}

/**
 * The decision cache refused a key, record, spec path, or session setup.
 * A cache that cannot prove a record is well formed must not replay it.
 */
export class CacheError extends JevyError {}

/**
 * The decider could not be reached, or kept returning invalid output after
 * its retries. It is not an answer: the session memoises and holds nothing,
 * so the next attempt asks again, and the matcher reports `needs-review`
 * rather than a pass or a fail. Every other error still fails the test.
 */
export class DeciderError extends JevyError {}
