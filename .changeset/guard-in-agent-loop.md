---
"@jevyjs/cli": patch
"@jevyjs/core": patch
---

Put the guard inside a coding agent's loop (roadmap step 2).

- **Hooks for Claude Code.** `jevy hook stop` runs the commands in the config's `checks` list and then `jevy guard`, and blocks the agent from finishing while any of them fails. After two blocked attempts in a row for the same reason it lets the agent stop and tells the person what still fails. `jevy hook pre-edit` blocks an edit to a protected path. `jevy hook session-start` records the commit a session starts on, so the stop hook also sees what the agent commits. `jevy hook print --agent claude` prints the settings that wire the three up.
- **Protected paths.** The new `protect` config key lists globs an agent must not change without a person. Every `jevy.config.*`, the decision cache directory and the `web3.policy` file are always protected. `jevy guard` reports a change to a protected path as `protected-path-changed`. **This changes the default result for a config edit:** any change to `jevy.config.*` is now weakening and exits 1, where it was a review finding before. Decision record files are still compared record by record.
- **Weak new tests.** `jevy guard` flags a new or changed test with no assertion (`test-without-assertion`) or whose every assertion cannot fail (`assertion-cannot-fail`) as weakening. A test whose assertion may be in code the guard cannot read (`assertion-not-visible`), or that only checks mocks it created and called itself (`only-checks-mocks`), is flagged for review.
- **Guard options.** `--merge-base` compares against the commit where the head branched from the base; the report gains `mergeBase`. `--tests <glob>` (repeatable) and `guard.tests` in the config name the files compared as tests. The cache directory defaults to `cache.dir` in the config. Settings are read from the text of the base version of the config, so a change cannot redefine what it is checked against.
- **The working tree.** With no `--head`, the guard now also compares the index, so a weakened test that is staged and then restored on disk is still reported. It exits 2 for a file flagged `skip-worktree` or `assume-unchanged`, a config that git ignores, and a `--base` or `--head` that names two refs.
- `@jevyjs/core` accepts the new config keys `protect`, `checks` and `guard.tests`, and refuses a glob the guard's matcher could not honour.
- A short skill file for coding agents ships in `@jevyjs/cli` at `skill/SKILL.md`.
