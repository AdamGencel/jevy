import { describe, expect, it } from "vitest";
import { diffJevyConfig, diffPlaywrightConfig } from "./diff-config.js";
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
});
