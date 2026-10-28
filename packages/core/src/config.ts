import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { LlmAdapter } from "./decider.js";
import { ConfigError } from "./errors.js";
import { isRecord } from "./guards.js";
import { redactText } from "./redact.js";
import type { RedactRule } from "./redact.js";
import {
  DEFAULT_NORMALISE,
  resolveNormalise,
  type NormaliseBuiltin,
  type NormaliseOptions,
  type NormaliseOverrides,
  type NormaliseReplacement,
} from "./snapshot.js";
import {
  assertThresholds,
  DEFAULT_THRESHOLDS,
  type Thresholds,
} from "./verdict.js";

export const CONFIG_FILENAMES = [
  "jevy.config.ts",
  "jevy.config.mts",
  "jevy.config.js",
  "jevy.config.mjs",
] as const;

export type DeciderId = "jev" | "kev" | "llm";

export type CacheMode = "replay" | "replay-or-query" | "record";

export type NeedsReviewAction = "warn" | "fail";

export const DEFAULT_JEV_MODEL = "jev-1.14.0";
export const DEFAULT_KEV_MODEL = "kev-4b@v1.0";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_KEV_BASE_URL = "http://127.0.0.1:8009";
export const DEFAULT_JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const DEFAULT_CACHE_DIR = ".jevy/decisions";
export const DEFAULT_MAIN_BRANCH = "main";

/**
 * Hosts a Jev client may call. The official API, OpenRouter's System One
 * base (the SDK appends `/v1/systemone`), and Vercel AI Gateway's
 * TypeSafe-compatible base. Anything else is rejected. Kev is separate:
 * its URL is user-declared.
 */
export const JEV_ALLOWED_BASE_URLS: readonly string[] = [
  DEFAULT_JEV_BASE_URL,
  "https://openrouter.ai/api",
  "https://ai-gateway.vercel.sh/typesafe",
];

export const MOVING_JEV_ALIASES: readonly string[] = [
  "jev-latest",
  "jev-preview",
];

const DECIDER_IDS: readonly DeciderId[] = ["jev", "kev", "llm"];
const CACHE_MODES: readonly CacheMode[] = [
  "replay",
  "replay-or-query",
  "record",
];
const REVIEW_ACTIONS: readonly NeedsReviewAction[] = ["warn", "fail"];
const NORMALISE_BUILTINS: readonly NormaliseBuiltin[] = [
  "uuid",
  "timestamp",
  "relative-time",
  "long-digits",
];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MAINNET_CHAIN_IDS = new Map<number, string>([
  [1, "Ethereum"],
  [10, "Optimism"],
  [56, "BNB Smart Chain"],
  [137, "Polygon"],
  [324, "zkSync"],
  [8453, "Base"],
  [42161, "Arbitrum One"],
  [43114, "Avalanche"],
]);

export interface DeciderChoice {
  readonly use: DeciderId;
  readonly model?: string;
  readonly fallback: readonly DeciderId[];
}

export interface JevDeciderConfig {
  readonly apiKeyEnv?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly allowMovingAlias?: boolean;
}

export interface KevDeciderConfig {
  readonly baseUrl?: string;
  readonly model?: string;
}

export interface LlmDeciderConfig {
  readonly adapter: LlmAdapter;
  readonly model?: string;
}

export interface Web3Config {
  readonly driver?: "mock" | "extension";
  readonly chain?:
    | { readonly id: number; readonly rpcUrlEnv: string }
    | { readonly fork: { readonly rpcUrlEnv: string } };
  readonly account?: { readonly privateKeyEnv: string };
  readonly policy?: string;
  readonly allowMainnetSigning?: boolean;
}

