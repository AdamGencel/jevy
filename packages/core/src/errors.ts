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

/** The decision cache could not be read, written, or replayed. */
export class CacheError extends JevyError {}

/**
 * Replay mode had no record, and the caller asked for an error
 * instead of `needs-review`. The decider is not called.
 */
export class CacheMissError extends CacheError {}

/**
 * The decider could not get an answer from its model.
 * This is a transport or protocol failure, never a pass or a fail.
 * `retryable` is true when another attempt might succeed.
 */
export class DeciderTransportError extends JevyError {
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options?: { readonly retryable?: boolean },
  ) {
    super(message);
    this.retryable = options?.retryable ?? false;
  }
}
