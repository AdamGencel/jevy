---
"@jevyjs/core": patch
"@jevyjs/deciders-jev": patch
"@jevyjs/deciders-kev": patch
"@jevyjs/deciders-llm": patch
---

Add the Jev, Kev, and generic LLM deciders. Every question includes an inconclusive option that maps to needs-review. Probability and confidence are stored as separate signals, and the verdict gate still uses confidence only. Replay does not construct a network client. Jev stays opt-in and reads TYPESAFE_API_KEY only when a call is made.
