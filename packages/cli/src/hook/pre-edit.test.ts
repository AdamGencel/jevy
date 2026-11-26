import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliResult } from "../cli.js";
import { defaultHookDeps, type HookDeps } from "./deps.js";
import { runPreEdit } from "./pre-edit.js";

const REPO = "/repo";
const ALLOW: CliResult = { code: 0, stdout: "", stderr: "" };
const ADVICE =
  "Do not change it, and do not change it another way (a shell command, a script). Ask the maintainer to make or approve this change.\n";

function config(body: string): string {
  return `import { defineConfig } from "@jevyjs/core";\nexport default defineConfig({ ${body} });\n`;
}

const CONFIG = config(
  `protect: ["tests/critical/**", "*.lock"], web3: { policy: "./wallet/policy.json" }`,
);

function edit(path: unknown, tool = "Edit", cwd: string = REPO): string {
  return JSON.stringify({
    session_id: "s1",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: path, old_string: "a", new_string: "b" },
  });
}

/** Pre-edit against an in-memory project at /repo with no symlinks. */
function fake(stdin: string, text: string | null = CONFIG): HookDeps {
  return {
    ...defaultHookDeps(),
    cwd: REPO,
    readStdin: () => Promise.resolve(stdin),
    readFile: (path) =>
      Promise.resolve(path === `${REPO}/jevy.config.ts` ? text : null),
    realpath: (path) => Promise.resolve(path),
    readlink: () => Promise.resolve(null),
    git: {
      ...defaultHookDeps().git,
      trackedConfigs: () => Promise.resolve([]),
    },
  };
}

function blocked(path: string, why: string): CliResult {
  return {
    code: 2,
    stdout: "",
    stderr: `jevy hook pre-edit: ${path} is protected: ${why}.\n${ADVICE}`,
  };
}