export interface JevyConfig {
  readonly decider?:
    | DeciderId
    | (Omit<DeciderChoice, "fallback"> & {
        readonly fallback?: readonly DeciderId[];
      });
  readonly deciders?: {
    readonly jev?: JevDeciderConfig;
    readonly kev?: KevDeciderConfig;
    readonly llm?: LlmDeciderConfig;
  };
  readonly thresholds?: { readonly pass?: number; readonly fail?: number };
  readonly cache?: {
    readonly dir?: string;
    readonly mode?: CacheMode;
  };
  readonly ci?: {
    readonly needsReview?: {
      readonly pr?: NeedsReviewAction;
      readonly main?: NeedsReviewAction;
    };
    readonly mainBranch?: string;
  };
  readonly redact?: readonly RedactRule[];
  readonly normalise?: NormaliseOverrides;
  readonly web3?: Web3Config;
}

export interface ResolvedJevDecider {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly allowMovingAlias: boolean;
}

export interface ResolvedKevDecider {
  readonly model: string;
  readonly baseUrl: string;
}

export interface ResolvedLlmDecider {
  readonly adapter: LlmAdapter;
  readonly model: string;
}

export interface ResolvedWeb3 {
  readonly driver: "mock" | "extension";
  readonly chain:
    | { readonly id: number; readonly rpcUrlEnv: string }
    | { readonly fork: { readonly rpcUrlEnv: string } }
    | null;
  readonly account: { readonly privateKeyEnv: string } | null;
  readonly policy: string | null;
  readonly allowMainnetSigning: boolean;
}

export interface ResolvedJevyConfig {
  readonly decider: DeciderChoice | null;
  readonly deciders: {
    readonly jev: ResolvedJevDecider;
    readonly kev: ResolvedKevDecider;
    readonly llm: ResolvedLlmDecider | null;
  };
  readonly thresholds: Thresholds;
  readonly cache: { readonly dir: string; readonly mode: CacheMode };
  readonly ci: {
    readonly needsReview: {
      readonly pr: NeedsReviewAction;
      readonly main: NeedsReviewAction;
    };
    readonly mainBranch: string;
  };
  readonly redact: readonly RedactRule[];
  readonly normalise: NormaliseOptions;
  readonly web3: ResolvedWeb3 | null;
  readonly warnings: readonly string[];
}

export type DeciderSelection =
  | {
      readonly id: "jev";
      readonly model: string;
      readonly source: "project" | "override";
      readonly fallback: readonly DeciderId[];
      readonly baseUrl: string;
      readonly apiKeyEnv: string;
      readonly allowMovingAlias: boolean;
    }
  | {
      readonly id: "kev";
      readonly model: string;
      readonly source: "project" | "override";
      readonly fallback: readonly DeciderId[];
      readonly baseUrl: string;
    }
  | {
      readonly id: "llm";
      readonly model: string;
      readonly source: "project" | "override";
      readonly fallback: readonly DeciderId[];
      readonly adapter: LlmAdapter;
    };

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly path?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Identity helper so `jevy.config.ts` is type-checked. Validation runs at load. */
export function defineConfig(config: JevyConfig): JevyConfig {
  return config;
}

export function parseConfig(
  input: unknown,
  options?: { readonly env?: Readonly<Record<string, string | undefined>> },
): ResolvedJevyConfig {
  if (!isRecord(input)) {
    throw new ConfigError("Config must be an object");
  }
  rejectUnknown(input, [
    "decider",
    "deciders",
    "thresholds",
    "cache",
    "ci",
    "redact",
    "normalise",
    "web3",
  ]);

  const deciders = readDeciders(input["deciders"]);
  const decider = readDeciderChoice(input["decider"], deciders);
  const thresholds = readThresholds(input["thresholds"]);
  const cache = readCache(input["cache"], options?.env ?? process.env);
  const ci = readCi(input["ci"]);
  const redact = readRedactRules(input["redact"]);
  const normalise = readNormalise(input["normalise"]);
  const web3Result = readWeb3(input["web3"]);

  const resolved: ResolvedJevyConfig = {
    decider,
    deciders,
    thresholds,
    cache,
    ci,
    redact,
    normalise,
    web3: web3Result.web3,
    warnings: web3Result.warnings,
  };
  assertChoiceAllowed(resolved);
  return resolved;
}

