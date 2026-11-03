# Jevy — the AI layer for the Playwright suite you already have

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: M1 (core) is in the tree.** `@jevyjs/core` implements the Decider types, verdicts, snapshot hashing, redaction, and the `jevy.config.ts` loader (including `decider: "kev"`). There is still no decision cache, decider adapter, recorder, or Playwright plugin. Only a placeholder `@jevyjs/cli` 0.0.1 is on npm (all packages publish under `@jevyjs/*`; installing `@jevyjs/cli` gives you the `jevy` command). Nothing here publishes automatically. The commands and APIs below show the *intended* usage and will change. Design: [docs/DESIGN.md](docs/DESIGN.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Undecided: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

Jevy is the AI layer for the Playwright suite you already have. It plugs into `@playwright/test` instead of being a new runner. CI stays trustworthy, and a replay run makes no model calls:

- **Confidence gates are on by default.** A weak answer becomes `needs-review` (warn on pull requests, fail on `main`) instead of a guessed pass or fail.
- **Verdicts and actions are cached in git.** Each entry is keyed on the decider and the model. Replay re-checks the gates, so CI makes zero model calls.
- **Redaction is pattern-based.** Keys, emails, seed phrases and transaction hashes are caught without registering each secret.
- **There is a public eval.** A labelled dataset, and a 70% precision bar for advisory steps.
- **Web3 is first class.** Wallet prompts are test objects, the signing policy is code, and chain state is checked in code.

Jevy is an open-source TypeScript project, distributed on npm. This repository contains only the Jevy product itself: the core library, the CLI, the Playwright plugin, the decider adapters and the Web3 wallet pack. You install it into your own project and configure it for your own app. No sample app ships with it. Plain Playwright code runs the test. AI is used where a locator or an exact string is the wrong check: picking an element while recording, and judging whether a page means what you expect. `jevy record` can also write a new spec when you do not have one yet. What you commit is a normal Playwright spec plus the redacted decision cache.

Replaying recorded actions is not a Jevy-only idea. The claim here is narrower. Assertion verdicts are cached as well as actions, each one bound to the redacted state and to the decider and model, and the gates run again on replay.

Jevy is an independent, personal open-source project by Adam Gencel. It is not affiliated with, endorsed by, or sponsored by TypeSafe AI, Inc. or any employer. Jev is a trademark of TypeSafe AI, Inc. and is used here only to identify the model Jevy can call. Jev is one supported backend; Kev (local) and any LLM you plug in work too. v0.1 targets Playwright only.

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

These steps show the planned setup. The packages in this repo are still stubs, and the only npm publish is the placeholder `@jevyjs/cli` 0.0.1.

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
  baseURL: "http://localhost:3000",                  // your app
  decider: "jev",                                    // one-line switch: "kev" keeps data local
  deciders: {
    jev: { apiKeyEnv: "TYPESAFE_API_KEY", model: "jev-1.14.0" },
    kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-4b@v1.0" },
    llm: { adapter: myLlmAdapter },                  // any provider you plug in
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

The path for a suite you already run is level 2. Level 1 is for a flow that has no spec yet. Level 3 is planned for v0.2.

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

The workspace matches this layout. Each package builds, and none of them implement their milestone yet.

| Package | Purpose |
|---|---|
| `@jevyjs/core` | Decider interface, decision cache, verdicts, accessibility snapshot handling |
| `@jevyjs/playwright` | Plugin: `toSatisfy`, locator repair suggestions, reporter |
| `@jevyjs/cli` | CLI (bin `jevy`): `record`, `eval`, `cache`, later `properties` |
| `@jevyjs/deciders-jev` | TypeSafe AI Jev adapter |
| `@jevyjs/deciders-kev` | Kev (local, open-weight) adapter |
| `@jevyjs/deciders-llm` | Generic LLM-judge adapter |
| `@jevyjs/web3` | Wallet pack: mock EIP-1193 provider, prompt classification, policy, viem decoding, user-configured fork or testnet |

## Privacy note

Hosted deciders (Jev, cloud LLMs) receive page content: accessibility trees and, if you enable them, screenshots. Jev is served from a US-hosted API, and zero data retention is enterprise-only per TypeSafe's docs. The intended use for Jev is staging and public apps. To keep data local, switch to Kev with one config line, per project or per test:

```ts
// jevy.config.ts (intended)
export default defineConfig({ decider: "kev" });
// or for one test file: test.use({ decider: "kev" });
```

API keys come from environment variables (for example `TYPESAFE_API_KEY`) and must never be committed. Decision records are redacted before they are written. Built-in rules match patterns — keys, emails, seed phrases and transaction hashes — without a list of registered secret values. See [DESIGN.md § Security and privacy](docs/DESIGN.md#9-security-and-privacy).

## Contributing and licence

MIT, see [LICENSE](LICENSE). Contributions are welcome under the Developer Certificate of Origin (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Development needs Node >= 22 (`.nvmrc` is 22; CI also runs Node 24). Maintainer: Adam Gencel (sole maintainer).

## Trademarks

Jev and TypeSafe are trademarks of TypeSafe AI, Inc. Uniswap, Playwright and other product names belong to their respective owners. Jevy is not affiliated with, endorsed by, or sponsored by any of them. The names are used only to describe compatibility.
