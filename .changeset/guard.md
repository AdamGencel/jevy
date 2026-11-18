---
"@jevyjs/cli": patch
---

Add `jevy guard --base <ref>`: a mechanical check, with no model call, that compares tests, `jevy.config.*`, `playwright.config.*` and the decision cache between two versions of a repository and reports weakening (removed tests or assertions, added `skip`/`only`/`fail`/`expect.soft`, a lowered pass threshold, `needsReview` relaxed to `warn`, approvals added to the cache). Files are parsed with the TypeScript compiler API and never executed. `--json` prints a versioned report; the exit code is 0 when clean, 1 at or above `--fail-on`, and 2 for a usage or git error. `typescript` is now a runtime dependency of `@jevyjs/cli`.