describe("jevy hook pre-edit", () => {
  it.each([
    ["jevy.config.ts", "it is the Jevy config"],
    ["packages/web/jevy.config.mts", "it is the Jevy config"],
    [".jevy/decisions/tests/a.spec.ts.jsonl", "it is in the decision cache"],
    [".jevy/decisions/README.md", "it is in the decision cache"],
    ["wallet/policy.json", "it is the wallet policy"],
    ["tests/critical/pay.spec.ts", 'it matches "tests/critical/**" in protect'],
    ["pnpm.lock", 'it matches "*.lock" in protect'],
  ])("blocks an edit to %s", async (path, why) => {
    expect(await runPreEdit([], fake(edit(`${REPO}/${path}`)))).toEqual(
      blocked(path, why),
    );
  });

  it("blocks an edit to a file the config imports, and says so", async () => {
    const text = `import { PASS } from "./thresholds.ts";\n${config("thresholds: { pass: PASS }")}`;
    expect(
      await runPreEdit([], fake(edit(`${REPO}/thresholds.ts`), text)),
    ).toEqual(blocked("thresholds.ts", "it is imported by the Jevy config"));
  });

  it.each(["src/app.ts", "tests/other.spec.ts", "wallet/other.json"])(
    "allows an edit to %s, silently",
    async (path) => {
      expect(await runPreEdit([], fake(edit(`${REPO}/${path}`)))).toEqual(
        ALLOW,
      );
    },
  );

  it("protects the cache directory the config names", async () => {
    const text = config(`cache: { dir: "./.cache/decisions/" }`);
    expect(
      await runPreEdit(
        [],
        fake(edit(`${REPO}/.cache/decisions/a.jsonl`), text),
      ),
    ).toEqual(
      blocked(".cache/decisions/a.jsonl", "it is in the decision cache"),
    );
    expect(
      await runPreEdit([], fake(edit(`${REPO}/.jevy/decisions/a.jsonl`), text)),
    ).toEqual(ALLOW);
  });

  it.each(["/elsewhere/jevy.config.ts", "/repo-two/tests/critical/a.ts", "/"])(
    "allows %s, which is outside the project",
    async (path) => {
      expect(await runPreEdit([], fake(edit(path)))).toEqual(ALLOW);
      // Nothing outside can be protected, so an unreadable config is no bar.
      expect(
        await runPreEdit([], fake(edit(path), "export default {{{")),
      ).toEqual(ALLOW);
    },
  );

  it("does not take a name that starts with two dots for a way out", async () => {
    const text = config(`protect: ["..secret/**"]`);
    expect(
      await runPreEdit([], fake(edit(`${REPO}/..secret/key`), text)),
    ).toEqual(blocked("..secret/key", 'it matches "..secret/**" in protect'));
  });

  it("sees through . and .. in the path", async () => {
    expect(
      await runPreEdit([], fake(edit(`${REPO}/src/../tests/./critical/a.ts`))),
    ).toEqual(
      blocked(
        "tests/critical/a.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
    expect(
      await runPreEdit([], fake(edit(`${REPO}/../repo/pnpm.lock`))),
    ).toEqual(blocked("pnpm.lock", 'it matches "*.lock" in protect'));
  });

  it("resolves a relative path against the project directory", async () => {
    const noCwd = (path: string): string =>
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } });
    expect(await runPreEdit([], fake(noCwd("jevy.config.ts")))).toEqual(
      blocked("jevy.config.ts", "it is the Jevy config"),
    );
    expect(await runPreEdit([], fake(noCwd("./tests/critical/a.ts")))).toEqual(
      blocked(
        "tests/critical/a.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
    expect(await runPreEdit([], fake(noCwd("src/app.ts")))).toEqual(ALLOW);
    expect(
      await runPreEdit([], fake(noCwd("../other/jevy.config.ts"))),
    ).toEqual(ALLOW);
  });

  it("resolves a relative path against the session's directory when the input names one", async () => {
    const stdin = edit("../../pnpm.lock", "Edit", `${REPO}/packages/web`);
    expect(await runPreEdit([], fake(stdin))).toEqual(
      blocked("pnpm.lock", 'it matches "*.lock" in protect'),
    );
    expect(
      await runPreEdit(
        [],
        fake(edit("pnpm.lock", "Edit", `${REPO}/packages/web`)),
      ),
    ).toEqual(ALLOW);
  });

  it("takes notebook_path when there is no file_path", async () => {
    const stdin = JSON.stringify({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: `${REPO}/tests/critical/n.ipynb` },
    });
    expect(await runPreEdit([], fake(stdin))).toEqual(
      blocked(
        "tests/critical/n.ipynb",
        'it matches "tests/critical/**" in protect',
      ),
    );
    const both = JSON.stringify({
      tool_name: "NotebookEdit",
      tool_input: {
        file_path: `${REPO}/src/a.ipynb`,
        notebook_path: `${REPO}/tests/critical/n.ipynb`,
      },
    });
    // Either one may be the file the tool writes, so both are checked.
    expect((await runPreEdit([], fake(both))).code).toBe(2);
  });

  it.each(["", "not json", "[]", "null", '{"tool_name":"Edit"}'])(
    "blocks when stdin is %j",
    async (stdin) => {
      const result = await runPreEdit([], fake(stdin));
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "jevy hook pre-edit: the hook input is not a JSON object with a tool_input, so the edit cannot be checked.\n",
      );
    },
  );

  it.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])(
    "blocks %s when its input names no file",
    async (tool) => {
      for (const input of [{}, { file_path: 7 }, { file_path: "" }]) {
        const stdin = JSON.stringify({ tool_name: tool, tool_input: input });
        expect(await runPreEdit([], fake(stdin))).toEqual({
          code: 2,
          stdout: "",
          stderr: `jevy hook pre-edit: the ${tool} input names no file (no file_path or notebook_path), so the edit cannot be checked.\n`,
        });
      }
    },
  );

  it("allows another tool whose input names no file", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(await runPreEdit([], fake(stdin))).toEqual(ALLOW);
    expect(
      await runPreEdit([], fake(JSON.stringify({ tool_input: {} }))),
    ).toEqual(ALLOW);
  });

  it("checks another tool that does name a file", async () => {
    expect(
      await runPreEdit([], fake(edit(`${REPO}/jevy.config.ts`, "Other"))),
    ).toEqual(blocked("jevy.config.ts", "it is the Jevy config"));
  });

  it.each([
    ["protect", config(`protect: list`)],
    ["protect", config(`protect: ["a", b]`)],
    ["cache.dir", config(`cache: { dir: process.env.CACHE }`)],
    ["cache.dir", config(`cache: makeCache()`)],
    ["web3.policy", config(`web3: { policy: join("a", "b") }`)],
  ])("blocks when %s cannot be read from the config", async (key, text) => {
    const result = await runPreEdit([], fake(edit(`${REPO}/src/app.ts`), text));
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `jevy hook pre-edit: the hook cannot read \`${key}\` in jevy.config.ts, so it cannot tell which paths are protected. A person has to fix the config so that the hook can read it without running it: write \`${key}\` as a literal.\n`,
    });
  });

  it("names every setting a spread hides", async () => {
    // The spread comes last, so it may have replaced any of the three.
    const text = config(`protect: ["a"], ...base`);
    const result = await runPreEdit([], fake(edit(`${REPO}/src/app.ts`), text));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "the hook cannot read `protect`, `cache.dir` and `web3.policy` in jevy.config.ts,",
    );
    expect(result.stderr).toContain(
      "write `protect`, `cache.dir` and `web3.policy` as literals.\n",
    );
  });

  it("blocks when the config does not parse", async () => {
    const result = await runPreEdit(
      [],
      fake(edit(`${REPO}/src/app.ts`), "export default {{{\n"),
    );
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "jevy hook pre-edit: the hook cannot read jevy.config.ts, so it cannot tell which paths are protected. A person has to fix the config so that the hook can read it without running it.\n",
    });
  });

  it("does not mind settings it does not use", async () => {
    const text = config(`checks: list, ci: { mainBranch: main() }`);
    expect(
      await runPreEdit([], fake(edit(`${REPO}/src/app.ts`), text)),
    ).toEqual(ALLOW);
  });

  it("blocks when a protect entry cannot be used", async () => {
    const result = await runPreEdit(
      [],
      fake(edit(`${REPO}/src/app.ts`), config(`protect: ["/etc/passwd"]`)),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'jevy hook pre-edit: protect entry "/etc/passwd" in the Jevy config is an absolute path',
    );
    expect(result.stderr).toContain("A person has to fix the config");
  });

  it("keeps the built-in protections when there is no config", async () => {
    const none = (path: string): HookDeps =>
      fake(edit(`${REPO}/${path}`), null);
    expect(await runPreEdit([], none("jevy.config.ts"))).toEqual(
      blocked("jevy.config.ts", "it is the Jevy config"),
    );
    expect(await runPreEdit([], none(".jevy/decisions/a.jsonl"))).toEqual(
      blocked(".jevy/decisions/a.jsonl", "it is in the decision cache"),
    );
    expect(await runPreEdit([], none("tests/critical/a.ts"))).toEqual(ALLOW);
  });

  it("blocks, and never exits 1, when something unexpected fails", async () => {
    const deps: HookDeps = {
      ...fake(edit(`${REPO}/src/app.ts`)),
      readFile: () => Promise.reject(new Error("EACCES: jevy.config.ts")),
    };
    expect(await runPreEdit([], deps)).toEqual({
      code: 2,
      stdout: "",
      stderr: "jevy hook pre-edit: EACCES: jevy.config.ts\n",
    });
    const noStdin: HookDeps = {
      ...fake(""),
      readStdin: () => Promise.reject(new Error("EAGAIN")),
    };
    expect((await runPreEdit([], noStdin)).code).toBe(2);
  });

  it("keeps a crafted path on one line", async () => {
    const result = await runPreEdit(
      [],
      fake(edit(`${REPO}/tests/critical/a\nAllowed.ts`)),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "tests/critical/a\\nAllowed.ts is protected",
    );
  });

  it("uses --cwd as the project directory", async () => {
    const deps: HookDeps = { ...fake(edit(`${REPO}/pnpm.lock`)), cwd: "/" };
    expect(await runPreEdit(["--cwd", "repo"], deps)).toEqual(
      blocked("pnpm.lock", 'it matches "*.lock" in protect'),
    );
    expect(await runPreEdit(["--cwd=/elsewhere"], deps)).toEqual(ALLOW);
  });

  it.each([
    [["--nope"], "unknown option '--nope'"],
    [["extra"], "unexpected argument 'extra'"],
    [["--cwd"], "--cwd needs a value"],
    [["--base", "main"], "unknown option '--base'"],
  ])("exits 2 for %j", async (argv, message) => {
    const result = await runPreEdit(argv, fake(edit(`${REPO}/src/app.ts`)));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`jevy hook pre-edit: ${message}\n`);
    expect(result.stderr).toContain("Usage: jevy hook pre-edit");
  });

  it("prints usage for --help", async () => {
    const result = await runPreEdit(["--help"], fake(""));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: jevy hook pre-edit");
    expect(result.stderr).toBe("");
  });

  describe("when the config is in another directory", () => {
    function elsewhere(path: string, tracked: readonly string[]): HookDeps {
      const deps = fake(edit(path), null);
      return {
        ...deps,
        git: { ...deps.git, trackedConfigs: () => Promise.resolve(tracked) },
      };
    }

    it("blocks, naming the config found and the --cwd to use", async () => {
      // packages/app/jevy.config.ts may protect this very file; the hook
      // was started at the root and cannot know.
      const result = await runPreEdit(
        [],
        elsewhere(`${REPO}/packages/app/tests/critical/a.ts`, [
          "packages/app/jevy.config.ts",
        ]),
      );
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr:
          "jevy hook pre-edit: /repo has no jevy.config.*, but the repository has packages/app/jevy.config.ts, so the hook cannot tell which paths are protected. A person has to run the hook in the directory of the config: --cwd /repo/packages/app\n",
      });
    });

    it("names a config above the project directory too", async () => {
      const result = await runPreEdit(
        ["--cwd", "/repo/packages/web"],
        elsewhere("/repo/packages/web/src/a.ts", ["../../jevy.config.mts"]),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "the repository has ../../jevy.config.mts",
      );
      expect(result.stderr).toContain("--cwd /repo\n");
    });

    it("says how many more there are", async () => {
      const result = await runPreEdit(
        [],
        elsewhere(`${REPO}/src/app.ts`, [
          "a/jevy.config.ts",
          "b/jevy.config.ts",
          "c/jevy.config.ts",
        ]),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "the repository has a/jevy.config.ts (and 2 more)",
      );
    });

    it("still allows a file outside the project", async () => {
      expect(
        await runPreEdit(
          [],
          elsewhere("/elsewhere/a.ts", ["packages/app/jevy.config.ts"]),
        ),
      ).toEqual(ALLOW);
    });

    it("keeps the built-in protections when the tracked config is this directory's own, deleted", async () => {
      // The stop hook reports the deletion; this hook has no list to read.
      expect(
        await runPreEdit(
          [],
          elsewhere(`${REPO}/src/app.ts`, ["jevy.config.ts"]),
        ),
      ).toEqual(ALLOW);
      expect(
        (await runPreEdit([], elsewhere(`${REPO}/jevy.config.ts`, []))).code,
      ).toBe(2);
    });

    it("does not ask git when the directory has a config", async () => {
      const deps: HookDeps = {
        ...fake(edit(`${REPO}/src/app.ts`)),
        git: {
          ...defaultHookDeps().git,
          trackedConfigs: () => Promise.reject(new Error("must not be asked")),
        },
      };
      expect(await runPreEdit([], deps)).toEqual(ALLOW);
    });

    it("blocks when git cannot say", async () => {
      const deps: HookDeps = {
        ...fake(edit(`${REPO}/src/app.ts`), null),
        git: {
          ...defaultHookDeps().git,
          trackedConfigs: () => Promise.reject(new Error("git broke")),
        },
      };
      expect(await runPreEdit([], deps)).toEqual({
        code: 2,
        stdout: "",
        stderr: "jevy hook pre-edit: git broke\n",
      });
    });
  });

  describe("the deadline", () => {
    const never = (): Promise<never> => new Promise(() => undefined);

    it.each([
      ["the config read", { readFile: never }],
      ["stdin", { readStdin: never }],
      ["a path lookup", { realpath: never }],
    ])("blocks when %s never comes back", async (_name, hung) => {
      const deps: HookDeps = { ...fake(edit(`${REPO}/src/app.ts`)), ...hung };
      const started = Date.now();
      const result = await runPreEdit(["--deadline", "0.05"], deps);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr:
          "jevy hook pre-edit: the edit could not be checked within 0.05 s, so it is refused. If this keeps happening, a person has to look at why the hook is slow.\n",
      });
    });

    it("is 20 seconds unless --deadline says otherwise, below the 30 the settings give the hook", async () => {
      const { DEFAULT_PRE_EDIT_DEADLINE_SECONDS } =
        await import("./pre-edit.js");
      expect(DEFAULT_PRE_EDIT_DEADLINE_SECONDS).toBe(20);
    });

    it.each([
      [["--deadline"], "--deadline needs a value"],
      [
        ["--deadline", "never"],
        "--deadline must be a number of seconds above 0: never",
      ],
    ])("exits 2 for %j", async (argv, message) => {
      const result = await runPreEdit(argv, fake(edit(`${REPO}/src/app.ts`)));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`jevy hook pre-edit: ${message}\n`);
      expect(result.stderr).toContain("Usage: jevy hook pre-edit");
    });
  });

  it("looks a deep path that does not exist up once, not once per segment", async () => {
    const segments = Array.from({ length: 400 }, (_, i) => `d${String(i)}`);
    let calls = 0;
    const deps: HookDeps = {
      ...fake(edit(`${REPO}/${segments.join("/")}/file.ts`)),
      // Only /repo exists.
      realpath: (path) => {
        calls += 1;
        if (path === REPO || path === "/") {
          return Promise.resolve(path);
        }
        return Promise.reject(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
      },
    };
    expect(await runPreEdit([], deps)).toEqual(ALLOW);
    // One walk up the 401 missing names, and a few calls for what exists.
    // Resolving every prefix on its own took more than 80,000.
    expect(calls).toBeLessThan(450);
  });

  it("still blocks a deep path that does not exist in a protected directory", async () => {
    const deep = Array.from({ length: 50 }, (_, i) => `d${String(i)}`).join(
      "/",
    );
    const deps: HookDeps = {
      ...fake(edit(`${REPO}/tests/critical/${deep}/new.spec.ts`)),
      realpath: (path) =>
        path === REPO || path === "/"
          ? Promise.resolve(path)
          : Promise.reject(
              Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
            ),
    };
    expect((await runPreEdit([], deps)).code).toBe(2);
  });
});

