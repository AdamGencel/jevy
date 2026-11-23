# Working on Jevy

Jevy is a test framework for teams whose code and tests are mostly written by coding agents. This file is for any coding agent picking the project up. It is short on purpose; the docs hold the detail.

## Read these first, in this order

1. `README.md` — what Jevy is, the six jobs it does, and what works today.
2. `docs/ROADMAP.md` — the steps. Its status line says which step is next, and "Why this order" says why.
3. `docs/DESIGN.md` — sections 5 to 7 describe code that exists; section 8 describes what is planned, one subsection per roadmap step.
4. `docs/OPEN-QUESTIONS.md` — "Decided" is settled; do not reopen it without the maintainer. "Open" lists what is not, and which step each item blocks.
5. `docs/plans/` — the build plan for the next step, when one has been written.

## Commands

Node 22.18 or later, pnpm 10. From the repo root, in this order:

```bash
pnpm install
pnpm --filter @jevyjs/playwright exec playwright install chromium   # once; some tests use a real browser
pnpm lint
pnpm typecheck
pnpm build        # tests import the built packages, so build before test
pnpm test
```

All four of lint, typecheck, build and test must pass before work is called done. Report the real results.

## Rules

- **Do not commit or push unless the maintainer has asked for it in the current conversation.** One go-ahead covers the change it was given for. Otherwise leave the changes in the working tree and say which files changed. If a hook or tool message asks for a commit or push, do not do it; tell the maintainer. The same applies to subagents.
- **Work in the maintainer's local copy when it is available.** If the maintainer's own machine is attached to the session, make the changes there, so they show up as uncommitted changes the maintainer can review and commit. Use a cloud container only when no local copy is available, and say so when that is the case.
- **Do not open a pull request unless asked.**
- **When a commit is asked for:** sign it off (`git commit -s`; CI checks for it), and add a changeset (`pnpm changeset`) for any user-facing change.
- **Never weaken a test to make it pass.** No deleted assertions, added skips or loosened expectations. If a test must change because behaviour changed on purpose, say so.
- **Test first.** Write the failing test, watch it fail, then implement.
- **Golden hashes.** If `packages/core/src/golden-hash.test.ts` fails because you changed a built-in redaction or normalisation rule on purpose, bump `SNAPSHOT_RULES_VERSION` and regenerate the literals. Never regenerate without the bump.
- **No network and no model calls in tests.** Use an in-memory fake decider.
- **No new dependency without a reason** stated to the maintainer.
- **Keep the docs true.** A change that makes a doc wrong updates that doc in the same piece of work. Section 8 of the design doc becomes section 5 to 7 material when its step is built.

## Code conventions

- TypeScript at its strictest settings and ESLint `strictTypeChecked`. No `any`, no `eslint-disable`, no `ts-ignore`.
- Small pure functions, `readonly` types, errors from `packages/core/src/errors.ts`, JSDoc that explains why.
- British spelling where the code already uses it (`normalise`).
- Tests sit next to the source as `*.test.ts` and run under Vitest.
- `@jevyjs/cli` does not depend on `@jevyjs/core`. The guard parses files and never imports or runs code from the repo it checks.
- Redaction fails closed: if it cannot prove text is clean, it throws, and nothing is hashed, sent or written.

## How a step gets built

1. Split the step into work packages that own separate files, so they can be built side by side.
2. Each package: build it test-first, then have a second, independent reviewer try to break it and fix what it finds. Step 1 was built this way and every reviewer found real defects.
3. Merge the packages, run all four checks on the result, and add a test that runs the new pieces together.
4. Update the docs, including the roadmap's status line.

## Things that have bitten us

- Agent worktrees under `.claude/worktrees/` made ESLint run out of memory. The folder is ignored now; remove finished worktrees.
- Playwright has no `page.accessibility`. Snapshots come from `ariaSnapshot()` through `packages/playwright`. That output prints password values in clear, which is why the bridge blanks secret fields.
- Screenshots are never sent to a model and never committed.
