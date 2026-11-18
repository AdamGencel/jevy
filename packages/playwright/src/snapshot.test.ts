import { existsSync } from "node:fs";
import {
  REDACTED,
  RedactionError,
  hashSnapshot,
  pruneSnapshot,
  redactSnapshot,
} from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import { chromium } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotAccessibility } from "./snapshot.js";

const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw error;
    return await chromium.launch({ executablePath: FALLBACK_CHROMIUM });
  }
}

const FORM = `
<form aria-label="Checkout">
  <label>Email <input type="email" value="a@b.co" required></label>
  <label>PIN <input type="password" id="pin"></label>
  <label>Code <input autocomplete="one-time-code" id="otp"></label>
  <label>Card <input autocomplete="billing cc-number" id="cc"></label>
  <label>CVC <input autocomplete="cc-csc" id="csc"></label>
  <label>Current <input autocomplete="current-password" id="cur"></label>
  <label>New <input type="password" autocomplete="new-password" id="new"></label>
  <label><input type="checkbox" checked> Terms</label>
  <label><input type="checkbox" id="mixed"> Some</label>
  <label><input type="radio" name="r" checked> Post</label>
  <label><input type="radio" name="r"> Courier</label>
  <label>Country <select><option>NL</option><option selected>UK</option></select></label>
  <label>Name <input disabled value="Ada"></label>
  <button disabled>Pay</button>
</form>`;

const SECRETS: Readonly<Record<string, string>> = {
  "#pin": "4321",
  "#otp": "998877",
  "#cc": "4111111111111111",
  "#csc": "737",
  "#cur": "hunter2-current",
  "#new": "s3cret  pass",
};

const CONTENT = `
<header><nav aria-label="Main"><ul>
  <li><a href="/">Home</a></li><li><a href="/about">About us</a></li>
</ul></nav></header>
<main>
  <h1>Order confirmed</h1>
  <h2>Details</h2>
  <ol><li>One</li><li>Two</li></ol>
  <table><caption>Items</caption>
    <tr><th>Item</th><th>Qty</th></tr>
    <tr><td>Pen</td><td>2</td></tr>
  </table>
  <div role="dialog" aria-modal="true" aria-labelledby="dt">
    <h2 id="dt">Confirm</h2><button>OK</button>
  </div>
</main>`;

