import {
  ConfigError,
  DeciderTransportError,
  JEV_ALLOWED_BASE_URLS,
  QuestionError,
  answerFromSignals,
  decisionStatePayload,
  errorText,
  isMovingJevAlias,
  prepareWireQuestions,
  redactSecrets,
  retryWithBackoff,
  retryableStatus,
  statusCode,
  systemOneQuestions,
  type Answer,
  type DecisionState,
  type Decider,
  type DeciderSelection,
  type PreparedWireQuestion,
} from "@jevyjs/core";

/** Pinned Vercel AI SDK provider. Direct TypeSafe calls, not a gateway resale. */
export const TYPESAFE_PROVIDER_PACKAGE = "@ai-sdk/typesafe-ai";
export const TYPESAFE_PROVIDER_VERSION = "3.0.33";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BASE_DELAY_MS = 200;

export interface JevDeciderOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly allowMovingAlias?: boolean;
  /** Defaults to `process.env` at call time, not at construction. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Sdk {
  experimental_decide: (options: {
    readonly model: unknown;
    readonly state: unknown;
    readonly questions: ReturnType<typeof systemOneQuestions>;
    readonly maxRetries: number;
    readonly abortSignal: AbortSignal;
  }) => Promise<unknown>;
  createTypeSafeAi: (options: {
    readonly apiKey: string;
    readonly baseURL: string;
    readonly fetch?: typeof fetch;
  }) => {
    decisionModel: (modelId: string) => unknown;
  };
}

/**
 * Jev decider. The TypeSafe client is created inside `decide`, after the key
 * is read from `TYPESAFE_API_KEY` (or `apiKeyEnv`). Construction does not
 * open a connection and does not read the key.
 */
export function jevDecider(options: JevDeciderOptions): Decider {
  const apiKeyEnv = options.apiKeyEnv ?? "TYPESAFE_API_KEY";
  const baseURL = providerBaseUrl(options.baseUrl);
  assertModel(options.model, options.allowMovingAlias ?? false);
  return {
    id: "jev",
    model: options.model,
    async decide(state, questions) {
      const prepared = prepareWireQuestions(questions);
      const key = readKey(apiKeyEnv, options.env ?? process.env);
      return retryWithBackoff(
        (signal) => askJev(options, baseURL, key, state, prepared, signal),
        {
          ...(options.attempts !== undefined
            ? { attempts: options.attempts }
            : { attempts: DEFAULT_ATTEMPTS }),
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : { timeoutMs: DEFAULT_TIMEOUT_MS }),
          ...(options.baseDelayMs !== undefined
            ? { baseDelayMs: options.baseDelayMs }
            : { baseDelayMs: DEFAULT_BASE_DELAY_MS }),
          ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        },
      );
    },
  };
}

export function jevDeciderFromSelection(
  selection: Extract<DeciderSelection, { id: "jev" }>,
  extra?: Omit<
    JevDeciderOptions,
    "model" | "baseUrl" | "apiKeyEnv" | "allowMovingAlias"
  >,
): Decider {
  return jevDecider({
    model: selection.model,
    baseUrl: selection.baseUrl,
    apiKeyEnv: selection.apiKeyEnv,
    allowMovingAlias: selection.allowMovingAlias,
    ...extra,
  });
}

/**
 * Map an allow-listed Jev base onto the AI SDK provider base.
 * The provider posts to `{baseURL}/systemone`. The allow-list entries are
 * the official SDK bases, which use `{base}/v1/systemone`.
 */
export function providerBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("Jev base URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("Jev base URL must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("Jev base URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("Jev base URL must not contain a query or hash");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const normalised = `${url.origin}${path}`;
  if (!JEV_ALLOWED_BASE_URLS.includes(normalised)) {
    throw new ConfigError(
      `Jev base URL is not on the allow-list (${JEV_ALLOWED_BASE_URLS.join(", ")}). Look-alike hosts are rejected.`,
    );
  }
  return `${normalised}/v1`;
}

function assertModel(model: string, allowMovingAlias: boolean): void {
  if (allowMovingAlias || !isMovingJevAlias(model)) return;
  throw new ConfigError(
    `Jev model "${model}" is a moving alias. Pin a model such as jev-1.14.0, or set allowMovingAlias.`,
  );
}

function readKey(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeciderTransportError(
      `${name} is not set. Jev is opt-in: the call goes to TypeSafe with your own key, and Jevy does not proxy it.`,
      { retryable: false },
    );
  }
  return value;
}

