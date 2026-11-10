---
"@jevyjs/core": patch
---

Tighten redaction and pruning. `callDecider` now prunes to the budget of the decider it calls, so Kev gets its 6,000-token budget without the caller passing `deciderId`. Seed phrases are redacted when numbered, comma-separated, or split one word per node. Raw 64-hex private keys without `0x`, JWTs and Google API keys are redacted, and recovery-phrase and private-key textboxes count as secret fields. Wallet fields such as `token` and `publicKey` are no longer blanked. Pruning is O(n log n) and gives the same result as before. Node 22.18 or later is required.
