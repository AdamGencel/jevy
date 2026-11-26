import { describe, expect, it } from "vitest";
import { readConfigSettings, type ConfigSettings } from "./config-source.js";
import { GuardError } from "./errors.js";
import type { FileChange } from "./git.js";
import {
  buildProtectRules,
  protectedPathFindings,
  protectionOf,
  type ProtectRules,
} from "./protect.js";

const RULES: ProtectRules = {
  globDir: "",
  globs: ["tests/critical/**", "docs/plan.md", "tests/**"],
  cacheDir: ".jevy/decisions",
  policyFile: "wallet-policy.ts",
};

const NO_CONFIG: ProtectRules = {
  globDir: "",
  globs: [],
  cacheDir: ".jevy/decisions",
  policyFile: null,
};

function settings(overrides: Partial<ConfigSettings>): ConfigSettings {
  return {
    cacheDir: null,
    guardTests: null,
    protect: null,
    checks: null,
    web3Policy: null,
    mainBranch: null,
    unreadable: [],
    ...overrides,
  };
}

function added(path: string): FileChange {
  return { status: "added", path, oldPath: path };
}

function modified(path: string): FileChange {
  return { status: "modified", path, oldPath: path };
}

function deleted(path: string): FileChange {
  return { status: "deleted", path, oldPath: path };
}

function renamed(oldPath: string, path: string): FileChange {
  return { status: "renamed", path, oldPath };
}

