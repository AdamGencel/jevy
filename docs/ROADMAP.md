# Jevy — Roadmap

Status: **the toolchain and step 1 are done. Step 2 is next.** Jevy is a personal project with one maintainer (Adam Gencel). No step has a date: each one lists what it delivers and how we know it is done.

## Direction

Jevy is an open-source test framework for the AI era: a time when coding agents write most of the code and most of the tests. In that setting the scarce thing is not a written test. It is a result you can trust. Six properties follow, and every step below serves at least one of them.

1. **Agent-operable.** An agent can install, run and read Jevy without a person: non-interactive commands, stable exit codes, a versioned machine-readable report, and reasons on every non-pass.
2. **Tamper-evident.** The agent that writes the code also edits the tests. Jevy flags a weakened test, checks that a new cached verdict really came from a model, and does not let an agent approve its own `needs-review`.
3. **Cheap and repeatable in the loop.** Verdicts are cached in git and replayed with no model call. A relevant change is a miss, not a guess.
4. **Honest about doubt.** Three verdicts. A weak or cut-off answer is `needs-review`, never a guessed pass or fail.
5. **Measured.** `eval` reports how often each decider is right on labelled cases before anyone trusts it.
6. **Earned and inspectable.** A test joins the suite only if it covers something real and new, and a person can see what every test does and how it has behaved.

Jevy does not run a model loop of its own. Its planner, generator and healer are definitions and tools that run inside the developer's own coding agent. Playwright is the first runner. Web3 stays first class: wallet prompts, signing policy and chain state use the same mechanisms as any other check.

## Why this order

The order was revised on 23 Nov 2026, after a research pass on how teams verify agent-written code (QA research, 19 Nov 2026). Four findings set it:

- **Agents weaken tests when they can.** One model gamed the tests on 76% of deliberately impossible tasks, and read-only tests reduced it. So stopping a weakened test comes first (step 2), ahead of new features.
- **A passing test proves little.** Maintainers would not merge about half of the agent pull requests that passed their tests, and AI-written tests tend to assert whatever the code does today. So a new test has to earn its place (steps 5 and 6) before Jevy helps anyone create tests (step 7).
- **Model-judged checks are not yet reliable enough to block a merge.** Research oracles for user interfaces reach 50 to 72% precision. So `toSatisfy` ships as advisory (step 3) until its accuracy is measured (step 4).
- **Writing test scripts is a commodity; evidence is not.** Playwright ships free planner, generator and healer agents, and a company that only generated test scripts closed. So Jevy has no recorder of its own, and its versions of those agents exist to add what the free ones lack: knowledge of the app, of the tests that already exist, and a person's approval.

## Steps

### Step 1 — Foundations (done, 18 Nov 2026)

Five work packages. They do not depend on a model or on the network. Each was built and then reviewed independently; what they built is described in DESIGN.md §5 to §7.

| # | Package | Delivers |
|---|---|---|
| 1a | Core contract | `callDecider` reports whether the snapshot was cut. A cut-off snapshot can never produce `fail`. An answer can abstain, and an abstention is `needs-review`. The snapshot hash carries a rules version, with golden-hash tests. |
| 1b | Pruning and robustness | Pruning keeps alerts, dialogs, status regions and headings longest. The token budget is always met or the call fails. Malformed snapshots raise `SnapshotError`. A rule that can never settle is rejected when the config loads. |
| 1c | Decision cache | Key scheme, record format, JSONL store (one file per spec), `replay` / `replay-or-query` / `record`, re-gating on a hit, a reason on every miss, and writes held until the test confirms the step. |
| 1d | Snapshot source | Turns Playwright's `ariaSnapshot()` output into the tree core expects, and blanks secret fields. Findings are in `docs/spikes/`. |
| 1e | Guard | `jevy guard --base <ref>` compares tests, config and cached decisions between two commits and reports weakening. No model call. |

### Step 2 — The guard inside the agent's loop

Today the guard reports a weakened test after the fact. This step stops it earlier, and widens what the guard sees.

- **Hooks for coding agents.** A stop hook that runs the project's real test, type-check and lint commands, plus `jevy guard`, before the agent may say it is done. A pre-edit hook that blocks or flags edits to protected paths. Claude Code first; other agents where they offer hooks.
- **Protected paths.** A project lists what an agent must not change without a person: test plans, the Jevy config, the decision cache, and any tests it chooses. The guard treats a change there as weakening.
- **Weak new tests.** The guard also flags a new test with no assertion, an assertion that can never fail, and a test that only checks its own mocks.
- **A short skill file.** The exact commands and the rules, in a few lines. Long instruction files cost more and help less.
- **Guard items carried from step 1:** a merge-base option, configurable test globs, and reading the cache directory from the config.
- Before building: look at isitdone and tdd-guard, which the research names as the closest existing tools.
- Done when: in a fixture repo, an agent session cannot finish with a deleted assertion or an added skip without the hook stopping it; the guard flags an assertion-free new test; and a clean change passes with no finding.

