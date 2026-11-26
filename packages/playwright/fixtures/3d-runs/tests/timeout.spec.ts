import { expect, test } from "@jevyjs/playwright";

// When the test's time left cannot fit the decider's attempts at their
// minimum, toSatisfy does not call: it reports needs-review at once, so the
// test ends with its report entry instead of a Playwright timeout.
const page = (heading: string): string => `<main><h1>${heading}</h1></main>`;

test("a late call to a slow model", async ({ page: tab }) => {
  test.setTimeout(10_000);
  await tab.setContent(page("Late"));
  await tab.waitForTimeout(8_700);
  await expect(tab.getByRole("main")).toSatisfy("Slow 8000 Shows Late");
});

test("a short timeout and a slow model", async ({ page: tab }) => {
  test.setTimeout(2_000);
  await tab.setContent(page("Tau"));
  await expect(tab.getByRole("main")).toSatisfy("Slow 8000 Shows Tau");
});
