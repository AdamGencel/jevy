---
"@jevyjs/core": patch
---

Tighten the decider contract. `callDecider` now returns `{ answers, truncated }`, and `gateAnswer` takes an optional `{ truncated }` context: on a cut-off snapshot a `fail` becomes `needs-review`. An answer can set `abstained: true`, which is always `needs-review`. `assertAnswers` checks own properties only, so an answer named `constructor` or `__proto__` is rejected. The snapshot hash now includes a rules version (`SNAPSHOT_HASH_VERSION` 2, `SNAPSHOT_RULES_VERSION` 2), so every existing snapshot hash changes, and `rulesFingerprint` fingerprints a project's redaction and normalisation rules.
