# Jevy — a test framework for the agentic era

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: early. Roadmap step 1 is in the tree.** What exists today: `@jevyjs/core` (decider contract, three verdicts, snapshot hashing, redaction, pruning, config loader, and the decision cache with replay), `@jevyjs/playwright` (turns a Playwright page into the snapshot core hashes; no `toSatisfy` yet), and `jevy guard` in `@jevyjs/cli`. There is no decider adapter, `toSatisfy` matcher, reporter or wallet pack yet. Only a placeholder `@jevyjs/cli` 0.0.1 is on npm (all packages publish under `@jevyjs/*`; installing `@jevyjs/cli` gives you the `jevy` command). Nothing here publishes automatically. Apart from the `jevy guard` section, the commands and APIs below show the *intended* usage and will change. Design: [docs/DESIGN.md](docs/DESIGN.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Undecided: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

Coding agents now write much of the code and many of the tests. A written test is no longer the scarce thing; a result you can trust is. Jevy is built for that: an agent can run it and read it without a person, it flags a test that was quietly weakened, cached verdicts replay with no model call, a doubtful answer is `needs-review` and never a guess, and deciders are measured before they are trusted. The plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

Playwright is the first runner. Jevy plugs into `@playwright/test` instead of being a new runner. CI stays trustworthy, and a replay run makes no model calls:

- **Confidence gates are on by default.** A weak answer becomes `needs-review` (warn on pull requests, fail on `main`) instead of a guessed pass or fail.
- **Verdicts and actions are cached in git.** Each entry is keyed on the decider and the model. Replay re-checks the gates, so CI makes zero model calls.
- **Redaction is pattern-based.** Keys, emails, seed phrases and transaction hashes are caught without registering each secret.
- **There is a public eval.** A labelled dataset, and a 70% precision bar for advisory steps.
- **Web3 is first class.** Wallet prompts are test objects, the signing policy is code, and chain state is checked in code.

Jevy is an open-source TypeScript project, distributed on npm. This repository contains only the Jevy product itself: the core library, the CLI, the Playwright plugin, the decider adapters and the Web3 wallet pack. You install it into your own project and configure it for your own app. No sample app ships with it. Plain Playwright code runs the test. AI is used where a locator or an exact string is the wrong check: picking an element while recording, and judging whether a page means what you expect. `jevy record` can also write a new spec when you do not have one yet. What you commit is a normal Playwright spec plus the redacted decision cache.

Replaying recorded actions is not a Jevy-only idea. The claim here is narrower. Assertion verdicts are cached as well as actions, each one bound to the redacted state and to the decider and model, and the gates run again on replay.

Jevy is an independent, personal open-source project by Adam Gencel. It is not affiliated with, endorsed by, or sponsored by TypeSafe AI, Inc. or any employer. Jev is a trademark of TypeSafe AI, Inc. and is used here only to identify the model Jevy can call. Jev is one supported backend; Kev (local) and any LLM you plug in work too. v0.1 targets Playwright only.

## `jevy guard` (works today)

A coding agent that writes the code also edits the tests, and the quickest way to turn a failing test green is to weaken it. `jevy guard` compares two versions of your repo and lists every change that could weaken your checks, so a person can review them. It does not call a model. It parses files with the TypeScript compiler and never runs code from your repo.

    jevy guard --base origin/main               # compare the working tree, untracked files included
    jevy guard --base origin/main --head HEAD   # compare two commits
    jevy guard --base origin/main --json        # machine-readable output

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
  - a decision-cache line added with a non-null `reviewedBy`. Approvals must be made by a human.
- **Review, which does not fail by default.** It flags:
  - a changed `toSatisfy` statement
  - a changed matcher, a changed literal argument, or an added `.not`
  - a changed test whose title is not a string literal
  - a changed `.each` table
  - changed `redact`, `normalise` or `decider` settings, and any other config change
  - raised Playwright `retries`, or changed test selection (`testIgnore`, `testMatch`, `grep` and similar)
  - added or removed decision records
  - a file that does not parse
- **Info:** added tests, added assertions, renamed tests (same body under a new title).

Reformatting, comments, reordered imports or tests, and renamed variables produce no findings.

Options: `--fail-on weakening|review|never` (default `weakening`), `--cache-dir <dir>` (default `.jevy/decisions`), `--cwd <dir>`.

Exit codes: `0` nothing at or above `--fail-on`; `1` something is; `2` usage or git error (unknown ref, not a git repo).

In CI, run it next to your tests on every pull request. Compare against the merge base, not the tip of the target branch; otherwise tests added to the target after your branch started look like tests you removed. Fetch full history first (`fetch-depth: 0`):

    - run: npx jevy guard --base "$(git merge-base origin/${{ github.base_ref }} HEAD)" --head HEAD

JSON (`--json`) prints exactly one document. The schema is versioned by `v`. Findings are sorted by file, then line, then kind, so the output is byte-identical across runs:

    { "v": 1, "tool": "jevy-guard", "base": "origin/main", "head": "HEAD",
      "summary": { "weakening": 1, "review": 0, "info": 2 },
      "findings": [ { "kind": "assertion-removed", "severity": "weakening",
        "file": "tests/checkout.spec.ts", "test": ["checkout", "pays by card"], "line": 4,
        "message": "checkout > pays by card has 1 fewer assertion (2 -> 1): removed toHaveText",
        "before": "expect(…).toHaveText(\"Paid\")" } ] }

`head` is `"working-tree"` when `--head` is omitted. `test`, `line`, `before` and `after` appear only when they apply. `line` is the line in the head version, or in the base version when the thing it points to is gone.

Known limits. It is a mechanical check, so it does not see: a removed `await` in front of an `expect`; assertions inside helper functions or a custom `expect` wrapper; a changed subject or argument that is not a literal; an early `return` or a `try`/`catch` around assertions; tests in files outside the default test globs; a decision record edited in place, which shows as one removal and one addition for review. A test with a non-literal title is only ever flagged for review.

## How Jevy compares

Notes on three tools that also put a model in the browser loop, from their public docs and packages as reviewed in November 2026.

- **[e2e](https://github.com/tester-army/e2e)** (TesterArmy, Apache-2.0) is its own runner. Tests are `*.e2e.ts` and import `test` and `expect` from `e2e`, not from `@playwright/test`. A test can mix Playwright-style locators with `agent.act`, `agent.assert`, `agent.waitFor` and `agent.extract`. It ships a TypeSafe Jev decision executor, [`@e2e-dev/decision`](https://www.npmjs.com/package/@e2e-dev/decision), and it replays verified action paths from a cache that is read-only in CI. The model is not part of that cache key. Assertions, waits and extracts run live; assertion verdicts are not cached. Docs: [e2e.tester.army](https://e2e.tester.army/).
- **[Stagehand](https://github.com/browserbase/stagehand)** (Browserbase, MIT) is a browser-agent SDK rather than a test framework. It offers act, observe and extract. Its server-side cache is keyed by the instruction, the page content and the options, and the model is not part of that key. Docs: [docs.stagehand.dev](https://docs.stagehand.dev/).
- **[Midscene.js](https://midscenejs.com/)** (ByteDance web-infra) caches action planning and XPath locating. `aiAssert`, `aiQuery` and `aiBoolean` are not cached. Modes include read-only and write-only. See [midscenejs.com/caching](https://midscenejs.com/caching).

e2e is the tool that drives an app at runtime, including on mobile. Jevy is the layer for a suite that stays on `@playwright/test`, with judgments that can be cached, re-gated and reviewed.

## Why

Current AI testing tools tend to have the same problems (sources in the research notes behind this repo):

- **Silent self-healing hides real regressions.** Healers can loosen assertions or skip tests.
- **A guessed verdict.** A low-confidence answer treated as pass or fail is not something CI should merge on.
- **A model call on every assertion.** Re-running the judgment on every CI run costs time and money, and a retry can draw a different answer.
- **A new runner.** Some tools replace `@playwright/test` with their own runner and file format, so an existing suite has to be rewritten.
- **Shallow oracles.** Free-text LLM judges with no measured accuracy on *your* app.

The design principles that follow from this:

1. **Playwright stays the runner.** Jevy wraps `@playwright/test`. Specs stay Playwright specs.
2. **Plain code first.** Locators and exact assertions run as written. AI is called only where code cannot decide.
3. **Three verdicts, gates on by default.** AI checks return `pass`, `fail` or `needs-review`. The default thresholds are 0.8 and 0.5. A weak yes or no is `needs-review`, never a guessed pass or fail. Pull requests warn; `main` fails. Both are configurable.
4. **Never silent healing.** A broken locator produces a suggested diff for review, not a changed test.
5. **Cache verdicts and actions, then re-check the gates.** Entries are committed to git and keyed on the decider and the model. A relevant state change is a miss. Replay applies the gates again and makes no model call.
6. **Numbers in code.** Amounts, balances, dates and chain state are checked with code (for example viem), never judged by AI.
7. **Swappable models.** One `Decider` interface. Adapters ship for TypeSafe AI's Jev (pinned `jev-1.14.0`), Kev (open-weight, runs locally) and a generic LLM judge. The decider and model are part of the cache key.
8. **Measure it.** A public labelled dataset and `eval` report accuracy and calibration. An advisory step stays on only if at least 70% of its findings are accepted.

## Quickstart: set Jevy up for your app (intended)

These steps show the planned setup. Only `@jevyjs/core` is implemented so far; the other packages are still stubs, and the only npm publish is the placeholder `@jevyjs/cli` 0.0.1. Loading `jevy.config.ts` uses Node's built-in type stripping, so it needs Node 22.18 or later.

**1. Install** into a project that uses (or will use) Playwright:

```bash
pnpm add -D @playwright/test @jevyjs/playwright @jevyjs/cli
pnpm add -D @jevyjs/deciders-jev      # and/or @jevyjs/deciders-kev, @jevyjs/deciders-llm
pnpm add -D @jevyjs/web3 viem         # only if your app has wallet flows
```

**2. Choose a decider and supply its credentials** through environment variables. Never commit them.

```bash
# .env (gitignored)
TYPESAFE_API_KEY=...          # if you use Jev
# Kev runs locally: start its server separately (see Kev's README), then point Jevy at it
```

**3. Configure** `jevy.config.ts` for your app:

```ts
// jevy.config.ts (sketch; fields will change)
import { defineConfig } from "@jevyjs/core";

export default defineConfig({
  // your app's URL stays in playwright.config.ts (use.baseURL)
  decider: "jev",                                    // one-line switch: "kev" keeps data local
  deciders: {
    jev: { apiKeyEnv: "TYPESAFE_API_KEY", model: "jev-1.14.0" },
    kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-4b@v1.0" },
    llm: { adapter: myLlmAdapter, model: "provider/model-id" }, // any provider; the model pin is required
  },
  cache: { dir: ".jevy/decisions" },                 // committed to git, redacted, keyed on decider and model
  ci: { needsReview: { pr: "warn", main: "fail" } },
});
```

**4. Web3 apps only: configure your own wallet, RPC and network.** Jevy ships no keys, RPC endpoints or chain defaults.

```ts
// in jevy.config.ts (sketch)
web3: {
  driver: "mock",                                    // injected EIP-1193 provider (default)
  chain: { id: 11155111, rpcUrlEnv: "SEPOLIA_RPC_URL" },  // your testnet, or a local fork:
  // chain: { fork: { rpcUrlEnv: "FORK_SOURCE_RPC_URL" } }, // Jevy starts Anvil for you
  account: { privateKeyEnv: "JEVY_TEST_PRIVATE_KEY" },  // throwaway test key only
  policy: "./wallet-policy.ts",                     // approve/reject/stop rules, in code
  // mainnet signing is refused unless you set allowMainnetSigning: true explicitly
},
```

**5. Extend the suite you already have, or record a missing flow,** with the levels below. Run locally in `record` mode, and commit the specs plus `.jevy/decisions/`. CI replays cached actions and verdicts, re-checks the gates, and makes no model calls.

## Three levels

The path for a suite you already run is level 2. Level 1 is for a flow that has no spec yet. Level 3 comes later. This section predates the roadmap re-order of 18 Nov 2026: recording a flow and repairing a locator are now planned as tools the developer's own coding agent calls (roadmap step 6), not as Jevy's own agent loop.

### Level 2: existing Playwright tests → add semantic assertions and locator-repair suggestions (v0.1)

```bash
pnpm add -D @jevyjs/playwright
```

```ts
import { test, expect } from "@jevyjs/playwright"; // wraps @playwright/test

test("order is confirmed", async ({ page }) => {
  await page.goto("/checkout");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page).toSatisfy("The page shows the order as confirmed, not as failed or pending");
  await expect(page.getByTestId("total")).toHaveText("$42.00"); // numbers stay in code
});
```

When a locator stops matching, the reporter proposes a repaired locator as a reviewable diff. The test itself is never changed silently. A Playwright retry replays the cached verdict for that state. It does not call the model again inside the same run.

### Level 1: no tests yet → record a spec from a plain-English goal (v0.1)

```bash
npx jevy record "Sign up with a new email and reach the dashboard" --url http://localhost:3000
```

1. An LLM plans the steps and the input values **once**.
2. At each step, the decider picks the action and the element from the page's accessibility tree.
3. Checks that need judgement are decided by the decider. Numeric checks are emitted as ordinary code assertions.
4. Output: `tests/sign-up.spec.ts`, a plain Playwright spec you can read, edit and commit, plus the recorded decisions.

### Level 3: property and invariant generation (planned, v0.2)

An LLM proposes properties and invariants, which run in fast-check (TypeScript) and in Foundry, Echidna or Medusa (Solidity). A property is kept only if it compiles and kills a mutant or a seeded bug.

```bash
npx jevy properties propose --target packages/sdk/src   # intended, v0.2
```

The v0.2 pilots are public OSS projects, so results can be shared: viem (TypeScript) and OpenZeppelin Contracts (Solidity).

## Web3 wallet pack (v0.1)

`@jevyjs/web3` is a generic feature for any dApp you test. It treats wallet pop-ups as test objects:

- The decider classifies each prompt (connect, sign message, sign typed data, send transaction, approve, switch network, unknown).
- A policy written in TypeScript decides whether to approve, reject or stop.
- Amounts, recipients and chain IDs are decoded and checked in code, never by AI.
- Chain-state assertions run in code against the network you configure: a local Anvil fork or a public testnet.
- Mainnet signing is never enabled by default.

## Demos (coming soon)

Recorded videos of Jevy running against real public web3 sites. They are produced outside this repository, and no demo app or site-specific code ships here.

| Demo | Site | What it shows | Video |
|---|---|---|---|
| 1. Swap flow | Uniswap web app (testnet mode: Ethereum Sepolia or Unichain Sepolia) | `jevy record` from a plain-English goal; wallet prompt classified; policy approves a testnet swap, or the run stops at the confirm screen and rejects the signature; amounts checked in code | *Coming soon* |
| 2. TBD | Another public web3 site | Level-2 `toSatisfy` checks and a locator-repair diff | *Coming soon* |

Jevy is not affiliated with Uniswap Labs or any site shown in the demos.

## Evaluate before you trust

```bash
npx jevy eval --cases eval/cases.jsonl --deciders jev,kev,llm
```

This reports accuracy, true positive and true negative rates, calibration, latency and cost per decider, and suggests confidence thresholds.

The project will publish a public seed dataset of about 200 labelled cases, taken only from public apps (such as the Uniswap web app), so anyone can rerun the benchmark. It may live in a separate dataset repo, depending on the licensing of site snapshots (see OPEN-QUESTIONS). Run `eval` on your own labelled cases too before trusting a decider on your app. An advisory step stays on only if at least 70% of its findings are accepted as real.

## Packages

The workspace matches this layout. Each package builds. The last column says what is implemented today.

| Package | Purpose | Today |
|---|---|---|
| `@jevyjs/core` | Decider interface, decision cache, verdicts, accessibility snapshot handling | Implemented |
| `@jevyjs/playwright` | Plugin: page snapshots, `toSatisfy`, reporter | Snapshots only |
| `@jevyjs/cli` | CLI (bin `jevy`): `guard`, later `cache`, `eval`, `init` | `guard` only |
| `@jevyjs/deciders-jev` | TypeSafe AI Jev adapter | Stub |
| `@jevyjs/deciders-kev` | Kev (local, open-weight) adapter | Stub |
| `@jevyjs/deciders-llm` | Generic LLM-judge adapter | Stub |
| `@jevyjs/web3` | Wallet pack: mock EIP-1193 provider, prompt classification, policy, viem decoding, user-configured fork or testnet | Stub |

## Privacy note

Hosted deciders (Jev, cloud LLMs) receive page content: accessibility trees and, if you enable them, screenshots. Jev is served from a US-hosted API, and zero data retention is enterprise-only per TypeSafe's docs. The intended use for Jev is staging and public apps. To keep data local, switch to Kev with one config line, per project or per test:

```ts
// jevy.config.ts (intended)
export default defineConfig({ decider: "kev" });
// or for one test file: test.use({ decider: "kev" });
```

API keys come from environment variables (for example `TYPESAFE_API_KEY`) and must never be committed. Decision records are redacted before they are written. Built-in rules match patterns — keys, emails, seed phrases and transaction hashes — without a list of registered secret values. See [DESIGN.md § Security and privacy](docs/DESIGN.md#9-security-and-privacy).

## Contributing and licence

MIT, see [LICENSE](LICENSE). Contributions are welcome under the Developer Certificate of Origin (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Development needs Node >= 22.18 (`.nvmrc` is 22; CI also runs Node 24). Maintainer: Adam Gencel (sole maintainer).

## Trademarks

Jev and TypeSafe are trademarks of TypeSafe AI, Inc. Uniswap, Playwright and other product names belong to their respective owners. Jevy is not affiliated with, endorsed by, or sponsored by any of them. The names are used only to describe compatibility.
