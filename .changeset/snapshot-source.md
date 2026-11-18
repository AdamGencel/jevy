---
"@jevyjs/playwright": patch
---

Add the snapshot source. `parseAriaSnapshot` turns the YAML from Playwright's `ariaSnapshot()` into the `AccessibilityNode` tree core hashes, and throws `SnapshotError` with the line number on malformed input. `snapshotAccessibility(pageOrLocator)` takes the snapshot and replaces the typed value of every password field, and of every field whose `autocomplete` is a secret token, with `[REDACTED]`, because the YAML prints those values in clear. Peer dependency: `@playwright/test` 1.49 or later.
