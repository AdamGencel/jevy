# Jevy — Open questions

Status: design stage. Each question names what it blocks. Resolve each one in a PR and move it to "Decided".

## Name and branding

The name is **Jevy**: CLI `jevy`, npm scope `@jevy/*`. Before publishing, still to do:

- Checked 27 Oct 2026: `jevy` and `@jevy/core` are unpublished on npm (the `@jevy` org itself still needs claiming). The GitHub username `jevy` belongs to an unrelated person, so the repo needs another home (e.g. `AdamGencel/jevy` or a `jevy-dev` org). Related Jev projects exist with similar names (`ZYRT3CH/jevyr`, an AI judge; `syumai/jevyoumean`; `markusbug/jevymarket`) and the `Ice-Hazymoon/jevwright` project overlaps with level 1.
- Check TypeSafe AI's trademark and brand policy on using "Jev" in a project name, because Jevy also supports non-Jev backends (Kev, generic LLMs). Add a "not affiliated with TypeSafe AI" line to the README either way.
- *Blocks:* M0 (reserving names), M9 (publishing).

## Open

1. **Licence: MIT or Apache-2.0?**
   - Both are compatible with the dependencies identified so far: `@typesafe-ai/sdk` is MIT and Kev is Apache-2.0. Echidna, Medusa and Halmos are AGPL-3.0 and will be called as external binaries, not bundled.
   - Apache-2.0 adds an explicit patent grant. MIT is shorter and the most common choice in the Playwright ecosystem.
   - *Blocks:* M0.
2. **Jev access.**
   - Does Adam's team have early-access API keys? The HN thread reported that signups were closed.
   - Is OpenRouter or Vercel AI Gateway access acceptable as a fallback route?
   - *Blocks:* M3 and M7 (a real Jev measurement).
3. **Data policy.**
   - Can staging or test page content (accessibility trees) go to a US-hosted API?
   - Is zero data retention needed? Per TypeSafe's docs it is enterprise-only.
   - If not, Kev becomes the default for internal use.
   - *Blocks:* M3 defaults, M7.
4. **Which dApp for the v0.1 wallet example?**
   - It must be a real, public dApp that can run against a local Anvil fork or a testnet.
   - Candidates: one of the team's own apps or Farcaster miniapps, a well-known open-source dApp front end, or MetaMask's test-dapp as a minimal fallback.
   - *Blocks:* M8.
5. **Default decider.** It is decided by the M7 eval, not upfront. Which labelled cases should form the seed set, and who labels them?
6. **Kev hardware.** What machine profile is a "local" decider expected to run on (laptop, CI runner, GPU)? This affects which Kev model size is documented as the default.
7. **LLM provider for planning and the generic judge.** Which provider and model is the default, and is any single provider acceptable as a hard dependency? The current plan is provider-agnostic.
8. **Cache in git.** Is committing `.jevy/decisions/` acceptable for large suites, or is an option to store it elsewhere needed? What redaction is required before committing?
9. **`needs-review` in CI.** Should it fail the job, warn, or be configurable per project? The default proposal is to warn on PRs and fail on main.
10. **Precision bar.** What share of AI findings must be accepted (accepted ÷ all) before the team keeps an advisory AI step switched on?
11. **Scope beyond Playwright.** Cypress, mobile, or API-level tests: now, later or never?
12. **Level 3 targets.** Which TypeScript SDK and which Solidity repo pilot property generation in v0.2? Who reviews the proposed properties?
13. **Governance.** Who are the maintainers, and is there a company affiliation to disclose? Is a CLA or DCO needed?

## Decided

- Open-source TypeScript framework distributed on npm as a pnpm monorepo.
- Three levels: record (no tests), Playwright plugin (existing tests), and properties (v0.2).
- Decision cache with deterministic CI replay; numbers and chain state checked in code; swappable `Decider` with Jev pinned to `jev-1.14.0`, Kev and a generic LLM judge; `eval` command; Web3 wallet pack as the standout example.
- v0.1 = levels 1 and 2 plus a wallet-flow example on a real dApp.
- Name: Jevy (pending the availability and trademark check above).
