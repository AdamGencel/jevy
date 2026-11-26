import { describe, expect, it } from "vitest";
import {
  canonicalSnapshot,
  normaliseSnapshot,
  reduceUrl,
} from "./normalise.js";
import type { AccessibilityNode } from "./snapshot.js";

describe("reduceUrl", () => {
  const cases: readonly [string, string, string][] = [
    [
      "drops the query string and the fragment",
      "https://shop.example/pay?session=abc123#top",
      "https://shop.example/pay",
    ],
    ["keeps a relative path relative", "/pay?token=abc", "/pay"],
    ["keeps a bare relative path", "pay/confirm#step-2", "pay/confirm"],
    ["reduces a query-only link to nothing", "?page=2", ""],
    ["reduces a fragment-only link to nothing", "#main", ""],
    [
      "keeps a protocol-relative host",
      "//cdn.example/app.js?v=1",
      "//cdn.example/app.js",
    ],
    [
      "drops credentials in the authority",
      "https://ada:hunter2@shop.example/account",
      "https://shop.example/account",
    ],
    [
      "drops credentials in a protocol-relative authority",
      "//ada@cdn.example/a",
      "//cdn.example/a",
    ],
    [
      "keeps an @ in the path",
      "https://social.example/u/@ada",
      "https://social.example/u/@ada",
    ],
    [
      "lowercases the scheme and the host but not the path",
      "HTTPS://Shop.Example/Pay",
      "https://shop.example/Pay",
    ],
    [
      "reduces a javascript: URL to its scheme",
      "javascript:alert(document.cookie)",
      "javascript:",
    ],
    [
      "sees through case and leading space",
      "  JavaScript:void(0)",
      "javascript:",
    ],
    [
      "sees through a tab or newline inside the scheme",
      "java\tscr\nipt:alert(1)",
      "javascript:",
    ],
    [
      "sees through a leading control character",
      "\u0001javascript:alert(1)",
      "javascript:",
    ],
    [
      "sees through full-width letters",
      "ｊａｖａｓｃｒｉｐｔ:alert(1)",
      "javascript:",
    ],
    [
      "reduces a data: URL to its scheme",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:",
    ],
    [
      "reduces a mailto: URL to its scheme",
      "mailto:ada@example.com?subject=Hi",
      "mailto:",
    ],
    ["reduces a tel: URL to its scheme", "tel:+441234567890", "tel:"],
    [
      "reads a backslashed authority as a browser does",
      "https:\\\\evil.example\\path",
      "https://evil.example/path",
    ],
    [
      "keeps a malformed host as text",
      "https://[::1/pay?x=1",
      "https://[::1/pay",
    ],
    [
      "keeps spaces as collapsed text",
      "http://shop.example/my   order?q",
      "http://shop.example/my order",
    ],
    ["keeps a colon later in a relative path", "/a:b?c", "/a:b"],
    [
      "reads an authority after any run of slashes",
      "https:////cdn.example/a",
      "https://cdn.example/a",
    ],
    [
      "reads an authority with no slashes",
      "https:cdn.example/a",
      "https://cdn.example/a",
    ],
    [
      "reads a backslashed protocol-relative authority",
      "\\\\cdn.example\\a",
      "//cdn.example/a",
    ],
    [
      "ignores a tab between the slashes",
      "/\t/cdn.example/a",
      "//cdn.example/a",
    ],
    [
      "ignores a newline inside the scheme and the authority",
      "ht\ntps://cdn.ex\nample/a",
      "https://cdn.example/a",
    ],
    [
      "turns backslashes in a relative path into slashes",
      "pay\\confirm",
      "pay/confirm",
    ],
    [
      "reduces a javascript: URL with slashes to its scheme",
      "javascript://x%0Aalert(1)",
      "javascript:",
    ],
    [
      "reduces a data: URL with slashes to its scheme",
      "data://text/html,<b>hi</b>",
      "data:",
    ],
    [
      "reduces a blob: URL to its scheme",
      "blob:https://shop.example/550e8400",
      "blob:",
    ],
    [
      "reduces an intent: URL to its scheme",
      "intent://scan/#Intent;scheme=zxing;end",
      "intent:",
    ],
    [
      "keeps the path of a ws: URL",
      "wss://live.example/feed?t=1",
      "wss://live.example/feed",
    ],
    [
      "keeps the path of an ftp: URL",
      "ftp://ada:pw@files.example/pub",
      "ftp://files.example/pub",
    ],
    [
      "keeps a file: URL's path",
      "file:///srv/report.pdf",
      "file:///srv/report.pdf",
    ],
    [
      "keeps a file: URL's host",
      "file:\\\\Server\\share\\a.txt",
      "file://server/share/a.txt",
    ],
    [
      "gives a file: URL with no slashes a path",
      "file:report.pdf",
      "file:///report.pdf",
    ],
    [
      "drops a matrix parameter",
      "https://shop.example/app;jsessionid=A1B2C3D4E5F6G7H8",
      "https://shop.example/app",
    ],
    ["drops matrix parameters from every segment", "/a;x=1/b;y=2/c", "/a/b/c"],
    [
      "drops the value of a name=value segment",
      "https://shop.example/api/key=AbCdEf123456;",
      "https://shop.example/api/key=",
    ],
    [
      "reduces a URL whose credentials hold a ? to its scheme",
      "https://user:pa?ss@host.example/",
      "https:",
    ],
    [
      "reduces a URL whose credentials hold a # to its scheme",
      "https://user:pa#ss@host.example/",
      "https:",
    ],
    [
      "reduces a URL whose port is not a number to its scheme",
      "https://user:pa/ss@host.example/",
      "https:",
    ],
    ["reduces a URL with an empty host to its scheme", "https://@/x", "https:"],
    [
      "keeps a bracketed IPv6 host and its port",
      "https://ada:pw@[::1]:8080/x",
      "https://[::1]:8080/x",
    ],
    [
      "keeps an @ in the query out of the host",
      "https://shop.example/a?next=b@evil.example",
      "https://shop.example/a",
    ],
    [
      "keeps a trailing slash, a default port and percent-encoding as written",
      "https://shop.example:443/%7ea/",
      "https://shop.example:443/%7ea/",
    ],
  ];

  for (const [title, input, expected] of cases) {
    it(title, () => {
      expect(reduceUrl(input)).toBe(expected);
    });
  }

  it("finds the same host and path as a browser's URL parser", () => {
    const inputs = [
      "https:///admin:hunter2@intranet/x",
      "https://\\admin:hunter2@10.0.0.1/x",
      "https:////admin:hunter2@intranet/x",
      "///admin:hunter2@intranet/x",
      "\\\\admin:hunter2@10.0.0.1/x",
      "/\t/admin:hunter2@10.0.0.1/x",
      "/\n/admin:hunter2@10.0.0.1/x",
      "https:\\\\admin:hunter2@good.example/x",
      "https:/\\admin:hunter2@good.example/x",
      "https:admin:hunter2@good.example/x",
      "ht\ttps://admin:hunter2@good.example/x",
      "https:\\\\good.example\\pay",
      "HTTPS://Shop.Example/Pay",
      "wss://ada:pw@Live.Example/feed",
      "https://ada:pw@[::1]:8080/x",
    ];
    for (const input of inputs) {
      // A base whose scheme differs, so `https:host` is read as absolute.
      const parsed = new URL(input, "ws://base.invalid/");
      const relative = /^[\s/\\]/.test(input);
      const browser = `${relative ? "" : parsed.protocol}//${parsed.host}${parsed.pathname}`;
      expect(reduceUrl(input), JSON.stringify(input)).toBe(browser);
    }
  });

  it("keeps the host of a backslashed or slashless authority", () => {
    const good = reduceUrl("https:\\\\good.example\\pay");
    const evil = reduceUrl("https:\\\\evil.example\\pay");
    expect(good).not.toBe(evil);
    expect(good).toBe(reduceUrl("https://good.example/pay"));
    expect(reduceUrl("https:good.example/pay")).toBe(good);
    expect(reduceUrl("https:evil.example/pay")).toBe(evil);
  });

  it("is idempotent", () => {
    for (const [, input] of cases) {
      const once = reduceUrl(input);
      expect(reduceUrl(once)).toBe(once);
    }
  });
});

