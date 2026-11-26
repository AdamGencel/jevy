/**
 * A time limit that holds whatever the work does.
 *
 * Claude Code cancels a hook that runs past its `timeout` and then carries
 * on as if the hook had allowed the action. So a hook that means to block
 * has to answer before that, even when a file read or a child process it is
 * waiting for never comes back. The work is raced against a timer and is
 * not waited for once the timer has won.
 */

export type Raced<T> =
  | { readonly inTime: true; readonly value: T }
  /** The time ran out. The work may still be running; nobody waits for it. */
  | { readonly inTime: false };

/**
 * Run `work` and answer within `ms` milliseconds. When the time is up the
 * signal handed to `work` aborts, so that what can be stopped (a running
 * check) is stopped, and the answer is `inTime: false` at once.
 *
 * Rejects only when `work` fails in time. A failure that comes later is
 * swallowed: the race has already been answered, and an unhandled rejection
 * would end the process with exit code 1, which to Claude Code is "carry
 * on".
 */
export async function within<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Raced<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ inTime: false });
    }, ms);
  });
  try {
    const done = work(controller.signal).then((value): Raced<T> => ({
      inTime: true,
      value,
    }));
    // The race stays subscribed to `done`, which is what handles a late
    // rejection.
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Limits above this do not fit the 32-bit milliseconds `setTimeout` takes. */
export const MAX_SECONDS = 2_000_000;

/** `value` as a number of seconds above 0, or null when it is not one. */
export function parseSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS
    ? seconds
    : null;
}
