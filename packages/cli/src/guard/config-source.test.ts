import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILENAMES,
  findConfig,
  readConfigSettings,
  type ConfigSettings,
} from "./config-source.js";

const EVERY_KEY = [
  "cache.dir",
  "guard.tests",
  "protect",
  "checks",
  "web3.policy",
  "ci.mainBranch",
];

const NOTHING: ConfigSettings = {
  cacheDir: null,
  guardTests: null,
  protect: null,
  checks: null,
  web3Policy: null,
  mainBranch: null,
  unreadable: [],
};

function read(text: string, path = "jevy.config.ts"): ConfigSettings {
  return readConfigSettings(text, path);
}

function config(body: string): ConfigSettings {
  return read(
    `import { defineConfig } from "@jevyjs/core";\nexport default defineConfig(${body});\n`,
  );
}

describe("readConfigSettings", () => {
  it("reads every setting from a literal config", () => {
    expect(
      config(`{
        decider: "kev",
        cache: { dir: ".jevy/decisions", mode: "replay" },
        guard: { tests: ["e2e/**/*.spec.ts", "tests/**"] },
        protect: ["tests/critical/**", "docs/plan.md"],
        checks: ["pnpm lint", "pnpm test"],
        web3: { driver: "anvil", policy: "./wallet-policy.ts" },
        ci: { needsReview: { pr: "fail" }, mainBranch: "trunk" },
      }`),
    ).toEqual({
      cacheDir: ".jevy/decisions",
      guardTests: ["e2e/**/*.spec.ts", "tests/**"],
      protect: ["tests/critical/**", "docs/plan.md"],
      checks: ["pnpm lint", "pnpm test"],
      web3Policy: "./wallet-policy.ts",
      mainBranch: "trunk",
      unreadable: [],
    });
  });

  it("reads an absent key as null, and not as unreadable", () => {
    expect(config(`{ decider: "kev" }`)).toEqual(NOTHING);
    expect(config(`{ cache: { mode: "replay" }, ci: {}, web3: {} }`)).toEqual(
      NOTHING,
    );
    expect(config(`{ guard: {} }`)).toEqual(NOTHING);
  });

  it("reads an empty array as an empty list, not as null", () => {
    expect(config(`{ protect: [], checks: [], guard: { tests: [] } }`)).toEqual(
      { ...NOTHING, protect: [], checks: [], guardTests: [] },
    );
  });

  it("treats a key set to undefined as absent, as the loader does", () => {
    expect(config(`{ protect: undefined, cache: { dir: undefined } }`)).toEqual(
      NOTHING,
    );
    expect(config(`{ cache: undefined }`)).toEqual(NOTHING);
  });

  it("sees through as const, satisfies, parentheses and quoting", () => {
    expect(
      config(`{
        "protect": (["a/**", 'b.md'] as const),
        checks: [\`pnpm lint\`] satisfies string[],
        cache: ({ dir: ("x" as string) } satisfies object),
        ["decider"]: "kev",
      } as const`),
    ).toMatchObject({
      protect: ["a/**", "b.md"],
      checks: ["pnpm lint"],
      cacheDir: "x",
    });
  });

  it("reads every way of exporting the config object", () => {
    const expected = { ...NOTHING, protect: ["a"] };
    expect(read(`export default { protect: ["a"] };`)).toEqual(expected);
    expect(
      read(
        `const config = { protect: ["a"] } satisfies JevyConfig;\nexport default config;`,
      ),
    ).toEqual(expected);
    expect(
      read(`module.exports = { protect: ["a"] };`, "jevy.config.js"),
    ).toEqual(expected);
    expect(
      read(
        `import { defineConfig } from "@jevyjs/core";\nconst c = defineConfig({ protect: ["a"] });\nexport { c as default };`,
        "jevy.config.mjs",
      ),
    ).toEqual(expected);
  });

  it("follows a top-level const referenced by identifier or shorthand", () => {
    expect(
      read(`const tests = ["e2e/**"] as const;
const protect = ["docs/**"];
const DIR = ".cache/jevy";
const cache = { dir: DIR };
const alias = protect;
export default defineConfig({ guard: { tests }, protect: alias, cache, checks: [] });
`),
    ).toEqual({
      ...NOTHING,
      guardTests: ["e2e/**"],
      protect: ["docs/**"],
      cacheDir: ".cache/jevy",
      checks: [],
    });
  });

  it("does not follow let or var, an import, or a cycle", () => {
    expect(
      read(`import { shared } from "./shared.js";
let protect = ["docs/**"];
var checks = ["pnpm test"];
const a = b;
const b = a;
export default defineConfig({ protect, checks, guard: { tests: shared }, cache: { dir: a } });
`),
    ).toEqual({
      ...NOTHING,
      unreadable: ["cache.dir", "guard.tests", "protect", "checks"],
    });
  });

  it("reports a present key it cannot read as a literal", () => {
    expect(
      config(`{
        cache: { dir: process.env.JEVY_CACHE },
        guard: { tests: globs() },
        protect: [...base, "a"],
        checks: "pnpm test",
        web3: { policy: \`./\${name}.ts\` },
        ci: { mainBranch: 42 },
      }`),
    ).toEqual({ ...NOTHING, unreadable: EVERY_KEY });
  });

  it("does not return part of a list: one unreadable element spoils it", () => {
    for (const list of [
      `["a", b]`,
      `["a", 1]`,
      `["a", , "b"]`,
      `["a", ...more]`,
      `["a", \`b\${c}\`]`,
      `["a", ["b"]]`,
    ]) {
      const settings = config(`{ protect: ${list}, checks: ${list} }`);
      expect(settings.protect).toBeNull();
      expect(settings.checks).toBeNull();
      expect(settings.unreadable).toEqual(["protect", "checks"]);
    }
  });

  it("reports a nested key under a parent it cannot read", () => {
    expect(
      config(`{ cache: makeCache(), guard: 1, web3: null, ci: [] }`).unreadable,
    ).toEqual(["cache.dir", "guard.tests", "web3.policy", "ci.mainBranch"]);
    expect(
      config(`{ get protect() { return []; }, checks() {} }`).unreadable,
    ).toEqual(["protect", "checks"]);
  });

  it("fails closed on a spread: only keys set after it are readable", () => {
    // Before the spread: the spread may overwrite it.
    expect(config(`{ protect: ["a"], ...base }`)).toEqual({
      ...NOTHING,
      unreadable: EVERY_KEY,
    });
    // After the spread: the explicit key wins, whatever the spread held.
    expect(
      config(`{ ...base, protect: ["a"], cache: { mode: "replay" } }`),
    ).toEqual({
      ...NOTHING,
      protect: ["a"],
      unreadable: ["guard.tests", "checks", "web3.policy", "ci.mainBranch"],
    });
    // The same rule one level down.
    expect(
      config(
        `{ cache: { dir: "x", ...shared }, web3: { ...w, policy: "p.ts" } }`,
      ),
    ).toEqual({ ...NOTHING, web3Policy: "p.ts", unreadable: ["cache.dir"] });
    expect(config(`{ cache: { ...shared } }`).unreadable).toEqual([
      "cache.dir",
    ]);
  });

  it("treats a computed key like a spread: it could be any key", () => {
    expect(config(`{ protect: ["a"], [key]: [] }`)).toEqual({
      ...NOTHING,
      unreadable: EVERY_KEY,
    });
    expect(config(`{ [key]: [], protect: ["a"] }`).protect).toEqual(["a"]);
  });

  it("takes the last of a repeated key, as JavaScript does", () => {
    expect(config(`{ protect: ["a"], protect: ["b"] }`).protect).toEqual(["b"]);
    expect(config(`{ protect: ["a"], protect: nope }`)).toEqual({
      ...NOTHING,
      unreadable: ["protect"],
    });
  });

  describe("a shape the real loader could read differently", () => {
    // The loader runs the config. In each of these it ends up with
    // `cache.dir` "tmp/d" (or cannot be shown not to) while the text still
    // shows ".jevy/decisions", so nothing may be read from the text.
    const lost = { ...NOTHING, unreadable: ["*"] };
    const SAFE = `{ cache: { dir: ".jevy/decisions" }, protect: ["tests/**"] }`;
    const IMPORT = `import { defineConfig } from "@jevyjs/core";\n`;

    it.each([
      [
        "a property of the config object assigned after it is built",
        `const c = ${SAFE};\nc.cache.dir = "tmp/d";\nexport default c;`,
      ],
      [
        "a let that is assigned again",
        `let c = ${SAFE};\nc = { cache: { dir: "tmp/d" } };\nexport default c;`,
      ],
      [
        "a let, even when nothing assigns it",
        `let c = ${SAFE};\nexport default c;`,
      ],
      ["a var", `var c = ${SAFE};\nexport default c;`],
      [
        "Object.assign on the config object",
        `const c = ${SAFE};\nObject.assign(c, { cache: { dir: "tmp/d" } });\nexport default c;`,
      ],
      [
        "the config object passed to a function",
        `const c = ${SAFE};\ntune(c);\nexport default defineConfig(c);`,
      ],
      [
        "the config object reached through a second name",
        `const c = ${SAFE};\nconst d = c;\nd.cache.dir = "tmp/d";\nexport default c;`,
      ],
      [
        "a defineConfig declared in the file as a function",
        `function defineConfig(c) { return { ...c, cache: { dir: "tmp/d" } }; }\nexport default defineConfig(${SAFE});`,
      ],
      [
        "a defineConfig declared in the file as a const",
        `const defineConfig = (c) => ({ ...c, cache: { dir: "tmp/d" } });\nexport default defineConfig(${SAFE});`,
      ],
      [
        "a defineConfig taken out of some other value",
        `const { defineConfig } = helpers;\nexport default defineConfig(${SAFE});`,
      ],
      [
        "a defineConfig imported from a file of the repository",
        `import { defineConfig } from "./tools/define.js";\nexport default defineConfig(${SAFE});`,
      ],
      [
        "another export imported under the name defineConfig",
        `import { tune as defineConfig } from "@jevyjs/core";\nexport default defineConfig(${SAFE});`,
      ],
      [
        "x.defineConfig where x is not an import",
        `const x = { defineConfig: (c) => ({ ...c, cache: { dir: "tmp/d" } }) };\nexport default x.defineConfig(${SAFE});`,
      ],
      [
        "x.defineConfig where x is not declared at all",
        `export default x.defineConfig(${SAFE});`,
      ],
      [
        "defineConfig given more than the config",
        `${IMPORT}export default defineConfig(${SAFE}, { cache: { dir: "tmp/d" } });`,
      ],
      [
        "defineConfig given a spread",
        `${IMPORT}export default defineConfig(...[${SAFE}]);`,
      ],
      [
        "a default re-exported from another file",
        `${IMPORT}defineConfig(${SAFE});\nexport { default } from "./real.config.js";`,
      ],
      [
        "a second export default",
        `export default ${SAFE};\nexport default { cache: { dir: "tmp/d" } };`,
      ],
      [
        "export default beside export { x as default }",
        `const x = { cache: { dir: "tmp/d" } };\nexport default ${SAFE};\nexport { x as default };`,
      ],
      [
        "a second module.exports =",
        `module.exports = ${SAFE};\nmodule.exports = { cache: { dir: "tmp/d" } };`,
      ],
      [
        "a second module.exports = inside a block",
        `module.exports = ${SAFE};\nif (process.env.CI) { module.exports = { cache: { dir: "tmp/d" } }; }`,
      ],
      [
        "a property of module.exports assigned afterwards",
        `module.exports = ${SAFE};\nmodule.exports.cache.dir = "tmp/d";`,
      ],
      [
        "exports used beside module.exports",
        `module.exports = ${SAFE};\nexports.cache = { dir: "tmp/d" };`,
      ],
      [
        "module.exports beside export default",
        `export default ${SAFE};\nmodule.exports = { cache: { dir: "tmp/d" } };`,
      ],
      ["export = in place of export default", `export = ${SAFE};`],
      [
        "a declared undefined",
        `var undefined = "tmp/d";\nexport default { cache: { dir: undefined } };`,
      ],
      [
        "a destructured undefined",
        `const { undefined } = { undefined: "tmp/d" };\nexport default { cache: { dir: undefined } };`,
      ],
      [
        "an imported undefined",
        `import { dir as undefined } from "./dir.js";\nexport default { cache: { dir: undefined } };`,
      ],
      [
        "a __proto__ key, whose keys the loader would inherit",
        `export default { __proto__: { cache: { dir: "tmp/d" } }, protect: ["tests/**"] };`,
      ],
      [
        "a quoted __proto__ key",
        `export default { "__proto__": { protect: [] }, cache: { dir: ".jevy/decisions" } };`,
      ],
      [
        "eval, which can reach a const without naming it",
        `const c = ${SAFE};\neval('c.cache.dir = "tmp/d"');\nexport default c;`,
      ],
      [
        "a dynamic import, which can reach the exported object",
        `export default ${SAFE};\nvoid import("./jevy.config.ts").then((m) => { m.default.cache.dir = "tmp/d"; });`,
      ],
      [
        "defineConfig wrapped in another call",
        `${IMPORT}export default tune(defineConfig(${SAFE}));`,
      ],
      [
        "a default-exported function",
        `export default function config() { return ${SAFE}; }`,
      ],
    ])('answers ["*"] for %s', (_what, text) => {
      expect(read(text)).toEqual(lost);
      expect(read(text, "jevy.config.js")).toEqual(lost);
    });

    it("reads the object that export { real as default } names, not a decoy call", () => {
      expect(
        read(
          `${IMPORT}const real = { cache: { dir: "tmp/d" } };\ndefineConfig(${SAFE});\nexport { real as default };`,
        ),
      ).toEqual({ ...NOTHING, cacheDir: "tmp/d" });
    });

    it("marks only the key when a const used as a value is touched elsewhere", () => {
      expect(
        read(`const protect = ["tests/**"];
protect.push("more");
const DIR = ".jevy/decisions";
const cache = { dir: DIR };
cache.dir = "tmp/d";
const tests = ["e2e/**"];
export default { protect, cache, guard: { tests }, checks: [] };
`),
      ).toEqual({
        ...NOTHING,
        guardTests: ["e2e/**"],
        checks: [],
        unreadable: ["cache.dir", "protect"],
      });
      // The same const read into two keys: neither read proves the other
      // did not change it, and the fix is to write the value out.
      expect(
        read(
          `const list = ["a"];\nexport default { protect: list, checks: list };`,
        ).unreadable,
      ).toEqual(["protect", "checks"]);
    });

    it("marks the key under a nested __proto__ key", () => {
      expect(
        config(
          `{ cache: { __proto__: { dir: "tmp/d" } }, web3: { __proto__: null, policy: "p.ts" }, protect: ["a"] }`,
        ),
      ).toEqual({
        ...NOTHING,
        protect: ["a"],
        unreadable: ["cache.dir", "web3.policy"],
      });
    });

    it("still reads the ordinary forms", () => {
      const expected = {
        ...NOTHING,
        cacheDir: ".jevy/decisions",
        protect: ["tests/**"],
      };
      for (const text of [
        `export default ${SAFE};`,
        `export default ${SAFE} satisfies JevyConfig;`,
        `${IMPORT}export default defineConfig(${SAFE});`,
        `${IMPORT}const config = defineConfig(${SAFE});\nexport default config;`,
        `${IMPORT}const config = ${SAFE};\nexport default defineConfig(config);`,
        `${IMPORT}const config = ${SAFE} as const;\nexport { config as default };`,
        `import * as jevy from "@jevyjs/core";\nexport default jevy.defineConfig(${SAFE});`,
        `import jevy from "@jevyjs/core";\nexport default jevy.defineConfig(${SAFE});`,
        `import type { JevyConfig } from "@jevyjs/core";\nconst config: JevyConfig = ${SAFE};\nexport default config;`,
        `export default defineConfig(${SAFE});`,
        // Code that never names the config object does not unprove it.
        `${IMPORT}import { rules } from "./rules.js";\nconst helper = (x: number) => x + 1;\nfunction other() { return helper(1); }\nexport default defineConfig({ cache: { dir: ".jevy/decisions" }, protect: ["tests/**"], redact: rules, thresholds: { pass: other() } });`,
      ]) {
        expect(read(text), text).toEqual(expected);
      }
      for (const text of [
        `module.exports = ${SAFE};`,
        `const config = ${SAFE};\nmodule.exports = config;`,
      ]) {
        expect(read(text, "jevy.config.js"), text).toEqual(expected);
      }
    });

    it.each(["README.md", "docs/DESIGN.md"])(
      "reads the example config in %s cleanly",
      (doc) => {
        const text = readFileSync(
          new URL(`../../../../${doc}`, import.meta.url),
          "utf8",
        );
        const examples = [...text.matchAll(/```ts\n([\s\S]*?)```/g)]
          .map((match) => match[1] ?? "")
          .filter((code) => code.includes("export default defineConfig("));
        expect(examples.length).toBeGreaterThan(0);
        for (const example of examples) {
          const settings = read(example);
          expect(settings.unreadable).toEqual([]);
          expect(settings.cacheDir).toBe(".jevy/decisions");
        }
      },
    );
  });

  it('answers ["*"] when the file does not parse or has no config object', () => {
    const lost = { ...NOTHING, unreadable: ["*"] };
    expect(read("export default defineConfig({")).toEqual(lost);
    expect(read("export default makeConfig();")).toEqual(lost);
    expect(read("export default async () => ({ protect: [] });")).toEqual(lost);
    expect(read("")).toEqual(lost);
    expect(read("const x = 1;")).toEqual(lost);
  });

  it("never throws, whatever the text", () => {
    for (const text of [
      "\u0000\u0001￿",
      "}{][)(",
      "export default defineConfig(defineConfig(defineConfig()));",
      "export default config;\nconst config = config;",
      `export default ${"(".repeat(20000)}`,
      `export default {${" a: {".repeat(20000)}`,
      `export default defineConfig({ protect: ${"[".repeat(5000)} });`,
    ]) {
      expect(read(text).unreadable).toEqual(["*"]);
    }
    expect(read("export default {};", "jevy.config.weird").unreadable).toEqual(
      [],
    );
  });

  it("parses .mts, .js and .mjs configs", () => {
    for (const path of CONFIG_FILENAMES) {
      expect(read(`export default { checks: ["pnpm test"] };`, path)).toEqual({
        ...NOTHING,
        checks: ["pnpm test"],
      });
    }
  });
});

