# Jevy — Design

Status: **design stage, no implementation.** This document describes intended behaviour. TypeScript snippets are signature sketches, not code to copy. Facts about third-party tools come from the project research notes (`RESEARCH.md` and `QA-APPROACHES.md`, 27 Oct 2026). Anything marked *(estimate)* is a guess.

## 1. Goals

1. **Useful with zero existing tests.** Turn a plain-English goal into a normal, readable Playwright spec (level 1).
2. **Improve existing Playwright suites.** Add semantic assertions with three verdicts and suggest locator repairs as reviewable diffs (level 2).
3. **Generate properties and invariants** that survive a mechanical filter: they compile and kill a mutant or a seeded bug (level 3, v0.2).
4. **Deterministic CI.** Every AI decision is recorded and replayed. Re-query only when the relevant part of the page changed.
5. **Swappable models.** One `Decider` interface. Jev (hosted), Kev (local, open-weight) and generic LLM adapters ship from day one.
6. **Measured trust.** An `eval` command measures each decider on the user's own labelled cases and recommends thresholds.
7. **Web3 as the flagship example.** Wallet pop-ups are first-class test objects. The signing policy lives in code, and chain state is checked in code.

## 2. Non-goals

- **No new test runner.** We build on `@playwright/test` (latest at research time: v1.64.1, 14 Oct 2026).
- **No silent self-healing.** The research found silent heals hide regressions, and Playwright's own healer can loosen assertions or add `test.fixme()`.
- **No AI judgement of numbers, amounts, balances, dates, gas or chain state.** Jev's own docs say it is weak at maths, counting and date comparison ("keep the arithmetic in code").
- **No hosted cloud, dashboard or vendor test format.** Output is plain Playwright TypeScript.
- **Not an AI auditor, and no replacement for human review or audits.**
- **No natural-language tests at runtime.** Natural language is an authoring input. What runs in CI is code plus recorded decisions.
- **No autonomous exploratory testing in v0.1.** The evidence rates it "promising, not a merge gate": the best of 15 agents found and fixed 59.0% of bugs on SWEeper-Bench.

## 3. Architecture

```mermaid
flowchart TD
  subgraph Authoring["Authoring (offline)"]
    Goal["Plain-English goal"] --> Planner["LLM planner<br/>steps + input values, once"]
    Planner --> Recorder["Recorder loop"]
  end

  subgraph Runtime["Every run (local or CI)"]
    Step["Playwright step<br/>deterministic locator / expect"] -->|ok| Next["next step"]
    Step -->|locator miss or toSatisfy| Snap["Accessibility snapshot<br/>pruned + hashed"]
  end

  Recorder --> Snap
  Snap --> Cache{"Decision cache<br/>hit?"}
  Cache -->|hit| Gate
  Cache -->|miss| Decider["Decider interface"]
  Decider --> Jev["deciders-jev<br/>jev-1.14.0 (hosted)"]
  Decider --> Kev["deciders-kev<br/>local"]
  Decider --> LLM["deciders-llm<br/>generic judge"]
  Jev --> Gate{"Confidence gate"}
  Kev --> Gate
  LLM --> Gate
  Gate --> Ledger["Write decision record"]
  Ledger --> Out["pass / fail / needs-review<br/>repair diff · emitted spec"]

  Code["Code checks: numbers, balances,<br/>chain state (viem + Anvil)"] --> Out
  Web3["web3 pack: wallet prompt → classify →<br/>policy in code → approve / reject / stop"] --> Decider
```

**Principles**
- Deterministic code always runs first.
- The decider is consulted only at defined decision points: choose an action and element, judge a semantic check, classify a wallet prompt, and later rank properties.
- Every decision is written to the cache before its result is used.

### 3.1 Level 1: `record`

1. **Plan (LLM, once).** The goal and the start URL go to an LLM that returns a short step plan and concrete input values (emails, amounts). Plans are cached, and the recorder doesn't call the LLM again unless re-planning is requested.
2. **Act (decider, every step).**
   - Take an accessibility snapshot.
   - Build candidates as *(action, element)* pairs, for example `click button "Pay"` or `fill textbox "Email" with <value>`. Prune them to at most 255, Jev's `choice` limit.
   - Ask the decider to pick one. Low confidence pauses the run for the user (interactive) or aborts it (non-interactive).
   - An element can only be one the page actually has, because Jev returns a typed option ID.
