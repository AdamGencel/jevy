# Contributing to Jevy

Thanks for your interest. Jevy is at the **design stage**, so there is no implementation code yet, and the most useful contributions right now are feedback on the design docs.

## Right now

- Read [docs/DESIGN.md](docs/DESIGN.md), [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).
- Open an issue or discussion for design feedback. Point to the section you're commenting on.
- Labelled eval cases (with no sensitive data) are welcome once the case schema is published (roadmap M7).

## Once code lands (planned)

- **Toolchain:** Node 20+, pnpm, TypeScript, Vitest. Run `pnpm install`, `pnpm build` and `pnpm test` from the repo root.
- **Changesets:** every user-facing change needs a changeset (`pnpm changeset`).
- **Tests:**
  - Use the fake decider in unit tests; never call hosted models in CI.
  - Tests that need a real decider are opt-in and read keys from environment variables.
- **Core principles a PR must not break:**
  - No silent self-healing.
  - No AI judgement of numbers, amounts or chain state.
  - Every AI decision goes through the decision cache.
  - Hosted deciders stay opt-in.
- **Security:**
  - Never commit API keys, private keys or raw page snapshots.
  - Report vulnerabilities privately (contact to be added) rather than in public issues.

## Licence and sign-off

The licence (MIT or Apache-2.0) and whether a DCO sign-off is required are still open. This file will be updated once they are decided.

## Code of conduct

To be added; likely the Contributor Covenant.