const HOOKS = "it keeps the Jevy hooks themselves working";

function hookBlocked(path: string): CliResult {
  return blocked(path, HOOKS);
}

/**
 * Pre-edit with the project at `projectDir`, these config files (absolute
 * path to text), and `top` as the root of the repository.
 */
function inRepo(
  stdin: string,
  projectDir: string,
  configs: Readonly<Record<string, string>>,
  top: string | null,
  tracked: readonly string[] = [],
): { readonly argv: readonly string[]; readonly deps: HookDeps } {
  const deps = fake(stdin);
  return {
    argv: ["--cwd", projectDir],
    deps: {
      ...deps,
      readFile: (path) => Promise.resolve(configs[path] ?? null),
      git: {
        ...deps.git,
        topLevel: () => Promise.resolve(top),
        trackedConfigs: () => Promise.resolve(tracked),
      },
    },
  };
}

describe("jevy hook pre-edit and the files that run the hooks", () => {
  // One Write to any of these turns every hook into "exit 0", and git shows
  // nothing: node_modules is ignored, and so is .claude/settings.local.json.
  it.each([
    "node_modules/.bin/jevy",
    "node_modules/@jevyjs/cli/dist/bin.js",
    "node_modules/@jevyjs/cli/package.json",
    "node_modules/@jevyjs/core/dist/index.js",
    ".claude/settings.json",
    ".claude/settings.local.json",
  ])("blocks %s, with no config and with one", async (path) => {
    for (const text of [null, CONFIG]) {
      expect(
        await runPreEdit([], fake(edit(`${REPO}/${path}`, "Write"), text)),
      ).toEqual(hookBlocked(path));
    }
  });

  it.each([".Claude/Settings.json", "node_modules/.BIN/Jevy"])(
    "blocks %s, whose case differs: a disk that ignores case writes the same file",
    async (path) => {
      expect(
        await runPreEdit([], fake(edit(`${REPO}/${path}`, "Write"))),
      ).toEqual(hookBlocked(path));
    },
  );

  it.each([
    "node_modules/.bin/vitest",
    "node_modules/left-pad/index.js",
    "node_modules/@jevyjsx/a.js",
    ".claude/commands/fix.md",
    ".claude/settings.json.bak",
    "src/.claude/settings.json",
  ])("allows %s", async (path) => {
    expect(
      await runPreEdit([], fake(edit(`${REPO}/${path}`, "Write"))),
    ).toEqual(ALLOW);
  });

  it("protects them at the root of the repository too, when the hook runs below it", async () => {
    const app = `${REPO}/packages/app`;
    const config = { [`${app}/jevy.config.ts`]: CONFIG };
    for (const [path, shown] of [
      [`${REPO}/.claude/settings.json`, `${REPO}/.claude/settings.json`],
      [`${REPO}/node_modules/.bin/jevy`, `${REPO}/node_modules/.bin/jevy`],
      [
        `${REPO}/node_modules/@jevyjs/cli/dist/bin.js`,
        `${REPO}/node_modules/@jevyjs/cli/dist/bin.js`,
      ],
      [`${app}/node_modules/.bin/jevy`, "node_modules/.bin/jevy"],
      [`${app}/.claude/settings.local.json`, ".claude/settings.local.json"],
    ] as const) {
      const { argv, deps } = inRepo(edit(path, "Write"), app, config, REPO);
      expect(await runPreEdit(argv, deps)).toEqual(hookBlocked(shown));
    }
  });

  it("still allows a file outside the repository", async () => {
    const { argv, deps } = inRepo(
      edit("/elsewhere/.claude/settings.json", "Write"),
      REPO,
      { [`${REPO}/jevy.config.ts`]: CONFIG },
      REPO,
    );
    expect(await runPreEdit(argv, deps)).toEqual(ALLOW);
  });
});

