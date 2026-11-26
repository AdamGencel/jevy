import { test as base } from "@playwright/test";
import type { Browser, BrowserContext } from "@playwright/test";
import { beginTest, beginWorker, endTest } from "./runtime.js";
import type { DeciderOption } from "./runtime.js";
import { rememberPasswordFields } from "./snapshot.js";

/** The option a spec file sets with `test.use({ decider })`. */
export interface JevyTestOptions {
  /**
   * The decider for this file or describe: `"llm"`, `"kev"` or `"jev"`,
   * passed to core's `selectDecider` as an override, or a `Decider` used as
   * it is. Unset, the project's `decider` from `jevy.config.*` applies.
   */
  readonly decider: DeciderOption | undefined;
}

interface JevyInternalFixtures {
  readonly _jevyTest: undefined;
}

interface JevyWorkerFixtures {
  readonly _jevyWorker: undefined;
}

/** Contexts that already have the init script, so it is added once. */
const remembering = new WeakSet<BrowserContext>();

async function rememberOn(context: BrowserContext): Promise<void> {
  if (remembering.has(context)) return;
  remembering.add(context);
  await context.addInitScript(rememberPasswordFields);
}

/**
 * Give every context the worker's browser creates the init script before
 * the caller can open a page in it: `browser.newContext()`, and
 * `browser.newPage()`, which calls it (Playwright 1.63). The methods are
 * replaced on this browser object only, and put back when the worker ends.
 *
 * Playwright's `context` event would also see every context, but its
 * listener runs after `newContext` has returned, so a page opened at once
 * could load before the script is added.
 */
function rememberOnNewContexts(browser: Browser): () => void {
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    await rememberOn(context);
    return context;
  };
  // Where newPage does not go through newContext, the script is added to its
  // context afterwards, and applies from the page's next navigation.
  browser.newPage = async (options) => {
    const page = await newPage(options);
    await rememberOn(page.context());
    return page;
  };
  return () => {
    Reflect.deleteProperty(browser, "newContext");
    Reflect.deleteProperty(browser, "newPage");
  };
}

/**
 * Playwright's `test`, extended for `toSatisfy`.
 *
 * - `decider`: an option fixture, so `test.use({ decider })` works per file.
 * - `context` and `browser`: Playwright's, with `rememberPasswordFields`
 *   installed on the test's context and on every context the browser
 *   creates for the test or a hook, so a password field a "show password"
 *   button switches to text is still blanked in the snapshot. The script
 *   adds one non-enumerable own property, `jevy.passwordFields`, to the
 *   page's `location`, and its own mutation observer and event listeners;
 *   it changes no element. A browser launched by hand
 *   (`chromium.launch()`), or a context from `launchPersistentContext`, is
 *   not covered.
 * - `_jevyWorker`: automatic, per worker. It runs before any hook, so a
 *   `toSatisfy` in `beforeAll` or `afterAll` is told it is in a hook.
 * - `_jevyTest`: automatic. It opens the test's decision state before the
 *   body and, in its teardown, writes the held records that `keysToKeep`
 *   keeps: all of them when the test passed, the answers up to a blocking
 *   "no" when that alone failed it, and none otherwise, so an answer that a
 *   later check contradicted never becomes a replayable record.
 *   `testInfo.status` and `testInfo.errors` are final there, after a soft
 *   failure too (checked on Playwright 1.63).
 */
export const test = base.extend<
  JevyTestOptions & JevyInternalFixtures,
  JevyWorkerFixtures
>({
  decider: [undefined, { option: true }],
  context: async ({ context }, use) => {
    await rememberOn(context);
    await use(context);
  },
  browser: [
    async ({ browser }, use) => {
      const restore = rememberOnNewContexts(browser);
      try {
        await use(browser);
      } finally {
        restore();
      }
    },
    { scope: "worker" },
  ],
  _jevyWorker: [
    async ({ browserName }, use) => {
      beginWorker(browserName);
      await use(undefined);
    },
    { scope: "worker", auto: true },
  ],
  _jevyTest: [
    async ({ decider }, use, testInfo) => {
      const run = beginTest(testInfo, decider);
      try {
        await use(undefined);
      } finally {
        endTest(testInfo);
      }
      await run.finish({
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        errors: testInfo.errors,
      });
    },
    { auto: true },
  ],
});
