# Spike: the snapshot source (Step 1d)

This is a dated finding (18 Nov 2026), kept as evidence. The current design is in [DESIGN.md §6](../DESIGN.md#6-built-the-snapshot-bridge-jevyjsplaywright). Of the recommendations in section 8, number 3 is done (core exports `SECRET_AUTOCOMPLETE_TOKENS` and the bridge uses it), 1 and 6 are adopted in the docs, 2 and 4 are carried into roadmap step 2, and 5 is open.

Status: done. Playwright 1.63.0, Chromium 1243 (headless), Node 22. Every output below was printed by that browser for the HTML shown, with `page.setContent`. Older versions were checked only by reading the type declarations and bundled source of `playwright-core` 1.48 to 1.62 from npm; no older browser was run.

Code: `packages/playwright/src/parse.ts` (`parseAriaSnapshot`), `secrets.ts`, `snapshot.ts` (`snapshotAccessibility`). Tests: `packages/playwright/src/*.test.ts`.

## Summary

- `page.accessibility` is gone. The public sources are `locator.ariaSnapshot()` (since 1.49), `page.ariaSnapshot()` (since 1.59) and, new in 1.63, `ariaSnapshotJSON()`, which returns the same tree as plain JSON. None of them needs CDP.
- The aria snapshot carries role, name, `checked`, `pressed`, `disabled`, `expanded` (true only), `selected` (true only), `level`, `invalid`, and the value of `<input>` and `<textarea>`. It never carries `description`, `required`, `readonly`, `modal`, `multiline`, `multiselectable`, `orientation`, `keyshortcuts`, `roledescription`, `haspopup`, `autocomplete`, `valuetext`, `valuemin` or `valuemax`. `focused` appears only in `mode: "ai"`.
- **Security:** the typed value of `<input type="password">` is printed in clear, and so is every `one-time-code`, `cc-number`, `cc-csc`, `current-password` and `new-password` field. The snapshot drops `type` and `autocomplete`, so core's secret-field check sees only the label. A password field labelled "PIN" or "Current" goes to core with its value. `snapshotAccessibility` therefore reads secret fields from the DOM in the same step and blanks their values everywhere in the tree.
- The YAML is deterministic for a static page, and focus changes do not alter it in the default mode.
- Core's canonical JSON is 1.3 to 2.5 times the size of the YAML for the same page.

## 1. Which APIs exist in 1.63

From `playwright-core/types/types.d.ts` 1.63.0:

| API | Returns | Options |
|---|---|---|
| `locator.ariaSnapshot(options?)` | YAML string | `mode?: "ai" \| "default"`, `depth?: number`, `boxes?: boolean`, `timeout`, `signal` |
| `page.ariaSnapshot(options?)` | YAML string of `body` | same |
| `locator.ariaSnapshotJSON(options?)` / `page.ariaSnapshotJSON(options?)` | `Serializable` (array of nodes) | same |

- `mode: "ai"` adds `[ref=eN]` to elements that receive pointer events, `[cursor=pointer]`, `[active]` on the focused element, includes generic containers, marks `aria-hidden` subtrees that are visible (`[aria-hidden]`) instead of dropping them, and inlines iframe content. It throws instead of waiting when a locator matches nothing.
- `depth` cuts the tree silently: with `depth: 2`, `<li>a<ul>…</ul></li>` prints as a bare `- listitem` with no text.
- `boxes: true` appends `[box=x,y,width,height]`.
- Version history, from the published type declarations: `locator.ariaSnapshot` first appears in 1.49 (absent in 1.48). `page.ariaSnapshot`, `mode` and `depth` first appear in 1.59; `boxes` in 1.60; `ariaSnapshotJSON` in 1.63. The input-value rendering (`children = [element.value]`) is present in the 1.49 bundle, so passwords have been printed in clear since the API exists.
- `page.ariaSnapshot()` is implemented as the snapshot of `body,frameset` in the main frame. `page.locator("body").ariaSnapshot()` returns the identical string (tested), and that form works from 1.49.

**Structured form without CDP:** yes, `ariaSnapshotJSON()` in 1.63 only. It is the same tree, not a richer one: its node properties are `role`, `name`, `text`, `children`, `checked`, `disabled`, `expanded`, `active` (ai only), `invalid`, `level`, `pressed`, `selected`, `url`, `placeholder`, `ariaHidden`, `ref`, `cursor`, `box`. Chromium's CDP `Accessibility.getFullAXTree` would give the missing ARIA properties, but it is Chromium-only and not public Playwright API, so it was not used.

```html
<a href="/home">Home</a>
<label>Email <input placeholder="you@x.test"></label>
<label>PIN <input type="password" value="4321"></label>
```

```json
[{"role":"link","name":"Home","url":"/home"},{"role":"text","text":"Email"},{"role":"textbox","name":"Email","placeholder":"you@x.test"},{"role":"text","text":"PIN"},{"role":"textbox","name":"PIN","text":"4321"}]
```

The same page as YAML:

```yaml
- link "Home":
  - /url: /home
- text: Email
- textbox "Email":
  - /placeholder: you@x.test
- text: PIN
- textbox "PIN": "4321"
```

## 2. Which `AccessibilityNode` fields can be recovered

Form fixture (values typed with `page.fill` afterwards: PIN `4321`, Code `998877`, Card `4111111111111111`, CVC `123`, Current `hunter2`, New `s3cret  pass`; the second checkbox set to `indeterminate`):

```html
<form>
  <label>Email <input type="email" value="a@b.co" required></label>
  <label>PIN <input type="password" id="pin"></label>
  <label>Code <input autocomplete="one-time-code" id="otp"></label>
  <label>Card <input autocomplete="cc-number" id="cc"></label>
  <label>CVC <input autocomplete="cc-csc" id="csc"></label>
  <label>Current <input type="password" autocomplete="current-password" id="cur"></label>
  <label>New <input type="password" autocomplete="new-password" id="new"></label>
  <label><input type="checkbox" checked> Terms</label>
  <label><input type="checkbox" id="mixed"> Some</label>
  <label><input type="radio" name="r" checked> A</label><label><input type="radio" name="r"> B</label>
  <label>Country <select><option>NL</option><option selected>UK</option></select></label>
  <label>Notes <textarea readonly>hello</textarea></label>
  <button disabled>Pay</button>
  <input type="search" aria-label="Find" value="q">
  <input type="number" aria-label="Qty" value="3" min="1" max="9">
  <input type="range" aria-label="Vol" value="30">
  <input aria-label="Bad" aria-invalid="true" placeholder="type here" aria-describedby="d"><span id="d">help text</span>
  <div role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Pick">x</div>
  <button aria-pressed="true">Bold</button><button aria-expanded="true" aria-haspopup="menu" aria-keyshortcuts="Alt+M" aria-roledescription="fancy">Menu</button>
  <input aria-label="Ro" readonly value="r">
</form>
```

`page.ariaSnapshot()`:

```yaml
- text: Email
- textbox "Email": a@b.co
- text: PIN
- textbox "PIN": "4321"
- text: Code
- textbox "Code": "998877"
- text: Card
- textbox "Card": "4111111111111111"
- text: CVC
- textbox "CVC": "123"
- text: Current
- textbox "Current": hunter2
- text: New
- textbox "New": s3cret pass
- checkbox "Terms" [checked]
- text: Terms
- checkbox "Some" [checked=mixed]
- text: Some
- radio "A" [checked]
- text: A
- radio "B"
- text: B Country
- combobox "Country":
  - option "NL"
  - option "UK" [selected]
- text: Notes
- textbox "Notes": hello
- button "Pay" [disabled]
- searchbox "Find": q
- spinbutton "Qty": "3"
- slider "Vol": "30"
- textbox "Bad" [invalid]:
  - /placeholder: type here
- text: help text
- combobox "Pick": x
- button "Bold" [pressed]
- button "Menu" [expanded]
- textbox "Ro": r
```

A second fixture for ARIA-only states:

```html
<div role="checkbox" aria-checked="false" aria-required="true" aria-readonly="true" aria-label="ariabox"></div>
<div role="treeitem" aria-expanded="false" aria-level="3" aria-label="node"></div>
<div role="textbox" aria-multiline="true" aria-label="ml"></div>
<div role="switch" aria-checked="true" aria-label="sw"></div>
<div role="menuitemcheckbox" aria-checked="mixed" aria-label="mic"></div>
<div role="option" aria-selected="true" aria-disabled="true">opt</div>
<input aria-label="gram" aria-invalid="grammar">
<div role="separator" aria-orientation="vertical"></div>
<div role="scrollbar" aria-valuenow="5" aria-controls="x" aria-label="sb"></div>
<div role="progressbar" aria-valuenow="40" aria-valuemin="0" aria-valuemax="100" aria-valuetext="40 percent" aria-label="Upload"></div>
<div role="dialog" aria-modal="true" aria-labelledby="dt"><h2 id="dt">Confirm</h2><button>OK</button></div>
<div contenteditable="true" role="textbox" aria-label="Rich">rich text</div>
```

```yaml
- checkbox "ariabox"
- treeitem "node" [level=3]
- textbox "ml"
- switch "sw" [checked]
- menuitemcheckbox "mic" [checked=mixed]
- option "opt" [disabled] [selected]
- textbox "gram" [invalid=grammar]
- separator
- scrollbar "sb"
- progressbar "Upload"
- dialog "Confirm":
  - heading "Confirm" [level=2]
  - button "OK"
- textbox "Rich"
```

| Field | From the YAML? | Evidence and mapping |
|---|---|---|
| `role` | yes | key head. `text:` entries become `{ role: "text", name }`. |
| `name` | yes, except names over 900 characters | quoted JSON string, or `/…/` unquoted when the name itself starts and ends with `/`. A 901-character button name printed as `- button`, no name. |
| `value` | for `<input>`/`<textarea>` only | inline text after the colon; under `- /placeholder:` it is a `- text:` child. Always a string (`"3"`). Never for ARIA widgets (`progressbar`, `scrollbar` with `aria-valuenow`), never for `contenteditable` (Playwright skips text inside a `textbox`). `<select>` has no value; the selected `option` is `[selected]`. |
| `checked` | yes | `[checked]`, `[checked=mixed]`. `false` is not printed. |
| `pressed` | yes | `[pressed]`, `[pressed=mixed]`. |
| `disabled` | yes | `[disabled]`. |
| `expanded` | true only | `aria-expanded="false"` prints nothing, the same as no attribute. |
| `selected` | true only | `[selected]`. |
| `level` | yes | `[level=N]` on headings and tree items. |
| `invalid` | yes | `[invalid]`, `[invalid=grammar]`, `[invalid=spelling]`; mapped to `"true"`, `"grammar"`, `"spelling"`. |
| `focused` | `mode: "ai"` only | `[active]`. Default mode never prints it. |
| `description` | **never** | `aria-describedby` text is not printed as a description (the describing span shows up as its own `text:` node). |
| `required` | **never** | `required` / `aria-required` |
| `readonly` | **never** | `readonly` / `aria-readonly` |
| `modal` | **never** | `aria-modal="true"` dialog printed without it |
| `multiline` | **never** | `aria-multiline` |
| `multiselectable` | **never** | |
| `orientation` | **never** | `aria-orientation` |
| `keyshortcuts` | **never** | `aria-keyshortcuts` |
| `roledescription` | **never** | `aria-roledescription` |
| `haspopup` | **never** | `aria-haspopup` |
| `autocomplete` | **never** | see section 4 |
| `valuetext`, `valuemin`, `valuemax` | **never** | `aria-valuetext`, `min`, `max`, `aria-valuemin/max` |

Note for core's hash rules (DESIGN 12.3): `required`, `readonly`, `modal`, `valuemin` and `valuemax` are in the hash allow-list, but from this source they are always absent, so a change to them never changes the hash. `expanded: false` and `selected: false` are indistinguishable from absent, which is what core already assumes for a missing flag. The parser omits any explicit `=false` so that `[checked=false]` and no attribute hash the same.

## 3. What the YAML has that core's type has no place for

| YAML | Example | What `parseAriaSnapshot` does |
|---|---|---|
| link target | `- /url: /about?x=1#y` | dropped |
| placeholder | `- /placeholder: type here` (only on `textbox`, and only when it differs from the name) | dropped |
| text nodes | `- text: Shipped`, inline `- paragraph: Plain paragraph` | `{ role: "text", name }` child |
| inline formatting | `- strong: today`, `- emphasis: post` (roles of `<strong>`, `<em>`) | ordinary nodes |
| refs | `[ref=e12]`, `[ref=f1e2]` in iframes | dropped (they change between pages) |
| `[cursor=pointer]`, `[box=…]` | ai mode, `boxes: true` | dropped |
| `[aria-hidden]` | ai mode | node and subtree dropped, as they are not in the accessibility tree |

Content fixture:

```html
<header><nav aria-label="Main"><ul><li><a href="/">Home</a></li><li><a href="/about?x=1#y">About us</a></li></ul></nav></header>
<main>
  <h1>Order confirmed</h1>
  <h2 aria-describedby="sub">Details</h2><p id="sub">Shipped <strong>today</strong> by <em>post</em>.</p>
  <ol><li>One</li><li>Two <a href="https://example.test/t">link</a></li></ol>
  <table><caption>Items</caption><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Pen</td><td>2</td></tr></tbody></table>
  <img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo">
  <details open><summary>More</summary>Hidden text</details>
  <div role="tablist" aria-orientation="vertical"><div role="tab" aria-selected="true">T1</div><div role="tab" aria-selected="false">T2</div></div>
</main>
```

```yaml
- banner:
  - navigation "Main":
    - list:
      - listitem:
        - link "Home":
          - /url: /
      - listitem:
        - link "About us":
          - /url: /about?x=1#y
- main:
  - heading "Order confirmed" [level=1]
  - heading "Details" [level=2]
  - paragraph:
    - text: Shipped
    - strong: today
    - text: by
    - emphasis: post
    - text: .
  - list:
    - listitem: One
    - listitem:
      - text: Two
      - link "link":
        - /url: https://example.test/t
  - table "Items":
    - caption: Items
    - rowgroup:
      - row "Item Qty":
        - columnheader "Item"
        - columnheader "Qty"
    - rowgroup:
      - row "Pen 2":
        - cell "Pen"
        - cell "2"
  - img "Logo"
  - group: More Hidden text
  - tablist:
    - tab "T1" [selected]
    - tab "T2"
```

Text from neighbouring inline elements is merged and whitespace-collapsed (`- text: B Country` joins two labels). URLs can carry session tokens in query strings, which is a reason to keep dropping them until core has a rule for them (section 8).

### Quoting

Playwright builds the key as `role + " " + JSON.stringify(name) + attributes`, then single-quotes the whole key for YAML when it needs it (`'` doubled). A name that starts and ends with `/` is printed unquoted, so it reads like a regular expression but is literal text. A lone `/` (a breadcrumb separator, `<button>/</button>`) counts: it prints as `- button /`. Values are YAML double-quoted with `\"`, `\\`, `\n`, `\t`, `\xNN` escapes when they would otherwise be read as something else (numbers, `yes`, `true`, `null`, a leading `-`, `#`, `: `).

```html
<button>Say "hi"</button> <button>it's</button> <button>a: b</button> <button>[x] box</button>
<button>tag #1</button> <button>- dash</button> <button>/regex/</button> <button>Zürich 東京 🎉</button>
<button>back\slash</button> <button>123</button> <button>{brace}</button> <button>multi
line</button> <p>value: colon text</p> <p>"quoted text"</p> <p>42</p>
<input aria-label="v1" value='He said "x": y'> <input aria-label="v4" value="">
<a href="/p?q=a: b#frag">a link</a>
```

```yaml
- button "Say \"hi\""
- button "it's"
- 'button "a: b"'
- button "[x] box"
- 'button "tag #1"'
- button "- dash"
- button /regex/
- button "Zürich 東京 🎉"
- button "back\\slash"
- button "123"
- 'button "{brace}"'
- button "multi line"
- paragraph: "value: colon text"
- paragraph: "\"quoted text\""
- paragraph: "42"
- textbox "v1": "He said \"x\": y"
- textbox "v4"
- link "a link":
  - /url: "/p?q=a: b#frag"
```

(An excerpt of a larger fixture; each output line belongs to the element in the same position. `parse.test.ts` holds every quoted key and value from the full run.)

Some values are not quoted although a YAML 1.2 core-schema parser would change them: `<p>~</p><p>.inf</p><p>.nan</p>` prints as `- paragraph: ~`, `- paragraph: .inf`, `- paragraph: .nan`, which a core-schema parser reads as null, Infinity and NaN. `parseAriaSnapshot` therefore parses with the `yaml` package's failsafe schema, where every scalar is a string, and parses the key with its own small grammar (role, JSON name or `/…/` name, `[attr]` / `[attr=value]`). The YAML structure itself is left to the `yaml` package rather than a hand-written parser because Playwright's own template parser uses the same package and the quoting rules above are YAML's.

## 4. Security: secret fields

From the form fixture in section 2, the default YAML contains:

```yaml
- textbox "PIN": "4321"                          # type=password
- textbox "Code": "998877"                       # autocomplete=one-time-code
- textbox "Card": "4111111111111111"             # autocomplete=cc-number
- textbox "CVC": "123"                           # autocomplete=cc-csc
- textbox "Current": hunter2                     # type=password autocomplete=current-password
- textbox "New": s3cret pass                     # type=password autocomplete=new-password, typed "s3cret  pass"
```

`mode: "ai"` prints the same values. `ariaSnapshotJSON()` puts them in `text`. The cause is in Playwright's injected script: every `<input>` and `<textarea>` except checkbox, radio and file gets `children = [element.value]`, with no check of `type`. That code is present from 1.49 to 1.63.

Masked? No. Neither `type` nor `autocomplete` appears in the snapshot. A password input is role `textbox`, like any other. Core's `isSecretField` looks at role, name, description and `autocomplete`; from this source it only has the name, and "PIN", "Code", "Card", "CVC", "Current" and "New" do not match its pattern. Without the bridge, core would hash and send all six values. (`hunter2` alone would also escape core's text patterns.)

