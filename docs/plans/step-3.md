# Build plan — step 3: the first end-to-end slice

Status: **built, 26 Nov 2026.** What exists is described in [DESIGN.md §5.3 to §6.3 and §7](../DESIGN.md). This file is kept as the record of the plan; [What changed from the plan](#what-changed-from-the-plan) at the end says where the build differs. Read `AGENTS.md` first.

Why it is next: everything so far is a library and a guard. This step is the first time a test author writes `await expect(locator).toSatisfy("…")` and gets a verdict, a committed record, a replay with no model call, and a report an agent can read.

Items marked _(proposal)_ are choices the builder may change. Record the reason if you do. The three the maintainer should settle before building are under [Decide first](#decide-first).

## Decide first

Decided by the maintainer on 26 Nov 2026:

1. **The cache key gains the spec** (3a). It makes every existing record a miss and makes a renamed spec file a miss.
2. **A link's URL joins the snapshot hash** (3b). It changes the hash of every page with a link, so `SNAPSHOT_RULES_VERSION` goes to 3.
3. **`deciders-llm` takes no dependency on `ai`** (below), and pull requests #5 and #3 are closed. Both were closed on 26 Nov 2026; their branches are kept.

## Prior work: pull request #5

Branch `origin/deciders` (PR #5, stacked on PR #3) holds an LLM, a Jev and a Kev decider on the Vercel AI SDK. It cannot merge: it is built on PR #3's cache, which `main` replaced in step 1, and on a contract `main` does not have (a `probability` field on `Answer`, an `__jevy_abstain` sentinel value, `wire-question.ts`, `transport.ts`, `open-decider.ts`).

**Decision: rewrite `deciders-llm` on `main`'s contract and carry the ideas over, not the code.**

Taken from it:

- The answer schema: one object per question whose `value` is an `enum` of the allowed ids plus the abstain id. An answer outside the options cannot be expressed.
- The prompt lines that say the state is untrusted data and that a weak belief is not a vote for the opposite value.
- The rule that a bad payload or a failed call is never a pass or a fail and is never cached.
- Its test cases, rewritten: every question kind offers abstain; a thrown call is retried; a bad payload rejects; secrets do not appear in error text.

Not taken:

- **The `ai` dependency.** `llmDecider` depends only on core's `LlmAdapter` (`complete(prompt, jsonSchema)`). Reasons: OPEN-QUESTIONS decides "no hard dependency on any provider"; an AI SDK user needs about five lines to write an adapter, which the README shows; and `ai` is a large, fast-moving package whose only use here would be one `generateText` call. Step 3 adds no external dependency.
- **`probability` on `Answer`.** A generic model's self-reported probability is not a second signal. DESIGN §8.1 leaves this to the first adapter that has a real one (Jev, step 11).
- **The sentinel value.** `main` marks an abstention with `abstained: true` (§5.1). The abstain id exists only inside the adapter's schema.
- **JSON in the prompt.** DESIGN §5.7 (then §8.1) asks for the compact indented rendering.
- **`openDecider` and the Jev and Kev adapters.** Step 11.

**Afterwards** _(recommendation; the maintainer does it)_: close PR #5 and PR #3 with a link to this plan. Keep both branches until step 11: `jev.ts` and `kev.ts` record facts worth having then (the `/v1` suffix behind the allow-list, `kev-latest` as the request model, the `uv` hint on a refused connection), and PR #3 has `jevy cache stats` and `prune`, which step 10 needs.

## Before building

Checked against the installed `@playwright/test` 1.63.0 types (`playwright/types/test.d.ts`, `testReporter.d.ts`):

- `expect.extend(matchers)` accepts a matcher that returns `Promise<MatcherReturnType>`, and returns a new `expect`. `this` has `isNot`, `promise`, `utils` and `timeout`. It has no test info; `test.info()` gives it.
- `expect.soft` is typed with the extended matchers, so `expect.soft(locator).toSatisfy(…)` type-checks.
- `test.extend` takes option fixtures (`[default, { option: true }]`), automatic fixtures (`{ auto: true }`) and worker fixtures (`{ scope: "worker" }`). `mergeTests` and `mergeExpects` exist.
- `testInfo` has `attach(name, { body, contentType })`, `annotations`, `retry`, `status`, `expectedStatus`, `file`, `line`, `titlePath` (it starts with the file name), `project.outputDir`, `config.configFile`, `config.rootDir` and `config.reporter`.
- A reporter is a default-exported class with `onBegin`, `onTestEnd(test, result)` and `onEnd`. `result.attachments[].body` is a `Buffer`; `result.retry` and `result.status` exist; `test.titlePath()`, `test.location` and `test.outcome()` exist.
- The output directory "is cleaned at the start" of a run, and a worker restarted after a failure is a new process with a new `workerIndex`. So a retry does not share memory with the attempt before it.

Not checked. Confirm each with a five-line experiment before relying on it:

- `testInfo.status` is final inside the teardown of an automatic fixture, including after a soft failure.
- Playwright leaves a directory it did not create inside `outputDir` alone for the whole run.
- A reporter named by package subpath (`"@jevyjs/playwright/reporter"`) loads.
- A `Decider` object passed to `test.use` in a spec file reaches the fixture unchanged.
- Attachments survive the blob reporter and `merge-reports` (sharded runs). If not, say so in the README; do not fix it here.
- The oldest peer, 1.49, has all of the above. Only 1.63 is installed. Raise the peer range if it does not.
- The CI variable names in 3d (`GITHUB_REF_NAME`, `GITHUB_EVENT_NAME`, `CI_COMMIT_BRANCH`) are from memory.

## What exists to build on

- `packages/core/src/cache/session.ts`: `createDecisionSession({ store, mode, deciderId, model, decider?, thresholds, snapshot?, memo? })`, with `decide`, `confirm` and `discard`. `replay` never calls a decider. A decider whose `id` or `model` differs from the session's is refused.
- `packages/core/src/prepare.ts`: `callDecider` redacts and prunes the state, redacts the question, and checks the answers. A decider receives a tree that is already safe to send.
- `packages/core/src/config.ts`: `loadConfig` executes `jevy.config.*`; `selectDecider(config, override?)` resolves the id, the model and the adapter; `cache.mode` is `replay` when `CI` is set. Loading by execution is right inside a Playwright worker, which runs the project's code anyway. The guard still reads the file as text.
- `packages/playwright/src/snapshot.ts`: `snapshotAccessibility(page | locator)` returns core's tree with secret fields blanked. `parse.ts` drops `/url` lines today.
- `packages/deciders-llm/src/index.ts` is an empty stub. `LlmAdapter` is already a core type.
- `packages/cli/src/guard/`: `toSatisfy` is already parsed, its statement compared (`statement-changed`), and counted as an assertion by the weak-test rules. `weak-tests/model.ts` lists the modules whose `test` and `expect` are the framework's own; `@jevyjs/playwright` is not among them.

## How it runs

```
await expect(locator).toSatisfy(statement)         matcher.ts (3d)
  context for test.info()                          set up by the automatic fixture in fixtures.ts
  runtime, once per worker and on first use        runtime.ts
    loadConfig({ cwd })                            core; runs jevy.config.*
    selectDecider(config, the test's `decider`)    core
    llmDecider({ adapter, model })                 3c; not built in replay
    JsonlDecisionStore, the run directory          core; memo.ts: memo, claims, record marks
  session, one per test                            createDecisionSession
  snapshotAccessibility(target)                    snapshot.ts (3f)
  session.decide({ spec, step, question, state })  core
    replay: hit, re-gated; or miss -> needs-review, source "none", a miss reason
    otherwise: run memo, else callDecider -> llmDecider -> adapter.complete
  attach the report entry; annotate a non-pass     entry.ts, report/schema.ts (3e)
  return pass or not, by policy                    policy.ts
fixture teardown: session.confirm() writes the records keysToKeep keeps   runtime.ts
reporter, in the runner process: collect entries, write report.json   (3e)
```

- **Nothing is loaded until the first `toSatisfy` in a worker.** A suite that imports Jevy's `test` and never calls the matcher needs no `jevy.config.*`.
- **Replay needs no decider.** The session takes only the id and model. An adapter must read its key when called, not when the config is imported; the README says so.
- **Errors that are not verdicts still throw:** `ConfigError`, `RedactionError`, `SnapshotError`, `CacheError`, `QuestionError`. Only a `DeciderError` (3a) becomes `needs-review`.

## Work packages

They own separate files and can be built side by side against the interfaces named here. Each is built test-first, then a second, independent reviewer tries to break it. **No package edits an `index.ts` or `package.json` it does not own**; each hand-off lists the names it needs exported.

| #   | Package                 | Depends on                   |
| --- | ----------------------- | ---------------------------- |
| 3a  | Core: cache and config  | —                            |
| 3b  | Core: snapshot          | —                            |
| 3c  | `deciders-llm`          | types from 3a and 3b         |
| 3d  | Matcher and fixtures    | types from 3a, 3c, 3e and 3f |
| 3e  | `report.json`           | —                            |
| 3f  | Snapshot bridge         | the `url` field from 3b      |
| 3g  | Guard                   | the config key from 3a       |
| 3h  | Integration and docs    | all                          |

### 3a — Core: cache and config

Owns: `packages/core/src/cache/key.ts`, `cache/session.ts`, `config.ts`, `errors.ts` and their tests.

- **The key is scoped to its spec** _(proposal)_. `decisionKey` takes `spec` and hashes it as written to the record; `DECISION_KEY_VERSION` becomes 2. Today two specs that ask the same question of the same state share one record, so a person's review of one test silently approves another, and deleting one spec's file removes the other's answer. Cost: the same question in two specs is asked twice; a renamed spec misses with `no-entry` and is recorded again; every version 1 record misses. Nothing is released, so the last is free. The step stays out of the key: it is an ordinal and moves when an assertion is inserted.
- **A retry that passes on a remembered answer holds a record.** On a run-memo hit with no held record for that key in this session, `decide` builds the record from the remembered answer and holds it, so `confirm` writes it. Today it holds nothing and the next run asks again.
- **The first answer wins across processes.** After `memo.set(key, entry)` the session reads `memo.get(key)` and uses that entry. An in-memory memo returns what was set; a shared memo (3d) may return another worker's earlier answer.
- **`DeciderError`** in `errors.ts`: the decider could not be reached or kept returning invalid output. Nothing is memoised or held when `decide` rejects with one.
- **Config key `toSatisfy: { blocking?: boolean }`**, default `false` _(proposal)_. `parseConfig` validates it and `ResolvedJevyConfig.toSatisfy.blocking` is always set. This is the one switch for blocking. There is no per-test or per-assertion switch in this step: a local `blocking: false` would be a quiet weakening.

Exports to add: `DeciderError`, the config types.

### 3b — Core: snapshot

Owns: `packages/core/src/snapshot.ts`, `validate.ts`, `normalise.ts`, `redact.ts`, `prune.ts`, `project.ts`, a new `render.ts`, and their tests, including `golden-hash.test.ts`.

- **`url?: string` on `AccessibilityNode`** _(proposal)_. Validated as a string. Redacted with the text rules. Normalised to scheme, host and path: the query string and fragment are dropped, because that is where session tokens and signed links live and where volatile ids would make the hash unstable. A relative URL stays relative. The field is hashed, so a "Pay" link that points somewhere new is a new hash. Pruning shortens it on the root like the other text fields.
- **The golden-hash rule in `AGENTS.md` applies.** Bump `SNAPSHOT_RULES_VERSION` to 3, then regenerate the literals, and add a ninth golden snapshot with a link. Never regenerate without the bump.
- **`renderSnapshot(tree): string`** in `render.ts`: the compact form for a prompt, in the indented style of Playwright's aria snapshot (`- button "Pay" [disabled]`, `- textbox "PIN": [REDACTED]`, `/url` as a child line). It renders only the fields core hashes, in a fixed order, and is a pure function of the tree it is given. It lives in core so that the Kev and Jev adapters can share it in step 11.
- **`isSecretFieldName(text): boolean`**: the existing rule for names that mean a secret (password, passcode, private key and the rest), exported for 3f. No behaviour change.

Exports to add: `renderSnapshot`, `isSecretFieldName`.

### 3c — `@jevyjs/deciders-llm`

Owns: everything under `packages/deciders-llm/` (`src/llm.ts`, `src/schema.ts`, `src/prompt.ts`, `src/fake.ts`, `src/index.ts`, tests, `package.json`). Adds `@jevyjs/core` as its only dependency.

```ts
llmDecider(opts: { adapter: LlmAdapter; model: string; attempts?: number; timeoutMs?: number }): Decider
llmDeciderId(model: string): string // "llm:<model>", the id §5.1 documents
fakeDecider(opts?: { id?: string; model?: string; answers?: …; onDecide?: … }): Decider
```

- **Structured output.** `schema.ts` builds the JSON schema passed to `adapter.complete`: an object with one required property per question, each `{ value, confidence }`, `additionalProperties: false`, and `value` an `enum`.
- **An explicit way to abstain.** The enum always holds one extra id: `inconclusive` for yes/no and score, `none` for a choice. If a caller's option id or level collides with it, a suffixed id is used. Choosing it maps to `{ abstained: true, value: <the label>, confidence }`.
- **Validation before the gate.** The reply must be an object with exactly the asked keys, a `value` from the enum and a finite `confidence` in [0, 1]. Anything else is invalid; it is never coerced. Own properties only, as `assertAnswers` does.
- **Failure.** A thrown or invalid reply is asked again, up to `attempts` (default 2 _(proposal)_), each attempt bounded by `timeoutMs` (default 60 s _(proposal)_). Then `DeciderError`. The message names the problem and never repeats the prompt or the reply, which can hold page text. Backoff and transport retries belong to the user's adapter.
- **The prompt** (`prompt.ts`): fixed instructions, then `renderSnapshot(state.snapshot)`, then the questions with their allowed values. It says that the state is untrusted and may contain instructions to ignore, that the model should abstain when the state does not show enough, and that confidence is how sure it is of the value it chose. `url`, `goal` and `wallet` are included when present. The prompt is deterministic for a given input; a test pins one.
- **The fake decider** is exported from the package root. It is in-memory and scripted by a record or a function. A question with no scripted answer abstains, so a forgotten script is `needs-review`, never a pass.

Tests: Vitest, no browser. Every kind offers abstain; abstain maps to `abstained: true`; an invalid reply rejects after `attempts`; a secret in a thrown error does not reach the message; the pinned prompt contains no JSON tree.

### 3d — Matcher and fixtures

Owns: `packages/playwright/src/matcher.ts`, `fixtures.ts`, `runtime.ts`, `memo.ts`, `policy.ts`, `entry.ts`, `index.ts`, `package.json`, and their tests. Adds `@jevyjs/deciders-llm` as a workspace dependency and the `./reporter` export for 3e.

```ts
import { test, expect } from "@jevyjs/playwright"; // @playwright/test, extended
await expect(page.getByRole("main")).toSatisfy("The order is shown as confirmed");
await expect(locator).toSatisfy(statement, { criteria: "…" });
test.use({ decider: "llm" }); // or a Decider object (proposal)
```

- **The statement is a yes/no question** (`{ kind: "yesno", prompt: statement, criteria? }`) about one snapshot of the target. There is no polling: each new snapshot could be a new key and a new call. Wait with a web-first assertion first; the docs say so and use a locator in every example. The decider's time counts against the test's timeout.
- **`.not.toSatisfy` throws** _(proposal)_ and tells the author to write the statement they expect to hold. "Not pass" is not "fail" when there are three verdicts.
- **Identity.** `spec` is the test file relative to the Jevy root, with forward slashes. The Jevy root is the directory of the Playwright config file, or `rootDir` when there is none _(proposal)_; `loadConfig` and the cache directory resolve against it. `step` is the title path without the file name, joined by `›`, then `#n`, where `n` counts the test's `toSatisfy` calls from 1.
- **The decider.** `test.use({ decider })` passes an id to `selectDecider` as the override. `"llm"` builds `llmDecider` from the config's adapter. `"kev"` and `"jev"` work in `replay`, which needs only the id and model; in any other mode they are a `ConfigError` that names step 11. A `Decider` object is used as it is. The session's `deciderId` is the decider's own `id` (`llmDeciderId(model)` for the LLM).
- **Advisory, the default** (`policy.ts`, a pure function of verdict, config and environment). The matcher returns `pass: true` whatever the verdict. "Reported" means three things: a `jevy-assertion` attachment (`application/json`, the report entry) on every call; an annotation `{ type: "jevy", description }` on every non-pass, which Playwright's own reporters show; and `report.json` (3e). The exit code does not change.
- **Blocking** (`toSatisfy.blocking: true` in `jevy.config.*`). `fail` fails the assertion, with the statement, the answer and the reason in the message. `needs-review` follows `ci.needsReview`: outside CI it warns; in CI the `main` action applies when the branch equals `ci.mainBranch` and the run is not a pull request, and the `pr` action otherwise. The branch comes from `JEVY_BRANCH`, then `GITHUB_REF_NAME` (with `GITHUB_EVENT_NAME`), then `CI_COMMIT_BRANCH` _(proposal)_.
- **A `DeciderError`** is caught and reported as `needs-review`, source `none`, reason `decider-error`, then handled by the same policy.
- **One session per test.** The automatic fixture's teardown writes the held records that `keysToKeep` keeps: all of them when the test passed; when it failed only on its own blocking `fail`s, those calls' records and those of the calls before the first; otherwise none. (The plan said `confirm()` when `status === expectedStatus`; see [What changed](#what-changed-from-the-plan).) In advisory mode a `fail` does not fail the test, so its record is written and replays as `fail`.
- **The run memo crosses processes** (`memo.ts`). `createFileRunMemo(dir)` implements core's `RunMemo` with one file per key, first writer wins, and a reader gets that entry. It lives in a run directory, `<project.outputDir>/.jevy/runs/<runner process id>/<run>/memo` (the plan had `<project.outputDir>/.jevy/memo/`; see [What changed](#what-changed-from-the-plan)). With 3a, a retry in a new worker gets the first attempt's answer and writes its record when it passes.
- **Show-password fields** _(proposal)_: the fixture installs 3f's init script on the browser context.
- **A missing reporter is said once per worker:** when `config.reporter` does not list Jevy's, a warning says that no `report.json` will be written.

Tests: `policy.ts`, `entry.ts`, the step and spec functions and `memo.ts` (two memos on one directory; first writer wins) are pure Vitest. The matcher and fixtures are tested through 3h's runs.

### 3e — `report.json` v1

Owns: `packages/playwright/src/report/schema.ts`, `report/build.ts`, `reporter.ts`, and their tests.

`schema.ts` holds the types and `parseReportEntry`. It is the contract between the matcher, which attaches one entry per call, and the reporter.

```ts
interface JevyReport {
  v: 1;
  tool: "jevy-report";
  run: { status: "passed" | "failed" | "timedout" | "interrupted" }; // Playwright's FullResult.status
  summary: { pass: number; fail: number; needsReview: number; failedTest: number; incomplete: number };
  assertions: ReportAssertion[];
  incomplete: ReportIncomplete[];
}
interface ReportIncomplete {
  spec: string; // as in ReportAssertion, derived by the reporter from the test's file
  project: string;
  test: string[]; // anonymous describes left out
  line: number;
  retry: number; // the last attempt
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted"; // how it ended
  entries: number; // entries the last attempt has (they are in `assertions`)
  entriesInEarlierAttempt: number; // the most any earlier attempt had, 0 when none
}
interface ReportAssertion {
  spec: string; // as in the decision record
  project: string; // Playwright project name, "" when unnamed
  test: string[]; // describe titles, then the test title
  step: string; // as in the decision record
  line: number; // the test's line in `spec`
  statement: string; // the question as stored: redacted, whitespace collapsed
  target: "page" | "locator";
  verdict: "pass" | "fail" | "needs-review";
  source: "cache" | "review" | "decider" | "none";
  missReason: MissReason | null; // core's, also on a pass that followed a miss
  reason: Reason | null; // why it is not a pass; null on a pass
  truncated: boolean;
  answer: { value: string; confidence: number; abstained: boolean } | null;
  decider: string;
  model: string;
  key: string;
  snapshotHash: string;
  mode: "replay" | "replay-or-query" | "record";
  effect: "none" | "reported" | "failed"; // what the verdict did to the test
  retry: number; // the attempt this entry is from
}
type Reason =
  | MissReason // a replay miss, or a hit re-gated below the threshold
  | "abstained" | "low-confidence" | "truncated" | "decider-error" // other needs-review
  | "answered-no" | "reviewed"; // fail: by the decider, or by a person
```

- **Deterministic.** Keys in the order above. `assertions` sorted by `spec`, `project`, `test`, `step`, compared by code unit, except that the step's trailing `#n` compares as a number, so `t#2` comes before `t#10` (ties, such as `#01` and `#1`, by code unit). `incomplete` sorted by `spec`, `project`, `test`, `line`. No timestamps and no durations, so two runs over the same state write the same bytes. Two-space JSON and a final newline.
- **Retries.** For each test the entries of its last attempt are kept; earlier attempts are dropped. `retry` says which attempt that was.
- **Nothing lost silently** _(added after review; still `v: 1`, since nothing has been released)_. `run` says how the run ended, so a report whose assertions all pass cannot pass for a clean run. A test is listed in `incomplete` when its last attempt timed out or was interrupted, or has fewer entries than an earlier attempt. A test still running when Playwright stops the run (a global timeout) gets no `onTestEnd`; the reporter keeps what it attached and lists it as `interrupted`.
- **Entries agree with core.** `parseReportEntry` refuses an entry that `decide` could not produce: for example source `none` outside a replay miss or a decider error, `answered-no` without the answer `no`, a fail on a truncated snapshot, `replay` with source `decider`, `record` with `cache` or `review`, a spec that `assertSpecPath` refuses, or a statement that is not whitespace-collapsed. Each rule in `schema.ts` names the core rule it mirrors.
- **Workers.** Entries travel as attachments from the worker to the reporter, which runs in the runner process. No worker writes the file.
- **Where.** `jevy-report/report.json` under the Jevy root _(proposal)_; the reporter option `outputFile` overrides it. The directory is not committed; the README says to ignore it. Step 8's page can live beside it.
- **The reporter** is the default export of `@jevyjs/playwright/reporter`. `onTestEnd` parses attachments named `jevy-assertion`; a malformed one fails the report loudly. `onEnd` writes the file, also when there are no assertions, and prints one summary line with its path to stderr (stdout belongs to reporters such as `json`). It never changes the run's status. Under `playwright test --list` (`_mode: "list"`) it writes and prints nothing. It writes to a temporary file and renames it over the target, and refuses a symbolic link or a non-file at the path, also when removing a stale report.
- **No page text.** An entry holds what a decision record may hold, and passes through `redactText` in the matcher before it is attached.

Tests: Vitest, no browser. `build.ts` is a pure function from attempts to a report: ordering, last-attempt selection, the summary, and byte-identical output for shuffled input.

### 3f — Snapshot bridge

Owns: `packages/playwright/src/parse.ts`, `snapshot.ts`, `secrets.ts` and their tests.

- **Link URLs.** `parseAriaSnapshot` keeps `/url` as the node's `url`. `/placeholder` is still dropped. `snapshotAccessibility` scrubs secret values from `url` as it does from the other text fields.
- **Show-password fields.** A password field switched to `type="text"` is not recognised today unless its autocomplete or its accessible name says so. Two additions:
  - The DOM read also returns each field's `name` and `id` attributes, and a field whose `name` or `id` passes core's `isSecretFieldName` is secret. This works wherever `snapshotAccessibility` is called.
  - `rememberPasswordFields`, an init script _(proposal)_: it records every input that has had `type="password"`, and the DOM read counts those as secret after the switch. It changes no element; it adds one non-enumerable property, `jevy.passwordFields`, to the page's `location`. 3d installs it.
- What is still missed, to state in §6: a switched field with a neutral name and id, on a page snapshotted without Jevy's `test`.
- This changes no core rule, so it needs no rules bump of its own. 3b's does.

Tests: real Chromium, as the existing `snapshot.test.ts`. Parser tests need none.

### 3g — Guard

Owns: `packages/cli/src/guard/weak-tests/model.ts`, `weak-tests/verdict.ts`, `config-source.ts`, `diff-config.ts`, `types.ts`, `findings.ts`, `analyse.ts` and their tests. The CLI still does not import core.

- **`@jevyjs/playwright` is a framework module.** Without this, a test that imports Jevy's `test` and `expect` is treated as using an unknown fixture file, and an empty test is reported as `assertion-not-visible` when it should be `test-without-assertion`.
- **`only-advisory-assertions`** (review) _(proposal)_: a new or changed test whose every assertion is `toSatisfy`, while the base config does not set `toSatisfy.blocking: true`. Such a test cannot fail the build. It is not `test-without-assertion`: a judgement-only test is what the generator will legitimately write, and a weakening would block every one of them in the default setup. It is not silence either, because a person should know. The stop hook blocks on weakening only, so this does not trap an agent.
- **`blocking-switched-off`** (weakening): `toSatisfy.blocking` changed from `true` to `false`, or removed. Switching it on is `config-changed`, as any other key.
- `statement-changed` needs no change.

### 3h — Integration and docs

Owns: `packages/playwright/fixtures/step-3/` (a Playwright project: config, `jevy.config.ts`, three static pages, specs named `*.spec.ts` so Vitest does not collect them), `packages/playwright/src/step-3.integration.test.ts`, every `index.ts` export hand-off, `packages/cli/skill/SKILL.md`, and the docs.

The Vitest test serves the pages from `node:http` on `127.0.0.1` at a free port and runs the real Playwright runner on the fixture project as a child process. The fixture's `jevy.config.ts` uses a scripted adapter under the real `llmDecider`: it answers from the statement and the rendered snapshot in the prompt, and appends one line per call to a file. Real Chromium; no network; no model.

It proves the roadmap's "Done when":

- **Run 1, `record`** (`CI` set to `""` in the child's environment): one assertion passes, one fails and one abstains to `needs-review`. The exit code is 0, because the mode is advisory. The decision files hold one record per assertion and no page text.
- **Run 2, `replay`** (`CI=1`): the call log has not grown, every source is `cache`, and `report.json` differs from run 1 only in `source`, `mode` and `missReason`.
- **A changed page** in replay: `needs-review`, `missReason: "snapshot-changed"`, still no call.
- **A retry:** a test whose exact assertion fails on its first attempt and passes on its second makes one decider call and writes one record.
- **Blocking on:** the failing assertion fails the run.
- **An agent on `report.json` alone:** a function in the test reads only the file and maps every non-pass entry to one next action from `spec`, `line`, `statement`, `reason` and `mode`: record locally, review a changed page, fix the app or the statement, or hand to a person. No entry is left without an action, and no log is read.
- **The guard** on the fixture reports `only-advisory-assertions` for the judgement-only spec.

Docs, in the same piece of work:

- `README.md`: the status line; move the step 3 example from "What is planned" to "What works today"; add an adapter example, the reporter line for `playwright.config.ts`, the `toSatisfy.blocking` switch, the reason-to-action table, and the two new guard findings; update the packages table.
- `docs/DESIGN.md`: the generic adapter becomes a built section (now §5.7); the `toSatisfy` and `report.json` section moves into §6 (now §6.2 and §6.3), and the later sections of §8 move up by one; §5.5 loses its "Still open" paragraph and gains the spec-scoped key and the retry rule; §5.3 and §6 gain `url`, rules version 3 and the show-password rule; §5.6 gains `toSatisfy.blocking`; §7 gains the findings; §9's "advisory until" line and its planned-items line are brought up to date. §8.1 keeps Kev and Jev.
- `docs/ROADMAP.md`: the status line and a step 3 table like steps 1 and 2.
- `docs/OPEN-QUESTIONS.md`: add the spec-scoped key and the `ai` decision to "Decided".
- `SKILL.md`: where `report.json` is, in two or three lines.
- This file: the status line, and a "What changed from the plan" section.

## Done when

- The fixture app passes, fails and returns `needs-review` as expected, and the second run in `replay` makes no decider call.
- A retry that passes on a remembered answer writes its record, across worker processes.
- An advisory `fail` leaves the exit code at 0; with `toSatisfy.blocking: true` it fails the run.
- `report.json` validates against the v1 types, is byte-identical for the same state, and is enough for the agent function to act on.
- A link that points somewhere new changes the hash; a show-password field is blanked.
- Lint, typecheck, build and test pass, and the docs above are true.

## Not in this step

- The Jev and Kev adapters, and `probability` beside `confidence` (step 11).
- Measuring accuracy and hash stability (step 4). Blocking stays off by default, and the thresholds stay placeholders.
- A token budget measured on the rendered prompt. Pruning still estimates from canonical JSON, which is 1.3 to 2.5 times larger, so it prunes early, never late. Step 4 measures real pages first.
- A per-assertion decider, sending the page URL or a goal with the state, `jevy cache verify` and approvals (step 10), the report page (step 8), test history (step 9), and a Vitest matcher.
- Sharded runs merged from blob reports, beyond the check under "Before building".

## What changed from the plan

- **The three decisions** under [Decide first](#decide-first) were taken as proposed: the key covers the spec (key and record version 2), a link's URL is in the hash (rules version 3), and `deciders-llm` has no `ai` dependency. A spec file whose path redaction would change is refused, since redacting it would let two specs share keys and a file.
- **Save on pass, with one exception.** The teardown does not confirm on `status === expectedStatus`: that would save the answers of a test marked `test.fail`. It writes all held records when the test passed and none otherwise, except that with `toSatisfy.blocking: true` the "no" that alone failed the test is kept, with the answers before it, so CI replay fails the same way until a person reviews it (`keysToKeep` in `runtime.ts`).
- **The run memo is scoped per run,** under `<project.outputDir>/.jevy/runs/<runner process id>/`, not in `.jevy/memo/`. UI mode, watch mode and the VS Code extension keep the output directory across runs, so a memo there would have outlived its run. With retries the runner has one directory; without, workers join numbered generations.
- **Workers coordinate beyond the memo.** Claims let one worker ask the decider for a key while the others wait for its answer, and record marks let one worker write each key's record per run, since each worker reads the decision files once.
- **The decider's timeout comes from the test's time:** three quarters of what is left, split over the attempts, at most 60 s and at least 1 s. With less than about 2.7 s left the model is not called, and the call is `needs-review` with `decider-error` rather than a Playwright timeout that reports nothing.
- **Hooks.** `toSatisfy` works in `beforeEach` and `afterEach`. In `beforeAll` and `afterAll` it is a `ConfigError` that says so. A spec outside the Jevy root is a `ConfigError` that names the root.
- **The init script** is installed on the test's context and on every context the worker's browser creates (`newContext`, `newPage`). It adds one non-enumerable property, `jevy.passwordFields`, to `location`; "changes nothing on the page" was too strong.
- **`report.json`** gained `run` and `incomplete` after review, still as `v: 1`. The reporter also takes a `root` option.
- **The guard's advisory rule** covers `toSatisfy` in a same-file helper the test calls, in a `toPass` block and in a hook, not only in the body. A config that only head has, or a change that switches blocking off, cannot silence `only-advisory-assertions`.
- **Packaging.** The `.` and `./reporter` exports have a `default` condition beside `import`, so a CommonJS project resolves them. `loadConfig` unwraps the `{ default: { __esModule: true, default } }` shape Node 22 gives for a `jevy.config.ts` compiled to CommonJS.
- **Smaller additions.** An unknown `toSatisfy` option is a `QuestionError`, so a local `blocking: false` cannot be passed quietly. A pull request is also read from `pull_request_target` and GitLab's `CI_MERGE_REQUEST_IID`. `llmDecider` caps `attempts` at 10.
- **Not checked, from "Before building":** only Playwright 1.63 has been run, so the peer range stays `>=1.49.0` untested on older versions; sharded runs merged from blob reports are not tested here.