/**
 * Load `jevy.config.ts` (or `.mts`, `.js`, `.mjs`) from `cwd`.
 * The file is executed. A missing file is an error: there is no implicit
 * default config, because a hosted decider must be chosen explicitly.
 */
export async function loadConfig(
  options?: LoadConfigOptions,
): Promise<ResolvedJevyConfig> {
  const cwd = options?.cwd ?? process.cwd();
  const file = resolveConfigFile(cwd, options?.path);
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(file).href);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ConfigError(`Could not load ${file}. ${detail}`);
  }
  if (!isRecord(imported)) {
    throw new ConfigError(`${file} did not export a config object`);
  }
  const exported: unknown = imported["default"];
  if (typeof exported === "function") {
    throw new ConfigError(
      `${file} default-exports a function. Call defineConfig({ ... }) and export the result.`,
    );
  }
  if (exported === undefined) {
    throw new ConfigError(`${file} must default-export the config object`);
  }
  if (options?.env === undefined) return parseConfig(exported);
  return parseConfig(exported, { env: options.env });
}

/**
 * Resolve the decider for a project, or for one test when `override` is set.
 * `decider: "kev"` in config and `selectDecider(config, "kev")` are the two
 * one-line switches. An override does not reuse the project's model pin or
 * fallback list. No network call is made.
 */
export function selectDecider(
  config: ResolvedJevyConfig,
  override?: string,
): DeciderSelection {
  if (override !== undefined && override.trim().length === 0) {
    throw new ConfigError("Decider override must be a non-empty id");
  }
  const source = override === undefined ? "project" : "override";
  const id = override ?? config.decider?.use;
  if (id === undefined) {
    throw new ConfigError(
      'No decider selected. Set decider: "kev" (or "jev" or "llm") in jevy.config.ts, or pass a per-test override.',
    );
  }
  if (!isDeciderId(id)) {
    throw new ConfigError(
      `Unknown decider "${id}". Expected "jev", "kev", or "llm".`,
    );
  }
  const project = config.decider;
  const modelOverride =
    project !== null && project.use === id ? project.model : undefined;
  const fallback = source === "project" ? (project?.fallback ?? []) : [];

  if (id === "jev") {
    const model = modelOverride ?? config.deciders.jev.model;
    assertJevModel(model, config.deciders.jev.allowMovingAlias, "decider");
    return {
      id,
      model,
      source,
      fallback,
      baseUrl: config.deciders.jev.baseUrl,
      apiKeyEnv: config.deciders.jev.apiKeyEnv,
      allowMovingAlias: config.deciders.jev.allowMovingAlias,
    };
  }
  if (id === "kev") {
    return {
      id,
      model: modelOverride ?? config.deciders.kev.model,
      source,
      fallback,
      baseUrl: config.deciders.kev.baseUrl,
    };
  }
  const llm = config.deciders.llm;
  if (llm === null) {
    throw new ConfigError(
      "decider is llm, but deciders.llm.adapter is not configured",
    );
  }
  return {
    id,
    model: modelOverride ?? llm.model,
    source,
    fallback,
    adapter: llm.adapter,
  };
}

/** Redact rules and normalisation from a loaded config, for hash and prepare. */
export function snapshotOptionsFromConfig(config: ResolvedJevyConfig): {
  readonly redact: readonly RedactRule[];
  readonly normalise: NormaliseOptions;
} {
  return { redact: config.redact, normalise: config.normalise };
}

export function isMovingJevAlias(model: string): boolean {
  const leaf = model.split("/").pop() ?? model;
  const bare = leaf.startsWith("~") ? leaf.slice(1) : leaf;
  return MOVING_JEV_ALIASES.includes(bare);
}

function assertJevModel(
  model: string,
  allowMovingAlias: boolean,
  path: string,
): void {
  if (allowMovingAlias || !isMovingJevAlias(model)) return;
  throw new ConfigError(
    `${path} model "${model}" is a moving alias. Pin a model such as ${DEFAULT_JEV_MODEL}, or set deciders.jev.allowMovingAlias to true.`,
  );
}

