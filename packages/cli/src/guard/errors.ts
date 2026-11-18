/**
 * Errors raised by `jevy guard`. Both map to exit code 2: the guard could
 * not do its job, which is different from finding weakening (exit 1).
 *
 * `@jevyjs/cli` does not depend on `@jevyjs/core`, so these do not extend
 * `JevyError`; they follow the same pattern.
 */
export class GuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The command line is wrong: a missing or unknown flag, or a bad value. */
export class UsageError extends GuardError {}

/** A git command failed, for example because a ref does not exist. */
export class GitError extends GuardError {}
