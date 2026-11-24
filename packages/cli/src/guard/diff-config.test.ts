import { describe, expect, it } from "vitest";
import { diffJevyConfig, diffPlaywrightConfig } from "./diff-config.js";
import { SEVERITY } from "./findings.js";
import { buildReport, formatHuman } from "./report.js";
import type { Finding } from "./types.js";

const JEVY = `import { defineConfig } from "@jevyjs/core";

export default defineConfig({
  decider: { use: "jev", fallback: ["kev"] },
  thresholds: { pass: 0.8, fail: 0.5 },
  cache: { dir: ".jevy/decisions", mode: "replay" },
  ci: { needsReview: { pr: "fail", main: "fail" } },
  redact: [/sk_live_\\w+/],
  normalise: { builtins: ["uuid"] },
});
`;

function jevy(before: string | null, after: string | null): Finding[] {
  return [...diffJevyConfig({ file: "jevy.config.ts", before, after })];
}

function kinds(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.kind);
}

describe("diffJevyConfig", () => {
  it("reports a lowered pass threshold as weakening", () => {
    expect(jevy(JEVY, JEVY.replace("pass: 0.8", "pass: 0.65"))).toEqual([
      {
        kind: "threshold-lowered",
        severity: "weakening",
        file: "jevy.config.ts",
        line: 5,
        message: "thresholds.pass lowered from 0.8 to 0.65",
        before: "0.8",
        after: "0.65",
      },
    ]);
  });

  it("reports a raised pass threshold for review only", () => {
    expect(kinds(jevy(JEVY, JEVY.replace("pass: 0.8", "pass: 0.9")))).toEqual([
      "config-changed",
    ]);
  });

  it.each(["pr", "main"])(
    "reports needsReview.%s going from fail to warn",
    (branch) => {
      const after = JEVY.replace(`${branch}: "fail"`, `${branch}: "warn"`);
      expect(jevy(JEVY, after)).toMatchObject([
        {
          kind: "needs-review-relaxed",
          severity: "weakening",
          message: `ci.needsReview.${branch} relaxed from "fail" to "warn"`,
        },
      ]);
    },
  );

  it("reports changed redaction and normalisation rules", () => {
    const after = JEVY.replace("[/sk_live_\\w+/]", "[]").replace(
      '["uuid"]',
      '["uuid", "long-digits"]',
    );
    expect(jevy(JEVY, after)).toMatchObject([
      {
        kind: "redaction-rules-changed",
        severity: "review",
        line: 8,
        before: "[/sk_live_\\w+/]",
        after: "[]",
      },
      { kind: "normalise-rules-changed", severity: "review", line: 9 },
    ]);
  });

  it("reports a changed decider", () => {
    const after = JEVY.replace('use: "jev"', 'use: "kev"');
    expect(kinds(jevy(JEVY, after))).toEqual(["decider-changed"]);
    const deciders = JEVY.replace(
      "  thresholds:",
      '  deciders: { kev: { model: "kev-4b@v1.0" } },\n  thresholds:',
    );
    expect(kinds(jevy(JEVY, deciders))).toEqual(["decider-changed"]);
  });

  it("reports any other change, and non-literal values, as config-changed", () => {
    const after = JEVY.replace('mode: "replay"', "mode: process.env.MODE");
    expect(jevy(JEVY, after)).toMatchObject([
      {
        kind: "config-changed",
        severity: "review",
        message: "cache.mode changed",
        before: '"replay"',
        after: "process.env.MODE",
      },
    ]);
  });

  it("reports a changed protect list as a protected path change", () => {
    const listed = JEVY.replace(
      "  thresholds:",
      '  protect: ["tests/critical/**", "docs/plan.md"],\n  thresholds:',
    );
    const shorter = listed.replace(', "docs/plan.md"', "");
    expect(jevy(listed, shorter)).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "jevy.config.ts",
        line: 5,
        message: "protect changed",
        before: '["tests/critical/**", "docs/plan.md"]',
        after: '["tests/critical/**"]',
      },
    ]);
    // Growing the list, or swapping one element, is a change to it as well.
    expect(jevy(shorter, listed)).toMatchObject([
      { kind: "protected-path-changed", message: "protect changed" },
    ]);
    expect(
      jevy(listed, listed.replace("tests/critical/**", "tests/crit/**")),
    ).toMatchObject([
      { kind: "protected-path-changed", message: "protect changed" },
    ]);
    expect(jevy(listed, listed.replace('"docs/plan.md"]', "...more]"))).toEqual(
      [
        {
          kind: "protected-path-changed",
          severity: "weakening",
          file: "jevy.config.ts",
          line: 5,
          message: "protect changed",
          before: '["tests/critical/**", "docs/plan.md"]',
          after: '["tests/critical/**", ...more]',
        },
      ],
    );
  });

  it("reports protect added or removed", () => {
    const listed = JEVY.replace(
      "  thresholds:",
      '  protect: ["tests/critical/**"],\n  thresholds:',
    );
    expect(jevy(JEVY, listed)).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "jevy.config.ts",
        line: 5,
        message: "protect added",
        after: '["tests/critical/**"]',
      },
    ]);
    expect(jevy(listed, JEVY)).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "jevy.config.ts",
        line: 5,
        message: "protect removed",
        before: '["tests/critical/**"]',
      },
    ]);
  });

  it("reports protect once however it is written, and not for reformatting", () => {
    const listed = JEVY.replace(
      "  thresholds:",
      '  protect: ["a/**", "b/**"],\n  thresholds:',
    );
    const reformatted = listed.replace(
      '["a/**", "b/**"]',
      "[\n    'a/**',\n    'b/**',\n  ]",
    );
    expect(jevy(listed, reformatted)).toEqual([]);
    // An object is not a valid list, but a change to it is still one finding.
    const object = listed.replace('["a/**", "b/**"]', "{ a: 1, b: 2 }");
    expect(kinds(jevy(listed, object))).toEqual(["protected-path-changed"]);
    expect(
      jevy(object, object.replace("{ a: 1, b: 2 }", "{ a: 2, b: 3 }")),
    ).toMatchObject([
      { kind: "protected-path-changed", message: "protect changed" },
    ]);
    // A key that merely starts with the same letters is not the protect key.
    const other = JEVY.replace(
      "  thresholds:",
      "  protected: true,\n  thresholds:",
    );
    expect(jevy(JEVY, other)).toMatchObject([
      { kind: "config-changed", message: "protected added" },
    ]);
  });

  it("reports needsReview.pr removed after fail, since the default is warn", () => {
    const after = JEVY.replace('pr: "fail", ', "");
    expect(jevy(JEVY, after)).toMatchObject([
      {
        kind: "needs-review-relaxed",
        severity: "weakening",
        message:
          'ci.needsReview.pr relaxed from "fail" to "warn" (removed; the default is "warn")',
      },
    ]);
    const noCi = JEVY.replace(
      '  ci: { needsReview: { pr: "fail", main: "fail" } },\n',
      "",
    );
    expect(kinds(jevy(JEVY, noCi))).toEqual([
      "config-changed",
      "needs-review-relaxed",
    ]);
  });

  it("reports a change to code the config object reads, outside it", () => {
    const before =
      "const PASS = 0.8;\nconst thresholds = { pass: PASS };\nexport default defineConfig({ thresholds });\n";
    const lowered = before.replace("PASS = 0.8", "PASS = 0.5");
    expect(jevy(before, lowered)).toMatchObject([
      {
        kind: "config-changed",
        severity: "review",
        message:
          "code outside the config object changed (a constant, import or helper it may read); review it by hand",
      },
    ]);
    const helper = before.replace(
      "const thresholds = { pass: PASS };",
      "const thresholds = { pass: PASS - 0.3 };",
    );
    expect(kinds(jevy(before, helper))).toEqual(["config-changed"]);
    // Formatting and comments outside the object are still not a change.
    expect(
      jevy(before, `// tuned\n${before.replace("PASS = 0.8", "PASS = 0.80")}`),
    ).toEqual([]);
  });

  it("does not compare a non-literal threshold as a number", () => {
    const after = JEVY.replace("pass: 0.8", "pass: PASS");
    expect(kinds(jevy(JEVY, after))).toEqual(["config-changed"]);
  });

  it("finds nothing for reformatting, comments or reordered keys", () => {
    const after = `import { defineConfig } from "@jevyjs/core";
// tuned by hand
export default defineConfig({
  normalise: { builtins: [ "uuid" ] },
  redact: [ /sk_live_\\w+/ ],
  ci: { needsReview: { main: "fail", pr: 'fail' } },
  cache: { mode: "replay", dir: ".jevy/decisions" },
  thresholds: { fail: 0.50, pass: 0.80 },
  decider: { use: "jev", fallback: ["kev"] },
});
`;
    expect(jevy(JEVY, after)).toEqual([]);
  });

  it("reads a default-exported object and a named const", () => {
    const plain = "export default { thresholds: { pass: 0.8 } };";
    const named =
      "const config = { thresholds: { pass: 0.7 } } satisfies JevyConfig;\nexport default config;";
    // The export itself was restructured, so that is reported for review too.
    expect(kinds(jevy(plain, named))).toEqual([
      "config-changed",
      "threshold-lowered",
    ]);
    const renamed = named.replace(/config/g, "settings");
    expect(kinds(jevy(named, renamed.replace("0.7", "0.6")))).toEqual([
      "config-changed",
      "threshold-lowered",
    ]);
    expect(kinds(jevy(named, named.replace("pass: 0.7", "pass: 0.6")))).toEqual(
      ["threshold-lowered"],
    );
  });

  it("reports a config it cannot read for review", () => {
    expect(jevy(JEVY, "export default defineConfig({")).toMatchObject([
      {
        kind: "config-changed",
        severity: "review",
        message: expect.stringMatching(
          /^head version could not be parsed \(line \d+: .+\)$/,
        ) as string,
      },
    ]);
    expect(
      jevy(JEVY, "export default makeConfig();\n// changed"),
    ).toMatchObject([
      {
        kind: "config-changed",
        message:
          "head version has no object literal passed to defineConfig or default-exported; review it by hand",
      },
    ]);
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__defineGetter__",
  ])(
    "gives a known kind and a severity to a change under the key %s",
    (key) => {
      const config = (checks: string): string =>
        `export default defineConfig({ ${key}: { checks: ${checks} }, "ci.needsReview.pr": 1 });\n`;
      const findings = jevy(config('["pnpm test"]'), config("[]"));
      expect(findings).toEqual([
        {
          kind: "config-changed",
          severity: "review",
          file: "jevy.config.ts",
          line: 1,
          message: `${key}.checks changed`,
          before: '["pnpm test"]',
          after: "[]",
        },
      ]);
      for (const finding of findings) {
        expect(Object.hasOwn(SEVERITY, finding.kind)).toBe(true);
        expect(finding.severity).toBe(SEVERITY[finding.kind]);
      }
      const report = buildReport("main", "working-tree", findings);
      expect(report.summary).toEqual({ weakening: 0, review: 1, info: 0 });
      expect(() => formatHuman(report)).not.toThrow();
    },
  );

  it("reports a config too deeply nested to analyse, instead of throwing", () => {
    const deep = `export default defineConfig({ thresholds: { pass: ${"(".repeat(20000)}0.8${")".repeat(20000)} } });\n`;
    for (const [before, after] of [
      [JEVY, deep],
      [deep, JEVY],
      [deep, deep.replace("0.8", "0.5")],
    ] as const) {
      expect(jevy(before, after)).toEqual([
        {
          kind: "config-changed",
          severity: "review",
          file: "jevy.config.ts",
          message: expect.stringMatching(
            /^the change could not be analysed \(.+\); review it by hand$/,
          ) as string,
        },
      ]);
    }
  });

  it("reports an added or removed config for review", () => {
    expect(kinds(jevy(null, JEVY))).toEqual(["config-changed"]);
    expect(jevy(JEVY, null)).toMatchObject([
      {
        kind: "config-changed",
        message: "jevy config removed; the defaults now apply",
      },
    ]);
  });
});

