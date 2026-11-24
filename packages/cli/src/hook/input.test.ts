import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseHookInput, readStdin } from "./input.js";

describe("parseHookInput", () => {
  it("reads the fields the hooks use", () => {
    expect(
      parseHookInput(
        JSON.stringify({
          session_id: "abc",
          cwd: "/work",
          hook_event_name: "PreToolUse",
          stop_hook_active: true,
          tool_name: "Edit",
          tool_input: { file_path: "/work/a.ts" },
        }),
      ),
    ).toEqual({
      sessionId: "abc",
      cwd: "/work",
      stopHookActive: true,
      toolName: "Edit",
      toolInput: { file_path: "/work/a.ts" },
    });
  });

  it("gives defaults for fields that are missing or of the wrong type", () => {
    expect(parseHookInput("{}")).toEqual({
      sessionId: null,
      cwd: null,
      stopHookActive: false,
      toolName: null,
      toolInput: null,
    });
    expect(
      parseHookInput(
        JSON.stringify({
          session_id: 7,
          cwd: "",
          stop_hook_active: "true",
          tool_name: ["Edit"],
          tool_input: ["a"],
        }),
      ),
    ).toEqual({
      sessionId: null,
      cwd: null,
      stopHookActive: false,
      toolName: null,
      toolInput: null,
    });
  });

  it.each(["", "   ", "not json", "[1]", "null", '"text"', "{"])(
    "is null for %j",
    (text) => {
      expect(parseHookInput(text)).toBeNull();
    },
  );
});

describe("readStdin", () => {
  it("reads a piped stream to its end", async () => {
    const stream = Readable.from([Buffer.from('{"a":'), Buffer.from('"ż"}')]);
    expect(await readStdin(stream)).toBe('{"a":"ż"}');
  });

  it("joins a character split across two chunks", async () => {
    const bytes = Buffer.from("ż");
    const stream = Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]);
    expect(await readStdin(stream)).toBe("ż");
  });

  it("is empty for an empty stream", async () => {
    expect(await readStdin(Readable.from([]))).toBe("");
  });

  it("does not wait on a terminal", async () => {
    const never = {
      isTTY: true,
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: () => new Promise<IteratorResult<string>>(() => undefined),
      }),
    };
    expect(await readStdin(never)).toBe("");
  });

  it("is empty when the stream fails", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("EAGAIN"));
      },
    });
    expect(await readStdin(stream)).toBe("");
  });
});
