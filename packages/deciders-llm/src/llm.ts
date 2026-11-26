import { ConfigError, DeciderError } from "@jevyjs/core";
import type {
  Answer,
  Decider,
  DecisionState,
  LlmAdapter,
  Question,
} from "@jevyjs/core";
import { renderPrompt } from "./prompt.js";
import { readReply } from "./reply.js";
import { askedQuestions, schemaFor } from "./schema.js";

/** Attempts per decision when none is given: one call and one retry. */
export const DEFAULT_ATTEMPTS = 2;

/**
 * The most attempts a decider takes. Each one is a billed call that may wait
 * the whole timeout, so a larger number is far more likely a typo than a
 * plan; transport retries belong to the adapter.
 */
export const MAX_ATTEMPTS = 10;

/** Attempts named in the error message; the rest are counted. */
const LISTED_ATTEMPTS = 3;

/** The bound on each attempt when none is given: 60 seconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** `setTimeout` fires at once for a delay above this, so it is refused. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface LlmDeciderOptions {
  /** The user's completion function. Read its key when called, not before. */
  readonly adapter: LlmAdapter;
  /** A pinned model id. It is part of the decider id and the cache key. */
  readonly model: string;
  /** Calls per decision, the first included. A whole number from 1 to 10. */
  readonly attempts?: number;
  /** The bound on each call, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * The cache identity of an LLM decider: `llm:` and the model, so
 * `"provider/model-id"` is `"llm:provider/model-id"`, as §5.1 documents.
 * A session refuses a decider whose id differs from its own, so the matcher
 * uses this in replay, where no decider is built.
 */
export function llmDeciderId(model: string): string {
  assertModel(model);
  return `llm:${model}`;
}

/**
 * A decider that asks any model through the user's `LlmAdapter`.
 *
 * Each decision is one call with a prompt (`renderPrompt`) and a JSON schema
 * (`answerSchema`) whose enums hold the allowed values and an abstain id.
 * The reply is checked strictly (`readReply`) before anything reaches the
 * gate. A call that throws, times out or returns an invalid reply is asked
 * again, up to `attempts`; then the decision rejects with `DeciderError`,
 * which the matcher reports as `needs-review` and the session neither
 * memoises nor stores. Backoff and transport retries are the adapter's job.
 *
 * The timeout bounds the wait, not the call. `complete(prompt, jsonSchema)`
 * takes no abort signal, so a call that times out is abandoned, not
 * cancelled: it may still finish and be billed. Its late result is ignored.
 * An adapter that can cancel should apply its own timeout below this one.
 *
 * The error message names the decider and the first attempts' problems. It never
 * repeats the prompt, the reply or the adapter's error text, any of which can
 * hold page text or a key, and it carries no `cause` for the same reason.
 *
 * Call it through `callDecider`, which redacts and prunes the state first.
 */
export function llmDecider(options: LlmDeciderOptions): Decider {
  const settings = readOptions(options);
  const id = llmDeciderId(settings.model);
  return {
    id,
    model: settings.model,
    decide: (state, questions) => decide(settings, id, state, questions),
  };
}

interface Settings {
  readonly adapter: LlmAdapter;
  readonly model: string;
  readonly attempts: number;
  readonly timeoutMs: number;
}

async function decide(
  settings: Settings,
  id: string,
  state: DecisionState,
  questions: Readonly<Record<string, Question>>,
): Promise<Readonly<Record<string, Answer>>> {
  // Both throw before any call: a bad question or tree is the caller's
  // error, not the model's, and asking again would not fix it.
  const asked = askedQuestions(questions);
  const prompt = renderPrompt(state, asked);
  const schema = schemaFor(asked);
  const problems: string[] = [];
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    const outcome = await attemptOnce(settings, prompt, schema);
    if (outcome.ok) {
      const read = readReply(outcome.reply, asked);
      if (read.ok) return read.answers;
      problems.push(read.problem);
    } else {
      problems.push(outcome.problem);
    }
  }
  throw new DeciderError(failureMessage(id, problems));
}

type Outcome =
  | { readonly ok: true; readonly reply: unknown }
  | { readonly ok: false; readonly problem: string };

/**
 * One call, raced against the timeout. A synchronous throw counts as a
 * failed call. `Promise.race` keeps a handler on the abandoned call, so its
 * late rejection is not an unhandled one.
 */
async function attemptOnce(
  settings: Settings,
  prompt: string,
  schema: object,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = new Promise<unknown>((resolve) => {
    resolve(settings.adapter.complete(prompt, schema));
  }).then(
    (reply): Outcome => ({ ok: true, reply }),
    (error: unknown): Outcome => ({ ok: false, problem: threw(error) }),
  );
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        problem: `the adapter did not answer within ${String(settings.timeoutMs)} ms`,
      });
    }, settings.timeoutMs);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Says that the adapter threw, and the error's class when it is a plain
 * identifier (`TypeError`, `APIConnectionError`), which helps without
 * carrying text. The message itself is never read.
 */
function threw(error: unknown): string {
  const name = errorClass(error);
  if (name === undefined) return "the adapter threw";
  return `the adapter threw ${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`;
}

/** The class name of a thrown `Error`, or undefined. Never throws itself. */
function errorClass(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const name: unknown = error.constructor.name;
    return typeof name === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names the first `LISTED_ATTEMPTS` problems and counts the rest, so the
 * message stays one readable line however many attempts were made.
 */
function failureMessage(id: string, problems: readonly string[]): string {
  const count = problems.length;
  const named = problems
    .slice(0, LISTED_ATTEMPTS)
    .map((problem, index) => `attempt ${String(index + 1)}: ${problem}`);
  const rest = count - named.length;
  const listed = [
    ...named,
    ...(rest > 0 ? [`and ${String(rest)} more`] : []),
  ].join("; ");
  return `The ${id} decider gave no valid answer after ${String(count)} ${count === 1 ? "attempt" : "attempts"} (${listed})`;
}

function readOptions(options: LlmDeciderOptions): Settings {
  const adapter: unknown = options.adapter;
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    typeof (adapter as Partial<LlmAdapter>).complete !== "function"
  ) {
    throw new ConfigError(
      "llmDecider needs an adapter with a complete(prompt, jsonSchema) function",
    );
  }
  assertModel(options.model);
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > MAX_ATTEMPTS
  ) {
    throw new ConfigError(
      `llmDecider attempts must be a whole number from 1 to ${String(MAX_ATTEMPTS)}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new ConfigError(
      `llmDecider timeoutMs must be a number of milliseconds above 0 and at most ${String(MAX_TIMEOUT_MS)}`,
    );
  }
  return {
    adapter: options.adapter,
    model: options.model,
    attempts,
    timeoutMs,
  };
}

function assertModel(model: unknown): void {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ConfigError("An LLM decider needs a non-empty, pinned model id");
  }
}
