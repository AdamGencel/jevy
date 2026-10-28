# Jevy — Roadmap

Status: **M0 is done in the repo** (pnpm workspace, TypeScript, lint, Vitest, Changesets, GitHub Actions, DCO check). M1 onward is not started. Jevy is a personal project with one maintainer (Adam Gencel). All durations are *estimates* assuming roughly full-time work on it; part-time work stretches them proportionally. Each milestone lists its exit criteria. Scope: Playwright only for v0.1; API-level tests and Cypress come later (unscheduled); mobile is not planned.

## v0.1: levels 1 and 2, plus the Web3 wallet pack

The repo contains only the product packages. Demos are recorded videos made outside the repo.

Estimated total: about 6–8 weeks *(estimate)*. This is slightly shorter than before: there is no in-repo example app or fork-compatibility spike, and recording the demos is smaller work.

| # | Milestone | Scope | Exit criteria |
|---|---|---|---|
| M0 | Repo foundation | **Done.** github.com/AdamGencel/jevy; pnpm workspace, TS config, lint, Vitest, Changesets, GitHub Actions, MIT `LICENSE`, DCO sign-off check on PRs, `.gitignore` for `.env*`, these docs | **Done.** `pnpm build && pnpm test` is green in CI on the stub packages; npm org `@jevyjs` created (28 Oct 2026) and placeholder `@jevyjs/cli` 0.0.1 published (28 Oct 2026); public repo created (28 Oct 2026); TypeSafe AI brand check done (27 Oct 2026, see OPEN-QUESTIONS) |
| M1 | Core | `Decider` interface, question/answer/verdict types, snapshot pruning and hashing, normalisation rules, redaction, config loader | Unit tests: same page gives the same hash; cosmetic change gives the same hash; relevant change gives a new hash |
| M2 | Decision cache | JSONL store committed to git by default, redaction before write, optional external store for big suites, key scheme, `replay` / `replay-or-query` / `record` modes, `jevy cache prune` / `stats` | CI fixture run in `replay` mode makes zero network calls |
| M3 | Deciders | `deciders-jev` (pinned `jev-1.14.0`, `TYPESAFE_API_KEY`, base-URL allow-list, alias rejection), `deciders-kev` (laptop default `kev-4b@v1.0`, *estimate*; `kev-0.8b@v1.0` for smaller machines), `deciders-llm` (provider-agnostic, user-supplied adapter, structured output and validation), fake decider for tests; per-project and per-test decider selection | Contract test suite passes for all three adapters plus the fake; switching Jev to Kev is a one-line config change; Kev-4B runs on a MacBook within an acceptable latency budget (to measure) |
| M4 | Playwright plugin | `test`/`expect` wrappers, `toSatisfy` with three verdicts, reporter showing `needs-review`, CI policy (warn on PRs, fail on main, configurable) | Example suite: known-good pages pass, known-bad pages fail, ambiguous pages are `needs-review` |
| M5 | Locator repair | Candidate selection on locator failure, unified-diff suggestion in the report and an optional patch file; no source edits | A renamed button produces a correct one-line diff; the test is still reported as failing or `needs-review` |
| M6 | Recorder (`jevy record`) | LLM planning once, per-step action/element choice, interactive pause on low confidence, spec emission with role-based locators, numeric checks as code assertions | 3 goals on a small fixture app inside the package tests produce specs that pass in `replay` mode and read like hand-written Playwright |
| M7 | Eval (`jevy eval`) + public dataset | Case schema, metrics (accuracy, TPR/TNR, calibration, latency, cost, repeat variance), threshold suggestion, acceptance-rate tracking for advisory steps (70% bar), markdown/JSON report; label and publish about 200 cases from public apps only (Uniswap interface and others) | Public dataset published in the repo; report comparing Jev, Kev and an LLM is reproducible by anyone; default decider and thresholds chosen from it |
| M8 | Web3 wallet pack + record demo videos on public web3 sites (Uniswap first) | Generic pack: prompt classification, code policy, decoded-request checks with viem, mock EIP-1193 driver, user-configured network (local Anvil fork or testnet), mainnet signing refused by default. Then record demo videos outside the repo with Playwright video and trace: Uniswap web app first, in testnet mode (Ethereum Sepolia or Unichain Sepolia) or stopping at the confirm screen with the signature rejected. About 1 week for the pack plus 2–3 days for demos *(estimate)* | Pack: connect, sign and send flows pass against a fixture dApp page on Anvil and replay in CI; a value-moving request outside the policy stops the run; mainnet signing is refused without the explicit flag. Demos: at least one Uniswap video, testnet funds only or signature rejected, with no key visible, ready for the README |
| M9 | Release 0.1.0 | Docs site or README pass (setup guide for your own app, including web3 wallet, RPC and testnet config), demo videos embedded, npm publish via CI with provenance. Remove `"private": true` from each package before that publish | Fresh-machine quickstart for levels 1 and 2 and the web3 config works from the README on a user's own app |

