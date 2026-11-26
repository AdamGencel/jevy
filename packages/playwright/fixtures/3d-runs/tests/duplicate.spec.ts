import { expect, test } from "@jevyjs/playwright";

// Four tests ask one question of one page, in four workers at once: one
// decider call, one record.
for (const name of ["one", "two", "three", "four"]) {
  test(`the same question ${name}`, async ({ page }) => {
    await page.setContent("<main><h1>Nu</h1></main>");
    await expect(page.getByRole("main")).toSatisfy("Slow 300 Shows Nu");
  });
}
