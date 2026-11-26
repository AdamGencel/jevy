import type { JevyConfig } from "@jevyjs/core";
import advisory from "../jevy.config.js";

// The step 3 fixture with toSatisfy.blocking on: a fail fails its test.
export default {
  ...advisory,
  toSatisfy: { blocking: true },
} satisfies JevyConfig;