describe("normalising a link's URL", () => {
  it("reduces the URL and applies the text rules to it", () => {
    const tree = normaliseSnapshot({
      role: "link",
      name: "Order",
      url: "https://shop.example/orders/123456789/550e8400-e29b-41d4-a716-446655440000?x=1",
    });
    expect(tree.url).toBe("https://shop.example/orders/[num]/[id]");
  });

  it("drops a URL that reduces to nothing", () => {
    const tree = normaliseSnapshot({
      role: "link",
      name: "Next",
      url: "?page=2",
    });
    expect(tree).toEqual({ role: "link", name: "Next" });
  });

  it("reduces again after a project placeholder", () => {
    const tree = normaliseSnapshot(
      { role: "link", name: "Pay", url: "/pay" },
      { replace: [{ pattern: /pay/, placeholder: "p?ay" }] },
    );
    expect(tree.url).toBe("/p");
  });

  it("keeps an unnamed generic that carries a URL", () => {
    const tree = normaliseSnapshot({
      role: "main",
      children: [{ role: "generic", url: "/home" }],
    });
    expect(tree.children).toEqual([{ role: "generic", url: "/home" }]);
  });

  it("puts the URL in the canonical form after the name", () => {
    const node: AccessibilityNode = {
      role: "link",
      url: "/terms",
      description: "Opens in a new tab",
      name: "Terms",
    };
    expect(JSON.stringify(canonicalSnapshot(node))).toBe(
      '{"role":"link","name":"Terms","url":"/terms","description":"Opens in a new tab"}',
    );
  });

  it("leaves the canonical form of a tree without URLs unchanged", () => {
    expect(
      JSON.stringify(canonicalSnapshot({ role: "button", name: "Pay" })),
    ).toBe('{"role":"button","name":"Pay"}');
  });
});