3. **Check.**
   - Semantic outcomes ("the dashboard is shown") are judged by the decider and emitted as `toSatisfy(...)`.
   - Anything numeric is emitted as a deterministic assertion (`toHaveText`, `toHaveValue`, or a viem read). Values come from the plan or from the user, never from an AI verdict.
4. **Emit.**
   - Write a Playwright spec using role-based locators (`getByRole`, `getByLabel`, `getByTestId` when present).
   - Write the recorded decisions to the cache.
   - The spec must run without Jevy's AI parts, except for `toSatisfy` lines, which replay from the cache.

### 3.2 Level 2: Playwright plugin

- **`expect(page | locator).toSatisfy(statement, opts?)`.** The decider's yes/no confidence maps to three verdicts, using thresholds set per project. `needs-review` is reported separately and can be set to fail or warn in CI.
- **Locator repair.** When a locator in a test from an existing suite fails, the plugin asks the decider to choose among accessibility-tree candidates. It attaches a suggested replacement locator as a unified diff to the report. The test still fails or is marked `needs-review`; the source file is never edited automatically.
- **Reporter.** A Playwright reporter lists `needs-review` items and repair diffs, and can write them as a patch file or a PR comment body. Posting is left to the user's CI.

### 3.3 Level 3: properties and invariants (v0.2, outline)

1. An LLM proposes properties in plain English from types, docs, NatSpec and audits.
2. They are translated into fast-check properties (TypeScript) or a Chimera-style shared suite (Foundry, Echidna, Medusa).
3. **Filter:** a property is kept only if it compiles, passes on the current code, and fails on at least one mutant or seeded bug. Seeds are stored for replay.
4. A decider may *rank* surviving properties for human review. It never decides whether a property is correct.

Echidna, Medusa and Halmos are AGPL-3.0, so they are invoked as external binaries and never bundled.

## 4. Package layout (pnpm monorepo)

```
packages/
  core/            @jevy/core           Decider interface, cache, verdicts, snapshot pruning/hashing, config
  playwright/      @jevy/playwright     test/expect wrappers, toSatisfy, locator repair, reporter
  cli/             jevy (bin)           record, eval, cache, (v0.2) properties
  deciders-jev/    @jevy/deciders-jev   TypeSafe AI adapter (wraps @typesafe-ai/sdk)
  deciders-kev/    @jevy/deciders-kev   Kev adapter (same /v1/systemone wire shape, local URL)
  deciders-llm/    @jevy/deciders-llm   generic LLM judge (structured output; provider-agnostic)
  web3/            @jevy/web3           wallet prompt classes, policy, EIP-1193 mock, Anvil + viem helpers
examples/
  basic-record/    level-1 example
  plugin/          level-2 example
  wallet-dapp/     wallet-flow example on a real dApp (choice open)
eval/              shared eval fixtures and labelled-case schema
```

**Naming.** The CLI package publishes as `jevy` (bin `jevy`) and libraries as `@jevy/*`. Whether the CLI ships as the unscoped `jevy` or as `@jevy/cli` exposing a `jevy` bin depends on npm availability; see OPEN-QUESTIONS.

**Dependency rules.**
- `core` has no model SDK dependencies.
- Each decider is a separate package, so users install only what they use.
- `playwright` and `web3` depend on `core`, and on Playwright and viem as peer dependencies.

## 5. Key interfaces (sketches)

### 5.1 Decider

A decider answers typed questions about a state. Its shape mirrors Jev's question types (`choice`, `score`, `noul`) because they cover every decision point, and any LLM can emulate them with structured output.

```ts
type Question =
  | { kind: "choice"; prompt: string; options: { id: string; label: string }[] } // ≤ 255 options
  | { kind: "yesno"; prompt: string; criteria?: string }                          // Jev `noul`
  | { kind: "score"; prompt: string; levels: string[] };                          // 2–10 levels

interface Answer { value: string; confidence: number; raw?: unknown }

interface Decider {
  readonly id: string;     // e.g. "jev", "kev", "llm:<provider>/<model>"
  readonly model: string;  // pinned version, e.g. "jev-1.14.0"
  decide(state: DecisionState, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}
```

