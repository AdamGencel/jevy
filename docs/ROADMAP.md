# Jevy — Roadmap

Status: **M0 and M1 are done** (toolchain, plus the `@jevyjs/core` decision layer). **Step 1 below is in progress.** Jevy is a personal project with one maintainer (Adam Gencel). This roadmap was re-ordered on 18 Nov 2026; the old milestone numbers are mapped at the end. No step has a date: each one lists what it delivers and how we know it is done.

## Direction

Jevy is an open-source test framework for a time when coding agents write most of the code and most of the tests. In that setting the scarce thing is not a written test. It is a result you can trust. Five properties follow, and every step below serves at least one of them.

1. **Agent-operable.** An agent can install, run and read Jevy without a person: non-interactive commands, stable exit codes, a versioned machine-readable report, and reasons on every non-pass.
2. **Tamper-evident.** The agent that writes the code also edits the tests. Jevy flags a weakened test, checks that a new cached verdict really came from a model, and does not let an agent approve its own `needs-review`.
3. **Cheap and repeatable in the loop.** Verdicts are cached in git and replayed with no model call. A relevant change is a miss, not a guess.
4. **Honest about doubt.** Three verdicts. A weak or cut-off answer is `needs-review`, never a guessed pass or fail.
5. **Measured.** `eval` reports how often each decider is right on labelled cases before anyone trusts it.

Jevy does not ship its own agent loop. The developer's coding agent does the driving; Jevy gives it tools and guardrails. Playwright is the first runner. Web3 stays first class: wallet prompts, signing policy and chain state use the same decision, cache and guard mechanisms as any other check.

## Steps

### Step 1 — Foundations (in progress)

Five work packages. They do not depend on a model or on the network.

| # | Package | Delivers | Done when |
|---|---|---|---|
| 1a | Core contract | `callDecider` reports whether the snapshot was cut. A cut-off snapshot can never produce `fail`. An answer can abstain, and an abstention is `needs-review`. The snapshot hash carries a rules version, with golden-hash tests, and a fingerprint of the project's redaction and normalisation rules. | A rule change that alters a hash fails a test until the version is bumped. |
| 1b | Pruning and robustness | Pruning keeps alerts, dialogs, status regions and headings longest. The token budget is always met or the call fails. Malformed snapshots raise `SnapshotError`. A redaction or normalisation rule that can never settle is rejected when the config loads. | The findings left open by the first code review are closed with tests. |
| 1c | Decision cache | Key scheme, record format, JSONL store (one file per spec), `replay` / `replay-or-query` / `record`, re-gating on a hit, a reason on every miss, and writes held until the test confirms the step. | A fixture run in `replay` makes zero decider calls, and every miss names its reason. |
| 1d | Snapshot source | Current Playwright has no `page.accessibility`. This package turns `ariaSnapshot()` output into the tree core expects, and records what the snapshot does and does not expose (password values, autocomplete). | Round-trip tests on fixture pages in a real browser; a written finding in `docs/spikes/`. |
| 1e | Guard | `jevy guard --base <ref>` compares tests, config and cached decisions between two commits and reports weakening: removed tests or assertions, added `skip`/`fixme`, loosened statements or thresholds, and approvals added in the diff. No model call. | JSON output with a versioned schema; exit code distinguishes weakening from clean. |

### Step 2 — First end-to-end slice

- `@jevyjs/deciders-llm`: `llmDecider` over a user-supplied adapter, with structured output, validation, an explicit abstain option, and a compact snapshot format for the prompt. A published fake decider for tests.
- `@jevyjs/playwright`: `expect(page | locator).toSatisfy(statement)` on `@playwright/test`, using 1a–1d. Locator-scoped by default in the docs.
- `report.json` v1: verdict, source (cache or decider), miss reason, truncation, decider and model, per assertion.
- Done when: a fixture app passes, fails and returns `needs-review` as expected; a second run in `replay` makes no decider call; an agent can act on `report.json` alone.

### Step 3 — Measure the two risky assumptions

