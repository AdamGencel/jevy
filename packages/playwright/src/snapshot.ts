import { RedactionError } from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";
import type { Locator, Page } from "@playwright/test";
import { parseRawAriaSnapshot } from "./parse.js";
import { parsePageReading, scrubSecrets, secretValues } from "./secrets.js";
import type { FieldReading } from "./secrets.js";

/**
 * The property of `location` under which {@link rememberPasswordFields}
 * publishes its record. The init script spells the same literal, because a
 * function that runs in the browser cannot refer to this module.
 *
 * `location` rather than `window`: the DOM read must reach the record
 * without calling anything the page can patch, and `location` is an
 * unforgeable property of the window whose own properties the page cannot
 * redefine once the record is there. A symbol key would need `Symbol.for`,
 * which the page can replace; a string key on `window` would show up among
 * the window's own property names.
 */
const PASSWORD_FIELDS_KEY = "jevy.passwordFields";

/**
 * How often to retry when a secret field changes while the snapshot is
 * taken. A page that keeps changing a password field is not snapshotted.
 */
const MAX_ATTEMPTS = 3;

/**
 * Take the accessibility tree of a page or of one element, in the shape core
 * hashes, redacts and prunes.
 *
 * The source is `locator.ariaSnapshot()` (public API, Playwright 1.49 and
 * later, any browser). That YAML prints the typed value of every input in
 * clear, password fields included, and it drops `type` and `autocomplete`,
 * so core cannot tell a secret field from its accessible name alone.
 *
 * So the values of secret fields are read from the DOM of the same frame, in
 * the same step, before and after the snapshot, including fields inside open
 * shadow roots. A field is secret by `isSecretField`: `<input
 * type="password">`, a secret `autocomplete` token, a text field whose `name`
 * or `id` names a secret, or a field that {@link rememberPasswordFields} saw
 * with `type="password"` before a "show password" button switched it. Every
 * occurrence of those values in the tree is replaced with `[REDACTED]`,
 * whatever the label says. Link urls are scrubbed as printed, before they
 * are reduced, and in every percent-encoded and `+` spelling (see
 * `scrubSecrets`). If the values differ before and after (the page changed
 * them while the snapshot was taken), the step is retried; if they keep
 * changing, `RedactionError` is thrown rather than risking a tree with a
 * secret in it. A reading that comes back malformed throws it too.
 *
 * Closed shadow roots are skipped by both the snapshot and the DOM read.
 * The default snapshot mode is used, which does not descend into iframes,
 * so only the target's own frame is read.
 */
export async function snapshotAccessibility(
  target: Page | Locator,
): Promise<AccessibilityNode> {
  const scope = isPage(target) ? target.locator("body") : target;
  const documentScope = isPage(target) ? target.locator(":root") : target;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const before = await readSecretValues(documentScope);
    const yaml = await scope.ariaSnapshot();
    const after = await readSecretValues(documentScope);
    if (sameValues(before, after)) {
      return scrubSecrets(parseRawAriaSnapshot(yaml), after);
    }
  }
  throw new RedactionError(
    "Secret form fields changed while the accessibility snapshot was taken. " +
      "The snapshot was discarded.",
  );
}

function isPage(target: Page | Locator): target is Page {
  return "mainFrame" in target;
}

