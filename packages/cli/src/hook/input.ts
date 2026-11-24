/**
 * What a coding agent hands a hook on stdin: one JSON object. Only the
 * fields the hooks use are read, and a field of the wrong type is read as
 * absent, so each hook decides for itself what a missing field means.
 */

export interface HookInput {
  /** `session_id`: names the session, so the stop hook can count per session. */
  readonly sessionId: string | null;
  /** `cwd`: the session's current directory, where a relative path starts. */
  readonly cwd: string | null;
  /** `stop_hook_active`: the agent is already continuing because a stop hook blocked. */
  readonly stopHookActive: boolean;
  /** `tool_name`, for a hook that runs before a tool. */
  readonly toolName: string | null;
  /** `tool_input`, when it is an object. */
  readonly toolInput: Readonly<Record<string, unknown>> | null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The hook input in `raw`, or null when it is not one JSON object. Null is
 * not an error here: a person running `jevy hook stop` by hand gives no
 * input, while the pre-edit hook treats null as a reason to block.
 */
export function parseHookInput(raw: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    sessionId: text(parsed["session_id"]),
    cwd: text(parsed["cwd"]),
    stopHookActive: parsed["stop_hook_active"] === true,
    toolName: text(parsed["tool_name"]),
    toolInput: isRecord(parsed["tool_input"]) ? parsed["tool_input"] : null,
  };
}

/** As much of `process.stdin` as reading it needs. */
export interface InputStream extends AsyncIterable<string | Uint8Array> {
  readonly isTTY?: boolean | undefined;
}

/**
 * Everything on `stream`, as text. A terminal gives "" at once: nobody is
 * going to type the JSON, and waiting for them would hang a person who runs
 * the hook by hand. A stream that fails also gives "", which the stop hook
 * reads as "no session" and the pre-edit hook as a reason to block.
 */
export async function readStdin(stream: InputStream): Promise<string> {
  if (stream.isTTY === true) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  } catch {
    return "";
  }
  // Decoded once at the end, so a character split across chunks survives.
  return Buffer.concat(chunks).toString("utf8");
}