- **`DecisionState`** is the pruned accessibility snapshot plus small structured context: URL, step goal, wallet prompt fields. Screenshots are off by default, because Jev image input is preview-only.
- **`confidence`** is the decider's probability, which for LLMs may be a self-reported or vote-based proxy. It is not trusted until `eval` has calibrated it.
- **Adapters:**
  - **Jev:** maps to `POST /v1/systemone` and rejects the moving aliases (`jev-latest`, `jev-preview`) unless explicitly allowed.
  - **Kev:** the same wire shape against a local base URL.
  - **LLM:** prompts for structured output and validates it with zod.

### 5.2 Verdicts and the confidence gate

```ts
type Verdict = "pass" | "fail" | "needs-review";
interface Thresholds { pass: number; fail: number } // e.g. pass ≥ 0.8, fail < 0.5 (placeholders until eval)
```

The defaults are placeholders. `eval` suggests project-specific values.

### 5.3 Wallet pack

```ts
type WalletPromptKind =
  "connect" | "sign-message" | "sign-typed-data" | "send-transaction" |
  "approve-token" | "switch-network" | "add-network" | "unknown";

type PolicyDecision = "approve" | "reject" | "stop";
type WalletPolicy = (p: { kind: WalletPromptKind; decoded: DecodedRequest }) => PolicyDecision;
```

- The decider classifies only the prompt's *kind*.
- `decoded` holds the chain ID, recipient, value and calldata. It is parsed in code (viem) from the EIP-1193 request, never read by AI from the UI.
- The default policy stops on `unknown` and on anything that moves value without an explicit allow rule.
- **Two drivers:**
  - An injected mock EIP-1193 provider with a local key on an Anvil fork: fast and CI-friendly.
  - A real-extension driver, Synpress-style: realistic, but needs headed mode or xvfb in CI.

## 6. Decision cache format

**Location.** `.jevy/decisions/` in the repo, committed. One JSON Lines file per spec, so diffs stay reviewable.

**Key.** `sha256(kind, normalisedQuestion, optionIds, snapshotHash, deciderId, model)`.
- `snapshotHash` covers only the *relevant* subtree: the step's target region, or the whole page for page-level checks.
- Volatile attributes (timestamps, random IDs, counters) are normalised out by configurable rules, so cosmetic changes don't cause re-queries.

**Record (one line):**

```json
{"v":1,"key":"sha256:…","spec":"tests/checkout.spec.ts","step":"toSatisfy#2",
 "kind":"yesno","question":"The page shows the order as confirmed","snapshotHash":"sha256:…",
 "decider":"jev","model":"jev-1.14.0","answer":"yes","confidence":0.93,"verdict":"pass",
 "thresholds":{"pass":0.8,"fail":0.5},"createdAt":"2026-10-27T22:00:00Z","reviewedBy":null}
```

**Rules**
- **Records are immutable.** A re-query appends a new record, and `jevy cache prune` removes superseded ones.
- **Human review is recorded.** `reviewedBy` is set when a human accepts a `needs-review` verdict, and that becomes the replayed answer.
- **Model changes invalidate.** Changing the decider or model pin changes the key, so old decisions are never silently reused for a new model.
- **No secrets.** Records store hashes and questions, not raw snapshots. Snapshots can optionally go to a gitignored debug folder.

## 7. CI story

| Mode | Behaviour on cache miss | Intended use |
|---|---|---|
| `replay` (CI default) | Step reports `needs-review` (or fails, if configured); no network calls | PR checks: fully deterministic, no API keys needed |
| `replay-or-query` | Query the decider, record, continue | Nightly or main-branch runs that refresh the cache |
| `record` | Always query, overwrite | Local authoring |

- PR runs are deterministic and need no model keys or network in `replay` mode.
- A changed page shows up as a cache miss, which is a reviewable signal rather than a silent AI call.
- A scheduled job in `replay-or-query` mode refreshes decisions and opens a PR with the updated cache and any repair diffs. Opening the PR is a user-configured CI step, not built in.
- Nondeterministic steps (LLM planning, exploratory runs) never sit in the blocking path.
- **Cost.** At Jev's published $0.042 per million input tokens (output free), a refresh run is likely cheap. Planning with a frontier LLM costs more, but only at authoring time. *(estimate; depends on page size and run count)*

