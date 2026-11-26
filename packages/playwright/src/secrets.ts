import {
  REDACTED,
  RedactionError,
  SECRET_AUTOCOMPLETE_TOKENS,
  isSecretFieldName,
  reduceUrl,
} from "@jevyjs/core";
import type { AccessibilityNode } from "@jevyjs/core";

/**
 * Autocomplete tokens that mark a field as secret. This is core's own list,
 * re-exported, so a token added to core reaches the bridge with no copy to
 * keep in step.
 */
export { SECRET_AUTOCOMPLETE_TOKENS };

/**
 * True when an `autocomplete` attribute holds a secret token. The attribute is
 * a space-separated list (`section-pay billing cc-number`), so each token is
 * checked, case-insensitively.
 */
export function isSecretAutocomplete(attribute: string): boolean {
  return attribute
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE_TOKENS.includes(token));
}

/**
 * One form field as the DOM read sees it. Every field with a value is read,
 * and the decision whether it is secret is made here, in Node, so that it can
 * use core's own rules: a function that runs in the browser cannot import
 * them.
 */
export interface FieldReading {
  readonly tag: "input" | "textarea";
  /** `input.type` as the browser reports it: lower case, `text` by default. */
  readonly type: string;
  readonly value: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly id: string;
  /**
   * The field has had `type="password"` since the page loaded, as recorded by
   * `rememberPasswordFields`. Always false when that script is not installed.
   */
  readonly wasPassword: boolean;
}

/**
 * Input types whose value is free text, so a secret-sounding `name` or `id`
 * means the value is the secret. An `<input>` with no `type` attribute reports
 * `text`. Other types are left to the `password` and autocomplete rules: a
 * checkbox's value is `on`, a submit button's value is its label, and
 * `<input type="number" name="password_min_length" value="8">` is a setting;
 * treating any of those as secret would blank that text everywhere on the
 * page.
 */
const FREE_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "search"]);

/**
 * True when a field's value must not leave the browser in clear: a password
 * field, a field with a secret autocomplete token, a field that was a
 * password field before a "show password" button switched its type, or a
 * free-text field (`text`, `search` or a textarea) whose `name` or `id` names
 * a secret by core's rule. The last catches a switched field that has no
 * autocomplete and a neutral label, as long as its markup names it
 * (`name="password"`).
 */
export function isSecretField(field: FieldReading): boolean {
  if (field.type === "password" || field.wasPassword) return true;
  if (isSecretAutocomplete(field.autocomplete)) return true;
  const freeText =
    field.tag === "textarea" || FREE_TEXT_INPUT_TYPES.has(field.type);
  return (
    freeText && (isSecretFieldName(field.name) || isSecretFieldName(field.id))
  );
}

/**
 * Check what the DOM read brought back from the page and join its two parts:
 * `fields`, read by the bridge's own function, and `remembered`, read by the
 * `rememberPasswordFields` init script when it is installed (`undefined`
 * otherwise). Both come from a page that may be hostile, so anything that is
 * not a list of well-formed readings throws `RedactionError` rather than
 * being taken as "no secrets". The message repeats nothing from the page.
 */
export function parsePageReading(reading: unknown): FieldReading[] {
  if (typeof reading !== "object" || reading === null) throw unreadable();
  const { fields, remembered } = reading as {
    readonly fields?: unknown;
    readonly remembered?: unknown;
  };
  const own = parseFields(fields);
  return remembered === undefined ? own : [...own, ...parseFields(remembered)];
}

function parseFields(value: unknown): FieldReading[] {
  if (!Array.isArray(value)) throw unreadable();
  return value.map((item: unknown): FieldReading => {
    if (typeof item !== "object" || item === null) throw unreadable();
    const field = item as Readonly<Record<string, unknown>>;
    const {
      tag,
      type,
      value: text,
      autocomplete,
      name,
      id,
      wasPassword,
    } = field;
    if (
      (tag !== "input" && tag !== "textarea") ||
      typeof type !== "string" ||
      typeof text !== "string" ||
      typeof autocomplete !== "string" ||
      typeof name !== "string" ||
      typeof id !== "string" ||
      typeof wasPassword !== "boolean"
    ) {
      throw unreadable();
    }
    return { tag, type, value: text, autocomplete, name, id, wasPassword };
  });
}

function unreadable(): RedactionError {
  return new RedactionError(
    "The form fields of the page could not be read, so the accessibility " +
      "snapshot could not be checked for secrets. The snapshot was discarded.",
  );
}

