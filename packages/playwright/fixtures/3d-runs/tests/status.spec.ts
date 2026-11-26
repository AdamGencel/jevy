import { expect, test } from "@jevyjs/playwright";

// Only a test that passed saves its answers. Every other status discards
// them, an expected failure and a skip after the check included.
const page = (heading: string): string => `<main><h1>${heading}</h1></main>`;

test("a passing test keeps its answer", async ({ page: tab }) => {
  await tab.setContent(page("Alpha"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Alpha");
});

test("an expected failure discards its answer", async ({ page: tab }) => {
  test.fail();
  await tab.setContent(page("Beta"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Beta");
  expect(1, "a later check fails, as the test expects").toBe(2);
});

test("a skip after the check discards its answer", async ({ page: tab }) => {
  await tab.setContent(page("Gamma"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Gamma");
  test.skip(true, "skipped after the check");
});

test("a fixme after the check discards its answer", async ({ page: tab }) => {
  await tab.setContent(page("Delta"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Delta");
  test.fixme(true, "fixme after the check");
});
