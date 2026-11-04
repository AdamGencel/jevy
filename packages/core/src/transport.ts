import { DeciderTransportError } from "./errors.js";

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  readonly attempts?: number;
  /** Per-attempt deadline in milliseconds. Default 20_000. */
  readonly timeoutMs?: number;
  /** First backoff delay. Later delays double. Default 200. */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BASE_DELAY_MS = 200;

/**
 * Run `operation` until it returns or a failure is not retryable.
 * Each attempt gets its own timeout. Backoff runs only between attempts.
 */
export async function retryWithBackoff<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options?.sleep ?? delay;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new DeciderTransportError("Retry attempts must be an integer >= 1");
  }
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await operation(signal, attempt);
    } catch (error: unknown) {
      const failure = signal.aborted
        ? new DeciderTransportError(`Timed out after ${String(timeoutMs)}ms.`, {
            retryable: true,
          })
        : error;
      last = failure;
      const retryable =
        failure instanceof DeciderTransportError && failure.retryable;
      if (!retryable || attempt === attempts) throw failure;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/** Replace every secret with `[REDACTED]`. Secrets are never logged. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function retryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 529
  );
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "request failed";
}

/** True when the local socket never accepted the connection. */
export function isHostUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  if (isCodeRecord(cause)) {
    return (
      cause.code === "ECONNREFUSED" ||
      cause.code === "ENOTFOUND" ||
      cause.code === "EAI_AGAIN" ||
      cause.code === "ECONNRESET"
    );
  }
  return /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(error.message);
}

export function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const status: unknown = error.statusCode;
  return typeof status === "number" ? status : undefined;
}

function isCodeRecord(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