const ALERTS = `
<div role="alert">Payment failed: card declined</div>
<div role="status">Saved</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page.setContent("");
});

async function fillSecrets(): Promise<void> {
  for (const [selector, value] of Object.entries(SECRETS)) {
    await page.fill(selector, value);
  }
  await page.evaluate(() => {
    const box = document.getElementById("mixed");
    if (box instanceof HTMLInputElement) box.indeterminate = true;
  });
}

function expectNoSecrets(tree: AccessibilityNode): void {
  const json = JSON.stringify(tree);
  for (const value of Object.values(SECRETS)) {
    expect(json).not.toContain(value);
  }
  expect(json).not.toContain("s3cret pass");
}

describe("snapshotAccessibility: form", () => {
  it("maps every control and blanks every secret field", async () => {
    await page.setContent(FORM);
    await fillSecrets();
    const tree = await snapshotAccessibility(page);
    expect(tree).toEqual({
      role: "form",
      name: "Checkout",
      children: [
        { role: "text", name: "Email" },
        { role: "textbox", name: "Email", value: "a@b.co" },
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
        { role: "text", name: "Code" },
        { role: "textbox", name: "Code", value: REDACTED },
        { role: "text", name: "Card" },
        { role: "textbox", name: "Card", value: REDACTED },
        { role: "text", name: "CVC" },
        { role: "textbox", name: "CVC", value: REDACTED },
        { role: "text", name: "Current" },
        { role: "textbox", name: "Current", value: REDACTED },
        { role: "text", name: "New" },
        { role: "textbox", name: "New", value: REDACTED },
        { role: "checkbox", name: "Terms", checked: true },
        { role: "text", name: "Terms" },
        { role: "checkbox", name: "Some", checked: "mixed" },
        { role: "text", name: "Some" },
        { role: "radio", name: "Post", checked: true },
        { role: "text", name: "Post" },
        { role: "radio", name: "Courier" },
        { role: "text", name: "Courier Country" },
        {
          role: "combobox",
          name: "Country",
          children: [
            { role: "option", name: "NL" },
            { role: "option", name: "UK", selected: true },
          ],
        },
        { role: "text", name: "Name" },
        { role: "textbox", name: "Name", disabled: true, value: "Ada" },
        { role: "button", name: "Pay", disabled: true },
      ],
    });
    expectNoSecrets(tree);
  });

  it("finds that the YAML itself prints the password in clear", async () => {
    // This is why snapshotAccessibility reads secret fields from the DOM.
    await page.setContent(FORM);
    await fillSecrets();
    const yaml = await page.locator("body").ariaSnapshot();
    expect(yaml).toContain('textbox "PIN": "4321"');
    expect(yaml).toContain('textbox "Current": hunter2-current');
    expect(yaml).not.toContain("required");
    expect(yaml).not.toContain("autocomplete");
  });

  it("blanks a password labelled PIN, whose label core cannot recognise", async () => {
    await page.setContent('<label>PIN <input type="password"></label>');
    await page.fill("input", "2468");
    const tree = await snapshotAccessibility(page);
    expect(tree).toEqual({
      role: "document",
      children: [
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
      ],
    });
    expect(JSON.stringify(tree)).not.toContain("2468");
  });

  it("blanks the secret wherever it appears, not only in the field", async () => {
    await page.setContent(`
      <label>PIN <input type="password" value="8642"></label>
      <p id="echo">You typed 8642</p>
      <label><input type="checkbox"> Remember <input type="password" value="8642" aria-label="again"></label>`);
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain("8642");
    expect(JSON.stringify(tree)).toContain(`You typed ${REDACTED}`);
  });

  it("blanks a password inside an open shadow root", async () => {
    await page.setContent(`
      <secret-box></secret-box>
      <script>
        customElements.define("secret-box", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "open" }).innerHTML =
              '<label>Key <input type="password" value="shadow-secret-1"></label>';
          }
        });
      </script>`);
    const yaml = await page.locator("body").ariaSnapshot();
    expect(yaml).toContain("shadow-secret-1");
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain("shadow-secret-1");
  });

  it("blanks a textarea with a secret autocomplete token", async () => {
    await page.setContent(
      '<label>Notes <textarea autocomplete="one-time-code">112233</textarea></label>',
    );
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain("112233");
  });

  it("snapshots a locator, and reads secrets from the locator's own frame", async () => {
    await page.setContent(`
      <h1>Outside</h1>
      <iframe srcdoc='<form aria-label="Login"><label>PIN <input type="password" value="frame-secret-9"></label><button>Go</button></form>'></iframe>`);
    const form = page.frameLocator("iframe").getByRole("form");
    const yaml = await form.ariaSnapshot();
    expect(yaml).toContain("frame-secret-9");
    const tree = await snapshotAccessibility(form);
    expect(tree).toEqual({
      role: "form",
      name: "Login",
      children: [
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
        { role: "button", name: "Go" },
      ],
    });
  });

  it("reads the value of a field with a placeholder, and blanks it when secret", async () => {
    await page.setContent(`
      <label>Email <input placeholder="you@x.test" value="a@b.co"></label>
      <label>PIN <input type="password" placeholder="4 digits" value="9753"></label>`);
    expect(await snapshotAccessibility(page)).toEqual({
      role: "document",
      children: [
        { role: "text", name: "Email" },
        { role: "textbox", name: "Email", value: "a@b.co" },
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
      ],
    });
  });

  it("does not show iframe content in a page snapshot", async () => {
    await page.setContent(
      `<button>Top</button><iframe srcdoc='<input type="password" value="inner-secret">'></iframe>`,
    );
    const tree = await snapshotAccessibility(page);
    expect(tree).toEqual({
      role: "document",
      children: [{ role: "button", name: "Top" }, { role: "iframe" }],
    });
  });

  it("matches page.ariaSnapshot() for a page", async () => {
    await page.setContent(CONTENT);
    expect(await page.locator("body").ariaSnapshot()).toBe(
      await page.ariaSnapshot(),
    );
  });
});

describe("snapshotAccessibility: content", () => {
  it("maps headings, lists, links, a table and a dialog", async () => {
    await page.setContent(CONTENT);
    expect(await snapshotAccessibility(page)).toEqual({
      role: "document",
      children: [
        {
          role: "banner",
          children: [
            {
              role: "navigation",
              name: "Main",
              children: [
                {
                  role: "list",
                  children: [
                    {
                      role: "listitem",
                      children: [{ role: "link", name: "Home" }],
                    },
                    {
                      role: "listitem",
                      children: [{ role: "link", name: "About us" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          role: "main",
          children: [
            { role: "heading", name: "Order confirmed", level: 1 },
            { role: "heading", name: "Details", level: 2 },
            {
              role: "list",
              children: [
                { role: "listitem", children: [{ role: "text", name: "One" }] },
                { role: "listitem", children: [{ role: "text", name: "Two" }] },
              ],
            },
            {
              role: "table",
              name: "Items",
              children: [
                {
                  role: "caption",
                  children: [{ role: "text", name: "Items" }],
                },
                {
                  role: "rowgroup",
                  children: [
                    {
                      role: "row",
                      name: "Item Qty",
                      children: [
                        { role: "columnheader", name: "Item" },
                        { role: "columnheader", name: "Qty" },
                      ],
                    },
                    {
                      role: "row",
                      name: "Pen 2",
                      children: [
                        { role: "cell", name: "Pen" },
                        { role: "cell", name: "2" },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              role: "dialog",
              name: "Confirm",
              children: [
                { role: "heading", name: "Confirm", level: 2 },
                { role: "button", name: "OK" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("maps an alert and a status region", async () => {
    await page.setContent(ALERTS);
    expect(await snapshotAccessibility(page)).toEqual({
      role: "document",
      children: [
        {
          role: "alert",
          children: [{ role: "text", name: "Payment failed: card declined" }],
        },
        { role: "status", children: [{ role: "text", name: "Saved" }] },
      ],
    });
  });

  it("reads names that Playwright prints unquoted between slashes", async () => {
    await page.setContent(`<button>/</button><button>/api/</button>`);
    expect(await snapshotAccessibility(page)).toEqual({
      role: "document",
      children: [
        { role: "button", name: "/" },
        { role: "button", name: "/api/" },
      ],
    });
  });
});

describe("snapshotAccessibility with core", () => {
  const page1 = (stamp: string, button: string): string => `
    <main>
      <h1>Order 42</h1>
      <p>Updated ${stamp}</p>
      <label>PIN <input type="password" value="5150"></label>
      <button>${button}</button>
    </main>`;

  it("hashes the same page the same way twice", async () => {
    await page.setContent(page1("2026-11-18T10:00:00Z", "Pay"));
    const first = hashSnapshot(await snapshotAccessibility(page));
    const second = hashSnapshot(await snapshotAccessibility(page));
    expect(second).toBe(first);
  });

  it("ignores a cosmetic change and sees a relevant one", async () => {
    await page.setContent(page1("2026-11-18T10:00:00Z", "Pay"));
    const base = hashSnapshot(await snapshotAccessibility(page));
    await page.setContent(page1("2026-11-19T23:59:59Z", "Pay"));
    expect(hashSnapshot(await snapshotAccessibility(page))).toBe(base);
    await page.setContent(page1("2026-11-18T10:00:00Z", "Pay now"));
    expect(hashSnapshot(await snapshotAccessibility(page))).not.toBe(base);
  });

  it("keeps the hash when only focus moves", async () => {
    await page.setContent(page1("2026-11-18T10:00:00Z", "Pay"));
    const base = hashSnapshot(await snapshotAccessibility(page));
    await page.focus("button");
    expect(hashSnapshot(await snapshotAccessibility(page))).toBe(base);
  });

  it("never lets the password value through", async () => {
    await page.setContent(page1("2026-11-18T10:00:00Z", "Pay"));
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain("5150");
    expect(JSON.stringify(redactSnapshot(tree))).not.toContain("5150");
  });

  it("is accepted by pruneSnapshot and redactSnapshot", async () => {
    await page.setContent(FORM + CONTENT + ALERTS);
    await fillSecrets();
    const tree = await snapshotAccessibility(page);
    const redacted = redactSnapshot(tree);
    expect(redacted.role).toBe("document");
    expectNoSecrets(redacted);
    const pruned = pruneSnapshot(tree, { maxNodes: 10 });
    expect(pruned.truncated).toBe(true);
    expect(pruned.snapshot.role).toBe("document");
    const whole = pruneSnapshot(tree);
    expect(whole.truncated).toBe(false);
    expectNoSecrets(whole.snapshot);
  });
});

describe("snapshotAccessibility: secret fields that change", () => {
  /** A stand-in Locator whose DOM read returns the given values in turn. */
  function fakeLocator(
    reads: readonly (readonly string[])[],
    yaml: string,
  ): { readonly locator: Locator; readonly calls: () => number } {
    let calls = 0;
    const fake = {
      evaluate: (): Promise<readonly string[]> => {
        const values = reads[Math.min(calls, reads.length - 1)] ?? [];
        calls += 1;
        return Promise.resolve(values);
      },
      ariaSnapshot: (): Promise<string> => Promise.resolve(yaml),
    };
    return { locator: fake as unknown as Locator, calls: () => calls };
  }

  it("throws when the values keep changing", async () => {
    const { locator, calls } = fakeLocator(
      [["a1"], ["a2"], ["a3"], ["a4"], ["a5"], ["a6"], ["a7"]],
      '- textbox "PIN": a1',
    );
    await expect(snapshotAccessibility(locator)).rejects.toBeInstanceOf(
      RedactionError,
    );
    expect(calls()).toBe(6);
  });

  it("retries and returns a clean tree once the values settle", async () => {
    const { locator } = fakeLocator(
      [["old"], ["new"], ["new"], ["new"]],
      '- textbox "PIN": new',
    );
    expect(await snapshotAccessibility(locator)).toEqual({
      role: "textbox",
      name: "PIN",
      value: REDACTED,
    });
  });
});
