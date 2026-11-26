import { expect, test } from "@jevyjs/playwright";

// Core refuses a spec that redaction or normalisation would change, such as
// this file's doubled space. The assertion fails with core's message, and
// the worker carries on.
test("a refused spec fails the assertion with core's message", async ({
  page,
}) => {
  await page.setContent("<main><h1>Order confirmed</h1></main>");
  let message = "";
  try {
    await expect(page.getByRole("main")).toSatisfy("Shows Order confirmed");
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/rename the spec file/i);
});

test("the worker still runs the next test", async ({ page }) => {
  await page.setContent("<main><h1>Next</h1></main>");
  await expect(page.getByRole("heading")).toHaveText("Next");
});
