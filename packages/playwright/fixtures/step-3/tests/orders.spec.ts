import { expect, test } from "@jevyjs/playwright";

// Judgement only: every assertion here is toSatisfy, so with blocking off
// (the default) nothing in this file can fail the build. The guard reports
// it as only-advisory-assertions.
test.describe("orders", () => {
  test("a confirmed order", async ({ page }) => {
    await page.goto("/confirmed");
    await expect(page.getByRole("main")).toSatisfy(
      'The page shows "Order confirmed"',
    );
  });

  test("a pending order", async ({ page }) => {
    await page.goto("/pending");
    // The page shows "Payment pending", so the scripted model answers no.
    await expect(page.getByRole("main")).toSatisfy(
      'The page shows "Payment taken"',
    );
  });

  test("the brand colour", async ({ page }) => {
    await page.goto("/pending");
    // No colour is in an accessibility tree, so the scripted model abstains.
    await expect(page.getByRole("main")).toSatisfy(
      "The logo is the brand's shade of blue",
    );
  });
});