- **Hash stability.** Snapshot three real apps repeatedly over several days and report how often the hash of an unchanged page changes, per page and per region.
- **Judge accuracy.** About 30 hand-labelled cases through the LLM decider: accuracy, `needs-review` rate, and how often a confident answer is wrong.
- Needs network access and a model key. It decides whether whole-page hashing is usable or whether hashing must be scoped to the evidence the decider used.
- Done when: both numbers are written up, with a go or change decision for the cache key.

### Step 4 — Integrity

- `jevy cache verify`: in a trusted CI job, re-ask the decider about records added or changed in the pull request, and fail on disagreement. Unchanged records still cost nothing.
- Approvals an agent cannot grant itself: `reviewedBy` is honoured only when the commit that adds it passes a project-defined check (for example CODEOWNERS on the cache directory).
- `jevy guard` runs in CI by default, next to the tests.
- Done when: a forged `pass` record and a quietly deleted assertion both fail CI in a fixture repo.

### Step 5 — Eval and more deciders

- `jevy eval`: case schema, accuracy, true positive and true negative rates, calibration, latency, cost, repeat variance, and suggested thresholds.
- `deciders-jev` and `deciders-kev` as optional adapters. The generic LLM adapter stays the default path, because everyone can run it.
- Public seed dataset, subject to the licensing question in OPEN-QUESTIONS.
- Done when: the report is reproducible by someone without a Jev key.

### Step 6 — Agent surface

- A skill file and `llms.txt` so a coding agent can set Jevy up and use it correctly.
- `jevy init --yes`: non-interactive, no hosted key required.
- An MCP server exposing: run a check, read the report, explain a miss, list candidates for a broken locator, propose a repair as a diff. Recording a new flow and repairing a locator are done by the developer's agent through these tools, under the guard. Jevy does not run its own planner.
- Done when: an agent with only the skill file adds a `toSatisfy` check to a fixture suite and gets it green without weakening anything the guard watches.

### Step 7 — Web3 wallet pack

- Prompt classification, signing policy in code, decoded-request checks with viem, mock EIP-1193 driver, user-configured fork or testnet, mainnet signing refused by default.
- Built on the same pieces: a wallet prompt is a state, its classification is a cached decision, the policy file is watched by the guard.
- Done when: connect, sign and send pass against a fixture dApp on Anvil and replay in CI; a value-moving request outside the policy stops the run.

### Step 8 — Tests that prove they test something

- A mutation gate: a new or changed test must fail on at least one mutant of the code it covers. This is the check on agent-written tests.
- Property and invariant generation (fast-check; Foundry, Echidna and Medusa as external binaries), kept only when the property compiles, passes, and kills a mutant.
- Failure triage as an advisory step, held to the 70% acceptance bar.

### Step 9 — Release 0.1.0

- Setup guide, demo videos, npm publish with provenance, `"private": true` removed.
- Open questions 4 and 5 have written answers from TypeSafe recorded in OPEN-QUESTIONS.

Steps 1–4 run in order. Steps 5, 6 and 7 can run in parallel after step 2. Step 8 can start once step 2 is done.

## Later or unscheduled

- A Vitest matcher on the same core, for API responses, CLI output and other non-page states.
- API-level tests and a Cypress adapter.
- ERC-4337 helpers, a real-extension wallet driver, a vision fallback.
- Nightly exploratory runs, advisory only.
- Mobile: **not planned.**

## Old milestone numbers

| Old | Now |
|---|---|
| M0 foundation, M1 core | Done |
| M2 decision cache, M2 follow-up | Step 1c, step 4 |
| M3 deciders | Step 2 (LLM, fake), step 5 (Jev, Kev) |
| M4 Playwright plugin | Step 2 |
| M5 locator repair, M6 recorder | Step 6, as tools for the developer's agent |
| M7 eval and dataset | Step 3 (first measurement), step 5 |
| M8 Web3 wallet pack and demos | Step 7 |
| M9 release 0.1.0 | Step 9 |
| v0.2 properties and triage | Step 8 |
| v0.3 Web3 depth | Later |

## Tracking

Each step becomes a GitHub milestone with issues. Changes to this roadmap go through PRs.
