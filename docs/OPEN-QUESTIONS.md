# Jevy — Open questions

Each open item names the roadmap step it blocks. Resolve an item in a PR and move it to "Decided". Item numbers are kept stable so links to them keep working; 1, 2, 8 and 9 are decided.

## Open

3. **Data licence and terms for published eval snapshots.**
   - The ~200-case public dataset contains accessibility snapshots of third-party public sites such as the Uniswap web app.
   - Check whether the sites' terms allow redistributing them, and choose a data licence (for example CC-BY-4.0 or CDLA-Permissive-2.0) separate from the MIT code licence.
   - Decide whether the dataset ships in this repo or in a separate dataset repo. A separate repo is preferred if any doubt remains.
   - The same terms check applies to recording promo demo videos on those sites.
   - If the dataset includes recorded Jev answers, TypeSafe's [Master Customer Agreement §2.3(b)](https://typesafe.ai/legal/mca) applies: Output may not be used to train a model to imitate Jev or to build a competing product. Publishing Jev answers for evaluation is fine (§4.2 assigns Output to the customer), but the dataset licence should carry that restriction forward. The Jev benchmarking dataset does the same with its "Jev Responses License" ([example](https://github.com/AppliedMachineLearning-Lab/jev-benchmarking/blob/main/responses/LICENSE_RESPONSES.md)). Never use Jev answers to fine-tune Kev or any other model.
   - *Blocks:* publishing the dataset (roadmap step 11) and the demo videos (step 14).
