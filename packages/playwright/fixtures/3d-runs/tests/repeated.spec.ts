import { expect, test } from "@jevyjs/playwright";

// Run twice by one runner (ui-twice.ts), as Playwright's UI, watch mode and
// VS Code do: each run asks again, because a run memo lasts one run.
test("asked once per run", async ({ page }) => {
  await page.setContent("<main><h1>Mu</h1></main>");
  await expect(page.getByRole("main")).toSatisfy("Shows Mu");
});
