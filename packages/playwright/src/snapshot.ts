import { RedactionError } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import type { Locator, Page } from "@playwright/test";
import { parseAriaSnapshot } from "./parse.js";
import { SECRET_AUTOCOMPLETE_TOKENS, scrubSecrets } from "./secrets.js";

/**
 * How often to retry when a secret field changes while the snapshot is
 * taken. A page that keeps changing a password field is not snapshotted.
 */
const MAX_ATTEMPTS = 3;

/**
 * Take the accessibility tree of a page or of one element, in the shape core
 * hashes, redacts and prunes.
 *
 * The source is `locator.ariaSnapshot()` (public API, Playwright 1.49 and
 * later, any browser). That YAML prints the typed value of every input in
 * clear, password fields included, and it drops `type` and `autocomplete`,
 * so core cannot tell a secret field from its accessible name alone.
 *
 * So the values of secret fields are read from the DOM of the same frame, in
 * the same step, before and after the snapshot: `<input type="password">`
 * and any input or textarea whose `autocomplete` holds one of core's secret
 * tokens, including fields inside open shadow roots. Every occurrence of
 * those values in the tree is replaced with `[REDACTED]`, whatever the label
 * says. If the values differ before and after (the page changed them while
 * the snapshot was taken), the step is retried; if they keep changing,
 * `RedactionError` is thrown rather than risking a tree with a secret in it.
 *
 * Closed shadow roots are skipped by both the snapshot and the DOM read.
 * The default snapshot mode is used, which does not descend into iframes,
 * so only the target's own frame is read.
 */
export async function snapshotAccessibility(
  target: Page | Locator,
): Promise<AccessibilityNode> {
  const scope = isPage(target) ? target.locator("body") : target;
  const documentScope = isPage(target) ? target.locator(":root") : target;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const before = await readSecretValues(documentScope);
    const yaml = await scope.ariaSnapshot();
    const after = await readSecretValues(documentScope);
    if (sameValues(before, after)) {
      return scrubSecrets(parseAriaSnapshot(yaml), after);
    }
  }
  throw new RedactionError(
    "Secret form fields changed while the accessibility snapshot was taken. " +
      "The snapshot was discarded.",
  );
}

function isPage(target: Page | Locator): target is Page {
  return "mainFrame" in target;
}

async function readSecretValues(scope: Locator): Promise<readonly string[]> {
  const values = await scope.evaluate(collectSecretValues, [
    ...SECRET_AUTOCOMPLETE_TOKENS,
  ]);
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Runs in the browser, so it must not refer to anything outside its own body.
 * Walks the whole document of the element's frame, not only the element,
 * because `aria-owns` and labels can pull content in from elsewhere; reading
 * more fields than needed only redacts more.
 */
function collectSecretValues(
  element: Element,
  tokens: readonly string[],
): string[] {
  const values: string[] = [];
  const roots: (Document | ShadowRoot)[] = [element.ownerDocument];
  for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
    for (const candidate of Array.from(root.querySelectorAll("*"))) {
      if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
      const isInput = candidate.tagName === "INPUT";
      if (!isInput && candidate.tagName !== "TEXTAREA") continue;
      const field = candidate as HTMLInputElement | HTMLTextAreaElement;
      const autocomplete = (candidate.getAttribute("autocomplete") ?? "")
        .toLowerCase()
        .split(/\s+/);
      const secret =
        (isInput && field.type === "password") ||
        autocomplete.some((token) => tokens.includes(token));
      if (secret && field.value !== "") values.push(field.value);
    }
  }
  return values;
}