describe("protectionOf", () => {
  it("protects every jevy.config.* by file name, in any directory", () => {
    for (const path of [
      "jevy.config.ts",
      "jevy.config.mts",
      "jevy.config.js",
      "jevy.config.mjs",
      "packages/app/jevy.config.ts",
      "node_modules/x/jevy.config.js",
    ]) {
      expect(protectionOf(path, NO_CONFIG)).toEqual({ reason: "config" });
    }
    for (const path of [
      "jevy.config.json",
      "jevy.config.ts.bak",
      "my-jevy.config.ts",
      "jevy.config.ts/notes.md",
      "playwright.config.ts",
    ]) {
      expect(protectionOf(path, NO_CONFIG)).toBeNull();
    }
  });

  it("protects the config whatever the case of its name", () => {
    // On a case-insensitive file system `Jevy.Config.ts` is the same file.
    expect(protectionOf("Jevy.Config.TS", NO_CONFIG)).toEqual({
      reason: "config",
    });
  });

  it("protects everything under the decision cache directory", () => {
    for (const path of [
      ".jevy/decisions/checkout.jsonl",
      ".jevy/decisions/a/b/c.jsonl",
      ".jevy/decisions/README.md",
      ".jevy/decisions",
    ]) {
      expect(protectionOf(path, NO_CONFIG)).toEqual({ reason: "cache" });
    }
    expect(protectionOf(".jevy/decisions-old/a.jsonl", NO_CONFIG)).toBeNull();
    expect(protectionOf(".jevy/other.jsonl", NO_CONFIG)).toBeNull();
    expect(protectionOf("x/.jevy/decisions/a.jsonl", NO_CONFIG)).toBeNull();
  });

  it("protects the wallet policy file, and only that file", () => {
    expect(protectionOf("wallet-policy.ts", RULES)).toEqual({
      reason: "policy",
    });
    expect(protectionOf("src/wallet-policy.ts", RULES)).toBeNull();
    expect(protectionOf("wallet-policy.ts", NO_CONFIG)).toBeNull();
  });

  it("protects a listed path and names the first glob that matches", () => {
    expect(protectionOf("tests/critical/pay.spec.ts", RULES)).toEqual({
      reason: "listed",
      glob: "tests/critical/**",
    });
    expect(protectionOf("tests/other.spec.ts", RULES)).toEqual({
      reason: "listed",
      glob: "tests/**",
    });
    expect(protectionOf("docs/plan.md", RULES)).toEqual({
      reason: "listed",
      glob: "docs/plan.md",
    });
    expect(protectionOf("src/app.ts", RULES)).toBeNull();
  });

  it("prefers config, then cache, then policy, then the list", () => {
    const rules: ProtectRules = {
      globDir: "",
      globs: ["**"],
      cacheDir: "cache",
      policyFile: "cache/policy.ts",
    };
    expect(protectionOf("cache/jevy.config.ts", rules)).toEqual({
      reason: "config",
    });
    expect(protectionOf("cache/policy.ts", rules)).toEqual({ reason: "cache" });
    expect(
      protectionOf("policy.ts", { ...rules, policyFile: "policy.ts" }),
    ).toEqual({ reason: "policy" });
    expect(protectionOf("src/a.ts", rules)).toEqual({
      reason: "listed",
      glob: "**",
    });
  });

  it("normalises the path before matching, so ./ and .. cannot dodge a rule", () => {
    expect(protectionOf("./jevy.config.ts", NO_CONFIG)).toEqual({
      reason: "config",
    });
    expect(protectionOf("src/../.jevy/decisions/a.jsonl", NO_CONFIG)).toEqual({
      reason: "cache",
    });
    expect(protectionOf("tests/x/../critical//a.ts", RULES)).toEqual({
      reason: "listed",
      glob: "tests/critical/**",
    });
  });

  it("answers null for a path that names nothing", () => {
    expect(protectionOf("", RULES)).toBeNull();
    expect(protectionOf(".", RULES)).toBeNull();
    expect(protectionOf("a/..", RULES)).toBeNull();
  });

  it("refuses a path that climbs out of the repository rather than calling it unprotected", () => {
    // `../jevy/jevy.config.ts` from a repository in `jevy/` is its own config.
    for (const path of [
      "../jevy/jevy.config.ts",
      "../jevy.config.ts",
      "a/../../tests/x.ts",
      "..",
      "a\\..\\..\\tests\\critical\\a.ts",
    ]) {
      expect(() => protectionOf(path, RULES), path).toThrow(GuardError);
      expect(() => protectionOf(path, RULES), path).toThrow(
        /climbs out of the repository/,
      );
    }
  });

  it("matches whatever the case of the path: on macOS and Windows it is the same file", () => {
    const rules: ProtectRules = {
      globDir: "",
      globs: ["tests/critical/**", "Docs/Plan.md"],
      cacheDir: ".jevy/decisions",
      policyFile: "wallet/policy.json",
    };
    expect(protectionOf("Tests/Critical/a.spec.ts", rules)).toEqual({
      reason: "listed",
      glob: "tests/critical/**",
    });
    expect(protectionOf("TESTS/CRITICAL/A.SPEC.TS", rules)).toEqual({
      reason: "listed",
      glob: "tests/critical/**",
    });
    expect(protectionOf("docs/plan.md", rules)).toEqual({
      reason: "listed",
      glob: "Docs/Plan.md",
    });
    expect(protectionOf(".JEVY/decisions/x.jsonl", rules)).toEqual({
      reason: "cache",
    });
    expect(protectionOf(".jevy/Decisions", rules)).toEqual({ reason: "cache" });
    expect(protectionOf("Wallet/Policy.json", rules)).toEqual({
      reason: "policy",
    });
    expect(protectionOf("sub/JEVY.CONFIG.MJS", rules)).toEqual({
      reason: "config",
    });
    // Folding widens a match; it does not join what was apart.
    expect(protectionOf("Tests/Criticalx/a.spec.ts", rules)).toBeNull();
    expect(protectionOf(".JEVY/decisions-old/x.jsonl", rules)).toBeNull();
    expect(protectionOf("Wallet/Policy.json.bak", rules)).toBeNull();
  });

  it("matches whatever the Unicode form of the path: APFS reads both as one file", () => {
    const rules: ProtectRules = {
      globDir: "",
      globs: ["src/caf\u00e9/**", "docs/re\u0301sume\u0301.md"],
      cacheDir: "cach\u00e9/decisions",
      policyFile: "polic\u00e9.json",
    };
    expect(protectionOf("src/cafe\u0301/a.ts", rules)).toEqual({
      reason: "listed",
      glob: "src/caf\u00e9/**",
    });
    expect(protectionOf("SRC/CAFE\u0301/a.ts", rules)).toEqual({
      reason: "listed",
      glob: "src/caf\u00e9/**",
    });
    expect(protectionOf("docs/r\u00e9sum\u00e9.md", rules)).toEqual({
      reason: "listed",
      glob: "docs/re\u0301sume\u0301.md",
    });
    expect(protectionOf("cache\u0301/decisions/x.jsonl", rules)).toEqual({
      reason: "cache",
    });
    expect(protectionOf("police\u0301.json", rules)).toEqual({
      reason: "policy",
    });
    expect(protectionOf("src/cafe/a.ts", rules)).toBeNull();
  });

  it("still matches what it matched before folding, when folding changes a length", () => {
    // Upper-casing turns one "\u00df" into two letters; `?` must still see one.
    const rules: ProtectRules = { ...NO_CONFIG, globs: ["stra?e/**"] };
    expect(protectionOf("stra\u00dfe/a.ts", rules)).toEqual({
      reason: "listed",
      glob: "stra?e/**",
    });
  });

  it("reads a backslash as a path separator", () => {
    expect(protectionOf("sub\\jevy.config.ts", NO_CONFIG)).toEqual({
      reason: "config",
    });
    expect(protectionOf(".jevy\\decisions\\x.jsonl", NO_CONFIG)).toEqual({
      reason: "cache",
    });
    expect(protectionOf("tests\\critical/a.spec.ts", RULES)).toEqual({
      reason: "listed",
      glob: "tests/critical/**",
    });
    expect(protectionOf("src\\..\\wallet-policy.ts", RULES)).toEqual({
      reason: "policy",
    });
  });

  it("refuses an absolute path rather than calling it unprotected", () => {
    expect(() => protectionOf("/repo/jevy.config.ts", NO_CONFIG)).toThrow(
      GuardError,
    );
    expect(() => protectionOf("C:/repo/tests/a.ts", RULES)).toThrow(
      /repository-relative/,
    );
    expect(() => protectionOf("C:\\repo\\tests\\a.ts", RULES)).toThrow(
      /repository-relative/,
    );
    // A backslash root and a drive letter without a slash are Windows paths
    // that leave the repository too.
    for (const path of [
      "\\jevy.config.ts",
      "\\\\server\\share\\jevy.config.ts",
      "C:jevy.config.ts",
      "c:tests/critical/a.ts",
    ]) {
      expect(() => protectionOf(path, RULES), path).toThrow(GuardError);
      expect(() => protectionOf(path, RULES), path).toThrow(
        /repository-relative/,
      );
    }
  });
});

