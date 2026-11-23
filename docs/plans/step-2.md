# Build plan — step 2: the guard inside the agent's loop

Status: **not started.** Scope comes from [ROADMAP.md](../ROADMAP.md) step 2 and [DESIGN.md §8.1](../DESIGN.md#81-the-guard-inside-the-agents-loop-step-2). Read `AGENTS.md` first.

Why it is next: agents weaken tests when they can, and the guard today only reports that after the fact. This step stops it before the agent finishes, and teaches the guard to see a new test that checks nothing.

Items marked *(proposal)* are choices the builder may change. Record the reason if you do.

## Before building

Look at **isitdone** and **tdd-guard**. The research names them as the closest existing tools (a scanner for weakened tests with signed receipts, and a hook that enforces test-first). Note in the pull request what Jevy should copy and what it does differently. This needs network access.

## What exists to build on

`packages/cli/src/guard/` is the guard:

- `parse.ts` turns a test file into a model of tests and assertions; `diff-tests.ts`, `diff-config.ts` and `diff-decisions.ts` compare two versions.
- `analyse.ts` routes each changed file by path. The test globs are hard-coded there.
- `git.ts` has a `RepoReader` interface with a git implementation and an in-memory one for tests.
- `command.ts` parses `--base`, `--head`, `--fail-on`, `--cache-dir`, `--cwd` and `--json`. `report.ts` prints the human and JSON forms; `types.ts` lists the finding kinds.

`packages/core/src/config.ts` loads `jevy.config.ts` and rejects unknown keys. The guard does not import core: it reads the config as source text.

## Work packages

They own separate files and can be built side by side. Each is built test-first and then reviewed by a second, independent reviewer.

### 2a — Weak new tests

Owns: `guard/parse.ts`, `guard/diff-tests.ts`, `guard/types.ts`, `guard/findings.ts` and their tests.

For a test that is new or changed in the diff, add three findings:

- `test-without-assertion` (weakening): the test body has no `expect` chain and no `toSatisfy`. If the body calls a function defined elsewhere, the assertion may be inside it, so report `assertion-not-visible` (review) instead.
- `assertion-cannot-fail` (weakening): every assertion compares a literal with a literal (`expect(true).toBe(true)`) or an expression with itself (`expect(total).toEqual(total)`).
- `only-checks-mocks` (review): every asserted value is a mock the test created and called itself. Best effort.

Must not fire on: a test with one real assertion among several weak ones, a parameterised test, or a test whose title is not a literal (those stay `dynamic-title`).

### 2b — Guard items carried from step 1

Owns: `guard/command.ts`, `guard/analyse.ts`, `guard/git.ts` and their tests.

- `--merge-base`: compare against `git merge-base <base> <head>` and not the tip of `<base>`. Without it, tests added to the target branch after a pull request branched look like tests it removed.
- Test globs from `--tests <glob>` (repeatable) and from a `guard.tests` list in the config. The default stays as it is.
- The cache directory defaults to the `cache.dir` literal in `jevy.config.*` when there is one.
- `--cache-dir .` gives a wrong "must be inside the repository" error. Fix the message or allow it.

### 2c — Protected paths

Owns: `packages/core/src/config.ts` and its tests (the new key), plus a new `guard/protect.ts` in the CLI.

- Config key `protect: string[]` *(proposal)*: globs an agent must not change without a person. `parseConfig` accepts and validates it.
- Always protected, with no config needed: `jevy.config.*`, the decision cache directory, and the file named by `web3.policy`.
- The guard reports `protected-path-changed` (weakening) for any changed, added, deleted or renamed file that matches.
- A change to the `protect` list itself is `protected-path-changed`.

### 2d — Hooks

Owns: new `packages/cli/src/hook/` and the `hook` command in `cli.ts`. Depends on 2c's `protect.ts` for matching.

- `jevy hook stop`: runs the project's check commands, then `jevy guard --merge-base` against the default branch. If anything fails it exits with the code the agent treats as "blocked, keep working" and prints a short reason. For Claude Code that is exit code 2 with the reason on stderr; **confirm against the current hook documentation before building.**
- Check commands come from a `checks: string[]` config key *(proposal)*, for example `["pnpm lint", "pnpm typecheck", "pnpm test"]`. The config is a protected path, so an agent cannot quietly empty the list.
- Cap the loop: after two blocked attempts in a row for the same reason, let the agent stop and print the failure plainly. An agent that cannot fix it should hand back to a person, not spin.
- `jevy hook pre-edit`: reads the pending edit from stdin and blocks it when the file is a protected path, with a message that tells the agent to ask the maintainer.
- `jevy hook print --agent claude`: prints the settings snippet that wires both hooks up. Writing it into the agent's settings is `jevy init` in step 7.
- The hooks read the config as source text, as the guard does. They never import it.

### 2e — Skill file

Owns: a new `packages/cli/skill/SKILL.md`, shipped in the package.

At most 40 lines: the exact commands, the rules (never weaken a test; ask before touching a protected path; a healer fix is a diff), and where the report is. Long instruction files cost more and help less.

## Done when

- In a fixture repo, `jevy hook stop` blocks a session whose working tree has a deleted assertion or an added skip, and allows a clean one.
- `jevy hook pre-edit` blocks an edit to the config and to a file matched by `protect`.
- The guard flags a new test with no assertion and one that cannot fail, and stays silent on a normal new test.
- `--merge-base` gives no finding for a test added on the target branch after the branch point.
- Lint, typecheck, build and test pass. The README's guard section, DESIGN §7 and §8.1, and the roadmap's status line are updated.

## Not in this step

`jevy init`, the planner, generator and healer (step 7); the admission check and the plan file (step 6); hooks for agents other than Claude Code, unless they turn out to be the same mechanism.
