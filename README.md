# Jevy — AI-assisted testing that produces plain Playwright code

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: M3 (deciders) is in the tree.** `@jevyjs/core` implements the Decider types, verdicts, snapshot hashing, redaction, the `jevy.config.ts` loader, and the decision cache. `jevy cache stats` and `jevy cache prune` work. `@jevyjs/deciders-jev`, `@jevyjs/deciders-kev`, and `@jevyjs/deciders-llm` implement the three deciders. There is still no recorder or Playwright plugin. Only a placeholder `@jevyjs/cli` 0.0.1 is on npm (all packages publish under `@jevyjs/*`; installing `@jevyjs/cli` gives you the `jevy` command). Nothing here publishes automatically. The recorder, plugin, and eval commands below are the *intended* usage. The cache section and the [decider setup](#decider-setup) match the code. Design: [docs/DESIGN.md](docs/DESIGN.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Undecided: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

Jevy is an open-source TypeScript testing framework, distributed on npm. This repository contains only the Jevy product itself: the core library, the CLI, the Playwright plugin, the decider adapters and the Web3 wallet pack. You install it into your own project and configure it for your own app. No sample app ships with it. It uses AI where AI is good (picking the right element, judging whether a page means what you expect) and plain code everywhere else. What you commit is a normal, readable Playwright spec. AI decisions are recorded, so CI replays them deterministically.

Jevy is an independent, personal open-source project by Adam Gencel. It is not affiliated with, endorsed by, or sponsored by TypeSafe AI, Inc. or any employer. Jev is a trademark of TypeSafe AI, Inc. and is used here only to identify the model Jevy can call. Jev is one supported backend; Kev (local) and any LLM you plug in work too. v0.1 targets Playwright only.

## Why

Current AI testing tools tend to have the same problems (sources in the research notes behind this repo):

- **Silent self-healing hides real regressions.** Healers can loosen assertions or skip tests.
- **Nondeterminism and cost.** An LLM call on every step of every run is slow, expensive and not repeatable.
- **Lock-in.** Tests live in a vendor's format or cloud.
- **Shallow oracles.** Free-text LLM judges with no measured accuracy on *your* app.

The design principles that follow from this:

1. **Deterministic first, AI as a fallback.** Plain Playwright code runs first. AI is called only where code can't decide.
2. **Three verdicts, not two.** AI checks return `pass`, `fail` or `needs-review`, gated on a confidence you calibrate.
3. **Never silent healing.** A broken locator produces a suggested diff for review, not a changed test.
4. **Record once, replay in CI.** Every AI decision goes into a decision cache. CI re-queries only when the page actually changed.
5. **Numbers in code.** Amounts, balances, dates and chain state are checked with code (for example viem), never judged by AI.
6. **Swappable models.** One `Decider` interface. Adapters ship for TypeSafe AI's Jev (pinned `jev-1.14.0`), Kev (open-weight, runs locally) and a generic LLM judge.
7. **Measure it.** `eval` reports accuracy and calibration on *your* labelled cases before you trust any decider.

## Quickstart: set Jevy up for your app (intended)

These steps show the planned setup once the packages are published. The decider packages exist in this repo and are `"private": true`. The only npm publish is the placeholder `@jevyjs/cli` 0.0.1. Use the [decider setup](#decider-setup) against a local checkout today.

**1. Install** into a project that uses (or will use) Playwright:

```bash
pnpm add -D @playwright/test @jevyjs/playwright @jevyjs/cli
pnpm add -D @jevyjs/deciders-jev      # and/or @jevyjs/deciders-kev, @jevyjs/deciders-llm
pnpm add -D @jevyjs/web3 viem         # only if your app has wallet flows
```

**2. Choose a decider and supply its credentials** through environment variables. Never commit them. The working setup is [below](#decider-setup).

```bash
# .env (gitignored)
TYPESAFE_API_KEY=...          # only if you opt in to Jev; read at call time
# Kev runs locally. Start its server, then point Jevy at it (see Decider setup).
```

**3. Configure** `jevy.config.ts` for your app. There is no `baseURL` key in config today (the app URL is an argument to `record`, which is not built yet). Unknown keys are rejected.

```ts
import { defineConfig } from "@jevyjs/core";

export default defineConfig({
  decider: "jev", // one-line switch: "kev" keeps data local. There is no default.
  deciders: {
    jev: { model: "jev-1.14.0" }, // key env is TYPESAFE_API_KEY
    kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-4b@v1.0" },
    // llm: { adapter, model: "example/model-id" }, // only when decider is "llm"
  },
  cache: { dir: ".jevy/decisions" }, // committed to git, redacted
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

**5. Record or extend tests** with levels 1 and 2 below, run them locally in `record` mode, and commit the specs plus `.jevy/decisions/`. CI replays them. Cache modes, commands, and what to gitignore are in [Decision cache](#decision-cache) below.

## Three levels — no existing tests needed

### Level 1: no tests yet → record a spec from a plain-English goal (v0.1)

```bash
npx jevy record "Sign up with a new email and reach the dashboard" --url http://localhost:3000
```

1. An LLM plans the steps and the input values **once**.
2. At each step, the decider picks the action and the element from the page's accessibility tree.
3. Checks that need judgement are decided by the decider. Numeric checks are emitted as ordinary code assertions.
4. Output: `tests/sign-up.spec.ts`, a plain Playwright spec you can read, edit and commit, plus the recorded decisions.

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

When a locator stops matching, the reporter proposes a repaired locator as a reviewable diff. The test itself is never changed silently.

### Level 3: property and invariant generation (planned, v0.2)

An LLM proposes properties and invariants, which run in fast-check (TypeScript) and in Foundry, Echidna or Medusa (Solidity). A property is kept only if it compiles and kills a mutant or a seeded bug.

```bash
npx jevy properties propose --target packages/sdk/src   # intended, v0.2
```

The v0.2 pilots are public OSS projects, so results can be shared: viem (TypeScript) and OpenZeppelin Contracts (Solidity).

## Decider setup

There is no default decider. Jev is used only when you set `decider: "jev"` (or pass that override). The key is read when a call is made, from `TYPESAFE_API_KEY` only. Jevy does not read `TYPESAFE_AI_API_KEY`, does not log the key, and does not proxy the request: your process calls TypeSafe with your key. The pin is `jev-1.14.0`. `jev-latest` and `jev-preview` are rejected unless `deciders.jev.allowMovingAlias` is true. The base URL must be `https://api.typesafe.ai` (the default), `https://openrouter.ai/api`, or `https://ai-gateway.vercel.sh/typesafe`.

Kev is the local switch. The default pin is `kev-4b@v1.0` at `http://127.0.0.1:8009`, aimed at a normal developer laptop (Kev's README lists that checkpoint for a 32 GB Apple Silicon Mac). A smaller machine can set `model: "kev-0.8b@v1.0"`. Start Kev's own server for the pin you configured:

```bash
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b@v1.0 --port 8009
```

If that server is not running, the error says so and includes that command. It does not become a pass or a fail. Snapshots sent to Kev are pruned to 6000 tokens when you go through `callDecider` or the cache. Set `KEV_API_KEY` only when the local server was started with one. Ollama's System One endpoint is the same adapter with `baseUrl: "http://127.0.0.1:11434"` and a `requestModel` for the pulled tag; the cache pin stays the `model` you configured.

An LLM decider needs an explicit model pin. In config, pass `LlmAdapter` (`complete(prompt, jsonSchema)`). In code, you can instead pass any Vercel AI SDK `LanguageModel` to `llmDecider`. Each question is a bounded choice, including an inconclusive option. Picking that option is `needs-review`.

`selectDecider` reads the config and returns the id, pin, and connection details. `openDecider` builds the client from the factories you pass. Replay mode does not call a factory and does not construct a network client.

```ts
import { loadConfig, openDecider } from "@jevyjs/core";
import { jevDeciderFromSelection } from "@jevyjs/deciders-jev";
import { kevDeciderFromSelection } from "@jevyjs/deciders-kev";
import { llmDeciderFromSelection } from "@jevyjs/deciders-llm";

const config = await loadConfig();
const decider = await openDecider(config, {
  factories: {
    jev: jevDeciderFromSelection,
    kev: kevDeciderFromSelection,
    llm: llmDeciderFromSelection,
  },
});
```

Pass `{ mode: "replay" }` in CI so a cache miss does not open a client. Probability (how likely the chosen value is) and confidence (how peaked that belief is) are both stored. The verdict uses confidence only: a confident yes passes, a confident no fails, and a weak answer is `needs-review`. A network error throws `DeciderTransportError`. It is not cached as a pass or a fail.

`pnpm test` never calls the network. `pnpm test:live` is an optional Jev smoke test that runs only when `TYPESAFE_API_KEY` is set, and CI does not run it. Details are in [DESIGN.md §14](docs/DESIGN.md#14-decisions-made-in-m3).

## Decision cache

AI answers are written to `.jevy/decisions/` as JSON Lines, one sorted file per spec, and committed to git. Redaction runs before the cache key is built and before the line is written. A secret, a transaction hash (`0x` plus 64 hex characters), an email address, or a password-field value does not land in the file. The raw accessibility snapshot is not stored.

`cache.mode` defaults to `record` outside CI and to `replay` when `CI` is set. `replay` only reads the cache: a hit replays the answer, a miss is `needs-review`, and the decider is not called. `replay-or-query` replays a hit and queries on a miss. `record` always queries and overwrites that cache key.

```ts
// jevy.config.ts
cache: {
  dir: ".jevy/decisions", // committed to git
  // mode defaults to replay when CI is set, and record otherwise
  // store: myStore, // optional DecisionStore; a directory belongs in dir
},
```

A cosmetic page change (timestamp, UUID, long digit run) hits the cache. A renamed control or a checked-state change misses. The decider id and model pin are part of the key, so switching model does not reuse the old answer. A cached low-confidence yes or no still resolves to `needs-review`.

```bash
jevy cache stats [--dir .jevy/decisions]
jevy cache prune --days 30 [--dir .jevy/decisions]
jevy cache prune --not-referenced [--dir .jevy/decisions]
```

`stats` counts records, verdicts, and how many winning `needs-review` lines have `reviewedBy` set. `prune --days 30` drops superseded lines and any winner whose `lastUsedAt` is at least 30 days old. `lastUsedAt` moves on `record` and `replay-or-query`, not on CI `replay`, so a replay does not dirty the committed files. `prune --not-referenced` instead drops keys that the last `record` or `replay-or-query` run did not touch. Pass one of those flags, not both. Details are in [DESIGN.md §13](docs/DESIGN.md#13-decisions-made-in-m2).

Commit the JSONL. Ignore the lock, the temp files, and the last-run bookkeeping:

```gitignore
.jevy/**/.locks/
.jevy/**/.last-run.json
.jevy/**/*.tmp
```

For a large suite, point `cache.dir` at another directory, or pass a `DecisionStore`. The built-in alternatives are the JSONL store and an in-memory store. There is no cloud backend.

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

The project will publish a public seed dataset of about 200 labelled cases, taken only from public apps (such as the Uniswap web app), so anyone can rerun the benchmark. It may live in a separate dataset repo, depending on the licensing of site snapshots (see OPEN-QUESTIONS). Run `eval` on your own labelled cases too before trusting a decider on your app.

## Packages

The workspace matches this layout. `@jevyjs/core`, the cache commands in `@jevyjs/cli`, and the three decider packages are implemented. `@jevyjs/playwright` and `@jevyjs/web3` are still stubs.

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

API keys come from environment variables (for example `TYPESAFE_API_KEY`) and must never be committed. Decision records are redacted before they are written. See [DESIGN.md § Security and privacy](docs/DESIGN.md#9-security-and-privacy).

## Contributing and licence

MIT, see [LICENSE](LICENSE). Contributions are welcome under the Developer Certificate of Origin (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Development needs Node >= 22 (`.nvmrc` is 22; CI also runs Node 24). Maintainer: Adam Gencel (sole maintainer).

## Trademarks

Jev and TypeSafe are trademarks of TypeSafe AI, Inc. Uniswap, Playwright and other product names belong to their respective owners. Jevy is not affiliated with, endorsed by, or sponsored by any of them. The names are used only to describe compatibility.
