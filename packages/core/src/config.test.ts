import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_API_KEY_ENV,
  DEFAULT_JEV_MODEL,
  DEFAULT_KEV_BASE_URL,
  DEFAULT_KEV_MODEL,
  configExport,
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

  it("defaults cache mode from CI and refuses an external store", () => {
    expect(parseConfig({}, { env: {} }).cache).toEqual({
      dir: ".jevy/decisions",
      mode: "record",
    });
    expect(parseConfig({}, { env: { CI: "true" } }).cache.mode).toBe("replay");
    expect(
      parseConfig(
        { cache: { mode: "replay-or-query" } },
        { env: { CI: "true" } },
      ).cache.mode,
    ).toBe("replay-or-query");
    expect(() => parseConfig(raw({ cache: { store: "later" } }))).toThrow(/M2/);
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

  it("loads a config compiled to CommonJS, as Playwright does in a CommonJS project", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), "{}\n");
    await writeFile(
      join(dir, "jevy.config.js"),
      [
        '"use strict";',
        'Object.defineProperty(exports, "__esModule", { value: true });',
        'exports.default = { decider: "kev" };',
        "",
      ].join("\n"),
    );
    const loaded = await loadConfig({ cwd: dir, env: {} });
    expect(loaded.decider?.use).toBe("kev");
  });

  it("unwraps the default export of a module compiled to CommonJS, whatever Node does", () => {
    // Node 22 and Playwright's own loader hand a compiled module over as
    // { default: { __esModule: true, default: config } }; Node 24 unwraps it.
    const config = { decider: "kev" };
    expect(
      configExport({ default: { __esModule: true, default: config } }),
    ).toBe(config);
    expect(configExport({ default: config })).toBe(config);
    const plain = { default: config };
    expect(configExport({ default: plain })).toBe(plain);
    expect(
      configExport({ default: { __esModule: false, default: config } }),
    ).toEqual({ __esModule: false, default: config });
  });

  it("does not unwrap a plain CommonJS object that has a default key", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), "{}\n");
    await writeFile(
      join(dir, "jevy.config.js"),
      'module.exports = { default: { decider: "kev" } };\n',
    );
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(
      "unknown keys: default",
    );
  });
});

function raw(value: unknown): unknown {
  return value;
}

