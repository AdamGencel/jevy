import { DEFAULT_THRESHOLDS } from "@jevyjs/core";
import { fakeDecider } from "@jevyjs/deciders-llm";
import { expect, test } from "@jevyjs/playwright";

// Compiled to CommonJS by Playwright, so each import is a require() of an
// ES module: @jevyjs/playwright, @jevyjs/core and @jevyjs/deciders-llm.

test("toSatisfy in a CommonJS project", async ({ page }) => {
  await page.setContent("<main><h1>Order confirmed</h1></main>");
  await expect(page.getByRole("main")).toSatisfy("Shows Order confirmed");
});

test.describe("a decider from @jevyjs/deciders-llm", () => {
  test.use({
    decider: fakeDecider({
      id: "fake",
      model: "fake-cjs-1",
      answers: {
        answer: { value: "yes", confidence: DEFAULT_THRESHOLDS.pass },
      },
    }),
  });

  test("the fake decider answers", async ({ page }) => {
    await page.setContent("<main><h1>Anything</h1></main>");
    await expect(page.getByRole("main")).toSatisfy("Shows anything");
  });
});
