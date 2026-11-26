import { expect, test } from "@jevyjs/playwright";
import { SECRET } from "../jevy.config.js";

// A password field that a "show password" button switches to text, with no
// name or id that says it is secret: only the init script's record of it
// blanks its value. Every way a test opens a page must have the script.
const PAGE = `<main><label>Code <input type=password value="${SECRET}"></label>
<button onclick="document.querySelector('input').type = 'text'">Show</button></main>`;

test("the page fixture", async ({ page }) => {
  await page.setContent(PAGE);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("main")).toSatisfy("Shows fixture page");
});

test("a context from browser.newContext()", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(PAGE);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("main")).toSatisfy("Shows own context");
  await context.close();
});

test("a page from browser.newPage()", async ({ browser }) => {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("main")).toSatisfy("Shows own page");
  await page.close();
});
