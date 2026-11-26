import { expect, test } from "@jevyjs/playwright";

// Run with toSatisfy.blocking on. A test that fails only because a blocking
// toSatisfy answered no keeps that answer, and the answers it drew before,
// so a replay fails the same way. Any other failure discards them all.
const page = (heading: string): string =>
  `<main><h1>${heading}</h1><button>Continue</button></main>`;

test("a blocking fail keeps its answer", async ({ page: tab }) => {
  await tab.setContent(page("Order pending"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Payment taken");
});

test("a blocking fail and an exact failure", async ({ page: tab }) => {
  await tab.setContent(page("Refund pending"));
  await expect.soft(tab.getByRole("main")).toSatisfy("Shows Refund sent");
  expect(1, "an exact check fails too").toBe(2);
});

test("a pass and an exact failure", async ({ page: tab }) => {
  await tab.setContent(page("Parcel sent"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Parcel sent");
  expect(1, "an exact check fails").toBe(2);
});

test("a soft blocking fail between two passes", async ({ page: tab }) => {
  await tab.setContent(page("Invoice due"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Invoice due");
  await expect.soft(tab.getByRole("main")).toSatisfy("Shows Invoice paid");
  await expect(tab.getByRole("main")).toSatisfy("Shows Continue");
});
