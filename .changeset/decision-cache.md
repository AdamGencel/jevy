---
"@jevyjs/core": patch
"@jevyjs/cli": patch
---

Add the decision cache. Decisions are redacted, then stored as sorted JSONL under `.jevy/decisions` (or in a `DecisionStore`). `replay` never calls the network. `jevy cache stats` and `jevy cache prune` inspect and trim the cache. A cached low-confidence yes or no stays `needs-review`.
