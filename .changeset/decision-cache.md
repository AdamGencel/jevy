---
"@jevyjs/core": patch
---

Add the decision cache. `decisionKey` binds a stored answer to the redacted question, its options or levels, the snapshot hash, the decider and the model. `DecisionRecord` is one line of JSON with a fixed key order, and `parseRecord` rejects anything malformed with `CacheError`. `JsonlDecisionStore` keeps one file per spec under the cache directory and refuses spec paths that could leave it; `MemoryDecisionStore` is for tests. `createDecisionSession` replays, queries or records by cache mode: a hit is re-gated with the current thresholds, a human review is replayed as is, `replay` never calls the decider, every miss names its reason, records are held until `confirm()`, and a run memo stops a retry from drawing a new answer.