async function readSecretValues(scope: Locator): Promise<readonly string[]> {
  const reading: unknown = await scope.evaluate(
    readFields,
    PASSWORD_FIELDS_KEY,
  );
  return secretValues(parsePageReading(reading));
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** What {@link readFields} sends back; checked by `parsePageReading`. */
interface PageReading {
  readonly fields: FieldReading[];
  readonly remembered: unknown;
}

/**
 * Runs in the browser, so it must not refer to anything outside its own body.
 * Walks the whole document of the element's frame, not only the element,
 * because `aria-owns` and labels can pull content in from elsewhere; reading
 * more fields than needed only redacts more.
 *
 * Every input and textarea with a value is returned with the attributes the
 * secret rule needs; the rule itself runs in Node.
 *
 * This walk runs in the page's own JavaScript, after the page's scripts, so
 * it uses whatever `getAttribute`, `value` and `querySelectorAll` the page
 * has left in place: a page that patches those built-ins can hide a field
 * from it. That is why the record of {@link rememberPasswordFields}, when it
 * is installed, is asked as well: it reads every field with built-ins it
 * captured before any page script ran, and says which fields have been
 * password fields. The two readings are joined, so the record can only add
 * fields to blank. The record is reached through `location`, which the page
 * cannot replace. Without the init script the page could plant a record of
 * its own; it too can only add fields, and a record that throws or returns
 * something malformed makes the snapshot fail (`parsePageReading`).
 */
function readFields(element: Element, key: string): PageReading {
  const fields: FieldReading[] = [];
  const roots: (Document | ShadowRoot)[] = [element.ownerDocument];
  for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
    for (const candidate of Array.from(root.querySelectorAll("*"))) {
      if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
      const isInput = candidate.tagName === "INPUT";
      if (!isInput && candidate.tagName !== "TEXTAREA") continue;
      const field = candidate as HTMLInputElement | HTMLTextAreaElement;
      if (field.value === "") continue;
      fields.push({
        tag: isInput ? "input" : "textarea",
        type: field.type,
        value: field.value,
        autocomplete: field.getAttribute("autocomplete") ?? "",
        name: field.getAttribute("name") ?? "",
        id: field.getAttribute("id") ?? "",
        wasPassword: false,
      });
    }
  }
  let remembered: unknown;
  try {
    const record = (location as unknown as Readonly<Record<string, unknown>>)[
      key
    ];
    if (record !== undefined) {
      remembered = (record as { readonly read: () => unknown }).read();
    }
  } catch {
    remembered = "unreadable";
  }
  return { fields, remembered };
}

/**
 * An init script that remembers every input that has had `type="password"`,
 * so a field a "show password" button switched to `type="text"` is still
 * blanked. Install it before the page loads:
 * `await context.addInitScript(rememberPasswordFields)`.
 *
 * It only observes. It sets no attribute, wraps no DOM method, cancels no
 * event and adds no global; its record sits on `location` under a
 * non-enumerable string key, read-only. A `MutationObserver` sees inputs
 * that are added as password fields and every change of `type` away from
 * `password`, with the old value, so a field added and switched in the same
 * task is caught too. It watches the document and every open shadow root it
 * finds: in an added subtree, in a rescan at `DOMContentLoaded` and `load`
 * (custom elements defined by the page's own scripts have attached theirs by
 * then), and around the target of any focus, pointer, key or input event,
 * which is how a person reaches a field before showing its value.
 *
 * It runs before any page script, and captures every built-in it calls
 * (`getAttribute`, the `tagName`, `value` and `type` getters,
 * `querySelectorAll`, the `WeakSet` methods and the rest) at that moment, so
 * a page that patches them later cannot blind it or make its record lie. It
 * still depends on the browser calling the `MutationObserver` callback and
 * the event listeners it registered.
 *
 * A field is remembered as the element itself and by its non-empty `id` and
 * `name`, so a framework that re-renders it as a new `type="text"` element
 * with the same `id` or `name` is still caught. The elements are held weakly.
 * The ids and names are kept for at most 256 fields: past that, the oldest
 * field no longer in the document is forgotten first, so a page that creates
 * password fields without end cannot grow the record without end, and a
 * field still on the page keeps its entry unless 256 others are too. Missed:
 * a re-rendered field with neither `id` nor `name`, a field re-rendered after
 * its old element left the document and 256 other password fields came and
 * went, and a field switched inside a shadow root that was attached after
 * load and never received an event before the switch.
 *
 * Runs in the browser, so it must not refer to anything outside its own body.
 * Installing it twice is harmless: the second copy finds the first and stops.
 */