describe("findConfig", () => {
  function reader(
    files: Readonly<Record<string, string>>,
    seen: string[] = [],
  ): (path: string) => Promise<string | null> {
    return (path) => {
      seen.push(path);
      return Promise.resolve(files[path] ?? null);
    };
  }

  it("lists the file names in the order the loader tries them", () => {
    expect(CONFIG_FILENAMES).toEqual([
      "jevy.config.ts",
      "jevy.config.mts",
      "jevy.config.js",
      "jevy.config.mjs",
    ]);
  });

  it("returns the first config that exists, in loader order", async () => {
    const files = {
      "jevy.config.mjs": "export default { a: 1 };",
      "jevy.config.mts": "export default { b: 2 };",
    };
    expect(await findConfig(reader(files), "")).toEqual({
      path: "jevy.config.mts",
      text: "export default { b: 2 };",
    });
  });

  it("looks in a subdirectory, and tolerates ./ and a trailing slash", async () => {
    const files = { "packages/app/jevy.config.js": "module.exports = {};" };
    const found = {
      path: "packages/app/jevy.config.js",
      text: "module.exports = {};",
    };
    expect(await findConfig(reader(files), "packages/app")).toEqual(found);
    expect(await findConfig(reader(files), "./packages/app/")).toEqual(found);
    expect(await findConfig(reader(files), "")).toBeNull();
  });

  it("returns an empty config file: empty is not absent", async () => {
    expect(await findConfig(reader({ "jevy.config.ts": "" }), "")).toEqual({
      path: "jevy.config.ts",
      text: "",
    });
  });

  it("returns null when there is none, having tried each name once", async () => {
    const seen: string[] = [];
    expect(await findConfig(reader({}, seen), "")).toBeNull();
    expect(seen).toEqual([...CONFIG_FILENAMES]);
  });
});
