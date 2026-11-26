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
  "toSatisfy.blocking",
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

  it("reads toSatisfy.blocking when it is a boolean literal", () => {
    expect(config(`{ toSatisfy: { blocking: true } }`)).toEqual({
      ...NOTHING,
      toSatisfyBlocking: true,
    });
    expect(config(`{ toSatisfy: { blocking: false } }`)).toEqual({
      ...NOTHING,
      toSatisfyBlocking: false,
    });
    // Absent, or set to undefined, is the default: nothing to report.
    expect(config(`{ toSatisfy: {} }`)).toEqual(NOTHING);
    expect(config(`{ toSatisfy: { blocking: undefined } }`)).toEqual(NOTHING);
  });

  it("reads void of a literal as undefined, as core's loader receives it", () => {
    expect(config(`{ toSatisfy: { blocking: void 0 } }`)).toEqual(NOTHING);
    expect(config(`{ toSatisfy: void 0 }`)).toEqual(NOTHING);
    expect(config(`{ cache: { dir: void "x" } }`)).toEqual(NOTHING);
    // void of anything else runs code first, so it is not read.
    expect(
      config(`{ toSatisfy: { blocking: void check() } }`).unreadable,
    ).toEqual(["toSatisfy.blocking"]);
  });

  it.each([
    '{ toSatisfy: { blocking: process.env.CI === "true" } }',
    `{ toSatisfy: { blocking: "true" } }`,
    `{ toSatisfy: { blocking: 1 } }`,
    `{ toSatisfy: { blocking: !false } }`,
    `{ toSatisfy: shared }`,
    `{ toSatisfy: { blocking: true, ...shared } }`,
    `{ toSatisfy: { blocking: true }, ...shared }`,
  ])("lists toSatisfy.blocking as unreadable in %s", (body) => {
    const settings = config(body);
    expect(settings.toSatisfyBlocking).toBeUndefined();
    expect(settings.unreadable).toContain("toSatisfy.blocking");
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
      imports: ["shared.js"],
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
        toSatisfy: { blocking: process.env.CI },
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
      // Changed on purpose: toSatisfy.blocking is read now, and the spread
      // may set it as well.
      unreadable: [
        "guard.tests",
        "checks",
        "web3.policy",
        "ci.mainBranch",
        "toSatisfy.blocking",
      ],
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
      ]) {
        expect(read(text), text).toEqual(expected);
      }
      // Code that never names the config object does not unprove it. The
      // file it imports is listed, so that a caller can protect it.
      expect(
        read(
          `${IMPORT}import { rules } from "./rules.js";\nconst helper = (x: number) => x + 1;\nfunction other() { return helper(1); }\nexport default defineConfig({ cache: { dir: ".jevy/decisions" }, protect: ["tests/**"], redact: rules, thresholds: { pass: other() } });`,
        ),
      ).toEqual({ ...expected, imports: ["rules.js"] });
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

describe("readConfigSettings: what the config imports", () => {
  it("lists the files it imports, relative to the repository root", () => {
    const text = `import { defineConfig } from "@jevyjs/core";
import { join } from "node:path";
import { PASS } from "./thresholds.ts";
import * as rules from "../shared/rules.js";
import type { Types } from "./types.ts";
import "./side-effect.mjs";
export * from "./reexport.js";
import legacy = require("./legacy");
const { adapter } = require("./llm.cjs");
export default defineConfig({ thresholds: { pass: PASS } });
`;
    expect(read(text, "packages/web/jevy.config.ts").imports).toEqual([
      "packages/web/thresholds.ts",
      "packages/shared/rules.js",
      "packages/web/side-effect.mjs",
      "packages/web/reexport.js",
      "packages/web/legacy",
      "packages/web/llm.cjs",
    ]);
  });

  it("lists nothing for a config with no file imports", () => {
    expect(config("{}").imports).toBeUndefined();
  });

  it("marks imports unreadable when one names a file it cannot place", () => {
    for (const specifier of [
      "@/thresholds",
      "#thresholds",
      "~/x",
      "/abs/x.ts",
    ]) {
      const settings = read(
        `import { PASS } from "${specifier}";\nexport default { thresholds: { pass: PASS } };\n`,
      );
      expect(settings.unreadable, specifier).toEqual(["imports"]);
    }
  });
});

