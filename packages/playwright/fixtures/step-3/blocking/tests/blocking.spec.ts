import { expect, test } from "@jevyjs/playwright";

// The pass and the fail of tests/orders.spec.ts, under blocking/jevy.config.ts,
// where toSatisfy.blocking is on.
test.describe("blocking", () => {
  test("a confirmed order", async ({ page }) => {
    await page.goto("/confirmed");
    await expect(page.getByRole("main")).toSatisfy(
      'The page shows "Order confirmed"',
    );
  });

  test("a pending order", async ({ page }) => {
    await page.goto("/pending");
    await expect(page.getByRole("main")).toSatisfy(
      'The page shows "Payment taken"',
    );
  });
});