function assertChoiceAllowed(config: ResolvedJevyConfig): void {
  if (config.decider === null) return;
  if (config.decider.use === "llm" && config.deciders.llm === null) {
    throw new ConfigError(
      "decider is llm, but deciders.llm.adapter is not configured",
    );
  }
  if (config.decider.use === "jev") {
    const model = config.decider.model ?? config.deciders.jev.model;
    assertJevModel(model, config.deciders.jev.allowMovingAlias, "decider");
  }
  for (const id of config.decider.fallback) {
    if (id === "llm" && config.deciders.llm === null) {
      throw new ConfigError(
        "decider.fallback includes llm, but deciders.llm.adapter is not configured",
      );
    }
  }
}

function readDeciderChoice(
  value: unknown,
  deciders: ResolvedJevyConfig["deciders"],
): DeciderChoice | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return { use: readDeciderId(value, "decider"), fallback: [] };
  }
  if (!isRecord(value)) {
    throw new ConfigError(
      'decider must be "jev", "kev", "llm", or { use, model?, fallback? }',
    );
  }
  rejectUnknown(value, ["use", "model", "fallback"], "decider");
  if (typeof value["use"] !== "string") {
    throw new ConfigError("decider.use is required");
  }
  const use = readDeciderId(value["use"], "decider.use");
  const model =
    value["model"] === undefined
      ? undefined
      : readPinnedModel(value["model"], "decider.model");
  const fallback = readFallback(value["fallback"], use);
  if (use === "llm" && deciders.llm === null) {
    throw new ConfigError(
      "decider.use is llm, but deciders.llm.adapter is not configured",
    );
  }
  if (model === undefined) return { use, fallback };
  return { use, model, fallback };
}

function readDeciders(value: unknown): ResolvedJevyConfig["deciders"] {
  if (value === undefined) {
    return { jev: defaultJev(), kev: defaultKev(), llm: null };
  }
  if (!isRecord(value)) throw new ConfigError("deciders must be an object");
  rejectUnknown(value, ["jev", "kev", "llm"], "deciders");
  return {
    jev: readJev(value["jev"]),
    kev: readKev(value["kev"]),
    llm: readLlm(value["llm"]),
  };
}

function defaultJev(): ResolvedJevDecider {
  return {
    model: DEFAULT_JEV_MODEL,
    baseUrl: DEFAULT_JEV_BASE_URL,
    apiKeyEnv: DEFAULT_JEV_API_KEY_ENV,
    allowMovingAlias: false,
  };
}

function defaultKev(): ResolvedKevDecider {
  return { model: DEFAULT_KEV_MODEL, baseUrl: DEFAULT_KEV_BASE_URL };
}

function readJev(value: unknown): ResolvedJevDecider {
  const base = defaultJev();
  if (value === undefined) return base;
  if (!isRecord(value)) throw new ConfigError("deciders.jev must be an object");
  rejectUnknown(
    value,
    ["apiKeyEnv", "model", "baseUrl", "allowMovingAlias"],
    "deciders.jev",
  );
  const model =
    value["model"] === undefined
      ? base.model
      : readPinnedModel(value["model"], "deciders.jev.model");
  const baseUrl =
    value["baseUrl"] === undefined
      ? base.baseUrl
      : readJevBaseUrl(value["baseUrl"]);
  const apiKeyEnv =
    value["apiKeyEnv"] === undefined
      ? base.apiKeyEnv
      : readEnvName(value["apiKeyEnv"], "deciders.jev.apiKeyEnv");
  const allowMovingAlias =
    value["allowMovingAlias"] === undefined
      ? false
      : readBoolean(value["allowMovingAlias"], "deciders.jev.allowMovingAlias");
  assertJevModel(model, allowMovingAlias, "deciders.jev.model");
  return { model, baseUrl, apiKeyEnv, allowMovingAlias };
}

