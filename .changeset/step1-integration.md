---
"@jevyjs/core": patch
"@jevyjs/playwright": patch
---

`callDecider` now redacts each question's prompt, criteria and option labels before the decider sees them, and refuses an option id or score level that redaction would change. A snapshot that reuses nodes into more than `MAX_SNAPSHOT_NODES` (250,000) is rejected instead of hanging. Core exports `SECRET_AUTOCOMPLETE_TOKENS`, and the Playwright bridge uses it instead of its own copy.
