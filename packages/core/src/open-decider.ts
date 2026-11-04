import type {
  CacheMode,
  DeciderSelection,
  ResolvedJevyConfig,
} from "./config.js";
import { selectDecider } from "./config.js";
import type { Decider } from "./decider.js";
import { ConfigError, DeciderTransportError } from "./errors.js";

export interface DeciderFactories {
  readonly jev?: (
    selection: Extract<DeciderSelection, { id: "jev" }>,
  ) => Decider | Promise<Decider>;
  readonly kev?: (
    selection: Extract<DeciderSelection, { id: "kev" }>,
  ) => Decider | Promise<Decider>;
  readonly llm?: (
    selection: Extract<DeciderSelection, { id: "llm" }>,
  ) => Decider | Promise<Decider>;
}

export interface OpenDeciderOptions {
  readonly override?: string;
  /**
   * When `replay`, the matching factory is not called. The returned decider
   * refuses `decide` and no network client is constructed.
   */
  readonly mode?: CacheMode;
  readonly factories?: DeciderFactories;
}

/**
 * Turn a loaded config into a Decider.
 * There is no default: Jev is used only when config or `override` says so.
 * Replay does not call a factory, so a hosted client is never constructed.
 */
export async function openDecider(
  config: ResolvedJevyConfig,
  options?: OpenDeciderOptions,
): Promise<Decider> {
  const selection = selectDecider(config, options?.override);
  if (options?.mode === "replay") return replayDecider(selection);
  const factories = options?.factories;
  switch (selection.id) {
    case "jev": {
      const create = factories?.jev;
      if (create === undefined) {
        throw missingFactory("jev");
      }
      return create(selection);
    }
    case "kev": {
      const create = factories?.kev;
      if (create === undefined) {
        throw missingFactory("kev");
      }
      return create(selection);
    }
    case "llm": {
      const create = factories?.llm;
      if (create === undefined) {
        throw missingFactory("llm");
      }
      return create(selection);
    }
    default:
      throw new ConfigError("Unknown decider");
  }
}

function replayDecider(selection: DeciderSelection): Decider {
  return {
    id: selection.id,
    model: selection.model,
    decide() {
      return Promise.reject(
        new DeciderTransportError(
          "Replay mode does not call a decider or construct a network client.",
          { retryable: false },
        ),
      );
    },
  };
}

function missingFactory(id: DeciderSelection["id"]): ConfigError {
  return new ConfigError(
    `No factory for decider "${id}". Install @jevyjs/deciders-${id} and pass it to openDecider.`,
  );
}
