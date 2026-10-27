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
3. **Data licence and terms for published eval snapshots.**
   - The ~200-case public dataset contains accessibility snapshots, and possibly screenshots, of third-party public sites such as the Uniswap web app.
   - Check whether the sites' terms allow redistributing them, and choose a data licence (for example CC-BY-4.0 or CDLA-Permissive-2.0) separate from the MIT code licence.
   - Decide whether the dataset ships in this repo or in a separate dataset repo. A separate repo is preferred if any doubt remains.
   - The same terms check applies to recording promo demo videos on those sites.
   - *Blocks:* M7 (publishing the dataset), M8 demos.

## Decided (27 Oct 2026)

- **Product.** Open-source TypeScript framework distributed on npm as a pnpm monorepo. Three levels: record (no tests), Playwright plugin (existing tests), properties (v0.2). Decision cache with deterministic CI replay; numbers and chain state checked in code; swappable `Decider` (Jev pinned to `jev-1.14.0`, Kev, generic LLM judge); `eval` command; Web3 wallet pack as the standout generic feature. v0.1 = levels 1 and 2 plus the wallet pack. The repo contains only the product packages; users install and configure Jevy for their own app.
- **Name.** Jevy: CLI `jevy`, npm scope `@jevy/*`. Pending the two open items above.
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