describe("rules that can never settle", () => {
  function configMessage(raw: unknown): string {
    try {
      parseConfig(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error("expected a ConfigError");
  }

  it("rejects a redact pattern that matches the empty string", () => {
    expect(configMessage({ redact: [/ORDER-\d+/, /x*/] })).toMatch(
      /redact\[1\].*empty string/,
    );
    expect(configMessage({ redact: [{ pattern: /a?/ }] })).toMatch(
      /redact\[0\].*empty string/,
    );
  });

  it("rejects a redact pattern that can match an empty span inside text", () => {
    expect(configMessage({ redact: [/\b/] })).toMatch(
      /redact\[0\].*empty string/,
    );
    expect(configMessage({ redact: [{ pattern: /(?=x)/ }] })).toMatch(
      /redact\[0\].*empty string/,
    );
  });

  it("rejects a rule that matches inside the [REDACTED] token", () => {
    const message = configMessage({ redact: [/RED/] });
    expect(message).toMatch(/redact\[0\]/);
    expect(message).toContain('"[REDACTED]"');
    expect(message).toMatch(/never settle/);
  });

  it("rejects a pattern rule that matches its own replacement", () => {
    expect(
      configMessage({
        redact: [{ pattern: /code-\d+|hidden/, replacement: "[hidden]" }],
      }),
    ).toMatch(/redact\[0\] matches its own replacement "\[hidden\]"/);
    // A replacement the pattern maps to itself is a fixed point, and settles.
    expect(
      parseConfig({
        redact: [{ pattern: /code-\w+/, replacement: "code-hidden" }],
      }).redact,
    ).toHaveLength(1);
  });

  it("rejects a rule that matches another rule's replacement", () => {
    expect(
      configMessage({
        redact: [{ pattern: /ORD-\d+/, replacement: "ORD" }, /ORD/],
      }),
    ).toMatch(/redact\[1\] matches "ORD", the replacement set by redact\[0\]/);
    expect(
      configMessage({
        redact: [{ role: "textbox", replacement: "hidden" }, /hidden/],
      }),
    ).toMatch(/redact\[1\].*"hidden".*redact\[0\]/);
  });

  it("ignores g and y flags and their lastIndex when it checks", () => {
    const global = /RED/g;
    global.lastIndex = 7;
    expect(configMessage({ redact: [global] })).toMatch(/redact\[0\]/);
    expect(global.lastIndex).toBe(7);
    expect(configMessage({ redact: [/RED/y] })).toMatch(/redact\[0\]/);
    const empty = /x*/g;
    empty.lastIndex = 3;
    expect(configMessage({ redact: [empty] })).toMatch(/empty string/);

    const fine = /ORDER-\d+/gy;
    fine.lastIndex = 4;
    expect(parseConfig({ redact: [fine] }).redact).toEqual([fine]);
    expect(fine.lastIndex).toBe(4);
  });

  it("accepts rules that settle", () => {
    const rules = [
      /ORDER-\d+/,
      { pattern: /tok_\w+/, replacement: "[token]" },
      { role: "textbox", name: "Backup code", replacement: "[code]" },
      { role: "searchbox" },
    ];
    expect(parseConfig({ redact: rules }).redact).toHaveLength(4);
  });

  it("rejects a normalise pattern that matches the empty string", () => {
    expect(
      configMessage({
        normalise: { replace: [{ pattern: /x*/, placeholder: "[x]" }] },
      }),
    ).toMatch(/normalise\.replace\[0\]\.pattern.*empty string/);
  });

  it("rejects a normalise pattern that matches its own placeholder", () => {
    expect(
      configMessage({
        normalise: {
          replace: [
            { pattern: /ORD-\d+/, placeholder: "[order]" },
            { pattern: /\[\w+\]/g, placeholder: "[ref]" },
          ],
        },
      }),
    ).toMatch(/normalise\.replace\[1\]\.pattern matches its own placeholder/);
  });

  it("rejects a redact rule that matches a built-in normalise placeholder", () => {
    // Normalised text is checked for secrets again, so a rule matching
    // "[time]" would fail every page that shows a timestamp.
    const message = configMessage({ redact: [/time/] });
    expect(message).toMatch(/redact\[0\]/);
    expect(message).toContain('"[time]"');
    expect(message).toMatch(/timestamp/);
    // Once the built-in is disabled its placeholder never appears.
    expect(
      parseConfig({
        redact: [/time/],
        normalise: { disable: ["timestamp", "relative-time"] },
      }).redact,
    ).toHaveLength(1);
  });

  it("rejects a redact rule that matches a normalise.replace placeholder", () => {
    expect(
      configMessage({
        redact: [/ORDER-\d+/, /order/],
        normalise: {
          replace: [{ pattern: /ORD-\d+/, placeholder: "[order]" }],
        },
      }),
    ).toMatch(/redact\[1\].*"\[order\]".*normalise\.replace\[0\]/);
  });

  it("accepts a normalise pattern whose placeholder it does not match", () => {
    const sticky = /ORD-\d+/y;
    sticky.lastIndex = 2;
    const config = parseConfig({
      normalise: { replace: [{ pattern: sticky, placeholder: "[order]" }] },
    });
    expect(config.normalise.replace).toHaveLength(1);
    expect(sticky.lastIndex).toBe(2);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jevy-config-"));
  directories.push(dir);
  return dir;
}

// glob-table:start
// The same table, character for character, is in
// packages/core/src/config.test.ts and packages/cli/src/guard/glob.test.ts.
// Core's loader (`assertGlob`) and the CLI's matcher (`checkGlob`) cannot
// import one another, so each restates the rule and each is tested against
// this table. Change both copies together: a glob the loader accepts and the
// matcher refuses makes the guard and the hooks fail on a valid config.
const GLOB_TABLE = {
  accepted: [
    "tests/**",
    "**/*.spec.ts",
    "docs/plan.md",
    "./tests/critical/",
    "**/*.{spec,test}.{ts,tsx}",
    "a?c",
    "**",
    "x/{a,}/y",
    "a/./b",
    "a//b",
    ".jevy/**",
    "app/(marketing)/**",
    "tests/my dir/*.ts",
    "my docs/plan.md",
    "{my docs,a b}/**",
    "a+b$^.ts",
    "{a,b}".repeat(8),
  ],
  rejected: [
    "",
    " ",
    " tests/**",
    "tests/** ",
    "\ttests/**",
    "{plans, tests/critical}/**",
    "{plans,tests/critical }/**",
    "tests/critical /**",
    "tests/ critical/**",
    "{a,b }/x",
    "a{ b,c}",
    "tests/\t/**",
    "!tests/**",
    "./!x",
    "{!a,b}",
    "/abs/path",
    "{/etc,a}",
    "C:/x",
    "C:x",
    "./C:x",
    "C:\\tests",
    "a\\b",
    "../outside",
    "a/../b",
    "{..,a}/x",
    "tests/[ab]/**",
    "src/[id]/**",
    "a]",
    "a/{b,{c,d}}",
    "{a",
    "a/{b,c",
    "a/b}",
    "a**b",
    "a/**.ts",
    ".",
    "./",
    "{tests,}",
    "tests/*.@(spec|test).ts",
    "tests/+(a|b)",
    "a/?(b)",
    "a/*(b)",
    "a/!(b)",
    "a|b",
    "{a,b}".repeat(9),
  ],
} as const;
// glob-table:end

describe("guard settings: protect, checks and guard.tests", () => {
  it("defaults to nothing protected, no checks and the built-in test globs", () => {
    const config = parseConfig({}, { env: {} });
    expect(config.protect).toEqual([]);
    expect(config.checks).toEqual([]);
    expect(config.guard).toEqual({ tests: null });
  });

  it("keeps the lists as written", () => {
    const config = parseConfig(
      {
        protect: ["tests/critical/**", "docs/test-plan.md"],
        checks: ["pnpm lint", "pnpm typecheck", "pnpm test"],
        guard: { tests: ["e2e/**/*.ts", "**/*.spec.ts"] },
      },
      { env: {} },
    );
    expect(config.protect).toEqual(["tests/critical/**", "docs/test-plan.md"]);
    expect(config.checks).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
    expect(config.guard).toEqual({ tests: ["e2e/**/*.ts", "**/*.spec.ts"] });
  });

  it("accepts the keys through defineConfig", () => {
    const defined = defineConfig({
      protect: ["tests/**"],
      checks: ["pnpm test"],
      guard: { tests: ["**/*.spec.ts"] },
    });
    expect(parseConfig(defined, { env: {} }).protect).toEqual(["tests/**"]);
  });

  it("rejects a list that is not an array of non-empty strings", () => {
    const bad: readonly [unknown, string][] = [
      [{ protect: "tests/**" }, "protect must be an array"],
      [{ protect: [""] }, "protect[0] must be a non-empty string"],
      [{ protect: [7] }, "protect[0] must be a non-empty string"],
      [{ checks: "pnpm test" }, "checks must be an array"],
      [{ checks: ["pnpm test", " "] }, "checks[1] must be a non-empty string"],
      [{ guard: [] }, "guard must be an object"],
      [{ guard: { tests: "**/*.spec.ts" } }, "guard.tests must be an array"],
      [
        { guard: { tests: [null] } },
        "guard.tests[0] must be a non-empty string",
      ],
    ];
    for (const [input, message] of bad) {
      expect(() => parseConfig(input, { env: {} })).toThrow(ConfigError);
      expect(() => parseConfig(input, { env: {} })).toThrow(message);
    }
  });

  it("rejects a glob it could not honour, so nothing is silently unprotected", () => {
    const bad: readonly [unknown, string][] = [
      [{ protect: ["!tests/open/**"] }, "protect[0] must not start with '!'"],
      [{ protect: ["/etc/passwd"] }, "protect[0] must be relative"],
      [{ protect: ["C:\\tests"] }, "protect[0] must use forward slashes"],
      [{ protect: ["../other/**"] }, "protect[0] must stay inside the project"],
      [
        { protect: ["tests/../../x"] },
        "protect[0] must stay inside the project",
      ],
      [{ guard: { tests: ["!x"] } }, "guard.tests[0] must not start with '!'"],
      [
        { guard: { tests: ["../x"] } },
        "guard.tests[0] must stay inside the project",
      ],
    ];
    for (const [input, message] of bad) {
      expect(() => parseConfig(input, { env: {} })).toThrow(ConfigError);
      expect(() => parseConfig(input, { env: {} })).toThrow(message);
    }
  });

  it("agrees with the table of globs it shares with the CLI's matcher", () => {
    for (const glob of GLOB_TABLE.accepted) {
      expect(
        parseConfig({ protect: [glob], guard: { tests: [glob] } }, { env: {} })
          .protect,
        glob,
      ).toEqual([glob]);
    }
    for (const glob of GLOB_TABLE.rejected) {
      expect(() => parseConfig({ protect: [glob] }, { env: {} }), glob).toThrow(
        ConfigError,
      );
      expect(
        () => parseConfig({ guard: { tests: [glob] } }, { env: {} }),
        glob,
      ).toThrow(ConfigError);
    }
  });

  it("says what is wrong with a glob the CLI's matcher would refuse", () => {
    const bad: readonly [string, string][] = [
      [" tests/**", "protect[0] must not start or end with whitespace"],
      ["tests/** ", "protect[0] must not start or end with whitespace"],
      [
        "{plans, tests/critical}/**",
        "protect[0] must not have whitespace at the start or end of a",
      ],
      [
        "tests/critical /**",
        "protect[0] must not have whitespace at the start or end of a path segment",
      ],
      [
        "a{ b,c}",
        "protect[0] must not have whitespace at the start or end of a brace alternative",
      ],
      ["./!x", "protect[0] must not start with '!'"],
      ["{!a,b}", "protect[0] must not start with '!'"],
      ["{/etc,a}", "protect[0] must be relative"],
      ["C:/x", "protect[0] must be relative"],
      ["C:x", "protect[0] must be relative"],
      ["{..,a}/x", "protect[0] must stay inside the project"],
      ["tests/[ab]/**", "protect[0] must not use a character class"],
      ["a]", "protect[0] must not use a character class"],
      ["a/{b,{c,d}}", "protect[0] must not nest braces"],
      ["{a", "protect[0] has unbalanced braces"],
      ["a/b}", "protect[0] has unbalanced braces"],
      ["a**b", "protect[0] must use ** as a whole path segment"],
      [".", "protect[0] names no path"],
      ["{tests,}", "protect[0] names no path"],
      ["tests/*.@(spec|test).ts", "protect[0] must not use an extended glob"],
      ["tests/+(a|b)", "protect[0] must not use an extended glob"],
      ["a|b", "protect[0] must not contain '|'"],
      ["{a,b}".repeat(9), "protect[0] expands to more than 256 alternatives"],
    ];
    for (const [glob, message] of bad) {
      expect(() => parseConfig({ protect: [glob] }, { env: {} }), glob).toThrow(
        message,
      );
    }
  });

  it("rejects an empty guard.tests, which would compare no test file at all", () => {
    expect(() => parseConfig({ guard: { tests: [] } }, { env: {} })).toThrow(
      "guard.tests must list at least one glob",
    );
  });

  it("rejects unknown keys under guard", () => {
    expect(() =>
      parseConfig({ guard: { test: ["**/*.spec.ts"] } }, { env: {} }),
    ).toThrow("guard has unknown keys: test");
  });

  it("does not treat a check command as a pasted secret", () => {
    const config = parseConfig(
      {
        checks: [
          "pnpm --filter @acme/web exec playwright test --reporter=line",
        ],
      },
      { env: {} },
    );
    expect(config.checks).toHaveLength(1);
  });
});

describe("toSatisfy.blocking", () => {
  it("defaults to advisory, so a verdict does not fail a test", () => {
    expect(parseConfig({}, { env: {} }).toSatisfy).toEqual({ blocking: false });
    expect(parseConfig({ toSatisfy: {} }, { env: {} }).toSatisfy).toEqual({
      blocking: false,
    });
  });

  it("keeps the switch as written, also through defineConfig", () => {
    const defined = defineConfig({ toSatisfy: { blocking: true } });
    expect(parseConfig(defined, { env: {} }).toSatisfy).toEqual({
      blocking: true,
    });
    expect(
      parseConfig({ toSatisfy: { blocking: false } }, { env: {} }).toSatisfy,
    ).toEqual({ blocking: false });
  });

  it.each<[unknown, string]>([
    [true, "toSatisfy must be an object"],
    [null, "toSatisfy must be an object"],
    [[], "toSatisfy must be an object"],
    [{ blocking: "true" }, "toSatisfy.blocking must be a boolean"],
    [{ blocking: 1 }, "toSatisfy.blocking must be a boolean"],
    [{ blocking: null }, "toSatisfy.blocking must be a boolean"],
    [{ blocking: true, perTest: false }, "toSatisfy has unknown keys: perTest"],
  ])("rejects toSatisfy %j", (toSatisfy, message) => {
    expect(() => parseConfig({ toSatisfy }, { env: {} })).toThrow(ConfigError);
    expect(() => parseConfig({ toSatisfy }, { env: {} })).toThrow(message);
  });
});