describe("readConfigSettings: a config that can change itself as it loads", () => {
  const SAFE =
    '{ protect: ["critical/**"], cache: { dir: ".jevy/decisions" } }';

  it.each([
    [
      "require.cache",
      `module.exports = ${SAFE};\nrequire.cache[__filename].exports.cache.dir = "fixtures";`,
    ],
    [
      "require.cache, without __filename",
      `module.exports = ${SAFE};\nfor (const m of Object.values(require.cache)) m.exports.cache.dir = "x";`,
    ],
    ["__filename", `module.exports = ${SAFE};\nconsole.log(__filename);`],
    ["import.meta", `export default ${SAFE};\nconsole.log(import.meta.url);`],
    ["globalThis", `export default ${SAFE};\nglobalThis.x = 1;`],
    [
      "Object.prototype",
      `export default ${SAFE};\nObject.prototype.cache = { dir: "elsewhere" };`,
    ],
    [
      "Object.defineProperty",
      `export default ${SAFE};\nObject.defineProperty(Object.prototype, "cache", { value: { dir: "elsewhere" } });`,
    ],
    [
      "Reflect",
      `export default ${SAFE};\nReflect.set(Object.getPrototypeOf({}), "cache", 1);`,
    ],
    [
      "Object.getPrototypeOf",
      `export default ${SAFE};\nObject.assign(Object.getPrototypeOf({}), { cache: { dir: "x" } });`,
    ],
    [
      "__lookupGetter__",
      `export default ${SAFE};\n({}).__lookupGetter__("__proto__").call({}).cache = { dir: "x" };`,
    ],
    ["eval", `export default ${SAFE};\neval("1");`],
    ["Function(", `export default ${SAFE};\nFunction("return 1")();`],
    [
      "a prototype reached without naming Object",
      `export default ${SAFE};\n({}).constructor.prototype.cache = { dir: "x" };`,
    ],
    [
      "an import of itself",
      `import self from "./jevy.config.ts";\nexport default ${SAFE};\nqueueMicrotask(() => { self.protect.length = 0; });`,
    ],
    [
      "an import of itself without the extension",
      `import self from "./jevy.config";\nexport default ${SAFE};\nqueueMicrotask(() => { self.protect.length = 0; });`,
    ],
    [
      "a require of itself",
      `module.exports = ${SAFE};\nsetTimeout(() => { require("./jevy.config.ts").protect.length = 0; });`,
    ],
    [
      "a require whose path is not a literal",
      `module.exports = ${SAFE};\nconst p = "./jevy.config.ts";\nsetTimeout(() => { require(p).protect.length = 0; });`,
    ],
  ])('answers ["*"] for a config that mentions %s', (_, text) => {
    expect(read(text).unreadable).toEqual(["*"]);
  });

  it.each([
    [
      "p[1] inside an inline adapter",
      `const a = { complete(p) { return p[1]; } };\nexport default { deciders: { llm: { adapter: a, model: "m" } } };`,
    ],
    [
      "m[1] of a regex match inside an adapter",
      `const adapter = {\n  async complete(prompt) {\n    const m = /verdict: (\\w+)/.exec(prompt);\n    return m === null ? "fail" : m[1];\n  },\n};\nexport default { deciders: { llm: { adapter, model: "m" } }, protect: ["tests/**"] };`,
    ],
    [
      "m[0] and arr[-1] on values that are not the config",
      `const pick = (m, arr) => [m[0], arr[-1], arr[+2], arr[(3)], arr[0x1]];\nexport default { protect: ["tests/**"], deciders: { llm: { adapter: { complete: pick }, model: "m" } } };`,
    ],
  ])("reads a config whose code has a numeric index: %s", (_, text) => {
    expect(read(text).unreadable).toEqual([]);
    expect(read(text, "jevy.config.js").unreadable).toEqual([]);
  });

  it.each([
    [
      "a numeric index read on the config object",
      `const config = ${SAFE};\nconsole.log(config[0]);\nexport default config;`,
    ],
    [
      "a numeric index written on the config object",
      `const config = ${SAFE};\nconfig[0] = { dir: "x" };\nexport default config;`,
    ],
    [
      "a numeric index written on a second name for the config object",
      `const config = ${SAFE};\nconst alias = config;\nalias[-1] = { dir: "x" };\nexport default config;`,
    ],
    [
      "a numeric index written on module.exports",
      `module.exports = ${SAFE};\nmodule.exports[0] = { dir: "x" };`,
    ],
    [
      "a key that is not a literal",
      `const config = ${SAFE};\nconst k = "cache";\nconst f = (o) => o[k];\nexport default config;`,
    ],
    [
      "a numeric index beside a constructor reached through a string key",
      `export default ${SAFE};\nconst x = [1][0];\n({})["constructor"]["prototype"].cache = { dir: "x" };`,
    ],
  ])('still answers ["*"] for %s', (_, text) => {
    expect(read(text).unreadable).toEqual(["*"]);
  });
});