describe("buildProtectRules", () => {
  it("protects the cache directory alone when there is no config", () => {
    expect(
      buildProtectRules({
        settings: null,
        configDir: "",
        cacheDir: ".jevy/decisions",
      }),
    ).toEqual({
      globDir: "",
      globs: [],
      cacheDir: ".jevy/decisions",
      policyFile: null,
    });
  });

  it("takes globs and the policy as written for a config at the root", () => {
    expect(
      buildProtectRules({
        settings: settings({
          protect: ["tests/critical/**", "./docs/plan.md"],
          web3Policy: "./wallet-policy.ts",
        }),
        configDir: "",
        cacheDir: "./.jevy/decisions/",
      }),
    ).toEqual({
      globDir: "",
      globs: ["tests/critical/**", "docs/plan.md"],
      cacheDir: ".jevy/decisions",
      policyFile: "wallet-policy.ts",
    });
  });

  it("resolves globs and the policy against the config's directory", () => {
    expect(
      buildProtectRules({
        settings: settings({
          protect: [
            "tests/critical/**",
            "./e2e/*.spec.ts",
            "**/*.snap",
            ".//docs/",
          ],
          web3Policy: "./wallet-policy.ts",
        }),
        configDir: "packages/app",
        cacheDir: "packages/app/.jevy/decisions",
      }),
    ).toEqual({
      // The directory is kept apart from the globs: it is literal text.
      globDir: "packages/app",
      globs: ["tests/critical/**", "e2e/*.spec.ts", "**/*.snap", "docs"],
      cacheDir: "packages/app/.jevy/decisions",
      policyFile: "packages/app/wallet-policy.ts",
    });
    expect(
      buildProtectRules({
        settings: settings({ web3Policy: "config/../../shared/./policy.ts" }),
        configDir: "./packages/app/",
        cacheDir: ".jevy/decisions",
      }).policyFile,
    ).toBe("packages/shared/policy.ts");
  });

  it("produces rules that protectionOf honours", () => {
    const rules = buildProtectRules({
      settings: readConfigSettings(
        `export default defineConfig({ protect: ["tests/critical"], web3: { policy: "./wallet-policy.ts" } });`,
        "jevy.config.ts",
      ),
      configDir: "packages/app",
      cacheDir: "packages/app/.jevy/decisions",
    });
    expect(
      protectionOf("packages/app/tests/critical/a/b.spec.ts", rules),
    ).toEqual({ reason: "listed", glob: "packages/app/tests/critical" });
    expect(protectionOf("tests/critical/a.spec.ts", rules)).toBeNull();
    expect(protectionOf("packages/app/wallet-policy.ts", rules)).toEqual({
      reason: "policy",
    });
    expect(protectionOf("wallet-policy.ts", rules)).toBeNull();
  });

  it("reads the config's directory as literal text, whatever characters it has", () => {
    const under = (configDir: string): ProtectRules =>
      buildProtectRules({
        settings: settings({ protect: ["tests/**"] }),
        configDir,
        cacheDir: ".jevy/decisions",
      });
    const braces = under("{a}");
    expect(protectionOf("{a}/tests/x.ts", braces)).toEqual({
      reason: "listed",
      glob: "{a}/tests/**",
    });
    expect(protectionOf("a/tests/x.ts", braces)).toBeNull();
    const star = under("pkg*");
    expect(protectionOf("pkg*/tests/x.ts", star)).not.toBeNull();
    expect(protectionOf("pkgOTHER/tests/x.ts", star)).toBeNull();
    const route = under("app/[id]");
    expect(protectionOf("app/[id]/tests/x.ts", route)).not.toBeNull();
    expect(protectionOf("app/i/tests/x.ts", route)).toBeNull();
    const bang = under("!x");
    expect(protectionOf("!x/tests/x.ts", bang)).not.toBeNull();
    const two = under("a,b/{c,d}?");
    expect(protectionOf("a,b/{c,d}?/tests/x.ts", two)).not.toBeNull();
    expect(protectionOf("a,b/c1/tests/x.ts", two)).toBeNull();
    // The directory itself, and what lies beside it, is not listed.
    expect(protectionOf("{a}", braces)).toBeNull();
    expect(protectionOf("{a}/src/x.ts", braces)).toBeNull();
    expect(protectionOf("tests/x.ts", braces)).toBeNull();
  });

  it("refuses a .. segment anywhere in a protect entry, as core's loader does", () => {
    for (const entry of ["../shared/**", "../..//docs/", "..", "a/../b"]) {
      const build = (): ProtectRules =>
        buildProtectRules({
          settings: settings({ protect: [entry] }),
          configDir: "packages/app",
          cacheDir: ".jevy/decisions",
        });
      expect(build, entry).toThrow(GuardError);
      expect(build, entry).toThrow(/"\.\." segment/);
    }
  });

  it("refuses an entry that names the config's own directory", () => {
    expect(() =>
      buildProtectRules({
        settings: settings({ protect: ["."] }),
        configDir: "packages/app",
        cacheDir: ".jevy/decisions",
      }),
    ).toThrow(/protect entry "\.".*names the config's own directory.*"\*\*"/);
  });

  it.each([
    ["../x", "", /protect entry "\.\.\/x".*"\.\." segment/],
    ["../../../x", "packages/app", /protect entry "\.\.\/\.\.\/\.\.\/x"/],
    ["/etc/passwd", "", /protect entry "\/etc\/passwd".*absolute/],
    ["/etc/passwd", "packages/app", /protect entry "\/etc\/passwd".*absolute/],
    ["!tests/**", "packages/app", /protect entry "!tests\/\*\*".*negation/],
    ["../!tests/**", "packages/app", /protect entry "\.\.\/!tests.*segment/],
    ["./!tests/**", "packages/app", /protect entry "\.\/!tests.*negation/],
    ["./C:x", "", /protect entry "\.\/C:x".*absolute/],
    ["tests/+(a|b)", "", /protect entry "tests\/\+\(a\|b\)".*extended glob/],
    [" tests/**", "", /protect entry " tests\/\*\*".*whitespace/],
    ["", "packages/app", /protect entry "".*empty/],
    ["tests/../../x", "packages/app", /protect entry "tests\/\.\.\/\.\.\/x"/],
    ["src/[id]/**", "", /protect entry "src\/\[id\]\/\*\*".*character class/],
    [".", "", /protect entry "\.".*repository root/],
    ["..", "packages", /protect entry "\.\.".*"\.\." segment/],
  ])(
    "throws for the protect entry %j with the config in %j",
    (entry, configDir, message) => {
      const build = (): ProtectRules =>
        buildProtectRules({
          settings: settings({ protect: ["ok/**", entry] }),
          configDir,
          cacheDir: ".jevy/decisions",
        });
      expect(build).toThrow(GuardError);
      expect(build).toThrow(message);
    },
  );

  it.each([
    ["../wallet-policy.ts", "", /web3\.policy "\.\.\/wallet-policy\.ts"/],
    ["a/../../../../p.ts", "packages/app", /outside the repository/],
    ["/abs/policy.ts", "packages/app", /web3\.policy "\/abs\/policy\.ts"/],
    ["C:/abs/policy.ts", "", /absolute/],
    [".\\policy.ts", "", /backslash/],
    ["", "", /web3\.policy "".*empty/],
    ["./", "", /names no file/],
  ])(
    "throws for the policy path %j with the config in %j",
    (policy, configDir, message) => {
      const build = (): ProtectRules =>
        buildProtectRules({
          settings: settings({ web3Policy: policy }),
          configDir,
          cacheDir: ".jevy/decisions",
        });
      expect(build).toThrow(GuardError);
      expect(build).toThrow(message);
    },
  );

  it.each(["", ".", "./", "../cache", "/abs/cache", "a/../.."])(
    "throws for the cache directory %j: it must be a directory inside the repository",
    (cacheDir) => {
      expect(() =>
        buildProtectRules({ settings: null, configDir: "", cacheDir }),
      ).toThrow(GuardError);
    },
  );

  it("throws for a config directory outside the repository", () => {
    for (const configDir of ["..", "/abs", "a/../.."]) {
      expect(() =>
        buildProtectRules({
          settings: null,
          configDir,
          cacheDir: ".jevy/decisions",
        }),
      ).toThrow(GuardError);
    }
  });
});

describe("protectedPathFindings", () => {
  it("reports added, modified and deleted protected files", () => {
    expect(
      protectedPathFindings(
        [
          added("tests/critical/new.spec.ts"),
          modified("jevy.config.ts"),
          deleted("wallet-policy.ts"),
          modified("src/app.ts"),
          added(".jevy/decisions/notes.md"),
        ],
        RULES,
      ),
    ).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "tests/critical/new.spec.ts",
        message:
          'protected path changed (added): matches "tests/critical/**" in protect; a person must approve this change',
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "jevy.config.ts",
        message:
          "protected path changed (modified): matches the Jevy config; a person must approve this change",
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "wallet-policy.ts",
        message:
          "protected path changed (deleted): matches the wallet policy; a person must approve this change",
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: ".jevy/decisions/notes.md",
        message:
          "protected path changed (added): matches the decision cache; a person must approve this change",
      },
    ]);
  });

  it("reports a rename when the old path is protected", () => {
    expect(
      protectedPathFindings(
        [renamed("tests/critical/pay.spec.ts", "attic/pay.spec.ts")],
        { ...RULES, globs: ["tests/critical/**"] },
      ),
    ).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "attic/pay.spec.ts",
        message:
          'protected path changed (renamed from tests/critical/pay.spec.ts to attic/pay.spec.ts): matches "tests/critical/**" in protect (old path); a person must approve this change',
      },
    ]);
  });

  it("reports a rename when only the new path is protected", () => {
    expect(
      protectedPathFindings(
        [renamed("old.config.ts", "jevy.config.ts")],
        RULES,
      ),
    ).toMatchObject([
      {
        file: "jevy.config.ts",
        message:
          "protected path changed (renamed from old.config.ts to jevy.config.ts): matches the Jevy config (new path); a person must approve this change",
      },
    ]);
  });

  it("reports one finding for a rename with both paths protected", () => {
    expect(
      protectedPathFindings(
        [
          renamed("tests/critical/a.spec.ts", "tests/critical/b.spec.ts"),
          renamed("tests/critical/c.spec.ts", "tests/c.spec.ts"),
        ],
        RULES,
      ).map((finding) => finding.message),
    ).toEqual([
      'protected path changed (renamed from tests/critical/a.spec.ts to tests/critical/b.spec.ts): matches "tests/critical/**" in protect (old and new path); a person must approve this change',
      'protected path changed (renamed from tests/critical/c.spec.ts to tests/c.spec.ts): matches "tests/critical/**" in protect (old path) and "tests/**" in protect (new path); a person must approve this change',
    ]);
  });

  it("does not report decision records: the guard compares those itself", () => {
    expect(
      protectedPathFindings(
        [
          added(".jevy/decisions/checkout.jsonl"),
          modified(".jevy/decisions/deep/er/pay.jsonl"),
          deleted(".jevy/decisions/gone.jsonl"),
          renamed(".jevy/decisions/a.jsonl", ".jevy/decisions/b.jsonl"),
        ],
        RULES,
      ),
    ).toEqual([]);
    // The pre-edit hook still sees them as protected.
    expect(protectionOf(".jevy/decisions/checkout.jsonl", RULES)).toEqual({
      reason: "cache",
    });
  });

  it("reports anything else under the cache directory", () => {
    expect(
      protectedPathFindings(
        [
          added(".jevy/decisions/README.md"),
          modified(".jevy/decisions/checkout.JSONL"),
          renamed(".jevy/decisions/a.jsonl", "attic/a.jsonl.bak"),
          renamed(".jevy/decisions/a.jsonl", ".jevy/decisions/a.txt"),
        ],
        NO_CONFIG,
      ).map((finding) => finding.message),
    ).toEqual([
      "protected path changed (added): matches the decision cache; a person must approve this change",
      "protected path changed (modified): matches the decision cache; a person must approve this change",
      "protected path changed (renamed from .jevy/decisions/a.jsonl to .jevy/decisions/a.txt): matches the decision cache (new path); a person must approve this change",
    ]);
  });

  it("still reports a decision record that a protect glob names", () => {
    const rules: ProtectRules = {
      ...NO_CONFIG,
      globs: [".jevy/decisions/approved/**"],
    };
    expect(
      protectedPathFindings(
        [
          modified(".jevy/decisions/approved/pay.jsonl"),
          modified(".jevy/decisions/other.jsonl"),
        ],
        rules,
      ),
    ).toMatchObject([
      {
        file: ".jevy/decisions/approved/pay.jsonl",
        message:
          'protected path changed (modified): matches ".jevy/decisions/approved/**" in protect; a person must approve this change',
      },
    ]);
  });

  it("keeps the order of the changes and reports nothing for none", () => {
    const changes = [
      modified("tests/z.spec.ts"),
      modified("src/app.ts"),
      modified("docs/plan.md"),
      modified("tests/a.spec.ts"),
    ];
    expect(
      protectedPathFindings(changes, RULES).map((finding) => finding.file),
    ).toEqual(["tests/z.spec.ts", "docs/plan.md", "tests/a.spec.ts"]);
    expect(protectedPathFindings([], RULES)).toEqual([]);
    expect(protectedPathFindings([modified("src/app.ts")], RULES)).toEqual([]);
  });

  it("never throws for a path git reports, however odd its name", () => {
    // On Linux a directory may be named `C:`; git paths are always relative.
    expect(
      protectedPathFindings(
        [modified("C:/notes/jevy.config.ts"), added("C:\\x\\a.ts")],
        NO_CONFIG,
      ).map((finding) => finding.file),
    ).toEqual(["C:/notes/jevy.config.ts"]);
  });

  it("reports a change it cannot place, instead of throwing or passing it", () => {
    expect(
      protectedPathFindings(
        [
          modified("../jevy/jevy.config.ts"),
          renamed("a/../../x.ts", "src/x.ts"),
          renamed("src/y.ts", "..\\y.ts"),
          modified("src/app.ts"),
        ],
        RULES,
      ),
    ).toEqual([
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "../jevy/jevy.config.ts",
        message:
          'protected path could not be checked (modified): "../jevy/jevy.config.ts" climbs out of the repository, so it cannot be compared with the protected paths; a person must approve this change',
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "src/x.ts",
        message:
          'protected path could not be checked (renamed from a/../../x.ts to src/x.ts): "a/../../x.ts" climbs out of the repository, so it cannot be compared with the protected paths; a person must approve this change',
      },
      {
        kind: "protected-path-changed",
        severity: "weakening",
        file: "..\\y.ts",
        message:
          'protected path could not be checked (renamed from src/y.ts to ..\\y.ts): "..\\y.ts" climbs out of the repository, so it cannot be compared with the protected paths; a person must approve this change',
      },
    ]);
  });

  it("reports a protected path whatever its case, Unicode form or slashes", () => {
    expect(
      protectedPathFindings(
        [
          modified("Tests/Critical/pay.spec.ts"),
          modified(".JEVY/decisions/notes.md"),
          modified("sub\\Jevy.Config.ts"),
          modified("WALLET-POLICY.TS"),
        ],
        RULES,
      ).map((finding) => finding.message),
    ).toEqual([
      'protected path changed (modified): matches "tests/critical/**" in protect; a person must approve this change',
      "protected path changed (modified): matches the decision cache; a person must approve this change",
      "protected path changed (modified): matches the Jevy config; a person must approve this change",
      "protected path changed (modified): matches the wallet policy; a person must approve this change",
    ]);
  });

  it("exempts a decision record only under the exact path the guard compares", () => {
    // The record comparison reads `.jevy/decisions/*.jsonl` as written. A
    // record under another spelling of that directory is compared by nothing,
    // so it is reported here.
    expect(
      protectedPathFindings(
        [
          modified(".jevy/decisions/a.jsonl"),
          modified(".JEVY/Decisions/a.jsonl"),
          modified(".jevy\\decisions\\b.jsonl"),
        ],
        NO_CONFIG,
      ).map((finding) => finding.file),
    ).toEqual([".JEVY/Decisions/a.jsonl", ".jevy\\decisions\\b.jsonl"]);
  });

  it("adds no line, before or after", () => {
    const [finding] = protectedPathFindings([modified("docs/plan.md")], RULES);
    expect(Object.keys(finding ?? {})).toEqual([
      "kind",
      "severity",
      "file",
      "message",
    ]);
  });
});

