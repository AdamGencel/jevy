# Jevy — Open questions

Status: design stage. Each open item names what it blocks. Resolve each one in a PR and move it to "Decided".

## Open

1. **TypeSafe AI trademark and brand check.**
   - Check TypeSafe AI's trademark and brand policy on using "Jev" in a project name, since Jevy also supports non-Jev backends (Kev and any LLM).
   - Whatever the outcome, keep the README line saying the project isn't affiliated with TypeSafe AI.
   - *Blocks:* M0 (final name), M9 (publishing).
2. **Claim the `@jevy` npm org.**
   - Checked 27 Oct 2026: `jevy` and `@jevy/core` were unpublished on npm, but the `@jevy` org itself still needs claiming.
   - Decide afterwards whether the CLI ships as unscoped `jevy` or as `@jevy/cli` with a `jevy` bin.
   - Note: the GitHub username `jevy` belongs to an unrelated person, so the repo lives under `AdamGencel/jevy` (see Decided).
   - Similarly named Jev projects exist (`ZYRT3CH/jevyr`, an AI judge; `syumai/jevyoumean`; `markusbug/jevymarket`), and `Ice-Hazymoon/jevwright` overlaps with level 1.
   - *Blocks:* M0, M9.

## Decided (27 Oct 2026)

- **Product.** Open-source TypeScript framework distributed on npm as a pnpm monorepo. Three levels: record (no tests), Playwright plugin (existing tests), properties (v0.2). Decision cache with deterministic CI replay; numbers and chain state checked in code; swappable `Decider` (Jev pinned to `jev-1.14.0`, Kev, generic LLM judge); `eval` command; Web3 wallet pack as the standout example. v0.1 = levels 1 and 2 plus a wallet-flow example.
- **Name.** Jevy: CLI `jevy`, npm scope `@jevy/*`. Pending the two open items above.
- **Repo home.** github.com/AdamGencel/jevy (not created yet).
- **Licence.** MIT, `Copyright (c) 2026 Adam Gencel` (see `LICENSE`).
- **Jev access.** The maintainer has a direct TypeSafe Jev API key, read from the `TYPESAFE_API_KEY` environment variable. Keys are never committed.
- **Data policy.** Jev (US-hosted) is acceptable for staging and public apps. Switching to local Kev is a one-line config change, settable per project and per test.
- **Wallet demo dApp.** The open-source Uniswap interface, against a local Anvil fork. It is GPL-3.0, so it is fetched at a pinned commit and not vendored. Whether it works fully against a fork is checked by a spike at the start of M8.
- **Eval seed set.** About 200 labelled cases from public apps only (Uniswap interface and others), so anyone can rerun the benchmark. The dataset is published in the repo.
- **Kev default.** Tuned for a normal developer laptop. Documented default: `kev-4b@v1.0` (Kev's README lists it for a 32 GB Apple Silicon Mac), with `kev-0.8b@v1.0` for smaller machines. *Estimate, to be confirmed by `eval` on laptop hardware.*
- **LLM for planning and the generic judge.** Provider-agnostic: users plug in any LLM through an adapter. No hard dependency on any provider.
- **Decision cache.** Committed to git by default, with redaction of secrets and PII before write, and an option to store it elsewhere for big suites.
- **`needs-review` in CI.** Warn on PRs, fail on main, configurable per project.
- **Precision bar.** An advisory AI step stays on only if at least 70% of its findings are accepted as real.
- **Scope.** Playwright only for v0.1. API-level tests and Cypress later. Mobile not planned.
- **v0.2 property-testing pilots.** Public OSS projects, so results are shareable: viem (TypeScript) and OpenZeppelin Contracts (Solidity).
- **Governance.** Adam Gencel is the sole maintainer. Personal project, no company affiliation. Contributions under the DCO (`git commit -s`).
- **Default decider.** Chosen from the M7 eval on the public dataset, not upfront (unchanged from the design).