/** The non-empty values of the secret fields, sorted so reads compare. */
export function secretValues(fields: readonly FieldReading[]): string[] {
  return fields
    .filter((field) => field.value !== "" && isSecretField(field))
    .map((field) => field.value)
    .sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The spellings a typed value can take in an aria snapshot: as typed, with
 * whitespace collapsed, and as Playwright 1.63 normalises text (zero-width
 * space and soft hyphen removed, trimmed, whitespace collapsed).
 */
export function secretForms(value: string): readonly string[] {
  const collapsed = value.trim().replace(/\s+/g, " ");
  const playwright = value
    .replace(/[\u200b\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const forms: string[] = [];
  for (const form of [value, collapsed, playwright]) {
    if (form !== "" && !forms.includes(form)) forms.push(form);
  }
  return forms;
}

/**
 * The spellings of a secret to look for in a link's url: those of
 * {@link secretForms}, of the value and of its NFKC form (core normalises a
 * url to NFKC before reducing it). Percent-encoding and `+` for a space are
 * not listed here: the url matcher decodes them as it goes, in any case and
 * in any mix, so every encoding of every form is matched.
 */
export function urlSecretForms(value: string): readonly string[] {
  const forms = [...secretForms(value)];
  for (const form of secretForms(value.normalize("NFKC"))) {
    if (!forms.includes(form)) forms.push(form);
  }
  return forms;
}

type TextField =
  | "name"
  | "description"
  | "keyshortcuts"
  | "roledescription"
  | "valuetext"
  | "autocomplete"
  | "haspopup"
  | "invalid"
  | "orientation";

const TEXT_FIELDS: readonly TextField[] = [
  "name",
  "description",
  "keyshortcuts",
  "roledescription",
  "valuetext",
  "autocomplete",
  "haspopup",
  "invalid",
  "orientation",
];

/**
 * Copy a tree with every occurrence of every secret replaced by `[REDACTED]`
 * in every text field, in `value` and in `url`. The role is left alone: it
 * comes from Playwright's fixed role list, not from the page.
 *
 * The `url` is taken as the raw href (see `parseRawAriaSnapshot`) and always
 * comes back reduced with core's `reduceUrl`, secrets or not: the secrets are
 * removed from the whole href first, so one holding `#` or `?` is not cut in
 * two by the reduction; then it is reduced; then scrubbed again, in case the
 * reduction (NFKC, dropped parameters) brought a secret together. A url that
 * reduces to nothing is dropped.
 *
 * Matching is by substring, so a short secret also blanks unrelated text that
 * contains it. That is the safe direction to be wrong in. Longer secrets are
 * removed first, and a secret is never matched across or inside a marker that
 * was already inserted, so the result cannot contain any secret.
 */
export function scrubSecrets(
  tree: AccessibilityNode,
  values: readonly string[],
): AccessibilityNode {
  const forms: Forms = {
    text: longestFirst(values.flatMap(secretForms)),
    url: longestFirst(values.flatMap(urlSecretForms)),
  };
  return scrubNode(tree, forms);
}

interface Forms {
  readonly text: readonly string[];
  readonly url: readonly string[];
}

function longestFirst(forms: readonly string[]): readonly string[] {
  return [...new Set(forms)].sort((left, right) => right.length - left.length);
}

function scrubNode(node: AccessibilityNode, forms: Forms): AccessibilityNode {
  const next: {
    -readonly [K in keyof AccessibilityNode]: AccessibilityNode[K];
  } = { ...node };
  for (const field of TEXT_FIELDS) {
    const text = node[field];
    if (text !== undefined) next[field] = scrubText(text, forms.text);
  }
  if (node.url !== undefined) {
    const url = scrubUrl(node.url, forms.url);
    if (url === undefined) delete next.url;
    else next.url = url;
  }
  if (node.value !== undefined) {
    const text = String(node.value);
    const scrubbed = scrubText(text, forms.text);
    if (scrubbed !== text) next.value = scrubbed;
  }
  if (node.children !== undefined) {
    next.children = node.children.map((child) => scrubNode(child, forms));
  }
  return next;
}

/**
 * Split on each secret in turn and join the pieces with the marker. Every
 * boundary between pieces is a marker, so later secrets only ever see text
 * from the page, never the marker itself.
 */
function scrubText(text: string, forms: readonly string[]): string {
  let pieces = [text];
  for (const form of forms) {
    pieces = pieces.flatMap((piece) => piece.split(form));
  }
  return pieces.join(REDACTED);
}

/** A scheme as core's `reduceUrl` prints it: lower case, with its colon. */
const REDUCED_SCHEME = /^[a-z][a-z0-9+.-]*:/;

/**
 * Scrub the raw href, reduce it, scrub it again.
 *
 * The scrub must not decide the url's scheme. A secret that matches inside
 * the scheme (`java` in `javascript:login('tok')`) would leave
 * `[REDACTED]script:login('tok')`, which core reads as a relative path and
 * keeps whole. So when the href has a scheme and the scrubbed href, reduced,
 * no longer starts with it, the result is the scheme alone, scrubbed.
 */
function scrubUrl(raw: string, forms: readonly string[]): string | undefined {
  const scheme = REDUCED_SCHEME.exec(reduceUrl(raw))?.[0];
  let reduced = reduceUrl(scrubUrlText(raw, forms));
  if (scheme !== undefined && !reduced.startsWith(scheme)) reduced = scheme;
  const scrubbed = reduced
    .split(REDACTED)
    .map((piece) => scrubUrlText(piece, forms))
    .join(REDACTED);
  return scrubbed === "" ? undefined : scrubbed;
}

/** {@link scrubText} for a url, where each form is matched however encoded. */
function scrubUrlText(text: string, forms: readonly string[]): string {
  let pieces = [text];
  for (const form of forms) {
    pieces = pieces.flatMap((piece) => splitUrl(piece, form));
  }
  return pieces.join(REDACTED);
}

/**
 * One character of a url as it is written: a literal character, or a run of
 * `%XX` bytes that decodes, as UTF-8, to exactly one character.
 */
interface UrlUnit {
  readonly raw: string;
  readonly char: string;
}

/**
 * The url's text between the places where `secret` is spelt, in any of the
 * ways a page writes text into a url: as is, percent-encoded with upper- or
 * lower-case hex (`%C3%A4`, `%c3%a4`, `%C3%a4`), with `+` for a space, or any
 * mix of these, character by character. Malformed percent-encoding never
 * throws: a `%` that does not start a valid UTF-8 sequence is a literal `%`.
 *
 * At each start the matcher follows every way the units can spell the
 * secret (a `%25` unit can be the `%` of the secret or the whole `%25` of
 * it), and takes the leftmost, shortest match.
 */
function splitUrl(text: string, secret: string): string[] {
  const units = urlUnits(text);
  const pieces: string[] = [];
  let piece = "";
  let start = 0;
  while (start < units.length) {
    const end = matchAt(units, start, secret);
    if (end === undefined) {
      piece += units[start]?.raw ?? "";
      start += 1;
      continue;
    }
    pieces.push(piece);
    piece = "";
    start = end;
  }
  pieces.push(piece);
  return pieces;
}

/** The index after the last unit of a match that starts at `start`. */
function matchAt(
  units: readonly UrlUnit[],
  start: number,
  secret: string,
): number | undefined {
  let reached = new Set([0]);
  for (let index = start; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) return undefined;
    const next = new Set<number>();
    for (const at of reached) {
      for (const advance of advances(unit, secret, at)) {
        if (at + advance === secret.length) return index + 1;
        next.add(at + advance);
      }
    }
    if (next.size === 0) return undefined;
    reached = next;
  }
  return undefined;
}

/** How far into the secret one unit can take a match that is at `at`. */
function advances(unit: UrlUnit, secret: string, at: number): number[] {
  const found: number[] = [];
  if (secret.startsWith(unit.raw, at)) found.push(unit.raw.length);
  if (unit.char !== unit.raw && secret.startsWith(unit.char, at)) {
    found.push(unit.char.length);
  }
  if (unit.raw === "+" && secret[at] === " ") found.push(1);
  return found;
}

function urlUnits(text: string): UrlUnit[] {
  const units: UrlUnit[] = [];
  let index = 0;
  while (index < text.length) {
    const unit =
      percentUnit(text, index) ??
      literalUnit(String.fromCodePoint(text.codePointAt(index) ?? 0));
    units.push(unit);
    index += unit.raw.length;
  }
  return units;
}

function literalUnit(char: string): UrlUnit {
  return { raw: char, char };
}

/** The number of UTF-8 bytes a sequence with this lead byte has, or 0. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function percentUnit(text: string, at: number): UrlUnit | undefined {
  const lead = byteAt(text, at);
  if (lead === undefined) return undefined;
  const length = sequenceLength(lead);
  if (length === 0) return undefined;
  const bytes = [lead];
  for (let index = 1; index < length; index += 1) {
    const byte = byteAt(text, at + 3 * index);
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  let char: string;
  try {
    char = UTF8.decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
  if (Array.from(char).length !== 1) return undefined;
  return { raw: text.slice(at, at + 3 * length), char };
}

const PERCENT_BYTE = /^%[0-9A-Fa-f]{2}$/;

function byteAt(text: string, at: number): number | undefined {
  const written = text.slice(at, at + 3);
  if (!PERCENT_BYTE.test(written)) return undefined;
  return Number.parseInt(written.slice(1), 16);
}
