import {
  ConfigError,
  DeciderTransportError,
  KEV_SNAPSHOT_TOKEN_BUDGET,
  QuestionError,
  answerFromSignals,
  decisionStatePayload,
  errorText,
  estimateSnapshotTokens,
  isHostUnreachable,
  prepareWireQuestions,
  redactSecrets,
  retryWithBackoff,
  retryableStatus,
  systemOneQuestions,
  type Answer,
  type DecisionState,
  type Decider,
  type DeciderSelection,
  type PreparedWireQuestion,
} from "@jevyjs/core";

/**
 * Name the local server accepts for whichever checkpoint it was started with.
 * `Decider.model` stays the pinned checkpoint, for example `kev-4b@v1.0`.
 */
export const KEV_REQUEST_MODEL = "kev-latest";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 200;
const LOCAL_KEY_ENV = "KEV_API_KEY";

export interface KevDeciderOptions {
  /** Checkpoint pin stored on the decider and in the cache key. */
  readonly model: string;
  readonly baseUrl: string;
  /**
   * Model field sent to the local server. Defaults to `kev-latest`, which is
   * what Kev's own server accepts for the checkpoint it loaded.
   */
  readonly requestModel?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Local Kev decider. Talks HTTP to a System One server on the machine
 * (Kev's own server by default, or another server that speaks the same API).
 * Nothing is constructed until `decide`. A missing server is a clear error.
 */
export function kevDecider(options: KevDeciderOptions): Decider {
  const baseUrl = normaliseBase(options.baseUrl);
  const requestModel = options.requestModel ?? KEV_REQUEST_MODEL;
  return {
    id: "kev",
    model: options.model,
    async decide(state, questions) {
      assertBudget(state);
      const prepared = prepareWireQuestions(questions);
      const localKey = readOptionalKey(options.env ?? process.env);
      return retryWithBackoff(
        (signal) =>
          askKev(
            options,
            baseUrl,
            requestModel,
            localKey,
            state,
            prepared,
            signal,
          ),
        {
          attempts: options.attempts ?? DEFAULT_ATTEMPTS,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
          ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        },
      );
    },
  };
}

export function kevDeciderFromSelection(
  selection: Extract<DeciderSelection, { id: "kev" }>,
  extra?: Omit<KevDeciderOptions, "model" | "baseUrl">,
): Decider {
  return kevDecider({
    model: selection.model,
    baseUrl: selection.baseUrl,
    ...extra,
  });
}

function assertBudget(state: DecisionState): void {
  const tokens = estimateSnapshotTokens(state.snapshot);
  if (tokens > KEV_SNAPSHOT_TOKEN_BUDGET) {
    throw new QuestionError(
      `Snapshot is about ${String(tokens)} tokens, over Kev's ${String(KEV_SNAPSHOT_TOKEN_BUDGET)}-token budget. callDecider prunes to that budget when the decider id is "kev".`,
    );
  }
}

function readOptionalKey(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[LOCAL_KEY_ENV];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

async function askKev(
  options: KevDeciderOptions,
  baseUrl: string,
  requestModel: string,
  localKey: string | undefined,
  state: DecisionState,
  prepared: Readonly<Record<string, PreparedWireQuestion>>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, Answer>>> {
  const secrets = localKey === undefined ? [] : [localKey];
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(localKey !== undefined
          ? { authorization: `Bearer ${localKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: requestModel,
        state: decisionStatePayload(state),
        questions: systemOneQuestions(prepared),
      }),
      signal,
    });
  } catch (error: unknown) {
    if (isHostUnreachable(error)) {
      throw new DeciderTransportError(downMessage(baseUrl, options.model), {
        retryable: true,
      });
    }
    throw new DeciderTransportError(
      redactSecrets(`Kev request failed. ${errorText(error)}`, secrets),
      { retryable: true },
    );
  }
  if (!response.ok) {
    throw new DeciderTransportError(
      redactSecrets(
        response.status === 401
          ? `Kev at ${baseUrl} rejected the request (HTTP 401). If the server was started with KEV_API_KEY, set that same variable.`
          : `Kev request failed (HTTP ${String(response.status)}).`,
        secrets,
      ),
      { retryable: retryableStatus(response.status) },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new DeciderTransportError(
      redactSecrets(
        `Kev returned unreadable JSON. ${errorText(error)}`,
        secrets,
      ),
      { retryable: true },
    );
  }
  try {
    return mapKevBody(body, prepared);
  } catch (error: unknown) {
    if (error instanceof DeciderTransportError) throw error;
    if (error instanceof QuestionError) {
      throw new DeciderTransportError(error.message, { retryable: true });
    }
    throw error;
  }
}

function mapKevBody(
  body: unknown,
  prepared: Readonly<Record<string, PreparedWireQuestion>>,
): Readonly<Record<string, Answer>> {
  if (!isRecord(body) || !isRecord(body["answers"])) {
    throw new DeciderTransportError("Kev returned no answers.", {
      retryable: true,
    });
  }
  const answers = body["answers"];
  const mapped: Record<string, Answer> = {};
  for (const name of Object.keys(prepared)) {
    const wire = prepared[name];
    const raw = answers[name];
    if (wire === undefined || !isRecord(raw) || raw["type"] !== "choice") {
      throw new DeciderTransportError(`Kev returned no choice for "${name}".`, {
        retryable: true,
      });
    }
    const picked = raw["choice"];
    if (typeof picked !== "string") {
      throw new DeciderTransportError(
        `Kev returned an unreadable choice for "${name}".`,
        { retryable: true },
      );
    }
    const confidence = raw["confidence"];
    mapped[name] = answerFromSignals(
      wire,
      picked,
      readProbabilities(raw["probabilities"]),
      typeof confidence === "number" ? confidence : null,
    );
  }
  return mapped;
}

function readProbabilities(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const name of Object.keys(value)) {
    const probability = value[name];
    if (typeof probability === "number") out[name] = probability;
  }
  return out;
}

function downMessage(baseUrl: string, model: string): string {
  let port = "8009";
  try {
    const url = new URL(baseUrl);
    if (url.port !== "") port = url.port;
  } catch {
    port = "8009";
  }
  if (port === "11434") {
    return `Kev is not running at ${baseUrl}. Start Ollama and set requestModel to the pulled tag.`;
  }
  const hub = /^kev-.+@.+$/.test(model) ? `jaredpalmer/${model}` : model;
  return `Kev is not running at ${baseUrl}. Start the laptop default for this pin with: uv run --extra serve python -m kev.serve --run ${hub} --port ${port}`;
}

function normaliseBase(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("Kev base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("Kev base URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("Kev base URL must not contain credentials");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
