/**
 * Text that goes back to a coding agent or to a person from a hook. A hook's
 * reason is read inside the agent's context, so it has to be short, and it
 * carries text the repository controls, so that text must not be able to
 * pass for the hook's own words.
 */

/** First line of trimmed output, so a reader knows the start is missing. */
export const CUT_MARKER = "[earlier output cut]";

export interface TailLimits {
  readonly lines: number;
  readonly chars: number;
}

const DEFAULT_LIMITS: TailLimits = { lines: 40, chars: 4000 };

/**
 * The end of a command's output: at most `lines` lines and `chars`
 * characters, with `CUT_MARKER` in front when anything was dropped. A failing
 * command says why at the end, and the whole log of a test run would crowd
 * the agent's context.
 */
export function tail(
  text: string,
  limits: TailLimits = DEFAULT_LIMITS,
): string {
  const all = text.replaceAll("\r\n", "\n").trimEnd();
  const lines = all.split("\n");
  let body = lines.slice(-limits.lines).join("\n");
  let cut = lines.length > limits.lines;
  if (body.length > limits.chars) {
    body = body.slice(-limits.chars);
    cut = true;
    // Half of a surrogate pair would print as a replacement character.
    const first = body.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) {
      body = body.slice(1);
    }
  }
  return cut ? `${CUT_MARKER}\n${body}` : body;
}

/** `text` with `prefix` before every line. */
export function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

const ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Whether a character changes how the text around it is laid out. The C0
 * and C1 controls (U+0085 ends a line, U+009B starts a terminal escape
 * sequence on its own), the line and paragraph separators, and the bidi
 * embeddings, overrides and isolates, which can make a line read in another
 * order than it is written.
 */
function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * `text` with control characters escaped. File names, test titles and guard
 * messages come from the repository; on one line each, and in the order
 * they are written, a crafted name cannot add a line that reads as an
 * instruction from the hook.
 */
export function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += isControl(code)
      ? (ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, "0")}`)
      : char;
  }
  return out;
}

/**
 * `text` cut to at most `max` characters, the last of them an ellipsis when
 * anything was dropped. A test title or a command can be thousands of
 * characters long, and one such line would push everything else out of a
 * message that has a size limit.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let kept = text.slice(0, Math.max(0, max - 1));
  // Half of a surrogate pair would print as a replacement character.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    kept = kept.slice(0, -1);
  }
  return `${kept}…`;
}

/**
 * A path cut to at most `max` characters by dropping its start, with an
 * ellipsis in front when anything was dropped. A path says what it is at
 * its end: cut like `clip`, a long directory would push out the file's own
 * name. The cut moves to the next slash, when there is one, so that no
 * directory name is shown half.
 */
export function clipPath(path: string, max: number): string {
  if (path.length <= max) {
    return path;
  }
  let kept = path.slice(path.length - Math.max(0, max - 1));
  const slash = kept.indexOf("/");
  if (slash > 0 && slash < kept.lastIndexOf("/")) {
    kept = kept.slice(slash);
  }
  // Half of a surrogate pair would print as a replacement character.
  const first = kept.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    kept = kept.slice(1);
  }
  return `…${kept}`;
}

/**
 * `printable` for text of several lines: the line breaks and tabs stay, so
 * a check's output still reads as output, and every other control character
 * is escaped. Without this a check that prints a terminal escape or a bidi
 * override would hand it to the agent as it is.
 */
export function printableLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\t").map(printable).join("\t"))
    .join("\n");
}

/** The message of whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