function readKev(value: unknown): ResolvedKevDecider {
  const base = defaultKev();
  if (value === undefined) return base;
  if (!isRecord(value)) throw new ConfigError("deciders.kev must be an object");
  rejectUnknown(value, ["baseUrl", "model"], "deciders.kev");
  const model =
    value["model"] === undefined
      ? base.model
      : readPinnedModel(value["model"], "deciders.kev.model");
  const baseUrl =
    value["baseUrl"] === undefined
      ? base.baseUrl
      : readKevBaseUrl(value["baseUrl"]);
  return { model, baseUrl };
}

function readLlm(value: unknown): ResolvedLlmDecider | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new ConfigError("deciders.llm must be an object");
  rejectUnknown(value, ["adapter", "model"], "deciders.llm");
  if (value["adapter"] === undefined) {
    throw new ConfigError("deciders.llm.adapter is required");
  }
  const adapter = readAdapter(value["adapter"]);
  if (value["model"] === undefined) {
    throw new ConfigError(
      "deciders.llm.model is required so the model pin is explicit",
    );
  }
  const model = readPinnedModel(value["model"], "deciders.llm.model");
  return { adapter, model };
}

function readAdapter(value: unknown): LlmAdapter {
  if (!isRecord(value) || typeof value["complete"] !== "function") {
    throw new ConfigError(
      "deciders.llm.adapter must be an object with a complete() function",
    );
  }
  const method = value["complete"] as (
    this: object,
    prompt: string,
    jsonSchema: object,
  ) => unknown;
  const target = value;
  return {
    complete(prompt: string, jsonSchema: object): Promise<unknown> {
      return Promise.resolve(method.call(target, prompt, jsonSchema));
    },
  };
}

function readThresholds(value: unknown): Thresholds {
  if (value === undefined) return DEFAULT_THRESHOLDS;
  if (!isRecord(value)) throw new ConfigError("thresholds must be an object");
  rejectUnknown(value, ["pass", "fail"], "thresholds");
  const pass = readUnit(
    value["pass"] === undefined ? DEFAULT_THRESHOLDS.pass : value["pass"],
    "thresholds.pass",
  );
  const fail = readUnit(
    value["fail"] === undefined ? DEFAULT_THRESHOLDS.fail : value["fail"],
    "thresholds.fail",
  );
  const thresholds = { pass, fail };
  try {
    assertThresholds(thresholds);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "invalid thresholds";
    throw new ConfigError(message);
  }
  return thresholds;
}

function readCache(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedJevyConfig["cache"] {
  if (value === undefined) {
    return { dir: DEFAULT_CACHE_DIR, mode: cacheModeFromEnv(env) };
  }
  if (!isRecord(value)) throw new ConfigError("cache must be an object");
  if (Object.hasOwn(value, "store")) {
    throw new ConfigError(
      "cache.store is not available yet. An external decision-cache store arrives in M2. Use cache.dir until then.",
    );
  }
  rejectUnknown(value, ["dir", "mode"], "cache");
  const dir =
    value["dir"] === undefined
      ? DEFAULT_CACHE_DIR
      : readPlainString(value["dir"], "cache.dir");
  const mode =
    value["mode"] === undefined
      ? cacheModeFromEnv(env)
      : readEnum(value["mode"], CACHE_MODES, "cache.mode");
  return { dir, mode };
}

function cacheModeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CacheMode {
  const ci = env["CI"];
  if (ci === undefined || ci === "" || ci === "0" || ci === "false") {
    return "record";
  }
  return "replay";
}

function readCi(value: unknown): ResolvedJevyConfig["ci"] {
  const defaults: ResolvedJevyConfig["ci"] = {
    needsReview: { pr: "warn", main: "fail" },
    mainBranch: DEFAULT_MAIN_BRANCH,
  };
  if (value === undefined) return defaults;
  if (!isRecord(value)) throw new ConfigError("ci must be an object");
  rejectUnknown(value, ["needsReview", "mainBranch"], "ci");
  const mainBranch =
    value["mainBranch"] === undefined
      ? defaults.mainBranch
      : readPlainString(value["mainBranch"], "ci.mainBranch");
  const needsReview = readNeedsReview(
    value["needsReview"],
    defaults.needsReview,
  );
  return { needsReview, mainBranch };
}

function readNeedsReview(
  value: unknown,
  defaults: ResolvedJevyConfig["ci"]["needsReview"],
): ResolvedJevyConfig["ci"]["needsReview"] {
  if (value === undefined) return defaults;
  if (!isRecord(value))
    throw new ConfigError("ci.needsReview must be an object");
  rejectUnknown(value, ["pr", "main"], "ci.needsReview");
  return {
    pr:
      value["pr"] === undefined
        ? defaults.pr
        : readEnum(value["pr"], REVIEW_ACTIONS, "ci.needsReview.pr"),
    main:
      value["main"] === undefined
        ? defaults.main
        : readEnum(value["main"], REVIEW_ACTIONS, "ci.needsReview.main"),
  };
}

function readRedactRules(value: unknown): readonly RedactRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError("redact must be an array");
  return value.map((rule, index) =>
    readRedactRule(rule, `redact[${String(index)}]`),
  );
}

