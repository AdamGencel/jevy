import { expect, test } from "@jevyjs/playwright";

// toSatisfy has no test session to hold its record in a beforeAll or
// afterAll hook, so it says so instead of blaming the test's declaration.
let message = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.setContent("<main><h1>Kappa</h1></main>");
  try {
    await expect(page.getByRole("main")).toSatisfy("Shows Kappa");
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  await page.close();
});

test("toSatisfy in beforeAll names the hook", () => {
  expect(message).toContain("beforeAll");
  expect(message).not.toContain("declared with");
});
