import { describe, expect, it } from "vitest";
import { DeciderError, JevyError } from "./errors.js";

describe("DeciderError", () => {
  it("is a JevyError named for its class", () => {
    const error = new DeciderError("The decider could not be reached");
    expect(error).toBeInstanceOf(JevyError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DeciderError");
    expect(error.message).toBe("The decider could not be reached");
  });
});
