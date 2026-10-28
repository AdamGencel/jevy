---
"@jevyjs/core": patch
---

Add the decision layer: Decider types, verdicts, snapshot hashing, redaction, and the jevy.config.ts loader. A yes/no answer is not flipped: `yes` passes and `no` fails only at or above the pass threshold, and a weaker answer is `needs-review`. The fail threshold applies to scores, not to yes/no.
