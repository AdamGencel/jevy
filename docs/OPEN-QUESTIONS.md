# Jevy — Open questions

Status: design stage. Each open item names what it blocks. Resolve each one in a PR and move it to "Decided".

## Open

2. **npm scope: `@jevy` is taken, pick a replacement.** (Checked 27 Oct 2026, partly resolved.)
   - Free: the unscoped name `jevy` (`npm view jevy` returns 404). Use it for the main package and the CLI, so `npx jevy ...` and `npm i -D jevy` work.
   - Taken: the scope `@jevy`. An npm user account named `jevy` exists ([npmjs.com/~jevy](https://www.npmjs.com/~jevy): 0 packages, 0 orgs), and the registry reports the scope as existing (`registry.npmjs.org/-/org/jevy/package` returns `{}`; an unused scope returns "Scope not found"). User and org names share one namespace, so `npmjs.com/org/create` will refuse `jevy`. npm's [name policy](https://docs.npmjs.com/policies/disputes) says it is "extremely unlikely to transfer control of a username", even one with no packages, so don't plan on getting it back.
   - `@jevy/core`, `@jevy/cli`, `@jevy/web3` and `@jevy/playwright` all 404, but nobody except the `jevy` account can publish them.
   - Free alternatives, checked the same day: `@jevyjs`, `@jevyhq`, `@usejevy`, `@getjevy`, `@jevy-dev`; the unscoped `jevy-core`, `jevy-cli`, `jevy-web3`, `jevy-playwright` and `create-jevy` are also free.
   - **Proposal:** CLI and main entry as unscoped `jevy`, sub-packages under `@jevyjs/*` (`@jevyjs/core`, `@jevyjs/playwright`, `@jevyjs/web3`, `@jevyjs/deciders-jev`, ...). The docs still say `@jevy/*` and get renamed once this is chosen.
   - **Maintainer action (about 1 minute, needs your npm login):** create the free public org at <https://www.npmjs.com/org/create> with the name you choose (for example `jevyjs`). The unscoped `jevy` can't be reserved ahead of time. npm treats registering names "simply for the purposes of reserving it" as squatting, so publish the first real `jevy` release (M0/M1) soon after the repo goes public. Anyone can take the name until then.
   - The GitHub user `jevy` (Jevin Maltais, account since 2009) is unrelated, so the repo stays at `AdamGencel/jevy`.
   - Similarly named Jev projects exist (`ZYRT3CH/jevyr`, an AI judge; `syumai/jevyoumean`; `markusbug/jevymarket`). `Ice-Hazymoon/jevwright` (npm `@hazymoon/jevwright`) overlaps with level 1.
   - *Blocks:* M0, M9.
3. **Data licence and terms for published eval snapshots.**
   - The ~200-case public dataset contains accessibility snapshots, and possibly screenshots, of third-party public sites such as the Uniswap web app.
   - Check whether the sites' terms allow redistributing them, and choose a data licence (for example CC-BY-4.0 or CDLA-Permissive-2.0) separate from the MIT code licence.
   - Decide whether the dataset ships in this repo or in a separate dataset repo. A separate repo is preferred if any doubt remains.
   - The same terms check applies to recording promo demo videos on those sites.
   - If the dataset includes recorded Jev answers, TypeSafe's [Master Customer Agreement §2.3(b)](https://typesafe.ai/legal/mca) applies: Output may not be used to train a model to imitate Jev or to build a competing product. Publishing Jev answers for evaluation is fine (§4.2 assigns Output to the customer), but the dataset licence should carry that restriction forward. The Jev benchmarking dataset does the same with its "Jev Responses License" ([example](https://github.com/AppliedMachineLearning-Lab/jev-benchmarking/blob/main/responses/LICENSE_RESPONSES.md)). Never use Jev answers to fine-tune Kev or any other model.
   - *Blocks:* M7 (publishing the dataset), M8 demos.

## Decided (27 Oct 2026)

- **Product.** Open-source TypeScript framework distributed on npm as a pnpm monorepo. Three levels: record (no tests), Playwright plugin (existing tests), properties (v0.2). Decision cache with deterministic CI replay; numbers and chain state checked in code; swappable `Decider` (Jev pinned to `jev-1.14.0`, Kev, generic LLM judge); `eval` command; Web3 wallet pack as the standout generic feature. v0.1 = levels 1 and 2 plus the wallet pack. The repo contains only the product packages; users install and configure Jevy for their own app.
- **Name.** Jevy: CLI and main npm package `jevy` (free as of 27 Oct 2026). The sub-package scope is pending open item 2, because `@jevy` is taken.
- **TypeSafe AI brand check (open item 1, resolved 27 Oct 2026).** "Jevy" is reasonable to keep, with the precautions below. Low-to-moderate risk.
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
  - Optional: email TypeSafe (support@typesafe.ai) before the 0.1.0 launch to say the project exists. This isn't required.
- **Repo home.** github.com/AdamGencel/jevy (not created yet).
- **Licence.** MIT, `Copyright (c) 2026 Adam Gencel` (see `LICENSE`).
- **Jev access.** The maintainer has a direct TypeSafe Jev API key, read from the `TYPESAFE_API_KEY` environment variable. Keys are never committed.
- **Data policy.** Jev (US-hosted) is acceptable for staging and public apps. Switching to local Kev is a one-line config change, settable per project and per test.
- **Wallet demo.** Recorded videos of Jevy on real public web3 sites, Uniswap's web app first, used in the README and for promotion. There is no example app or demo code in the repo.
  - Safety: testnet funds only (Ethereum Sepolia or Unichain Sepolia), or stop at the confirm screen and reject the signature. Never mainnet.
  - The wallet pack itself stays generic: a mock EIP-1193 provider and a user-configured local fork or testnet. Mainnet signing is off by default.
- **Eval seed set.** About 200 labelled cases from public apps only (the Uniswap web app and others), so anyone can rerun the benchmark. It is published either in this repo or in a separate dataset repo if the licensing of site snapshots is a concern (open item 3).
- **Kev default.** Tuned for a normal developer laptop. Documented default: `kev-4b@v1.0` (Kev's README lists it for a 32 GB Apple Silicon Mac), with `kev-0.8b@v1.0` for smaller machines. *Estimate, to be confirmed by `eval` on laptop hardware.*
- **LLM for planning and the generic judge.** Provider-agnostic: users plug in any LLM through an adapter. No hard dependency on any provider.
- **Decision cache.** Committed to git by default, with redaction of secrets and PII before write, and an option to store it elsewhere for big suites.
- **`needs-review` in CI.** Warn on PRs, fail on main, configurable per project.
- **Precision bar.** An advisory AI step stays on only if at least 70% of its findings are accepted as real.
- **Scope.** Playwright only for v0.1. API-level tests and Cypress later. Mobile not planned.
- **v0.2 property-testing pilots.** Public OSS projects, so results are shareable: viem (TypeScript) and OpenZeppelin Contracts (Solidity).
- **Governance.** Adam Gencel is the sole maintainer. Personal project, no company affiliation. Contributions under the DCO (`git commit -s`).
- **Default decider.** Chosen from the M7 eval on the public dataset, not upfront (unchanged from the design).
