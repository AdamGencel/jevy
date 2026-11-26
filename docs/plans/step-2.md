# Build plan — step 2: the guard inside the agent's loop

Status: **built, 23 Nov 2026.** What exists is described in [DESIGN.md §7](../DESIGN.md#7-built-the-guard-protected-paths-and-agent-hooks-jevyjscli). This file is kept as the record of the plan; [What changed from the plan](#what-changed-from-the-plan) and [What isitdone and tdd-guard taught us](#what-isitdone-and-tdd-guard-taught-us) at the end say where the build differs and why. Read `AGENTS.md` first.

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
- Lint, typecheck, build and test pass. The README's guard section, DESIGN §7 (which absorbed the planned §8.1), and the roadmap's status line are updated.

## Not in this step

`jevy init`, the planner, generator and healer (step 7); the admission check and the plan file (step 6); hooks for agents other than Claude Code, unless they turn out to be the same mechanism.

## What changed from the plan

The two proposals, `protect` and `checks`, were kept as written. `guard.tests` is validated by the loader and may not be empty.

- **Decision records are not reported as protected paths by the guard** (2c). The plan protects the whole cache directory. A test run writes the records, so reporting each new one as weakening would fail every change that adds a model-judged check. The guard still compares them record by record, and the pre-edit hook still blocks an agent that edits one by hand.
- **Settings are read from the base version of the config** (2b). The plan did not say which version. Reading the head version would let a change move the cache directory or narrow the test globs and benefit in the same run.
- **The working-tree comparison also covers the index, and the guard refuses a tree it cannot see** (2b). A staged weakening restored on disk, a file flagged `skip-worktree`, an ignored config and an ambiguous ref each ended in "No findings" before.
- **A third hook, `jevy hook session-start`** (2d). The stop hook compares the branch with the default branch. An agent that commits on the default branch leaves nothing between the two, so the stop hook also compares the session with the commit it started on, which this hook records.
- **The stop hook has an overall deadline** (2d). Claude Code lets the agent proceed when a hook times out, so a hung check was a way through.
- **A parameterised test, or one with a non-literal title, is still checked for having no assertion** (2a). The plan said not to fire on either. `it.each([0])` or a computed title then silenced an empty test with one token. The cannot-fail and only-mocks rules are still not applied to them.
- **The printed settings call `./node_modules/.bin/jevy`, not `npx`** (2d). `npx --no-install` still asked the npm registry for a package named `jevy`.
- **Protected-path matching ignores case and Unicode form** (2c), because macOS and Windows disks do.

Not done, and listed as known limits in the README: a test weakened inside a git submodule (a changed submodule is now flagged for review); a config in another directory of a monorepo than the one the guard runs in. An edit hidden by a forged file timestamp (`core.trustctime false`) is now seen: the guard compares the bytes of the files it checks with the base itself.

## What isitdone and tdd-guard taught us

Looked at on 23 Nov 2026.

- **isitdone** is the closer of the two: a stop hook that runs the project's checks, scans the diff for weakened tests, and writes a signed receipt. Copied: the attempt cap with a plain "gave up" message to the person, and honouring `stop_hook_active`. Different: its scan is line-and-regex over the diff, where the guard compares syntax trees and matches tests by identity, so a reformat or a rename is not a finding. Its receipt is signed with a key kept beside it in the repository, so it proves nothing against the agent; Jevy's proof file is step 8 and its approvals step 10. It does not look for assertions that cannot fail or tests that only check mocks.
- **tdd-guard** enforces test-first with a model call on every edit. Jevy's hooks call no model, so they cost nothing and cannot block on a malformed reply, which is tdd-guard's main open issue. Its documentation states the limit both tools share: a shell command bypasses a pre-edit hook. Jevy answers that with the guard at stop time and in CI.
- Worth a later look: binding a pass to a hash of the tree and of the check configuration, so a loosened gate shows as stale (step 8); scanning CI files for neutered test steps (`|| true`, `--passWithNoTests`); a `doctor` command that proves the hooks block (step 7, with `jevy init`).
