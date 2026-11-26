// A decider for any LLM through a user-supplied adapter, and a fake for
// tests. No provider is bundled and nothing here calls the network itself.
export {
  DEFAULT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  llmDecider,
  llmDeciderId,
} from "./llm.js";
export type { LlmDeciderOptions } from "./llm.js";

export { ABSTAIN_BASE_IDS, abstainId, answerSchema } from "./schema.js";

export { UNSCRIPTED, fakeDecider } from "./fake.js";
export type { FakeAnswers, FakeAsk, FakeDeciderOptions } from "./fake.js";
