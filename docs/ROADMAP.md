# Jevy — Roadmap

Status: **design stage.** All durations are *estimates* for roughly one full-time maintainer and will move. Each milestone lists its exit criteria.

## v0.1: levels 1 and 2, plus a wallet-flow example

Estimated total: about 6–9 weeks *(estimate)*.

| # | Milestone | Scope | Exit criteria |
|---|---|---|---|
| M0 | Repo foundation | pnpm workspace, TS config, lint, Vitest, Changesets, GitHub Actions, licence, these docs | `pnpm build && pnpm test` green on an empty package set; npm scope and names reserved |
| M1 | Core | `Decider` interface, question/answer/verdict types, snapshot pruning and hashing, normalisation rules, redaction, config loader | Unit tests: same page gives the same hash; cosmetic change gives the same hash; relevant change gives a new hash |
| M2 | Decision cache | JSONL store, key scheme, `replay` / `replay-or-query` / `record` modes, `jevy cache prune` / `stats` | CI fixture run in `replay` mode makes zero network calls |
| M3 | Deciders | `deciders-jev` (pinned `jev-1.14.0`, base-URL allow-list, alias rejection), `deciders-kev`, `deciders-llm` (structured output and validation), fake decider for tests | Contract test suite passes for all three adapters plus the fake |
| M4 | Playwright plugin | `test`/`expect` wrappers, `toSatisfy` with three verdicts, reporter showing `needs-review` | Example suite: known-good pages pass, known-bad pages fail, ambiguous pages are `needs-review` |
| M5 | Locator repair | Candidate selection on locator failure, unified-diff suggestion in the report and an optional patch file; no source edits | A renamed button produces a correct one-line diff; the test is still reported as failing or `needs-review` |
| M6 | Recorder (`jevy record`) | LLM planning once, per-step action/element choice, interactive pause on low confidence, spec emission with role-based locators, numeric checks as code assertions | 3 example goals on a demo app produce specs that pass in `replay` mode and read like hand-written Playwright |
| M7 | Eval (`jevy eval`) | Case schema, metrics (accuracy, TPR/TNR, calibration, latency, cost, repeat variance), threshold suggestion, markdown/JSON report | Report on a seed set of about 200 labelled cases *(estimate)* comparing Jev, Kev and LLM; default decider chosen from it |
| M8 | Web3 wallet pack + example | Prompt classification, code policy, decoded-request checks with viem, mock EIP-1193 driver on an Anvil fork, wallet-flow example on a real dApp (choice open) | Connect, sign and send-transaction flow recorded and replayed in CI; a value-moving request outside the policy stops the run |
| M9 | Release 0.1.0 | Docs site or README pass, examples, npm publish via CI with provenance | Fresh-machine quickstart for levels 1 and 2 works from the README |

**Order.** M0–M3 come first and in that order. M4–M5 and M6 can proceed in parallel. M7 should start early because it decides the default decider. M8 depends on M6.

## v0.2: properties, invariants and triage

Estimated at about 6–8 weeks *(estimate)*.

- **`jevy properties propose`.** An LLM proposes properties in plain English from types, docs and NatSpec, then translates them to fast-check.
- **Mutation and seeded-bug filter for TypeScript.** Keep a property only if it compiles, passes on current code and kills at least one mutant. The mutation tool is still to be chosen; Stryker is a candidate *(suggestion, not yet evaluated)*.
- **Solidity.** Generate a Chimera-style shared suite that runs in Foundry for PRs and Echidna/Medusa nightly, invoked as external binaries. Seeds are stored for replay.
- **Ranking.** A decider ranks surviving properties for review. Humans accept or reject them.
- **Failure triage.** Classify failing tests as app bug, flaky test, environment or data, gated on confidence and evaluated with `eval`.
- **Pilot.** Round-trip and invariant properties on a real TypeScript SDK, for example an account-abstraction SDK. Exit criterion: at least one surviving property a maintainer would keep *(target, not a promise)*.

## v0.3: Web3 depth and wider coverage

Estimated at about 6–10 weeks *(estimate)*.

- **ERC-4337 helpers.** UserOp building and assertion, paymaster and session-key flows, and bundler receipts checked in code.
- **Real-extension wallet driver** for smoke tests (MetaMask, Rabby), with xvfb guidance for CI.
- **Nightly exploratory run** (optional, advisory only). An agent explores the app and files `needs-review` findings for human triage; never a merge gate.
- **Vision fallback** for canvas and iframe-heavy UIs, gated behind a flag. This depends on Jev images leaving preview, or on a VLM adapter.
- **Optional pre-deployment AI audit hook** for contracts, as triage before a human audit, with its output treated as advisory.
- **Public benchmark** of Jevy deciders on an open labelled set, with reproducible eval reports.

## Later or unscheduled

- Cypress or mobile adapters.
- Additional deciders.
- Solidity mutation tooling.
- An IDE helper for reviewing `needs-review` items.

## Tracking

Each milestone becomes a GitHub milestone with issues. Changes to this roadmap go through PRs.