4. **Does a hosted runner that holds a user's key count as proxying?** Confirm in writing with TypeSafe before 0.1.0.
   - [MCA §2.3(a)](https://typesafe.ai/legal/mca) bans offering the Services "as a standalone service". The project rule is that Jevy never proxies or resells Jev access, and every user brings their own `TYPESAFE_API_KEY`. Calls go from the user's machine or CI to an allow-listed host.
   - 0.1.0 does not ship a hosted runner. The open point is any later runner or service that would hold a user's key and call Jev on their behalf. Adam confirms with TypeSafe, in writing, whether that arrangement counts as proxying.
   - Record the answer here before roadmap step 14. Do not build that runner on an assumption.
   - Contact already used for brand questions: support@typesafe.ai.
   - *Blocks:* 0.1.0 (step 14), and any hosted runner.
5. **Is the name Jevy acceptable next to the pending JEV filing?** Confirm in writing with TypeSafe before 0.1.0.
   - TypeSafe AI, Inc. filed the word mark **JEV** on 23 Sep 2026 (US serial [50124229](https://trademarks.justia.com/501/24/jev-50124229.html)), classes 9 and 42. It is pending. The desk check on 27 Oct 2026 (Decided, below) concluded the name was reasonable to keep, with the README disclaimer. That check is not a confirmation from TypeSafe.
   - Before 0.1.0, Adam confirms with TypeSafe, in writing, that the name Jevy is acceptable beside that filing. Record the answer here. If they object, rename before publish. The code is cheap to rename before 1.0.
   - The npm package `jevy-vet` is a possible confusion risk. It is an OpenCode plugin that uses TypeSafe Jev, so developers can meet that name and this project in the same place. The written check should mention it. The package does not, by itself, decide whether Jevy stays.
   - *Blocks:* 0.1.0 (step 14).
6. **Is a hash of the whole page stable enough to cache verdicts on?**
   - In replay, a verdict is reused only when the redacted, normalised page hashes the same. Normalisation removes timestamps, UUIDs and long digit runs, but prices, names and list contents still change on real apps, and every change is a miss that reports `needs-review`.
   - Nobody has measured how often this happens. Roadmap step 4 snapshots three real apps over several days and reports the rate per page and per region.
   - If the rate is too high, the alternatives are hashing only a region (already supported), or hashing only the evidence the decider says it used.
   - *Blocks:* the final shape of the cache key, and switching `toSatisfy` from advisory to blocking.
7. **How is a human approval told apart from one an agent wrote?**
   - Three things need a person's approval: a plan line, a healer's fix, and a `needs-review` verdict. A record with `reviewedBy` set replays its `reviewVerdict` without a gate. Today anyone who can edit the cache file can write one. `jevy guard` reports every approval added in a diff, but it cannot say who added it.
   - Candidates: CODEOWNERS on the cache directory, a required reviewer on any diff that adds an approval, or a signature.
   - *Blocks:* step 10.

## Decided

- **Direction (18 Nov 2026).** Jevy is a test framework for the AI era: coding agents write most of the code and many of the tests, so the scarce thing is a result you can trust. It is designed around six properties (agent-operable, tamper-evident, cheap and repeatable, honest about doubt, measured, and, since 23 Nov 2026, earned and inspectable). This replaces the earlier positioning as an AI add-on for an existing Playwright suite, and the "three levels".
- **No recorder (18 Nov 2026, confirmed 23 Nov 2026).** There is no `jevy record` command. Writing test scripts from a goal is free elsewhere, and a product that only did that closed.
- **Planner, generator and healer are built in (23 Nov 2026).** Jevy ships its own versions of the three agents Playwright provides, as first-class parts of the framework. They read the app map and existing coverage, and work under the guard and the admission check.
- **A test has to earn its place (23 Nov 2026).** A created test must cover the right things, not duplicate what exists, and not be there for its own sake. Jevy enforces this with an app map, a fingerprint per test, a plan a person approves, and a check that the test catches a planted bug.
- **A page the team can read (23 Nov 2026).** A static report page shows what each test protects, each step, screenshots with the element highlighted, and the test's history. The framework itself hosts nothing.
- **`toSatisfy` is advisory by default (23 Nov 2026).** A model-judged check does not fail a build until a project switches blocking on, after its accuracy has been measured.
- **Prevention before detection (23 Nov 2026).** Hooks that stop an agent finishing with a weakened test, and protected paths, come before new features.
- **Where the agents run (item 9, resolved 23 Nov 2026).** Inside the developer's coding agent, as Playwright's do, and in that agent's headless mode in CI. In CI they only propose. The checks that gate a merge (tests in replay, the guard, the admission check) need no agent and no model, and repairing a locator needs only a single decider question. A built-in runner for teams with no coding agent in CI is a later option; the agents are definitions and a tool server, so it can be added without changing them.
- **Test history is pluggable (item 8, resolved 23 Nov 2026).** History has its own roadmap step and its own design section. Jevy writes a documented results format and reads and writes history through a small store interface. A team can plug in its own store or a third-party results service such as Currents, and a built-in store works with no service.
- **A Jevy dashboard, later (23 Nov 2026).** A hosted product that ties the report page, history, proof bundles and guard findings together is a later, optional and separate product. The open-source framework never depends on it. It would receive results only: it would hold no model key and call no model, so open item 4 does not apply to it. What it may store is to be designed then, because screenshots can show personal data.
- **Healing (23 Nov 2026).** No quiet healing. When a test breaks, Jevy may propose a fix, always as a diff, and a person approves it before it applies. A fix that changes what a test checks, loosens a statement or adds a skip is flagged by the guard.
- **Product form.** Open-source TypeScript, distributed on npm, developed as a pnpm monorepo. The repo contains only the product packages; users install and configure Jevy for their own app.
- **Runner.** Playwright first, as a plugin to `@playwright/test`, not a new runner. A Vitest matcher on the same core, API-level tests and Cypress may follow. Mobile is not planned.
- **Deciders.** One `Decider` interface. The generic LLM adapter comes first and is where the docs start, because everyone can run it: users plug in any model through an adapter, and there is no hard dependency on any provider. Jev (hosted, pinned to `jev-1.14.0`) and Kev (local) are optional adapters. Config has no built-in decider; a project names the one it uses. Which decider a project should use is settled by `eval` on its own cases.
- **Decision cache.** Committed to git by default, one JSONL file per spec, with secrets and personal data redacted before anything is written. A project that wants its records elsewhere implements `DecisionStore`.
- **`needs-review` in CI.** Warn on pull requests, fail on the main branch, configurable per project.
- **Numbers in code.** Amounts, balances, dates and chain state are checked with code, never judged by a model.
- **Precision bar.** An advisory AI step stays on only if at least 70% of its findings are accepted as real.
- **Web3 stays first class.** The wallet pack is generic: a mock EIP-1193 provider and a user-configured local fork or testnet. Wallet prompts, signing policy and chain state use the same decision, cache and guard mechanisms as any other check. Mainnet signing is off by default.
- **Wallet demos.** Recorded videos of Jevy on real public web3 sites, Uniswap's web app first, used in the README and for promotion. There is no example app or demo code in the repo. Testnet funds only (Ethereum Sepolia or Unichain Sepolia), or stop at the confirm screen and reject the signature. Never mainnet.
- **Eval seed set.** About 200 labelled cases from public apps only, so anyone can rerun the benchmark. It is published either in this repo or in a separate dataset repo if the licensing of site snapshots is a concern (open item 3).
- **Kev model size.** Tuned for a normal developer laptop. Documented default: `kev-4b@v1.0` (Kev's README lists it for a 32 GB Apple Silicon Mac), with `kev-0.8b@v1.0` for smaller machines. *Estimate, to be confirmed by `eval` on laptop hardware.*
- **Property-testing pilots.** Public OSS projects, so results are shareable: viem (TypeScript) and OpenZeppelin Contracts (Solidity).
- **Data policy.** Jev (US-hosted) is acceptable for staging and public apps. For anything more sensitive, use a local model.
- **Jev access.** The maintainer has a direct TypeSafe Jev API key, read from the `TYPESAFE_API_KEY` environment variable. Keys are never committed. Every user brings their own key; Jevy never proxies or resells Jev access.
- **Name.** Jevy.
- **npm names (item 2, resolved 28 Oct 2026).** Every package publishes under `@jevyjs/*`, and the CLI is `@jevyjs/cli` (bin `jevy`). The `@jevyjs` org exists and a placeholder `@jevyjs/cli` 0.0.1 is published.
  - Blocked: the unscoped `jevy`. It was unregistered, but on 28 Oct 2026 npm refused to publish it as "too similar to existing packages jest, levn".
  - Taken: the scope `@jevy`. An npm user account named `jevy` exists ([npmjs.com/~jevy](https://www.npmjs.com/~jevy): 0 packages, 0 orgs), and the registry reports the scope as existing (`registry.npmjs.org/-/org/jevy/package` returns `{}`; an unused scope returns "Scope not found"). User and org names share one namespace, so `npmjs.com/org/create` will refuse `jevy`. npm's [name policy](https://docs.npmjs.com/policies/disputes) says it is "extremely unlikely to transfer control of a username", even one with no packages, so don't plan on getting it back.
  - `@jevy/core`, `@jevy/cli`, `@jevy/web3` and `@jevy/playwright` all 404, but nobody except the `jevy` account can publish them.
  - Free alternatives, checked the same day: `@jevyjs`, `@jevyhq`, `@usejevy`, `@getjevy`, `@jevy-dev`; the unscoped `jevy-core`, `jevy-cli`, `jevy-web3`, `jevy-playwright` and `create-jevy` are also free.
  - Decision: all packages under `@jevyjs/*` (`@jevyjs/cli`, `@jevyjs/core`, `@jevyjs/playwright`, `@jevyjs/web3`, `@jevyjs/deciders-jev`, ...). Users run `npx jevy ...` once `@jevyjs/cli` is installed. The docs use these names.
  - The GitHub user `jevy` (Jevin Maltais, account since 2009) is unrelated, so the repo stays at `AdamGencel/jevy`.
  - Similarly named Jev projects exist (`ZYRT3CH/jevyr`, an AI judge; `syumai/jevyoumean`; `markusbug/jevymarket`). `Ice-Hazymoon/jevwright` (npm `@hazymoon/jevwright`) overlaps with recording a spec from a goal, which Jevy leaves to the developer's agent. The npm package `jevy-vet` is a separate confusion risk; see open item 5.
- **TypeSafe AI brand check (item 1, resolved 27 Oct 2026).** "Jevy" is reasonable to keep, with the precautions below. Low-to-moderate risk.
  - Findings:
    - TypeSafe AI, Inc. filed a US trademark application for the word mark **JEV** on 23 Sep 2026 (serial [50124229](https://trademarks.justia.com/501/24/jev-50124229.html)), classes 9 and 42 (AI decision software and SaaS). It is pending and not yet examined.
    - TMview, which covers EUIPO, WIPO/Madrid and national offices, shows no EU or international JEV filing by TypeSafe yet, and no **JEVY** mark in classes 9 or 42 anywhere. The only JEVY marks are unrelated: China (classes 31, 39 and 43), Uzbekistan (juice) and Argentina ("QUE JEVY"/"JEVY!", clothing).
    - TypeSafe publishes no brand or naming guidelines and no "made with Jev" programme (checked [typesafe.ai/legal/terms](https://typesafe.ai/legal/terms), [/legal/mca](https://typesafe.ai/legal/mca), [/legal/acceptable-use-policy](https://typesafe.ai/legal/acceptable-use-policy) and [docs.typesafe.ai/legal](https://docs.typesafe.ai/legal)). The customer agreement (§16.4) grants no right to use TypeSafe's "name, brand, or logo" without consent, and the site terms reserve all rights.
    - Dozens of community projects use Jev-derived names: jevwright, jev-style, NanoJev, OpenJev, JevForge, jevplay.games, awesome-jev lists, jevlist.ai. No objection or takedown by TypeSafe was found. Projects add disclaimers on their own, for example [Simple-Jev #5](https://github.com/ihatecoding01/Simple-Jev/issues/5) and [jev-typesafe.org](https://jev-typesafe.org/terms).
  - Risk: "Jevy" contains "Jev" and covers related software, so once JEV registers, TypeSafe could object under a likelihood-of-confusion theory, mainly if Jevy looks official or Jev-only. Mitigations: Jevy is multi-backend (Jev, Kev, any LLM), the description is nominative ("works with Jev"), and the disclaimer below is in place. Fallback if TypeSafe ever objects: rename. The `jevy` code is cheap to rename before 1.0.
  - Rules adopted:
    - Disclaimer in the README and on any site: "Jevy is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by TypeSafe AI, Inc. Jev is a trademark of TypeSafe AI, Inc. and is used here only to identify the model Jevy can call."
    - No TypeSafe logo, colours (pink/ink) or mascot. Never call Jevy "official".
    - "Jev" appears only to name the backend, for example in the `deciders-jev` adapter and in "works with Jev".
    - Link only to typesafe.ai and docs.typesafe.ai. Never link to look-alike domains such as jevtypesafeai.com, aijev.app, madewithjev.com or jevlaya.cc.
    - Every user brings their own `TYPESAFE_API_KEY`. Jevy never proxies or resells Jev access, because MCA §2.3(a) bans offering the Services "as a standalone service".
  - Written confirmation from TypeSafe is still required before 0.1.0. The desk check above is not that confirmation. See open items 4 and 5. Contact: support@typesafe.ai.
- **Repo home.** [github.com/AdamGencel/jevy](https://github.com/AdamGencel/jevy) (public, created 28 Oct 2026).
- **Licence.** MIT, `Copyright (c) 2026 Adam Gencel` (see `LICENSE`).
- **Governance.** Adam Gencel is the sole maintainer. Personal project, no company affiliation. Contributions under the DCO (`git commit -s`).