function readRedactRule(value: unknown, path: string): RedactRule {
  if (value instanceof RegExp) return value;
  if (!isRecord(value)) {
    throw new ConfigError(
      `${path} must be a RegExp, { pattern }, or { role, name? }`,
    );
  }
  const patternRule = Object.hasOwn(value, "pattern");
  const roleRule = Object.hasOwn(value, "role");
  if (patternRule === roleRule) {
    throw new ConfigError(
      `${path} must set either pattern or role, not both and not neither`,
    );
  }
  if (patternRule) {
    rejectUnknown(value, ["pattern", "replacement"], path);
    if (!(value["pattern"] instanceof RegExp)) {
      throw new ConfigError(`${path}.pattern must be a RegExp`);
    }
    const replacement =
      value["replacement"] === undefined
        ? undefined
        : readPlainString(value["replacement"], `${path}.replacement`);
    return replacement === undefined
      ? { pattern: value["pattern"] }
      : { pattern: value["pattern"], replacement };
  }
  rejectUnknown(value, ["role", "name", "replacement"], path);
  const role = readPlainString(value["role"], `${path}.role`);
  const name = readRuleName(value["name"], `${path}.name`);
  const replacement =
    value["replacement"] === undefined
      ? undefined
      : readPlainString(value["replacement"], `${path}.replacement`);
  return {
    role,
    ...(name !== undefined ? { name } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function readRuleName(
  value: unknown,
  path: string,
): string | RegExp | undefined {
  if (value === undefined) return undefined;
  if (value instanceof RegExp) return value;
  if (typeof value === "string" && value.length > 0) return value;
  throw new ConfigError(`${path} must be a string or a RegExp`);
}

function readNormalise(value: unknown): NormaliseOptions {
  if (value === undefined) return resolveNormalise(undefined);
  if (!isRecord(value)) throw new ConfigError("normalise must be an object");
  rejectUnknown(
    value,
    ["disable", "replace", "dropRoles", "unwrapUnnamedGeneric"],
    "normalise",
  );
  const disable =
    value["disable"] === undefined
      ? DEFAULT_NORMALISE.disable
      : readBuiltinList(value["disable"]);
  const replace =
    value["replace"] === undefined ? [] : readReplacements(value["replace"]);
  const dropRoles =
    value["dropRoles"] === undefined
      ? []
      : readStringList(value["dropRoles"], "normalise.dropRoles");
  const unwrapUnnamedGeneric =
    value["unwrapUnnamedGeneric"] === undefined
      ? DEFAULT_NORMALISE.unwrapUnnamedGeneric
      : readBoolean(
          value["unwrapUnnamedGeneric"],
          "normalise.unwrapUnnamedGeneric",
        );
  return resolveNormalise({
    disable,
    replace,
    dropRoles,
    unwrapUnnamedGeneric,
  });
}

function readBuiltinList(value: unknown): readonly NormaliseBuiltin[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("normalise.disable must be an array");
  }
  return value.map((entry) =>
    readEnum(entry, NORMALISE_BUILTINS, "normalise.disable"),
  );
}

function readReplacements(value: unknown): readonly NormaliseReplacement[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("normalise.replace must be an array");
  }
  return value.map((entry, index) => {
    const path = `normalise.replace[${String(index)}]`;
    if (!isRecord(entry)) throw new ConfigError(`${path} must be an object`);
    rejectUnknown(entry, ["pattern", "placeholder"], path);
    if (!(entry["pattern"] instanceof RegExp)) {
      throw new ConfigError(`${path}.pattern must be a RegExp`);
    }
    const placeholder = readPlainString(
      entry["placeholder"],
      `${path}.placeholder`,
    );
    return { pattern: entry["pattern"], placeholder };
  });
}

function readWeb3(value: unknown): {
  web3: ResolvedWeb3 | null;
  warnings: string[];
} {
  if (value === undefined) return { web3: null, warnings: [] };
  if (!isRecord(value)) throw new ConfigError("web3 must be an object");
  rejectUnknown(
    value,
    ["driver", "chain", "account", "policy", "allowMainnetSigning"],
    "web3",
  );
  const driver =
    value["driver"] === undefined
      ? "mock"
      : readEnum(
          value["driver"],
          ["mock", "extension"] as const,
          "web3.driver",
        );
  const chain = readChain(value["chain"]);
  const account = readAccount(value["account"]);
  const policy =
    value["policy"] === undefined
      ? null
      : readPlainString(value["policy"], "web3.policy");
  const allowMainnetSigning =
    value["allowMainnetSigning"] === undefined
      ? false
      : readBoolean(value["allowMainnetSigning"], "web3.allowMainnetSigning");
  const warnings: string[] = [];
  if (allowMainnetSigning) {
    warnings.push(
      "web3.allowMainnetSigning is true. Mainnet signing stays off unless a later milestone is explicitly configured to honour this flag.",
    );
  }
  if (chain !== null && "id" in chain) {
    const network = MAINNET_CHAIN_IDS.get(chain.id);
    if (network !== undefined && !allowMainnetSigning) {
      warnings.push(
        `web3.chain.id ${String(chain.id)} is ${network} mainnet. allowMainnetSigning is false, so the wallet pack refuses to sign or send on this chain.`,
      );
    }
  }
  return {
    web3: { driver, chain, account, policy, allowMainnetSigning },
    warnings,
  };
}

function readChain(value: unknown): ResolvedWeb3["chain"] {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new ConfigError("web3.chain must be an object");
  const fork = Object.hasOwn(value, "fork");
  const id = Object.hasOwn(value, "id");
  if (fork && id) {
    throw new ConfigError(
      "web3.chain must be either { id, rpcUrlEnv } or { fork }",
    );
  }
  if (fork) {
    rejectUnknown(value, ["fork"], "web3.chain");
    if (!isRecord(value["fork"])) {
      throw new ConfigError("web3.chain.fork must be an object");
    }
    rejectUnknown(value["fork"], ["rpcUrlEnv"], "web3.chain.fork");
    return {
      fork: {
        rpcUrlEnv: readEnvName(
          value["fork"]["rpcUrlEnv"],
          "web3.chain.fork.rpcUrlEnv",
        ),
      },
    };
  }
  rejectUnknown(value, ["id", "rpcUrlEnv"], "web3.chain");
  return {
    id: readChainId(value["id"]),
    rpcUrlEnv: readEnvName(value["rpcUrlEnv"], "web3.chain.rpcUrlEnv"),
  };
}

function readAccount(value: unknown): ResolvedWeb3["account"] {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new ConfigError("web3.account must be an object");
  rejectUnknown(value, ["privateKeyEnv"], "web3.account");
  return {
    privateKeyEnv: readEnvName(
      value["privateKeyEnv"],
      "web3.account.privateKeyEnv",
    ),
  };
}

function readFallback(value: unknown, use: DeciderId): readonly DeciderId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("decider.fallback must be an array of decider ids");
  }
  const fallback = value.map((entry) =>
    readDeciderId(entry, "decider.fallback"),
  );
  if (fallback.includes(use)) {
    throw new ConfigError(
      "decider.fallback must not include the selected decider",
    );
  }
  if (new Set(fallback).size !== fallback.length) {
    throw new ConfigError("decider.fallback contains a duplicate id");
  }
  return fallback;
}

