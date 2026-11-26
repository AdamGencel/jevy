import type { Decider } from "@jevyjs/core";
import { expect, test } from "@jevyjs/playwright";

function page(heading: string): string {
  return `<main><h1>${heading}</h1><button>Continue</button></main>`;
}

test.describe("checkout", () => {
  test("passes", async ({ page: tab }) => {
    await tab.setContent(page("Order confirmed"));
    await expect(tab.getByRole("main")).toSatisfy("Shows Order confirmed");
  });

  test("fails but is advisory", async ({ page: tab }) => {
    await tab.setContent(page("Order pending"));
    await expect(tab.getByRole("main")).toSatisfy("Shows Payment taken");
  });

  test.describe(() => {
    test("abstains, twice in one test", async ({ page: tab }) => {
      await tab.setContent(page("Order pending"));
      await expect(tab.getByRole("main")).toSatisfy("Unsure about the order");
      await expect(tab).toSatisfy("Shows Order pending", {
        criteria: "The heading names the order state",
      });
    });
  });

  test("a decider error is needs-review", async ({ page: tab }) => {
    await tab.setContent(page("Order lost"));
    await expect(tab.getByRole("main")).toSatisfy("Unreachable model");
  });
});

test("a soft failure discards the answer @discard", async ({ page: tab }) => {
  await tab.setContent(page("Soft page"));
  await expect.soft(tab.getByRole("main")).toSatisfy("Shows Soft page");
  expect.soft(1, "fails the test after the verdict").toBe(2);
});

test("a retry passes on the remembered answer", async ({ page: tab }) => {
  await tab.setContent(page("Retry page"));
  await expect(tab.getByRole("main")).toSatisfy("Shows Retry page");
  expect(test.info().retry, "the first attempt fails on purpose").toBe(1);
});

test("not.toSatisfy tells the author what to write", async ({ page: tab }) => {
  await tab.setContent(page("Order confirmed"));
  let message = "";
  try {
    await expect(tab.getByRole("main")).not.toSatisfy("Shows Order lost");
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("Write the statement you expect to hold");
});

const own: Decider = {
  id: "own",
  model: "own-1",
  decide: () => Promise.resolve({ answer: { value: "yes", confidence: 0.99 } }),
};

test.describe("own decider", () => {
  test.use({ decider: own });

  test("uses the decider object", async ({ page: tab }) => {
    await tab.setContent(page("Anything"));
    await expect(tab.getByRole("main")).toSatisfy("Shows whatever");
  });
});