**Order.** M0–M3 come first and in that order. M4–M5 and M6 can proceed in parallel. M7 should start early because it decides the default decider. M8 depends on M6, and its demo videos depend on M8's pack.

## v0.2: properties, invariants and triage

Estimated at about 6–8 weeks *(estimate)*.

- **`jevy properties propose`.** An LLM proposes properties in plain English from types, docs and NatSpec, then translates them to fast-check.
- **Mutation and seeded-bug filter for TypeScript.** Keep a property only if it compiles, passes on current code and kills at least one mutant. The mutation tool is still to be chosen; Stryker is a candidate *(suggestion, not yet evaluated)*.
- **Solidity.** Generate a Chimera-style shared suite that runs in Foundry for PRs and Echidna/Medusa nightly, invoked as external binaries. Seeds are stored for replay.
- **Ranking.** A decider ranks surviving properties for review. Humans accept or reject them.
- **Failure triage.** Classify failing tests as app bug, flaky test, environment or data, gated on confidence and evaluated with `eval`.
- **Pilots (public, shareable):**
  - viem (TypeScript, fast-check): round-trip properties such as ABI encode/decode, sign/recover and transaction serialize/parse.
  - OpenZeppelin Contracts (Solidity, Foundry plus Echidna/Medusa): token and access-control invariants.
  - Results and surviving properties are published. Upstream contributions go only through each project's normal process.
  - Exit criterion: at least one surviving property per pilot that would plausibly be accepted upstream *(target, not a promise)*.
- **Advisory steps** (triage, property ranking) stay on only if at least 70% of their findings are accepted.

## v0.3: Web3 depth and wider coverage

Estimated at about 6–10 weeks *(estimate)*.

- **ERC-4337 helpers.** UserOp building and assertion, paymaster and session-key flows, and bundler receipts checked in code.
- **Real-extension wallet driver** for smoke tests (MetaMask, Rabby), with xvfb guidance for CI.
- **Nightly exploratory run** (optional, advisory only). An agent explores the app and files `needs-review` findings for human triage; never a merge gate. It stays on only if at least 70% of its findings are accepted as real.
- **Vision fallback** for canvas and iframe-heavy UIs, gated behind a flag. This depends on Jev images leaving preview, or on a VLM adapter.
- **Optional pre-deployment AI audit hook** for contracts, as triage before a human audit, with its output treated as advisory.
- **Public benchmark** of Jevy deciders on an open labelled set, with reproducible eval reports.

## Later or unscheduled

- API-level tests and a Cypress adapter (planned for after v0.3; not scheduled).
- Mobile: **not planned.**
- Additional deciders.
- Solidity mutation tooling.
- An IDE helper for reviewing `needs-review` items.

## Tracking

Each milestone becomes a GitHub milestone with issues. Changes to this roadmap go through PRs.