## 8. Eval harness

**Command.** `jevy eval --cases eval/cases.jsonl --deciders jev,kev,llm [--repeat 3]`

**Case format.** One labelled decision per line: the state (or a path to a saved snapshot), the question, and the expected answer. It is the user's own data. The suggested starting size is about 200 cases *(estimate)*.

**Metrics.** Per decider and per question kind:
- Accuracy and TPR/TNR (the practitioner standard for binary judges).
- Precision on `fail` verdicts.
- Calibration (reliability table and Brier score).
- `needs-review` rate at the suggested thresholds.
- p50 and p95 latency, cost per 1,000 decisions, and run-to-run disagreement over `--repeat`.

**Output.** A markdown and JSON report plus recommended thresholds.

**Why it's mandatory.** Red Hat's benchmark of Jev-1.13.0 (2 Oct 2026) found decision models "do not reliably outperform LLM-as-a-judge … in speed or accuracy" on guardrail tasks. That result is disputed on HN, and guardrail tasks aren't testing tasks, so the default decider should be whichever wins on the user's own cases.

## 9. Security and privacy

- **Data leaves the machine** with hosted deciders. Jev is a closed, hosted model served from the US. TypeSafe states customer data isn't used for training, but zero data retention is enterprise-only. Snapshots from staging may contain PII, tokens or internal data. Mitigations:
  - Redaction rules in `core`, applied before any decider call.
  - Screenshots off by default.
  - A `--decider kev` path that keeps everything local.
  - Hosted deciders must be enabled explicitly per project.
- **Look-alike Jev domains.** Third-party sites such as jevtypesafeai.com, aijev.app, madewithjev.com and jevlaya.cc proxy the API or sell "instant hosted keys". The Jev adapter will:
  - Default to `https://api.typesafe.ai`.
  - Accept only an allow-list of base URLs: the official API, Vercel AI Gateway, OpenRouter, or a user-declared Kev URL.
  - Warn loudly on anything else.
  - Docs will link only typesafe.ai and docs.typesafe.ai.
- **Prompt injection.** Page content is untrusted input to the decider; Jev's docs note it can be swayed by adversarial state. Mitigations:
  - A decider can only choose among options the code built.
  - Wallet actions go through the code policy, and `unknown` stops the run.
  - No decider output is ever executed as code.
- **Keys and wallets.**
  - API keys come from environment variables and are never written to the cache or reports.
  - The wallet pack uses throwaway keys on a local Anvil fork by default.
  - Running against a live network requires an explicit flag, and the default policy rejects value-moving requests.
- **Supply chain.** Pin the deciders' SDK versions. AGPL tools stay external binaries.
- **Model drift.** Pin `jev-1.14.0`. Moving aliases are rejected by default, and a model change invalidates cache keys.

## 10. Configuration sketch

```ts
// jevy.config.ts (sketch)
export default defineConfig({
  decider: { use: "jev", model: "jev-1.14.0", fallback: ["kev", "llm"] },
  thresholds: { pass: 0.8, fail: 0.5 },          // replace with eval output
  cache: { dir: ".jevy/decisions", mode: process.env.CI ? "replay" : "record" },
  redact: [/sk_live_\w+/, { role: "textbox", name: /password/i }],
});
```

Config files only. Fields will change.

## 11. Known risks

- **Jev maturity and access.** It launched 15 Sep 2026 and is in early access; the HN thread reported that signups were closed. Kev and the LLM adapters are the exit. The project must work without Jev.
- **Calibration** is disputed for Jev and unknown for LLM proxies. Use `eval` and three verdicts.
- **Competition.** Playwright's agents or vendors such as Momentic may add similar features. The differentiators are calibration, deterministic replay, the Web3 pack and plain code output.
- **Wallet automation is brittle.** Synpress documents headless issues. Default to the mock provider and keep the real-extension driver for smoke tests.
- **Level 3 evidence is mostly from Python** (Hypothesis). Whether it works as well with TypeScript and fast-check is unproven.
