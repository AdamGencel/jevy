import { expect, test } from "@jevyjs/playwright";

// The first attempt fails on its exact assertion after toSatisfy has asked
// the decider; the retry, in a new worker, gets the remembered answer from
// the run memo, passes, and writes the one record.
test("a retried test asks once", async ({ page }) => {
  await page.goto("/receipt");
  await expect(page.getByRole("main")).toSatisfy(
    'The page shows "Receipt sent"',
  );
  expect(test.info().retry, "the first attempt fails on purpose").toBe(1);
});
