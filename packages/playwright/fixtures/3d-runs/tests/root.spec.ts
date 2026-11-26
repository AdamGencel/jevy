import { dirname } from "node:path";
import { expect, test } from "@jevyjs/playwright";

// Run from outside/playwright.config.ts, whose directory is the Jevy root,
// so this file is outside it.
test("a spec outside the Jevy root is refused with the root named", async ({
  page,
}) => {
  await page.setContent("<main><h1>Root</h1></main>");
  let message = "";
  try {
    await expect(page.getByRole("main")).toSatisfy("Shows Root");
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  const root = dirname(test.info().config.configFile ?? "");
  expect(message).toContain("inside the Jevy root");
  expect(message).toContain(root);
});