Other observations:

- Whitespace in the value is normalised as Playwright normalises all text: zero-width space and soft hyphen removed, trimmed, runs of whitespace collapsed. `"  a ​ b\t\tc  "` prints as `a b c`.
- A typed value can also reach other nodes: a label that wraps a control takes the control's value into its accessible name, and the page may echo the value as text. For
  `<label>PIN <input type="password" value="8642"></label><p>You typed 8642</p><label><input type="checkbox"> Remember <input type="password" value="8642" aria-label="again"></label>`
  the snapshot is:

  ```yaml
  - text: PIN
  - textbox "PIN": "8642"
  - paragraph: You typed 8642
  - checkbox "Remember 8642"
  - text: Remember
  - textbox "again": "8642"
  ```
- A password field inside an **open** shadow root is printed in clear. One inside a **closed** shadow root is not printed at all.
- A "show password" toggle that switches `type="password"` to `type="text"` makes it an ordinary text field.

**Mechanism chosen.** `snapshotAccessibility(target)` does, for up to three attempts:

1. Read, in the target's frame, the values of every `<input type="password">` and every `<input>`/`<textarea>` whose `autocomplete` holds one of core's secret tokens (`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`; the attribute is split on whitespace, so `billing cc-number` counts). It walks the whole document and every open shadow root, not only the target element, because labels and `aria-owns` pull content from elsewhere.
2. Take `locator.ariaSnapshot()` (`page.locator("body")` for a page).
3. Read the values again. If they differ from step 1, the page changed a secret field during the snapshot: try again. After three failed attempts, throw `RedactionError`.
4. Parse, then replace every occurrence of each value (as typed, whitespace-collapsed, and Playwright-normalised) in every text field of every node with `[REDACTED]`. Longer secrets go first, and a later secret is never matched across or inside an inserted marker, so the result contains none of them.

