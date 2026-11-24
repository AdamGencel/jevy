---
name: jevy
description: Use when writing, changing or fixing tests in a project that uses Jevy, and before saying work there is done.
---

# Jevy

Jevy guards this project's tests. A check weakened to get a pass is reported, and it blocks you.

## Commands

    npx jevy guard --base origin/main --merge-base          # what this change weakened
    npx jevy guard --base origin/main --merge-base --json   # the same, as JSON (schema v1)
    npx jevy hook stop       # the project's checks, then the guard; exit 2 means not done
    npx jevy hook pre-edit   # reads a pending edit on stdin; exit 2 means a protected path

Exit codes of `guard`: 0 clean, 1 findings at or above `--fail-on`, 2 it could not run.

## Rules

1. Never weaken a test to make it pass. No deleted test or assertion, no `.skip`, `.only`, `.fixme` or `test.fail`, no `expect.soft`, no looser matcher or expected value. Fix the code. If the test is wrong, say so and ask.
2. A new test must check something: at least one assertion whose outcome depends on the code under test. `expect(true).toBe(true)` does not count, nor does a mock you only called yourself.
3. Ask before touching a protected path: `jevy.config.*`, the decision cache (`.jevy/decisions`), the wallet policy, and anything in the config's `protect` list. Do not go round the hook with a shell command; the guard reports the change anyway.
4. Never write a decision record or set `reviewedBy` by hand. An approval is a person's.
5. A fix to a broken test is a diff for a person to approve. Do not apply it quietly, and do not change what a test expects to match what the app does today.
6. Before you say you are done, run the project's checks (`checks` in `jevy.config.*`) and the guard. Report the real results.

## Where the report is

`jevy guard` prints its findings to stdout. `weakening` fails, `review` needs a person, `info` is for the record. Each finding has a kind, a file, a test and a line. With `--json`, read `summary` and `findings`. When the stop hook blocks, its reason lists the failed checks and the findings: fix the cause, then stop again.