describe("diffPlaywrightConfig", () => {
  const PW = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  retries: process.env.CI ? 1 : 0,
  projects: [{ name: "chromium", retries: 0 }],
});
`;

  function pw(before: string | null, after: string | null): Finding[] {
    return [
      ...diffPlaywrightConfig({ file: "playwright.config.ts", before, after }),
    ];
  }

  it("reports raised retries", () => {
    expect(pw(PW, PW.replace("CI ? 1 : 0", "CI ? 3 : 0"))).toEqual([
      {
        kind: "retries-raised",
        severity: "review",
        file: "playwright.config.ts",
        line: 3,
        message: "retries raised from 1 to 3",
        before: "1",
        after: "3",
      },
    ]);
    expect(kinds(pw(PW, PW.replace("retries: 0 }", "retries: 2 }")))).toEqual([
      "retries-raised",
    ]);
  });

  it("treats a new retries setting as raised from Playwright's default of 0", () => {
    const before = "export default defineConfig({});";
    const after = "export default defineConfig({ retries: 2 });";
    expect(kinds(pw(before, after))).toEqual(["retries-raised"]);
  });

  it("finds nothing for lowered retries or reformatting", () => {
    expect(pw(PW, PW.replace("CI ? 1 : 0", "CI ? 0 : 0"))).toEqual([]);
    expect(pw(PW, PW.replace("retries: 0 }", "retries: 0, }"))).toEqual([]);
  });

  it("reports retries it cannot read, and changed test selection, for review", () => {
    expect(
      kinds(pw(PW, PW.replace("CI ? 1 : 0", "Number(process.env.RETRIES)"))),
    ).toEqual(["config-changed"]);
    const ignored = PW.replace(
      "  projects:",
      '  testIgnore: ["**/checkout.spec.ts"],\n  projects:',
    );
    expect(pw(PW, ignored)).toMatchObject([
      { kind: "config-changed", message: "testIgnore changed", line: 4 },
    ]);
  });

  it("reports a config that does not parse for review", () => {
    expect(kinds(pw(PW, "export default {"))).toEqual(["config-changed"]);
  });

  it("reports a config too deeply nested to analyse, instead of throwing", () => {
    const deep = `export default defineConfig({ retries: ${"(".repeat(20000)}2${")".repeat(20000)} });\n`;
    for (const [before, after] of [
      [PW, deep],
      [deep, PW],
      [null, deep],
    ] as const) {
      expect(pw(before, after)).toEqual([
        {
          kind: "config-changed",
          severity: "review",
          file: "playwright.config.ts",
          message: expect.stringMatching(
            /^the change could not be analysed \(.+\); review it by hand$/,
          ) as string,
        },
      ]);
    }
  });
});