function readDeciderId(value: unknown, path: string): DeciderId {
  if (typeof value !== "string" || !isDeciderId(value)) {
    throw new ConfigError(`${path} must be "jev", "kev", or "llm"`);
  }
  return value;
}

function isDeciderId(value: string): value is DeciderId {
  return (DECIDER_IDS as readonly string[]).includes(value);
}

function readPinnedModel(value: unknown, path: string): string {
  const model = readPlainString(value, path);
  if (/\s/.test(model)) {
    throw new ConfigError(`${path} must be a model id without whitespace`);
  }
  return model;
}

function readJevBaseUrl(value: unknown): string {
  const raw = readPlainString(value, "deciders.jev.baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("deciders.jev.baseUrl is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("deciders.jev.baseUrl must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("deciders.jev.baseUrl must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      "deciders.jev.baseUrl must not contain a query or hash",
    );
  }
  const normalised = normaliseBaseUrl(url);
  if (!JEV_ALLOWED_BASE_URLS.includes(normalised)) {
    throw new ConfigError(
      `deciders.jev.baseUrl is not on the allow-list (${JEV_ALLOWED_BASE_URLS.join(", ")}). Look-alike Jev hosts are rejected.`,
    );
  }
  return normalised;
}

function readKevBaseUrl(value: unknown): string {
  const raw = readPlainString(value, "deciders.kev.baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("deciders.kev.baseUrl is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("deciders.kev.baseUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("deciders.kev.baseUrl must not contain credentials");
  }
  if (url.hostname === "") {
    throw new ConfigError("deciders.kev.baseUrl is missing a host");
  }
  return normaliseBaseUrl(url);
}

function normaliseBaseUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function readEnvName(value: unknown, path: string): string {
  const name = readPlainString(value, path);
  if (!ENV_NAME.test(name)) {
    throw new ConfigError(
      `${path} must be an environment variable name, not the secret itself`,
    );
  }
  return name;
}

function readPlainString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  assertNoSecret(value, path);
  return value;
}