### Step 3 — First end-to-end slice

- `@jevyjs/deciders-llm`: `llmDecider` over a user-supplied adapter, with structured output, validation, an explicit abstain option, and a compact snapshot format for the prompt. A published fake decider for tests.
- `@jevyjs/playwright`: `expect(page | locator).toSatisfy(statement)` on `@playwright/test`. Locator-scoped by default in the docs.
- **Advisory by default.** A `fail` or `needs-review` from `toSatisfy` is reported and does not fail the build until a project switches blocking on. Exact assertions in code still fail as usual.
- `report.json` v1: verdict, source (cache or decider), miss reason, truncation, decider and model, per assertion.
- Cache items carried from step 1: whether a key should be scoped to its spec, and how a retry that passes on a remembered answer gets its record written.
- Snapshot items carried from step 1: a link's URL is not in the tree; a password field switched to plain text by a "show password" control is not recognised as secret.
- Done when: a fixture app passes, fails and returns `needs-review` as expected; a second run in `replay` makes no decider call; an agent can act on `report.json` alone.

### Step 4 — Measure the two risky assumptions

- **Hash stability.** Snapshot three real apps repeatedly over several days and report how often the hash of an unchanged page changes, per page and per region.
- **Judge accuracy.** About 30 hand-labelled cases through the LLM decider: accuracy, `needs-review` rate, and how often a confident answer is wrong.
- Needs network access and a model key. It can run any time after step 3 and blocks only two things: making `toSatisfy` blocking, and the final shape of the cache key.
- Done when: both numbers are written up, with a decision on whether whole-page hashing stays and on when a project may switch blocking on.

### Step 5 — The app map and test fingerprints

To judge whether a test is worth having, Jevy has to know the app and what is already covered.

- **App map.** Routes, pages and API endpoints read from the codebase, written to a file a person can read. The project marks critical areas, for example login, payments and wallet signing.
- **Test fingerprint.** For each test, recorded from a real run: the pages it visits, the elements it interacts with, what it asserts, the endpoints it calls, and the client code it executes.
- **Coverage view.** Which parts of the map are covered, by which tests, and which critical areas are not covered at all.
- No model is needed. It can be built alongside step 3.
- Done when: on a fixture app the map lists every route and the tests that touch it; a fingerprint is identical across two runs of an unchanged test; an uncovered critical area is reported.

### Step 6 — Tests that earn their place

An admission check between "an agent proposed a test" and "the test joins the suite". It is the same for a test a person writes.

- **A plan a person approves.** Each test traces to one line in a short plan that says what the test protects and why. The plan is a protected path (step 2). A person approves the plan, not each test.
- **No duplicates.** A proposed test whose fingerprint adds nothing to the existing suite is rejected, with the tests that already cover it named.
- **No bloat.** A test is admitted only if it covers something uncovered, or catches a planted bug that no existing test catches.
- **A mutation gate, scoped to the change.** Small bugs are planted in the changed code. A new or changed test must fail on at least one. A model discards planted bugs that change nothing observable, and that judgement is a cached decision like any other.
- **Pruning.** `jevy suite` lists existing tests that add no coverage and catch no planted bug, with the time each one costs.
- Done when: on a fixture app a duplicate test is rejected; a test that catches no planted bug is rejected; a test with no plan line is rejected; and one redundant existing test is listed.

### Step 7 — Planner, generator and healer

Jevy's own versions of the three agents, built in from the start. They are agent definitions and a tool server, run by the developer's coding agent, as Playwright's are.

- **On a developer's machine and in CI.** The same definitions run in the developer's coding agent locally and in that agent's headless mode in CI. In CI they only propose: a plan line, a new test as a pull request, a fix as a suggested diff.
- **CI gates never need an agent.** Running tests in replay, the guard, the admission check, fingerprints and the report use no agent and no model. An agent's output never decides whether a merge is allowed.
- **Repairing a locator needs no agent.** Jevy builds the candidates and a decider picks one, which is a single typed question. It works in CI with a model key alone.

- **Planner.** Reads the app map and the coverage view first. Proposes plan lines only for what is missing, critical areas and changed code first, and says why each is not already covered.
- **Generator.** Writes a plain Playwright test from an approved plan line. Numbers become exact assertions; outcomes that need judgement become `toSatisfy`. Then the admission check runs.
- **Healer.** Never heals quietly. It proposes a fix as a diff and the test keeps failing until a person approves it. A fix that only points a locator at the same element is marked low risk. A fix that changes what is checked, loosens a statement or adds a skip is flagged by the guard.
- **`jevy init --yes`.** Non-interactive setup of the hooks, the skill file, the agents and the config, with no hosted key required.
- Done when: on a fixture app the planner proposes nothing for a flow that is already covered; the generator's test passes admission or is rejected with a reason; and for a renamed button the healer produces a one-line diff while the test stays red.

### Step 8 — The report page and the proof bundle

One set of facts, in a form for people and a form for machines.

