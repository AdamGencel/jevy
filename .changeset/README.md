# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning.

User-facing changes get a changeset (`pnpm changeset`). Versions stay on `0.0.x` until the 0.1.0 release. There is no publish workflow: publishing is manual and happens only when a maintainer asks for it.

`@jevyjs/cli` is `0.0.1` because that version is already on npm as a placeholder. The other packages are `0.0.0` and have not been published.

Every package is `"private": true` until 0.1.0. That blocks the registry only; Changesets still versions them. Remove `"private"` in the 0.1.0 release before publishing, and keep `publishConfig.access` as `"public"`.
