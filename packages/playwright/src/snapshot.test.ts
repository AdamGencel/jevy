import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import {
  REDACTED,
  RedactionError,
  hashSnapshot,
  pruneSnapshot,
  redactSnapshot,
} from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FieldReading } from "./secrets.js";
import { rememberPasswordFields, snapshotAccessibility } from "./snapshot.js";

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
                      children: [{ role: "link", name: "Home", url: "/" }],
                    },
                    {
                      role: "listitem",
                      children: [
                        { role: "link", name: "About us", url: "/about" },
                      ],
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
      evaluate: (): Promise<{
        readonly fields: readonly FieldReading[];
        readonly remembered: undefined;
      }> => {
        const values = reads[Math.min(calls, reads.length - 1)] ?? [];
        calls += 1;
        return Promise.resolve({
          fields: values.map(passwordField),
          remembered: undefined,
        });
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

/** A password field with the given value, as the DOM read returns it. */
function passwordField(value: string): FieldReading {
  return {
    tag: "input",
    type: "password",
    value,
    autocomplete: "",
    name: "",
    id: "",
    wasPassword: false,
  };
}

describe("snapshotAccessibility: link urls", () => {
  it("keeps each link's url, reduced, and blanks a secret in it", async () => {
    await page.setContent(`
      <label>PIN <input type="password" value="77331"></label>
      <a href="/orders/42?session=abc#top">Order</a>
      <a href="https://user:pw@shop.test/pay">Pay</a>
      <a href="javascript:alert('hi')">Script</a>
      <a href="/reset/77331">Reset</a>
      <a href="">Here</a>`);
    const tree = await snapshotAccessibility(page);
    expect(tree).toEqual({
      role: "document",
      children: [
        { role: "text", name: "PIN" },
        { role: "textbox", name: "PIN", value: REDACTED },
        { role: "link", name: "Order", url: "/orders/42" },
        { role: "link", name: "Pay", url: "https://shop.test/pay" },
        { role: "link", name: "Script", url: "javascript:" },
        { role: "link", name: "Reset", url: `/reset/${REDACTED}` },
        { role: "link", name: "Here" },
      ],
    });
    expect(redactSnapshot(tree)).toEqual(tree);
  });

  it.each([
    ["hunt#er2zz", "/u/hunt#er2zz"],
    ["secr?etvalue", "/u/secr?etvalue"],
  ])("blanks a secret holding # or ? whole: %s", async (secret, href) => {
    await page.setContent(
      `<label>Pass <input type="password" value="${secret}"></label>` +
        `<a href="${href}">x</a>`,
    );
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain(secret.slice(0, 4));
    expect(tree.children).toContainEqual({
      role: "link",
      name: "x",
      url: `/u/${REDACTED}`,
    });
  });

  it("blanks a secret in lower-case percent-encoding or with + for spaces", async () => {
    await page.setContent(`
      <label>Pass <input type="password" value="pässwort99"></label>
      <label>Phrase <input type="password" value="my pass phrase"></label>
      <a href="/u/p%c3%a4sswort99">lower</a>
      <a href="/u/p%C3%a4sswort99">mixed</a>
      <a href="/s/my+pass+phrase">plus</a>`);
    const tree = await snapshotAccessibility(page);
    const links = (tree.children ?? []).filter((node) => node.role === "link");
    expect(links).toEqual([
      { role: "link", name: "lower", url: `/u/${REDACTED}` },
      { role: "link", name: "mixed", url: `/u/${REDACTED}` },
      { role: "link", name: "plus", url: `/s/${REDACTED}` },
    ]);
  });

  it("does not blank text that matches a number field named like a secret", async () => {
    await page.setContent(`
      <label>Min length <input type="number" name="password_min_length" value="8"></label>
      <a href="/v8/docs">Docs v8</a>`);
    const tree = await snapshotAccessibility(page);
    expect(JSON.stringify(tree)).not.toContain(REDACTED);
    expect(tree.children).toContainEqual({
      role: "link",
      name: "Docs v8",
      url: "/v8/docs",
    });
  });

  it("changes the hash when a link points somewhere new", async () => {
    await page.setContent('<a href="/pay/visa">Pay</a>');
    const base = hashSnapshot(await snapshotAccessibility(page));
    await page.setContent('<a href="/pay/visa?t=1">Pay</a>');
    expect(hashSnapshot(await snapshotAccessibility(page))).toBe(base);
    await page.setContent('<a href="/pay/crypto">Pay</a>');
    expect(hashSnapshot(await snapshotAccessibility(page))).not.toBe(base);
  });
});

/**
 * A login form with a "show password" button, as sites build it: the button
 * switches the field's `type` between `password` and `text`.
 */
function loginPage(name: string, id: string): string {
  return `<!doctype html><title>Login</title>
    <label>Your code <input type="password" name="${name}" id="${id}"></label>
    <button id="show" onclick="
      const f = document.getElementById('${id}');
      f.type = f.type === 'password' ? 'text' : 'password';
    ">Show</button>
    <button id="rerender" onclick="
      const old = document.getElementById('${id}');
      const next = document.createElement('input');
      next.type = 'text'; next.name = old.name; next.id = old.id;
      next.value = old.value;
      old.replaceWith(next);
    ">Rerender</button>
    <button id="move" onclick="
      const f = document.getElementById('${id}');
      f.remove(); document.body.append(f);
    ">Move</button>
    <shadow-login></shadow-login>
    <script>
      customElements.define("shadow-login", class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML =
            '<label>Inner <input type="password" id="inner"></label>';
        }
      });
    </script>`;
}

describe("snapshotAccessibility: show-password fields", () => {
  let server: Server;
  let origin: string;
  let html = "";

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });

  async function open(
    page: string,
    remember: boolean,
  ): Promise<{ readonly context: BrowserContext; readonly tab: Page }> {
    html = page;
    const context = await browser.newContext();
    if (remember) await context.addInitScript(rememberPasswordFields);
    const tab = await context.newPage();
    await tab.goto(origin);
    return { context, tab };
  }

  async function textOf(tab: Page): Promise<string> {
    return JSON.stringify(await snapshotAccessibility(tab));
  }

  it("finds that a switched field prints its value in clear", async () => {
    const { context, tab } = await open(loginPage("code", "code"), false);
    await tab.fill("#code", "shown-secret-1");
    await tab.click("#show");
    expect(await tab.locator("#code").getAttribute("type")).toBe("text");
    expect(await tab.locator("body").ariaSnapshot()).toContain(
      "shown-secret-1",
    );
    await context.close();
  });

  it("blanks a switched field whose name says password, with no init script", async () => {
    const { context, tab } = await open(loginPage("password", "code"), false);
    await tab.fill("#code", "shown-secret-2");
    await tab.click("#show");
    expect(await textOf(tab)).not.toContain("shown-secret-2");
    await context.close();
  });

  it("blanks a switched field whose id names a secret, with no init script", async () => {
    const { context, tab } = await open(
      loginPage("code", "user-passcode"),
      false,
    );
    await tab.fill("#user-passcode", "shown-secret-3");
    await tab.click("#show");
    expect(await textOf(tab)).not.toContain("shown-secret-3");
    await context.close();
  });

  it("misses a switched field with a neutral name and id, with no init script", async () => {
    // The gap DESIGN.md §6 states: nothing on the page says it is secret.
    const { context, tab } = await open(loginPage("code", "code"), false);
    await tab.fill("#code", "shown-secret-4");
    await tab.click("#show");
    expect(await textOf(tab)).toContain("shown-secret-4");
    await context.close();
  });

  it("blanks a switched field with a neutral name and id, with the init script", async () => {
    const { context, tab } = await open(loginPage("code", "code"), true);
    await tab.fill("#code", "shown-secret-5");
    await tab.click("#show");
    const tree = await snapshotAccessibility(tab);
    expect(JSON.stringify(tree)).not.toContain("shown-secret-5");
    expect(tree.children).toContainEqual({
      role: "textbox",
      name: "Your code",
      value: REDACTED,
    });
    await context.close();
  });

  it("keeps blanking it when the type is toggled back and forth", async () => {
    const { context, tab } = await open(loginPage("code", "code"), true);
    await tab.fill("#code", "shown-secret-6");
    for (let toggle = 0; toggle < 5; toggle += 1) {
      await tab.click("#show");
      expect(await textOf(tab)).not.toContain("shown-secret-6");
    }
    await context.close();
  });

  it("keeps blanking it when the field is moved or re-rendered", async () => {
    const { context, tab } = await open(loginPage("code", "code"), true);
    await tab.fill("#code", "shown-secret-7");
    await tab.click("#show");
    await tab.click("#move");
    expect(await textOf(tab)).not.toContain("shown-secret-7");
    await tab.click("#rerender");
    expect(await tab.locator("#code").getAttribute("type")).toBe("text");
    expect(await textOf(tab)).not.toContain("shown-secret-7");
    await context.close();
  });

  it("remembers a password field inside an open shadow root", async () => {
    const { context, tab } = await open(loginPage("code", "code"), true);
    const inner = tab.locator("shadow-login #inner");
    await inner.fill("shadow-shown-8");
    await inner.evaluate((field) => {
      (field as HTMLInputElement).type = "text";
    });
    expect(await textOf(tab)).not.toContain("shadow-shown-8");
    await context.close();
  });

  it("remembers a password field in a shadow root attached after load", async () => {
    const { context, tab } = await open("<!doctype html><p>Late</p>", true);
    await tab.evaluate(async () => {
      const host = document.createElement("late-login");
      document.body.append(host);
      // Let the observer see the host before it has a shadow root.
      await new Promise((resolve) => setTimeout(resolve, 20));
      customElements.define(
        "late-login",
        class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: "open" });
            root.innerHTML = '<label>Late <input type="password"></label>';
          }
        },
      );
    });
    const inner = tab.locator("late-login input");
    await inner.fill("late-shown-11");
    await inner.evaluate((field) => {
      (field as HTMLInputElement).type = "text";
    });
    expect(await textOf(tab)).not.toContain("late-shown-11");
    await context.close();
  });

  it("remembers a field switched in the same task it was added", async () => {
    const { context, tab } = await open("<!doctype html><p>Empty</p>", true);
    await tab.evaluate(() => {
      const field = document.createElement("input");
      field.type = "password";
      field.value = "same-task-9";
      field.setAttribute("aria-label", "Code");
      document.body.append(field);
      field.type = "text";
    });
    expect(await textOf(tab)).not.toContain("same-task-9");
    await context.close();
  });

  it("is not blinded by a page that patches Symbol.for", async () => {
    const { context, tab } = await open(
      `<!doctype html><label>Pass <input id="a" type="password"></label>
      <button>show</button>
      <script>
        const original = Symbol.for;
        Symbol.for = (key) =>
          key === "jevy.passwordFields" ? Symbol("x") : original(key);
        document.querySelector("button").onclick = () => { a.type = "text"; };
      </script>`,
      true,
    );
    await tab.fill("#a", "tamper-for-12");
    await tab.click("button");
    expect(await textOf(tab)).not.toContain("tamper-for-12");
    await context.close();
  });

  it("is not blinded by a page that patches getAttribute and re-renders", async () => {
    const { context, tab } = await open(
      `<!doctype html><label>Pass <input id="a" name="pw" type="password"></label>
      <button>show</button>
      <script>
        const get = Element.prototype.getAttribute;
        Element.prototype.getAttribute = function (name) {
          return ["name", "id", "autocomplete"].includes(name)
            ? null
            : get.call(this, name);
        };
        document.querySelector("button").onclick = () => {
          a.type = "text";
          const copy = a.cloneNode();
          copy.value = a.value;
          a.replaceWith(copy);
        };
      </script>`,
      true,
    );
    await tab.fill("#a", "tamper-attr-13");
    await tab.click("button");
    expect(await textOf(tab)).not.toContain("tamper-attr-13");
    await context.close();
  });

  it("throws rather than trust a record that cannot be read", async () => {
    // Without the init script a page can plant a record itself. It can only
    // add fields to blank; a record that fails stops the snapshot.
    const { context, tab } = await open(
      `<!doctype html><script>
        Object.defineProperty(location, "jevy.passwordFields", {
          value: { read() { throw new Error("no"); } },
        });
      </script><p>Hi</p>`,
      false,
    );
    await expect(snapshotAccessibility(tab)).rejects.toBeInstanceOf(
      RedactionError,
    );
    await context.close();
  });

  it("still catches a re-rendered field after many other password fields come and go", async () => {
    const { context, tab } = await open(loginPage("code", "code"), true);
    await tab.fill("#code", "flood-shown-14");
    await tab.evaluate(async () => {
      const box = document.createElement("div");
      document.body.append(box);
      for (let round = 0; round < 20; round += 1) {
        let html = "";
        for (let index = 0; index < 100; index += 1) {
          const tag = `${String(round)}-${String(index)}`;
          html += `<input type="password" id="f-${tag}" name="n-${tag}">`;
        }
        box.innerHTML = html;
        await new Promise((resolve) => setTimeout(resolve, 0));
        box.innerHTML = "";
      }
    });
    await tab.click("#show");
    await tab.click("#rerender");
    expect(await tab.locator("#code").getAttribute("type")).toBe("text");
    expect(await textOf(tab)).not.toContain("flood-shown-14");
    await context.close();
  });

  it("leaves the page's markup, its window globals and the field's type as they are without it", async () => {
    const page = loginPage("code", "code");
    const read = async (remember: boolean): Promise<unknown> => {
      const { context, tab } = await open(page, remember);
      await tab.fill("#code", "x");
      await tab.click("#show");
      const seen = await tab.evaluate(() => ({
        html: document.documentElement.outerHTML,
        keys: Object.getOwnPropertyNames(window).sort(),
        type: (document.getElementById("code") as HTMLInputElement).type,
      }));
      await context.close();
      return seen;
    };
    expect(await read(true)).toEqual(await read(false));
  });

  it("can be installed twice", async () => {
    html = loginPage("code", "code");
    const context = await browser.newContext();
    await context.addInitScript(rememberPasswordFields);
    await context.addInitScript(rememberPasswordFields);
    const tab = await context.newPage();
    await tab.goto(origin);
    await tab.fill("#code", "twice-10");
    await tab.click("#show");
    expect(await textOf(tab)).not.toContain("twice-10");
    await context.close();
  });
});