export function rememberPasswordFields(): void {
  const key = "jevy.passwordFields";
  const limit = 256;
  const apply = Reflect.apply;
  type Method = (this: unknown, ...args: readonly unknown[]) => unknown;
  const describe = (prototype: object, name: string): PropertyDescriptor => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor === undefined) throw new TypeError(`No ${name}.`);
    return descriptor;
  };
  const method = (prototype: object, name: string): Method => {
    const value: unknown = describe(prototype, name).value;
    if (typeof value !== "function") throw new TypeError(`No ${name}.`);
    return value as Method;
  };
  const getter = (prototype: object, name: string): Method => {
    const get: unknown = Reflect.get(describe(prototype, name), "get");
    if (typeof get !== "function") throw new TypeError(`No ${name} getter.`);
    return get as Method;
  };
  const call = (
    fn: Method,
    target: unknown,
    ...args: readonly unknown[]
  ): unknown => apply(fn, target, args);
  const get = (from: Method, target: unknown): unknown => call(from, target);

  const hasOwn = method(Object.prototype, "hasOwnProperty");
  if (call(hasOwn, location, key) === true) return;
  const tagNameOf = getter(Element.prototype, "tagName");
  const shadowRootOf = getter(Element.prototype, "shadowRoot");
  const nodeTypeOf = getter(Node.prototype, "nodeType");
  const isConnectedOf = getter(Node.prototype, "isConnected");
  const hostOf = getter(ShadowRoot.prototype, "host");
  const documentElementOf = getter(Document.prototype, "documentElement");
  const inputValueOf = getter(HTMLInputElement.prototype, "value");
  const inputTypeOf = getter(HTMLInputElement.prototype, "type");
  const textareaValueOf = getter(HTMLTextAreaElement.prototype, "value");
  const lengthOf = getter(NodeList.prototype, "length");
  const recordTypeOf = getter(MutationRecord.prototype, "type");
  const recordTargetOf = getter(MutationRecord.prototype, "target");
  const recordOldValueOf = getter(MutationRecord.prototype, "oldValue");
  const recordAddedOf = getter(MutationRecord.prototype, "addedNodes");
  const getAttribute = method(Element.prototype, "getAttribute");
  const elementQuery = method(Element.prototype, "querySelectorAll");
  const documentQuery = method(Document.prototype, "querySelectorAll");
  const fragmentQuery = method(DocumentFragment.prototype, "querySelectorAll");
  const item = method(NodeList.prototype, "item");
  const getRootNode = method(Node.prototype, "getRootNode");
  const composedPath = method(Event.prototype, "composedPath");
  const observe = method(MutationObserver.prototype, "observe");
  const trim = method(String.prototype, "trim");
  const toLowerCase = method(String.prototype, "toLowerCase");
  const weakAdd = method(WeakSet.prototype, "add");
  const weakHas = method(WeakSet.prototype, "has");
  const deref = method(WeakRef.prototype, "deref");
  const Ref = WeakRef;
  const root = document;

  const attribute = (element: Element, name: string): string => {
    const value = call(getAttribute, element, name);
    return typeof value === "string" ? value : "";
  };
  const isElement = (node: unknown): node is Element => {
    try {
      return get(nodeTypeOf, node) === 1;
    } catch {
      return false;
    }
  };
  const isShadowRoot = (node: unknown): node is ShadowRoot => {
    try {
      get(hostOf, node);
      return true;
    } catch {
      return false;
    }
  };
  const isPassword = (type: unknown): boolean =>
    typeof type === "string" &&
    call(toLowerCase, call(trim, type)) === "password";
  const isPasswordInput = (element: Element): boolean =>
    get(tagNameOf, element) === "INPUT" &&
    isPassword(attribute(element, "type"));
  const each = (list: unknown, visit: (node: unknown) => void): void => {
    const length = get(lengthOf, list);
    if (typeof length !== "number") return;
    for (let index = 0; index < length; index += 1) {
      visit(call(item, list, index));
    }
  };
  const everyElement = (where: Document | ShadowRoot): unknown =>
    get(nodeTypeOf, where) === 9
      ? call(documentQuery, where, "*")
      : call(fragmentQuery, where, "*");

  interface Entry {
    readonly id: string;
    readonly name: string;
    readonly ref: WeakRef<Element>;
  }
  const elements = new WeakSet<Element>();
  const entries: Entry[] = [];
  const isGone = (entry: Entry): boolean => {
    const element = call(deref, entry.ref);
    return element === undefined || get(isConnectedOf, element) !== true;
  };
  const remember = (field: Element): void => {
    call(weakAdd, elements, field);
    const id = attribute(field, "id");
    const name = attribute(field, "name");
    if (id === "" && name === "") return;
    const entry: Entry = { id, name, ref: new Ref(field) };
    for (let index = 0; index < entries.length; index += 1) {
      const known = entries[index];
      if (known !== undefined && known.id === id && known.name === name) {
        entries[index] = entry;
        return;
      }
    }
    entries[entries.length] = entry;
    if (entries.length <= limit) return;
    let drop = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const known = entries[index];
      if (known !== undefined && isGone(known)) {
        drop = index;
        break;
      }
    }
    for (let index = drop; index < entries.length - 1; index += 1) {
      const next = entries[index + 1];
      if (next !== undefined) entries[index] = next;
    }
    entries.length -= 1;
  };
  const wasPassword = (field: Element): boolean => {
    if (call(weakHas, elements, field) === true) return true;
    const id = attribute(field, "id");
    const name = attribute(field, "name");
    for (let index = 0; index < entries.length; index += 1) {
      const known = entries[index];
      if (known === undefined) continue;
      if (id !== "" && known.id === id) return true;
      if (name !== "" && known.name === name) return true;
    }
    return false;
  };

  const watched = new WeakSet<Node>();
  const visit = (element: Element): void => {
    if (isPasswordInput(element)) remember(element);
    const shadow = get(shadowRootOf, element);
    if (isShadowRoot(shadow)) watch(shadow);
  };
  const scan = (top: Element): void => {
    visit(top);
    each(call(elementQuery, top, "*"), (node) => {
      if (isElement(node)) visit(node);
    });
  };
  const observer = new MutationObserver((records) => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === undefined) continue;
      if (get(recordTypeOf, record) === "attributes") {
        const target = get(recordTargetOf, record);
        if (
          isElement(target) &&
          get(tagNameOf, target) === "INPUT" &&
          (isPassword(get(recordOldValueOf, record)) ||
            isPassword(attribute(target, "type")))
        ) {
          remember(target);
        }
        continue;
      }
      each(get(recordAddedOf, record), (added) => {
        if (isElement(added)) scan(added);
      });
    }
  });
  const watch = (where: Document | ShadowRoot): void => {
    if (call(weakHas, watched, where) === true) return;
    call(weakAdd, watched, where);
    call(observe, observer, where, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["type"],
      attributeOldValue: true,
    });
    each(everyElement(where), (node) => {
      if (isElement(node)) visit(node);
    });
  };
  const watchAround = (event: Event): void => {
    const path = call(composedPath, event) as readonly unknown[];
    const origin = path[0];
    if (!isElement(origin)) return;
    if (isPasswordInput(origin)) remember(origin);
    let at = call(getRootNode, origin);
    while (isShadowRoot(at)) {
      watch(at);
      at = call(getRootNode, get(hostOf, at));
    }
  };
  for (const type of ["focusin", "pointerdown", "keydown", "input"]) {
    window.addEventListener(type, watchAround, {
      capture: true,
      passive: true,
    });
  }
  // Both events fire once the document element exists.
  const rescan = (): void => {
    const top = get(documentElementOf, root);
    if (isElement(top)) scan(top);
  };
  document.addEventListener("DOMContentLoaded", rescan);
  window.addEventListener("load", rescan);

  /** Every field with a value, read with the built-ins captured above. */
  const read = (): FieldReading[] => {
    const fields: FieldReading[] = [];
    const roots: (Document | ShadowRoot)[] = [root];
    while (roots.length > 0) {
      const where = roots[roots.length - 1];
      roots.length -= 1;
      if (where === undefined) continue;
      each(everyElement(where), (node) => {
        if (!isElement(node)) return;
        const shadow = get(shadowRootOf, node);
        if (isShadowRoot(shadow)) roots[roots.length] = shadow;
        const tag = get(tagNameOf, node);
        const isInput = tag === "INPUT";
        if (!isInput && tag !== "TEXTAREA") return;
        const value = get(isInput ? inputValueOf : textareaValueOf, node);
        const type = isInput ? get(inputTypeOf, node) : "textarea";
        if (typeof value !== "string" || value === "") return;
        fields[fields.length] = {
          tag: isInput ? "input" : "textarea",
          // A type that is not text cannot happen; if it does, blank it.
          type: typeof type === "string" ? type : "password",
          value,
          autocomplete: attribute(node, "autocomplete"),
          name: attribute(node, "name"),
          id: attribute(node, "id"),
          wasPassword: wasPassword(node),
        };
      });
    }
    return fields;
  };
  Object.defineProperty(location, key, { value: Object.freeze({ read }) });
  watch(root);
}