function assertNoSecret(value: string, path: string): void {
  if (redactText(value) !== collapseForCompare(value)) {
    throw new ConfigError(
      `${path} looks like it contains a secret or personal data. Read keys from environment variables such as TYPESAFE_API_KEY.`,
    );
  }
}

function collapseForCompare(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
}

function readUnit(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new ConfigError(`${path} must be a finite number from 0 to 1`);
  }
  return value;
}

function readChainId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError("web3.chain.id must be a positive integer");
  }
  return value;
}

function readStringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array`);
  return value.map((entry, index) =>
    readPlainString(entry, `${path}[${String(index)}]`),
  );
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !isOneOf(value, allowed)) {
    throw new ConfigError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function isOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
): value is T {
  for (const entry of allowed) {
    if (entry === value) return true;
  }
  return false;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path?: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const where = path === undefined ? "config" : path;
  throw new ConfigError(`${where} has unknown keys: ${unknown.join(", ")}`);
}

function resolveConfigFile(cwd: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    const file = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(file))
      throw new ConfigError(`Config file not found: ${file}`);
    return file;
  }
  for (const name of CONFIG_FILENAMES) {
    const file = resolve(cwd, name);
    if (existsSync(file)) return file;
  }
  throw new ConfigError(`No ${CONFIG_FILENAMES.join(", ")} found in ${cwd}`);
}
