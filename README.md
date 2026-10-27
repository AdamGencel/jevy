# Jevy — AI-assisted testing that produces plain Playwright code

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: design stage.** There is no code yet, and the repository ([github.com/AdamGencel/jevy](https://github.com/AdamGencel/jevy)) and the `@jevy` npm org are not created yet. The commands and APIs below show the *intended* usage and will change. Design: [docs/DESIGN.md](docs/DESIGN.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Undecided: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

Jevy is an open-source TypeScript testing framework, distributed on npm. This repository contains only the Jevy product itself: the core library, the CLI, the Playwright plugin, the decider adapters and the Web3 wallet pack. You install it into your own project and configure it for your own app. No sample app ships with it. It uses AI where AI is good (picking the right element, judging whether a page means what you expect) and plain code everywhere else. What you commit is a normal, readable Playwright spec. AI decisions are recorded, so CI replays them deterministically.

Jevy is an independent, personal open-source project by Adam Gencel. It is not affiliated with or endorsed by TypeSafe AI or any employer. Jev is one supported backend; Kev (local) and any LLM you plug in work too. v0.1 targets Playwright only.

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

Nothing is published yet. These steps show the planned setup.

**1. Install** into a project that uses (or will use) Playwright:

```bash
pnpm add -D @playwright/test @jevy/playwright @jevy/cli
pnpm add -D @jevy/deciders-jev      # and/or @jevy/deciders-kev, @jevy/deciders-llm
pnpm add -D @jevy/web3 viem         # only if your app has wallet flows
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
import { defineConfig } from "@jevy/core";

export default defineConfig({
  baseURL: "http://localhost:3000",                  // your app
  decider: "jev",                                    // one-line switch: "kev" keeps data local
  deciders: {
    jev: { apiKeyEnv: "TYPESAFE_API_KEY", model: "jev-1.14.0" },
    kev: { baseUrl: "http://127.0.0.1:8009", model: "kev-4b@v1.0" },
    llm: { adapter: myLlmAdapter },                  // any provider you plug in
  },
  cache: { dir: ".jevy/decisions" },                 // committed to git, redacted
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

**5. Record or extend tests** with levels 1 and 2 below, run them locally in `record` mode, and commit the specs plus `.jevy/decisions/`. CI replays them.

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
pnpm add -D @jevy/playwright
```

```ts
import { test, expect } from "@jevy/playwright"; // wraps @playwright/test

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

## Web3 wallet pack (v0.1)

`@jevy/web3` is a generic feature for any dApp you test. It treats wallet pop-ups as test objects:

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

## Packages (planned)

| Package | Purpose |
|---|---|
| `@jevy/core` | Decider interface, decision cache, verdicts, accessibility snapshot handling |
| `@jevy/playwright` | Plugin: `toSatisfy`, locator repair suggestions, reporter |
| `@jevy/cli` | `record`, `eval`, `cache`, later `properties` |
| `@jevy/deciders-jev` | TypeSafe AI Jev adapter |
| `@jevy/deciders-kev` | Kev (local, open-weight) adapter |
| `@jevy/deciders-llm` | Generic LLM-judge adapter |
| `@jevy/web3` | Wallet pack: mock EIP-1193 provider, prompt classification, policy, viem decoding, user-configured fork or testnet |

## Privacy note

Hosted deciders (Jev, cloud LLMs) receive page content: accessibility trees and, if you enable them, screenshots. Jev is served from a US-hosted API, and zero data retention is enterprise-only per TypeSafe's docs. The intended use for Jev is staging and public apps. To keep data local, switch to Kev with one config line, per project or per test:

```ts
// jevy.config.ts (intended)
export default defineConfig({ decider: "kev" });
// or for one test file: test.use({ decider: "kev" });
```

API keys come from environment variables (for example `TYPESAFE_API_KEY`) and must never be committed. Decision records are redacted before they are written. See [DESIGN.md § Security and privacy](docs/DESIGN.md#9-security-and-privacy).

## Contributing and licence

MIT, see [LICENSE](LICENSE). Contributions are welcome under the Developer Certificate of Origin (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Maintainer: Adam Gencel (sole maintainer).