- **Report page.** A static page generated by each run, opened locally or published from CI. Jevy hosts nothing. For each test: what it protects (its plan line), each step in plain words with what it checks, a screenshot per step with the element highlighted, the pages and code it covers, and its history of passes, failures and flakes.
- **History** on the page comes from the store in step 9. Until then the page shows the current run only.
- **Screenshots stay out of git and are never sent to a model.** Secret fields are masked before capture.
- **Proof bundle.** One signed file per pull request: the commit, what ran, the results, the guard's findings, the admission results and the mutation score. It is what a reviewer reads instead of re-running everything.
- Done when: a person can open the page for a fixture run and follow one test step by step; and the bundle for a pull request verifies against its commit.

### Step 9 — Test history

How each test has behaved over time: passes, failures, flakes, durations, verdict sources. A team must be able to keep it wherever it already keeps test results.

- **A documented, versioned results format.** Every run writes the same facts the report page and `report.json` use, as events any tool can read.
- **A store interface.** Small, in the manner of the decision store: append a run, read a test's history. A team plugs in its own.
- **A built-in store** that needs no service, so history works out of the box. A git branch or the CI system's cache are the candidates.
- **Third-party tools.** Jevy runs on `@playwright/test`, so a team that uses a results service such as Currents keeps its reporter. An exporter sends Jevy's own facts (plan line, verdict source, fingerprint) to tools that can take them.
- **The report page reads history through the same interface,** whichever store is behind it.
- Done when: a flaky test shows as flaky after three runs with the built-in store; the same history is read back through a second store written against the interface; and a run with no store configured still works.

### Step 10 — Integrity

- `jevy cache verify`: in a trusted CI job, re-ask the decider about records added or changed in the pull request, and fail on disagreement. Unchanged records still cost nothing.
- **Approvals an agent cannot grant itself.** One rule for every approval a person gives: a plan line, a healer's fix, and a `needs-review` verdict. It is honoured only when the commit that adds it passes a project-defined check, for example CODEOWNERS (OPEN-QUESTIONS item 7).
- `jevy guard` and the admission check run in CI by default, next to the tests.
- Cache housekeeping: `jevy cache ls`, `prune` and `stats`. Records are append-only, so superseded ones accumulate.
- Done when: a forged `pass` record, a quietly deleted assertion and a self-approved healer fix each fail CI in a fixture repo.

### Step 11 — Eval and more deciders

- `jevy eval`: case schema, accuracy, true positive and true negative rates, calibration, latency, cost, repeat variance, and suggested thresholds.
- `deciders-jev` and `deciders-kev` as optional adapters. The generic LLM adapter stays the one the docs start with, because everyone can run it.
- Public seed dataset, subject to the licensing question in OPEN-QUESTIONS.
- Done when: the report is reproducible by someone without a Jev key.

### Step 12 — Web3 wallet pack

- Prompt classification, signing policy in code, decoded-request checks with viem, mock EIP-1193 driver, user-configured fork or testnet, mainnet signing refused by default.
- Built on the same pieces: a wallet prompt is a state, its classification is a cached decision, the policy file is a protected path, and wallet steps appear on the report page like any other step.
- The planner, generator and healer handle a flow that includes a wallet prompt, which Playwright's own agents cannot.
- Done when: connect, sign and send pass against a fixture dApp on Anvil and replay in CI; a value-moving request outside the policy stops the run.

### Step 13 — Properties and invariants

- Property and invariant generation (fast-check; Foundry, Echidna and Medusa as external binaries), kept only when the property compiles, passes, and catches a planted bug.
- Failure triage as an advisory step, held to the 70% acceptance bar.

### Step 14 — Release 0.1.0

- Setup guide, demo videos, npm publish with provenance, `"private": true` removed.
- Open questions 4 and 5 have written answers from TypeSafe recorded in OPEN-QUESTIONS.

**Order.** Step 2 can start now. Steps 3 and 5 can run side by side. Step 4 follows step 3 whenever network access and a model key are available. Steps 6, 7, 8 and 9 follow in that order. Steps 10, 11 and 12 can run in parallel once step 3 is done. Step 13 follows step 6.

## Later or unscheduled

- A Vitest matcher on the same core, for API responses, CLI output and other non-page states.
- API-level tests and a Cypress adapter.
- Server-side code in the test fingerprint (step 5 covers client code, pages and endpoints).
- A cross-vendor format for the proof bundle, if one emerges.
- **A Jevy dashboard.** A hosted product that brings the report page, history, the proof bundles and the guard's findings together across a team's repos. It is optional and separate: the open-source framework never depends on it, and it is one more store behind the step 9 interface.
- A built-in agent runner, for a team that has no coding agent in CI. The agents are definitions and a tool server, so a runner can be added without changing them.
- ERC-4337 helpers, a real-extension wallet driver, a vision fallback.
- Nightly exploratory runs, advisory only.
- Mobile: **not planned.**

## Tracking

Each step becomes a GitHub milestone with issues. Changes to this roadmap go through PRs.
