import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_API_KEY_ENV,
  DEFAULT_JEV_MODEL,
  DEFAULT_KEV_BASE_URL,
  DEFAULT_KEV_MODEL,
  defineConfig,
  loadConfig,
  parseConfig,
  selectDecider,
  snapshotOptionsFromConfig,
} from "./config.js";
import { ConfigError } from "./errors.js";
import { hashSnapshot } from "./hash.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("config", () => {
  it("switches to Kev with one field, and again for a single test", () => {
    const defined = defineConfig({ decider: "kev" });
    expect(defined.decider).toBe("kev");

    const project = parseConfig({ decider: "kev" }, { env: {} });
    expect(selectDecider(project)).toEqual({
      id: "kev",
      model: DEFAULT_KEV_MODEL,
      source: "project",
      fallback: [],
      baseUrl: DEFAULT_KEV_BASE_URL,
    });

    const hosted = parseConfig(
      {
        decider: { use: "jev", model: DEFAULT_JEV_MODEL, fallback: ["kev"] },
      },
      { env: {} },
    );
    expect(selectDecider(hosted, "kev")).toEqual({
      id: "kev",
      model: DEFAULT_KEV_MODEL,
      source: "override",
      fallback: [],
      baseUrl: DEFAULT_KEV_BASE_URL,
    });
    const jev = selectDecider(hosted);
    expect(jev.id).toBe("jev");
    if (jev.id !== "jev") return;
    expect(jev.model).toBe(DEFAULT_JEV_MODEL);
    expect(jev.apiKeyEnv).toBe(DEFAULT_JEV_API_KEY_ENV);
    expect(jev.fallback).toEqual(["kev"]);
    expect(jev.allowMovingAlias).toBe(false);
  });

  it("does not read TYPESAFE_API_KEY into the config", () => {
    const previous = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "super-secret-value";
    try {
      const config = parseConfig({ decider: "jev" }, { env: {} });
      expect(JSON.stringify(config)).not.toContain("super-secret-value");
      expect(config.deciders.jev.apiKeyEnv).toBe("TYPESAFE_API_KEY");
    } finally {
      if (previous === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = previous;
    }
  });

  it("validates thresholds, aliases, hosts and unknown keys", () => {
    expect(() => parseConfig({ thresholds: { pass: 0.4, fail: 0.5 } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ thresholds: { pass: 0.4 } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(raw({ colour: "ink" }))).toThrow(/unknown keys/);
    expect(() =>
      parseConfig({
        decider: "jev",
        deciders: { jev: { model: "jev-latest" } },
      }),
    ).toThrow(/moving alias/);
    expect(() =>
      parseConfig({
        decider: "jev",
        deciders: { jev: { model: "~typesafe/jev-preview" } },
      }),
    ).toThrow(/moving alias/);
    const allowed = parseConfig({
      decider: "jev",
      deciders: { jev: { model: "jev-latest", allowMovingAlias: true } },
    });
    expect(selectDecider(allowed).model).toBe("jev-latest");

    expect(() =>
      parseConfig({
        deciders: { jev: { baseUrl: "https://jev.example/api" } },
      }),
    ).toThrow(/allow-list/);
    expect(() =>
      parseConfig({
        deciders: { jev: { baseUrl: "http://api.typesafe.ai" } },
      }),
    ).toThrow(ConfigError);
    expect(
      parseConfig({
        deciders: { jev: { baseUrl: "https://openrouter.ai/api/" } },
      }).deciders.jev.baseUrl,
    ).toBe("https://openrouter.ai/api");
    expect(
      parseConfig({
        deciders: { kev: { baseUrl: "http://127.0.0.1:8009/" } },
      }).deciders.kev.baseUrl,
    ).toBe("http://127.0.0.1:8009");
  });

  it("defaults cache mode from CI and accepts a decision store", () => {
    expect(parseConfig({}, { env: {} }).cache).toEqual({
      dir: ".jevy/decisions",
      mode: "record",
      store: null,
    });
    expect(parseConfig({}, { env: { CI: "true" } }).cache.mode).toBe("replay");
    expect(
      parseConfig(
        { cache: { mode: "replay-or-query" } },
        { env: { CI: "true" } },
      ).cache.mode,
    ).toBe("replay-or-query");
    expect(() => parseConfig(raw({ cache: { store: "later" } }))).toThrow(
      /cache\.dir/,
    );
    const store = {
      get(): Promise<null> {
        return Promise.resolve(null);
      },
      put(): Promise<void> {
        return Promise.resolve();
      },
      list(): Promise<readonly []> {
        return Promise.resolve([]);
      },
      touch(): Promise<void> {
        return Promise.resolve();
      },
      replaceAll(): Promise<void> {
        return Promise.resolve();
      },
      noteReferenced(): Promise<void> {
        return Promise.resolve();
      },
      referencedKeys(): Promise<ReadonlySet<string>> {
        return Promise.resolve(new Set());
      },
    };
    expect(parseConfig({ cache: { store } }).cache.store).toBe(store);
    expect(parseConfig({}).ci).toEqual({
      needsReview: { pr: "warn", main: "fail" },
      mainBranch: "main",
    });
  });

  it("warns on mainnet chain ids and keeps signing off", () => {
    const config = parseConfig({
      web3: {
        chain: { id: 1, rpcUrlEnv: "ETH_RPC_URL" },
        account: { privateKeyEnv: "JEVY_TEST_PRIVATE_KEY" },
      },
    });
    expect(config.web3?.allowMainnetSigning).toBe(false);
    expect(config.web3?.driver).toBe("mock");
    expect(config.warnings.some((warning) => warning.includes("mainnet"))).toBe(
      true,
    );
    expect(() =>
      parseConfig({
        web3: { account: { privateKeyEnv: `0x${"ab".repeat(32)}` } },
      }),
    ).toThrow(ConfigError);
  });

  it("requires an LLM adapter and an explicit model pin", () => {
    const adapter = {
      complete(): Promise<unknown> {
        return Promise.resolve(null);
      },
    };
    const config = parseConfig({
      decider: "llm",
      deciders: { llm: { adapter, model: "example/mock-1" } },
    });
    const selected = selectDecider(config);
    expect(selected.id).toBe("llm");
    expect(selected.model).toBe("example/mock-1");
    expect(() =>
      parseConfig({
        decider: "llm",
        deciders: { llm: { adapter } },
      }),
    ).toThrow(/model/);
    expect(() => parseConfig({ decider: "llm" })).toThrow(/adapter/);
    expect(() => selectDecider(parseConfig({}))).toThrow(/No decider selected/);
  });

  it("connects config redact rules to the snapshot hash", () => {
    const config = parseConfig({
      redact: [/ORDER-\d+/],
      normalise: { disable: ["long-digits"] },
    });
    const options = snapshotOptionsFromConfig(config);
    expect(hashSnapshot({ role: "status", name: "ORDER-12" }, options)).toBe(
      hashSnapshot({ role: "status", name: "ORDER-99" }, options),
    );
    expect(hashSnapshot({ role: "status", name: "ORDER-12" })).not.toBe(
      hashSnapshot({ role: "status", name: "ORDER-99" }),
    );
  });

  it("loads a TypeScript config and a JavaScript config", async () => {
    const tsDir = await tempDir();
    await writeFile(join(tsDir, "package.json"), '{ "type": "module" }\n');
    await writeFile(
      join(tsDir, "jevy.config.ts"),
      'export default { decider: "kev", thresholds: { pass: 0.9, fail: 0.2 } };\n',
    );
    const fromTs = await loadConfig({ cwd: tsDir, env: {} });
    expect(fromTs.decider?.use).toBe("kev");
    expect(fromTs.thresholds).toEqual({ pass: 0.9, fail: 0.2 });

    const jsDir = await tempDir();
    await writeFile(join(jsDir, "package.json"), '{ "type": "module" }\n');
    await writeFile(
      join(jsDir, "jevy.config.mjs"),
      'export default { decider: "jev" };\n',
    );
    const fromJs = await loadConfig({ cwd: jsDir, env: {} });
    expect(selectDecider(fromJs).id).toBe("jev");

    const empty = await tempDir();
    await expect(loadConfig({ cwd: empty })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

function raw(value: unknown): unknown {
  return value;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jevy-config-"));
  directories.push(dir);
  return dir;
}