async function askJev(
  options: JevDeciderOptions,
  baseURL: string,
  key: string,
  state: DecisionState,
  prepared: Readonly<Record<string, PreparedWireQuestion>>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, Answer>>> {
  let sdk: Sdk;
  try {
    sdk = await loadSdk();
  } catch (error: unknown) {
    throw new DeciderTransportError(
      redactSecrets(
        `Could not load the TypeSafe AI SDK provider. ${errorText(error)}`,
        [key],
      ),
      { retryable: true },
    );
  }
  const provider = sdk.createTypeSafeAi({
    apiKey: key,
    baseURL,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  try {
    const result: unknown = await sdk.experimental_decide({
      model: provider.decisionModel(options.model),
      state: decisionStatePayload(state),
      questions: systemOneQuestions(prepared),
      maxRetries: 0,
      abortSignal: signal,
    });
    return mapJevResult(
      result,
      prepared,
      options.model,
      options.allowMovingAlias ?? false,
      key,
    );
  } catch (error: unknown) {
    if (
      error instanceof DeciderTransportError ||
      error instanceof QuestionError
    ) {
      throw error;
    }
    if (error instanceof ConfigError) throw error;
    const status = statusCode(error);
    const retryable = status === undefined || retryableStatus(status);
    const detail =
      status === undefined ? errorText(error) : `HTTP ${String(status)}`;
    throw new DeciderTransportError(
      redactSecrets(`Jev request failed (${detail}).`, [key]),
      { retryable },
    );
  }
}

function mapJevResult(
  result: unknown,
  prepared: Readonly<Record<string, PreparedWireQuestion>>,
  requestedModel: string,
  allowMovingAlias: boolean,
  key: string,
): Readonly<Record<string, Answer>> {
  if (!isRecord(result)) {
    throw new DeciderTransportError(
      redactSecrets("Jev returned a response that was not an object.", [key]),
      { retryable: true },
    );
  }
  assertResponseModel(result["response"], requestedModel, allowMovingAlias);
  const confidence = readConfidence(result["providerMetadata"]);
  const answers = result["answers"];
  if (!isRecord(answers)) {
    throw new DeciderTransportError(
      redactSecrets("Jev returned no answers.", [key]),
      { retryable: true },
    );
  }
  const mapped: Record<string, Answer> = {};
  for (const name of Object.keys(prepared)) {
    const wire = prepared[name];
    const raw = answers[name];
    if (wire === undefined || !isRecord(raw) || raw["type"] !== "choice") {
      throw new DeciderTransportError(
        redactSecrets(`Jev returned no choice for "${name}".`, [key]),
        { retryable: true },
      );
    }
    const picked = raw["choice"];
    if (typeof picked !== "string") {
      throw new DeciderTransportError(
        redactSecrets(`Jev returned an unreadable choice for "${name}".`, [
          key,
        ]),
        { retryable: true },
      );
    }
    try {
      mapped[name] = answerFromSignals(
        wire,
        picked,
        readProbabilities(raw["probabilities"]),
        confidence[name],
      );
    } catch (error: unknown) {
      if (error instanceof QuestionError) {
        throw new DeciderTransportError(redactSecrets(error.message, [key]), {
          retryable: true,
        });
      }
      throw error;
    }
  }
  return mapped;
}

function assertResponseModel(
  response: unknown,
  requestedModel: string,
  allowMovingAlias: boolean,
): void {
  if (allowMovingAlias || !isRecord(response)) return;
  const modelId = response["modelId"];
  if (typeof modelId !== "string" || modelId.length === 0) return;
  if (modelId !== requestedModel) {
    throw new DeciderTransportError(
      `Jev answered as "${modelId}" but the pin is "${requestedModel}". The answer was not used.`,
      { retryable: false },
    );
  }
}

function readConfidence(metadata: unknown): Readonly<Record<string, number>> {
  if (!isRecord(metadata)) return {};
  const typesafe = metadata["typesafe"];
  if (!isRecord(typesafe)) return {};
  const confidence = typesafe["confidence"];
  if (!isRecord(confidence)) return {};
  const out: Record<string, number> = {};
  for (const name of Object.keys(confidence)) {
    const value = confidence[name];
    if (typeof value === "number") out[name] = value;
  }
  return out;
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

async function loadSdk(): Promise<Sdk> {
  const [ai, typesafe] = await Promise.all([
    import("ai"),
    import("@ai-sdk/typesafe-ai"),
  ]);
  return {
    experimental_decide: ai.experimental_decide as Sdk["experimental_decide"],
    createTypeSafeAi: typesafe.createTypeSafeAi,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
