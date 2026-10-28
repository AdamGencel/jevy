# Contributing to Jevy

Thanks for your interest. Jevy is a personal open-source project maintained by Adam Gencel (sole maintainer; no company affiliation). The M0 toolchain is in the repo. `@jevyjs/core` implements the M1 decision layer and the M2 decision cache. `@jevyjs/cli` implements `jevy cache stats` and `jevy cache prune`. The other packages are still stubs. The most useful contributions right now are still feedback on the design docs.

## Right now

- Read [docs/DESIGN.md](docs/DESIGN.md), [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).
- Open an issue or discussion on [github.com/AdamGencel/jevy](https://github.com/AdamGencel/jevy) with design feedback. Point to the section you're commenting on.
- Labelled eval cases are welcome once the case schema is published (roadmap M7). They must come from public apps only and contain no personal or sensitive data.

## Developer Certificate of Origin (DCO)

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). The sign-off certifies that you wrote the change, or otherwise have the right to submit it under the project's MIT licence. There is no CLA.

Add the sign-off with `-s`:

```bash
git commit -s -m "Fix cache key normalisation"
```

This appends a line using your git `user.name` and `user.email`:

```
Signed-off-by: Your Name <you@example.com>
```

- **Forgot it on the last commit:** `git commit --amend -s --no-edit`, then force-push your PR branch.
- **Forgot it on several commits:** `git rebase --signoff main`, then force-push your PR branch.
- **Check:** GitHub Actions checks that every commit on a pull request has a `Signed-off-by` trailer. Unsigned commits can't be merged.
- **Real name:** use a real name or a consistent identity you can be contacted under.

## Toolchain

- **Toolchain:** Node >= 22 (`.nvmrc` is 22; CI also runs Node 24), pnpm 10 (the version is pinned in the root `package.json` `packageManager` field), TypeScript, Vitest. From the repo root: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test`.
- **Changesets:** every user-facing change needs a changeset (`pnpm changeset`). A change that only touches the toolchain, and does not change published behaviour, does not. Nothing in this repo publishes to npm automatically.
- **Publishing:** every package under `packages/` is `"private": true` until the 0.1.0 release, so a stray `pnpm publish` cannot ship them. Changesets can still version them. Remove `"private"` as part of the 0.1.0 release, before the first real publish. Leave `publishConfig.access` set to `"public"`.
- **Tests:**
  - Use the fake decider in unit tests; never call hosted models in CI.
  - Tests that need a real decider (Jev, Kev or an LLM) are opt-in and read keys from environment variables, for example `TYPESAFE_API_KEY`.
- **Product only:** the repo holds the Jevy packages. Please don't add example apps or site-specific code (for example for Uniswap). Demos are recorded videos kept outside the repo, and package tests use small fixtures.
- **Scope:** v0.1 is Playwright only. Please discuss Cypress or API-level adapters in an issue first. Mobile is not planned.
- **Core principles a PR must not break:**
  - No silent self-healing.
  - No AI judgement of numbers, amounts or chain state.
  - Every AI decision goes through the decision cache, with redaction.
  - Hosted deciders stay opt-in.
  - No hard dependency on any LLM provider.
- **Security:**
  - Never commit API keys, private keys, seed phrases, `.env` files or raw page snapshots.
  - Report vulnerabilities privately through GitHub's private vulnerability reporting once the repository exists, not in public issues.

## Licence

Jevy is MIT-licensed (see [LICENSE](LICENSE)). By contributing, you agree that your contributions are licensed under the same terms.

## Code of conduct

To be added; likely the Contributor Covenant.