describe("jevy hook pre-edit on a path outside the project but inside the repository", () => {
  it("refuses it when the config is in another directory", async () => {
    // Started in packages/app/src, which has no config; the agent writes
    // the config one directory up.
    const { argv, deps } = inRepo(
      edit(`${REPO}/packages/app/jevy.config.ts`, "Write"),
      `${REPO}/packages/app/src`,
      {},
      REPO,
      ["../jevy.config.ts"],
    );
    const result = await runPreEdit(argv, deps);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "/repo/packages/app/src has no jevy.config.*, but the repository has ../jevy.config.ts",
    );
  });

  it("protects a Jevy config anywhere in the repository", async () => {
    const app = `${REPO}/packages/app`;
    const config = { [`${app}/jevy.config.ts`]: CONFIG };
    for (const path of [
      `${REPO}/packages/web/jevy.config.ts`,
      `${REPO}/jevy.config.mts`,
    ]) {
      const { argv, deps } = inRepo(edit(path), app, config, REPO);
      expect(await runPreEdit(argv, deps)).toEqual(
        blocked(path, "it is the Jevy config"),
      );
    }
    const { argv, deps } = inRepo(
      edit(`${REPO}/packages/web/src/a.ts`),
      app,
      config,
      REPO,
    );
    expect(await runPreEdit(argv, deps)).toEqual(ALLOW);
  });

  it("refuses it when the project's own config cannot be read", async () => {
    const app = `${REPO}/packages/app`;
    const { argv, deps } = inRepo(
      edit(`${REPO}/packages/web/src/a.ts`),
      app,
      { [`${app}/jevy.config.ts`]: "export default {{{\n" },
      REPO,
    );
    expect((await runPreEdit(argv, deps)).code).toBe(2);
  });
});