Why this and not the alternatives:

- Blanking by label (core's current rule) is exactly what fails here.
- Mapping YAML nodes back to elements needs `mode: "ai"` refs and the undocumented `aria-ref=` selector, and changes the snapshot (refs, generic containers, iframes, `[active]`). Value matching works with the default mode and public API only.
- Clearing the fields in the page before the snapshot would change the page under test.

Known limits, stated plainly:

- Substring matching over-redacts: a PIN `42` also blanks "Order 42". That is the safe direction.
- If a page script changes a secret field to a new value and back to the original strictly between the two DOM reads, the intermediate value is not known and would not be blanked. The before/after comparison catches every change that is still in place at the second read.
- A "show password" field switched to `type="text"` is not a password field; it is caught only if its `autocomplete` is a secret token or its label matches core's name pattern.
- The DOM read and the snapshot both skip closed shadow roots, so nothing there leaks or is read.
- The default mode does not descend into iframes (`- iframe`), so only the target's own frame is read. A `Locator` inside a frame (`page.frameLocator(...).getByRole(...)`) is read in that frame; this is tested.

Tests: a password labelled "PIN", all five autocomplete tokens with neutral labels, a value echoed in a paragraph and in a wrapping label, an open shadow root, a textarea, a field inside an iframe reached through a `Locator`, a field with a placeholder, and a page whose secret value keeps changing (`RedactionError`). Removing the scrub step makes ten of the `snapshotAccessibility` tests fail.

## 5. Iframes, shadow DOM, hidden content, long text

```html
<div role="alert">Payment failed: card declined</div>
<div role="status" aria-live="polite">Saved 3 seconds ago</div>
<p>Plain paragraph</p>
<div hidden>display none text</div>
<div style="visibility:hidden">visibility hidden text</div>
<div aria-hidden="true">aria hidden text <button>Hidden btn</button></div>
<div style="position:absolute;left:-9999px">offscreen text</div>
<iframe srcdoc="<button>In frame</button>" title="Frame"></iframe>
<my-el></my-el>  <!-- open shadow root containing <button>Shadow btn</button> -->
```

Default mode:

```yaml
- alert: "Payment failed: card declined"
- status: Saved 3 seconds ago
- paragraph: Plain paragraph
- text: offscreen text
- iframe
- button "Shadow btn"
```

`mode: "ai"`:

```yaml
- generic [active] [ref=e1]:
  - alert [ref=e2]: "Payment failed: card declined"
  - status [ref=e3]: Saved 3 seconds ago
  - paragraph [ref=e4]: Plain paragraph
  - generic [aria-hidden] [ref=e5]:
    - text: aria hidden text
    - button [ref=e6]: Hidden btn
  - generic [ref=e7]: offscreen text
  - iframe [ref=e8]:
    - button "In frame" [ref=f1e2]
  - button "Shadow btn" [ref=e10]
```

- `display: none`, `visibility: hidden` and `aria-hidden` content is left out in the default mode. Off-screen content is kept.
- An iframe is a bare `- iframe` in the default mode: no name (the `title` is ignored) and no content. `mode: "ai"` inlines it.
- Open shadow roots and slotted content are included. Closed shadow roots are not.
- Long text is not truncated: a 3,000-word paragraph printed as one 6,012-character line. A name over 900 characters is dropped entirely (the node prints as a bare role), so two buttons with different long names look the same. Data URLs in `/url` are cut after the comma.

## 6. Determinism

```html
<h1>Static</h1><label>Name <input id="a"></label><button id="b">Go</button><p>text</p>
```

- Two default snapshots of the static page: identical strings.
- After `page.focus("#a")`, and again after `page.focus("#b")`: identical to the first. The default mode never prints `[active]`.
- `mode: "ai"` changes with focus: `button "Go" [active] [ref=e5]` becomes `button "Go" [ref=e5]` and `textbox "Name" [active] [ref=e4]`. Two ai snapshots in the same state were identical; refs are per-page counters, so they are not stable across pages.
- The form and content fixture above (medium page in section 7): identical twice, and identical after focusing the email field.
- End to end, `hashSnapshot(await snapshotAccessibility(page))` is equal across two calls, equal after a timestamp changes and after focus moves, and different after a button is renamed (tested).

## 7. Size

Characters of `page.locator("body").ariaSnapshot()` against `canonicalSnapshotJson(await snapshotAccessibility(page))` for the same page. Normalising first did not change any of the three numbers.

| Page | Contents | YAML | ai-mode YAML | `ariaSnapshotJSON` | core canonical JSON | JSON / YAML | core token estimate |
|---|---|---:|---:|---:|---:|---:|---:|
| small | alert, status, heading, button | 114 | 198 | 197 | 286 | 2.51 | 72 |
| medium | the section 2 form plus the section 3 content page | 1,620 | 2,927 | 2,799 | 2,988 | 1.84 | 747 |
| large | 60-link navigation and a 150-row product table with a button per row | 30,354 | 34,908 | 40,877 | 40,107 | 1.32 | 10,027 |

The YAML of the large page includes 60 `/url` lines that the tree drops; the JSON is still a third bigger. The gap is widest on small pages, where `{"role":…,"name":…}` and `"children":[…]` dominate. Indented JSON (`JSON.stringify(…, null, 2)`) is 4.4 times the YAML on the large page.

## 8. Recommendations

1. **Keep `AccessibilityNode` for the hash, but stop describing it as Playwright's tree.** It is now core's own format, filled by this bridge. Document which fields this source fills (role, name, value, checked, pressed, disabled, expanded, selected, level, invalid, focused in ai mode only) and which it never fills. Either drop `required`, `readonly`, `modal`, `valuemin`, `valuemax` from the hash allow-list or, better, keep them and say in DESIGN 12.3 that a change in them is not detected with the Playwright source. Do not remove the fields from the type: a CDP or other source could still fill them, and removing them is a breaking change for no gain.
2. **Add `url` to the type, behind redaction.** Link targets are relevant (a "Pay" link pointing somewhere else is a real change). Hash only scheme, host and path after redaction, never the query string or fragment, which can carry tokens. Until then the bridge drops `/url`. `placeholder` can stay out: it is presentational.
3. **Export core's secret autocomplete tokens** (e.g. `SECRET_AUTOCOMPLETE_TOKENS`) so the bridge does not keep a copy. The bridge has a test that fails if core stops treating any of its tokens as secret, but a token added to core would not reach the bridge without the export.
4. **Send the decider YAML, rendered by core from the redacted, pruned tree, not JSON and not Playwright's raw YAML.** Concretely: add `renderSnapshotYaml(tree)` to core, producing Playwright's format (`- role "name" [attr]: value`) from the canonical fields only, and make `estimateSnapshotTokens` and the prune budget measure that rendering. Reasons: it is 25 to 60 percent smaller than the canonical JSON on these pages, so the same budget keeps more of the page; it is the format coding agents and Playwright MCP already use, so models read it well; and rendering from core's tree keeps the secret scrub, redaction, normalisation and pruning in the path. Playwright's raw YAML must never be sent: it has passwords, URLs and refs in it. Keep canonical JSON as the hash input, since the hash must not depend on a rendering.
5. **Use `ariaSnapshotJSON()` when the peer is at least 1.63.** It is the same information without YAML parsing. `parseAriaSnapshot` stays for snapshots stored as text (`toMatchAriaSnapshot` files, cached pages). This is optional; the YAML path is tested and works from 1.49.
6. **Peer range.** `@playwright/test >= 1.49.0`: the bridge calls only `locator.ariaSnapshot()`, `page.locator()`, `locator.evaluate()` and `Page.mainFrame` (for type narrowing), all present in 1.49. Only 1.63 was run. If the team prefers to support only tested versions, use `>= 1.63.0`.
7. **Do not use `mode: "ai"` for hashing.** It prints `[active]` (focus changes the snapshot), refs that differ between pages, and generic wrappers. The parser accepts it and drops refs, cursor, box and `aria-hidden` subtrees, but the default mode is the stable source.
