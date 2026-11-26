# Jevy — a test framework for the AI era

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: early, not yet on npm.** What works today, from a clone of this repo: `jevy guard`, the agent hooks and protected paths, the `toSatisfy` matcher for Playwright with its `report.json`, the generic LLM decider, and the decision layer under them (three verdicts, snapshot hashing, redaction, the decision cache with replay). `toSatisfy` is advisory by default until its accuracy is measured (step 4). The app map, the admission check for new tests, the planner, generator and healer, the report page, `eval` and the wallet pack are planned and marked as such below. Only a placeholder `@jevyjs/cli` 0.0.1 is on npm. Design: [docs/DESIGN.md](docs/DESIGN.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Undecided: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

Coding agents now write much of the code and many of the tests. A written test is no longer the scarce thing. A result you can trust is. **Jevy is an open-source test framework for teams whose code and tests are mostly written by coding agents.** It runs on Playwright, and does six jobs:

1. **Knows your app.** It maps your routes, pages and endpoints, and records what each test actually touches, so it can say what is covered and what is not.
2. **Creates tests worth having.** A planner proposes only what is missing and a generator writes plain Playwright tests. Every new test must pass an admission check: a person approved the plan, it duplicates nothing, and it catches a deliberately planted bug.
3. **Runs them cheaply and honestly.** Exact checks stay in code. A check that needs judgement goes to a model once; the answer is stored in git and replayed with no model call. A doubtful answer is `needs-review`, never a guess.
4. **Protects them.** The guard and agent hooks stop a test being quietly weakened. A broken test gets a proposed fix that a person approves. An agent cannot approve its own work.
5. **Shows what happened.** A page where the team can read what each test protects, step by step, with screenshots and history, plus one proof file per pull request.
6. **Measures itself.** A model is scored on labelled cases before its answers are trusted.

Today, job 4 and most of job 3 are built; the status note above and the sections below say exactly which. Jevy runs no model loop of its own: your coding agent does the driving, and Jevy gives it a planner, a generator and a healer to run, plus checks and guardrails. Web3 is built on the same six jobs: wallet prompts, signing policy and chain state use the same mechanisms as any other check.

## The problem

- **The author marks its own homework.** An agent asked to make a failing test pass can delete the assertion, add `.skip`, loosen the wording or lower a threshold. Nothing in a normal test run notices.
- **Silent self-healing hides regressions.** A tool that repairs a test on its own can also repair away the bug the test was there to catch.
- **A guessed verdict.** A low-confidence model answer treated as pass or fail is not something to merge on.
- **A model call on every assertion.** It costs time and money on every run, and a retry can draw a different answer.
- **Unmeasured judges.** A free-text model judge with no measured accuracy on your app is an opinion, not a check.

## What works today

Nothing is published yet, so these run from a clone (`pnpm install && pnpm build`).

### `jevy guard`

A coding agent that writes the code also edits the tests, and the quickest way to turn a failing test green is to weaken it. `jevy guard` compares two versions of your repo and lists every change that could weaken your checks, so a person can review them. It does not call a model. It parses files with the TypeScript compiler and never runs code from your repo.

    jevy guard --base origin/main --merge-base               # the working tree against where this branch started
    jevy guard --base origin/main --merge-base --head HEAD   # the same, for a commit
    jevy guard --base origin/main --merge-base --json        # machine-readable output

Without `--head` the guard checks the working tree, untracked files included, and the index as well, so a weakened test that is staged and then restored on disk is still seen. It compares the bytes of every file it checks with the base version itself, so a forged file timestamp or a file-system monitor cannot hide an edit. A test file that git ignores still counts as a new test, because Playwright and Vitest run it; files under `node_modules` and `dist` do not. Git runs no program your repository configures for it (an fsmonitor, a clean filter, a hook) while the guard runs. So a file stored through a filter such as git-lfs reads as changed when it is a test or a protected path.

What it catches:

- **Weakening, which fails by default.** It catches:
  - a deleted test file or test
  - fewer `expect` calls in a test
  - a new `.skip`, `.fixme`, `.todo`, `x`-prefixed test, `test.skip()`/`test.fixme()` call or `test.step.skip`
  - a new `.only`
  - a new `test.fail`
  - an `expect` that became `expect.soft`
  - a lower `thresholds.pass`
  - `ci.needsReview.pr` or `.main` moved from `"fail"` to `"warn"`
  - `toSatisfy.blocking` moved from `true` to `false`, or removed (the default is `false`). The guard compares the config the loader reads in each directory, so deleting the config, adding one the loader reads first (`jevy.config.ts` before `jevy.config.mts`) or renaming it counts too.
  - a decision-cache line added with a non-null `reviewedBy`. Approvals must be made by a human.
  - a new or changed test with no assertion, or whose every assertion cannot fail (`expect(true).toBe(true)`, `expect(total).toEqual(total)`). A test whose skip or expected-failure marker came off counts as changed.
  - a change to a protected path (see below)
- **Review, which does not fail by default.** It flags:
  - a changed `toSatisfy` statement
  - a changed matcher, a changed literal argument, or an added `.not`
  - a changed test whose title is not a string literal
  - a new or changed test with no visible assertion that calls something the guard cannot read, such as an imported helper or a page object
  - a new or changed test that only checks mocks it created and called itself
  - a new or changed test whose only checks that can fail are `toSatisfy` from `@jevyjs/playwright`, while `toSatisfy.blocking` is not `true` in the base config or the change switches it off. A `toSatisfy` in a same-file function the test calls, in a `toPass` block or in a hook counts the same. Such a test cannot fail the build. Vitest's `toSatisfy(predicate)`, and one the file defines with `expect.extend`, are ordinary matchers.
  - a changed `.each` table
  - changed `redact`, `normalise` or `decider` settings, and any other config change
  - raised Playwright `retries`, at the top level or for a project (projects are matched by name), or changed test selection (`testIgnore`, `testMatch`, `grep` and similar)
  - an added, moved or removed git submodule where tests or protected paths may be. The guard does not look inside it.
  - added or removed decision records
  - a file that does not parse
- **Info:** added tests, added assertions, renamed tests (same body under a new title).

Reformatting, comments, reordered imports or tests, and renamed variables produce no findings.

Options:

- `--merge-base` compares against the commit where `--head` branched from `--base`, not the tip of `--base`. Without it, tests added to the target branch after yours started look like tests you removed. It needs full history.
- `--tests <glob>` (repeatable) names the files compared as tests. The default is `**/*.{spec,test}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`. Files under `node_modules` and `dist` are never tests.
- `--fail-on weakening|review|never` (default `weakening`).
- `--cache-dir <dir>` (default: `cache.dir` in the config, else `.jevy/decisions`).
- `--cwd <dir>`.

Settings in `jevy.config.*` are read as text; the file is never run. The guard reads `guard.tests`, `cache.dir`, `protect`, `web3.policy` and `toSatisfy.blocking` from the **base** version of the config when it exists there, so a change cannot redefine what it is checked against. A value the guard cannot read as a literal (a variable from another file, a function call) stops it with exit code 2. So does a config that can change itself as it loads: one that uses `globalThis`, `require.cache`, `import.meta`, `Object.prototype`, `Object.defineProperty`, `Reflect`, `eval` or `Function`, or imports itself. A config committed as a symbolic link stops it too. A file the config imports with a relative path is protected like the config; an import the guard cannot place (an alias such as `@/x`) stops it.

**Protected paths** are files an agent must not change without a person. Always protected, with no setup: every `jevy.config.*`, the files it imports, the decision cache directory, and the file named by `web3.policy`. Add your own with `protect`, for example a test plan or the tests for payments:

    protect: ["docs/test-plan.md", "tests/payments/**"],

The guard reports any added, changed, deleted or renamed protected file as `protected-path-changed`, which is weakening. So every edit to `jevy.config.*` now needs a person's review. Decision records are the exception: a test run writes them, so the guard compares them record by record as before. Matching ignores case, because macOS and Windows disks do. Globs support `*`, `**`, `?` and `{a,b}`, and a glob that names a directory covers everything in it. A space inside a name is fine (`my docs/plan.md`), but a space at the start or end of a path segment or a `{a,b}` alternative is refused, because `{plans, tests}` would match nothing.

Exit codes: `0` nothing at or above `--fail-on`; `1` something is; `2` usage or git error (unknown ref, not a git repo), or the guard cannot be sure what it is looking at. For example, `--base` is a short commit id that a branch also takes as its name, or git ignores a config that the loader would read first.

In CI, run it next to your tests on every pull request, with `--merge-base`. Fetch full history first (`fetch-depth: 0`):

    - run: npx jevy guard --base origin/${{ github.base_ref }} --merge-base --head HEAD

JSON (`--json`) prints exactly one document. The schema is versioned by `v`. Findings are sorted by file, then line, then kind, so the output is byte-identical across runs:

    { "v": 1, "tool": "jevy-guard", "base": "origin/main", "head": "HEAD",
      "summary": { "weakening": 1, "review": 0, "info": 2 },
      "findings": [ { "kind": "assertion-removed", "severity": "weakening",
        "file": "tests/checkout.spec.ts", "test": ["checkout", "pays by card"], "line": 4,
        "message": "checkout > pays by card has 1 fewer assertion (2 -> 1): removed toHaveText",
        "before": "expect(…).toHaveText(\"Paid\")" } ] }

`head` is `"working-tree"` when `--head` is omitted. `mergeBase` holds the commit compared against when `--merge-base` is given. `test`, `line`, `before` and `after` appear only when they apply. `line` is the line in the head version, or in the base version when the thing it points to is gone.

Known limits. It is a mechanical check, so it does not see: a removed `await` in front of an `expect`; a removed assertion inside a helper function in another file or a custom `expect` wrapper; a changed subject or argument that is not a literal; an early `return` or a `try`/`catch` around assertions; tests in files outside the test globs; a test weakened inside a git submodule (a changed submodule is only flagged for review); a value the config reads through an import of an import, or from a workspace package; a decision record edited in place, which shows as one removal and one addition for review. A test with a non-literal title is matched only for review.

The check for weak new tests reads one file. An assertion in an imported helper, a page object or a custom fixture is "not visible" and is flagged for review, never as weakening. Some weak tests get review where weakening would be right: a built-in matcher on literals whose result the guard does not work out (`toContain` on a list, `toHaveProperty`, `toBeCloseTo`, `toBeTypeOf`, `toMatch` with a pattern, `toBeOneOf`); an empty test under `node:test`, `mocha` or `bun:test`; a test that reads `process`, `globalThis` or a `const` of its describe block; a constant assertion beside `expect.assertions()`, which may count an assertion in a `catch`. It does not follow dead code, so `if (false) expect(...)` counts as an assertion. Settings are read from the `jevy.config.*` in the directory the guard runs in; a config in another directory of a monorepo is protected as a file, but its `protect` list applies only when the guard runs there (`--cwd`).

### Agent hooks

The guard reports a weakened test after the fact. The hooks stop it inside a coding agent's session. They are for Claude Code today.

    jevy hook print --agent claude   # the settings snippet; paste it into .claude/settings.json

The snippet wires three commands:

- **`jevy hook stop`** runs before the agent may say it is done. It runs each command in your config's `checks` list, then `jevy guard` twice: the branch against the default branch (`--merge-base`), and the session against the commit it started on. If a check fails or the guard finds weakening, the hook exits with code 2, and Claude Code hands the reason to the agent and keeps it working.
- **`jevy hook pre-edit`** runs before each file edit and blocks one that targets a protected path, with a message telling the agent to ask you. It always protects the files that run the hooks, with no config needed: `node_modules/.bin/jevy`, `node_modules/@jevyjs/**` and `.claude/settings.json` and `.claude/settings.local.json`, in the project directory and at the root of the repository. One write to any of them could switch every hook off.
- **`jevy hook session-start`** records the commit the session starts on, so the stop hook also sees what the agent commits. The record belongs to the repository, so the stop hook finds it whichever directory it runs in.

Name your real checks in the config. The config is a protected path, so an agent cannot quietly empty the list:

    checks: ["pnpm lint", "pnpm typecheck", "pnpm test"],

The stop hook does not let an agent spin. After two blocked attempts in a row for the same reason, the third lets it stop and shows you what still fails. It also stops blocking after six blocks in one run, and it has an overall time limit (`--deadline`, 1500 seconds by default; `--timeout`, 300 seconds per check), because Claude Code lets an agent proceed when a hook times out. The guard runs in a process of its own, which the hook kills when the time is up; a guard that dies, out of memory for example, blocks the agent.

Both hooks read the config as text and never run it. They fail closed: a config they cannot read, a hook input they cannot parse, or an internal error blocks with exit code 2, since any other exit code would let the action through. Their git commands ignore `git replace` and the repository's file-system monitor, so the agent cannot make git show the hooks another commit.

Known limits. The hooks make weakening hard to do by accident; they are not a sandbox. A change you make to the config yourself during a session keeps blocking the agent until the next session starts, because the hook cannot tell your edit from the agent's. An edit made through a shell command does not pass through the pre-edit hook; the stop hook's guard reports it afterwards. The pre-edit hook stops an edit tool from changing the settings files or the installed `jevy`, but an agent can still change them with a shell command; add `.claude/settings.json` to `protect` if you want the guard to report that. The hooks keep their state in the temp directory, and an agent that deletes the record of where the session started reopens the gap the second guard run closes: the stop hook then compares with the default branch only. The guard in CI, run from a clean checkout, is the check an agent cannot reach.

A short skill file for agents ships in the package at `skill/SKILL.md`: the exact commands, the rules, and what to do with `report.json`, in under 40 lines.

### `toSatisfy` in Playwright

A check that needs judgement goes to a model once. The answer is stored in git and replayed with no model call.

```ts
import { test, expect } from "@jevyjs/playwright"; // @playwright/test, extended

test("order is confirmed", async ({ page }) => {
  await page.goto("/checkout");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible(); // wait first: toSatisfy does not poll
  await expect(page.getByRole("main")).toSatisfy(
    "The order is shown as confirmed, not as failed or pending",
  );
  await expect(page.getByTestId("total")).toHaveText("$42.00"); // numbers stay in code
});
```

The statement becomes a yes/no question about one accessibility snapshot of the target, with secret fields blanked. Point it at a locator rather than the whole page: a smaller state costs less and changes less often. Add `{ criteria: "…" }` when the statement could be read two ways. `.not.toSatisfy` throws; write the statement you expect to hold.

**Setup.** Name a model in `jevy.config.ts` through an adapter: an object whose `complete(prompt, jsonSchema)` calls the model and returns its answer as a parsed object. Any provider works. The fetch below is a placeholder for your provider's own API:

```ts
// jevy.config.ts
import { defineConfig } from "@jevyjs/core";
import type { LlmAdapter } from "@jevyjs/core";

const adapter: LlmAdapter = {
  async complete(prompt, jsonSchema) {
    // Read the key here, not at import, so a replay run in CI needs no key.
    const key = process.env.MY_MODEL_API_KEY;
    if (!key) throw new Error("MY_MODEL_API_KEY is not set");
    // Placeholder: your provider's endpoint and request shape.
    const response = await fetch("https://models.example.com/v1/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "provider/model-id", prompt, schema: jsonSchema }),
    });
    if (!response.ok) throw new Error("The model call failed");
    const body = (await response.json()) as { output: string }; // placeholder
    return JSON.parse(body.output); // the object the schema describes
  },
};

export default defineConfig({
  decider: "llm",
  deciders: { llm: { adapter, model: "provider/model-id" } }, // the pin is part of every cache key
  cache: { dir: ".jevy/decisions" }, // committed to git; replayed with no model call when CI is set
});
```

`complete` is not told the model, so call the one you pinned. A reply that does not match the schema is asked again (two attempts by default), then reported as `needs-review`. Jevy never repeats the prompt, the reply or your adapter's error text in a message. `@jevyjs/deciders-llm` also exports `fakeDecider` for tests.

Add Jevy's reporter in `playwright.config.ts`, and git-ignore `jevy-report/`:

```ts
reporter: [["list"], ["@jevyjs/playwright/reporter"]],
```

**How it runs.** Without `CI` set, the mode is `record`: each call asks the model, and a test that passes writes its answers to `.jevy/decisions/<spec>.jsonl`, which you commit. With `CI` set, the mode is `replay`: no model is called and no key is needed, and a call with no matching record is `needs-review` with a reason. A retry gets the answer the first attempt drew, also in a new worker, so it cannot draw a different one. `test.use({ decider })` picks the decider for a file: `"llm"`, or a `Decider` object of your own. `"kev"` and `"jev"` can only replay until their adapters exist (step 11).

**Advisory by default.** A `fail` or `needs-review` does not fail the test, and the exit code does not change. It is reported three ways: a `jevy-assertion` attachment on the test, a `jevy` annotation on every non-pass (Playwright's own reporters show it), and `report.json`. Once you trust the model on your app, set `toSatisfy: { blocking: true }` in `jevy.config.ts`. Then a `fail` fails the test, and `needs-review` follows `ci.needsReview`: outside CI it only warns; in CI it warns on pull requests and fails on the main branch by default. The branch comes from `JEVY_BRANCH`, `GITHUB_REF_NAME` or `CI_COMMIT_BRANCH`. There is no per-test switch, and the guard reports switching it off as weakening. With blocking on, a "no" that alone failed its test is still recorded, so CI fails the same way until a person reviews it.

**`report.json`.** After a run, `jevy-report/report.json` (the reporter's `outputFile` option moves it) lists every `toSatisfy` call: `spec`, `line`, `statement`, `verdict`, `source` (`cache`, `review`, `decider` or `none`), `reason`, `mode`, `effect` (whether it failed its test), decider and model. `run.status` says how the run ended, and `incomplete` lists tests cut short, whose later assertions may be missing. It holds no page text and no timestamps, so the same state gives the same bytes. An agent can act on it without reading logs:

| `reason`                                                              | Verdict      | Next action                                                                    |
| --------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `no-entry`, `model-changed`, `redaction-changed`                      | needs-review | Run the spec locally, outside CI, so it is recorded; commit the records        |
| `snapshot-changed`                                                    | needs-review | The page changed: a person looks at it, then it is re-recorded or approved     |
| `answered-no`, `reviewed`                                             | fail         | Fix the app, or the statement if it is wrong (the guard flags that for review) |
| `abstained`, `low-confidence`, `truncated`, `regated-below-threshold` | needs-review | Hand to a person                                                               |
| `decider-error`                                                       | needs-review | The model could not answer; run the spec again locally                         |
| a test in `incomplete`                                                | —            | Hand to a person                                                               |

The first three reasons are replay misses and appear only in `replay` mode; in any other mode, hand them to a person.

**Known limits.**

- No polling. The snapshot is taken when the call runs. Wait for the page with a web-first assertion first.
- The model's time counts against the test's timeout. A call needs about 2.7 seconds of the test's time left; with less, the model is not asked and the result is `needs-review` (`decider-error`).
- `toSatisfy` works in a test, `beforeEach` and `afterEach`, not in `beforeAll` or `afterAll`, and only in tests declared with Jevy's `test`.
- Spec files must be inside the Jevy root, the directory of the Playwright config. A spec whose path redaction would change (an email address in the file name, say) is refused. The same question in two specs is asked twice, and a renamed spec is recorded again.
- The script that keeps a "show password" field blanked is installed on the test's `context` and on every context the `browser` fixture creates. It is not installed on a browser you launch yourself (`chromium.launch()`) or a context from `launchPersistentContext`; there a password field switched to plain text is blanked only when its `name` or `id` says it is secret.
- A retry set only through `test.describe.configure({ retries })`, with the project's `retries` at 0, may ask the model again.
- Sharded runs merged from blob reports keep the attachments, so `merge-reports` with Jevy's reporter writes one `report.json`.
- The thresholds (0.8 and 0.5) are placeholders until accuracy is measured (step 4).

### The decision layer and the snapshot bridge

`toSatisfy` is built on `@jevyjs/core` and the snapshot bridge in `@jevyjs/playwright`, which you can also use directly, for example outside a Playwright test. The decider is anything that implements the `Decider` interface: `llmDecider({ adapter, model })` from `@jevyjs/deciders-llm`, or your own.

```ts
import {
  createDecisionSession,
  DEFAULT_THRESHOLDS,
  JsonlDecisionStore,
} from "@jevyjs/core";
import { snapshotAccessibility } from "@jevyjs/playwright";

const session = createDecisionSession({
  store: new JsonlDecisionStore({ dir: ".jevy/decisions" }), // one JSONL file per spec, committed to git
  mode: process.env.CI ? "replay" : "record", // replay never calls the decider
  deciderId: myDecider.id,
  model: myDecider.model,
  decider: myDecider,
  thresholds: DEFAULT_THRESHOLDS,
});

const outcome = await session.decide({
  spec: "tests/checkout.spec.ts",
  step: "order-confirmed",
  question: { kind: "yesno", prompt: "The page shows the order as confirmed" },
  state: { snapshot: await snapshotAccessibility(page) }, // password fields are blanked here
});
// outcome.verdict: "pass" | "fail" | "needs-review"; a miss carries outcome.reason
await session.confirm(); // write the new records only once the test has passed
```

What that gives you:

- **Three verdicts.** A weak answer, an abstention, and a "no" about a page that had to be cut to fit the model are all `needs-review`.
- **A cache key bound to the state.** The key covers the spec, the question, the redacted and normalised page, the decider and the model. A timestamp changing does not miss; a renamed button, or a link that points somewhere new, does.
- **A reason on every miss:** `no-entry`, `snapshot-changed`, `model-changed`, `redaction-changed` or `regated-below-threshold`.
- **Redaction before anything is hashed, sent or written.** Built-in patterns cover keys, tokens, emails, phone numbers, seed phrases and password fields. A redaction that cannot be proven complete stops the call.

Details are in [docs/DESIGN.md](docs/DESIGN.md).

## What is planned

In roadmap order. Everything in this section is intended usage and will change. [docs/ROADMAP.md](docs/ROADMAP.md) says why the steps are in this order.

**Measuring the two risky assumptions (step 4).** How often the hash of an unchanged real page changes, and how often a model judge is right. The result decides when a project should switch `toSatisfy` to blocking and whether the cache key keeps its current shape.

**The app map and test fingerprints (step 5).** Jevy reads your routes, pages and API endpoints from the codebase, and records what each test visits, clicks, checks and executes. You mark the critical areas. The result shows what is covered, by which tests, and what is not.

**Tests that earn their place (step 6).** An admission check for every new test, whoever wrote it. It must trace to a line in a short plan a person approved, must not duplicate an existing test, and must either cover something uncovered or catch a deliberately planted bug that nothing else catches. `jevy suite` lists existing tests that add nothing.

**Planner, generator and healer (step 7).** Jevy's own versions of Playwright's three agents, run by your coding agent. The planner reads the app map and existing coverage and proposes only what is missing. The generator writes a plain Playwright test from an approved plan line. The healer never heals quietly: it proposes a fix as a diff, and the test stays red until a person approves it. The same agents run in CI in your coding agent's headless mode, where they only propose. The checks that gate a merge never need an agent.

**The report page and the proof bundle (step 8).** A static page your team can open: for each test, what it protects, each step in plain words, a screenshot per step with the element highlighted, and what it covers. The same facts go into one signed file per pull request for a reviewer or an agent to read.

**Test history (step 9).** Each test's passes, failures and flakes over time, shown on the report page. History goes through a small store interface: a built-in store that needs no service, your own, or a results service you already use. A hosted Jevy dashboard that ties it all together may come later as an optional, separate product; the framework will never depend on it.

**Integrity (step 10).** `jevy cache verify` re-asks the model about records added in a pull request, so a forged `pass` fails CI. A person's approval, of a plan line, a healer's fix or a `needs-review` result, counts only when the commit that adds it passes a check the project defines.

**Eval and more deciders (step 11).** `jevy eval` reports accuracy, calibration, latency and cost per decider on labelled cases, and suggests thresholds. Adapters for TypeSafe AI's Jev (hosted) and Kev (local, open-weight) are optional extras.

**Web3 wallet pack (step 12).** `@jevyjs/web3` treats a wallet prompt as a test object. A decider classifies the prompt; a policy you write in TypeScript approves, rejects or stops; amounts, recipients and chain IDs are decoded and checked in code; chain state is checked in code against a local fork or a testnet you configure. Mainnet signing is refused unless you switch it on.

**Properties and invariants (step 13).** Generated properties, kept only when they compile, pass, and catch a planted bug.

Configuration lives in `jevy.config.ts`. The loader exists today and accepts this:

```ts
import { defineConfig } from "@jevyjs/core";

export default defineConfig({
  decider: "llm",
  deciders: {
    llm: { adapter: myLlmAdapter, model: "provider/model-id" }, // any provider; the model pin is required
    kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-4b@v1.0" }, // local; "kev" keeps page content on your machine
  },
  thresholds: { pass: 0.8, fail: 0.5 },
  cache: { dir: ".jevy/decisions" }, // replay when CI is set, record otherwise
  ci: { needsReview: { pr: "warn", main: "fail" } },
  toSatisfy: { blocking: false }, // the default; true: a fail fails the test
  redact: [/ORDER-\d+/],
  protect: ["docs/test-plan.md", "tests/payments/**"], // an agent must not change these without a person
  checks: ["pnpm lint", "pnpm typecheck", "pnpm test"], // what `jevy hook stop` runs
  guard: { tests: ["e2e/**/*.ts", "**/*.spec.ts"] }, // files `jevy guard` compares as tests
});
```

## Principles

1. **The developer's agent drives.** Jevy runs no model loop of its own; its planner, generator and healer run inside your coding agent.
2. **Plain code first.** Locators and exact assertions run as written. A model is asked only where code cannot decide.
3. **Three verdicts.** Doubt is `needs-review`, never a guessed pass or fail.
4. **Nothing is weakened silently.** A broken test is never healed quietly. A fix is proposed as a diff, a person approves it, and the guard reports a weakened test.
5. **Decisions are cached in git and re-checked.** A record is bound to the state, the decider and the model, and goes through the gate again on every replay.
6. **Numbers in code.** Amounts, balances, dates and chain state are checked with code, never judged by a model.
7. **Any model.** One `Decider` interface. No model is called until you name one in your config, and a local model keeps page content on your machine.
8. **Measure before trusting.** A model-judged check is advisory until its accuracy is measured, and an advisory step stays on only if at least 70% of its findings are accepted as real.
9. **A test has to earn its place.** It traces to a plan a person approved, duplicates nothing, and covers something new or catches a planted bug.

## How Jevy compares

Notes on three tools that also put a model in the browser loop, from their public docs and packages as reviewed in November 2026.

- **[e2e](https://github.com/tester-army/e2e)** (TesterArmy, Apache-2.0) is its own runner. Tests are `*.e2e.ts` and import `test` and `expect` from `e2e`, not from `@playwright/test`. A test can mix Playwright-style locators with `agent.act`, `agent.assert`, `agent.waitFor` and `agent.extract`. It ships a TypeSafe Jev decision executor, [`@e2e-dev/decision`](https://www.npmjs.com/package/@e2e-dev/decision), and it replays verified action paths from a cache that is read-only in CI. The model is not part of that cache key. Assertions, waits and extracts run live; assertion verdicts are not cached. Docs: [e2e.tester.army](https://e2e.tester.army/).
- **[Stagehand](https://github.com/browserbase/stagehand)** (Browserbase, MIT) is a browser-agent SDK rather than a test framework. It offers act, observe and extract. Its server-side cache is keyed by the instruction, the page content and the options, and the model is not part of that key. Docs: [docs.stagehand.dev](https://docs.stagehand.dev/).
- **[Midscene.js](https://midscenejs.com/)** (ByteDance web-infra) caches action planning and XPath locating. `aiAssert`, `aiQuery` and `aiBoolean` are not cached. Modes include read-only and write-only. See [midscenejs.com/caching](https://midscenejs.com/caching).

Those tools put a model in the loop to drive an app or to judge it. Jevy's subject is whether the result can be trusted when an agent wrote both the code and the test: verdicts are cached, bound to the state and the model, gated again on replay, and guarded against quiet weakening.

## Packages

The last column says what is implemented today.

| Package                | Purpose                                                                                                             | Today                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `@jevyjs/core`         | Decider contract, verdicts, snapshot hashing, redaction, pruning, decision cache, config                            | Implemented                      |
| `@jevyjs/playwright`   | Page snapshots, the `toSatisfy` matcher and the `report.json` reporter; later test fingerprints and the report page | Snapshots, `toSatisfy`, reporter |
| `@jevyjs/cli`          | The `jevy` command: `guard` and `hook`; later the app map, admission, the agents, `cache`, `eval`, `init`           | `guard` and `hook`               |
| `@jevyjs/deciders-llm` | Generic adapter for any LLM, and a fake decider for tests                                                           | Implemented                      |
| `@jevyjs/deciders-jev` | TypeSafe AI Jev adapter                                                                                             | Stub                             |
| `@jevyjs/deciders-kev` | Kev (local, open-weight) adapter                                                                                    | Stub                             |
| `@jevyjs/web3`         | Wallet pack                                                                                                         | Stub                             |

This repository holds only the packages. No sample app ships with it.

## Privacy

A hosted decider, including a cloud LLM behind the generic adapter, receives page content as a redacted accessibility snapshot, plus the redacted question. A link's URL is part of the snapshot, cut to scheme, host and path; a token in a link's path is sent unless a `redact` rule matches it. Jevy does not send screenshots. To keep page content on your machine, use a local model. API keys are read from environment variables and must never be committed; the config holds the variable's name, not the key. Decision records hold the question, the answer and hashes, never the page. See [DESIGN.md § Security and privacy](docs/DESIGN.md#10-security-and-privacy).

## Contributing and licence

MIT, see [LICENSE](LICENSE). Contributions are welcome under the Developer Certificate of Origin (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Development needs Node >= 22.18 (`.nvmrc` is 22; CI also runs Node 24). Maintainer: Adam Gencel (sole maintainer).

## Trademarks

Jevy is an independent, personal open-source project by Adam Gencel. It is not affiliated with, endorsed by, or sponsored by TypeSafe AI, Inc. or any employer. Jev and TypeSafe are trademarks of TypeSafe AI, Inc. and are used here only to identify a model Jevy can call. Uniswap, Playwright and other product names belong to their respective owners, and Jevy is not affiliated with any of them.