describe("files the Jevy config imports", () => {
  function rulesFor(imports: readonly string[], configDir = ""): ProtectRules {
    return buildProtectRules({
      settings: settings({ imports }),
      configDir,
      cacheDir: ".jevy/decisions",
    });
  }

  it("protects each imported file as part of the config", () => {
    const rules = rulesFor(["thresholds.ts", "lib/shared.js"]);
    expect(protectionOf("thresholds.ts", rules)).toEqual({
      reason: "config",
      importedBy: "the Jevy config",
    });
    expect(protectionOf("Thresholds.TS", rules)?.reason).toBe("config");
    expect(protectionOf("lib/shared.js", rules)?.reason).toBe("config");
    expect(protectionOf("other.ts", rules)).toBeNull();
    expect(protectionOf("thresholds.ts", NO_CONFIG)).toBeNull();
  });

  it("protects every file an import without its TypeScript extension can load", () => {
    const rules = rulesFor(["lib/shared.js", "consts"]);
    for (const path of [
      "lib/shared.ts",
      "lib/shared.mts",
      "lib/shared.tsx",
      "consts.ts",
      "consts.js",
      "consts.json",
      "consts/index.ts",
      "consts/index.mjs",
    ]) {
      expect(protectionOf(path, rules)?.reason, path).toBe("config");
    }
    expect(protectionOf("lib/shared.json", rules)).toBeNull();
    expect(protectionOf("consts/other.ts", rules)).toBeNull();
  });

  it("takes the imports as already relative to the repository root", () => {
    const rules = rulesFor(["web/thresholds.ts"], "web");
    expect(protectionOf("web/thresholds.ts", rules)?.reason).toBe("config");
    expect(protectionOf("thresholds.ts", rules)).toBeNull();
  });

  it("refuses an import outside the repository, which it cannot protect", () => {
    expect(() => rulesFor(["../outside.ts"])).toThrow(GuardError);
    expect(() => rulesFor(["../outside.ts"])).toThrow(/outside the repository/);
  });

  it("reports a change to an imported file as a protected path", () => {
    const rules = rulesFor(["thresholds.ts"]);
    const [found] = protectedPathFindings([modified("thresholds.ts")], rules);
    expect(found?.kind).toBe("protected-path-changed");
    expect(found?.message).toContain("imported by the Jevy config");
  });

  it("reads the imports from the config's text", () => {
    const rules = buildProtectRules({
      settings: readConfigSettings(
        `import { PASS } from "./thresholds.ts";\nexport default { thresholds: { pass: PASS } };\n`,
        "web/jevy.config.ts",
      ),
      configDir: "web",
      cacheDir: "web/.jevy/decisions",
    });
    expect(protectionOf("web/thresholds.ts", rules)?.reason).toBe("config");
  });
});