describe("jevy hook pre-edit on a real file system", () => {
  let base = "";
  let repo = "";
  let link = "";

  beforeAll(() => {
    // Resolved, so that the only symlinks are the ones made here.
    base = realpathSync(mkdtempSync(join(tmpdir(), "jevy-hook-pre-edit-")));
    repo = join(base, "project");
    link = join(base, "link");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(repo, "jevy.config.ts"), CONFIG);
    writeFileSync(join(repo, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(base, "outside", "real.ts"), "export const b = 1;\n");
    symlinkSync(repo, link, "dir");
    symlinkSync(repo, join(base, "link2"), "dir");
    // A harmless name for the config, and a protected name for a file outside.
    symlinkSync(join(repo, "jevy.config.ts"), join(repo, "src", "alias.ts"));
    symlinkSync(join(base, "outside", "real.ts"), join(repo, "pnpm.lock"));
    symlinkSync(join(base, "outside"), join(repo, "src", "out"), "dir");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function check(cwd: string, path: string): Promise<CliResult> {
    return runPreEdit(["--cwd", cwd], {
      ...defaultHookDeps(),
      readStdin: () => Promise.resolve(edit(path, "Write", cwd)),
    });
  }

  it("blocks the config and allows an ordinary file", async () => {
    expect(await check(repo, join(repo, "jevy.config.ts"))).toEqual(
      blocked("jevy.config.ts", "it is the Jevy config"),
    );
    expect(await check(repo, join(repo, "src", "app.ts"))).toEqual(ALLOW);
  });

  it("blocks a file that does not exist yet in a protected directory", async () => {
    expect(
      await check(repo, join(repo, ".jevy", "decisions", "tests", "new.jsonl")),
    ).toEqual(
      blocked(".jevy/decisions/tests/new.jsonl", "it is in the decision cache"),
    );
    expect(
      await check(repo, join(repo, "tests", "critical", "deep", "new.spec.ts")),
    ).toEqual(
      blocked(
        "tests/critical/deep/new.spec.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
    expect(await check(repo, join(repo, "src", "new", "file.ts"))).toEqual(
      ALLOW,
    );
  });

  it("blocks when the project directory is reached through a symlink", async () => {
    // The hook is started in the link; the agent names the real path.
    expect(await check(link, join(repo, "jevy.config.ts"))).toEqual(
      blocked("jevy.config.ts", "it is the Jevy config"),
    );
    // And the other way round.
    expect(await check(repo, join(link, "tests", "critical", "a.ts"))).toEqual(
      blocked(
        "tests/critical/a.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
    expect(await check(link, join(link, "pnpm.lock"))).toEqual(
      blocked("pnpm.lock", 'it matches "*.lock" in protect'),
    );
    expect(await check(link, join(repo, "src", "app.ts"))).toEqual(ALLOW);
    expect(await check(repo, join(link, "src", "new.ts"))).toEqual(ALLOW);
  });

  it("blocks a symlink that leads to a protected file", async () => {
    expect(await check(repo, join(repo, "src", "alias.ts"))).toEqual(
      blocked("jevy.config.ts", "it is the Jevy config"),
    );
  });

  it("blocks a protected name even when it is a symlink to somewhere else", async () => {
    expect(await check(repo, join(repo, "pnpm.lock"))).toEqual(
      blocked("pnpm.lock", 'it matches "*.lock" in protect'),
    );
  });

  it("blocks a protected name reached through a second link to the project", async () => {
    // Started in one link, named through another; the file is itself a
    // link out of the project, so only its resolved directory places it.
    expect(await check(link, join(base, "link2", "pnpm.lock"))).toEqual(
      blocked("pnpm.lock", 'it matches "*.lock" in protect'),
    );
    expect(await check(link, join(base, "link2", "src", "app.ts"))).toEqual(
      ALLOW,
    );
  });

  it("blocks a dangling symlink whose target is a protected path", async () => {
    // Writing through the link creates the target, which does not exist yet.
    symlinkSync(
      join(repo, "tests", "critical", "new.spec.ts"),
      join(repo, "src", "notes.txt"),
    );
    expect(await check(repo, join(repo, "src", "notes.txt"))).toEqual(
      blocked(
        "tests/critical/new.spec.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
  });

  it("blocks a dangling symlink with a relative target, and a chain of them", async () => {
    symlinkSync("../.jevy/decisions/a.jsonl", join(repo, "src", "rel.txt"));
    expect(await check(repo, join(repo, "src", "rel.txt"))).toEqual(
      blocked(".jevy/decisions/a.jsonl", "it is in the decision cache"),
    );
    symlinkSync("rel.txt", join(repo, "src", "chain.txt"));
    expect(await check(repo, join(repo, "src", "chain.txt"))).toEqual(
      blocked(".jevy/decisions/a.jsonl", "it is in the decision cache"),
    );
  });

  it("blocks a path below a dangling symlink to a protected directory", async () => {
    symlinkSync(
      join(repo, "tests", "critical", "sub"),
      join(repo, "src", "sublink"),
    );
    expect(await check(repo, join(repo, "src", "sublink", "a.ts"))).toEqual(
      blocked(
        "tests/critical/sub/a.ts",
        'it matches "tests/critical/**" in protect',
      ),
    );
  });

  it("allows a dangling symlink to an ordinary path", async () => {
    symlinkSync(join(repo, "src", "later.ts"), join(repo, "src", "ok.txt"));
    expect(await check(repo, join(repo, "src", "ok.txt"))).toEqual(ALLOW);
  });

  it("refuses a symlink that leads back to itself", async () => {
    symlinkSync("loop-b", join(repo, "src", "loop-a"));
    symlinkSync("loop-a", join(repo, "src", "loop-b"));
    const result = await check(repo, join(repo, "src", "loop-a"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("allows a file outside the project, however it is reached", async () => {
    expect(await check(repo, join(base, "outside", "real.ts"))).toEqual(ALLOW);
    expect(await check(repo, join(repo, "src", "out", "real.ts"))).toEqual(
      ALLOW,
    );
    expect(
      await check(repo, join(repo, "src", "out", "jevy.config.ts")),
    ).toEqual(blocked("src/out/jevy.config.ts", "it is the Jevy config"));
  });

  it("blocks the installed jevy however it is named, pnpm's store included", async () => {
    const project = join(base, "installed");
    const store = join(
      project,
      "node_modules",
      ".pnpm",
      "@jevyjs+cli@0.0.1",
      "node_modules",
      "@jevyjs",
      "cli",
    );
    mkdirSync(join(store, "dist"), { recursive: true });
    writeFileSync(join(store, "dist", "bin.js"), "// jevy\n");
    mkdirSync(join(project, "node_modules", "@jevyjs"), { recursive: true });
    symlinkSync(store, join(project, "node_modules", "@jevyjs", "cli"), "dir");
    mkdirSync(join(project, "config"));
    writeFileSync(join(project, "config", "claude.json"), "{}\n");
    mkdirSync(join(project, ".claude"));
    symlinkSync(
      join(project, "config", "claude.json"),
      join(project, ".claude", "settings.json"),
    );
    const inStore = join(store, "dist", "bin.js");
    expect(await check(project, inStore)).toEqual(
      hookBlocked(
        "node_modules/.pnpm/@jevyjs+cli@0.0.1/node_modules/@jevyjs/cli/dist/bin.js",
      ),
    );
    expect(
      await check(
        project,
        join(project, "node_modules", "@jevyjs", "cli", "dist", "bin.js"),
      ),
    ).toEqual(hookBlocked("node_modules/@jevyjs/cli/dist/bin.js"));
    // The settings file is a link: its target is the file Claude Code reads.
    expect(
      await check(project, join(project, "config", "claude.json")),
    ).toEqual(hookBlocked("config/claude.json"));
    expect(await check(project, join(project, "config", "other.json"))).toEqual(
      ALLOW,
    );
  });
});
